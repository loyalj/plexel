/**
 * Colour adjustments on a CMYK document, through its profile.
 *
 * Hue/Saturation, Colour Balance and the other colour operations work on
 * RGB. A CMYK pixel is taken there through the document's profile (to a
 * working RGB, Adobe RGB compatible, wide enough for any press), adjusted,
 * and brought back with its black ink kept: C, M and Y are solved for with
 * K where it was, as a separator preserving black would. Two tables do it,
 * both in light (1 − ink, the compositor's terms) and sampled as the
 * display tables are, tetrahedral in three channels and linear across K:
 *
 *   fwd: (c, m, y) on a grid, per K slice, to the working RGB.
 *   inv: RGB on a grid, per K slice, to the (c, m, y) that make it with
 *        that K, solved on `fwd` by Newton's method inside the unit cube.
 *
 * The result is applied as a change, cmy + inv(adjusted) − inv(original),
 * so a pixel the adjustment leaves alone comes back exactly as it was,
 * whatever the tables' error, and the tables' error largely cancels for
 * the rest.
 */
import { FLAGS, type Cms, type Profile } from './cms'
import { tetra } from './lut'

/**
 * Grid points per channel, and K slices: the forward table 17³ × 33 (as
 * the display tables, color/lut.ts: CMYK's error lives along K, so K gets
 * the points), the inverse 17³ × 17. The inverse is only ever used for a
 * change (see above), where its error mostly cancels, and solving it is
 * most of the time the tables take to make.
 */
export const CT_SIZE = 17
export const CT_K = 33
export const CT_K_INV = 17

export interface CmykTables {
  size: number
  kSlices: number
  /** RGBA (A unused) per (c, m, y, k) grid point, x = c fastest, a slice per k. */
  fwd: Float32Array
  invSlices: number
  /** CMY_ (the fourth unused) per (r, g, b, k) grid point, laid out likewise, `invSlices` of them. */
  inv: Float32Array
}

/** A 4D table read at (x, y, z, w): tetrahedral in x, y, z, linear in w. */
export function sample4(data: Float32Array, size: number, kSlices: number, x: number, y: number, z: number, w: number, out: number[] = [0, 0, 0]): number[] {
  const slice = size ** 3 * 4
  const fk = Math.min(Math.max(w, 0), 1) * (kSlices - 1)
  const k0 = Math.min(Math.floor(fk), kSlices - 2)
  const rk = fk - k0
  const a = [0, 0, 0]
  const b = [0, 0, 0]
  tetra(data, k0 * slice, size, x, y, z, a)
  tetra(data, (k0 + 1) * slice, size, x, y, z, b)
  for (let i = 0; i < 3; i++) out[i] = a[i] * (1 - rk) + b[i] * rk
  return out
}

/** A CMYK colour (light, 0..1) as working RGB. */
export const cmykToRgbT = (t: CmykTables, c: number[]) => sample4(t.fwd, t.size, t.kSlices, c[0], c[1], c[2], c[3])

/** The C, M and Y (light) that make `rgb` with black `k` (light). */
export const rgbToCmyT = (t: CmykTables, rgb: number[], k: number) => sample4(t.inv, t.size, t.invSlices, rgb[0], rgb[1], rgb[2], k)

/**
 * An adjusted RGB back to CMYK (light), black kept: the change the
 * adjustment made, carried over to C, M and Y.
 */
export function adjustedCmyk(t: CmykTables, c: number[], before: number[], after: number[]): number[] {
  const a = rgbToCmyT(t, before, c[3])
  const b = rgbToCmyT(t, after, c[3])
  const cl = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
  return [cl(c[0] + b[0] - a[0]), cl(c[1] + b[1] - a[1]), cl(c[2] + b[2] - a[2]), c[3]]
}

/** The tables for a CMYK profile, against a working RGB profile. */
export function buildCmykTables(cms: Cms, cmyk: Profile, rgb: Profile, size = CT_SIZE, kSlices = CT_K, invSlices = CT_K_INV): CmykTables {
  const per = size ** 3
  const count = per * kSlices
  // The grid in light, as ink for the colour engine.
  const ink = new Float32Array(count * 4)
  for (let k = 0; k < kSlices; k++)
    for (let i = 0; i < per; i++) {
      const o = (k * per + i) * 4
      ink[o] = 1 - (i % size) / (size - 1)
      ink[o + 1] = 1 - (Math.floor(i / size) % size) / (size - 1)
      ink[o + 2] = 1 - Math.floor(i / (size * size)) / (size - 1)
      ink[o + 3] = 1 - k / (kSlices - 1)
    }
  const t = cms.transform(cmyk, rgb, 'relative', FLAGS.blackPointCompensation)
  let out: Float32Array
  try {
    out = t.run(ink, count)
  } finally {
    t.close()
  }
  const fwd = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) fwd[i * 4 + c] = out[i * 3 + c]
  const tables: CmykTables = { size, kSlices, fwd, invSlices, inv: new Float32Array(per * invSlices * 4) }
  invert(tables)
  return tables
}

