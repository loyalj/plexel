/**
 * The image codecs: PNG in and out, TIFF in, JPEG's markers, and images
 * into tiles.
 *
 * PNGs and TIFFs are built here byte by byte, in every variant the decoders
 * claim (bit depths, colour types, palettes, keyed transparency, Adam7,
 * strips and tiles, LZW, Deflate and PackBits, prediction, planar layout,
 * byte orders, associated alpha), from known pixels, so a decoded image is
 * compared with what was put in rather than with another decoder's opinion.
 * PNG's own encoder is checked by reading back what it wrote, and against
 * Node's zlib.
 *
 * Run with: npm run check:images
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { decodePng, encodePng, encodePngIndexed } from '../src/io/png'
import { decodeTiff, lzwDecode, packBitsDecode } from '../src/io/tiff'
import { readJpegInfo, withIcc } from '../src/io/jpeg'
import { decodeImage, rasterToSet, sniff, type Raster } from '../src/io/raster'
import { crc32 } from '../src/io/zip'
import { TileStore } from '../src/tiles/store'
import { memorySpill } from '../src/tiles/spill'
import { TILE, TILE_PIXELS } from '../src/tiles/format'
import { isWebp, webpChunks, webpInfo, withWebpIcc } from '../src/io/webp'
import { quantize } from '../src/io/quantize'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}
let seed = 5
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i])
const noJpeg = async (): Promise<Raster> => {
  throw new Error('no JPEG decoder in Node')
}

// --- PNG, built by hand ---------------------------------------------------------------
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  out.set([...type].map((c) => c.charCodeAt(0)), 4)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}
const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Packs samples into a PNG scanline at a bit depth. */
function packRow(samples: number[], depth: number): Uint8Array {
  if (depth === 8) return new Uint8Array(samples)
  if (depth === 16) return new Uint8Array(samples.flatMap((v) => [v >> 8, v & 255]))
  const out = new Uint8Array(Math.ceil((samples.length * depth) / 8))
  samples.forEach((v, i) => {
    const bit = i * depth
    out[bit >> 3] |= v << (8 - depth - (bit & 7))
  })
  return out
}

/** A PNG of `rows` (samples per row, interleaved), unfiltered or with Adam7 passes. */
function buildPng(o: { width: number; height: number; depth: number; colour: number; rows: number[][]; spp: number; interlace?: boolean; extra?: Uint8Array[] }): Uint8Array {
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, o.width)
  dv.setUint32(4, o.height)
  ihdr[8] = o.depth
  ihdr[9] = o.colour
  ihdr[12] = o.interlace ? 1 : 0
  const raw: number[] = []
  const passes = o.interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]]
  for (const [sx, sy, dx, dy] of passes) {
    for (let y = sy; y < o.height; y += dy) {
      const samples: number[] = []
      for (let x = sx; x < o.width; x += dx) samples.push(...o.rows[y].slice(x * o.spp, (x + 1) * o.spp))
      if (!samples.length) continue
      raw.push(0, ...packRow(samples, o.depth))
    }
  }
  return join([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...(o.extra ?? []), chunk('IDAT', deflateSync(new Uint8Array(raw))), chunk('IEND', new Uint8Array(0))])
}

