/**
 * Freehand paths (the Pencil, the Paintbrush, the Blob Brush): a stroke of
 * pointer points fitted with curves, and a selected path redrawn by one,
 * as Illustrator's "Edit selected paths": the stroke drawn from near one
 * place on the path to near another replaces what's between them; drawn
 * on from an open end, it carries the path on.
 *
 * Pure and DOM-free; check-geom runs it in Node.
 */
import { anchor, evalCubic, segmentsOf, splitCubic, type Anchor, type Cubic, type Pt, type Subpath } from './path'
import { fitCubics } from './regions'

/** Points closer together than `min` dropped (the last kept), so a slow hand isn't a thousand points. */
function thinned(pts: Pt[], min: number): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const q = out[out.length - 1]
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= min) out.push(p)
  }
  const last = pts[pts.length - 1]
  if (out.length && last && out[out.length - 1] !== last) out.push(last)
  return out
}

/** A stroke's points as a subpath: curves within `tol` of them (larger is smoother), corners where it turns sharply. */
export function fitFreehand(pts: Pt[], tol: number, closed: boolean): Subpath {
  const t = thinned(pts, Math.max(0.01, tol / 4))
  if (closed && t.length > 2) {
    const a = t[0]
    const b = t[t.length - 1]
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) t.pop()
  }
  if (t.length < 2) return { closed: false, anchors: t.map((p) => anchor(p[0], p[1])) }
  if (t.length === 2) return { closed: false, anchors: t.map((p) => anchor(p[0], p[1])) }
  return { closed, anchors: fitPoints(t, closed && t.length > 2, Math.max(0.05, tol), 70) }
}

/**
 * Points fitted with curves, as Image Trace's boundaries and freehand
 * strokes are: corners kept where the line turns more than `cornerDeg`
 * degrees over a few points (so a hand's jitter or a pixel staircase
 * isn't a corner at every point), the points between smoothed and fitted
 * with cubics within `tol`. `closed` for a loop.
 */
export function fitPoints(pts: Pt[], closed: boolean, tol: number, cornerDeg: number): Anchor[] {
  const n = pts.length
  if (n < 2) return pts.map((p) => anchor(p[0], p[1]))
  // Corners by the chords a few points either side.
  const k = Math.max(2, Math.min(4, Math.floor(n / 4)))
  const cos = Math.cos((cornerDeg * Math.PI) / 180)
  const turn: number[] = new Array(n).fill(1)
  for (let i = 0; i < n; i++) {
    if (!closed && (i < 1 || i > n - 2)) continue
    const a = pts[closed ? (i - k + n) % n : Math.max(0, i - k)]
    const b = pts[i]
    const c = pts[closed ? (i + k) % n : Math.min(n - 1, i + k)]
    const ux = b[0] - a[0]
    const uy = b[1] - a[1]
    const vx = c[0] - b[0]
    const vy = c[1] - b[1]
    const lu = Math.hypot(ux, uy) || 1
    const lv = Math.hypot(vx, vy) || 1
    turn[i] = (ux * vx + uy * vy) / (lu * lv)
  }
  const cut: number[] = []
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) {
      cut.push(i)
      continue
    }
    if (turn[i] >= cos) continue
    // The sharpest of its neighbours only.
    let best = true
    for (let d = -k; d <= k && best; d++) {
      if (!d) continue
      const j = closed ? (i + d + n) % n : i + d
      if (j < 0 || j >= n) continue
      if (turn[j] < turn[i] || (turn[j] === turn[i] && j < i)) best = false
    }
    if (best) cut.push(i)
  }
  // A loop with no corner still needs somewhere to start: that start isn't a corner.
  const startIsCorner = cut.length > 0
  if (closed && !cut.length) cut.push(0)
  const curves: Cubic[] = []
  /** Which curves start at a corner (the rest join smoothly). */
  const atCorner = new Set<number>()
  const runs = closed ? cut.length : cut.length - 1
  for (let r = 0; r < runs; r++) {
    const a = cut[r]
    const b = closed ? cut[(r + 1) % cut.length] : cut[r + 1]
    const run: Pt[] = []
    for (let i = a; ; i = (i + 1) % n) {
      run.push([pts[i][0], pts[i][1]])
      if ((i === b && run.length > 1) || run.length > n + 1) break
    }
    // The staircase smoothed, its ends (corners) where they are.
    for (let pass = 0; pass < 3; pass++) {
      const prev = run.map((p) => [p[0], p[1]] as Pt)
      for (let i = 1; i < run.length - 1; i++) run[i] = [(prev[i - 1][0] + 2 * prev[i][0] + prev[i + 1][0]) / 4, (prev[i - 1][1] + 2 * prev[i][1] + prev[i + 1][1]) / 4]
    }
    if (run.length < 2) continue
    if (startIsCorner || !closed) atCorner.add(curves.length)
    fitCubics(run, tol, curves)
  }
  if (!curves.length) return pts.map((p) => anchor(p[0], p[1]))
  const anchors = curves.map((c, i) => {
    const prev = curves[(i - 1 + curves.length) % curves.length]
    const inH: Pt | null = i === 0 && !closed ? null : [prev[4], prev[5]]
    const outH: Pt = [c[2], c[3]]
    // Where two fitted curves meet inside a run, their handles lined up (each its own length): smooth, no kink.
    if (!inH || atCorner.has(i)) return anchor(c[0], c[1], inH, outH)
    const ix = c[0] - inH[0]
    const iy = c[1] - inH[1]
    const ox = outH[0] - c[0]
    const oy = outH[1] - c[1]
    const li = Math.hypot(ix, iy)
    const lo = Math.hypot(ox, oy)
    if (li < 1e-9 || lo < 1e-9) return anchor(c[0], c[1], inH, outH)
    let dx = ix / li + ox / lo
    let dy = iy / li + oy / lo
    const l = Math.hypot(dx, dy) || 1
    dx /= l
    dy /= l
    return anchor(c[0], c[1], [c[0] - dx * li, c[1] - dy * li], [c[0] + dx * lo, c[1] + dy * lo], true)
  })
  if (!closed) {
    const last = curves[curves.length - 1]
    anchors.push(anchor(last[6], last[7], [last[4], last[5]], null))
  }
  return anchors
}

