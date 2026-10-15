/**
 * Live filters, declared once. Each entry lists its parameters (which make
 * its dialog and its controls in Properties), how far past a pixel it reads
 * (its reach, so the render graph gathers that much of the layer around
 * each tile), and a CPU reference the GPU kernels (render/shaders/filter.ts)
 * are held to.
 *
 * Filters run on a region: premultiplied working-space pixels, `stride`
 * numbers each (colour channels then alpha), `size` a side, at a mip level.
 * Sizes in the parameters are in document pixels; at a level they're scaled
 * by 1 / 2^level, so a blur looks the same at any zoom. Outside the region
 * is transparent; the region is always gathered wide enough that this
 * never reaches the tile it's for.
 */
import { readParamValues, type ParamDef, type ParamValues } from '../doc/params'
import { gaussBoxes } from '../tiles/coverage'
import type { Box, Pt } from '../geom/path'
import { aspectOf, displace, frameBox, framed, onFrame, pinch, polar, ripple, spherize, twirl, wave, zigzag, type MapSampler } from '../geom/distort'
import { WARP_STYLES, WarpMap, decodeField, fieldAt, fieldReach, fieldStep, frameCorners, isEmptyField, isIdentityMesh, readMesh, styleMesh, type Field, type Mesh } from '../geom/warp'

export interface Region {
  size: number
  stride: number
  data: Float64Array
}

export interface FilterContext {
  /** The region's first pixel, in pixels of the level it's at: where noise comes from. */
  origin: [number, number]
  /** 2^level: document pixels per pixel here. */
  scale: number
  seed: number
}

/** A filter, its methods given its parameters' values as V (FilterDef: any filter's, as plain records). */
export interface FilterDefOf<V> {
  id: string
  label: string
  params: readonly ParamDef[]
  /** How far it reads, in pixels at the level (scale = 2^level). */
  reach(v: V, scale: number): number
  /** The reference: a new region from the old. A filter that remaps leaves the region as it is. */
  ref(img: Region, v: V, ctx: FilterContext): Region
  /**
   * A filter that moves pixels about the canvas rather than reading round
   * them (Offset): where each canvas pixel takes its colour from, in pixels
   * of a canvas `w` by `h`, or null for transparent. It can read from
   * anywhere on the canvas, so the render graph works out what it reads
   * tile by tile (graph.ts remapTile) instead of gathering a region, and
   * what it gives is the canvas only.
   */
  remap?(x: number, y: number, v: V, w: number, h: number): [number, number] | null
  /**
   * A geometric effect (Warp, Liquify): it moves the node's content about
   * rather than changing its colours, by a warp in the node's own
   * coordinates. The render graph reads each pixel from where the warp
   * says, at whatever distance (graph.ts warpTile); shapes and text with a
   * warp that maps forwards are warped as outlines, keeping their edges.
   * Null when the settings move nothing.
   */
  warp?(v: V, env?: WarpEnv): Warp | null
  /** Where it goes in the Filter menu: Blur, Distort, Noise, Pixelate, Render, Sharpen, Stylize or Other. */
  category?: string
  /** Kept on a frame (the unit square to the box of the layer's content when it was added), as Twirl and the radial distortions are. */
  framed?: boolean
  /** Left out of the Filter menu: it has a command of its own (Free Transform's Warp, Liquify). */
  hidden?: boolean
}

export type FilterDef = FilterDefOf<Record<string, unknown>>

/**
 * A filter defined with its parameters' values typed from the parameters
 * themselves (`v.radius` a number where radius is a number parameter), so
 * a renamed key or a wrong kind fails to compile. The registry holds every
 * filter as a FilterDef; the one cast is here.
 */
function defineFilter<const P extends readonly ParamDef[]>(def: Omit<FilterDefOf<ParamValues<P>>, 'params'> & { params: P }): FilterDef {
  return def as unknown as FilterDef
}

/** A geometric effect's warp, in the node's own coordinates. */
export interface Warp {
  /** Where a point drawn at (x, y) is read from, homogeneous [X, Y, W] (the point X / W, Y / W); null where nothing is drawn. */
  inverse(x: number, y: number): [number, number, number] | null
  /** Where a point of the node is drawn, when that can be said: what outlines are carried through. */
  forward?(x: number, y: number): Pt | null
  /** Where a rectangle of the node can be drawn. */
  bounds(r: Box): Box | null
  /** The finest detail the warp has, in the node's units (a Liquify field's spacing): what's read is worked out at least this finely. */
  detail?: number
  /** It jumps (Polar Coordinates' seam): where neighbouring points read from far apart, each pixel reads as its nearest does, not between. */
  seams?: boolean
}

/** Offset's edge modes: Photoshop's Undefined Areas. */
export type OffsetEdge = 'wrap' | 'repeat' | 'transparent'

/** The most a filter may read past a pixel, in pixels at the level drawn: two tiles. */
export const MAX_REACH = 512
/** The Median filter's largest radius, at the level drawn. */
export const MEDIAN_MAX = 5

const num = <K extends string>(key: K, label: string, min: number, max: number, def: number, unit: string, step = 1, hint?: string) => ({ key, kind: 'number' as const, label, min, max, step, unit, default: def, hint })

// --- passes, shared by the references --------------------------------------------------

/** A box blur of radius r along rows or columns: the mean of 2r + 1 pixels, transparent outside. */
export function boxPass(img: Region, r: number, horizontal: boolean): Region {
  if (r <= 0) return img
  const { size, stride } = img
  const out = new Float64Array(img.data.length)
  const n = 2 * r + 1
  for (let line = 0; line < size; line++) {
    for (let c = 0; c < stride; c++) {
      const at = (i: number) => (horizontal ? (line * size + i) * stride + c : (i * size + line) * stride + c)
      let sum = 0
      for (let i = 0; i <= Math.min(r, size - 1); i++) sum += img.data[at(i)]
      for (let i = 0; i < size; i++) {
        out[at(i)] = sum / n
        const add = i + r + 1
        const drop = i - r
        if (add < size) sum += img.data[at(add)]
        if (drop >= 0) sum -= img.data[at(drop)]
      }
    }
  }
  return { size, stride, data: out }
}

/** The box radii for a Gaussian of sigma s at a level; none for a sigma too small to matter. */
export const boxesFor = (sigma: number): number[] => (sigma < 0.3 ? [] : gaussBoxes(sigma))

export function gaussianRegion(img: Region, sigma: number): Region {
  let r = img
  for (const b of boxesFor(sigma)) r = boxPass(boxPass(r, b, true), b, false)
  return r
}

/** Straight colour of a pixel in a region. */
const straight = (d: Float64Array, o: number, stride: number) => {
  const a = d[o + stride - 1]
  return Array.from({ length: stride - 1 }, (_, c) => (a > 0 ? Math.min(1, Math.max(0, d[o + c] / a)) : 0))
}

