/**
 * Reading renders back from the GPU: layer thumbnails, the small sRGB
 * previews a .pxll carries, and full-size composites for export.
 *
 * Each renders tiles outside the frame loop, in its own command encoder,
 * and maps a buffer to read them. A tile whose pixels are still coming back
 * from disk makes it wait for them and try again.
 */
import type { DocNode, NodeId } from '../doc/types'
import { makeNode } from '../doc/nodes'
import { TILE, TILE_PIXELS } from '../tiles/format'
import { NotReady } from './residency'
import type { Rect, SceneChannel } from './scene'
import type { Renderer } from './renderer'
import { tileBufferBytes } from './shaders/common'
import type { DisplayProfileId } from '../color/profiles'
import { newSamples, type Samples, type TileFormat } from '../tiles/format'
import { CoverReader, coverForTile } from '../tiles/coverage'
import { FILTER_BY_ID } from '../filters/defs'
import type { TileId, TileStore } from '../tiles/store'

const MAX_TRIES = 50

/** Straight 8-bit RGBA of the whole canvas at a mip level, through a display table. */
export interface Image8 {
  width: number
  height: number
  data: Uint8Array
}

async function retry<T>(fn: () => T): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return fn()
    } catch (e) {
      if (!(e instanceof NotReady) || i >= MAX_TRIES) throw e
      await Promise.allSettled(e.waits)
    }
  }
}

/**
 * A band of `cols` tiles rendered (`renderOne` for each, null where there's
 * nothing) and copied into one staging buffer, tried again while tiles come
 * back from disk; then mapped. Returns the buffer, which tiles were drawn,
 * and the mapping, to wait for when the caller wants the bytes (several
 * bands can be in flight). The caller destroys the buffer.
 */
