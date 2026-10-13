/**
 * Graphic styles: named appearance stacks kept in the document
 * (Illustrator's Graphic Styles), each its fills and strokes with their
 * own effects. Applying one gives a shape, a compound shape or text a copy
 * of its appearance and links it to the style; redefining the style
 * changes every shape linked to it; changing a linked shape's own
 * appearance unlinks it, as in Illustrator.
 *
 * The link is the node's `graphicStyle`; what's drawn is always the node's
 * own appearance, so a document draws the same with or without its styles.
 */
import { readAppearance, type AppearanceItem } from './vector'
import { isObject, type Warn } from './read'
import type { Doc, DocNode, NodeId } from './types'

export interface GraphicStyle {
  id: string
  name: string
  appearance: AppearanceItem[]
}

/** The kinds a graphic style goes on. */
export const stylable = (n: DocNode | undefined): n is DocNode & { kind: 'vector' | 'boolean' | 'text' } => !!n && (n.kind === 'vector' || n.kind === 'boolean' || n.kind === 'text')

/** The style a node is linked to, if any. */
export const linkOf = (n: DocNode | undefined): string | null => (stylable(n) ? ((n.props as { graphicStyle?: string | null }).graphicStyle ?? null) : null)

export function readGraphicStyles(raw: unknown, warn: Warn): GraphicStyle[] {
  if (!Array.isArray(raw)) return []
  const out: GraphicStyle[] = []
  for (const s of raw) {
    if (!isObject(s) || typeof s.id !== 'string' || !s.id) {
      warn('a graphic style was not readable; left it out')
      continue
    }
    out.push({ id: s.id, name: typeof s.name === 'string' ? s.name.slice(0, 200) : 'Style', appearance: readAppearance(s.appearance, warn) })
  }
  return out
}

/** A copy of an appearance, so a style and a node never share one. */
const copy = (a: AppearanceItem[]): AppearanceItem[] => JSON.parse(JSON.stringify(a)) as AppearanceItem[]

const withNode = (n: DocNode, appearance: AppearanceItem[], link: string | null): DocNode => ({ ...n, props: { ...n.props, appearance, graphicStyle: link } }) as DocNode

export function addGraphicStyle(doc: Doc, s: GraphicStyle): Doc {
  if ((doc.graphicStyles ?? []).some((x) => x.id === s.id)) return doc
  return { ...doc, graphicStyles: [...(doc.graphicStyles ?? []), { ...s, appearance: copy(s.appearance) }] }
}

export function renameGraphicStyle(doc: Doc, id: string, name: string): Doc {
  const n = name.trim()
  if (!n) return doc
  return { ...doc, graphicStyles: (doc.graphicStyles ?? []).map((s) => (s.id === id ? { ...s, name: n } : s)) }
}

/** Takes a style out of the document; the shapes linked to it keep their look, unlinked. */
export function removeGraphicStyle(doc: Doc, id: string): Doc {
  const nodes = { ...doc.nodes }
  for (const n of Object.values(doc.nodes)) if (linkOf(n) === id) nodes[n.id] = withNode(n, (n.props as { appearance: AppearanceItem[] }).appearance, null)
  return { ...doc, nodes, graphicStyles: (doc.graphicStyles ?? []).filter((s) => s.id !== id) }
}

/** Gives the nodes a copy of the style's appearance, linked to it. */
export function applyGraphicStyle(doc: Doc, ids: NodeId[], id: string): Doc {
  const s = (doc.graphicStyles ?? []).find((x) => x.id === id)
  if (!s) return doc
  const nodes = { ...doc.nodes }
  let changed = false
  for (const nid of ids) {
    const n = doc.nodes[nid]
    if (!stylable(n)) continue
    nodes[nid] = withNode(n, copy(s.appearance), id)
    changed = true
  }
  return changed ? { ...doc, nodes } : doc
}

/** A style made the appearance given, and every node linked to it with it. */
export function redefineGraphicStyle(doc: Doc, id: string, appearance: AppearanceItem[]): Doc {
  if (!(doc.graphicStyles ?? []).some((s) => s.id === id)) return doc
  const nodes = { ...doc.nodes }
  for (const n of Object.values(doc.nodes)) if (linkOf(n) === id) nodes[n.id] = withNode(n, copy(appearance), id)
  return { ...doc, nodes, graphicStyles: (doc.graphicStyles ?? []).map((s) => (s.id === id ? { ...s, appearance: copy(appearance) } : s)) }
}

/** A node's link to its style broken; its look stays. */
export function unlinkGraphicStyle(doc: Doc, id: NodeId): Doc {
  const n = doc.nodes[id]
  if (!linkOf(n)) return doc
  return { ...doc, nodes: { ...doc.nodes, [id]: withNode(n, (n.props as { appearance: AppearanceItem[] }).appearance, null) } }
}