console.log('\nPNG')
{
  // 8-bit RGBA, read back exactly.
  const w = 37
  const h = 23
  const rows = Array.from({ length: h }, () => Array.from({ length: w * 4 }, () => Math.floor(rand() * 256)))
  const r = await decodePng(buildPng({ width: w, height: h, depth: 8, colour: 6, rows, spp: 4 }))
  check('8-bit RGBA reads back sample for sample', r.mode === 'rgb' && r.depth === 8 && same(r.data, rows.flat()))
  const ri = await decodePng(buildPng({ width: w, height: h, depth: 8, colour: 6, rows, spp: 4, interlace: true }))
  check('so does the same image interlaced (Adam7)', same(ri.data, rows.flat()))

  const rows16 = Array.from({ length: h }, () => Array.from({ length: w * 3 }, () => Math.floor(rand() * 65536)))
  const r16 = await decodePng(buildPng({ width: w, height: h, depth: 16, colour: 2, rows: rows16, spp: 3 }))
  const want16 = rows16.flatMap((row) => Array.from({ length: w }, (_, x) => [...row.slice(x * 3, x * 3 + 3), 65535]).flat())
  check('16-bit RGB stays 16-bit, with opaque alpha added', r16.depth === 16 && r16.mode === 'rgb' && same(r16.data, want16))

  const g = Array.from({ length: h }, () => Array.from({ length: w }, () => Math.floor(rand() * 4)))
  const r2 = await decodePng(buildPng({ width: w, height: h, depth: 2, colour: 0, rows: g, spp: 1 }))
  check('2-bit gray is scaled to 8 bits (3 → 255)', r2.mode === 'gray' && r2.depth === 8 && same(r2.data, g.flat().flatMap((v) => [v * 85, 255])))
  const g1 = Array.from({ length: 9 }, () => Array.from({ length: 13 }, () => (rand() < 0.5 ? 1 : 0)))
  const r1 = await decodePng(buildPng({ width: 13, height: 9, depth: 1, colour: 0, rows: g1, spp: 1, interlace: true }))
  check('1-bit gray, interlaced, odd sizes', same(r1.data, g1.flat().flatMap((v) => [v * 255, 255])))

  const pal = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9])
  const trns = new Uint8Array([255, 128, 0])
  const idx = Array.from({ length: 5 }, () => Array.from({ length: 7 }, () => Math.floor(rand() * 4)))
  const rp = await decodePng(buildPng({ width: 7, height: 5, depth: 4, colour: 3, rows: idx, spp: 1, extra: [chunk('PLTE', pal), chunk('tRNS', trns)] }))
  check('a 4-bit palette becomes RGBA, with tRNS alpha (and opaque past its end)', same(rp.data, idx.flat().flatMap((i) => [pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2], i < 3 ? trns[i] : 255])))

  const key = new Uint8Array([0, 10, 0, 20, 0, 30])
  const kr = [[10, 20, 30, 10, 20, 31]]
  const rk = await decodePng(buildPng({ width: 2, height: 1, depth: 8, colour: 2, rows: kr, spp: 3, extra: [chunk('tRNS', key)] }))
  check('an RGB tRNS key makes that one colour transparent', same(rk.data, [10, 20, 30, 0, 10, 20, 31, 255]))

  const icc = new Uint8Array(300).map((_, i) => i & 255)
  const iccp = join([new TextEncoder().encode('Test'), new Uint8Array([0, 0]), deflateSync(icc)])
  const ri2 = await decodePng(buildPng({ width: 1, height: 1, depth: 8, colour: 0, rows: [[5]], spp: 1, extra: [chunk('iCCP', iccp)] }))
  check('the iCCP profile comes out whole', !!ri2.icc && same(ri2.icc, icc))

  const good = buildPng({ width: w, height: h, depth: 8, colour: 6, rows, spp: 4 })
  const cut = good.slice(0, good.length - 40)
  const rc = await decodePng(cut).catch((e) => e)
  check('a PNG cut short says so rather than crashing', rc instanceof Error || (rc as Raster).warnings.length > 0, rc instanceof Error ? rc.message : (rc as Raster).warnings.join('; '))
  check('a file that isn’t a PNG is refused, saying so', /isn’t a PNG/.test(String(await decodePng(new Uint8Array(20)).catch((e) => e.message))))

  // Our encoder: written, then read back by our decoder and Node's zlib.
  for (const [mode, depth, alpha] of [['rgb', 8, true], ['rgb', 16, true], ['gray', 8, true], ['gray', 16, false], ['rgb', 8, false]] as const) {
    const ch = (mode === 'rgb' ? 3 : 1) + (alpha ? 1 : 0)
    const W = 70
    const H = 41
    const max = depth === 16 ? 65535 : 255
    const px = depth === 16 ? new Uint16Array(W * H * ch) : new Uint8Array(W * H * ch)
    for (let i = 0; i < px.length; i++) px[i] = Math.floor(((i % (W * ch)) / (W * ch)) * max * 0.8 + rand() * max * 0.2)
    async function* bands() {
      for (let y = 0; y < H; y += 16) yield px.subarray(y * W * ch, Math.min(H, y + 16) * W * ch)
    }
    const blob = await encodePng({ width: W, height: H, mode, depth, alpha, icc: icc }, bands())
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const back = await decodePng(bytes)
    const want: number[] = []
    for (let p = 0; p < W * H; p++) {
      for (let c = 0; c < ch; c++) want.push(px[p * ch + c])
      if (!alpha) want.push(max)
    }
    check(`our PNG encoder: ${mode} ${depth}-bit${alpha ? ' with alpha' : ''} reads back exactly, profile and all`, same(back.data, want) && !!back.icc && same(back.icc, icc))
    // The IDAT stream is plain zlib any reader can inflate.
    let at = 8
    const idat: Uint8Array[] = []
    while (at < bytes.length) {
      const len = new DataView(bytes.buffer).getUint32(at)
      if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + len))
      at += 12 + len
    }
    if (mode === 'rgb' && depth === 8 && alpha) check('and its image data is zlib that Node inflates', inflateSync(join(idat)).length === H * (1 + W * ch))
  }
}

