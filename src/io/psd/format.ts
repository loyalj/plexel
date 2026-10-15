/**
 * The PSD and PSB file structure, read and written: the header, colour
 * mode data, image resources, layer records (with their masks, blending
 * ranges and tagged blocks), each layer's channels, the global layer mask,
 * the tagged blocks after the layers, and the composite image.
 *
 * As Adobe's specification lays it out. Channels are decoded from all
 * four compressions (raw, RLE, ZIP, ZIP with prediction) into samples (8,
 * 16 and 32 bits; 1-bit bitmaps as bytes of 0 or 255); 16- and 32-bit
 * documents' layers, which Photoshop keeps in an "Lr16" or "Lr32" block,
 * are read from there. Tagged blocks are kept as bytes: toDoc.ts reads the
 * ones it knows, and the rest survive nothing (a document written by
 * fromDoc.ts says what it means from scratch).
 *
 * This part is pure: bytes in, structure out, and back.
 */
import { inflateZlib, deflateZlib } from '../png'
import { PsdError, Reader, Writer } from './bin'



export type PsdSamples = Uint8Array | Uint16Array | Float32Array

/** Colour modes as the header numbers them. */
export const PSD_MODE = { bitmap: 0, gray: 1, indexed: 2, rgb: 3, cmyk: 4, multichannel: 7, duotone: 8, lab: 9 } as const

export interface PsdResource {
  id: number
  name: string
  data: Uint8Array
}

export interface PsdBlock {
  key: string
  data: Uint8Array
}

export interface PsdChannel {
  /** 0.. colour channels, -1 transparency, -2 the layer mask, -3 the real (vector and pixel) mask. */
  id: number
  /** Decoded samples for the channel's rectangle, row by row; null for an empty rectangle. */
  data: PsdSamples | null
}

export interface PsdRect {
  top: number
  left: number
  bottom: number
  right: number
}

export interface PsdMask extends PsdRect {
  /** What shows outside the rectangle: 0 or 255. */
  defaultColor: number
  /** Bit 0 position relative to the layer, 1 disabled, 2 inverted (obsolete), 3 from rendering other data, 4 has parameters. */
  flags: number
  userDensity?: number
  userFeather?: number
  vectorDensity?: number
  vectorFeather?: number
  /** The real mask's rectangle and flags, when the layer has both a pixel and a vector mask. */
  real?: PsdRect & { flags: number; defaultColor: number }
}

export interface PsdLayer extends PsdRect {
  channels: PsdChannel[]
  /** The blend mode's key ("norm", "mul ", "pass"...). */
  blend: string
  opacity: number
  /** 0 base, 1 clipped to the layer below. */
  clipping: number
  /** Bit 0 transparency protected, 1 hidden, 3 bit 4 is useful, 4 pixel data irrelevant to the appearance. */
  flags: number
  mask: PsdMask | null
  ranges: Uint8Array
  name: string
  blocks: PsdBlock[]
}

export interface PsdFile {
  psb: boolean
  width: number
  height: number
  /** Channels in the composite, including any alpha and spot channels. */
  channels: number
  depth: 1 | 8 | 16 | 32
  mode: number
  colorModeData: Uint8Array
  resources: PsdResource[]
  /** Bottom first, as the file has them. */
  layers: PsdLayer[]
  /** The layer count was negative: the composite's first extra channel is its transparency. */
  mergedAlpha: boolean
  globalMask: Uint8Array
  /** Tagged blocks after the layers (patterns, linked files, and the like). */
  blocks: PsdBlock[]
  /**
   * The composite image, one plane a channel; null when it wasn't read or
   * isn't there. A plane not decoded (the colour, read 'flat' from a file
   * with layers) is null.
   */
  composite: (PsdSamples | null)[] | null
}

const BIG_KEYS = new Set(['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD', 'lnkE', 'cinf'])

function newSamples(depth: number, n: number): PsdSamples {
  return depth === 16 ? new Uint16Array(n) : depth === 32 ? new Float32Array(n) : new Uint8Array(n)
}

// --- compression ------------------------------------------------------------------------------------

/** PackBits, one row: into `out` from `at`, `n` bytes. Returns where the input ended. */
export function unpackBits(src: Uint8Array, pos: number, end: number, out: Uint8Array, at: number, n: number): number {
  let o = at
  const stop = at + n
  while (o < stop && pos < end) {
    const h = src[pos++]
    if (h < 128) {
      const len = h + 1
      out.set(src.subarray(pos, pos + len), o)
      pos += len
      o += len
    } else if (h > 128) {
      const len = 257 - h
      out.fill(src[pos++], o, o + len)
      o += len
    }
  }
  return pos
}

