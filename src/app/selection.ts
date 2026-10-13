/**
 * Selections and masks, from the page's side: the Select menu, the
 * selection tools' results, filling and clearing through the selection,
 * Quick Mask, and the Layer Mask commands.
 *
 * The coverage work is the engine's (engine/selectHost.ts); this decides
 * what to ask for, and commits what comes back as one named step, like any
 * edit. A selection is history, as in Photoshop; Reselect's memory of the
 * last one isn't.
 */
import { addChannel, addMask, removeChannel, renameChannel, removeNode, setChannelTiles, setMaskProps, setSelection, setTiles } from '../doc/edit'
import type { ColourRangePreset } from '../tiles/coverage'
import type { Doc, DocNode, NodeId } from '../doc/types'
import { engine } from '../engine/EngineHost'
import type { SelectModify, SelectShape } from '../engine/selectHost'
import type { CombineOp, Refine } from '../tiles/coverage'
import { colours } from './colours'
import { documents, newId, type OpenDoc } from './documents'
import { notify } from './notices'
import { formatOf, hold, samplesFor } from './pixels'
import { selectTools } from './selectTools'

const store = () => documents()

function active(): OpenDoc | null {
  return store().active()
}

/** Commits a new selection (null for none), remembering the old one for Reselect when it goes. */
function commitSelection(d: OpenDoc, set: string | null, label: string) {
  const release = set ? hold([set]) : () => {}
  const before = d.history.present.selection?.tiles ?? null
  store().commit((x) => setSelection(x, set), { key: d.key, label })
  if (!set && before) store().setEditState({ lastSelection: before }, d.key)
  release()
}

/** Calls the engine for a new selection, then commits it, or says what went wrong. */
async function selectWith(d: OpenDoc, label: string, fn: () => Promise<string | null>) {
  try {
    const set = await fn()
    // The document may have moved on (closed, or another selection) while the engine worked.
    if (!store().get(d.key)) return
    commitSelection(store().get(d.key)!, set, label)
  } catch (e) {
    notify('error', `${label} didn’t work.`, [e instanceof Error ? e.message : String(e)])
  }
}

export function selectAll() {
  const d = active()
  if (!d) return
  const doc = d.history.present
  void selectWith(d, 'Select All', () => engine().call('select.all', { width: doc.width, height: doc.height }))
}

export function deselect() {
  const d = active()
  if (!d || !d.history.present.selection) return
  commitSelection(d, null, 'Deselect')
}

export function reselect() {
  const d = active()
  if (!d || !d.lastSelection) return
  commitSelection(d, d.lastSelection, 'Reselect')
}

export function inverse() {
  const d = active()
  if (!d) return
  const doc = d.history.present
  void selectWith(d, 'Inverse', () => engine().call('select.invert', { width: doc.width, height: doc.height, current: doc.selection?.tiles ?? null }))
}

/** Feather, Expand, Contract, Select and Mask, or moving the selection by whole pixels. */
export function modifySelection(modify: SelectModify, label: string) {
  const d = active()
  const sel = d?.history.present.selection?.tiles
  if (!d || !sel) return
  const doc = d.history.present
  void selectWith(d, label, () => engine().call('select.modify', { width: doc.width, height: doc.height, tiled: doc.tiled, current: sel, modify }))
}

/** A marquee or lasso shape, combined with the selection as `op` says. */
export function selectShape(shape: SelectShape, op: CombineOp, o: { feather: number; antialias: boolean }, label: string) {
  const d = active()
  if (!d) return
  const doc = d.history.present
  void selectWith(d, label, () =>
    engine().call('select.shape', { width: doc.width, height: doc.height, tiled: doc.tiled, shape, antialias: o.antialias, feather: o.feather, op, current: doc.selection?.tiles ?? null }),
  )
}

