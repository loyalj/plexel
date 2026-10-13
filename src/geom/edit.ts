/**
 * Editing paths: what the Pen and Direct Selection tools do to a path,
 * as pure functions from one path to the next, and the hit tests that say
 * what a press landed on. Points are in the path's own coordinates; the
 * tools map the pointer into them.
 */
import { evalCubic, segmentsOf, splitCubic, type Anchor, type PathData, type Pt } from './path'

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
