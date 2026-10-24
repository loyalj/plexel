/**
 * Fragments: a few layers lifted out of a document as a document of their
 * own, and put back into another. What the clipboard holds, and what
 * Duplicate Layer goes through.
 *
 * A fragment is an ordinary Doc: its root holds the copied layers (with
 * their masks, effects and clipped layers), in the mode, depth and profile
 * they came from, with the swatches their paints link to and the text
 * styles. Being a Doc, it converts to another mode as a document does
 * (doc/convert.ts) and its tile sets are found as a document's are.
 *
 * Pasting gives every node a new id, so the same fragment goes in as many
 * times as it's pasted, into the document it came from or any other.
 */
import { linkOf } from './graphicStyles'
import { insertNode, transformNode } from './edit'
import { makeNode, nodeDef } from './nodes'
import { placeOf, subtree } from './tree'
import type { TextStyles } from './text'
import type { DocSwatch } from './swatches'
import type { Affine, Doc, DocNode, DocPattern, NodeId } from './types'
import type { AppearanceItem, Paint } from './vector'

/** The swatch ids an appearance stack's paints link to. */
function linkedSwatches(a: AppearanceItem[], out: Set<string>) {
  for (const it of a) if (it.paint.kind === 'solid' && it.paint.swatch) out.add(it.paint.swatch)
}

/** The ids of the patterns made from pixels that nodes paint with: in fills and strokes, fill layers and Pattern Overlay. */
function usedPatterns(nodes: Iterable<DocNode>): Set<string> {
  const out = new Set<string>()
  const paint = (p: Paint) => p.kind === 'pattern' && out.add(p.pattern)
  for (const n of nodes) {
    if (n.kind === 'vector' || n.kind === 'boolean' || n.kind === 'text') for (const it of n.props.appearance) paint(it.paint)
    if (n.kind === 'fill') paint(n.props.paint)
    for (const f of n.fx) {
      if (f.kind === 'pattern-overlay' && typeof f.params.pattern === 'string') out.add(f.params.pattern)
      if (f.kind === 'pattern-overlay' && typeof f.params.image === 'string') out.add(f.params.image)
    }
  }
  return out
}

/**
 * The layers `ids` (and everything they hold) as a fragment, in the order
 * they're painted in `doc`. Layers inside another of the ids go with it,
 * not twice. Ids that aren't layers in `doc` are left out.
 */
export function fragmentOf(doc: Doc, ids: NodeId[], rootId: NodeId): Doc {
  const order = paintingOrder(doc)
  const chosen = new Set(ids.filter((id) => id !== doc.root && placeOf(doc, id)?.slot === 'children'))
  // A layer inside a chosen one comes along with it.
  const tops = [...chosen].filter((id) => !ancestors(doc, id).some((a) => chosen.has(a))).sort((a, b) => order.get(a)! - order.get(b)!)
  const nodes: Record<NodeId, DocNode> = {}
  for (const id of tops) for (const n of subtree(doc, id)) nodes[n] = doc.nodes[n]
  const root = makeNode('group', rootId, 'Root')
  root.children = tops
  nodes[rootId] = root
  const used = new Set<string>()
  for (const n of Object.values(nodes)) {
    if (n.kind === 'vector' || n.kind === 'boolean' || n.kind === 'text') linkedSwatches(n.props.appearance, used)
    if (n.kind === 'fill' && n.props.paint.kind === 'solid' && n.props.paint.swatch) used.add(n.props.paint.swatch)
  }
  const swatches = (doc.swatches ?? []).filter((s) => used.has(s.id))
  const patternIds = usedPatterns(Object.values(nodes))
  const patterns = (doc.patterns ?? []).filter((p) => patternIds.has(p.id))
  // Graphic styles the copied shapes are linked to go with them.
  const styleIds = new Set(Object.values(nodes).map((n) => linkOf(n)).filter((x): x is string => !!x))
  const graphicStyles = (doc.graphicStyles ?? []).filter((g) => styleIds.has(g.id))
  // The symbols copied instances show go with them, and the symbols those symbols' instances show.
  const symbolIds = new Set<string>()
  const visit = (list: DocNode[]) => {
    for (const n of list) {
      if (n.kind !== 'symbol' || symbolIds.has(n.props.symbol)) continue
      symbolIds.add(n.props.symbol)
      const s = doc.symbols?.find((x) => x.id === n.props.symbol)
      if (s) visit(Object.values(s.content.nodes))
    }
  }
  visit(Object.values(nodes))
  const symbols = (doc.symbols ?? []).filter((s) => symbolIds.has(s.id))
  const frag: Doc = { ...doc, root: rootId, nodes, selection: null, guides: [] }
  delete frag.swatches
  delete frag.graphicStyles
  delete frag.patterns
  delete frag.channels
  delete frag.tiled
  delete frag.symbols
  if (symbols.length) frag.symbols = symbols
  if (swatches.length) frag.swatches = swatches
  if (patterns.length) frag.patterns = patterns
  if (graphicStyles.length) frag.graphicStyles = graphicStyles
  return frag
}

