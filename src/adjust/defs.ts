/**
 * Adjustments, declared once (ARCHITECTURE.md, "Adjustments and filters").
 *
 * Each entry lists its parameters (doc/params.ts), which generate its
 * controls in Properties, and compiles them into a Program: one of a few
 * colour operations with its numbers worked out on the CPU. The GPU kernel
 * (render/shaders/adjust.ts) and `runProgram` below run the same programs,
 * so the TypeScript is the reference the GPU is held to, and each entry's
 * own maths (what Levels or Curves means) is checked here, in Node.
 *
 * Colours are straight (not premultiplied), 0..1, in the working space:
 * RGB as it is, Gray as one channel, CMYK as light (1 − ink, as the
 * compositor keeps it). Tone adjustments on CMYK work on the inks, as
 * Photoshop's do; colour adjustments (Hue/Saturation and the rest) work on
 * the colour through the document's profile, black kept
 * (color/cmykAdjust.ts). Until the profile's tables are made, and in the
 * checks that don't make them, they work on a plain RGB view of the inks
 * (each light channel times black's).
 */
import { adjustedCmyk, cmykToRgbT, type CmykTables } from '../color/cmykAdjust'
import { CHANNELS, CURVE_IDENTITY, LEVELS_IDENTITY, readParamValues, type CurvePoints, type GradientStop, type LevelsValue, type ParamDef, type ParamValues } from '../doc/params'
import { clamp01 as clamp } from '../lib/num'

export type Mode = 'rgb' | 'gray' | 'cmyk'

/** The operations a program can be. */
export const OP = { lut: 0, hsl: 1, vibrance: 2, balance: 3, bw: 4, mixer: 5, threshold: 6, gradient: 7, cube: 8 } as const

/** Entries in each tone table. */
export const LUT_SIZE = 1024

export interface Program {
  op: number
  /** Up to 64 numbers, as the op wants them. */
  f: number[]
  /** Tone tables, LUT_SIZE entries per channel (op lut), a gradient's colours, 4 per entry (op gradient), or a colour cube, S³ RGB entries, red fastest (op cube). */
  table: Float32Array | null
}

/** An adjustment, compiled from its parameters' values as V (AdjustmentDef: any adjustment's, as plain records). */
export interface AdjustmentDefOf<V> {
  id: string
  label: string
  params: readonly ParamDef[]
  compile(values: V, mode: Mode): Program
}
export type AdjustmentDef = AdjustmentDefOf<Record<string, unknown>>

/** An adjustment defined with its values typed from its parameters (as defineFilter); the registry holds AdjustmentDefs. */
function defineAdjustment<const P extends readonly ParamDef[]>(def: Omit<AdjustmentDefOf<ParamValues<P>>, 'params'> & { params: P }): AdjustmentDef {
  return def as unknown as AdjustmentDef
}

const nc = (mode: Mode) => (mode === 'rgb' ? 3 : mode === 'gray' ? 1 : 4)

// --- tone tables -----------------------------------------------------------------------

/** A table from a function, for every channel the same. */
function tables(mode: Mode, fns: ((x: number) => number)[]): Float32Array {
  const n = nc(mode)
  const t = new Float32Array(n * LUT_SIZE)
  for (let c = 0; c < n; c++) {
    const fn = fns[Math.min(c, fns.length - 1)]
    for (let i = 0; i < LUT_SIZE; i++) t[c * LUT_SIZE + i] = clamp(fn(i / (LUT_SIZE - 1)))
  }
  return t
}

/**
 * A curve through points, as Photoshop draws one: a natural cubic spline
 * through every point (so a steep bend can overshoot, and is clamped),
 * flat past the ends. Points are taken in order of input.
 */
export function curveFn(points: CurvePoints): (x: number) => number {
  const pts = [...points].sort((a, b) => a[0] - b[0])
  const n = pts.length
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  if (n === 0) return (x) => x
  if (n === 1) return () => ys[0]
  if (n === 2) return (x) => (x <= xs[0] ? ys[0] : x >= xs[1] ? ys[1] : ys[0] + ((x - xs[0]) / Math.max(1e-9, xs[1] - xs[0])) * (ys[1] - ys[0]))
  // Second derivatives, zero at the ends, by the tridiagonal sweep.
  const h = xs.slice(0, -1).map((x, i) => Math.max(1e-9, xs[i + 1] - x))
  const a = new Array<number>(n).fill(0)
  const b = new Array<number>(n).fill(1)
  const c = new Array<number>(n).fill(0)
  const d = new Array<number>(n).fill(0)
  for (let i = 1; i < n - 1; i++) {
    a[i] = h[i - 1]
    b[i] = 2 * (h[i - 1] + h[i])
    c[i] = h[i]
    d[i] = 6 * ((ys[i + 1] - ys[i]) / h[i] - (ys[i] - ys[i - 1]) / h[i - 1])
  }
  for (let i = 1; i < n; i++) {
    const w = a[i] / b[i - 1]
    b[i] -= w * c[i - 1]
    d[i] -= w * d[i - 1]
  }
  const M = new Array<number>(n).fill(0)
  M[n - 1] = d[n - 1] / b[n - 1]
  for (let i = n - 2; i >= 0; i--) M[i] = (d[i] - c[i] * M[i + 1]) / b[i]
  return (x) => {
    if (x <= xs[0]) return ys[0]
    if (x >= xs[n - 1]) return ys[n - 1]
    let i = 0
    while (x > xs[i + 1]) i++
    const H = h[i]
    const t = xs[i + 1] - x
    const u = x - xs[i]
    return (M[i] * t * t * t + M[i + 1] * u * u * u) / (6 * H) + (ys[i] / H - (M[i] * H) / 6) * t + (ys[i + 1] / H - (M[i + 1] * H) / 6) * u
  }
}

/**
 * Brightness/Contrast as Photoshop has it since CS3: curves, so the ends
 * stay put and nothing clips. Brightness slides one point along the
 * anti-diagonal; contrast is an S (or its flattening) through the quarter
 * points. Photoshop doesn't publish the curve; these constants are fitted
 * to its renders (scripts/fixtures/psd/adj_brightnesscontrast_rgb).
 */
