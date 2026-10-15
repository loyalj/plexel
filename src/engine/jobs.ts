/**
 * Long jobs in the engine (content-aware fill, opening a PSD, baking a
 * filter): their progress to the page, and the page's cancel to them.
 *
 * A call that can take a while carries a `job` id. The job reports how far
 * it's got (`progress`, at most ten times a second), and polls whether
 * it's been called off at its checkpoints (`checkpoint`), which also give
 * the worker's queue a turn so the cancel can arrive. Work that runs in a
 * worker of its own (the inpainting) is stopped outright (`whenCancelled`).
 * A cancelled job throws a `cancelled` error the page expects.
 */
import type { FromEngine } from './protocol'

let send: ((m: FromEngine) => void) | null = null
const cancelled = new Set<string>()
const stoppers = new Map<string, Set<() => void>>()
const last = new Map<string, number>()
let lastYield = 0

/** The worker's postMessage, given once. */
export function setJobPost(fn: (m: FromEngine) => void) {
  send = fn
}

export function cancelledError(): Error {
  const e = new Error('cancelled')
  e.name = 'CancelledError'
  return e
}

/** How far a job has got, 0..1 (null: working, but how far isn't known). */
export function progress(job: string | undefined, fraction: number | null) {
  if (!job || !send) return
  const now = performance.now()
  if (fraction !== null && fraction < 1 && now - (last.get(job) ?? 0) < 100) return
  last.set(job, now)
  send({ type: 'progress', job, fraction })
}

/** The page called the job off. */
export function cancelJob(job: string) {
  cancelled.add(job)
  for (const fn of stoppers.get(job) ?? []) fn()
  stoppers.delete(job)
}

export const isCancelled = (job: string | undefined) => !!job && cancelled.has(job)

/** Runs `fn` if the job's called off; returns a function that stops listening. */
export function whenCancelled(job: string | undefined, fn: () => void): () => void {
  if (!job) return () => {}
  if (cancelled.has(job)) {
    fn()
    return () => {}
  }
  const set = stoppers.get(job) ?? new Set()
  set.add(fn)
  stoppers.set(job, set)
  return () => set.delete(fn)
}

/**
 * A place a job may stop: throws if it's been called off. Now and then it
 * lets the worker's queue run, so the cancel can come in at all while the
 * job works through promises that settle at once.
 */
export async function checkpoint(job: string | undefined, fraction?: number | null) {
  if (!job) return
  if (fraction !== undefined) progress(job, fraction)
  const now = performance.now()
  if (now - lastYield > 40) {
    lastYield = now
    await new Promise((r) => setTimeout(r, 0))
  }
  if (cancelled.has(job)) throw cancelledError()
}

/** A job over: its record let go. */
export function endJob(job: string | undefined) {
  if (!job) return
  cancelled.delete(job)
  stoppers.delete(job)
  last.delete(job)
}
