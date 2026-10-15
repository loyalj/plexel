/**
 * Paths: cubic béziers in subpaths, open or closed, with a fill rule
 * (ARCHITECTURE.md, "Geometry"). Plain JSON, so a path goes in a document
 * as it is.
 *
 * A path is a list of anchors, each with the handles either side of it in
 * absolute coordinates, the way the Pen tool and node editing think of it.
 * A missing handle sits on its anchor, which makes the segment next to it
 * straight at that end. Everything that draws a path works from its
 * segments: cubics of four points, flattened into lines as finely as the
 * scale they're drawn at needs.
 *
 * Pure and DOM-free; check-geom runs all of it in Node.
 */

export type Pt = [number, number]

export interface Anchor {
  p: Pt
  /** The handle the segment arriving here leaves from; null sits on the anchor. */
  in: Pt | null
  /** The handle the segment leaving here starts towards; null sits on the anchor. */
  out: Pt | null
  /** Its handles stay in line when one is dragged: a smooth point, not a corner. */
  smooth: boolean
}

export interface Subpath {
  closed: boolean
  anchors: Anchor[]
}

export type FillRule = 'nonzero' | 'evenodd'

export interface PathData {
  subpaths: Subpath[]
  fillRule: FillRule
}

/** A cubic as eight numbers: p0, c1, c2, p3. */
export type Cubic = [number, number, number, number, number, number, number, number]

/** A 2D affine, `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Mat = readonly number[]

export const EMPTY_PATH: PathData = { subpaths: [], fillRule: 'nonzero' }

export const anchor = (x: number, y: number, inH: Pt | null = null, outH: Pt | null = null, smooth = false): Anchor => ({ p: [x, y], in: inH, out: outH, smooth })

export const applyMat = (m: Mat, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

/** The segments of a subpath, in order, the closing one included when it's closed. */
export function segmentsOf(s: Subpath): Cubic[] {
  const a = s.anchors
  const out: Cubic[] = []
  const n = a.length
  if (n < 2) return out
  const last = s.closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const p = a[i]
    const q = a[(i + 1) % n]
    const c1 = p.out ?? p.p
    const c2 = q.in ?? q.p
    out.push([p.p[0], p.p[1], c1[0], c1[1], c2[0], c2[1], q.p[0], q.p[1]])
  }
  return out
}

/** Whether a cubic is a straight line from its start to its end (handles on the line, between the ends). */
export function isLine(c: Cubic, eps = 1e-9): boolean {
  const dx = c[6] - c[0]
  const dy = c[7] - c[1]
  const len2 = dx * dx + dy * dy
  const off = (x: number, y: number) => {
    if (len2 < eps) return Math.hypot(x - c[0], y - c[1])
    return Math.abs((x - c[0]) * dy - (y - c[1]) * dx) / Math.sqrt(len2)
  }
  const along = (x: number, y: number) => (len2 < eps ? 0 : ((x - c[0]) * dx + (y - c[1]) * dy) / len2)
  const t1 = along(c[2], c[3])
  const t2 = along(c[4], c[5])
  return off(c[2], c[3]) <= Math.sqrt(eps) && off(c[4], c[5]) <= Math.sqrt(eps) && t1 >= -1e-9 && t1 <= 1 + 1e-9 && t2 >= -1e-9 && t2 <= 1 + 1e-9
}

export function evalCubic(c: Cubic, t: number): Pt {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const d = 3 * u * t * t
  const e = t * t * t
  return [a * c[0] + b * c[2] + d * c[4] + e * c[6], a * c[1] + b * c[3] + d * c[5] + e * c[7]]
}

