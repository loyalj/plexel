/**
 * Brush tips. The round tip is computed (dab.ts `roundMask`); every other
 * is an image of coverage values 0..1. The built-in ones are made here from
 * fixed seeds, so they're the same on every machine and nothing
 * third-party ships; the rest come from Define Brush Preset and ABR files,
 * registered by their content hash ('tip:…') wherever they're used: the
 * page, the engine worker, the checks.
 *
 * Any size and shape: the image's longer side spans the tip's diameter,
 * centred, and its shorter side keeps its proportion. Each tip keeps a mip
 * chain, halving down to a pixel, so a 1,000-pixel tip stamped at 10
 * pixels reads a level that's 16 pixels across, not every 64th texel of
 * the full one. A tip is read trilinearly between the two levels around
 * the dab's scale, the same here and on the GPU (shaders/paint.ts).
 */
import { BUILTIN_TIPS, type TipId } from './defs'
import { rng } from './rng'

/** The built-in sampled tips' size, a side. */
export const BUILTIN_TIP_SIZE = 256
/** The largest a tip is kept, a side: bigger images are scaled down to it. */
export const MAX_TIP_SIZE = 1024

export interface TipImage {
  width: number
  height: number
  /** Level 0 is the image; each next is half the size (rounded up), to 1 × 1. */
  levels: Float32Array[]
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** A soft disc broken up by noise: chalk on paper. */
function chalk(n: number): Float32Array {
  const r = rng(101)
  const out = new Float32Array(n * n)
  // Grain about a sixtieth of the tip across, as it was at 64 pixels: blocks of noise, smoothed.
  const g = 64
  const grain = Array.from({ length: g * g }, r)
  const at = (x: number, y: number) => grain[(((y % g) + g) % g) * g + (((x % g) + g) % g)]
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5
      const dy = (y + 0.5) / n - 0.5
      const d = Math.hypot(dx, dy) * 2
      const disc = 1 - smooth(0.6, 1, d)
      const gx = ((x + 0.5) / n) * g - 0.5
      const gy = ((y + 0.5) / n) * g - 0.5
      const x0 = Math.floor(gx)
      const y0 = Math.floor(gy)
      const tx = gx - x0
      const ty = gy - y0
      const v = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
      out[y * n + x] = disc * smooth(0.35, 0.75, v)
    }
  }
  return out
}

/** Separate round drops of different sizes. */
function spatter(n: number): Float32Array {
  const r = rng(202)
  const out = new Float32Array(n * n)
  for (let i = 0; i < 24; i++) {
    const a = r() * Math.PI * 2
    const dist = Math.sqrt(r()) * 0.42
    const cx = 0.5 + Math.cos(a) * dist
    const cy = 0.5 + Math.sin(a) * dist
    const rad = 0.015 + r() * 0.06
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const d = Math.hypot((x + 0.5) / n - cx, (y + 0.5) / n - cy)
        const v = 1 - smooth(rad * 0.7, rad, d)
        const k = y * n + x
        out[k] = Math.max(out[k], v)
      }
    }
  }
  return out
}

/** Parallel hairs across the tip, of uneven strength: a dry bristle brush. */
function bristle(n: number): Float32Array {
  const r = rng(303)
  const out = new Float32Array(n * n)
  const hairs = Array.from({ length: 18 }, () => ({ x: 0.08 + r() * 0.84, w: 0.01 + r() * 0.025, s: 0.4 + r() * 0.6, l: 0.25 + r() * 0.2 }))
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n
      const v = (y + 0.5) / n
      let m = 0
      for (const h of hairs) {
        const across = 1 - smooth(h.w * 0.5, h.w, Math.abs(u - h.x))
        const along = 1 - smooth(h.l, h.l + 0.1, Math.abs(v - 0.5))
        m = Math.max(m, across * along * h.s)
      }
      out[y * n + x] = m
    }
  }
  return out
}

/** Each next level of a mip chain: the mean of the 2 × 2 (or fewer, at an odd edge) texels under each. */
export function mipChain(width: number, height: number, base: Float32Array): Float32Array[] {
  const levels = [base]
  let w = width
  let h = height
  let src = base
  while (w > 1 || h > 1) {
    const nw = Math.max(1, Math.ceil(w / 2))
    const nh = Math.max(1, Math.ceil(h / 2))
    const out = new Float32Array(nw * nh)
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++) {
        let s = 0
        let n = 0
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const sx = x * 2 + dx
            const sy = y * 2 + dy
            // Past the edge of an odd-sized level: nothing there, which counts as empty.
            if (sx < w && sy < h) s += src[sy * w + sx]
            n++
          }
        out[y * nw + x] = s / n
      }
    levels.push(out)
    src = out
    w = nw
    h = nh
  }
  return levels
}

/** Level `l`'s size: the image's halved `l` times, rounding up. */
export const levelSize = (t: { width: number; height: number }, l: number): [number, number] => {
  let w = t.width
  let h = t.height
  for (let i = 0; i < l; i++) {
    w = Math.max(1, Math.ceil(w / 2))
    h = Math.max(1, Math.ceil(h / 2))
  }
  return [w, h]
}

