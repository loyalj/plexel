/**
 * Display lookup tables: a document's colours, sampled on a grid and
 * converted once by the colour engine, so the GPU can show every pixel
 * through a texture lookup instead of a colour transform.
 *
 *   RGB and Lab documents: a 3D table, `size`³ entries.
 *   Gray documents:        a 1D table, `size` entries.
 *   CMYK documents:        `kSlices` 3D tables over C, M and Y, one per
 *                          step of K, interpolated between in K: a 4D
 *                          table the GPU can hold as a 3D texture array.
 *
 * Every entry is RGBA float, laid out with the first channel varying
 * fastest (x = first channel), which is how a 3D texture is addressed. A is
 * 1, except in a table made with a gamut check, where it's 0 for a colour
 * the proof can't reproduce: interpolated like the colour, it says how far
 * a pixel is into that region, and the shader marks it past half. The
 * samplers here are the CPU reference the GPU shader is checked against:
 * tetrahedral within a cube, linear between K slices, as LittleCMS itself
 * interpolates.
 *
 * Soft-proofing (`buildLookLut`) chains two conversions into the same
 * table: the document to the proof's device values (how it would print),
 * clipped to what the device can do, then those to the display, with the
 * paper's white and the ink's black shown or not.
 */
import { FLAGS, type Cms, type Intent, type Profile, type Transform } from './cms'
import { deltaE2000 } from './models'

export interface Lut {
  /** What the table takes: a document's colours in this space. */
  input: 'rgb' | 'lab' | 'gray' | 'cmyk'
  dims: 1 | 3 | 4
  /** Points per channel on the colour axes. */
  size: number
  /** CMYK only: how many K slices. */
  kSlices: number
  data: Float32Array
}

/**
 * Table sizes, chosen by measurement (check-color reports the numbers).
 * CMYK's error lives mostly along K, near full black, so it gets more K
 * slices and fewer points on C, M and Y: 17³ × 33 holds the generic
 * profile to 0.08 ΔE2000 on average and 1.5 at worst, in 1.3 MB as
 * half-floats, where 33³ × 17 used four times the memory for a worst case
 * of 3.8.
 */
export const LUT_SIZE = 33
const LUT_CMYK_SIZE = 17
const LUT_K_SLICES = 33
const LUT_GRAY_SIZE = 1024

function grid(size: number, channels: number, extra: number[] = []): Float32Array {
  const n = size ** channels
  const out = new Float32Array(n * (channels + extra.length))
  let o = 0
  const idx = new Array(channels).fill(0)
  for (let i = 0; i < n; i++) {
    let rest = i
    for (let c = 0; c < channels; c++) {
      idx[c] = rest % size
      rest = Math.floor(rest / size)
    }
    for (let c = 0; c < channels; c++) out[o++] = idx[c] / (size - 1)
    for (const e of extra) out[o++] = e
  }
  return out
}

/** Lab grid points, from the unit cube to L 0..100, a and b -128..127. */
const toLab = (u: Float32Array) => {
  for (let i = 0; i < u.length; i += 3) {
    u[i] *= 100
    u[i + 1] = u[i + 1] * 255 - 128
    u[i + 2] = u[i + 2] * 255 - 128
  }
  return u
}

function rgba(rgb: Float32Array): Float32Array {
  const n = rgb.length / 3
  const out = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    out[i * 4] = Math.min(1, Math.max(0, rgb[i * 3]))
    out[i * 4 + 1] = Math.min(1, Math.max(0, rgb[i * 3 + 1]))
    out[i * 4 + 2] = Math.min(1, Math.max(0, rgb[i * 3 + 2]))
    out[i * 4 + 3] = 1
  }
  return out
}

/** The table that shows `from` on a display with profile `to` (an RGB profile). */
export function buildDisplayLut(
  cms: Cms,
  from: Profile,
  to: Profile,
  intent: Intent = 'relative',
  flags = 0x2000,
  size = from.space === 'cmyk' ? LUT_CMYK_SIZE : LUT_SIZE,
  kSlices = LUT_K_SLICES,
): Lut {
  return buildLookLut(cms, from, to, { intent, bpc: (flags & FLAGS.blackPointCompensation) !== 0 }, size, kSlices)
}

/**
 * How a printing condition is simulated on screen, as Photoshop's Proof
 * Setup has it: the document converted to the proof's device with `intent`
 * (and black-point compensation), then shown with the paper's own white
 * (`paper`, absolute colorimetric) or the display's, and the ink's own
 * black (`black`) or the display's.
 */