// --- TIFF, built by hand -----------------------------------------------------------------------
/** TIFF's LZW, with the early change: what libtiff writes. */
function lzwEncode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  let acc = 0
  let bits = 0
  let width = 9
  const emit = (code: number) => {
    acc = (acc << width) | code
    bits += width
    while (bits >= 8) {
      out.push((acc >> (bits - 8)) & 255)
      bits -= 8
    }
    acc &= (1 << bits) - 1
  }
  let dict = new Map<string, number>()
  let next = 258
  const reset = () => {
    dict = new Map()
    for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i)
    next = 258
    width = 9
  }
  reset()
  emit(256)
  let w = ''
  for (const b of data) {
    const k = String.fromCharCode(b)
    if (dict.has(w + k)) {
      w += k
      continue
    }
    while (next >= 1 << width && width < 12) width++
    emit(dict.get(w)!)
    dict.set(w + k, next++)
    w = k
    if (next >= 4094) {
      while (next >= 1 << width && width < 12) width++
      emit(256)
      reset()
    }
  }
  while (next >= 1 << width && width < 12) width++
  if (w) emit(dict.get(w)!)
  next++
  while (next >= 1 << width && width < 12) width++
  emit(257)
  if (bits) out.push((acc << (8 - bits)) & 255)
  return new Uint8Array(out)
}

function packBitsEncode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < data.length) {
    let run = 1
    while (i + run < data.length && data[i + run] === data[i] && run < 128) run++
    if (run > 2) {
      out.push(257 - run, data[i])
      i += run
    } else {
      const start = i
      while (i < data.length && i - start < 128 && !(i + 2 < data.length && data[i] === data[i + 1] && data[i] === data[i + 2])) i++
      out.push(i - start - 1, ...data.subarray(start, i))
    }
  }
  return new Uint8Array(out)
}

interface TiffSpec {
  le: boolean
  width: number
  height: number
  spp: number
  bps: number
  photometric: number
  compression: number
  /** Samples, interleaved, one array of numbers. */
  samples: number[]
  planar?: 1 | 2
  predictor?: 1 | 2
  extra?: number[]
  tile?: [number, number]
  rowsPerStrip?: number
  colormap?: number[]
  icc?: Uint8Array
}

