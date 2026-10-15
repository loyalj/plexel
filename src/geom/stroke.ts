/**
 * Strokes as geometry (ARCHITECTURE.md, "Geometry"): a stroke becomes the
 * outline of the area it paints, which the rasterizer fills like any other
 * shape. Outline Stroke would be this code with its result kept.
 *
 * Works on a path already flattened (to the tolerance its drawing scale
 * needs): each polyline's two sides are offset by half the width, with
 * joins on the outer side of every turn and caps on open ends. The inner
 * side of a turn goes in through the corner point, as most stroke
 * engines' do, so the outline's loops overlap there; filled with the
 * nonzero rule, overlaps are simply covered. Where the turn is gentle
 * (a flattened curve's, every few pixels) the two offsets meet at a point
 * on both, and the side goes through that point instead: no overlap there
 * at all, so the edge's anti-aliasing is exact, not doubled.
 *
 * Every point of a line carries how far along its subpath it is, and how
 * wide each side is there: a width profile (width points along the
 * subpath, eased between) sets the half-widths, dashes cut the line
 * keeping them, and arrowheads go at an open line's ends, the line trimmed
 * under a filled head. Dashes aligned to corners cut the line at its
 * corners (flattenPath marks them) and fit a whole number of repeats to
 * each run, half a dash either side of each corner.
 */
import type { Polyline } from './path'

export type Join = 'miter' | 'round' | 'bevel'
export type Cap = 'butt' | 'round' | 'square'

/** A width point: where along the subpath (0..1 of its length), and each side's width there as a share of the stroke's. */
export interface WidthPoint {
  at: number
  left: number
  right: number
}

export type ArrowShape = 'triangle' | 'stealth' | 'open' | 'circle' | 'square' | 'diamond' | 'bar'

export interface Arrowhead {
  shape: ArrowShape
  /** Its size as a share of the default for the stroke's width (1 is 100%). */
  scale: number
}

export interface StrokeStyle {
  width: number
  join: Join
  cap: Cap
  /** Photoshop's and Illustrator's miter limit: a miter longer than this many widths becomes a bevel. */
  miter: number
  /** Dash and gap lengths, alternating, in the path's units; empty for a solid line. */
  dash: number[]
  dashOffset: number
  /** The width along each subpath; absent or empty is the same width all the way. */
  profile?: WidthPoint[]
  /** Dashes stretched to fit between corners, half a dash either side of each. */
  dashAlign?: boolean
  /** Arrowheads at an open subpath's start and end. */
  start?: Arrowhead | null
  end?: Arrowhead | null
}

export const SOLID: StrokeStyle = { width: 1, join: 'miter', cap: 'butt', miter: 4, dash: [], dashOffset: 0 }

/** Width profiles as Illustrator's presets have them: their points. */
export const WIDTH_PRESETS: { id: string; label: string; points: WidthPoint[] }[] = [
  { id: 'uniform', label: 'Uniform', points: [] },
  { id: 'taper-both', label: 'Taper Both', points: [w(0, 0), w(0.5, 1), w(1, 0)] },
  { id: 'taper-start', label: 'Taper Start', points: [w(0, 0), w(1, 1)] },
  { id: 'taper-end', label: 'Taper End', points: [w(0, 1), w(1, 0)] },
  { id: 'bulge', label: 'Bulge', points: [w(0, 0.35), w(0.5, 1), w(1, 0.35)] },
  { id: 'pinch', label: 'Pinch', points: [w(0, 1), w(0.5, 0.25), w(1, 1)] },
  { id: 'brush', label: 'Brush', points: [w(0, 0), w(0.15, 1), w(0.85, 0.85), w(1, 0)] },
]
function w(at: number, v: number): WidthPoint {
  return { at, left: v, right: v }
}

export const ARROW_SHAPES: [ArrowShape, string][] = [
  ['triangle', 'Triangle'],
  ['stealth', 'Stealth'],
  ['open', 'Open'],
  ['circle', 'Circle'],
  ['square', 'Square'],
  ['diamond', 'Diamond'],
  ['bar', 'Bar'],
]

/** The preset a profile is, if it is one exactly. */
export function presetOf(profile: WidthPoint[] | undefined): string | null {
  const p = profile ?? []
  for (const pr of WIDTH_PRESETS) if (pr.points.length === p.length && pr.points.every((x, i) => Math.abs(x.at - p[i].at) < 1e-9 && Math.abs(x.left - p[i].left) < 1e-9 && Math.abs(x.right - p[i].right) < 1e-9)) return pr.id
  return null
}

