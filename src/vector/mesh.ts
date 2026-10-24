/**
 * Gradient meshes and freeform gradients: the arithmetic both kernels and
 * the editing share.
 *
 * A mesh is a grid of points in rows, each with a colour. A patch is the
 * four-sided cell between four points, its edges straight: a point inside
 * it is found by inverting the bilinear map from the unit square
 * (`invBilinear`), which gives where in the grid it is, (column + u, row +
 * v). The colour there is a Catmull–Rom spline through the points' colours
 * in both directions, so it runs on smoothly from patch to patch, with no
 * creases at the grid lines (the points' own colours are exact). Past the
 * mesh's edge (a shape bigger than its grid) the nearest patch's colour
 * carries on.
 *
 * A freeform gradient blends its colour points by inverse distance: each
 * point's weight is (spread² / distance²)^1.5, so a point's own colour is
 * exact where it is and blends into its neighbours' smoothly; a bigger
 * spread reaches further.
 *
 * Pure and DOM-free: check-geom runs it in Node, and render/shaders/vector.ts
 * does the same sums in WGSL.
 */
import type { Box, Pt } from '../geom/path'
import { MAX_MESH, type FreeformPoint, type MeshNode, type Paint } from '../doc/vector'

export type Mesh = Extract<Paint, { kind: 'mesh' }>

/** The point at column i, row j. */
export const meshNode = (m: Mesh, i: number, j: number): MeshNode => m.nodes[j * (m.cols + 1) + i]

/** Freeform weights: (spread² / (d² + EPS))^1.5. */
export const FREEFORM_EPS = 1e-6

/**
 * Where (x, y) is in the patch a (u = 0, v = 0), b (1, 0), c (1, 1),
 * d (0, 1): the bilinear map inverted, choosing of its two solutions the
 * one nearer the patch. `out` is how far outside the unit square it is (0
 * inside).
 */
export function invBilinear(x: number, y: number, a: Pt, b: Pt, c: Pt, d: Pt): { u: number; v: number; out: number } {
  const ex = b[0] - a[0]
  const ey = b[1] - a[1]
  const fx = d[0] - a[0]
  const fy = d[1] - a[1]
  const gx = a[0] - b[0] + c[0] - d[0]
  const gy = a[1] - b[1] + c[1] - d[1]
  const hx = x - a[0]
  const hy = y - a[1]
  const k2 = gx * fy - gy * fx
  const k1 = ex * fy - ey * fx + hx * gy - hy * gx
  const k0 = hx * ey - hy * ex
  const disc = k1 * k1 - 4 * k0 * k2
  const w = Math.sqrt(Math.max(0, disc))
  // The two roots, stably: q / k2 and k0 / q.
  const q = -0.5 * (k1 + (k1 >= 0 ? w : -w))
  const roots = [q !== 0 ? k0 / q : 1e9, k2 !== 0 ? q / k2 : 1e9]
  let best = { u: 0, v: 0, out: Infinity }
  for (const v of roots) {
    const qx = ex + gx * v
    const qy = ey + gy * v
    const qq = qx * qx + qy * qy
    const u = qq > 0 ? ((hx - fx * v) * qx + (hy - fy * v) * qy) / qq : 0
    const out = Math.max(0, -u, u - 1, -v, v - 1)
    if (out < best.out) best = { u, v, out }
  }
  return best
}

/** The patches (column, row) a mesh has, all of them. */
export function allPatches(m: Pick<Mesh, 'cols' | 'rows'>): number[] {
  const out: number[] = []
  for (let j = 0; j < m.rows; j++) for (let i = 0; i < m.cols; i++) out.push(i, j)
  return out
}

/**
 * Where (x, y) is in the grid: the patch it's in (of `patches`, column and
 * row pairs; all by default), and u, v within it, kept inside the patch
 * when the point's past the mesh's edge.
 */
