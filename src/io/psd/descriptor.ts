/**
 * Photoshop's action descriptors: the typed key–value trees that layer
 * effects (lfx2), text (TySh), smart objects (SoLd, PlLd), fill layers
 * (SoCo, GdFl, PtFl), vector strokes (vstk) and much else are kept in.
 *
 * Read into a tagged tree that writes back exactly, so a block Plexel only
 * partly understands survives a round trip; helpers read values out and
 * build new ones.
 */
import { PsdError, type Reader, type Writer } from './bin'

export interface Descriptor {
  /** The class's display name (often empty). */
  name: string
  cls: string
  items: [string, DValue][]
}

export type RefItem =
  | { t: 'prop'; name: string; cls: string; key: string }
  | { t: 'Clss'; name: string; cls: string }
  | { t: 'Enmr'; name: string; cls: string; type: string; v: string }
  | { t: 'rele'; name: string; cls: string; v: number }
  | { t: 'Idnt' | 'indx'; v: number }
  | { t: 'name'; name: string; cls: string; v: string }

export type DValue =
  | { t: 'doub'; v: number }
  | { t: 'UntF'; unit: string; v: number }
  | { t: 'UnFl'; unit: string; v: number[] }
  | { t: 'TEXT'; v: string }
  | { t: 'enum'; type: string; v: string }
  | { t: 'long'; v: number }
  | { t: 'comp'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'Objc' | 'GlbO'; v: Descriptor }
  | { t: 'VlLs'; v: DValue[] }
  | { t: 'type' | 'GlbC'; name: string; cls: string }
  | { t: 'alis' | 'tdta' | 'Pth '; v: Uint8Array }
  | { t: 'obj '; v: RefItem[] }
  | { t: 'ObAr'; v: { name: string; cls: string; items: [string, { unit: string; v: number[] }][] } }

export function readDescriptor(r: Reader): Descriptor {
  const name = r.unicode()
  const cls = r.id()
  const n = r.u32()
  const items: [string, DValue][] = []
  for (let i = 0; i < n; i++) {
    const key = r.id()
    items.push([key, readValue(r, r.sig())])
  }
  return { name, cls, items }
}

function readValue(r: Reader, t: string): DValue {
  switch (t) {
    case 'doub':
      return { t, v: r.f64() }
    case 'UntF':
      return { t, unit: r.sig(), v: r.f64() }
    case 'UnFl': {
      const unit = r.sig()
      const n = r.u32()
      return { t, unit, v: Array.from({ length: n }, () => r.f64()) }
    }
    case 'TEXT':
      return { t, v: r.unicode() }
    case 'enum':
      return { t, type: r.id(), v: r.id() }
    case 'long':
      return { t, v: r.i32() }
    case 'comp':
      return { t, v: r.i64() }
    case 'bool':
      return { t, v: r.u8() !== 0 }
    case 'Objc':
    case 'GlbO':
      return { t, v: readDescriptor(r) }
    case 'VlLs': {
      const n = r.u32()
      const v: DValue[] = []
      for (let i = 0; i < n; i++) v.push(readValue(r, r.sig()))
      return { t, v }
    }
    case 'type':
    case 'GlbC':
      return { t, name: r.unicode(), cls: r.id() }
    case 'alis':
    case 'tdta':
    case 'Pth ':
      return { t, v: r.bytes(r.u32()).slice() }
    case 'obj ': {
      const n = r.u32()
      const v: RefItem[] = []
      for (let i = 0; i < n; i++) {
        const k = r.sig()
        if (k === 'prop') v.push({ t: k, name: r.unicode(), cls: r.id(), key: r.id() })
        else if (k === 'Clss') v.push({ t: k, name: r.unicode(), cls: r.id() })
        else if (k === 'Enmr') v.push({ t: k, name: r.unicode(), cls: r.id(), type: r.id(), v: r.id() })
        else if (k === 'rele') v.push({ t: k, name: r.unicode(), cls: r.id(), v: r.i32() })
        else if (k === 'Idnt' || k === 'indx') v.push({ t: k, v: r.u32() })
        else if (k === 'name') v.push({ t: k, name: r.unicode(), cls: r.id(), v: r.unicode() })
        else throw new PsdError(`A descriptor reference of kind “${k}” isn’t known`)
      }
      return { t, v }
    }
    case 'ObAr': {
      r.u32() // version, 16
      const name = r.unicode()
      const cls = r.id()
      const n = r.u32()
      const items: [string, { unit: string; v: number[] }][] = []
      for (let i = 0; i < n; i++) {
        const key = r.id()
        const type = r.sig()
        if (type !== 'UnFl') throw new PsdError(`An object array holds “${type}”, which isn’t known`)
        const unit = r.sig()
        const count = r.u32()
        items.push([key, { unit, v: Array.from({ length: count }, () => r.f64()) }])
      }
      return { t, v: { name, cls, items } }
    }
    default:
      throw new PsdError(`A descriptor value of type “${t}” isn’t known`)
  }
}

export function writeDescriptor(w: Writer, d: Descriptor) {
  w.unicode(d.name)
  w.id(d.cls)
  w.u32(d.items.length)
  for (const [k, v] of d.items) {
    w.id(k)
    writeValue(w, v)
  }
}