/** The Magic Wand at a document point. */
export function wandAt(x: number, y: number, op: CombineOp) {
  const d = active()
  if (!d) return
  const doc = d.history.present
  const w = selectTools().get().wand
  const node = w.sampleAll ? null : layerFor(d)
  void selectWith(d, 'Magic Wand', () =>
    engine().call('select.wand', { key: d.key, x, y, tolerance: w.tolerance, contiguous: w.contiguous, node: node?.id ?? null, antialias: w.antialias, op, current: doc.selection?.tiles ?? null }),
  )
}

/** The layer the image-reading selection work reads: the selected one, unless the tool samples all layers. */
function sampled(d: OpenDoc, all: boolean): string | null {
  return all ? null : (layerFor(d)?.id ?? null)
}

/** Select → Grow (pixels touching the selection) or Similar (anywhere) like its colours, within the Magic Wand's tolerance. */
export function growSimilar(contiguous: boolean) {
  const d = active()
  const sel = d?.history.present.selection?.tiles
  if (!d || !sel) return
  const w = selectTools().get().wand
  void selectWith(d, contiguous ? 'Grow' : 'Similar', () =>
    engine().call('select.similar', { key: d.key, node: sampled(d, w.sampleAll), current: sel, tolerance: w.tolerance, contiguous, antialias: w.antialias }),
  )
}

export interface ColourRangeOptions {
  preset: ColourRangePreset
  samples: [number, number][]
  fuzziness: number
  invert: boolean
  sampleAll: boolean
}

/** Colour Range's selection, made without a step: for the dialog's preview, and committed on OK. */
export async function colourRangeSet(o: ColourRangeOptions): Promise<string | null> {
  const d = active()
  if (!d) return null
  return engine().call('select.colourRange', { key: d.key, node: sampled(d, o.sampleAll), preset: o.preset, samples: o.samples, fuzziness: o.fuzziness, invert: o.invert, op: 'replace', current: null })
}

/** Shows a selection made for a dialog's preview on the canvas in place of the document's, without a step. */
export function previewSelection(set: string | null) {
  const d = active()
  if (d) engine().setScene(d.key, setSelection(d.history.present, set))
}

/** A set made for a preview combined with the selection there is, then committed as `label`. */
export async function commitCombined(set: string | null, op: CombineOp, label: string) {
  const d = active()
  if (!d) return
  const doc = d.history.present
  if (op === 'replace') return commitSelection(d, set, label)
  await selectWith(d, label, () => engine().call('select.channel', { width: doc.width, height: doc.height, tiled: doc.tiled, tiles: set, transform: [1, 0, 0, 1, 0, 0], invert: false, op, current: doc.selection?.tiles ?? null }))
}

/** Quick Selection: the selection grown from a stroke (document points, a brush radius) out to the edges, or shrunk away from them. */
export async function quickSelectStroke(points: [number, number][], radius: number, mode: 'add' | 'subtract', o: { sampleAll: boolean; autoEnhance: boolean }, current: string | null): Promise<string | null> {
  const d = active()
  if (!d) return null
  return engine().call('select.quick', { key: d.key, node: sampled(d, o.sampleAll), current, points, radius, mode, autoEnhance: o.autoEnhance })
}

/** Commits a selection a tool made over a drag. */
export function commitSelectionFrom(set: string | null, label: string) {
  const d = active()
  if (d) commitSelection(d, set, label)
}

/** Select and Mask's edge detection and refine brush, on a selection: the result, held until `release`, without a step. */
export async function refineEdgeSet(current: string, o: { radius: number; smart: boolean; strokes: { points: [number, number][]; radius: number }[]; sampleAll?: boolean }): Promise<string | null> {
  const d = active()
  if (!d) return null
  return engine().call('select.refineEdge', { key: d.key, node: sampled(d, o.sampleAll ?? true), current, radius: o.radius, smart: o.smart, strokes: o.strokes })
}

// --- alpha channels -----------------------------------------------------------------------

/**
 * Select → Save Selection: into a new alpha channel, or into one there is
 * (replacing it, or added to, subtracted from or intersected with it).
 */