/** Each side's share of the width at t (0..1 along the subpath): eased between the points around it. */
export function profileAt(profile: WidthPoint[], t: number, side: 'left' | 'right'): number {
  if (!profile.length) return 1
  const pts = profile
  if (t <= pts[0].at) return pts[0][side]
  const last = pts[pts.length - 1]
  if (t >= last.at) return last[side]
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (t > b.at) continue
    const u = b.at > a.at ? (t - a.at) / (b.at - a.at) : 1
    const e = (1 - Math.cos(Math.PI * u)) / 2
    return a[side] + (b[side] - a[side]) * e
  }
  return last[side]
}

/** A profile's widest point, as a share of the width. */
export const profileMax = (profile: WidthPoint[] | undefined) => (profile?.length ? Math.max(1e-9, ...profile.map((p) => Math.max(p.left, p.right))) : 1)

/** Steps for an arc of `sweep` radians at radius r, staying within tol of the circle. */
function arcSteps(r: number, sweep: number, tol: number): number {
  const t = Math.min(0.999, Math.max(1e-6, tol / Math.max(r, 1e-9)))
  const step = 2 * Math.acos(1 - t)
  return Math.max(1, Math.min(512, Math.ceil(Math.abs(sweep) / step)))
}

/** A polyline's corners as indices into its points once repeats are taken out (clean): found again by where they are. */
function cornersAfterClean(l: Polyline): number[] | undefined {
  if (!l.corners?.length) return undefined
  const pts = clean(l.pts, l.closed)
  const out: number[] = []
  for (const c of l.corners) {
    const x = l.pts[c * 2]
    const y = l.pts[c * 2 + 1]
    for (let i = 0; i < pts.length; i += 2) {
      if (Math.abs(pts[i] - x) < 1e-9 && Math.abs(pts[i + 1] - y) < 1e-9) {
        out.push(i / 2)
        break
      }
    }
  }
  return out
}

/** A polyline's points with repeats taken out; a closed one's end that comes back to its start too. */
function clean(pts: number[], closed: boolean): number[] {
  const out: number[] = []
  for (let i = 0; i < pts.length; i += 2) {
    const n = out.length
    if (n && Math.abs(out[n - 2] - pts[i]) < 1e-9 && Math.abs(out[n - 1] - pts[i + 1]) < 1e-9) continue
    out.push(pts[i], pts[i + 1])
  }
  if (closed && out.length >= 4 && Math.abs(out[0] - out[out.length - 2]) < 1e-9 && Math.abs(out[1] - out[out.length - 1]) < 1e-9) out.length -= 2
  return out
}

// --- lines that know where they are ---------------------------------------------------------------

/** A polyline with each point's distance along its subpath, and the subpath's whole length. */
interface Line {
  pts: number[]
  closed: boolean
  d: number[]
  total: number
  /** Point indices that are the path's corners. */
  corners?: number[]
}

function measure(line: Polyline): Line {
  const pts = line.pts
  const d = [0]
  for (let i = 2; i < pts.length; i += 2) d.push(d[d.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]))
  let total = d[d.length - 1]
  if (line.closed && pts.length >= 4) total += Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1])
  return { pts, closed: line.closed, d, total, corners: line.corners }
}

/** The line with points added so no segment is longer than \`step\`, for a profile to change smoothly along straight runs. */
function densify(l: Line, step: number): Line {
  if (!(step > 0)) return l
  const pts: number[] = []
  const d: number[] = []
  const corners: number[] = []
  const isCorner = new Set(l.corners ?? [])
  const n = l.pts.length / 2
  const segs = l.closed ? n : n - 1
  for (let i = 0; i < n; i++) {
    if (isCorner.has(i)) corners.push(pts.length / 2)
    pts.push(l.pts[i * 2], l.pts[i * 2 + 1])
    d.push(l.d[i])
    if (i >= segs) continue
    const j = (i + 1) % n
    const len = (j === 0 ? l.total : l.d[j]) - l.d[i]
    const k = Math.ceil(len / step)
    for (let s = 1; s < k; s++) {
      const t = s / k
      pts.push(l.pts[i * 2] + (l.pts[j * 2] - l.pts[i * 2]) * t, l.pts[i * 2 + 1] + (l.pts[j * 2 + 1] - l.pts[i * 2 + 1]) * t)
      d.push(l.d[i] + len * t)
    }
  }
  return { pts, closed: l.closed, d, total: l.total, corners }
}