/** A region where each pixel's straight colour becomes fn(colour, its index), alpha kept. */
function mapColour(img: Region, fn: (s: number[], i: number) => number[]): Region {
  const { size, stride } = img
  const out = new Float64Array(img.data.length)
  for (let i = 0; i < size * size; i++) {
    const o = i * stride
    const a = img.data[o + stride - 1]
    out[o + stride - 1] = a
    if (a <= 0) continue
    const s = fn(straight(img.data, o, stride), i)
    for (let c = 0; c < stride - 1; c++) out[o + c] = Math.min(1, Math.max(0, s[c])) * a
  }
  return { size, stride, data: out }
}

/** A hash to 0 ≤ u < 1 for a pixel, a seed and a channel: the same on the CPU and the GPU. */
export function hash01(x: number, y: number, seed: number, k: number): number {
  let v = (Math.imul(x >>> 0, 0x9e3779b1) ^ Math.imul(y >>> 0, 0x85ebca77) ^ Math.imul((seed + k * 0x632be5ab) >>> 0, 0xc2b2ae3d)) >>> 0
  v = (Math.imul(v, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((v >>> ((v >>> 28) + 4)) ^ v) >>> 0, 277803737) >>> 0
  return (((w >>> 22) ^ w) >>> 8) / 16777216
}

// --- the registry ----------------------------------------------------------------------------

export const FILTER_DEFS: FilterDef[] = [
  defineFilter({
    id: 'gaussian-blur',
    label: 'Gaussian Blur',
    params: [num('radius', 'Radius', 0.1, 250, 4, 'px', 0.1, 'How far the blur spreads: about a standard deviation.')],
    reach: (v, s) => boxesFor(v.radius / s).reduce((a, b) => a + b, 0),
    ref: (img, v, ctx) => gaussianRegion(img, v.radius / ctx.scale),
  }),
  defineFilter({
    id: 'box-blur',
    label: 'Box Blur',
    params: [num('radius', 'Radius', 1, 250, 4, 'px')],
    reach: (v, s) => Math.round(v.radius / s),
    ref(img, v, ctx) {
      const r = Math.round(v.radius / ctx.scale)
      return boxPass(boxPass(img, r, true), r, false)
    },
  }),
  defineFilter({
    id: 'unsharp-mask',
    label: 'Unsharp Mask',
    params: [num('amount', 'Amount', 1, 500, 100, '%'), num('radius', 'Radius', 0.1, 250, 2, 'px', 0.1), num('threshold', 'Threshold', 0, 255, 0, 'levels', 1, 'Edges that differ by less than this are left alone.')],
    reach: (v, s) => boxesFor(v.radius / s).reduce((a, b) => a + b, 0),
    ref(img, v, ctx) {
      const b = gaussianRegion(img, v.radius / ctx.scale)
      const amt = v.amount / 100
      const t = v.threshold / 255
      return mapColour(img, (s, i) => {
        const bs = straight(b.data, i * img.stride, img.stride)
        return s.map((x, c) => (Math.abs(x - bs[c]) < t ? x : x + amt * (x - bs[c])))
      })
    },
  }),
  defineFilter({
    id: 'high-pass',
    label: 'High Pass',
    params: [num('radius', 'Radius', 0.1, 250, 10, 'px', 0.1)],
    reach: (v, s) => boxesFor(v.radius / s).reduce((a, b) => a + b, 0),
    ref(img, v, ctx) {
      const b = gaussianRegion(img, v.radius / ctx.scale)
      return mapColour(img, (s, i) => {
        const bs = straight(b.data, i * img.stride, img.stride)
        return s.map((x, c) => 0.5 + x - bs[c])
      })
    },
  }),
  defineFilter({
    id: 'add-noise',
    label: 'Add Noise',
    params: [
      num('amount', 'Amount', 0, 100, 10, '%'),
      { key: 'distribution', kind: 'choice', label: 'Distribution', options: [['uniform', 'Uniform'], ['gaussian', 'Gaussian']], default: 'uniform' },
      { key: 'monochromatic', kind: 'bool', label: 'Monochromatic', default: false },
    ],
    reach: () => 0,
    ref(img, v, ctx) {
      const amt = v.amount / 100
      const gauss = v.distribution === 'gaussian'
      const mono = !!v.monochromatic
      return mapColour(img, (s, i) => {
        const x = ctx.origin[0] + (i % img.size)
        const y = ctx.origin[1] + Math.floor(i / img.size)
        return s.map((c, k) => c + noiseAt(x, y, ctx.seed, mono ? 0 : k, gauss) * amt)
      })
    },
  }),
  defineFilter({
    id: 'median',
    label: 'Median',
    params: [num('radius', 'Radius', 1, MEDIAN_MAX, 1, 'px', 1, 'Each pixel becomes the middle value of the square around it, channel by channel.')],
    reach: (v, s) => Math.min(MEDIAN_MAX, Math.round(v.radius / s)),
    ref(img, v, ctx) {
      const r = Math.min(MEDIAN_MAX, Math.round(v.radius / ctx.scale))
      if (r <= 0) return img
      const { size, stride } = img
      const out = new Float64Array(img.data.length)
      const vals: number[] = []
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          for (let c = 0; c < stride; c++) {
            vals.length = 0
            for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
              const qx = x + dx
              const qy = y + dy
              vals.push(qx < 0 || qy < 0 || qx >= size || qy >= size ? 0 : img.data[(qy * size + qx) * stride + c])
            }
            vals.sort((a, b) => a - b)
            out[(y * size + x) * stride + c] = vals[vals.length >> 1]
          }
        }
      }
      return { size, stride, data: out }
    },
  }),
  defineFilter({
    id: 'motion-blur',
    label: 'Motion Blur',
    params: [num('angle', 'Angle', -90, 90, 0, '°'), num('distance', 'Distance', 1, 500, 10, 'px')],
    reach: (v, s) => Math.ceil(v.distance / s / 2) + 1,
    ref(img, v, ctx) {
      const taps = motionTaps(v.angle, v.distance / ctx.scale)
      const { size, stride } = img
      const out = new Float64Array(img.data.length)
      const at = (x: number, y: number, c: number) => (x < 0 || y < 0 || x >= size || y >= size ? 0 : img.data[(y * size + x) * stride + c])
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          for (let c = 0; c < stride; c++) {
            let sum = 0
            for (const [dx, dy] of taps) {
              // Bilinear, about pixel centres.
              const px = x + dx
              const py = y + dy
              const x0 = Math.floor(px)
              const y0 = Math.floor(py)
              const fx = px - x0
              const fy = py - y0
              sum += (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) + (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy
            }
            out[(y * size + x) * stride + c] = sum / taps.length
          }
        }
      }
      return { size, stride, data: out }
    },
  }),
]

