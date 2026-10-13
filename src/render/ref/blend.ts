/**
 * Every blend mode, as plain TypeScript: the reference the GPU's WGSL is
 * held to (check-gpu), and the definition check-render-ref holds to
 * Photoshop's formulas and to known values.
 *
 * Values are 0..1 and straight (not premultiplied). `b` is the backdrop,
 * what's already there, and `s` is the source, the layer being drawn.
 *
 * Working space. Colours are blended in the document's encoded values, as
 * Photoshop does, with one turn: CMYK is blended as light, each ink
 * inverted (1 − ink), so that Multiply darkens and Screen lightens in CMYK
 * as they do in RGB. That is how Photoshop composites CMYK. A colour here
 * is 1 (Gray), 3 (RGB) or 4 (CMYK as light) channels.
 *
 * The non-separable modes (Hue, Saturation, Color, Luminosity) work on
 * three channels. Gray has no hue or saturation, so Luminosity takes the
 * source and the other three keep the backdrop. CMYK uses its first three
 * light channels as RGB and treats black on its own: Luminosity takes the
 * source's, the other three keep the backdrop's.
 */
import type { BlendModeId } from '../../doc/types'

export type Separable = (b: number, s: number) => number
export type Colour = number[]

const clamp = (v: number) => Math.min(1, Math.max(0, v))

export const multiply: Separable = (b, s) => b * s
export const screen: Separable = (b, s) => b + s - b * s
export const hardLight: Separable = (b, s) => (s <= 0.5 ? multiply(b, 2 * s) : screen(b, 2 * s - 1))
export const overlay: Separable = (b, s) => hardLight(s, b)
export const colorDodge: Separable = (b, s) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)))
export const colorBurn: Separable = (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s))
/** Photoshop's Soft Light: the square-root form, without the W3C's extra piece below a quarter. */
export const softLight: Separable = (b, s) => (s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (Math.sqrt(b) - b))
export const vividLight: Separable = (b, s) => (s <= 0.5 ? colorBurn(b, 2 * s) : colorDodge(b, 2 * s - 1))
export const linearLight: Separable = (b, s) => clamp(b + 2 * s - 1)
export const pinLight: Separable = (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1))
export const hardMix: Separable = (b, s) => (b + s >= 1 ? 1 : 0)
export const divide: Separable = (b, s) => (s <= 0 ? (b > 0 ? 1 : 0) : Math.min(1, b / s))

/** The separable modes, by id. `normal` and `dissolve` are here as "take the source". */
export const SEPARABLE: Partial<Record<BlendModeId, Separable>> = {
  normal: (_b, s) => s,
  dissolve: (_b, s) => s,
  darken: Math.min,
  multiply,
  'color-burn': colorBurn,
  'linear-burn': (b, s) => Math.max(0, b + s - 1),
  lighten: Math.max,
  screen,
  'color-dodge': colorDodge,
  'linear-dodge': (b, s) => Math.min(1, b + s),
  overlay,
  'soft-light': softLight,
  'hard-light': hardLight,
  'vivid-light': vividLight,
  'linear-light': linearLight,
  'pin-light': pinLight,
  'hard-mix': hardMix,
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
  subtract: (b, s) => Math.max(0, b - s),
  divide,
}

// --- the non-separable modes, as the W3C compositing spec defines them ----------

const lum = (c: Colour) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]

function clipColour(c: Colour): Colour {
  const l = lum(c)
  const n = Math.min(c[0], c[1], c[2])
  const x = Math.max(c[0], c[1], c[2])
  let out = c
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n))
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l))
  return out
}

const setLum = (c: Colour, l: number) => {
  const d = l - lum(c)
  return clipColour([c[0] + d, c[1] + d, c[2] + d])
}

const sat = (c: Colour) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])

function setSat(c: Colour, s: number): Colour {
  // The largest channel goes to s, the smallest to 0, the middle scales between.
  const idx = [0, 1, 2].sort((i, j) => c[i] - c[j])
  const [lo, mid, hi] = idx
  const out = [0, 0, 0]
  if (c[hi] > c[lo]) {
    out[mid] = ((c[mid] - c[lo]) * s) / (c[hi] - c[lo])
    out[hi] = s
  }
  out[lo] = 0
  return out
}

type NonSeparable = (b: Colour, s: Colour) => Colour
const NON_SEPARABLE: Partial<Record<BlendModeId, NonSeparable>> = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
}

/**
 * The blended colour B(b, s), before any alpha: what the source turns the
 * backdrop into where both are fully there. `b` and `s` have the same
 * number of channels: 1, 3 or 4.
 */
export function blendColour(mode: BlendModeId, b: Colour, s: Colour): Colour {
  const n = b.length
  const sep = SEPARABLE[mode]
  if (sep) return b.map((v, i) => sep(v, s[i]))
  if (mode === 'darker-color' || mode === 'lighter-color') {
    // The whole colour of whichever is darker (or lighter), by the total of its channels.
    const sb = b.reduce((a, v) => a + v, 0)
    const ss = s.reduce((a, v) => a + v, 0)
    return (mode === 'darker-color' ? ss < sb : ss > sb) ? [...s] : [...b]
  }
  const ns = NON_SEPARABLE[mode]
  if (!ns) return [...s] // pass-through: never blended as a layer; treated as Normal
  if (n === 1) return mode === 'luminosity' ? [...s] : [...b]
  const rgb = ns(b.slice(0, 3), s.slice(0, 3))
  if (n === 3) return rgb
  return [...rgb, mode === 'luminosity' ? s[3] : b[3]]
}
