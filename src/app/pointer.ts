/**
 * Where the pointer is over the front document, in document pixels, for
 * panels that read what's under it (Separations). Null when it's off the
 * canvas.
 */
export interface PointerAt {
  key: string
  x: number
  y: number
}

let at: PointerAt | null = null
const listeners = new Set<() => void>()

export const pointer = {
  get: () => at,
  set(p: PointerAt | null) {
    if (p === at || (p && at && p.key === at.key && p.x === at.x && p.y === at.y)) return
    at = p
    for (const fn of listeners) fn()
  },
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}
