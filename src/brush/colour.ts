/**
 * A dab's colour, from Colour Dynamics: the foreground mixed towards the
 * background, then its hue turned and its saturation and brightness moved.
 * Colours are working-space straight values (CMYK as light, 1 − ink), as
 * strokes keep them. In RGB that's HSB on the document's own values; in
 * Gray only brightness means anything; in CMYK the colour goes to RGB
 * through the document's profile and back with its black kept, as the
 * colour adjustments do (color/cmykAdjust.ts), or through a plain RGB view
 * of the inks when the profile's tables aren't ready.
 */
import type { ColourMode } from '../doc/types'
import { adjustedCmyk, cmykToRgbT, type CmykTables } from '../color/cmykAdjust'
import { clamp01 as clamp } from '../lib/num'


export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6
  return [h, max > 0 ? d / max : 0, max]
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const hh = ((h % 1) + 1) % 1
  const i = Math.floor(hh * 6)
  const f = hh * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  switch (i % 6) {
    case 0:
      return [v, t, p]
    case 1:
      return [q, v, p]
    case 2:
      return [p, v, t]
    case 3:
      return [p, q, v]
    case 4:
      return [t, p, v]
    default:
      return [v, p, q]
  }
}

/** An RGB colour with hue turned by `dh` (turns), saturation and brightness moved by `ds` and `db`. */
function jitterRgb(rgb: number[], dh: number, ds: number, db: number): number[] {
  const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2])
  return hsvToRgb(h + dh, clamp(s + ds), clamp(v + db))
}

/** A dab's straight working-space colour: `mix` of the way from fg to bg, then `hsb` applied. */
export function dabColour(fg: number[], bg: number[], mix: number, hsb: [number, number, number], mode: ColourMode, tables: CmykTables | null = null): number[] {
  const base = fg.map((v, i) => v + (bg[i] - v) * mix)
  const [dh, ds, db] = hsb
  if (!dh && !ds && !db) return base
  if (mode === 'gray') return [clamp(base[0] + db)]
  if (mode === 'rgb') return jitterRgb(base, dh, ds, db)
  // CMYK, as light: to RGB and back, black kept.
  const before = tables ? [...cmykToRgbT(tables, base)] : [base[0] * base[3], base[1] * base[3], base[2] * base[3]]
  const after = jitterRgb(before, dh, ds, db)
  if (tables) return adjustedCmyk(tables, base, before, after)
  const k = base[3]
  return k <= 1e-6 ? [1, 1, 1, k] : [clamp(after[0] / k), clamp(after[1] / k), clamp(after[2] / k), k]
}
