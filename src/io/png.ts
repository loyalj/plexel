/**
 * PNG, our own: decoding every PNG there is (1, 2, 4, 8 and 16 bits, gray,
 * RGB, palette, with or without alpha, interlaced or not) with its ICC
 * profile, and encoding 8 and 16-bit gray and RGB with alpha and a profile.
 *
 * The browser's decoder would convert to 8-bit sRGB and drop the profile,
 * which a 16-bit, wide-gamut photo can't afford (ARCHITECTURE.md, "Import
 * and export"). Compression is the browser's own deflate, through
 * DecompressionStream and CompressionStream, so this is filtering and
 * chunk bookkeeping only. Nothing here touches the DOM.
 */
import { crc32 } from './zip'
import type { Raster } from './raster'

export class PngError extends Error {}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = []
  let n = 0
  const r = stream.getReader()
  for (;;) {
    const { done, value } = await r.read()
    if (done) break
    parts.push(value)
    n += value.length
  }
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export const inflateZlib = (data: Uint8Array): Promise<Uint8Array> => collect(new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')))
export const deflateZlib = (data: Uint8Array) => collect(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate')))

export const isPng = (b: Uint8Array) => SIGNATURE.every((v, i) => b[i] === v)

/** The seven passes of Adam7: start x, start y, step x, step y. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
]

function unfilter(data: Uint8Array, at: number, rows: number, stride: number, bpp: number, out: Uint8Array): number {
  let prev: Uint8Array = new Uint8Array(stride)
  for (let y = 0; y < rows; y++) {
    const filter = data[at++]
    if (at + stride > data.length) throw new PngError('The image data is cut short.')
    const cur = out.subarray(y * stride, (y + 1) * stride)
    cur.set(data.subarray(at, at + stride))
    at += stride
    switch (filter) {
      case 0:
        break
      case 1:
        for (let i = bpp; i < stride; i++) cur[i] = (cur[i] + cur[i - bpp]) & 255
        break
      case 2:
        for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 255
        break
      case 3:
        for (let i = 0; i < stride; i++) cur[i] = (cur[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 255
        break
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0
          const b = prev[i]
          const c = i >= bpp ? prev[i - bpp] : 0
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
        }
        break
      default:
        throw new PngError(`A row uses filter ${filter}, which isn’t one PNG has.`)
    }
    prev = cur
  }
  return at
}

/** Decodes a PNG into a Raster: gray or RGB, 8 or 16-bit, always with alpha. */
export async function decodePng(bytes: Uint8Array): Promise<Raster> {
  if (!isPng(bytes)) throw new PngError('This isn’t a PNG file.')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0
  let height = 0
  let bitDepth = 0
  let colourType = -1
  let interlace = 0
  let palette: Uint8Array | null = null
  let trns: Uint8Array | null = null
  let icc: Uint8Array | null = null
  let srgb = false
  const warnings: string[] = []
  const idat: Uint8Array[] = []
  let at = 8
  while (at + 12 <= bytes.length) {
    const len = dv.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    if (at + 12 + len > bytes.length) {
      warnings.push('The file ends partway through; read what was there')
      break
    }
    const data = bytes.subarray(at + 8, at + 8 + len)
    if (crc32(bytes.subarray(at + 4, at + 8 + len)) !== dv.getUint32(at + 8 + len)) {
      if (type === 'IHDR' || type === 'IDAT') warnings.push(`The ${type} chunk’s checksum doesn’t match; the image may be damaged`)
    }
    if (type === 'IHDR') {
      const h = new DataView(data.buffer, data.byteOffset, data.byteLength)
      width = h.getUint32(0)
      height = h.getUint32(4)
      bitDepth = data[8]
      colourType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'sRGB') srgb = true
    else if (type === 'iCCP') {
      const nul = data.indexOf(0)
      try {
        icc = await inflateZlib(data.subarray(nul + 2))
      } catch {
        warnings.push('Its colour profile couldn’t be read, so it was treated as sRGB')
      }
    } else if (type === 'IEND') break
    at += 12 + len
  }
  if (!width || !height) throw new PngError('The PNG has no image header.')
  const okDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
  if (!okDepths[colourType]?.includes(bitDepth)) throw new PngError(`The PNG says it has colour type ${colourType} at ${bitDepth} bits, which isn’t a valid PNG.`)
  if (colourType === 3 && !palette) throw new PngError('The PNG uses a palette but has none.')
  if (!idat.length) throw new PngError('The PNG has no image data.')

  const total = idat.reduce((n, d) => n + d.length, 0)
  const joined = new Uint8Array(total)
  let o = 0
  for (const d of idat) {
    joined.set(d, o)
    o += d.length
  }
  let raw: Uint8Array
  try {
    raw = await inflateZlib(joined)
  } catch {
    throw new PngError('The PNG’s image data doesn’t decompress.')
  }

  const samples = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType as 0 | 2 | 3 | 4 | 6]
  const bitsPerPixel = samples * bitDepth
  const bpp = Math.max(1, bitsPerPixel >> 3)
  const gray = colourType === 0 || colourType === 4
  const deep = bitDepth === 16
  const outCh = gray ? 2 : 4
  const out = deep ? new Uint16Array(width * height * outCh) : new Uint8Array(width * height * outCh)
  const max = deep ? 65535 : 255

  const key = (() => {
    if (!trns) return null
    const t = new DataView(trns.buffer, trns.byteOffset, trns.byteLength)
    if (colourType === 0 && trns.length >= 2) return [t.getUint16(0)]
    if (colourType === 2 && trns.length >= 6) return [t.getUint16(0), t.getUint16(2), t.getUint16(4)]
    return null
  })()

  /** Writes one decoded row of a pass into the image. */
  const emit = (row: Uint8Array, y: number, x0: number, dx: number, count: number) => {
    const sample = (i: number) => {
      if (bitDepth === 16) return (row[i * 2] << 8) | row[i * 2 + 1]
      if (bitDepth === 8) return row[i]
      const per = 8 / bitDepth
      const b = row[Math.floor(i / per)]
      const shift = 8 - bitDepth * ((i % per) + 1)
      return (b >> shift) & ((1 << bitDepth) - 1)
    }
    const scale = bitDepth < 8 && colourType === 0 ? 255 / ((1 << bitDepth) - 1) : 1
    for (let k = 0; k < count; k++) {
      const x = x0 + k * dx
      const d = (y * width + x) * outCh
      if (colourType === 3) {
        const idx = sample(k)
        out[d] = palette![idx * 3] ?? 0
        out[d + 1] = palette![idx * 3 + 1] ?? 0
        out[d + 2] = palette![idx * 3 + 2] ?? 0
        out[d + 3] = trns && idx < trns.length ? trns[idx] : 255
      } else if (colourType === 0) {
        const v = sample(k)
        out[d] = Math.round(v * scale)
        out[d + 1] = key && v === key[0] ? 0 : max
      } else if (colourType === 4) {
        out[d] = sample(k * 2)
        out[d + 1] = sample(k * 2 + 1)
      } else if (colourType === 2) {
        const r = sample(k * 3)
        const g = sample(k * 3 + 1)
        const b = sample(k * 3 + 2)
        out[d] = r
        out[d + 1] = g
        out[d + 2] = b
        out[d + 3] = key && r === key[0] && g === key[1] && b === key[2] ? 0 : max
      } else {
        for (let c = 0; c < 4; c++) out[d + c] = sample(k * 4 + c)
      }
    }
  }

  let pos = 0
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]]
  try {
    for (const [sx, sy, dx, dy] of passes) {
      const cols = Math.ceil((width - sx) / dx)
      const rows = Math.ceil((height - sy) / dy)
      if (cols <= 0 || rows <= 0) continue
      const stride = Math.ceil((cols * bitsPerPixel) / 8)
      const buf = new Uint8Array(stride * rows)
      pos = unfilter(raw, pos, rows, stride, bpp, buf)
      for (let r = 0; r < rows; r++) emit(buf.subarray(r * stride, (r + 1) * stride), sy + r * dy, sx, dx, cols)
    }
  } catch (e) {
    if (!(e instanceof PngError)) throw e
    warnings.push(`${e.message} What was read is kept, and the rest is transparent.`)
  }
  return { width, height, mode: gray ? 'gray' : 'rgb', depth: deep ? 16 : 8, data: out, icc, srgb, warnings }
}

