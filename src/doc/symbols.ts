/**
 * Symbols: artwork kept once and placed as instances, as Illustrator's and
 * Affinity's are. Edit the symbol and every instance follows; each instance
 * has its own place, size, turn, opacity and blend mode.
 *
 * A symbol's contents are a document of their own (`DocSymbol.content`),
 * as a smart object's are, with the artwork at the origin and the canvas
 * its size. An instance is a node of kind `symbol` naming it; its
 * transform takes the symbol's coordinates into the document's. On its way
 * to the renderer (and the exporters) an instance becomes a group of
 * copies of the symbol's layers, each through the instance's transform
 * (doc/expand.ts), so shapes and text stay sharp at any size.
 *
 * Pure, so the checks run it in Node.
 */
import { compose, insertNode, removeNode } from './edit'
import { makeNode } from './nodes'
import { placeOf } from './tree'
import { IDENTITY, type Affine, type Doc, type DocNode, type DocSymbol, type NodeId } from './types'

export type SymbolNode = DocNode & { kind: 'symbol' }

export const symbolById = (doc: Doc, id: string): DocSymbol | undefined => doc.symbols?.find((s) => s.id === id)

/** A name for a new symbol: "Symbol 2" and so on. */
export function nextSymbolName(doc: Doc): string {
  const used = new Set((doc.symbols ?? []).map((s) => s.name))
  let i = (doc.symbols?.length ?? 0) + 1
  while (used.has(`Symbol ${i}`)) i++
  return `Symbol ${i}`
}

/** Every node in a subtree: the node, its children's subtrees, its masks and effects. */
function subtree(doc: Doc, id: NodeId, out = new Set<NodeId>()): Set<NodeId> {
  const n = doc.nodes[id]
  if (!n || out.has(id)) return out
  out.add(id)
  for (const m of n.masks) subtree(doc, m, out)
  for (const e of n.effects) subtree(doc, e, out)
  for (const c of n.children ?? []) subtree(doc, c, out)
  return out
}

/** Instances of a symbol in a document, its own and its smart objects' not counted. */
export const instancesOf = (doc: Doc, symbol: string): SymbolNode[] => Object.values(doc.nodes).filter((n): n is SymbolNode => n.kind === 'symbol' && n.props.symbol === symbol)

/**
 * New Symbol from the selected layers: they become the symbol's contents,
 * moved so the box round them is at the origin, and in their place, where
 * the topmost of them was, an instance that shows them where they were.
 * `box` is that box in document pixels; `ids` are top-level picks (none
 * inside another), bottom first.
 */
export function makeSymbol(doc: Doc, ids: NodeId[], box: [number, number, number, number], o: { symbolId: string; instanceId: NodeId; rootId: NodeId; name: string }): Doc {
  const picked = ids.filter((id) => doc.nodes[id] && id !== doc.root)
  if (!picked.length) return doc
  const [x0, y0, x1, y1] = [Math.floor(box[0]), Math.floor(box[1]), Math.ceil(box[2]), Math.ceil(box[3])]
  const width = Math.max(1, x1 - x0)
  const height = Math.max(1, y1 - y0)
  const toSymbol: Affine = [1, 0, 0, 1, -x0, -y0]
  // The symbol's own document: the picked layers, and all they hold, moved to the origin.
  const nodes: Record<NodeId, DocNode> = {}
  for (const id of picked) for (const s of subtree(doc, id)) nodes[s] = { ...doc.nodes[s], transform: compose(toSymbol, doc.nodes[s].transform) } as DocNode
  const root = makeNode('group', o.rootId, 'Root')
  root.children = [...picked]
  nodes[root.id] = root as DocNode
  const content: Doc = {
    name: o.name,
    width,
    height,
    resolution: doc.resolution,
    mode: doc.mode,
    depth: doc.depth,
    profile: doc.profile,
    root: root.id,
    nodes,
    guides: [],
    selection: null,
    ...(doc.textStyles ? { textStyles: doc.textStyles } : {}),
    ...(doc.patterns ? { patterns: doc.patterns } : {}),
    ...(doc.swatches ? { swatches: doc.swatches } : {}),
  }
  // The instance goes where the topmost picked layer was.
  const top = picked[picked.length - 1]
  const at = placeOf(doc, top)
  if (!at || at.slot !== 'children') return doc
  const inst = makeNode('symbol', o.instanceId, o.name, { symbol: o.symbolId })
  inst.transform = [1, 0, 0, 1, x0, y0]
  let out: Doc = { ...doc, symbols: [...(doc.symbols ?? []), { id: o.symbolId, name: o.name, content }] }
  out = insertNode(out, inst as DocNode, at.parent, at.index + 1)
  for (const id of picked) out = removeNode(out, id)
  return out
}

