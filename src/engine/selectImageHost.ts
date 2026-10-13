/**
 * The selection work that reads the image: Grow and Similar, Colour Range,
 * Quick Selection, the Magnetic Lasso's wire, and Select and Mask's edge
 * refinement. Each reads the canvas (or one layer) as 8-bit values in the
 * document's terms, from a mip level when the document is big, and keeps
 * that read while the document stays as it is, so a drag's many calls read
 * it once. The selection-only work (shapes, Feather, Transform Selection) is
 * selectHost.ts's.
 */
import { CoverReader, colourRange, combine, exactBounds, hitsToSet, invert, pasteWindow, similarHits, valuesToSet, type ColourRangePreset, type CombineOp, type Torus } from '../tiles/coverage'
import { tileWraps } from '../doc/types'
import { quickSelect } from '../select/quickSelect'
import { EdgeMap, liveWire, snapToEdge } from '../select/liveWire'
import { edgeBand, refineEdge } from '../select/matte'
import type { Renderer } from '../render/renderer'
import { readPixels8 } from '../render/readback'
import { guarded, held } from './selectHost'
import { store } from './tileHost'

/** The most pixels read for selection work; past this, a mip level. */
const READ_PIXELS = 32 * 1024 * 1024
/** The most pixels Select and Mask refines at once; a bigger edge is refined at a smaller size. */
const REFINE_PIXELS = 4 * 1024 * 1024

interface Read {
  key: string
  node: string | null
  level: number
  revision: number
  width: number
  height: number
  channels: number
  data: Uint8Array
  edges?: EdgeMap
}

/** The last read or two, kept while the document doesn't change. */
const reads: Read[] = []

async function readImage(r: Renderer, key: string, node: string | null, atLeast = 0): Promise<Read> {
  const s = r.docState(key)
  const doc = s?.scene.doc
  if (!s || !doc) throw new Error('That document isn’t in the engine')
  let level = atLeast
  while ((doc.width / 2 ** level) * (doc.height / 2 ** level) > READ_PIXELS) level++
  const hit = reads.find((x) => x.key === key && x.node === node && x.level === level && x.revision === s.scene.revision)
  if (hit) return hit
  const img = await readPixels8(r, key, node, level)
  const read: Read = { key, node, level, revision: s.scene.revision, ...img }
  reads.unshift(read)
  reads.length = Math.min(reads.length, 2)
  return read
}

/** A tiled document's torus, read from it at full size; none at a mip level, where its period isn't whole pixels. */
function torusAt(r: Renderer, key: string, img: Read): Torus | null {
  const t = tileWraps(r.docState(key)?.scene.doc?.tiled)
  return (t.x || t.y) && img.level === 0 ? t : null
}

/** A selection read at an image's size: each image pixel the average of the canvas pixels it covers. */
async function coverAt(set: string | null, img: Read, x0: number, y0: number, w: number, h: number, torus: Torus | null = null): Promise<Float32Array> {
  const s = 2 ** img.level
  const full = await new CoverReader(store, set, 0, torus ? { ...torus, width: img.width, height: img.height } : null).window(x0 * s, y0 * s, w * s, h * s)
  if (s === 1) return full
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let yy = 0; yy < s; yy++) for (let xx = 0; xx < s; xx++) sum += full[(y * s + yy) * w * s + x * s + xx]
      out[y * w + x] = sum / (s * s)
    }
  return out
}

/** A window of an image's pixels; on a torus, wrapped round its edges. */
function cut(img: Read, x0: number, y0: number, w: number, h: number, torus: Torus | null = null): Uint8Array {
  const c = img.channels
  const out = new Uint8Array(w * h * c)
  if (torus) {
    const m = (v: number, n: number) => ((v % n) + n) % n
    for (let y = 0; y < h; y++) {
      const sy = torus.y ? m(y0 + y, img.height) : y0 + y
      for (let x = 0; x < w; x++) {
        const sx = torus.x ? m(x0 + x, img.width) : x0 + x
        out.set(img.data.subarray((sy * img.width + sx) * c, (sy * img.width + sx + 1) * c), (y * w + x) * c)
      }
    }
    return out
  }
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * img.width + x0) * c, ((y0 + y) * img.width + x0 + w) * c), y * w * c)
  return out
}