/** A place on a subpath: which segment, how far along it (0..1), the point, how far it is from what was asked. */
export interface SubpathPlace {
  seg: number
  t: number
  p: Pt
  dist: number
}

/** The nearest place on a subpath to (x, y). */
export function nearestOnSubpath(s: Subpath, x: number, y: number): SubpathPlace | null {
  const segs = segmentsOf(s)
  if (!segs.length) return s.anchors.length ? { seg: 0, t: 0, p: s.anchors[0].p, dist: Math.hypot(s.anchors[0].p[0] - x, s.anchors[0].p[1] - y) } : null
  let best: SubpathPlace | null = null
  segs.forEach((c, seg) => {
    // Sampled, then refined round the best sample.
    let bt = 0
    let bd = Infinity
    const N = 32
    for (let i = 0; i <= N; i++) {
      const q = evalCubic(c, i / N)
      const d = Math.hypot(q[0] - x, q[1] - y)
      if (d < bd) (bd = d), (bt = i / N)
    }
    let step = 1 / N
    for (let k = 0; k < 20; k++) {
      step /= 2
      for (const t of [bt - step, bt + step]) {
        if (t < 0 || t > 1) continue
        const q = evalCubic(c, t)
        const d = Math.hypot(q[0] - x, q[1] - y)
        if (d < bd) (bd = d), (bt = t)
      }
    }
    if (!best || bd < best.dist) best = { seg, t: bt, p: evalCubic(c, bt), dist: bd }
  })
  return best
}

/** Cubics, end to end, as anchors (open: an anchor at each end; closed: the last end is the first). */
function cubicsToAnchors(cs: Cubic[], closed: boolean): Anchor[] {
  if (!cs.length) return []
  const out: Anchor[] = cs.map((c, i) => {
    const prev = i > 0 ? cs[i - 1] : closed ? cs[cs.length - 1] : null
    return anchor(c[0], c[1], prev ? [prev[4], prev[5]] : null, [c[2], c[3]])
  })
  if (!closed) {
    const last = cs[cs.length - 1]
    out.push(anchor(last[6], last[7], [last[4], last[5]], null))
  }
  return out
}

/** A place's order along an open subpath. */
const along = (p: SubpathPlace) => p.seg + p.t

/** The part of a segment from t0 to t1 (0 ≤ t0 < t1 ≤ 1). */
function part(c: Cubic, t0: number, t1: number): Cubic {
  if (t1 >= 1 - 1e-12) return t0 <= 1e-12 ? c : splitCubic(c, t0)[1]
  const head = splitCubic(c, t1)[0]
  return t0 <= 1e-12 ? head : splitCubic(head, t0 / t1)[1]
}

/** The drawn anchors with their first point moved to `a` and last to `b` (their handles with them), so the stroke meets the path. */
function pinned(drawn: Anchor[], a: Pt | null, b: Pt | null): Anchor[] {
  const out = drawn.map((x) => ({ ...x }))
  const move = (x: Anchor, to: Pt): Anchor => {
    const dx = to[0] - x.p[0]
    const dy = to[1] - x.p[1]
    return { ...x, p: [to[0], to[1]], in: x.in && [x.in[0] + dx, x.in[1] + dy], out: x.out && [x.out[0] + dx, x.out[1] + dy] }
  }
  if (a && out.length) out[0] = move(out[0], a)
  if (b && out.length) out[out.length - 1] = move(out[out.length - 1], b)
  return out
}

