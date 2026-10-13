/**
 * Snapping: where a point or a box being dragged should land, and the
 * smart guides that show why.
 *
 * Pure maths over document pixels, checked in Node (check:snap). The app
 * (app/snapping.ts) gathers the targets for a gesture once, when it
 * starts: guides, the grid, the canvas's edges and centre, other layers'
 * edges and centres, and path anchors. Each move then asks here how far to
 * pull what's dragged, separately across and down, so it can snap on one
 * axis and slide freely along the other.
 *
 * A box snaps by its left, centre or right (top, middle, bottom) to a
 * line, and between other boxes to equal spacing, as Illustrator's and
 * Affinity's smart guides do: centred in a gap, or the same gap again
 * beside a pair already spaced. Whatever lines up once it has moved is
 * reported, so the app can draw a guide from it to what it lines up with.
 */

/** x0, y0, x1, y1, with x0 ≤ x1 and y0 ≤ y1. */
export type Box = [number, number, number, number]

export type SnapKind = 'guide' | 'grid' | 'document' | 'layer' | 'point'

/**
 * A line something can snap to: an x on the x axis's list, a y on the y's.
 * `span` is how far it runs along the other axis (a layer's edge, from its
 * top to its bottom), for drawing a smart guide to it; a guide has none,
 * since it's drawn already.
 */
export interface SnapLine {
  at: number
  span: [number, number] | null
  kind: SnapKind
}

/** A grid along one axis: a line every `step` pixels, through `origin`. */
export interface GridAxis {
  step: number
  origin: number
}

export interface SnapTargets {
  x: SnapLine[]
  y: SnapLine[]
  grid: { x: GridAxis; y: GridAxis } | null
  /** Other layers' boxes, for equal spacing. */
  boxes: Box[]
}

export const NO_TARGETS: SnapTargets = { x: [], y: [], grid: null, boxes: [] }

/**
 * A smart guide: on the x axis a line straight down at x = `at`, from y =
 * `from` to `to`; on the y axis one straight across.
 */
export interface SmartLine {
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
}

/**
 * A gap of the same size as another: on the x axis from x = `from` to
 * `to`, drawn at y = `at`; on the y axis the same, turned.
 */
export interface GapMark {
  axis: 'x' | 'y'
  from: number
  to: number
  at: number
}

export interface Snap {
  /** How far to move what's dragged to land on what it snapped to. */
  dx: number
  dy: number
  /** Whether it snapped across, and down. */
  x: boolean
  y: boolean
  lines: SmartLine[]
  gaps: GapMark[]
}

const NONE: Snap = { dx: 0, dy: 0, x: false, y: false, lines: [], gaps: [] }

/** Lines this close after a snap count as lined up, for drawing. */
const EPS = 1e-3

/** One way to snap along an axis: how far, and the gaps it would show. */
interface Candidate {
  off: number
  gaps: (moved: Box) => GapMark[]
}

const nearestOnGrid = (v: number, g: GridAxis) => g.origin + Math.round((v - g.origin) / g.step) * g.step

/** The nearest way to snap `features` (positions along one axis) to `lines` or the grid, within `tol`. */
function lineCandidates(features: number[], lines: SnapLine[], grid: GridAxis | null, tol: number): Candidate[] {
  const out: Candidate[] = []
  for (const f of features) {
    for (const l of lines) if (Math.abs(l.at - f) <= tol) out.push({ off: l.at - f, gaps: () => [] })
    if (grid && grid.step > 0) {
      const g = nearestOnGrid(f, grid)
      if (Math.abs(g - f) <= tol) out.push({ off: g - f, gaps: () => [] })
    }
  }
  return out
}

/** An axis's view of a box: its near and far edges along the axis, and across it. */
const along = (b: Box, axis: 'x' | 'y') => (axis === 'x' ? { a0: b[0], a1: b[2], c0: b[1], c1: b[3] } : { a0: b[1], a1: b[3], c0: b[0], c1: b[2] })

/**
 * Equal spacing along an axis: the box centred between its neighbours, or
 * the gap between a neighbour and the one beyond it repeated. Only boxes
 * that overlap it across the axis count, as they're the ones in its row.
 */
function gapCandidates(box: Box, boxes: Box[], axis: 'x' | 'y', tol: number): Candidate[] {
  const m = along(box, axis)
  const w = m.a1 - m.a0
  const mid = (m.a0 + m.a1) / 2
  const row = boxes.map((b) => along(b, axis)).filter((b) => b.c0 < m.c1 && b.c1 > m.c0)
  // Where to draw a gap: across the middle of the overlap of what it's between.
  const across = (p: { c0: number; c1: number }, q: { c0: number; c1: number }) => (Math.max(p.c0, q.c0) + Math.min(p.c1, q.c1)) / 2
  const mark = (from: number, to: number, at: number): GapMark => ({ axis, from, to, at })
  const before = row.filter((b) => b.a1 <= mid).sort((p, q) => q.a1 - p.a1)
  const after = row.filter((b) => b.a0 >= mid).sort((p, q) => p.a0 - q.a0)
  const out: Candidate[] = []
  const A = before[0]
  const B = after[0]
  if (A && B && B.a0 - A.a1 > w) {
    const off = (A.a1 + B.a0 - w) / 2 - m.a0
    if (Math.abs(off) <= tol) {
      out.push({
        off,
        gaps: (moved) => {
          const n = along(moved, axis)
          return [mark(A.a1, n.a0, across(A, n)), mark(n.a1, B.a0, across(n, B))]
        },
      })
    }
  }
  if (A) {
    // The one beyond A: the nearest before it that also shares the row with A.
    const P = row.filter((b) => b.a1 <= A.a0 && b.c0 < A.c1 && b.c1 > A.c0).sort((p, q) => q.a1 - p.a1)[0]
    if (P) {
      const g = A.a0 - P.a1
      const off = A.a1 + g - m.a0
      if (Math.abs(off) <= tol) out.push({ off, gaps: (moved) => [mark(P.a1, A.a0, across(P, A)), mark(A.a1, along(moved, axis).a0, across(A, along(moved, axis)))] })
    }
  }
  if (B) {
    const Q = row.filter((b) => b.a0 >= B.a1 && b.c0 < B.c1 && b.c1 > B.c0).sort((p, q) => p.a0 - q.a0)[0]
    if (Q) {
      const g = Q.a0 - B.a1
      const off = B.a0 - g - m.a1
      if (Math.abs(off) <= tol) out.push({ off, gaps: (moved) => [mark(along(moved, axis).a1, B.a0, across(along(moved, axis), B)), mark(B.a1, Q.a0, across(B, Q))] })
    }
  }
  return out
}

