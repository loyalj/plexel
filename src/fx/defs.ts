/**
 * Layer effects, declared once: Photoshop's layer styles. Each entry lists
 * its parameters (doc/params.ts), which generate its page in the Layer
 * Style dialog, read it back from a file and feed the CPU reference
 * (render/ref/fx.ts) the GPU is held to.
 *
 * Every effect is worked out from the layer's shape (its alpha, after its
 * masks) and drawn in one of two places: below the layer's content (drop
 * shadow, outer glow) or on it (the rest), in the order Photoshop draws
 * them. Distances and sizes are in document pixels.
 */
import { BLEND_DEFS } from '../render/blendModes'
import { readParamValues, type ParamDef } from '../doc/params'
import type { LayerFx } from '../doc/types'
import { PATTERNS } from '../vector/patterns'

export type FxKind = 'drop-shadow' | 'inner-shadow' | 'outer-glow' | 'inner-glow' | 'bevel' | 'satin' | 'colour-overlay' | 'gradient-overlay' | 'pattern-overlay' | 'stroke'

export interface FxDef {
  kind: FxKind
  label: string
  /** Drawn under the content, or on it. */
  place: 'below' | 'on' | 'over'
  params: ParamDef[]
  /** How far past the layer's shape it can reach, or what it reads, in document pixels: the margin it needs. */
  reach(v: Record<string, unknown>): number
}

const BLENDS: [string, string][] = BLEND_DEFS.filter((d) => d.id !== 'pass-through' && d.id !== 'dissolve').map((d) => [d.id, d.label])
const blend = (d: string): ParamDef => ({ key: 'blend', kind: 'choice', label: 'Blend mode', options: BLENDS, default: d })
const n = (key: string, label: string, min: number, max: number, def: number, unit: string, hint?: string): ParamDef => ({ key, kind: 'number', label, min, max, step: 1, unit, default: def, hint })
const opacity = (d: number) => n('opacity', 'Opacity', 0, 100, d, '%')
const angle = (d: number) => n('angle', 'Angle', -180, 180, d, '°', 'The light’s direction: where the light comes from.')
const size = (d: number) => n('size', 'Size', 0, 250, d, 'px', 'How far the effect is blurred.')
const colour = (d: 'black' | 'white' | number[]): ParamDef => ({ key: 'colour', kind: 'colour', label: 'Colour', default: d })

