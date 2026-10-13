/**
 * The tagged blocks of a PSD layer that Plexel understands, read into
 * plain structures: names, groups, protection, colour tags, fill opacity,
 * knockout, vector paths, fill layers, vector strokes, adjustments, layer
 * effects, text, smart objects and the files embedded for them.
 *
 * Layouts as Adobe's specification gives them, with psd-tools' notes where
 * the specification is silent (subpath operations, the order inside mask
 * records).
 */
import { PsdError, Reader } from './bin'
import { readDescriptor, type Descriptor } from './descriptor'
import { readEngineData, type EValue } from './engineData'
import type { PsdBlock } from './format'

export const block = (blocks: PsdBlock[], ...keys: string[]): Uint8Array | null => blocks.find((b) => keys.includes(b.key))?.data ?? null

/** A descriptor after a u32 version (16), as most descriptor blocks have it. */
export function versionedDescriptor(data: Uint8Array, skip = 0): Descriptor {
  const r = new Reader(data)
  r.skip(skip)
  r.u32()
  return readDescriptor(r)
}

export function unicodeName(data: Uint8Array): string {
  return new Reader(data).unicode()
}

/** lsct: 1 open group, 2 closed group, 3 the end of a group (its bottom); a group's blend key when given. */
export function sectionDivider(data: Uint8Array): { type: number; blend: string | null } {
  const r = new Reader(data)
  const type = r.u32()
  let blend: string | null = null
  if (r.left >= 8) {
    r.sig()
    blend = r.sig()
  }
  return { type, blend }
}

// --- paths ------------------------------------------------------------------------------------------

export interface PsdKnot {
  /** Document pixels: the handle arriving, the anchor, the handle leaving. */
  before: [number, number]
  anchor: [number, number]
  after: [number, number]
  linked: boolean
}

export interface PsdSubpath {
  closed: boolean
  /** 1 union, 2 subtract, 3 intersect, 0 exclude (and -1, older files, the same as union). */
  op: number
  knots: PsdKnot[]
}

export interface PsdPath {
  invert: boolean
  notLink: boolean
  disabled: boolean
  subpaths: PsdSubpath[]
}

/** vmsk / vsms: path records, points as fractions of the document (8.24 fixed point). */
export function readPath(data: Uint8Array, width: number, height: number): PsdPath {
  const r = new Reader(data)
  r.u32()
  const flags = r.u32()
  const subpaths: PsdSubpath[] = []
  let cur: PsdSubpath | null = null
  const fixed = () => r.i32() / 2 ** 24
  const pt = (): [number, number] => {
    const y = fixed() * height
    const x = fixed() * width
    return [x, y]
  }
  while (r.left >= 26) {
    const sel = r.u16()
    const start = r.pos
    if (sel === 0 || sel === 3) {
      r.u16() // knot count
      const op = r.i16()
      cur = { closed: sel === 0, op, knots: [] }
      subpaths.push(cur)
    } else if (sel === 1 || sel === 2 || sel === 4 || sel === 5) {
      const before = pt()
      const anchor = pt()
      const after = pt()
      cur?.knots.push({ before, anchor, after, linked: sel === 1 || sel === 4 })
    }
    r.pos = start + 24
  }
  return { invert: (flags & 1) !== 0, notLink: (flags & 2) !== 0, disabled: (flags & 4) !== 0, subpaths }
}

// --- adjustments ------------------------------------------------------------------------------------

export interface LevelsRecord {
  inBlack: number
  inWhite: number
  outBlack: number
  outWhite: number
  gamma: number
}

export function readLevels(data: Uint8Array): LevelsRecord[] {
  const r = new Reader(data)
  r.u16()
  const out: LevelsRecord[] = []
  for (let i = 0; i < 29 && r.left >= 10; i++) out.push({ inBlack: r.u16(), inWhite: r.u16(), outBlack: r.u16(), outWhite: r.u16(), gamma: r.u16() / 100 })
  return out
}

/** Curves: per channel present (bit 0 the composite), points as [input, output] 0..255. */
export function readCurves(data: Uint8Array): Map<number, [number, number][]> {
  const r = new Reader(data)
  const isMap = r.u8()
  const version = r.u16()
  const bits = r.u32()
  const out = new Map<number, [number, number][]>()
  const channels: number[] = []
  if (version === 1) for (let c = 0; c < 32; c++) if (bits & (1 << c)) channels.push(c)
  const readPoints = (): [number, number][] => {
    if (isMap) {
      const table = r.bytes(256)
      // A map: sampled back into points.
      return [0, 32, 64, 96, 128, 160, 192, 224, 255].map((x) => [x, table[x]])
    }
    const n = r.u16()
    const pts: [number, number][] = []
    for (let i = 0; i < n; i++) {
      const o = r.u16()
      const x = r.u16()
      pts.push([x, o])
    }
    return pts
  }
  if (version === 1) for (const c of channels) out.set(c, readPoints())
  // The extra block names channels explicitly, and is what newer files rely on.
  if (r.left >= 10 && new TextDecoder('latin1').decode(data.subarray(r.pos, r.pos + 4)) === 'Crv ') {
    r.skip(4)
    r.u16()
    const n = r.u32()
    for (let i = 0; i < n && r.left >= 4; i++) {
      const id = r.u16()
      out.set(id, readPoints())
    }
  } else if (version === 4) {
    for (let i = 0; i < bits && r.left >= 2; i++) {
      const id = r.u16()
      out.set(id, readPoints())
    }
  }
  return out
}

