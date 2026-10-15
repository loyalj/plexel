/**
 * Warps: the maths of the geometric effects (ARCHITECTURE.md, "Warps").
 *
 * - **Homographies** carry a box's corners anywhere (Free Transform's
 *   Perspective and Distort): 3 × 3 matrices, row by row, applied to
 *   (x, y, 1).
 * - **Meshes** of bicubic Bézier patches (Warp, and its styles): a grid of
 *   `cols` × `rows` patches, (3·cols + 1) × (3·rows + 1) control points in
 *   the box's own unit square, so the identity mesh has its points at
 *   thirds. A point past the mesh is its edge patch carried on, so a warp
 *   has an inverse everywhere, and what's drawn ends where the content
 *   does, edges and all.
 * - **Liquify** is a field of displacements: each point of the result is
 *   read from itself plus the field there (a backward map), so painting
 *   it is moving where things are read from.
 *
 * Everything is in the node's own coordinates; the render graph carries it
 * through the node's transform. Pure and DOM-free; check-geom runs it.
 */
import type { Box, Pt } from './path'

// --- homographies ------------------------------------------------------------------------------

export type H3 = number[]

const H_IDENTITY: H3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** H applied to (x, y, 1): homogeneous (X, Y, W). */
export const applyH = (h: H3, x: number, y: number): [number, number, number] => [h[0] * x + h[1] * y + h[2], h[3] * x + h[4] * y + h[5], h[6] * x + h[7] * y + h[8]]

/** H applied to a point, divided through; null behind the horizon. */
export function mapH(h: H3, x: number, y: number): Pt | null {
  const [X, Y, W] = applyH(h, x, y)
  return W > 1e-12 ? [X / W, Y / W] : null
}

function mulH(a: H3, b: H3): H3 {
  const o = new Array(9).fill(0)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c]
  return o
}

export function invertH(h: H3): H3 | null {
  const [a, b, c, d, e, f, g, i, j] = h
  const A = e * j - f * i
  const B = -(d * j - f * g)
  const C = d * i - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-300) return null
  const out = [A, -(b * j - c * i), b * f - c * e, B, a * j - c * g, -(a * f - c * d), C, -(a * i - b * g), a * e - b * d].map((v) => v / det)
  return out
}

/** An affine [a, b, c, d, e, f] as a homography. */
const affineH = (m: readonly number[]): H3 => [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1]

/** The homography taking the unit square's corners (0,0), (1,0), (1,1), (0,1) to q's four, in that order; null when they're degenerate. */
export function squareToQuad(q: Pt[]): H3 | null {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q
  const dx1 = x1 - x2
  const dx2 = x3 - x2
  const dy1 = y1 - y2
  const dy2 = y3 - y2
  const sx = x0 - x1 + x2 - x3
  const sy = y0 - y1 + y2 - y3
  let g = 0
  let h = 0
  if (Math.abs(sx) > 1e-12 || Math.abs(sy) > 1e-12) {
    const den = dx1 * dy2 - dx2 * dy1
    if (Math.abs(den) < 1e-300) return null
    g = (sx * dy2 - dx2 * sy) / den
    h = (dx1 * sy - sx * dy1) / den
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1]
}

/** The homography taking a box's corners (top left, top right, bottom right, bottom left) to `corners`. */
export function boxToQuad(box: Box, corners: Pt[]): H3 | null {
  const s = squareToQuad(corners)
  const w = box[2] - box[0]
  const hh = box[3] - box[1]
  if (!s || Math.abs(w) < 1e-12 || Math.abs(hh) < 1e-12) return null
  // Box to the unit square, then the square to the quad.
  return mulH(s, [1 / w, 0, -box[0] / w, 0, 1 / hh, -box[1] / hh, 0, 0, 1])
}

/** Whether four corners make a convex quad going one way round: one a homography can reach without folding. */
export function convexQuad(q: Pt[]): boolean {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = q[i]
    const b = q[(i + 1) % 4]
    const c = q[(i + 2) % 4]
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    if (Math.abs(z) < 1e-12) return false
    if (sign && Math.sign(z) !== sign) return false
    sign = Math.sign(z)
  }
  return true
}

// --- meshes ------------------------------------------------------------------------------------

export interface Mesh {
  cols: number
  rows: number
  /** (3·cols + 1) × (3·rows + 1) points, row by row, x then y, in the box's unit square. */
  pts: number[]
}

export const meshWidth = (m: Mesh) => 3 * m.cols + 1
export const meshHeight = (m: Mesh) => 3 * m.rows + 1

export function identityMesh(cols = 1, rows = 1): Mesh {
  const pts: number[] = []
  for (let j = 0; j <= 3 * rows; j++) for (let i = 0; i <= 3 * cols; i++) pts.push(i / (3 * cols), j / (3 * rows))
  return { cols, rows, pts }
}

/** Whether a mesh moves nothing. */
export function isIdentityMesh(m: Mesh): boolean {
  const id = identityMesh(m.cols, m.rows).pts
  return m.pts.length === id.length && m.pts.every((v, i) => Math.abs(v - id[i]) < 1e-9)
}