/** The derivative at t (not normalised). */
export function tangentAt(c: Cubic, t: number): Pt {
  const u = 1 - t
  const x = 3 * u * u * (c[2] - c[0]) + 6 * u * t * (c[4] - c[2]) + 3 * t * t * (c[6] - c[4])
  const y = 3 * u * u * (c[3] - c[1]) + 6 * u * t * (c[5] - c[3]) + 3 * t * t * (c[7] - c[5])
  if (Math.abs(x) + Math.abs(y) > 1e-12) return [x, y]
  // A handle on its anchor: the direction comes from the next point along.
  const p = evalCubic(c, t < 0.5 ? t + 1e-3 : t)
  const q = evalCubic(c, t < 0.5 ? t : t - 1e-3)
  return t < 0.5 ? [p[0] - c[0], p[1] - c[1]] : [c[6] - q[0], c[7] - q[1]]
}

/** Splits a cubic at t (de Casteljau). */
export function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const lerp = (a: number, b: number) => a + (b - a) * t
  const x01 = lerp(c[0], c[2])
  const y01 = lerp(c[1], c[3])
  const x12 = lerp(c[2], c[4])
  const y12 = lerp(c[3], c[5])
  const x23 = lerp(c[4], c[6])
  const y23 = lerp(c[5], c[7])
  const xa = lerp(x01, x12)
  const ya = lerp(y01, y12)
  const xb = lerp(x12, x23)
  const yb = lerp(y12, y23)
  const xm = lerp(xa, xb)
  const ym = lerp(ya, yb)
  return [
    [c[0], c[1], x01, y01, xa, ya, xm, ym],
    [xm, ym, xb, yb, x23, y23, c[6], c[7]],
  ]
}

/** The part of a cubic between t0 and t1. */
export function subCubic(c: Cubic, t0: number, t1: number): Cubic {
  if (t0 <= 0 && t1 >= 1) return c
  let r = c
  if (t1 < 1) r = splitCubic(r, t1)[0]
  if (t0 > 0) r = splitCubic(r, t0 / Math.max(t1, 1e-12))[1]
  return r
}

export const reverseCubic = (c: Cubic): Cubic => [c[6], c[7], c[4], c[5], c[2], c[3], c[0], c[1]]

function transformCubic(c: Cubic, m: Mat): Cubic {
  const out = [...c] as Cubic
  for (let i = 0; i < 8; i += 2) {
    out[i] = m[0] * c[i] + m[2] * c[i + 1] + m[4]
    out[i + 1] = m[1] * c[i] + m[3] * c[i + 1] + m[5]
  }
  return out
}

/** The roots in (0, 1) of a·t² + b·t + c. */
function quadRoots(a: number, b: number, c: number): number[] {
  const out: number[] = []
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) out.push(-c / b)
  } else {
    const d = b * b - 4 * a * c
    if (d >= 0) {
      const s = Math.sqrt(d)
      out.push((-b + s) / (2 * a), (-b - s) / (2 * a))
    }
  }
  return out.filter((t) => t > 1e-9 && t < 1 - 1e-9)
}

/** Where a cubic turns in x (axis 0) or y (axis 1): the t values of its extremes. */
export function extremaOf(c: Cubic, axis: 0 | 1): number[] {
  const p0 = c[axis]
  const p1 = c[axis + 2]
  const p2 = c[axis + 4]
  const p3 = c[axis + 6]
  // d/dt of the cubic, over 3: a t² + b t + c.
  const a = -p0 + 3 * p1 - 3 * p2 + p3
  const b = 2 * (p0 - 2 * p1 + p2)
  const cc = p1 - p0
  return quadRoots(a, b, cc)
}

export type Box = [number, number, number, number]

/** The exact box round a cubic. */
export function cubicBounds(c: Cubic): Box {
  let x0 = Math.min(c[0], c[6])
  let x1 = Math.max(c[0], c[6])
  let y0 = Math.min(c[1], c[7])
  let y1 = Math.max(c[1], c[7])
  for (const t of extremaOf(c, 0)) {
    const [x] = evalCubic(c, t)
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
  }
  for (const t of extremaOf(c, 1)) {
    const [, y] = evalCubic(c, t)
    y0 = Math.min(y0, y)
    y1 = Math.max(y1, y)
  }
  return [x0, y0, x1, y1]
}

