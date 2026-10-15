/**
 * Regions where shapes overlap (ARCHITECTURE.md, "Geometry"): what
 * Pathfinder's Divide, the Shape Builder and Live Paint all work from.
 * Every area the shapes' outlines cut the plane into is a region, with the
 * shapes it's inside; worked out by the booleans (geom/boolean.ts), so the
 * regions' edges are the shapes' own curves.
 *
 * Also the path commands that work on one shape: Join, Simplify, Smooth.
 * Pure and DOM-free; check-geom runs it.
 */
import { booleanPaths } from './boolean'
import { anchor, flattenPath, pathBounds, polyArea, segmentsOf, evalCubic, type Box, type Cubic, type PathData, type Pt, type Subpath } from './path'

export interface Region {
  path: PathData
  /** Which of the shapes (by index, bottom first) it's inside. */
  inside: number[]
}

const empty = (p: PathData) => !p.subpaths.length || area(p) < 1e-6
/** A path's filled area (nonzero), from its outlines' signed areas. */
export function area(p: PathData): number {
  let a = 0
  for (const l of flattenPath(p, 0.05)) if (l.closed && l.pts.length >= 6) a += polyArea(l.pts)
  return Math.abs(a)
}

/**
 * Every region the shapes cut the plane into (inside at least one of
 * them), each connected one apart: the union cut again by each shape, into
 * what's in it and what isn't, then each split into its separate pieces.
 */
export function divide(paths: PathData[]): Region[] {
  let parts: { path: PathData; inside: number[] }[] = []
  paths.forEach((p, i) => {
    if (!p.subpaths.length) return
    const next: typeof parts = []
    // What this shape adds that nothing below has.
    let rest: PathData = { ...p, subpaths: p.subpaths.filter((s) => s.closed) }
    for (const r of parts) {
      const both = booleanPaths([
        { path: r.path, op: 'add' },
        { path: p, op: 'intersect' },
      ])
      const only = booleanPaths([
        { path: r.path, op: 'add' },
        { path: p, op: 'subtract' },
      ])
      if (!empty(both)) next.push({ path: both, inside: [...r.inside, i] })
      if (!empty(only)) next.push({ path: only, inside: r.inside })
      rest = booleanPaths([
        { path: rest, op: 'add' },
        { path: r.path, op: 'subtract' },
      ])
    }
    if (!empty(rest)) next.push({ path: rest, inside: [i] })
    parts = next
  })
  return parts.flatMap((r) => pieces(r.path).map((path) => ({ path, inside: r.inside })))
}

/**
 * A path's separate pieces: each outline with the holes inside it, the
 * nonzero result of the booleans (outlines one way round, holes the other).
 */
export function pieces(p: PathData): PathData[] {
  const loops = p.subpaths.filter((s) => s.closed)
  if (loops.length <= 1) return loops.length ? [{ subpaths: loops, fillRule: 'nonzero' }] : []
  const info = loops.map((s) => {
    const l = flattenPath({ subpaths: [s], fillRule: 'nonzero' }, 0.05)[0]
    return { s, pts: l.pts, a: polyArea(l.pts) }
  })
  // The outlines turn the way the biggest does; the rest are holes.
  const sign = Math.sign(info.reduce((m, x) => (Math.abs(x.a) > Math.abs(m.a) ? x : m)).a) || 1
  const outers = info.filter((x) => Math.sign(x.a) === sign)
  const out = outers.map((o) => ({ o, holes: [] as Subpath[] }))
  for (const h of info.filter((x) => Math.sign(x.a) !== sign)) {
    // The smallest outline round one of its points.
    const q: Pt = [h.pts[0], h.pts[1]]
    let best: (typeof out)[number] | null = null
    for (const c of out) if (insidePoly(c.o.pts, q) && (!best || Math.abs(c.o.a) < Math.abs(best.o.a))) best = c
    if (best) best.holes.push(h.s)
  }
  return out.map((c) => ({ subpaths: [c.o.s, ...c.holes], fillRule: 'nonzero' }))
}

