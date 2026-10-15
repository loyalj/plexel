/**
 * The sampling brushes, Smudge and the Mixer Brush, as plain TypeScript:
 * the reference their GPU kernels (shaders/sample.ts) are held to.
 *
 * The brush carries paint: a patch PATCH × PATCH texels across the tip's
 * square, premultiplied working-space colour and alpha. Each dab, in order:
 *
 * 1. picks up what's under it: the layer, with this stroke so far laid on,
 *    read bilinearly at each patch texel's place in the layer;
 * 2. changes what the brush carries:
 *    - Smudge: carried ← s·carried + (1 − s)·canvas, s the strength (times
 *      the dab's opacity, which pressure can control). The first dab picks
 *      up the canvas as it is, or with Finger Painting starts with the
 *      foreground colour.
 *    - Mixer: the canvas paint on the brush moves towards what's under it
 *      by its wetness times MIXER_PICK, and the reservoir's paint towards
 *      that by the mix as well (the brush gets dirty, as Photoshop's does,
 *      until it's cleaned or loaded again); the reservoir (loaded with the foreground colour,
 *      or clean) dries by its load: amount ← amount·(1 − (1 − load)·0.05·flow);
 * 3. puts paint down where the tip covers, as a replacing stroke (the layer
 *    goes towards the paint, alpha included, so smudging transparency into
 *    paint thins it): Smudge puts down what it carries; the Mixer puts down
 *    one paint mixed from its canvas paint (by mix and wetness) and the
 *    reservoir's (by the rest of the mix and what's left in the reservoir).
 *
 * A stroke pixel of a sampling stroke is its coverage `k`, then the paint
 * the layer goes towards, premultiplied, then that paint's alpha; dabs
 * combine as successive replacements do:
 *
 *   k' = k + k_d − k·k_d,   T' = (T·k·(1 − k_d) + T_d·k_d) / k'
 */
import { dabMask, type DabStyle, type LayerDab } from '../../brush/dab'
import { TILE } from '../../tiles/format'
import type { Px } from './composite'
import { onCanvas, type CanvasClip } from './paint'

/** The carried paint's size, a side. */
export const PATCH = 64

/**
 * How far the Mixer's canvas paint moves towards what's under it each dab,
 * fully wet: the brush keeps most of what it had, so paint picked up is
 * carried on and streaks; the wetter, the more it picks up.
 */
export const MIXER_PICK = 0.25

/** How far the Mixer's reservoir goes towards the canvas paint on the brush each dab: by wetness and mix. */
const mixerDirt = (tool: SampleTool, d: LayerDab) => tool.wet * d.wet * tool.mix * d.mix * MIXER_PICK

export interface SampleTool {
  kind: 'smudge' | 'mixer'
  strength: number
  fingerPainting: boolean
  wet: number
  load: number
  mix: number
}

/** What the brush carries: paint per patch texel (n + 1 floats each), and for the Mixer its reservoir and how full it is. */
export interface BrushLoad {
  channels: number
  carried: Float32Array
  reservoir: Float32Array
  amount: number
  /** Whether a dab has picked anything up yet this stroke. */
  started: boolean
}

export function newLoad(channels: number, reservoir: Px | null): BrushLoad {
  const s = channels + 1
  const carried = new Float32Array(PATCH * PATCH * s)
  const res = new Float32Array(PATCH * PATCH * s)
  if (reservoir) for (let i = 0; i < PATCH * PATCH; i++) res.set([...reservoir.c.slice(0, channels), reservoir.a], i * s)
  return { channels, carried, reservoir: res, amount: reservoir ? 1 : 0, started: false }
}

/** A layer pixel's paint as it is now, premultiplied working values: the layer with the stroke so far. */
export type CanvasReader = (ix: number, iy: number) => Px

/** The canvas at a layer point, bilinearly between pixel centres. */
function canvasAt(read: CanvasReader, px: number, py: number, n: number): Px {
  const fx = px - 0.5
  const fy = py - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const c = new Array(n).fill(0)
  let a = 0
  const add = (x: number, y: number, w: number) => {
    if (w === 0) return
    const p = read(x, y)
    for (let i = 0; i < n; i++) c[i] += p.c[i] * w
    a += p.a * w
  }
  add(x0, y0, (1 - tx) * (1 - ty))
  add(x0 + 1, y0, tx * (1 - ty))
  add(x0, y0 + 1, (1 - tx) * ty)
  add(x0 + 1, y0 + 1, tx * ty)
  return { c, a }
}

/** Where patch texel (i, j) falls in the layer, for dab `d`: the tip's square mapped back through A⁻¹. */
function patchPoint(d: LayerDab, i: number, j: number): [number, number] {
  const ux = ((i + 0.5) / PATCH) * 2 - 1
  const uy = ((j + 0.5) / PATCH) * 2 - 1
  const det = d.a[0] * d.a[3] - d.a[1] * d.a[2] || 1e-12
  return [d.cx + (d.a[3] * ux - d.a[1] * uy) / det, d.cy + (-d.a[2] * ux + d.a[0] * uy) / det]
}

