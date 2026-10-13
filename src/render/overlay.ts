/**
 * Overlays: what the tools draw over the canvas, drawn by the engine in
 * the same frame as the canvas, so they never lag it while the view moves.
 *
 * The page sends each document's overlay in document pixels: lines (a
 * marquee or lasso being drawn, a transform's box, a crop's frame),
 * handles, and the crop's shade; and for paths, their outline, anchors and
 * handles in the accent colour, as the Pen and Direct Selection show them. The selection's marching ants and Quick
 * Mask's tint aren't shapes: the screen shader draws them from the
 * selection's coverage (renderer.ts).
 *
 * Guides, the grid and the pixel grid are the overlay's `view`: what the
 * page shows of the document (its guides) and of the view settings (the
 * grid), drawn under the tools' shapes. A guide crosses the whole canvas;
 * the grid covers the document, its finer lines left out when they'd be
 * closer than a few device pixels, and the pixel grid shows from 600%.
 *
 * Each frame the shapes go through the view into device pixels and are cut
 * into triangles here, on the CPU: a few hundred at most, and the grid's
 * lines, which are never closer than a few device pixels.
 */
import type { Guide } from '../doc/types'
import { apply, invert, type Matrix } from './view'

export type OverlayShape =
  /** A line through points: `ants` dashes black and white and crawls; `line` is white edged with black; `thin` is one accent-coloured pixel; `smart` one pixel in the smart guides' colour. */
  | { kind: 'path'; points: [number, number][]; closed: boolean; style: 'ants' | 'line' | 'thin' | 'smart' }
  /** A guide being dragged: across the whole canvas, in the guides' colour. */
  | { kind: 'guide'; axis: 'x' | 'y'; at: number }
  /** Square handles, a few device pixels across whatever the zoom. */
  | { kind: 'handles'; points: [number, number][] }
  /** A path's anchors: small accent squares, filled when selected, hollow when not. */
  | { kind: 'anchors'; points: [number, number][]; selected: boolean[] }
  /** The ends of a path's handles: small accent diamonds. */
  | { kind: 'dots'; points: [number, number][] }
  /** Filled quadrilaterals, four corners each: a text selection's highlight, see-through. */
  | { kind: 'quads'; points: [number, number][] }

export interface Overlay {
  shapes: OverlayShape[]
  /** Darkens everything outside this quadrilateral (the crop being made), or nothing. */
  shade: [number, number][] | null
  /** Quick Mask: the selection shown as a red tint over what isn't selected, instead of ants. */
  quickMask: boolean
  /** Hides the selection's ants (while a tool draws its own outline, or the selection is being moved). */
  hideAnts?: boolean
  /** Guides and grids, under the shapes; none when nothing's shown. */
  view?: OverlayView | null
  /** View → Tiled View: a tiled document's copies shown round it; absent is on. */
  tiledView?: boolean
}

export type Rgb = [number, number, number]

export interface OverlayView {
  /** The document's size, which the grid covers. */
  width: number
  height: number
  /** The guides shown. */
  guides: Guide[]
  /** A grid line every `step` pixels through `origin`, each cell cut `sub` ways by fainter lines. */
  grid: { step: [number, number]; origin: [number, number]; sub: number } | null
  /** Lines between pixels, when zoomed in far enough to see them. */
  pixelGrid: boolean
  colours: { guide: Rgb; smart: Rgb; grid: Rgb }
}

/** The pixel grid shows from this zoom (CSS pixels per document pixel) up, as Photoshop's does past 500%. */
export const PIXEL_GRID_ZOOM = 6
/** Grid lines closer than this many CSS pixels on screen are left out. */
const GRID_MIN_GAP = 6

export const NO_OVERLAY: Overlay = { shapes: [], shade: null, quickMask: false }

/** Colours a vertex can have, as the overlay shader numbers them. */
export const INK = { ants: 0, black: 1, white: 2, accent: 3, selection: 4, guide: 5, smart: 6, grid: 7, gridSub: 8, pixelGrid: 9 } as const