/** Every node's position in painting order, bottom first, across the whole tree. */
function paintingOrder(doc: Doc): Map<NodeId, number> {
  const out = new Map<NodeId, number>()
  const visit = (id: NodeId) => {
    out.set(id, out.size)
    for (const c of doc.nodes[id]?.children ?? []) visit(c)
  }
  visit(doc.root)
  return out
}

function ancestors(doc: Doc, id: NodeId): NodeId[] {
  const out: NodeId[] = []
  for (let at = placeOf(doc, id)?.parent; at; at = placeOf(doc, at)?.parent) out.push(at)
  return out
}

/** The fragment's layers, top level, bottom first. */
export const fragmentLayers = (frag: Doc): NodeId[] => frag.nodes[frag.root]?.children ?? []

export interface PasteOptions {
  /** Where the layers go: `parent`'s children at `index` (painting order). A parent that can't hold them is passed over for the root. */
  parent: NodeId
  index: number
  /** Moved by this many document pixels on the way in. */
  offset?: [number, number]
  /** A fresh id, for each node pasted. */
  newId: (prefix: string) => string
  /** Each top-level layer's name, given its name in the fragment. */
  rename?: (name: string) => string
}

/**
 * The fragment's layers pasted into `doc`, every node under a new id, with
 * the swatches and text styles they use that `doc` doesn't have. Returns
 * the document and the new ids of the top-level layers, bottom first. The
 * fragment must already be in `doc`'s mode, depth and profile.
 */
