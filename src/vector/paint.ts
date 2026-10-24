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
import { strokeStyleOf, type GradientLine, type GradientType, type Paint, type StrokeItem } from '../doc/vector'
import type { Box, FillRule, Mat, Polyline } from '../geom/path'
import { PATTERN_BY_ID, patternValue } from './patterns'
import { compose as mul } from '../geom/affine'
import { fillSegments, inside, windingAt } from '../geom/raster'
import { profileAt, strokeReach } from '../geom/stroke'
import { TILE } from '../tiles/format'
import { FREEFORM_EPS, allPatches, gridSpline, invBilinear, type Mesh } from './mesh'

/** Kinds as the kernel numbers them. */
export const PAINT_KIND = { solid: 0, linear: 1, radial: 2, angular: 3, diamond: 4, pattern: 5, reflected: 6, image: 7, stroke: 8, freeform: 9, mesh: 10 } as const

/** Floats a stroke's centre line takes a segment, a freeform point, a mesh point, in a paint's field. */
export const STROKE_SEG = 12
export const FREEFORM_STRIDE = 8
export const MESH_STRIDE = 7
/** Floats before a field's own data. */
export const FIELD_HEAD = 4

/**
 * A stroke's centre line, for a gradient along or across it: its flattened
 * segments in the shape's own coordinates, STROKE_SEG floats each: the two
 * ends (ax, ay, bx, by), how far along its subpath each end is and the
 * subpath's length (sa, sb, len), the stroke's width each side at each end
 * (left a, right a, left b, right b), and which side is "left" (1, or −1
 * for an inside or outside stroke whose visible side is on the right).
 * `reach` is how far from it the stroke paints at most.
 */