/** A mesh read back from a file: whole, or null. */
export function readMesh(v: unknown): Mesh | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const cols = typeof r.cols === 'number' ? Math.round(r.cols) : 0
  const rows = typeof r.rows === 'number' ? Math.round(r.rows) : 0
  if (cols < 1 || rows < 1 || cols > 16 || rows > 16 || !Array.isArray(r.pts)) return null
  const n = (3 * cols + 1) * (3 * rows + 1) * 2
  if (r.pts.length !== n || !r.pts.every((x) => typeof x === 'number' && Number.isFinite(x))) return null
  return { cols, rows, pts: (r.pts as number[]).map((x) => Math.max(-1e4, Math.min(1e4, x))) }
}

const bern = (t: number): [number, number, number, number] => {
  const s = 1 - t
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t]
}
const dbern = (t: number): [number, number, number, number] => {
  const s = 1 - t
  return [-3 * s * s, 3 * s * s - 6 * s * t, 6 * s * t - 3 * t * t, 3 * t * t]
}

/** Which patch (i, j) a point (u, v) of the unit square falls in, and where in it (s, t); outside, the edge patch carried on. */
function patchAt(m: Mesh, u: number, v: number): [number, number, number, number] {
  const i = Math.max(0, Math.min(m.cols - 1, Math.floor(u * m.cols)))
  const j = Math.max(0, Math.min(m.rows - 1, Math.floor(v * m.rows)))
  return [i, j, u * m.cols - i, v * m.rows - j]
}

/**
 * The mesh at (u, v), with its derivatives: [x, y, dx/du, dy/du, dx/dv,
 * dy/dv]. Past the square it goes on straight, along the edge's slope, so
 * it doesn't curl back over itself as a polynomial carried on would.
 */
export function meshEval(m: Mesh, u: number, v: number): [number, number, number, number, number, number] {
  const cu = Math.max(0, Math.min(1, u))
  const cv = Math.max(0, Math.min(1, v))
  if (cu === u && cv === v) return patchEval(m, u, v)
  const e = patchEval(m, cu, cv)
  const du = u - cu
  const dv = v - cv
  return [e[0] + e[2] * du + e[4] * dv, e[1] + e[3] * du + e[5] * dv, e[2], e[3], e[4], e[5]]
}

function patchEval(m: Mesh, u: number, v: number): [number, number, number, number, number, number] {
  const [i, j, s, t] = patchAt(m, u, v)
  const W = meshWidth(m)
  const bs = bern(s)
  const bt = bern(t)
  const ds = dbern(s)
  const dt = dbern(t)
  let x = 0
  let y = 0
  let xu = 0
  let yu = 0
  let xv = 0
  let yv = 0
  for (let b = 0; b < 4; b++) {
    for (let a = 0; a < 4; a++) {
      const k = ((3 * j + b) * W + 3 * i + a) * 2
      const px = m.pts[k]
      const py = m.pts[k + 1]
      const w = bs[a] * bt[b]
      x += w * px
      y += w * py
      xu += ds[a] * bt[b] * px
      yu += ds[a] * bt[b] * py
      xv += bs[a] * dt[b] * px
      yv += bs[a] * dt[b] * py
    }
  }
  return [x, y, xu * m.cols, yu * m.cols, xv * m.rows, yv * m.rows]
}

/**
 * Where in the unit square the mesh takes to (x, y): Newton's method from
 * `guess` (or the nearest of a lattice of the mesh's points), damped so it
 * never gets further away. Null where it finds none (a fold's far side).
 */
export function meshInverse(m: Mesh, x: number, y: number, guess?: Pt | null): Pt | null {
  const tryFrom = (u0: number, v0: number): Pt | null => {
    let u = u0
    let v = v0
    let [fx, fy, xu, yu, xv, yv] = meshEval(m, u, v)
    let err = Math.hypot(x - fx, y - fy)
    for (let it = 0; it < 30 && err > 1e-9; it++) {
      const det = xu * yv - xv * yu
      if (Math.abs(det) < 1e-14) return null
      const du = ((x - fx) * yv - (y - fy) * xv) / det
      const dv = ((y - fy) * xu - (x - fx) * yu) / det
      let step = 1
      let moved = false
      for (let k = 0; k < 12; k++) {
        const nu = Math.max(-4, Math.min(5, u + du * step))
        const nv = Math.max(-4, Math.min(5, v + dv * step))
        const e = meshEval(m, nu, nv)
        const ne = Math.hypot(x - e[0], y - e[1])
        if (ne < err) {
          u = nu
          v = nv
          ;[fx, fy, xu, yu, xv, yv] = e
          err = ne
          moved = true
          break
        }
        step /= 2
      }
      if (!moved) break
    }
    return err < 1e-6 ? [u, v] : null
  }
  // Past the square a mesh's polynomials can fold back: an answer in the square wins, then the one nearest it.
  const outside = (r: Pt) => Math.hypot(Math.max(0, -r[0], r[0] - 1), Math.max(0, -r[1], r[1] - 1))
  let found: Pt | null = null
  const consider = (r: Pt | null) => {
    if (r && (!found || outside(r) < outside(found))) found = r
    return !!found && outside(found) < 1e-9
  }
  if (guess && consider(tryFrom(guess[0], guess[1]))) return found
  // Then from the nearest few points of a lattice: the mesh sampled across and a little past the square.
  const lat = latticeOf(m)
  const best: [number, number][] = []
  // Off the square's image altogether, nothing in the square goes there: the guess's answer stands.
  const sq = lat.box
  if (found && (x < sq[0] || y < sq[1] || x > sq[2] || y > sq[3])) return found

  for (let k = 0; k < lat.uv.length; k += 2) {
    const d = (lat.xy[k] - x) ** 2 + (lat.xy[k + 1] - y) ** 2
    if (best.length < 6 || d < best[best.length - 1][0]) {
      best.push([d, k])
      best.sort((a, b) => a[0] - b[0])
      if (best.length > 6) best.pop()
    }
  }
  for (const [, k] of best) if (consider(tryFrom(lat.uv[k], lat.uv[k + 1]))) break
  return found
}

