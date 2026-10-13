/**
 * Booleans on paths, curve-preserving (ARCHITECTURE.md, "Geometry"): add,
 * subtract, intersect and exclude, done on the curves themselves, the way
 * paper.js does it, so Expand gives back curves rather than polygons.
 *
 * 1. Every curve of every operand is cut where its direction turns in x or
 *    y, so each piece is monotone: its box is its ends, and a horizontal
 *    line crosses it at most once.
 * 2. Pieces are cut again wherever they cross or touch another piece
 *    (found by subdividing until both are flat, then refined with Newton).
 * 3. Each resulting edge is judged by the winding numbers just either side
 *    of its middle: kept when the result is inside on one side and outside
 *    on the other, and turned so the inside is on its left.
 * 4. Kept edges are chained into closed loops, and edges that are
 *    neighbouring parts of one original curve are joined back into it.
 *
 * The result fills correctly with the nonzero rule: outlines one way round,
 * holes the other. check-geom compares random cases with a sampled
 * reference, area and inside-ness both.
 */
import {
  evalCubic,
  extremaOf,
  isLine,
  segmentsOf,
  splitCubic,
  subCubic,
  subpathFromCubics,
  tangentAt,
  type Cubic,
  type FillRule,
  type PathData,
  type Pt,
  type Subpath,
} from './path'

export type BoolOp = 'add' | 'subtract' | 'intersect' | 'exclude'

export interface Operand {
  path: PathData
  /** How it combines with everything below it; the first operand's is ignored. */
  op: BoolOp
}

interface Piece {
  /** Which operand it belongs to. */
  k: number
  /** The curve it came from, and where on it. */
  src: number
  t0: number
  t1: number
  c: Cubic
  /** Monotone: y runs from c[1] to c[7], x from c[0] to c[6]. */
  splits: number[]
}

interface Edge {
  k: number
  src: number
  t0: number
  t1: number
  c: Cubic
}

/** Every closed outline of a path's subpaths as cubics; an open subpath is closed with a straight line, as filling does. */
function closedCurves(path: PathData): Cubic[][] {
  const out: Cubic[][] = []
  for (const s of path.subpaths) {
    if (s.anchors.length < 2) continue
    const cs = segmentsOf({ closed: s.closed, anchors: s.anchors })
    if (!s.closed) {
      const a = s.anchors[s.anchors.length - 1].p
      const b = s.anchors[0].p
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-12) cs.push([a[0], a[1], a[0], a[1], b[0], b[1], b[0], b[1]])
    }
    out.push(cs.filter((c) => Math.abs(c[0] - c[6]) + Math.abs(c[1] - c[7]) + Math.abs(c[2] - c[0]) + Math.abs(c[3] - c[1]) + Math.abs(c[4] - c[6]) + Math.abs(c[5] - c[7]) > 1e-12))
  }
  return out
}

/** A curve cut into pieces monotone in x and y, as t ranges. */
function monotoneRanges(c: Cubic): [number, number][] {
  const ts = [...extremaOf(c, 0), ...extremaOf(c, 1)].sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-9)
  const cuts = [0, ...ts, 1]
  const out: [number, number][] = []
  for (let i = 0; i + 1 < cuts.length; i++) if (cuts[i + 1] - cuts[i] > 1e-9) out.push([cuts[i], cuts[i + 1]])
  return out
}

const boxOf = (c: Cubic) => [Math.min(c[0], c[6]), Math.min(c[1], c[7]), Math.max(c[0], c[6]), Math.max(c[1], c[7])]
/** The box round any cubic, from its control points: loose but safe. */
const hullBox = (c: Cubic) => [Math.min(c[0], c[2], c[4], c[6]), Math.min(c[1], c[3], c[5], c[7]), Math.max(c[0], c[2], c[4], c[6]), Math.max(c[1], c[3], c[5], c[7])]

