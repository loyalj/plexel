/**
 * Paints as the GPU gets them: a paint, made concrete for one tile (where
 * its gradient or pattern lies, in the tile's pixels), and the reference
 * the paint kernel (render/shaders/vector.ts) is held to.
 *
 * Gradients and patterns are laid out in the shape's own coordinates, so
 * they move, turn and scale with it: a gradient across the box round its
 * path (Photoshop's Gradient Overlay's angle and scale) or along its own
 * line, a pattern in cells of `size` units turned by `angle`.
 *
 * A pattern made from pixels is sampled from a pyramid of its repeat, in
 * the working space, premultiplied: bilinearly within a level and between
 * the two levels nearest the footprint, wrapping round at its edges, so it
 * tiles without seams and stays smooth however small it's drawn.
 */
import type { ColourMode } from '../doc/types'
import type { GradientLine, GradientType, Paint } from '../doc/vector'
import type { Box, Mat } from '../geom/path'
import { PATTERN_BY_ID, patternValue } from './patterns'
import { compose as mul } from '../geom/affine'

/** Kinds as the kernel numbers them. */
export const PAINT_KIND = { solid: 0, linear: 1, radial: 2, angular: 3, diamond: 4, pattern: 5, reflected: 6, image: 7 } as const

/** One level of a pattern's pyramid: w × h pixels, five floats each (four working-space channels and alpha, premultiplied). */
export interface PatternLevel {
  w: number
  h: number
  data: Float32Array
}

/** A pattern made from pixels, as the kernels read it: `key` names it (its tile set), `levels[0]` is full size. */
export interface PatternImage {
  key: string
  w: number
  h: number
  levels: PatternLevel[]
}

/** How many floats a pixel takes in a pattern's pyramid. */
export const PATTERN_STRIDE = 5
/** The largest repeat, a side, that a pattern made from pixels may have. */
export const MAX_PATTERN = 1024

/**
 * A pattern's pyramid from its pixels (w × h, five floats each, working
 * space, premultiplied): each level half the last, rounded, down to a
 * pixel, every pixel the average of the area it covers, wrapping round.
 */
export function patternLevels(w: number, h: number, data: Float32Array): PatternLevel[] {
  const out: PatternLevel[] = [{ w, h, data }]
  while (out.length < 16) {
    const p = out[out.length - 1]
    if (p.w === 1 && p.h === 1) break
    const nw = Math.max(1, Math.round(p.w / 2))
    const nh = Math.max(1, Math.round(p.h / 2))
    const d = new Float32Array(nw * nh * PATTERN_STRIDE)
    const sx = p.w / nw
    const sy = p.h / nh
    const acc = new Float64Array(PATTERN_STRIDE)
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        // The source area [x·sx, (x+1)·sx) × [y·sy, (y+1)·sy), each pixel weighted by its overlap.
        acc.fill(0)
        let wsum = 0
        for (let yy = Math.floor(y * sy); yy < Math.ceil((y + 1) * sy); yy++) {
          const wy = Math.min(yy + 1, (y + 1) * sy) - Math.max(yy, y * sy)
          if (wy <= 0) continue
          for (let xx = Math.floor(x * sx); xx < Math.ceil((x + 1) * sx); xx++) {
            const wx = Math.min(xx + 1, (x + 1) * sx) - Math.max(xx, x * sx)
            if (wx <= 0) continue
            const o = ((yy % p.h) * p.w + (xx % p.w)) * PATTERN_STRIDE
            for (let c = 0; c < PATTERN_STRIDE; c++) acc[c] += p.data[o + c] * wx * wy
            wsum += wx * wy
          }
        }
        for (let c = 0; c < PATTERN_STRIDE; c++) d[(y * nw + x) * PATTERN_STRIDE + c] = acc[c] / wsum
      }
    }
    out.push({ w: nw, h: nh, data: d })
  }
  return out
}