function brightnessFn(brightness: number, contrast: number): (x: number) => number {
  const b = brightness / 100
  const c = contrast / 100
  const d = b > 0 ? 0.1636 * b : 0.1057 * b
  const k = c > 0 ? 0.1119 * c : 0.2624 * c
  const bf = Math.abs(d) > 1e-6 ? curveFn([[0, 0], [0.6994 - d, 0.6994 + d], [1, 1]]) : (x: number) => x
  const cf = Math.abs(k) > 1e-6 ? curveFn([[0, 0], [0.25, 0.25 - k], [0.75, 0.75 + k], [1, 1]]) : (x: number) => x
  return (x) => clamp(cf(clamp(bf(x))))
}

/** The legacy version: a shift, then a stretch about the middle, clipping at both ends. */
function legacyBrightnessFn(brightness: number, contrast: number): (x: number) => number {
  const k = contrast >= 0 ? 100 / Math.max(1e-3, 100 - contrast) : (100 + contrast) / 100
  return (x) => clamp((x + brightness / 255 - 0.5) * k + 0.5)
}

/** Levels: input black and white, gamma between, then output black and white. */
export function levelsFn(l: LevelsValue): (x: number) => number {
  return (x) => {
    const t = clamp((x - l.inBlack) / Math.max(1e-6, l.inWhite - l.inBlack))
    return l.outBlack + Math.pow(t, 1 / l.gamma) * (l.outWhite - l.outBlack)
  }
}

/**
 * A tone program: per-channel functions of the channel's own value, the
 * channel's own first then the master, as Photoshop has it. On CMYK they
 * apply to ink.
 */
function toneProgram(mode: Mode, master: (x: number) => number, own?: ((x: number) => number)[]): Program {
  const fns = Array.from({ length: nc(mode) }, (_, c) => {
    const o = own?.[c]
    return o ? (x: number) => master(o(x)) : master
  })
  return { op: OP.lut, f: [mode === 'cmyk' ? 1 : 0], table: tables(mode, fns) }
}

// --- colour helpers, shared with runProgram ---------------------------------------------

export const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h /= 6
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s <= 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number) => {
    t = t - Math.floor(t)
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)]
}

/**
 * Hue/Saturation's saturation, as Photoshop works it: each channel pushed
 * from (or pulled to) the colour's HSL lightness; at +100 anything with
 * colour goes fully saturated.
 */
function saturate(rgb: number[], a: number): number[] {
  const mx = Math.max(rgb[0], rgb[1], rgb[2])
  const mn = Math.min(rgb[0], rgb[1], rgb[2])
  const delta = mx - mn
  if (delta <= 0 || a === 0) return rgb.slice(0, 3)
  const sum = mx + mn
  const L = sum / 2
  if (a < 0) return rgb.slice(0, 3).map((v) => L + (v - L) * (1 + a))
  const S = L < 0.5 ? delta / sum : delta / (2 - sum)
  const k = 1 / (a + S >= 1 ? S : 1 - a) - 1
  return rgb.slice(0, 3).map((v) => clamp(v + (v - L) * k))
}

// --- colour cubes: adjustments that are any function of the colour --------------------------

/** A colour cube's side for adjustments worked out here: fine enough for smooth changes. */
const CUBE = 17

/**
 * A program that's a colour cube: `fn` (straight RGB, 0..1, in and out)
 * sampled at S³ points, read back trilinearly. Selective Colour, Photo
 * Filter, Colour Lookup, Colour Grading and Hue/Saturation's ranges are
 * all one of these, so the GPU needs one more op for all of them.
 */
export function cubeProgram(fn: (rgb: number[]) => number[], S = CUBE): Program {
  const t = new Float32Array(S * S * S * 3)
  for (let b = 0; b < S; b++)
    for (let g = 0; g < S; g++)
      for (let r = 0; r < S; r++) {
        const o = fn([r / (S - 1), g / (S - 1), b / (S - 1)])
        t.set([clamp(o[0]), clamp(o[1]), clamp(o[2])], ((b * S + g) * S + r) * 3)
      }
  return { op: OP.cube, f: [S], table: t }
}

/** A colour cube read at a colour, trilinearly: the reference the GPU is held to. */
function cubeAt(t: Float32Array, S: number, rgb: number[]): number[] {
  const p = rgb.map((v) => clamp(v) * (S - 1))
  const i = p.map((v) => Math.min(S - 2, Math.floor(v)))
  const f = p.map((v, k) => v - i[k])
  const out = [0, 0, 0]
  for (let dz = 0; dz < 2; dz++)
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) {
        const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2])
        const o = (((i[2] + dz) * S + i[1] + dy) * S + i[0] + dx) * 3
        for (let c = 0; c < 3; c++) out[c] += w * t[o + c]
      }
  return out
}

// --- Selective Colour --------------------------------------------------------------------------

const SELECTIVE_RANGES: [string, string][] = [
  ['reds', 'Reds'],
  ['yellows', 'Yellows'],
  ['greens', 'Greens'],
  ['cyans', 'Cyans'],
  ['blues', 'Blues'],
  ['magentas', 'Magentas'],
  ['whites', 'Whites'],
  ['neutrals', 'Neutrals'],
  ['blacks', 'Blacks'],
]

/** How much a colour belongs to each of Selective Colour's ranges, 0..1. */
export function selectiveWeights(rgb: number[]): Record<string, number> {
  const [r, g, b] = rgb
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const mid = r + g + b - mx - mn
  const w: Record<string, number> = {}
  w.reds = r === mx && r > mid ? mx - mid : 0
  w.greens = g === mx && g > mid && w.reds === 0 ? mx - mid : 0
  w.blues = b === mx && b > mid && !w.reds && !w.greens ? mx - mid : 0
  w.cyans = r === mn && r < mid ? mid - mn : 0
  w.magentas = g === mn && g < mid && !w.cyans ? mid - mn : 0
  w.yellows = b === mn && b < mid && !w.cyans && !w.magentas ? mid - mn : 0
  w.whites = mn > 0.5 ? (mn - 0.5) * 2 : 0
  w.blacks = mx < 0.5 ? (0.5 - mx) * 2 : 0
  w.neutrals = Math.max(0, 1 - (Math.abs(mx - 0.5) + Math.abs(mn - 0.5)))
  return w
}