FILTER_DEFS.push(defineFilter({
  id: 'offset',
  label: 'Offset',
  params: [
    num('horizontal', 'Horizontal', -30000, 30000, 0, 'px', 1, 'How far everything moves right; left, when negative.'),
    num('vertical', 'Vertical', -30000, 30000, 0, 'px', 1, 'How far everything moves down; up, when negative.'),
    {
      key: 'edge',
      kind: 'choice',
      label: 'Undefined areas',
      options: [
        ['wrap', 'Wrap around'],
        ['repeat', 'Repeat edge pixels'],
        ['transparent', 'Set to transparent'],
      ],
      default: 'wrap',
      hint: 'What fills the gap left at the far side: what moved off the other edge, the edge pixels drawn out, or nothing.',
    },
  ],
  reach: () => 0,
  ref: (img) => img,
  remap(x, y, v, w, h) {
    const sx = x - Math.round(v.horizontal)
    const sy = y - Math.round(v.vertical)
    const edge = v.edge as OffsetEdge
    if (edge === 'wrap') return [((sx % w) + w) % w, ((sy % h) + h) % h]
    if (edge === 'repeat') return [Math.min(w - 1, Math.max(0, sx)), Math.min(h - 1, Math.max(0, sy))]
    return sx < 0 || sy < 0 || sx >= w || sy >= h ? null : [sx, sy]
  },
}))

// --- the filter pack: blurs, sharpening, stylize, pixelate, noise, render, other ---------------

const at = (img: Region, x: number, y: number, c: number) => (x < 0 || y < 0 || x >= img.size || y >= img.size ? 0 : img.data[(y * img.size + x) * img.stride + c])
const bil = (img: Region, px: number, py: number, c: number) => {
  const x0 = Math.floor(px)
  const y0 = Math.floor(py)
  const fx = px - x0
  const fy = py - y0
  return (at(img, x0, y0, c) * (1 - fx) + at(img, x0 + 1, y0, c) * fx) * (1 - fy) + (at(img, x0, y0 + 1, c) * (1 - fx) + at(img, x0 + 1, y0 + 1, c) * fx) * fy
}
/** A pixel's straight colour, 0..1 (0 where it's clear). */
const st = (img: Region, x: number, y: number, c: number) => {
  const a = at(img, x, y, img.stride - 1)
  return a > 0 ? Math.min(1, Math.max(0, at(img, x, y, c) / a)) : 0
}
/** The mean of a pixel's straight colour channels. */
const lumAt = (img: Region, x: number, y: number) => {
  const a = at(img, x, y, img.stride - 1)
  if (a <= 0) return 0
  let s = 0
  for (let c = 0; c < img.stride - 1; c++) s += at(img, x, y, c)
  return Math.min(1, Math.max(0, s / (a * (img.stride - 1))))
}
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-9)))
  return t * t * (3 - 2 * t)
}
/** A region with the same alpha, each pixel's colour from `fn` (straight, 0..1). */
function perPixel(img: Region, fn: (x: number, y: number, a: number) => number[] | null): Region {
  const { size, stride } = img
  const out = new Float64Array(img.data.length)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * stride
      const a = img.data[o + stride - 1]
      out[o + stride - 1] = a
      if (a <= 0) continue
      const s = fn(x, y, a)
      if (s) for (let c = 0; c < stride - 1; c++) out[o + c] = Math.min(1, Math.max(0, s[c])) * a
    }
  return { size, stride, data: out }
}

/** How many taps Lens Blur takes for a radius: the disc's area over two, between 1 and 256. */
export const lensTaps = (r: number) => Math.max(1, Math.min(256, Math.ceil((Math.PI * r * r) / 2)))
/** Lens Blur's disc of taps, as the GPU takes them. */
export function lensRegion(img: Region, r: number, boost: number, threshold: number): Region {
  const { size, stride } = img
  const out = new Float64Array(img.data.length)
  const n = lensTaps(r)
  const taps = Array.from({ length: n }, (_, k) => {
    const rad = r * Math.sqrt((k + 0.5) / n)
    const ang = k * 2.399963229728653
    return [rad * Math.cos(ang), rad * Math.sin(ang)]
  })
  const s = new Float64Array(stride)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sum = new Float64Array(stride)
      let ws = 0
      for (const [dx, dy] of taps) {
        let m = 0
        for (let c = 0; c < stride; c++) s[c] = bil(img, x + dx, y + dy, c)
        for (let c = 0; c < stride - 1; c++) m += s[c]
        const al = s[stride - 1]
        const l = al > 0 ? Math.min(1, Math.max(0, m / (al * (stride - 1)))) : 0
        const w = 1 + boost * smoothstep(threshold, 1, l)
        for (let c = 0; c < stride; c++) sum[c] += s[c] * w
        ws += w
      }
      for (let c = 0; c < stride; c++) out[(y * size + x) * stride + c] = sum[c] / ws
    }
  return { size, stride, data: out }
}

/** Surface Blur's step: every pixel of a small disc, every few of a big one (17 a side at most). */
export const surfaceStep = (r: number) => Math.max(1, Math.ceil(r / 8))