/** One level, bilinearly, at (fu, fv) through the repeat (0..1, wrapping), added into `out` weighted by k. */
function levelSample(l: PatternLevel, fu: number, fv: number, out: number[], k: number) {
  const x = fu * l.w - 0.5
  const y = fv * l.h - 0.5
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const wrap = (v: number, n: number) => ((v % n) + n) % n
  const xa = wrap(x0, l.w)
  const xb = wrap(x0 + 1, l.w)
  const ya = wrap(y0, l.h)
  const yb = wrap(y0 + 1, l.h)
  for (let c = 0; c < PATTERN_STRIDE; c++) {
    const at = (xx: number, yy: number) => l.data[(yy * l.w + xx) * PATTERN_STRIDE + c]
    const top = at(xa, ya) * (1 - fx) + at(xb, ya) * fx
    const bottom = at(xa, yb) * (1 - fx) + at(xb, yb) * fx
    out[c] += (top * (1 - fy) + bottom * fy) * k
  }
}

/**
 * A pattern made from pixels at (u, v) in its own pixels (any value: it
 * repeats), drawn with a footprint of `fw` pattern pixels to a pixel:
 * premultiplied colour (four channels) and alpha.
 */
function patternSample(img: { w: number; h: number; levels: PatternLevel[] }, u: number, v: number, fw: number): { c: number[]; a: number } {
  const n = img.levels.length
  const out = [0, 0, 0, 0, 0]
  if (!n) return { c: [0, 0, 0, 0], a: 0 }
  const lod = Math.min(n - 1, Math.max(0, Math.log2(Math.max(fw, 1e-6))))
  const l0 = Math.floor(lod)
  const t = lod - l0
  const fu = u / img.w - Math.floor(u / img.w)
  const fv = v / img.h - Math.floor(v / img.h)
  levelSample(img.levels[l0], fu, fv, out, 1 - t)
  if (t > 0 && l0 + 1 < n) levelSample(img.levels[l0 + 1], fu, fv, out, t)
  return { c: out.slice(0, 4), a: out[4] }
}

export interface PaintParams {
  kind: number
  /** Stops: at, four colour channels (working space), alpha; six floats each. */
  stops: Float32Array
  pattern: number
  reverse: boolean
  /** Tile pixel (its centre) to paint space. */
  m: number[]
  /** Pattern cells per pixel: how wide the filter is. */
  fw: number
  colour: number[]
  colour2: number[]
  alpha: number
  alpha2: number
  /** A pattern made from pixels, for an image paint; null draws nothing. */
  image: PatternImage | null
  /** Paint everywhere, as if covered: a fill layer, which has no outline. */
  full?: boolean
  /**
   * A gradient in a tiled document: each pixel takes the gradient's value
   * at its copy nearest the anchor, so it runs on over the seam it was
   * dragged across, and the break it must have somewhere falls half a
   * period away. The period across and down in tile pixels (0 where the
   * document doesn't repeat), then the anchor, in tile pixels.
   */
  wrap?: [number, number, number, number]
}

/**
 * Where a gradient along a line is anchored in a tiled document (wrap,
 * above), in the shape's coordinates: the middle of a linear or reflected
 * line, the start of the others; none for a gradient without a line.
 */
export function gradientAnchor(p: Paint): [number, number] | null {
  if (p.kind !== 'gradient' || !p.line) return null
  const [x0, y0, x1, y1] = p.line
  return p.type === 'linear' || p.type === 'reflected' ? [(x0 + x1) / 2, (y0 + y1) / 2] : [x0, y0]
}

/** A tile pixel moved by whole periods to its copy nearest the anchor (PaintParams.wrap). */
export function wrapPoint(w: [number, number, number, number] | undefined, x: number, y: number): [number, number] {
  if (!w) return [x, y]
  return [w[0] > 0 ? x - Math.round((x - w[2]) / w[0]) * w[0] : x, w[1] > 0 ? y - Math.round((y - w[3]) / w[1]) * w[1] : y]
}

/** A colour in the document's terms to the working space the kernels blend in: CMYK as light. */
const working = (mode: ColourMode, c: number[]) => {
  const v = mode === 'cmyk' ? c.map((x) => 1 - x) : c
  return [...v, 0, 0, 0, 0].slice(0, 4)
}


/**
 * A paint (its colours already in the document's mode) for a tile: `toNode`
 * maps a tile pixel's centre into the shape's coordinates, `box` is the box
 * round its path there.
 */
