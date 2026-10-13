/**
 * How one pixel is laid onto another: the compositing operations the render
 * graph is built from, as plain TypeScript. The GPU kernel
 * (shaders/composite.wgsl.ts) does the same sums in the same order, and
 * check-gpu holds it to these.
 *
 * Pixels here are premultiplied: `c` is each colour channel times alpha, in
 * the working space blend.ts describes.
 *
 *   over    a layer onto what's below it, with its blend mode: the W3C
 *           compositing formula, which is Photoshop's.
 *   atop    a layer clipped to what's below it (a child of a non-group
 *           node): the backdrop keeps its alpha, and the source changes its
 *           colour only where the backdrop is.
 *   lerp    a pass-through group with an opacity below 100%: the group's
 *           result over the backdrop, faded back towards the backdrop.
 *   knock   a layer in a knockout group: it's laid over the knockout
 *           backdrop instead of over the layers before it, and replaces them
 *           in proportion to its shape (its own alpha, before opacity).
 */
import type { BlendModeId } from '../../doc/types'
import { blendColour } from './blend'

export interface Px {
  c: number[]
  a: number
}

export type Op = 'over' | 'atop' | 'lerp' | 'knock' | 'tint'
export const OPS: Op[] = ['over', 'atop', 'lerp', 'knock', 'tint']

export const clear = (n: number): Px => ({ c: new Array(n).fill(0), a: 0 })

/** Straight colour from premultiplied, clamped: a stored pixel can be a hair over its alpha after rounding. */
const unpremult = (p: Px) => (p.a > 0 ? p.c.map((v) => Math.min(1, Math.max(0, v / p.a))) : p.c.map(() => 0))

/**
 * `src` over `dst` with blend mode `mode`, its alpha scaled by `k` (opacity
 * times fill times mask).
 *
 *   co = αs·(1 − αb)·Cs + αs·αb·B(Cb, Cs) + (1 − αs)·cb
 *   αo = αs + αb·(1 − αs)
 */
export function over(dst: Px, src: Px, mode: BlendModeId, k: number): Px {
  const as = src.a * k
  if (as <= 0) return { c: [...dst.c], a: dst.a }
  const cs = unpremult(src)
  const cb = unpremult(dst)
  const B = blendColour(mode, cb, cs)
  const ab = dst.a
  return {
    c: dst.c.map((d, i) => as * (1 - ab) * cs[i] + as * ab * B[i] + (1 - as) * d),
    a: as + ab * (1 - as),
  }
}

/**
 * `src` clipped to `dst`: where the backdrop is, its colour moves towards
 * the blended colour by the source's alpha; where it isn't, nothing.
 *
 *   co = αs·αb·B(Cb, Cs) + (1 − αs)·cb
 *   αo = αb
 */
export function atop(dst: Px, src: Px, mode: BlendModeId, k: number): Px {
  const as = src.a * k
  if (as <= 0 || dst.a <= 0) return { c: [...dst.c], a: dst.a }
  const B = blendColour(mode, unpremult(dst), unpremult(src))
  return { c: dst.c.map((d, i) => as * dst.a * B[i] + (1 - as) * d), a: dst.a }
}

/** `dst` moved towards `src` by `k`. Both premultiplied, so this is a plain mix. */
export function lerp(dst: Px, src: Px, k: number): Px {
  return { c: dst.c.map((d, i) => d + (src.c[i] - d) * k), a: dst.a + (src.a - dst.a) * k }
}

/**
 * A layer in a knockout group: laid over `kb`, the knockout backdrop, at its
 * opacity `k` but with its shape taken out (it's applied as the mix
 * weight instead), so a layer at 0% fill punches a clean hole down to the
 * backdrop, and one at 100% looks as if it had been laid over it.
 */
export function knock(dst: Px, src: Px, kb: Px, mode: BlendModeId, k: number): Px {
  const shape = src.a
  if (shape <= 0) return { c: [...dst.c], a: dst.a }
  const solid: Px = { c: src.c.map((v) => Math.min(1, Math.max(0, v / shape))), a: 1 }
  return lerp(dst, over(kb, solid, mode, k), shape)
}

/**
 * Dissolve's random threshold for one pixel: the same number for the same
 * document pixel and seed, every time, on the CPU and the GPU alike. A hash
 * (PCG's output function), not a generator, so pixels needn't be visited
 * in order. 0 ≤ result < 1, in steps of 2⁻²⁴, which float32 holds exactly.
 */
export function dissolveThreshold(x: number, y: number, seed: number): number {
  let v = (Math.imul(x >>> 0, 0x9e3779b1) ^ Math.imul(y >>> 0, 0x85ebca77) ^ Math.imul(seed >>> 0, 0xc2b2ae3d)) >>> 0
  v = (Math.imul(v, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((v >>> ((v >>> 28) + 4)) ^ v) >>> 0, 277803737) >>> 0
  return (((w >>> 22) ^ w) >>> 8) / 16777216
}

/**
 * Dissolve: each pixel is either fully there or not at all, with the odds
 * set by its alpha. The surviving pixels are then laid on as Normal.
 */
export function dissolve(src: Px, k: number, x: number, y: number, seed: number): { px: Px; k: number } {
  const as = src.a * k
  const keep = dissolveThreshold(x, y, seed) < as
  if (!keep || src.a <= 0) return { px: { c: src.c.map(() => 0), a: 0 }, k: 0 }
  return { px: { c: src.c.map((v) => v / src.a), a: 1 }, k: 1 }
}

/**
 * An adjustment laid on: the backdrop's colour moves towards the blend of
 * itself with its adjusted copy `src` (which has the same alpha) by `k`
 * (opacity times mask), and its alpha stays as it is. In Normal mode this
 * is a plain mix; in Luminosity, say, only the adjustment's lightness lands.
 *
 *   co = cb + (αb·B(Cb, Cs) − cb)·k
 *   αo = αb
 */
export function tint(dst: Px, src: Px, mode: BlendModeId, k: number): Px {
  if (dst.a <= 0 || k <= 0) return { c: [...dst.c], a: dst.a }
  const B = blendColour(mode, unpremult(dst), unpremult(src))
  return { c: dst.c.map((d, i) => d + (dst.a * B[i] - d) * k), a: dst.a }
}

/** One operation, by name, as the kernel dispatches it. */
export function apply(op: Op, dst: Px, src: Px, mode: BlendModeId, k: number, kb?: Px): Px {
  switch (op) {
    case 'over':
      return over(dst, src, mode, k)
    case 'atop':
      return atop(dst, src, mode, k)
    case 'lerp':
      return lerp(dst, src, k)
    case 'knock':
      return knock(dst, src, kb ?? clear(dst.c.length), mode, k)
    case 'tint':
      return tint(dst, src, mode, k)
  }
}
