/**
 * Editing paths: what the Pen and Direct Selection tools do to a path,
 * as pure functions from one path to the next, and the hit tests that say
 * what a press landed on. Points are in the path's own coordinates; the
 * tools map the pointer into them.
 */
import { evalCubic, reverseSubpath, segmentsOf, splitCubic, type Anchor, type PathData, type Pt, type Subpath } from './path'

/** An anchor, by subpath and index. */
export interface AnchorRef {
  sub: number
  i: number
}

export const refKey = (r: AnchorRef) => `${r.sub}:${r.i}`
export const parseRef = (k: string): AnchorRef => {
  const [sub, i] = k.split(':').map(Number)
  return { sub, i }
}

const d2 = (a: Pt, x: number, y: number) => (a[0] - x) ** 2 + (a[1] - y) ** 2

/** The anchor nearest (x, y) within r, or null. */
export function hitAnchor(path: PathData, x: number, y: number, r: number): AnchorRef | null {
  let best: AnchorRef | null = null
  let bd = r * r
  path.subpaths.forEach((s, sub) =>
    s.anchors.forEach((a, i) => {
      const d = d2(a.p, x, y)
      if (d <= bd) {
        bd = d
        best = { sub, i }
      }
    }),
  )
  return best
}

/** A handle of one of `anchors` nearest (x, y) within r. */
export function hitHandle(path: PathData, anchors: AnchorRef[], x: number, y: number, r: number): { ref: AnchorRef; which: 'in' | 'out' } | null {
  let best: { ref: AnchorRef; which: 'in' | 'out' } | null = null
  let bd = r * r
  for (const ref of anchors) {
    const a = path.subpaths[ref.sub]?.anchors[ref.i]
    if (!a) continue
    for (const which of ['in', 'out'] as const) {
      const h = a[which]
      if (!h) continue
      const d = d2(h, x, y)
      if (d <= bd) {
        bd = d
        best = { ref, which }
      }
    }
  }
  return best
}

/** The point on a path nearest (x, y) within r: which segment, how far along it, and how far away. */
export function hitSegment(path: PathData, x: number, y: number, r: number): { sub: number; seg: number; t: number; d: number } | null {
  let best: { sub: number; seg: number; t: number; d: number } | null = null
  path.subpaths.forEach((s, sub) => {
    segmentsOf(s).forEach((c, seg) => {
      // Coarse samples, then a few rounds of narrowing round the best.
      const n = 32
      let bt = 0
      let bd = Infinity
      for (let k = 0; k <= n; k++) {
        const p = evalCubic(c, k / n)
        const d = d2(p, x, y)
        if (d < bd) {
          bd = d
          bt = k / n
        }
      }
      let step = 1 / n
      for (let it = 0; it < 12; it++) {
        step /= 2
        for (const t of [bt - step, bt + step]) {
          if (t < 0 || t > 1) continue
          const d = d2(evalCubic(c, t), x, y)
          if (d < bd) {
            bd = d
            bt = t
          }
        }
      }
      const d = Math.sqrt(bd)
      if (d <= r && (!best || d < best.d)) best = { sub, seg, t: bt, d }
    })
  })
  return best
}

const withSub = (path: PathData, sub: number, anchors: Anchor[], closed?: boolean): PathData => ({
  ...path,
  subpaths: path.subpaths.map((s, i) => (i === sub ? { closed: closed ?? s.closed, anchors } : s)),
})

/** A new anchor on segment `seg` at t, the curve unchanged: its neighbours' handles shorten to fit. */
export function insertAnchor(path: PathData, sub: number, seg: number, t: number): PathData {
  const s = path.subpaths[sub]
  const c = segmentsOf(s)[seg]
  if (!c) return path
  const [l, r] = splitCubic(c, t)
  const n = s.anchors.length
  const i = seg
  const j = (seg + 1) % n
  const anchors = s.anchors.map((a) => ({ ...a }))
  const straight = !anchors[i].out && !anchors[j].in
  if (!straight) {
    anchors[i].out = [l[2], l[3]]
    anchors[j].in = [r[4], r[5]]
  }
  const mid: Anchor = { p: [l[6], l[7]], in: straight ? null : [l[4], l[5]], out: straight ? null : [r[2], r[3]], smooth: !straight }
  anchors.splice(i + 1, 0, mid)
  return withSub(path, sub, anchors)
}

