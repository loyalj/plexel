/**
 * A document converted to another colour mode, profile or depth: every
 * colour it holds, as pure data. The pixels are the engine's to convert
 * (engine/convertHost.ts); this takes their new tile sets and puts them in
 * place, and converts everything else a document keeps a colour in:
 *
 *   - fills, strokes, gradients and patterns of shapes, compound shapes and
 *     text (their appearance stacks);
 *   - every colour and gradient parameter of adjustments, filters and layer
 *     effects (parameters are kept in the document's own terms);
 *   - smart objects' contents, which share the document's mode and depth.
 *
 * Curves and Levels keep their master curve; their per-channel curves
 * belong to the old mode's channels, so a mode change drops them and says
 * so. Masks, alpha channels and the selection are coverage, not colour,
 * and stay as they are. Patterns made from pixels are converted as pixel
 * layers are.
 */
import { ADJUSTMENT_BY_ID } from '../adjust/defs'
import { FILTER_BY_ID } from '../filters/defs'
import { FX_BY_KIND } from '../fx/defs'
import { readParamValues, type GradientStop, type ParamDef } from './params'
import type { ColourMode, Depth, Doc, DocNode, LayerFx, ProfileRef } from './types'
import { appearanceIn, brushIn, mapPaintColours, paintIn, type AppearanceItem, type Paint } from './vector'
import type { CharProps } from './text'
import { mapBrushPaints } from './vectorBrush'
import { deepEqual } from '../lib/equal'

export interface ConvertTarget {
  mode: ColourMode
  profile: ProfileRef
  depth: Depth
}

/** One colour in the document's terms to the target's (CMYK as ink, everything 0..1). */
export type ColourFn = (c: number[]) => number[]

export interface Converted {
  doc: Doc
  warnings: string[]
}

/** Every tile set a document's pixels are in, its patterns and smart objects' contents included: what the engine converts. */
export function pixelSets(doc: Doc): string[] {
  const out = new Set<string>()
  const visit = (d: Doc) => {
    for (const n of Object.values(d.nodes)) {
      if (n.kind === 'pixel' && n.props.tiles) out.add(n.props.tiles)
      if (n.kind === 'text' && n.props.stand) out.add(n.props.stand.tiles)
      if (n.kind === 'embedded' && n.props.content) visit(n.props.content)
    }
    for (const p of d.patterns ?? []) {
      out.add(p.tiles)
      if (p.art) visit(p.art.content)
    }
    for (const s of d.symbols ?? []) visit(s.content)
  }
  visit(doc)
  return [...out]
}

/** Characters' own fill and stroke (colour per character) converted; the rest of their settings as they are. */
function convertCharPaints(c: Partial<CharProps>, from: ColourMode, fn: ColourFn): Partial<CharProps> {
  if (!c.fill && !c.stroke) return c
  return { ...c, ...(c.fill ? { fill: convertPaint(paintIn(c.fill, from), fn) } : {}), ...(c.stroke ? { stroke: convertPaint(paintIn(c.stroke, from), fn) } : {}) }
}

function convertPaint(p: Paint, fn: ColourFn): Paint {
  switch (p.kind) {
    case 'solid':
      return { ...p, colour: fn(p.colour) }
    case 'gradient':
      return { ...p, stops: p.stops.map((s) => ({ ...s, colour: fn(s.colour) })) }
    default:
      return mapPaintColours(p, fn)
  }
}

const convertAppearance = (a: AppearanceItem[], from: ColourMode, fn: ColourFn): AppearanceItem[] =>
  appearanceIn(a, from).map(
    (it) =>
      ({
        ...it,
        paint: convertPaint(it.paint, fn),
        ...(it.kind === 'stroke' && it.brush ? { brush: mapBrushPaints(brushIn(it.brush, from), (p) => convertPaint(p, fn), fn) } : {}),
        // An item's effects' colours (a shadow's) go across as every colour parameter does.
        ...(it.effects ? { effects: it.effects.map((e) => ({ ...e, params: convertColourParams(FILTER_BY_ID.get(e.kind)?.params ?? [], e.params, from, fn) })) } : {}),
      }) as AppearanceItem,
  )

/** A registry entry's colour parameters converted, the rest left as they are. */
function convertColourParams(defs: readonly ParamDef[], raw: Record<string, unknown>, from: ColourMode, fn: ColourFn): Record<string, unknown> {
  if (!defs.some((d) => d.kind === 'colour')) return raw
  const v = readParamValues(defs, raw, from)
  const out = { ...raw }
  for (const d of defs) if (d.kind === 'colour') out[d.key] = fn(v[d.key] as number[])
  return out
}

/**
 * A registry entry's parameters converted: colours and gradients through
 * `fn`, per-channel curves and levels kept for the master channel only when
 * the mode changes. `dropped` is told when that loses anything.
 */
function convertParams(defs: readonly ParamDef[], raw: Record<string, unknown>, from: ColourMode, to: ColourMode, fn: ColourFn, dropped: () => void): Record<string, unknown> {
  const v = readParamValues(defs, raw, from)
  const out: Record<string, unknown> = { ...raw }
  for (const d of defs) {
    if (d.kind === 'colour') out[d.key] = fn(v[d.key] as number[])
    else if (d.kind === 'gradient') out[d.key] = (v[d.key] as GradientStop[]).map((s) => ({ ...s, colour: fn(s.colour) }))
    else if ((d.kind === 'curves' || d.kind === 'levels') && from !== to) {
      const per = v[d.key] as Record<string, unknown>
      const changed = Object.entries(per).some(([ch, x]) => ch !== 'master' && !deepEqual(x, d.kind === 'curves' ? [[0, 0], [1, 1]] : { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 }))
      if (changed) dropped()
      out[d.key] = { master: per.master }
    }
  }
  return out
}

