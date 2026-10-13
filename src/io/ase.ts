/**
 * Adobe Swatch Exchange (.ase): the swatch library format Photoshop,
 * Illustrator, InDesign and Affinity all read and write.
 *
 *   "ASEF", version 1.0 (two u16s), a u32 block count, then blocks:
 *     u16 type: 0xC001 group start, 0xC002 group end, 0x0001 colour
 *     u32 length of what follows
 *     colour and group start: a u16 length in UTF-16 units (with the
 *       closing NUL), the name in UTF-16 big-endian; a colour then has its
 *       model ("CMYK", "RGB ", "LAB ", "Gray"), its values as big-endian
 *       float32s, and a u16 kind: 0 global, 1 spot, 2 normal.
 *
 * Values are 0..1 for CMYK (ink), RGB and Gray (light; 0 is black), and
 * for Lab L is 0..1 (of 100) with a and b as they are. The file names no
 * profiles: CMYK, RGB and Gray colours are read in the profiles given
 * (the working spaces) and written as their numbers.
 */
import type { ColourValue } from '../color/value'
import type { DocSwatch, SwatchKind } from '../doc/swatches'
import type { ProfileRef } from '../doc/types'

export interface AseProfiles {
  rgb: ProfileRef
  cmyk: ProfileRef
  gray: ProfileRef
}

const DEFAULT_PROFILES: AseProfiles = { rgb: { builtin: 'srgb' }, cmyk: { builtin: 'generic-cmyk' }, gray: { builtin: 'gray-gamma-2.2' } }

export type AseRead = { ok: true; swatches: Omit<DocSwatch, 'id'>[]; warnings: string[] } | { ok: false; error: string }

const KIND_IN: Record<number, SwatchKind> = { 0: 'global', 1: 'spot', 2: 'process' }
const KIND_OUT: Record<SwatchKind, number> = { global: 0, spot: 1, process: 2 }

export function readAse(bytes: Uint8Array, profiles: AseProfiles = DEFAULT_PROFILES): AseRead {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'ASEF') return { ok: false, error: 'it isn’t an Adobe Swatch Exchange file' }
  const major = v.getUint16(4)
  if (major !== 1) return { ok: false, error: `it’s version ${major}, and Plexel reads version 1` }
  const count = v.getUint32(8)
  const swatches: Omit<DocSwatch, 'id'>[] = []
  const warnings = new Set<string>()
  let o = 12
  const groups: string[] = []
  for (let b = 0; b < count; b++) {
    if (o + 6 > bytes.length) return { ok: false, error: 'it ends part-way through' }
    const type = v.getUint16(o)
    const len = v.getUint32(o + 2)
    const start = o + 6
    const end = start + len
    if (end > bytes.length) return { ok: false, error: 'it ends part-way through' }
    o = end
    if (type === 0xc002) {
      groups.pop()
      continue
    }
    if (type !== 0x0001 && type !== 0xc001) continue
    if (start + 2 > end) continue
    const n = v.getUint16(start)
    if (start + 2 + n * 2 > end) return { ok: false, error: 'a name runs past its block' }
    let name = ''
    for (let i = 0; i < n; i++) {
      const c = v.getUint16(start + 2 + i * 2)
      if (c) name += String.fromCharCode(c)
    }
    if (type === 0xc001) {
      groups.push(name)
      continue
    }
    let p = start + 2 + n * 2
    if (p + 4 > end) continue
    const model = String.fromCharCode(...bytes.subarray(p, p + 4))
    p += 4
    const nums = { 'CMYK': 4, 'RGB ': 3, 'LAB ': 3, Gray: 1 }[model]
    if (!nums || p + nums * 4 + 2 > end) {
      warnings.add(`Colours in the “${model.trim()}” model were left out`)
      continue
    }
    const f = Array.from({ length: nums }, (_, i) => v.getFloat32(p + i * 4))
    if (!f.every(Number.isFinite)) continue
    p += nums * 4
    const kind = KIND_IN[v.getUint16(p)] ?? 'process'
    const clamp = (x: number) => Math.min(1, Math.max(0, x))
    const colour: ColourValue =
      model === 'CMYK'
        ? { space: 'cmyk', profile: profiles.cmyk, c: f.map(clamp) }
        : model === 'RGB '
          ? { space: 'rgb', profile: profiles.rgb, c: f.map(clamp) }
          : model === 'LAB '
            ? { space: 'lab', profile: null, c: [clamp(f[0]) * 100, Math.min(127, Math.max(-128, f[1])), Math.min(127, Math.max(-128, f[2]))] }
            : { space: 'gray', profile: profiles.gray, c: [clamp(f[0])] }
    swatches.push({ name: name || (groups.length ? `${groups[groups.length - 1]} ${swatches.length + 1}` : `Swatch ${swatches.length + 1}`), kind, colour })
  }
  return { ok: true, swatches, warnings: [...warnings] }
}

/** Swatches as an .ase file, one colour block each, no groups. */
export function writeAse(swatches: Pick<DocSwatch, 'name' | 'kind' | 'colour'>[]): Uint8Array {
  const blocks = swatches.map((s) => {
    const name = s.name.slice(0, 1000)
    const model = s.colour.space === 'cmyk' ? 'CMYK' : s.colour.space === 'rgb' ? 'RGB ' : s.colour.space === 'lab' ? 'LAB ' : 'Gray'
    const values = s.colour.space === 'lab' ? [s.colour.c[0] / 100, s.colour.c[1], s.colour.c[2]] : s.colour.c
    const len = 2 + (name.length + 1) * 2 + 4 + values.length * 4 + 2
    const b = new Uint8Array(6 + len)
    const v = new DataView(b.buffer)
    v.setUint16(0, 0x0001)
    v.setUint32(2, len)
    let p = 6
    v.setUint16(p, name.length + 1)
    p += 2
    for (let i = 0; i < name.length; i++, p += 2) v.setUint16(p, name.charCodeAt(i))
    p += 2
    for (let i = 0; i < 4; i++) b[p + i] = model.charCodeAt(i)
    p += 4
    for (const x of values) {
      v.setFloat32(p, x)
      p += 4
    }
    v.setUint16(p, KIND_OUT[s.kind])
    return b
  })
  const total = 12 + blocks.reduce((t, b) => t + b.length, 0)
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  out.set([0x41, 0x53, 0x45, 0x46])
  v.setUint16(4, 1)
  v.setUint16(6, 0)
  v.setUint32(8, blocks.length)
  let o = 12
  for (const b of blocks) {
    out.set(b, o)
    o += b.length
  }
  return out
}