/** Two runs of anchors joined where one ends and the other starts (the same point): one anchor, its handle in from the first, out to the second. */
function joined(a: Anchor[], b: Anchor[]): Anchor[] {
  if (!a.length) return b
  if (!b.length) return a
  const last = a[a.length - 1]
  return [...a.slice(0, -1), { ...b[0], in: last.in }, ...b.slice(1)]
}

const reversed = (a: Anchor[]): Anchor[] => [...a].reverse().map((x) => ({ ...x, in: x.out, out: x.in }))

/**
 * A subpath redrawn: `drawn` (a fitted stroke, open) replacing what lies
 * between `from` (near the stroke's start) and `to` (near its end). Drawn
 * the other way along the path, it's turned round. On a closed subpath the
 * part replaced is the one the stroke runs along (from its start in the
 * direction it was drawn).
 */
export function spliceSubpath(s: Subpath, from: SubpathPlace, to: SubpathPlace, drawn: Anchor[]): Subpath {
  const segs = segmentsOf(s)
  if (!segs.length || drawn.length < 2) return s
  if (!s.closed) {
    let a = from
    let b = to
    let mid = drawn
    if (along(b) < along(a)) {
      ;[a, b] = [b, a]
      mid = reversed(drawn)
    }
    const head: Cubic[] = segs.slice(0, a.seg)
    if (a.t > 1e-9) head.push(part(segs[a.seg], 0, a.t))
    const tail: Cubic[] = []
    if (b.t < 1 - 1e-9) tail.push(part(segs[b.seg], b.t, 1))
    tail.push(...segs.slice(b.seg + 1))
    const pa = evalCubic(segs[a.seg], a.t)
    const pb = evalCubic(segs[b.seg], b.t)
    const headA = head.length ? cubicsToAnchors(head, false) : [anchor(pa[0], pa[1])]
    const tailA = tail.length ? cubicsToAnchors(tail, false) : [anchor(pb[0], pb[1])]
    return { closed: false, anchors: joined(joined(headA, pinned(mid, pa, pb)), tailA) }
  }
  // Closed: the stroke replaces the arc from `from` forwards to `to` when it's drawn along the path's direction; otherwise backwards.
  const n = segs.length
  const dirAt = (pl: SubpathPlace): Pt => {
    const c = segs[pl.seg]
    const q0 = evalCubic(c, Math.max(0, pl.t - 0.01))
    const q1 = evalCubic(c, Math.min(1, pl.t + 0.01))
    return [q1[0] - q0[0], q1[1] - q0[1]]
  }
  const d0 = dirAt(from)
  const sd: Pt = [drawn[1].p[0] - drawn[0].p[0], drawn[1].p[1] - drawn[0].p[1]]
  const forwards = d0[0] * sd[0] + d0[1] * sd[1] >= 0
  // The arc kept: from `to` forwards round to `from` (for a stroke drawn forwards).
  const [keepFrom, keepTo, mid] = forwards ? [to, from, drawn] : [from, to, reversed(drawn)]
  const keep: Cubic[] = []
  if (keepFrom.seg === keepTo.seg && keepTo.t > keepFrom.t) keep.push(part(segs[keepFrom.seg], keepFrom.t, keepTo.t))
  else {
    if (keepFrom.t < 1 - 1e-9) keep.push(part(segs[keepFrom.seg], keepFrom.t, 1))
    for (let i = (keepFrom.seg + 1) % n; i !== keepTo.seg; i = (i + 1) % n) keep.push(segs[i])
    if (keepTo.t > 1e-9) keep.push(part(segs[keepTo.seg], 0, keepTo.t))
  }
  const pEnd = evalCubic(segs[keepTo.seg], keepTo.t)
  const pStart = evalCubic(segs[keepFrom.seg], keepFrom.t)
  // Round the loop: the kept arc, then the stroke from the arc's end back to its start.
  const keepA = keep.length ? cubicsToAnchors(keep, false) : [anchor(pStart[0], pStart[1])]
  const loop = joined(keepA, pinned(mid, pEnd, pStart))
  // The last anchor is the first again.
  const last = loop.pop()!
  loop[0] = { ...loop[0], in: last.in }
  return { closed: true, anchors: loop }
}

/** A subpath carried on from one of its ends by a stroke drawn from near it. */
export function extendSubpath(s: Subpath, atEnd: boolean, drawn: Anchor[]): Subpath {
  if (s.closed || drawn.length < 2) return s
  if (atEnd) return { closed: false, anchors: joined(s.anchors, pinned(drawn, s.anchors[s.anchors.length - 1].p, null)) }
  return { closed: false, anchors: joined(reversed(pinned(drawn, s.anchors[0].p, null)), s.anchors) }
}
