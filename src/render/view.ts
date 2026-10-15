/**
 * The view: where the document sits in the canvas. Pure maths, shared by
 * the page (which owns the view and turns gestures into it) and the engine
 * (which draws through it), and checked in Node.
 *
 * A view is the document point at the canvas's centre, a zoom (CSS pixels
 * per document pixel, so 1 is 100% on every screen) and a rotation in
 * degrees, clockwise as on screen. Keeping the centre rather than an offset
 * means a resize keeps the image where it was, as every editor does.
 *
 * Device pixels are the canvas's own; `dpr` turns CSS pixels into them.
 */
import { TILE } from '../tiles/format'

export interface View {
  cx: number
  cy: number
  zoom: number
  /** Degrees, clockwise, −180 < r ≤ 180. */
  rotation: number
}

export interface Canvas {
  /** Device pixels. */
  width: number
  height: number
  dpr: number
}

/** x' = a·x + c·y + e, y' = b·x + d·y + f, as doc/types' Affine. */
export type Matrix = [number, number, number, number, number, number]

const MIN_ZOOM = 1 / 100
const MAX_ZOOM = 128

/** The zoom steps Ctrl+= and Ctrl+− walk through, as Photoshop's do. */
const ZOOM_STEPS = [
  0.01, 0.015, 0.02, 0.03, 0.04, 0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 32, 48, 64, 96, 128,
]

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

/** An angle folded into −180 < r ≤ 180. */
const normaliseAngle = (r: number) => {
  const m = ((((r + 180) % 360) + 360) % 360) - 180
  return m === -180 ? 180 : m
}

/**
 * Document to device pixels. Unrotated, the translation is rounded to whole
 * device pixels, so at 100%, 200% and the rest every document pixel lands
 * exactly on device pixels and the image is sharp.
 */
export function viewMatrix(v: View, c: Canvas): Matrix {
  const s = v.zoom * c.dpr
  const t = (v.rotation * Math.PI) / 180
  const cos = Math.cos(t) * s
  const sin = Math.sin(t) * s
  let e = c.width / 2 - (cos * v.cx - sin * v.cy)
  let f = c.height / 2 - (sin * v.cx + cos * v.cy)
  if (v.rotation === 0) {
    e = Math.round(e)
    f = Math.round(f)
  }
  return [cos, sin, -sin, cos, e, f]
}

// Affines (geom/affine.ts): multiply(b, a) applies a first, as compose does.
import { apply, compose as multiply, invert } from '../geom/affine'
export { apply, multiply, invert }

/** The document point under a device pixel. */
export const docPoint = (v: View, c: Canvas, x: number, y: number) => apply(invert(viewMatrix(v, c)), x, y)

/**
 * The view that fits the document in the canvas with `margin` CSS pixels
 * around it, unrotated. `upTo100` stops it at 100%, as a document is shown
 * when it opens; Fit on Screen itself may go past.
 */
export function fitView(docW: number, docH: number, c: Canvas, margin = 32, upTo100 = true): View {
  const cssW = c.width / c.dpr
  const cssH = c.height / c.dpr
  let zoom = Math.min((cssW - 2 * margin) / docW, (cssH - 2 * margin) / docH)
  if (upTo100) zoom = Math.min(zoom, 1)
  return { cx: docW / 2, cy: docH / 2, zoom: clampZoom(Math.max(zoom, MIN_ZOOM)), rotation: 0 }
}

/** Zoomed by `factor` (or to `zoom`), keeping the document point under device pixel (x, y) where it is. */
export function zoomAt(v: View, c: Canvas, zoom: number, x: number, y: number): View {
  const z = clampZoom(zoom)
  const [px, py] = docPoint(v, c, x, y)
  // The point stays put: the new centre is the old one, moved towards the
  // point by how much less of the document now fits around it.
  const k = v.zoom / z
  return { ...v, zoom: z, cx: px + (v.cx - px) * k, cy: py + (v.cy - py) * k }
}

