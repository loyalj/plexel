/**
 * Each document's overlay, as the page sends it to the engine: what a tool
 * is drawing (setToolOverlay), the smart guides of a snap in progress
 * (setSnapOverlay, kept apart so a tool redrawing its own shapes doesn't
 * wipe them), Quick Mask from the document's state, the guides and grids
 * it shows (app/viewAids.ts), and the alpha and spot channels shown
 * (app/channels.ts). It's sent again whenever any of those
 * changes.
 */
import type { Overlay, OverlayShape } from '../render/overlay'
import { engine } from '../engine/EngineHost'
import { channels, shownChannels } from './channels'
import { documents } from './documents'
import { guidePrefs } from './guidePrefs'
import { origins, overlayViewOf } from './viewAids'
import { Listeners } from '../lib/listeners'
import { tileWraps } from '../doc/types'
import { artboardRect, artboardsOf, pasteboardQuads } from '../doc/artboards'
import type { Doc } from '../doc/types'

/** Where the artboards are, as text, so a move of one sends the pasteboard again. */
const boardsKey = (doc: Doc) => artboardsOf(doc)
  .map((a) => artboardRect(a).join())
  .join('|')

/** A document as a tool previews it (an artboard being dragged), for the pasteboard to follow; null when it's as it is. */
const previewed = new Map<string, Doc>()
export function setOverlayDoc(key: string, doc: Doc | null) {
  if (doc) previewed.set(key, doc)
  else previewed.delete(key)
  sendOverlay(key)
}

const overlays = new Map<string, Omit<Overlay, 'quickMask'>>()
const snaps = new Map<string, OverlayShape[]>()

/**
 * A count of tools' overlay changes, for what follows a tool's drawing on
 * the page: a session's readout (a Polygonal Lasso's corners, a Free
 * Transform's size) changes as its overlay does.
 */
let toolVersion = 0
const toolChanges = new Listeners()
export const toolOverlayVersion = () => toolVersion
export function subscribeToolOverlay(fn: () => void) {
  return toolChanges.subscribe(fn)
}
function toolChanged() {
  toolVersion++
  toolChanges.emit()
}

/** Documents whose overlay changed and hasn't been sent yet. */
const unsent = new Set<string>()

/**
 * Sends a document's overlay: what a tool is drawing, its smart guides,
 * Quick Mask, and its guides and grids. Sent once after whatever is
 * running now, so a pointer move that changes a tool's shapes and its smart
 * guides sends (and copies) the overlay once, not twice.
 */
export function sendOverlay(key: string) {
  if (!unsent.size) queueMicrotask(flush)
  unsent.add(key)
}

function flush() {
  for (const key of unsent) {
    const d = documents().get(key)
    // A document closed meanwhile: the engine has let it go.
    if (!d) continue
    const o = overlays.get(key) ?? { shapes: [], shade: null }
    const snap = snaps.get(key)
    const v = channels.get(key)
    const doc = d.history.present
    // In Tiled View, the document itself framed among its copies, so it can be found again.
    const tiled = guidePrefs().get().tiledView && (tileWraps(doc.tiled).x || tileWraps(doc.tiled).y)
    // A document with artboards: the canvas outside them shaded as the pasteboard, underneath everything else.
    const board = pasteboardQuads(previewed.get(key) ?? doc)
    const pasteboard: OverlayShape[] = board.length ? [{ kind: 'quads', ink: 'pasteboard', points: board }] : []
    const frame: OverlayShape[] = tiled
      ? [
          {
            kind: 'path',
            closed: true,
            style: 'frame',
            points: [
              [0, 0],
              [doc.width, 0],
              [doc.width, doc.height],
              [0, doc.height],
            ],
          },
        ]
      : []
    engine().setOverlay(key, {
      ...o,
      shapes: [...pasteboard, ...frame, ...o.shapes, ...(snap ?? [])],
      quickMask: !!d.quickMask,
      view: overlayViewOf(key),
      tiledView: guidePrefs().get().tiledView,
      channels: v ? shownChannels(doc, v) : [],
      colourHidden: !!v && !v.colour.some(Boolean),
    })
  }
  unsent.clear()
}

export function setToolOverlay(key: string, o: Partial<Omit<Overlay, 'quickMask' | 'view'>>) {
  overlays.set(key, { shapes: o.shapes ?? [], shade: o.shade ?? null, hideAnts: o.hideAnts })
  sendOverlay(key)
  toolChanged()
}

export function clearToolOverlay(key: string) {
  overlays.delete(key)
  sendOverlay(key)
  toolChanged()
}

/** The smart guides a snap shows; an empty list takes them away. */
export function setSnapOverlay(key: string, shapes: OverlayShape[]) {
  const had = snaps.get(key)
  if (!shapes.length && !had?.length) return
  if (shapes.length) snaps.set(key, shapes)
  else snaps.delete(key)
  sendOverlay(key)
}

// Quick Mask and the guides live in the document store, the document's size bounds the grid, and its tiling frames it; the overlay follows them.
let shown = new Map<string, unknown[]>()
documents().subscribe(() => {
  const next = new Map(
    documents()
      .getState()
      .docs.map((d) => {
        const doc = d.history.present
        return [d.key, [d.quickMask, doc.guides, doc.width, doc.height, doc.resolution, doc.channels, doc.tiled, boardsKey(doc)]] as [string, unknown[]]
      }),
  )
  for (const [k, v] of next) {
    const was = shown.get(k)
    if (!was || v.some((x, i) => x !== was[i])) sendOverlay(k)
  }
  shown = next
})

// The View menu's settings and the rulers' zero points change what every document shows.
const all = () => {
  for (const d of documents().getState().docs) sendOverlay(d.key)
}
guidePrefs().subscribe(all)
origins().subscribe(all)
channels.subscribe(all)