export async function saveSelection(o: { channel: string | null; name: string; op: CombineOp }) {
  const d = active()
  const sel = d?.history.present.selection?.tiles
  if (!d || !sel) return
  const doc = d.history.present
  if (!o.channel) {
    const id = newId('ch')
    const name = o.name.trim() || freshChannelName(doc)
    const release = hold([sel])
    store().commit((x) => addChannel(x, { id, name, tiles: sel, transform: [1, 0, 0, 1, 0, 0] }), { key: d.key, label: 'Save Selection' })
    release()
    return
  }
  const ch = doc.channels?.find((c) => c.id === o.channel)
  if (!ch) return
  try {
    // The channel as it lies in the document, combined with the selection.
    const set =
      o.op === 'replace'
        ? sel
        : await engine().call('select.channel', { width: doc.width, height: doc.height, tiled: doc.tiled, tiles: sel, transform: [1, 0, 0, 1, 0, 0], invert: false, op: o.op, current: await engine().call('select.channel', { width: doc.width, height: doc.height, tiled: doc.tiled, tiles: ch.tiles, transform: ch.transform, invert: false, op: 'replace', current: null }) })
    const release = set ? hold([set]) : () => {}
    store().commit((x) => setChannelTiles(x, ch.id, set), { key: d.key, label: 'Save Selection' })
    release()
  } catch (e) {
    notify('error', 'Save Selection didn’t work.', [e instanceof Error ? e.message : String(e)])
  }
}

/** Select → Load Selection, or a click on a channel: the channel as the selection, combined as `op` says. */
export function loadSelection(channel: string, o: { invert: boolean; op: CombineOp }) {
  const d = active()
  const doc = d?.history.present
  const ch = doc?.channels?.find((c) => c.id === channel)
  if (!d || !doc || !ch) return
  void selectWith(d, 'Load Selection', () =>
    engine().call('select.channel', { width: doc.width, height: doc.height, tiled: doc.tiled, tiles: ch.tiles, transform: ch.transform, invert: o.invert, op: o.op, current: doc.selection?.tiles ?? null }),
  )
}

/** "Alpha 1", "Alpha 2"... */
export function freshChannelName(doc: Doc): string {
  const used = new Set((doc.channels ?? []).map((c) => c.name))
  for (let i = 1; ; i++) if (!used.has(`Alpha ${i}`)) return `Alpha ${i}`
}

export function deleteChannel(id: string) {
  const d = active()
  if (d) store().commit((x) => removeChannel(x, id), { key: d.key, label: 'Delete Channel' })
}

export function renameDocChannel(id: string, name: string) {
  const d = active()
  if (d) store().commit((x) => renameChannel(x, id, name), { key: d.key, label: 'Rename Channel' })
}

/** Duplicate Channel: the same coverage under a new name. */
export function duplicateChannel(id: string) {
  const d = active()
  const ch = d?.history.present.channels?.find((c) => c.id === id)
  if (!d || !ch) return
  store().commit((x) => addChannel(x, { ...ch, id: newId('ch'), name: `${ch.name} copy` }), { key: d.key, label: 'Duplicate Channel' })
}

/** The selected layer, if it can be worked on: a pixel layer, or with a mask, the layer the mask is on. */
function layerFor(d: OpenDoc): DocNode | null {
  return d.selected ? (d.history.present.nodes[d.selected] ?? null) : null
}

/**
 * Select and Mask's preview: the refined selection shown in place of the
 * document's while the dialog is open, without a step. Returns the set (held
 * until `release`), or null for an empty result.
 */
export async function previewRefine(o: Refine): Promise<{ set: string | null; release(): void }> {
  const d = active()
  const sel = d?.history.present.selection?.tiles
  if (!d || !sel) return { set: null, release: () => {} }
  const doc = d.history.present
  const set = await engine().call('select.modify', { width: doc.width, height: doc.height, tiled: doc.tiled, current: sel, modify: { kind: 'refine', refine: o } })
  const release = set ? hold([set]) : () => {}
  engine().setScene(d.key, setSelection(doc, set))
  return { set, release }
}

