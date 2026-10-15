/**
 * Artboards on the page: making them (Layer → New Artboard, Artboard from
 * Layers), letting their layers go (Release Artboard), and exporting them
 * each to a file of its own. The model is doc/artboards.ts.
 */
import { addArtboard, artboardDoc, artboardOf, artboardsOf, fitCanvas, isArtboard, makeArtboard, nextArtboardName, nextArtboardPlace } from '../doc/artboards'
import { moveNode, transformNode } from '../doc/edit'
import { placeOf } from '../doc/tree'
import type { Doc, NodeId } from '../doc/types'
import { layersBox } from './bounds'
import { documents, newId, selectedIds, type OpenDoc } from './documents'
import { notify } from './notices'
import { views } from './views'

/**
 * Commits a change to artboards with the canvas grown round them: when it
 * grows to the left or the top, everything moves right or down, and the
 * view goes with it, so nothing seems to jump.
 */
export function commitArtboards(d: OpenDoc, fn: (doc: Doc) => Doc, label: string) {
  let shift: [number, number] = [0, 0]
  store().commit(
    (x) => {
      const r = fitCanvas(fn(x))
      shift = [r.dx, r.dy]
      return r.doc
    },
    { key: d.key, label },
  )
  if (shift[0] || shift[1]) {
    const v = views().get(d.key)
    if (v) views().set(d.key, { ...v, cx: v.cx + shift[0], cy: v.cy + shift[1] })
  }
}

const store = () => documents()

/**
 * Layer → New Artboard. The first in a document turns its canvas into
 * Artboard 1, every layer in it, the canvas growing round it as the
 * pasteboard; each after is a new empty artboard, the size of the last,
 * to the right of the others (or of `size`).
 */
export function newArtboard(size?: { width: number; height: number; name?: string }): NodeId | null {
  const d = store().active()
  if (!d) return null
  const doc = d.history.present
  const id = newId('ab')
  const all = artboardsOf(doc)
  if (!all.length && !size) commitArtboards(d, (x) => canvasToArtboard(x, id), 'New Artboard')
  else {
    const last = all[0]
    const w = size?.width ?? (last ? last.props.artboard.width : doc.width)
    const h = size?.height ?? (last ? last.props.artboard.height : doc.height)
    const [x, y] = all.length ? nextArtboardPlace(doc) : [doc.width + 100, 0]
    commitArtboards(d, (x2) => addArtboard(x2, makeArtboard(id, size?.name ?? nextArtboardName(x2), x, y, w, h, x2.mode)), 'New Artboard')
  }
  store().select(id, d.key)
  return id
}

/** The canvas as Artboard 1: every top-level layer in it, its size the canvas's. */
export function canvasToArtboard(doc: Doc, id: NodeId): Doc {
  const kids = [...(doc.nodes[doc.root].children ?? [])]
  let out = addArtboard(doc, makeArtboard(id, nextArtboardName(doc), 0, 0, doc.width, doc.height, doc.mode))
  // Its layers go into it, in order.
  for (const k of kids) out = moveNode(out, k, id, out.nodes[id].children?.length ?? 0)
  return out
}

/** Layer → Artboard from Layers: the selected layers in a new artboard the size of the box round them. */
export async function artboardFromLayers(): Promise<void> {
  const d = store().active()
  if (!d) return
  const doc = d.history.present
  const ids = topLevelPicks(doc, selectedIds(d)).filter((id) => !isArtboard(doc.nodes[id]))
  if (!ids.length) {
    notify('info', 'Select the layers to put on the artboard first.')
    return
  }
  const box = await layersBox(doc, ids)
  if (!box) {
    notify('info', 'Those layers have nothing in them to size an artboard by.')
    return
  }
  const id = newId('ab')
  commitArtboards(
    d,
    (x) => {
      const [x0, y0, x1, y1] = [Math.floor(box[0]), Math.floor(box[1]), Math.ceil(box[2]), Math.ceil(box[3])]
      let out = addArtboard(x, makeArtboard(id, nextArtboardName(x), x0, y0, x1 - x0, y1 - y0, x.mode))
      // Bottom first, so they keep their order in it.
      const order = (n: NodeId) => (placeOf(out, n)?.index ?? 0)
      for (const k of [...ids].sort((a, b) => order(a) - order(b))) out = moveNode(out, k, id, out.nodes[id].children?.length ?? 0)
      return out
    },
    'Artboard from Layers',
  )
  store().select(id, d.key)
}

/** Layer → Release Artboard: its layers out at the top level where it was, and the artboard gone. */
export function releaseArtboard() {
  const d = store().active()
  const doc = d?.history.present
  const ab = d && doc && d.selected ? (isArtboard(doc.nodes[d.selected]) ? doc.nodes[d.selected] : artboardOf(doc, d.selected)) : null
  if (!d || !doc || !ab) return
  store().commit(
    (x) => {
      const at = placeOf(x, ab.id)?.index ?? 0
      let out = x
      const kids = [...(x.nodes[ab.id].children ?? [])]
      kids.forEach((k, i) => (out = moveNode(out, k, x.root, at + i)))
      const nodes = { ...out.nodes }
      const root = nodes[out.root]
      nodes[out.root] = { ...root, children: root.children!.filter((c) => c !== ab.id) }
      delete nodes[ab.id]
      return { ...out, nodes }
    },
    { key: d.key, label: 'Release Artboard' },
  )
}

/** The selected layers with none inside another selected one. */
function topLevelPicks(doc: Doc, ids: NodeId[]): NodeId[] {
  const set = new Set(ids)
  return ids.filter((id) => {
    let p = placeOf(doc, id)
    while (p) {
      if (set.has(p.parent)) return false
      p = placeOf(doc, p.parent)
    }
    return true
  })
}

/** An artboard moved by (dx, dy), its layers with it. */
export function moveArtboardBy(doc: Doc, id: NodeId, dx: number, dy: number): Doc {
  return transformNode(doc, id, [1, 0, 0, 1, Math.round(dx), Math.round(dy)])
}

/** The documents to export for each artboard (or the one given), named after it. */
export function artboardDocs(d: OpenDoc, only?: NodeId): { id: NodeId; name: string; doc: Doc }[] {
  const doc = d.history.present
  const list = only ? artboardsOf(doc).filter((a) => a.id === only) : [...artboardsOf(doc)].reverse()
  return list.flatMap((a) => {
    const one = artboardDoc(doc, a.id)
    return one ? [{ id: a.id, name: a.name, doc: one }] : []
  })
}

/** The artboard the selection is in (or is), for exporting it alone. */
export function selectedArtboard(d: OpenDoc): NodeId | null {
  const doc = d.history.present
  if (!d.selected) return null
  if (isArtboard(doc.nodes[d.selected])) return d.selected
  return artboardOf(doc, d.selected)?.id ?? null
}

