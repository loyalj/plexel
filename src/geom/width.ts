/**
 * Width profiles edited by hand (the Width tool): adding, setting, moving
 * and deleting width points, flipping a profile, and measuring along a
 * path to find where on it a point is.
 *
 * A profile is a stroke's width points (geom/stroke.ts): where along each
 * subpath (0..1 of its length) and how wide each side is there, as a share
 * of the stroke's width. Edits keep the points in order and hand back
 * `undefined` for a profile that's the same width all the way, so a stroke
 * made uniform again has none. On a closed path the points at 0 and 1 are
 * the same place: setting one sets both.
 *
 * Pure and DOM-free; check-geom runs it in Node.
 */
import { flattenPath, type PathData, type Pt } from './path'
import { profileAt, type WidthPoint } from './stroke'

/** The most a side can be, as a share of the stroke's width (what files read back). */
export const MAX_SHARE = 50

const EPS = 1e-6
const clampShare = (v: number) => Math.min(MAX_SHARE, Math.max(0, Number.isFinite(v) ? v : 0))
const wp = (at: number, left: number, right: number): WidthPoint => ({ at, left: clampShare(left), right: clampShare(right) })

/** A profile tidied: in order, each side within range; none when every point is full width both sides. */
export function tidyProfile(p: WidthPoint[] | undefined): WidthPoint[] | undefined {
  if (!p?.length) return undefined
  const out = [...p].map((x) => wp(Math.min(1, Math.max(0, x.at)), x.left, x.right)).sort((a, b) => a.at - b.at)
  if (out.every((x) => Math.abs(x.left - 1) < 1e-9 && Math.abs(x.right - 1) < 1e-9)) return undefined
  return out
}

/** Whether point `i` is a closed path's start or end, which are the same place. */
const isSeam = (p: WidthPoint[], i: number) => p[i].at <= EPS || p[i].at >= 1 - EPS

/**
 * A point added at `at`, as wide as the stroke is there; a uniform stroke
 * gets its ends too, at full width. Returns the profile and the new
 * point's index.
 */
export function addWidthPoint(profile: WidthPoint[] | undefined, at: number): { profile: WidthPoint[]; index: number } {
  const t = Math.min(1, Math.max(0, at))
  const base = profile?.length ? [...profile].sort((a, b) => a.at - b.at) : [wp(0, 1, 1), wp(1, 1, 1)]
  // On a point already: that one.
  const same = base.findIndex((x) => Math.abs(x.at - t) < EPS)
  if (same >= 0) return { profile: base, index: same }
  const added = wp(t, profileAt(base, t, 'left'), profileAt(base, t, 'right'))
  const out = [...base, added].sort((a, b) => a.at - b.at)
  return { profile: out, index: out.indexOf(added) }
}

/** Point `i` given new widths; on a closed path its partner at the other end too. */
export function setWidthPoint(profile: WidthPoint[], i: number, left: number, right: number, closed: boolean): WidthPoint[] {
  return profile.map((x, j) => (j === i || (closed && isSeam(profile, i) && isSeam(profile, j)) ? wp(x.at, left, right) : x))
}

/**
 * The range point `i` can slide in: between its neighbours, never onto
 * them. A point at either end of the profile stays there (null).
 */
export function slideRange(profile: WidthPoint[], i: number): [number, number] | null {
  if (i <= 0 || i >= profile.length - 1) return null
  const gap = 1e-3
  const lo = profile[i - 1].at + gap
  const hi = profile[i + 1].at - gap
  return lo < hi ? [lo, hi] : null
}

/** Point `i` slid to `at`, kept between its neighbours. */
export function moveWidthPoint(profile: WidthPoint[], i: number, at: number): WidthPoint[] {
  const r = slideRange(profile, i)
  if (!r) return profile
  const t = Math.min(r[1], Math.max(r[0], at))
  return profile.map((x, j) => (j === i ? { ...x, at: t } : x))
}

/** The points at `indices` taken out; none left (or all full width) is uniform. */
export function deleteWidthPoints(profile: WidthPoint[], indices: Iterable<number>): WidthPoint[] | undefined {
  const drop = new Set(indices)
  return tidyProfile(profile.filter((_, j) => !drop.has(j)))
}

/** The profile end to end: what was at the start is at the end. */
export const flipAlong = (p: WidthPoint[] | undefined): WidthPoint[] | undefined => (p?.length ? p.map((x) => ({ ...x, at: 1 - x.at })).reverse() : p)

/** The profile side to side: each point's left width is its right. */
export const flipAcross = (p: WidthPoint[] | undefined): WidthPoint[] | undefined => (p?.length ? p.map((x) => ({ at: x.at, left: x.right, right: x.left })) : p)

/** Whether two profiles are the same points (none and empty alike). */
export function sameProfile(a: WidthPoint[] | undefined, b: WidthPoint[] | undefined): boolean {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((p, i) => Math.abs(p.at - y[i].at) < 1e-9 && Math.abs(p.left - y[i].left) < 1e-9 && Math.abs(p.right - y[i].right) < 1e-9)
}

