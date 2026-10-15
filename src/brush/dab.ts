/**
 * A dab: one stamp of the brush tip. The brush engine places dabs in
 * document pixels (stroke.ts); before stamping, each is mapped into the
 * layer's own pixel grid through the inverse of the layer's live transform,
 * so a brush works the same on a layer that's been scaled, turned or
 * skewed (ARCHITECTURE.md, "Live transforms on pixel layers").
 *
 * In the layer, a dab is an affine map `A` from layer pixels (relative to
 * its centre) into the tip's own space, where the tip fills the unit disc
 * (or, for an image tip, the square its longer side spans). Size,
 * roundness, angle, flips and the layer's transform all fold into `A`, so
 * the GPU and the CPU reference evaluate one formula whatever the shape.
 *
 * After the tip's own coverage come Noise (grain in its soft parts) and
 * Wet Edges (lighter inside, paint pooled at the edge); the paper texture
 * and the dual brush act on the stroke as it builds (render/ref/paint.ts).
 */
import { sampleTip, tipImage } from './tips'
import type { TipId } from './defs'

/** A dab as the brush engine places it, in document pixels. */
export interface Dab {
  x: number
  y: number
  /** Diameter. */
  size: number
  /** Radians. */
  angle: number
  roundness: number
  flipX: boolean
  flipY: boolean
  hardness: number
  /** The most the stroke may cover here. */
  opacity: number
  /** How much this dab adds. */
  flow: number
  /** 0 is the foreground colour, 1 the background, between a mix. */
  colour: number
  /** Hue (turns), saturation and brightness (−1..1) moved by Colour Dynamics. */
  hsb: [number, number, number]
  tip: TipId
  /** Texture depth, for a texture laid into each tip; 1 otherwise. */
  texDepth: number
  /** The Mixer Brush's wetness and mix, as shares of its settings. */
  wet: number
  mix: number
  /** A seed for this dab's Noise. */
  grain: number
  /** A Dual Brush's dab: it marks where the main stroke may show, and paints nothing itself. */
  dual: boolean
}

/** A dab in a layer's pixels, ready to stamp. */
export interface LayerDab {
  /** Centre, in layer pixels. */
  cx: number
  cy: number
  /** Layer pixels (from the centre) into tip space: u = A·(p − c). */
  a: [number, number, number, number]
  /** How wide one layer pixel is in tip space: the anti-aliasing width for a hard edge, and the level an image tip is read at. */
  aa: number
  hardness: number
  opacity: number
  flow: number
  colour: number
  hsb: [number, number, number]
  tip: TipId
  texDepth: number
  wet: number
  mix: number
  grain: number
  dual: boolean
  /** The rectangle it can touch, in layer pixels: left, top, right, bottom. */
  box: [number, number, number, number]
}

/**
 * Where a dab is stamped in a tiled document, which is a torus: first the
 * dab moved into the document by whole periods, then a copy a period away
 * for each edge its reach crosses, so a dab over an edge paints both sides.
 * Each copy is still clipped to the canvas when it's stamped, which is what
 * makes them meet without a seam. A document that doesn't repeat gets the
 * dab as it is.
 */
export function wrapDab(d: Dab, width: number, height: number, wrap: { x: boolean; y: boolean }): Dab[] {
  if (!wrap.x && !wrap.y) return [d]
  const mod = (v: number, n: number) => ((v % n) + n) % n
  const x = wrap.x ? mod(d.x, width) : d.x
  const y = wrap.y ? mod(d.y, height) : d.y
  // The unit square in tip space bounds any tip; its corner is √2 radii out, and a pixel more for anti-aliasing.
  const reach = (d.size / 2) * Math.SQRT2 + 2
  const shifts = (c: number, size: number, on: boolean) => {
    if (!on) return [0]
    const out = [0]
    for (let k = Math.floor((-reach - c) / size) + 1; k < Math.ceil((size + reach - c) / size); k++) if (k !== 0) out.push(k * size)
    return out
  }
  const out: Dab[] = []
  for (const dy of shifts(y, height, wrap.y)) for (const dx of shifts(x, width, wrap.x)) out.push(dx === 0 && dy === 0 && x === d.x && y === d.y ? d : { ...d, x: x + dx, y: y + dy })
  return out
}

/**
 * Maps a dab into a layer whose transform (layer to document) is `t`
 * ([a, b, c, d, e, f] as doc/types' Affine).
 */
