/**
 * A brush's stroke drawn on the CPU, for the Brushes panel's strips and the
 * Brush Settings panel's preview: an S across the strip, pressing harder
 * towards the middle, by the same code the GPU is checked against
 * (render/ref/paint.ts), so a preview is what the brush paints. Coverage
 * only, 0..1 a pixel, `width` × `height`.
 */
import type { BrushSettings } from './defs'
import { toLayer } from './dab'
import { strokeDabs, type PenSample } from './stroke'
import { TILE } from '../tiles/format'
import { coverageAt, layoutOf, newStrokeTile, stamp, styleOf } from '../render/ref/paint'

export function strokePreview(b: BrushSettings, width: number, height: number, maxSize = Math.min(26, height - 10)): Float32Array {
  const size = Math.min(b.size, maxSize)
  const k = size / b.size
  // Scaled down to fit, as a whole: the dual brush and the texture shrink with it.
  const settings: BrushSettings = {
    ...b,
    size,
    smoothing: 0,
    buildUp: false,
    dual: b.dual ? { ...b.dual, size: Math.max(1, b.dual.size * k) } : null,
    texture: b.texture ? { ...b.texture, scale: b.texture.scale * Math.max(0.25, k) } : null,
  }
  const samples: PenSample[] = Array.from({ length: 40 }, (_, i) => {
    const t = i / 39
    return { x: 12 + t * (width - 24), y: height / 2 + Math.sin(t * Math.PI * 2) * (height / 2 - size / 2 - 3), pressure: Math.sin(t * Math.PI) * 0.8 + 0.2, tiltX: 0, tiltY: 0, twist: (t * 360) % 360, t: i * 10 }
  })
  const dabs = strokeDabs(settings, 1, samples).map((d) => toLayer(d, [1, 0, 0, 1, 0, 0]))
  const out = new Float32Array(width * height)
  const style = styleOf(settings)
  const clip = { t: [1, 0, 0, 1, 0, 0], width, height }
  for (let ty = 0; ty * TILE < height; ty++)
    for (let tx = 0; tx * TILE < width; tx++) {
      const tile = newStrokeTile(layoutOf(settings, false, 0))
      stamp(tile, tx, ty, dabs, null, clip, style)
      for (let y = 0; y < TILE && ty * TILE + y < height; y++)
        for (let x = 0; x < TILE && tx * TILE + x < width; x++) out[(ty * TILE + y) * width + tx * TILE + x] = coverageAt(tile, y * TILE + x)
    }
  return out
}
