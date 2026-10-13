/**
 * Tiled documents on the page: which copy of the document a point is in.
 *
 * A tiled document (Document → Tiled) is a torus. In Tiled View its copies
 * show round it, and a press in any copy works on the document itself: the
 * point is moved by whole periods, the same for the whole drag. Where the
 * document doesn't repeat (an axis it isn't tiled on, or Tiled View off,
 * where there are no copies to press in) nothing moves.
 */
import { tileWraps, type Doc } from '../doc/types'
import { guidePrefs } from './guidePrefs'

/**
 * A point moved by whole periods to the copy nearest `ref`: the corners of
 * a lasso clicked over a seam stay one shape, rather than each landing back
 * on the canvas.
 */
export function nearestCopy(doc: Pick<Doc, 'tiled' | 'width' | 'height'> | null, p: [number, number], ref: [number, number]): [number, number] {
  if (!doc) return p
  const w = tileWraps(doc.tiled)
  const near = (v: number, r: number, size: number, on: boolean) => (on ? v - Math.round((v - r) / size) * size : v)
  return [near(p[0], ref[0], doc.width, w.x), near(p[1], ref[1], doc.height, w.y)]
}

/** The whole periods between the copy a document point is in and the document; none outside Tiled View. */
export function copyShift(doc: Pick<Doc, 'tiled' | 'width' | 'height'> | null, x: number, y: number, view = guidePrefs().get().tiledView): [number, number] {
  if (!doc || !view) return [0, 0]
  const w = tileWraps(doc.tiled)
  return [w.x ? Math.floor(x / doc.width) * doc.width : 0, w.y ? Math.floor(y / doc.height) * doc.height : 0]
}
