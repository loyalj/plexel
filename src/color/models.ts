/**
 * Colour models for the pickers: HSB (also called HSV), HSL, hex, and LCh,
 * the polar form of Lab. Pure arithmetic on numbers already in one colour
 * space. Moving between spaces (RGB to CMYK, anything to Lab) is the colour
 * engine's job, through profiles.
 *
 * Ranges: RGB, S, B and L are 0..1; hue is degrees 0..360; Lab L is
 * 0..100 and a, b about -128..127; LCh C is Lab's chroma.
 */
import { clamp01 } from '../lib/num'

const wrapHue = (h: number) => ((h % 360) + 360) % 360

export function rgbToHsb([r, g, b]: number[]): number[] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
  }
  return [wrapHue(h * 60), max === 0 ? 0 : d / max, max]
}

export function hsbToRgb([h, s, v]: number[]): number[] {
  const f = (n: number) => {
    const k = (n + wrapHue(h) / 60) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return [f(5), f(3), f(1)]
}

export function rgbToHsl([r, g, b]: number[]): number[] {
  const [h] = rgbToHsb([r, g, b])
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  return [h, s, l]
}

export function hslToRgb([h, s, l]: number[]): number[] {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + wrapHue(h) / 30) % 12
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}

export function labToLch([L, a, b]: number[]): number[] {
  return [L, Math.hypot(a, b), wrapHue((Math.atan2(b, a) * 180) / Math.PI)]
}

export function lchToLab([L, C, h]: number[]): number[] {
  const r = (h * Math.PI) / 180
  return [L, C * Math.cos(r), C * Math.sin(r)]
}

/** `#rrggbb` (or `#rgb`, or without the #) to RGB 0..1; null if it isn't one. */
export function parseHex(text: string): number[] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim())
  if (!m) return null
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
}

export function formatHex(rgb: number[]): string {
  return '#' + rgb.map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('')
}

/** CIE76 colour difference. A difference under 1 is not visible; under 2.3 is a "just noticeable" one. */
export const deltaE = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/**
 * CIEDE2000, the difference that matches what people see, for the checks
 * that hold conversions to "no visible difference".
 */
export function deltaE2000([L1, a1, b1]: number[], [L2, a2, b2]: number[]): number {
  const rad = Math.PI / 180
  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cb = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)
  const h1p = C1p === 0 ? 0 : wrapHue(Math.atan2(b1, a1p) / rad)
  const h2p = C2p === 0 ? 0 : wrapHue(Math.atan2(b2, a2p) / rad)
  const dL = L2 - L1
  const dC = C2p - C1p
  let dh = 0
  if (C1p * C2p !== 0) {
    dh = h2p - h1p
    if (dh > 180) dh -= 360
    else if (dh < -180) dh += 360
  }
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad)
  const Lb = (L1 + L2) / 2
  const Cbp = (C1p + C2p) / 2
  let hb = h1p + h2p
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hb += h1p + h2p < 360 ? 360 : -360
    hb /= 2
  }
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad)
  const dTheta = 30 * Math.exp(-(((hb - 275) / 25) ** 2))
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2)
  const Sc = 1 + 0.045 * Cbp
  const Sh = 1 + 0.015 * Cbp * T
  const Rt = -Math.sin(2 * dTheta * rad) * Rc
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh))
}