export interface StrokeCentre {
  segs: Float64Array
  reach: number
}

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
export function patternSample(img: { w: number; h: number; levels: PatternLevel[] }, u: number, v: number, fw: number): { c: number[]; a: number } {
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
  /**
   * What a stroke gradient, a freeform gradient or a mesh reads, cut to the
   * tile: FIELD_HEAD floats, then a stroke's segments (count, along 0 or
   * across 1), a freeform's points (count; x, y, colour, alpha, spread) or a
   * mesh (columns, rows, patches listed, where its points start; the
   * patches as column and row; its points as x, y, premultiplied colour,
   * alpha). In the shape's own coordinates, which `m` takes a pixel to.
   */
  field?: Float32Array
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
export function paintParams(p: Paint, mode: ColourMode, toNode: Mat, box: Box | null, patterns?: (id: string) => PatternImage | undefined, centre?: StrokeCentre | null): PaintParams {
  const base: PaintParams = { kind: 0, stops: new Float32Array(12), pattern: 0, reverse: false, m: [1, 0, 0, 1, 0, 0], fw: 0, colour: [0, 0, 0, 0], colour2: [0, 0, 0, 0], alpha: 1, alpha2: 1, image: null }
  if (p.kind === 'solid') return { ...base, colour: working(mode, p.colour) }
  if (p.kind === 'freeform') {
    const field = new Float32Array(FIELD_HEAD + p.points.length * FREEFORM_STRIDE)
    field[0] = p.points.length
    p.points.forEach((q, i) => field.set([q.p[0], q.p[1], ...working(mode, q.colour), q.alpha, q.spread], FIELD_HEAD + i * FREEFORM_STRIDE))
    return { ...base, kind: PAINT_KIND.freeform, m: [...toNode], field }
  }
  if (p.kind === 'mesh') return { ...base, kind: PAINT_KIND.mesh, m: [...toNode], field: meshField(p, mode, tileBox(toNode)) }
  if (p.kind === 'gradient' && p.stroke && centre) return { ...gradientParams(p, mode), kind: PAINT_KIND.stroke, pattern: p.stroke === 'across' ? 1 : 0, m: [...toNode], field: strokeField(centre, p.stroke, tileBox(toNode)) }
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

/** The box a tile covers in the shape's coordinates, from its pixel-to-shape matrix. */
function tileBox(toNode: Mat): Box {
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y] of [
    [0, 0],
    [TILE, 0],
    [0, TILE],
    [TILE, TILE],
  ]) {
    xs.push(toNode[0] * x + toNode[2] * y + toNode[4])
    ys.push(toNode[1] * x + toNode[3] * y + toNode[5])
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

const meets = (a: Box, b: Box) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]

/** A stroke's centre segments near a tile (those within its reach of it), as the field. */
function strokeField(c: StrokeCentre, along: 'along' | 'across', box: Box): Float32Array {
  const r = c.reach
  const near: number[] = []
  for (let o = 0; o < c.segs.length; o += STROKE_SEG) {
    const s = c.segs
    const sb: Box = [Math.min(s[o], s[o + 2]) - r, Math.min(s[o + 1], s[o + 3]) - r, Math.max(s[o], s[o + 2]) + r, Math.max(s[o + 1], s[o + 3]) + r]
    if (meets(sb, box)) near.push(o)
  }
  const field = new Float32Array(FIELD_HEAD + near.length * STROKE_SEG)
  field[0] = near.length
  field[1] = along === 'across' ? 1 : 0
  near.forEach((o, k) => field.set(c.segs.subarray(o, o + STROKE_SEG), FIELD_HEAD + k * STROKE_SEG))
  return field
}

/**
 * A mesh as the field: the patches that meet the tile, and those round the
 * mesh's edge (what a pixel past the edge takes its colour from), then
 * every point, its colour premultiplied in the working space.
 */
function meshField(m: Mesh, mode: ColourMode, box: Box): Float32Array {
  const patches: number[] = []
  const all = allPatches(m)
  for (let k = 0; k < all.length; k += 2) {
    const i = all[k]
    const j = all[k + 1]
    const edge = i === 0 || j === 0 || i === m.cols - 1 || j === m.rows - 1
    const ps = [m.nodes[j * (m.cols + 1) + i], m.nodes[j * (m.cols + 1) + i + 1], m.nodes[(j + 1) * (m.cols + 1) + i], m.nodes[(j + 1) * (m.cols + 1) + i + 1]].map((n) => n.p)
    const pb: Box = [Math.min(...ps.map((p) => p[0])), Math.min(...ps.map((p) => p[1])), Math.max(...ps.map((p) => p[0])), Math.max(...ps.map((p) => p[1]))]
    if (edge || meets(pb, box)) patches.push(i, j)
  }
  const vstart = FIELD_HEAD + patches.length
  const field = new Float32Array(vstart + m.nodes.length * MESH_STRIDE)
  field.set([m.cols, m.rows, patches.length / 2, vstart], 0)
  field.set(patches, FIELD_HEAD)
  m.nodes.forEach((n, i) =>
    field.set(
      [n.p[0], n.p[1], ...working(mode, n.colour).map((v) => v * n.alpha), n.alpha],
      vstart + i * MESH_STRIDE,
    ),
  )
  return field
}

/**
 * A stroke's centre line for a gradient along or across it (StrokeCentre),
 * from its path flattened in its own coordinates. A centre stroke runs from
 * its right edge (0) to its left (1) across; an inside or outside one from
 * the path (0) out to its visible edge (1), the side found by asking the
 * fill which side of the path it's on.
 */
export function strokeCentre(lines: Polyline[], item: StrokeItem, rule: FillRule): StrokeCentre {
  const closedAll = lines.length > 0 && lines.every((l) => l.closed)
  const aligned = closedAll && item.align !== 'centre'
  const fill = aligned ? fillSegments(lines) : null
  const out: number[] = []
  const profile = item.profile ?? []
  const hw = item.width / 2
  for (const l of lines) {
    const pts = l.pts.slice()
    if (l.closed && pts.length >= 4) pts.push(pts[0], pts[1])
    const n = pts.length / 2
    if (n < 2) continue
    const along = [0]
    for (let i = 1; i < n; i++) along.push(along[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]))
    const len = along[n - 1]
    if (len <= 0) continue
    // An inside or outside stroke: which side of this subpath it shows on, tried beside its longest segment.
    let flip = 1
    if (fill) {
      let best = 1
      for (let i = 2; i < n; i++) if (along[i] - along[i - 1] > along[best] - along[best - 1]) best = i
      const ax = pts[best * 2 - 2]
      const ay = pts[best * 2 - 1]
      const dx = pts[best * 2] - ax
      const dy = pts[best * 2 + 1] - ay
      const dl = Math.hypot(dx, dy) || 1
      const e = Math.max(1e-4, dl * 1e-3)
      const leftIn = inside(windingAt(fill, ax + dx / 2 - (dy / dl) * e, ay + dy / 2 + (dx / dl) * e), rule)
      flip = leftIn === (item.align === 'inside') ? 1 : -1
    }
    const widths = (s: number): [number, number] => {
      const t = s / len
      if (aligned) return [item.width * profileAt(profile, t, flip > 0 ? 'left' : 'right'), 0]
      return [hw * profileAt(profile, t, 'left'), hw * profileAt(profile, t, 'right')]
    }
    for (let i = 1; i < n; i++) {
      const wa = widths(along[i - 1])
      const wb = widths(along[i])
      out.push(pts[i * 2 - 2], pts[i * 2 - 1], pts[i * 2], pts[i * 2 + 1], along[i - 1], along[i], len, wa[0], wa[1], wb[0], wb[1], flip)
    }
  }
  return { segs: new Float64Array(out), reach: strokeReach(strokeStyleOf(item, aligned ? item.width * 2 : item.width)) + 1 }
}

