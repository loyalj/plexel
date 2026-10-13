/**
 * Coverage: how much of each pixel a filled outline covers, worked out
 * exactly rather than by sampling (ARCHITECTURE.md, "Rendering").
 *
 * An outline is line segments (curves are flattened first, finely enough
 * for the scale they're drawn at). For a pixel, every segment crossing its
 * row adds the area of the pixel to its right, signed by which way the
 * segment runs: summed, that is the integral of the winding number over
 * the pixel. The fill rule turns it into coverage: nonzero takes its size,
 * up to 1; even-odd folds it. That's the analytic coverage Vello and font
 * rasterizers use, and on a pixel crossed by one edge it is exact.
 *
 * The GPU kernel (render/shaders/vector.ts) does the same sum per pixel, on
 * the segments that matter to its region: `regionSegments` picks them out
 * here, clipped to the region's rows, whatever lies right of the region
 * dropped. Whatever lies left of it counts only by its height, the same for
 * every pixel of a row, so it's summed into one number a row: the row's
 * backdrop, which the kernel starts from. A long path far to the left of a
 * tile then costs that tile nothing but its rows. `rasterRegion` is the
 * reference the kernel is held to.
 */
import { applyMat, type Box, type FillRule, type Mat, type Polyline } from './path'

/** Closed loops (x, y pairs) as line segments: x0, y0, x1, y1 each. */
export function loopsToSegments(loops: ArrayLike<number>[], m?: Mat, out: number[] = []): number[] {
  for (const pts of loops) {
    const n = pts.length / 2
    if (n < 2) continue
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      let x0 = pts[i * 2]
      let y0 = pts[i * 2 + 1]
      let x1 = pts[j * 2]
      let y1 = pts[j * 2 + 1]
      if (m) {
        ;[x0, y0] = applyMat(m, x0, y0)
        ;[x1, y1] = applyMat(m, x1, y1)
      }
      if (y0 === y1) continue
      out.push(x0, y0, x1, y1)
    }
  }
  return out
}

/** Polylines filled: an open one is closed for filling, as in Illustrator and SVG. */
export const fillSegments = (lines: Polyline[], m?: Mat) => loopsToSegments(lines.map((l) => l.pts), m)

export function segmentsBounds(segs: ArrayLike<number>): Box | null {
  if (!segs.length) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i < segs.length; i += 2) {
    x0 = Math.min(x0, segs[i])
    x1 = Math.max(x1, segs[i])
    y0 = Math.min(y0, segs[i + 1])
    y1 = Math.max(y1, segs[i + 1])
  }
  return [x0, y0, x1, y1]
}

/** Adds a segment's height, by row, to a region's backdrop: what it gives every pixel right of it in each row. */
function addBackdrop(rows: Float64Array, y0: number, y1: number) {
  const sgn = y1 > y0 ? 1 : -1
  const lo = Math.max(0, Math.min(y0, y1))
  const hi = Math.min(rows.length, Math.max(y0, y1))
  for (let r = Math.floor(lo); r < hi; r++) {
    const a = Math.max(lo, r)
    const b = Math.min(hi, r + 1)
    if (b > a) rows[r] += sgn * (b - a)
  }
}

/**
 * A band of regions in a row (each `size` wide, `h` tall, the first's top
 * left at (0, oy)), sorted out once so each region reads only what crosses
 * it: `cols[c]` the segments over column c's x range, `left[c]` the
 * backdrop of everything wholly left of it, summed. Giving a region its
 * column's `left` as `rows` and its segments to regionSegments comes to the
 * same as giving it the whole band, for a cost that follows the region and
 * not the band's width: dense text across a page, a long path.
 */
export interface SegmentGrid {
  cols: number[][]
  left: Float64Array[]
}

const MAX_COLUMNS = 4096

export function segmentGrid(segs: ArrayLike<number>, oy: number, size: number, h: number): SegmentGrid {
  const cols: number[][] = []
  const delta: (Float64Array | undefined)[] = []
  for (let i = 0; i < segs.length; i += 4) {
    const ay = segs[i + 1] - oy
    const by = segs[i + 3] - oy
    if (ay === by || Math.max(ay, by) <= 0 || Math.min(ay, by) >= h) continue
    const lo = Math.min(segs[i], segs[i + 2])
    const hi = Math.max(segs[i], segs[i + 2])
    // Right of every column up to `end`'s left edge; over columns first..end-1.
    const end = Math.min(MAX_COLUMNS, Math.max(0, Math.ceil(hi / size)))
    const first = Math.max(0, Math.floor(lo / size))
    for (let c = first; c < end; c++) (cols[c] ??= []).push(segs[i], segs[i + 1], segs[i + 2], segs[i + 3])
    addBackdrop((delta[end] ??= new Float64Array(h)), ay, by)
  }
  const n = Math.max(cols.length, delta.length)
  const left: Float64Array[] = []
  let sum = new Float64Array(h)
  for (let c = 0; c < n; c++) {
    const d = delta[c]
    if (d) {
      const next = sum.slice()
      for (let r = 0; r < h; r++) next[r] += d[r]
      sum = next
    }
    left[c] = sum
  }
  return { cols, left }
}