/** The nearest candidate, or null. Lines win a tie with gaps, being listed first. */
function best(c: Candidate[]): Candidate | null {
  let out: Candidate | null = null
  for (const x of c) if (!out || Math.abs(x.off) < Math.abs(out.off) - 1e-9) out = x
  return out
}

/** The smart guides for what lines up with a box (or a point, a box with no size) once it's moved. */
function linesFor(moved: Box, t: SnapTargets, point: boolean): SmartLine[] {
  const out = new Map<string, SmartLine>()
  const add = (axis: 'x' | 'y', at: number, from: number, to: number) => {
    const k = `${axis}${at.toFixed(3)}`
    const had = out.get(k)
    out.set(k, had ? { ...had, from: Math.min(had.from, from), to: Math.max(had.to, to) } : { axis, at, from, to })
  }
  for (const axis of ['x', 'y'] as const) {
    const m = along(moved, axis)
    const features = point ? [m.a0] : [m.a0, (m.a0 + m.a1) / 2, m.a1]
    for (const l of axis === 'x' ? t.x : t.y) {
      if (!l.span) continue
      for (const f of features) if (Math.abs(l.at - f) < EPS) add(axis, l.at, Math.min(l.span[0], m.c0), Math.max(l.span[1], m.c1))
    }
  }
  return [...out.values()]
}

/**
 * Snaps a box dragged to `box`: how far to move it so an edge or its centre
 * lands on a line, or it sits evenly spaced among the others, within `tol`
 * on each axis.
 */
export function snapBox(box: Box, t: SnapTargets, tol: number, axes: { x: boolean; y: boolean } = { x: true, y: true }): Snap {
  if (!(tol > 0)) return NONE
  const pick = (axis: 'x' | 'y') => {
    if (!axes[axis]) return null
    const m = along(box, axis)
    const lines = lineCandidates([m.a0, (m.a0 + m.a1) / 2, m.a1], axis === 'x' ? t.x : t.y, t.grid ? t.grid[axis] : null, tol)
    return best([...lines, ...gapCandidates(box, t.boxes, axis, tol)])
  }
  const cx = pick('x')
  const cy = pick('y')
  const dx = cx?.off ?? 0
  const dy = cy?.off ?? 0
  const moved: Box = [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy]
  return { dx, dy, x: !!cx, y: !!cy, lines: linesFor(moved, t, false), gaps: [...(cx?.gaps(moved) ?? []), ...(cy?.gaps(moved) ?? [])] }
}

/** Snaps a point: to the nearest line or grid line within `tol` across, and down. */
export function snapPoint(x: number, y: number, t: SnapTargets, tol: number): Snap {
  if (!(tol > 0)) return NONE
  const cx = best(lineCandidates([x], t.x, t.grid?.x ?? null, tol))
  const cy = best(lineCandidates([y], t.y, t.grid?.y ?? null, tol))
  const dx = cx?.off ?? 0
  const dy = cy?.off ?? 0
  return { dx, dy, x: !!cx, y: !!cy, lines: linesFor([x + dx, y + dy, x + dx, y + dy], t, true), gaps: [] }
}

/** A box's lines to snap to: its edges and centre on each axis, each running its length. */
export function boxLines(b: Box, kind: SnapKind): { x: SnapLine[]; y: SnapLine[] } {
  return {
    x: [b[0], (b[0] + b[2]) / 2, b[2]].map((at) => ({ at, span: [b[1], b[3]] as [number, number], kind })),
    y: [b[1], (b[1] + b[3]) / 2, b[3]].map((at) => ({ at, span: [b[0], b[2]] as [number, number], kind })),
  }
}

/** The box round a list of points, or null for none. */
export function boxOf(points: Iterable<readonly [number, number]>): Box | null {
  let b: Box | null = null
  for (const [x, y] of points) b = b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y]
  return b
}

/** The box round several, or null for none. */
export function unionBox(boxes: Iterable<Box | null>): Box | null {
  let b: Box | null = null
  for (const x of boxes) if (x) b = b ? [Math.min(b[0], x[0]), Math.min(b[1], x[1]), Math.max(b[2], x[2]), Math.max(b[3], x[3])] : [...x]
  return b
}