FILTER_DEFS.push(
  defineFilter({
    id: 'lens-blur',
    label: 'Lens Blur',
    category: 'Blur',
    params: [
      num('radius', 'Radius', 1, 100, 10, 'px', 1, 'The size of the iris: how far out of focus.'),
      num('brightness', 'Specular brightness', 0, 100, 0, '%', 1, 'How much the brightest spots bloom into discs, as out-of-focus lights do.'),
      num('threshold', 'Specular threshold', 0, 255, 230, 'levels', 1, 'How bright a spot must be to bloom.'),
    ],
    reach: (v, s) => Math.ceil(v.radius / s) + 2,
    ref: (img, v, ctx) => lensRegion(img, v.radius / ctx.scale, (v.brightness / 100) * 4, v.threshold / 255),
  }),
  defineFilter({
    id: 'surface-blur',
    label: 'Surface Blur',
    category: 'Blur',
    params: [num('radius', 'Radius', 1, 100, 5, 'px'), num('threshold', 'Threshold', 2, 255, 15, 'levels', 1, 'Edges that differ by more than about this are kept sharp.')],
    reach: (v, s) => Math.ceil(v.radius / s),
    ref(img, v, ctx) {
      const r = Math.max(0, Math.round(v.radius / ctx.scale))
      const t = v.threshold / 255
      const step = surfaceStep(r)
      const { size, stride } = img
      const out = new Float64Array(img.data.length)
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const sum = new Float64Array(stride)
          let ws = 0
          for (let dy = -r; dy <= r; dy += step)
            for (let dx = -r; dx <= r; dx += step) {
              if (dx * dx + dy * dy > r * r) continue
              let d = 0
              for (let c = 0; c < stride - 1; c++) d = Math.max(d, Math.abs(st(img, x + dx, y + dy, c) - st(img, x, y, c)))
              const w = Math.max(0, 1 - d / (2.5 * t))
              for (let c = 0; c < stride; c++) sum[c] += at(img, x + dx, y + dy, c) * w
              ws += w
            }
          for (let c = 0; c < stride; c++) out[(y * size + x) * stride + c] = ws > 0 ? sum[c] / ws : at(img, x, y, c)
        }
      return { size, stride, data: out }
    },
  }),
  defineFilter({
    id: 'smart-sharpen',
    label: 'Smart Sharpen',
    category: 'Sharpen',
    params: [
      num('amount', 'Amount', 1, 500, 150, '%'),
      num('radius', 'Radius', 0.1, 64, 2, 'px', 0.1),
      { key: 'remove', kind: 'choice', label: 'Remove', options: [['gaussian', 'Gaussian Blur'], ['lens', 'Lens Blur'], ['motion', 'Motion Blur']], default: 'lens', hint: 'The blur to take out: Lens Blur sharpens fine detail with less of a halo.' },
      { ...num('angle', 'Angle', -90, 90, 0, '°'), when: (v) => v.remove === 'motion' },
      num('noise', 'Reduce noise', 0, 100, 10, '%', 1, 'Differences smaller than this much are left alone, so grain isn’t sharpened.'),
    ],
    reach: (v, s) => Math.ceil(((v.remove === 'gaussian' ? 3 : 1) * v.radius) / s) + 2,
    ref(img, v, ctx) {
      const r = v.radius / ctx.scale
      const blur = v.remove === 'gaussian' ? gaussianRegion(img, r) : v.remove === 'lens' ? lensRegion(img, r, 0, 1) : FILTER_BY_ID.get('motion-blur')!.ref(img, { angle: v.angle, distance: v.radius * 2 }, ctx)
      const amt = v.amount / 100
      const t = ((v.noise / 100) * 16) / 255
      return mapColour(img, (s, i) => {
        const bs = straight(blur.data, i * img.stride, img.stride)
        return s.map((x, c) => (Math.abs(x - bs[c]) < t ? x : x + amt * (x - bs[c])))
      })
    },
  }),
  defineFilter({
    id: 'emboss',
    label: 'Emboss',
    category: 'Stylize',
    params: [num('angle', 'Angle', -180, 180, 135, '°'), num('height', 'Height', 1, 10, 3, 'px'), num('amount', 'Amount', 1, 500, 100, '%')],
    reach: (v, s) => Math.ceil(v.height / s) + 2,
    ref(img, v, ctx) {
      const a = (v.angle * Math.PI) / 180
      const h = v.height / ctx.scale
      const dx = Math.cos(a) * h
      const dy = -Math.sin(a) * h
      const k = v.amount / 100
      const bl = (px: number, py: number) => {
        let m = 0
        for (let c = 0; c < img.stride - 1; c++) m += bil(img, px, py, c)
        const al = bil(img, px, py, img.stride - 1)
        return al > 0 ? Math.min(1, Math.max(0, m / (al * (img.stride - 1)))) : 0
      }
      return perPixel(img, (x, y) => {
        const g = 0.5 + k * (bl(x - dx, y - dy) - bl(x + dx, y + dy))
        return new Array(img.stride - 1).fill(g)
      })
    },
  }),
  defineFilter({
    id: 'find-edges',
    label: 'Find Edges',
    category: 'Stylize',
    params: [],
    reach: () => 1,
    ref: (img) =>
      perPixel(img, (x, y) =>
        Array.from({ length: img.stride - 1 }, (_, c) => {
          const s = (dx: number, dy: number) => st(img, x + dx, y + dy, c)
          const gx = s(1, -1) + 2 * s(1, 0) + s(1, 1) - s(-1, -1) - 2 * s(-1, 0) - s(-1, 1)
          const gy = s(-1, 1) + 2 * s(0, 1) + s(1, 1) - s(-1, -1) - 2 * s(0, -1) - s(1, -1)
          return 1 - Math.hypot(gx, gy) * 0.5
        }),
      ),
  }),
  defineFilter({
    id: 'solarize',
    label: 'Solarize',
    category: 'Stylize',
    params: [],
    reach: () => 0,
    ref: (img) => mapColour(img, (s) => s.map((x) => (x > 0.5 ? 1 - x : x))),
  }),
  defineFilter({
    id: 'lighting',
    label: 'Lighting Effects',
    category: 'Render',
    params: [
      num('angle', 'Angle', -180, 180, 135, '°', 1, 'Where the light comes from, round the layer.'),
      num('altitude', 'Altitude', 5, 90, 40, '°', 1, 'How high the light is: low lights rake across the surface.'),
      num('intensity', 'Intensity', 0, 200, 100, '%'),
      num('ambience', 'Ambience', 0, 100, 25, '%', 1, 'Light from everywhere, so the shade isn’t black.'),
      num('height', 'Height', 0, 50, 10, '', 1, 'How much light and dark raise the surface the light falls on.'),
      num('gloss', 'Gloss', 0, 100, 20, '%'),
      { key: 'colour', kind: 'colour', label: 'Light colour', default: 'white' },
    ],
    reach: () => 1,
    ref(img, v) {
      const L = lightOf(v)
      const lc = workingOf(v.colour, img.stride)
      const h = v.height
      return perPixel(img, (x, y) => {
        const gx = lumAt(img, x + 1, y) - lumAt(img, x - 1, y)
        const gy = lumAt(img, x, y + 1) - lumAt(img, x, y - 1)
        const nl = Math.hypot(gx * h, gy * h, 1)
        const N = [(-gx * h) / nl, (-gy * h) / nl, 1 / nl]
        const diff = Math.max(0, N[0] * L[0] + N[1] * L[1] + N[2] * L[2])
        const H = [L[0], L[1], L[2] + 1]
        const hl = Math.hypot(...H)
        const spec = Math.pow(Math.max(0, (N[0] * H[0] + N[1] * H[1] + N[2] * H[2]) / hl), 24) * (v.gloss / 100)
        return Array.from({ length: img.stride - 1 }, (_, c) => st(img, x, y, c) * (v.ambience / 100 + (v.intensity / 100) * diff * (lc[c] ?? 1)) + spec * (lc[c] ?? 1))
      })
    },
  }),
  defineFilter({
    id: 'clouds',
    label: 'Clouds',
    category: 'Render',
    params: [
      { key: 'from', kind: 'colour', label: 'From', default: 'black' },
      { key: 'to', kind: 'colour', label: 'To', default: 'white' },
      num('scale', 'Scale', 4, 2000, 200, 'px', 1, 'The size of the biggest clouds.'),
      num('seed', 'Seed', 0, 9999, 1, '', 1, 'Another number, other clouds.'),
    ],
    reach: () => 0,
    ref(img, v, ctx) {
      const f = workingOf(v.from, img.stride)
      const t = workingOf(v.to, img.stride)
      return perPixel(img, (x, y) => {
        const n = cloudsAt((ctx.origin[0] + x + 0.5) / (v.scale / ctx.scale), (ctx.origin[1] + y + 0.5) / (v.scale / ctx.scale), v.seed)
        return f.map((a, c) => a + ((t[c] ?? a) - a) * n)
      })
    },
  }),
  defineFilter({
    id: 'mosaic',
    label: 'Mosaic',
    category: 'Pixelate',
    params: [num('cell', 'Cell size', 2, 200, 10, 'px', 1, 'Each square is the average of the pixels in it.')],
    reach: (v, s) => Math.ceil(v.cell / s) + 1,
    ref(img, v, ctx) {
      const cell = Math.max(1, v.cell / ctx.scale)
      const m = mosaicTaps(cell)
      const { size, stride } = img
      const out = new Float64Array(img.data.length)
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const gx = Math.floor((ctx.origin[0] + x) / cell) * cell - ctx.origin[0]
          const gy = Math.floor((ctx.origin[1] + y) / cell) * cell - ctx.origin[1]
          for (let c = 0; c < stride; c++) {
            let s = 0
            for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) s += at(img, Math.floor(gx + ((i + 0.5) * cell) / m), Math.floor(gy + ((j + 0.5) * cell) / m), c)
            out[(y * size + x) * stride + c] = s / (m * m)
          }
        }
      return { size, stride, data: out }
    },
  }),
  defineFilter({
    id: 'dust-scratches',
    label: 'Dust & Scratches',
    category: 'Noise',
    params: [num('radius', 'Radius', 1, MEDIAN_MAX, 2, 'px'), num('threshold', 'Threshold', 0, 255, 10, 'levels', 1, 'Only pixels that differ from round them by more than this are smoothed: specks, not texture.')],
    reach: (v, s) => Math.min(MEDIAN_MAX, Math.round(v.radius / s)),
    ref(img, v, ctx) {
      const m = FILTER_BY_ID.get('median')!.ref(img, { radius: v.radius }, ctx)
      const t = v.threshold / 255
      const { size, stride } = img
      const out = new Float64Array(m.data)
      for (let i = 0; i < size * size; i++) {
        let d = 0
        for (let c = 0; c < stride; c++) d = Math.max(d, Math.abs(img.data[i * stride + c] - m.data[i * stride + c]))
        if (d < t) for (let c = 0; c < stride; c++) out[i * stride + c] = img.data[i * stride + c]
      }
      return { size, stride, data: out }
    },
  }),
  ...(['minimum', 'maximum'] as const).map(
    (id) => defineFilter({
      id,
      label: id === 'minimum' ? 'Minimum' : 'Maximum',
      category: 'Other',
      params: [num('radius', 'Radius', 1, 100, 1, 'px', 1, id === 'minimum' ? 'Darker and thinner: each pixel the least round it.' : 'Lighter and wider: each pixel the most round it.')],
      reach: (v, s) => Math.max(1, Math.round(v.radius / s)),
      ref(img, v, ctx) {
        const r = Math.max(1, Math.round(v.radius / ctx.scale))
        const big = id === 'maximum'
        const pass = (src: Region, horizontal: boolean): Region => {
          const { size, stride } = src
          const out = new Float64Array(src.data.length)
          for (let line = 0; line < size; line++)
            for (let i = 0; i < size; i++)
              for (let c = 0; c < stride; c++) {
                let m = big ? -Infinity : Infinity
                for (let k = Math.max(0, i - r); k <= Math.min(size - 1, i + r); k++) {
                  const q = src.data[(horizontal ? line * size + k : k * size + line) * stride + c]
                  m = big ? Math.max(m, q) : Math.min(m, q)
                }
                out[(horizontal ? line * size + i : i * size + line) * stride + c] = m
              }
          return { size, stride, data: out }
        }
        return pass(pass(img, true), false)
      },
    }),
  ),
)