/** The next zoom step in or out from `zoom`. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  const eps = 1e-6
  if (dir > 0) return ZOOM_STEPS.find((s) => s > zoom * (1 + eps)) ?? MAX_ZOOM
  return [...ZOOM_STEPS].reverse().find((s) => s < zoom * (1 - eps)) ?? MIN_ZOOM
}

/** Panned by a drag of (dx, dy) device pixels: the document moves with the pointer. */
export function panBy(v: View, c: Canvas, dx: number, dy: number): View {
  const s = v.zoom * c.dpr
  const t = (-v.rotation * Math.PI) / 180
  // The drag, turned back into the document's axes and scaled into its pixels.
  const ux = (dx * Math.cos(t) - dy * Math.sin(t)) / s
  const uy = (dx * Math.sin(t) + dy * Math.cos(t)) / s
  return { ...v, cx: v.cx - ux, cy: v.cy - uy }
}

/** Rotated to `deg`, about the document point at the canvas's centre. */
export const rotateTo = (v: View, deg: number): View => ({ ...v, rotation: normaliseAngle(deg) })

/**
 * Which mip level to render at: 0 is full size, and each level halves it.
 * The level is the finest one that's still no larger than twice what the
 * screen shows, so the final pass never shrinks a level by more than half
 * and bilinear filtering is enough.
 */
export function mipLevel(zoom: number, dpr: number): number {
  const s = zoom * dpr
  return s >= 1 ? 0 : Math.max(0, Math.floor(-Math.log2(s) + 1e-9))
}

/** Tile coordinates and their rectangle at a level, in document pixels. */
export function tileRect(level: number, tx: number, ty: number): [number, number, number, number] {
  const span = TILE * 2 ** level
  return [tx * span, ty * span, (tx + 1) * span, (ty + 1) * span]
}

/** The canvas's four corners in document pixels, clockwise from the top left. */
export function viewQuad(v: View, c: Canvas): [number, number][] {
  const inv = invert(viewMatrix(v, c))
  return [apply(inv, 0, 0), apply(inv, c.width, 0), apply(inv, c.width, c.height), apply(inv, 0, c.height)]
}

/** Whether two convex polygons overlap, by the separating axis test. */
export function convexOverlap(p: [number, number][], q: [number, number][]): boolean {
  for (const poly of [p, q]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i]
      const [x2, y2] = poly[(i + 1) % poly.length]
      const nx = y2 - y1
      const ny = x1 - x2
      let pMin = Infinity
      let pMax = -Infinity
      let qMin = Infinity
      let qMax = -Infinity
      for (const [x, y] of p) {
        const d = x * nx + y * ny
        pMin = Math.min(pMin, d)
        pMax = Math.max(pMax, d)
      }
      for (const [x, y] of q) {
        const d = x * nx + y * ny
        qMin = Math.min(qMin, d)
        qMax = Math.max(qMax, d)
      }
      if (pMax <= qMin || qMax <= pMin) return false
    }
  }
  return true
}

/**
 * The tile columns (or rows) a span of document pixels needs at a level,
 * folded into the document where it repeats: an interval past one edge
 * comes back from the other, and one a period long or more needs them all.
 */
export function foldedTiles(min: number, max: number, size: number, span: number, wraps: boolean): number[] {
  const n = Math.ceil(size / span)
  if (!wraps) {
    const a = Math.max(0, Math.floor(min / span))
    const b = Math.min(n, Math.ceil(max / span))
    return Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i)
  }
  if (max - min >= size) return Array.from({ length: n }, (_, i) => i)
  const a = ((min % size) + size) % size
  const b = a + (max - min)
  const out = new Set<number>()
  const add = (lo: number, hi: number) => {
    for (let t = Math.floor(lo / span); t < Math.min(n, Math.ceil(hi / span)); t++) out.add(t)
  }
  add(a, Math.min(b, size))
  if (b > size) add(0, b - size)
  return [...out]
}

/**
 * The tiles at `level` that are on screen and on the canvas, nearest the
 * centre of the view first, which is the order they're rendered in. Where a
 * tiled document repeats (`wrap`), the copies on screen are folded into the
 * document's own tiles.
 */