const lattices = new WeakMap<Mesh, { uv: number[]; xy: number[]; box: Box }>()
function latticeOf(m: Mesh) {
  let l = lattices.get(m)
  if (l) return l
  // The square's image lies within its control points' hull, so within their box.
  const xs = m.pts.filter((_, i) => i % 2 === 0)
  const ys = m.pts.filter((_, i) => i % 2 === 1)
  l = { uv: [], xy: [], box: [Math.min(...xs) - 1e-9, Math.min(...ys) - 1e-9, Math.max(...xs) + 1e-9, Math.max(...ys) + 1e-9] }
  const n = 8
  for (let j = -n; j <= m.rows * n + n; j++)
    for (let i = -n; i <= m.cols * n + n; i++) {
      const u = i / (m.cols * n)
      const v = j / (m.rows * n)
      const e = meshEval(m, u, v)
      l.uv.push(u, v)
      l.xy.push(e[0], e[1])
    }
  lattices.set(m, l)
  return l
}

// --- warp styles ---------------------------------------------------------------------------

/** Photoshop's warp styles, by id and label. */
export const WARP_STYLES: [string, string][] = [
  ['none', 'None'],
  ['custom', 'Custom'],
  ['arc', 'Arc'],
  ['arc-lower', 'Arc Lower'],
  ['arc-upper', 'Arc Upper'],
  ['arch', 'Arch'],
  ['bulge', 'Bulge'],
  ['shell-lower', 'Shell Lower'],
  ['shell-upper', 'Shell Upper'],
  ['flag', 'Flag'],
  ['wave', 'Wave'],
  ['fish', 'Fish'],
  ['rise', 'Rise'],
  ['fisheye', 'Fisheye'],
  ['inflate', 'Inflate'],
  ['squeeze', 'Squeeze'],
  ['twist', 'Twist'],
]

/** A style's shape on the unit square: where (u, v) goes, bend b in −1..1. Horizontal; vertical styles swap the axes. */
function styleAt(style: string, b: number, u: number, v: number): Pt {
  const x = 2 * u - 1
  const hump = 1 - x * x
  switch (style) {
    case 'arc': {
      // Rows become arcs about a centre below (or above): the whole box bent round.
      if (Math.abs(b) < 1e-6) return [u, v]
      const th = b * Math.PI
      const R = 1 / th
      const a = x * (th / 2)
      const r = R + (0.5 - v) * 1
      return [0.5 + r * Math.sin(a) * 1, 0.5 + R - r * Math.cos(a) - (R - R * Math.cos(th / 2)) / 2]
    }
    case 'arc-lower':
      return [u, v + b * 0.5 * hump * v]
    case 'arc-upper':
      return [u, v - b * 0.5 * hump * (1 - v)]
    case 'arch':
      return [u, v - b * 0.5 * hump]
    case 'bulge':
      return [u, 0.5 + (v - 0.5) * (1 + b * hump)]
    case 'shell-lower':
      return [u, v - b * 0.5 * (1 - hump) * v]
    case 'shell-upper':
      return [u, v + b * 0.5 * (1 - hump) * (1 - v)]
    case 'flag':
      return [u, v - b * 0.25 * Math.sin(Math.PI * x)]
    case 'wave':
      return [u, v - b * 0.25 * Math.sin(Math.PI * x + Math.PI * (v - 0.5))]
    case 'fish':
      return [u, 0.5 + (v - 0.5) * (1 + b * 0.5 * Math.sin(Math.PI * u))]
    case 'rise':
      return [u, v - b * 0.3 * x]
    case 'fisheye': {
      const cx = u - 0.5
      const cy = v - 0.5
      const r2 = Math.min(1, (cx * cx + cy * cy) * 2)
      const k = 1 + b * 0.6 * (1 - r2)
      return [0.5 + cx * k, 0.5 + cy * k]
    }
    case 'inflate': {
      const cx = u - 0.5
      const cy = v - 0.5
      const k = 1 + b * 0.4 * (1 - 4 * cx * cx) * (1 - 4 * cy * cy)
      return [0.5 + cx * k, 0.5 + cy * k]
    }
    case 'squeeze':
      return [0.5 + (u - 0.5) * (1 - b * 0.4 * (1 - (2 * v - 1) ** 2)), 0.5 + (v - 0.5) * (1 + b * 0.4 * hump)]
    case 'twist': {
      const cx = u - 0.5
      const cy = v - 0.5
      const r = Math.hypot(cx, cy) * Math.SQRT2
      const a = b * Math.PI * 0.5 * Math.max(0, 1 - r)
      return [0.5 + cx * Math.cos(a) - cy * Math.sin(a), 0.5 + cx * Math.sin(a) + cy * Math.cos(a)]
    }
  }
  return [u, v]
}