/** Cuts lines into dashes (open pieces) by a dash pattern starting \`offset\` into it; each point keeps its distance. */
function dashRich(lines: Line[], dash: number[], offset: number): Line[] {
  const pattern = dash.length % 2 ? [...dash, ...dash] : dash
  const total = pattern.reduce((a, b) => a + Math.max(0, b), 0)
  if (!pattern.length || total <= 1e-9) return lines
  const out: Line[] = []
  for (const line of lines) {
    const pts = line.closed ? [...line.pts, line.pts[0], line.pts[1]] : line.pts
    const dd = line.closed ? [...line.d, line.total] : line.d
    let at = ((offset % total) + total) % total
    let k = 0
    while (at > 0 && at >= Math.max(0, pattern[k])) {
      at -= Math.max(0, pattern[k])
      k = (k + 1) % pattern.length
    }
    let left = Math.max(0, pattern[k]) - at
    let on = k % 2 === 0
    let cur: { pts: number[]; d: number[] } | null = on ? { pts: [pts[0], pts[1]], d: [dd[0]] } : null
    const emit = () => {
      if (cur) out.push({ pts: cur.pts, closed: false, d: cur.d, total: line.total })
    }
    const skipEmpty = (x: number, y: number, at0: number) => {
      while (left <= 1e-12) {
        if (on) emit()
        on = !on
        cur = on ? { pts: [x, y], d: [at0] } : null
        k = (k + 1) % pattern.length
        left = Math.max(0, pattern[k])
      }
    }
    skipEmpty(pts[0], pts[1], dd[0])
    for (let i = 0; i + 3 < pts.length; i += 2) {
      let x = pts[i]
      let y = pts[i + 1]
      let da = dd[i / 2]
      const x1 = pts[i + 2]
      const y1 = pts[i + 3]
      const db = dd[i / 2 + 1]
      let seg = Math.hypot(x1 - x, y1 - y)
      while (seg > 1e-12) {
        if (left > seg + 1e-12) {
          left -= seg
          if (cur) {
            cur.pts.push(x1, y1)
            cur.d.push(db)
          }
          seg = 0
          break
        }
        const t = left / seg
        const mx = x + (x1 - x) * t
        const my = y + (y1 - y) * t
        const md = da + (db - da) * t
        if (cur) {
          cur.pts.push(mx, my)
          cur.d.push(md)
          emit()
          cur = null
        } else cur = { pts: [mx, my], d: [md] }
        on = !on
        if (!on) cur = null
        seg -= left
        x = mx
        y = my
        da = md
        k = (k + 1) % pattern.length
        left = Math.max(0, pattern[k])
        skipEmpty(x, y, da)
      }
    }
    if (cur && (cur as { pts: number[] }).pts.length >= 4) emit()
    else if (cur && on && left > 1e-12 && Math.max(0, pattern[k]) <= 1e-12) emit()
  }
  return out
}

/** Cuts polylines into dashes (open pieces) by a dash pattern. */
export function dashLines(lines: Polyline[], dash: number[], offset: number): Polyline[] {
  return dashRich(lines.map(measure), dash, offset).map((l) => ({ pts: l.pts, closed: false }))
}

/** A line's runs between corners (and its ends), each with its own length; a closed line without corners is one run, still closed. */
function cornerRuns(l: Line): Line[] {
  const n = l.pts.length / 2
  const corners = [...new Set(l.corners ?? [])].filter((i) => i >= 0 && i < n).sort((a, b) => a - b)
  const piece = (from: number, to: number): Line => {
    // Indices from \`from\` to \`to\` (wrapping for a closed line); distances made the run's own.
    const pts: number[] = []
    const d: number[] = []
    let acc = 0
    let prev = -1
    for (let s = 0; ; s++) {
      const i = (from + s) % n
      if (prev >= 0) acc += Math.hypot(l.pts[i * 2] - l.pts[prev * 2], l.pts[i * 2 + 1] - l.pts[prev * 2 + 1])
      pts.push(l.pts[i * 2], l.pts[i * 2 + 1])
      d.push(acc)
      prev = i
      if (i === to && s > 0) break
      if (s > n) break
    }
    return { pts, closed: false, d, total: acc }
  }
  if (l.closed) {
    if (!corners.length) return [{ ...l, d: l.d, total: l.total }]
    return corners.map((c, k) => piece(c, corners[(k + 1) % corners.length]))
  }
  const cuts = [0, ...corners.filter((c) => c > 0 && c < n - 1), n - 1]
  const out: Line[] = []
  for (let k = 0; k + 1 < cuts.length; k++) out.push(piece(cuts[k], cuts[k + 1]))
  return out
}

