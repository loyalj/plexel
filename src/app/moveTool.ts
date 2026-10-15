/**
 * The Move tool's own settings: Auto-Select, which picks the layer under
 * the pointer at each press, and whether it picks that layer or the
 * outermost group holding it, as Photoshop's does; and Scale Strokes,
 * whether transforming a shape scales its strokes (Illustrator's Scale
 * Strokes & Effects). Kept by the browser.
 */
import { Listeners } from '../lib/listeners'
export interface MoveSettings {
  autoSelect: boolean
  target: 'layer' | 'group'
  /** Free Transform and the transform controls scale shapes' strokes with them; off, the strokes keep their widths. */
  scaleStrokes: boolean
}

const DEFAULT_MOVE: MoveSettings = { autoSelect: false, target: 'layer', scaleStrokes: true }

const KEY = 'plexel.move.v1'

/** Settings from their saved text; anything wrong is its default. */
function readMoveSettings(text: string | null): MoveSettings {
  try {
    const raw: unknown = text ? JSON.parse(text) : null
    if (typeof raw !== 'object' || raw === null) return DEFAULT_MOVE
    const r = raw as Record<string, unknown>
    return { autoSelect: typeof r.autoSelect === 'boolean' ? r.autoSelect : DEFAULT_MOVE.autoSelect, target: r.target === 'group' ? 'group' : 'layer', scaleStrokes: typeof r.scaleStrokes === 'boolean' ? r.scaleStrokes : DEFAULT_MOVE.scaleStrokes }
  } catch {
    return DEFAULT_MOVE
  }
}

class MoveStore {
  private value: MoveSettings | null = null
  private changes = new Listeners()
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
    return this.changes.subscribe(fn)
  }
  update(change: Partial<MoveSettings>) {
    this.value = { ...this.get(), ...change }
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value))
    } catch {
      // Kept for this visit only.
    }
    this.changes.emit()
  }
}

let store: MoveStore | null = null
export const moveTool = () => (store ??= new MoveStore())