function insidePoly(pts: number[], q: Pt): boolean {
  let c = false
  const n = pts.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i]
    const yi = pts[2 * i + 1]
    const xj = pts[2 * j]
    const yj = pts[2 * j + 1]
    if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/** Whether a point is inside a path (its fill rule). */
export function contains(p: PathData, q: Pt): boolean {
  let wn = 0
  let crossings = 0
  for (const l of flattenPath(p, 0.05)) {
    const n = l.pts.length / 2
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const x0 = l.pts[2 * i]
      const y0 = l.pts[2 * i + 1]
      const x1 = l.pts[2 * j]
      const y1 = l.pts[2 * j + 1]
      if (y0 <= q[1] !== y1 <= q[1]) {
        const x = x0 + ((q[1] - y0) * (x1 - x0)) / (y1 - y0)
        if (x > q[0]) {
          wn += y1 > y0 ? 1 : -1
          crossings++
        }
      }
    }
  }
  return p.fillRule === 'evenodd' ? crossings % 2 === 1 : wn !== 0
}

/** The region a point is in, or none. */
export const regionAt = (regions: Region[], q: Pt): number => regions.findIndex((r) => contains(r.path, q))

/** Regions combined into one path. */
export const unite = (paths: PathData[]): PathData => (paths.length === 1 ? paths[0] : booleanPaths(paths.map((path) => ({ path, op: 'add' as const }))))

export const boxOf = (paths: PathData[]): Box | null => paths.reduce<Box | null>((b, p) => {
  const q = pathBounds(p)
  return !q ? b : !b ? q : [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])]
}, null)

// --- Join, Simplify, Smooth ------------------------------------------------------------------------

/**
 * Join: a path's two open ends nearest each other joined with a straight
 * segment, two open subpaths becoming one; one open subpath alone is
 * closed. The path as it was when there's nothing to join.
 */
export function joinPath(p: PathData): PathData {
  const open = p.subpaths.map((s, i) => ({ s, i })).filter((x) => !x.s.closed && x.s.anchors.length >= 1)
  if (!open.length) return p
  if (open.length === 1) {
    if (open[0].s.anchors.length < 2) return p
    return { ...p, subpaths: p.subpaths.map((s, i) => (i === open[0].i ? { ...s, closed: true } : s)) }
  }
  // The pair of ends nearest each other, across two subpaths.
  let best = { d: Infinity, a: -1, b: -1, ae: 'end' as 'start' | 'end', be: 'start' as 'start' | 'end' }
  const ends = (s: Subpath) => ({ start: s.anchors[0].p, end: s.anchors[s.anchors.length - 1].p })
  for (let x = 0; x < open.length; x++)
    for (let y = 0; y < open.length; y++) {
      if (x === y) continue
      for (const ae of ['start', 'end'] as const)
        for (const be of ['start', 'end'] as const) {
          const pa = ends(open[x].s)[ae]
          const pb = ends(open[y].s)[be]
          const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1])
          if (d < best.d) best = { d, a: x, b: y, ae, be }
        }
    }
  const rev = (s: Subpath): Subpath => ({ closed: false, anchors: [...s.anchors].reverse().map((a) => ({ ...a, in: a.out, out: a.in })) })
  // A's end to B's start: A turned round if its start is the end that joins, B if its end is.
  const A = best.ae === 'end' ? open[best.a].s : rev(open[best.a].s)
  const B = best.be === 'start' ? open[best.b].s : rev(open[best.b].s)
  const joined: Subpath = { closed: false, anchors: [...A.anchors, ...B.anchors] }
  const keep = p.subpaths.filter((_, i) => i !== open[best.a].i && i !== open[best.b].i)
  return { ...p, subpaths: [...keep, joined] }
}