/** A region's share of a grid: its segments and its backdrop's start. */
export function gridColumn(g: SegmentGrid, c: number): { segs: number[]; left: Float64Array | null } {
  const segs = g.cols[c] ?? []
  const left = g.left.length ? g.left[Math.min(c, g.left.length - 1)] : null
  return { segs, left }
}

/**
 * The segments that matter to a region w × h pixels whose top left is at
 * (ox, oy), in the region's own pixels: clipped to its rows, dropped where
 * they're right of it. What's left of it goes into `rows`, the region's
 * backdrop, when that's given (h numbers); without it, it's moved onto the
 * region's left edge as vertical segments, which sum to the same.
 * Appended to `out` (four numbers each); returns how many were added.
 */
export function regionSegments(segs: ArrayLike<number>, ox: number, oy: number, w: number, h: number, out: number[], rows?: Float64Array): number {
  const before = out.length
  const left = (y0: number, y1: number) => (rows ? addBackdrop(rows, y0, y1) : out.push(0, y0, 0, y1))
  for (let i = 0; i < segs.length; i += 4) {
    let ax = segs[i] - ox
    let ay = segs[i + 1] - oy
    let bx = segs[i + 2] - ox
    let by = segs[i + 3] - oy
    if (ay === by) continue
    // Clip to the rows: 0 ≤ y ≤ h.
    const lo = Math.min(ay, by)
    const hi = Math.max(ay, by)
    if (hi <= 0 || lo >= h) continue
    if (lo < 0 || hi > h) {
      const at = (y: number) => ax + ((bx - ax) * (y - ay)) / (by - ay)
      const y0 = Math.max(0, lo)
      const y1 = Math.min(h, hi)
      const down = by > ay
      const xa = at(down ? y0 : y1)
      const xb = at(down ? y1 : y0)
      ;[ax, ay, bx, by] = down ? [xa, y0, xb, y1] : [xa, y1, xb, y0]
    }
    if (Math.min(ax, bx) >= w) continue
    if (Math.max(ax, bx) <= 0) {
      left(ay, by)
      continue
    }
    // Cut where it crosses the left and right edges.
    const ts = [0, 1]
    for (const e of [0, w]) {
      if ((ax - e) * (bx - e) < 0) ts.push((e - ax) / (bx - ax))
    }
    ts.sort((p, q) => p - q)
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k]
      const t1 = ts[k + 1]
      if (t1 - t0 < 1e-12) continue
      const x0 = ax + (bx - ax) * t0
      const y0 = ay + (by - ay) * t0
      const x1 = ax + (bx - ax) * t1
      const y1 = ay + (by - ay) * t1
      const mid = (x0 + x1) / 2
      if (mid >= w) continue
      if (mid <= 0) left(y0, y1)
      else out.push(x0, y0, x1, y1)
    }
  }
  return (out.length - before) / 4
}

/** Rows per strip: the kernel's workgroups are 16 pixels tall. */
export const STRIP = 16

/**
 * A region's segments sorted into strips of 16 rows, the kernel's
 * workgroups: each strip's segments one after another, and where each
 * strip's start (`offsets`, one more than there are strips). A workgroup
 * then reads only the segments crossing its own rows.
 */
export function stripSegments(segs: ArrayLike<number>, h: number): { segs: Float32Array; offsets: Uint32Array } {
  const n = Math.ceil(h / STRIP)
  const lists: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < segs.length; i += 4) {
    const lo = Math.min(segs[i + 1], segs[i + 3])
    const hi = Math.max(segs[i + 1], segs[i + 3])
    const s0 = Math.max(0, Math.floor(lo / STRIP))
    const s1 = Math.min(n - 1, Math.ceil(hi / STRIP) - 1)
    for (let s = s0; s <= s1; s++) lists[s].push(segs[i], segs[i + 1], segs[i + 2], segs[i + 3])
  }
  const offsets = new Uint32Array(n + 1)
  let total = 0
  lists.forEach((l, s) => {
    offsets[s] = total
    total += l.length / 4
  })
  offsets[n] = total
  const out = new Float32Array(Math.max(4, total * 4))
  let at = 0
  for (const l of lists) {
    out.set(l, at)
    at += l.length
  }
  return { segs: out, offsets }
}