export interface ProofCondition {
  profile: Profile
  intent: Intent
  bpc: boolean
  paper: boolean
  black: boolean
}

export interface LookOptions {
  /** How the document goes to the display when it isn't proofed. */
  intent?: Intent
  bpc?: boolean
  /** Shown as it would print on this condition. */
  proof?: ProofCondition | null
  /** Marks colours this condition can't reproduce (in A, see above). */
  gamut?: Omit<ProofCondition, 'paper' | 'black'> | null
}

/** The grid a table samples, in the document's own terms, as the colour engine takes them. */
function sampleGrid(from: Profile, size: number, kSlices: number): { input: Lut['input']; dims: Lut['dims']; size: number; kSlices: number; points: Float32Array; count: number } {
  if (from.space === 'gray') return { input: 'gray', dims: 1, size: LUT_GRAY_SIZE, kSlices: 0, points: grid(LUT_GRAY_SIZE, 1), count: LUT_GRAY_SIZE }
  if (from.space === 'cmyk') {
    const per = size ** 3
    const points = new Float32Array(per * kSlices * 4)
    for (let k = 0; k < kSlices; k++) points.set(grid(size, 3, [k / (kSlices - 1)]), k * per * 4)
    return { input: 'cmyk', dims: 4, size, kSlices, points, count: per * kSlices }
  }
  const input = from.space === 'lab' ? 'lab' : 'rgb'
  const g = grid(size, 3)
  return { input, dims: 3, size, kSlices: 0, points: input === 'lab' ? toLab(g) : g, count: size ** 3 }
}

const clamp01 = (v: Float32Array) => {
  for (let i = 0; i < v.length; i++) v[i] = v[i] < 0 ? 0 : v[i] > 1 ? 1 : v[i]
  return v
}

/** Runs `fn` with transforms that are closed after, whatever happens. */
function using<T>(fn: (open: (t: Transform) => Transform) => T): T {
  const opened: Transform[] = []
  try {
    return fn((t) => (opened.push(t), t))
  } finally {
    for (const t of opened) t.close()
  }
}

/**
 * Which colours of a grid `proof` can't reproduce, judged as the Colour
 * panel judges them (color/value.ts): to an RGB device a float transform
 * says so by leaving 0..1. A CMYK device clips by itself, and a Gray one
 * has no colour at all to leave room for, so there a colour is out when
 * the trip there and back moves it more than 2 ΔE2000 (under the same
 * intent and black point, so black isn't out).
 */
export function gamutFlags(cms: Cms, from: Profile, proof: Profile, intent: Intent, bpc: boolean, points: Float32Array, count: number): Uint8Array {
  return using((open) => {
    const flags = bpc ? FLAGS.blackPointCompensation : 0
    const there = open(cms.transform(from, proof, intent, flags)).run(points, count)
    const out = new Uint8Array(count)
    const n = proof.channels
    if (proof.space === 'rgb') {
      for (let i = 0; i < count; i++) for (let c = 0; c < n; c++) if (there[i * n + c] < -1e-4 || there[i * n + c] > 1 + 1e-4) out[i] = 1
      return out
    }
    const back = open(cms.transform(proof, from, intent, flags)).run(clamp01(there), count)
    const lab = cms.lab()
    try {
      const toLab = open(cms.transform(from, lab, 'relative', 0))
      const a = toLab.run(points, count)
      const b = toLab.run(back, count)
      for (let i = 0; i < count; i++) if (deltaE2000([a[i * 3], a[i * 3 + 1], a[i * 3 + 2]], [b[i * 3], b[i * 3 + 1], b[i * 3 + 2]]) > 2) out[i] = 1
    } finally {
      lab.close()
    }
    return out
  })
}

/**
 * The table that shows `from` on `to`: plainly, as it would print on a
 * proof condition, and with what that condition can't reproduce marked.
 */
