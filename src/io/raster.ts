/**
 * A decoded image, whatever file it came from, and turning one into tiles.
 *
 * Every decoder (png.ts, tiff.ts, and the browser for JPEG's and WebP's pixels) hands
 * back a Raster: interleaved samples in the image's own mode and depth,
 * alpha last, with its ICC profile if it had one. `rasterToSet` then puts
 * it into the tile store in a document's format, converting depth and,
 * through a colour transform the caller supplies, colour.
 */
import type { ColourMode, Depth } from '../doc/types'
import { COLOUR_CHANNELS, TILE, TILE_PIXELS, newSamples, type TileFormat } from '../tiles/format'
import type { SetId, TileId, TileStore } from '../tiles/store'
import { decodePng, isPng } from './png'
import { decodeTiff, isTiff } from './tiff'
import { isJpeg } from './jpeg'
import { isWebp } from './webp'

export interface Raster {
  width: number
  height: number
  mode: ColourMode
  depth: Depth
  /** Interleaved: the colour channels, then alpha. */
  data: Uint8Array | Uint16Array
  icc: Uint8Array | null
  /** The file said sRGB outright (PNG's sRGB chunk) rather than with a profile. */
  srgb?: boolean
  warnings: string[]
}

export type ImageKind = 'png' | 'jpeg' | 'tiff' | 'webp'

/** The image file types Plexel opens, for pickers and drops. */
export const IMAGE_TYPES: Record<ImageKind, { mime: string; extensions: string[] }> = {
  png: { mime: 'image/png', extensions: ['.png'] },
  jpeg: { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg', '.jpe'] },
  tiff: { mime: 'image/tiff', extensions: ['.tif', '.tiff'] },
  webp: { mime: 'image/webp', extensions: ['.webp'] },
}

/** What a file is, from its first bytes; the name is only a fallback. */
export function sniff(bytes: Uint8Array, name = ''): ImageKind | null {
  if (isPng(bytes)) return 'png'
  if (isJpeg(bytes)) return 'jpeg'
  if (isTiff(bytes)) return 'tiff'
  if (isWebp(bytes)) return 'webp'
  const lower = name.toLowerCase()
  for (const [k, t] of Object.entries(IMAGE_TYPES)) if (t.extensions.some((e) => lower.endsWith(e))) return k as ImageKind
  return null
}

export const isImageName = (name: string) => Object.values(IMAGE_TYPES).some((t) => t.extensions.some((e) => name.toLowerCase().endsWith(e)))

/** The decoders that need the browser: JPEG's (except CMYK) and WebP's. */
export interface BrowserDecoders {
  jpeg(bytes: Uint8Array): Promise<Raster>
  webp(bytes: Uint8Array): Promise<Raster>
}

export async function decodeImage(bytes: Uint8Array, name: string, browser: BrowserDecoders): Promise<Raster> {
  const kind = sniff(bytes, name)
  if (kind === 'png') return decodePng(bytes)
  if (kind === 'tiff') return decodeTiff(bytes)
  if (kind === 'jpeg') return browser.jpeg(bytes)
  if (kind === 'webp') return browser.webp(bytes)
  throw new Error('This isn’t an image Plexel can open: PNG, JPEG, WebP and TIFF are.')
}

/** Turns a batch of colours from one space into another: `count` colours in, channel after channel. */
export type Convert = (colours: Float32Array, count: number) => Float32Array

/**
 * The image as a tile set in `f`, at (0, 0). `convert` changes colours
 * (and their number of channels) on the way, when the image's profile or
 * mode isn't the document's; without it the colour numbers are kept and
 * only the depth changes. Tiles with nothing in them aren't stored.
 */
export function rasterToSet(store: TileStore, r: Raster, f: TileFormat, convert?: Convert): SetId {
  const inCh = COLOUR_CHANNELS[r.mode]
  const outCh = COLOUR_CHANNELS[f.mode]
  if (!convert && inCh !== outCh) throw new Error('An image in another colour mode needs converting')
  const inStride = inCh + 1
  const inMax = r.depth === 16 ? 65535 : 255
  const outMax = f.depth === 16 ? 65535 : 255
  const entries: [number, number, TileId][] = []
  const colours = new Float32Array(TILE_PIXELS * inCh)
  for (let ty = 0; ty < Math.ceil(r.height / TILE); ty++) {
    for (let tx = 0; tx < Math.ceil(r.width / TILE); tx++) {
      const s = newSamples(f)
      const alphaPlane = outCh * TILE_PIXELS
      let any = false
      const w = Math.min(TILE, r.width - tx * TILE)
      const h = Math.min(TILE, r.height - ty * TILE)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const src = ((ty * TILE + y) * r.width + tx * TILE + x) * inStride
          const p = y * TILE + x
          const a = r.data[src + inCh]
          if (a) any = true
          s[alphaPlane + p] = inMax === outMax ? a : Math.round((a * outMax) / inMax)
          if (convert) for (let c = 0; c < inCh; c++) colours[p * inCh + c] = r.data[src + c] / inMax
          else for (let c = 0; c < inCh; c++) s[c * TILE_PIXELS + p] = inMax === outMax ? r.data[src + c] : Math.round((r.data[src + c] * outMax) / inMax)
        }
      }
      if (!any) continue
      if (convert) {
        const out = convert(colours, TILE_PIXELS)
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const p = y * TILE + x
            for (let c = 0; c < outCh; c++) s[c * TILE_PIXELS + p] = Math.round(Math.min(1, Math.max(0, out[p * outCh + c])) * outMax)
          }
        }
      }
      entries.push([tx, ty, store.data(f, s)])
    }
  }
  return store.createSet(f, entries)
}