/** Dashes fitted to each run between corners: a whole number of repeats, half a dash at each end, so corners and ends are dashed. */
function alignedDashes(lines: Line[], dash: number[]): Line[] {
  const pattern = dash.length % 2 ? [...dash, ...dash] : dash
  const p = pattern.reduce((a, b) => a + Math.max(0, b), 0)
  if (p <= 1e-9) return lines
  const out: Line[] = []
  for (const l of lines) {
    for (const run of cornerRuns(l)) {
      const reps = Math.max(1, Math.round(run.total / p))
      const k = run.total / (reps * p)
      const scaled = pattern.map((v) => v * k)
      // Starting half way through the first dash: the run's end falls half way through a dash too.
      const pieces = dashRich([{ ...run, d: run.d, total: run.total }], scaled, scaled[0] / 2)
      // Distances back into the subpath's, for its profile: the run's share of the line.
      for (const piece of pieces) out.push({ ...piece, d: piece.d.map((x) => mapRunDistance(l, run, x)), total: l.total })
    }
  }
  return out
}

/** A distance along a run as one along the line it came from, by the run's first point's place on the line. */
function mapRunDistance(l: Line, run: Line, x: number): number {
  const sx = run.pts[0]
  const sy = run.pts[1]
  const n = l.pts.length / 2
  for (let i = 0; i < n; i++) if (Math.abs(l.pts[i * 2] - sx) < 1e-9 && Math.abs(l.pts[i * 2 + 1] - sy) < 1e-9) return (l.d[i] + x) % (l.closed ? l.total || 1 : Infinity)
  return x
}

// --- arrowheads --------------------------------------------------------------------------------

/** How long a head is along the line, and how far its base comes back from the tip, in units of the stroke's width × scale. */
const HEAD: Record<ArrowShape, { length: number; trim: number }> = {
  triangle: { length: 4, trim: 2.5 },
  stealth: { length: 4.5, trim: 2.5 },
  open: { length: 3.5, trim: 0 },
  circle: { length: 2, trim: 0 },
  square: { length: 1.6, trim: 0 },
  diamond: { length: 2.5, trim: 0 },
  bar: { length: 0.5, trim: 0 },
}

/** The point \`dist\` back along an open line from its end (or its start, with \`fromStart\`), and the direction there towards the end. */
function backAlong(l: Line, dist: number, fromStart: boolean): { x: number; y: number; ux: number; uy: number } {
  const n = l.pts.length / 2
  const idx = (k: number) => (fromStart ? k : n - 1 - k)
  const ex = l.pts[idx(0) * 2]
  const ey = l.pts[idx(0) * 2 + 1]
  let left = dist
  let px = ex
  let py = ey
  for (let k = 1; k < n; k++) {
    const qx = l.pts[idx(k) * 2]
    const qy = l.pts[idx(k) * 2 + 1]
    const seg = Math.hypot(qx - px, qy - py)
    if (seg >= left && seg > 1e-12) {
      px += ((qx - px) * left) / seg
      py += ((qy - py) * left) / seg
      left = 0
      break
    }
    left -= seg
    px = qx
    py = qy
  }
  let ux = ex - px
  let uy = ey - py
  const len = Math.hypot(ux, uy)
  if (len < 1e-12) {
    // A line shorter than the head: its first segment's direction.
    const qx = l.pts[idx(1) * 2]
    const qy = l.pts[idx(1) * 2 + 1]
    ux = ex - qx
    uy = ey - qy
  }
  const l2 = Math.hypot(ux, uy) || 1
  return { x: px, y: py, ux: ux / l2, uy: uy / l2 }
}

