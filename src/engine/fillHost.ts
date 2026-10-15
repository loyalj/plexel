/**
 * Fills, as the engine worker runs them: Edit → Fill's contents (a colour,
 * a pattern, content-aware), the Gradient tool and the Paint Bucket, laid
 * onto a pixel layer or a mask through the selection with a blend mode and
 * an opacity. The work is tiles/fill.ts's; content-aware fill's search is
 * retouch/inpaint.ts's, run in a worker of its own.
 */
import { tileWraps, type BlendModeId, type ColourMode } from '../doc/types'
import type { Paint } from '../doc/vector'
import { CoverReader, exactBounds } from '../tiles/coverage'
import { fillLayer, type FillSource } from '../tiles/fill'
import { TILE, TILE_PIXELS, newSamples, type Samples, type TileFormat } from '../tiles/format'
import type { TileId } from '../tiles/store'
import { patternPixels } from '../tiles/patterns'
import { keepPlanes } from '../tiles/planes'
import { gradientAnchor, paintParams, patternLevels, type PatternImage } from '../vector/paint'
import type { Renderer } from '../render/renderer'
import { held } from './tileHost'
import { guarded } from './work'
import { store } from './tileHost'
import { cancelledError, progress, whenCancelled } from './jobs'

export interface FillCommon {
  /** The document, for its patterns. */
  key: string
  /** The layer's (or mask's) tiles; null for none yet. */
  layer: string | null
  format: TileFormat
  /** Layer pixels to document pixels. */
  transform: number[]
  /** Where the fill goes, as coverage; null for the whole canvas. */
  cover: string | null
  width: number
  height: number
  blend: BlendModeId
  opacity: number
  preserve: boolean
}

export interface FillCalls {
  /** A paint, its colours already in the layer's mode, laid out in document pixels. Returns the layer's new set (null: left empty). */
  'fill.paint': { args: FillCommon & { paint: Paint }; result: string | null }
  /** Content-aware fill: what the selection covers made again from the layer's pixels round it. */
  'fill.contentAware': { args: FillCommon & { seed: number; job?: string }; result: string | null }
  /** An edit kept to some colour channels: `after` with the others, and alpha, as they were in `before` (tiles/planes.ts). */
  'fill.keepPlanes': { args: { before: string | null; after: string | null; planes: boolean[] }; result: string | null }
  /** A rectangle of a set's pixels moved to the origin: a pattern's one repeat (Define Pattern). Null when it's empty. */
  'fill.crop': { args: { set: string; rect: [number, number, number, number] }; result: string | null }
}

/** The widest region content-aware fill searches, a side, around what it fills. */
const AWARE_MAX = 3072

const patternCache = new Map<string, PatternImage>()

/** A document's pattern, its pyramid made once per tile set. */
async function patternImage(r: Renderer, key: string, id: string): Promise<PatternImage | undefined> {
  const p = r.docState(key)?.scene.doc?.patterns?.find((x) => x.id === id)
  if (!p || !store.hasSet(p.tiles)) return undefined
  let img = patternCache.get(p.tiles)
  if (!img) {
    img = { key: p.tiles, w: p.width, h: p.height, levels: patternLevels(p.width, p.height, await patternPixels(store, p.tiles, p.width, p.height)) }
    patternCache.set(p.tiles, img)
    if (patternCache.size > 16) patternCache.delete(patternCache.keys().next().value!)
  }
  return img
}

/** Where a fill can reach, in document pixels: the selection's bounds, or the canvas. */
async function reach(a: FillCommon): Promise<[number, number, number, number] | null> {
  const canvas: [number, number, number, number] = [0, 0, a.width, a.height]
  if (!a.cover) return canvas
  const b = await exactBounds(store, a.cover)
  if (!b) return null
  return [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(a.width, b[2]), Math.min(a.height, b[3])]
}

function finish(a: FillCommon, set: string | null): string | null {
  return set === a.layer ? set : held(set)
}

