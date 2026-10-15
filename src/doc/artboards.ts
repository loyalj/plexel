/**
 * Artboards: pages of one document, each with its own size, as in
 * Photoshop, Illustrator and Affinity.
 *
 * An artboard is a group at the document's top level carrying an
 * `artboard` (types.ts): its size, its background, and whether it clips
 * what's in it. Its corner is the group's translation, so moving it is
 * moving a group (its layers go with it), and Canvas Size, Crop and the
 * rest move it as they move everything. The document's canvas is the
 * pasteboard round the artboards, and grows to keep them on it.
 *
 * On its way to the renderer an artboard becomes an isolated group with
 * its background (a rectangle) at the bottom and, when it clips, a vector
 * mask of its rectangle (doc/expand.ts), so nothing below the document
 * model knows about artboards. Exporting one is the document cropped to it
 * with only that artboard in it (`artboardDoc`).
 *
 * Pure, so the checks run it in Node.
 */
export { readArtboard } from './artboardRead'
import { MAX_SIDE, type Artboard, type ColourMode, type Doc, type DocNode, type NodeId } from './types'
import type { ParamColour } from './params'
import { crop, insertNode, resizeCanvas, transformNode } from './edit'
import { makeNode } from './nodes'

/** Room left round the artboards on the canvas, in pixels. */
export const PASTEBOARD = 200
/** The gap a new artboard leaves after the last one. */
export const ARTBOARD_GAP = 100

export type ArtboardNode = DocNode & { kind: 'group'; props: { knockout: 'none' | 'shallow' | 'deep'; artboard: Artboard } }

/** Whether a node is an artboard. */
export const isArtboard = (n: DocNode | undefined | null): n is ArtboardNode => !!n && n.kind === 'group' && !!n.props.artboard

/** An artboard's rectangle in document pixels: left, top, right, bottom. */
export function artboardRect(n: ArtboardNode): [number, number, number, number] {
  const x = n.transform[4]
  const y = n.transform[5]
  return [x, y, x + n.props.artboard.width, y + n.props.artboard.height]
}

/** The document's artboards, top first as the Layers panel lists them. */
export function artboardsOf(doc: Doc): ArtboardNode[] {
  const kids = doc.nodes[doc.root]?.children ?? []
  return [...kids].reverse().flatMap((id) => (isArtboard(doc.nodes[id]) ? [doc.nodes[id] as ArtboardNode] : []))
}

export const hasArtboards = (doc: Doc) => (doc.nodes[doc.root]?.children ?? []).some((id) => isArtboard(doc.nodes[id]))

/** The artboard a document point is on, the topmost first; null off them all. */
export function artboardAt(doc: Doc, x: number, y: number): ArtboardNode | null {
  for (const a of artboardsOf(doc)) {
    const [x0, y0, x1, y1] = artboardRect(a)
    if (x >= x0 && x < x1 && y >= y0 && y < y1) return a
  }
  return null
}

/** The artboard a node is in, if any: its top-level ancestor, when that's an artboard. */
export function artboardOf(doc: Doc, id: NodeId): ArtboardNode | null {
  const parents = new Map<NodeId, NodeId>()
  for (const n of Object.values(doc.nodes)) for (const c of n.children ?? []) parents.set(c, n.id)
  let at = id
  while (parents.has(at) && parents.get(at) !== doc.root) at = parents.get(at)!
  return parents.get(at) === doc.root && isArtboard(doc.nodes[at]) ? (doc.nodes[at] as ArtboardNode) : null
}

/** White in a document's mode, the background a new artboard has. */
export const whiteIn = (mode: ColourMode): ParamColour => (mode === 'cmyk' ? [0, 0, 0, 0] : mode === 'gray' ? [1] : [1, 1, 1])


/** A new artboard node, empty, its corner at (x, y). */
export function makeArtboard(id: NodeId, name: string, x: number, y: number, width: number, height: number, mode: ColourMode): ArtboardNode {
  const n = makeNode('group', id, name, { knockout: 'none', artboard: { width: Math.round(width), height: Math.round(height), background: whiteIn(mode), clip: true } })
  n.transform = [1, 0, 0, 1, Math.round(x), Math.round(y)]
  // An artboard's layers land on its background, not the layers below: it's isolated.
  n.blend = 'normal'
  return n as ArtboardNode
}

