/**
 * Where the pointer is over the front document, in document pixels, for
 * panels that read what's under it (Separations). Null when it's off the
 * canvas.
 */
import { Listeners } from '../lib/listeners'
export interface PointerAt {
  key: string
  x: number
  y: number
}

let at: PointerAt | null = null
const changes = new Listeners()

export const pointer = {
  get: () => at,
  set(p: PointerAt | null) {
    if (p === at || (p && at && p.key === at.key && p.x === at.x && p.y === at.y)) return
    at = p
    changes.emit()
  },
  subscribe(fn: () => void) {
    return changes.subscribe(fn)
  },
}