/** Floats per vertex: x, y in device pixels, distance along the line, ink. */
export const VERTEX_FLOATS = 4

/**
 * The part of the line through device points `p` and `q` inside a canvas `w`
 * by `h` (with a pixel to spare), or null if it misses: the whole line, or
 * only between them when `segment`.
 */
function clip(p: [number, number], q: [number, number], x0: number, w: number, h: number, segment: boolean): [[number, number], [number, number]] | null {
  const dx = q[0] - p[0]
  const dy = q[1] - p[1]
  let t0 = segment ? 0 : -Infinity
  let t1 = segment ? 1 : Infinity
  for (const [d, lo, hi, v] of [
    [dx, x0 - 2, x0 + w + 2, p[0]],
    [dy, -2, h + 2, p[1]],
  ]) {
    if (Math.abs(d) < 1e-12) {
      if (v < lo || v > hi) return null
      continue
    }
    const a = (lo - v) / d
    const b = (hi - v) / d
    t0 = Math.max(t0, Math.min(a, b))
    t1 = Math.min(t1, Math.max(a, b))
  }
  if (!(t1 > t0)) return null
  return [
    [p[0] + dx * t0, p[1] + dy * t0],
    [p[0] + dx * t1, p[1] + dy * t1],
  ]
}

/**
 * The overlay's triangles in device pixels, through the view `vm` (document
 * to device pixels), on a canvas `size` device pixels, with the guides and
 * grids of `view` under the shapes.
 */
