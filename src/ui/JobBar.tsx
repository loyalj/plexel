/**
 * The bar over the canvas for long jobs (app/jobs.ts): what's working, how
 * far it's got (a moving stripe when that isn't known), Cancel, and Esc to
 * cancel. It waits a moment before showing, so a quick job doesn't flash.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { cancelLastJob, jobList } from '../app/jobs'

const DELAY = 300

export function JobBar() {
  const jobs = useSyncExternalStore(jobList.subscribe, jobList.get)
  const [, tick] = useState(0)
  const job = jobs[jobs.length - 1] ?? null
  // Drawn again once the delay is up, and Esc listened for while there's a job.
  useEffect(() => {
    if (!job) return
    const t = setTimeout(() => tick((n) => n + 1), DELAY)
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // A dialog or a menu takes its own Esc first.
      if (document.querySelector('[data-dialog], [role="menu"]')) return
      e.preventDefault()
      e.stopPropagation()
      cancelLastJob()
    }
    window.addEventListener('keydown', key, true)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', key, true)
    }
  }, [job])
  if (!job || performance.now() - job.started < DELAY) return null
  const pct = job.fraction === null ? null : Math.round(job.fraction * 100)
  return (
    <div className="job-bar" role="status" aria-live="polite" data-job={job.id}>
      <span className="job-label">{job.label}</span>
      <span className={`job-track${pct === null ? ' unknown' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-label={job.label}>
        <span className="job-fill" style={pct === null ? undefined : { width: `${pct}%` }} />
      </span>
      {pct !== null && <span className="job-pct">{pct}%</span>}
      <button type="button" className="button small" data-job-cancel onClick={job.cancel}>
        Cancel <kbd>Esc</kbd>
      </button>
    </div>
  )
}