/**
 * Select and Mask's whole result, without a step: the edge worked out again
 * from the image (a radius, Smart Radius, brushed strokes), then the global
 * refinements. Null for an empty result.
 */
export async function refineAll(o: Refine & { radius: number; smart: boolean; strokes: { points: [number, number][]; radius: number }[] }): Promise<string | null> {
  const d = active()
  const sel = d?.history.present.selection?.tiles
  if (!d || !sel) return null
  const doc = d.history.present
  let set: string | null = sel
  if (o.radius > 0 || o.strokes.length) set = await refineEdgeSet(sel, o)
  if (set && (o.smooth || o.feather || o.contrast || o.shift)) {
    const release = hold([set])
    try {
      set = await engine().call('select.modify', { width: doc.width, height: doc.height, tiled: doc.tiled, current: set, modify: { kind: 'refine', refine: { smooth: o.smooth, feather: o.feather, contrast: o.contrast, shift: o.shift } } })
    } finally {
      release()
    }
  }
  return set
}

/** Ends a preview: the document as it is, back on the canvas. */
export function endPreview() {
  const d = active()
  if (d) engine().setScene(d.key, d.history.present)
}

/** Commits a set made while previewing as the selection. */
export function commitPreviewed(set: string | null, label: string) {
  const d = active()
  if (d) commitSelection(d, set, label)
}

// --- pixels through the selection ------------------------------------------------

/** What pixel commands act on: the selected layer's pixels, or its mask when that's the target. */
export function pixelTarget(d: OpenDoc): { node: DocNode; mask: DocNode | null } | null {
  const node = layerFor(d)
  if (!node) return null
  const doc = d.history.present
  // A vector mask isn't painted on: it's an outline, edited with the Pen and Direct Selection.
  if (d.maskTarget === 'pixel') {
    const mask = pixelMaskOf(doc, node)
    if (mask) return { node, mask }
  }
  return node.kind === 'pixel' ? { node, mask: null } : null
}

/** Why a layer can't take pixel edits, or null when it can. */
function refusal(node: DocNode): string | null {
  if (node.locked.all || node.locked.pixels) return `“${node.name}” is locked against painting. Unlock it in the Properties panel.`
  return null
}

/**
 * Fills the target with the foreground or background colour, through the
 * selection when there is one (Edit → Fill). On a mask, the colour's gray
 * value is what's filled: white reveals, black hides.
 */
export async function fillTarget(which: 'fg' | 'bg') {
  const d = active()
  if (!d) return
  const t = pixelTarget(d)
  if (!t) return
  const why = refusal(t.node)
  if (why) return notify('info', why)
  const doc = d.history.present
  const colour = colours().get()[which]
  const label = which === 'fg' ? 'Fill with Foreground' : 'Fill with Background'
  try {
    if (t.mask && t.mask.kind === 'mask') {
      const g = await grayOf(doc, which)
      await throughSelection(d, t.mask, { mode: 'gray', depth: 8 }, [Math.round(g * 255), 255], label)
      return
    }
    const { value, clipped } = await samplesFor(doc, colour)
    await throughSelection(d, t.node, formatOf(doc), value, label)
    if (clipped) notify('info', 'The colour was outside the document’s gamut, so the nearest colour it has was used.')
  } catch (e) {
    notify('error', `${label} didn’t work.`, [e instanceof Error ? e.message : String(e)])
  }
}

/** Clears what the selection covers on the target: Edit → Clear, the Delete key with a selection. On a mask, clearing hides. */
export async function clearTarget() {
  const d = active()
  if (!d) return
  const t = pixelTarget(d)
  if (!t) return
  const why = refusal(t.node)
  if (why) return notify('info', why)
  const doc = d.history.present
  try {
    if (t.mask && t.mask.kind === 'mask') await throughSelection(d, t.mask, { mode: 'gray', depth: 8 }, [0, 255], 'Clear')
    else await throughSelection(d, t.node, formatOf(doc), null, 'Clear')
  } catch (e) {
    notify('error', 'Clear didn’t work.', [e instanceof Error ? e.message : String(e)])
  }
}