/** Anchors taken out; a subpath left with fewer than two goes. */
export function deleteAnchors(path: PathData, refs: AnchorRef[]): PathData {
  const gone = new Set(refs.map(refKey))
  const subpaths = path.subpaths
    .map((s, sub) => ({ closed: s.closed, anchors: s.anchors.filter((_, i) => !gone.has(refKey({ sub, i }))) }))
    .filter((s) => s.anchors.length >= 2)
  return { ...path, subpaths }
}

/** Anchors (with their handles) moved by (dx, dy). */
export function moveAnchors(path: PathData, refs: AnchorRef[], dx: number, dy: number): PathData {
  const on = new Set(refs.map(refKey))
  const mv = (p: Pt | null): Pt | null => (p ? [p[0] + dx, p[1] + dy] : null)
  return {
    ...path,
    subpaths: path.subpaths.map((s, sub) => ({
      closed: s.closed,
      anchors: s.anchors.map((a, i) => (on.has(refKey({ sub, i })) ? { ...a, p: mv(a.p)!, in: mv(a.in), out: mv(a.out) } : a)),
    })),
  }
}

/**
 * A handle dragged to (x, y). On a smooth point the other handle turns to
 * stay in line, keeping its length; `breakSmooth` (Alt) makes the point a
 * corner instead and leaves the other handle where it is.
 */
export function moveHandle(path: PathData, ref: AnchorRef, which: 'in' | 'out', x: number, y: number, breakSmooth: boolean): PathData {
  const s = path.subpaths[ref.sub]
  const a = s?.anchors[ref.i]
  if (!a) return path
  const next: Anchor = { ...a, [which]: [x, y] as Pt }
  const other = which === 'in' ? 'out' : 'in'
  if (breakSmooth) next.smooth = false
  else if (a.smooth && a[other]) {
    const o = a[other]!
    const len = Math.hypot(o[0] - a.p[0], o[1] - a.p[1])
    const dx = a.p[0] - x
    const dy = a.p[1] - y
    const l = Math.hypot(dx, dy)
    if (l > 1e-9) next[other] = [a.p[0] + (dx / l) * len, a.p[1] + (dy / l) * len]
  }
  const anchors = s.anchors.map((b, i) => (i === ref.i ? next : b))
  return withSub(path, ref.sub, anchors)
}

/**
 * Converts a point: a corner with handles, or a smooth point, becomes a
 * corner with none; a corner with none becomes smooth, its handles along
 * the line between its neighbours, a third of the way to each.
 */
export function convertAnchor(path: PathData, ref: AnchorRef): PathData {
  const s = path.subpaths[ref.sub]
  const a = s?.anchors[ref.i]
  if (!a) return path
  let next: Anchor
  if (a.in || a.out) next = { p: a.p, in: null, out: null, smooth: false }
  else {
    const n = s.anchors.length
    const prev = s.closed || ref.i > 0 ? s.anchors[(ref.i - 1 + n) % n].p : null
    const after = s.closed || ref.i < n - 1 ? s.anchors[(ref.i + 1) % n].p : null
    const from = prev ?? a.p
    const to = after ?? a.p
    let dx = to[0] - from[0]
    let dy = to[1] - from[1]
    const l = Math.hypot(dx, dy) || 1
    dx /= l
    dy /= l
    const li = prev ? Math.hypot(a.p[0] - prev[0], a.p[1] - prev[1]) / 3 : 0
    const lo = after ? Math.hypot(after[0] - a.p[0], after[1] - a.p[1]) / 3 : 0
    next = { p: a.p, in: prev ? [a.p[0] - dx * li, a.p[1] - dy * li] : null, out: after ? [a.p[0] + dx * lo, a.p[1] + dy * lo] : null, smooth: true }
  }
  return withSub(
    path,
    ref.sub,
    s.anchors.map((b, i) => (i === ref.i ? next : b)),
  )
}