// The Bernstein basis at thirds, inverted: control points from a style's values at a 4 × 4 lattice.
const BASIS_INV: number[][] = (() => {
  const B = [0, 1 / 3, 2 / 3, 1].map((t) => bern(t))
  // Gauss–Jordan on a 4 × 4.
  const a = B.map((r, i) => [...r, ...[0, 1, 2, 3].map((k) => (k === i ? 1 : 0))])
  for (let c = 0; c < 4; c++) {
    let p = c
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r
    ;[a[c], a[p]] = [a[p], a[c]]
    const d = a[c][c]
    for (let k = 0; k < 8; k++) a[c][k] /= d
    for (let r = 0; r < 4; r++) {
      if (r === c) continue
      const f = a[r][c]
      for (let k = 0; k < 8; k++) a[r][k] -= f * a[c][k]
    }
  }
  return a.map((r) => r.slice(4))
})()

/**
 * A style's mesh: one patch through the style's shape at a 4 × 4 lattice,
 * then Horizontal and Vertical Distortion (−1..1) leaning it in
 * perspective. Bend, h and v are Photoshop's percentages over 100.
 */
export function styleMesh(style: string, bend: number, h: number, v: number, vertical: boolean): Mesh {
  const at = (u: number, w: number): Pt => {
    if (!vertical) return styleAt(style, bend, u, w)
    const [a, b] = styleAt(style, bend, w, u)
    return [b, a]
  }
  // Values at the lattice, then control points P = B⁻¹ · V · B⁻ᵀ.
  const V: Pt[][] = [0, 1, 2, 3].map((j) => [0, 1, 2, 3].map((i) => at(i / 3, j / 3)))
  const pts: number[] = []
  for (let j = 0; j < 4; j++)
    for (let i = 0; i < 4; i++) {
      let x = 0
      let y = 0
      for (let b = 0; b < 4; b++)
        for (let a = 0; a < 4; a++) {
          const w = BASIS_INV[j][b] * BASIS_INV[i][a]
          x += w * V[b][a][0]
          y += w * V[b][a][1]
        }
      // Distortion: one side taller than the other (h), or the top wider than the bottom (v).
      const ny = 0.5 + (y - 0.5) * (1 + h * (x - 0.5) * 1.5)
      const nx = 0.5 + (x - 0.5) * (1 - v * (y - 0.5) * 1.5)
      pts.push(nx, ny)
    }
  return { cols: 1, rows: 1, pts }
}

// --- the transform warp ----------------------------------------------------------------------

/**
 * Free Transform's warp, as it's kept on a node: a frame (the affine
 * taking the unit square to the box it was made on, in the node's own
 * coordinates), a mesh over the square, and where the box's corners go
 * after it (perspective and distort). A point of the box goes into the
 * square, through the mesh, then the corners' homography.
 */
export interface TransformWarp {
  /** The unit square to the box, [a, b, c, d, e, f] as Mat. */
  frame: number[]
  /** Where the box's corners go, top left first, clockwise: eight numbers, in the node's own coordinates. */
  corners: number[]
  mesh: Mesh | null
}

/** The frame of an upright box. */
export const boxFrame = (b: Box): number[] => [b[2] - b[0], 0, 0, b[3] - b[1], b[0], b[1]]

/** A frame's corners: the unit square's, through it. */
export function frameCorners(f: number[]): number[] {
  const out: number[] = []
  for (const [u, v] of [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ])
    out.push(f[0] * u + f[2] * v + f[4], f[1] * u + f[3] * v + f[5])
  return out
}

export const boxCorners = (b: Box) => frameCorners(boxFrame(b))

export const quadPoints = (c: number[]): Pt[] => [0, 1, 2, 3].map((i) => [c[2 * i], c[2 * i + 1]])

/** A transform warp made ready to map points both ways, and to bound what it does. */
export class WarpMap {
  readonly h: H3
  readonly hinv: H3
  private readonly fi: number[]
  private last: Pt | null = null
  constructor(readonly spec: TransformWarp) {
    const h = squareToQuad(quadPoints(spec.corners)) ?? affineH(spec.frame)
    this.h = h
    let hi = invertH(h) ?? H_IDENTITY
    // W positive inside: the quad's middle in front.
    const c = quadPoints(spec.corners).reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0])
    if (applyH(hi, c[0], c[1])[2] < 0) hi = hi.map((v) => -v)
    this.hinv = hi
    const f = spec.frame
    const d = f[0] * f[3] - f[1] * f[2] || 1e-12
    this.fi = [f[3] / d, -f[1] / d, -f[2] / d, f[0] / d, (f[2] * f[5] - f[3] * f[4]) / d, (f[1] * f[4] - f[0] * f[5]) / d]
  }

  /** A point of the node (before) to where it's drawn (after). */
  forward(x: number, y: number): Pt | null {
    const fi = this.fi
    let u = fi[0] * x + fi[2] * y + fi[4]
    let v = fi[1] * x + fi[3] * y + fi[5]
    if (this.spec.mesh) [u, v] = meshEval(this.spec.mesh, u, v)
    return mapH(this.h, u, v)
  }

  /**
   * Where a point drawn at (x, y) is read from, homogeneous: [X, Y, W],
   * the point being (X / W, Y / W). Linear in (x, y) with no mesh, so it
   * interpolates exactly. Null where nothing is drawn.
   */
  inverse(x: number, y: number): [number, number, number] | null {
    let [U, V, W] = applyH(this.hinv, x, y)
    if (W <= 1e-12) return null
    const { mesh, frame: f } = this.spec
    if (mesh) {
      const uv = meshInverse(mesh, U / W, V / W, this.last)
      this.last = uv
      // Well past the box there's nothing to read (the content is in it), and nothing is read: no stray copies.
      if (!uv || uv[0] < -0.25 || uv[1] < -0.25 || uv[0] > 1.25 || uv[1] > 1.25) return null
      U = uv[0] * W
      V = uv[1] * W
    }
    return [f[0] * U + f[2] * V + f[4] * W, f[1] * U + f[3] * V + f[5] * W, W]
  }

  /** Where a rectangle of the node goes: its edges sampled and mapped. */
  bounds(r: Box): Box | null {
    return mappedBounds(r, (x, y) => this.forward(x, y))
  }
}