/** How far a cubic's handles are from its chord. */
function flatness(c: Cubic): number {
  const dx = c[6] - c[0]
  const dy = c[7] - c[1]
  const l = Math.hypot(dx, dy)
  if (l < 1e-12) return Math.max(Math.hypot(c[2] - c[0], c[3] - c[1]), Math.hypot(c[4] - c[0], c[5] - c[1]))
  const d1 = Math.abs((c[2] - c[0]) * dy - (c[3] - c[1]) * dx) / l
  const d2 = Math.abs((c[4] - c[0]) * dy - (c[5] - c[1]) * dx) / l
  return Math.max(d1, d2)
}

/** Refines (ta, tb) where two curves meet, by Newton's method on their difference. */
function refine(a: Cubic, b: Cubic, ta: number, tb: number): [number, number, number] {
  let s = ta
  let u = tb
  for (let i = 0; i < 8; i++) {
    const pa = evalCubic(a, s)
    const pb = evalCubic(b, u)
    const fx = pa[0] - pb[0]
    const fy = pa[1] - pb[1]
    const da = tangentAt(a, s)
    const db = tangentAt(b, u)
    // J = [da, −db]; solve J·[ds, du] = −f.
    const det = da[0] * -db[1] - -db[0] * da[1]
    if (Math.abs(det) < 1e-18) break
    const ds = (-fx * -db[1] - -db[0] * -fy) / det
    const du = (da[0] * -fy - -fx * da[1]) / det
    s = Math.min(1, Math.max(0, s + ds))
    u = Math.min(1, Math.max(0, u + du))
    if (Math.abs(ds) + Math.abs(du) < 1e-14) break
  }
  const pa = evalCubic(a, s)
  const pb = evalCubic(b, u)
  return [s, u, Math.hypot(pa[0] - pb[0], pa[1] - pb[1])]
}

/** Where two pieces meet, as parameters on each (0..1 along the piece). */
function intersections(a: Cubic, b: Cubic, tol: number, eps: number, out: [number, number][]) {
  let budget = 4096
  const add = (s: number, u: number) => {
    const [rs, ru, d] = refine(a, b, s, u)
    out.push(d < eps ? [rs, ru] : [s, u])
  }
  const lineLine = (ca: Cubic, sa0: number, sa1: number, cb: Cubic, sb0: number, sb1: number) => {
    const ax = ca[6] - ca[0]
    const ay = ca[7] - ca[1]
    const bx = cb[6] - cb[0]
    const by = cb[7] - cb[1]
    const den = ax * by - ay * bx
    const la = Math.hypot(ax, ay)
    const lb = Math.hypot(bx, by)
    const wx = cb[0] - ca[0]
    const wy = cb[1] - ca[1]
    if (Math.abs(den) <= 1e-12 * la * lb) {
      // Parallel: if they lie on one line, where each one's ends fall on the other.
      if (la < 1e-15 || Math.abs(wx * ay - wy * ax) / la > tol) return
      const pa = (x: number, y: number) => ((x - ca[0]) * ax + (y - ca[1]) * ay) / (la * la)
      const pb = (x: number, y: number) => (lb < 1e-15 ? 0 : ((x - cb[0]) * bx + (y - cb[1]) * by) / (lb * lb))
      const cand: [number, number][] = [
        [0, pb(ca[0], ca[1])],
        [1, pb(ca[6], ca[7])],
        [pa(cb[0], cb[1]), 0],
        [pa(cb[6], cb[7]), 1],
      ]
      for (const [s, u] of cand) if (s >= -1e-9 && s <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) add(sa0 + (sa1 - sa0) * Math.min(1, Math.max(0, s)), sb0 + (sb1 - sb0) * Math.min(1, Math.max(0, u)))
      return
    }
    const s = (wx * by - wy * bx) / den
    const u = (wx * ay - wy * ax) / den
    const slack = 1e-7
    if (s < -slack || s > 1 + slack || u < -slack || u > 1 + slack) return
    add(sa0 + (sa1 - sa0) * Math.min(1, Math.max(0, s)), sb0 + (sb1 - sb0) * Math.min(1, Math.max(0, u)))
  }
  const recurse = (ca: Cubic, sa0: number, sa1: number, cb: Cubic, sb0: number, sb1: number, depth: number) => {
    if (--budget < 0) return
    const ba = hullBox(ca)
    const bb = hullBox(cb)
    if (ba[0] > bb[2] + eps || bb[0] > ba[2] + eps || ba[1] > bb[3] + eps || bb[1] > ba[3] + eps) return
    const fa = flatness(ca) <= tol
    const fb = flatness(cb) <= tol
    if ((fa && fb) || depth > 40) {
      lineLine(ca, sa0, sa1, cb, sb0, sb1)
      return
    }
    const sizeA = Math.max(ba[2] - ba[0], ba[3] - ba[1])
    const sizeB = Math.max(bb[2] - bb[0], bb[3] - bb[1])
    if (!fa && (fb || sizeA >= sizeB)) {
      const [l, r] = splitCubic(ca, 0.5)
      const m = (sa0 + sa1) / 2
      recurse(l, sa0, m, cb, sb0, sb1, depth + 1)
      recurse(r, m, sa1, cb, sb0, sb1, depth + 1)
    } else {
      const [l, r] = splitCubic(cb, 0.5)
      const m = (sb0 + sb1) / 2
      recurse(ca, sa0, sa1, l, sb0, m, depth + 1)
      recurse(ca, sa0, sa1, r, m, sb1, depth + 1)
    }
  }
  recurse(a, 0, 1, b, 0, 1, 0)
}

