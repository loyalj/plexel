/**
 * Finding your way around the node tree.
 *
 * Children are in painting order: `children[0]` is drawn first, at the
 * bottom, and the last child is on top. That's the order the renderer walks
 * and the order PSD stores layers in. The layers panel shows them reversed,
 * top first, as every editor does.
 */
import type { Doc, DocNode, NodeId } from './types'

/** Where a node sits: which node holds it, and in which of its lists. */
export interface Place {
  parent: NodeId
  slot: 'children' | 'masks' | 'effects'
  index: number
}

/** Every node's place, computed in one pass. Cached per `nodes` object, which is replaced on every edit. */
const placesCache = new WeakMap<Doc['nodes'], Map<NodeId, Place>>()

function places(doc: Doc): Map<NodeId, Place> {
  const cached = placesCache.get(doc.nodes)
  if (cached) return cached
  const map = new Map<NodeId, Place>()
  for (const node of Object.values(doc.nodes)) {
    for (const slot of ['children', 'masks', 'effects'] as const) {
      const list = slot === 'children' ? node.children : node[slot]
      list?.forEach((id, index) => map.set(id, { parent: node.id, slot, index }))
    }
  }
  placesCache.set(doc.nodes, map)
  return map
}

export const placeOf = (doc: Doc, id: NodeId) => places(doc).get(id)

/** The top-level artboard holding a node (or the artboard itself); null outside them. */
function artboardHolding(doc: Doc, id: NodeId): NodeId | null {
  let at: NodeId | undefined = id
  while (at) {
    const p = placeOf(doc, at)
    if (!p) return null
    if (p.parent === doc.root) {
      const n = doc.nodes[at]
      return n?.kind === 'group' && n.props.artboard ? at : null
    }
    at = p.parent
  }
  return null
}

/** The topmost artboard under a document point, by id. */
function artboardUnder(doc: Doc, x: number, y: number): NodeId | null {
  for (const id of [...(doc.nodes[doc.root]?.children ?? [])].reverse()) {
    const n = doc.nodes[id]
    if (n?.kind !== 'group' || !n.props.artboard) continue
    const [ax, ay] = [n.transform[4], n.transform[5]]
    if (x >= ax && y >= ay && x < ax + n.props.artboard.width && y < ay + n.props.artboard.height) return id
  }
  return null
}

/**
 * Where a new layer goes: above the selected one, in its group (inside a
 * compound shape it's above the compound); into the artboard itself when
 * an artboard is selected; otherwise at the top. Drawn at a point (`at`)
 * on an artboard the selected layer isn't in, it goes at the top of that
 * artboard instead, so a shape drawn on Artboard 2 isn't clipped away in
 * Artboard 1, as in Photoshop.
 */
export function whereNew(doc: Doc, selected: NodeId | null, at?: [number, number] | null): { parent: NodeId; index: number } {
  const top = (parent: NodeId) => ({ parent, index: doc.nodes[parent]?.children?.length ?? 0 })
  if (at) {
    const under = artboardUnder(doc, at[0], at[1])
    if (under && (!selected || artboardHolding(doc, selected) !== under)) return top(under)
  }
  const sel = selected ? doc.nodes[selected] : null
  if (sel?.kind === 'group' && sel.props.artboard) return top(sel.id)
  let place = selected ? placeOf(doc, selected) : null
  // Inside a compound shape, the new layer goes above the compound.
  while (place?.slot === 'children' && doc.nodes[place.parent]?.kind === 'boolean') place = placeOf(doc, place.parent)
  if (place?.slot === 'children') return { parent: place.parent, index: place.index + 1 }
  return top(doc.root)
}

/**
 * What to select in place of `id` once it's gone, as Photoshop does: the
 * nearest layer below it among its siblings, else the nearest above, else
 * the group (or layer) that held it. `ok` says whether a candidate is still
 * there to be selected. Looked up in `doc`, the document before it went.
 */
export function neighbourOf(doc: Doc, id: NodeId, ok: (id: NodeId) => boolean): NodeId | null {
  const place = placeOf(doc, id)
  if (!place) return null
  const parent = doc.nodes[place.parent]
  const list = place.slot === 'children' ? (parent?.children ?? []) : place.slot === 'masks' ? (parent?.masks ?? []) : (parent?.effects ?? [])
  // Below in the panel is earlier in painting order.
  for (let i = place.index - 1; i >= 0; i--) if (ok(list[i])) return list[i]
  for (let i = place.index + 1; i < list.length; i++) if (ok(list[i])) return list[i]
  if (place.parent !== doc.root && ok(place.parent)) return place.parent
  // The parent went too: what would replace it.
  return place.parent !== doc.root ? neighbourOf(doc, place.parent, ok) : null
}

/** The node and everything under it (children, masks and effects, all the way down), parents first. */
export function subtree(doc: Doc, id: NodeId): NodeId[] {
  const out: NodeId[] = []
  const visit = (n: NodeId) => {
    const node = doc.nodes[n]
    if (!node) return
    out.push(n)
    node.masks.forEach(visit)
    node.effects.forEach(visit)
    node.children?.forEach(visit)
  }
  visit(id)
  return out
}

/** Whether `ancestor` is `id` or holds it, at any depth. */
export function isWithin(doc: Doc, id: NodeId, ancestor: NodeId): boolean {
  const p = places(doc)
  for (let at: NodeId | undefined = id; at; at = p.get(at)?.parent) if (at === ancestor) return true
  return false
}

/**
 * Layers as the layers panel lists them: top first, each followed by its
 * children when its group is open. `depth` is the nesting level for
 * indentation. The root itself isn't listed. `folded` holds the nodes the
 * panel has folded, which is view state, not part of the document.
 */
export function layerRows(doc: Doc, folded: ReadonlySet<NodeId> = new Set()): { node: DocNode; depth: number }[] {
  const rows: { node: DocNode; depth: number }[] = []
  const visit = (id: NodeId, depth: number) => {
    const node = doc.nodes[id]
    if (!node) return
    rows.push({ node, depth })
    if (!folded.has(id) && node.children) for (const c of [...node.children].reverse()) visit(c, depth + 1)
  }
  const root = doc.nodes[doc.root]
  for (const c of [...(root?.children ?? [])].reverse()) visit(c, 0)
  return rows
}

/** A name not yet used in the document: "Group 1", "Group 2"... */
export function freshName(doc: Doc, base: string): string {
  const used = new Set(Object.values(doc.nodes).map((n) => n.name))
  for (let i = 1; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`
}
