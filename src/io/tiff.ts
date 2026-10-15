/**
 * TIFF, our own decoder: the first image of a file, in strips or tiles,
 * uncompressed or LZW, Deflate or PackBits, with horizontal prediction;
 * 1, 2, 4, 8 and 16-bit gray, palette, RGB and CMYK, with an alpha channel
 * (associated or not) and the embedded ICC profile.
 *
 * Layers in TIFF files (Photoshop's private tag) and floating-point images
 * come later; a file that has only those still opens as its flattened
 * image, or says plainly why it can't.
 */
import { inflateZlib } from './png'
import type { Raster } from './raster'

class TiffError extends Error {}

export const isTiff = (b: Uint8Array) => (b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42)

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 }

/** TIFF's LZW: MSB-first codes, 9 to 12 bits, with the early change. */
export function lzwDecode(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected)
  let o = 0
  const prefix = new Int32Array(4096)
  const suffix = new Uint8Array(4096)
  const first = new Uint8Array(4096)
  const length = new Uint16Array(4096)
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1
    suffix[i] = i
    first[i] = i
    length[i] = 1
  }
  let next = 258
  let width = 9
  let bitPos = 0
  let old = -1
  const read = () => {
    let v = 0
    for (let i = 0; i < width; i++) {
      const byte = input[(bitPos + i) >> 3]
      if (byte === undefined) return 257
      v = (v << 1) | ((byte >> (7 - ((bitPos + i) & 7))) & 1)
    }
    bitPos += width
    return v
  }
  const write = (code: number) => {
    const n = length[code]
    let c = code
    for (let i = n - 1; i >= 0; i--) {
      if (o + i < expected) out[o + i] = suffix[c]
      c = prefix[c]
    }
    o += n
  }
  for (;;) {
    const code = read()
    if (code === 257 || o >= expected) break
    if (code === 256) {
      next = 258
      width = 9
      old = -1
      continue
    }
    if (old === -1) {
      if (code > 255) throw new TiffError('The LZW data is damaged.')
      write(code)
      old = code
      continue
    }
    if (code < next) {
      write(code)
      if (next < 4096) {
        prefix[next] = old
        suffix[next] = first[code]
        first[next] = first[old]
        length[next] = length[old] + 1
        next++
      }
    } else {
      if (code !== next || next >= 4096) throw new TiffError('The LZW data is damaged.')
      prefix[next] = old
      suffix[next] = first[old]
      first[next] = first[old]
      length[next] = length[old] + 1
      next++
      write(code)
    }
    old = code
    if (next + 1 >= 1 << width && width < 12) width++
  }
  return out
}

export function packBitsDecode(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected)
  let i = 0
  let o = 0
  while (i < input.length && o < expected) {
    const n = (input[i++] << 24) >> 24
    if (n >= 0) {
      out.set(input.subarray(i, i + n + 1).subarray(0, expected - o), o)
      i += n + 1
      o += n + 1
    } else if (n !== -128) {
      out.fill(input[i++], o, Math.min(expected, o + 1 - n))
      o += 1 - n
    }
  }
  return out
}

interface Ifd {
  get(tag: number): number[] | undefined
  bytes(tag: number): Uint8Array | undefined
}

function readIfd(b: Uint8Array, dv: DataView, le: boolean, at: number): Ifd {
  const count = dv.getUint16(at, le)
  const entries = new Map<number, { type: number; n: number; off: number }>()
  for (let i = 0; i < count; i++) {
    const e = at + 2 + i * 12
    if (e + 12 > b.length) break
    const tag = dv.getUint16(e, le)
    const type = dv.getUint16(e + 2, le)
    const n = dv.getUint32(e + 4, le)
    const size = (TYPE_SIZE[type] ?? 1) * n
    entries.set(tag, { type, n, off: size <= 4 ? e + 8 : dv.getUint32(e + 8, le) })
  }
  const value = (type: number, off: number) => {
    switch (type) {
      case 3:
        return dv.getUint16(off, le)
      case 4:
        return dv.getUint32(off, le)
      case 8:
        return dv.getInt16(off, le)
      case 9:
        return dv.getInt32(off, le)
      case 5:
        return dv.getUint32(off, le) / (dv.getUint32(off + 4, le) || 1)
      default:
        return b[off]
    }
  }
  return {
    get(tag) {
      const e = entries.get(tag)
      if (!e) return undefined
      const size = TYPE_SIZE[e.type] ?? 1
      if (e.off + size * e.n > b.length) throw new TiffError(`A field (tag ${tag}) points past the end of the file.`)
      return Array.from({ length: e.n }, (_, i) => value(e.type, e.off + i * size))
    },
    bytes(tag) {
      const e = entries.get(tag)
      if (!e) return undefined
      const len = (TYPE_SIZE[e.type] ?? 1) * e.n
      return b.subarray(e.off, e.off + len)
    },
  }
}