export const unionBox = (a: Box | null, b: Box | null): Box | null => (!a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])])

/** The exact box round a path's outline (its anchors, and its curves' extremes), through `m` when given; null when it's empty. */
export function pathBounds(path: PathData, m?: Mat): Box | null {
  let box: Box | null = null
  for (const s of path.subpaths) {
    if (s.anchors.length === 1) {
      const [x, y] = m ? applyMat(m, ...s.anchors[0].p) : s.anchors[0].p
      box = unionBox(box, [x, y, x, y])
    }
    for (const c of segmentsOf(s)) box = unionBox(box, cubicBounds(m ? transformCubic(c, m) : c))
  }
  return box
}

export function transformPath(path: PathData, m: Mat): PathData {
  const t = (p: Pt | null): Pt | null => (p ? applyMat(m, p[0], p[1]) : null)
  return {
    fillRule: path.fillRule,
    subpaths: path.subpaths.map((s) => ({ closed: s.closed, anchors: s.anchors.map((a) => ({ p: t(a.p)!, in: t(a.in), out: t(a.out), smooth: a.smooth })) })),
  }
}

/** Number of lines a cubic needs to stay within `tol` of the curve (Wang's formula). */
export function linesFor(c: Cubic, tol: number): number {
  const ddx = Math.max(Math.abs(c[0] - 2 * c[2] + c[4]), Math.abs(c[2] - 2 * c[4] + c[6]))
  const ddy = Math.max(Math.abs(c[1] - 2 * c[3] + c[5]), Math.abs(c[3] - 2 * c[5] + c[7]))
  const dd = Math.hypot(ddx, ddy)
  return Math.max(1, Math.min(4096, Math.ceil(Math.sqrt((0.75 * dd) / Math.max(tol, 1e-9)))))
}

/** A polyline: x, y pairs, and whether it closes back to its start. */
export interface Polyline {
  pts: number[]
  closed: boolean
  /** Which points (by index) are the path's corners: anchors whose two sides don't continue each other. For dashes aligned to corners. */
  corners?: number[]
}

/**
 * A path flattened into polylines, within `tol` of the curves (after `m`,
 * when given: affines keep béziers béziers, so the control points go
 * through it first and the tolerance is in the output's units).
 */
export function flattenPath(path: PathData, tol: number, m?: Mat): Polyline[] {
  const out: Polyline[] = []
  for (const s of path.subpaths) {
    if (!s.anchors.length) continue
    const first = m ? applyMat(m, ...s.anchors[0].p) : s.anchors[0].p
    const pts = [first[0], first[1]]
    const segs = segmentsOf(s)
    // Each anchor's point index, for marking the corners.
    const at: number[] = [0]
    for (const c0 of segs) {
      const c = m ? transformCubic(c0, m) : c0
      if (isLine(c)) {
        pts.push(c[6], c[7])
        at.push(pts.length / 2 - 1)
        continue
      }
      const n = linesFor(c, tol)
      for (let i = 1; i <= n; i++) {
        const [x, y] = evalCubic(c, i / n)
        pts.push(x, y)
      }
      at.push(pts.length / 2 - 1)
    }
    const corners: number[] = []
    const k = segs.length
    for (let j = 0; j < s.anchors.length && k; j++) {
      // The segment arriving at anchor j and the one leaving it; an open path's ends aren't corners.
      const inSeg = j > 0 ? segs[j - 1] : s.closed ? segs[k - 1] : null
      const outSeg = j < k ? segs[j] : null
      if (!inSeg || !outSeg) continue
      const ti = endTangent(inSeg)
      const to = startTangent(outSeg)
      if (ti && to && ti[0] * to[0] + ti[1] * to[1] < Math.cos((2 * Math.PI) / 180)) corners.push(j === 0 || (s.closed && j === k) ? 0 : at[j])
    }
    // A closed subpath's closing segment ends where it began; that point
    // is the start again, so it's dropped.
    if (s.closed && pts.length >= 4 && Math.abs(pts[pts.length - 2] - pts[0]) < 1e-9 && Math.abs(pts[pts.length - 1] - pts[1]) < 1e-9) pts.length -= 2
    out.push(corners.length ? { pts, closed: s.closed, corners } : { pts, closed: s.closed })
  }
  return out
}