// --- encoding --------------------------------------------------------------------

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** Filters a row with whichever of PNG's five filters leaves the smallest numbers, the usual heuristic. */
function filterRow(cur: Uint8Array, prev: Uint8Array, bpp: number, out: Uint8Array) {
  const n = cur.length
  let best = Infinity
  let bestType = 0
  const tmp = new Uint8Array(n)
  for (let t = 0; t <= 4; t++) {
    let sum = 0
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let p = 0
      if (t === 1) p = a
      else if (t === 2) p = b
      else if (t === 3) p = (a + b) >> 1
      else if (t === 4) {
        const q = a + b - c
        const pa = Math.abs(q - a)
        const pb = Math.abs(q - b)
        const pc = Math.abs(q - c)
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      const v = (cur[i] - p) & 255
      tmp[i] = v
      sum += v < 128 ? v : 256 - v
      if (sum >= best) break
    }
    if (sum < best) {
      best = sum
      bestType = t
      out[0] = t
      out.set(tmp, 1)
    }
  }
  return bestType
}

export interface PngHeader {
  width: number
  height: number
  mode: 'rgb' | 'gray'
  depth: 8 | 16
  /** With alpha (RGBA or gray + alpha) or without. */
  alpha: boolean
  icc: Uint8Array | null
  /** The profile's name for the iCCP chunk. */
  iccName?: string
}