async function renderBand(r: Renderer, label: string, cols: number, tileBytes: number, renderOne: (tx: number, enc: GPUCommandEncoder) => GPUBuffer | null) {
  const staging = r.device.createBuffer({ label, size: tileBytes * cols, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const present: boolean[] = []
  try {
    await retry(() => {
      present.length = 0
      const enc = r.beginWork()
      try {
        for (let tx = 0; tx < cols; tx++) {
          const buf = renderOne(tx, enc)
          present.push(!!buf)
          if (!buf) continue
          enc.copyBufferToBuffer(buf, 0, staging, tx * tileBytes, tileBytes)
          r.bufferPool.release(buf)
        }
      } finally {
        r.finishWork(enc)
      }
    })
  } catch (e) {
    staging.destroy()
    throw e
  }
  return { staging, present, mapped: staging.mapAsync(GPUMapMode.READ) }
}

/**
 * An alpha or spot channel's coverage over the canvas at a mip level, as
 * the canvas shows it (through its transform, from its mips), one byte a
 * pixel: for the Magic Wand and the Paint Bucket on a channel, and its
 * thumbnail.
 */
export async function readCover8(r: Renderer, key: string, c: SceneChannel, level: number): Promise<{ width: number; height: number; data: Uint8Array }> {
  const s = r.docState(key)
  const doc = s?.scene.doc
  if (!s || !doc) throw new Error('That document isn’t in the engine')
  const span = 2 ** level
  const width = Math.max(1, Math.ceil(doc.width / span))
  const height = Math.max(1, Math.ceil(doc.height / span))
  const cols = Math.ceil(width / TILE)
  const tileBytes = TILE_PIXELS * 4
  const data = new Uint8Array(width * height)
  for (let ty = 0; ty < Math.ceil(height / TILE); ty++) {
    const staging = r.device.createBuffer({ label: 'channel band', size: tileBytes * cols, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    try {
      const constants: (number | null)[] = []
      await retry(() => {
        constants.length = 0
        const enc = r.beginWork()
        try {
          for (let tx = 0; tx < cols; tx++) {
            const v = r.channelTile(r.job(s, level, tx, ty, enc), c)
            if (typeof v === 'number') {
              constants.push(v)
              continue
            }
            constants.push(null)
            enc.copyBufferToBuffer(v, 0, staging, tx * tileBytes, tileBytes)
            r.releaseCover(v)
          }
        } finally {
          r.finishWork(enc)
        }
      })
      await staging.mapAsync(GPUMapMode.READ)
      const f = new Float32Array(staging.getMappedRange())
      const rows = Math.min(TILE, height - ty * TILE)
      for (let tx = 0; tx < cols; tx++) {
        const k = constants[tx]
        const w = Math.min(TILE, width - tx * TILE)
        for (let y = 0; y < rows; y++) {
          const o = (ty * TILE + y) * width + tx * TILE
          if (k !== null) {
            data.fill(Math.round(Math.min(1, Math.max(0, k)) * 255), o, o + w)
            continue
          }
          const b = tx * TILE_PIXELS + y * TILE
          for (let x = 0; x < w; x++) data[o + x] = Math.round(Math.min(1, Math.max(0, f[b + x])) * 255)
        }
      }
      staging.unmap()
    } finally {
      staging.destroy()
    }
  }
  return { width, height, data }
}

/**
 * The document (or one node of it, on its own, at full strength) at the
 * coarsest mip level that's still at least `size` pixels across, as 8-bit
 * RGBA through the table for `target`.
 */
export async function renderSmall(r: Renderer, key: string, node: NodeId | null, size: number, target: DisplayProfileId): Promise<Image8 | null> {
  const s = r.docState(key)
  const doc = s?.scene.doc
  if (!s || !doc) return null
  const lut = r.lutBuffers(s, target)
  if (!lut) return null
  const longest = Math.max(doc.width, doc.height)
  const level = Math.max(0, Math.floor(Math.log2(longest / size)))
  const span = 2 ** level
  const w = Math.max(1, Math.ceil(doc.width / span))
  const h = Math.max(1, Math.ceil(doc.height / span))
  const cols = Math.ceil(w / TILE)
  const rows = Math.ceil(h / TILE)
  const tileBytes = TILE_PIXELS * 4
  const device = r.device
  const out = device.createBuffer({ label: 'readback bytes', size: tileBytes * cols * rows, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
  const staging = device.createBuffer({ label: 'readback', size: out.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const format = r.bufferFormat(doc.mode, doc.depth)
  const temps: GPUBuffer[] = []
  try {
    await retry(() => {
      const enc = r.beginWork()
      try {
        for (let ty = 0; ty < rows; ty++) {
          for (let tx = 0; tx < cols; tx++) {
            const job = r.job(s, level, tx, ty, enc)
            const buf = node ? r.renderNodeTile(job, node) : r.renderTile(job)
            if (!buf) continue
            const tmp = device.createBuffer({ label: 'tile bytes', size: tileBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
            temps.push(tmp)
            r.toBytes(enc, format, lut, buf, tmp)
            enc.copyBufferToBuffer(tmp, 0, out, (ty * cols + tx) * tileBytes, tileBytes)
            r.bufferPool.release(buf)
          }
        }
        enc.copyBufferToBuffer(out, 0, staging, 0, out.size)
      } finally {
        r.finishWork(enc)
      }
    })
    await staging.mapAsync(GPUMapMode.READ)
    const tiles = new Uint8Array(staging.getMappedRange().slice(0))
    staging.unmap()
    const data = new Uint8Array(w * h * 4)
    let any = false
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = Math.floor(y / TILE) * cols + Math.floor(x / TILE)
        const src = t * tileBytes + ((y % TILE) * TILE + (x % TILE)) * 4
        const dst = (y * w + x) * 4
        data.set(tiles.subarray(src, src + 4), dst)
        if (tiles[src + 3]) any = true
      }
    }
    return any ? { width: w, height: h, data } : { width: w, height: h, data: new Uint8Array(0) }
  } finally {
    for (const t of temps) t.destroy()
    out.destroy()
    staging.destroy()
  }
}

/** A box-filtered copy that fits in `size` × `size`, keeping the shape. */
export function shrink(img: Image8, size: number): Image8 {
  const k = Math.min(1, size / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * k))
  const h = Math.max(1, Math.round(img.height * k))
  if (w === img.width && h === img.height) return img
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * img.width + sx) * 4
          const al = img.data[o + 3]
          r += img.data[o] * al
          g += img.data[o + 1] * al
          b += img.data[o + 2] * al
          a += al
          n++
        }
      }
      const o = (y * w + x) * 4
      if (a) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round(a / n)
    }
  }
  return { width: w, height: h, data: out }
}

/** Every half float, as a float: reading back a band of f16 tiles is a lookup a sample. */
const HALVES = (() => {
  const t = new Float32Array(65536)
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1
    const e = (h >> 10) & 0x1f
    const f = h & 0x3ff
    t[h] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15)
  }
  return t
})()
const halfToFloat = (h: number) => HALVES[h]

