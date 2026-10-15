/**
 * Whether a dialog previewing on the canvas is open (a filter, an
 * adjustment, Layer Style, Offset Path): no backdrop dims the picture, and
 * the canvas only moves the view while it's open, so a stroke can't land
 * on the layer being previewed. A drag on the canvas pans, as a drag in
 * Photoshop's filter previews does; the wheel zooms as ever. The panels,
 * bars and menus take no presses meanwhile (`data-previewing` on <html>),
 * as the backdrop kept them from before.
 */
import { Listeners } from '../lib/listeners'

let open = 0
const changes = new Listeners()
const mark = () => {
  if (open > 0) document.documentElement.dataset.previewing = ''
  else delete document.documentElement.dataset.previewing
}

export const previewing = {
  get: () => open > 0,
  subscribe: (l: () => void) => changes.subscribe(l),
  /** Counts a previewing dialog in; the function returned counts it out. */
  begin() {
    open++
    mark()
    changes.emit()
    let done = false
    return () => {
      if (done) return
      done = true
      open--
      mark()
      changes.emit()
    }
  },
}