async function buildTiff(t: TiffSpec): Promise<Uint8Array> {
  const planes = t.planar === 2 ? t.spp : 1
  const per = t.planar === 2 ? 1 : t.spp
  const [bw, bh] = t.tile ?? [t.width, t.rowsPerStrip ?? t.height]
  const across = t.tile ? Math.ceil(t.width / bw) : 1
  const down = Math.ceil(t.height / bh)
  const blocks: Uint8Array[] = []
  for (let p = 0; p < planes; p++) {
    for (let by = 0; by < down; by++) {
      for (let bx = 0; bx < across; bx++) {
        const rows = t.tile ? bh : Math.min(bh, t.height - by * bh)
        const raw: number[] = []
        for (let r = 0; r < rows; r++) {
          const y = by * bh + r
          const vals: number[] = []
          for (let x = 0; x < bw; x++) {
            const sx = bx * bw + x
            for (let c = 0; c < per; c++) {
              const ch = t.planar === 2 ? p : c
              vals.push(y < t.height && sx < t.width ? t.samples[(y * t.width + sx) * t.spp + ch] : 0)
            }
          }
          if (t.predictor === 2) for (let i = vals.length - 1; i >= per; i--) vals[i] = (vals[i] - vals[i - per]) & (t.bps === 16 ? 0xffff : 0xff)
          if (t.bps === 16) raw.push(...vals.flatMap((v) => (t.le ? [v & 255, v >> 8] : [v >> 8, v & 255])))
          else raw.push(...packRow(vals, t.bps))
        }
        const bytes = new Uint8Array(raw)
        blocks.push(t.compression === 5 ? lzwEncode(bytes) : t.compression === 32773 ? packBitsEncode(bytes) : t.compression === 8 ? deflateSync(bytes) : bytes)
      }
    }
  }
  type Entry = [number, number, number[] | Uint8Array]
  const entries: Entry[] = [
    [256, 4, [t.width]],
    [257, 4, [t.height]],
    [258, 3, new Array(t.spp).fill(t.bps)],
    [259, 3, [t.compression]],
    [262, 3, [t.photometric]],
    [277, 3, [t.spp]],
    [284, 3, [t.planar ?? 1]],
  ]
  if (t.predictor) entries.push([317, 3, [t.predictor]])
  if (t.extra) entries.push([338, 3, t.extra])
  if (t.colormap) entries.push([320, 3, t.colormap])
  if (t.icc) entries.push([34675, 7, t.icc])
  if (t.tile) entries.push([322, 4, [bw]], [323, 4, [bh]])
  else entries.push([278, 4, [bh]])
  // Offsets are filled in once the layout is known.
  entries.push([t.tile ? 324 : 273, 4, blocks.map(() => 0)], [t.tile ? 325 : 279, 4, blocks.map((b) => b.length)])
  entries.sort((a, b) => a[0] - b[0])
  const size = (e: Entry) => (e[1] === 3 ? 2 : e[1] === 4 ? 4 : 1) * e[2].length
  const ifdAt = 8
  const ifdLen = 2 + entries.length * 12 + 4
  let extraAt = ifdAt + ifdLen
  const extraOffsets = entries.map((e) => {
    if (size(e) <= 4) return -1
    const at = extraAt
    extraAt += size(e) + (size(e) & 1)
    return at
  })
  let dataAt = extraAt
  const blockOffsets = blocks.map((b) => {
    const at = dataAt
    dataAt += b.length
    return at
  })
  const offsetEntry = entries.find((e) => e[0] === 273 || e[0] === 324)!
  offsetEntry[2] = blockOffsets
  const out = new Uint8Array(dataAt)
  const dv = new DataView(out.buffer)
  out.set(t.le ? [0x49, 0x49] : [0x4d, 0x4d])
  dv.setUint16(2, 42, t.le)
  dv.setUint32(4, ifdAt, t.le)
  dv.setUint16(ifdAt, entries.length, t.le)
  const writeVals = (at: number, e: Entry) => {
    e[2].forEach((v, i) => {
      if (e[1] === 3) dv.setUint16(at + i * 2, v, t.le)
      else if (e[1] === 4) dv.setUint32(at + i * 4, v, t.le)
      else out[at + i] = v
    })
  }
  entries.forEach((e, i) => {
    const at = ifdAt + 2 + i * 12
    dv.setUint16(at, e[0], t.le)
    dv.setUint16(at + 2, e[1], t.le)
    dv.setUint32(at + 4, e[2].length, t.le)
    if (extraOffsets[i] < 0) writeVals(at + 8, e)
    else {
      dv.setUint32(at + 8, extraOffsets[i], t.le)
      writeVals(extraOffsets[i], e)
    }
  })
  blocks.forEach((b, i) => out.set(b, blockOffsets[i]))
  return out
}

