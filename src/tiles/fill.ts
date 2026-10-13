/**
 * Filling a pixel layer: a paint (a colour, a gradient, a pattern) or an
 * image (what content-aware fill made) laid onto a layer's tiles through
 * coverage, with a blend mode and an opacity, as Photoshop's Edit → Fill,
 * the Gradient tool and the Paint Bucket do. With Preserve Transparency the
 * layer keeps its alpha and only its colour changes (the compositing
 * reference's `atop`); otherwise the fill goes over it (`over`).
 *
 * The sums are render/ref/composite.ts's, pixel for pixel, in the working
 * space (premultiplied, CMYK as light); Normal at full strength takes a
 * short way round with the same result. Untouched tiles are shared.
 */
import type { BlendModeId, ColourMode } from '../doc/types'
import { atop, dissolveThreshold, over, type Px } from '../render/ref/composite'
import { paintAt, type PaintParams } from '../vector/paint'
import { coverForTile, type CoverReader } from './coverage'
import { TILE, TILE_PIXELS, newSamples, type Samples, type TileFormat } from './format'
import type { SetId, TileId, TileStore } from './store'

type Affine = number[]

/** What's laid on, in working terms, premultiplied. */
export type FillSource =
  /** A paint whose space is the document's: `params` maps a document pixel (as a tile pixel at the origin) to it. */
  | { kind: 'paint'; params: PaintParams }
  /** An image in document pixels: w × h at (x0, y0), five floats a pixel; outside it nothing is laid on. */
  | { kind: 'image'; x0: number; y0: number; w: number; h: number; data: Float32Array }

export interface FillOptions {
  blend: BlendModeId
  /** 0..1. */
  opacity: number
  /** Photoshop's Preserve Transparency: the layer's alpha stays as it is. */
  preserve: boolean
  /** Dissolve's seed. */
  seed?: number
}

const planesOf = (f: TileFormat) => (f.mode === 'rgb' ? 4 : f.mode === 'gray' ? 2 : 5)

/** The working-space value at a document point (its pixel's centre at x + ½, y + ½). */
function sourceAt(src: FillSource, x: number, y: number, out: Px) {
  if (src.kind === 'paint') {
    const p = paintAt(src.params, x, y)
    out.c = p.c
    out.a = p.a
    return
  }
  const ix = Math.floor(x) - src.x0
  const iy = Math.floor(y) - src.y0
  if (ix < 0 || iy < 0 || ix >= src.w || iy >= src.h) {
    out.c = [0, 0, 0, 0]
    out.a = 0
    return
  }
  const o = (iy * src.w + ix) * 5
  out.c = [src.data[o], src.data[o + 1], src.data[o + 2], src.data[o + 3]]
  out.a = src.data[o + 4]
}

/**
 * A pixel layer's tiles with `src` laid on as much as `cover` covers each
 * pixel (looked up through the layer's transform `t`), within `bounds`
 * (document pixels, [x0, y0, x1, y1)). `cover` null fills everywhere in
 * bounds. Returns the new set; null for a layer left with nothing in it.
 */
export async function fillLayer(
  store: TileStore,
  layer: SetId | null,
  f: TileFormat,
  t: Affine,
  cover: CoverReader | null,
  bounds: [number, number, number, number],
  src: FillSource,
  o: FillOptions,
): Promise<SetId | null> {
  const mode: ColourMode = f.mode
  const planes = planesOf(f)
  const n = planes - 1
  const max = f.depth === 16 ? 65535 : 255
  const det = t[0] * t[3] - t[1] * t[2] || 1e-12
  const inv = [t[3] / det, -t[1] / det, -t[2] / det, t[0] / det, (t[2] * t[5] - t[3] * t[4]) / det, (t[1] * t[4] - t[0] * t[5]) / det]
  const corners = [
    [bounds[0], bounds[1]],
    [bounds[2], bounds[1]],
    [bounds[0], bounds[3]],
    [bounds[2], bounds[3]],
  ].map(([x, y]) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]])
  const lx0 = Math.floor(Math.min(...corners.map((c) => c[0])) / TILE)
  const ly0 = Math.floor(Math.min(...corners.map((c) => c[1])) / TILE)
  const lx1 = Math.floor((Math.max(...corners.map((c) => c[0])) - 1e-9) / TILE)
  const ly1 = Math.floor((Math.max(...corners.map((c) => c[1])) - 1e-9) / TILE)
  const fast = o.blend === 'normal' && !o.preserve
  const s: Px = { c: [], a: 0 }
  const changes: [number, number, TileId | null][] = []
  for (let ty = ly0; ty <= ly1; ty++) {
    for (let tx = lx0; tx <= lx1; tx++) {
      const old = layer ? store.tileAt(layer, tx, ty) : undefined
      // Preserving transparency, a tile with nothing in it stays so.
      if (o.preserve && old === undefined) continue
      const before: Samples = old !== undefined ? await store.samples(old) : newSamples(f)
      const out = newSamples(f)
      out.set(before)
      const ks = cover ? await coverForTile(cover, t, tx, ty) : null
      let changed = false
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const i = y * TILE + x
          // The pixel's centre in the document.
          const lx = tx * TILE + x + 0.5
          const ly = ty * TILE + y + 0.5
          const dx = t[0] * lx + t[2] * ly + t[4]
          const dy = t[1] * lx + t[3] * ly + t[5]
          if (dx < bounds[0] || dy < bounds[1] || dx >= bounds[2] || dy >= bounds[3]) continue
          let k = (ks ? ks[i] : 1) * o.opacity
          if (k <= 0) continue
          const ab = before[n * TILE_PIXELS + i] / max
          if (o.preserve && ab <= 0) continue
          sourceAt(src, dx - 0.5, dy - 0.5, s)
          if (s.a <= 0) continue
          let sp: Px = s
          if (o.blend === 'dissolve') {
            // Each pixel all there or not at all, as the canvas draws Dissolve.
            if (dissolveThreshold(Math.floor(dx), Math.floor(dy), o.seed ?? 0) >= s.a * k) continue
            sp = { c: s.c.map((v) => v / s.a), a: 1 }
            k = 1
          }
          // The layer's pixel, in working terms.
          const dc = new Array(n)
          for (let c = 0; c < n; c++) {
            const v = before[c * TILE_PIXELS + i] / max
            dc[c] = (mode === 'cmyk' ? 1 - v : v) * ab
          }
          let r: Px
          if (fast || o.blend === 'dissolve') {
            const as = sp.a * k
            r = { c: dc.map((d, c) => sp.c[c] * k + (1 - as) * d), a: as + ab * (1 - as) }
          } else r = o.preserve ? atop({ c: dc, a: ab }, sp, o.blend, k) : over({ c: dc, a: ab }, sp, o.blend, k)
          const a = Math.min(1, Math.max(0, r.a))
          for (let c = 0; c < n; c++) {
            const v = a > 0 ? Math.min(1, Math.max(0, r.c[c] / a)) : 0
            out[c * TILE_PIXELS + i] = Math.round((mode === 'cmyk' ? 1 - v : v) * max)
          }
          out[n * TILE_PIXELS + i] = Math.round(a * max)
          changed = true
        }
      }
      if (!changed) continue
      const alpha = out.subarray(n * TILE_PIXELS)
      changes.push([tx, ty, alpha.every((v) => v === 0) ? null : store.data(f, out)])
    }
  }
  if (layer) return changes.length ? store.derive(layer, changes) : layer
  const kept = changes.filter((c): c is [number, number, TileId] => c[2] !== null)
  return kept.length ? store.createSet(f, kept) : null
}
