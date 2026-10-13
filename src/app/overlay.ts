/**
 * Each document's overlay, as the page sends it to the engine: what a tool
 * is drawing (setToolOverlay), the smart guides of a snap in progress
 * (setSnapOverlay, kept apart so a tool redrawing its own shapes doesn't
 * wipe them), Quick Mask from the document's state, and the guides and
 * grids it shows (app/viewAids.ts). It's sent again whenever any of those
 * changes.
 */
import type { Overlay, OverlayShape } from '../render/overlay'
import { engine } from '../engine/EngineHost'
import { documents } from './documents'
import { guidePrefs } from './guidePrefs'
import { origins, overlayViewOf } from './viewAids'

const overlays = new Map<string, Omit<Overlay, 'quickMask'>>()
const snaps = new Map<string, OverlayShape[]>()

/** Sends a document's overlay: what a tool is drawing, its smart guides, Quick Mask, and its guides and grids. */
export function sendOverlay(key: string) {
  const d = documents().get(key)
  const o = overlays.get(key) ?? { shapes: [], shade: null }
  const snap = snaps.get(key)
  engine().setOverlay(key, { ...o, shapes: snap?.length ? [...o.shapes, ...snap] : o.shapes, quickMask: !!d?.quickMask, view: overlayViewOf(key), tiledView: guidePrefs().get().tiledView })
}

export function setToolOverlay(key: string, o: Partial<Omit<Overlay, 'quickMask' | 'view'>>) {
  overlays.set(key, { shapes: o.shapes ?? [], shade: o.shade ?? null, hideAnts: o.hideAnts })
  sendOverlay(key)
}

export function clearToolOverlay(key: string) {
  overlays.delete(key)
  sendOverlay(key)
}

/** The smart guides a snap shows; an empty list takes them away. */
export function setSnapOverlay(key: string, shapes: OverlayShape[]) {
  const had = snaps.get(key)
  if (!shapes.length && !had?.length) return
  if (shapes.length) snaps.set(key, shapes)
  else snaps.delete(key)
  sendOverlay(key)
}

// Quick Mask and the guides live in the document store, and the document's size bounds the grid; the overlay follows them.
let shown = new Map<string, unknown[]>()
documents().subscribe(() => {
  const next = new Map(
    documents()
      .getState()
      .docs.map((d) => {
        const doc = d.history.present
        return [d.key, [d.quickMask, doc.guides, doc.width, doc.height, doc.resolution]] as [string, unknown[]]
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