/**
 * Selective Colour: each range's cyan, magenta, yellow and black (−1..1)
 * added to the inks (1 − each channel) of colours in that range, by how
 * much they belong to it; Relative scales the change by the ink already
 * there, Absolute doesn't.
 */
function selectiveFn(adj: Record<string, number[]>, relative: boolean) {
  return (rgb: number[]): number[] => {
    const w = selectiveWeights(rgb)
    const ink = rgb.map((v) => 1 - v)
    const k0 = Math.min(...ink)
    const out = [...ink]
    for (const [range] of SELECTIVE_RANGES) {
      const a = adj[range]
      if (!w[range] || !a || a.every((x) => x === 0)) continue
      for (let c = 0; c < 3; c++) {
        const d = a[c] * (relative ? (a[c] > 0 ? 1 - ink[c] : ink[c]) : 1) + a[3] * (relative ? (a[3] > 0 ? 1 - k0 : k0) : 1)
        out[c] += w[range] * d
      }
    }
    return out.map((v) => 1 - clamp(v))
  }
}

// --- Photo Filter ------------------------------------------------------------------------------

/** Photoshop's filters, by id: their colours, straight RGB 0..255. */
const PHOTO_FILTERS: [string, string, [number, number, number]][] = [
  ['warming-85', 'Warming Filter (85)', [236, 138, 0]],
  ['warming-lba', 'Warming Filter (LBA)', [250, 150, 0]],
  ['warming-81', 'Warming Filter (81)', [235, 177, 19]],
  ['cooling-80', 'Cooling Filter (80)', [0, 109, 255]],
  ['cooling-lbb', 'Cooling Filter (LBB)', [0, 93, 255]],
  ['cooling-82', 'Cooling Filter (82)', [0, 181, 255]],
  ['red', 'Red', [234, 26, 26]],
  ['orange', 'Orange', [243, 132, 23]],
  ['yellow', 'Yellow', [249, 227, 28]],
  ['green', 'Green', [25, 201, 25]],
  ['cyan', 'Cyan', [29, 203, 234]],
  ['blue', 'Blue', [29, 53, 234]],
  ['violet', 'Violet', [155, 29, 234]],
  ['magenta', 'Magenta', [227, 24, 227]],
  ['sepia', 'Sepia', [172, 122, 51]],
  ['deep-red', 'Deep Red', [255, 0, 0]],
  ['deep-blue', 'Deep Blue', [0, 34, 205]],
  ['deep-emerald', 'Deep Emerald', [0, 140, 0]],
  ['deep-yellow', 'Deep Yellow', [255, 213, 0]],
  ['underwater', 'Underwater', [0, 194, 177]],
]

/** Photo Filter: the colour multiplied in at `density` (0..1), the lightness kept when asked. */
function photoFilterFn(f: number[], density: number, keep: boolean) {
  return (rgb: number[]): number[] => {
    const out = rgb.map((v, c) => v + (v * f[c] - v) * density)
    if (!keep) return out
    const d = luma(rgb[0], rgb[1], rgb[2]) - luma(out[0], out[1], out[2])
    return out.map((v) => v + d)
  }
}

// --- Colour Lookup ------------------------------------------------------------------------------

/** Colour Lookup's built-in looks, worked out here rather than read from files. */
const LOOKS: [string, string, (rgb: number[]) => number[]][] = [
  ['warm', 'Warm', ([r, g, b]) => [r * 1.06 + 0.02, g * 1.01, b * 0.88]],
  ['cool', 'Cool', ([r, g, b]) => [r * 0.9, g * 1.0, b * 1.08 + 0.02]],
  [
    'teal-orange',
    'Teal and Orange',
    (c) => {
      const y = luma(c[0], c[1], c[2])
      const s = smooth01(y)
      // Shadows to teal, highlights to orange, the lightness kept.
      const t = [c[0] - 0.08 * (1 - s) + 0.1 * s, c[1] + 0.02 * (1 - s) + 0.02 * s, c[2] + 0.08 * (1 - s) - 0.1 * s]
      const d = y - luma(t[0], t[1], t[2])
      return t.map((v) => v + d)
    },
  ],
  [
    'film',
    'Film',
    (c) => {
      // A gentle S, lifted blacks, a touch less saturation.
      const s = c.map((v) => 0.04 + 0.92 * (v * v * (3 - 2 * v) * 0.6 + v * 0.4))
      const y = luma(s[0], s[1], s[2])
      return s.map((v) => y + (v - y) * 0.88)
    },
  ],
  [
    'bleach',
    'Bleach Bypass',
    (c) => {
      const y = luma(c[0], c[1], c[2])
      const ov = (a: number, b: number) => (b < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b))
      return c.map((v) => v * 0.4 + ov(v, y) * 0.6)
    },
  ],
  [
    'sepia',
    'Sepia',
    (c) => {
      const y = luma(c[0], c[1], c[2])
      return [y * 1.07 + 0.03, y * 0.95 + 0.01, y * 0.75]
    },
  ],
  [
    'night',
    'Day for Night',
    (c) => {
      const y = luma(c[0], c[1], c[2])
      return [y * 0.35, y * 0.5, y * 0.85 + 0.03]
    },
  ],
  ['fade', 'Faded', (c) => c.map((v) => 0.12 + v * 0.8)],
  [
    'crisp',
    'Crisp',
    (c) => {
      const s = c.map((v) => v * v * (3 - 2 * v))
      const y = luma(s[0], s[1], s[2])
      return s.map((v) => y + (v - y) * 1.15)
    },
  ],
]
const smooth01 = (x: number) => clamp(x) * clamp(x) * (3 - 2 * clamp(x))

/** A colour lookup table read from a file: its grid and its colours, 16-bit, in base 64. */
export interface StoredCube {
  name: string
  size: number
  data: string
}