/** A colour parameter (the document's terms, CMYK as ink) in the working space regions are in (CMYK as light). */
const workingOf = (c: number[], stride: number) => (stride === 5 ? c.map((v) => 1 - v) : c)

/** Mosaic's taps a side: one a pixel, up to sixteen. */
export const mosaicTaps = (cell: number) => Math.max(1, Math.min(16, Math.ceil(cell)))

/** Lighting Effects' light: a direction from its angle and altitude, as the GPU takes it. */
export function lightOf(v: Record<string, unknown>): [number, number, number] {
  const a = ((v.angle as number) * Math.PI) / 180
  const e = ((v.altitude as number) * Math.PI) / 180
  return [Math.cos(e) * Math.cos(a), -Math.cos(e) * Math.sin(a), Math.sin(e)]
}

/** Clouds: five octaves of smooth value noise, 0..1, the same sums as the GPU's. */
export function cloudsAt(x: number, y: number, seed: number): number {
  const vn = (px: number, py: number, s: number) => {
    const ix = Math.floor(px)
    const iy = Math.floor(py)
    const fx = px - ix
    const fy = py - iy
    const ux = fx * fx * (3 - 2 * fx)
    const uy = fy * fy * (3 - 2 * fy)
    const a0 = hash01(ix, iy, s, 0)
    const a1 = hash01(ix + 1, iy, s, 0)
    const a2 = hash01(ix, iy + 1, s, 0)
    const a3 = hash01(ix + 1, iy + 1, s, 0)
    return (a0 + (a1 - a0) * ux) * (1 - uy) + (a2 + (a3 - a2) * ux) * uy
  }
  let v = 0
  let amp = 0.5
  let px = x
  let py = y
  for (let k = 0; k < 5; k++) {
    v += amp * vn(px, py, (seed + k) >>> 0)
    px *= 2
    py *= 2
    amp *= 0.5
  }
  return Math.min(1, Math.max(0, v / 0.96875))
}

// --- shadows and glows as filters: what a fill or a stroke takes, as well as a layer ---------------

/**
 * A shadow (or a glow, at no distance) under a region: its alpha blurred by
 * Gaussian sigma `sigma`, moved (dx, dy), in `colour` (working space) at
 * `opacity`, laid under what's there. The reference the GPU's is held to.
 */
function shadowRegion(img: Region, sigma: number, dx: number, dy: number, colour: number[], opacity: number): Region {
  const b = gaussianRegion(img, sigma)
  const { size, stride } = img
  const out = new Float64Array(img.data)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * stride
      const A = Math.min(1, bil(b, x - dx, y - dy, stride - 1)) * opacity
      const a = img.data[o + stride - 1]
      for (let c = 0; c < stride - 1; c++) out[o + c] = img.data[o + c] + (colour[c] ?? 0) * A * (1 - a)
      out[o + stride - 1] = a + A * (1 - a)
    }
  return { size, stride, data: out }
}

FILTER_DEFS.push(
  defineFilter({
    id: 'drop-shadow',
    label: 'Drop Shadow',
    category: 'Stylize',
    params: [
      { key: 'colour', kind: 'colour', label: 'Colour', default: 'black' },
      num('opacity', 'Opacity', 0, 100, 75, '%'),
      num('angle', 'Angle', -180, 180, 120, '°', 1, 'Where the light comes from: the shadow falls the other way.'),
      num('distance', 'Distance', 0, 500, 5, 'px'),
      num('size', 'Size', 0, 250, 5, 'px', 1, 'How soft the shadow is.'),
    ],
    reach: (v, s) => Math.ceil((v.size * 1.5 + v.distance) / s) + 2,
    ref(img, v, ctx) {
      const a = (v.angle * Math.PI) / 180
      const d = v.distance / ctx.scale
      return shadowRegion(img, v.size / ctx.scale / 2, -Math.cos(a) * d, Math.sin(a) * d, workingOf(v.colour, img.stride), v.opacity / 100)
    },
  }),
  defineFilter({
    id: 'outer-glow',
    label: 'Outer Glow',
    category: 'Stylize',
    params: [{ key: 'colour', kind: 'colour', label: 'Colour', default: [1, 1, 0.75] }, num('opacity', 'Opacity', 0, 100, 75, '%'), num('size', 'Size', 0, 250, 10, 'px', 1, 'How far the glow spreads.')],
    reach: (v, s) => Math.ceil((v.size * 1.5) / s) + 2,
    ref: (img, v, ctx) => shadowRegion(img, v.size / ctx.scale / 3, 0, 0, workingOf(v.colour, img.stride), v.opacity / 100),
  }),
)