function convertNode(n: DocNode, from: ColourMode, to: ColourMode, fn: ColourFn, sets: ReadonlyMap<string, string>, target: ConvertTarget, warn: (w: string) => void): DocNode {
  const dropped = () => warn('Curves and Levels kept only their master channel: the old mode’s channels don’t exist in the new one')
  let m: DocNode = n
  const fx = n.fx.length
    ? n.fx.map((f): LayerFx => {
        const def = FX_BY_KIND.get(f.kind as never)
        return def ? { ...f, params: convertParams(def.params, f.params, from, to, fn, dropped) } : f
      })
    : n.fx
  if (fx !== n.fx) m = { ...m, fx }
  switch (m.kind) {
    case 'pixel': {
      const t = m.props.tiles ? (sets.get(m.props.tiles) ?? null) : null
      if (m.props.tiles && !t) warn('A layer’s pixels couldn’t be converted, so the layer is empty')
      return { ...m, props: { ...m.props, tiles: t } }
    }
    case 'text': {
      // Its stand-in pixels converted with the rest, or let go.
      const st = m.props.stand ? sets.get(m.props.stand.tiles) : undefined
      const { stand: _s, ...props } = m.props
      const content = { paragraphs: m.props.content.paragraphs.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, props: convertCharPaints(r.props, from, fn) })) })) }
      return { ...m, props: { ...props, content, ...(m.props.stand && st ? { stand: { ...m.props.stand, tiles: st } } : {}), appearance: convertAppearance(m.props.appearance, from, fn) } } as DocNode
    }
    case 'vector':
    case 'boolean':
      return { ...m, props: { ...m.props, appearance: convertAppearance(m.props.appearance, from, fn) } } as DocNode
    case 'fill':
      return { ...m, props: { ...m.props, paint: convertPaint(paintIn(m.props.paint, from), fn) } }
    case 'adjustment': {
      const def = ADJUSTMENT_BY_ID.get(m.props.adjustment)
      return def ? { ...m, props: { ...m.props, params: convertParams(def.params, m.props.params, from, to, fn, dropped) } } : m
    }
    case 'filter': {
      const def = FILTER_BY_ID.get(m.props.filter)
      return def ? { ...m, props: { ...m.props, params: convertParams(def.params, m.props.params, from, to, fn, dropped) } } : m
    }
    case 'embedded':
      return m.props.content ? { ...m, props: { ...m.props, content: convertDocColours(m.props.content, target, fn, sets, warn) } } : m
    default:
      return m
  }
}

/**
 * The document in `target`'s mode, profile and depth: `fn` converts each
 * colour, `sets` maps every pixel tile set (pixelSets) to its converted
 * one. `warn` hears what couldn't be kept.
 */
export function convertDocColours(doc: Doc, target: ConvertTarget, fn: ColourFn, sets: ReadonlyMap<string, string>, warn: (w: string) => void = () => {}): Doc {
  const nodes: Record<string, DocNode> = {}
  for (const [id, n] of Object.entries(doc.nodes)) nodes[id] = convertNode(n, doc.mode, target.mode, fn, sets, target, warn)
  const out: Doc = { ...doc, mode: target.mode, profile: target.profile, depth: target.depth, nodes }
  if (doc.graphicStyles?.length) out.graphicStyles = doc.graphicStyles.map((g) => ({ ...g, appearance: convertAppearance(g.appearance, doc.mode, fn) }))
  if (doc.textStyles) {
    const ts = doc.textStyles
    out.textStyles = { character: ts.character.map((c) => ({ ...c, char: convertCharPaints(c.char, doc.mode, fn) })), paragraph: ts.paragraph.map((p) => ({ ...p, char: convertCharPaints(p.char, doc.mode, fn) })) }
  }
  if (doc.vectorBrushes?.length) out.vectorBrushes = doc.vectorBrushes.map((b) => mapBrushPaints(brushIn(b, doc.mode), (p) => convertPaint(p, fn), fn))
  if (doc.patterns?.length) {
    out.patterns = doc.patterns.flatMap((p) => {
      const tiles = sets.get(p.tiles)
      if (!tiles) warn('A pattern’s pixels couldn’t be converted, so it was left out')
      return tiles ? [{ ...p, tiles, ...(p.art ? { art: { ...p.art, content: convertDocColours(p.art.content, target, fn, sets, warn) } } : {}) }] : []
    })
  }
  // Symbols' contents go with the document, as smart objects' do.
  if (doc.symbols?.length) out.symbols = doc.symbols.map((s) => ({ ...s, content: convertDocColours(s.content, target, fn, sets, warn) }))
  return out
}

/** The same, collecting the warnings once each. */
export function convertDoc(doc: Doc, target: ConvertTarget, fn: ColourFn, sets: ReadonlyMap<string, string>): Converted {
  const warnings = new Set<string>()
  const out = convertDocColours(doc, target, fn, sets, (w) => warnings.add(w))
  return { doc: out, warnings: [...warnings] }
}
