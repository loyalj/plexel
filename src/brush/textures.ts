/**
 * Brush textures: the paper a stroke's paint sits in (Photoshop's Texture
 * section). Grey images 0..1 that tile, read in document pixels at the
 * texture's scale, so the grain stays put on the canvas as the brush moves
 * over it. The built-in papers are made here from fixed seeds and tile
 * seamlessly; patterns from ABR files are registered by their content hash
 * ('pat:…'), like image tips.
 *
 * How a texture changes a dab's coverage, by mode, is `textured` (the GPU
 * has the same in shaders/paint.ts).
 */
import type { BrushTexture, TextureMode } from './defs'
import { rng } from './rng'

export interface TextureImage {
  width: number
  height: number
  /** 0..1, row by row. */
  data: Float32Array
}

export const BUILTIN_TEXTURES = ['paper', 'canvas', 'rough', 'burlap'] as const
export type BuiltinTexture = (typeof BUILTIN_TEXTURES)[number]
export const TEXTURE_LABELS: Record<BuiltinTexture, string> = { paper: 'Fine Paper', canvas: 'Canvas', rough: 'Rough Paper', burlap: 'Burlap' }

/** Built-in textures' size, a side. */
const N = 256

/** Value noise that tiles every `period` cells, smoothly interpolated. */
function tilingNoise(seed: number, period: number): (x: number, y: number) => number {
  const r = rng(seed)
  const grid = Array.from({ length: period * period }, r)
  const at = (x: number, y: number) => grid[(((y % period) + period) % period) * period + (((x % period) + period) % period)]
  const s = (t: number) => t * t * (3 - 2 * t)
  return (x, y) => {
    const fx = (x / N) * period
    const fy = (y / N) * period
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = s(fx - x0)
    const ty = s(fy - y0)
    return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
  }
}

/** Octaves of tiling noise, normalised to 0..1. */
function fbm(seed: number, periods: number[], weights: number[]): Float32Array {
  const layers = periods.map((p, i) => tilingNoise(seed + i * 17, p))
  const out = new Float32Array(N * N)
  let lo = Infinity
  let hi = -Infinity
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let v = 0
      layers.forEach((f, i) => (v += f(x, y) * weights[i]))
      out[y * N + x] = v
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
  // Clamped: float rounding can land a hair past either end.
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, Math.max(0, (out[i] - lo) / (hi - lo || 1)))
  return out
}

function make(id: BuiltinTexture): Float32Array {
  switch (id) {
    case 'paper':
      return fbm(11, [64, 128, 256], [0.45, 0.35, 0.2])
    case 'rough':
      return fbm(23, [16, 32, 64, 128], [0.4, 0.3, 0.2, 0.1])
    case 'canvas': {
      // A plain weave: threads over and under, with a little unevenness.
      const n = fbm(37, [32, 128], [0.6, 0.4])
      const out = new Float32Array(N * N)
      const threads = 32
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const u = ((x + 0.5) / N) * threads
          const v = ((y + 0.5) / N) * threads
          const over = (Math.floor(u) + Math.floor(v)) % 2 === 0
          const across = Math.sin((over ? u : v) * Math.PI * 2) * 0.5 + 0.5
          const along = Math.sin((over ? v : u) * Math.PI) ** 2
          out[y * N + x] = Math.min(1, Math.max(0, 0.25 + 0.55 * across * (0.6 + 0.4 * along) + 0.2 * n[y * N + x]))
        }
      return out
    }
    case 'burlap': {
      const n = fbm(41, [64, 256], [0.7, 0.3])
      const out = new Float32Array(N * N)
      const threads = 16
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const u = ((x + 0.5) / N) * threads
          const v = ((y + 0.5) / N) * threads
          const warp = Math.abs(Math.sin(u * Math.PI))
          const weft = Math.abs(Math.sin(v * Math.PI))
          out[y * N + x] = Math.min(1, Math.max(0, Math.max(warp, weft) ** 3 * 0.8 + 0.2 * n[y * N + x]))
        }
      return out
    }
  }
}

const registry = new Map<string, TextureImage>()

/** A texture's image, built-in or registered; null when it isn't known here. */
export function textureImage(id: string): TextureImage | null {
  let t = registry.get(id)
  if (!t && (BUILTIN_TEXTURES as readonly string[]).includes(id)) {
    t = { width: N, height: N, data: make(id as BuiltinTexture) }
    registry.set(id, t)
  }
  return t ?? null
}

export function registerTexture(id: string, t: TextureImage) {
  registry.set(id, t)
}

export const hasTexture = (id: string) => (BUILTIN_TEXTURES as readonly string[]).includes(id) || registry.has(id)

/** The texture under document point (x, y), tiled, at `scale`, bilinearly. */
export function sampleTexture(t: TextureImage, x: number, y: number, scale: number): number {
  const fx = x / scale - 0.5
  const fy = y / scale - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const at = (px: number, py: number) => t.data[(((py % t.height) + t.height) % t.height) * t.width + (((px % t.width) + t.width) % t.width)]
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
}

/** The texture value after Brightness, Contrast and Invert: Photoshop's sliders, on 0..1. */
export function adjustTexture(v: number, tex: Pick<BrushTexture, 'brightness' | 'contrast' | 'invert'>): number {
  let t = tex.invert ? 1 - v : v
  t += tex.brightness / 150 / 2
  const k = tex.contrast >= 0 ? 1 + (tex.contrast / 100) * 3 : 1 + tex.contrast / 50
  t = (t - 0.5) * k + 0.5
  return Math.min(1, Math.max(0, t))
}

export const TEXTURE_MODE_INDEX: Record<TextureMode, number> = { multiply: 0, subtract: 1, darken: 2, overlay: 3, 'color-dodge': 4, 'color-burn': 5, 'linear-burn': 6, 'hard-mix': 7, 'linear-height': 8, height: 9 }

/**
 * A dab's coverage `m` (0..1) in a texture whose value here is `t` (after
 * its adjustments), at `depth`: the paper's grain taking paint away where
 * it's low. Depth 0 leaves `m` as it is.
 */
export function textured(m: number, t: number, depth: number, mode: number): number {
  if (m <= 0 || depth <= 0) return m
  let v: number
  switch (mode) {
    case 0: // Multiply: the grain darkens the paint's coverage.
      v = m * t
      break
    case 1: // Subtract: the grain's shadows taken off.
      v = m - (1 - t)
      break
    case 2: // Darken: the lower of the two.
      v = Math.min(m, t)
      break
    case 3: // Overlay.
      v = m < 0.5 ? 2 * m * t : 1 - 2 * (1 - m) * (1 - t)
      break
    case 4: // Colour Dodge (the divisor kept off zero, where the answer is 1 anyway and floats disagree).
      v = Math.min(1, m / Math.max(0.02, 1 - t))
      break
    case 5: // Colour Burn, likewise.
      v = 1 - Math.min(1, (1 - m) / Math.max(0.02, t))
      break
    case 6: // Linear Burn.
      v = m + t - 1
      break
    case 7: // Hard Mix: paint only where the paper is high enough for it.
      v = m + t >= 1 ? 1 : 0
      break
    case 8: // Linear Height: coverage as the paper's height, scaled by the paint.
      v = m * (0.5 + t) - 0.5 * (1 - m)
      break
    default: // Height: the paint fills the paper up to its coverage.
      v = t >= 1 - m ? 1 : 0
      v = v * m
  }
  v = Math.min(1, Math.max(0, v))
  return m + (v - m) * depth
}
