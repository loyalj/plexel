/**
 * Pattern editing mode, after Illustrator's: a pattern's tile opened in a
 * tab of its own, with every tool, its copies round it (Tiled View), and
 * the Pattern Options (the Patterns panel, while the tab is in front): the
 * tile's layout, its size, the spacing between tiles, its name.
 *
 * What's drawn in the tab goes back into the pattern's document as it's
 * drawn: a moment after each change the tile's pixels are read (as the
 * canvas shows them, its edges wrapping where the layout repeats exactly),
 * laid out into one repeat (doc/patterns.ts `repeatOf`, the engine's
 * `fill.repeat`), and the pattern takes that repeat with the artwork,
 * one step there ("Edit Pattern") for each run of edits; so every shape,
 * fill and layer style drawn with it follows. Undone there, the tab
 * follows too. Done closes the tab; Cancel puts the pattern back as it
 * was before the tab opened (or takes away one that was being made);
 * Save a Copy keeps what's drawn as a new pattern beside it.
 *
 * Make Pattern copies the selected layers into a new pattern's tile and
 * opens it here. A pattern made from pixels opens as one pixel layer, and
 * comes back with artwork: its pixels as a layer to paint on.
 */
import { addPattern, removePattern, resizeCanvas, setTiling } from '../doc/edit'
import { DEFAULT_PATTERN_TILE, contentOf, editTiling, patternContent, pixelContent, repeatFits, repeatOf } from '../doc/patterns'
import { placeOf } from '../doc/tree'
import type { Doc, DocPattern, PatternTile } from '../doc/types'
import { engine } from '../engine/EngineHost'
import { Listeners } from '../lib/listeners'
import { MAX_PATTERN } from '../vector/paint'
import { layersBox } from './bounds'
import { documents, newId, selectedIds } from './documents'
import { freshPatternName } from './fills'
import { notify } from './notices'
import { hold } from './pixels'

const store = () => documents()

interface Editing {
  owner: string
  pattern: string
  name: string
  tile: PatternTile
  /** The pattern as it was when the tab opened, for Cancel; null for one being made. */
  original: DocPattern | null
  /** The tab's document whose repeat was last sent, or is being worked out. */
  sent: Doc | null
  /** The contents last sent, to tell the owner's own changes (an undo there) from ours. */
  content: Doc | null
  seq: number
  timer: ReturnType<typeof setTimeout> | null
  /** Said once per tab: the layout's repeat is too big for a pattern. */
  warned: boolean
}

const editing = new Map<string, Editing>()
const changes = new Listeners()

/** How long after a change the repeat is worked out: a run of edits is one. */
const SETTLE_MS = 180

/** The pattern editing a tab is doing, if it's a pattern's tab. */
export const patternEditOf = (tabKey: string | null | undefined) => (tabKey ? (editing.get(tabKey) ?? null) : null)
export const subscribePatternEdit = (fn: () => void) => changes.subscribe(fn)

function open(owner: string, pattern: string, name: string, content: Doc, tile: PatternTile, original: DocPattern | null) {
  const key = store().add({ doc: { ...content, name, tiled: editTiling(tile) }, file: null, saved: true, patternOf: { key: owner, pattern }, label: original ? 'Edit Pattern' : 'Make Pattern' })
  // A pattern being made gets its first repeat at once; one being edited keeps what it has until something's drawn.
  editing.set(key, { owner, pattern, name, tile, original, sent: original ? (store().get(key)?.history.present ?? null) : null, content: original?.art?.content ?? null, seq: 0, timer: null, warned: false })
  if (!original) schedule(key, 0)
  changes.emit()
  return key
}

/** Edit Pattern: the pattern's tile in a tab of its own, or that tab if it's open already. */
export function editPattern(id: string): string | null {
  const d = store().active()
  const p = d?.history.present.patterns?.find((x) => x.id === id)
  if (!d || !p) return null
  const there = store()
    .getState()
    .docs.find((x) => x.patternOf?.key === d.key && x.patternOf.pattern === id)
  if (there) {
    store().activate(there.key)
    return there.key
  }
  const content = p.art?.content ?? pixelContent(d.history.present, p, newId('root'), newId('n'))
  return open(d.key, id, p.name, content, p.art?.tile ?? { ...DEFAULT_PATTERN_TILE, spacing: [0, 0] }, p)
}