/** An instance of a symbol, centred on (cx, cy), at the top of `parent`. */
export function placeSymbol(doc: Doc, symbolId: string, instanceId: NodeId, parent: NodeId, index: number, cx: number, cy: number): Doc {
  const s = symbolById(doc, symbolId)
  if (!s) return doc
  const inst = makeNode('symbol', instanceId, s.name, { symbol: symbolId })
  inst.transform = [1, 0, 0, 1, Math.round(cx - s.content.width / 2), Math.round(cy - s.content.height / 2)]
  return insertNode(doc, inst as DocNode, parent, index)
}

/** A symbol's contents replaced: every instance shows them at once. */
export function setSymbolContent(doc: Doc, symbolId: string, content: Doc): Doc {
  const list = doc.symbols ?? []
  const s = list.find((x) => x.id === symbolId)
  if (!s || s.content === content) return doc
  return { ...doc, symbols: list.map((x) => (x.id === symbolId ? { ...x, content } : x)) }
}

export function renameSymbol(doc: Doc, symbolId: string, name: string): Doc {
  const n = name.trim()
  const list = doc.symbols ?? []
  if (!n || !list.some((x) => x.id === symbolId && x.name !== n)) return doc
  return { ...doc, symbols: list.map((x) => (x.id === symbolId ? { ...x, name: n, content: { ...x.content, name: n } } : x)) }
}

/** A copy of a symbol under a new id and name. */
export function duplicateSymbol(doc: Doc, symbolId: string, newId: string, name: string): Doc {
  const s = symbolById(doc, symbolId)
  if (!s) return doc
  return { ...doc, symbols: [...(doc.symbols ?? []), { id: newId, name, content: { ...s.content, name } }] }
}

/**
 * Break Link: an instance becomes a group of the symbol's layers, its own
 * from now on, each through the instance's transform. `newId` gives each
 * copied node an id the document doesn't have yet.
 */
export function breakLink(doc: Doc, instanceId: NodeId, newId: (old: NodeId) => NodeId): Doc {
  const inst = doc.nodes[instanceId]
  if (!inst || inst.kind !== 'symbol') return doc
  const s = symbolById(doc, inst.props.symbol)
  const at = placeOf(doc, instanceId)
  if (!at || at.slot !== 'children') return doc
  const group = makeNode('group', newId(instanceId), inst.name)
  Object.assign(group, { opacity: inst.opacity, fillOpacity: inst.fillOpacity, blend: inst.blend === 'normal' ? 'pass-through' : inst.blend, visible: inst.visible, masks: inst.masks, effects: inst.effects, fx: inst.fx, tag: inst.tag })
  const nodes = { ...doc.nodes }
  if (s) {
    const ids = new Map<NodeId, NodeId>()
    const content = s.content
    const all = [...subtree(content, content.root)].filter((id) => id !== content.root)
    for (const id of all) ids.set(id, newId(id))
    const map = (id: NodeId) => ids.get(id) ?? id
    for (const id of all) nodes[map(id)] = copyNode(content.nodes[id], map, inst.transform)
    group.children = (content.nodes[content.root].children ?? []).map(map)
  }
  nodes[group.id] = group as DocNode
  const parent = nodes[at.parent]
  nodes[at.parent] = { ...parent, children: parent.children!.map((c) => (c === instanceId ? group.id : c)) } as DocNode
  delete nodes[instanceId]
  return { ...doc, nodes }
}

/**
 * A node of a symbol's contents as it is in a document: renamed by `map`
 * (its id and every id it names: children, masks, effects, a compound
 * shape's operations), through the instance's transform `t`.
 */
export function copyNode(n: DocNode, map: (id: NodeId) => NodeId, t: Affine): DocNode {
  const c = { ...n, id: map(n.id), transform: isIdentity(t) ? n.transform : compose(t, n.transform), masks: n.masks.map(map), effects: n.effects.map(map) } as DocNode
  if (n.children) c.children = n.children.map(map)
  if (n.kind === 'boolean') (c as typeof n).props = { ...n.props, ops: Object.fromEntries(Object.entries(n.props.ops).map(([k, v]) => [map(k), v])) }
  return c
}

const isIdentity = (t: Affine) => t.every((v, i) => v === IDENTITY[i])

/**
 * Deleting a symbol: its instances can't show nothing, so each first
 * becomes a group of its own (Break Link), as Illustrator offers.
 */
export function deleteSymbol(doc: Doc, symbolId: string, newId: (old: NodeId) => NodeId): Doc {
  let out = doc
  for (const inst of instancesOf(doc, symbolId)) out = breakLink(out, inst.id, newId)
  return { ...out, symbols: (out.symbols ?? []).filter((s) => s.id !== symbolId) }
}

/** An instance shown as another symbol, keeping its place, size and turn. */
export function replaceSymbol(doc: Doc, instanceId: NodeId, symbolId: string): Doc {
  const n = doc.nodes[instanceId]
  if (!n || n.kind !== 'symbol' || !symbolById(doc, symbolId) || n.props.symbol === symbolId) return doc
  return { ...doc, nodes: { ...doc.nodes, [instanceId]: { ...n, props: { symbol: symbolId } } } }
}
