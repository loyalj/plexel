/**
 * What the pointer is doing on the canvas right now, for the status bar's
 * key hints: nothing, or a drag of some kind (a tool's gesture, painting,
 * panning, sizing the brush). The canvas sets it; the hints read it.
 */
export type CanvasGesture = 'tool' | 'paint' | 'pick' | 'pan' | 'zoom' | 'rotate' | 'size' | 'bird'

let current: CanvasGesture | null = null
const listeners = new Set<() => void>()

export const canvasGesture = {
  get: () => current,
  set(g: CanvasGesture | null) {
    if (g === current) return
    current = g
    for (const fn of listeners) fn()
  },
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}