/** The x where a monotone piece is at height y (it must span y). */
function xAtY(c: Cubic, y: number): number {
  if (isLine(c)) return c[0] + ((c[6] - c[0]) * (y - c[1])) / (c[7] - c[1])
  let lo = 0
  let hi = 1
  const up = c[7] > c[1]
  for (let i = 0; i < 52; i++) {
    const m = (lo + hi) / 2
    const py = evalCubic(c, m)[1]
    if (py < y === up) lo = m
    else hi = m
  }
  return evalCubic(c, (lo + hi) / 2)[0]
}

/** An operand's winding number at a point, from its monotone pieces. */
function windingOf(pieces: Piece[], x: number, y: number): number {
  let wn = 0
  for (const p of pieces) {
    const y0 = p.c[1]
    const y1 = p.c[7]
    if (y0 === y1 || y0 <= y === y1 <= y) continue
    if (Math.max(p.c[0], p.c[6]) < x) {
      wn += y1 > y0 ? 1 : -1
      continue
    }
    if (Math.min(p.c[0], p.c[6]) >= x) continue
    if (xAtY(p.c, y) < x) wn += y1 > y0 ? 1 : -1
  }
  return wn
}

const insideBy = (wn: number, rule: FillRule) => (rule === 'evenodd' ? (wn & 1) !== 0 : wn !== 0)

function combine(ins: boolean[], ops: BoolOp[]): boolean {
  let r = ins[0]
  for (let k = 1; k < ins.length; k++) {
    const v = ins[k]
    switch (ops[k]) {
      case 'add':
        r = r || v
        break
      case 'subtract':
        r = r && !v
        break
      case 'intersect':
        r = r && v
        break
      case 'exclude':
        r = r !== v
        break
    }
  }
  return r
}

/**
 * The operands combined, bottom first: each adds to, subtracts from,
 * intersects or excludes what's below it. One operand alone comes back
 * tidied: its overlaps resolved into plain outlines and holes.
 */