/** In the order Photoshop draws them, bottom first. */
export const FX_DEFS: FxDef[] = [
  {
    kind: 'drop-shadow',
    label: 'Drop Shadow',
    place: 'below',
    params: [blend('multiply'), colour('black'), opacity(75), angle(120), n('distance', 'Distance', 0, 1000, 5, 'px'), n('spread', 'Spread', 0, 100, 0, '%', 'Hardens the shadow’s edge before it’s blurred.'), size(5)],
    reach: (v) => (v.distance as number) + (v.size as number),
  },
  {
    kind: 'outer-glow',
    label: 'Outer Glow',
    place: 'below',
    params: [blend('screen'), colour([1, 1, 0.75]), opacity(75), n('spread', 'Spread', 0, 100, 0, '%'), size(5)],
    reach: (v) => v.size as number,
  },
  {
    kind: 'inner-shadow',
    label: 'Inner Shadow',
    place: 'on',
    params: [blend('multiply'), colour('black'), opacity(75), angle(120), n('distance', 'Distance', 0, 1000, 5, 'px'), n('choke', 'Choke', 0, 100, 0, '%'), size(5)],
    reach: (v) => (v.distance as number) + (v.size as number),
  },
  {
    kind: 'inner-glow',
    label: 'Inner Glow',
    place: 'on',
    params: [
      blend('screen'),
      colour([1, 1, 0.75]),
      opacity(75),
      { key: 'source', kind: 'choice', label: 'Source', options: [['edge', 'Edge'], ['centre', 'Centre']], default: 'edge' },
      n('choke', 'Choke', 0, 100, 0, '%'),
      size(5),
    ],
    reach: (v) => v.size as number,
  },
  {
    kind: 'satin',
    label: 'Satin',
    place: 'on',
    params: [blend('multiply'), colour('black'), opacity(50), n('angle', 'Angle', -180, 180, 19, '°'), n('distance', 'Distance', 0, 250, 11, 'px'), size(14), { key: 'invert', kind: 'bool', label: 'Invert', default: true }],
    reach: (v) => (v.distance as number) + (v.size as number),
  },
  {
    kind: 'colour-overlay',
    label: 'Colour Overlay',
    place: 'on',
    params: [blend('normal'), colour([1, 0, 0]), opacity(100)],
    reach: () => 0,
  },
  {
    kind: 'gradient-overlay',
    label: 'Gradient Overlay',
    place: 'on',
    params: [
      blend('normal'),
      opacity(100),
      { key: 'gradient', kind: 'gradient', label: 'Gradient' },
      n('angle', 'Angle', -180, 180, 90, '°'),
      n('scale', 'Scale', 10, 150, 100, '%'),
      { key: 'reverse', kind: 'bool', label: 'Reverse', default: false },
    ],
    reach: () => 0,
  },
  {
    kind: 'pattern-overlay',
    label: 'Pattern Overlay',
    place: 'on',
    params: [
      blend('normal'),
      opacity(100),
      { key: 'pattern', kind: 'choice', label: 'Pattern', options: PATTERNS.map((p) => [p.id, p.label]), default: 'checker' },
      colour('black'),
      { key: 'background', kind: 'colour', label: 'Background', default: 'white' },
      n('backgroundOpacity', 'Background opacity', 0, 100, 100, '%'),
      n('scale', 'Size', 1, 1000, 16, 'px', 'One cell of the pattern, in document pixels.'),
      n('angle', 'Angle', -180, 180, 0, '°'),
    ],
    reach: () => 0,
  },
  {
    kind: 'bevel',
    label: 'Bevel & Emboss',
    place: 'on',
    params: [
      { key: 'style', kind: 'choice', label: 'Style', options: [['inner', 'Inner Bevel'], ['outer', 'Outer Bevel'], ['emboss', 'Emboss']], default: 'inner' },
      n('depth', 'Depth', 1, 1000, 100, '%'),
      { key: 'direction', kind: 'choice', label: 'Direction', options: [['up', 'Up'], ['down', 'Down']], default: 'up' },
      size(5),
      n('soften', 'Soften', 0, 16, 0, 'px'),
      angle(120),
      n('altitude', 'Altitude', 0, 90, 30, '°'),
      { key: 'highlightBlend', kind: 'choice', label: 'Highlight mode', options: BLENDS, default: 'screen' },
      { key: 'highlightColour', kind: 'colour', label: 'Highlight colour', default: 'white' },
      n('highlightOpacity', 'Highlight opacity', 0, 100, 75, '%'),
      { key: 'shadowBlend', kind: 'choice', label: 'Shadow mode', options: BLENDS, default: 'multiply' },
      { key: 'shadowColour', kind: 'colour', label: 'Shadow colour', default: 'black' },
      n('shadowOpacity', 'Shadow opacity', 0, 100, 75, '%'),
    ],
    reach: (v) => (v.size as number) + (v.soften as number) + 2,
  },
  {
    kind: 'stroke',
    label: 'Stroke',
    place: 'over',
    params: [
      n('size', 'Size', 1, 250, 3, 'px'),
      { key: 'position', kind: 'choice', label: 'Position', options: [['outside', 'Outside'], ['inside', 'Inside'], ['centre', 'Centre']], default: 'outside' },
      blend('normal'),
      opacity(100),
      colour('black'),
    ],
    reach: (v) => v.size as number,
  },
]

export const FX_BY_KIND = new Map(FX_DEFS.map((d) => [d.kind, d]))

/** An effect's parameters, whole and in range for a colour mode. */
export const fxValues = (fx: LayerFx, mode: 'rgb' | 'gray' | 'cmyk') => readParamValues(FX_BY_KIND.get(fx.kind as FxKind)?.params ?? [], fx.params, mode)

/** A node's effects that draw: known, switched on, in Photoshop's order. */
export function activeFx(list: LayerFx[]): LayerFx[] {
  return FX_DEFS.flatMap((d) => list.filter((f) => f.kind === d.kind && f.enabled))
}