export function buildLookLut(cms: Cms, from: Profile, to: Profile, o: LookOptions = {}, size = from.space === 'cmyk' ? LUT_CMYK_SIZE : LUT_SIZE, kSlices = LUT_K_SLICES): Lut {
  const g = sampleGrid(from, size, kSlices)
  const rgb = using((open) => {
    if (!o.proof) return open(cms.transform(from, to, o.intent ?? 'relative', (o.bpc ?? true) ? FLAGS.blackPointCompensation : 0)).run(g.points, g.count)
    const p = o.proof
    // What the device would print: its own values, inside what it can do.
    // Proofed on its own profile, a document already is those values.
    const device = p.profile === from ? g.points : clamp01(open(cms.transform(from, p.profile, p.intent, p.bpc ? FLAGS.blackPointCompensation : 0)).run(g.points, g.count))
    // Shown with the paper's white (absolute), or the display's white and,
    // unless the ink's black is simulated, the display's black.
    const show = p.paper ? open(cms.transform(p.profile, to, 'absolute', 0)) : open(cms.transform(p.profile, to, 'relative', p.black ? 0 : FLAGS.blackPointCompensation))
    return show.run(device, g.count)
  })
  const data = rgba(rgb)
  if (o.gamut) {
    const out = gamutFlags(cms, from, o.gamut.profile, o.gamut.intent, o.gamut.bpc, g.points, g.count)
    for (let i = 0; i < g.count; i++) if (out[i]) data[i * 4 + 3] = 0
  }
  return { input: g.input, dims: g.dims, size: g.size, kSlices: g.kSlices, data }
}

/** A table's answer to "can this colour be reproduced?": how far into the marked region it is, 0..1. */
export function lutGamut(lut: Lut, c: number[]): number {
  return 1 - sampleChannel(lut, c, 3)
}

/** What the display pass shows on top of the table: channels hidden, one shown alone in gray, and the warnings. */
export interface Look {
  /** Which channels are shown: CMYK's inks, RGB's lights; a hidden one counts as none. */
  inks: [boolean, boolean, boolean, boolean]
  /** The one colour channel shown alone, in gray, as its own value (CMYK's ink as its absence); -1 for none. */
  gray: number
  gamut: boolean
  /** CMYK: total ink (0..4, 3 is 300%) past which a pixel is marked; 0 for none. */
  inkLimit: number
  /** In the display's terms. */
  alarm: [number, number, number]
  inkAlarm: [number, number, number]
}

export const PLAIN_LOOK: Look = { inks: [true, true, true, true], gray: -1, gamut: false, inkLimit: 0, alarm: [0.5, 0.5, 0.5], inkAlarm: [0.1, 0.9, 0.3] }

/**
 * The display colour for one document colour (0..1 per channel, CMYK as
 * ink): the reference the display shader is held to, warnings included.
 */
export function displayRef(lut: Lut, look: Look, c: number[]): number[] {
  if (look.gray >= 0) {
    const g = Math.min(1, Math.max(0, lut.input === 'cmyk' ? 1 - (c[look.gray] ?? 0) : (c[look.gray] ?? 0)))
    return [g, g, g]
  }
  const v = lut.input === 'gray' ? c : c.map((x, i) => (look.inks[i] ? x : 0))
  let out = sampleLut(lut, v)
  if (look.gamut && lutGamut(lut, v) >= 0.5) out = [...look.alarm]
  if (look.inkLimit > 0 && lut.input === 'cmyk' && c[0] + c[1] + c[2] + c[3] > look.inkLimit) out = [...look.inkAlarm]
  return out
}


/** Tetrahedral interpolation in one 3D table of 4-float entries, at `base` floats into `data`: channels `from` up to `to`. */
export function tetra(data: Float32Array, base: number, size: number, x: number, y: number, z: number, out: number[], from = 0, to = 3) {
  const s1 = size - 1
  const fx = Math.min(Math.max(x, 0), 1) * s1
  const fy = Math.min(Math.max(y, 0), 1) * s1
  const fz = Math.min(Math.max(z, 0), 1) * s1
  const x0 = Math.min(Math.floor(fx), s1 - 1)
  const y0 = Math.min(Math.floor(fy), s1 - 1)
  const z0 = Math.min(Math.floor(fz), s1 - 1)
  const rx = fx - x0
  const ry = fy - y0
  const rz = fz - z0
  const at = (i: number, j: number, k: number, c: number) => data[base + ((k * size + j) * size + i) * 4 + c]
  for (let c = from; c < to; c++) {
    const c000 = at(x0, y0, z0, c)
    const c111 = at(x0 + 1, y0 + 1, z0 + 1, c)
    let v: number
    // The six tetrahedra of a cube, chosen by the order of the fractions.
    if (rx >= ry) {
      if (ry >= rz) v = c000 + rx * (at(x0 + 1, y0, z0, c) - c000) + ry * (at(x0 + 1, y0 + 1, z0, c) - at(x0 + 1, y0, z0, c)) + rz * (c111 - at(x0 + 1, y0 + 1, z0, c))
      else if (rx >= rz) v = c000 + rx * (at(x0 + 1, y0, z0, c) - c000) + rz * (at(x0 + 1, y0, z0 + 1, c) - at(x0 + 1, y0, z0, c)) + ry * (c111 - at(x0 + 1, y0, z0 + 1, c))
      else v = c000 + rz * (at(x0, y0, z0 + 1, c) - c000) + rx * (at(x0 + 1, y0, z0 + 1, c) - at(x0, y0, z0 + 1, c)) + ry * (c111 - at(x0 + 1, y0, z0 + 1, c))
    } else {
      if (rz >= ry) v = c000 + rz * (at(x0, y0, z0 + 1, c) - c000) + ry * (at(x0, y0 + 1, z0 + 1, c) - at(x0, y0, z0 + 1, c)) + rx * (c111 - at(x0, y0 + 1, z0 + 1, c))
      else if (rz >= rx) v = c000 + ry * (at(x0, y0 + 1, z0, c) - c000) + rz * (at(x0, y0 + 1, z0 + 1, c) - at(x0, y0 + 1, z0, c)) + rx * (c111 - at(x0, y0 + 1, z0 + 1, c))
      else v = c000 + ry * (at(x0, y0 + 1, z0, c) - c000) + rx * (at(x0 + 1, y0 + 1, z0, c) - at(x0, y0 + 1, z0, c)) + rz * (c111 - at(x0 + 1, y0 + 1, z0, c))
    }
    out[c] = v
  }
}

