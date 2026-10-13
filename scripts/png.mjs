/**
 * Just enough PNG decoding to read back a screenshot or a reference image:
 * 8-bit gray, RGB and their alpha forms, and palettes at 1 to 8 bits, not
 * interlaced. Chrome's screenshots are 8-bit RGB(A); some reference renders
 * (resvg's) are palettes. The browser suites use it to ask what colour the
 * engine actually drew, since the canvas belongs to the worker and the
 * page can't read it.
 *
 * This is test tooling, not the app's PNG reader. That one (src/io, phase
 * 4) handles every depth, palette and profile.
 */
import { inflateSync } from 'node:zlib'

export function decodePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!sig.every((b, i) => buf[i] === b)) throw new Error('not a PNG')
  let width = 0
  let height = 0
  let depth = 8
  let colour = 2
  let palette = null
  let trns = null
  const idat = []
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    const data = buf.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colour = data[9]
      const ok = colour === 3 ? [1, 2, 4, 8].includes(depth) : depth === 8 && [0, 2, 4, 6].includes(colour)
      if (!ok || data[12] !== 0) throw new Error(`unsupported PNG: depth ${depth}, colour type ${colour}, interlace ${data[12]}`)
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    at += 12 + len
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour]
  const bpp = Math.max(1, (channels * depth) >> 3)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = Math.ceil((width * channels * depth) / 8)
  const out = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  const cur = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = cur[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 255
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (colour === 3) {
        const bit = x * depth
        const i = (cur[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)
        out[o] = palette[i * 3]
        out[o + 1] = palette[i * 3 + 1]
        out[o + 2] = palette[i * 3 + 2]
        out[o + 3] = trns && i < trns.length ? trns[i] : 255
      } else if (colour === 0 || colour === 4) {
        out[o] = out[o + 1] = out[o + 2] = cur[x * channels]
        out[o + 3] = colour === 4 ? cur[x * channels + 1] : 255
      } else {
        out[o] = cur[x * channels]
        out[o + 1] = cur[x * channels + 1]
        out[o + 2] = cur[x * channels + 2]
        out[o + 3] = channels === 4 ? cur[x * channels + 3] : 255
      }
    }
    cur.copy(prev)
  }
  return { width, height, data: out }
}

/** The pixel at (x, y) as [r, g, b, a]. */
export const pixelAt = (img, x, y) => {
  const o = (y * img.width + x) * 4
  return [...img.data.subarray(o, o + 4)]
}

/** `#rrggbb` to [r, g, b]. */
export const hexRgb = (hex) => {
  const h = hex.trim().replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
}
