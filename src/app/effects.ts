/**
 * Adjustments, filters, layer styles and smart objects, from the page's
 * side: what the Layer and Filter menus, the Layer Style dialog and the
 * Properties panel do with them, each committed as one named step.
 *
 * Previews (a filter's or a layer style's settings while its dialog is
 * open) are documents sent straight to the engine, not steps; the dialog
 * commits once, or puts the document back.
 */
import { ADJUSTMENT_BY_ID } from '../adjust/defs'
import { addAdjustment, addEffect, convertToSmartObject, insertNode, removeNode, setFx, setParams, setSmartContent, setTiles, updateNode } from '../doc/edit'
import { defaultParams } from '../doc/params'
import { makeNode } from '../doc/nodes'
import { freshName, placeOf } from '../doc/tree'
import type { Doc, DocNode, LayerFx, NodeId } from '../doc/types'
import { engine } from '../engine/EngineHost'
import { FILTER_BY_ID } from '../filters/defs'
import { channelTarget, planesTarget } from './channels'
import { documents, newId, type OpenDoc } from './documents'
import { notify } from './notices'
import { hold } from './pixels'
import { isCancelled, runJob } from './jobs'
import { whereNew } from '../doc/tree'

const store = () => documents()
const active = () => store().active()

/** Where a new layer goes: above the selected one, in its group; otherwise at the top. */
export function placeForNew(d: OpenDoc): { parent: NodeId; index: number } {
  return whereNew(d.history.present, d.selected)
}

/** Layer → New Adjustment Layer → (one of ADJUSTMENT_DEFS): above the selected layer, chosen. */
export function newAdjustmentLayer(id: string) {
  const d = active()
  const def = ADJUSTMENT_BY_ID.get(id)
  if (!d || !def) return
  const doc = d.history.present
  const { parent, index } = placeForNew(d)
  const nid = newId('n')
  store().commit((x) => addAdjustment(x, nid, freshName(x, def.label), id, defaultParams(def.params, doc.mode), parent, index), { key: d.key, label: `New ${def.label} Layer` })
  store().select(nid, d.key)
}

/** Layer → New Filter Layer → (one of FILTER_DEFS): above the selected layer, filtering everything below it, chosen. */
export function newFilterLayer(id: string) {
  const d = active()
  const def = FILTER_BY_ID.get(id)
  if (!d || !def) return
  const doc = d.history.present
  const { parent, index } = placeForNew(d)
  const nid = newId('f')
  const node = makeNode('filter', nid, freshName(doc, def.label), { filter: id, params: defaultParams(def.params, doc.mode) })
  store().commit((x) => insertNode(x, node, parent, index), { key: d.key, label: `New ${def.label} Layer` })
  store().select(nid, d.key)
}

/** An adjustment's or a filter's settings changed in Properties; a drag of one control is one step. */
export function setNodeParams(id: NodeId, params: Record<string, unknown>, coalesce?: string) {
  const d = active()
  if (d) store().commit((x) => setParams(x, id, params), { key: d.key, coalesce })
}

/** Shows or hides an effect (a live filter, or an adjustment on one layer). */
export function toggleEffect(id: NodeId) {
  const d = active()
  const n = d?.history.present.nodes[id]
  if (!d || !n) return
  store().commit((x) => updateNode(x, id, (m) => ({ ...m, visible: !m.visible }) as DocNode), { key: d.key, label: n.visible ? `Hide “${n.name}”` : `Show “${n.name}”` })
}

/** The pixel layer filters go to: the selected one, or the layer an effect selected belongs to. */
export function filterTarget(d: OpenDoc): DocNode | null {
  if (!d.selected) return null
  const doc = d.history.present
  let n = doc.nodes[d.selected]
  const place = placeOf(doc, d.selected)
  if (n && place?.slot === 'effects') n = doc.nodes[place.parent]
  return n ?? null
}

/**
 * The frame a framed filter (Twirl, Pinch, Spherize, ZigZag, Polar
 * Coordinates, Displace) is kept on: the unit square to the box of the
 * layer's content, in the layer's own coordinates. Null when it has none.
 */
export async function frameFor(doc: Doc, node: DocNode): Promise<number[] | null> {
  const { transformBox } = await import('./canvasTools')
  const fb = await transformBox(doc, node)
  if (!fb) return null
  let [x0, y0, x1, y1] = fb.box
  // A compound's box comes in the document's coordinates; its own are through its transform.
  if (node.kind === 'boolean') {
    const t = node.transform
    const d = t[0] * t[3] - t[1] * t[2] || 1e-12
    const inv = [t[3] / d, -t[1] / d, -t[2] / d, t[0] / d, (t[2] * t[5] - t[3] * t[4]) / d, (t[1] * t[4] - t[0] * t[5]) / d]
    const pts = [
      [x0, y0],
      [x1, y0],
      [x0, y1],
      [x1, y1],
    ].map(([x, y]) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]])
    ;[x0, y0, x1, y1] = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]
  }
  return x1 > x0 && y1 > y0 ? [x1 - x0, 0, 0, y1 - y0, x0, y0] : null
}

