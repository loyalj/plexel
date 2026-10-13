/**
 * One node (with its masks and effects, at full strength) or the whole
 * composite, rendered and cropped to what's in it: for SVG (an sRGB PNG)
 * and PDF (8-bit samples in the document's own terms, CMYK as ink, and
 * alpha) where a layer can't be written as vectors.
 */
import type { NodeId } from '../doc/types'
import { encodePng } from '../io/png'
import { readPixels8 } from '../render/readback'
import type { Renderer } from '../render/renderer'
import { colour } from './colourHost'

export interface NodeImage {
  x: number
  y: number
  w: number
  h: number
  /** Colour channels (the document's, or 3 for sRGB), then alpha, interleaved. */
  channels: number
  data: Uint8Array
  /** For SVG: the same as an sRGB PNG with transparency. */
  png: Uint8Array | null
}

export async function nodeImage(r: Renderer, key: string, node: NodeId | null, srgb: boolean): Promise<NodeImage | null> {
  const s = r.docState(key)
  const doc = s?.scene.doc
  if (!s || !doc) throw new Error('That document isn’t in the engine')
  const all = await readPixels8(r, key, node, 0)
  const ch = all.channels
  const n = ch - 1
  // What's in it: the bounds of everything not transparent.
  let x0 = all.width
  let y0 = all.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < all.height; y++)
    for (let x = 0; x < all.width; x++)
      if (all.data[(y * all.width + x) * ch + n]) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  if (x1 < 0) return null
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  const data = new Uint8Array(w * h * ch)
  for (let y = 0; y < h; y++) data.set(all.data.subarray(((y0 + y) * all.width + x0) * ch, ((y0 + y) * all.width + x0 + w) * ch), y * w * ch)
  if (!srgb) return { x: x0, y: y0, w, h, channels: ch, data, png: null }
  // To sRGB through the document's profile, for SVG, which has no other.
  const { cms, registry } = await colour()
  const t = cms.transform(registry.resolve(doc.profile, doc.mode).profile, registry.builtin('srgb'), 'relative', 0x2000)
  const rgba = new Uint8Array(w * h * 4)
  try {
    const px = new Float32Array(w * h * n)
    for (let i = 0; i < w * h; i++) for (let c = 0; c < n; c++) px[i * n + c] = data[i * ch + c] / 255
    const out = t.run(px, w * h)
    for (let i = 0; i < w * h; i++) {
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(Math.min(1, Math.max(0, out[i * 3 + c])) * 255)
      rgba[i * 4 + 3] = data[i * ch + n]
    }
  } finally {
    t.close()
  }
  async function* rows() {
    for (let y = 0; y < h; y++) yield rgba.subarray(y * w * 4, (y + 1) * w * 4)
  }
  const blob = await encodePng({ width: w, height: h, mode: 'rgb', depth: 8, alpha: true, icc: null, iccName: 'sRGB' }, rows())
  return { x: x0, y: y0, w, h, channels: 4, data: rgba, png: new Uint8Array(await blob.arrayBuffer()) }
}