/**
 * The full-size composite, one band of tile rows at a time: for each band,
 * the working-space pixels (premultiplied floats, `stride` per pixel) of
 * `TILE` rows across the whole width. Only one band is in memory at once.
 */
export async function* compositeBands(r: Renderer, key: string): AsyncGenerator<{ y: number; rows: number; width: number; stride: number; data: Float32Array }> {
  const s = r.docState(key)
  const doc = s?.scene.doc
  if (!s || !doc) throw new Error('That document isn’t in the engine')
  const format = r.bufferFormat(doc.mode, doc.depth)
  const stride = format.mode === 'rgb' ? 4 : format.mode === 'gray' ? 2 : 5
  const tileBytes = tileBufferBytes(format)
  const cols = Math.ceil(doc.width / TILE)
  for (let ty = 0; ty < Math.ceil(doc.height / TILE); ty++) {
    const { staging, present, mapped } = await renderBand(r, 'export band', cols, tileBytes, (tx, enc) => r.renderTile(r.job(s, 0, tx, ty, enc)))
    await mapped
    const raw = staging.getMappedRange()
    const f16 = format.store === 'f16'
    const src16 = f16 ? new Uint16Array(raw) : null
    const src32 = f16 ? null : new Float32Array(raw)
    const rows = Math.min(TILE, doc.height - ty * TILE)
    const data = new Float32Array(doc.width * rows * stride)
    for (let tx = 0; tx < cols; tx++) {
      if (!present[tx]) continue
      const w = Math.min(TILE, doc.width - tx * TILE)
      const base = (tx * tileBytes) / (f16 ? 2 : 4)
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < w; x++) {
          const si = base + (y * TILE + x) * stride
          const di = (y * doc.width + tx * TILE + x) * stride
          for (let c = 0; c < stride; c++) data[di + c] = f16 ? halfToFloat(src16![si + c]) : src32![si + c]
        }
      }
    }
    staging.unmap()
    staging.destroy()
    yield { y: ty * TILE, rows, width: doc.width, stride, data }
  }
}

/**
 * The composite at a document point, averaged over size × size pixels
 * around it (premultiplied, so transparent pixels don't darken the
 * average): the document's own values, 0..1, alpha last. Null off the
 * canvas. What the Colour Picker picks.
 */