/** The foreground or background as a gray level, 0..1, for painting and filling masks. */
export async function grayOf(doc: Doc, which: 'fg' | 'bg'): Promise<number> {
  const { value } = await samplesFor({ ...doc, mode: 'gray', depth: 8, profile: { builtin: 'gray-gamma-2.2' } }, colours().get()[which])
  return value[0] / 255
}

async function throughSelection(d: OpenDoc, node: DocNode, format: { mode: Doc['mode']; depth: Doc['depth'] }, value: number[] | null, label: string) {
  if (node.kind !== 'pixel' && node.kind !== 'mask') return
  const doc = d.history.present
  // A mask with no tiles is its outside value everywhere: fill from that, not from nothing.
  let layer = node.props.tiles
  if (node.kind === 'mask' && !layer && node.props.outside > 0) {
    layer = await engine().call('select.fill', { layer: null, format, transform: node.transform, cover: null, width: doc.width, height: doc.height, value: [Math.round(node.props.outside * 255), 255] })
  }
  const set = await engine().call('select.fill', { layer, format, transform: node.transform, cover: doc.selection?.tiles ?? null, width: doc.width, height: doc.height, value })
  if (set === node.props.tiles) return
  const release = set ? hold([set]) : () => {}
  store().commit((x) => setTiles(x, node.id, set), { key: d.key, label })
  release()
}

// --- Quick Mask ---------------------------------------------------------------------

/**
 * Quick Mask on or off. Going in with nothing selected selects everything
 * first, so the brushes have a selection to paint black out of.
 */
export async function toggleQuickMask() {
  const d = active()
  if (!d) return
  if (d.quickMask) {
    store().setEditState({ quickMask: false }, d.key)
    return
  }
  const doc = d.history.present
  if (!doc.selection) {
    const set = await engine().call('select.all', { width: doc.width, height: doc.height })
    commitSelection(store().get(d.key)!, set, 'Quick Mask')
  }
  store().setEditState({ quickMask: true }, d.key)
}

// --- layer masks ------------------------------------------------------------------------

export type NewMask = 'reveal-all' | 'hide-all' | 'reveal-selection' | 'hide-selection'

/** Adds a pixel mask to the selected layer, from nothing or from the selection, and makes it the target. */
export async function addLayerMask(kind: NewMask) {
  const d = active()
  const node = d ? layerFor(d) : null
  if (!d || !node) return
  const doc = d.history.present
  if (pixelMaskOf(doc, node)) return notify('info', `“${node.name}” already has a layer mask.`)
  const sel = doc.selection?.tiles ?? null
  let tiles: string | null = null
  let outside = kind === 'hide-all' ? 0 : 1
  if (kind === 'reveal-selection' || kind === 'hide-selection') {
    if (!sel) return notify('info', 'There’s no selection to make the mask from.')
    if (kind === 'reveal-selection') {
      tiles = sel
      outside = 0
    } else {
      tiles = await engine().call('select.invert', { width: doc.width, height: doc.height, current: sel })
      // Off the canvas, the hidden part's opposite: shown.
      outside = 1
    }
  }
  const id = newId('m')
  const release = tiles ? hold([tiles]) : () => {}
  const labels: Record<NewMask, string> = { 'reveal-all': 'Reveal All', 'hide-all': 'Hide All', 'reveal-selection': 'Reveal Selection', 'hide-selection': 'Hide Selection' }
  store().commit((x) => addMask(x, node.id, id, tiles, outside), { key: d.key, label: labels[kind] })
  release()
  store().select(node.id, d.key, true)
}

/** The selected layer's mask, if it has one. */
/**
 * The selected layer's mask that's being worked on: the vector mask when
 * that's the target, otherwise its pixel mask, or its vector mask when it
 * has only that.
 */
export function maskOf(d: OpenDoc, source?: 'pixel' | 'vector'): (DocNode & { kind: 'mask' }) | null {
  const node = layerFor(d)
  if (!node) return null
  const doc = d.history.present
  const pixel = pixelMaskOf(doc, node)
  const vector = vectorMaskOf(doc, node)
  if (source) return source === 'vector' ? vector : pixel
  return d.maskTarget === 'vector' ? (vector ?? pixel) : (pixel ?? vector)
}

