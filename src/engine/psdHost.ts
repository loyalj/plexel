/**
 * Photoshop files as the engine worker opens them: parsed (io/psd/format),
 * mapped to a document (io/psd/toDoc) with this file as the host that makes
 * tile sets from the channels, converts colours, and opens the files
 * embedded for smart objects (PSD and PSB, or images) in the document's
 * own mode and depth. The sets it makes are held a minute for the page to
 * commit.
 */
import type { Intent } from '../color/cms'
import { buildConvertLut, runConvertLut } from '../color/convertLut'
import { Converter } from '../color/value'
import { convertDocColours, pixelSets } from '../doc/convert'
import { makeNode } from '../doc/nodes'
import type { ColourMode, Depth, Doc, ProfileRef } from '../doc/types'
import { sha256 } from '../io/assets'
import { readPsd, type PsdSamples } from '../io/psd/format'
import { psdToDoc, type PsdHost } from '../io/psd/toDoc'
import { decodeImage, rasterToSet } from '../io/raster'
import { COLOUR_CHANNELS, TILE, TILE_PIXELS, newSamples, type TileFormat } from '../tiles/format'
import { convertSet } from '../tiles/convert'
import type { TileId } from '../tiles/store'
import { colour } from './colourHost'
import { decodeJpeg } from './imageHost'
import { addProfile } from './colourHost'
import { pinSet, store, unpinSet } from './tileHost'

const HOLD_MS = 60_000
const hold = (id: string) => {
  pinSet(id)
  setTimeout(() => unpinSet(id), HOLD_MS)
}

export interface PsdOpened {
  doc: Doc
  warnings: string[]
  fonts: string[]
  /** Embedded profiles the page should keep, by hash. */
  profiles: { hash: string; bytes: Uint8Array }[]
}

let ids = 0
const newId = (p: string) => {
  const b = new Uint8Array(6)
  crypto.getRandomValues(b)
  return p + [...b].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 10) + (ids++).toString(36)
}

/** Planes of a w × h region (0..max) into a tile set of `f`, empty tiles left out. */
function planesToSet(f: TileFormat, w: number, h: number, planes: PsdSamples[], alpha: PsdSamples | null, max: number): string | null {
  const outMax = f.depth === 16 ? 65535 : 255
  const n = COLOUR_CHANNELS[f.mode]
  const scale = outMax / max
  const entries: [number, number, TileId][] = []
  for (let ty = 0; ty < Math.ceil(h / TILE); ty++)
    for (let tx = 0; tx < Math.ceil(w / TILE); tx++) {
      const s = newSamples(f)
      let any = false
      const tw = Math.min(TILE, w - tx * TILE)
      const th = Math.min(TILE, h - ty * TILE)
      for (let y = 0; y < th; y++)
        for (let x = 0; x < tw; x++) {
          const src = (ty * TILE + y) * w + tx * TILE + x
          const p = y * TILE + x
          const a = alpha ? Math.round(alpha[src] * scale) : outMax
          if (a) any = true
          s[n * TILE_PIXELS + p] = a
          for (let c = 0; c < n; c++) s[c * TILE_PIXELS + p] = Math.round((planes[c]?.[src] ?? 0) * scale)
        }
      if (any) entries.push([tx, ty, store.data(f, s)])
    }
  if (!entries.length) return null
  const id = store.createSet(f, entries)
  hold(id)
  return id
}