/**
 * Encodes rows as they come: `rows` yields bands of rows, each sample
 * interleaved (RGB(A) or gray(+A)), 16-bit samples as numbers, not bytes.
 * Only the compressed result is kept in memory, never the whole image.
 */
export async function encodePng(h: PngHeader, rows: AsyncIterable<Uint8Array | Uint16Array>): Promise<Blob> {
  const channels = (h.mode === 'rgb' ? 3 : 1) + (h.alpha ? 1 : 0)
  const bytesPer = h.depth / 8
  const stride = h.width * channels * bytesPer
  const bpp = channels * bytesPer
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, h.width)
  dv.setUint32(4, h.height)
  ihdr[8] = h.depth
  ihdr[9] = h.mode === 'rgb' ? (h.alpha ? 6 : 2) : h.alpha ? 4 : 0
  const parts: BlobPart[] = [new Uint8Array(SIGNATURE), chunk('IHDR', ihdr) as BlobPart]
  if (h.icc) {
    const name = new TextEncoder().encode((h.iccName ?? 'ICC profile').replace(/[^\x20-\x7e]/g, '').slice(0, 79) || 'ICC profile')
    const z = await deflateZlib(h.icc)
    const body = new Uint8Array(name.length + 2 + z.length)
    body.set(name)
    body.set(z, name.length + 2)
    parts.push(chunk('iCCP', body) as BlobPart)
  }

  const cs = new CompressionStream('deflate')
  const writer = cs.writable.getWriter()
  const compressed = collect(cs.readable)
  let prev: Uint8Array = new Uint8Array(stride)
  let written = 0
  for await (const band of rows) {
    const per = h.width * channels
    const count = band.length / per
    const filtered = new Uint8Array(count * (stride + 1))
    for (let r = 0; r < count; r++) {
      const cur = new Uint8Array(stride)
      if (h.depth === 16) {
        for (let i = 0; i < per; i++) {
          const v = band[r * per + i]
          cur[i * 2] = v >> 8
          cur[i * 2 + 1] = v & 255
        }
      } else cur.set((band as Uint8Array).subarray(r * per, (r + 1) * per))
      filterRow(cur, prev, bpp, filtered.subarray(r * (stride + 1), (r + 1) * (stride + 1)))
      prev = cur
    }
    written += count
    await writer.write(filtered as Uint8Array<ArrayBuffer>)
  }
  await writer.close()
  if (written !== h.height) throw new PngError(`The image had ${written} rows, not ${h.height}.`)
  const z = await compressed
  // IDAT chunks of up to 1 MB, as encoders usually write them.
  for (let i = 0; i < z.length; i += 1 << 20) parts.push(chunk('IDAT', z.subarray(i, Math.min(z.length, i + (1 << 20)))) as BlobPart)
  parts.push(chunk('IEND', new Uint8Array(0)) as BlobPart)
  return new Blob(parts, { type: 'image/png' })
}