export async function samplePoint(r: Renderer, key: string, x: number, y: number, size: number): Promise<number[] | null> {
  const s = r.docState(key)
  const doc = s?.scene.doc
  if (!s || !doc) return null
  const cx = Math.floor(x)
  const cy = Math.floor(y)
  if (cx < 0 || cy < 0 || cx >= doc.width || cy >= doc.height) return null
  const half = Math.floor(size / 2)
  const x0 = Math.max(0, cx - half)
  const y0 = Math.max(0, cy - half)
  const x1 = Math.min(doc.width - 1, cx + half)
  const y1 = Math.min(doc.height - 1, cy + half)
  const format = r.bufferFormat(doc.mode, doc.depth)
  const stride = format.mode === 'rgb' ? 4 : format.mode === 'gray' ? 2 : 5
  const tileBytes = tileBufferBytes(format)
  const tiles: [number, number][] = []
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) tiles.push([tx, ty])
  const device = r.device
  const staging = device.createBuffer({ label: 'sample', size: tileBytes * tiles.length, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const present: boolean[] = []
  try {
    await retry(() => {
      present.length = 0
      const enc = r.beginWork()
      try {
        tiles.forEach(([tx, ty], i) => {
          const buf = r.renderTile(r.job(s, 0, tx, ty, enc))
          present.push(!!buf)
          if (!buf) return
          enc.copyBufferToBuffer(buf, 0, staging, i * tileBytes, tileBytes)
          r.bufferPool.release(buf)
        })
      } finally {
        r.finishWork(enc)
      }
    })
    await staging.mapAsync(GPUMapMode.READ)
    const raw = staging.getMappedRange()
    const f16 = format.store === 'f16'
    const acc = new Array(stride).fill(0)
    let n = 0
    tiles.forEach(([tx, ty], i) => {
      const words = f16 ? new Uint16Array(raw, i * tileBytes, tileBytes / 2) : new Float32Array(raw, i * tileBytes, tileBytes / 4)
      for (let py = Math.max(y0, ty * TILE); py <= Math.min(y1, ty * TILE + TILE - 1); py++) {
        for (let px = Math.max(x0, tx * TILE); px <= Math.min(x1, tx * TILE + TILE - 1); px++) {
          n++
          if (!present[i]) continue
          const o = ((py - ty * TILE) * TILE + (px - tx * TILE)) * stride
          for (let c = 0; c < stride; c++) acc[c] += f16 ? halfToFloat(words[o + c]) : words[o + c]
        }
      }
    })
    staging.unmap()
    const a = acc[stride - 1] / n
    const colour = acc.slice(0, -1).map((v) => (a > 0 ? Math.min(1, Math.max(0, v / n / a)) : 0))
    return [...(doc.mode === 'cmyk' ? colour.map((v) => 1 - v) : colour), Math.min(1, Math.max(0, a))]
  } finally {
    staging.destroy()
  }
}

/**
 * The document (or one node on its own) at mip level `level`, as straight
 * 8-bit values in the document's own terms (CMYK as ink), alpha last: what
 * the magic wand compares. Read a band of tiles at a time, so only the
 * result is ever whole in memory.
 */
export async function readPixels8(r: Renderer, key: string, node: NodeId | null, level: number): Promise<{ width: number; height: number; channels: number; data: Uint8Array }> {
  const s = r.docState(key)
  const doc = s?.scene.doc
  if (!s || !doc) throw new Error('That document isn’t in the engine')
  const span = 2 ** level
  const width = Math.max(1, Math.ceil(doc.width / span))
  const height = Math.max(1, Math.ceil(doc.height / span))
  const format = r.bufferFormat(doc.mode, doc.depth)
  const stride = format.mode === 'rgb' ? 4 : format.mode === 'gray' ? 2 : 5
  const tileBytes = tileBufferBytes(format)
  const cols = Math.ceil(width / TILE)
  const data = new Uint8Array(width * height * stride)
  const cmyk = doc.mode === 'cmyk'
  for (let ty = 0; ty < Math.ceil(height / TILE); ty++) {
    const { staging, present, mapped } = await renderBand(r, 'wand band', cols, tileBytes, (tx, enc) => {
      const job = r.job(s, level, tx, ty, enc)
      return node ? r.renderNodeTile(job, node) : r.renderTile(job)
    })
    try {
      await mapped
      const raw = staging.getMappedRange()
      const f16 = format.store === 'f16'
      const src16 = f16 ? new Uint16Array(raw) : null
      const src32 = f16 ? null : new Float32Array(raw)
      const rows = Math.min(TILE, height - ty * TILE)
      for (let tx = 0; tx < cols; tx++) {
        if (!present[tx]) continue
        const w = Math.min(TILE, width - tx * TILE)
        const base = (tx * tileBytes) / (f16 ? 2 : 4)
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < w; x++) {
            const si = base + (y * TILE + x) * stride
            const di = ((ty * TILE + y) * width + tx * TILE + x) * stride
            const read = (c: number) => (f16 ? halfToFloat(src16![si + c]) : src32![si + c])
            const a = Math.min(1, Math.max(0, read(stride - 1)))
            data[di + stride - 1] = Math.round(a * 255)
            if (a <= 0) {
              if (cmyk) data.fill(0, di, di + stride - 1)
              continue
            }
            for (let c = 0; c < stride - 1; c++) {
              const v = Math.min(1, Math.max(0, read(c) / a))
              data[di + c] = Math.round((cmyk ? 1 - v : v) * 255)
            }
          }
        }
      }
      staging.unmap()
    } finally {
      staging.destroy()
    }
  }
  return { width, height, channels: stride, data }
}

/**
 * Tiles rendered by `renderOne` over the tile range `[tx0, ty0]..[tx1, ty1]`
 * of `s`'s scene at level 0, read back as samples in the document's own
 * numbers (straight, CMYK as ink, at its depth), a band of tiles at a time.
 * Calls `take` with each tile that has anything in it.
 */
/** How many bands a read keeps in flight. */
const READ_AHEAD = 4