/** A name for a new artboard: "Artboard 2" and so on, the first number free. */
export function nextArtboardName(doc: Doc): string {
  const used = new Set(artboardsOf(doc).map((a) => a.name))
  let i = artboardsOf(doc).length + 1
  while (used.has(`Artboard ${i}`)) i++
  return `Artboard ${i}`
}

/** Where a new artboard of this size goes: to the right of the others, level with the first. */
export function nextArtboardPlace(doc: Doc): [number, number] {
  const all = artboardsOf(doc)
  if (!all.length) return [PASTEBOARD, PASTEBOARD]
  const rects = all.map(artboardRect)
  const right = Math.max(...rects.map((r) => r[2]))
  const top = Math.min(...rects.map((r) => r[1]))
  return [right + ARTBOARD_GAP, top]
}

/**
 * The canvas grown (never shrunk) to hold every artboard with room round
 * it. One past the canvas's left or top edge moves everything right or
 * down, as Canvas Size does, so no artboard ever sits off the canvas.
 */
export function fitCanvasToArtboards(doc: Doc): Doc {
  return fitCanvas(doc).doc
}

/** As fitCanvasToArtboards, saying how far everything moved (right and down), so a view can follow. */
export function fitCanvas(doc: Doc): { doc: Doc; dx: number; dy: number } {
  const all = artboardsOf(doc)
  if (!all.length) return { doc, dx: 0, dy: 0 }
  const rects = all.map(artboardRect)
  const minX = Math.min(...rects.map((r) => r[0]))
  const minY = Math.min(...rects.map((r) => r[1]))
  const maxX = Math.max(...rects.map((r) => r[2]))
  const maxY = Math.max(...rects.map((r) => r[3]))
  // Room needed on each side.
  const left = Math.max(0, Math.ceil(PASTEBOARD - minX))
  const top = Math.max(0, Math.ceil(PASTEBOARD - minY))
  const width = Math.min(MAX_SIDE, Math.max(doc.width + left, Math.ceil(maxX + left + PASTEBOARD)))
  const height = Math.min(MAX_SIDE, Math.max(doc.height + top, Math.ceil(maxY + top + PASTEBOARD)))
  if (width === doc.width && height === doc.height) return { doc, dx: 0, dy: 0 }
  // resizeCanvas moves things by (growth × anchor): the anchor that moves them by exactly left, top.
  const gx = width - doc.width
  const gy = height - doc.height
  return { doc: resizeCanvas(doc, width, height, { x: gx ? left / gx : 0, y: gy ? top / gy : 0 }), dx: gx ? left : 0, dy: gy ? top : 0 }
}

/** A new artboard in the document, on top. (The canvas is grown round it by fitCanvasToArtboards.) */
export function addArtboard(doc: Doc, node: ArtboardNode): Doc {
  const kids = doc.nodes[doc.root]?.children ?? []
  return insertNode(doc, node, doc.root, kids.length)
}

/**
 * An artboard moved and resized to `rect`. Moving carries its layers;
 * resizing leaves them where they are, as in Photoshop. (The canvas is grown
 * round it by fitCanvasToArtboards.)
 */
export function setArtboardRect(doc: Doc, id: NodeId, rect: [number, number, number, number], carry = true): Doc {
  const n = doc.nodes[id]
  if (!isArtboard(n)) return doc
  const [x0, y0, x1, y1] = rect.map(Math.round) as [number, number, number, number]
  const w = Math.max(1, x1 - x0)
  const h = Math.max(1, y1 - y0)
  const [ox, oy] = [n.transform[4], n.transform[5]]
  let out = doc
  if (carry && (x0 !== ox || y0 !== oy) && w === n.props.artboard.width && h === n.props.artboard.height) out = transformNode(out, id, [1, 0, 0, 1, x0 - ox, y0 - oy])
  else {
    const now = out.nodes[id] as ArtboardNode
    out = { ...out, nodes: { ...out.nodes, [id]: { ...now, transform: [1, 0, 0, 1, x0, y0], props: { ...now.props, artboard: { ...now.props.artboard, width: w, height: h } } } as DocNode } }
  }
  return out
}