/** The points a closed path shows: its end's point is its start's, so it's left out when both are there. */
export function shownPoints(profile: WidthPoint[], closed: boolean): number[] {
  const out: number[] = []
  const hasStart = profile.some((x) => x.at <= EPS)
  profile.forEach((x, i) => {
    if (closed && hasStart && x.at >= 1 - EPS) return
    out.push(i)
  })
  return out
}

// --- measuring along a path ---------------------------------------------------------------------

/** One subpath flattened, each point's distance along it, and its length. */
export interface MeasuredSub {
  pts: number[]
  d: number[]
  total: number
  closed: boolean
}

/** Every subpath of a path flattened to `tol` and measured, as strokes measure them (index for index). */
export function measurePath(path: PathData, tol: number): MeasuredSub[] {
  return path.subpaths.map((s) => {
    const line = flattenPath({ subpaths: [s], fillRule: path.fillRule }, tol)[0]
    const pts: number[] = []
    if (line) for (let i = 0; i < line.pts.length; i += 2) {
      const n = pts.length
      if (n && Math.abs(pts[n - 2] - line.pts[i]) < 1e-9 && Math.abs(pts[n - 1] - line.pts[i + 1]) < 1e-9) continue
      pts.push(line.pts[i], line.pts[i + 1])
    }
    // A closed line that comes back to its start: that point once.
    if (s.closed && pts.length >= 4 && Math.abs(pts[0] - pts[pts.length - 2]) < 1e-9 && Math.abs(pts[1] - pts[pts.length - 1]) < 1e-9) pts.length -= 2
    const d = [0]
    for (let i = 2; i < pts.length; i += 2) d.push(d[d.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]))
    let total = d[d.length - 1] ?? 0
    if (s.closed && pts.length >= 4) total += Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1])
    return { pts, d: pts.length ? d : [], total, closed: s.closed }
  })
}

/** A place on a path: which subpath, how far along it (0..1), the point, the unit direction there, how far it is from what was asked. */
export interface PathPlace {
  sub: number
  t: number
  p: Pt
  dir: Pt
  dist: number
}

/** The segments of a measured subpath, as [i, j] point indices, the closing one included. */
function* segs(m: MeasuredSub): Generator<[number, number, number]> {
  const n = m.pts.length / 2
  for (let i = 0; i + 1 < n; i++) yield [i, i + 1, m.d[i]]
  if (m.closed && n >= 3) yield [n - 1, 0, m.d[n - 1]]
}

/** The nearest place on the path to (x, y); `only` limits it to one subpath. */
export function nearestPlace(ms: MeasuredSub[], x: number, y: number, only?: number): PathPlace | null {
  let best: PathPlace | null = null
  ms.forEach((m, sub) => {
    if (only !== undefined && sub !== only) return
    if (!(m.total > 0)) return
    for (const [i, j, d0] of segs(m)) {
      const ax = m.pts[i * 2]
      const ay = m.pts[i * 2 + 1]
      const bx = m.pts[j * 2]
      const by = m.pts[j * 2 + 1]
      const vx = bx - ax
      const vy = by - ay
      const len2 = vx * vx + vy * vy
      if (len2 <= 1e-18) continue
      const u = Math.min(1, Math.max(0, ((x - ax) * vx + (y - ay) * vy) / len2))
      const px = ax + vx * u
      const py = ay + vy * u
      const dist = Math.hypot(x - px, y - py)
      if (best && dist >= best.dist) continue
      const len = Math.sqrt(len2)
      best = { sub, t: Math.min(1, (d0 + len * u) / m.total), p: [px, py], dir: [vx / len, vy / len], dist }
    }
  })
  return best
}

/** The place `t` (0..1) along subpath `sub`. */
export function placeAt(ms: MeasuredSub[], sub: number, t: number): PathPlace | null {
  const m = ms[sub]
  if (!m || !(m.total > 0)) return null
  const target = Math.min(1, Math.max(0, t)) * m.total
  let last: PathPlace | null = null
  for (const [i, j, d0] of segs(m)) {
    const ax = m.pts[i * 2]
    const ay = m.pts[i * 2 + 1]
    const bx = m.pts[j * 2]
    const by = m.pts[j * 2 + 1]
    const len = Math.hypot(bx - ax, by - ay)
    if (len <= 1e-12) continue
    const dir: Pt = [(bx - ax) / len, (by - ay) / len]
    const u = Math.min(1, Math.max(0, (target - d0) / len))
    last = { sub, t, p: [ax + (bx - ax) * u, ay + (by - ay) * u], dir, dist: 0 }
    if (target <= d0 + len + 1e-9) return last
  }
  return last
}

/** The side of the path a point is on, by the stroke's sense of left (towards the normal (−dy, dx)): +1 left, −1 right. */
export const sideOf = (place: PathPlace, x: number, y: number): 1 | -1 => ((x - place.p[0]) * -place.dir[1] + (y - place.p[1]) * place.dir[0] >= 0 ? 1 : -1)
