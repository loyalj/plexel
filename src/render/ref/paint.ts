/**
 * Painting, as plain TypeScript: the reference the GPU's stroke kernels are
 * held to (check-gpu), and what check-brush holds to Photoshop's behaviour.
 *
 * A stroke is drawn into a stroke buffer first, never straight into the
 * layer: each pixel keeps how much the stroke covers it, and, for a stroke
 * whose colour varies, its colour. Dabs build that coverage up the way
 * Photoshop's flow and opacity do:
 *
 *   a' = a + (O − a)·flow·mask     while a < O
 *
 * so overlapping dabs at a low flow build up gradually, but a single stroke
 * never covers more than its opacity O, however often it crosses itself.
 * Only when the stroke is laid onto the layer does it blend, once, with the
 * brush's mode (or, for the eraser, take alpha away).
 *
 * A stroke pixel is `layout.stride` floats: the coverage the layer gets
 * first; then, when the stroke as a whole is textured or has a dual brush,
 * the main tip's own coverage (`raw`) and the dual brush's (`dual`), from
 * which the first is worked out again after every stamp; then the colour.
 *
 * Pixels outside the canvas aren't painted: a stroke stops at the edge of
 * the document, as Photoshop's does.
 */
import type { BlendModeId } from '../../doc/types'
import type { BrushSettings } from '../../brush/defs'
import { dabMask, type DabStyle, type LayerDab } from '../../brush/dab'
import { TEXTURE_MODE_INDEX, adjustTexture, sampleTexture, textureImage, textured, type TextureImage } from '../../brush/textures'
import { TILE, TILE_PIXELS } from '../../tiles/format'
import { over, type Px } from './composite'

/** What a stroke pixel holds, and where. */
export interface StrokeLayout {
  /** The main tip's coverage kept apart from what the layer gets (a stroke-wide texture, or a dual brush). */
  raw: boolean
  dual: boolean
  /** Colour channels kept per pixel, or 0. */
  channels: number
}

export const strokeStride = (l: StrokeLayout) => 1 + (l.raw ? 1 : 0) + (l.dual ? 1 : 0) + l.channels
const rawOffset = (l: StrokeLayout) => (l.raw ? 1 : 0)
const dualOffset = (l: StrokeLayout) => 1 + (l.raw ? 1 : 0)
export const colourOffset = (l: StrokeLayout) => 1 + (l.raw ? 1 : 0) + (l.dual ? 1 : 0)

/** A stroke's texture, as stamping reads it. */
export interface StampTexture {
  image: TextureImage
  scale: number
  brightness: number
  contrast: number
  invert: boolean
  /** TEXTURE_MODE_INDEX. */
  mode: number
  depth: number
  eachTip: boolean
}

/** Everything about a stroke that stamping needs beyond its dabs. */
export interface StampStyle extends DabStyle {
  texture: StampTexture | null
  /** The dual brush's mode, as a TEXTURE_MODE_INDEX, or −1 for none. */
  dualMode: number
}

const PLAIN_STYLE: StampStyle = { noise: false, wetEdges: false, texture: null, dualMode: -1 }

/** TEXTURE_MODE_INDEX for each dual mode: the dual brush combines with the same formulas. */
export const DUAL_INDEX: Record<string, number> = { multiply: 0, darken: 2, overlay: 3, 'color-dodge': 4, 'color-burn': 5, 'linear-burn': 6, 'hard-mix': 7, 'linear-height': 8 }

/** What a brush's stroke pixels hold, given whether its colour varies and the mode's colour channels. */
export const layoutOf = (b: BrushSettings, varies: boolean, channels: number): StrokeLayout => ({ raw: (!!b.texture && !b.texture.eachTip) || !!b.dual, dual: !!b.dual, channels: varies ? channels : 0 })

/** How a brush's dabs stamp: its Noise, Wet Edges, texture and dual brush. */
export function styleOf(b: BrushSettings): StampStyle {
  const img = b.texture ? (textureImage(b.texture.id) ?? textureImage('paper')) : null
  const t = b.texture
  return {
    noise: b.noise,
    wetEdges: b.wetEdges,
    texture: t && img ? { image: img, scale: t.scale, brightness: t.brightness, contrast: t.contrast, invert: t.invert, mode: TEXTURE_MODE_INDEX[t.mode], depth: t.depth, eachTip: t.eachTip } : null,
    dualMode: b.dual ? DUAL_INDEX[b.dual.mode] : -1,
  }
}

export interface StrokeTile {
  layout: StrokeLayout
  /** `stride` floats a pixel. */
  v: Float32Array
}

export const newStrokeTile = (layout: StrokeLayout): StrokeTile => ({ layout, v: new Float32Array(TILE_PIXELS * strokeStride(layout)) })

/** The coverage the layer gets at a pixel. */
export const coverageAt = (t: StrokeTile, i: number) => t.v[i * strokeStride(t.layout)]
/** The colour kept at a pixel. */
export const colourAt = (t: StrokeTile, i: number) => {
  const s = strokeStride(t.layout)
  const o = i * s + colourOffset(t.layout)
  return Array.from(t.v.subarray(o, o + t.layout.channels))
}