/** Smooth: every anchor's handles made in line, a third of the way to its neighbours (Catmull–Rom), corners and all. */
export function smoothPath(p: PathData): PathData {
  return {
    ...p,
    subpaths: p.subpaths.map((s) => {
      const n = s.anchors.length
      return {
        ...s,
        anchors: s.anchors.map((a, i) => {
          const prev = s.anchors[s.closed ? (i - 1 + n) % n : Math.max(0, i - 1)].p
          const next = s.anchors[s.closed ? (i + 1) % n : Math.min(n - 1, i + 1)].p
          const t: Pt = [(next[0] - prev[0]) / 6, (next[1] - prev[1]) / 6]
          const first = !s.closed && i === 0
          const last = !s.closed && i === n - 1
          return anchor(a.p[0], a.p[1], first ? null : [a.p[0] - t[0], a.p[1] - t[1]], last ? null : [a.p[0] + t[0], a.p[1] + t[1]], !first && !last)
        }),
      }
    }),
  }
}

/**
 * Simplify: a path redrawn with as few anchors as keep it within
 * `tolerance` of where it was (Schneider's curve fitting, from Graphics
 * Gems): its outline sampled, cut at its corners (turning more than
 * `corner` degrees), and each stretch fitted with as few cubics as do.
 */
export function simplifyPath(p: PathData, tolerance: number, corner = 60): PathData {
  const subpaths: Subpath[] = []
  for (const s of p.subpaths) {
    const pts = sampled(s, Math.max(tolerance / 4, 0.05))
    if (pts.length < 3) {
      subpaths.push(s)
      continue
    }
    // Corners: where the line turns sharply.
    const n = pts.length
    const cos = Math.cos((corner * Math.PI) / 180)
    const isCorner = (i: number) => {
      if (!s.closed && (i === 0 || i === n - 1)) return true
      const a = pts[(i - 1 + n) % n]
      const b = pts[i]
      const c = pts[(i + 1) % n]
      const u = [b[0] - a[0], b[1] - a[1]]
      const v = [c[0] - b[0], c[1] - b[1]]
      const lu = Math.hypot(u[0], u[1]) || 1
      const lv = Math.hypot(v[0], v[1]) || 1
      return (u[0] * v[0] + u[1] * v[1]) / (lu * lv) < cos
    }
    const cut = pts.map((_, i) => i).filter(isCorner)
    const curves: Cubic[] = []
    if (s.closed && !cut.length) cut.push(0)
    const k = cut.length
    const runs = s.closed ? k : k - 1
    for (let r = 0; r < runs; r++) {
      const a = cut[r]
      const b = s.closed ? cut[(r + 1) % k] : cut[r + 1]
      const run: Pt[] = []
      for (let i = a; ; i = (i + 1) % n) {
        run.push(pts[i])
        if (i === b && run.length > 1) break
        if (run.length > n + 1) break
      }
      if (run.length < 2) continue
      fitCubics(run, tolerance, curves)
    }
    if (!curves.length) {
      subpaths.push(s)
      continue
    }
    const anchors = curves.map((c, i) => {
      const prev = curves[(i - 1 + curves.length) % curves.length]
      const inH: Pt | null = i === 0 && !s.closed ? null : [prev[4], prev[5]]
      return anchor(c[0], c[1], inH, [c[2], c[3]])
    })
    if (!s.closed) {
      const last = curves[curves.length - 1]
      anchors.push(anchor(last[6], last[7], [last[4], last[5]], null))
    }
    subpaths.push({ closed: s.closed, anchors })
  }
  return { ...p, subpaths }
}

/** A subpath's outline as points every `step` or so, its anchors among them. */
function sampled(s: Subpath, step: number): Pt[] {
  const out: Pt[] = []
  const segs = segmentsOf(s)
  if (!segs.length) return s.anchors.map((a) => a.p)
  for (const c of segs) {
    const len = Math.hypot(c[2] - c[0], c[3] - c[1]) + Math.hypot(c[4] - c[2], c[5] - c[3]) + Math.hypot(c[6] - c[4], c[7] - c[5])
    const m = Math.max(1, Math.min(200, Math.ceil(len / step)))
    for (let i = 0; i < m; i++) out.push(evalCubic(c, i / m))
  }
  if (!s.closed) {
    const c = segs[segs.length - 1]
    out.push([c[6], c[7]])
  }
  return out
}