export function visibleTiles(v: View, c: Canvas, level: number, docW: number, docH: number, wrap: { x: boolean; y: boolean } = { x: false, y: false }): [number, number][] {
  const quad = viewQuad(v, c)
  if (wrap.x || wrap.y) {
    const span = TILE * 2 ** level
    const xs = quad.map((p) => p[0])
    const ys = quad.map((p) => p[1])
    const cols = foldedTiles(Math.min(...xs), Math.max(...xs), docW, span, wrap.x)
    const rows = foldedTiles(Math.min(...ys), Math.max(...ys), docH, span, wrap.y)
    // Nearest the centre first, measured round the torus.
    const near = (d: number, size: number, on: boolean) => (on ? Math.min(((d % size) + size) % size, size - (((d % size) + size) % size)) : d)
    const out: [number, number, number][] = []
    for (const ty of rows)
      for (const tx of cols) {
        const [l, t, r, b] = tileRect(level, tx, ty)
        const dx = near((l + r) / 2 - v.cx, docW, wrap.x)
        const dy = near((t + b) / 2 - v.cy, docH, wrap.y)
        out.push([tx, ty, dx * dx + dy * dy])
      }
    return out.sort((a, b) => a[2] - b[2]).map(([x, y]) => [x, y])
  }
  const span = TILE * 2 ** level
  const xs = quad.map((p) => p[0])
  const ys = quad.map((p) => p[1])
  const x0 = Math.max(0, Math.floor(Math.min(...xs) / span))
  const y0 = Math.max(0, Math.floor(Math.min(...ys) / span))
  const x1 = Math.min(Math.ceil(docW / span), Math.ceil(Math.max(...xs) / span))
  const y1 = Math.min(Math.ceil(docH / span), Math.ceil(Math.max(...ys) / span))
  const out: [number, number, number][] = []
  for (let ty = y0; ty < y1; ty++) {
    for (let tx = x0; tx < x1; tx++) {
      const [l, t, r, b] = tileRect(level, tx, ty)
      const rect: [number, number][] = [
        [l, t],
        [r, t],
        [r, b],
        [l, b],
      ]
      if (v.rotation !== 0 && !convexOverlap(rect, quad)) continue
      const d = ((l + r) / 2 - v.cx) ** 2 + ((t + b) / 2 - v.cy) ** 2
      out.push([tx, ty, d])
    }
  }
  return out.sort((a, b) => a[2] - b[2]).map(([x, y]) => [x, y])
}

/** Two views that draw the same. */
export const sameView = (a: View | null, b: View | null) =>
  a === b || (!!a && !!b && a.cx === b.cx && a.cy === b.cy && a.zoom === b.zoom && a.rotation === b.rotation)

/**
 * Split view: the canvas cut in two side by side, each pane with a view of
 * its own (app/views.ts). `split` is where the cut is, as a share of the
 * width, or null for one pane. The panes' x and width in device pixels,
 * with a thin gap between.
 */
export interface Pane {
  x: number
  width: number
}

export function paneRects(c: Canvas, split: number | null): Pane[] {
  if (split === null) return [{ x: 0, width: c.width }]
  const gap = Math.max(1, Math.round(2 * c.dpr))
  const left = Math.max(1, Math.round((c.width - gap) * Math.min(0.9, Math.max(0.1, split))))
  return [
    { x: 0, width: left },
    { x: left + gap, width: Math.max(1, c.width - left - gap) },
  ]
}

/** A pane as a canvas of its own, for the view maths. */
export const paneCanvas = (c: Canvas, p: Pane): Canvas => ({ width: p.width, height: c.height, dpr: c.dpr })

/** Which pane a device x on the whole canvas is over: the nearer, in the gap. */
export function paneAt(panes: Pane[], x: number): number {
  if (panes.length < 2) return 0
  return x < (panes[0].x + panes[0].width + panes[1].x) / 2 ? 0 : 1
}

/** A view's matrix for a pane, in the whole canvas's device pixels. */
export function paneMatrix(v: View, c: Canvas, p: Pane): Matrix {
  const m = viewMatrix(v, paneCanvas(c, p))
  return [m[0], m[1], m[2], m[3], m[4] + p.x, m[5]]
}
