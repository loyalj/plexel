/**
 * Pen samples from the page to the engine worker through shared memory
 * (ARCHITECTURE.md, "The threads"): the page's pointer handler writes each
 * sample into a ring as it arrives, and the worker reads whatever is there
 * at the start of each frame. Painting never waits on React or on the
 * worker's message queue.
 *
 * One writer, one reader. Indices only grow; a slot is `index % SLOTS`.
 * The writer publishes with an atomic store after the sample's numbers are
 * in place, so the reader never sees half a sample. A full ring (a worker
 * that hasn't drawn for over a thousand samples) tells the writer, which
 * sends the sample as a message instead.
 *
 * Without cross-origin isolation there's no SharedArrayBuffer, and every
 * sample goes as a message; nothing else changes.
 */
import type { PenSample } from '../brush/stroke'

export const SLOTS = 2048
/** Per sample: stroke id, x, y, pressure, tiltX, tiltY, twist, time. */
const WIDTH = 8

export interface Ring {
  buffer: SharedArrayBuffer
}

export function createRing(): Ring | null {
  if (typeof SharedArrayBuffer === 'undefined' || !(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) return null
  return { buffer: new SharedArrayBuffer(8 + SLOTS * WIDTH * 8) }
}

const views = (r: Ring) => ({ head: new Int32Array(r.buffer, 0, 2), data: new Float64Array(r.buffer, 8, SLOTS * WIDTH) })

export class RingWriter {
  private v
  constructor(r: Ring) {
    this.v = views(r)
  }

  /** Writes a sample; false when the ring is full. */
  push(stroke: number, s: PenSample): boolean {
    const w = Atomics.load(this.v.head, 0)
    const r = Atomics.load(this.v.head, 1)
    if (w - r >= SLOTS) return false
    const o = (w % SLOTS) * WIDTH
    this.v.data.set([stroke, s.x, s.y, s.pressure, s.tiltX, s.tiltY, s.twist, s.t], o)
    Atomics.store(this.v.head, 0, w + 1)
    return true
  }
}

export class RingReader {
  private v
  constructor(r: Ring) {
    this.v = views(r)
  }

  /** Every sample written since the last drain, oldest first. */
  drain(): { stroke: number; sample: PenSample }[] {
    const w = Atomics.load(this.v.head, 0)
    let r = Atomics.load(this.v.head, 1)
    const out: { stroke: number; sample: PenSample }[] = []
    for (; r < w; r++) {
      const o = (r % SLOTS) * WIDTH
      const d = this.v.data
      out.push({ stroke: d[o], sample: { x: d[o + 1], y: d[o + 2], pressure: d[o + 3], tiltX: d[o + 4], tiltY: d[o + 5], twist: d[o + 6], t: d[o + 7] } })
    }
    Atomics.store(this.v.head, 1, r)
    return out
  }
}
