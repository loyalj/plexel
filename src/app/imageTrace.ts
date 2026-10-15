/**
 * Image Trace from the page's side (trace/trace.ts does the tracing, in a
 * worker of its own): the selected layer's pixels, as it draws on its own,
 * traced with the dialog's settings, the result shown on the canvas as it
 * would be, and committed as one step: a group of shapes (one per colour)
 * just above the layer, the layer hidden if asked.
 *
 * The layer is read once (in sRGB, made smaller first when it's larger than
 * `MAX_SIDE` a side), and traced again in the worker as the settings
 * change; a trace that's overtaken by a newer one is let go.
 */
import { insertNode, setVisible, addVector } from '../doc/edit'
import { makeNode } from '../doc/nodes'
import { freshName, placeOf } from '../doc/tree'
import type { Doc, NodeId } from '../doc/types'
import { fillItem, solid } from '../doc/vector'
import { transformPath } from '../geom/path'
import { shrinkForTrace, type TraceOptions, type TraceResult } from '../trace/trace'
import type { TraceReply, TraceRequest } from '../trace/worker'
import { engine } from '../engine/EngineHost'
import { colourEngine } from './colour'
import { colourSettings } from './colourSettings'
import { documents, newId, type OpenDoc } from './documents'

/** The longest side traced; a larger layer is averaged down first (the result scaled back up). */
export const MAX_SIDE = 2400

/** Layers Image Trace takes: whatever is drawn as pixels. */
const TRACEABLE = new Set(['pixel', 'embedded', 'smart', 'fill'])

export function canTrace(d: OpenDoc | null): boolean {
  const n = d?.selected ? d.history.present.nodes[d.selected] : undefined
  return !!n && TRACEABLE.has(n.kind)
}

const hex2 = (v: number) => v.toString(16).padStart(2, '0')

export interface TraceSession {
  key: string
  source: NodeId
  /** The image traced: its size, and where it lies in the document. */
  width: number
  height: number
  trace(o: TraceOptions): Promise<TraceResult | null>
  preview(r: TraceResult, hideSource: boolean): void
  commit(r: TraceResult, hideSource: boolean): void
  close(): void
}

/** Starts tracing the selected layer: its pixels read and sent to the worker. Null (and why) when there's nothing to trace. */
export async function startTrace(): Promise<TraceSession | { error: string }> {
  const d = documents().active()
  if (!d || !canTrace(d)) return { error: 'Select a pixel layer (or a placed image) to trace.' }
  const doc = d.history.present
  const source = d.selected!
  const { renderPart } = await import('./exports')
  const img = await renderPart(doc, [source], true, true)
  if (!img || !img.w || !img.h) return { error: 'The layer has nothing in it to trace.' }
  const small = shrinkForTrace(img.data, img.w, img.h, MAX_SIDE)
  const worker = new Worker(new URL('../trace/worker.ts', import.meta.url), { type: 'module', name: 'plexel-trace' })
  worker.postMessage({ kind: 'image', rgba: small.rgba, w: small.w, h: small.h } satisfies TraceRequest, [small.rgba.buffer])
  const { converter } = await colourEngine()
  let latest = 0
  const waiting = new Map<number, (r: TraceResult | null) => void>()
  worker.onmessage = (e: MessageEvent<TraceReply>) => {
    const done = waiting.get(e.data.id)
    waiting.delete(e.data.id)
    // Overtaken by a newer trace: nobody wants it.
    done?.(e.data.ok && e.data.id === latest ? e.data.result : null)
  }
  /** The traced shapes as a document: a group above the source, one shape per colour, in the document's colours. */
  const docWith = (x: Doc, r: TraceResult, hideSource: boolean): Doc => {
    const place = placeOf(x, source)
    if (!place) return x
    const { intent, blackPointCompensation } = colourSettings.get()
    const gid = newId('n')
    let y = insertNode(x, makeNode('group', gid, freshName(x, 'Image Trace')), place.parent, place.index + 1)
    const toDoc = [small.scale, 0, 0, small.scale, img.x, img.y]
    r.layers.forEach((l, i) => {
      const c = converter.convert({ space: 'rgb', profile: { builtin: 'srgb' }, c: l.colour.map((v) => v / 255) }, { space: x.mode, profile: x.profile }, intent, blackPointCompensation).c
      const name = l.colour.every((v) => v === 0) ? 'Black' : l.colour.every((v) => v === 255) ? 'White' : `#${l.colour.map(hex2).join('')}`
      y = addVector(y, newId('n'), name, { kind: 'path', path: transformPath(l.path, toDoc) }, [fillItem(solid(c))], gid, i)
    })
    if (hideSource) y = setVisible(y, source, false)
    return y
  }
  let group: NodeId | null = null
  return {
    key: d.key,
    source,
    width: small.w,
    height: small.h,
    trace(options) {
      const id = ++latest
      return new Promise((resolve) => {
        waiting.set(id, resolve)
        worker.postMessage({ kind: 'trace', id, options } satisfies TraceRequest)
      })
    },
    preview(r, hideSource) {
      const now = documents().get(d.key)
      if (now) engine().setScene(d.key, docWith(now.history.present, r, hideSource))
    },
    commit(r, hideSource) {
      documents().commit(
        (x) => {
          const y = docWith(x, r, hideSource)
          const place = placeOf(x, source)
          group = place ? ((y.nodes[place.parent].children ?? [])[place.index + 1] ?? null) : null
          return y
        },
        { key: d.key, label: 'Image Trace' },
      )
      if (group) documents().select(group, d.key)
    },
    close() {
      worker.terminate()
      for (const f of waiting.values()) f(null)
      waiting.clear()
      const now = documents().get(d.key)
      if (now) engine().setScene(d.key, now.history.present)
    },
  }
}