/** Where the canvas is, seen from the layer: its transform (layer → document) and the document's size. */
export interface CanvasClip {
  t: number[]
  width: number
  height: number
}

/** Whether the layer pixel whose centre is (px, py) is on the canvas. */
export function onCanvas(clip: CanvasClip, px: number, py: number) {
  const t = clip.t
  const x = t[0] * px + t[2] * py + t[4]
  const y = t[1] * px + t[3] * py + t[5]
  return x >= 0 && y >= 0 && x < clip.width && y < clip.height
}

/** The texture's value under a layer pixel, adjusted: it sits on the document, wherever the layer is. */
function textureAt(tex: StampTexture, clip: CanvasClip, px: number, py: number): number {
  const t = clip.t
  const x = t[0] * px + t[2] * py + t[4]
  const y = t[1] * px + t[3] * py + t[5]
  return adjustTexture(sampleTexture(tex.image, x, y, tex.scale), tex)
}

/**
 * Stamps dabs, in order, into the stroke tile at layer tile (tx, ty).
 * `colours` gives each dab's straight working-space colour when the stroke
 * keeps colour per pixel.
 */
export function stamp(tile: StrokeTile, tx: number, ty: number, dabs: LayerDab[], colours: number[][] | null, clip: CanvasClip, style: StampStyle = PLAIN_STYLE) {
  const l = tile.layout
  const s = strokeStride(l)
  const n = l.channels
  const ro = rawOffset(l)
  const dof = dualOffset(l)
  const co = colourOffset(l)
  const tex = style.texture
  for (let y = 0; y < TILE; y++) {
    const py = ty * TILE + y + 0.5
    for (let x = 0; x < TILE; x++) {
      const px = tx * TILE + x + 0.5
      if (!onCanvas(clip, px, py)) continue
      const i = (y * TILE + x) * s
      const t = tex ? textureAt(tex, clip, px, py) : 1
      let touched = false
      dabs.forEach((d, k) => {
        if (px < d.box[0] || py < d.box[1] || px > d.box[2] || py > d.box[3]) return
        let m = dabMask(d, px, py, style)
        if (m <= 0) return
        if (d.dual) {
          // The dual brush only marks where the stroke may show: its coverage builds up on its own.
          if (l.dual) tile.v[i + dof] += (1 - tile.v[i + dof]) * m
          touched = true
          return
        }
        if (tex?.eachTip) m = textured(m, t, d.texDepth, tex.mode)
        const w = d.flow * m
        if (w <= 0) return
        const a = tile.v[i + ro]
        if (a >= d.opacity) return
        const a2 = a + (d.opacity - a) * w
        if (n && colours) {
          const share = (a2 - a) / a2
          for (let c = 0; c < n; c++) tile.v[i + co + c] += (colours[k][c] - tile.v[i + co + c]) * share
        }
        tile.v[i + ro] = a2
        touched = true
      })
      if (touched && l.raw) {
        // What the layer gets: the main coverage through the dual brush, then the paper.
        let f = tile.v[i + 1]
        if (l.dual && style.dualMode >= 0) f = textured(f, tile.v[i + dof], 1, style.dualMode)
        if (tex && !tex.eachTip) f = textured(f, t, tex.depth, tex.mode)
        tile.v[i] = f
      }
    }
  }
}

/**
 * The layer pixel `L` (premultiplied, working space) with the stroke laid
 * on: coverage `a` in straight colour `colour`, blended with `mode`; or, for
 * the eraser, `L` with `a` of its alpha taken away.
 */
export function applyStroke(L: Px, a: number, colour: number[], mode: BlendModeId, eraser: boolean, planes?: boolean[]): Px {
  if (a <= 0) return { c: [...L.c], a: L.a }
  const r = eraser ? { c: L.c.map((v) => v * (1 - a)), a: L.a * (1 - a) } : over(L, { c: colour.map((v) => v * a), a }, mode, 1)
  return planes && !planes.every(Boolean) ? keepPlanes(L, r, planes) : r
}

/**
 * Painting some colour channels (the Channels panel's target): `R`, the
 * layer pixel `L` with paint laid on, keeping `L`'s straight colour in
 * each channel not painted, and `L`'s alpha.
 */
export function keepPlanes(L: Px, R: Px, planes: boolean[]): Px {
  const straight = (p: Px, i: number) => (p.a > 0 ? p.c[i] / p.a : 0)
  return { c: L.c.map((_, i) => (planes[i] ?? true ? straight(R, i) : straight(L, i)) * L.a), a: L.a }
}

/**
 * The layer pixel `L` with a sampling stroke (Smudge, the Mixer Brush) laid
 * on: towards the stroke's own pixel `T` (premultiplied colour and alpha)
 * by `k`. Paint can be taken away as well as put down: smudging a
 * transparent area into paint thins it.
 */
export function applyReplace(L: Px, k: number, T: Px): Px {
  if (k <= 0) return { c: [...L.c], a: L.a }
  return { c: L.c.map((v, i) => v + (T.c[i] - v) * k), a: L.a + (T.a - L.a) * k }
}