/** A line with \`dist\` taken off its end (or its start). */
function trim(l: Line, dist: number, fromStart: boolean): Line {
  if (!(dist > 0)) return l
  const n = l.pts.length / 2
  if (fromStart) {
    const target = l.d[0] + dist
    let i = 0
    while (i < n - 1 && l.d[i + 1] <= target) i++
    if (i >= n - 1) return { ...l, pts: l.pts.slice(-2), d: l.d.slice(-1) }
    const t = (target - l.d[i]) / Math.max(1e-12, l.d[i + 1] - l.d[i])
    const x = l.pts[i * 2] + (l.pts[i * 2 + 2] - l.pts[i * 2]) * t
    const y = l.pts[i * 2 + 1] + (l.pts[i * 2 + 3] - l.pts[i * 2 + 1]) * t
    return { ...l, pts: [x, y, ...l.pts.slice((i + 1) * 2)], d: [target, ...l.d.slice(i + 1)], corners: undefined }
  }
  const target = l.d[n - 1] - dist
  let i = n - 1
  while (i > 0 && l.d[i - 1] >= target) i--
  if (i <= 0) return { ...l, pts: l.pts.slice(0, 2), d: l.d.slice(0, 1) }
  const t = (target - l.d[i - 1]) / Math.max(1e-12, l.d[i] - l.d[i - 1])
  const x = l.pts[(i - 1) * 2] + (l.pts[i * 2] - l.pts[(i - 1) * 2]) * t
  const y = l.pts[(i - 1) * 2 + 1] + (l.pts[i * 2 + 1] - l.pts[(i - 1) * 2 + 1]) * t
  return { ...l, pts: [...l.pts.slice(0, i * 2), x, y], d: [...l.d.slice(0, i), target], corners: undefined }
}

/** A head's loops at a line's end: its tip at the end, pointing along \`u\`; \`a\` is the stroke's width × the head's scale. */
function headLoops(shape: ArrowShape, x: number, y: number, ux: number, uy: number, a: number, s: StrokeStyle, tol: number): number[][] {
  const nx = -uy
  const ny = ux
  // A point \`along\` back from the tip and \`across\` to the side, in the head's frame.
  const at = (along: number, across: number) => [x - ux * along * a + nx * across * a, y - uy * along * a + ny * across * a]
  switch (shape) {
    case 'triangle':
      return [[...at(0, 0), ...at(4, 2), ...at(4, -2)]]
    case 'stealth':
      return [[...at(0, 0), ...at(4.5, 2.2), ...at(3, 0), ...at(4.5, -2.2)]]
    case 'diamond':
      return [[...at(-2.5, 0), ...at(0, 1.75), ...at(2.5, 0), ...at(0, -1.75)]]
    case 'square':
      return [[...at(-1.6, -1.6), ...at(-1.6, 1.6), ...at(1.6, 1.6), ...at(1.6, -1.6)]]
    case 'bar':
      return [[...at(-0.5, -2.5), ...at(-0.5, 2.5), ...at(0.5, 2.5), ...at(0.5, -2.5)]]
    case 'circle': {
      const r = 2 * a
      const k = arcSteps(r, 2 * Math.PI, tol)
      const loop: number[] = []
      for (let j = 0; j < k; j++) loop.push(x + Math.cos((2 * Math.PI * j) / k) * r, y + Math.sin((2 * Math.PI * j) / k) * r)
      return [loop]
    }
    case 'open': {
      // Two arms back from the tip, stroked as the line is (mitred at the tip).
      const arms = [...at(3.5, 2.6), x, y, ...at(3.5, -2.6)]
      return strokeOutline([{ pts: arms, closed: false }], { width: s.width, join: 'miter', cap: s.cap === 'butt' ? 'butt' : s.cap, miter: 10, dash: [], dashOffset: 0 }, tol)
    }
  }
}

// --- the outline ------------------------------------------------------------------------------