/** Object → Pattern → Make: copies of the selected layers as a new pattern's tile, opened to edit. */
export async function makePatternFromSelection(): Promise<string | null> {
  const d = store().active()
  if (!d) return null
  if (d.patternOf) {
    notify('info', 'Finish editing this pattern first (Done in the Patterns panel).')
    return null
  }
  const doc = d.history.present
  const ids = selectedIds(d).filter((id) => doc.nodes[id] && placeOf(doc, id)?.slot === 'children')
  if (!ids.length) {
    notify('info', 'Select the layers to make a pattern of first.')
    return null
  }
  // What the layers cover, exactly (a pixel layer's tiles are coarser), effects and all.
  let box: [number, number, number, number] | null = null
  for (const id of ids) {
    const b = (await engine().call('clip.pixels', { key: d.key, source: { kind: 'node', node: id }, selection: null })).bounds ?? (await layersBox(doc, [id]))
    if (b) box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : [b[0], b[1], b[2], b[3]]
  }
  if (!box) {
    notify('info', 'Those layers have nothing in them to make a pattern of.')
    return null
  }
  const w = Math.ceil(box[2]) - Math.floor(box[0])
  const h = Math.ceil(box[3]) - Math.floor(box[1])
  if (w > MAX_PATTERN || h > MAX_PATTERN) {
    notify('info', `A pattern’s tile can be at most ${MAX_PATTERN.toLocaleString()} pixels a side; these layers cover ${w} × ${h}. Make them smaller first.`)
    return null
  }
  const name = freshPatternName(doc)
  const content = patternContent(doc, ids, box, newId('root'), name)
  const id = newId('pat')
  open(d.key, id, name, content, { ...DEFAULT_PATTERN_TILE, spacing: [0, 0] }, null)
  return id
}

function schedule(tabKey: string, ms = SETTLE_MS) {
  const e = editing.get(tabKey)
  if (!e) return
  if (e.timer) clearTimeout(e.timer)
  e.timer = setTimeout(() => {
    e.timer = null
    void render(tabKey)
  }, ms)
}

/** The tab's tile laid out as one repeat, and the pattern given it with the artwork. */
async function render(tabKey: string) {
  const e = editing.get(tabKey)
  const tab = store().get(tabKey)
  if (!e || !tab) return
  const now = tab.history.present
  const seq = ++e.seq
  e.sent = now
  const rep = repeatOf(now.width, now.height, e.tile)
  if (!repeatFits(rep)) {
    if (!e.warned) notify('warning', `Laid out this way the pattern repeats every ${rep.width} × ${rep.height} pixels; a pattern can be at most ${MAX_PATTERN.toLocaleString()} a side. Make the tile smaller, or choose another layout; the pattern keeps what it had.`)
    e.warned = true
    return
  }
  e.warned = false
  try {
    const px = await engine().call('clip.pixels', { key: tabKey, source: { kind: 'merged' }, selection: null })
    const tiles = px.set ? await engine().call('fill.repeat', { set: px.set, w: now.width, h: now.height, width: rep.width, height: rep.height, at: rep.at }) : null
    // A later change has its own repeat coming.
    if (seq !== e.seq || !editing.has(tabKey)) return
    const owner = store().get(e.owner)
    if (!owner) return
    if (!tiles) {
      if (e.original || owner.history.present.patterns?.some((p) => p.id === e.pattern)) notify('info', 'The tile is empty, so the pattern keeps what it had.')
      return
    }
    const content = contentOf(now, e.name)
    e.content = content
    const release = hold([tiles])
    const made = !owner.history.present.patterns?.some((p) => p.id === e.pattern)
    store().commit((x) => addPattern(x, { id: e.pattern, name: e.name, tiles, width: rep.width, height: rep.height, art: { content, tile: e.tile } }), { key: e.owner, label: made ? 'Make Pattern' : 'Edit Pattern', coalesce: `pattern:${e.pattern}` })
    release()
    changes.emit()
  } catch (err) {
    notify('error', 'The pattern couldn’t be drawn.', [err instanceof Error ? err.message : String(err)])
  }
}

/** The Pattern Options: the tile's layout and spacing, applied at once (and its tiling in the tab to match). */
export function setPatternTile(tabKey: string, patch: Partial<PatternTile>) {
  const e = editing.get(tabKey)
  if (!e) return
  e.tile = { ...e.tile, ...patch, spacing: patch.spacing ? [Math.round(patch.spacing[0]), Math.round(patch.spacing[1])] : e.tile.spacing }
  const tiling = editTiling(e.tile)
  const tab = store().get(tabKey)
  if (tab && (tab.history.present.tiled ?? 'off') !== tiling) store().commit((x) => setTiling(x, tiling), { key: tabKey, label: 'Pattern Options' })
  schedule(tabKey, 0)
  changes.emit()
}