export async function decodeTiff(bytes: Uint8Array): Promise<Raster> {
  if (!isTiff(bytes)) throw new TiffError(bytes[2] === 43 || bytes[3] === 43 ? 'This is a BigTIFF, which isn’t supported yet.' : 'This isn’t a TIFF file.')
  const le = bytes[0] === 0x49
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ifd = readIfd(bytes, dv, le, dv.getUint32(4, le))
  const one = (tag: number, d: number) => ifd.get(tag)?.[0] ?? d
  const warnings: string[] = []

  const width = one(256, 0)
  const height = one(257, 0)
  if (!width || !height) throw new TiffError('The TIFF has no image size.')
  const spp = one(277, 1)
  const bits = ifd.get(258) ?? [1]
  const bps = bits[0]
  if (bits.some((b) => b !== bps)) throw new TiffError('The TIFF’s channels have different bit depths, which isn’t supported.')
  if (![1, 2, 4, 8, 16].includes(bps)) throw new TiffError(`The TIFF has ${bps}-bit channels; 1, 2, 4, 8 and 16-bit ones are supported.`)
  if (one(339, 1) !== 1) throw new TiffError('The TIFF holds floating-point or signed samples, which arrive with 32-bit documents.')
  const compression = one(259, 1)
  if (![1, 5, 8, 32946, 32773].includes(compression)) {
    const name = { 7: 'JPEG', 6: 'old-style JPEG', 2: 'CCITT', 3: 'CCITT fax', 4: 'CCITT fax' }[compression] ?? `method ${compression}`
    throw new TiffError(`The TIFF is compressed with ${name}, which isn’t supported yet. Uncompressed, LZW, ZIP and PackBits are.`)
  }
  const photometric = one(262, spp >= 3 ? 2 : 1)
  const planar = one(284, 1)
  const predictor = one(317, 1)
  if (predictor === 3) throw new TiffError('The TIFF uses floating-point prediction, which arrives with 32-bit documents.')
  const extra = ifd.get(338) ?? []
  const colourCh = photometric === 2 ? 3 : photometric === 5 ? (one(332, 1) === 1 ? 4 : spp - extra.length) : 1
  if (photometric === 5 && colourCh !== 4) throw new TiffError('The TIFF is a separated image with inks other than CMYK, which isn’t supported.')
  if (![0, 1, 2, 3, 5].includes(photometric)) {
    const name = { 6: 'YCbCr', 8: 'CIE Lab', 4: 'a transparency mask' }[photometric] ?? `photometric ${photometric}`
    throw new TiffError(`The TIFF’s colours are ${name}, which isn’t supported yet.`)
  }
  const hasAlpha = spp > colourCh && extra.length > 0 && (extra[0] === 1 || extra[0] === 2)
  const associated = hasAlpha && extra[0] === 1
  const mode = photometric === 2 || photometric === 3 ? 'rgb' : photometric === 5 ? 'cmyk' : 'gray'
  const depth = bps === 16 ? 16 : 8
  const outColour = mode === 'rgb' ? 3 : mode === 'cmyk' ? 4 : 1
  const outCh = outColour + 1
  const max = depth === 16 ? 65535 : 255
  const out = depth === 16 ? new Uint16Array(width * height * outCh) : new Uint8Array(width * height * outCh)

  const tiled = ifd.get(322) !== undefined
  const tw = tiled ? one(322, 0) : width
  const th = tiled ? one(323, 0) : one(278, height)
  const offsets = (tiled ? ifd.get(324) : ifd.get(273)) ?? []
  const counts = (tiled ? ifd.get(325) : ifd.get(279)) ?? []
  if (!offsets.length) throw new TiffError('The TIFF has no image data.')
  const across = tiled ? Math.ceil(width / tw) : 1
  const down = Math.ceil(height / th)
  const perPlane = across * down
  const colourMap = photometric === 3 ? ifd.get(320) : undefined
  if (photometric === 3 && !colourMap) throw new TiffError('The TIFF uses a palette but has none.')
  const icc = ifd.bytes(34675) ?? null

  const samplesIn = planar === 2 ? 1 : spp
  const rowBytes = Math.ceil((tw * samplesIn * bps) / 8)
  for (let i = 0; i < offsets.length; i++) {
    const plane = planar === 2 ? Math.floor(i / perPlane) : 0
    const block = i % perPlane
    const bx = (block % across) * tw
    const by = Math.floor(block / across) * th
    if (by >= height) continue
    const rows = Math.min(th, tiled ? th : height - by)
    const expected = rowBytes * rows
    const src = bytes.subarray(offsets[i], offsets[i] + (counts[i] ?? expected))
    let data: Uint8Array
    try {
      if (compression === 1) data = src
      else if (compression === 5) data = lzwDecode(src, expected)
      else if (compression === 32773) data = packBitsDecode(src, expected)
      else data = await inflateZlib(src)
    } catch (e) {
      warnings.push(`A part of the image couldn’t be decompressed (${e instanceof Error ? e.message : String(e)}); it was left transparent`)
      continue
    }
    for (let r = 0; r < rows; r++) {
      const y = by + r
      if (y >= height) break
      const row = data.subarray(r * rowBytes, (r + 1) * rowBytes)
      const n = tw * samplesIn
      const vals = new Uint32Array(n)
      for (let s = 0; s < n; s++) {
        if (bps === 16) vals[s] = le ? row[s * 2] | (row[s * 2 + 1] << 8) : (row[s * 2] << 8) | row[s * 2 + 1]
        else if (bps === 8) vals[s] = row[s]
        else {
          const bit = s * bps
          vals[s] = (row[bit >> 3] >> (8 - bps - (bit & 7))) & ((1 << bps) - 1)
        }
      }
      if (predictor === 2) for (let s = samplesIn; s < n; s++) vals[s] = (vals[s] + vals[s - samplesIn]) & (bps === 16 ? 0xffff : 0xff)
      for (let x = 0; x < tw; x++) {
        const ox = bx + x
        if (ox >= width) break
        const d = (y * width + ox) * outCh
        const get = (c: number) => vals[x * samplesIn + c]
        if (planar === 2) {
          // One plane at a time: plane `plane` is channel `plane`.
          writeChannel(out, d, plane, get(0))
          continue
        }
        for (let c = 0; c < Math.min(spp, colourCh + (hasAlpha ? 1 : 0)); c++) writeChannel(out, d, c, get(c))
        if (!hasAlpha) out[d + outColour] = max
      }
    }
  }

  function writeChannel(o: Uint8Array | Uint16Array, d: number, c: number, v: number) {
    if (photometric === 3) {
      if (c > 0) {
        if (c === 1 && hasAlpha) o[d + 3] = scale(v)
        return
      }
      const n = colourMap!.length / 3
      const k = depth === 16 ? 1 : 1 / 257
      o[d] = Math.round(colourMap![v] * k)
      o[d + 1] = Math.round(colourMap![n + v] * k)
      o[d + 2] = Math.round(colourMap![2 * n + v] * k)
      if (!hasAlpha) o[d + 3] = max
      return
    }
    if (c < outColour) o[d + c] = photometric === 0 ? max - scale(v) : scale(v)
    else if (c === outColour) o[d + c] = scale(v)
    if (planar === 2 && c === 0 && !hasAlpha) o[d + outColour] = max
  }
  function scale(v: number) {
    return bps < 8 ? Math.round((v * 255) / ((1 << bps) - 1)) : v
  }

  if (associated) {
    // Premultiplied alpha, which the document doesn't keep: divided out.
    for (let p = 0; p < width * height; p++) {
      const a = out[p * outCh + outColour]
      if (a === 0 || a === max) continue
      for (let c = 0; c < outColour; c++) out[p * outCh + c] = Math.min(max, Math.round((out[p * outCh + c] * max) / a))
    }
  }
  if (extra.length > 1 || (spp > colourCh + 1 && !hasAlpha)) warnings.push('The TIFF has extra channels that were left out')
  return { width, height, mode, depth, data: out, icc, warnings }
}