export function paintParams(p: Paint, mode: ColourMode, toNode: Mat, box: Box | null, patterns?: (id: string) => PatternImage | undefined): PaintParams {
  const base: PaintParams = { kind: 0, stops: new Float32Array(12), pattern: 0, reverse: false, m: [1, 0, 0, 1, 0, 0], fw: 0, colour: [0, 0, 0, 0], colour2: [0, 0, 0, 0], alpha: 1, alpha2: 1, image: null }
  if (p.kind === 'solid') return { ...base, colour: working(mode, p.colour) }
  const scaleOf = Math.sqrt(Math.abs(toNode[0] * toNode[3] - toNode[1] * toNode[2])) || 1
  if (p.kind === 'pattern' && !PATTERN_BY_ID.has(p.pattern)) {
    // A pattern of the document's, from pixels: node space to its pixels, turned by −angle.
    const img = patterns?.(p.pattern) ?? null
    const a = (p.angle * Math.PI) / 180
    const s = img ? img.w / p.size : 1
    const g = [Math.cos(a) * s, -Math.sin(a) * s, Math.sin(a) * s, Math.cos(a) * s, 0, 0]
    return { ...base, kind: PAINT_KIND.image, image: img, m: mul(g, toNode), fw: scaleOf * s }
  }
  if (p.kind === 'pattern') {
    const a = (p.angle * Math.PI) / 180
    const s = 1 / p.size
    // Node space to pattern cells: turned by −angle, scaled by 1/size.
    const g = [Math.cos(a) * s, -Math.sin(a) * s, Math.sin(a) * s, Math.cos(a) * s, 0, 0]
    return {
      ...base,
      kind: PAINT_KIND.pattern,
      pattern: PATTERN_BY_ID.get(p.pattern)?.index ?? 0,
      m: mul(g, toNode),
      fw: scaleOf * s,
      colour: working(mode, p.colour),
      colour2: working(mode, p.background),
      alpha: 1,
      alpha2: p.backgroundAlpha,
    }
  }
  if (p.line) return { ...gradientParams(p, mode), m: mul(lineMatrix(p.type, p.line), toNode) }
  const b = box ?? [0, 0, 1, 1]
  const cx = (b[0] + b[2]) / 2
  const cy = (b[1] + b[3]) / 2
  const w = Math.max(1e-6, b[2] - b[0])
  const h = Math.max(1e-6, b[3] - b[1])
  const a = (p.angle * Math.PI) / 180
  const dx = Math.cos(a)
  const dy = -Math.sin(a)
  const scale = p.scale / 100
  let g: number[]
  switch (p.type) {
    case 'linear': {
      // Across the box along the angle: 0 at one side, 1 at the other.
      const half = Math.max(1e-6, ((Math.abs(w * dx) + Math.abs(h * dy)) / 2) * scale)
      g = [dx / (2 * half), 0, dy / (2 * half), 0, 0.5 - (dx * cx + dy * cy) / (2 * half), 0]
      break
    }
    case 'reflected': {
      // From the middle of the box out to both sides along the angle.
      const half = Math.max(1e-6, ((Math.abs(w * dx) + Math.abs(h * dy)) / 2) * scale)
      g = [dx / half, 0, dy / half, 0, -(dx * cx + dy * cy) / half, 0]
      break
    }
    case 'radial': {
      const r = Math.max(1e-6, (Math.max(w, h) / 2) * scale)
      g = [1 / r, 0, 0, 1 / r, -cx / r, -cy / r]
      break
    }
    default: {
      // Angular and diamond: turned so the angle points along +x.
      const r = Math.max(1e-6, (Math.max(w, h) / 2) * scale)
      const k = p.type === 'diamond' ? 1 / r : 1
      g = [dx * k, -dy * k, dy * k, dx * k, -(dx * cx + dy * cy) * k, (dy * cx - dx * cy) * k]
    }
  }
  return { ...gradientParams(p, mode), m: mul(g, toNode) }
}

/** A gradient's kind, stops and direction, before it's placed. */
function gradientParams(p: Paint & { kind: 'gradient' }, mode: ColourMode): PaintParams {
  const stops = new Float32Array(Math.max(2, p.stops.length) * 6)
  p.stops.forEach((s, i) => stops.set([s.at, ...working(mode, s.colour), s.alpha], i * 6))
  return { kind: PAINT_KIND[p.type], stops, pattern: 0, reverse: p.reverse, m: [1, 0, 0, 1, 0, 0], fw: 0, colour: [0, 0, 0, 0], colour2: [0, 0, 0, 0], alpha: 1, alpha2: 1, image: null }
}

