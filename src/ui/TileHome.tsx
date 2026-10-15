/**
 * In Tiled View, a way back to the document itself once it's mostly off
 * screen: the copies round it look the same, so it's easy to lose. The
 * document is framed on the canvas too (app/overlay.ts). The button centres
 * it again at the zoom in use; Fit on Screen frames it whole.
 */
import { useSyncExternalStore } from 'react'
import { documents } from '../app/documents'
import { guidePrefs } from '../app/guidePrefs'
import { views } from '../app/views'
import { engine } from '../engine/EngineHost'
import { tileWraps } from '../doc/types'
import { apply, viewMatrix } from '../render/view'
import { Icon } from './Icon'

/** How much of the document, 0..1, the view shows, roughly (by its corners' box on screen). */
function shownShare(w: number, h: number): number {
  const v = views().front()
  if (!v) return 1
  const c = engine().canvasSize()
  const m = viewMatrix(v, c)
  const pts = [apply(m, 0, 0), apply(m, w, 0), apply(m, w, h), apply(m, 0, h)]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const area = (x1 - x0) * (y1 - y0)
  if (area <= 0) return 1
  const ix = Math.max(0, Math.min(x1, c.width) - Math.max(x0, 0))
  const iy = Math.max(0, Math.min(y1, c.height) - Math.max(y0, 0))
  return (ix * iy) / area
}

export function TileHome() {
  useSyncExternalStore(views().subscribe, views().front)
  const prefs = useSyncExternalStore(guidePrefs().subscribe, guidePrefs().get)
  const d = useSyncExternalStore(documents().subscribe, () => documents().active())
  const doc = d?.history.present
  if (!doc || !prefs.tiledView) return null
  const w = tileWraps(doc.tiled)
  if (!w.x && !w.y) return null
  if (shownShare(doc.width, doc.height) > 0.35) return null
  return (
    <button type="button" className="tile-home" data-tile-home="" data-tip="The copies round a tiled document look the same: this centres the document itself again. Ctrl+0 fits it on screen." onClick={() => views().centreOn(doc.width / 2, doc.height / 2)}>
      <Icon name="ui.home" />
      Back to the document
    </button>
  )
}