export async function openPsd(bytes: Uint8Array, name: string, working: Record<ColourMode, ProfileRef>, intent: Intent = 'relative', bpc = true): Promise<PsdOpened> {
  const { cms, registry } = await colour()
  const converter = new Converter(registry)
  const profiles: { hash: string; bytes: Uint8Array }[] = []

  const open = async (data: Uint8Array, fileName: string, into: { mode: ColourMode; depth: Depth; profile: ProfileRef } | null): Promise<{ doc: Doc; warnings: string[]; fonts: string[] }> => {
    const f = await readPsd(data)
    // The embedded profile, registered before anything is converted through it.
    const icc = f.resources.find((r) => r.id === 1039)?.data ?? null
    let iccRef: ProfileRef | null = null
    if (icc) {
      try {
        const p = cms.openProfile(icc)
        p.close()
        const hash = await sha256(icc)
        addProfile(hash, icc)
        profiles.push({ hash, bytes: icc })
        iccRef = { asset: hash }
      } catch {
        iccRef = null
      }
    }
    const nested: string[] = []
    const fonts: string[] = []
    let docProfile: ProfileRef = working.rgb
    const host: PsdHost = {
      pixels: (mode, depth, w, h, planes, alpha, max) => planesToSet({ mode, depth }, w, h, planes, alpha, max),
      mask: (w, h, plane, max) => planesToSet({ mode: 'gray', depth: 8 }, w, h, [plane], null, max),
      colour: (v) => converter.convert(v, { space: docMode, profile: docProfile }, intent, bpc).c,
      labToRgb: (L, a, b, max) => {
        const n = L.length
        const lab = new Float32Array(n * 3)
        const half = max === 1 ? 0.5 : (max + 1) / 2
        for (let i = 0; i < n; i++) {
          lab[i * 3] = (L[i] / max) * 100
          lab[i * 3 + 1] = ((a[i] - half) / (max === 1 ? 1 : half)) * 128
          lab[i * 3 + 2] = ((b[i] - half) / (max === 1 ? 1 : half)) * 128
        }
        const t = cms.transform(registry.lab(), registry.resolve(working.rgb, 'rgb').profile, intent, bpc ? 0x2000 : 0)
        try {
          const rgb = t.run(lab, n)
          return [0, 1, 2].map((c) => Float32Array.from({ length: n }, (_, i) => rgb[i * 3 + c]))
        } finally {
          t.close()
        }
      },
      open: async (inner, innerName, target) => {
        try {
          const r = await openNested(inner, innerName, target)
          nested.push(...r.warnings)
          fonts.push(...r.fonts)
          return r.doc
        } catch (e) {
          nested.push(`A smart object’s contents (“${innerName}”) couldn’t be opened: ${e instanceof Error ? e.message : String(e)}`)
          return null
        }
      },
      profile: (_icc, mode) => {
        docProfile = iccRef ?? working[mode]
        return docProfile
      },
      working,
      newId,
    }
    // The document's mode, as toDoc will decide it, so colours convert into it.
    let docMode: ColourMode = f.mode === 4 ? 'cmyk' : f.mode === 3 || f.mode === 2 || f.mode === 9 ? 'rgb' : 'gray'
    docProfile = f.mode === 2 || f.mode === 9 ? working.rgb : (iccRef ?? working[docMode])
    const r = await psdToDoc(f, host)
    docMode = r.doc.mode
    let doc = { ...r.doc, name: fileName.replace(/\.ps[db]$/i, '') }
    const warnings = [...r.warnings, ...nested]
    if (into && (doc.mode !== into.mode || doc.depth !== into.depth || JSON.stringify(doc.profile) !== JSON.stringify(into.profile))) doc = await convertInto(doc, into)
    return { doc, warnings, fonts: [...r.fonts, ...fonts] }
  }

  /** A smart object's file: a PSD or PSB as a document, an image as a document of one layer, in the parent's terms. */
  const openNested = async (data: Uint8Array, fileName: string, into: { mode: ColourMode; depth: Depth; profile: ProfileRef }): Promise<{ doc: Doc; warnings: string[]; fonts: string[] }> => {
    if (data[0] === 0x38 && data[1] === 0x42 && data[2] === 0x50 && data[3] === 0x53) return open(data, fileName, into)
    const raster = await decodeImage(data, fileName, decodeJpeg)
    const defaultId = raster.mode === 'gray' ? 'gray-gamma-2.2' : raster.mode === 'cmyk' ? 'generic-cmyk' : 'srgb'
    const from = raster.icc ? cms.openProfile(raster.icc) : registry.builtin(defaultId)
    const to = registry.resolve(into.profile, into.mode).profile
    const t = cms.transform(from, to, intent, bpc ? 0x2000 : 0)
    let set: string
    try {
      set = rasterToSet(store, raster, { mode: into.mode, depth: into.depth }, (c, n) => t.run(c, n))
    } finally {
      t.close()
      if (raster.icc) from.close()
    }
    hold(set)
    const rootId = newId('r')
    const px = makeNode('pixel', newId('p'), fileName.replace(/\.[a-z0-9]+$/i, ''), { tiles: set, resample: 'bicubic' })
    const root = makeNode('group', rootId, 'Root')
    root.children = [px.id]
    const doc: Doc = { name: fileName, width: raster.width, height: raster.height, resolution: 72, mode: into.mode, depth: into.depth, profile: into.profile, root: rootId, nodes: { [rootId]: root, [px.id]: px }, guides: [], selection: null }
    return { doc, warnings: raster.warnings, fonts: [] }
  }

  /** A nested document converted into its parent's mode, depth and profile, pixels and colours. */
  const convertInto = async (doc: Doc, into: { mode: ColourMode; depth: Depth; profile: ProfileRef }): Promise<Doc> => {
    const fromP = registry.resolve(doc.profile, doc.mode).profile
    const toP = registry.resolve(into.profile, into.mode).profile
    const same = doc.mode === into.mode && JSON.stringify(doc.profile) === JSON.stringify(into.profile)
    const lut = same ? null : buildConvertLut(cms, fromP, toP, intent, bpc)
    const map = new Map<string, string>()
    for (const id of pixelSets(doc)) {
      const next = await convertSet(store, id, { mode: into.mode, depth: into.depth }, lut ? (c, n) => runConvertLut(lut, c, n) : null)
      hold(next)
      map.set(id, next)
    }
    const t = same ? null : cms.transform(fromP, toP, intent, bpc ? 0x2000 : 0)
    try {
      return convertDocColours(doc, { mode: into.mode, profile: into.profile, depth: into.depth }, (c) => (t ? t.one(c).map((v) => Math.min(1, Math.max(0, v))) : c), map)
    } finally {
      t?.close()
    }
  }

  const r = await open(bytes, name, null)
  return { ...r, warnings: [...new Set(r.warnings)], fonts: [...new Set(r.fonts)], profiles }
}