/** Steps 1 and 2: what the brush carries after picking up under dab `d`. `fg` is the foreground, premultiplied, for Finger Painting. */
export function pickUp(load: BrushLoad, d: LayerDab, tool: SampleTool, read: CanvasReader, fg: Px) {
  const n = load.channels
  const s = n + 1
  const first = !load.started
  load.started = true
  for (let j = 0; j < PATCH; j++)
    for (let i = 0; i < PATCH; i++) {
      const [px, py] = patchPoint(d, i, j)
      const C = canvasAt(read, px, py, n)
      const o = (j * PATCH + i) * s
      const cv = load.carried
      if (tool.kind === 'smudge') {
        if (first) {
          const from = tool.fingerPainting ? fg : C
          for (let c = 0; c < n; c++) cv[o + c] = from.c[c]
          cv[o + n] = from.a
        } else {
          const k = tool.strength * d.opacity
          for (let c = 0; c < n; c++) cv[o + c] = cv[o + c] * k + C.c[c] * (1 - k)
          cv[o + n] = cv[o + n] * k + C.a * (1 - k)
        }
      } else {
        const w = first ? 1 : tool.wet * d.wet * MIXER_PICK
        const dirty = mixerDirt(tool, d)
        const res = load.reservoir
        for (let c = 0; c <= n; c++) {
          cv[o + c] += ((c < n ? C.c[c] : C.a) - cv[o + c]) * w
          res[o + c] += (cv[o + c] - res[o + c]) * dirty
        }
      }
    }
}

/** The Mixer's reservoir after a dab has put paint down. */
export function drain(load: BrushLoad, d: LayerDab, tool: SampleTool) {
  load.amount *= 1 - (1 - tool.load) * 0.05 * d.flow
}

/** A patch read bilinearly at tip-space point u, clamped at its edges: n + 1 floats. */
function patchAt(p: Float32Array, s: number, ux: number, uy: number): number[] {
  const fx = Math.min(PATCH - 1, Math.max(0, ((ux + 1) / 2) * PATCH - 0.5))
  const fy = Math.min(PATCH - 1, Math.max(0, ((uy + 1) / 2) * PATCH - 0.5))
  const x0 = Math.min(PATCH - 2, Math.floor(fx))
  const y0 = Math.min(PATCH - 2, Math.floor(fy))
  const tx = fx - x0
  const ty = fy - y0
  const out = new Array(s).fill(0)
  for (let c = 0; c < s; c++) {
    const at = (x: number, y: number) => p[(y * PATCH + x) * s + c]
    out[c] = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
  }
  return out
}

/** A sampling stroke tile: k, the paint premultiplied (n), its alpha; per pixel. */
export interface SampleTile {
  n: number
  v: Float32Array
}

export const newSampleTile = (n: number): SampleTile => ({ n, v: new Float32Array(TILE * TILE * (n + 2)) })

/** One dab's paint and coverage at a layer pixel: what it would replace the canvas with, and by how much. */
function dabPaint(load: BrushLoad, d: LayerDab, tool: SampleTool, px: number, py: number, style: DabStyle): { T: number[]; k: number } | null {
  const m = dabMask(d, px, py, style)
  if (m <= 0) return null
  const ox = px - d.cx
  const oy = py - d.cy
  const ux = d.a[0] * ox + d.a[1] * oy
  const uy = d.a[2] * ox + d.a[3] * oy
  const n = load.channels
  const s = n + 1
  const B = patchAt(load.carried, s, ux, uy)
  if (tool.kind === 'smudge') return { T: B, k: m * d.flow }
  // The Mixer puts down one paint: the canvas paint on the brush by mix and wetness, the reservoir's (opaque,
  // in its own colour) by the rest of the mix and what's left in it; as much of it as those shares add up to.
  // Laid on again and again, a pixel goes towards that mixture, not towards whichever is laid last.
  const R = patchAt(load.reservoir, s, ux, uy)
  const cs = tool.mix * d.mix * tool.wet * d.wet
  const rs = (1 - tool.mix * d.mix) * R[n] * load.amount
  const share = cs + rs
  const k = m * d.flow * share
  if (k <= 0) return null
  const R1 = R.slice(0, n).map((v) => (R[n] > 0 ? v / R[n] : 0))
  const T = new Array(s)
  for (let c = 0; c < n; c++) T[c] = (B[c] * cs + R1[c] * rs) / share
  T[n] = (B[n] * cs + rs) / share
  return { T, k }
}

/** Step 3: dab `d`'s paint put down in the tile at layer tile (tx, ty). */
export function deposit(tile: SampleTile, tx: number, ty: number, load: BrushLoad, d: LayerDab, tool: SampleTool, clip: CanvasClip, style: DabStyle) {
  const n = tile.n
  const s = n + 2
  for (let y = 0; y < TILE; y++) {
    const py = ty * TILE + y + 0.5
    if (py < d.box[1] || py > d.box[3]) continue
    for (let x = 0; x < TILE; x++) {
      const px = tx * TILE + x + 0.5
      if (px < d.box[0] || px > d.box[2] || !onCanvas(clip, px, py)) continue
      const got = dabPaint(load, d, tool, px, py, style)
      if (!got || got.k <= 0) continue
      const o = (y * TILE + x) * s
      const k = tile.v[o]
      // k + k_d − k·k_d: the same as 1 − (1 − k)(1 − k_d), without a tiny k_d cancelling to nothing.
      const k2 = k + got.k - k * got.k
      for (let c = 0; c <= n; c++) tile.v[o + 1 + c] = (tile.v[o + 1 + c] * k * (1 - got.k) + got.T[c] * got.k) / k2
      tile.v[o] = k2
    }
  }
}

/** A layer pixel with a sampling stroke's tile pixel laid on: ref/paint.ts applyReplace, from the tile's numbers. */
export function withSample(L: Px, tile: SampleTile, i: number): Px {
  const n = tile.n
  const o = i * (n + 2)
  const k = tile.v[o]
  if (k <= 0) return L
  const T: Px = { c: Array.from(tile.v.subarray(o + 1, o + 1 + n)), a: tile.v[o + 1 + n] }
  return { c: L.c.map((v, c) => v + (T.c[c] - v) * k), a: L.a + (T.a - L.a) * k }
}
