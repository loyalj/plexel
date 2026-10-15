/**
 * Colours cut down to a palette, for PNG-8 (Save for Web): median cut over
 * the image's colours, counted in a histogram of 5 bits a channel, then
 * each pixel given its nearest palette colour, with Floyd–Steinberg
 * dithering if asked. Transparency is one bit, as PNG-8 files from Save
 * for Web have it: a pixel less than half opaque is the palette's clear
 * entry; the rest are laid on the matte (or kept as they are with none).
 *
 * Pure and DOM-free; check-images runs it in Node.
 */

export interface Quantized {
  /** One palette index per pixel. */
  indices: Uint8Array
  /** RGB, three bytes an entry. */
  palette: Uint8Array
  /** Each entry's alpha: 0 for the clear one, 255 for the rest. */
  alpha: Uint8Array
}

export interface QuantizeOptions {
  /** Most colours in the palette, 2 to 256 (the clear entry among them). */
  colours: number
  dither: boolean
  /** Keep transparency (a clear entry); without it, every pixel is laid on the matte. */
  transparency: boolean
  /** What partly transparent pixels are laid on, 0..255 each; null keeps their colour as it is. */
  matte: [number, number, number] | null
}

/** A box of the histogram's colours, by their 15-bit keys. */
interface Box {
  keys: number[]
  count: number
}

const R = (k: number) => (k >> 10) & 31
const G = (k: number) => (k >> 5) & 31
const B = (k: number) => k & 31

function splitBox(b: Box, hist: Uint32Array): [Box, Box] | null {
  if (b.keys.length < 2) return null
  // Along the channel the box is widest in.
  let lo = [31, 31, 31]
  let hi = [0, 0, 0]
  for (const k of b.keys) {
    const c = [R(k), G(k), B(k)]
    lo = lo.map((v, i) => Math.min(v, c[i]))
    hi = hi.map((v, i) => Math.max(v, c[i]))
  }
  const span = hi.map((v, i) => v - lo[i])
  const ch = span[0] >= span[1] && span[0] >= span[2] ? 0 : span[1] >= span[2] ? 1 : 2
  const get = ch === 0 ? R : ch === 1 ? G : B
  const keys = [...b.keys].sort((x, y) => get(x) - get(y))
  // At the median by count.
  let acc = 0
  let cut = 1
  for (let i = 0; i < keys.length - 1; i++) {
    acc += hist[keys[i]]
    if (acc >= b.count / 2) {
      cut = i + 1
      break
    }
    cut = i + 1
  }
  const a = keys.slice(0, cut)
  const c = keys.slice(cut)
  const sum = (ks: number[]) => ks.reduce((n, k) => n + hist[k], 0)
  return [
    { keys: a, count: sum(a) },
    { keys: c, count: sum(c) },
  ]
}

