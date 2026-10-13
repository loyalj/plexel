/**
 * Content-aware fill in a worker of its own, started by the engine worker,
 * so the canvas keeps drawing while it searches: one job, then it's let go.
 */
import { inpaint, type InpaintInput } from './inpaint'

self.onmessage = (e: MessageEvent<Omit<InpaintInput, 'onProgress' | 'shouldStop'>>) => {
  try {
    const out = inpaint(e.data)
    ;(self as unknown as Worker).postMessage({ ok: true, image: out }, [out.buffer])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
