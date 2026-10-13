/**
 * Retouching finished on the CPU: the Healing Brush and the Spot Healing
 * Brush when the pen lifts, and the Patch tool. Each works on a window of
 * the layer round what's covered (a stroke's dabs, through the CPU
 * reference, so it covers exactly what the GPU painted; or a selection):
 *
 * - healing (the Healing Brush, Patch) takes the source's texture with the
 *   destination's colour and tone at the edge (retouch/heal.ts);
 * - spot healing fills what's covered from round it, by content-aware
 *   fill's PatchMatch (retouch/inpaint.ts) in its worker.
 *
 * Either is mixed with the layer by how much each pixel is covered, and
 * written as a new tile set. The layer must be on whole pixels, unturned:
 * healing reads and writes it pixel for pixel. In a tiled document the
 * source reads round the canvas's edges.
 */
import { dabMask, type LayerDab } from '../brush/dab'
import { tileWraps, type Tiling } from '../doc/types'
import { heal } from '../retouch/heal'
import { readTiles } from '../render/readback'
import type { Renderer } from '../render/renderer'
import { CoverReader, coverForTile, exactBounds } from '../tiles/coverage'
import { TILE, TILE_PIXELS, newSamples, type Samples, type TileFormat } from '../tiles/format'
import type { TileId } from '../tiles/store'
import { inpaintInWorker } from './fillHost'
import { store } from './tileHost'

/** What's retouched: a window of the layer, in its pixels, and how much each pixel of it is covered. */
export interface RetouchArea {
  key: string
  layer: string | null
  format: TileFormat
  transform: number[]
  /** The window: its first pixel and size, in the layer's pixels. */
  rect: [number, number, number, number]
  k: Float32Array
}

const planesOf = (f: TileFormat) => (f.mode === 'rgb' ? 4 : f.mode === 'gray' ? 2 : 5)

/** Whether a transform is a move by whole pixels, nothing more. */
export const onWholePixels = (t: number[]) => t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1 && Number.isInteger(t[4]) && Number.isInteger(t[5])

const NOT_PLAIN = 'Healing works on a layer that isn’t turned or scaled, on whole pixels: rasterize it first, or use the Clone Stamp.'

/**
 * Pixels of tile sets read one at a time, in working terms: premultiplied,
 * CMYK as light. Tiles are read once each.
 */
class PixelReader {
  private tiles = new Map<string, Samples | null>()
  constructor(
    private f: TileFormat,
    private get: (tx: number, ty: number) => Promise<Samples | null>,
  ) {}
  private async tile(tx: number, ty: number) {
    const key = `${tx},${ty}`
    if (!this.tiles.has(key)) this.tiles.set(key, await this.get(tx, ty))
    return this.tiles.get(key)!
  }
  /** A window of pixels, `planes` values each, row by row; `map` moves each pixel to where it's read from. */
  async window(x0: number, y0: number, w: number, h: number, map: (x: number, y: number) => [number, number] = (x, y) => [x, y]): Promise<Float32Array> {
    const planes = planesOf(this.f)
    const max = this.f.depth === 16 ? 65535 : 255
    const cmyk = this.f.mode === 'cmyk'
    const out = new Float32Array(w * h * planes)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const [sx, sy] = map(x0 + x, y0 + y)
        const t = await this.tile(Math.floor(sx / TILE), Math.floor(sy / TILE))
        if (!t) continue
        const i = (sy - Math.floor(sy / TILE) * TILE) * TILE + (sx - Math.floor(sx / TILE) * TILE)
        const a = t[(planes - 1) * TILE_PIXELS + i] / max
        const o = (y * w + x) * planes
        out[o + planes - 1] = a
        for (let c = 0; c < planes - 1; c++) {
          const v = t[c * TILE_PIXELS + i] / max
          out[o + c] = (cmyk ? 1 - v : v) * a
        }
      }
    return out
  }
}

const layerReader = (layer: string | null, f: TileFormat) =>
  new PixelReader(f, async (tx, ty) => {
    const id = layer ? store.tileAt(layer, tx, ty) : undefined
    return id === undefined ? null : store.samples(id)
  })