export async function readTiles(
  r: Renderer,
  s: NonNullable<ReturnType<Renderer['docState']>>,
  range: [number, number, number, number],
  renderOne: (job: ReturnType<Renderer['job']>) => GPUBuffer | null,
  take: (tx: number, ty: number, samples: Samples) => void,
) {
  const doc = s.scene.doc!
  const f: TileFormat = { mode: doc.mode, depth: doc.depth }
  const format = r.bufferFormat(doc.mode, doc.depth)
  const stride = format.mode === 'rgb' ? 4 : format.mode === 'gray' ? 2 : 5
  const tileBytes = tileBufferBytes(format)
  const max = doc.depth === 16 ? 65535 : 255
  const cmyk = doc.mode === 'cmyk'
  const [tx0, ty0, tx1, ty1] = range
  const cols = tx1 - tx0 + 1
  const f16 = format.store === 'f16'
  /** A band read back: its tiles into samples, the empty ones skipped. */
  const takeBand = (ty: number, staging: GPUBuffer, present: boolean[]) => {
    const raw = staging.getMappedRange()
    const src16 = f16 ? new Uint16Array(raw) : null
    const src32 = f16 ? null : new Float32Array(raw)
    for (let tx = tx0; tx <= tx1; tx++) {
      if (!present[tx - tx0]) continue
      const out = newSamples(f)
      const base = ((tx - tx0) * tileBytes) / (f16 ? 2 : 4)
      let any = false
      for (let i = 0; i < TILE_PIXELS; i++) {
        const si = base + i * stride
        const read = (c: number) => (f16 ? halfToFloat(src16![si + c]) : src32![si + c])
        const a = Math.min(1, Math.max(0, read(stride - 1)))
        const qa = Math.round(a * max)
        out[(stride - 1) * TILE_PIXELS + i] = qa
        if (!qa) continue
        any = true
        for (let c = 0; c < stride - 1; c++) {
          const v = Math.min(1, Math.max(0, read(c) / a))
          out[c * TILE_PIXELS + i] = Math.round((cmyk ? 1 - v : v) * max)
        }
      }
      if (any) take(tx, ty, out)
    }
    staging.unmap()
  }
  // Several bands are in flight at once: a band's readback waits behind whatever else the GPU is
  // doing (a frame for the view, say), and waiting once for several costs what waiting for one did.
  const inFlight: { ty: number; staging: GPUBuffer; present: boolean[]; mapped: Promise<void> }[] = []
  const settle = async () => {
    const b = inFlight.shift()!
    try {
      await b.mapped
      takeBand(b.ty, b.staging, b.present)
    } finally {
      b.staging.destroy()
    }
  }
  try {
    for (let ty = ty0; ty <= ty1; ty++) {
      inFlight.push({ ty, ...(await renderBand(r, 'tiles band', cols, tileBytes, (tx, enc) => renderOne(r.job(s, 0, tx0 + tx, ty, enc)))) })
      if (inFlight.length >= READ_AHEAD) await settle()
    }
    while (inFlight.length) await settle()
  } finally {
    // After a failure, the rest are let go unread.
    for (const b of inFlight.splice(0)) void b.mapped.catch(() => {}).finally(() => b.staging.destroy())
  }
}

export const tileRange = (b: Rect): [number, number, number, number] => [Math.floor(b[0] / TILE), Math.floor(b[1] / TILE), Math.floor((b[2] - 1e-6) / TILE), Math.floor((b[3] - 1e-6) / TILE)]

/**
 * Rasterize: a pixel layer drawn through its live transform, with its own
 * resampling, into new tiles on the document's grid, in the document's own
 * numbers; or a smart object's contents (or a symbol instance's layers), drawn the same way. The layer then
 * has no transform to carry. Tiles left fully transparent aren't kept.
 */