export function meshLocate(m: Mesh, x: number, y: number, patches = allPatches(m)): { i: number; j: number; u: number; v: number; out: number } {
  let best = { i: 0, j: 0, u: 0, v: 0, out: Infinity }
  for (let k = 0; k < patches.length; k += 2) {
    const i = patches[k]
    const j = patches[k + 1]
    const r = invBilinear(x, y, meshNode(m, i, j).p, meshNode(m, i + 1, j).p, meshNode(m, i + 1, j + 1).p, meshNode(m, i, j + 1).p)
    if (r.out < best.out) {
      best = { i, j, ...r }
      if (r.out <= 0) break
    }
  }
  return { ...best, u: Math.min(1, Math.max(0, best.u)), v: Math.min(1, Math.max(0, best.v)) }
}

/** Catmull–Rom weights at f (0..1) for the knots before, at, after and after that. */
export function catmullRom(f: number): [number, number, number, number] {
  const f2 = f * f
  const f3 = f2 * f
  return [(-f3 + 2 * f2 - f) / 2, (3 * f3 - 5 * f2 + 2) / 2, (-3 * f3 + 4 * f2 + f) / 2, (f3 - f2) / 2]
}

/**
 * A value carried by every point of the grid (`at(i, j)`, any number of
 * channels), at (gu, gv) through the grid, by Catmull–Rom both ways; knots
 * past the edge are the edge's.
 */
export function gridSpline(cols: number, rows: number, at: (i: number, j: number) => ArrayLike<number>, gu: number, gv: number, channels: number): number[] {
  const iu = Math.min(cols - 1, Math.max(0, Math.floor(gu)))
  const iv = Math.min(rows - 1, Math.max(0, Math.floor(gv)))
  const wu = catmullRom(Math.min(1, Math.max(0, gu - iu)))
  const wv = catmullRom(Math.min(1, Math.max(0, gv - iv)))
  const out = new Array<number>(channels).fill(0)
  for (let b = 0; b < 4; b++) {
    const j = Math.min(rows, Math.max(0, iv - 1 + b))
    for (let a = 0; a < 4; a++) {
      const i = Math.min(cols, Math.max(0, iu - 1 + a))
      const w = wu[a] * wv[b]
      const v = at(i, j)
      for (let c = 0; c < channels; c++) out[c] += v[c] * w
    }
  }
  return out
}

/** Where a place in the grid (gu, gv) is: bilinearly within its patch. */
export function meshPointAt(m: Mesh, gu: number, gv: number): Pt {
  const i = Math.min(m.cols - 1, Math.max(0, Math.floor(gu)))
  const j = Math.min(m.rows - 1, Math.max(0, Math.floor(gv)))
  const u = gu - i
  const v = gv - j
  const a = meshNode(m, i, j).p
  const b = meshNode(m, i + 1, j).p
  const c = meshNode(m, i + 1, j + 1).p
  const d = meshNode(m, i, j + 1).p
  return [a[0] * (1 - u) * (1 - v) + b[0] * u * (1 - v) + c[0] * u * v + d[0] * (1 - u) * v, a[1] * (1 - u) * (1 - v) + b[1] * u * (1 - v) + c[1] * u * v + d[1] * (1 - u) * v]
}

/** A point's colour and alpha as stored, at (gu, gv), for new points: straight (not premultiplied), kept in range. */
function nodeAt(m: Mesh, gu: number, gv: number): { colour: number[]; alpha: number } {
  const n = m.nodes[0].colour.length
  const v = gridSpline(m.cols, m.rows, (i, j) => [...meshNode(m, i, j).colour, meshNode(m, i, j).alpha], gu, gv, n + 1)
  return { colour: v.slice(0, n).map((x) => Math.min(1, Math.max(0, x))), alpha: Math.min(1, Math.max(0, v[n])) }
}

