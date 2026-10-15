/**
 * What the pointer is doing on the canvas right now, for the status bar's
 * key hints: nothing, or a drag of some kind (a tool's gesture, painting,
 * panning, sizing the brush). The canvas sets it; the hints read it.
 */
import { Listeners } from '../lib/listeners'
export type CanvasGesture = 'tool' | 'paint' | 'pick' | 'pan' | 'zoom' | 'rotate' | 'size' | 'bird' | 'hue'

let current: CanvasGesture | null = null
const changes = new Listeners()

export const canvasGesture = {
  get: () => current,
  set(g: CanvasGesture | null) {
    if (g === current) return
    current = g
    changes.emit()
  },
  subscribe(fn: () => void) {
    return changes.subscribe(fn)
  },
}
