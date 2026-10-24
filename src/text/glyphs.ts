/**
 * What the Glyphs panel shows of a font: every character it maps (its cmap
 * table, read straight from the file), each character's alternates (the
 * glyphs OpenType features give it, found by shaping it with each), and a
 * glyph's outline as an SVG path.
 *
 * Pure apart from the font it's handed: check-text runs it in Node.
 */
import type { Face, Font } from './hb'

/** A character the font has, and its glyph. */
export interface MappedGlyph {
  cp: number
  gid: number
}

const maps = new WeakMap<Face, MappedGlyph[]>()

/**
 * Every character a face maps to a glyph, in order: from its best cmap
 * subtable (full Unicode, format 12, before the Basic Multilingual Plane's,
 * format 4). Read once per face.
 */
export function cmapOf(face: Face): MappedGlyph[] {
  const hit = maps.get(face)
  if (hit) return hit
  const out = parseCmap(face.tableBytes('cmap'))
  maps.set(face, out)
  return out
}

export function parseCmap(bytes: Uint8Array | null): MappedGlyph[] {
  if (!bytes || bytes.length < 4) return []
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (o: number) => (o + 2 <= v.byteLength ? v.getUint16(o) : 0)
  const u32 = (o: number) => (o + 4 <= v.byteLength ? v.getUint32(o) : 0)
  const n = u16(2)
  const tables: { platform: number; encoding: number; offset: number; format: number }[] = []
  for (let i = 0; i < n; i++) {
    const r = 4 + i * 8
    const offset = u32(r + 4)
    tables.push({ platform: u16(r), encoding: u16(r + 2), offset, format: u16(offset) })
  }
  const rank = (t: (typeof tables)[number]) => (t.format === 12 && (t.platform === 3 || t.platform === 0) ? 0 : t.format === 4 && (t.platform === 3 || t.platform === 0) ? 1 : 9)
  const best = tables.filter((t) => rank(t) < 9).sort((a, b) => rank(a) - rank(b))[0]
  if (!best) return []
  const out = new Map<number, number>()
  const o = best.offset
  if (best.format === 12) {
    const groups = u32(o + 12)
    for (let g = 0; g < groups && g < 100000; g++) {
      const at = o + 16 + g * 12
      const start = u32(at)
      const end = Math.min(u32(at + 4), 0x10ffff)
      const gid = u32(at + 8)
      for (let cp = start; cp <= end && cp - start < 70000; cp++) if (gid + cp - start) out.set(cp, gid + cp - start)
    }
  } else {
    const segX2 = u16(o + 6)
    const ends = o + 14
    const starts = ends + segX2 + 2
    const deltas = starts + segX2
    const ranges = deltas + segX2
    for (let s = 0; s < segX2 / 2; s++) {
      const end = u16(ends + s * 2)
      const start = u16(starts + s * 2)
      const delta = u16(deltas + s * 2)
      const ro = u16(ranges + s * 2)
      for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
        let gid: number
        if (!ro) gid = (cp + delta) & 0xffff
        else {
          const g = u16(ranges + s * 2 + ro + (cp - start) * 2)
          gid = g ? (g + delta) & 0xffff : 0
        }
        if (gid) out.set(cp, gid)
      }
    }
  }
  return [...out].map(([cp, gid]) => ({ cp, gid })).sort((a, b) => a.cp - b.cp)
}

/** OpenType features that swap a character for another form of it: what the panel looks through for alternates. */
const ALTERNATE_FEATURES = [
  'salt',
  'swsh',
  'cswh',
  'titl',
  'smcp',
  'c2sc',
  'pcap',
  'c2pc',
  'unic',
  'onum',
  'lnum',
  'pnum',
  'tnum',
  'zero',
  'sups',
  'subs',
  'sinf',
  'ordn',
  'case',
  'hist',
  'nalt',
  'ornm',
  ...Array.from({ length: 20 }, (_, i) => `ss${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 20 }, (_, i) => `cv${String(i + 1).padStart(2, '0')}`),
]

/**
 * A character's alternates in a font: each glyph a feature gives it in
 * place of its own, with the feature that does (aalt's alternates as
 * "aalt=1", "aalt=2"…), each glyph once.
 */
export function alternatesOf(font: Font, cp: number, lang = ''): { gid: number; feature: string }[] {
  const ch = String.fromCodePoint(cp)
  const base = font.shape(ch, 0, ch.length, 'ltr', '', lang, [])
  if (base.length !== 1) return []
  const seen = new Set([base[0].gid])
  const out: { gid: number; feature: string }[] = []
  const tryFeature = (f: string) => {
    const g = font.shape(ch, 0, ch.length, 'ltr', '', lang, [f])
    if (g.length !== 1 || seen.has(g[0].gid)) return false
    seen.add(g[0].gid)
    out.push({ gid: g[0].gid, feature: f })
    return true
  }
  for (let k = 1; k <= 12; k++) if (!tryFeature(`aalt=${k}`) && k > 1) break
  for (const f of ALTERNATE_FEATURES) tryFeature(f)
  return out
}

/** A glyph's outline (font units, y up) as an SVG path, y down: for drawing in a box from the ascender down. */
export function outlineSvg(outline: number[]): string {
  const parts: string[] = []
  const r = (v: number) => Math.round(v * 10) / 10
  for (let i = 0; i < outline.length; ) {
    const op = outline[i]
    if (op === 0 || op === 1) {
      parts.push(`${op === 0 ? 'M' : 'L'}${r(outline[i + 1])} ${r(-outline[i + 2])}`)
      i += 3
    } else if (op === 3) {
      parts.push(`C${r(outline[i + 1])} ${r(-outline[i + 2])} ${r(outline[i + 3])} ${r(-outline[i + 4])} ${r(outline[i + 5])} ${r(-outline[i + 6])}`)
      i += 7
    } else {
      parts.push('Z')
      i += 1
    }
  }
  return parts.join('')
}

/** A character's name as the panel shows it: U+ and its hex. */
export const codeName = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