/** A `.cube` file (Adobe's and Resolve's 3D LUTs) as a stored cube; null with what's wrong. */
export function parseCube(text: string, name: string): StoredCube | { error: string } {
  let size = 0
  let lo = [0, 0, 0]
  let hi = [1, 1, 1]
  const vals: number[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    const key = parts[0].toUpperCase()
    if (key === 'TITLE') continue
    if (key === 'LUT_1D_SIZE') return { error: 'It’s a one-dimensional table; Colour Lookup takes 3D tables (LUT_3D_SIZE).' }
    if (key === 'LUT_3D_SIZE') size = Number(parts[1])
    else if (key === 'DOMAIN_MIN') lo = parts.slice(1, 4).map(Number)
    else if (key === 'DOMAIN_MAX') hi = parts.slice(1, 4).map(Number)
    else if (/^[-+.\d]/.test(parts[0]) && parts.length >= 3) vals.push(...parts.slice(0, 3).map(Number))
  }
  if (!Number.isInteger(size) || size < 2 || size > 65) return { error: 'It has no LUT_3D_SIZE between 2 and 65.' }
  if (vals.length !== size * size * size * 3 || vals.some((v) => !Number.isFinite(v))) return { error: `It should have ${size ** 3} colours and has ${Math.floor(vals.length / 3)}.` }
  const u = new Uint16Array(vals.length)
  for (let i = 0; i < vals.length; i++) u[i] = Math.round(clamp((vals[i] - lo[i % 3]) / (hi[i % 3] - lo[i % 3] || 1)) * 65535)
  return { name, size, data: bytesToBase64(new Uint8Array(u.buffer)) }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=')
  }
  return s
}
const cubes = new Map<string, Float32Array>()
/** A stored cube's colours, 0..1, red fastest, decoded once per data string. */
export function cubeColours(c: StoredCube): Float32Array | null {
  let t = cubes.get(c.data)
  if (t) return t
  const at = new Int16Array(128).fill(-1)
  for (let i = 0; i < 64; i++) at[B64.charCodeAt(i)] = i
  const s = c.data
  const n = c.size ** 3 * 3
  const bytes = new Uint8Array(n * 2)
  let o = 0
  for (let i = 0; i < s.length && o < bytes.length; i += 4) {
    const k = (at[s.charCodeAt(i)] << 18) | (at[s.charCodeAt(i + 1)] << 12) | ((s[i + 2] === '=' ? 0 : at[s.charCodeAt(i + 2)]) << 6) | (s[i + 3] === '=' ? 0 : at[s.charCodeAt(i + 3)])
    bytes[o++] = (k >> 16) & 255
    if (o < bytes.length) bytes[o++] = (k >> 8) & 255
    if (o < bytes.length) bytes[o++] = k & 255
  }
  if (o < bytes.length) return null
  const u = new Uint16Array(bytes.buffer)
  t = new Float32Array(n)
  for (let i = 0; i < n; i++) t[i] = u[i] / 65535
  cubes.set(c.data, t)
  if (cubes.size > 8) cubes.delete(cubes.keys().next().value!)
  return t
}

function readStoredCube(v: unknown): StoredCube | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (typeof r.name !== 'string' || typeof r.size !== 'number' || typeof r.data !== 'string' || r.size < 2 || r.size > 65) return null
  return { name: r.name, size: r.size, data: r.data }
}

// --- Colour Grading -----------------------------------------------------------------------------

/** A wheel's push: a hue (degrees) and how far towards it (0..1), as an offset to each channel about none. */
const push = (hue: number, amount: number): number[] => hslToRgb(hue / 360, 1, 0.5).map((v) => (v - 0.5) * amount)

/**
 * Colour Grading: shadows, midtones and highlights each pushed towards a
 * hue and made lighter or darker, by how much a colour is in each (Balance
 * moving where shadows end and highlights begin, Blending how much they
 * overlap), then the whole image towards Global's.
 */
function gradingFn(w: Record<string, [number, number]>, lum: Record<string, number>, balance: number, blending: number) {
  const pushes = Object.fromEntries(Object.entries(w).map(([k, [h, a]]) => [k, push(h, a / 100)]))
  return (rgb: number[]): number[] => {
    // Shadows, midtones and highlights as Colour Balance weighs them, Balance moving the middle, Blending widening them.
    const y = clamp(luma(rgb[0], rgb[1], rgb[2]) - balance * 0.25)
    const e = 2 - blending
    const ws = Math.pow(1 - y, e) * (1 - y)
    const wh = Math.pow(y, e) * y
    const wm = Math.max(0, 1 - ws - wh)
    return rgb.map((v, c) => v + ws * (pushes.shadows[c] * 0.5 + lum.shadows) + wm * (pushes.midtones[c] * 0.5 + lum.midtones) + wh * (pushes.highlights[c] * 0.5 + lum.highlights) + pushes.global[c] * 0.5 + lum.global)
  }
}

// --- Hue/Saturation's ranges --------------------------------------------------------------------

const HUE_RANGES: [string, string, number][] = [
  ['reds', 'Reds', 0],
  ['yellows', 'Yellows', 60],
  ['greens', 'Greens', 120],
  ['cyans', 'Cyans', 180],
  ['blues', 'Blues', 240],
  ['magentas', 'Magentas', 300],
]

/**
 * Each range's hue limits, as Photoshop keeps them: where it starts to
 * come in, where it's whole, where it starts to go and where it's gone,
 * in degrees round from red. These are Photoshop's own to start with.
 */
const HUE_LIMITS: Record<string, [number, number, number, number]> = {
  reds: [315, 345, 15, 45],
  yellows: [15, 45, 75, 105],
  greens: [75, 105, 135, 165],
  cyans: [135, 165, 195, 225],
  blues: [195, 225, 255, 285],
  magentas: [255, 285, 315, 345],
}

/** How much a hue (degrees) is in a range with these limits: rising, whole, falling, round the circle. */
export function rangeWeight(hue: number, limits: [number, number, number, number]): number {
  const a = limits[0]
  const up = (x: number, from: number) => (x < from ? x + 360 * Math.ceil((from - x) / 360) : x)
  const b = up(limits[1], a)
  const c = up(limits[2], b)
  const d = up(limits[3], c)
  const h = up(((hue % 360) + 360) % 360, a)
  if (h > d && h - 360 < a) return 0
  if (h < b) return b > a ? (h - a) / (b - a) : 1
  if (h <= c) return 1
  if (h < d) return d > c ? (d - h) / (d - c) : 0
  return 0
}