export function pasteFragment(doc: Doc, frag: Doc, o: PasteOptions): { doc: Doc; ids: NodeId[] } {
  const ids = new Map<NodeId, NodeId>()
  for (const n of Object.values(frag.nodes)) if (n.id !== frag.root) ids.set(n.id, o.newId(n.kind === 'mask' ? 'm' : 'n'))
  const map = (id: NodeId) => ids.get(id) ?? id
  const fresh = new Map<NodeId, DocNode>()
  for (const n of Object.values(frag.nodes)) {
    if (n.id === frag.root) continue
    let m = { ...n, id: map(n.id), masks: n.masks.map(map), effects: n.effects.map(map) } as DocNode
    if (n.children) m.children = n.children.map(map)
    if (m.kind === 'boolean') {
      const ops: Record<NodeId, (typeof m.props.ops)[string]> = {}
      for (const [k, v] of Object.entries(m.props.ops)) ops[map(k)] = v
      m = { ...m, props: { ...m.props, ops } }
    }
    fresh.set(m.id, m)
  }
  const tops = fragmentLayers(frag).map(map)
  let parent = o.parent
  const p = doc.nodes[parent]
  if (!p?.children || tops.some((id) => !nodeDef(p.kind).accepts?.(fresh.get(id)!.kind))) parent = doc.root
  let index = parent === o.parent ? o.index : (doc.nodes[doc.root].children?.length ?? 0)
  // Everything but the top-level layers goes in directly; those go through insertNode, which places them.
  let out: Doc = { ...doc, nodes: { ...doc.nodes } }
  const topSet = new Set(tops)
  for (const [id, n] of fresh) if (!topSet.has(id)) out.nodes[id] = n
  const placed: NodeId[] = []
  for (const id of tops) {
    let n = fresh.get(id)!
    if (o.rename) n = { ...n, name: o.rename(n.name) } as DocNode
    const next = insertNode(out, n, parent, index)
    if (next === out) continue
    out = next
    placed.push(id)
    index++
  }
  if (!placed.length) return { doc, ids: [] }
  const [dx, dy] = o.offset ?? [0, 0]
  if (dx || dy) for (const id of placed) out = transformNode(out, id, [1, 0, 0, 1, dx, dy] as Affine)
  out = withSwatches(out, frag.swatches ?? [])
  out = withStyles(out, frag.textStyles)
  out = withPatterns(out, frag.patterns ?? [])
  // Graphic styles the document doesn't have come too; one it has (by id) is its own.
  const haveStyles = new Set((out.graphicStyles ?? []).map((g) => g.id))
  const addStyles = (frag.graphicStyles ?? []).filter((g) => !haveStyles.has(g.id))
  if (addStyles.length) out = { ...out, graphicStyles: [...(out.graphicStyles ?? []), ...addStyles] }
  // Symbols the document doesn't have (by id) come with their instances; one it has is its own.
  const haveSymbols = new Set((out.symbols ?? []).map((s) => s.id))
  const addSymbols = (frag.symbols ?? []).filter((s) => !haveSymbols.has(s.id))
  if (addSymbols.length) out = { ...out, symbols: [...(out.symbols ?? []), ...addSymbols] }
  return { doc: out, ids: placed }
}

/** The patterns `doc` doesn't have yet (by id) added to it; one it has is its own. */
function withPatterns(doc: Doc, patterns: DocPattern[]): Doc {
  const have = new Set((doc.patterns ?? []).map((p) => p.id))
  const add = patterns.filter((p) => !have.has(p.id))
  return add.length ? { ...doc, patterns: [...(doc.patterns ?? []), ...add] } : doc
}

/** The swatches `doc` doesn't have yet (by id) added to it. */
function withSwatches(doc: Doc, swatches: DocSwatch[]): Doc {
  const have = new Set((doc.swatches ?? []).map((s) => s.id))
  const add = swatches.filter((s) => !have.has(s.id))
  return add.length ? { ...doc, swatches: [...(doc.swatches ?? []), ...add] } : doc
}

/** The text styles `doc` doesn't have yet (by id) added to it; one it has keeps its own settings. */
function withStyles(doc: Doc, styles: TextStyles | undefined): Doc {
  if (!styles || (!styles.character.length && !styles.paragraph.length)) return doc
  const have = doc.textStyles ?? { character: [], paragraph: [] }
  const chars = new Set(have.character.map((s) => s.id))
  const paras = new Set(have.paragraph.map((s) => s.id))
  const character = styles.character.filter((s) => !chars.has(s.id))
  const paragraph = styles.paragraph.filter((s) => !paras.has(s.id))
  if (!character.length && !paragraph.length) return doc
  return { ...doc, textStyles: { character: [...have.character, ...character], paragraph: [...have.paragraph, ...paragraph] } }
}

/** A fragment of one pixel layer: copied pixels, `set` in the source's format, placed by `transform`. */
export function pixelFragment(source: Doc, rootId: NodeId, layerId: NodeId, name: string, set: string | null, transform: Affine): Doc {
  const layer = makeNode('pixel', layerId, name, { tiles: set })
  layer.transform = [...transform]
  const root = makeNode('group', rootId, 'Root')
  root.children = [layerId]
  const frag: Doc = { ...source, root: rootId, nodes: { [rootId]: root, [layerId]: layer }, selection: null, guides: [] }
  delete frag.swatches
  delete frag.symbols
  delete frag.textStyles
  delete frag.tiled
  delete frag.patterns
  delete frag.channels
  return frag
}