/** The antiderivative of how much of a pixel lies right of an edge u pixels into it: u, then u − u²/2, then ½. */
const W = (u: number) => (u <= 0 ? u : u >= 1 ? 0.5 : u - 0.5 * u * u)
const wAt = (u: number) => Math.min(1, Math.max(0, 1 - u))

/** One segment's signed area in pixel (px, py): the kernel's `contrib`, sum for sum. */
export function contribution(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  let sgn = 1
  if (ay > by) {
    ;[ax, ay, bx, by] = [bx, by, ax, ay]
    sgn = -1
  }
  const y0 = Math.max(ay, py)
  const y1 = Math.min(by, py + 1)
  if (y1 <= y0) return 0
  const k = (bx - ax) / (by - ay)
  const xa = ax + k * (y0 - ay) - px
  const xb = ax + k * (y1 - ay) - px
  const dy = y1 - y0
  const avg = Math.abs(xb - xa) < 1e-5 ? wAt(0.5 * (xa + xb)) : (W(xb) - W(xa)) / (xb - xa)
  return sgn * dy * avg
}

/** Accumulated area to coverage, by the fill rule. */
export const coverageOf = (a: number, rule: FillRule) => (rule === 'evenodd' ? Math.abs(a - 2 * Math.round(0.5 * a)) : Math.min(1, Math.abs(a)))

/**
 * The reference: coverage of every pixel of a w × h region from its
 * segments (regionSegments's output), row by row. A segment adds its exact
 * share to the pixels it passes through and its whole height to every pixel
 * right of those.
 */
export function rasterRegion(segs: ArrayLike<number>, w: number, h: number, rule: FillRule, rows?: ArrayLike<number>): Float32Array {
  const area = new Float64Array(w * h)
  const cover = new Float64Array((w + 1) * h)
  if (rows) for (let py = 0; py < h; py++) cover[py * (w + 1)] += rows[py]
  for (let i = 0; i < segs.length; i += 4) {
    const ax = segs[i]
    const ay = segs[i + 1]
    const bx = segs[i + 2]
    const by = segs[i + 3]
    const r0 = Math.max(0, Math.floor(Math.min(ay, by)))
    const r1 = Math.min(h - 1, Math.ceil(Math.max(ay, by)) - 1)
    for (let py = r0; py <= r1; py++) {
      // Where the segment is within this row.
      const lo = Math.max(Math.min(ay, by), py)
      const hi = Math.min(Math.max(ay, by), py + 1)
      if (hi <= lo) continue
      const at = (y: number) => ax + ((bx - ax) * (y - ay)) / (by - ay)
      const xa = at(lo)
      const xb = at(hi)
      const xmin = Math.min(xa, xb)
      const xmax = Math.max(xa, xb)
      const c0 = Math.max(0, Math.floor(xmin))
      const c1 = Math.min(w - 1, Math.floor(xmax))
      for (let px = c0; px <= c1; px++) area[py * w + px] += contribution(ax, ay, bx, by, px, py)
      const full = (by > ay ? 1 : -1) * (hi - lo)
      const from = Math.max(0, c1 + 1)
      if (from < w) cover[py * (w + 1) + from] += full
    }
  }
  const out = new Float32Array(w * h)
  for (let py = 0; py < h; py++) {
    let run = 0
    for (let px = 0; px < w; px++) {
      run += cover[py * (w + 1) + px]
      out[py * w + px] = coverageOf(area[py * w + px] + run, rule)
    }
  }
  return out
}

/** The winding number at a point: segments crossing its row to its left, by direction. For sampled references. */
export function windingAt(segs: ArrayLike<number>, x: number, y: number): number {
  let wn = 0
  for (let i = 0; i < segs.length; i += 4) {
    const ay = segs[i + 1]
    const by = segs[i + 3]
    if (ay <= y === by <= y) continue
    const xc = segs[i] + ((segs[i + 2] - segs[i]) * (y - ay)) / (by - ay)
    if (xc < x) wn += by > ay ? 1 : -1
  }
  return wn
}

export const inside = (wn: number, rule: FillRule) => (rule === 'evenodd' ? (wn & 1) !== 0 : wn !== 0)

/** Coverage by sampling n × n points per pixel: what the exact sums are checked against. */
export function sampledCoverage(segs: ArrayLike<number>, px: number, py: number, rule: FillRule, n = 16): number {
  let hit = 0
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (inside(windingAt(segs, px + (i + 0.5) / n, py + (j + 0.5) / n), rule)) hit++
  return hit / (n * n)
}
