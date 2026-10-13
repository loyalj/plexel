/**
 * How pixels are laid out in a tile.
 *
 * A tile is 256 × 256 pixels, stored planar: every channel is its own
 * plane, one after another, so a CMYK tile is five planes (C, M, Y, K and
 * alpha) and the GPU can pack them into textures of up to four channels.
 * 8-bit tiles hold Uint8 samples, 16-bit tiles Uint16, little-endian in
 * files.
 *
 * Samples are in the document's own terms: RGB light, Gray light (0 is
 * black), CMYK ink (0 is no ink), and alpha last, not premultiplied, the
 * way PSD keeps them. Compositing turns them into premultiplied floats on
 * the GPU.
 */
import type { ColourMode, Depth } from '../doc/types'

export const TILE = 256
export const TILE_PIXELS = TILE * TILE

export interface TileFormat {
  mode: ColourMode
  depth: Depth
}

/** Colour channels, without alpha. */
export const COLOUR_CHANNELS: Record<ColourMode, number> = { rgb: 3, gray: 1, cmyk: 4 }

/** Every plane in a tile: the colour channels and alpha. */
export const planesOf = (f: TileFormat) => COLOUR_CHANNELS[f.mode] + 1

export const maxSample = (f: TileFormat) => (f.depth === 16 ? 65535 : 255)

export const tileSamples = (f: TileFormat) => TILE_PIXELS * planesOf(f)

export const tileBytes = (f: TileFormat) => tileSamples(f) * (f.depth / 8)

export const formatKey = (f: TileFormat) => `${f.mode}/${f.depth}`

export const sameFormat = (a: TileFormat, b: TileFormat) => a.mode === b.mode && a.depth === b.depth

export type Samples = Uint8Array | Uint16Array

export function newSamples(f: TileFormat): Samples {
  return f.depth === 16 ? new Uint16Array(tileSamples(f)) : new Uint8Array(tileSamples(f))
}

/** The tile coordinates that cover a canvas, as [x, y] pairs. */
export function tilesCovering(width: number, height: number): [number, number][] {
  const out: [number, number][] = []
  for (let y = 0; y < Math.ceil(height / TILE); y++) for (let x = 0; x < Math.ceil(width / TILE); x++) out.push([x, y])
  return out
}

/**
 * A pixel's value with alpha, from colour channels 0..1 and an opacity
 * 0..1, quantised to the format's samples.
 */
export function quantise(f: TileFormat, colour: number[], alpha = 1): number[] {
  const max = maxSample(f)
  return [...colour, alpha].map((v) => Math.round(Math.min(1, Math.max(0, v)) * max))
}

/** Samples back to 0..1, colour channels first and alpha last. */
export const unquantise = (f: TileFormat, value: number[]) => value.map((v) => v / maxSample(f))
