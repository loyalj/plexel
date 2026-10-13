/**
 * Images in and out, as the engine worker does them: decoding a PNG, JPEG
 * or TIFF straight into the tile store, and encoding a document's
 * composite as PNG or JPEG with its profile.
 *
 * Decoding happens here rather than on the page so the pixels go into tiles
 * where they're decoded, without crossing between threads twice.
 */
import type { Intent } from '../color/cms'
import type { ColourMode, Depth, ProfileRef } from '../doc/types'
import { decodeImage, rasterToSet, type Raster } from '../io/raster'
import { readJpegInfo, withIcc, JpegError } from '../io/jpeg'
import { decodeJpegPixels } from '../io/jpegDecode'
import { encodePng } from '../io/png'
import { COLOUR_CHANNELS } from '../tiles/format'
import type { TileStore } from '../tiles/store'
import { colour } from './colourHost'
import { sha256 } from '../io/assets'
import { compositeBands } from '../render/readback'
import type { Renderer } from '../render/renderer'

/** JPEG pixels through the browser's decoder, with no colour conversion, so the file's profile still describes them. */
export async function decodeJpeg(bytes: Uint8Array): Promise<Raster> {
  const info = readJpegInfo(bytes)
  // CMYK and YCCK: the browser would turn the inks into RGB its own way, so they're ours to decode.
  if (info.components === 4) return decodeJpegPixels(bytes)
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new JpegError('The browser couldn’t make a canvas to decode the JPEG on.')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  const gray = info.components === 1
  const n = canvas.width * canvas.height
  const data = new Uint8Array(n * (gray ? 2 : 4))
  if (gray) {
    for (let i = 0; i < n; i++) {
      data[i * 2] = rgba[i * 4]
      data[i * 2 + 1] = 255
    }
  } else data.set(rgba)
  return { width: canvas.width, height: canvas.height, mode: gray ? 'gray' : 'rgb', depth: 8, data, icc: info.icc, warnings: [] }
}

export interface ImportInto {
  mode: ColourMode
  depth: Depth
  profile: ProfileRef
  intent: Intent
  blackPointCompensation: boolean
}

export interface Imported {
  set: string
  width: number
  height: number
  mode: ColourMode
  depth: Depth
  /** The image's profile, when it had a usable one, for the page to keep as an asset. */
  icc: Uint8Array | null
  warnings: string[]
}

export async function importImage(store: TileStore, bytes: Uint8Array, name: string, into: ImportInto | null): Promise<Imported> {
  const raster = await decodeImage(bytes, name, decodeJpeg)
  const warnings = [...raster.warnings]
  const { cms, registry } = await colour()
  // The image's own profile, if it has one that fits its colours.
  let icc = raster.icc
  if (icc) {
    try {
      const p = cms.openProfile(icc)
      const fits = p.space === raster.mode
      p.close()
      if (!fits) {
        warnings.push('Its embedded profile is for a different kind of colour, so it was ignored')
        icc = null
      }
    } catch {
      warnings.push('Its embedded profile couldn’t be read, so it was ignored')
      icc = null
    }
  }
  if (!into) {
    const set = rasterToSet(store, raster, { mode: raster.mode, depth: raster.depth })
    return { set, width: raster.width, height: raster.height, mode: raster.mode, depth: raster.depth, icc, warnings }
  }
  // Into an existing document: converted from the image's profile (or its
  // mode's default) to the document's, unless they're the same.
  const from = icc ? cms.openProfile(icc) : null
  const defaultId = raster.mode === 'gray' ? 'gray-gamma-2.2' : raster.mode === 'cmyk' ? 'generic-cmyk' : 'srgb'
  const fromProfile = from ?? registry.builtin(defaultId)
  const to = registry.resolve(into.profile, into.mode)
  const same =
    raster.mode === into.mode &&
    !to.substituted &&
    (icc ? 'asset' in into.profile && (await sha256(icc)) === into.profile.asset : 'builtin' in into.profile && into.profile.builtin === defaultId)
  let set: string
  if (same) set = rasterToSet(store, raster, { mode: into.mode, depth: into.depth })
  else {
    const t = cms.transform(fromProfile, to.profile, into.intent, into.blackPointCompensation ? 0x2000 : 0)
    try {
      set = rasterToSet(store, raster, { mode: into.mode, depth: into.depth }, (c, count) => t.run(c, count))
    } finally {
      t.close()
    }
  }
  from?.close()
  return { set, width: raster.width, height: raster.height, mode: raster.mode, depth: raster.depth, icc, warnings }
}

