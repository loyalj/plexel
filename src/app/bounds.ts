/**
 * A layer's box on the canvas: the rectangle, in document pixels, round
 * what it shows. Snapping lines up with these, Align and Distribute move
 * them, and New Guides from Shape puts guides on one.
 *
 * Shapes are measured by their paths (Illustrator's geometric bounds, the
 * stroke left out), text by its glyphs or its frame, pixel layers by their
 * pixels that aren't clear, smart objects by their canvas, groups by what's
 * in them. Fill layers have no edge and adjustments nothing to measure.
 *
 * Measuring pixels asks the engine, so this is async. A layer's box is kept
 * with its node object, which every edit to it replaces.
 */
import type { Affine, Doc, DocNode, NodeId } from '../doc/types'
import { geometryPath } from '../doc/vector'
import { engine } from '../engine/EngineHost'
import { pathBounds } from '../geom/path'
import { boxOf, unionBox, type Box } from '../geom/snap'
import { docPathOf } from '../vector/shape'
import { layoutOf } from './text'
import { expandDoc } from '../doc/expand'
import { artboardRect, isArtboard } from '../doc/artboards'

const kept = new WeakMap<DocNode, Promise<Box | null>>()

const corners = (t: Affine, b: Box): Box | null =>
  boxOf(
    [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[0], b[3]],
      [b[2], b[3]],
    ].map(([x, y]) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]] as const),
  )

async function measure(doc: Doc, n: DocNode): Promise<Box | null> {
  switch (n.kind) {
    case 'pixel': {
      if (!n.props.tiles) return null
      const b = await engine().call('tiles.alphaBounds', { set: n.props.tiles })
      return b ? corners(n.transform, b) : null
    }
    case 'embedded':
      return n.props.content ? corners(n.transform, [0, 0, n.props.content.width, n.props.content.height]) : null
    case 'vector':
      return n.props.geometry ? pathBounds(geometryPath(n.props.geometry), n.transform) : null
    case 'boolean': {
      const path = docPathOf((id) => doc.nodes[id], n)
      return path ? pathBounds(path) : null
    }
    case 'text': {
      if (n.props.mode === 'area' && n.props.frame) return pathBounds(geometryPath(n.props.frame), n.transform)
      const b = layoutOf(n, doc)?.bounds
      return b ? corners(n.transform, b) : null
    }
    default:
      return null
  }
}

/** A layer's box in document pixels, or null when it has none (empty, endless, or not a layer that shows anything). */
export async function layerBox(doc: Doc, id: NodeId): Promise<Box | null> {
  const n = doc.nodes[id]
  if (!n) return null
  // An artboard is its rectangle; an instance, the box round its symbol's layers where it puts them.
  if (isArtboard(n)) return artboardRect(n)
  if (n.kind === 'symbol') return layerBox(expandDoc(doc), id)
  if (n.kind === 'group') {
    const kids = await Promise.all((n.children ?? []).filter((c) => doc.nodes[c]?.visible).map((c) => layerBox(doc, c)))
    return unionBox(kids)
  }
  let p = kept.get(n)
  if (!p) {
    p = measure(doc, n).catch(() => null)
    // Text has no layout until its fonts load, so its box isn't kept until it has one.
    if (n.kind !== 'text' || layoutOf(n, doc)) kept.set(n, p)
  }
  return p
}

/** The box round several layers. */
export async function layersBox(doc: Doc, ids: NodeId[]): Promise<Box | null> {
  return unionBox(await Promise.all(ids.map((id) => layerBox(doc, id))))
}
