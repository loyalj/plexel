/**
 * A simple model of CMYK ink on paper, for Plexel's Generic CMYK profile.
 *
 * Real print conditions (FOGRA, GRACoL, a particular press) are measured,
 * and their profiles belong to whoever measured them. Until such profiles
 * ship, or the user loads their printer's own, CMYK documents need a
 * profile that behaves plausibly: smaller gamut than sRGB, dot gain in the
 * midtones, a black that isn't perfectly black, and grey component
 * replacement so neutrals print with black ink. This is that, and it says
 * so in its name. It is not a press profile.
 *
 * The model is built to be exactly invertible inside its gamut, so its two
 * tables agree: Lab -> CMYK -> Lab comes back where it started (to the
 * table's precision), which the checks hold it to.
 *
 *   forward:  ink -> dot gain -> subtractive mixing -> a little impurity
 *             -> black limit -> linear sRGB -> XYZ (D65 -> D50) -> Lab
 *   inverse:  the same steps backwards, choosing black by GCR
 */

/** Dot gain at 50%: a 50% dot prints as 50% + this. */
const DOT_GAIN = 0.15
/** How much of each ink's colour bleeds towards grey; a real cyan isn't a pure minus-red. */
const IMPURITY = 0.12
/** The darkest reflectance four inks reach: L* about 18. */
const BLACK_FLOOR = 0.025
/** How much of the grey component goes to black (grey component replacement). */
const GCR = 0.7
/** Below this much grey component, no black at all, so highlights stay clean. */
const GCR_START = 0.15

const gain = (t: number) => t + DOT_GAIN * 4 * t * (1 - t)
/** The inverse of `gain`, for 0..1: the root of DOT_GAIN·4·t² − (1 + DOT_GAIN·4)·t + v = 0 in 0..1. */
function ungain(v: number): number {
  const a = DOT_GAIN * 4
  if (a === 0) return v
  const b = 1 + a
  return (b - Math.sqrt(b * b - 4 * a * v)) / (2 * a)
}

// --- colour science -------------------------------------------------------

/** Linear sRGB (D65) to XYZ, then Bradford-adapted to D50: the ICC PCS. */
const RGB_TO_XYZ_D50 = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
]
const XYZ_D50_TO_RGB = invert3(RGB_TO_XYZ_D50)
const D50 = [0.9642, 1, 0.8249]

function invert3(m: number[][]): number[][] {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ]
}

const mul = (m: number[][], v: number[]) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2])

const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
const labFInv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27))

function xyzToLab(xyz: number[]): number[] {
  const [fx, fy, fz] = xyz.map((v, i) => labF(v / D50[i]))
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function labToXyz([L, a, b]: number[]): number[] {
  const fy = (L + 16) / 116
  return [labFInv(fy + a / 500) * D50[0], labFInv(fy) * D50[1], labFInv(fy - b / 200) * D50[2]]
}

/** Mixing each channel a little towards the mean: invertible for IMPURITY < 1. */
const impure = (v: number[]) => {
  const mean = (v[0] + v[1] + v[2]) / 3
  return v.map((x) => x + IMPURITY * (mean - x))
}
const pure = (v: number[]) => {
  // The mean is unchanged by `impure`, so it can be read straight back.
  const mean = (v[0] + v[1] + v[2]) / 3
  return v.map((x) => (x - IMPURITY * mean) / (1 - IMPURITY))
}

// --- the model ------------------------------------------------------------

/** CMYK, each 0..1, to Lab. */
export function cmykToLab([c, m, y, k]: number[]): number[] {
  const [cg, mg, yg, kg] = [c, m, y, k].map((t) => gain(Math.min(1, Math.max(0, t))))
  const reflect = [(1 - cg) * (1 - kg), (1 - mg) * (1 - kg), (1 - yg) * (1 - kg)]
  const lin = impure(reflect).map((r) => BLACK_FLOOR + (1 - BLACK_FLOOR) * r)
  return xyzToLab(mul(RGB_TO_XYZ_D50, lin))
}

/**
 * Lab to CMYK, each 0..1. Colours outside the gamut are clipped to it, as a
 * relative colorimetric conversion does.
 */
export function labToCmyk(lab: number[]): number[] {
  const lin = mul(XYZ_D50_TO_RGB, labToXyz(lab))
  const reflect = pure(lin.map((v) => (v - BLACK_FLOOR) / (1 - BLACK_FLOOR))).map((v) => Math.min(1, Math.max(0, v)))
  // The grey component is what all three channels share. Black takes a
  // share of it, ramping in above GCR_START.
  const grey = 1 - Math.max(...reflect)
  const ramp = grey <= GCR_START ? 0 : (grey - GCR_START) / (1 - GCR_START)
  const kg = Math.min(grey, GCR * ramp * grey + (1 - GCR) * ramp * ramp * grey)
  const rest = 1 - kg
  const [cg, mg, yg] = reflect.map((r) => (rest <= 1e-9 ? 0 : Math.min(1, Math.max(0, 1 - r / rest))))
  return [cg, mg, yg, kg].map(ungain)
}

// --- tables, for the profile ----------------------------------------------------------

/** Lab in LittleCMS's normalised float form: L/100, (a+128)/255, (b+128)/255. */
const normLab = ([L, a, b]: number[]) => [L / 100, (a + 128) / 255, (b + 128) / 255]
const unnormLab = ([l, a, b]: number[]) => [l * 100, a * 255 - 128, b * 255 - 128]

/** CMYK -> Lab, on `points` per ink, the last ink varying fastest. */
export function forwardTable(points: number): Float32Array {
  const out = new Float32Array(points ** 4 * 3)
  let o = 0
  for (let c = 0; c < points; c++)
    for (let m = 0; m < points; m++)
      for (let y = 0; y < points; y++)
        for (let k = 0; k < points; k++) {
          const lab = normLab(cmykToLab([c, m, y, k].map((v) => v / (points - 1))))
          out[o++] = lab[0]
          out[o++] = lab[1]
          out[o++] = lab[2]
        }
  return out
}

/** Lab -> CMYK, on `points` per normalised Lab axis, b varying fastest. */
export function inverseTable(points: number): Float32Array {
  const out = new Float32Array(points ** 3 * 4)
  let o = 0
  for (let l = 0; l < points; l++)
    for (let a = 0; a < points; a++)
      for (let b = 0; b < points; b++) {
        const cmyk = labToCmyk(unnormLab([l, a, b].map((v) => v / (points - 1))))
        for (const v of cmyk) out[o++] = v
      }
  return out
}
