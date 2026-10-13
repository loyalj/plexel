/**
 * Between a tile's samples and the compositing working space, and the mip
 * pyramid's reduction, as plain TypeScript for the checks.
 *
 * A tile holds straight samples in the document's own terms (tiles/
 * format.ts): RGB light, Gray light, CMYK ink, alpha last. The working
 * space is premultiplied floats with CMYK turned into light (1 − ink), so
 * every blend mode means the same in every mode (ref/blend.ts).
 */
import type { ColourMode } from '../../doc/types'
import type { Px } from './composite'

/** Straight 0..1 values, colour channels then alpha, into a working pixel. */
export function toWorking(mode: ColourMode, v: number[]): Px {
  const a = v[v.length - 1]
  const colour = v.slice(0, -1)
  const light = mode === 'cmyk' ? colour.map((x) => 1 - x) : colour
  return { c: light.map((x) => x * a), a }
}

/** A working pixel back to straight 0..1 values in the document's terms, alpha last. */
export function fromWorking(mode: ColourMode, p: Px): number[] {
  const straight = p.a > 0 ? p.c.map((x) => Math.min(1, Math.max(0, x / p.a))) : p.c.map(() => 0)
  const colour = mode === 'cmyk' ? straight.map((x) => 1 - x) : straight
  return [...colour, Math.min(1, Math.max(0, p.a))]
}

/**
 * One pixel of a mip level from the four below it: their premultiplied
 * average, stored straight again. A transparent neighbour lowers the alpha
 * without darkening the colour, which a straight average would do.
 */
export function reduce(four: number[][]): number[] {
  const n = four[0].length - 1
  let a = 0
  const c = new Array(n).fill(0)
  for (const v of four) {
    const va = v[n]
    a += va
    for (let i = 0; i < n; i++) c[i] += v[i] * va
  }
  return a > 0 ? [...c.map((x) => x / a), a / 4] : [...c.map(() => 0), 0]
}
