/**
 * Live shapes: a shape keeps its parameters and makes its path when it's
 * drawn, so a rectangle's corners or a star's points can be changed at any
 * time (ARCHITECTURE.md, "Geometry"). Each is laid out in a box (x, y, w,
 * h), so moving and sizing them is the same for all; a line runs between
 * two points. Turning a shape is its node's transform.
 *
 * Pure: check-geom checks every shape's path against its sums.
 */
import type { Anchor, PathData, Pt } from './path'

export type CornerStyle = 'round' | 'chamfer' | 'inset'

export type ShapeParams =
  /** Corners: top left, top right, bottom right, bottom left, each a radius. */
  | { type: 'rect'; x: number; y: number; w: number; h: number; radii: [number, number, number, number]; corner: CornerStyle }
  | { type: 'ellipse'; x: number; y: number; w: number; h: number }
  /** A regular polygon in the ellipse that fits the box, its first corner at the top. */
  | { type: 'polygon'; x: number; y: number; w: number; h: number; sides: number }
  /** A star in the box: `inner` is its inner corners' distance from the middle, as a share of the outer. */
  | { type: 'star'; x: number; y: number; w: number; h: number; points: number; inner: number }
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number }

export type ShapeType = ShapeParams['type']

export const SHAPE_TYPES: [ShapeType, string][] = [
  ['rect', 'Rectangle'],
  ['ellipse', 'Ellipse'],
  ['polygon', 'Polygon'],
  ['star', 'Star'],
  ['line', 'Line'],
]

export const SHAPE_LABEL: Record<ShapeType, string> = Object.fromEntries(SHAPE_TYPES) as Record<ShapeType, string>

/** How far along a quarter circle's tangent its handles go, for the closest cubic. */
export const KAPPA = 0.5522847498307936

const corner = (x: number, y: number): Anchor => ({ p: [x, y], in: null, out: null, smooth: false })

/** A rectangle's path, clockwise from the top left, its corners rounded, cut or set in. */
function rectPath(s: Extract<ShapeParams, { type: 'rect' }>): Anchor[] {
  const x0 = Math.min(s.x, s.x + s.w)
  const y0 = Math.min(s.y, s.y + s.h)
  const w = Math.abs(s.w)
  const h = Math.abs(s.h)
  const max = Math.min(w, h) / 2
  const r = s.radii.map((v) => Math.max(0, Math.min(max, v)))
  if (r.every((v) => v <= 0)) return [corner(x0, y0), corner(x0 + w, y0), corner(x0 + w, y0 + h), corner(x0, y0 + h)]
  // Each corner: where the edge before it stops, its middle, where the next edge starts.
  const cs: { c: Pt; a: Pt; b: Pt }[] = [
    { c: [x0, y0], a: [x0, y0 + r[0]], b: [x0 + r[0], y0] },
    { c: [x0 + w, y0], a: [x0 + w - r[1], y0], b: [x0 + w, y0 + r[1]] },
    { c: [x0 + w, y0 + h], a: [x0 + w, y0 + h - r[2]], b: [x0 + w - r[2], y0 + h] },
    { c: [x0, y0 + h], a: [x0 + r[3], y0 + h], b: [x0, y0 + h - r[3]] },
  ]
  const out: Anchor[] = []
  cs.forEach(({ c, a, b }, i) => {
    if (r[i] <= 0) {
      out.push(corner(c[0], c[1]))
      return
    }
    if (s.corner === 'chamfer') {
      out.push(corner(a[0], a[1]), corner(b[0], b[1]))
      return
    }
    // Round: the arc bulges out towards the corner; set in, it curves the
    // other way, round the corner point itself.
    const k = KAPPA
    const toward = s.corner === 'round' ? c : ([a[0] + b[0] - c[0], a[1] + b[1] - c[1]] as Pt)
    const ha: Pt = [a[0] + (toward[0] - a[0]) * k, a[1] + (toward[1] - a[1]) * k]
    const hb: Pt = [b[0] + (toward[0] - b[0]) * k, b[1] + (toward[1] - b[1]) * k]
    out.push({ p: a, in: null, out: ha, smooth: false }, { p: b, in: hb, out: null, smooth: false })
  })
  return out
}

function ellipsePath(x: number, y: number, w: number, h: number): Anchor[] {
  const cx = x + w / 2
  const cy = y + h / 2
  const rx = Math.abs(w) / 2
  const ry = Math.abs(h) / 2
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  // Top, right, bottom, left: clockwise on screen.
  return [
    { p: [cx, cy - ry], in: [cx - kx, cy - ry], out: [cx + kx, cy - ry], smooth: true },
    { p: [cx + rx, cy], in: [cx + rx, cy - ky], out: [cx + rx, cy + ky], smooth: true },
    { p: [cx, cy + ry], in: [cx + kx, cy + ry], out: [cx - kx, cy + ry], smooth: true },
    { p: [cx - rx, cy], in: [cx - rx, cy + ky], out: [cx - rx, cy - ky], smooth: true },
  ]
}