export function packBits(row: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < row.length) {
    let run = 1
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++
    if (run >= 2) {
      out.push(257 - run, row[i])
      i += run
      continue
    }
    let lit = 1
    while (i + lit < row.length && lit < 128 && !(i + lit + 1 < row.length && row[i + lit] === row[i + lit + 1])) lit++
    out.push(lit - 1)
    for (let k = 0; k < lit; k++) out.push(row[i + k])
    i += lit
  }
  return Uint8Array.from(out)
}

/** Big-endian bytes into samples. */
function toSamples(bytes: Uint8Array, depth: number, n: number): PsdSamples {
  if (depth === 8) return bytes.slice(0, n)
  if (depth === 1) {
    // Bitmaps: 1 is black. Out as 0 (black) or 255.
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) out[i] = bytes[i >> 3] & (0x80 >> (i & 7)) ? 0 : 255
    return out
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = newSamples(depth, n)
  for (let i = 0; i < n; i++) out[i] = depth === 16 ? v.getUint16(i * 2) : v.getFloat32(i * 4)
  return out
}

function fromSamples(s: PsdSamples, depth: number): Uint8Array {
  if (depth === 8) return s as Uint8Array
  const out = new Uint8Array(s.length * (depth / 8))
  const v = new DataView(out.buffer)
  for (let i = 0; i < s.length; i++) {
    if (depth === 16) v.setUint16(i * 2, s[i])
    else v.setFloat32(i * 4, s[i])
  }
  return out
}

/** ZIP with prediction undone: deltas per row (bytes, 16-bit values, or 32-bit floats stored byte-plane by byte-plane). */
function unpredict(b: Uint8Array, w: number, h: number, depth: number): Uint8Array {
  if (depth === 8) {
    for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) b[y * w + x] = (b[y * w + x] + b[y * w + x - 1]) & 255
    return b
  }
  if (depth === 16) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
    for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) v.setUint16((y * w + x) * 2, (v.getUint16((y * w + x) * 2) + v.getUint16((y * w + x - 1) * 2)) & 0xffff)
    return b
  }
  // 32-bit: bytes deltas across the row of 4w, then un-shuffled from planes (all first bytes, then seconds...).
  const out = new Uint8Array(b.length)
  for (let y = 0; y < h; y++) {
    const row = b.subarray(y * w * 4, (y + 1) * w * 4)
    for (let i = 1; i < row.length; i++) row[i] = (row[i] + row[i - 1]) & 255
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = row[k * w + x]
  }
  return out
}

function predict(b: Uint8Array, w: number, h: number, depth: number): Uint8Array {
  const out = b.slice()
  if (depth === 8) {
    for (let y = 0; y < h; y++) for (let x = w - 1; x > 0; x--) out[y * w + x] = (b[y * w + x] - b[y * w + x - 1]) & 255
    return out
  }
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const o = new DataView(out.buffer)
  for (let y = 0; y < h; y++) for (let x = w - 1; x > 0; x--) o.setUint16((y * w + x) * 2, (v.getUint16((y * w + x) * 2) - v.getUint16((y * w + x - 1) * 2)) & 0xffff)
  return out
}