export function tessellate(shapes: OverlayShape[], vm: Matrix, dpr: number, size: { width: number; height: number; x?: number } = { width: 1e5, height: 1e5 }, view: OverlayView | null = null): Float32Array {
  // A pane of a split view starts `x` device pixels in.
  const x0 = size.x ?? 0
  const out: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[], ink: number, da = 0, db = 0) => {
    out.push(a[0], a[1], da, ink, b[0], b[1], db, ink, c[0], c[1], db, ink)
    out.push(a[0], a[1], da, ink, c[0], c[1], db, ink, d[0], d[1], da, ink)
  }
  const segment = (p: number[], q: number[], half: number, ink: number, d0: number) => {
    const dx = q[0] - p[0]
    const dy = q[1] - p[1]
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) return 0
    // Out to the side, and a little past each end so corners meet.
    const nx = (-dy / len) * half
    const ny = (dx / len) * half
    const ex = (dx / len) * half
    const ey = (dy / len) * half
    quad([p[0] + nx - ex, p[1] + ny - ey], [q[0] + nx + ex, q[1] + ny + ey], [q[0] - nx + ex, q[1] - ny + ey], [p[0] - nx - ex, p[1] - ny - ey], ink, d0, d0 + len)
    return len
  }
  const px = Math.max(1, Math.round(dpr))
  /** One device pixel wide, between two document points, clipped to the canvas; `endless` for the whole line through them. */
  const hairline = (a: [number, number], b: [number, number], ink: number, endless = false) => {
    const c = clip(apply(vm, ...a), apply(vm, ...b), x0, size.width, size.height, !endless)
    if (c) segment(c[0], c[1], 0.5 * px, ink, 0)
  }
  if (view) {
    const scale = Math.sqrt(Math.abs(vm[0] * vm[3] - vm[1] * vm[2]))
    // What of the document is on the canvas: its corners back through the view.
    const inv = invert(vm)
    const corners = [apply(inv, x0, 0), apply(inv, x0 + size.width, 0), apply(inv, x0, size.height), apply(inv, x0 + size.width, size.height)]
    const vx0 = Math.max(0, Math.min(...corners.map((c) => c[0])))
    const vx1 = Math.min(view.width, Math.max(...corners.map((c) => c[0])))
    const vy0 = Math.max(0, Math.min(...corners.map((c) => c[1])))
    const vy1 = Math.min(view.height, Math.max(...corners.map((c) => c[1])))
    // Lines every `step` through `origin` between lo and hi, the finer ones too when they're far enough apart on screen.
    const lines = (step: number, origin: number, sub: number, lo: number, hi: number, draw: (at: number, major: boolean) => void) => {
      const fine = step / Math.max(1, sub)
      const fineShows = fine * scale >= GRID_MIN_GAP * dpr
      const each = fineShows ? fine : step
      if (!(each > 0) || each * scale < GRID_MIN_GAP * dpr) return
      const first = Math.ceil((lo - origin) / each - 1e-9)
      const last = Math.floor((hi - origin) / each + 1e-9)
      for (let i = first; i <= last && i - first < 4000; i++) {
        const at = origin + i * each
        const k = (at - origin) / step
        draw(at, !fineShows || Math.abs(k - Math.round(k)) < 1e-6)
      }
    }
    if (vx1 > vx0 && vy1 > vy0) {
      if (view.pixelGrid && scale >= PIXEL_GRID_ZOOM * dpr) {
        lines(1, 0, 1, vx0, vx1, (x) => hairline([x, vy0], [x, vy1], INK.pixelGrid))
        lines(1, 0, 1, vy0, vy1, (y) => hairline([vx0, y], [vx1, y], INK.pixelGrid))
      }
      const g = view.grid
      if (g) {
        lines(g.step[0], g.origin[0], g.sub, vx0, vx1, (x, major) => hairline([x, vy0], [x, vy1], major ? INK.grid : INK.gridSub))
        lines(g.step[1], g.origin[1], g.sub, vy0, vy1, (y, major) => hairline([vx0, y], [vx1, y], major ? INK.grid : INK.gridSub))
      }
    }
    for (const gd of view.guides) hairline(gd.axis === 'x' ? [gd.at, 0] : [0, gd.at], gd.axis === 'x' ? [gd.at, 1] : [1, gd.at], INK.guide, true)
  }
  for (const s of shapes) {
    if (s.kind === 'guide') {
      hairline(s.axis === 'x' ? [s.at, 0] : [0, s.at], s.axis === 'x' ? [s.at, 1] : [1, s.at], INK.guide, true)
      continue
    }
    const pts = s.points.map(([x, y]) => apply(vm, x, y))
    if (s.kind === 'handles') {
      const outer = 4.5 * px
      const inner = 3.5 * px
      for (const [x, y] of pts) {
        quad([x - outer, y - outer], [x + outer, y - outer], [x + outer, y + outer], [x - outer, y + outer], INK.black)
        quad([x - inner, y - inner], [x + inner, y - inner], [x + inner, y + inner], [x - inner, y + inner], INK.white)
      }
      continue
    }
    if (s.kind === 'anchors') {
      const outer = 3.5 * px
      const inner = 2.5 * px
      pts.forEach(([x, y], i) => {
        quad([x - outer, y - outer], [x + outer, y - outer], [x + outer, y + outer], [x - outer, y + outer], INK.accent)
        if (!s.selected[i]) quad([x - inner, y - inner], [x + inner, y - inner], [x + inner, y + inner], [x - inner, y + inner], INK.white)
      })
      continue
    }
    if (s.kind === 'quads') {
      for (let i = 0; i + 3 < pts.length; i += 4) quad(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], INK.selection)
      continue
    }
    if (s.kind === 'dots') {
      const r = 3.5 * px
      for (const [x, y] of pts) quad([x, y - r], [x + r, y], [x, y + r], [x - r, y], INK.accent)
      continue
    }
    const n = s.closed ? pts.length : pts.length - 1
    const passes: [number, number][] =
      s.style === 'ants' ? [[0.5 * px, INK.ants]] : s.style === 'thin' ? [[0.5 * px, INK.accent]] : s.style === 'smart' ? [[0.5 * px, INK.smart]] : [[1.5 * px, INK.black], [0.5 * px, INK.white]]
    for (const [half, ink] of passes) {
      let d = 0
      for (let i = 0; i < n; i++) d += segment(pts[i], pts[(i + 1) % pts.length], half, ink, d)
    }
  }
  return new Float32Array(out)
}
