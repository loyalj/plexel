/**
 * Tiles as bytes: one tile on its own (for the journal, where each is a
 * content-addressed file) and a whole set as a pack (for .pxll files,
 * `layers/<id>.tiles`).
 *
 * A data tile is stored filtered and deflated. The filter is PNG's Sub,
 * per row of each plane: each sample becomes its difference from the one
 * to its left, which turns smooth images into small numbers that deflate
 * well. A uniform tile is stored as its values.
 *
 * Pack layout, little-endian throughout:
 *
 *   magic "PXTS", version u16, mode u8, depth u8, tile size u16, planes u8,
 *   reserved u8, count u32                                    (16 bytes)
 *   index: count entries of x i32, y i32, kind u8, 3 reserved,
 *          offset u64 from the start of the data, length u32  (24 bytes each)
 *   data
 *
 * Kinds: 0 uniform (planes × u16 values), 1 deflated, 2 Sub-filtered and
 * deflated. The index comes first so a reader can fetch single tiles from a
 * big file without reading the rest (phase 4 reads them that way).
 */
import type { ColourMode } from '../doc/types'
import { deflateRaw, inflateRaw } from '../io/zip'
import { TILE, newSamples, planesOf, tileSamples, type Samples, type TileFormat } from './format'
import { parseKey, type SetId, type TileStore } from './store'

const MAGIC = 0x53545850 // "PXTS" read as a little-endian u32
const VERSION = 1
const HEADER = 16
const ENTRY = 24
const MODES: ColourMode[] = ['rgb', 'gray', 'cmyk']

export const KIND_UNIFORM = 0
export const KIND_DEFLATE = 1
export const KIND_SUB = 2

export class PackError extends Error {}

function subFilter(f: TileFormat, s: Samples): Samples {
  const out = newSamples(f)
  const mask = f.depth === 16 ? 0xffff : 0xff
  for (let row = 0; row < planesOf(f) * TILE; row++) {
    const o = row * TILE
    out[o] = s[o]
    for (let x = 1; x < TILE; x++) out[o + x] = (s[o + x] - s[o + x - 1]) & mask
  }
  return out
}

function unSubFilter(f: TileFormat, s: Samples) {
  const mask = f.depth === 16 ? 0xffff : 0xff
  for (let row = 0; row < planesOf(f) * TILE; row++) {
    const o = row * TILE
    for (let x = 1; x < TILE; x++) s[o + x] = (s[o + x] + s[o + x - 1]) & mask
  }
}

const bytesOf = (s: Samples) => new Uint8Array(s.buffer, s.byteOffset, s.byteLength)

/** One data tile's bytes: Sub-filtered and deflated. */
export async function encodeTile(f: TileFormat, s: Samples): Promise<Uint8Array> {
  return deflateRaw(bytesOf(subFilter(f, s)))
}

export async function decodeTile(f: TileFormat, kind: number, bytes: Uint8Array): Promise<Samples> {
  const raw = await inflateRaw(bytes)
  const want = tileSamples(f) * (f.depth / 8)
  if (raw.length !== want) throw new PackError(`A tile has ${raw.length} bytes; a ${f.mode}/${f.depth} tile has ${want}.`)
  const s = f.depth === 16 ? new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2).slice() : raw
  if (kind === KIND_SUB) unSubFilter(f, s)
  return s
}

/** A whole set as a pack. */
export async function encodeSet(store: TileStore, id: SetId): Promise<Uint8Array> {
  const { format, tiles } = store.getSet(id)
  const planes = planesOf(format)
  const entries: { x: number; y: number; kind: number; data: Uint8Array }[] = []
  for (const [k, t] of tiles) {
    const [x, y] = parseKey(k)
    const u = store.isUniform(t)
    if (u) {
      const d = new Uint8Array(planes * 2)
      const v = new DataView(d.buffer)
      u.forEach((n, i) => v.setUint16(i * 2, n, true))
      entries.push({ x, y, kind: KIND_UNIFORM, data: d })
    } else {
      entries.push({ x, y, kind: KIND_SUB, data: await encodeTile(format, await store.samples(t)) })
    }
  }
  const dataLen = entries.reduce((n, e) => n + e.data.length, 0)
  const out = new Uint8Array(HEADER + entries.length * ENTRY + dataLen)
  const v = new DataView(out.buffer)
  v.setUint32(0, MAGIC, true)
  v.setUint16(4, VERSION, true)
  v.setUint8(6, MODES.indexOf(format.mode))
  v.setUint8(7, format.depth)
  v.setUint16(8, TILE, true)
  v.setUint8(10, planes)
  v.setUint32(12, entries.length, true)
  let offset = 0
  const dataStart = HEADER + entries.length * ENTRY
  entries.forEach((e, i) => {
    const at = HEADER + i * ENTRY
    v.setInt32(at, e.x, true)
    v.setInt32(at + 4, e.y, true)
    v.setUint8(at + 8, e.kind)
    v.setUint32(at + 12, offset % 2 ** 32, true)
    v.setUint32(at + 16, Math.floor(offset / 2 ** 32), true)
    v.setUint32(at + 20, e.data.length, true)
    out.set(e.data, dataStart + offset)
    offset += e.data.length
  })
  return out
}