export function booleanPaths(operands: Operand[]): PathData {
  const ops = operands.map((o) => o.op)
  const rules = operands.map((o) => o.path.fillRule)
  // Scale, for the tolerances.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const curves: { k: number; c: Cubic }[] = []
  operands.forEach((o, k) => {
    for (const loop of closedCurves(o.path))
      for (const c of loop) {
        curves.push({ k, c })
        const b = hullBox(c)
        minX = Math.min(minX, b[0])
        minY = Math.min(minY, b[1])
        maxX = Math.max(maxX, b[2])
        maxY = Math.max(maxY, b[3])
      }
  })
  if (!curves.length) return { subpaths: [], fillRule: 'nonzero' }
  const scale = Math.max(maxX - minX, maxY - minY, 1e-6)
  const flatTol = scale * 1e-5
  const merge = scale * 1e-7

  // 1. Monotone pieces.
  const pieces: Piece[] = []
  curves.forEach(({ k, c }, src) => {
    for (const [t0, t1] of monotoneRanges(c)) pieces.push({ k, src, t0, t1, c: subCubic(c, t0, t1), splits: [] })
  })
  const byOperand = operands.map((_, k) => pieces.filter((p) => p.k === k))

  // 2. Where pieces meet.
  for (let i = 0; i < pieces.length; i++) {
    const a = pieces[i]
    const ba = boxOf(a.c)
    for (let j = i + 1; j < pieces.length; j++) {
      const b = pieces[j]
      const bb = boxOf(b.c)
      if (ba[0] > bb[2] + merge || bb[0] > ba[2] + merge || ba[1] > bb[3] + merge || bb[1] > ba[3] + merge) continue
      const found: [number, number][] = []
      intersections(a.c, b.c, flatTol, merge, found)
      for (const [s, u] of found) {
        a.splits.push(s)
        b.splits.push(u)
      }
    }
  }

  // Edges: pieces cut at their splits.
  const edges: Edge[] = []
  for (const p of pieces) {
    const ts = [0, ...p.splits.filter((t) => t > 1e-9 && t < 1 - 1e-9).sort((a, b) => a - b), 1]
    let prev = 0
    for (let i = 1; i < ts.length; i++) {
      const t = ts[i]
      const a = evalCubic(p.c, prev)
      const b = evalCubic(p.c, t)
      if (t - prev < 1e-9 || (Math.hypot(a[0] - b[0], a[1] - b[1]) < merge && t < 1)) continue
      const sub = subCubic(p.c, prev, t)
      const span = p.t1 - p.t0
      edges.push({ k: p.k, src: p.src, t0: p.t0 + span * prev, t1: p.t0 + span * t, c: sub })
      prev = t
    }
  }

  // Vertices: edge ends snapped together.
  const verts: Pt[] = []
  const grid = new Map<string, number[]>()
  const cell = merge * 64
  const vertexAt = (x: number, y: number): number => {
    const gx = Math.floor(x / cell)
    const gy = Math.floor(y / cell)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const v of grid.get(`${gx + dx},${gy + dy}`) ?? []) if (Math.hypot(verts[v][0] - x, verts[v][1] - y) <= merge * 32) return v
    verts.push([x, y])
    const key = `${gx},${gy}`
    grid.set(key, [...(grid.get(key) ?? []), verts.length - 1])
    return verts.length - 1
  }

  // 3. Keep edges with the result inside on one side only, inside on the left.
  const delta = scale * 1e-6
  type Kept = { from: number; to: number; c: Cubic; src: number; t0: number; t1: number; used: boolean }
  const kept: Kept[] = []
  const seen = new Set<string>()
  for (const e of edges) {
    const m = evalCubic(e.c, 0.5)
    const tg = tangentAt(e.c, 0.5)
    const tl = Math.hypot(tg[0], tg[1]) || 1
    const nx = -tg[1] / tl
    const ny = tg[0] / tl
    const side = (s: number) => combine(byOperand.map((ps, k) => insideBy(windingOf(ps, m[0] + nx * delta * s, m[1] + ny * delta * s), rules[k])), ops)
    const left = side(1)
    const right = side(-1)
    if (left === right) continue
    let c = e.c
    let t0 = e.t0
    let t1 = e.t1
    if (!left) {
      c = [c[6], c[7], c[4], c[5], c[2], c[3], c[0], c[1]]
      ;[t0, t1] = [t1, t0]
    }
    const from = vertexAt(c[0], c[1])
    const to = vertexAt(c[6], c[7])
    if (from === to && Math.hypot(c[2] - c[0], c[3] - c[1]) + Math.hypot(c[4] - c[0], c[5] - c[1]) < merge) continue
    // The same edge from two operands lying on each other: once is enough.
    const mid = evalCubic(c, 0.5)
    const sig = `${from}>${to}@${Math.round(mid[0] / (merge * 64))},${Math.round(mid[1] / (merge * 64))}`
    if (seen.has(sig)) continue
    seen.add(sig)
    kept.push({ from, to, c, src: e.src, t0, t1, used: false })
  }

  // 4. Chain into loops.
  const outgoing = new Map<number, Kept[]>()
  for (const e of kept) outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e])
  const angleOut = (e: Kept) => {
    const t = tangentAt(e.c, 0)
    return Math.atan2(t[1], t[0])
  }
  const angleIn = (e: Kept) => {
    const t = tangentAt(e.c, 1)
    return Math.atan2(t[1], t[0])
  }
  const subpaths: Subpath[] = []
  for (const start of kept) {
    if (start.used) continue
    const loop: Kept[] = []
    let e: Kept | undefined = start
    while (e && !e.used) {
      e.used = true
      loop.push(e)
      if (e.to === start.from) break
      const options: Kept[] = (outgoing.get(e.to) ?? []).filter((x) => !x.used)
      if (options.length <= 1) e = options[0]
      else {
        // Where several leave one point, take the sharpest turn towards the
        // inside (on the left): the loop hugs what it bounds and stays simple.
        const a = angleIn(e)
        const turn = (x: Kept) => {
          let d = angleOut(x) - a
          while (d <= -Math.PI) d += 2 * Math.PI
          while (d > Math.PI) d -= 2 * Math.PI
          return d
        }
        e = options.reduce((best, x) => (turn(x) > turn(best) ? x : best))
      }
    }
    if (loop.length < 1) continue
    // Neighbouring parts of one curve, joined back.
    const joined: Kept[] = []
    for (const x of loop) {
      const prev = joined[joined.length - 1]
      if (prev && prev.src === x.src && Math.abs(prev.t1 - x.t0) < 1e-9) {
        const src = curves[x.src].c
        const lo = Math.min(prev.t0, x.t1)
        const hi = Math.max(prev.t0, x.t1)
        let c = subCubic(src, lo, hi)
        if (prev.t0 > x.t1) c = [c[6], c[7], c[4], c[5], c[2], c[3], c[0], c[1]]
        joined[joined.length - 1] = { ...prev, c, t1: x.t1, to: x.to }
      } else joined.push({ ...x })
    }
    // And across the loop's seam.
    if (joined.length > 1) {
      const first = joined[0]
      const last = joined[joined.length - 1]
      if (first.src === last.src && Math.abs(last.t1 - first.t0) < 1e-9) {
        const src = curves[first.src].c
        const lo = Math.min(last.t0, first.t1)
        const hi = Math.max(last.t0, first.t1)
        let c = subCubic(src, lo, hi)
        if (last.t0 > first.t1) c = [c[6], c[7], c[4], c[5], c[2], c[3], c[0], c[1]]
        joined[0] = { ...first, c, t0: last.t0 }
        joined.pop()
      }
    }
    // Snap each edge's ends onto its shared vertices, so the loop closes exactly.
    const cs = joined.map((x) => {
      const c = [...x.c] as Cubic
      const a = verts[x.from]
      const b = verts[x.to]
      const dax = a[0] - c[0]
      const day = a[1] - c[1]
      const dbx = b[0] - c[6]
      const dby = b[1] - c[7]
      return [a[0], a[1], c[2] + dax, c[3] + day, c[4] + dbx, c[5] + dby, b[0], b[1]] as Cubic
    })
    if (cs.length === 1 && isLine(cs[0])) continue
    subpaths.push(subpathFromCubics(cs, true))
  }
  return { subpaths, fillRule: 'nonzero' }
}