/** The outline a stroke paints, as loops to fill with the nonzero rule. \`tol\` is how close round joins and caps keep to their circles. */
export function strokeOutline(lines: Polyline[], s: StrokeStyle, tol: number): number[][] {
  const hw = s.width / 2
  if (!(hw > 0)) return []
  const profile = s.profile?.length ? [...s.profile].sort((a, b) => a.at - b.at) : null
  const loops: number[][] = []
  let rich = lines.map((l) => measure({ pts: clean(l.pts, l.closed), closed: l.closed, corners: cornersAfterClean(l) }))
  // Arrowheads at open lines' ends, from the line before dashing; the line stops short under a filled head.
  if (s.start || s.end) {
    rich = rich.map((l) => {
      if (l.closed || l.pts.length < 4) return l
      let out = l
      for (const [head, fromStart] of [
        [s.start, true],
        [s.end, false],
      ] as const) {
        if (!head) continue
        const a = s.width * Math.max(0.05, head.scale)
        const h = HEAD[head.shape]
        const p = backAlong(l, h.length * a, fromStart)
        const tip = fromStart ? [l.pts[0], l.pts[1]] : [l.pts[l.pts.length - 2], l.pts[l.pts.length - 1]]
        loops.push(...headLoops(head.shape, tip[0], tip[1], p.ux, p.uy, a, s, tol))
        out = trim(out, h.trim * a, fromStart)
      }
      return out
    })
  }
  // A profile changes along straight runs too: points every so often for it to change at.
  if (profile) rich = rich.map((l) => densify(l, Math.max(tol * 4, l.total / 96)))
  const pieces = s.dash.length ? (s.dashAlign ? alignedDashes(rich, s.dash) : dashRich(rich, s.dash, s.dashOffset)) : rich
  for (const line of pieces) {
    const pts = line.pts
    const n = pts.length / 2
    if (n === 0) continue
    // Each point's half-width on its left and its right.
    const hl = line.d.map((d) => hw * (profile ? profileAt(profile, line.total > 0 ? d / line.total : 0, 'left') : 1))
    const hr = line.d.map((d) => hw * (profile ? profileAt(profile, line.total > 0 ? d / line.total : 0, 'right') : 1))
    if (n === 1) {
      const dot = dotOutline(pts[0], pts[1], Math.max(hl[0], hr[0]), s.cap, tol)
      if (dot) loops.push(dot)
      continue
    }
    if (line.closed && n >= 3) {
      loops.push(side(pts, hl, s, tol, true))
      loops.push(side(reversed(pts), [...hr].reverse(), s, tol, true))
      continue
    }
    const fwd = side(pts, hl, s, tol, false)
    const back = side(reversed(pts), [...hr].reverse(), s, tol, false)
    const loop = [...fwd]
    cap(loop, pts, n - 1, n - 2, hl[n - 1], hr[n - 1], s.cap, tol)
    // Element by element: spreading a long outline into push's arguments overflows the stack.
    for (let i = 0; i < back.length; i++) loop.push(back[i])
    cap(loop, pts, 0, 1, hr[0], hl[0], s.cap, tol)
    loops.push(loop)
  }
  return loops
}

function reversed(pts: number[]): number[] {
  const out: number[] = []
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1])
  return out
}

/** One side of a polyline, offset by each point's half-width towards each segment's normal (−dy, dx), with joins. */
function side(pts: number[], hws: number[], s: StrokeStyle, tol: number, closed: boolean): number[] {
  const n = pts.length / 2
  const out: number[] = []
  const dir = (i: number): [number, number] => {
    const j = (i + 1) % n
    const dx = pts[j * 2] - pts[i * 2]
    const dy = pts[j * 2 + 1] - pts[i * 2 + 1]
    const l = Math.hypot(dx, dy) || 1
    return [dx / l, dy / l]
  }
  const len = (i: number) => {
    const j = (i + 1) % n
    return Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1])
  }
  if (!closed) {
    const d = dir(0)
    out.push(pts[0] - d[1] * hws[0], pts[1] + d[0] * hws[0])
  }
  const first = closed ? 0 : 1
  const last = closed ? n - 1 : n - 2
  for (let i = first; i <= last; i++) {
    const a = (i - 1 + n) % n
    join(out, pts[i * 2], pts[i * 2 + 1], dir(a), dir(i), hws[i], s, tol, Math.min(len(a), len(i)))
  }
  if (!closed) {
    const d = dir(n - 2)
    out.push(pts[(n - 1) * 2] - d[1] * hws[n - 1], pts[(n - 1) * 2 + 1] + d[0] * hws[n - 1])
  }
  return out
}