console.log('\nTIFF')
{
  const data = new Uint8Array(5000).map(() => (rand() < 0.6 ? 7 : Math.floor(rand() * 256)))
  check('LZW decodes what an early-change encoder wrote', same(lzwDecode(lzwEncode(data), data.length), data))
  const long = new Uint8Array(200000).map((_, i) => (i * 7 + (i >> 9)) & 255)
  check('including past 4096 codes, where the table is cleared', same(lzwDecode(lzwEncode(long), long.length), long))
  check('PackBits round-trips runs and literals', same(packBitsDecode(packBitsEncode(data), data.length), data))

  const W = 45
  const H = 31
  const rgb8 = Array.from({ length: W * H * 3 }, () => Math.floor(rand() * 256))
  const withAlpha = (s: number[], n: number, max: number) => {
    const out: number[] = []
    for (let p = 0; p < s.length / n; p++) out.push(...s.slice(p * n, p * n + n), max)
    return out
  }
  const variants: [string, Partial<TiffSpec>][] = [
    ['uncompressed, one strip', { compression: 1 }],
    ['LZW, in strips of 7 rows', { compression: 5, rowsPerStrip: 7 }],
    ['LZW with horizontal prediction', { compression: 5, predictor: 2 }],
    ['Deflate', { compression: 8 }],
    ['PackBits, big-endian', { compression: 32773, le: false }],
    ['in 16 × 16 tiles', { compression: 5, tile: [16, 16] }],
    ['planar, one plane after another', { compression: 1, planar: 2 }],
  ]
  for (const [name, v] of variants) {
    const r = await decodeTiff(await buildTiff({ le: true, width: W, height: H, spp: 3, bps: 8, photometric: 2, samples: rgb8, compression: 1, ...v }))
    check(`8-bit RGB, ${name}`, r.mode === 'rgb' && r.depth === 8 && same(r.data, withAlpha(rgb8, 3, 255)))
  }
  const g16 = Array.from({ length: W * H }, () => Math.floor(rand() * 65536))
  for (const le of [true, false]) {
    const r = await decodeTiff(await buildTiff({ le, width: W, height: H, spp: 1, bps: 16, photometric: 1, samples: g16, compression: 5, predictor: 2 }))
    check(`16-bit gray, ${le ? 'little' : 'big'}-endian, LZW with prediction`, r.mode === 'gray' && r.depth === 16 && same(r.data, withAlpha(g16, 1, 65535)))
  }
  const wiz = await decodeTiff(await buildTiff({ le: true, width: 4, height: 1, spp: 1, bps: 8, photometric: 0, samples: [0, 50, 200, 255], compression: 1 }))
  check('WhiteIsZero gray is turned the right way up', same(wiz.data, [255, 255, 205, 255, 55, 255, 0, 255]))
  const bits = [1, 0, 0, 1, 1, 1, 0, 1, 0]
  const bil = await decodeTiff(await buildTiff({ le: true, width: 9, height: 1, spp: 1, bps: 1, photometric: 1, samples: bits, compression: 1 }))
  check('1-bit black and white', same(bil.data, bits.flatMap((b) => [b * 255, 255])))
  const cmyka = Array.from({ length: W * H * 5 }, () => Math.floor(rand() * 256))
  const rc = await decodeTiff(await buildTiff({ le: true, width: W, height: H, spp: 5, bps: 8, photometric: 5, samples: cmyka, compression: 8, extra: [2] }))
  check('CMYK with unassociated alpha', rc.mode === 'cmyk' && same(rc.data, cmyka))
  const premul = [100, 50, 25, 128, 0, 0, 0, 0]
  const ra = await decodeTiff(await buildTiff({ le: true, width: 2, height: 1, spp: 4, bps: 8, photometric: 2, samples: premul, compression: 1, extra: [1] }))
  check('associated (premultiplied) alpha is divided out', same(ra.data, [199, 100, 50, 128, 0, 0, 0, 0]), Array.from(ra.data).join())
  const cmap = [...[0, 65535, 0, 30000], ...[0, 0, 65535, 30000], ...[65535, 0, 0, 30000]]
  const pi = await decodeTiff(await buildTiff({ le: true, width: 4, height: 1, spp: 1, bps: 8, photometric: 3, samples: [0, 1, 2, 3], colormap: cmap, compression: 1 }))
  check('a palette TIFF becomes RGB', same(pi.data, [0, 0, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255, 117, 117, 117, 255]), Array.from(pi.data).join())
  const icc = new Uint8Array(129).map((_, i) => 255 - i)
  const ri = await decodeTiff(await buildTiff({ le: true, width: 1, height: 1, spp: 1, bps: 8, photometric: 1, samples: [9], compression: 1, icc }))
  check('the ICC tag comes out whole', !!ri.icc && same(ri.icc, icc))
  const jpegTiff = await buildTiff({ le: true, width: 1, height: 1, spp: 1, bps: 8, photometric: 1, samples: [9], compression: 7 })
  check('a JPEG-compressed TIFF is refused, saying which compression', /JPEG/.test(String(await decodeTiff(jpegTiff).catch((e) => e.message))))
  const ycc = await buildTiff({ le: true, width: 1, height: 1, spp: 3, bps: 8, photometric: 6, samples: [1, 2, 3], compression: 1 })
  check('a YCbCr TIFF is refused, saying so', /YCbCr/.test(String(await decodeTiff(ycc).catch((e) => e.message))))
}