/** A cubic's direction where it ends, and where it starts: through its nearest control point that isn't on the end. */
function endTangent(c: Cubic): Pt | null {
  for (const [x, y] of [
    [c[4], c[5]],
    [c[2], c[3]],
    [c[0], c[1]],
  ]) {
    const dx = c[6] - x
    const dy = c[7] - y
    const l = Math.hypot(dx, dy)
    if (l > 1e-9) return [dx / l, dy / l]
  }
  return null
}
function startTangent(c: Cubic): Pt | null {
  for (const [x, y] of [
    [c[2], c[3]],
    [c[4], c[5]],
    [c[6], c[7]],
  ]) {
    const dx = x - c[0]
    const dy = y - c[1]
    const l = Math.hypot(dx, dy)
    if (l > 1e-9) return [dx / l, dy / l]
  }
  return null
}

/** How much a transform stretches anything at most: its largest singular value. */
export function maxScale(m: Mat): number {
  const a = m[0]
  const b = m[1]
  const c = m[2]
  const d = m[3]
  const s1 = a * a + b * b + c * c + d * d
  const s2 = Math.sqrt((a * a + b * b - c * c - d * d) ** 2 + 4 * (a * c + b * d) ** 2)
  return Math.sqrt((s1 + s2) / 2)
}

/** A path's anchor count, for the Properties panel. */
export const anchorCount = (path: PathData) => path.subpaths.reduce((n, s) => n + s.anchors.length, 0)

/** The signed area of a polyline (positive clockwise in y-down coordinates). */
export function polyArea(pts: ArrayLike<number>): number {
  let a = 0
  const n = pts.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    a += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1]
  }
  return a / 2
}

/** A subpath turned round: same outline, the other way. */
export function reverseSubpath(s: Subpath): Subpath {
  return { closed: s.closed, anchors: [...s.anchors].reverse().map((a) => ({ p: a.p, in: a.out, out: a.in, smooth: a.smooth })) }
}

/** A subpath from cubics end to end, closed or not. Straight segments get no handles. */
export function subpathFromCubics(cs: Cubic[], closed: boolean): Subpath {
  const anchors: Anchor[] = []
  if (!cs.length) return { closed, anchors }
  const handle = (x: number, y: number, ax: number, ay: number): Pt | null => (Math.abs(x - ax) < 1e-12 && Math.abs(y - ay) < 1e-12 ? null : [x, y])
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]
    const line = isLine(c)
    if (i === 0) anchors.push({ p: [c[0], c[1]], in: null, out: line ? null : handle(c[2], c[3], c[0], c[1]), smooth: false })
    else anchors[anchors.length - 1].out = line ? null : handle(c[2], c[3], c[0], c[1])
    const end = { p: [c[6], c[7]] as Pt, in: line ? null : handle(c[4], c[5], c[6], c[7]), out: null, smooth: false }
    if (closed && i === cs.length - 1) anchors[0].in = end.in
    else anchors.push(end)
  }
  // A point is smooth when its handles are in line.
  for (const a of anchors) {
    if (!a.in || !a.out) continue
    const ix = a.p[0] - a.in[0]
    const iy = a.p[1] - a.in[1]
    const ox = a.out[0] - a.p[0]
    const oy = a.out[1] - a.p[1]
    const cross = ix * oy - iy * ox
    const dot = ix * ox + iy * oy
    a.smooth = dot > 0 && Math.abs(cross) <= 1e-6 * Math.hypot(ix, iy) * Math.hypot(ox, oy) + 1e-12
  }
  return { closed, anchors }
}