/** The box round where a rectangle's edges go under `f`, sampled finely, with a little to spare. */
function mappedBounds(r: Box, f: (x: number, y: number) => Pt | null, n = 32): Box | null {
  let b: Box | null = null
  const add = (x: number, y: number) => {
    const p = f(x, y)
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return
    b = b ? [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])] : [p[0], p[1], p[0], p[1]]
  }
  for (let i = 0; i <= n; i++) {
    const t = i / n
    add(r[0] + (r[2] - r[0]) * t, r[1])
    add(r[0] + (r[2] - r[0]) * t, r[3])
    add(r[0], r[1] + (r[3] - r[1]) * t)
    add(r[2], r[1] + (r[3] - r[1]) * t)
  }
  if (!b) return null
  const bb: Box = b
  const m = 0.02 * Math.max(bb[2] - bb[0], bb[3] - bb[1]) + 2
  return [bb[0] - m, bb[1] - m, bb[2] + m, bb[3] + m]
}

/**
 * Lines (closed loops or open runs of x, y pairs) carried through a point
 * map, each straight piece cut until its middle lands within `tol` of
 * where the map takes it: what a warped shape's outline is drawn from.
 */
export function warpLines(pts: ArrayLike<number>, f: (x: number, y: number) => Pt | null, tol: number, closed: boolean): number[] {
  const out: number[] = []
  const n = pts.length / 2
  if (!n) return out
  const at = (i: number) => f(pts[2 * i], pts[2 * i + 1])
  let prev = at(0)
  let px = pts[0]
  let py = pts[1]
  if (prev) out.push(prev[0], prev[1])
  const seg = (ax: number, ay: number, a: Pt, bx: number, by: number, b: Pt, depth: number) => {
    const mx = (ax + bx) / 2
    const my = (ay + by) / 2
    const m = f(mx, my)
    // The middle and the quarters: a wave can cross the line at its middle and still stray from it.
    const off = (t: number, p: Pt | null) => !!p && Math.hypot(p[0] - (a[0] + (b[0] - a[0]) * t), p[1] - (a[1] + (b[1] - a[1]) * t)) > tol
    const bent = !!m && (off(0.5, m) || off(0.25, f(ax + (bx - ax) * 0.25, ay + (by - ay) * 0.25)) || off(0.75, f(ax + (bx - ax) * 0.75, ay + (by - ay) * 0.75)))
    if (m && depth < 14 && bent) {
      seg(ax, ay, a, mx, my, m, depth + 1)
      seg(mx, my, m, bx, by, b, depth + 1)
      return
    }
    out.push(b[0], b[1])
  }
  const last = closed ? n : n - 1
  for (let i = 1; i <= last; i++) {
    const k = i % n
    const qx = pts[2 * k]
    const qy = pts[2 * k + 1]
    const q = at(k)
    if (prev && q) seg(px, py, prev, qx, qy, q, 0)
    else if (q) out.push(q[0], q[1])
    prev = q
    px = qx
    py = qy
  }
  // A closed loop ends where it began: the last point is the first again.
  if (closed && out.length >= 4) out.length -= 2
  return out
}

// --- liquify -----------------------------------------------------------------------------------

/**
 * A Liquify field: displacements at a grid of points over `area` (in the
 * node's own coordinates), `cols` × `rows` of them, corners included.
 * A point drawn at q is read from q + d(q).
 */
export interface Field {
  area: Box
  cols: number
  rows: number
  d: Float32Array
}

/** The most points a field has a side. */
const FIELD_MAX = 320

/** An empty field for a node whose content is `box`: a quarter as much again all round, so things can be pushed out of it. */
export function newField(box: Box): Field {
  const w = box[2] - box[0]
  const h = box[3] - box[1]
  const m = Math.max(w, h) * 0.25 + 16
  const area: Box = [box[0] - m, box[1] - m, box[2] + m, box[3] + m]
  const step = Math.max(2, Math.max(area[2] - area[0], area[3] - area[1]) / (FIELD_MAX - 1))
  const cols = Math.max(2, Math.ceil((area[2] - area[0]) / step) + 1)
  const rows = Math.max(2, Math.ceil((area[3] - area[1]) / step) + 1)
  return { area: [area[0], area[1], area[0] + (cols - 1) * step, area[1] + (rows - 1) * step], cols, rows, d: new Float32Array(cols * rows * 2) }
}

