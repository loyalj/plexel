/**
 * Patterns made from pixels, read out of the tile store for drawing: one
 * repeat's pixels as the paint kernels take them, in the working space
 * (CMYK as light), premultiplied, five floats a pixel. Its pyramid is
 * vector/paint.ts's (patternLevels), and the GPU's buffer
 * render/shaders/vector.ts's (patternBuffer).
 */
import { PATTERN_STRIDE } from '../vector/paint'
import { TILE, TILE_PIXELS } from './format'
import type { SetId, TileStore } from './store'

/** A pattern's w × h pixels from its tile set (at the origin), working space, premultiplied. */
export async function patternPixels(store: TileStore, set: SetId, w: number, h: number): Promise<Float32Array> {
  const out = new Float32Array(w * h * PATTERN_STRIDE)
  const f = store.getSet(set).format
  const planes = f.mode === 'rgb' ? 4 : f.mode === 'gray' ? 2 : 5
  const max = f.depth === 16 ? 65535 : 255
  const cmyk = f.mode === 'cmyk'
  for (let ty = 0; ty * TILE < h; ty++) {
    for (let tx = 0; tx * TILE < w; tx++) {
      const id = store.tileAt(set, tx, ty)
      if (id === undefined) continue
      const u = store.isUniform(id)
      const s = u ? null : await store.samples(id)
      for (let y = ty * TILE; y < Math.min(h, (ty + 1) * TILE); y++) {
        for (let x = tx * TILE; x < Math.min(w, (tx + 1) * TILE); x++) {
          const i = (y - ty * TILE) * TILE + (x - tx * TILE)
          const v = (c: number) => (u ? u[c] : s![c * TILE_PIXELS + i]) / max
          const a = v(planes - 1)
          const o = (y * w + x) * PATTERN_STRIDE
          for (let c = 0; c < planes - 1; c++) out[o + c] = (cmyk ? 1 - v(c) : v(c)) * a
          out[o + 4] = a
        }
      }
    }
  }
  return out
}
