/**
 * What the canvas shows besides the document: its guides, the grid and the
 * pixel grid, from the document and the View menu's settings
 * (app/guidePrefs.ts); and each open document's ruler zero point, which
 * the rulers, the grid and the readouts measure from.
 *
 * The zero point is view state, as the zoom is: dragged out of the rulers'
 * corner, put back by double-clicking it, never an undo step.
 */
import type { OverlayView } from '../render/overlay'
import { fromPixels } from '../doc/units'
import { documents } from './documents'
import { guidePrefs, rgbOf } from './guidePrefs'
import { Listeners } from '../lib/listeners'

class Origins {
  private map = new Map<string, [number, number]>()
  private changes = new Listeners()
  subscribe = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }
  get = (key: string | null): [number, number] => (key ? (this.map.get(key) ?? [0, 0]) : [0, 0])
  set(key: string, at: [number, number] | null) {
    if (at) this.map.set(key, at)
    else this.map.delete(key)
    this.changes.emit()
  }
}

let origins_: Origins | null = null
/** Each open document's ruler zero point, in document pixels. */
export const origins = () => (origins_ ??= new Origins())

/** The grid's spacing in document pixels, from its units at the document's resolution. */
export function gridStep(resolution: number): number {
  const p = guidePrefs().get()
  if (p.gridUnit === 'px') return p.gridEvery
  // Unrounded: a grid in centimetres keeps its spacing at any resolution.
  return p.gridEvery / fromPixels(1, p.gridUnit, resolution)
}

/** A guide being dragged: left out of the document's guides while the drag draws it where it's going. */
let held: { key: string; index: number } | null = null
export function holdGuide(h: { key: string; index: number } | null) {
  held = h
}

/** What a document's overlay shows under the tools: its guides, the grid, the pixel grid; or nothing. */
export function overlayViewOf(key: string): OverlayView | null {
  const d = documents().get(key)
  if (!d) return null
  const doc = d.history.present
  const p = guidePrefs().get()
  const guides = !p.guides ? [] : held?.key === key ? doc.guides.filter((_, i) => i !== held!.index) : doc.guides
  const step = gridStep(doc.resolution)
  const grid = p.grid && step > 0 ? { step: [step, step] as [number, number], origin: origins().get(key), sub: p.gridSub } : null
  if (!guides.length && !grid && !p.pixelGrid) return null
  return {
    width: doc.width,
    height: doc.height,
    guides,
    grid,
    pixelGrid: p.pixelGrid,
    colours: { guide: rgbOf(p.guideColour), smart: rgbOf(p.smartColour), grid: rgbOf(p.gridColour) },
  }
}
