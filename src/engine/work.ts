/**
 * Work in the engine that may be making tiles nobody holds yet. Calls make
 * tiles with no references while they work (conversion, opening and writing
 * PSD, retouching, selections, fills), and put them into a set only at the
 * end, after awaits; a collection in between would free them. Every call
 * but tiles.gc runs guarded, and tiles.gc waits until none is running.
 *
 * Calls arrive as messages, each its own task, and a waiting collection
 * resumes in a microtask as soon as the count reaches nought, so it runs
 * before the next call starts: busy periods postpone it, they can't starve it.
 */

let running = 0
let settled: (() => void)[] = []

/** Resolves once no guarded work is running. */
export function workIdle(): Promise<void> {
  if (!running) return Promise.resolve()
  return new Promise((resolve) => settled.push(resolve))
}

/** Runs work that may make unheld tiles, keeping collection waiting until it's done. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  running++
  try {
    return await fn()
  } finally {
    running--
    if (!running) for (const r of settled.splice(0)) r()
  }
}