/** The image's pixels (RGBA, 8 bits, not premultiplied) as palette indices. */
export function quantize(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, o: QuantizeOptions): Quantized {
  const n = width * height
  const clearOf = (i: number) => o.transparency && rgba[i * 4 + 3] < 128
  // Colours as they'll be shown: laid on the matte where partly transparent (or kept), opaque.
  const px = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255
    for (let c = 0; c < 3; c++) {
      const v = rgba[i * 4 + c]
      px[i * 3 + c] = o.matte && (a < 1 || !o.transparency) ? v * a + o.matte[c] * (1 - a) : v
    }
  }
  const hist = new Uint32Array(32768)
  let opaque = 0
  for (let i = 0; i < n; i++) {
    if (clearOf(i)) continue
    hist[((px[i * 3] >> 3) << 10) | ((px[i * 3 + 1] >> 3) << 5) | (px[i * 3 + 2] >> 3)]++
    opaque++
  }
  const hasClear = o.transparency && opaque < n
  const want = Math.max(1, Math.min(256, Math.round(o.colours)) - (hasClear ? 1 : 0))
  const keys: number[] = []
  for (let k = 0; k < 32768; k++) if (hist[k]) keys.push(k)
  // Few enough colours already: each its own entry, exactly (their mean within the bin).
  let boxes: Box[] = keys.length ? [{ keys, count: opaque }] : []
  while (boxes.length < want) {
    // The box with the most pixels that can still be split.
    let best = -1
    for (let i = 0; i < boxes.length; i++) if (boxes[i].keys.length > 1 && (best < 0 || boxes[i].count > boxes[best].count)) best = i
    if (best < 0) break
    const parts = splitBox(boxes[best], hist)
    if (!parts) break
    boxes = [...boxes.slice(0, best), ...parts, ...boxes.slice(best + 1)]
  }
  // Each box's colour: the mean of the pixels in it, from the pixels themselves.
  const boxOf = new Int16Array(32768).fill(-1)
  boxes.forEach((b, i) => b.keys.forEach((k) => (boxOf[k] = i)))
  const sums = new Float64Array(boxes.length * 4)
  for (let i = 0; i < n; i++) {
    if (clearOf(i)) continue
    const bi = boxOf[((px[i * 3] >> 3) << 10) | ((px[i * 3 + 1] >> 3) << 5) | (px[i * 3 + 2] >> 3)]
    sums[bi * 4] += px[i * 3]
    sums[bi * 4 + 1] += px[i * 3 + 1]
    sums[bi * 4 + 2] += px[i * 3 + 2]
    sums[bi * 4 + 3]++
  }
  const first = hasClear ? 1 : 0
  const entries = first + boxes.length
  const palette = new Uint8Array(Math.max(1, entries) * 3)
  const alpha = new Uint8Array(Math.max(1, entries)).fill(255)
  if (hasClear) alpha[0] = 0
  for (let b = 0; b < boxes.length; b++) {
    const c = sums[b * 4 + 3] || 1
    for (let ch = 0; ch < 3; ch++) palette[(first + b) * 3 + ch] = Math.round(sums[b * 4 + ch] / c)
  }
  // Each pixel to its nearest entry, remembered by 15-bit key when not dithering.
  const nearest = (r: number, g: number, b: number) => {
    let best = first
    let bd = Infinity
    for (let e = first; e < entries; e++) {
      const dr = palette[e * 3] - r
      const dg = palette[e * 3 + 1] - g
      const db = palette[e * 3 + 2] - b
      const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114
      if (d < bd) {
        bd = d
        best = e
      }
    }
    return best
  }
  const indices = new Uint8Array(n)
  const memo = new Int16Array(32768).fill(-1)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (clearOf(i)) {
        indices[i] = 0
        continue
      }
      const r = Math.min(255, Math.max(0, px[i * 3]))
      const g = Math.min(255, Math.max(0, px[i * 3 + 1]))
      const b = Math.min(255, Math.max(0, px[i * 3 + 2]))
      let e: number
      if (o.dither) e = nearest(r, g, b)
      else {
        const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
        e = memo[k] >= 0 ? memo[k] : (memo[k] = nearest(r, g, b))
      }
      indices[i] = e
      if (!o.dither) continue
      // Floyd–Steinberg: the error to the pixels right and below, not into clear ones.
      const er = r - palette[e * 3]
      const eg = g - palette[e * 3 + 1]
      const eb = b - palette[e * 3 + 2]
      const spread = (dx: number, dy: number, w: number) => {
        const xx = x + dx
        const yy = y + dy
        if (xx < 0 || xx >= width || yy >= height) return
        const j = yy * width + xx
        if (clearOf(j)) return
        px[j * 3] += er * w
        px[j * 3 + 1] += eg * w
        px[j * 3 + 2] += eb * w
      }
      spread(1, 0, 7 / 16)
      spread(-1, 1, 3 / 16)
      spread(0, 1, 5 / 16)
      spread(1, 1, 1 / 16)
    }
  }
  return { indices, palette: palette.subarray(0, Math.max(1, entries) * 3), alpha: alpha.subarray(0, Math.max(1, entries)) }
}