/** Whether an anchor is the first or last of an open subpath, which the Pen can carry on from. */
export function isEndpoint(path: PathData, ref: AnchorRef): 'start' | 'end' | null {
  const s = path.subpaths[ref.sub]
  if (!s || s.closed) return null
  if (ref.i === s.anchors.length - 1) return 'end'
  if (ref.i === 0) return 'start'
  return null
}

/** Anchors inside the box (x0, y0)–(x1, y1). */
export function anchorsIn(path: PathData, x0: number, y0: number, x1: number, y1: number): AnchorRef[] {
  const out: AnchorRef[] = []
  const lx = Math.min(x0, x1)
  const hx = Math.max(x0, x1)
  const ly = Math.min(y0, y1)
  const hy = Math.max(y0, y1)
  path.subpaths.forEach((s, sub) => s.anchors.forEach((a, i) => a.p[0] >= lx && a.p[0] <= hx && a.p[1] >= ly && a.p[1] <= hy && out.push({ sub, i })))
  return out
}

// --- curvature ----------------------------------------------------------------------------------

/** A point plus a direction times a length. */
const along = (p: Pt, d: Pt, l: number): Pt => [p[0] + d[0] * l, p[1] + d[1] * l]
const unit = (x: number, y: number): Pt => {
  const l = Math.hypot(x, y)
  return l > 1e-12 ? [x / l, y / l] : [0, 0]
}

/**
 * A smooth point's handles worked out from its neighbours, as the
 * Curvature tool (and the Pen's Smart mode) makes them: along the line
 * between its neighbours, a third of the way to each. An open path's end
 * turns towards where the curve through the next point is heading (the
 * neighbour's direction mirrored across the chord), so the end segment
 * curves as the rest do; with no point beyond, it's straight. A corner
 * keeps no handles.
 */
export function curvatureAnchor(s: Subpath, i: number): Anchor {
  const a = s.anchors
  const n = a.length
  const me = a[i]
  if (!me.smooth || n < 2) return { ...me, in: null, out: null }
  const prev = s.closed || i > 0 ? a[(i - 1 + n) % n].p : null
  const next = s.closed || i < n - 1 ? a[(i + 1) % n].p : null
  const p = me.p
  if (prev && next) {
    const d = unit(next[0] - prev[0], next[1] - prev[1])
    return { ...me, in: along(p, d, -Math.hypot(p[0] - prev[0], p[1] - prev[1]) / 3), out: along(p, d, Math.hypot(next[0] - p[0], next[1] - p[1]) / 3) }
  }
  // An open end: towards its neighbour, bent by where the curve goes on from there.
  const nb = (prev ?? next)!
  const beyond = prev ? (i - 2 >= 0 ? a[i - 2].p : null) : i + 2 < n ? a[i + 2].p : null
  const chord = unit(nb[0] - p[0], nb[1] - p[1])
  const len = Math.hypot(nb[0] - p[0], nb[1] - p[1]) / 3
  let d = chord
  if (beyond && a[prev ? i - 1 : i + 1].smooth) {
    // The neighbour's tangent (pointing away from this end), mirrored across the chord.
    const t = unit(beyond[0] - p[0], beyond[1] - p[1])
    const dot = t[0] * chord[0] + t[1] * chord[1]
    d = unit(2 * dot * chord[0] - t[0], 2 * dot * chord[1] - t[1])
  }
  const h = along(p, d, len)
  return prev ? { ...me, in: h, out: null } : { ...me, in: null, out: h }
}

/** A subpath's smooth points among `around` and their neighbours given handles by the curvature rule. */
export function recurve(s: Subpath, around: number[]): Subpath {
  const n = s.anchors.length
  const touch = new Set<number>()
  for (const i of around)
    for (const k of [i - 1, i, i + 1]) {
      if (s.closed) touch.add(((k % n) + n) % n)
      else if (k >= 0 && k < n) touch.add(k)
    }
  // Worked out from the points as they are, not from handles already changed.
  const anchors = s.anchors.map((a, i) => (touch.has(i) ? curvatureAnchor(s, i) : a))
  return { closed: s.closed, anchors }
}