/** The spacing of a field's points. */
export const fieldStep = (f: Field) => (f.area[2] - f.area[0]) / (f.cols - 1)

/** The displacement at (x, y): bilinear between the points, nothing outside the area. */
export function fieldAt(f: Field, x: number, y: number): Pt {
  const s = fieldStep(f)
  const gx = (x - f.area[0]) / s
  const gy = (y - f.area[1]) / s
  if (gx < 0 || gy < 0 || gx > f.cols - 1 || gy > f.rows - 1) return [0, 0]
  const i = Math.min(f.cols - 2, Math.floor(gx))
  const j = Math.min(f.rows - 2, Math.floor(gy))
  const fx = gx - i
  const fy = gy - j
  const k = (j * f.cols + i) * 2
  const k2 = k + f.cols * 2
  const d = f.d
  const lx = (d[k] * (1 - fx) + d[k + 2] * fx) * (1 - fy) + (d[k2] * (1 - fx) + d[k2 + 2] * fx) * fy
  const ly = (d[k + 1] * (1 - fx) + d[k + 3] * fx) * (1 - fy) + (d[k2 + 1] * (1 - fx) + d[k2 + 3] * fx) * fy
  return [lx, ly]
}

/** The largest displacement in a field. */
export function fieldReach(f: Field): number {
  let m = 0
  for (let i = 0; i < f.d.length; i += 2) m = Math.max(m, Math.hypot(f.d[i], f.d[i + 1]))
  return m
}

export const isEmptyField = (f: Field) => f.d.every((v) => v === 0)

/** A field kept in a document: its numbers as 16-bit eighths of a pixel, in base 64. */
export interface StoredField {
  area: Box
  cols: number
  rows: number
  data: string
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function encodeField(f: Field): StoredField {
  const bytes = new Uint8Array(f.d.length * 2)
  for (let i = 0; i < f.d.length; i++) {
    const v = Math.max(-32767, Math.min(32767, Math.round(f.d[i] * 8)))
    bytes[2 * i] = v & 255
    bytes[2 * i + 1] = (v >> 8) & 255
  }
  let s = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=')
  }
  return { area: [...f.area] as Box, cols: f.cols, rows: f.rows, data: s }
}

const decoded = new Map<string, Float32Array>()
const B64_AT = new Int16Array(128).fill(-1)
for (let i = 0; i < 64; i++) B64_AT[B64.charCodeAt(i)] = i

/** A stored field read back; null when it's not whole. Decoded once per data string. */
export function decodeField(v: unknown): Field | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const area = r.area
  const cols = r.cols
  const rows = r.rows
  if (!Array.isArray(area) || area.length !== 4 || !area.every((x) => typeof x === 'number' && Number.isFinite(x))) return null
  if (typeof cols !== 'number' || typeof rows !== 'number' || cols < 2 || rows < 2 || cols > FIELD_MAX || rows > FIELD_MAX || typeof r.data !== 'string') return null
  const n = cols * rows * 2
  let d = decoded.get(r.data)
  if (d && d.length !== n) return null
  if (!d) {
    const s = r.data
    const bytes = new Uint8Array(Math.floor((s.length * 3) / 4))
    let o = 0
    for (let i = 0; i + 3 < s.length + 1 && i < s.length; i += 4) {
      const a = B64_AT[s.charCodeAt(i)]
      const b = B64_AT[s.charCodeAt(i + 1)]
      const c = s[i + 2] === '=' ? 0 : B64_AT[s.charCodeAt(i + 2)]
      const e = s[i + 3] === '=' ? 0 : B64_AT[s.charCodeAt(i + 3)]
      if (a < 0 || b < 0 || c < 0 || e < 0) return null
      const k = (a << 18) | (b << 12) | (c << 6) | e
      bytes[o++] = (k >> 16) & 255
      if (s[i + 2] !== '=') bytes[o++] = (k >> 8) & 255
      if (s[i + 3] !== '=') bytes[o++] = k & 255
    }
    if (o < n * 2) return null
    d = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = bytes[2 * i] | (bytes[2 * i + 1] << 8)
      d[i] = (x >= 32768 ? x - 65536 : x) / 8
    }
    decoded.set(r.data, d)
    // A few fields at a time: the ones being drawn and edited.
    if (decoded.size > 8) decoded.delete(decoded.keys().next().value!)
  }
  return { area: area as Box, cols, rows, d }
}

/** Liquify's tools. */
export type LiquifyTool = 'warp' | 'reconstruct' | 'smooth' | 'twirl-cw' | 'twirl-ccw' | 'pucker' | 'bloat' | 'push-left'

/** How strongly a brush of `radius` acts at distance r from its middle: smooth to nothing at the edge. */
const falloff = (r: number, radius: number) => {
  const t = r / radius
  return t >= 1 ? 0 : (1 - t * t) * (1 - t * t)
}