export interface ExportOptions {
  format: 'png' | 'jpeg'
  /** JPEG quality, 0..1. */
  quality: number
}

/**
 * The document's composite as a file. PNG keeps the document's depth,
 * transparency and profile; a CMYK document becomes sRGB, which PNG needs.
 * JPEG is 8-bit RGB on white; an RGB document keeps its profile, Gray and
 * CMYK become sRGB.
 */
export async function exportImage(r: Renderer, key: string, o: ExportOptions): Promise<{ bytes: Uint8Array; mime: string; warnings: string[] }> {
  const s = r.docState(key)
  const doc = s?.scene.doc
  if (!doc) throw new Error('That document isn’t in the engine')
  const { cms, registry } = await colour()
  const warnings: string[] = []
  const keep = o.format === 'png' ? doc.mode !== 'cmyk' : doc.mode === 'rgb'
  const docProfile = registry.resolve(doc.profile, doc.mode).profile
  const outMode: 'rgb' | 'gray' = keep ? (doc.mode as 'rgb' | 'gray') : 'rgb'
  const depth: 8 | 16 = o.format === 'png' ? doc.depth : 8
  const icc = keep ? docProfile.bytes() : registry.builtin('srgb').bytes()
  if (!keep) warnings.push(`${o.format.toUpperCase()} can’t hold ${doc.mode === 'cmyk' ? 'CMYK' : 'Gray'} here, so it was converted to sRGB`)
  const convert = keep ? null : cms.transform(docProfile, registry.builtin('srgb'), 'relative', 0x2000)
  const n = COLOUR_CHANNELS[doc.mode]
  const outN = outMode === 'rgb' ? 3 : 1
  const alpha = o.format === 'png'
  const outCh = outN + (alpha ? 1 : 0)
  const max = depth === 16 ? 65535 : 255
  const white = doc.mode === 'cmyk' ? 0 : 1

  async function* rows() {
    for await (const band of compositeBands(r, key)) {
      const count = band.width * band.rows
      const colours = new Float32Array(count * n)
      const alphas = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        const a = Math.min(1, Math.max(0, band.data[i * band.stride + n]))
        alphas[i] = a
        for (let c = 0; c < n; c++) {
          const light = a > 0 ? Math.min(1, Math.max(0, band.data[i * band.stride + c] / a)) : 0
          let v = doc!.mode === 'cmyk' ? 1 - light : light
          // JPEG has no transparency: what's transparent is white paper.
          if (!alpha) v = v * a + white * (1 - a)
          colours[i * n + c] = v
        }
      }
      const out = convert ? convert.run(colours, count) : colours
      const px = depth === 16 ? new Uint16Array(count * outCh) : new Uint8Array(count * outCh)
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < outN; c++) px[i * outCh + c] = Math.round(Math.min(1, Math.max(0, out[i * outN + c])) * max)
        if (alpha) px[i * outCh + outN] = Math.round(alphas[i] * max)
      }
      yield px
    }
  }

  try {
    if (o.format === 'png') {
      const blob = await encodePng({ width: doc.width, height: doc.height, mode: outMode, depth, alpha: true, icc, iccName: keep ? docProfile.description : 'sRGB IEC61966-2.1' }, rows())
      return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', warnings }
    }
    const canvas = new OffscreenCanvas(doc.width, doc.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('The browser couldn’t make a canvas this size to encode the JPEG on. Try PNG.')
    let y = 0
    for await (const band of rows()) {
      const h = band.length / (doc.width * outCh)
      const img = new ImageData(doc.width, h)
      for (let i = 0; i < doc.width * h; i++) {
        const g = outN === 1
        img.data[i * 4] = band[i * outCh]
        img.data[i * 4 + 1] = band[i * outCh + (g ? 0 : 1)]
        img.data[i * 4 + 2] = band[i * outCh + (g ? 0 : 2)]
        img.data[i * 4 + 3] = 255
      }
      ctx.putImageData(img, 0, y)
      y += h
    }
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: o.quality })
    return { bytes: withIcc(new Uint8Array(await blob.arrayBuffer()), icc), mime: 'image/jpeg', warnings }
  } finally {
    convert?.close()
  }
}