// --- geometric effects ---------------------------------------------------------------------

/** An affine that can be inverted, read back from a file. */
const readFrame = (v: unknown): number[] | null =>
  Array.isArray(v) && v.length === 6 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) && Math.abs(v[0] * v[3] - v[1] * v[2]) > 1e-12 ? (v as number[]) : null
const readCorners = (v: unknown): number[] | null => (Array.isArray(v) && v.length === 8 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (v as number[]) : null)
/** Whether a warp's settings are one of the styles (not None, not Custom). */
export const styled = (v: Record<string, unknown>) => v.style !== 'none' && v.style !== 'custom'

/** The mesh a warp's settings make: its style's, its own (Custom), or none. */
function meshOf(v: Record<string, unknown>): Mesh | null {
  if (v.style === 'custom') return (v.mesh as Mesh | null) ?? null
  return styled(v) ? styleMesh(v.style as string, (v.bend as number) / 100, (v.horizontal as number) / 100, (v.vertical as number) / 100, v.orient === 'vertical') : null
}

/** The transform warp's settings as WarpMap wants them; null when they move nothing. */
export function warpSpec(v: Record<string, unknown>) {
  const frame = v.frame as number[]
  const flatCorners = frameCorners(frame)
  const corners = (v.corners as number[] | null) ?? flatCorners
  const mesh = meshOf(v)
  const flat = corners.every((c, i) => Math.abs(c - flatCorners[i]) < 1e-9)
  const bent = !!mesh && !isIdentityMesh(mesh)
  if (flat && !bent) return null
  return { frame, corners, mesh: bent ? mesh : null }
}

FILTER_DEFS.push(defineFilter({
  id: 'warp',
  label: 'Warp',
  hidden: true,
  params: [
    { key: 'style', kind: 'choice', label: 'Style', options: WARP_STYLES, default: 'none', hint: 'A shape to bend to, or Custom: the mesh as dragged in Free Transform.' },
    { key: 'orient', kind: 'choice', label: 'Orientation', options: [['horizontal', 'Horizontal'], ['vertical', 'Vertical']], default: 'horizontal', when: styled },
    { ...num('bend', 'Bend', -100, 100, 50, '%'), when: styled },
    { ...num('horizontal', 'Horizontal distortion', -100, 100, 0, '%'), when: styled },
    { ...num('vertical', 'Vertical distortion', -100, 100, 0, '%'), when: styled },
    { key: 'frame', kind: 'data', label: 'Frame', read: readFrame, default: [1, 0, 0, 1, 0, 0] },
    { key: 'corners', kind: 'data', label: 'Corners', read: readCorners, default: null },
    { key: 'mesh', kind: 'data', label: 'Mesh', read: readMesh, default: null },
  ],
  reach: () => 0,
  ref(img, v, ctx) {
    const w = this.warp!(v)
    return w ? warpRegion(img, w, ctx) : img
  },
  warp(v) {
    const spec = warpSpec(v)
    if (!spec) return null
    const m = new WarpMap(spec)
    return { inverse: (x, y) => m.inverse(x, y), forward: (x, y) => m.forward(x, y), bounds: (r) => m.bounds(r) }
  },
}))

FILTER_DEFS.push(defineFilter({
  id: 'liquify',
  label: 'Liquify',
  hidden: true,
  params: [
    { key: 'field', kind: 'data', label: 'Field', read: (v) => (decodeField(v) ? v : null), default: null },
    { key: 'frame', kind: 'data', label: 'Frame', read: readFrame, default: [1, 0, 0, 1, 0, 0] },
  ],
  reach: () => 0,
  ref(img, v, ctx) {
    const w = this.warp!(v)
    return w ? warpRegion(img, w, ctx) : img
  },
  warp(v) {
    const f = v.field ? decodeField(v.field) : null
    if (!f || isEmptyField(f)) return null
    return liquifyWarp(f, v.frame)
  },
}))

const reaches = new WeakMap<Float32Array, number>()
/**
 * A Liquify field as a warp: each point read from itself plus the field
 * there. The field is in its own coordinates, which `frame` takes into the
 * node's (the identity, until the node is rasterized from under it).
 */
function liquifyWarp(f: Field, frame: readonly number[] = [1, 0, 0, 1, 0, 0]): Warp {
  let reach = reaches.get(f.d)
  if (reach === undefined) reaches.set(f.d, (reach = fieldReach(f)))
  const plain = frame.every((v, i) => v === [1, 0, 0, 1, 0, 0][i])
  const d = frame[0] * frame[3] - frame[1] * frame[2] || 1e-12
  const fi = [frame[3] / d, -frame[1] / d, -frame[2] / d, frame[0] / d, (frame[2] * frame[5] - frame[3] * frame[4]) / d, (frame[1] * frame[4] - frame[0] * frame[5]) / d]
  const m = (reach + 2) * Math.max(Math.hypot(frame[0], frame[1]), Math.hypot(frame[2], frame[3]))
  return {
    inverse(x, y) {
      if (plain) {
        const [dx, dy] = fieldAt(f, x, y)
        return [x + dx, y + dy, 1]
      }
      const u = fi[0] * x + fi[2] * y + fi[4]
      const v = fi[1] * x + fi[3] * y + fi[5]
      const [dx, dy] = fieldAt(f, u, v)
      return [frame[0] * (u + dx) + frame[2] * (v + dy) + frame[4], frame[1] * (u + dx) + frame[3] * (v + dy) + frame[5], 1]
    },
    bounds: (r) => [r[0] - m, r[1] - m, r[2] + m, r[3] + m],
    detail: fieldStep(f) * Math.max(Math.hypot(frame[0], frame[1]), Math.hypot(frame[2], frame[3])),
  }
}

/**
 * A warp run on a region, the reference the GPU is held to: each pixel
 * read bilinearly (about pixel centres) from where the warp says, the
 * region at `ctx.origin` in pixels of a level `ctx.scale` document pixels
 * a pixel, and the node at the document's own coordinates.
 */
