/**
 * Undo and redo, for any immutable value. Fresyn's history, unchanged in
 * shape: it served every editing feature there without one of them needing
 * anything special.
 *
 * A step is a whole state, not a diff. That's cheap because states share
 * everything an edit didn't touch, and a document's pixels aren't in the
 * state at all (only tile-set ids), so stepping back through a brush stroke
 * on a huge image costs a pointer swap.
 */
export interface History<T> {
  past: T[]
  present: T
  future: T[]
  /**
   * What each step was, for the History panel: `labels[i]` names the edit
   * that produced `past[i]`, then `label` the one that produced `present`,
   * then `futureLabels[i]` the one that produces `future[i]`. Kept beside the
   * states rather than wrapped round them, so everything that reads a state
   * reads it plainly.
   */
  labels: string[]
  label: string
  futureLabels: string[]
}

/**
 * How many steps back you can go before the oldest is forgotten. There's a
 * memory cap beside it (app/pixels.ts, HISTORY_BYTES), since every stroke
 * holds on to the tiles it replaced.
 */
export const HISTORY_LIMIT = 100

/** What the first entry in the list is called: where the session started. */
export const OPENED = 'Open'

export function initHistory<T>(present: T, label = OPENED): History<T> {
  return { past: [], present, future: [], labels: [], label, futureLabels: [] }
}

/**
 * Record a new state.
 *
 * `coalesce` folds the change into the current entry instead of pushing a
 * new one. Dragging an opacity slider produces a value every frame, and
 * without this a single gesture would fill the history with steps nobody
 * wants to undo one at a time.
 *
 * `label` is what the step is called in the History panel. A folded edit
 * keeps the name of the gesture it joined unless it brings one of its own.
 */
export function commit<T>(h: History<T>, next: T, coalesce = false, label?: string): History<T> {
  if (next === h.present) return h
  if (coalesce) return { ...h, present: next, future: [], futureLabels: [], label: label ?? h.label }
  const full = h.past.length >= HISTORY_LIMIT
  return {
    past: [...(full ? h.past.slice(1) : h.past), h.present],
    labels: [...(full ? h.labels.slice(1) : h.labels), h.label],
    present: next,
    label: label ?? 'Edit',
    future: [],
    futureLabels: [],
  }
}

/** Forgets all but the newest `keep` steps back. */
export function trimPast<T>(h: History<T>, keep: number): History<T> {
  if (h.past.length <= keep) return h
  return { ...h, past: h.past.slice(h.past.length - keep), labels: h.labels.slice(h.labels.length - keep) }
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h
  return {
    past: h.past.slice(0, -1),
    labels: h.labels.slice(0, -1),
    present: h.past[h.past.length - 1],
    label: h.labels[h.labels.length - 1],
    future: [h.present, ...h.future],
    futureLabels: [h.label, ...h.futureLabels],
  }
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h
  return {
    past: [...h.past, h.present],
    labels: [...h.labels, h.label],
    present: h.future[0],
    label: h.futureLabels[0],
    future: h.future.slice(1),
    futureLabels: h.futureLabels.slice(1),
  }
}

/**
 * Go to the step at `index` in `steps(h)` in one move: several undos or
 * several redos, whichever way it lies. Every step jumped over is still
 * there to jump back to, until the next edit.
 */
export function jumpTo<T>(h: History<T>, index: number): History<T> {
  const here = h.past.length
  const to = Math.max(0, Math.min(index, here + h.future.length))
  if (to === here) return h
  const all = [...h.past, h.present, ...h.future]
  const names = [...h.labels, h.label, ...h.futureLabels]
  return {
    past: all.slice(0, to),
    labels: names.slice(0, to),
    present: all[to],
    label: names[to],
    future: all.slice(to + 1),
    futureLabels: names.slice(to + 1),
  }
}

/** Every step in order, oldest first, and which one you are on. */
export function steps(h: History<unknown>): { labels: string[]; current: number } {
  return { labels: [...h.labels, h.label, ...h.futureLabels], current: h.past.length }
}

export const canUndo = (h: History<unknown>) => h.past.length > 0
export const canRedo = (h: History<unknown>) => h.future.length > 0

/** The name of the step Undo would take back, or null. */
export const undoLabel = (h: History<unknown>) => (h.past.length ? h.label : null)
/** The name of the step Redo would bring back, or null. */
export const redoLabel = (h: History<unknown>) => (h.future.length ? h.futureLabels[0] : null)