/** Working pixels written back into a layer's set where `k` covers them; the rest of the set shared. */
async function writeWindow(layer: string | null, f: TileFormat, x0: number, y0: number, w: number, h: number, pixels: Float32Array, k: Float32Array): Promise<string | null> {
  const planes = planesOf(f)
  const max = f.depth === 16 ? 65535 : 255
  const cmyk = f.mode === 'cmyk'
  const changes: [number, number, TileId | null][] = []
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + h - 1) / TILE); ty++)
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + w - 1) / TILE); tx++) {
      const id = layer ? store.tileAt(layer, tx, ty) : undefined
      const out = newSamples(f)
      if (id !== undefined) out.set(await store.samples(id))
      let changed = false
      for (let y = Math.max(y0, ty * TILE); y < Math.min(y0 + h, (ty + 1) * TILE); y++)
        for (let x = Math.max(x0, tx * TILE); x < Math.min(x0 + w, (tx + 1) * TILE); x++) {
          const p = (y - y0) * w + (x - x0)
          if (k[p] <= 0) continue
          changed = true
          const i = (y - ty * TILE) * TILE + (x - tx * TILE)
          const a = Math.min(1, Math.max(0, pixels[p * planes + planes - 1]))
          out[(planes - 1) * TILE_PIXELS + i] = Math.round(a * max)
          for (let c = 0; c < planes - 1; c++) {
            const v = a > 0 ? Math.min(1, Math.max(0, pixels[p * planes + c] / a)) : 0
            out[c * TILE_PIXELS + i] = Math.round((cmyk ? 1 - v : v) * max)
          }
        }
      if (!changed) continue
      let any = false
      for (let i = 0; i < TILE_PIXELS; i++) if (out[(planes - 1) * TILE_PIXELS + i]) any = true
      changes.push([tx, ty, any ? store.data(f, out) : null])
    }
  if (!changes.length) return layer
  if (layer) return store.derive(layer, changes)
  return store.createSet(f, changes.filter((c): c is [number, number, TileId] => c[2] !== null))
}

/**
 * How much each layer pixel of a window a stroke's dabs cover, as the
 * stroke built it: each dab's tip times its flow, up towards its opacity
 * (render/ref/paint.ts stamp), on the canvas, times the selection's share.
 * With `full`, up towards all of it, whatever the dabs' opacity.
 */
export async function dabCoverage(dabs: LayerDab[], t: number[], width: number, height: number, selection: string | null, full = false): Promise<{ rect: [number, number, number, number]; k: Float32Array } | null> {
  if (!dabs.length) return null
  const ix = (v: number) => Math.floor(v)
  // The canvas in the layer's pixels (a move by whole pixels).
  const cx0 = -t[4]
  const cy0 = -t[5]
  const x0 = Math.max(cx0, ix(Math.min(...dabs.map((d) => d.box[0]))))
  const y0 = Math.max(cy0, ix(Math.min(...dabs.map((d) => d.box[1]))))
  const x1 = Math.min(cx0 + width, ix(Math.max(...dabs.map((d) => d.box[2]))) + 1)
  const y1 = Math.min(cy0 + height, ix(Math.max(...dabs.map((d) => d.box[3]))) + 1)
  if (x1 <= x0 || y1 <= y0) return null
  const w = x1 - x0
  const h = y1 - y0
  const k = new Float32Array(w * h)
  for (const d of dabs) {
    const bx0 = Math.max(x0, ix(d.box[0]))
    const by0 = Math.max(y0, ix(d.box[1]))
    const bx1 = Math.min(x1 - 1, ix(d.box[2]))
    const by1 = Math.min(y1 - 1, ix(d.box[3]))
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        const m = dabMask(d, x + 0.5, y + 0.5)
        const wgt = m * d.flow
        if (wgt <= 0) continue
        const p = (y - y0) * w + (x - x0)
        // Spot healing fills all the way, whatever the opacity its preview is painted at.
        const top = full ? 1 : d.opacity
        if (k[p] < top) k[p] += (top - k[p]) * wgt
      }
  }
  if (selection && store.hasSet(selection)) {
    const reader = new CoverReader(store, selection)
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y1 - 1) / TILE); ty++)
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x1 - 1) / TILE); tx++) {
        const cov = await coverForTile(reader, t, tx, ty)
        for (let y = Math.max(y0, ty * TILE); y < Math.min(y1, (ty + 1) * TILE); y++)
          for (let x = Math.max(x0, tx * TILE); x < Math.min(x1, (tx + 1) * TILE); x++) k[(y - y0) * w + (x - x0)] *= cov[(y - ty * TILE) * TILE + (x - tx * TILE)]
      }
  }
  return { rect: [x0, y0, w, h], k }
}

/** A selection's coverage over the layer, in its pixels: what Patch heals. */
export async function selectionCoverage(selection: string, t: number[]): Promise<{ rect: [number, number, number, number]; k: Float32Array } | null> {
  const b = await exactBounds(store, selection)
  if (!b) return null
  // Document to layer pixels: a move by whole pixels.
  const rect: [number, number, number, number] = [b[0] - t[4], b[1] - t[5], b[2] - b[0], b[3] - b[1]]
  const cover = await new CoverReader(store, selection).window(b[0], b[1], rect[2], rect[3])
  return { rect, k: cover }
}

/**
 * Heals (with a source `offset`, document pixels: the source is where a
 * pixel is plus it) or spot-heals an area of a layer. Returns the layer's
 * new set.
 */