function writeValue(w: Writer, v: DValue) {
  w.sig(v.t)
  switch (v.t) {
    case 'doub':
      return w.f64(v.v)
    case 'UntF':
      w.sig(v.unit)
      return w.f64(v.v)
    case 'UnFl':
      w.sig(v.unit)
      w.u32(v.v.length)
      for (const x of v.v) w.f64(x)
      return
    case 'TEXT':
      return w.unicode(v.v)
    case 'enum':
      w.id(v.type)
      return w.id(v.v)
    case 'long':
      return w.i32(v.v)
    case 'comp':
      return w.i64(v.v)
    case 'bool':
      return w.u8(v.v ? 1 : 0)
    case 'Objc':
    case 'GlbO':
      return writeDescriptor(w, v.v)
    case 'VlLs':
      w.u32(v.v.length)
      for (const x of v.v) writeValue(w, x)
      return
    case 'type':
    case 'GlbC':
      w.unicode(v.name)
      return w.id(v.cls)
    case 'alis':
    case 'tdta':
    case 'Pth ':
      w.u32(v.v.length)
      return w.bytes(v.v)
    case 'obj ':
      w.u32(v.v.length)
      for (const it of v.v) {
        w.sig(it.t)
        if (!('name' in it)) w.u32(it.v)
        else {
          w.unicode(it.name)
          w.id(it.cls)
          if (it.t === 'prop') w.id(it.key)
          else if (it.t === 'Enmr') {
            w.id(it.type)
            w.id(it.v)
          } else if (it.t === 'rele') w.i32(it.v)
          else if (it.t === 'name') w.unicode(it.v)
        }
      }
      return
    case 'ObAr':
      w.u32(16)
      w.unicode(v.v.name)
      w.id(v.v.cls)
      w.u32(v.v.items.length)
      for (const [k, x] of v.v.items) {
        w.id(k)
        w.sig('UnFl')
        w.sig(x.unit)
        w.u32(x.v.length)
        for (const n of x.v) w.f64(n)
      }
      return
  }
}

// --- reading values out ---------------------------------------------------------------------------

export const get = (d: Descriptor | undefined, key: string): DValue | undefined => d?.items.find(([k]) => k === key)?.[1]

/** A number: doub, long, comp or a unit float's value. */
export function num(d: Descriptor | undefined, key: string, fallback = 0): number {
  const v = get(d, key)
  if (!v) return fallback
  if (v.t === 'doub' || v.t === 'long' || v.t === 'comp' || v.t === 'UntF') return v.v
  return fallback
}

/** A unit float's unit and value ("#Prc" percent, "#Pxl" pixels, "#Ang" degrees, "#Pnt" points). */
export function unit(d: Descriptor | undefined, key: string): { unit: string; v: number } | null {
  const v = get(d, key)
  if (v?.t === 'UntF') return { unit: v.unit, v: v.v }
  if (v?.t === 'doub' || v?.t === 'long') return { unit: '#Nne', v: v.v }
  return null
}

export function str(d: Descriptor | undefined, key: string, fallback = ''): string {
  const v = get(d, key)
  return v?.t === 'TEXT' ? v.v : fallback
}

export function en(d: Descriptor | undefined, key: string): string | null {
  const v = get(d, key)
  return v?.t === 'enum' ? v.v : null
}

export function bool(d: Descriptor | undefined, key: string, fallback = false): boolean {
  const v = get(d, key)
  return v?.t === 'bool' ? v.v : fallback
}

export function obj(d: Descriptor | undefined, key: string): Descriptor | undefined {
  const v = get(d, key)
  return v?.t === 'Objc' || v?.t === 'GlbO' ? v.v : undefined
}

export function list(d: Descriptor | undefined, key: string): DValue[] {
  const v = get(d, key)
  return v?.t === 'VlLs' ? v.v : []
}

export const objs = (d: Descriptor | undefined, key: string): Descriptor[] => list(d, key).flatMap((x) => (x.t === 'Objc' || x.t === 'GlbO' ? [x.v] : []))

export function raw(d: Descriptor | undefined, key: string): Uint8Array | null {
  const v = get(d, key)
  return v?.t === 'tdta' || v?.t === 'alis' ? v.v : null
}

// --- building -------------------------------------------------------------------------------------

export const D = {
  doub: (v: number): DValue => ({ t: 'doub', v }),
  unit: (unit: '#Prc' | '#Pxl' | '#Ang' | '#Pnt' | '#Nne' | '#Rsl' | '#Rlt', v: number): DValue => ({ t: 'UntF', unit, v }),
  text: (v: string): DValue => ({ t: 'TEXT', v }),
  enum: (type: string, v: string): DValue => ({ t: 'enum', type, v }),
  long: (v: number): DValue => ({ t: 'long', v: Math.round(v) }),
  bool: (v: boolean): DValue => ({ t: 'bool', v }),
  obj: (cls: string, items: [string, DValue][], name = ''): DValue => ({ t: 'Objc', v: { name, cls, items } }),
  list: (v: DValue[]): DValue => ({ t: 'VlLs', v }),
  data: (v: Uint8Array): DValue => ({ t: 'tdta', v }),
}

export const desc = (cls: string, items: [string, DValue][], name = ''): Descriptor => ({ name, cls, items })
