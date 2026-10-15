/**
 * Affines, as a b c d e f (x' = a x + c y + e, y' = b x + d y + f): the one
 * place they're composed and inverted. Documents (doc/types, Affine), the
 * view (render/view, Matrix) and geometry (geom/path, Mat) all use them.
 */

export type Affine6 = [number, number, number, number, number, number]

export const IDENTITY: Readonly<Affine6> = [1, 0, 0, 1, 0, 0]

/** `a` after `b`: the affine that applies `b` first, then `a`. */
export function compose(a: readonly number[], b: readonly number[]): Affine6 {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

/**
 * The inverse. A singular affine (a layer scaled to nothing, say) has none:
 * the identity stands in, everywhere, rather than a divide by nought or a
 * near-nought fallback whose huge numbers go on to cost loops elsewhere.
 */
export function invert(m: readonly number[]): Affine6 {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  if (!det || !Number.isFinite(det)) return [1, 0, 0, 1, 0, 0]
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

/** A turn by `a` radians about (cx, cy). */
export const rotateAbout = (cx: number, cy: number, a: number): Affine6 => {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]
}

/** A point through an affine. */
export const apply = (m: readonly number[], x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