/**
 * Hue/Saturation with ranges, as Photoshop works it: each colour's hue,
 * saturation and lightness changes are the master's plus each range's by
 * how much the colour's hue is in it, then made at once.
 */
/**
 * Hue/Saturation with ranges: each colour's hue, saturation and lightness
 * changes are the master's plus each range's by how much the colour's hue
 * is in it, then made at once. Photoshop doesn't publish how ranges that
 * overlap combine; this is how GIMP's emulation of it does.
 */
function hueRangesFn(master: [number, number, number], ranges: Record<string, [number, number, number]>, limits: Record<string, [number, number, number, number]>) {
  return (rgb: number[]): number[] => {
    const [h0, s0] = rgbToHsl(rgb[0], rgb[1], rgb[2])
    let [h, s, l] = master
    if (s0 > 1e-6)
      for (const [id] of HUE_RANGES) {
        const r = ranges[id]
        if (!r || (!r[0] && !r[1] && !r[2])) continue
        const w = rangeWeight(h0 * 360, limits[id] ?? HUE_LIMITS[id])
        h += r[0] * w
        s += r[1] * w
        l += r[2] * w
      }
    const k = (x: number) => Math.max(-1, Math.min(1, x / 100))
    return runProgram({ op: OP.hsl, f: [h / 360, k(s), k(l), 0], table: null }, 'rgb', rgb)
  }
}

const readLimits = (v: unknown): [number, number, number, number] | null => (Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (v.map((x) => ((x % 360) + 360) % 360) as [number, number, number, number]) : null)

// --- the registry ------------------------------------------------------------------------

const n = <K extends string>(key: K, label: string, min: number, max: number, def: number, unit = '', step = 1, hint?: string) => ({ key, kind: 'number' as const, label, min, max, step, unit, default: def, hint })