export async function rasterizeNode(r: Renderer, store: TileStore, key: string, nodeId: NodeId): Promise<string | null> {
  const s = r.docState(key)
  const doc = s?.scene.doc
  const node = s?.scene.node(nodeId)
  if (!s || !doc || !node || !['pixel', 'embedded', 'vector', 'boolean', 'text', 'fill', 'group'].includes(node.kind)) throw new Error('Rasterize needs a pixel layer, a smart object, a shape, text or a fill layer')
  // A fill layer has no edge: it's rasterized over the canvas.
  const b = node.kind === 'fill' ? s.scene.canvas : node.kind === 'group' ? s.scene.bounds(nodeId) : s.scene.contentBounds(node, false)
  if (!b) return null
  const f: TileFormat = { mode: doc.mode, depth: doc.depth }
  // Kept as samples until the read is done, then made tiles and a set in one go: a tile made
  // earlier would belong to no set while the reads wait, and a collection meanwhile would take it.
  const read: [number, number, Samples][] = []
  // A group (a symbol instance, as the page sends it) is its layers drawn together.
  await readTiles(r, s, tileRange(b), (job) => (node.kind === 'group' ? r.renderNodeTile(job, nodeId) : r.renderContentTile(job, nodeId)), (tx, ty, samples) => read.push([tx, ty, samples]))
  return read.length ? store.createSet(f, read.map(([tx, ty, samples]) => [tx, ty, store.data(f, samples)])) : null
}

let bakes = 0

/**
 * A pixel layer's tiles with effects run on them and baked in: a filter
 * applied for good (Filter menu with a selection, or not live), or its live
 * filters applied. Worked in the layer's own pixels, as a scene of its own
 * holding just the layer, and mixed with the old pixels by the selection's
 * coverage (none: everywhere). Returns the new set.
 */
/**
 * Tiles of document pixels moved into a layer that sits `dx`, `dy` (whole
 * pixels) from the document's corner: the same pixels, in the layer's own
 * tiles. Transparent pixels are skipped, as new tiles start transparent.
 */
function shiftTiles(src: Map<string, Samples>, f: TileFormat, dx: number, dy: number): Map<string, Samples> {
  const out = new Map<string, Samples>()
  if (dx % TILE === 0 && dy % TILE === 0) {
    for (const [k, s] of src) {
      const [tx, ty] = k.split(',').map(Number)
      out.set(`${tx - dx / TILE},${ty - dy / TILE}`, s)
    }
    return out
  }
  const planes = f.mode === 'rgb' ? 4 : f.mode === 'gray' ? 2 : 5
  const A = (planes - 1) * TILE_PIXELS
  for (const [k, s] of src) {
    const [tx, ty] = k.split(',').map(Number)
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const i = y * TILE + x
        if (!s[A + i]) continue
        const lx = tx * TILE + x - dx
        const ly = ty * TILE + y - dy
        const key = `${Math.floor(lx / TILE)},${Math.floor(ly / TILE)}`
        let t = out.get(key)
        if (!t) out.set(key, (t = newSamples(f)))
        const j = (((ly % TILE) + TILE) % TILE) * TILE + (((lx % TILE) + TILE) % TILE)
        for (let c = 0; c < planes; c++) t[c * TILE_PIXELS + j] = s[c * TILE_PIXELS + i]
      }
  }
  return out
}

