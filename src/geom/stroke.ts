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
 * Dashes cut the polylines into pieces first, each stroked with caps.
 */
import type { Polyline } from './path'

export type Join = 'miter' | 'round' | 'bevel'
export type Cap = 'butt' | 'round' | 'square'

export interface StrokeStyle {
  width: number
  join: Join
  cap: Cap
  /** Photoshop's and Illustrator's miter limit: a miter longer than this many widths becomes a bevel. */
  miter: number
  /** Dash and gap lengths, alternating, in the path's units; empty for a solid line. */
  dash: number[]
  dashOffset: number
}

export const SOLID: StrokeStyle = { width: 1, join: 'miter', cap: 'butt', miter: 4, dash: [], dashOffset: 0 }

/** Steps for an arc of `sweep` radians at radius r, staying within tol of the circle. */
function arcSteps(r: number, sweep: number, tol: number): number {
  const t = Math.min(0.999, Math.max(1e-6, tol / Math.max(r, 1e-9)))
  const step = 2 * Math.acos(1 - t)
  return Math.max(1, Math.min(512, Math.ceil(Math.abs(sweep) / step)))
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

/** Cuts polylines into dashes (open pieces) by a dash pattern. */
export function dashLines(lines: Polyline[], dash: number[], offset: number): Polyline[] {
  const pattern = dash.length % 2 ? [...dash, ...dash] : dash
  const total = pattern.reduce((a, b) => a + Math.max(0, b), 0)
  if (!pattern.length || total <= 1e-9) return lines
  const out: Polyline[] = []
  for (const line of lines) {
    const pts = line.closed ? [...line.pts, line.pts[0], line.pts[1]] : line.pts
    // Where in the pattern the line starts.
    let at = ((offset % total) + total) % total
    let k = 0
    while (at > 0 && at >= Math.max(0, pattern[k])) {
      at -= Math.max(0, pattern[k])
      k = (k + 1) % pattern.length
    }
    let left = Math.max(0, pattern[k]) - at
    let on = k % 2 === 0
    let cur: number[] | null = on ? [pts[0], pts[1]] : null
    // Entries of no length where the pattern stands: a dot, or nothing.
    const skipEmpty = (x: number, y: number) => {
      while (left <= 1e-12) {
        if (on && cur) out.push({ pts: cur, closed: false })
        on = !on
        cur = on ? [x, y] : null
        k = (k + 1) % pattern.length
        left = Math.max(0, pattern[k])
      }
    }
    skipEmpty(pts[0], pts[1])
    for (let i = 0; i + 3 < pts.length; i += 2) {
      let x = pts[i]
      let y = pts[i + 1]
      const x1 = pts[i + 2]
      const y1 = pts[i + 3]
      let seg = Math.hypot(x1 - x, y1 - y)
      while (seg > 1e-12) {
        if (left > seg + 1e-12) {
          left -= seg
          if (cur) cur.push(x1, y1)
          seg = 0
          break
        }
        const t = left / seg
        const mx = x + (x1 - x) * t
        const my = y + (y1 - y) * t
        if (cur) {
          cur.push(mx, my)
          out.push({ pts: cur, closed: false })
          cur = null
        } else cur = [mx, my]
        on = !on
        if (!on) cur = null
        seg -= left
        x = mx
        y = my
        k = (k + 1) % pattern.length
        left = Math.max(0, pattern[k])
        // A zero-length dash is still a dash: a dot, with round caps.
        skipEmpty(x, y)
      }
    }
    if (cur && cur.length >= 4) out.push({ pts: cur, closed: false })
    else if (cur && on && left > 1e-12 && Math.max(0, pattern[k]) <= 1e-12) out.push({ pts: cur, closed: false })
  }
  return out
}

/** The outline a stroke paints, as loops to fill with the nonzero rule. `tol` is how close round joins and caps keep to their circles. */
export function strokeOutline(lines: Polyline[], s: StrokeStyle, tol: number): number[][] {
  const hw = s.width / 2
  if (!(hw > 0)) return []
  const pieces = s.dash.length ? dashLines(lines, s.dash, s.dashOffset) : lines
  const loops: number[][] = []
  for (const line of pieces) {
    const pts = clean(line.pts, line.closed)
    const n = pts.length / 2
    if (n === 0) continue
    if (n === 1) {
      const dot = dotOutline(pts[0], pts[1], hw, s.cap, tol)
      if (dot) loops.push(dot)
      continue
    }
    if (line.closed && n >= 3) {
      loops.push(side(pts, hw, s, tol, true))
      loops.push(side(reversed(pts), hw, s, tol, true))
      continue
    }
    const fwd = side(pts, hw, s, tol, false)
    const back = side(reversed(pts), hw, s, tol, false)
    const loop = [...fwd]
    cap(loop, pts, n - 1, n - 2, hw, s.cap, tol)
    // Element by element: spreading a long outline into push's arguments overflows the stack.
    for (let i = 0; i < back.length; i++) loop.push(back[i])
    cap(loop, pts, 0, 1, hw, s.cap, tol)
    loops.push(loop)
  }
  return loops
}

function reversed(pts: number[]): number[] {
  const out: number[] = []
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1])
  return out
}

/** One side of a polyline, offset by hw towards each segment's normal (−dy, dx), with joins. */
function side(pts: number[], hw: number, s: StrokeStyle, tol: number, closed: boolean): number[] {
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
    out.push(pts[0] - d[1] * hw, pts[1] + d[0] * hw)
  }
  const first = closed ? 0 : 1
  const last = closed ? n - 1 : n - 2
  for (let i = first; i <= last; i++) {
    const a = (i - 1 + n) % n
    join(out, pts[i * 2], pts[i * 2 + 1], dir(a), dir(i), hw, s, tol, Math.min(len(a), len(i)))
  }
  if (!closed) {
    const d = dir(n - 2)
    out.push(pts[(n - 1) * 2] - d[1] * hw, pts[(n - 1) * 2 + 1] + d[0] * hw)
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

/** The cap at point `end`, the line arriving there from point `prev`; adds the points between the two sides. */
function cap(out: number[], pts: number[], end: number, prev: number, hw: number, c: Cap, tol: number) {
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
    out.push(px + (nx + dx) * hw, py + (ny + dy) * hw, px + (-nx + dx) * hw, py + (-ny + dy) * hw)
    return
  }
  const a0 = Math.atan2(ny, nx)
  const k = arcSteps(hw, Math.PI, tol)
  for (let j = 1; j < k; j++) {
    const a = a0 - (Math.PI * j) / k
    out.push(px + Math.cos(a) * hw, py + Math.sin(a) * hw)
  }
}

/** A stroke of no length: a round dot, a square, or (butt caps) nothing. */
function dotOutline(x: number, y: number, hw: number, c: Cap, tol: number): number[] | null {
  if (c === 'butt') return null
  if (c === 'square') return [x - hw, y - hw, x + hw, y - hw, x + hw, y + hw, x - hw, y + hw]
  const k = arcSteps(hw, 2 * Math.PI, tol)
  const out: number[] = []
  for (let j = 0; j < k; j++) {
    const a = (2 * Math.PI * j) / k
    out.push(x + Math.cos(a) * hw, y + Math.sin(a) * hw)
  }
  return out
}

/** How far past the path a stroke can reach: half its width, more where a miter or a square cap sticks out. */
export function strokeReach(s: StrokeStyle): number {
  const hw = s.width / 2
  const miter = s.join === 'miter' ? Math.max(1, s.miter) : 1
  const capR = s.cap === 'square' ? Math.SQRT2 : 1
  return hw * Math.max(miter, capR)
}