export function toLayer(d: Dab, t: number[]): LayerDab {
  const det = t[0] * t[3] - t[1] * t[2] || 1e-12
  // Document point → layer point: the inverse transform.
  const ia = t[3] / det
  const ib = -t[1] / det
  const ic = -t[2] / det
  const id = t[0] / det
  const ie = (t[2] * t[5] - t[3] * t[4]) / det
  const iff = (t[1] * t[4] - t[0] * t[5]) / det
  const cx = ia * d.x + ic * d.y + ie
  const cy = ib * d.x + id * d.y + iff
  // Document offset → tip space: rotate by −angle, then divide by the radii, then flip.
  const r = Math.max(1e-6, d.size / 2)
  const cos = Math.cos(d.angle)
  const sin = Math.sin(d.angle)
  const rx = r * (d.flipX ? -1 : 1)
  const ry = Math.max(1e-6, r * d.roundness) * (d.flipY ? -1 : 1)
  // M = F·S⁻¹·R(−θ), applied to the document offset T_lin·(p − c).
  const m00 = cos / rx
  const m01 = sin / rx
  const m10 = -sin / ry
  const m11 = cos / ry
  // A = M · T_lin, where T_lin maps a layer offset to a document offset.
  const a: [number, number, number, number] = [m00 * t[0] + m01 * t[1], m00 * t[2] + m01 * t[3], m10 * t[0] + m11 * t[1], m10 * t[2] + m11 * t[3]]
  // A⁻¹ maps the unit square (it bounds the disc and any image tip) back to the layer: its rows bound the dab.
  const adet = a[0] * a[3] - a[1] * a[2] || 1e-12
  const b00 = a[3] / adet
  const b01 = -a[1] / adet
  const b10 = -a[2] / adet
  const b11 = a[0] / adet
  const hx = Math.abs(b00) + Math.abs(b01) + 1
  const hy = Math.abs(b10) + Math.abs(b11) + 1
  // The longest a layer pixel can be in tip space: the larger singular value of A.
  const s1 = a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]
  const s2 = Math.sqrt(Math.max(0, s1 * s1 - 4 * adet * adet))
  const aa = Math.sqrt((s1 + s2) / 2)
  return {
    cx,
    cy,
    a,
    aa,
    hardness: d.hardness,
    opacity: d.opacity,
    flow: d.flow,
    colour: d.colour,
    hsb: d.hsb,
    tip: d.tip,
    texDepth: d.texDepth,
    wet: d.wet,
    mix: d.mix,
    grain: d.grain,
    dual: d.dual,
    box: [cx - hx, cy - hy, cx + hx, cy + hy],
  }
}

const smoothstep = (t: number) => t * t * (3 - 2 * t)

/**
 * The round tip's coverage at distance r from the centre (1 at the edge).
 * Full inside the hard core, falling smoothly to nothing at the edge; a
 * hard tip still gets an edge one pixel wide, so it isn't jagged.
 */
export function roundMask(r: number, hardness: number, aa: number): number {
  const soft = Math.max(1 - hardness, Math.min(1, aa))
  const t = Math.min(1, Math.max(0, (1 - r) / soft))
  return smoothstep(t)
}

/** A number 0..1 from a pixel and a seed, the same here as on the GPU (u32 arithmetic). */
export function hash01(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(seed | 0, 83492791)) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  h = Math.imul(h, 0x7feb352d) >>> 0
  h = (h ^ (h >>> 15)) >>> 0
  h = Math.imul(h, 0x846ca68b) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967296
}

/** Noise: grain in a tip's soft parts, none where it's full or empty. `n` is 0..1. */
export const noisy = (m: number, n: number) => Math.min(1, Math.max(0, m + (n - 0.5) * 1.5 * (1 - Math.abs(2 * m - 1))))

/**
 * Wet Edges: the paint lighter inside the dab and pooled at its edge, as
 * watercolour dries. `edge` is how near the edge this pixel is, 0..1.
 */
const wetEdge = (m: number, edge: number) => m * (0.45 + 0.55 * edge)

/** How near a dab's edge a point in tip space is: by radius for the round tip, by coverage for an image. */
export const edgeness = (round: boolean, r: number, m: number) => (round ? smoothstep(Math.min(1, Math.max(0, (r - 0.55) / 0.45))) : Math.min(1, Math.max(0, (1 - m) * 1.6)))

export interface DabStyle {
  noise: boolean
  wetEdges: boolean
}

/** A dab's coverage at the layer pixel whose centre is (px, py), with Noise and Wet Edges. */
export function dabMask(d: LayerDab, px: number, py: number, style: DabStyle = { noise: false, wetEdges: false }): number {
  const ox = px - d.cx
  const oy = py - d.cy
  const ux = d.a[0] * ox + d.a[1] * oy
  const uy = d.a[2] * ox + d.a[3] * oy
  let m: number
  let r = 0
  const round = d.tip === 'round'
  if (round) {
    r = Math.hypot(ux, uy)
    if (r >= 1) return 0
    m = roundMask(r, d.hardness, d.aa)
  } else {
    if (Math.abs(ux) >= 1 || Math.abs(uy) >= 1) return 0
    const img = tipImage(d.tip)
    if (!img) return 0
    m = sampleTip(img, ux, uy, d.aa)
  }
  if (m <= 0) return 0
  if (style.noise) m = noisy(m, hash01(Math.floor(px), Math.floor(py), d.grain))
  if (style.wetEdges) m = wetEdge(m, edgeness(round, r, m))
  return m
}