/** One channel (3 is A) of a table at a document colour. */
function sampleChannel(lut: Lut, c: number[], ch: number): number {
  const out = [0, 0, 0, 0]
  if (lut.dims === 1) {
    const f = Math.min(Math.max(c[0], 0), 1) * (lut.size - 1)
    const i = Math.min(Math.floor(f), lut.size - 2)
    const r = f - i
    return lut.data[i * 4 + ch] * (1 - r) + lut.data[(i + 1) * 4 + ch] * r
  }
  if (lut.dims === 3) {
    const [x, y, z] = lut.input === 'lab' ? [c[0] / 100, (c[1] + 128) / 255, (c[2] + 128) / 255] : c
    tetra(lut.data, 0, lut.size, x, y, z, out, ch, ch + 1)
    return out[ch]
  }
  const sliceLen = lut.size ** 3 * 4
  const fk = Math.min(Math.max(c[3], 0), 1) * (lut.kSlices - 1)
  const k0 = Math.min(Math.floor(fk), lut.kSlices - 2)
  const rk = fk - k0
  const a = [0, 0, 0, 0]
  const b = [0, 0, 0, 0]
  tetra(lut.data, k0 * sliceLen, lut.size, c[0], c[1], c[2], a, ch, ch + 1)
  tetra(lut.data, (k0 + 1) * sliceLen, lut.size, c[0], c[1], c[2], b, ch, ch + 1)
  return a[ch] * (1 - rk) + b[ch] * rk
}

/**
 * The display colour for one document colour, read from the table. Inputs
 * are in the document's terms, 0..1 per channel (Lab as for ColourValue).
 */
export function sampleLut(lut: Lut, c: number[]): number[] {
  const out = [0, 0, 0]
  if (lut.dims === 1) {
    const f = Math.min(Math.max(c[0], 0), 1) * (lut.size - 1)
    const i = Math.min(Math.floor(f), lut.size - 2)
    const r = f - i
    for (let k = 0; k < 3; k++) out[k] = lut.data[i * 4 + k] * (1 - r) + lut.data[(i + 1) * 4 + k] * r
    return out
  }
  if (lut.dims === 3) {
    const [x, y, z] = lut.input === 'lab' ? [c[0] / 100, (c[1] + 128) / 255, (c[2] + 128) / 255] : c
    tetra(lut.data, 0, lut.size, x, y, z, out)
    return out
  }
  const sliceLen = lut.size ** 3 * 4
  const fk = Math.min(Math.max(c[3], 0), 1) * (lut.kSlices - 1)
  const k0 = Math.min(Math.floor(fk), lut.kSlices - 2)
  const rk = fk - k0
  const a = [0, 0, 0]
  const b = [0, 0, 0]
  tetra(lut.data, k0 * sliceLen, lut.size, c[0], c[1], c[2], a)
  tetra(lut.data, (k0 + 1) * sliceLen, lut.size, c[0], c[1], c[2], b)
  for (let i = 0; i < 3; i++) out[i] = a[i] * (1 - rk) + b[i] * rk
  return out
}