function join(out: number[], px: number, py: number, da: [number, number], db: [number, number], hw: number, s: StrokeStyle, tol: number, shortest: number) {
  const na = [-da[1], da[0]]
  const nb = [-db[1], db[0]]
  const cross = da[0] * db[1] - da[1] * db[0]
  const dot = da[0] * db[0] + da[1] * db[1]
  if (Math.abs(cross) < 1e-12 && dot > 0) {
    out.push(px + na[0] * hw, py + na[1] * hw)
    return
  }
  // Turning towards this side: it's the inside of the turn. Where the two
  // offsets cross on both segments, through that point; otherwise in
  // through the corner.
  if (cross > 0) {
    const c = Math.sqrt(Math.max(0, (1 + dot) / 2))
    const back = c > 1e-9 ? (hw * Math.sqrt(Math.max(0, 1 - c * c))) / c : Infinity
    if (back <= shortest) {
      const mx = na[0] + nb[0]
      const my = na[1] + nb[1]
      const ml = Math.hypot(mx, my) || 1
      out.push(px + (mx / ml) * (hw / c), py + (my / ml) * (hw / c))
      return
    }
    out.push(px + na[0] * hw, py + na[1] * hw, px, py, px + nb[0] * hw, py + nb[1] * hw)
    return
  }
  if (s.join === 'round') {
    const a0 = Math.atan2(na[1], na[0])
    const sweep = Math.atan2(na[0] * nb[1] - na[1] * nb[0], na[0] * nb[0] + na[1] * nb[1])
    const k = arcSteps(hw, sweep, tol)
    for (let j = 0; j <= k; j++) {
      const a = a0 + (sweep * j) / k
      out.push(px + Math.cos(a) * hw, py + Math.sin(a) * hw)
    }
    return
  }
  if (s.join === 'miter') {
    const c = Math.sqrt(Math.max(0, (1 + dot) / 2))
    if (c > 1e-9 && 1 / c <= s.miter) {
      const mx = na[0] + nb[0]
      const my = na[1] + nb[1]
      const ml = Math.hypot(mx, my) || 1
      const r = hw / c
      out.push(px + (mx / ml) * r, py + (my / ml) * r)
      return
    }
  }
  out.push(px + na[0] * hw, py + na[1] * hw, px + nb[0] * hw, py + nb[1] * hw)
}

/**
 * The cap at point \`end\`, the line arriving there from point \`prev\`: the
 * points between the side arriving (\`hIn\` from the line, on its left as it
 * arrives) and the side leaving (\`hOut\`, on its right). A round cap is a
 * half circle, an ellipse's half when the two sides differ.
 */
function cap(out: number[], pts: number[], end: number, prev: number, hIn: number, hOut: number, c: Cap, tol: number) {
  if (c === 'butt') return
  const px = pts[end * 2]
  const py = pts[end * 2 + 1]
  let dx = px - pts[prev * 2]
  let dy = py - pts[prev * 2 + 1]
  const l = Math.hypot(dx, dy) || 1
  dx /= l
  dy /= l
  const nx = -dy
  const ny = dx
  if (c === 'square') {
    const ext = Math.max(hIn, hOut)
    out.push(px + nx * hIn + dx * ext, py + ny * hIn + dy * ext, px - nx * hOut + dx * ext, py - ny * hOut + dy * ext)
    return
  }
  const a0 = Math.atan2(ny, nx)
  const k = arcSteps(Math.max(hIn, hOut, 1e-9), Math.PI, tol)
  for (let j = 1; j < k; j++) {
    const t = j / k
    const a = a0 - Math.PI * t
    // The radius from one side's half-width to the other's, round the end.
    const r = hIn + (hOut - hIn) * t
    out.push(px + Math.cos(a) * r, py + Math.sin(a) * r)
  }
}

/** A stroke of no length: a round dot, a square, or (butt caps) nothing. */
function dotOutline(x: number, y: number, hw: number, c: Cap, tol: number): number[] | null {
  if (c === 'butt' || !(hw > 0)) return null
  if (c === 'square') return [x - hw, y - hw, x + hw, y - hw, x + hw, y + hw, x - hw, y + hw]
  const k = arcSteps(hw, 2 * Math.PI, tol)
  const out: number[] = []
  for (let j = 0; j < k; j++) {
    const a = (2 * Math.PI * j) / k
    out.push(x + Math.cos(a) * hw, y + Math.sin(a) * hw)
  }
  return out
}

/** How far past the path a stroke can reach: half its widest width, more where a miter or a square cap sticks out, or an arrowhead does. */
export function strokeReach(s: StrokeStyle): number {
  const hw = (s.width / 2) * profileMax(s.profile)
  const miter = s.join === 'miter' ? Math.max(1, s.miter) : 1
  const capR = s.cap === 'square' ? Math.SQRT2 : 1
  let r = hw * Math.max(miter, capR)
  // A head reaches from the end as far as its widest part, in widths × its scale.
  for (const h of [s.start, s.end]) if (h) r = Math.max(r, s.width * Math.max(0.05, h.scale) * 3.5)
  return r
}
