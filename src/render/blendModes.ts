/**
 * Every blend mode, declared once: its name, where it sits in the menu, and
 * its WGSL. The Properties panel's menu, the compositing kernel and the
 * checks all read this, so a mode added here is in all of them at once.
 *
 * The CPU reference for each is in ref/blend.ts, under the same id, and
 * check-gpu holds the WGSL to it in every colour mode and depth.
 *
 * A separable mode's WGSL is an expression in `b` (backdrop) and `s`
 * (source), both f32 in 0..1, and is applied to each channel. The rest
 * (Darker and Lighter Color, and the four that work on hue, saturation and
 * luminosity) are written out in the kernel, since they read the whole
 * colour.
 */
import { BLEND_MODES, type BlendModeId } from '../doc/types'

export interface BlendDef {
  id: BlendModeId
  label: string
  /** The menu's sections, as Photoshop draws separators between them. */
  group: 'normal' | 'darken' | 'lighten' | 'contrast' | 'inversion' | 'component' | 'group'
  /** For a separable mode: the result as a WGSL expression in `b` and `s`. */
  wgsl?: string
}

const SEPARABLE_WGSL: Partial<Record<BlendModeId, string>> = {
  normal: 's',
  dissolve: 's',
  darken: 'min(b, s)',
  multiply: 'b * s',
  'color-burn': 'select(select(1.0 - min(1.0, (1.0 - b) / s), 0.0, s <= 0.0), 1.0, b >= 1.0)',
  'linear-burn': 'max(0.0, b + s - 1.0)',
  lighten: 'max(b, s)',
  screen: 'b + s - b * s',
  'color-dodge': 'select(select(min(1.0, b / (1.0 - s)), 1.0, s >= 1.0), 0.0, b <= 0.0)',
  'linear-dodge': 'min(1.0, b + s)',
  overlay: 'hard_light(s, b)',
  'soft-light': 'select(b + (2.0 * s - 1.0) * (sqrt(b) - b), b - (1.0 - 2.0 * s) * b * (1.0 - b), s <= 0.5)',
  'hard-light': 'hard_light(b, s)',
  'vivid-light': 'select(color_dodge(b, 2.0 * s - 1.0), color_burn(b, 2.0 * s), s <= 0.5)',
  'linear-light': 'clamp(b + 2.0 * s - 1.0, 0.0, 1.0)',
  'pin-light': 'select(max(b, 2.0 * s - 1.0), min(b, 2.0 * s), s <= 0.5)',
  'hard-mix': 'select(0.0, 1.0, b + s >= 1.0)',
  difference: 'abs(b - s)',
  exclusion: 'b + s - 2.0 * b * s',
  subtract: 'max(0.0, b - s)',
  divide: 'select(min(1.0, b / s), select(0.0, 1.0, b > 0.0), s <= 0.0)',
}

const GROUP: Record<BlendModeId, BlendDef['group']> = {
  'pass-through': 'group',
  normal: 'normal',
  dissolve: 'normal',
  darken: 'darken',
  multiply: 'darken',
  'color-burn': 'darken',
  'linear-burn': 'darken',
  'darker-color': 'darken',
  lighten: 'lighten',
  screen: 'lighten',
  'color-dodge': 'lighten',
  'linear-dodge': 'lighten',
  'lighter-color': 'lighten',
  overlay: 'contrast',
  'soft-light': 'contrast',
  'hard-light': 'contrast',
  'vivid-light': 'contrast',
  'linear-light': 'contrast',
  'pin-light': 'contrast',
  'hard-mix': 'contrast',
  difference: 'inversion',
  exclusion: 'inversion',
  subtract: 'inversion',
  divide: 'inversion',
  hue: 'component',
  saturation: 'component',
  color: 'component',
  luminosity: 'component',
}

const LABELS: Partial<Record<BlendModeId, string>> = { 'linear-dodge': 'Linear Dodge (Add)' }
const titleCase = (id: string) => id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')

export const BLEND_DEFS: BlendDef[] = BLEND_MODES.map((id) => ({
  id,
  label: LABELS[id] ?? titleCase(id),
  group: GROUP[id],
  wgsl: SEPARABLE_WGSL[id],
}))

export const BLEND_BY_ID = new Map(BLEND_DEFS.map((d) => [d.id, d]))

/** A mode's index, as the kernel receives it. */
export const blendIndex = (id: BlendModeId) => BLEND_MODES.indexOf(id)

export const blendLabel = (id: BlendModeId) => BLEND_BY_ID.get(id)?.label ?? id