/** A grid over a box, `cols` × `rows` patches, each point coloured by `colourAt` (0..1 across and down). */
export function newMesh(box: Box, cols: number, rows: number, colourAt: (u: number, v: number) => { colour: number[]; alpha: number }): Mesh {
  const nodes: MeshNode[] = []
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= cols; i++) {
      const u = i / cols
      const v = j / rows
      nodes.push({ p: [box[0] + (box[2] - box[0]) * u, box[1] + (box[3] - box[1]) * v], ...colourAt(u, v) })
    }
  return { kind: 'mesh', cols, rows, nodes }
}

/** The mesh made again with a new number of patches, each new point where the old grid has it, in its colour there. */
export function resizeMesh(m: Mesh, cols: number, rows: number): Mesh {
  const nodes: MeshNode[] = []
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= cols; i++) {
      const gu = (i / cols) * m.cols
      const gv = (j / rows) * m.rows
      nodes.push({ p: meshPointAt(m, gu, gv), ...nodeAt(m, gu, gv) })
    }
  return { kind: 'mesh', cols, rows, nodes }
}

/**
 * A line of points added through (gu, gv): a column there (`col`), a row
 * (`row`), or both, as Illustrator's Mesh tool adds them. Each new point is
 * on the old patch's edge, in the colour the mesh had there, so the mesh
 * looks the same.
 */
export function splitMesh(m: Mesh, gu: number, gv: number, col: boolean, row: boolean): Mesh {
  const us = [...Array(m.cols + 1).keys()]
  const vs = [...Array(m.rows + 1).keys()]
  const near = (list: number[], g: number) => list.some((x) => Math.abs(x - g) < 1e-6)
  if (col && !near(us, gu) && gu > 0 && gu < m.cols) us.push(gu)
  if (row && !near(vs, gv) && gv > 0 && gv < m.rows) vs.push(gv)
  us.sort((a, b) => a - b)
  vs.sort((a, b) => a - b)
  if (us.length - 1 > MAX_MESH || vs.length - 1 > MAX_MESH) return m
  const nodes: MeshNode[] = []
  for (const v of vs)
    for (const u of us) {
      // An old point stays as it is.
      if (Number.isInteger(u) && Number.isInteger(v)) nodes.push(meshNode(m, u, v))
      else nodes.push({ p: meshPointAt(m, u, v), ...nodeAt(m, u, v) })
    }
  return { kind: 'mesh', cols: us.length - 1, rows: vs.length - 1, nodes }
}

/** The grid line nearest a place: which column or row line, by index, and how far (in grid units). */
export function nearestLines(m: Mesh, gu: number, gv: number): { col: number; du: number; row: number; dv: number } {
  const col = Math.min(m.cols, Math.max(0, Math.round(gu)))
  const row = Math.min(m.rows, Math.max(0, Math.round(gv)))
  return { col, du: Math.abs(gu - col), row, dv: Math.abs(gv - row) }
}

/** A freeform gradient's weights at (x, y), one per point, not normalised. */
export function freeformWeights(points: FreeformPoint[], x: number, y: number): number[] {
  return points.map((q) => {
    const d2 = (x - q.p[0]) ** 2 + (y - q.p[1]) ** 2
    return Math.pow((q.spread * q.spread) / (d2 + FREEFORM_EPS), 1.5)
  })
}

/** A freeform gradient's colour (straight) and alpha at (x, y), from colours already in some space (`colourOf`). */
export function freeformAt(points: FreeformPoint[], x: number, y: number, colourOf: (q: FreeformPoint) => number[]): { colour: number[]; alpha: number } {
  if (!points.length) return { colour: [0, 0, 0, 0], alpha: 0 }
  const w = freeformWeights(points, x, y)
  const sum = w.reduce((s, v) => s + v, 0) || 1
  const n = colourOf(points[0]).length
  const colour = new Array<number>(n).fill(0)
  let alpha = 0
  points.forEach((q, i) => {
    const k = w[i] / sum
    const c = colourOf(q)
    for (let j = 0; j < n; j++) colour[j] += c[j] * q.alpha * k
    alpha += q.alpha * k
  })
  return { colour: colour.map((v) => (alpha > 0 ? v / alpha : 0)), alpha }
}