export function readBrightness(data: Uint8Array): { brightness: number; contrast: number } {
  const r = new Reader(data)
  return { brightness: r.i16(), contrast: r.i16() }
}

/** Hue/Saturation: the colourise and master settings, and each of the six colour ranges' hue, saturation and lightness. */
export function readHueSat(data: Uint8Array): { colorize: boolean; colorization: [number, number, number]; master: [number, number, number]; ranges: number[][]; limits: [number, number, number, number][] } {
  const r = new Reader(data)
  r.u16()
  const colorize = r.u8() !== 0
  r.u8()
  const colorization: [number, number, number] = [r.i16(), r.i16(), r.i16()]
  const master: [number, number, number] = [r.i16(), r.i16(), r.i16()]
  const ranges: number[][] = []
  const limits: [number, number, number, number][] = []
  // Each range: four hue limits (where it ramps in, starts, ends and ramps out), then its three settings.
  for (let i = 0; i < 6 && r.left >= 14; i++) {
    limits.push([r.i16(), r.i16(), r.i16(), r.i16()])
    ranges.push([r.i16(), r.i16(), r.i16()])
  }
  return { colorize, colorization, master, ranges, limits }
}

export function readColourBalance(data: Uint8Array): { shadows: number[]; midtones: number[]; highlights: number[]; luminosity: boolean } {
  const r = new Reader(data)
  const three = () => [r.i16(), r.i16(), r.i16()]
  return { shadows: three(), midtones: three(), highlights: three(), luminosity: r.left > 0 ? r.u8() !== 0 : true }
}

export function readMixer(data: Uint8Array): { monochrome: boolean; rows: number[][] } {
  const r = new Reader(data)
  r.u16()
  const monochrome = r.u16() !== 0
  const rows: number[][] = []
  while (r.left >= 10 && rows.length < 4) rows.push([r.i16(), r.i16(), r.i16(), r.i16(), r.i16()])
  return { monochrome, rows }
}

export function readExposure(data: Uint8Array): { exposure: number; offset: number; gamma: number } {
  const r = new Reader(data)
  r.u16()
  return { exposure: r.f32(), offset: r.f32(), gamma: r.f32() }
}

export interface PsdGradientStop {
  at: number
  /** The colour's space (0 RGB, 1 HSB, 2 CMYK, 7 Lab, 8 Gray) and four 16-bit values. */
  space: number
  values: number[]
}

export function readGradientMap(data: Uint8Array): { reverse: boolean; stops: PsdGradientStop[] } {
  const r = new Reader(data)
  const version = r.u16()
  const reverse = r.u8() !== 0
  r.u8()
  if (version === 3) r.sig()
  r.unicode()
  const n = r.u16()
  const stops: PsdGradientStop[] = []
  for (let i = 0; i < n; i++) {
    const at = r.u32() / 4096
    r.u32()
    const space = r.u16()
    const values = [r.u16(), r.u16(), r.u16(), r.u16()]
    r.skip(2)
    stops.push({ at, space, values })
  }
  return { reverse, stops }
}

// --- text -------------------------------------------------------------------------------------------

export interface PsdText {
  /** xx xy yx yy tx ty. */
  transform: number[]
  text: Descriptor
  engine: EValue | null
}

export function readTypeTool(data: Uint8Array): PsdText {
  const r = new Reader(data)
  r.u16()
  const transform = [r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64()]
  r.u16()
  r.u32()
  const text = readDescriptor(r)
  const ed = text.items.find(([k]) => k === 'EngineData')?.[1]
  const engine = ed && ed.t === 'tdta' ? readEngineData(ed.v) : null
  return { transform, text, engine }
}

// --- smart objects ----------------------------------------------------------------------------------

/** SoLd (or SoLE): the placed object's descriptor, after its key and version. */
export function readSmartObject(data: Uint8Array): Descriptor {
  const r = new Reader(data)
  r.sig()
  r.u32()
  r.u32()
  return readDescriptor(r)
}

export interface LinkedFile {
  id: string
  name: string
  type: string
  data: Uint8Array | null
  /** External files are referred to, not carried. */
  external: boolean
}

/** lnk2 / lnkD / lnk3: the files smart objects are made from. */
export function readLinkedFiles(data: Uint8Array): LinkedFile[] {
  const r = new Reader(data)
  const out: LinkedFile[] = []
  while (r.left >= 8) {
    const len = r.u64()
    if (len <= 0 || len > r.left) break
    const start = r.pos
    try {
      const kind = r.sig()
      const version = r.u32()
      const id = r.pascal(1)
      const name = r.unicode()
      const type = r.sig()
      r.sig()
      const size = r.u64()
      const hasDescriptor = r.u8()
      if (hasDescriptor) {
        r.u32()
        readDescriptor(r)
      }
      let bytes: Uint8Array | null = null
      if (kind === 'liFD') bytes = r.bytes(Math.min(size, r.left)).slice()
      out.push({ id, name, type, data: bytes, external: kind !== 'liFD' })
      void version
    } catch (e) {
      if (!(e instanceof PsdError)) throw e
    }
    r.pos = start + len
    // Items are padded to four bytes.
    while (r.pos % 4 && r.left) r.pos++
  }
  return out
}