/** A filter node for `id` with settings `params`, not yet in any document. */
export function filterNode(id: string, params: Record<string, unknown>): DocNode {
  const def = FILTER_BY_ID.get(id)!
  return makeNode('filter', newId('f'), def.label, { filter: id, params })
}

/** A document with `effect` added to a layer's effects: what the Filter dialog previews. */
export function withEffect(doc: Doc, node: NodeId, effect: DocNode): Doc {
  return addEffect(doc, node, effect)
}

/** Shows a document that isn't committed on the canvas (a dialog's preview), or puts the committed one back. */
export const previewDoc = (key: string, doc: Doc) => engine().setScene(key, doc)
export function endPreview(key: string) {
  const d = store().get(key)
  if (d) engine().setScene(key, d.history.present)
}

/**
 * The Filter dialog's OK: as a live filter in the layer's effects, which
 * stays editable, or (with a selection, or asked to) baked into its pixels,
 * through the selection.
 */
export async function applyFilter(id: string, params: Record<string, unknown>, live: boolean) {
  const d = active()
  const node = d ? filterTarget(d) : null
  const def = FILTER_BY_ID.get(id)
  if (!d || !node || !def) return
  if (node.locked.all || node.locked.pixels) return notify('info', `“${node.name}” is locked against painting. Unlock it in the Properties panel.`)
  const effect = filterNode(id, params)
  if (channelTarget(d)) return notify('info', `${def.label} works on a layer’s pixels; filters on an alpha or spot channel aren’t there yet. Pick a layer in the Layers panel.`)
  // On some colour channels it's applied for good: a live filter would change them all.
  const planes = planesTarget(d)
  if (live && !planes) {
    store().commit((x) => addEffect(x, node.id, effect), { key: d.key, label: def.label })
    return
  }
  if (node.kind !== 'pixel') return notify('info', 'A filter applied for good needs a pixel layer; on anything else, it’s added as a live filter.')
  try {
    let set = await runJob(def.label, (job) => engine().call('render.bake', { key: d.key, node: node.id, effects: [effect], selection: d.history.present.selection?.tiles ?? null, job }))
    // Only the colour channels targeted: the rest put back.
    if (planes) set = await engine().call('fill.keepPlanes', { before: node.props.tiles, after: set, planes })
    const release = set ? hold([set]) : () => {}
    store().commit((x) => setTiles(x, node.id, set), { key: d.key, label: def.label })
    release()
  } catch (e) {
    if (isCancelled(e)) return
    notify('error', `${def.label} didn’t work.`, [e instanceof Error ? e.message : String(e)])
  }
}

/**
 * Document → Adjustments → (one): the Adjustments dialog's OK. Live, it's
 * an adjustment in the layer's effects; otherwise it's baked into the
 * layer's pixels, through the selection, as Photoshop's Image →
 * Adjustments are.
 */
export async function applyAdjustment(id: string, params: Record<string, unknown>, live: boolean) {
  const d = active()
  const node = d ? filterTarget(d) : null
  const def = ADJUSTMENT_BY_ID.get(id)
  if (!d || !node || !def) return
  if (node.locked.all || node.locked.pixels) return notify('info', `“${node.name}” is locked against painting. Unlock it in the Properties panel.`)
  const effect = makeNode('adjustment', newId('a'), def.label, { adjustment: id, params })
  if (channelTarget(d)) return notify('info', `${def.label} works on a layer’s pixels; adjustments on an alpha or spot channel aren’t there yet. Pick a layer in the Layers panel.`)
  const planes = planesTarget(d)
  if (live && !planes) {
    store().commit((x) => addEffect(x, node.id, effect), { key: d.key, label: def.label })
    return
  }
  if (node.kind !== 'pixel') return notify('info', 'An adjustment applied for good needs a pixel layer; on anything else, it’s added live, in the layer’s effects.')
  try {
    let set = await runJob(def.label, (job) => engine().call('render.bake', { key: d.key, node: node.id, effects: [effect], selection: d.history.present.selection?.tiles ?? null, job }))
    // Only the colour channels targeted: the rest put back.
    if (planes) set = await engine().call('fill.keepPlanes', { before: node.props.tiles, after: set, planes })
    const release = set ? hold([set]) : () => {}
    store().commit((x) => setTiles(x, node.id, set), { key: d.key, label: def.label })
    release()
  } catch (e) {
    if (isCancelled(e)) return
    notify('error', `${def.label} didn’t work.`, [e instanceof Error ? e.message : String(e)])
  }
}

