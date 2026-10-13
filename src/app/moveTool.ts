/**
 * The Move tool's own settings: Auto-Select, which picks the layer under
 * the pointer at each press, and whether it picks that layer or the
 * outermost group holding it, as Photoshop's does. Kept by the browser.
 */
export interface MoveSettings {
  autoSelect: boolean
  target: 'layer' | 'group'
}

export const DEFAULT_MOVE: MoveSettings = { autoSelect: false, target: 'layer' }

const KEY = 'plexel.move.v1'

/** Settings from their saved text; anything wrong is its default. */
export function readMoveSettings(text: string | null): MoveSettings {
  try {
    const raw: unknown = text ? JSON.parse(text) : null
    if (typeof raw !== 'object' || raw === null) return DEFAULT_MOVE
    const r = raw as Record<string, unknown>
    return { autoSelect: typeof r.autoSelect === 'boolean' ? r.autoSelect : DEFAULT_MOVE.autoSelect, target: r.target === 'group' ? 'group' : 'layer' }
  } catch {
    return DEFAULT_MOVE
  }
}

class MoveStore {
  private value: MoveSettings | null = null
  private listeners = new Set<() => void>()
  get = (): MoveSettings => {
    if (!this.value) {
      let text: string | null = null
      try {
        text = localStorage.getItem(KEY)
      } catch {
        // No storage: the defaults.
      }
      this.value = readMoveSettings(text)
    }
    return this.value
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  update(change: Partial<MoveSettings>) {
    this.value = { ...this.get(), ...change }
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value))
    } catch {
      // Kept for this visit only.
    }
    for (const fn of this.listeners) fn()
  }
}

let store: MoveStore | null = null
export const moveTool = () => (store ??= new MoveStore())
