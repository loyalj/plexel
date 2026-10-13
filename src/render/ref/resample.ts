/**
 * Resampling a pixel layer through its live transform: the four filters a
 * node can choose (`props.resample`), as plain TypeScript, for check-gpu to
 * hold the kernel to.
 *
 * Positions are in source pixels, with pixel centres at i + 0.5. Filtering
 * is done on premultiplied values, so a transparent pixel's colour never
 * bleeds into its neighbours. Bicubic and Lanczos overshoot at hard edges;
 * the result is clamped back to a valid premultiplied pixel.
 *
 * All four reproduce the source exactly when every output pixel lands on a
 * source pixel centre: each kernel is 1 at 0 and 0 at every other whole
 * number. The render graph still uses nearest for that case, which is
 * cheaper and exact in float32 too.
 */
import type { Px } from './composite'

export type Filter = 'nearest' | 'bilinear' | 'bicubic' | 'lanczos'
export const FILTERS: Filter[] = ['nearest', 'bilinear', 'bicubic', 'lanczos']

/** Keys' cubic with a = −0.5 (Catmull-Rom), what Photoshop's Bicubic is close to. */
export function cubic(x: number): number {
  const a = -0.5
  const t = Math.abs(x)
  if (t <= 1) return (a + 2) * t * t * t - (a + 3) * t * t + 1
  if (t < 2) return a * t * t * t - 5 * a * t * t + 8 * a * t - 4 * a
  return 0
}

const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x))
/** Three-lobed Lanczos. */
export const lanczos3 = (x: number) => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0)

/** How many taps each side of the sample each filter reaches, and its kernel. */
const KERNELS = {
  bilinear: { lo: 0, hi: 1, w: (x: number) => Math.max(0, 1 - Math.abs(x)) },
  bicubic: { lo: 1, hi: 2, w: cubic },
  lanczos: { lo: 2, hi: 3, w: lanczos3 },
} as const

/** The weights along one axis for a sample at `p` (source pixels): the first tap's index, and one weight per tap, summing to 1. */
export function weights(filter: Exclude<Filter, 'nearest'>, p: number): { first: number; w: number[] } {
  const k = KERNELS[filter]
  const t = p - 0.5
  const i = Math.floor(t)
  const f = t - i
  const w: number[] = []
  for (let j = -k.lo; j <= k.hi; j++) w.push(k.w(f - j))
  const sum = w.reduce((a, v) => a + v, 0)
  return { first: i - k.lo, w: w.map((v) => v / sum) }
}

/**
 * The filtered pixel at (x, y), in source pixels, reading the source
 * through `texel`, which returns premultiplied pixels and transparent
 * outside the layer.
 */
export function sample(texel: (ix: number, iy: number) => Px, x: number, y: number, filter: Filter, channels: number): Px {
  if (filter === 'nearest') return texel(Math.floor(x), Math.floor(y))
  const wx = weights(filter, x)
  const wy = weights(filter, y)
  const c = new Array(channels).fill(0)
  let a = 0
  for (let j = 0; j < wy.w.length; j++) {
    for (let i = 0; i < wx.w.length; i++) {
      const w = wx.w[i] * wy.w[j]
      const p = texel(wx.first + i, wy.first + j)
      for (let k = 0; k < channels; k++) c[k] += p.c[k] * w
      a += p.a * w
    }
  }
  a = Math.min(1, Math.max(0, a))
  return { c: c.map((v) => Math.min(a, Math.max(0, v))), a }
}