type MaskNode = DocNode & { kind: 'mask' }
const maskBy = (source: 'pixel' | 'vector') => (doc: Doc, node: DocNode): MaskNode | null => {
  for (const m of node.masks) {
    const n = doc.nodes[m]
    if (n?.kind === 'mask' && n.props.source === source) return n
  }
  return null
}
/** A layer's pixel mask, if it has one. */
export const pixelMaskOf = maskBy('pixel')
/** A layer's vector mask, if it has one. */
export const vectorMaskOf = maskBy('vector')

export function deleteLayerMask(source?: 'pixel' | 'vector') {
  const d = active()
  const m = d ? maskOf(d, source) : null
  if (!d || !m) return
  store().commit((x) => removeNode(x, m.id), { key: d.key, label: m.props.source === 'vector' ? 'Delete Vector Mask' : 'Delete Layer Mask' })
  store().setEditState({ maskTarget: false }, d.key)
}

/** Enables or disables the mask: a disabled mask is kept but not applied. */
export function toggleMaskEnabled(source?: 'pixel' | 'vector') {
  const d = active()
  const m = d ? maskOf(d, source) : null
  if (!d || !m) return
  store().commit((x) => ({ ...x, nodes: { ...x.nodes, [m.id]: { ...x.nodes[m.id], visible: !m.visible } } }), { key: d.key, label: m.visible ? 'Disable Layer Mask' : 'Enable Layer Mask' })
}

export function setMask(patch: Parameters<typeof setMaskProps>[2], coalesce?: string) {
  const d = active()
  const m = d ? maskOf(d) : null
  if (!d || !m) return
  store().commit((x) => setMaskProps(x, m.id, patch), { key: d.key, coalesce })
}

/** Apply Layer Mask: the layer's pixels made to match what the mask shows, and the mask gone. */
export async function applyLayerMask() {
  const d = active()
  const node = d ? layerFor(d) : null
  const m = d ? maskOf(d) : null
  if (!d || !node || !m) return
  if (node.kind !== 'pixel') return notify('info', 'Apply Layer Mask works on pixel layers. A group’s mask stays a mask.')
  if (m.props.source !== 'pixel') return notify('info', 'A vector mask stays an outline: Rasterize the layer to make what it hides part of its pixels.')
  const why = refusal(node)
  if (why) return notify('info', why)
  const doc = d.history.present
  try {
    const set = node.props.tiles
      ? await engine().call('mask.apply', {
          layer: node.props.tiles,
          format: formatOf(doc),
          transform: node.transform,
          mask: { tiles: m.props.tiles, transform: m.transform, outside: m.props.outside, invert: m.props.invert, density: m.props.density, feather: m.props.feather },
          width: doc.width,
          height: doc.height,
        })
      : null
    const release = set ? hold([set]) : () => {}
    store().commit((x) => removeNode(m.visible ? setTiles(x, node.id, set) : x, m.id), { key: d.key, label: 'Apply Layer Mask' })
    release()
    store().setEditState({ maskTarget: false }, d.key)
  } catch (e) {
    notify('error', 'Apply Layer Mask didn’t work.', [e instanceof Error ? e.message : String(e)])
  }
}

/** The mask's coverage as the selection (Ctrl-click on its thumbnail in Photoshop). */
export function selectionFromMask(id: NodeId) {
  const d = active()
  const m = d?.history.present.nodes[id]
  if (!d || !m || m.kind !== 'mask') return
  if (m.props.tiles && m.transform.every((v, i) => v === [1, 0, 0, 1, 0, 0][i]) && m.props.outside === 0 && !m.props.invert && m.props.density === 1) {
    commitSelection(d, m.props.tiles, 'Load Selection')
    return
  }
  notify('info', 'Only a mask made from a selection, not moved or changed since, loads as a selection for now.')
}