/** Filter → Apply Live Filters: the selected pixel layer's live filters baked into its pixels, and taken off. */
export async function applyLiveFilters() {
  const d = active()
  const node = d ? filterTarget(d) : null
  if (!d || !node || node.kind !== 'pixel' || !node.effects.length) return
  const doc = d.history.present
  const effects = node.effects.map((id) => doc.nodes[id]).filter((e): e is DocNode => !!e && e.visible)
  try {
    const set = await runJob('Apply Live Filters', (job) => engine().call('render.bake', { key: d.key, node: node.id, effects, selection: null, job }))
    const release = set ? hold([set]) : () => {}
    store().commit(
      (x) => {
        let y = setTiles(x, node.id, set)
        for (const id of node.effects) y = removeNode(y, id)
        return y
      },
      { key: d.key, label: 'Apply Live Filters' },
    )
    release()
    // An effect's row may have been the selection; the layer it was on is now.
    store().select(node.id, d.key)
  } catch (e) {
    if (isCancelled(e)) return
    notify('error', 'The live filters couldn’t be applied.', [e instanceof Error ? e.message : String(e)])
  }
}

/** The Layer Style dialog's OK. */
export function commitFx(id: NodeId, fx: LayerFx[]) {
  const d = active()
  if (d) store().commit((x) => setFx(x, id, fx), { key: d.key, label: 'Layer Style' })
}

export function clearFx() {
  const d = active()
  if (d?.selected) store().commit((x) => setFx(x, d.selected!, []), { key: d.key, label: 'Clear Layer Style' })
}

// --- smart objects ----------------------------------------------------------------------------

/** The document rectangle a node's pixels reach (through their transforms), or null. */
async function pixelBounds(doc: Doc, id: NodeId): Promise<[number, number, number, number] | null> {
  let r: [number, number, number, number] | null = null
  const visit = async (nid: NodeId) => {
    const n = doc.nodes[nid]
    if (!n) return
    let b: [number, number, number, number] | null = null
    if (n.kind === 'pixel' && n.props.tiles) b = await engine().call('tiles.alphaBounds', { set: n.props.tiles })
    if (n.kind === 'embedded' && n.props.content) b = [0, 0, n.props.content.width, n.props.content.height]
    if (b) {
      const t = n.transform
      for (const [x, y] of [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]]) {
        const px = t[0] * x + t[2] * y + t[4]
        const py = t[1] * x + t[3] * y + t[5]
        r = r ? [Math.min(r[0], px), Math.min(r[1], py), Math.max(r[2], px), Math.max(r[3], py)] : [px, py, px, py]
      }
    }
    for (const c of n.children ?? []) await visit(c)
  }
  await visit(id)
  return r
}

/** Layer → Smart Objects → Convert to Smart Object: the selected layer becomes one, its contents a document of its own. */
export async function toSmartObject() {
  const d = active()
  const id = d?.selected
  const doc = d?.history.present
  const node = id && doc ? doc.nodes[id] : null
  if (!d || !doc || !node || node.kind === 'adjustment') return
  const b = await pixelBounds(doc, node.id)
  const rect = b ? { x: Math.floor(b[0]), y: Math.floor(b[1]), width: Math.ceil(b[2]) - Math.floor(b[0]), height: Math.ceil(b[3]) - Math.floor(b[1]) } : { x: 0, y: 0, width: doc.width, height: doc.height }
  const smart = newId('s')
  store().commit((x) => convertToSmartObject(x, [node.id], smart, newId('r'), node.name, rect), { key: d.key, label: 'Convert to Smart Object' })
  store().select(smart, d.key)
}

/** Edit Contents: the smart object's contents open in a tab of their own; Save there puts them back. */
export function editContents() {
  const d = active()
  const n = d?.selected ? d.history.present.nodes[d.selected] : null
  if (!d || !n || n.kind !== 'embedded' || !n.props.content) return
  const open = store().getState().docs.find((x) => x.parent?.key === d.key && x.parent.node === n.id)
  if (open) return store().activate(open.key)
  store().add({ doc: { ...n.props.content, name: n.name }, file: null, saved: true, parent: { key: d.key, node: n.id }, label: 'Edit Contents' })
}

/** Save in a smart object's contents: back into the document holding it, as one step there. */
export function saveToParent(key: string): boolean {
  const d = store().get(key)
  const p = d?.parent ? store().get(d.parent.key) : null
  if (!d || !d.parent || !p || !p.history.present.nodes[d.parent.node]) {
    notify('warning', 'The document this smart object belongs to isn’t open any more, so its contents can’t go back into it. Save As keeps them as a document of their own.')
    return false
  }
  const content = d.history.present
  store().commit((x) => setSmartContent(x, d.parent!.node, content), { key: p.key, label: 'Edit Contents' })
  store().markSaved(key, content, d.file ?? { handleKey: null, name: content.name })
  notify('info', `“${content.name}” is updated in “${p.history.present.name}”.`)
  return true
}