/** One channel's data (after its compression word) into samples. */
async function decodeChannel(r: Reader, compression: number, w: number, h: number, depth: number, end: number): Promise<PsdSamples | null> {
  if (w <= 0 || h <= 0) {
    r.pos = end
    return null
  }
  const n = w * h
  const rowBytes = depth === 1 ? Math.ceil(w / 8) : w * (depth / 8)
  let bytes: Uint8Array
  if (compression === 0) bytes = r.bytes(rowBytes * h)
  else if (compression === 1) {
    const counts: number[] = []
    for (let y = 0; y < h; y++) counts.push(r.psb ? r.u32() : r.u16())
    bytes = new Uint8Array(rowBytes * h)
    for (let y = 0; y < h; y++) {
      const start = r.pos
      unpackBits(r.b, start, start + counts[y], bytes, y * rowBytes, rowBytes)
      r.pos = start + counts[y]
    }
  } else if (compression === 2 || compression === 3) {
    const z = r.bytes(end - r.pos)
    bytes = await inflateZlib(z)
    if (bytes.length < rowBytes * h) throw new PsdError('A layer’s compressed pixels came out short')
    if (compression === 3) bytes = unpredict(bytes, w, h, depth)
  } else throw new PsdError(`Pixels compressed by method ${compression} aren’t known`)
  r.pos = Math.max(r.pos, end)
  if (depth === 1) {
    // A bitmap's rows are padded to whole bytes.
    const out = new Uint8Array(n)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = bytes[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? 0 : 255
    return out
  }
  return toSamples(bytes, depth, n)
}

// --- reading ----------------------------------------------------------------------------------------

export interface ReadOptions {
  /**
   * Whether to decode the composite image: false skips it (when the layers
   * are what's wanted), 'flat' reads its colour only when there are no
   * layers (when it would be the Background), and its alpha and spot
   * channels always (they're only there). Decoding it is a full image's work.
   */
  composite?: boolean | 'flat'
}

export async function readPsd(bytes: Uint8Array, o: ReadOptions = {}): Promise<PsdFile> {
  const r = new Reader(bytes)
  if (r.left < 26 || r.sig() !== '8BPS') throw new PsdError('This isn’t a Photoshop file')
  const version = r.u16()
  if (version !== 1 && version !== 2) throw new PsdError(`It says it’s version ${version}; PSD is 1 and PSB 2`)
  r.psb = version === 2
  r.skip(6)
  const channels = r.u16()
  const height = r.u32()
  const width = r.u32()
  const depth = r.u16()
  const mode = r.u16()
  if (![1, 8, 16, 32].includes(depth)) throw new PsdError(`Its depth, ${depth} bits, isn’t one Photoshop writes`)
  const colorModeData = r.bytes(r.u32()).slice()
  // Image resources.
  const resources: PsdResource[] = []
  {
    const res = r.sub(r.u32())
    while (res.left >= 12) {
      const sig = res.sig()
      if (sig !== '8BIM' && sig !== 'MeSa' && sig !== 'AgHg' && sig !== 'PHUT' && sig !== 'DCSR') break
      const id = res.u16()
      const name = res.pascal(2)
      const size = res.u32()
      const data = res.bytes(Math.min(size, res.left)).slice()
      if (size % 2 && res.left) res.skip(1)
      resources.push({ id, name, data })
    }
  }
  // Layer and mask information.
  const lmLength = r.len()
  const lmEnd = r.pos + lmLength
  let layers: PsdLayer[] = []
  let mergedAlpha = false
  let globalMask: Uint8Array = new Uint8Array(0)
  const blocks: PsdBlock[] = []
  if (lmLength > 0) {
    const infoLength = r.len()
    const infoEnd = r.pos + infoLength
    if (infoLength > 0) {
      const got = await readLayerInfo(r, depth)
      layers = got.layers
      mergedAlpha = got.mergedAlpha
    }
    r.pos = infoEnd
    if (r.pos + 4 <= lmEnd) {
      const gl = r.u32()
      globalMask = r.bytes(Math.min(gl, lmEnd - r.pos)).slice()
    }
    // Tagged blocks to the end of the section: for 16 and 32 bits, the layers are in here.
    while (r.pos + 12 <= lmEnd) {
      const sig = r.sig()
      if (sig !== '8BIM' && sig !== '8B64') break
      const key = r.sig()
      const len = r.psb && BIG_KEYS.has(key) ? r.u64() : r.u32()
      const start = r.pos
      if ((key === 'Lr16' || key === 'Lr32') && !layers.length) {
        const sub = new Reader(r.bytes(len), r.psb)
        const got = await readLayerInfo(sub, depth)
        layers = got.layers
        mergedAlpha = got.mergedAlpha
      } else blocks.push({ key, data: r.bytes(len).slice() })
      r.pos = start + len
    }
  }
  r.pos = lmEnd
  // The composite. Read 'flat' from a file with layers, only the planes after the colour (and the merged transparency): alpha and spot channels.
  let composite: (PsdSamples | null)[] | null = null
  const colourCount = mode === PSD_MODE.cmyk ? 4 : mode === PSD_MODE.rgb || mode === PSD_MODE.lab ? 3 : 1
  const firstWanted = o.composite === 'flat' && layers.length ? colourCount + (mergedAlpha ? 1 : 0) : 0
  if (o.composite !== false && firstWanted < channels && r.left >= 2) {
    const compression = r.u16()
    const n = width * height
    const rowBytes = depth === 1 ? Math.ceil(width / 8) : width * (depth / 8)
    composite = []
    if (compression === 1) {
      const counts: number[] = []
      for (let i = 0; i < height * channels; i++) counts.push(r.psb ? r.u32() : r.u16())
      for (let c = 0; c < channels; c++) {
        if (c < firstWanted) {
          for (let y = 0; y < height; y++) r.pos += counts[c * height + y]
          composite.push(null)
          continue
        }
        const plane = new Uint8Array(rowBytes * height)
        for (let y = 0; y < height; y++) {
          const len = counts[c * height + y]
          unpackBits(r.b, r.pos, r.pos + len, plane, y * rowBytes, rowBytes)
          r.pos += len
        }
        composite.push(depth === 1 ? bitmapToBytes(plane, width, height, rowBytes) : toSamples(plane, depth, n))
      }
    } else if (compression === 0) {
      for (let c = 0; c < channels; c++) {
        if (c < firstWanted) {
          r.skip(rowBytes * height)
          composite.push(null)
          continue
        }
        const plane = r.bytes(rowBytes * height)
        composite.push(depth === 1 ? bitmapToBytes(plane, width, height, rowBytes) : toSamples(plane, depth, n))
      }
    } else if (compression === 2 || compression === 3) {
      let all = await inflateZlib(r.bytes(r.left))
      const per = rowBytes * height
      for (let c = 0; c < channels; c++) {
        if (c < firstWanted) {
          composite.push(null)
          continue
        }
        let plane = all.subarray(c * per, (c + 1) * per)
        if (compression === 3) plane = unpredict(plane.slice(), width, height, depth)
        composite.push(toSamples(plane, depth, n))
      }
      all = new Uint8Array(0)
    }
  }
  return { psb: r.psb, width, height, channels, depth: depth as PsdFile['depth'], mode, colorModeData, resources, layers, mergedAlpha, globalMask, blocks, composite }
}

function bitmapToBytes(plane: Uint8Array, w: number, h: number, rowBytes: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = plane[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? 0 : 255
  return out
}

async function readLayerInfo(r: Reader, depth: number): Promise<{ layers: PsdLayer[]; mergedAlpha: boolean }> {
  const count = r.i16()
  const mergedAlpha = count < 0
  const n = Math.abs(count)
  const layers: PsdLayer[] = []
  const lengths: number[][] = []
  for (let i = 0; i < n; i++) {
    const top = r.i32()
    const left = r.i32()
    const bottom = r.i32()
    const right = r.i32()
    const nc = r.u16()
    const channels: PsdChannel[] = []
    const lens: number[] = []
    for (let c = 0; c < nc; c++) {
      channels.push({ id: r.i16(), data: null })
      lens.push(r.len())
    }
    lengths.push(lens)
    const sig = r.sig()
    if (sig !== '8BIM') throw new PsdError('A layer record is damaged')
    const blend = r.sig()
    const opacity = r.u8()
    const clipping = r.u8()
    const flags = r.u8()
    r.u8()
    const extra = r.sub(r.u32())
    // The layer mask.
    let mask: PsdMask | null = null
    {
      const ml = extra.u32()
      if (ml > 0) {
        const m = extra.sub(ml)
        mask = { top: m.i32(), left: m.i32(), bottom: m.i32(), right: m.i32(), defaultColor: m.u8(), flags: m.u8() }
        // When there are both kinds of mask, the real one (flags, colour, rectangle) comes next; then any parameters.
        if (ml >= 36 && m.left >= 18) {
          const flags2 = m.u8()
          const def2 = m.u8()
          mask.real = { flags: flags2, defaultColor: def2, top: m.i32(), left: m.i32(), bottom: m.i32(), right: m.i32() }
        }
        if (mask.flags & 16 && m.left >= 1) {
          const p = m.u8()
          if (p & 1 && m.left >= 1) mask.userDensity = m.u8()
          if (p & 2 && m.left >= 8) mask.userFeather = m.f64()
          if (p & 4 && m.left >= 1) mask.vectorDensity = m.u8()
          if (p & 8 && m.left >= 8) mask.vectorFeather = m.f64()
        }
      }
    }
    const ranges = extra.bytes(extra.u32()).slice()
    const name = extra.pascal(4)
    const blocks: PsdBlock[] = []
    while (extra.left >= 12) {
      const s = extra.sig()
      if (s !== '8BIM' && s !== '8B64') break
      const key = extra.sig()
      const len = r.psb && BIG_KEYS.has(key) ? extra.u64() : extra.u32()
      blocks.push({ key, data: extra.bytes(Math.min(len, extra.left)).slice() })
    }
    layers.push({ top, left, bottom, right, channels, blend, opacity, clipping, flags, mask, ranges, name, blocks })
  }
  // Channel image data, layer by layer, channel by channel.
  for (let i = 0; i < n; i++) {
    const L = layers[i]
    for (let c = 0; c < L.channels.length; c++) {
      const ch = L.channels[c]
      const start = r.pos
      const end = start + lengths[i][c]
      if (lengths[i][c] < 2) {
        r.pos = end
        continue
      }
      const compression = r.u16()
      // -2 is the mask's rectangle; -3, when there are both kinds of mask, the real one's.
      const rect = ch.id === -2 && L.mask ? L.mask : ch.id === -3 && L.mask?.real ? L.mask.real : L
      const w = rect.right - rect.left
      const h = rect.bottom - rect.top
      ch.data = await decodeChannel(r, compression, w, h, depth, end)
      r.pos = end
    }
  }
  return { layers, mergedAlpha }
}

// --- writing ----------------------------------------------------------------------------------------

export interface WriteOptions {
  /** Compression for 8-bit channels: RLE (Photoshop's own) or ZIP. 16 and 32 bits are always ZIP with prediction. */
  rle?: boolean
}

async function encodeChannel(s: PsdSamples | null, w: number, h: number, depth: number, psb: boolean): Promise<Uint8Array> {
  const out = new Writer(psb)
  if (!s || w <= 0 || h <= 0) {
    out.u16(0)
    return out.done()
  }
  if (depth === 8) {
    const rows: Uint8Array[] = []
    for (let y = 0; y < h; y++) rows.push(packBits((s as Uint8Array).subarray(y * w, (y + 1) * w)))
    out.u16(1)
    for (const row of rows) {
      if (psb) out.u32(row.length)
      else out.u16(row.length)
    }
    for (const row of rows) out.bytes(row)
    return out.done()
  }
  out.u16(depth === 16 ? 3 : 2)
  const bytes = fromSamples(s, depth)
  out.bytes(await deflateZlib(depth === 16 ? predict(bytes, w, h, depth) : bytes))
  return out.done()
}

function writeBlock(w: Writer, b: PsdBlock, pad: number) {
  const big = w.psb && BIG_KEYS.has(b.key)
  w.sig(big ? '8B64' : '8BIM')
  w.sig(b.key)
  const padded = Math.ceil(b.data.length / pad) * pad
  if (big) w.u64(padded)
  else w.u32(padded)
  w.bytes(b.data)
  w.zeros(padded - b.data.length)
}

async function writeLayerInfo(w: Writer, f: PsdFile) {
  w.i16(f.mergedAlpha ? -f.layers.length : f.layers.length)
  const data: Uint8Array[][] = []
  for (const L of f.layers) {
    const chans: Uint8Array[] = []
    for (const ch of L.channels) {
      const rect = ch.id === -2 && L.mask ? L.mask : ch.id === -3 && L.mask?.real ? L.mask.real : L
      chans.push(await encodeChannel(ch.data, rect.right - rect.left, rect.bottom - rect.top, f.depth, f.psb))
    }
    data.push(chans)
  }
  f.layers.forEach((L, i) => {
    w.i32(L.top)
    w.i32(L.left)
    w.i32(L.bottom)
    w.i32(L.right)
    w.u16(L.channels.length)
    L.channels.forEach((ch, c) => {
      w.i16(ch.id)
      w.len(data[i][c].length)
    })
    w.sig('8BIM')
    w.sig(L.blend)
    w.u8(L.opacity)
    w.u8(L.clipping)
    w.u8(L.flags)
    w.u8(0)
    const extra = w.mark()
    if (!L.mask) w.u32(0)
    else {
      const m = L.mask
      const done = w.mark()
      w.i32(m.top)
      w.i32(m.left)
      w.i32(m.bottom)
      w.i32(m.right)
      w.u8(m.defaultColor)
      const params = (m.userDensity !== undefined ? 1 : 0) | (m.userFeather !== undefined ? 2 : 0) | (m.vectorDensity !== undefined ? 4 : 0) | (m.vectorFeather !== undefined ? 8 : 0)
      w.u8(m.flags | (params ? 16 : 0))
      if (m.real) {
        w.u8(m.real.flags)
        w.u8(m.real.defaultColor)
        w.i32(m.real.top)
        w.i32(m.real.left)
        w.i32(m.real.bottom)
        w.i32(m.real.right)
      }
      if (params) {
        w.u8(params)
        if (m.userDensity !== undefined) w.u8(m.userDensity)
        if (m.userFeather !== undefined) w.f64(m.userFeather)
        if (m.vectorDensity !== undefined) w.u8(m.vectorDensity)
        if (m.vectorFeather !== undefined) w.f64(m.vectorFeather)
      }
      if (!m.real && !params) w.zeros(2)
      done()
    }
    w.u32(L.ranges.length)
    w.bytes(L.ranges)
    w.pascal(L.name, 4)
    for (const b of L.blocks) writeBlock(w, b, 2)
    extra()
  })
  for (const chans of data) for (const c of chans) w.bytes(c)
}

export async function writePsd(f: PsdFile, o: WriteOptions = {}): Promise<Uint8Array> {
  void o
  const w = new Writer(f.psb)
  w.sig('8BPS')
  w.u16(f.psb ? 2 : 1)
  w.zeros(6)
  w.u16(f.channels)
  w.u32(f.height)
  w.u32(f.width)
  w.u16(f.depth)
  w.u16(f.mode)
  w.u32(f.colorModeData.length)
  w.bytes(f.colorModeData)
  {
    const done = w.mark()
    for (const res of f.resources) {
      w.sig('8BIM')
      w.u16(res.id)
      w.pascal(res.name, 2)
      w.u32(res.data.length)
      w.bytes(res.data)
      if (res.data.length % 2) w.u8(0)
    }
    done()
  }
  {
    const lm = w.mark(f.psb)
    const big = f.depth > 8
    // 16- and 32-bit layers go in an Lr16 or Lr32 block, the layer info left empty, as Photoshop writes them.
    if (!big) {
      const info = w.mark(f.psb)
      const start = w.pos
      if (f.layers.length) await writeLayerInfo(w, f)
      w.pad(4, start)
      info()
    } else w.len(0)
    w.u32(f.globalMask.length)
    w.bytes(f.globalMask)
    if (big && f.layers.length) {
      const sub = new Writer(f.psb)
      await writeLayerInfo(sub, f)
      sub.pad(4)
      writeBlock(w, { key: f.depth === 16 ? 'Lr16' : 'Lr32', data: sub.done() }, 4)
    }
    for (const b of f.blocks) writeBlock(w, b, 4)
    lm()
  }
  // The composite: every channel, RLE at 8 bits, ZIP with prediction above.
  const comp = f.composite ?? []
  const n = f.width * f.height
  if (f.depth === 8) {
    w.u16(1)
    const rows: Uint8Array[] = []
    for (let c = 0; c < f.channels; c++) {
      const plane = (comp[c] as Uint8Array) ?? new Uint8Array(n)
      for (let y = 0; y < f.height; y++) rows.push(packBits(plane.subarray(y * f.width, (y + 1) * f.width)))
    }
    for (const r of rows) {
      if (f.psb) w.u32(r.length)
      else w.u16(r.length)
    }
    for (const r of rows) w.bytes(r)
  } else {
    w.u16(f.depth === 16 ? 3 : 2)
    const per = n * (f.depth / 8)
    const all = new Uint8Array(per * f.channels)
    for (let c = 0; c < f.channels; c++) {
      const bytes = fromSamples(comp[c] ?? newSamples(f.depth, n), f.depth)
      all.set(f.depth === 16 ? predict(bytes, f.width, f.height, 16) : bytes, c * per)
    }
    w.bytes(await deflateZlib(all))
  }
  return w.done()
}

/** The blend modes' keys. */
export const BLEND_KEYS: Record<string, string> = {
  pass: 'pass-through',
  norm: 'normal',
  diss: 'dissolve',
  dark: 'darken',
  'mul ': 'multiply',
  idiv: 'color-burn',
  lbrn: 'linear-burn',
  dkCl: 'darker-color',
  lite: 'lighten',
  scrn: 'screen',
  'div ': 'color-dodge',
  lddg: 'linear-dodge',
  lgCl: 'lighter-color',
  over: 'overlay',
  sLit: 'soft-light',
  hLit: 'hard-light',
  vLit: 'vivid-light',
  lLit: 'linear-light',
  pLit: 'pin-light',
  hMix: 'hard-mix',
  diff: 'difference',
  smud: 'exclusion',
  fsub: 'subtract',
  fdiv: 'divide',
  'hue ': 'hue',
  'sat ': 'saturation',
  colr: 'color',
  'lum ': 'luminosity',
}
export const BLEND_KEY_OF: Record<string, string> = Object.fromEntries(Object.entries(BLEND_KEYS).map(([k, v]) => [v, k]))
