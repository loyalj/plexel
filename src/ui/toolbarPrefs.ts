/**
 * Your toolbar: which slots it shows, in what order, and in how many
 * columns (Edit → Toolbar…, as Photoshop's Edit Toolbar). A slot is a tool
 * on its own or a group of tools sharing a key, named by the group or the
 * tool. Slots taken off the bar are under its "…" slot, and their keys
 * still work.
 *
 * View state, per browser, read defensively: unknown slots are dropped,
 * and slots a later version adds go in at their place in the default
 * order, so a new tool shows up. The arranging is pure, for check-commands.
 */
import { TOOL_DEFS } from '../tools'
import { Listeners } from '../lib/listeners'

export interface ToolbarPrefs {
  /** Slot ids, top to bottom. */
  order: string[]
  /** Slot ids not on the bar. */
  hidden: string[]
  /** One column, two, or as the window's height allows. */
  columns: 'auto' | 'one' | 'two'
}

/** Every slot's id in the toolbar's own order. */
export const DEFAULT_SLOTS: string[] = (() => {
  const out: string[] = []
  for (const t of TOOL_DEFS) {
    const id = t.group ?? t.id
    if (!out.includes(id)) out.push(id)
  }
  return out
})()

export const DEFAULT_TOOLBAR: ToolbarPrefs = { order: DEFAULT_SLOTS, hidden: [], columns: 'auto' }

/**
 * An order with every known slot once: those given first (unknown ones
 * dropped), then any missing, each placed after the slot before it in the
 * default order.
 */
export function arrange(order: readonly string[]): string[] {
  const out = order.filter((id, i) => DEFAULT_SLOTS.includes(id) && order.indexOf(id) === i)
  DEFAULT_SLOTS.forEach((id, i) => {
    if (out.includes(id)) return
    const before = DEFAULT_SLOTS.slice(0, i).reverse().find((x) => out.includes(x))
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, id)
  })
  return out
}

export function readToolbar(raw: unknown): ToolbarPrefs {
  if (!raw || typeof raw !== 'object') return DEFAULT_TOOLBAR
  const r = raw as Partial<Record<keyof ToolbarPrefs, unknown>>
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return {
    order: arrange(strings(r.order)),
    hidden: strings(r.hidden).filter((id) => DEFAULT_SLOTS.includes(id)),
    columns: r.columns === 'one' || r.columns === 'two' ? r.columns : 'auto',
  }
}

/** The slot moved to just before `before` (or to the end with null). */
export function moveSlot(p: ToolbarPrefs, id: string, before: string | null): ToolbarPrefs {
  if (id === before) return p
  const order = p.order.filter((x) => x !== id)
  const at = before === null ? order.length : order.indexOf(before)
  order.splice(at < 0 ? order.length : at, 0, id)
  return { ...p, order }
}

export function setShown(p: ToolbarPrefs, id: string, shown: boolean): ToolbarPrefs {
  const hidden = p.hidden.filter((x) => x !== id)
  return { ...p, hidden: shown ? hidden : [...hidden, id] }
}

const KEY = 'plexel.toolbar.v1'

class ToolbarStore {
  private state: ToolbarPrefs = DEFAULT_TOOLBAR
  private loaded = false
  private changes = new Listeners()
  get = () => {
    if (!this.loaded) {
      this.loaded = true
      try {
        this.state = readToolbar(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
      } catch {
        this.state = DEFAULT_TOOLBAR
      }
    }
    return this.state
  }
  subscribe = (fn: () => void) => this.changes.subscribe(fn)
  set(next: ToolbarPrefs) {
    this.state = next
    this.loaded = true
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // Kept for this visit only.
    }
    this.changes.emit()
  }
  reset() {
    this.set(DEFAULT_TOOLBAR)
  }
}

let store: ToolbarStore | null = null
export const toolbarPrefs = () => (store ??= new ToolbarStore())