/**
 * One dab of a Liquify tool on a field, in place: at (x, y), of `radius`,
 * at `pressure` (0..1), the pointer having moved (dx, dy) since the last.
 * The field is a backward map, so a dab works out, for each point near it,
 * where that point should now be read from.
 */
export function liquifyDab(f: Field, tool: LiquifyTool, x: number, y: number, dx: number, dy: number, radius: number, pressure: number) {
  const s = fieldStep(f)
  const i0 = Math.max(0, Math.floor((x - radius - f.area[0]) / s))
  const j0 = Math.max(0, Math.floor((y - radius - f.area[1]) / s))
  const i1 = Math.min(f.cols - 1, Math.ceil((x + radius - f.area[0]) / s))
  const j1 = Math.min(f.rows - 1, Math.ceil((y + radius - f.area[1]) / s))
  if (i1 < i0 || j1 < j0) return
  const old = f.d.slice()
  const was: Field = { ...f, d: old }
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const qx = f.area[0] + i * s
      const qy = f.area[1] + j * s
      const w = falloff(Math.hypot(qx - x, qy - y), radius) * pressure
      if (w <= 0) continue
      const k = (j * f.cols + i) * 2
      // Where q is read from now: a source point, whose own displacement then carries on.
      let sx = qx
      let sy = qy
      switch (tool) {
        case 'warp':
          sx = qx - dx * w
          sy = qy - dy * w
          break
        case 'push-left': {
          // Left of the way the pointer goes: up while it goes right.
          sx = qx - dy * w
          sy = qy + dx * w
          break
        }
        case 'twirl-cw':
        case 'twirl-ccw': {
          const a = (tool === 'twirl-cw' ? -1 : 1) * 0.12 * w
          const c = Math.cos(a)
          const sn = Math.sin(a)
          sx = x + (qx - x) * c - (qy - y) * sn
          sy = y + (qx - x) * sn + (qy - y) * c
          break
        }
        case 'pucker':
        case 'bloat': {
          const k2 = (tool === 'pucker' ? 1 : -1) * 0.06 * w
          sx = x + (qx - x) * (1 + k2)
          sy = y + (qy - y) * (1 + k2)
          break
        }
        case 'reconstruct': {
          const r = Math.min(1, 0.25 * w)
          f.d[k] = old[k] * (1 - r)
          f.d[k + 1] = old[k + 1] * (1 - r)
          continue
        }
        case 'smooth': {
          // Towards the mean of the neighbours.
          let ax = 0
          let ay = 0
          let n = 0
          for (const [di, dj] of [
            [-1, 0],
            [1, 0],
            [0, -1],
            [0, 1],
          ]) {
            const ii = i + di
            const jj = j + dj
            if (ii < 0 || jj < 0 || ii >= f.cols || jj >= f.rows) continue
            const kk = (jj * f.cols + ii) * 2
            ax += old[kk]
            ay += old[kk + 1]
            n++
          }
          const r = Math.min(1, 0.5 * w)
          f.d[k] = old[k] + (ax / n - old[k]) * r
          f.d[k + 1] = old[k + 1] + (ay / n - old[k + 1]) * r
          continue
        }
      }
      const [ex, ey] = fieldAt(was, sx, sy)
      f.d[k] = sx + ex - qx
      f.d[k + 1] = sy + ey - qy
    }
  }
}

// --- editing meshes ----------------------------------------------------------------------------

/** Whether point (i, j) of a mesh is an anchor (a patch corner), not a handle or an inner point. */
export const isAnchor = (i: number, j: number) => i % 3 === 0 && j % 3 === 0
/** Whether point (i, j) is inside a patch: worked out from its edges, never dragged. */
export const isInner = (i: number, j: number) => i % 3 !== 0 && j % 3 !== 0

/**
 * A patch's four inner points made again from its edges (a Coons patch as
 * a tensor patch, as PDF's mesh shadings convert them), so a mesh edited
 * by its anchors and handles bends smoothly inside.
 */
export function coonsInner(m: Mesh, pi: number, pj: number) {
  const W = meshWidth(m)
  const P = (a: number, b: number, c: 0 | 1) => m.pts[((3 * pj + b) * W + 3 * pi + a) * 2 + c]
  const set = (a: number, b: number, c: 0 | 1, v: number) => (m.pts[((3 * pj + b) * W + 3 * pi + a) * 2 + c] = v)
  for (const c of [0, 1] as const) {
    const p = (a: number, b: number) => P(a, b, c)
    set(1, 1, c, (-4 * p(0, 0) + 6 * (p(1, 0) + p(0, 1)) - 2 * (p(3, 0) + p(0, 3)) + 3 * (p(3, 1) + p(1, 3)) - p(3, 3)) / 9)
    set(2, 1, c, (-4 * p(3, 0) + 6 * (p(2, 0) + p(3, 1)) - 2 * (p(0, 0) + p(3, 3)) + 3 * (p(0, 1) + p(2, 3)) - p(0, 3)) / 9)
    set(1, 2, c, (-4 * p(0, 3) + 6 * (p(1, 3) + p(0, 2)) - 2 * (p(3, 3) + p(0, 0)) + 3 * (p(3, 2) + p(1, 0)) - p(3, 0)) / 9)
    set(2, 2, c, (-4 * p(3, 3) + 6 * (p(2, 3) + p(3, 2)) - 2 * (p(0, 3) + p(3, 0)) + 3 * (p(0, 2) + p(2, 0)) - p(0, 0)) / 9)
  }
}