export function warpRegion(img: Region, w: Warp, ctx: FilterContext): Region {
  const { size, stride } = img
  const out = new Float64Array(img.data.length)
  const s = ctx.scale
  const at = (x: number, y: number, c: number) => (x < 0 || y < 0 || x >= size || y >= size ? 0 : img.data[(y * size + x) * stride + c])
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const src = w.inverse((ctx.origin[0] + i + 0.5) * s, (ctx.origin[1] + j + 0.5) * s)
      if (!src || src[2] <= 1e-12) continue
      const px = src[0] / src[2] / s - ctx.origin[0] - 0.5
      const py = src[1] / src[2] / s - ctx.origin[1] - 0.5
      const x0 = Math.floor(px)
      const y0 = Math.floor(py)
      const fx = px - x0
      const fy = py - y0
      for (let c = 0; c < stride; c++)
        out[(j * size + i) * stride + c] = (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) + (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy
    }
  return { size, stride, data: out }
}

// --- Distort: geometric filters ------------------------------------------------------------

/** What a warp may need from the document it's drawn in: its patterns (Displace's map). */
export interface WarpEnv {
  mode: 'rgb' | 'gray' | 'cmyk'
  pattern(id: string): { w: number; h: number; levels: { w: number; h: number; data: Float32Array }[] } | undefined
}

/** A framed filter's frame, or none (a filter made before it had one moves nothing). */
const frameParam = { key: 'frame', kind: 'data', label: 'Frame', read: readFrame, default: null } as const satisfies ParamDef

/** A warp from a map on the frame's unit square, keeping to the frame's box (or the rectangle asked about). */
function framedWarp(frame: number[], g: (u: number, v: number) => Pt | null): Warp {
  const fr = framed(frame)
  const box = frameBox(frame)
  return {
    inverse: onFrame(fr, g),
    bounds: (r) => [Math.min(r[0], box[0]), Math.min(r[1], box[1]), Math.max(r[2], box[2]), Math.max(r[3], box[3])],
    detail: Math.min(Math.hypot(frame[0], frame[1]), Math.hypot(frame[2], frame[3])) / 384,
  }
}
/** A warp that moves points by at most `m` (node units). */
function nearWarp(inverse: (x: number, y: number) => [number, number, number] | null, m: number, detail?: number): Warp {
  return { inverse, bounds: (r) => [r[0] - m, r[1] - m, r[2] + m, r[3] + m], detail }
}

FILTER_DEFS.push(
  defineFilter({
    id: 'twirl',
    label: 'Twirl',
    category: 'Distort',
    framed: true,
    params: [num('angle', 'Angle', -999, 999, 50, '°', 1, 'How far the middle turns; the edge of the circle doesn’t.'), frameParam],
    reach: () => 0,
    ref: geometricRef,
    warp: (v) => (v.frame && v.angle ? framedWarp(v.frame, twirl(v.angle, aspectOf(v.frame))) : null),
  }),
  defineFilter({
    id: 'pinch',
    label: 'Pinch',
    category: 'Distort',
    framed: true,
    params: [num('amount', 'Amount', -100, 100, 50, '%', 1, 'In towards the middle; out, when negative.'), frameParam],
    reach: () => 0,
    ref: geometricRef,
    warp: (v) => (v.frame && v.amount ? framedWarp(v.frame, pinch(v.amount, aspectOf(v.frame))) : null),
  }),
  defineFilter({
    id: 'spherize',
    label: 'Spherize',
    category: 'Distort',
    framed: true,
    params: [
      num('amount', 'Amount', -100, 100, 100, '%', 1, 'As if wrapped round a ball; inside a bowl, when negative.'),
      { key: 'mode', kind: 'choice', label: 'Mode', options: [['normal', 'Normal'], ['horizontal', 'Horizontal only'], ['vertical', 'Vertical only']], default: 'normal' },
      frameParam,
    ],
    reach: () => 0,
    ref: geometricRef,
    warp: (v) => (v.frame && v.amount ? framedWarp(v.frame, spherize(v.amount, v.mode as 'normal' | 'horizontal' | 'vertical')) : null),
  }),
  defineFilter({
    id: 'zigzag',
    label: 'ZigZag',
    category: 'Distort',
    framed: true,
    params: [
      num('amount', 'Amount', -100, 100, 10, '%'),
      num('ridges', 'Ridges', 1, 20, 5, ''),
      { key: 'style', kind: 'choice', label: 'Style', options: [['around', 'Around centre'], ['out', 'Out from centre'], ['pond', 'Pond ripples']], default: 'pond' },
      frameParam,
    ],
    reach: () => 0,
    ref: geometricRef,
    warp: (v) => (v.frame && v.amount ? framedWarp(v.frame, zigzag(v.amount, v.ridges, v.style, aspectOf(v.frame))) : null),
  }),
  defineFilter({
    id: 'polar',
    label: 'Polar Coordinates',
    category: 'Distort',
    framed: true,
    params: [{ key: 'way', kind: 'choice', label: 'Way', options: [['to-polar', 'Rectangular to polar'], ['to-rect', 'Polar to rectangular']], default: 'to-polar' }, frameParam],
    reach: () => 0,
    ref: geometricRef,
    warp: (v) => (v.frame ? { ...framedWarp(v.frame, polar(v.way === 'to-polar')), seams: true } : null),
  }),
  defineFilter({
    id: 'wave',
    label: 'Wave',
    category: 'Distort',
    params: [
      num('generators', 'Generators', 1, 20, 5, ''),
      num('minWavelength', 'Wavelength, least', 1, 998, 10, 'px'),
      num('maxWavelength', 'Wavelength, most', 2, 999, 120, 'px'),
      num('minAmplitude', 'Amplitude, least', 1, 998, 5, 'px'),
      num('maxAmplitude', 'Amplitude, most', 2, 999, 35, 'px'),
      num('scaleH', 'Scale across', 0, 100, 100, '%'),
      num('scaleV', 'Scale down', 0, 100, 100, '%'),
      { key: 'kind', kind: 'choice', label: 'Type', options: [['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square']], default: 'sine' },
      num('seed', 'Randomize', 0, 9999, 1, '', 1, 'Another number, other waves.'),
    ],
    reach: () => 0,
    ref: geometricRef,
    warp(v) {
      const amp: [number, number] = [Math.min(v.minAmplitude, v.maxAmplitude), Math.max(v.minAmplitude, v.maxAmplitude)]
      const sc: [number, number] = [v.scaleH / 100, v.scaleV / 100]
      if (!sc[0] && !sc[1]) return null
      const f = wave({ generators: v.generators, wavelength: [Math.min(v.minWavelength, v.maxWavelength), Math.max(v.minWavelength, v.maxWavelength)], amplitude: amp, scale: sc, kind: v.kind, seed: v.seed })
      return nearWarp(f, amp[1] * Math.max(sc[0], sc[1]) + 2, Math.min(v.minWavelength, v.maxWavelength) / 8)
    },
  }),
  defineFilter({
    id: 'ripple',
    label: 'Ripple',
    category: 'Distort',
    params: [num('amount', 'Amount', -999, 999, 100, '%'), { key: 'size', kind: 'choice', label: 'Size', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], default: 'medium' }],
    reach: () => 0,
    ref: geometricRef,
    warp(v) {
      if (!v.amount) return null
      const l = v.size === 'small' ? 8 : v.size === 'large' ? 40 : 18
      return nearWarp(ripple(v.amount, l), Math.abs(v.amount / 100) * l * 0.15 + 2, l / 12)
    },
  }),
  defineFilter({
    id: 'displace',
    label: 'Displace',
    category: 'Distort',
    framed: true,
    params: [
      { key: 'map', kind: 'pattern', label: 'Map', hint: 'A pattern of the document’s (Edit → Define Pattern): its light moves things one way, its dark the other; red across, green down.' },
      num('scaleH', 'Horizontal scale', -999, 999, 10, 'px'),
      num('scaleV', 'Vertical scale', -999, 999, 10, 'px'),
      { key: 'fit', kind: 'choice', label: 'Map', options: [['stretch', 'Stretch to fit'], ['tile', 'Tile']], default: 'stretch' },
      frameParam,
    ],
    reach: () => 0,
    ref: geometricRef,
    warp(v, env) {
      if (!v.map || !v.frame || (!v.scaleH && !v.scaleV)) return null
      const m = Math.max(Math.abs(v.scaleH), Math.abs(v.scaleV)) + 2
      const p = env?.pattern(v.map)
      // Without the pattern to hand (working out bounds), as far as it could move anything.
      if (!p) return nearWarp((x, y) => [x, y, 1], m)
      const lv = p.levels[0]
      const frame = v.frame
      // In pattern pixels: stretched across the box, or tiled from its corner at the pattern's size.
      const side = [Math.hypot(frame[0], frame[1]), Math.hypot(frame[2], frame[3])]
      const sample: MapSampler = (u, w) => {
        const px = v.fit === 'tile' ? u * side[0] : u * lv.w
        const py = v.fit === 'tile' ? w * side[1] : w * lv.h
        const x0 = Math.floor(px - 0.5)
        const y0 = Math.floor(py - 0.5)
        const fx = px - 0.5 - x0
        const fy = py - 0.5 - y0
        const at = (x: number, y: number, c: number) => {
          const i = ((((y % lv.h) + lv.h) % lv.h) * lv.w + (((x % lv.w) + lv.w) % lv.w)) * 5
          const a = lv.data[i + 4]
          return a > 0 ? lv.data[i + c] / a : 0.5
        }
        const ch = (c: number) => (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) + (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy
        return env!.mode === 'gray' ? [ch(0)] : [ch(0), ch(1), ch(2)]
      }
      return nearWarp(displace(sample, [v.scaleH, v.scaleV], frame), m)
    },
  }),
)

