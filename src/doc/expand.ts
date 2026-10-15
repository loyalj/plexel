/**
 * Artboards and symbol instances as plain layers, for everything that
 * draws or writes a document (the engine's scenes, the exporters, picking):
 *
 * - An artboard becomes an isolated group with its background, a rectangle
 *   in its colour, at the bottom, and (when it clips) a vector mask of its
 *   rectangle among its masks.
 * - An instance becomes a group of copies of its symbol's layers, each
 *   through the instance's transform, named `<instance>~<layer>` so a hit
 *   on one is a hit on the instance (`ownerOf`). Instances inside a symbol
 *   are expanded in turn, a few deep at most.
 *
 * What a document draws doesn't change: only how it's said. The result is
 * kept per document and per node, and a node that didn't change is the same
 * object as before, so the engine is sent only what did.
 */
import { artboardRect, isArtboard, type ArtboardNode } from './artboards'
import { copyNode, symbolById } from './symbols'
import { fillItem, solid } from './vector'
import { makeNode } from './nodes'
import type { Doc, DocNode, DocPattern, DocSymbol, NodeId } from './types'

/** How a made-up node's id is joined to the node it stands for. */
export const SEP = '~'
/** The node a made-up (expanded) node belongs to in the document itself. */
export const ownerOf = (id: NodeId): NodeId => (id.includes(SEP) ? id.slice(0, id.indexOf(SEP)) : id)

/** Instances inside symbols inside symbols: this many deep, no more. */
const MAX_DEPTH = 6

const byDoc = new WeakMap<Doc, Doc>()

/** Whether a document has anything to expand. */
const needs = (doc: Doc) => Object.values(doc.nodes).some((n) => n.kind === 'symbol' || isArtboard(n))

export function expandDoc(doc: Doc): Doc {
  const kept = byDoc.get(doc)
  if (kept) return kept
  if (!needs(doc)) {
    byDoc.set(doc, doc)
    return doc
  }
  let nodes: Record<NodeId, DocNode> = doc.nodes
  let patterns = doc.patterns
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const out: Record<NodeId, DocNode> = {}
    let more = false
    for (const [id, n] of Object.entries(nodes)) {
      if (isArtboard(n)) Object.assign(out, artboardNodes(n))
      else if (n.kind === 'symbol') {
        const s = symbolById(doc, n.props.symbol)
        Object.assign(out, instanceNodes(n, s))
        if (s) {
          if (Object.values(s.content.nodes).some((x) => x.kind === 'symbol')) more = true
          patterns = mergePatterns(patterns, s.content.patterns)
        }
      } else out[id] = n
    }
    nodes = out
    if (!more) break
  }
  const expanded = { ...doc, nodes, ...(patterns ? { patterns } : {}) }
  byDoc.set(doc, expanded)
  return expanded
}

/** The patterns a symbol's layers paint with, added where the document hasn't them. */
function mergePatterns(a: DocPattern[] | undefined, b: DocPattern[] | undefined): DocPattern[] | undefined {
  if (!b?.length) return a
  const have = new Set((a ?? []).map((p) => p.id))
  const extra = b.filter((p) => !have.has(p.id))
  return extra.length ? [...(a ?? []), ...extra] : a
}

// --- artboards ---------------------------------------------------------------------------

const artboardKept = new WeakMap<DocNode, Record<NodeId, DocNode>>()

function artboardNodes(n: ArtboardNode): Record<NodeId, DocNode> {
  const kept = artboardKept.get(n)
  if (kept) return kept
  const a = n.props.artboard
  const [x, y] = artboardRect(n)
  const box = { type: 'rect' as const, x: 0, y: 0, w: a.width, h: a.height, radii: [0, 0, 0, 0] as [number, number, number, number], corner: 'round' as const }
  const out: Record<NodeId, DocNode> = {}
  const children = [...(n.children ?? [])]
  const masks = [...n.masks]
  if (a.background) {
    const bg = makeNode('vector', `${n.id}${SEP}bg`, 'Background', { geometry: { kind: 'shape', shape: box }, appearance: [fillItem(solid(a.background))], graphicStyle: null })
    bg.transform = [1, 0, 0, 1, x, y]
    out[bg.id] = bg as DocNode
    children.unshift(bg.id)
  }
  if (a.clip) {
    const clip = makeNode('mask', `${n.id}${SEP}clip`, 'Artboard', { source: 'vector', geometry: { kind: 'shape', shape: box }, outside: 0 })
    clip.transform = [1, 0, 0, 1, x, y]
    out[clip.id] = clip as DocNode
    masks.push(clip.id)
  }
  // A plain group to the renderer: isolated, so its layers land on its background.
  const { artboard: _a, ...props } = n.props
  out[n.id] = { ...n, props, blend: n.blend === 'pass-through' ? 'normal' : n.blend, children, masks } as DocNode
  artboardKept.set(n, out)
  return out
}

// --- instances ------------------------------------------------------------------------------

/** Per instance, per version of its symbol: undo and redo go back and forth between the same objects. */
const instanceKept = new WeakMap<DocNode, WeakMap<DocSymbol | typeof NONE, Record<NodeId, DocNode>>>()
const NONE = {}

function instanceNodes(n: DocNode & { kind: 'symbol' }, s: DocSymbol | undefined): Record<NodeId, DocNode> {
  let bySymbol = instanceKept.get(n)
  const kept = bySymbol?.get(s ?? NONE)
  if (kept) return kept
  const out: Record<NodeId, DocNode> = {}
  const group = makeNode('group', n.id, n.name)
  Object.assign(group, {
    visible: n.visible,
    locked: n.locked,
    opacity: n.opacity,
    fillOpacity: n.fillOpacity,
    // Isolated, as a symbol is one piece of artwork; laid on with the instance's mode.
    blend: n.blend,
    masks: n.masks,
    effects: n.effects,
    fx: n.fx,
    tag: n.tag,
  })
  if (s) {
    const c = s.content
    const map = (id: NodeId) => `${n.id}${SEP}${id}`
    for (const [id, node] of Object.entries(c.nodes)) if (id !== c.root) out[map(id)] = copyNode(node, map, n.transform)
    group.children = (c.nodes[c.root]?.children ?? []).map(map)
  }
  out[n.id] = group as DocNode
  if (!bySymbol) instanceKept.set(n, (bySymbol = new WeakMap()))
  bySymbol.set(s ?? NONE, out)
  return out
}