function radial(x: number, y: number, w: number, h: number, n: number, radiusAt: (i: number) => number): Anchor[] {
  const cx = x + w / 2
  const cy = y + h / 2
  const rx = Math.abs(w) / 2
  const ry = Math.abs(h) / 2
  const out: Anchor[] = []
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
    const r = radiusAt(i)
    out.push(corner(cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r))
  }
  return out
}

/** The path a shape makes, in its node's own coordinates. */
export function shapePath(s: ShapeParams): PathData {
  switch (s.type) {
    case 'rect':
      return { fillRule: 'nonzero', subpaths: [{ closed: true, anchors: rectPath(s) }] }
    case 'ellipse':
      return { fillRule: 'nonzero', subpaths: [{ closed: true, anchors: ellipsePath(s.x, s.y, s.w, s.h) }] }
    case 'polygon':
      return { fillRule: 'nonzero', subpaths: [{ closed: true, anchors: radial(s.x, s.y, s.w, s.h, Math.max(3, Math.round(s.sides)), () => 1) }] }
    case 'star': {
      const n = Math.max(3, Math.round(s.points))
      return { fillRule: 'nonzero', subpaths: [{ closed: true, anchors: radial(s.x, s.y, s.w, s.h, n * 2, (i) => (i % 2 ? s.inner : 1)) }] }
    }
    case 'line':
      return { fillRule: 'nonzero', subpaths: [{ closed: false, anchors: [corner(s.x1, s.y1), corner(s.x2, s.y2)] }] }
  }
}

/** A new shape of a type filling the box (x0, y0)–(x1, y1); a line runs corner to corner. */
export function shapeInBox(type: ShapeType, x0: number, y0: number, x1: number, y1: number, o: { radius?: number; sides?: number; points?: number; inner?: number; corner?: CornerStyle } = {}): ShapeParams {
  const x = Math.min(x0, x1)
  const y = Math.min(y0, y1)
  const w = Math.abs(x1 - x0)
  const h = Math.abs(y1 - y0)
  switch (type) {
    case 'rect': {
      const r = o.radius ?? 0
      return { type, x, y, w, h, radii: [r, r, r, r], corner: o.corner ?? 'round' }
    }
    case 'ellipse':
      return { type, x, y, w, h }
    case 'polygon':
      return { type, x, y, w, h, sides: o.sides ?? 6 }
    case 'star':
      return { type, x, y, w, h, points: o.points ?? 5, inner: o.inner ?? 0.5 }
    case 'line':
      return { type, x1: x0, y1: y0, x2: x1, y2: y1 }
  }
}

/** A shape's box: x, y, w, h. */
export function shapeBox(s: ShapeParams): [number, number, number, number] {
  if (s.type === 'line') return [Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1)]
  return [s.x, s.y, s.w, s.h]
}

/** A shape moved and sized to a new box, keeping what makes it what it is (a line keeps its direction). */
export function withBox(s: ShapeParams, x: number, y: number, w: number, h: number): ShapeParams {
  if (s.type !== 'line') return { ...s, x, y, w: Math.max(0, w), h: Math.max(0, h) }
  const [bx, by, bw, bh] = shapeBox(s)
  const fx = (v: number) => x + (bw ? ((v - bx) / bw) * w : 0)
  const fy = (v: number) => y + (bh ? ((v - by) / bh) * h : 0)
  return { ...s, x1: fx(s.x1), y1: fy(s.y1), x2: fx(s.x2), y2: fy(s.y2) }
}

const num = (v: unknown, d: number, lo = -1e7, hi = 1e7) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
const CORNERS: CornerStyle[] = ['round', 'chamfer', 'inset']

/** A shape's parameters read back from a file, every field in range; null when it isn't one. */
export function readShape(raw: unknown): ShapeParams | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const box = { x: num(r.x, 0), y: num(r.y, 0), w: num(r.w, 100, 0), h: num(r.h, 100, 0) }
  switch (r.type) {
    case 'rect': {
      const radii = Array.isArray(r.radii) ? r.radii : []
      return {
        type: 'rect',
        ...box,
        radii: [0, 1, 2, 3].map((i) => num(radii[i], 0, 0)) as [number, number, number, number],
        corner: CORNERS.includes(r.corner as CornerStyle) ? (r.corner as CornerStyle) : 'round',
      }
    }
    case 'ellipse':
      return { type: 'ellipse', ...box }
    case 'polygon':
      return { type: 'polygon', ...box, sides: Math.round(num(r.sides, 6, 3, 100)) }
    case 'star':
      return { type: 'star', ...box, points: Math.round(num(r.points, 5, 3, 100)), inner: num(r.inner, 0.5, 0.01, 1) }
    case 'line':
      return { type: 'line', x1: num(r.x1, 0), y1: num(r.y1, 0), x2: num(r.x2, 100), y2: num(r.y2, 0) }
    default:
      return null
  }
}