/** The format a pack holds, from its header alone. */
export function packFormat(bytes: Uint8Array): TileFormat {
  if (bytes.length < HEADER) throw new PackError('The tile data is cut short.')
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (v.getUint32(0, true) !== MAGIC) throw new PackError('This isn’t Plexel tile data.')
  const version = v.getUint16(4, true)
  if (version > VERSION) throw new PackError(`The tile data is a newer format (${version}) than this version reads (${VERSION}).`)
  const mode = MODES[v.getUint8(6)]
  const depth = v.getUint8(7)
  if (!mode || (depth !== 8 && depth !== 16)) throw new PackError('The tile data has an unknown colour mode or depth.')
  if (v.getUint16(8, true) !== TILE) throw new PackError(`The tile data uses ${v.getUint16(8, true)}-pixel tiles; this version uses ${TILE}.`)
  const format = { mode, depth } as TileFormat
  if (v.getUint8(10) !== planesOf(format)) throw new PackError('The tile data has the wrong number of channels for its mode.')
  return format
}

/**
 * Reads a pack's index from `blob`, where the pack is the `length` bytes at
 * `start`, and makes the set from it without reading any pixels: data
 * tiles stay in the file until they're drawn (TileStore.lazy). Only the
 * header, the index and the uniform tiles' few bytes are read now.
 */
export async function decodeSetLazy(store: TileStore, blob: Blob, start: number, length: number, id: SetId): Promise<SetId> {
  if (store.hasSet(id)) return id
  const head = new Uint8Array(await blob.slice(start, start + HEADER).arrayBuffer())
  const format = packFormat(head)
  const count = new DataView(head.buffer).getUint32(12, true)
  const dataStart = HEADER + count * ENTRY
  if (dataStart > length) throw new PackError('The tile index runs past the end of the data.')
  const index = new DataView(await blob.slice(start + HEADER, start + dataStart).arrayBuffer())
  const planes = planesOf(format)
  const entries: [number, number, number][] = []
  const uniforms: { i: number; offset: number }[] = []
  for (let i = 0; i < count; i++) {
    const at = i * ENTRY
    const x = index.getInt32(at, true)
    const y = index.getInt32(at + 4, true)
    const kind = index.getUint8(at + 8)
    const offset = index.getUint32(at + 12, true) + index.getUint32(at + 16, true) * 2 ** 32
    const len = index.getUint32(at + 20, true)
    if (dataStart + offset + len > length) throw new PackError('A tile runs past the end of the data.')
    const abs = start + dataStart + offset
    if (kind === KIND_UNIFORM) {
      if (len !== planes * 2) throw new PackError('A uniform tile has the wrong length.')
      uniforms.push({ i: entries.length, offset: abs })
      entries.push([x, y, -1])
    } else if (kind === KIND_DEFLATE || kind === KIND_SUB) {
      entries.push([x, y, store.lazy(format, { blob, offset: abs, length: len, kind, decode: (k, b) => decodeTile(format, k, b) })])
    } else {
      throw new PackError(`A tile is stored in a way this version doesn’t know (${kind}).`)
    }
  }
  // Uniform tiles are a few bytes each; read in batches rather than one by one.
  for (let b = 0; b < uniforms.length; b += 64) {
    await Promise.all(
      uniforms.slice(b, b + 64).map(async ({ i, offset }) => {
        const dv = new DataView(await blob.slice(offset, offset + planes * 2).arrayBuffer())
        entries[i][2] = store.uniform(format, Array.from({ length: planes }, (_, p) => dv.getUint16(p * 2, true)))
      }),
    )
  }
  return store.createSet(format, entries, id)
}

/** Reads a pack into the store as the set `id`. */
export async function decodeSet(store: TileStore, bytes: Uint8Array, id: SetId): Promise<SetId> {
  if (store.hasSet(id)) return id
  const format = packFormat(bytes)
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = v.getUint32(12, true)
  const dataStart = HEADER + count * ENTRY
  if (dataStart > bytes.length) throw new PackError('The tile index runs past the end of the data.')
  const planes = planesOf(format)
  const entries: [number, number, number][] = []
  for (let i = 0; i < count; i++) {
    const at = HEADER + i * ENTRY
    const x = v.getInt32(at, true)
    const y = v.getInt32(at + 4, true)
    const kind = v.getUint8(at + 8)
    const offset = v.getUint32(at + 12, true) + v.getUint32(at + 16, true) * 2 ** 32
    const len = v.getUint32(at + 20, true)
    const start = dataStart + offset
    if (start + len > bytes.length) throw new PackError('A tile runs past the end of the data.')
    const data = bytes.subarray(start, start + len)
    if (kind === KIND_UNIFORM) {
      if (len !== planes * 2) throw new PackError('A uniform tile has the wrong length.')
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
      entries.push([x, y, store.uniform(format, Array.from({ length: planes }, (_, p) => dv.getUint16(p * 2, true)))])
    } else if (kind === KIND_DEFLATE || kind === KIND_SUB) {
      entries.push([x, y, store.data(format, await decodeTile(format, kind, data))])
    } else {
      throw new PackError(`A tile is stored in a way this version doesn’t know (${kind}).`)
    }
  }
  return store.createSet(format, entries, id)
}