// --- JPEG markers -------------------------------------------------------------------------------
console.log('\nJPEG')
{
  const seg = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body]
  const iccTag = [...'ICC_PROFILE'].map((c) => c.charCodeAt(0)).concat(0)
  const icc = Array.from({ length: 100 }, (_, i) => i)
  const jpeg = new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, [...'JFIF'].map((c) => c.charCodeAt(0)).concat([0, 1, 1, 0, 0, 1, 0, 1, 0, 0])),
    ...seg(0xe2, [...iccTag, 2, 2, ...icc.slice(60)]),
    ...seg(0xe2, [...iccTag, 1, 2, ...icc.slice(0, 60)]),
    ...seg(0xee, [...'Adobe'].map((c) => c.charCodeAt(0)).concat([0, 100, 0, 0, 0, 0, 1])),
    ...seg(0xc2, [8, 0, 3, 0, 5, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
    ...seg(0xda, [3, 1, 0, 2, 0, 3, 0, 0, 63, 0]),
    1, 2, 3, 0xff, 0xd9,
  ])
  const info = readJpegInfo(jpeg)
  check('its size, components and progressiveness are read from the frame header', info.width === 5 && info.height === 3 && info.components === 3 && info.progressive)
  check('an ICC profile split over two segments, out of order, comes back whole', !!info.icc && same(info.icc, icc))
  check('Adobe’s transform flag is read', info.adobeTransform === 1)
  const bigIcc = new Uint8Array(150000).map((_, i) => i * 31)
  const with2 = withIcc(jpeg, bigIcc)
  const back = readJpegInfo(with2)
  check('a profile written in replaces the old one, split into as many segments as it needs', !!back.icc && same(back.icc, bigIcc) && back.width === 5)
  check('JFIF stays first, and the image data follows untouched', with2[2] === 0xff && with2[3] === 0xe0 && same(with2.subarray(with2.length - 5), jpeg.subarray(jpeg.length - 5)))
  check('files are told apart by their first bytes', sniff(jpeg) === 'jpeg' && sniff(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])) === 'png' && sniff(new Uint8Array([0x4d, 0x4d, 0, 42])) === 'tiff' && sniff(new Uint8Array(8)) === null)
  check('a name is the fallback', sniff(new Uint8Array(4), 'photo.TIF') === 'tiff')
  check('anything else is refused, saying what is opened', /PNG, JPEG, WebP and TIFF/.test(String(await decodeImage(new Uint8Array(8), 'x.bin', { jpeg: noJpeg, webp: noJpeg }).catch((e) => e.message))))
}