export async function bakeEffects(r: Renderer, store: TileStore, key: string, nodeId: NodeId, effects: DocNode[], selection: string | null): Promise<string | null> {
  const s = r.docState(key)
  const doc = s?.scene.doc
  const node = s?.scene.node(nodeId)
  if (!s || !doc || !node || node.kind !== 'pixel') throw new Error('Filters apply to a pixel layer')
  const set = node.props.tiles
  const e = set ? store.extent(set) : null
  if (!set || !e) return set
  const f: TileFormat = { mode: doc.mode, depth: doc.depth }
  const tmpKey = `bake-${++bakes}`
  // A filter that remaps (Offset) works on the canvas, so it's drawn where the layer is on the canvas and moved back into the layer.
  const remaps = effects.some((x) => x.kind === 'filter' && !!FILTER_BY_ID.get(x.props.filter)?.remap)
  const tr = node.transform
  const plain = tr[0] === 1 && tr[1] === 0 && tr[2] === 0 && tr[3] === 1 && Number.isInteger(tr[4]) && Number.isInteger(tr[5])
  if (remaps && !plain) throw new Error('Offset is applied to a layer that isn’t turned, scaled or on part of a pixel: keep it live, or rasterize the layer first')
  // In a tiled document a filter reads round the edges, so it's drawn on the canvas, where the document repeats, and
  // moved back into the layer; a layer that isn't on whole pixels is filtered as it is, without wrapping.
  const wraps = (doc.tiled ?? 'off') !== 'off'
  const onCanvas = remaps || (wraps && plain)
  const layer: DocNode = { ...node, transform: onCanvas ? [1, 0, 0, 1, tr[4], tr[5]] : [1, 0, 0, 1, 0, 0], masks: [], fx: [], opacity: 1, fillOpacity: 1, blend: 'normal', visible: true, effects: effects.map((x) => x.id), children: [] } as DocNode
  const root = makeNode('group', `${tmpKey}-root`)
  root.children = [layer.id]
  r.updateScene(tmpKey, {
    doc: onCanvas ? { ...doc, root: root.id, selection: null } : { ...doc, root: root.id, selection: null, width: (e.x1 + 1) * TILE, height: (e.y1 + 1) * TILE, tiled: undefined },
    nodes: [root, layer, ...effects].map((n, i) => ({ node: n, version: i + 1 })),
    removed: [],
    reset: true,
  })
  try {
    const t = r.docState(tmpKey)!
    let filtered = new Map<string, Samples>()
    if (onCanvas) {
      await readTiles(r, t, [0, 0, Math.ceil(doc.width / TILE) - 1, Math.ceil(doc.height / TILE) - 1], (job) => r.renderTile(job), (tx, ty, samples) => filtered.set(`${tx},${ty}`, samples))
      filtered = shiftTiles(filtered, f, tr[4], tr[5])
    } else {
      // As far as the filters reach; a warp, wherever it carries the layer.
      const b = t.scene.contentBounds(t.scene.node(layer.id) ?? layer)
      const reach = Math.ceil(t.scene.reachOf(layer) / TILE)
      const tiles: [number, number, number, number] = b ? [Math.floor(b[0] / TILE), Math.floor(b[1] / TILE), Math.ceil(b[2] / TILE) - 1, Math.ceil(b[3] / TILE) - 1] : [e.x0 - reach, e.y0 - reach, e.x1 + reach, e.y1 + reach]
      await readTiles(r, t, tiles, (job) => r.renderTile(job), (tx, ty, samples) => filtered.set(`${tx},${ty}`, samples))
    }
    const reader = selection ? new CoverReader(store, selection) : null
    const planes = f.mode === 'rgb' ? 4 : f.mode === 'gray' ? 2 : 5
    const max = f.depth === 16 ? 65535 : 255
    // Samples until the end, then tiles and the new set in one go, so no tile waits unowned across an await.
    const changes: [number, number, Samples | null][] = []
    for (const k of new Set([...filtered.keys(), ...store.getSet(set).tiles.keys()])) {
      const [tx, ty] = k.split(',').map(Number)
      const next = filtered.get(k) ?? null
      if (!reader) {
        changes.push([tx, ty, next])
        continue
      }
      // Through the selection: old and new mixed by how much it covers each pixel.
      const cov = await coverForTile(reader, node.transform, tx, ty)
      if (cov.every((v) => v <= 0)) continue
      const oldId = store.tileAt(set, tx, ty)
      const old = oldId !== undefined ? await store.samples(oldId) : newSamples(f)
      const out = newSamples(f)
      let any = false
      const A = (planes - 1) * TILE_PIXELS
      for (let i = 0; i < TILE_PIXELS; i++) {
        const kk = cov[i]
        if (kk <= 0) {
          // Where the selection doesn't reach, the pixel exactly as it was.
          for (let c = 0; c < planes; c++) out[c * TILE_PIXELS + i] = old[c * TILE_PIXELS + i]
          if (old[A + i]) any = true
          continue
        }
        const a0 = old[A + i] / max
        const a1 = next ? next[A + i] / max : 0
        const a = a0 + (a1 - a0) * kk
        const qa = Math.round(a * max)
        out[A + i] = qa
        if (!qa) continue
        any = true
        for (let c = 0; c < planes - 1; c++) {
          const c0 = old[c * TILE_PIXELS + i] / max
          const c1 = next ? next[c * TILE_PIXELS + i] / max : 0
          out[c * TILE_PIXELS + i] = Math.round(Math.min(1, Math.max(0, (c0 * a0 + (c1 * a1 - c0 * a0) * kk) / a)) * max)
        }
      }
      changes.push([tx, ty, any ? out : null])
    }
    return changes.length ? store.derive(set, changes.map(([tx, ty, samples]) => [tx, ty, samples ? store.data(f, samples) : null] as [number, number, TileId | null])) : set
  } finally {
    r.close(tmpKey)
  }
}
