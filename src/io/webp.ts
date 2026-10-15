/**
 * WebP files, as far as Plexel writes them: the browser encodes the
 * pixels (lossy at a quality, or lossless), and this puts the document's
 * colour profile in, which the browser's encoder leaves out. A simple
 * file (one VP8 or VP8L chunk) becomes an extended one: a VP8X chunk
 * saying there's a profile (and transparency, if the pixels have any),
 * then the ICCP chunk, then the rest as it was.
 *
 * Layout (Google's "WebP Container Specification"): "RIFF", the size of
 * what follows, "WEBP", then chunks: a four-letter tag, a little-endian
 * size, the data, and a byte of padding when the size is odd.
 */

export class WebpError extends Error {}

interface Chunk {
  tag: string
  data: Uint8Array
}

const tagOf = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0

/** Whether the bytes are a WebP file. */
export const isWebp = (b: Uint8Array) => b.length >= 12 && tagOf(b, 0) === 'RIFF' && tagOf(b, 8) === 'WEBP'

/** A WebP file's chunks, in order. */
export function webpChunks(b: Uint8Array): Chunk[] {
  if (!isWebp(b)) throw new WebpError('This isn’t a WebP file.')
  const end = Math.min(b.length, 8 + u32(b, 4))
  const out: Chunk[] = []
  let at = 12
  while (at + 8 <= end) {
    const size = u32(b, at + 4)
    if (at + 8 + size > end) throw new WebpError('The WebP file is cut short.')
    out.push({ tag: tagOf(b, at), data: b.subarray(at + 8, at + 8 + size) })
    at += 8 + size + (size & 1)
  }
  return out
}

function writeChunks(chunks: Chunk[]): Uint8Array {
  const size = 4 + chunks.reduce((n, c) => n + 8 + c.data.length + (c.data.length & 1), 0)
  const out = new Uint8Array(8 + size)
  const put32 = (at: number, v: number) => {
    out[at] = v & 255
    out[at + 1] = (v >>> 8) & 255
    out[at + 2] = (v >>> 16) & 255
    out[at + 3] = (v >>> 24) & 255
  }
  const putTag = (at: number, t: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = t.charCodeAt(i)
  }
  putTag(0, 'RIFF')
  put32(4, size)
  putTag(8, 'WEBP')
  let at = 12
  for (const c of chunks) {
    putTag(at, c.tag)
    put32(at + 4, c.data.length)
    out.set(c.data, at + 8)
    at += 8 + c.data.length + (c.data.length & 1)
  }
  return out
}

/** VP8X's flags. */
const ICC = 0x20
const ALPHA = 0x10

/** Whether a lossless (VP8L) image says it uses its alpha. */
const vp8lAlpha = (d: Uint8Array) => d.length >= 5 && d[0] === 0x2f && ((u32(d, 1) >>> 28) & 1) === 1

/** A WebP file with `icc` as its colour profile (any it had replaced); `width` and `height` are the image's. */
export function withWebpIcc(bytes: Uint8Array, icc: Uint8Array, width: number, height: number): Uint8Array {
  const chunks = webpChunks(bytes).filter((c) => c.tag !== 'ICCP')
  const iccp: Chunk = { tag: 'ICCP', data: icc }
  const x = chunks.find((c) => c.tag === 'VP8X')
  if (x) {
    const data = new Uint8Array(x.data)
    data[0] |= ICC
    // The profile comes straight after VP8X.
    const rest = chunks.filter((c) => c !== x)
    return writeChunks([{ tag: 'VP8X', data }, iccp, ...rest])
  }
  const image = chunks.find((c) => c.tag === 'VP8 ' || c.tag === 'VP8L')
  if (!image) throw new WebpError('The WebP file has no image in it.')
  const alpha = chunks.some((c) => c.tag === 'ALPH') || (image.tag === 'VP8L' && vp8lAlpha(image.data))
  const data = new Uint8Array(10)
  data[0] = ICC | (alpha ? ALPHA : 0)
  const w = width - 1
  const h = height - 1
  data.set([w & 255, (w >>> 8) & 255, (w >>> 16) & 255, h & 255, (h >>> 8) & 255, (h >>> 16) & 255], 4)
  return writeChunks([{ tag: 'VP8X', data }, iccp, ...chunks])
}

/** What a WebP file holds, for the checks: lossless or not, transparency, a profile. */
export function webpInfo(bytes: Uint8Array): { lossless: boolean; alpha: boolean; icc: Uint8Array | null; width: number; height: number } {
  const chunks = webpChunks(bytes)
  const x = chunks.find((c) => c.tag === 'VP8X')
  const l = chunks.find((c) => c.tag === 'VP8L')
  const v = chunks.find((c) => c.tag === 'VP8 ')
  let width = 0
  let height = 0
  if (x) {
    width = 1 + (x.data[4] | (x.data[5] << 8) | (x.data[6] << 16))
    height = 1 + (x.data[7] | (x.data[8] << 8) | (x.data[9] << 16))
  } else if (l) {
    const w = u32(l.data, 1)
    width = (w & 0x3fff) + 1
    height = ((w >>> 14) & 0x3fff) + 1
  } else if (v && v.data.length >= 10) {
    width = (v.data[6] | (v.data[7] << 8)) & 0x3fff
    height = (v.data[8] | (v.data[9] << 8)) & 0x3fff
  }
  return {
    lossless: !!l,
    alpha: x ? (x.data[0] & ALPHA) !== 0 : !!l && vp8lAlpha(l.data),
    icc: chunks.find((c) => c.tag === 'ICCP')?.data ?? null,
    width,
    height,
  }
}