// --- into tiles ----------------------------------------------------------------------------
console.log('\ninto tiles')
{
  const store = new TileStore({ budget: 1e9, spill: memorySpill(), shared: false })
  const W = 300
  const H = 260
  const data = new Uint8Array(W * H * 4)
  for (let i = 0; i < W * H; i++) data.set([i & 255, (i >> 8) & 255, 7, i % 5 ? 255 : 0], i * 4)
  const raster: Raster = { width: W, height: H, mode: 'rgb', depth: 8, data, icc: null, warnings: [] }
  const set = rasterToSet(store, raster, { mode: 'rgb', depth: 8 })
  const e = store.extent(set)!
  check('an image becomes the tiles that cover it', e.x0 === 0 && e.y0 === 0 && e.x1 === 1 && e.y1 === 1)
  const t = await store.samples(store.tileAt(set, 1, 1)!)
  const px = (x: number, y: number) => [0, 1, 2, 3].map((c) => t[c * TILE_PIXELS + (y - TILE) * TILE + (x - TILE)])
  const at = (x: number, y: number) => Array.from(data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4))
  check('each pixel lands in its tile, planar', same(px(270, 259), at(270, 259)) && same(px(299, 256), at(299, 256)))
  check('and past the image’s edge the tile is transparent', px(300, 256)[3] === 0 && px(511, 511)[3] === 0)
  const deep = rasterToSet(store, raster, { mode: 'rgb', depth: 16 })
  const t16 = await store.samples(store.tileAt(deep, 0, 0)!)
  check('into a 16-bit document each 8-bit value becomes v × 257', t16[5] === data[5 * 4] * 257 && t16[3 * TILE_PIXELS + 1] === 255 * 257)
  const empty: Raster = { width: 600, height: 10, mode: 'gray', depth: 8, data: new Uint8Array(600 * 10 * 2), icc: null, warnings: [] }
  check('fully transparent tiles aren’t stored at all', store.extent(rasterToSet(store, empty, { mode: 'gray', depth: 8 })) === null)
  const grayDoc = rasterToSet(store, raster, { mode: 'gray', depth: 8 }, (c, n) => {
    const out = new Float32Array(n)
    for (let k = 0; k < n; k++) out[k] = c[k * 3]
    return out
  })
  const tg = await store.samples(store.tileAt(grayDoc, 0, 0)!)
  check('with a conversion, colours go through it (here RGB to gray, red kept)', tg[1] === data[4] && tg[TILE_PIXELS + 1] === 255)
}

// --- WebP's container: a profile put in ---------------------------------------------------------
{
  console.log('\nWebP')
  /** A WebP file of the given chunks. */
  const riff = (chunks: [string, number[]][]) => {
    const body: number[] = [...'WEBP'].map((c) => c.charCodeAt(0))
    for (const [tag, data] of chunks) {
      body.push(...[...tag].map((c) => c.charCodeAt(0)), data.length & 255, (data.length >> 8) & 255, 0, 0, ...data)
      if (data.length & 1) body.push(0)
    }
    return new Uint8Array([...[...'RIFF'].map((c) => c.charCodeAt(0)), body.length & 255, (body.length >> 8) & 255, 0, 0, ...body])
  }
  // A lossless image 300 × 200 that uses its alpha: width-1 in 14 bits, height-1 in the next 14, then the alpha bit.
  const word = (299 | (199 << 14) | (1 << 28)) >>> 0
  const vp8l = [0x2f, word & 255, (word >>> 8) & 255, (word >>> 16) & 255, (word >>> 24) & 255, 7, 7, 7]
  const icc = [1, 2, 3, 4, 5]
  const out = withWebpIcc(riff([['VP8L', vp8l]]), new Uint8Array(icc), 300, 200)
  const info = webpInfo(out)
  const tags = webpChunks(out).map((c) => c.tag)
  check('a simple WebP becomes an extended one: VP8X, then the profile, then the image', tags.join() === 'VP8X,ICCP,VP8L', tags.join())
  check('saying its size, transparency and profile', info.width === 300 && info.height === 200 && info.alpha && info.lossless && [...(info.icc ?? [])].join() === icc.join(), JSON.stringify({ ...info, icc: [...(info.icc ?? [])] }))
  check('the odd-sized profile padded, the file’s size right', out.length === 8 + (out[4] | (out[5] << 8)) && out.length % 2 === 0)
  // An extended one already, with alpha and an old profile: the flag set, the profile replaced, straight after VP8X.
  const x = [0x10, 0, 0, 0, 99, 0, 0, 49, 0, 0]
  const ext = withWebpIcc(riff([['VP8X', x], ['ICCP', [9, 9]], ['ALPH', [1, 2]], ['VP8 ', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]]), new Uint8Array(icc), 100, 50)
  const extTags = webpChunks(ext).map((c) => c.tag)
  check('an extended one keeps its chunks, the profile replaced and flagged', extTags.join() === 'VP8X,ICCP,ALPH,VP8 ' && webpInfo(ext).alpha && [...(webpInfo(ext).icc ?? [])].join() === icc.join() && (webpChunks(ext)[0].data[0] & 0x20) !== 0, extTags.join())
  check('WebP files are told apart by their first bytes', isWebp(out) && !isWebp(new Uint8Array(16)) && sniff(out, 'x.bin') === 'webp')
}