/** Round brush dabs along a polyline (image pixels), marked in a w × h mask at (x0, y0). */
function dabs(mask: Uint8Array, w: number, h: number, x0: number, y0: number, points: [number, number][], radius: number) {
  const r = Math.max(0.5, radius)
  const dab = (cx: number, cy: number) => {
    for (let y = Math.max(0, Math.floor(cy - r - y0)); y <= Math.min(h - 1, Math.ceil(cy + r - y0)); y++)
      for (let x = Math.max(0, Math.floor(cx - r - x0)); x <= Math.min(w - 1, Math.ceil(cx + r - x0)); x++) if ((x + x0 + 0.5 - cx) ** 2 + (y + y0 + 0.5 - cy) ** 2 <= r * r) mask[y * w + x] = 1
  }
  points.forEach((p, i) => {
    const q = points[i - 1] ?? p
    const steps = Math.max(1, Math.ceil(Math.hypot(p[0] - q[0], p[1] - q[1]) / Math.max(1, r / 2)))
    for (let k = 1; k <= steps; k++) dab(q[0] + ((p[0] - q[0]) * k) / steps, q[1] + ((p[1] - q[1]) * k) / steps)
  })
}

/** A rectangle round points (image pixels) grown by `m`, inside the image; on a torus, over its edges, at most a period. */
function around(img: Read, points: [number, number][], m: number, torus: Torus | null = null): [number, number, number, number] {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const span = (lo: number, hi: number, size: number, wraps: boolean): [number, number] => {
    if (!wraps) return [Math.max(0, lo), Math.min(size, hi)]
    return [lo, Math.min(hi, lo + size)]
  }
  const [x0, x1] = span(Math.floor(Math.min(...xs) - m), Math.ceil(Math.max(...xs) + m), img.width, !!torus?.x)
  const [y0, y1] = span(Math.floor(Math.min(...ys) - m), Math.ceil(Math.max(...ys) + m), img.height, !!torus?.y)
  return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)]
}

const docSize = (r: Renderer, key: string) => {
  const doc = r.docState(key)?.scene.doc
  if (!doc) throw new Error('That document isn’t in the engine')
  return doc
}

export interface SelectImageCalls {
  /** Select → Grow (touching the selection) or Similar (anywhere): colours like the selection's, added to it. */
  'select.similar': { args: { key: string; node: string | null; current: string; tolerance: number; contiguous: boolean; antialias: boolean }; result: string | null }
  /** Select → Colour Range: sampled colours (document points) or a preset, with fuzziness, combined with the selection. */
  'select.colourRange': {
    args: { key: string; node: string | null; preset: ColourRangePreset; samples: [number, number][]; fuzziness: number; invert: boolean; op: CombineOp; current: string | null }
    result: string | null
  }
  /** Quick Selection: the selection grown from (or, subtracting, shrunk away from) a brush stroke, out to the edges. */
  'select.quick': { args: { key: string; node: string | null; current: string | null; points: [number, number][]; radius: number; mode: 'add' | 'subtract'; autoEnhance: boolean }; result: string | null }
  /** The Magnetic Lasso: the path along the strongest edges from one document point to another. */
  'select.wire': { args: { key: string; node: string | null; from: [number, number]; to: [number, number]; width: number; contrast: number }; result: [number, number][] }
  /** The strongest edge within `radius` of a document point: where the Magnetic Lasso's first click lands. */
  'select.snap': { args: { key: string; node: string | null; x: number; y: number; radius: number }; result: [number, number] }
  /** Select and Mask's edge detection and refine brush: coverage re-estimated from the image in a band round the edge and wherever brushed. */
  'select.refineEdge': {
    args: { key: string; node: string | null; current: string; radius: number; smart: boolean; strokes: { points: [number, number][]; radius: number }[] }
    result: string | null
  }
}