export const ADJUSTMENT_DEFS: AdjustmentDef[] = [
  defineAdjustment({
    id: 'levels',
    label: 'Levels',
    params: [{ key: 'levels', kind: 'levels', label: 'Levels', hint: 'Input black and white points, gamma, and the output range, for all channels together and each on its own.' }],
    compile(v, mode) {
      const l = v.levels as Record<string, LevelsValue>
      const ch = CHANNELS[mode].slice(1)
      return toneProgram(mode, levelsFn(l.master ?? LEVELS_IDENTITY), ch.length ? ch.map((c) => levelsFn(l[c] ?? LEVELS_IDENTITY)) : undefined)
    },
  }),
  defineAdjustment({
    id: 'curves',
    label: 'Curves',
    params: [{ key: 'curves', kind: 'curves', label: 'Curves', hint: 'A tone curve for all channels together and each on its own.' }],
    compile(v, mode) {
      const c = v.curves as Record<string, CurvePoints>
      const ch = CHANNELS[mode].slice(1)
      return toneProgram(mode, curveFn(c.master ?? CURVE_IDENTITY), ch.length ? ch.map((k) => curveFn(c[k] ?? CURVE_IDENTITY)) : undefined)
    },
  }),
  defineAdjustment({
    id: 'brightness-contrast',
    label: 'Brightness/Contrast',
    params: [
      n('brightness', 'Brightness', -150, 150, 0),
      n('contrast', 'Contrast', -50, 100, 0),
      { key: 'legacy', kind: 'bool', label: 'Use legacy', default: false, hint: 'The old straight-line version: brightness shifts every value, contrast stretches them about the middle, and both clip.' },
    ],
    compile(v, mode) {
      const b = v.brightness
      const c = v.contrast
      return toneProgram(mode, v.legacy ? legacyBrightnessFn(b, c) : brightnessFn(b, c))
    },
  }),
  defineAdjustment({
    id: 'exposure',
    label: 'Exposure',
    params: [n('exposure', 'Exposure', -20, 20, 0, 'stops', 0.01), n('offset', 'Offset', -0.5, 0.5, 0, '', 0.001), n('gamma', 'Gamma', 0.01, 9.99, 1, '', 0.01)],
    compile(v, mode) {
      const e = Math.pow(2, v.exposure)
      const o = v.offset
      const g = v.gamma
      // Photoshop works exposure in linear light: the values are taken out of a 2.2 gamma and put back.
      return toneProgram(mode, (x) => Math.pow(Math.pow(clamp(Math.pow(x, 2.2) * e + o), 1 / g), 1 / 2.2))
    },
  }),
  defineAdjustment({
    id: 'invert',
    label: 'Invert',
    params: [],
    compile: (_v, mode) => toneProgram(mode, (x) => 1 - x),
  }),
  defineAdjustment({
    id: 'posterize',
    label: 'Posterize',
    params: [n('levels', 'Levels', 2, 255, 4)],
    compile(v, mode) {
      const k = v.levels - 1
      // Equal bins across the range, each to its own level (Photoshop's way): floor(v·n/256) on 8-bit values.
      return toneProgram(mode, (x) => Math.min(k, Math.floor(clamp(x) * (k + 1) * (255 / 256))) / k)
    },
  }),
  defineAdjustment({
    id: 'threshold',
    label: 'Threshold',
    params: [n('level', 'Threshold level', 1, 255, 128)],
    compile: (v, mode) => ({ op: OP.threshold, f: [v.level / 255, mode === 'cmyk' ? 1 : 0], table: null }),
  }),
  defineAdjustment({
    id: 'hue-saturation',
    label: 'Hue/Saturation',
    params: [
      { key: 'range', kind: 'choice', label: 'Range', options: [['master', 'Master'], ...HUE_RANGES.map(([id, label]): [string, string] => [id, label])], default: 'master', hint: 'Master changes every colour; a range only the colours near its hue, each range keeping its own settings.' },
      { ...n('hue', 'Hue', -180, 180, 0, '°'), when: (v) => v.range === 'master' },
      { ...n('saturation', 'Saturation', -100, 100, 0), when: (v) => v.range === 'master' },
      { ...n('lightness', 'Lightness', -100, 100, 0), when: (v) => v.range === 'master' },
      ...HUE_RANGES.flatMap(([r]): ParamDef[] => [
        { ...n(`${r}Hue`, 'Hue', -180, 180, 0, '°'), when: (v) => v.range === r && !v.colorize },
        { ...n(`${r}Saturation`, 'Saturation', -100, 100, 0), when: (v) => v.range === r && !v.colorize },
        { ...n(`${r}Lightness`, 'Lightness', -100, 100, 0), when: (v) => v.range === r && !v.colorize },
        { key: `${r}Limits`, kind: 'data', label: 'Limits', read: readLimits, default: HUE_LIMITS[r] },
      ]),
      { key: 'colorize', kind: 'bool', label: 'Colourise', default: false, hint: 'Give the whole image one hue, with the saturation set here.' },
    ],
    compile(v) {
      const master: [number, number, number] = [v.hue, v.saturation, v.lightness]
      const ranges = Object.fromEntries(HUE_RANGES.map(([r]) => [r, [v[`${r}Hue`], v[`${r}Saturation`], v[`${r}Lightness`]] as [number, number, number]]))
      // Only the master: Photoshop's sums exactly, as before; with a range, a colour cube of them.
      if (v.colorize || Object.values(ranges).every((r) => r.every((x) => !x))) return { op: OP.hsl, f: [master[0] / 360, master[1] / 100, master[2] / 100, v.colorize ? 1 : 0], table: null }
      const limits = Object.fromEntries(HUE_RANGES.map(([r]) => [r, v[`${r}Limits`] as [number, number, number, number]]))
      return cubeProgram(hueRangesFn(master, ranges, limits), 33)
    },
  }),
  defineAdjustment({
    id: 'vibrance',
    label: 'Vibrance',
    params: [n('vibrance', 'Vibrance', -100, 100, 0, '', 1, 'Raises the saturation of dull colours more than of those already strong.'), n('saturation', 'Saturation', -100, 100, 0)],
    compile: (v) => ({ op: OP.vibrance, f: [v.vibrance / 100, v.saturation / 100], table: null }),
  }),
  defineAdjustment({
    id: 'colour-balance',
    label: 'Colour Balance',
    params: [
      ...(['shadows', 'midtones', 'highlights'] as const).flatMap((r) => [
        n(`${r}CyanRed`, `${r[0].toUpperCase()}${r.slice(1)}: Cyan–Red`, -100, 100, 0),
        n(`${r}MagentaGreen`, `${r[0].toUpperCase()}${r.slice(1)}: Magenta–Green`, -100, 100, 0),
        n(`${r}YellowBlue`, `${r[0].toUpperCase()}${r.slice(1)}: Yellow–Blue`, -100, 100, 0),
      ]),
      { key: 'preserveLuminosity', kind: 'bool', label: 'Preserve luminosity', default: true },
    ],
    compile: (v) => ({
      op: OP.balance,
      f: [
        ...(['shadows', 'midtones', 'highlights'] as const).flatMap((r) => [v[`${r}CyanRed`], v[`${r}MagentaGreen`], v[`${r}YellowBlue`]].map((x) => (x as number) / 200)),
        v.preserveLuminosity ? 1 : 0,
      ],
      table: null,
    }),
  }),
  defineAdjustment({
    id: 'black-white',
    label: 'Black & White',
    params: [
      n('reds', 'Reds', -200, 300, 40, '%'),
      n('yellows', 'Yellows', -200, 300, 60, '%'),
      n('greens', 'Greens', -200, 300, 40, '%'),
      n('cyans', 'Cyans', -200, 300, 60, '%'),
      n('blues', 'Blues', -200, 300, 20, '%'),
      n('magentas', 'Magentas', -200, 300, 80, '%'),
      { key: 'tint', kind: 'bool', label: 'Tint', default: false },
      n('tintHue', 'Tint hue', 0, 360, 35, '°'),
      n('tintSaturation', 'Tint saturation', 0, 100, 25, '%'),
    ],
    compile: (v) => ({
      op: OP.bw,
      f: [...(['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const).map((k) => v[k] / 100), v.tint ? 1 : 0, v.tintHue / 360, v.tintSaturation / 100],
      table: null,
    }),
  }),
  defineAdjustment({
    id: 'channel-mixer',
    label: 'Channel Mixer',
    params: [
      { key: 'monochrome', kind: 'bool', label: 'Monochrome', default: false },
      ...(['red', 'green', 'blue', 'gray'] as const).flatMap((out) => [
        n(`${out}FromRed`, `${out[0].toUpperCase()}${out.slice(1)}: from red`, -200, 200, out === 'red' ? 100 : out === 'gray' ? 40 : 0, '%'),
        n(`${out}FromGreen`, `${out[0].toUpperCase()}${out.slice(1)}: from green`, -200, 200, out === 'green' ? 100 : out === 'gray' ? 40 : 0, '%'),
        n(`${out}FromBlue`, `${out[0].toUpperCase()}${out.slice(1)}: from blue`, -200, 200, out === 'blue' ? 100 : out === 'gray' ? 20 : 0, '%'),
        n(`${out}Constant`, `${out[0].toUpperCase()}${out.slice(1)}: constant`, -200, 200, 0, '%'),
      ]),
    ],
    compile(v) {
      const row = (o: 'gray' | 'red' | 'green' | 'blue') => [v[`${o}FromRed`], v[`${o}FromGreen`], v[`${o}FromBlue`], v[`${o}Constant`]].map((x) => x / 100)
      const rows = v.monochrome ? [row('gray'), row('gray'), row('gray')] : [row('red'), row('green'), row('blue')]
      return { op: OP.mixer, f: [...rows.flat(), ...row('gray')], table: null }
    },
  }),
  defineAdjustment({
    id: 'gradient-map',
    label: 'Gradient Map',
    params: [{ key: 'gradient', kind: 'gradient', label: 'Gradient', hint: 'Each tone of the image becomes the gradient’s colour at that point: shadows from the left, highlights from the right.' }, { key: 'reverse', kind: 'bool', label: 'Reverse', default: false }],
    compile(v, mode) {
      const stops = v.gradient as GradientStop[]
      const t = new Float32Array(LUT_SIZE * 4)
      const ch = nc(mode)
      for (let i = 0; i < LUT_SIZE; i++) {
        let x = i / (LUT_SIZE - 1)
        if (v.reverse) x = 1 - x
        const c = gradientAt(stops, x)
        // In the working space: CMYK's inks as light.
        for (let k = 0; k < ch; k++) t[i * 4 + k] = mode === 'cmyk' ? 1 - c[k] : c[k]
      }
      return { op: OP.gradient, f: [mode === 'cmyk' ? 1 : 0], table: t }
    },
  }),
]

const cap = (x: string) => x[0].toUpperCase() + x.slice(1)
const INKS = ['cyan', 'magenta', 'yellow', 'black'] as const
const WHEELS = ['shadows', 'midtones', 'highlights', 'global'] as const

ADJUSTMENT_DEFS.push(
  defineAdjustment({
    id: 'selective-colour',
    label: 'Selective Colour',
    params: [
      { key: 'range', kind: 'choice', label: 'Colours', options: SELECTIVE_RANGES, default: 'reds', hint: 'Which colours the four sliders below change: each range keeps its own.' },
      ...SELECTIVE_RANGES.flatMap(([r]) => INKS.map((k): ParamDef => ({ ...n(`${r}_${k}`, cap(k), -100, 100, 0, '%'), when: (v) => v.range === r }))),
      { key: 'method', kind: 'choice', label: 'Method', options: [['relative', 'Relative'], ['absolute', 'Absolute']], default: 'relative', hint: 'Relative changes each ink by a share of what’s there; Absolute by the amount itself.' },
    ],
    compile(v) {
      const adj = Object.fromEntries(SELECTIVE_RANGES.map(([r]) => [r, INKS.map((k) => (v[`${r}_${k}`] as number) / 100)]))
      return cubeProgram(selectiveFn(adj, v.method === 'relative'))
    },
  }),
  defineAdjustment({
    id: 'photo-filter',
    label: 'Photo Filter',
    params: [
      { key: 'filter', kind: 'choice', label: 'Filter', options: [...PHOTO_FILTERS.map(([id, label]): [string, string] => [id, label]), ['custom', 'Colour…']], default: 'warming-85' },
      { key: 'colour', kind: 'colour', label: 'Colour', default: [0.93, 0.54, 0], when: (v) => v.filter === 'custom' },
      n('density', 'Density', 1, 100, 25, '%', 1, 'How strongly the filter’s colour tints the image.'),
      { key: 'preserve', kind: 'bool', label: 'Preserve luminosity', default: true },
    ],
    compile(v, mode) {
      const preset = PHOTO_FILTERS.find((p) => p[0] === v.filter)
      const c = v.colour
      // A colour of the document's own as RGB: Gray's one channel three times, CMYK's inks as light.
      const own = mode === 'rgb' ? c : mode === 'gray' ? [c[0], c[0], c[0]] : [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])]
      const f = preset ? preset[2].map((x) => x / 255) : own
      return cubeProgram(photoFilterFn(f, v.density / 100, !!v.preserve))
    },
  }),
  defineAdjustment({
    id: 'colour-lookup',
    label: 'Colour Lookup',
    params: [
      { key: 'look', kind: 'choice', label: 'Look', options: [...LOOKS.map(([id, label]): [string, string] => [id, label]), ['file', 'From a file (.cube)']], default: 'film' },
      {
        key: 'lut',
        kind: 'file',
        label: '3D LUT file',
        accept: '.cube',
        hint: 'A .cube colour lookup table, as cameras, grading software and Photoshop use.',
        load: (text, name) => parseCube(text, name),
        read: readStoredCube,
        describe: (x) => (x ? (x as StoredCube).name : 'None loaded'),
        when: (v) => v.look === 'file',
      },
    ],
    compile(v, mode) {
      if (v.look === 'file') {
        const c = v.lut as StoredCube | null
        const t = c ? cubeColours(c) : null
        return t ? { op: OP.cube, f: [c!.size], table: t } : toneProgram(mode, (x) => x)
      }
      return cubeProgram(LOOKS.find((l) => l[0] === v.look)?.[2] ?? ((x) => x))
    },
  }),
  defineAdjustment({
    id: 'colour-grading',
    label: 'Colour Grading',
    params: [
      ...WHEELS.flatMap((w): ParamDef[] => [
        { key: `${w}Wheel`, kind: 'wheel', label: cap(w), hint: `Pushes the ${w === 'global' ? 'whole image' : w} towards a hue: drag from the middle, further for more.` },
        n(`${w}Lum`, `${cap(w)} luminance`, -100, 100, 0),
      ]),
      n('balance', 'Balance', -100, 100, 0, '', 1, 'Moves where the shadows end and the highlights begin.'),
      n('blending', 'Blending', 0, 100, 50, '%', 1, 'How much the shadows, midtones and highlights overlap.'),
    ],
    compile(v) {
      const w = Object.fromEntries(WHEELS.map((k) => [k, v[`${k}Wheel`] as [number, number]]))
      const lum = Object.fromEntries(WHEELS.map((k) => [k, (v[`${k}Lum`] as number) / 400]))
      return cubeProgram(gradingFn(w, lum, v.balance / 100, v.blending / 100))
    },
  }),
)

export const ADJUSTMENT_BY_ID = new Map(ADJUSTMENT_DEFS.map((d) => [d.id, d]))

/** A gradient's colour at x, between its stops. */
export function gradientAt(stops: GradientStop[], x: number): number[] {
  if (x <= stops[0].at) return stops[0].colour
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i].at) {
      const a = stops[i - 1]
      const b = stops[i]
      const t = (x - a.at) / Math.max(1e-9, b.at - a.at)
      return a.colour.map((c, k) => c + (b.colour[k] - c) * t)
    }
  }
  return stops[stops.length - 1].colour
}