// --- PNG-8: colours cut to a palette, written indexed -------------------------------------------
{
  console.log('\nPNG-8')
  // Four colours in quarters, the bottom right quarter clear.
  const w = 16
  const h = 16
  const four = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = x < 8 ? (y < 8 ? [255, 0, 0, 255] : [0, 0, 255, 255]) : y < 8 ? [0, 200, 0, 255] : [10, 20, 30, 0]
      four.set(c, (y * w + x) * 4)
    }
  const q = quantize(four, w, h, { colours: 256, dither: false, transparency: true, matte: null })
  check('a few colours are kept exactly, a clear entry first', q.alpha.length === 4 && q.alpha[0] === 0 && [0, 1, 2].map((e) => [...q.palette.subarray(3 + e * 3, 6 + e * 3)].join()).sort().join(' ') === '0,0,255 0,200,0 255,0,0', [...q.palette].join())
  check('clear pixels are the clear entry', q.indices[15 * w + 15] === 0 && q.indices[0] !== 0)
  const flat = quantize(four, w, h, { colours: 256, dither: false, transparency: false, matte: [255, 255, 255] })
  check('without transparency, clear pixels are laid on the matte', !flat.alpha.some((a) => a < 255) && [...flat.palette.subarray(flat.indices[15 * w + 15] * 3, flat.indices[15 * w + 15] * 3 + 3)].join() === '255,255,255')
  // A smooth gradient of many colours, cut to sixteen.
  const gw = 256
  const grad = new Uint8Array(gw * 4 * 4)
  for (let y = 0; y < 4; y++) for (let x = 0; x < gw; x++) grad.set([x, 255 - x, (x * 3) & 255, 255], (y * gw + x) * 4)
  const g16 = quantize(grad, gw, 4, { colours: 16, dither: false, transparency: true, matte: null })
  check('many colours cut to no more than asked', g16.alpha.length <= 16 && g16.alpha.length >= 12, String(g16.alpha.length))
  const err = (qq: typeof g16) => {
    let e = 0
    for (let i = 0; i < gw * 4; i++) for (let c = 0; c < 3; c++) e += Math.abs(grad[i * 4 + c] - qq.palette[qq.indices[i] * 3 + c])
    return e / (gw * 4 * 3)
  }
  check('each pixel its nearest colour: close on average', err(g16) < 24, err(g16).toFixed(1))
  const d16 = quantize(grad, gw, 4, { colours: 16, dither: true, transparency: true, matte: null })
  // Dithered, the average colour of a stretch stays truer than the nearest colours alone.
  const mean = (qq: typeof g16, x0: number, x1: number) => {
    let t = 0
    for (let y = 0; y < 4; y++) for (let x = x0; x < x1; x++) t += qq.palette[qq.indices[y * gw + x] * 3]
    return t / (4 * (x1 - x0))
  }
  const truth = (x0: number, x1: number) => (x0 + x1 - 1) / 2
  const off = (qq: typeof g16) => [0, 32, 64, 96, 128, 160, 192, 224].reduce((t, x0) => t + Math.abs(mean(qq, x0, x0 + 32) - truth(x0, x0 + 32)), 0)
  check('dithering keeps a stretch’s average colour truer', off(d16) <= off(g16), `${off(d16).toFixed(1)} ≤ ${off(g16).toFixed(1)}`)
  // Written indexed, read back the same.
  const blob = await encodePngIndexed({ width: w, height: h, palette: q.palette, alpha: q.alpha, icc: new Uint8Array([1, 2, 3]), iccName: 'x' }, q.indices)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  check('written as a palette PNG, with a tRNS chunk', bytes[25] === 3 && new TextDecoder('latin1').decode(bytes).includes('tRNS') && new TextDecoder('latin1').decode(bytes).includes('PLTE'))
  const back = await decodePng(bytes)
  const same = [0, 9 * w + 3, 3 * w + 12, 15 * w + 15].every((i) => back.data[i * 4 + 3] === four[i * 4 + 3] && (four[i * 4 + 3] === 0 || [0, 1, 2].every((c) => back.data[i * 4 + c] === four[i * 4 + c])))
  check('and read back pixel for pixel, the clear ones clear', back.width === w && same && !!back.icc)
}

console.log(`\n${failures === 0 ? 'all clear' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