/** A copy of a mesh with a different number of patches, through the same shape: each new patch fitted to the old at a 4 × 4 lattice. */
export function regridMesh(old: Mesh, cols: number, rows: number): Mesh {
  const out: Mesh = { cols, rows, pts: new Array((3 * cols + 1) * (3 * rows + 1) * 2).fill(0) }
  const W = meshWidth(out)
  for (let pj = 0; pj < rows; pj++)
    for (let pi = 0; pi < cols; pi++) {
      const V: Pt[][] = [0, 1, 2, 3].map((b) =>
        [0, 1, 2, 3].map((a) => {
          const e = meshEval(old, (pi + a / 3) / cols, (pj + b / 3) / rows)
          return [e[0], e[1]] as Pt
        }),
      )
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          let x = 0
          let y = 0
          for (let b = 0; b < 4; b++)
            for (let a = 0; a < 4; a++) {
              const w = BASIS_INV[j][b] * BASIS_INV[i][a]
              x += w * V[b][a][0]
              y += w * V[b][a][1]
            }
          const k = ((3 * pj + j) * W + 3 * pi + i) * 2
          out.pts[k] = x
          out.pts[k + 1] = y
        }
    }
  return out
}

/** A mesh's point (i, j). */
export const meshPoint = (m: Mesh, i: number, j: number): Pt => {
  const k = (j * meshWidth(m) + i) * 2
  return [m.pts[k], m.pts[k + 1]]
}

/**
 * Drags point (i, j) of a mesh by (dx, dy), in place: an anchor takes its
 * handles with it; a handle next to an inner anchor turns the handle
 * opposite to stay in line (the curve stays smooth through the anchor);
 * then the inner points of the patches touched are made again.
 */
export function dragMeshPoint(m: Mesh, i: number, j: number, dx: number, dy: number) {
  const W = meshWidth(m)
  const H = meshHeight(m)
  const move = (a: number, b: number, ddx: number, ddy: number) => {
    if (a < 0 || b < 0 || a >= W || b >= H) return
    const k = (b * W + a) * 2
    m.pts[k] += ddx
    m.pts[k + 1] += ddy
  }
  const touched = new Set<string>()
  const touch = (a: number, b: number) => {
    for (const pi of [Math.floor((a - 1) / 3), Math.floor(a / 3)])
      for (const pj of [Math.floor((b - 1) / 3), Math.floor(b / 3)]) if (pi >= 0 && pj >= 0 && pi < m.cols && pj < m.rows) touched.add(`${pi},${pj}`)
  }
  if (isAnchor(i, j)) {
    move(i, j, dx, dy)
    for (const [a, b] of [
      [i - 1, j],
      [i + 1, j],
      [i, j - 1],
      [i, j + 1],
    ])
      move(a, b, dx, dy)
    touch(i, j)
  } else if (!isInner(i, j)) {
    move(i, j, dx, dy)
    touch(i, j)
    // The anchor it belongs to, and the handle across it.
    const horizontal = j % 3 === 0
    const ai = horizontal ? (i % 3 === 1 ? i - 1 : i + 1) : i
    const aj = horizontal ? j : j % 3 === 1 ? j - 1 : j + 1
    const oi = 2 * ai - i
    const oj = 2 * aj - j
    if (oi >= 0 && oj >= 0 && oi < W && oj < H) {
      const a = meshPoint(m, ai, aj)
      const h = meshPoint(m, i, j)
      const o = meshPoint(m, oi, oj)
      // In line, keeping its own length.
      const len = Math.hypot(o[0] - a[0], o[1] - a[1])
      const hl = Math.hypot(h[0] - a[0], h[1] - a[1]) || 1
      move(oi, oj, a[0] - ((h[0] - a[0]) / hl) * len - o[0], a[1] - ((h[1] - a[1]) / hl) * len - o[1])
      touch(oi, oj)
    }
  }
  for (const t of touched) {
    const [pi, pj] = t.split(',').map(Number)
    coonsInner(m, pi, pj)
  }
}

/**
 * Drags a mesh by a point on its surface (u, v) by (dx, dy), in place:
 * the anchors and handles of the patch it's on, each by how much it pulls
 * there, scaled so the point under the pointer follows it.
 */
export function dragMeshSurface(m: Mesh, u: number, v: number, dx: number, dy: number) {
  const pi = Math.max(0, Math.min(m.cols - 1, Math.floor(u * m.cols)))
  const pj = Math.max(0, Math.min(m.rows - 1, Math.floor(v * m.rows)))
  const s = Math.max(0, Math.min(1, u * m.cols - pi))
  const t = Math.max(0, Math.min(1, v * m.rows - pj))
  const bs = bern(s)
  const bt = bern(t)
  let sum = 0
  for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) sum += (bs[a] * bt[b]) ** 2
  const W = meshWidth(m)
  for (let b = 0; b < 4; b++)
    for (let a = 0; a < 4; a++) {
      const w = (bs[a] * bt[b]) / (sum || 1)
      const k = ((3 * pj + b) * W + 3 * pi + a) * 2
      m.pts[k] += dx * w
      m.pts[k + 1] += dy * w
    }
}