export async function retouchArea(r: Renderer, a: RetouchArea, how: { kind: 'heal'; offset: [number, number]; sampleAll: boolean } | { kind: 'spot'; seed: number }): Promise<string | null> {
  if (!onWholePixels(a.transform)) throw new Error(NOT_PLAIN)
  const s = r.docState(a.key)
  const doc = s?.scene.doc
  if (!s || !doc) throw new Error('That document isn’t in the engine')
  const t = a.transform
  const planes = planesOf(a.format)
  // A margin round the area, for the healing's edge (and, spot healing, for something to fill it from).
  const [rx, ry, rw, rh] = a.rect
  const span = Math.max(rw, rh)
  const m = how.kind === 'heal' ? 2 : Math.max(32, Math.min(span, 512))
  const cx0 = -t[4]
  const cy0 = -t[5]
  const x0 = Math.max(cx0, rx - m)
  const y0 = Math.max(cy0, ry - m)
  const x1 = Math.min(cx0 + doc.width, rx + rw + m)
  const y1 = Math.min(cy0 + doc.height, ry + rh + m)
  const w = x1 - x0
  const h = y1 - y0
  const k = new Float32Array(w * h)
  for (let y = 0; y < rh; y++)
    for (let x = 0; x < rw; x++) {
      const yy = ry + y - y0
      const xx = rx + x - x0
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) k[yy * w + xx] = a.k[y * rw + x]
    }
  const dest = await layerReader(a.layer, a.format).window(x0, y0, w, h)
  let result: Float32Array
  if (how.kind === 'heal') {
    const wrap = tileWraps(doc.tiled as Tiling | undefined)
    const mod = (v: number, n: number) => ((v % n) + n) % n
    // A layer pixel's source, in document pixels, wrapped round a tiled document's edges.
    const toSource = (x: number, y: number): [number, number] => {
      let dx = x + t[4] + how.offset[0]
      let dy = y + t[5] + how.offset[1]
      if (wrap.x) dx = mod(dx, doc.width)
      if (wrap.y) dy = mod(dy, doc.height)
      return [dx, dy]
    }
    let source: Float32Array
    if (how.sampleAll) {
      // The document as it shows, round the source.
      const sx0 = x0 + t[4] + how.offset[0]
      const sy0 = y0 + t[5] + how.offset[1]
      const range: [number, number, number, number] = wrap.x || wrap.y ? [0, 0, Math.ceil(doc.width / TILE) - 1, Math.ceil(doc.height / TILE) - 1] : [Math.floor(sx0 / TILE), Math.floor(sy0 / TILE), Math.floor((sx0 + w - 1) / TILE), Math.floor((sy0 + h - 1) / TILE)]
      const tiles = new Map<string, Samples>()
      await readTiles(r, s, range, (job) => r.renderTile(job), (tx, ty, sm) => tiles.set(`${tx},${ty}`, sm))
      source = await new PixelReader(a.format, async (tx, ty) => tiles.get(`${tx},${ty}`) ?? null).window(x0, y0, w, h, toSource)
    } else {
      // The layer itself, round the source: document pixels back into the layer's.
      source = await layerReader(a.layer, a.format).window(x0, y0, w, h, (x, y) => {
        const [dx, dy] = toSource(x, y)
        return [dx - t[4], dy - t[5]]
      })
    }
    result = heal({ dest, source, k, width: w, height: h, stride: planes })
  } else {
    // Spot healing: everything the stroke touches made again from round it, then mixed in by how much it covers.
    const image = new Uint8Array(w * h * planes)
    const cmyk = a.format.mode === 'cmyk'
    for (let p = 0; p < w * h; p++) {
      const al = dest[p * planes + planes - 1]
      image[p * planes + planes - 1] = Math.round(al * 255)
      for (let c = 0; c < planes - 1; c++) {
        const v = al > 0 ? dest[p * planes + c] / al : 0
        image[p * planes + c] = Math.round((cmyk ? 1 - v : v) * 255)
      }
    }
    const hole = new Float32Array(w * h)
    for (let i = 0; i < hole.length; i++) hole[i] = k[i] > 0 ? 1 : 0
    const made = await inpaintInWorker({ image, channels: planes, width: w, height: h, hole, seed: how.seed })
    result = new Float32Array(dest)
    for (let p = 0; p < w * h; p++) {
      const kk = k[p]
      if (kk <= 0) continue
      const al = made[p * planes + planes - 1] / 255
      for (let c = 0; c < planes; c++) {
        const v = c === planes - 1 ? al : (cmyk ? 1 - made[p * planes + c] / 255 : made[p * planes + c] / 255) * al
        result[p * planes + c] = dest[p * planes + c] + (v - dest[p * planes + c]) * kk
      }
    }
  }
  return writeWindow(a.layer, a.format, x0, y0, w, h, result, k)
}
