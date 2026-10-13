/**
 * Layer → Align and Distribute, and the Move tool's buttons for them:
 * the selected layers measured (app/bounds.ts), the moves worked out
 * (geom/align.ts) and made as one step.
 *
 * What they line up with is the Align To setting (app/guidePrefs.ts):
 * the selected layers' box, the key layer (the one selected last, which
 * stays put, as Illustrator's key object does), the canvas, or the
 * selection. With one layer selected, Selected Layers means the canvas,
 * as in Affinity. Distributing spreads three or more layers between the
 * outermost; to the canvas or the selection, two or more across it.
 *
 * Moves keep layers with pixels in them on whole pixels, so they stay
 * sharp; shapes and text move exactly.
 */
import { boxGuides, addGuides } from '../doc/guides'
import type { NodeId } from '../doc/types'
import { engine } from '../engine/EngineHost'
import { alignDeltas, distributeDeltas, type AlignOp, type DistributeOp } from '../geom/align'
import { unionBox, type Box } from '../geom/snap'
import { layerBox, layersBox } from './bounds'
import { movable } from './canvasTools'
import { documents, type OpenDoc } from './documents'
import { guidePrefs, type AlignTo } from './guidePrefs'
import { notify } from './notices'
import { moveBy } from '../doc/edit'

/** How many layers the next Align or Distribute would move. */
export function alignCount(d: OpenDoc | null): number {
  return d ? movable(d, true).length : 0
}

/** Why Align can't run now, or null. */
export function alignWhy(d: OpenDoc | null, to: AlignTo = guidePrefs().get().alignTo): string | null {
  if (!d) return 'Open a document first'
  const n = alignCount(d)
  if (!n) return 'Select a layer that can move'
  if (to === 'key' && n < 2) return 'Align to the key layer needs two or more layers selected'
  if (to === 'selection' && !d.history.present.selection) return 'Make a selection to align to'
  return null
}

/** Why Distribute can't run now, or null. */
export function distributeWhy(d: OpenDoc | null, to: AlignTo = guidePrefs().get().alignTo): string | null {
  const why = alignWhy(d, to === 'key' ? 'layers' : to)
  if (why) return why
  const n = alignCount(d)
  const across = to === 'canvas' || to === 'selection'
  if (n < (across ? 2 : 3)) return across ? 'Distribute needs two or more layers selected' : 'Distribute needs three or more layers selected'
  return null
}

/** The selected layers that move, each with its box (those with none are left where they are). */
async function measured(d: OpenDoc): Promise<{ id: NodeId; box: Box }[]> {
  const doc = d.history.present
  const ids = movable(d)
  const boxes = await Promise.all(ids.map((id) => layerBox(doc, id)))
  return ids.flatMap((id, i) => (boxes[i] ? [{ id, box: boxes[i]! }] : []))
}

async function selectionBox(d: OpenDoc): Promise<Box | null> {
  const sel = d.history.present.selection?.tiles
  return sel ? await engine().call('select.bounds', { set: sel }) : null
}

/** The moves made, as one step; layers with pixels are kept on whole pixels. */
function commitMoves(d: OpenDoc, moves: { id: NodeId; d: [number, number] }[], label: string) {
  const doc = d.history.present
  const whole = (id: NodeId) => ['pixel', 'embedded', 'group'].includes(doc.nodes[id]?.kind ?? '')
  const out = moves.map((m) => ({ id: m.id, dx: whole(m.id) ? Math.round(m.d[0]) : m.d[0], dy: whole(m.id) ? Math.round(m.d[1]) : m.d[1] })).filter((m) => Math.abs(m.dx) > 1e-9 || Math.abs(m.dy) > 1e-9)
  if (!out.length) return notify('info', 'Already lined up: nothing moved.')
  documents().commit((x) => out.reduce((y, m) => moveBy(y, m.id, m.dx, m.dy), x), { key: d.key, label })
}

const ALIGN_LABEL: Record<AlignOp, string> = { left: 'Align Left Edges', hcentre: 'Align Horizontal Centres', right: 'Align Right Edges', top: 'Align Top Edges', vcentre: 'Align Vertical Centres', bottom: 'Align Bottom Edges' }
const DISTRIBUTE_LABEL: Record<DistributeOp, string> = {
  left: 'Distribute Left Edges',
  hcentre: 'Distribute Horizontal Centres',
  right: 'Distribute Right Edges',
  top: 'Distribute Top Edges',
  vcentre: 'Distribute Vertical Centres',
  bottom: 'Distribute Bottom Edges',
  hspace: 'Distribute Horizontal Spacing',
  vspace: 'Distribute Vertical Spacing',
}

export async function alignLayers(op: AlignOp) {
  const d = documents().active()
  const to = guidePrefs().get().alignTo
  const why = alignWhy(d, to)
  if (!d || why) return why && notify('info', `${why}.`)
  const items = await measured(d)
  if (!items.length) return notify('info', 'The selected layers have nothing in them to line up.')
  const doc = d.history.present
  const canvas: Box = [0, 0, doc.width, doc.height]
  let ref: Box | null
  let moving = items
  if (to === 'key') {
    ref = d.selected ? await layerBox(doc, d.selected) : null
    moving = items.filter((it) => it.id !== d.selected)
  } else if (to === 'selection') ref = await selectionBox(d)
  else if (to === 'canvas' || items.length < 2) ref = canvas
  else ref = unionBox(items.map((it) => it.box))
  if (!ref) return notify('info', 'There’s nothing to line up with.')
  const deltas = alignDeltas(
    moving.map((it) => it.box),
    op,
    ref,
  )
  commitMoves(
    d,
    moving.map((it, i) => ({ id: it.id, d: deltas[i] })),
    ALIGN_LABEL[op],
  )
}

export async function distributeLayers(op: DistributeOp) {
  const d = documents().active()
  const to = guidePrefs().get().alignTo
  const why = distributeWhy(d, to)
  if (!d || why) return why && notify('info', `${why}.`)
  const items = await measured(d)
  const doc = d.history.present
  const range = to === 'canvas' ? ([0, 0, doc.width, doc.height] as Box) : to === 'selection' ? await selectionBox(d) : null
  const deltas = distributeDeltas(
    items.map((it) => it.box),
    op,
    range,
  )
  commitMoves(
    d,
    items.map((it, i) => ({ id: it.id, d: deltas[i] })),
    DISTRIBUTE_LABEL[op],
  )
}

/** View → New Guides from Shape: guides on the selected layers' box, its edges and centre. */
export async function guidesFromShape() {
  const d = documents().active()
  if (!d?.selected) return
  const b = await layersBox(d.history.present, [d.selected, ...d.others])
  if (!b) return notify('info', 'The selected layer has nothing in it to put guides on.')
  documents().commit((x) => addGuides(x, boxGuides(b)), { key: d.key, label: 'New Guides from Shape' })
}
