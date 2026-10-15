/**
 * Content-aware fill in a worker of its own, started by the engine worker,
 * so the canvas keeps drawing while it searches: one job, then it's let go.
 * It says how far it's got as it goes, for the page's progress bar; the
 * engine stops it outright when the job's called off.
 */
import { inpaint, type InpaintInput } from './inpaint'

self.onmessage = (e: MessageEvent<Omit<InpaintInput, 'onProgress' | 'shouldStop'>>) => {
  try {
    let at = -1
    const out = inpaint({
      ...e.data,
      onProgress: (f) => {
        // A message for each hundredth, no more.
        const step = Math.floor(f * 100)
        if (step === at) return
        at = step
        ;(self as unknown as Worker).postMessage({ progress: f })
      },
    })
    ;(self as unknown as Worker).postMessage({ ok: true, image: out }, [out.buffer])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
