/**
 * Swatches kept in the document, as Illustrator and InDesign keep them:
 * each with a name and a colour in its own space (a CMYK or Lab colour
 * stays itself through any change of mode), and one of three kinds:
 *
 *   process  a colour to pick from; nothing remembers it was used.
 *   global   a process colour that fills and strokes stay linked to:
 *            changing the swatch changes every one of them.
 *   spot     a named ink (a Pantone, a varnish, a house colour), linked
 *            like a global one. It's drawn through its process equivalent
 *            (the colour given, in CMYK or Lab), and kept as a spot so print
 *            output can make a plate of it.
 *
 * A linked paint keeps its swatch's id and a tint (1 is full strength) next
 * to its colour, which is always the swatch's colour, tinted, in the
 * document's own terms: drawing never needs the swatch. The edits here keep
 * it so, given how to make that colour (the page's colour engine).
 */
import { readColourValue, type ColourValue } from '../color/value'
import { isObject, type Warn } from './read'
import type { ParamColour } from './params'
import type { ColourMode, Doc, DocNode } from './types'
import type { AppearanceItem, Paint } from './vector'

export type SwatchKind = 'process' | 'global' | 'spot'

export interface DocSwatch {
  id: string
  name: string
  kind: SwatchKind
  colour: ColourValue
}

/** A swatch's colour in a document's terms at a tint: what a linked paint holds. */
export type SwatchColourFn = (s: DocSwatch, tint: number) => ParamColour

export const SWATCH_KINDS: [SwatchKind, string][] = [
  ['process', 'Process'],
  ['global', 'Global process'],
  ['spot', 'Spot'],
]

/** Whether paints stay linked to a swatch of this kind. */
export const linkable = (s: DocSwatch | undefined) => !!s && s.kind !== 'process'

/**
 * A tint of a colour in a document's terms, as a spot ink's tint prints:
 * CMYK inks scaled, RGB and Gray towards white.
 */
export function tinted(c: ParamColour, mode: ColourMode, tint: number): ParamColour {
  const t = Math.min(1, Math.max(0, tint))
  if (t >= 1) return [...c]
  return mode === 'cmyk' ? c.map((v) => v * t) : c.map((v) => 1 - (1 - v) * t)
}

export function readSwatches(raw: unknown, warn: Warn): DocSwatch[] {
  if (!Array.isArray(raw)) {
    warn('the document’s swatches were not readable; left them out')
    return []
  }
  const out: DocSwatch[] = []
  const ids = new Set<string>()
  for (const r of raw) {
    if (!isObject(r) || typeof r.id !== 'string' || ids.has(r.id)) {
      warn('a swatch was not readable; left it out')
      continue
    }
    const colour = readColourValue(r.colour)
    if (!colour) {
      warn(`the swatch “${String(r.name ?? r.id)}” had no readable colour; left it out`)
      continue
    }
    ids.add(r.id)
    out.push({ id: r.id, name: typeof r.name === 'string' && r.name.trim() ? r.name : 'Swatch', kind: r.kind === 'global' || r.kind === 'spot' ? r.kind : 'process', colour })
  }
  return out
}

// --- paints ----------------------------------------------------------------------------------------

/** Each paint of an appearance stack through `fn`; the same array when nothing changes. */
function mapAppearance(a: AppearanceItem[], fn: (p: Paint) => Paint): AppearanceItem[] {
  let changed = false
  const out = a.map((it) => {
    const paint = fn(it.paint)
    if (paint === it.paint) return it
    changed = true
    return { ...it, paint } as AppearanceItem
  })
  return changed ? out : a
}

/** Every paint in the document's own layers through `fn` (smart objects' contents have swatches of their own). */
export function mapPaints(doc: Doc, fn: (p: Paint) => Paint): Doc {
  let nodes: Record<string, DocNode> | null = null
  for (const [id, n] of Object.entries(doc.nodes)) {
    if (n.kind === 'fill') {
      const paint = fn(n.props.paint)
      if (paint === n.props.paint) continue
      nodes ??= { ...doc.nodes }
      nodes[id] = { ...n, props: { ...n.props, paint } }
      continue
    }
    if (n.kind !== 'vector' && n.kind !== 'boolean' && n.kind !== 'text') continue
    const appearance = mapAppearance(n.props.appearance, fn)
    if (appearance === n.props.appearance) continue
    nodes ??= { ...doc.nodes }
    nodes[id] = { ...n, props: { ...n.props, appearance } } as DocNode
  }
  return nodes ? { ...doc, nodes } : doc
}

/** Every linked paint's colour made again from its swatch, as `colourOf` makes it (after a change of mode, say). */
export function recolourLinked(doc: Doc, colourOf: SwatchColourFn): Doc {
  const byId = new Map((doc.swatches ?? []).map((s) => [s.id, s]))
  return mapPaints(doc, (p) => {
    if (p.kind !== 'solid' || !p.swatch) return p
    const s = byId.get(p.swatch)
    if (!linkable(s)) {
      const { swatch: _s, tint: _t, ...rest } = p
      return rest
    }
    const colour = colourOf(s!, p.tint ?? 1)
    return colour.every((v, i) => v === p.colour[i]) && colour.length === p.colour.length ? p : { ...p, colour }
  })
}

// --- edits -----------------------------------------------------------------------------------------

export function addSwatch(doc: Doc, s: DocSwatch, index = (doc.swatches ?? []).length): Doc {
  const list = [...(doc.swatches ?? [])]
  list.splice(Math.min(index, list.length), 0, s)
  return { ...doc, swatches: list }
}

/** A swatch changed (name, kind, colour); paints linked to it follow. */
export function updateSwatch(doc: Doc, id: string, patch: Partial<Omit<DocSwatch, 'id'>>, colourOf: SwatchColourFn): Doc {
  const list = doc.swatches ?? []
  if (!list.some((s) => s.id === id)) return doc
  const next = { ...doc, swatches: list.map((s) => (s.id === id ? { ...s, ...patch } : s)) }
  return recolourLinked(next, colourOf)
}

/** A swatch deleted: paints linked to it keep their colour, unlinked. */
export function removeSwatch(doc: Doc, id: string): Doc {
  const list = doc.swatches ?? []
  if (!list.some((s) => s.id === id)) return doc
  const next = mapPaints(doc, (p) => {
    if (p.kind !== 'solid' || p.swatch !== id) return p
    const { swatch: _s, tint: _t, ...rest } = p
    return rest
  })
  return { ...next, swatches: list.filter((s) => s.id !== id) }
}

export function moveSwatch(doc: Doc, id: string, index: number): Doc {
  const list = [...(doc.swatches ?? [])]
  const i = list.findIndex((s) => s.id === id)
  if (i < 0) return doc
  const [s] = list.splice(i, 1)
  list.splice(Math.max(0, Math.min(index, list.length)), 0, s)
  return { ...doc, swatches: list }
}

/** A solid paint linked to a swatch at a tint (a process swatch only gives its colour). */
export function swatchPaint(s: DocSwatch, tint: number, colourOf: SwatchColourFn): Paint {
  const colour = colourOf(s, linkable(s) ? tint : 1)
  return linkable(s) ? { kind: 'solid', colour, swatch: s.id, tint: Math.min(1, Math.max(0, tint)) } : { kind: 'solid', colour }
}

/** Which swatches the document's paints link to, with how many paints each. */
export function swatchUses(doc: Doc): Map<string, number> {
  const out = new Map<string, number>()
  mapPaints(doc, (p) => {
    if (p.kind === 'solid' && p.swatch) out.set(p.swatch, (out.get(p.swatch) ?? 0) + 1)
    return p
  })
  return out
}