/** An artboard's settings changed: its background, whether it clips. */
export function setArtboard(doc: Doc, id: NodeId, patch: Partial<Artboard>): Doc {
  const n = doc.nodes[id]
  if (!isArtboard(n)) return doc
  if (patch.width !== undefined || patch.height !== undefined) {
    const [x0, y0] = artboardRect(n)
    return setArtboardRect(doc, id, [x0, y0, x0 + (patch.width ?? n.props.artboard.width), y0 + (patch.height ?? n.props.artboard.height)], false)
  }
  return { ...doc, nodes: { ...doc.nodes, [id]: { ...n, props: { ...n.props, artboard: { ...n.props.artboard, ...patch } } } as DocNode } }
}

/**
 * The document cropped to one artboard with only that artboard in it, the
 * canvas its size: what exporting the artboard writes, through every
 * exporter as it is.
 */
export function artboardDoc(doc: Doc, id: NodeId): Doc | null {
  const n = doc.nodes[id]
  if (!isArtboard(n)) return null
  const [x0, y0, x1, y1] = artboardRect(n)
  const cropped = crop(doc, { x: x0, y: y0, width: x1 - x0, height: y1 - y0, angle: 0 })
  const root = cropped.nodes[cropped.root]
  return { ...cropped, name: `${doc.name} - ${n.name}`, guides: [], channels: [], nodes: { ...cropped.nodes, [cropped.root]: { ...root, children: [id] } } }
}

/**
 * The canvas outside the artboards, as rectangles (each four corners), to
 * shade as the pasteboard: the canvas cut into bands at every artboard's
 * top and bottom, and each band's stretches between artboards.
 */
export function pasteboardQuads(doc: Doc): [number, number][] {
  const rects = artboardsOf(doc).map(artboardRect)
  if (!rects.length) return []
  const ys = [...new Set([0, doc.height, ...rects.flatMap((r) => [r[1], r[3]])].map((v) => Math.min(doc.height, Math.max(0, v))))].sort((a, b) => a - b)
  const out: [number, number][] = []
  for (let i = 0; i + 1 < ys.length; i++) {
    const [a, b] = [ys[i], ys[i + 1]]
    if (b <= a) continue
    const mid = (a + b) / 2
    // The artboards across this band, left to right, merged where they meet.
    const spans = rects
      .filter((r) => r[1] <= mid && r[3] >= mid)
      .map((r) => [Math.max(0, r[0]), Math.min(doc.width, r[2])] as [number, number])
      .sort((p, q) => p[0] - q[0])
    let x = 0
    for (const [s, e] of spans) {
      if (s > x) out.push([x, a], [s, a], [s, b], [x, b])
      x = Math.max(x, e)
    }
    if (x < doc.width) out.push([x, a], [doc.width, a], [doc.width, b], [x, b])
  }
  return out
}

/** Sizes for a new artboard, as Photoshop's and Illustrator's lists have them. */
export const ARTBOARD_PRESETS: { id: string; name: string; group: string; width: number; height: number }[] = [
  { id: 'iphone', name: 'iPhone 15', group: 'Phone', width: 393, height: 852 },
  { id: 'iphone-max', name: 'iPhone 15 Pro Max', group: 'Phone', width: 430, height: 932 },
  { id: 'android', name: 'Android', group: 'Phone', width: 360, height: 800 },
  { id: 'ipad', name: 'iPad', group: 'Tablet', width: 820, height: 1180 },
  { id: 'desktop', name: 'Desktop', group: 'Web', width: 1440, height: 1024 },
  { id: 'web-hd', name: 'Web, 1920 × 1080', group: 'Web', width: 1920, height: 1080 },
  { id: 'ig-post', name: 'Instagram Post', group: 'Social', width: 1080, height: 1080 },
  { id: 'ig-portrait', name: 'Instagram Portrait', group: 'Social', width: 1080, height: 1350 },
  { id: 'ig-story', name: 'Story or Reel', group: 'Social', width: 1080, height: 1920 },
  { id: 'yt-thumb', name: 'YouTube Thumbnail', group: 'Social', width: 1280, height: 720 },
  { id: 'a4', name: 'A4 at 72 ppi', group: 'Print', width: 595, height: 842 },
  { id: 'letter', name: 'US Letter at 72 ppi', group: 'Print', width: 612, height: 792 },
]

/** Whether `parent` may hold an artboard: only the document's top level. */
export const artboardMayGo = (doc: Doc, parent: NodeId) => parent === doc.root
