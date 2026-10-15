/**
 * What every store on the page has: functions to call when it changes.
 *
 * Stores keep their own state and say when it's changed (`emit`); React
 * reads them through useSyncExternalStore, which wants a stable subscribe
 * and a snapshot that's the same object until something changes.
 */
export class Listeners {
  private fns = new Set<() => void>()

  /** Bound, so it can be handed on as it is (to useSyncExternalStore). */
  readonly subscribe = (fn: () => void) => {
    this.fns.add(fn)
    return () => {
      this.fns.delete(fn)
    }
  }

  emit() {
    for (const fn of this.fns) fn()
  }
}