/** How far along or across a stroke (0..1, before reversing) a point in the shape's coordinates is, from its field. */
export function strokeT(field: Float32Array, x: number, y: number): number {
  const n = field[0]
  let best = Infinity
  let k = -1
  let tau = 0
  for (let s = 0; s < n; s++) {
    const o = FIELD_HEAD + s * STROKE_SEG
    const abx = field[o + 2] - field[o]
    const aby = field[o + 3] - field[o + 1]
    const l2 = abx * abx + aby * aby
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - field[o]) * abx + (y - field[o + 1]) * aby) / l2)) : 0
    const dx = x - (field[o] + abx * t)
    const dy = y - (field[o + 1] + aby * t)
    const d2 = dx * dx + dy * dy
    if (d2 < best) {
      best = d2
      k = o
      tau = t
    }
  }
  if (k < 0) return 0
  if (field[1] < 0.5) return (field[k + 4] + tau * (field[k + 5] - field[k + 4])) / Math.max(field[k + 6], 1e-9)
  // Across: the distance from the line, signed by which side (so a corner's outside runs on smoothly).
  const abx = field[k + 2] - field[k]
  const aby = field[k + 3] - field[k + 1]
  const side = abx * (y - field[k + 1]) - aby * (x - field[k])
  const d = (side * field[k + 11] >= 0 ? 1 : -1) * Math.sqrt(best)
  const wl = field[k + 7] + tau * (field[k + 9] - field[k + 7])
  const wr = field[k + 8] + tau * (field[k + 10] - field[k + 8])
  return (d + wr) / Math.max(wl + wr, 1e-9)
}

/** A freeform gradient at a point in the shape's coordinates, from its field: premultiplied colour and alpha. */
export function freeformField(field: Float32Array, x: number, y: number): { c: number[]; a: number } {
  const n = field[0]
  const c = [0, 0, 0, 0]
  let a = 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const o = FIELD_HEAD + i * FREEFORM_STRIDE
    const d2 = (x - field[o]) ** 2 + (y - field[o + 1]) ** 2
    const s2 = field[o + 7] * field[o + 7]
    const w = Math.pow(s2 / (d2 + FREEFORM_EPS), 1.5)
    const al = field[o + 6]
    for (let j = 0; j < 4; j++) c[j] += field[o + 2 + j] * al * w
    a += al * w
    sum += w
  }
  if (sum <= 0) return { c, a: 0 }
  return { c: c.map((v) => v / sum), a: a / sum }
}

/** A mesh at a point in the shape's coordinates, from its field: premultiplied colour and alpha. */
export function meshFieldAt(field: Float32Array, x: number, y: number): { c: number[]; a: number } {
  const cols = field[0]
  const rows = field[1]
  const np = field[2]
  const vs = field[3]
  const pt = (i: number, j: number): [number, number] => {
    const o = vs + (j * (cols + 1) + i) * MESH_STRIDE
    return [field[o], field[o + 1]]
  }
  let best = { i: 0, j: 0, u: 0, v: 0, out: Infinity }
  for (let k = 0; k < np; k++) {
    const i = field[FIELD_HEAD + k * 2]
    const j = field[FIELD_HEAD + k * 2 + 1]
    const r = invBilinear(x, y, pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1))
    if (r.out < best.out) {
      best = { i, j, ...r }
      if (r.out <= 0) break
    }
  }
  const gu = best.i + Math.min(1, Math.max(0, best.u))
  const gv = best.j + Math.min(1, Math.max(0, best.v))
  const v = gridSpline(cols, rows, (i, j) => field.subarray(vs + (j * (cols + 1) + i) * MESH_STRIDE + 2, vs + (j * (cols + 1) + i) * MESH_STRIDE + 7), gu, gv, 5)
  const a = Math.min(1, Math.max(0, v[4]))
  return { c: v.slice(0, 4).map((c) => Math.min(a, Math.max(0, c))), a }
}

/**
 * A paint's colour at a point in the shape's coordinates, in the
 * document's terms, straight, and its alpha: what a mesh or freeform
 * gradient made from another paint starts from. `box` is the path's box.
 */
export function paintColourAt(p: Paint, mode: ColourMode, box: Box, x: number, y: number): { colour: number[]; alpha: number } {
  const q = paintAt(paintParams(p, mode, [1, 0, 0, 1, x - 0.5, y - 0.5], box), 0, 0)
  const n = mode === 'rgb' ? 3 : mode === 'gray' ? 1 : 4
  const straight = q.c.slice(0, n).map((v) => (q.a > 0 ? Math.min(1, Math.max(0, v / q.a)) : 0))
  return { colour: mode === 'cmyk' ? straight.map((v) => 1 - v) : straight, alpha: q.a }
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
  if (p.kind === PAINT_KIND.freeform) return freeformField(p.field!, gx, gy)
  if (p.kind === PAINT_KIND.mesh) return meshFieldAt(p.field!, gx, gy)
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
    case PAINT_KIND.stroke:
      t = strokeT(p.field!, gx, gy)
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
