/**
 * Zoom to Selection and Zoom to Layer (View, and a double-click on a
 * layer's thumbnail): the view framed on a box of the document, as
 * Affinity's and Illustrator's do.
 */
import { engine } from '../engine/EngineHost'
import { documents, selectedIds } from './documents'
import { layersBox } from './bounds'
import { views } from './views'
import { notify } from './notices'

export async function zoomToSelection() {
  const d = documents().active()
  const sel = d?.history.present.selection?.tiles
  if (!d || !sel) return
  const b = await engine().call('select.bounds', { set: sel })
  if (b) views().fitBox(b)
}

/** The selected layers framed, or the one given. */
export async function zoomToLayer(id?: string) {
  const d = documents().active()
  if (!d) return
  const ids = id ? [id] : selectedIds(d)
  if (!ids.length) return
  const b = await layersBox(d.history.present, ids)
  if (b) views().fitBox(b)
  else notify('info', 'There’s nothing in that layer to zoom to.')
}
