/**
 * Long jobs the page waits on (content-aware fill, opening a PSD, applying
 * a filter): a bar over the canvas saying what's working and how far it's
 * got, with Cancel (and Esc). The rest of the interface keeps going.
 *
 * `runJob` gives the work a job id to pass to the engine call, which
 * reports progress for it (engine/jobs.ts). Cancel tells the engine, which
 * stops where it can, and the job's promise rejects with a `Cancelled` at
 * once, whatever the engine is still finishing; callers catch it and do
 * nothing more.
 */
import { engine } from '../engine/EngineHost'
import { Listeners } from '../lib/listeners'

export class Cancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

export const isCancelled = (e: unknown) => e instanceof Cancelled || (e instanceof Error && e.name === 'CancelledError')

export interface Job {
  id: string
  label: string
  /** 0..1, or null while how far isn't known. */
  fraction: number | null
  started: number
  cancel(): void
}

let jobs: Job[] = []
let next = 1
const changes = new Listeners()
const set = (j: Job[]) => {
  jobs = j
  changes.emit()
}

export const jobList = {
  get: () => jobs,
  subscribe: (l: () => void) => changes.subscribe(l),
}

/** Runs `work` as a job the bar shows, with `label` saying what it is. */
export function runJob<T>(label: string, work: (job: string) => Promise<T>): Promise<T> {
  const id = `job-${next++}`
  return new Promise<T>((resolve, reject) => {
    let over = false
    const finish = () => {
      over = true
      off()
      set(jobs.filter((j) => j.id !== id))
    }
    const job: Job = {
      id,
      label,
      fraction: null,
      started: performance.now(),
      cancel: () => {
        if (over) return
        engine().cancelJob(id)
        finish()
        reject(new Cancelled())
      },
    }
    const off = engine().onProgress(id, (fraction) => {
      if (!over) set(jobs.map((j) => (j.id === id ? { ...j, fraction } : j)))
    })
    set([...jobs, job])
    work(id).then(
      (v) => {
        if (over) return
        finish()
        resolve(v)
      },
      (e) => {
        if (over) return
        finish()
        reject(isCancelled(e) ? new Cancelled() : e)
      },
    )
  })
}

/** Calls off the job started last, as Esc does. */
export function cancelLastJob(): boolean {
  const j = jobs[jobs.length - 1]
  if (!j) return false
  j.cancel()
  return true
}