/** An adjustment node's program, from its kind and raw parameters; null for a kind this build doesn't know. */
export function programFor(id: string, raw: unknown, mode: Mode): Program | null {
  const def = ADJUSTMENT_BY_ID.get(id)
  if (!def) return null
  return def.compile(readParamValues(def.params, raw, mode), mode)
}

// --- the reference --------------------------------------------------------------------------

function lookup(t: Float32Array, c: number, x: number): number {
  const p = clamp(x) * (LUT_SIZE - 1)
  const i = Math.min(LUT_SIZE - 2, Math.floor(p))
  const f = p - i
  return t[c * LUT_SIZE + i] * (1 - f) + t[c * LUT_SIZE + i + 1] * f
}

/** A CMYK colour (light) as RGB for the colour operations, and back, keeping black. */
const cmykToRgb = (c: number[]) => [c[0] * c[3], c[1] * c[3], c[2] * c[3]]
const rgbToCmyk = (rgb: number[], k: number) => (k <= 1e-6 ? [1, 1, 1, k] : [clamp(rgb[0] / k), clamp(rgb[1] / k), clamp(rgb[2] / k), k])

/**
 * A program run on one straight working-space colour (alpha isn't
 * touched): the reference the GPU is held to.
 */
export function runProgram(p: Program, mode: Mode, colour: number[], tables: CmykTables | null = null): number[] {
  const f = p.f
  if (p.op === OP.lut) {
    // CMYK's tone tables work on ink.
    const ink = f[0] > 0.5
    return colour.map((v, c) => (ink ? 1 - lookup(p.table!, c, 1 - v) : lookup(p.table!, c, v)))
  }
  // Everything else works on RGB: Gray's one channel as three, CMYK's inks as a plain RGB view.
  const rgb = mode === 'rgb' ? colour.slice(0, 3) : mode === 'gray' ? [colour[0], colour[0], colour[0]] : tables ? cmykToRgbT(tables, colour) : cmykToRgb(colour)
  let out: number[]
  switch (p.op) {
    case OP.threshold: {
      const y = luma(rgb[0], rgb[1], rgb[2]) >= f[0] ? 1 : 0
      // Threshold is pure black or white, and in CMYK black is all ink in K.
      if (mode === 'cmyk') return [1, 1, 1, y]
      out = [y, y, y]
      break
    }
    case OP.hsl: {
      if (f[3] > 0.5) {
        let [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2])
        h = f[0] < 0 ? f[0] + 1 : f[0]
        s = clamp(0.25 + f[1] * 0.75)
        l = f[2] < 0 ? l * (1 + f[2]) : l + (1 - l) * f[2]
        out = hslToRgb(h, s, l)
      } else {
        // Photoshop's order: lightness towards black or white, the hue turned, then saturation about the lightness.
        const L = f[2]
        const lit = rgb.map((v) => (L < 0 ? v * (1 + L) : v + (1 - v) * L))
        const [h1, s1, l1] = rgbToHsl(lit[0], lit[1], lit[2])
        out = saturate(hslToRgb(h1 + f[0], s1, l1), f[1])
      }
      break
    }
    case OP.vibrance: {
      let [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2])
      s = clamp(s * (1 + f[0] * (1 - s)))
      s = f[1] < 0 ? s * (1 + f[1]) : clamp(s + (1 - s) * f[1] * s)
      out = hslToRgb(h, s, l)
      break
    }
    case OP.balance: {
      const y0 = luma(rgb[0], rgb[1], rgb[2])
      const ws = (1 - y0) * (1 - y0)
      const wh = y0 * y0
      const wm = 1 - ws - wh
      out = [0, 1, 2].map((c) => rgb[c] + ws * f[c] + wm * f[3 + c] + wh * f[6 + c])
      if (f[9] > 0.5) {
        const d = y0 - luma(out[0], out[1], out[2])
        out = out.map((x) => x + d)
      }
      break
    }
    case OP.bw: {
      // Photoshop's: the share of the strongest primary and of the
      // secondary it makes with the next, each by its weight.
      const order = [0, 1, 2].sort((a, c) => rgb[c] - rgb[a])
      const [hi, mid] = order
      const lo = rgb[order[2]]
      const primary = [0, 2, 4][hi]
      const pair = hi + mid
      // red+green: yellow; green+blue: cyan; red+blue: magenta.
      const secondary = pair === 1 ? 1 : pair === 3 ? 3 : 5
      let y = lo + (rgb[hi] - rgb[mid]) * f[primary] + (rgb[mid] - lo) * f[secondary]
      y = clamp(y)
      out = f[6] > 0.5 ? hslToRgb(f[7], f[8], y) : [y, y, y]
      if (f[6] > 0.5) {
        // Tinted, keeping the gray's lightness.
        const d = y - luma(out[0], out[1], out[2])
        out = out.map((x) => x + d)
      }
      break
    }
    case OP.mixer: {
      out = [0, 1, 2].map((o) => rgb[0] * f[o * 4] + rgb[1] * f[o * 4 + 1] + rgb[2] * f[o * 4 + 2] + f[o * 4 + 3])
      if (mode === 'gray') {
        const y = rgb[0] * f[12] + rgb[1] * f[13] + rgb[2] * f[14] + f[15]
        out = [y, y, y]
      }
      break
    }
    case OP.cube:
      out = cubeAt(p.table!, f[0], rgb)
      break
    case OP.gradient: {
      const t = p.table!
      const p0 = clamp(luma(rgb[0], rgb[1], rgb[2])) * (LUT_SIZE - 1)
      const i = Math.min(LUT_SIZE - 2, Math.floor(p0))
      const fr = p0 - i
      const g = [0, 1, 2, 3].map((k) => t[i * 4 + k] * (1 - fr) + t[(i + 1) * 4 + k] * fr)
      // The table is already in the working space, CMYK as light.
      return mode === 'rgb' ? g.slice(0, 3) : mode === 'gray' ? [g[0]] : g.slice(0, 4)
    }
    default:
      return colour
  }
  out = out.map(clamp)
  if (mode === 'rgb') return out
  if (mode === 'gray') return [clamp(luma(out[0], out[1], out[2]))]
  return tables ? adjustedCmyk(tables, colour, rgb, out) : rgbToCmyk(out, colour[3])
}