/** The pattern's name, here and in its document. */
export function renameEditedPattern(tabKey: string, name: string) {
  const e = editing.get(tabKey)
  const n = name.trim()
  if (!e || !n || n === e.name) return
  e.name = n
  store().commit((x) => ({ ...x, name: n }), { key: tabKey, label: 'Pattern Options' })
  changes.emit()
}

function close(tabKey: string) {
  const e = editing.get(tabKey)
  if (e?.timer) clearTimeout(e.timer)
  editing.delete(tabKey)
  if (store().get(tabKey)) store().remove(tabKey)
  changes.emit()
}

/** Done: the pattern as it's drawn; the tab closes. A change still settling is drawn first. */
export async function finishPattern(tabKey: string) {
  const e = editing.get(tabKey)
  if (!e) return
  if (e.timer || e.sent !== store().get(tabKey)?.history.present) {
    if (e.timer) clearTimeout(e.timer)
    e.timer = null
    await render(tabKey)
  }
  const owner = store().get(e.owner)
  close(tabKey)
  if (owner) store().activate(owner.key)
}

/** Cancel: the pattern back as it was before the tab opened (a new one taken away); the tab closes. */
export function cancelPattern(tabKey: string) {
  const e = editing.get(tabKey)
  if (!e) return
  e.seq++
  const owner = store().get(e.owner)
  if (owner) {
    const have = owner.history.present.patterns?.find((p) => p.id === e.pattern)
    if (e.original && have !== e.original) store().commit((x) => addPattern(x, e.original!), { key: e.owner, label: 'Cancel Pattern Edit' })
    else if (!e.original && have) store().commit((x) => removePattern(x, e.pattern), { key: e.owner, label: 'Cancel Make Pattern' })
  }
  close(tabKey)
  if (owner) store().activate(owner.key)
}

/** Save a Copy: what's drawn kept as a new pattern too; editing goes on with the first. */
export async function savePatternCopy(tabKey: string): Promise<string | null> {
  const e = editing.get(tabKey)
  if (!e) return null
  await render(tabKey)
  const owner = store().get(e.owner)
  const p = owner?.history.present.patterns?.find((x) => x.id === e.pattern)
  if (!owner || !p) return null
  const id = newId('pat')
  store().commit((x) => addPattern(x, { ...p, id, name: `${p.name} copy` }), { key: e.owner, label: 'Save a Copy of Pattern' })
  notify('info', `Kept as “${p.name} copy” too.`)
  return id
}

/** The tile's size from the Pattern Options: the tab's canvas, grown or shrunk round its middle. */
export function setTileSize(tabKey: string, width: number, height: number) {
  const w = Math.round(Math.min(MAX_PATTERN, Math.max(1, width)))
  const h = Math.round(Math.min(MAX_PATTERN, Math.max(1, height)))
  const d = store().get(tabKey)?.history.present
  if (!d || (d.width === w && d.height === h)) return
  store().commit((x) => resizeCanvas(x, w, h, { x: 0.5, y: 0.5 }), { key: tabKey, label: 'Tile Size' })
}

// A pattern's tab: each change (an edit, an undo, a redo) is drawn into its pattern; and a change
// to the pattern in its document (undone there, say) comes into the tab, so the two agree.
store().subscribe(() => {
  for (const [key, e] of editing) {
    const tab = store().get(key)
    const owner = store().get(e.owner)
    if (!tab || !owner) {
      if (e.timer) clearTimeout(e.timer)
      editing.delete(key)
      if (tab && !owner) store().remove(key)
      changes.emit()
      continue
    }
    const now = tab.history.present
    const there = owner.history.present.patterns?.find((p) => p.id === e.pattern)
    // The document's pattern changed on its own (an undo there): the tab takes its artwork and layout.
    if (there?.art && e.content && there.art.content !== e.content && now === e.sent && !e.timer) {
      e.content = there.art.content
      e.tile = there.art.tile
      e.name = there.name
      const next = { ...there.art.content, name: there.name, tiled: editTiling(there.art.tile) }
      e.sent = next
      store().commit(() => next, { key, label: 'Changed in its document' })
      store().markClean(key)
      changes.emit()
      continue
    }
    if (now !== e.sent && !e.timer) schedule(key)
    if (tab.history.present !== tab.saved) store().markClean(key)
  }
})