/** An image as a tip: scaled down to MAX_TIP_SIZE if bigger, with its mip chain. `data` is coverage 0..1. */
export function makeTip(width: number, height: number, data: Float32Array): TipImage {
  let w = width
  let h = height
  let d = data
  const big = Math.max(w, h)
  if (big > MAX_TIP_SIZE) {
    // Box-filtered down: each new texel the mean of the old ones it covers.
    const k = big / MAX_TIP_SIZE
    const nw = Math.max(1, Math.round(w / k))
    const nh = Math.max(1, Math.round(h / k))
    const out = new Float32Array(nw * nh)
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++) {
        const x0 = Math.floor((x * w) / nw)
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / nw))
        const y0 = Math.floor((y * h) / nh)
        const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / nh))
        let s = 0
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += d[yy * w + xx]
        out[y * nw + x] = s / ((x1 - x0) * (y1 - y0))
      }
    w = nw
    h = nh
    d = out
  }
  return { width: w, height: h, levels: mipChain(w, h, d) }
}

const registry = new Map<TipId, TipImage>()

/** A sampled tip's image; null for the computed round tip, or one that isn't registered here. */
export function tipImage(tip: TipId): TipImage | null {
  if (tip === 'round') return null
  let t = registry.get(tip)
  if (!t && (BUILTIN_TIPS as string[]).includes(tip)) {
    const n = BUILTIN_TIP_SIZE
    t = makeTip(n, n, tip === 'chalk' ? chalk(n) : tip === 'spatter' ? spatter(n) : bristle(n))
    registry.set(tip, t)
  }
  return t ?? null
}

/** Makes an image tip known here, by its id. */
export function registerTip(id: TipId, t: TipImage) {
  registry.set(id, t)
}

export const hasTip = (id: TipId) => id === 'round' || (BUILTIN_TIPS as string[]).includes(id) || registry.has(id)

/** A tip's id from its pixels: the same image is the same tip wherever it came from. */
export function tipId(width: number, height: number, data: Uint8Array): TipId {
  // FNV-1a over the size and the bytes, twice with different offsets, as 16 hex digits.
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  const mix = (v: number) => {
    a = Math.imul(a ^ v, 0x01000193) >>> 0
    b = Math.imul(b ^ v, 0x5bd1e995) >>> 0
  }
  mix(width & 0xff)
  mix(width >> 8)
  mix(height & 0xff)
  mix(height >> 8)
  for (let i = 0; i < data.length; i++) mix(data[i])
  return `tip:${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

/** 8-bit coverage to a tip image. */
export const tipFromBytes = (width: number, height: number, data: Uint8Array): TipImage => makeTip(width, height, Float32Array.from(data, (v) => v / 255))

/**
 * A tip's coverage at a point in tip space (the tip fills −1..1 across its
 * longer side), read trilinearly for a dab where one layer pixel is `aa`
 * wide in tip space.
 */
export function sampleTip(t: TipImage, ux: number, uy: number, aa: number): number {
  const m = Math.max(t.width, t.height)
  // Level-0 texels per layer pixel decide the level.
  const lod = Math.min(t.levels.length - 1, Math.max(0, Math.log2(Math.max(1, (aa * m) / 2))))
  const l0 = Math.floor(lod)
  const l1 = Math.min(t.levels.length - 1, l0 + 1)
  const f = lod - l0
  const a = sampleLevel(t, l0, ux, uy)
  return f > 0 && l1 !== l0 ? a + (sampleLevel(t, l1, ux, uy) - a) * f : a
}

/** One level, bilinearly: level-0 position halved per level, texel centres at +0.5. */
function sampleLevel(t: TipImage, l: number, ux: number, uy: number): number {
  const m = Math.max(t.width, t.height)
  const [w, h] = levelSize(t, l)
  const s = 2 ** l
  const fx = (((ux + 1) / 2) * m - (m - t.width) / 2) / s - 0.5
  const fy = (((uy + 1) / 2) * m - (m - t.height) / 2) / s - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const img = t.levels[l]
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x])
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
}

/** u32s per tip in the GPU's table: width, height, levels, longer side, then each level's offset (up to 12). */
export const TIP_TABLE_STRIDE = 16

/** Tips laid out for the GPU: a table of where each one's levels are, and every level end to end. */
export function packTips(tips: TipImage[]): { table: Uint32Array; data: Float32Array } {
  const table = new Uint32Array(Math.max(1, tips.length) * TIP_TABLE_STRIDE)
  let total = 0
  for (const t of tips) for (const l of t.levels.slice(0, 12)) total += l.length
  const data = new Float32Array(Math.max(1, total))
  let at = 0
  tips.forEach((t, i) => {
    const o = i * TIP_TABLE_STRIDE
    const levels = t.levels.slice(0, 12)
    table.set([t.width, t.height, levels.length, Math.max(t.width, t.height)], o)
    levels.forEach((l, k) => {
      table[o + 4 + k] = at
      data.set(l, at)
      at += l.length
    })
  })
  return { table, data }
}