/** Cubics through points, within `tol`, split where the fit is worst until each is (Schneider). Image Trace fits its boundaries with it too. */
export function fitCubics(pts: Pt[], tol: number, out: Cubic[], depth = 0) {
  if (pts.length === 2) {
    const [a, b] = pts
    out.push([a[0], a[1], a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3, a[0] + ((b[0] - a[0]) * 2) / 3, a[1] + ((b[1] - a[1]) * 2) / 3, b[0], b[1]])
    return
  }
  const n = pts.length
  const t1 = unit(sub(pts[1], pts[0]))
  const t2 = unit(sub(pts[n - 2], pts[n - 1]))
  // Chord-length parameters.
  const u = [0]
  for (let i = 1; i < n; i++) u.push(u[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const total = u[n - 1] || 1
  for (let i = 0; i < n; i++) u[i] /= total
  const c = fitOne(pts, u, t1, t2)
  let worst = 0
  let at = 0
  for (let i = 0; i < n; i++) {
    const q = evalCubic(c, u[i])
    const d = Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1])
    if (d > worst) {
      worst = d
      at = i
    }
  }
  if (worst <= tol || depth > 12 || n < 4) {
    out.push(c)
    return
  }
  const mid = Math.max(1, Math.min(n - 2, at))
  fitCubics(pts.slice(0, mid + 1), tol, out, depth + 1)
  fitCubics(pts.slice(mid), tol, out, depth + 1)
}

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]]
const unit = (v: Pt): Pt => {
  const l = Math.hypot(v[0], v[1]) || 1
  return [v[0] / l, v[1] / l]
}

/** One cubic from its ends and tangents, its handles' lengths by least squares. */
function fitOne(pts: Pt[], u: number[], t1: Pt, t2: Pt): Cubic {
  const p0 = pts[0]
  const p3 = pts[pts.length - 1]
  let c00 = 0
  let c01 = 0
  let c11 = 0
  let x0 = 0
  let x1 = 0
  for (let i = 0; i < pts.length; i++) {
    const t = u[i]
    const b0 = (1 - t) ** 3
    const b1 = 3 * t * (1 - t) ** 2
    const b2 = 3 * t * t * (1 - t)
    const b3 = t ** 3
    const a1: Pt = [t1[0] * b1, t1[1] * b1]
    const a2: Pt = [t2[0] * b2, t2[1] * b2]
    c00 += a1[0] * a1[0] + a1[1] * a1[1]
    c01 += a1[0] * a2[0] + a1[1] * a2[1]
    c11 += a2[0] * a2[0] + a2[1] * a2[1]
    const tmp: Pt = [pts[i][0] - (p0[0] * (b0 + b1) + p3[0] * (b2 + b3)), pts[i][1] - (p0[1] * (b0 + b1) + p3[1] * (b2 + b3))]
    x0 += a1[0] * tmp[0] + a1[1] * tmp[1]
    x1 += a2[0] * tmp[0] + a2[1] * tmp[1]
  }
  const det = c00 * c11 - c01 * c01
  const dist = Math.hypot(p3[0] - p0[0], p3[1] - p0[1])
  let a1 = det ? (x0 * c11 - c01 * x1) / det : 0
  let a2 = det ? (c00 * x1 - c01 * x0) / det : 0
  // Degenerate: a third of the way along, as Schneider does.
  if (!(a1 > 1e-6 * dist) || !(a2 > 1e-6 * dist)) a1 = a2 = dist / 3
  return [p0[0], p0[1], p0[0] + t1[0] * a1, p0[1] + t1[1] * a1, p3[0] + t2[0] * a2, p3[1] + t2[1] * a2, p3[0], p3[1]]
}