/**
 * Runs content-aware fill's search in a worker of its own, its progress
 * reported for `id` (a page's job), and stopped outright if that's called off.
 */
export function inpaintInWorker(job: { image: Uint8Array; channels: number; width: number; height: number; hole: Float32Array; seed: number }, id?: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../retouch/inpaint.worker.ts', import.meta.url), { type: 'module', name: 'plexel-content-aware' })
    const stop = whenCancelled(id, () => {
      w.terminate()
      reject(cancelledError())
    })
    w.onmessage = (e: MessageEvent<{ ok: true; image: Uint8Array } | { ok: false; error: string } | { progress: number }>) => {
      if ('progress' in e.data) return progress(id, e.data.progress)
      w.terminate()
      stop()
      if (e.data.ok) resolve(e.data.image)
      else reject(new Error(e.data.error))
    }
    w.onerror = (e) => {
      w.terminate()
      stop()
      reject(new Error(e.message || 'Content-aware fill stopped'))
    }
    w.postMessage(job, [job.image.buffer, job.hole.buffer])
  })
}

export function fillHandlers(renderer: () => Promise<Renderer>): { [M in keyof FillCalls]: (args: FillCalls[M]['args']) => Promise<FillCalls[M]['result']> } {
  return {
    'fill.keepPlanes': ({ before, after, planes }) => guarded(async () => held(await keepPlanes(store, before, after, planes))),
    'fill.crop': ({ set, rect }) =>
      guarded(async () => {
        const f = store.getSet(set).format
        const planes = f.mode === 'rgb' ? 4 : f.mode === 'gray' ? 2 : 5
        const [x0, y0, x1, y1] = rect
        const made: [number, number, Samples][] = []
        for (let ty = 0; ty * TILE < y1 - y0; ty++) {
          for (let tx = 0; tx * TILE < x1 - x0; tx++) {
            const out = newSamples(f)
            let any = false
            for (let y = 0; y < TILE && ty * TILE + y < y1 - y0; y++) {
              const sy = y0 + ty * TILE + y
              for (let x = 0; x < TILE && tx * TILE + x < x1 - x0; x++) {
                const sx = x0 + tx * TILE + x
                const id = store.tileAt(set, Math.floor(sx / TILE), Math.floor(sy / TILE))
                if (id === undefined) continue
                const s = await store.samples(id)
                const si = (sy - Math.floor(sy / TILE) * TILE) * TILE + (sx - Math.floor(sx / TILE) * TILE)
                for (let c = 0; c < planes; c++) out[c * TILE_PIXELS + y * TILE + x] = s[c * TILE_PIXELS + si]
                if (s[(planes - 1) * TILE_PIXELS + si]) any = true
              }
            }
            if (any) made.push([tx, ty, out])
          }
        }
        if (!made.length) return null
        return held(store.createSet(f, made.map(([tx, ty, s]): [number, number, TileId] => [tx, ty, store.data(f, s)])))
      }),
    'fill.paint': (a) =>
      guarded(async () => {
        const bounds = await reach(a)
        if (!bounds) return a.layer
        const r = await renderer()
        const mode: ColourMode = a.format.mode
        // A pattern's pyramid, if the paint is one of the document's.
        const img = a.paint.kind === 'pattern' ? await patternImage(r, a.key, a.paint.pattern) : undefined
        const params = paintParams(a.paint, mode, [1, 0, 0, 1, 0, 0], [0, 0, a.width, a.height], () => img)
        // A tiled document's gradient runs on over the seam it was dragged across.
        const w = tileWraps(r.docState(a.key)?.scene.doc?.tiled)
        const anchor = gradientAnchor(a.paint)
        if (anchor && (w.x || w.y)) params.wrap = [w.x ? a.width : 0, w.y ? a.height : 0, anchor[0], anchor[1]]
        const cover = a.cover ? new CoverReader(store, a.cover) : null
        const set = await fillLayer(store, a.layer, a.format, a.transform, cover, bounds, { kind: 'paint', params }, { blend: a.blend, opacity: a.opacity, preserve: a.preserve, seed: seedOf(a.key) })
        return finish(a, set)
      }),
    'fill.contentAware': (a) =>
      guarded(async () => {
        if (!a.cover) throw new Error('Content-aware fill needs a selection: it fills what’s selected from what isn’t.')
        const t = a.transform
        if (t[0] !== 1 || t[1] !== 0 || t[2] !== 0 || t[3] !== 1 || t[4] !== Math.round(t[4]) || t[5] !== Math.round(t[5])) {
          throw new Error('Content-aware fill works on a layer that isn’t scaled or turned. Rasterize it first.')
        }
        const b = await reach(a)
        if (!b) return a.layer
        // The region searched: the selection and as much again round it, inside the canvas.
        const span = Math.max(b[2] - b[0], b[3] - b[1])
        const margin = Math.max(48, Math.min(span, Math.floor((AWARE_MAX - span) / 2)))
        const x0 = Math.max(0, b[0] - margin)
        const y0 = Math.max(0, b[1] - margin)
        const x1 = Math.min(a.width, b[2] + margin)
        const y1 = Math.min(a.height, b[3] + margin)
        const w = x1 - x0
        const h = y1 - y0
        const planes = a.format.mode === 'rgb' ? 4 : a.format.mode === 'gray' ? 2 : 5
        const max = a.format.depth === 16 ? 65535 : 255
        // The layer's pixels in the region, 8-bit, interleaved.
        const image = new Uint8Array(w * h * planes)
        const ox = x0 - t[4]
        const oy = y0 - t[5]
        if (a.layer) {
          for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + h - 1) / TILE); ty++) {
            for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + w - 1) / TILE); tx++) {
              const id = store.tileAt(a.layer, tx, ty)
              if (id === undefined) continue
              const s = await store.samples(id)
              for (let y = Math.max(oy, ty * TILE); y < Math.min(oy + h, (ty + 1) * TILE); y++) {
                for (let x = Math.max(ox, tx * TILE); x < Math.min(ox + w, (tx + 1) * TILE); x++) {
                  const i = (y - ty * TILE) * TILE + (x - tx * TILE)
                  const o = ((y - oy) * w + (x - ox)) * planes
                  for (let c = 0; c < planes; c++) image[o + c] = Math.round((s[c * TILE_PIXELS + i] / max) * 255)
                }
              }
            }
          }
        }
        // Everything the selection touches is made again; the fill then goes on as much as it's selected.
        const cover = await new CoverReader(store, a.cover).window(x0, y0, w, h)
        const hole = new Float32Array(w * h)
        for (let i = 0; i < hole.length; i++) hole[i] = cover[i] > 0 ? 1 : 0
        const made = await inpaintInWorker({ image, channels: planes, width: w, height: h, hole, seed: a.seed }, a.job)
        // Into working terms, premultiplied, for the fill.
        const data = new Float32Array(w * h * 5)
        for (let p = 0; p < w * h; p++) {
          const al = made[p * planes + planes - 1] / 255
          for (let c = 0; c < planes - 1; c++) {
            const v = made[p * planes + c] / 255
            data[p * 5 + c] = (a.format.mode === 'cmyk' ? 1 - v : v) * al
          }
          data[p * 5 + 4] = al
        }
        const src: FillSource = { kind: 'image', x0, y0, w, h, data }
        const set = await fillLayer(store, a.layer, a.format, a.transform, new CoverReader(store, a.cover), b, src, { blend: a.blend, opacity: a.opacity, preserve: a.preserve })
        return finish(a, set)
      }),
  }
}

/** Dissolve's seed for a fill: from the document, so a fill dissolves the same way each time. */
function seedOf(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  return h >>> 0
}