/** recurve on one subpath of a path. */
export function recurvePath(path: PathData, sub: number, around: number[]): PathData {
  const s = path.subpaths[sub]
  return s ? { ...path, subpaths: path.subpaths.map((x, k) => (k === sub ? recurve(s, around) : x)) } : path
}

// --- breaking and joining -------------------------------------------------------------------------

/**
 * Paths cut at points: a closed subpath opens there (starting and ending
 * at it), an open one splits in two, the point on both sides (each copy
 * keeping the handle on its own side). An open path's end isn't a cut.
 */
export function breakAt(path: PathData, refs: AnchorRef[]): PathData {
  const out: Subpath[] = []
  path.subpaths.forEach((s, sub) => {
    const n = s.anchors.length
    const cuts = [...new Set(refs.filter((r) => r.sub === sub).map((r) => r.i))].filter((i) => i >= 0 && i < n && (s.closed || (i > 0 && i < n - 1))).sort((a, b) => a - b)
    if (!cuts.length) return out.push(s)
    // A closed path is read from its first cut round to it again.
    const order = s.closed ? [...s.anchors.slice(cuts[0]), ...s.anchors.slice(0, cuts[0] + 1)] : s.anchors
    const at = s.closed ? cuts.map((c) => c - cuts[0]).concat(n) : [0, ...cuts, n - 1]
    for (let k = 0; k + 1 < at.length; k++) {
      const piece = order.slice(at[k], at[k + 1] + 1).map((a) => ({ ...a }))
      if (piece.length < 2) continue
      piece[0] = { ...piece[0], in: null, smooth: false }
      piece[piece.length - 1] = { ...piece[piece.length - 1], out: null, smooth: false }
      out.push({ closed: false, anchors: piece })
    }
  })
  return { ...path, subpaths: out }
}

/** An open subpath turned so `end` is its last point. */
const endingAt = (s: Subpath, end: 'start' | 'end'): Subpath => (end === 'end' ? s : reverseSubpath(s))

/**
 * Two open ends joined: `a`'s end `aEnd` to `b`'s end `bEnd`, by a straight
 * segment, or with `merge` into one point (a's position, a's handle
 * arriving, b's leaving). Returns the one open subpath they make.
 */
export function joinSubpaths(a: Subpath, aEnd: 'start' | 'end', b: Subpath, bEnd: 'start' | 'end', merge: boolean): Subpath {
  const first = endingAt(a, aEnd).anchors.map((x) => ({ ...x }))
  const second = reverseIfNeeded(b, bEnd).anchors.map((x) => ({ ...x }))
  if (merge) {
    const l = first[first.length - 1]
    first[first.length - 1] = { p: l.p, in: l.in, out: second[0].out, smooth: false }
    return { closed: false, anchors: [...first, ...second.slice(1)] }
  }
  return { closed: false, anchors: [...first, ...second] }
}
/** An open subpath turned so `end` is its first point. */
const reverseIfNeeded = (s: Subpath, end: 'start' | 'end'): Subpath => (end === 'start' ? s : reverseSubpath(s))

/** An open subpath closed: by a straight segment from its last point to its first, or with `merge` the two made one point. */
export function closeSubpath(s: Subpath, merge: boolean): Subpath {
  const anchors = s.anchors.map((x) => ({ ...x }))
  if (merge && anchors.length > 2) {
    const l = anchors.pop()!
    anchors[0] = { p: anchors[0].p, in: l.in, out: anchors[0].out, smooth: false }
  }
  return { closed: true, anchors }
}

/** Each subpath of a path as a path of its own. */
export function separate(path: PathData): PathData[] {
  return path.subpaths.map((s) => ({ fillRule: path.fillRule, subpaths: [s] }))
}