/** A geometric filter's reference: its warp run on the region. */
function geometricRef(this: FilterDef, img: Region, v: Record<string, unknown>, ctx: FilterContext): Region {
  const w = this.warp!(v)
  return w ? warpRegion(img, w, ctx) : img
}

// The first filters' places in the menu.
const CATEGORY: Record<string, string> = { 'gaussian-blur': 'Blur', 'box-blur': 'Blur', 'motion-blur': 'Blur', 'unsharp-mask': 'Sharpen', 'high-pass': 'Other', 'add-noise': 'Noise', median: 'Noise', offset: 'Other' }
for (const d of FILTER_DEFS) d.category ??= CATEGORY[d.id]

/** The Filter menu's submenus, in Photoshop's order. */
export const FILTER_CATEGORIES = ['Blur', 'Distort', 'Noise', 'Pixelate', 'Render', 'Sharpen', 'Stylize', 'Other']

export const FILTER_BY_ID = new Map(FILTER_DEFS.map((d) => [d.id, d]))

const warps = new WeakMap<object, { mode: string; w: Warp | null }>()
const warpsWith = new WeakMap<object, { mode: string; w: Warp | null }>()
/**
 * A filter node's warp, when it's a geometric effect that moves anything:
 * worked out once per node object (its settings change with it). Without
 * `env` (the scene working out bounds) one that needs the document's
 * patterns only says how far it could move things.
 */
export function warpOf(e: { kind: string; props: object }, mode: 'rgb' | 'gray' | 'cmyk', env?: WarpEnv): Warp | null {
  const props = e.props as { filter?: string; params?: unknown }
  if (e.kind !== 'filter' || !props.filter) return null
  const def = FILTER_BY_ID.get(props.filter)
  if (!def?.warp) return null
  const cache = env ? warpsWith : warps
  const hit = cache.get(e)
  if (hit && hit.mode === mode) return hit.w
  const w = def.warp(filterValues(props.filter, props.params, mode), env)
  cache.set(e, { mode, w })
  return w
}

/** Whether a filter id is a geometric effect. */
export const isGeometric = (id: string) => !!FILTER_BY_ID.get(id)?.warp

/** A filter node's parameters, whole and in range. */
export const filterValues = (id: string, raw: unknown, mode: 'rgb' | 'gray' | 'cmyk') => readParamValues(FILTER_BY_ID.get(id)?.params ?? [], raw, mode)

/** Noise for one pixel and channel, −1..1 (uniform) or about that (Gaussian, a third of a standard deviation a unit). */
export function noiseAt(x: number, y: number, seed: number, k: number, gauss: boolean): number {
  const u = hash01(x, y, seed, k)
  if (!gauss) return u * 2 - 1
  const u2 = hash01(x, y, seed, k + 7)
  return (Math.sqrt(-2 * Math.log(Math.max(1e-7, 1 - u))) * Math.cos(2 * Math.PI * u2)) / 3
}

/** Where Motion Blur samples, as offsets: evenly along the line, at most 64 of them. Up is negative y, as on screen. */
export function motionTaps(angleDeg: number, distance: number): [number, number][] {
  const n = Math.max(1, Math.min(64, Math.ceil(distance) + 1))
  const a = (angleDeg * Math.PI) / 180
  const dx = Math.cos(a)
  const dy = -Math.sin(a)
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0 : -distance / 2 + (distance * i) / (n - 1)
    return [t * dx, t * dy]
  })
}

/**
 * A geometric effect's settings carried by an affine `m` of the node's own
 * coordinates: what keeps a warp where it was when the node's coordinates
 * change under it (Rasterize making its transform the identity).
 */
export function moveWarpParams(id: string, params: Record<string, unknown>, m: readonly number[]): Record<string, unknown> {
  const comp = (f: number[]) => [m[0] * f[0] + m[2] * f[1], m[1] * f[0] + m[3] * f[1], m[0] * f[2] + m[2] * f[3], m[1] * f[2] + m[3] * f[3], m[0] * f[4] + m[2] * f[5] + m[4], m[1] * f[4] + m[3] * f[5] + m[5]]
  const frame = readFrame(params.frame) ?? [1, 0, 0, 1, 0, 0]
  if (id === 'liquify' || (FILTER_BY_ID.get(id)?.framed && params.frame)) return { ...params, frame: comp(frame) }
  if (id !== 'warp') return params
  const corners = readCorners(params.corners) ?? frameCorners(frame)
  const moved = corners.map((_, i) => (i % 2 ? m[1] * corners[i - 1] + m[3] * corners[i] + m[5] : m[0] * corners[i] + m[2] * corners[i + 1] + m[4]))
  return { ...params, frame: comp(frame), corners: moved }
}
