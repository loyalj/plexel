/**
 * Image Trace in a worker of its own (app/imageTrace.ts starts it), so the
 * page keeps answering while a photo is traced: one job at a time, the
 * image sent over once and traced again as the settings change.
 */
import { traceImage, type TraceOptions, type TraceResult } from './trace'

let image: { rgba: Uint8ClampedArray; w: number; h: number } | null = null

export type TraceRequest = { kind: 'image'; rgba: Uint8ClampedArray; w: number; h: number } | { kind: 'trace'; id: number; options: TraceOptions }
export type TraceReply = { id: number; ok: true; result: TraceResult } | { id: number; ok: false; error: string }

self.onmessage = (e: MessageEvent<TraceRequest>) => {
  const m = e.data
  if (m.kind === 'image') {
    image = { rgba: m.rgba, w: m.w, h: m.h }
    return
  }
  const post = (r: TraceReply) => (self as unknown as Worker).postMessage(r)
  if (!image) return post({ id: m.id, ok: false, error: 'No image to trace' })
  try {
    post({ id: m.id, ok: true, result: traceImage(image.rgba, image.w, image.h, m.options) })
  } catch (err) {
    post({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