export function selectImageHandlers(renderer: () => Promise<Renderer>): { [M in keyof SelectImageCalls]: (args: SelectImageCalls[M]['args']) => Promise<SelectImageCalls[M]['result']> } {
  return {
    'select.similar': (a) =>
      guarded(async () => {
        const r = await renderer()
        const doc = docSize(r, a.key)
        const img = await readImage(r, a.key, a.node)
        const torus = torusAt(r, a.key, img)
        const cover = await coverAt(a.current, img, 0, 0, img.width, img.height)
        const hits = similarHits(img.data, img.channels, img.width, img.height, cover, a.tolerance, a.contiguous, torus)
        if (!hits) return held(a.current)
        const set = hitsToSet(store, hits, img.width, img.height, a.antialias, img.level, doc.width, doc.height, torus)
        return held(await combine(store, a.current, set, 'add', doc.width, doc.height))
      }),
    'select.colourRange': (a) =>
      guarded(async () => {
        const r = await renderer()
        const doc = docSize(r, a.key)
        const img = await readImage(r, a.key, a.node)
        const s = 2 ** img.level
        // Each sample is the 3 × 3 average round its point, as Photoshop's eyedropper reads.
        const samples = a.samples.map(([x, y]) => {
          const cx = Math.min(img.width - 1, Math.max(0, Math.floor(x / s)))
          const cy = Math.min(img.height - 1, Math.max(0, Math.floor(y / s)))
          const v = new Array(img.channels).fill(0)
          let n = 0
          for (let yy = Math.max(0, cy - 1); yy <= Math.min(img.height - 1, cy + 1); yy++)
            for (let xx = Math.max(0, cx - 1); xx <= Math.min(img.width - 1, cx + 1); xx++) {
              for (let c = 0; c < img.channels; c++) v[c] += img.data[(yy * img.width + xx) * img.channels + c]
              n++
            }
          return v.map((x) => x / n)
        })
        if (a.preset === 'sampled' && !samples.length) return held(a.op === 'replace' ? null : a.current)
        const values = colourRange(img.data, img.channels, img.width, img.height, doc.mode, a.preset, samples, a.fuzziness)
        let set = valuesToSet(store, values, img.width, img.height, img.level, doc.width, doc.height)
        if (a.invert) set = await invert(store, set, doc.width, doc.height)
        return held(await combine(store, a.current, set, a.op, doc.width, doc.height))
      }),
    'select.quick': (a) =>
      guarded(async () => {
        const r = await renderer()
        const doc = docSize(r, a.key)
        const img = await readImage(r, a.key, a.node)
        const s = 2 ** img.level
        const pts = a.points.map(([x, y]) => [x / s, y / s] as [number, number])
        const rad = Math.max(1, a.radius / s)
        const torus = torusAt(r, a.key, img)
        // Room round the stroke for the object it's on to be found in: on a torus, over the edges.
        const [x0, y0, w, h] = around(img, pts, Math.max(48, rad * 6), torus)
        const stroke = new Uint8Array(w * h)
        dabs(stroke, w, h, x0, y0, pts, rad)
        const current = await coverAt(a.current, img, x0, y0, w, h, torus)
        const next = quickSelect({ image: cut(img, x0, y0, w, h, torus), channels: img.channels, width: w, height: h, current, stroke, mode: a.mode, autoEnhance: a.autoEnhance })
        const set = await pasteWindow(store, a.current, x0, y0, w, h, next, doc.width, doc.height, img.level, torus)
        return held(store.getSet(set).tiles.size ? set : null)
      }),
    'select.wire': async (a) => {
      const r = await renderer()
      const img = await readImage(r, a.key, a.node)
      img.edges ??= new EdgeMap(img.data, img.channels, img.width, img.height)
      const s = 2 ** img.level
      const off = (p: [number, number]) => p[0] < 0 || p[1] < 0 || p[0] >= img.width * s || p[1] >= img.height * s
      if (off(a.to) || off(a.from)) {
        // Over a tiled document's seam (an end in a copy): the edges of a window cut round both ends, wrapped,
        // so the wire clings across it. Past an ordinary document's edge there's nothing to cling to.
        const torus = torusAt(r, a.key, img)
        if (!torus) return [a.from, a.to]
        const w = Math.max(2, a.width / s)
        const [x0, y0, ww, wh] = around(img, [a.from, a.to], w + 8, torus)
        const edges = new EdgeMap(cut(img, x0, y0, ww, wh, torus), img.channels, ww, wh)
        const local = (p: [number, number]): [number, number] => [Math.min(ww - 1, Math.max(0, Math.floor(p[0] - x0))), Math.min(wh - 1, Math.max(0, Math.floor(p[1] - y0)))]
        const [tx, ty] = local(a.to)
        const near = snapToEdge(edges, tx, ty, Math.min(w, 8))
        const end = edges.strength(near[0], near[1]) >= a.contrast ? near : ([tx, ty] as [number, number])
        return liveWire(edges, local(a.from), end, { width: w, contrast: a.contrast }).map(([x, y]) => [x + x0 + 0.5, y + y0 + 0.5] as [number, number])
      }
      const clamp = (p: [number, number]): [number, number] => [Math.min(img.width - 1, Math.max(0, Math.floor(p[0] / s))), Math.min(img.height - 1, Math.max(0, Math.floor(p[1] / s)))]
      // The free end clings to the strongest edge within the width, as Photoshop's does.
      const w = Math.max(2, a.width / s)
      const [tx, ty] = clamp(a.to)
      const near = snapToEdge(img.edges, tx, ty, Math.min(w, 8))
      const end = img.edges.strength(near[0], near[1]) >= a.contrast ? near : ([tx, ty] as [number, number])
      const path = liveWire(img.edges, clamp(a.from), end, { width: w, contrast: a.contrast })
      return path.map(([x, y]) => [(x + 0.5) * s, (y + 0.5) * s] as [number, number])
    },
    'select.snap': async (a) => {
      const r = await renderer()
      const img = await readImage(r, a.key, a.node)
      img.edges ??= new EdgeMap(img.data, img.channels, img.width, img.height)
      const s = 2 ** img.level
      const [x, y] = snapToEdge(img.edges, Math.min(img.width - 1, Math.max(0, Math.floor(a.x / s))), Math.min(img.height - 1, Math.max(0, Math.floor(a.y / s))), Math.max(1, a.radius / s))
      return [(x + 0.5) * s, (y + 0.5) * s]
    },
    'select.refineEdge': (a) =>
      guarded(async () => {
        const r = await renderer()
        const doc = docSize(r, a.key)
        const b = await exactBounds(store, a.current)
        if (!b) return held(a.current)
        // The edge and the brushed strokes, with room for the band; at a size that refines quickly.
        const reach = a.radius + 4
        const strokeR = Math.max(0, ...a.strokes.map((x) => x.radius))
        const allPts: [number, number][] = [
          [b[0] - reach, b[1] - reach],
          [b[2] + reach, b[3] + reach],
          ...a.strokes.flatMap((x) => x.points),
        ]
        const xs = allPts.map((p) => p[0])
        const ys = allPts.map((p) => p[1])
        const area = (Math.max(...xs) - Math.min(...xs) + 2 * strokeR) * (Math.max(...ys) - Math.min(...ys) + 2 * strokeR)
        const level = Math.max(0, Math.ceil(Math.log2(Math.sqrt(area / REFINE_PIXELS))))
        const img = await readImage(r, a.key, a.node, level)
        const s = 2 ** img.level
        // On a tiled document's torus the window reaches over the edges, with a margin past a period either side
        // so its own ends aren't a seam: only the middle is pasted back.
        const torus = torusAt(r, a.key, img)
        const M = torus ? Math.ceil(reach / s) + 4 : 0
        let [x0, y0, w, h] = around(
          img,
          allPts.map(([x, y]) => [x / s, y / s]),
          strokeR / s + 2,
          torus,
        )
        const mx = torus?.x ? M : 0
        const my = torus?.y ? M : 0
        x0 -= mx
        y0 -= my
        w += 2 * mx
        h += 2 * my
        const coverage = await coverAt(a.current, img, x0, y0, w, h, torus)
        const image = cut(img, x0, y0, w, h, torus)
        let brushed: Uint8Array | undefined
        if (a.strokes.length) {
          brushed = new Uint8Array(w * h)
          for (const st of a.strokes)
            dabs(
              brushed,
              w,
              h,
              x0,
              y0,
              st.points.map(([x, y]) => [x / s, y / s]),
              st.radius / s,
            )
        }
        const band = edgeBand({ image, channels: img.channels, width: w, height: h, coverage, radius: Math.max(1, a.radius / s), smart: a.smart, brushed })
        let next = refineEdge({ image, channels: img.channels, width: w, height: h, coverage, band })
        let [px, py, pw, ph] = [x0, y0, w, h]
        if (mx || my) {
          // The middle, without the margins.
          pw = w - 2 * mx
          ph = h - 2 * my
          const mid = new Float32Array(pw * ph)
          for (let y = 0; y < ph; y++) mid.set(next.subarray((y + my) * w + mx, (y + my) * w + mx + pw), y * pw)
          next = mid
          px = x0 + mx
          py = y0 + my
        }
        const set = await pasteWindow(store, a.current, px, py, pw, ph, next, doc.width, doc.height, img.level, torus)
        return held(store.getSet(set).tiles.size ? set : null)
      }),
  }
}