/**
 * The forward table at (x, y, z) in slice-pair k, and its Jacobian in x, y,
 * z, written into `v` (3) and `J` (row-major 3 × 3, output by input). The
 * table is linear within each tetrahedron, so the Jacobian is exact there:
 * Newton's method on it lands in a step or two.
 */
function fwdAt(t: CmykTables, x: number, y: number, z: number, k: number, v: Float64Array, J: Float64Array) {
  const { size, kSlices, fwd } = t
  const s1 = size - 1
  const slice = size ** 3 * 4
  const fk = Math.min(Math.max(k, 0), 1) * (kSlices - 1)
  const k0 = Math.min(Math.floor(fk), kSlices - 2)
  const rk = fk - k0
  const fx = Math.min(Math.max(x, 0), 1) * s1
  const fy = Math.min(Math.max(y, 0), 1) * s1
  const fz = Math.min(Math.max(z, 0), 1) * s1
  const x0 = Math.min(Math.floor(fx), s1 - 1)
  const y0 = Math.min(Math.floor(fy), s1 - 1)
  const z0 = Math.min(Math.floor(fz), s1 - 1)
  const rx = fx - x0
  const ry = fy - y0
  const rz = fz - z0
  // The corners walked to (1,1,1), in the order the fractions say: the steps along x, y and z.
  const order = rx >= ry ? (ry >= rz ? [0, 1, 2] : rx >= rz ? [0, 2, 1] : [2, 0, 1]) : rz >= ry ? [2, 1, 0] : rz >= rx ? [1, 2, 0] : [1, 0, 2]
  const r = [rx, ry, rz]
  v.fill(0)
  J.fill(0)
  for (let side = 0; side < 2; side++) {
    const w = side ? rk : 1 - rk
    if (w === 0) continue
    const base = (k0 + side) * slice
    let i = x0
    let j = y0
    let l = z0
    let prev = base + ((l * size + j) * size + i) * 4
    for (let c = 0; c < 3; c++) v[c] += w * fwd[prev + c]
    for (const axis of order) {
      if (axis === 0) i++
      else if (axis === 1) j++
      else l++
      const at = base + ((l * size + j) * size + i) * 4
      for (let c = 0; c < 3; c++) {
        const d = fwd[at + c] - fwd[prev + c]
        v[c] += w * r[axis] * d
        J[c * 3 + axis] += w * d * s1
      }
      prev = at
    }
  }
}

/**
 * Fills `inv` from `fwd`: for every RGB grid point and K slice, the C, M, Y
 * in the unit cube whose colour with that K is nearest, by damped Newton
 * steps on the forward table, starting from the neighbour just solved (the
 * solutions vary smoothly across the grid).
 */
function invert(t: CmykTables) {
  const { size, invSlices } = t
  const per = size ** 3
  const cl = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
  const v = new Float64Array(3)
  const J = new Float64Array(9)
  const x = [0.5, 0.5, 0.5]
  for (let ks = 0; ks < invSlices; ks++) {
    const k = ks / (invSlices - 1)
    for (let i = 0; i < per; i++) {
      const tr = (i % size) / (size - 1)
      const tg = (Math.floor(i / size) % size) / (size - 1)
      const tb = Math.floor(i / (size * size)) / (size - 1)
      // At the start of a row, the plain RGB view of the inks is a fair start; then the neighbour's answer.
      if (i % size === 0) {
        x[0] = cl(k > 1e-6 ? tr / k : 1)
        x[1] = cl(k > 1e-6 ? tg / k : 1)
        x[2] = cl(k > 1e-6 ? tb / k : 1)
      }
      for (let it = 0; it < 24; it++) {
        fwdAt(t, x[0], x[1], x[2], k, v, J)
        const r0 = v[0] - tr
        const r1 = v[1] - tg
        const r2 = v[2] - tb
        if (Math.abs(r0) + Math.abs(r1) + Math.abs(r2) < 1e-6) break
        // Least squares with a little damping, so a flat direction (a clipped channel) doesn't blow up.
        const JtJ = [0, 1, 2].map((a) => [0, 1, 2].map((b) => J[a] * J[b] + J[3 + a] * J[3 + b] + J[6 + a] * J[6 + b] + (a === b ? 1e-6 : 0)))
        const Jtr = [0, 1, 2].map((a) => J[a] * r0 + J[3 + a] * r1 + J[6 + a] * r2)
        const d = solve3(JtJ, Jtr)
        if (!d) break
        let moved = 0
        for (let c = 0; c < 3; c++) {
          const n = cl(x[c] - d[c])
          moved += Math.abs(n - x[c])
          x[c] = n
        }
        if (moved < 1e-8) break
      }
      const o = (ks * per + i) * 4
      t.inv[o] = x[0]
      t.inv[o + 1] = x[1]
      t.inv[o + 2] = x[2]
    }
  }
}

/** Solves a 3 × 3 system by Cramer's rule; null when it's singular. */
function solve3(m: number[][], v: number[]): number[] | null {
  const det = (a: number[][]) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
  const D = det(m)
  if (Math.abs(D) < 1e-18) return null
  return [0, 1, 2].map((c) => det(m.map((row, r) => row.map((x, j) => (j === c ? v[r] : x)))) / D)
}