/**
 * Node space to gradient space for a gradient along a line: linear and
 * reflected put the start at 0 and the end at 1 along x; radial, angular
 * and diamond centre on the start, turned so the line points along +x,
 * with the end at 1.
 */
function lineMatrix(type: GradientType, line: GradientLine): number[] {
  const [x0, y0, x1, y1] = line
  const dx = x1 - x0
  const dy = y1 - y0
  const l2 = Math.max(1e-12, dx * dx + dy * dy)
  if (type === 'linear' || type === 'reflected') return [dx / l2, 0, dy / l2, 0, -(dx * x0 + dy * y0) / l2, 0]
  const l = Math.sqrt(l2)
  const ux = dx / l
  const uy = dy / l
  const k = type === 'angular' ? 1 : 1 / l
  // x along the line, y across it.
  return [ux * k, -uy * k, uy * k, ux * k, -(ux * x0 + uy * y0) * k, (uy * x0 - ux * y0) * k]
}

/** A gradient's colour and alpha at t, from its stops (as the kernel reads them). */
function stopsAt(stops: Float32Array, t: number): { c: number[]; a: number } {
  const n = stops.length / 6
  const at = (i: number) => stops[i * 6]
  if (t <= at(0)) return { c: Array.from(stops.subarray(1, 5)), a: stops[5] }
  if (t >= at(n - 1)) return { c: Array.from(stops.subarray((n - 1) * 6 + 1, (n - 1) * 6 + 5)), a: stops[(n - 1) * 6 + 5] }
  let i = 0
  while (i < n - 2 && t > at(i + 1)) i++
  const span = Math.max(1e-6, at(i + 1) - at(i))
  const f = Math.min(1, Math.max(0, (t - at(i)) / span))
  const c = [0, 1, 2, 3].map((j) => stops[i * 6 + 1 + j] + (stops[(i + 1) * 6 + 1 + j] - stops[i * 6 + 1 + j]) * f)
  return { c, a: stops[i * 6 + 5] + (stops[(i + 1) * 6 + 5] - stops[i * 6 + 5]) * f }
}

/** The paint at a tile pixel (its centre at px + ½, py + ½), premultiplied: what the kernel computes before coverage. */
export function paintAt(p: PaintParams, px: number, py: number): { c: number[]; a: number } {
  if (p.kind === PAINT_KIND.solid) return { c: p.colour.slice(), a: 1 }
  const [x, y] = wrapPoint(p.wrap, px + 0.5, py + 0.5)
  const gx = p.m[0] * x + p.m[2] * y + p.m[4]
  const gy = p.m[1] * x + p.m[3] * y + p.m[5]
  if (p.kind === PAINT_KIND.image) return p.image ? patternSample(p.image, gx, gy, p.fw) : { c: [0, 0, 0, 0], a: 0 }
  if (p.kind === PAINT_KIND.pattern) {
    const v = patternValue(p.pattern, gx, gy, p.fw)
    const a = p.alpha2 * (1 - v) + p.alpha * v
    const c = [0, 1, 2, 3].map((j) => p.colour2[j] * p.alpha2 * (1 - v) + p.colour[j] * p.alpha * v)
    return { c, a }
  }
  let t: number
  switch (p.kind) {
    case PAINT_KIND.linear:
      t = gx
      break
    case PAINT_KIND.reflected:
      t = Math.abs(gx)
      break
    case PAINT_KIND.radial:
      t = Math.hypot(gx, gy)
      break
    case PAINT_KIND.angular: {
      const ang = Math.atan2(gy, gx) / (2 * Math.PI)
      t = ang - Math.floor(ang)
      break
    }
    default:
      t = Math.abs(gx) + Math.abs(gy)
  }
  if (p.reverse) t = 1 - t
  t = Math.min(1, Math.max(0, t))
  const s = stopsAt(p.stops, t)
  return { c: s.c.map((v) => v * s.a), a: s.a }
}
