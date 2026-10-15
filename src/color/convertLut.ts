/**
 * Converting many pixels fast: the colour engine's conversion sampled on a
 * grid once, then each pixel interpolated, which is what LittleCMS's own
 * optimised transforms do (a float transform evaluates the whole pipeline
 * for every pixel, about 2 megapixels a second in WebAssembly; this is
 * several times that). Grids as the display tables have them (color/lut.ts),
 * finer for CMYK: 33³ for RGB, 17³ × 65 K slices for CMYK, 4096 points for
 * Gray;
 * tetrahedral within a cube, linear across K, so check:print holds it to
 * the engine's own answer.
 *
 * Values in and out are the colour engine's (color/cms.ts): 0..1 per
 * channel, CMYK as ink.
 */
import { FLAGS, type Cms, type Intent, type Profile } from './cms'
import { LUT_SIZE } from './lut'

const CONVERT_GRAY_SIZE = 4096
/**
 * CMYK in: twice the display's K slices, as a conversion is kept, not just
 * looked at, and CMYK's error is along K, worst in the last few percent of
 * black where a profile turns hardest.
 */
const CONVERT_CMYK_SIZE = 17
const CONVERT_K_SLICES = 65

/**
 * RGB and Gray outputs are kept in the table roughly linear (raised to
 * 2.2, sign kept for colours past the gamut) and put back after
 * interpolating: straight lines between grid points then follow the
 * conversion in the shadows, where a gamma-encoded output curves hardest.
 * LittleCMS's prelinearisation curves do this for its own tables.
 */
const LINEAR = 2.2
const lin = (v: number) => (v < 0 ? -((-v) ** LINEAR) : v ** LINEAR)
const unlin = (v: number) => (v < 0 ? -((-v) ** (1 / LINEAR)) : v ** (1 / LINEAR))
/** unlin over a whole result, in place: a conversion makes millions of them, and a copy each time was garbage. */
function unlinInPlace(out: Float32Array): Float32Array {
  for (let i = 0; i < out.length; i++) out[i] = unlin(out[i])
  return out
}

export interface ConvertLut {
  inCh: number
  outCh: number
  /** Whether the table holds outputs made linear (RGB and Gray light). */
  linear: boolean
  size: number
  kSlices: number
  /** outCh values per grid point, laid out as the display tables are (first channel fastest), padded to four. */
  data: Float32Array
}

export function buildConvertLut(cms: Cms, from: Profile, to: Profile, intent: Intent, bpc: boolean): ConvertLut {
  const inCh = from.channels
  const outCh = to.channels
  const size = inCh === 1 ? CONVERT_GRAY_SIZE : inCh === 4 ? CONVERT_CMYK_SIZE : LUT_SIZE
  const kSlices = inCh === 4 ? CONVERT_K_SLICES : 0
  const per = inCh === 1 ? size : size ** 3
  const count = per * (inCh === 4 ? kSlices : 1)
  const pts = new Float32Array(count * inCh)
  for (let i = 0; i < count; i++) {
    const g = i % per
    const o = i * inCh
    if (inCh === 1) pts[o] = g / (size - 1)
    else {
      pts[o] = (g % size) / (size - 1)
      pts[o + 1] = (Math.floor(g / size) % size) / (size - 1)
      pts[o + 2] = Math.floor(g / (size * size)) / (size - 1)
      if (inCh === 4) pts[o + 3] = Math.floor(i / per) / (kSlices - 1)
    }
  }
  const t = cms.transform(from, to, intent, bpc ? FLAGS.blackPointCompensation : 0)
  let out: Float32Array
  try {
    out = t.run(pts, count)
  } finally {
    t.close()
  }
  const linear = to.space === 'rgb' || to.space === 'gray'
  const data = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) for (let c = 0; c < outCh; c++) data[i * 4 + c] = linear ? lin(out[i * outCh + c]) : out[i * outCh + c]
  return { inCh, outCh, linear, size, kSlices, data }
}

/** `count` colours through the table, packed channel after channel, as Transform.run takes and gives them. */
export function runConvertLut(l: ConvertLut, input: Float32Array, count: number): Float32Array {
  const { inCh, outCh, size, data } = l
  const out = new Float32Array(count * outCh)
  const s1 = size - 1
  const cl = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
  if (inCh === 1) {
    for (let i = 0; i < count; i++) {
      const f = cl(input[i]) * s1
      const i0 = f >= s1 ? s1 - 1 : Math.floor(f)
      const r = f - i0
      for (let c = 0; c < outCh; c++) out[i * outCh + c] = data[i0 * 4 + c] * (1 - r) + data[(i0 + 1) * 4 + c] * r
    }
    return l.linear ? unlinInPlace(out) : out
  }
  const sx = 4
  const sy = size * 4
  const sz = size * size * 4
  const slice = size ** 3 * 4
  const acc = new Float64Array(4)
  /** Tetrahedral interpolation in the cube at (x, y, z), into `acc` scaled by `w` and added. */
  const tetraAdd = (base: number, x: number, y: number, z: number, w: number) => {
    const fx = cl(x) * s1
    const fy = cl(y) * s1
    const fz = cl(z) * s1
    const x0 = fx >= s1 ? s1 - 1 : Math.floor(fx)
    const y0 = fy >= s1 ? s1 - 1 : Math.floor(fy)
    const z0 = fz >= s1 ? s1 - 1 : Math.floor(fz)
    const rx = fx - x0
    const ry = fy - y0
    const rz = fz - z0
    const c000 = base + x0 * sx + y0 * sy + z0 * sz
    const c111 = c000 + sx + sy + sz
    // The six tetrahedra of a cube: corners stepped to in the order of the fractions.
    let a: number, b: number, ra: number, rb: number, rc: number
    if (rx >= ry) {
      if (ry >= rz) ((a = c000 + sx), (b = a + sy), (ra = rx), (rb = ry), (rc = rz))
      else if (rx >= rz) ((a = c000 + sx), (b = a + sz), (ra = rx), (rb = rz), (rc = ry))
      else ((a = c000 + sz), (b = a + sx), (ra = rz), (rb = rx), (rc = ry))
    } else if (rz >= ry) ((a = c000 + sz), (b = a + sy), (ra = rz), (rb = ry), (rc = rx))
    else if (rz >= rx) ((a = c000 + sy), (b = a + sz), (ra = ry), (rb = rz), (rc = rx))
    else ((a = c000 + sy), (b = a + sx), (ra = ry), (rb = rx), (rc = rz))
    for (let c = 0; c < outCh; c++) {
      const v0 = data[c000 + c]
      const va = data[a + c]
      const vb = data[b + c]
      acc[c] += w * (v0 + ra * (va - v0) + rb * (vb - va) + rc * (data[c111 + c] - vb))
    }
  }
  if (inCh === 3) {
    for (let i = 0; i < count; i++) {
      acc.fill(0)
      tetraAdd(0, input[i * 3], input[i * 3 + 1], input[i * 3 + 2], 1)
      for (let c = 0; c < outCh; c++) out[i * outCh + c] = acc[c]
    }
    return l.linear ? unlinInPlace(out) : out
  }
  const ks1 = l.kSlices - 1
  for (let i = 0; i < count; i++) {
    const o = i * 4
    const fk = cl(input[o + 3]) * ks1
    const k0 = fk >= ks1 ? ks1 - 1 : Math.floor(fk)
    const rk = fk - k0
    acc.fill(0)
    tetraAdd(k0 * slice, input[o], input[o + 1], input[o + 2], 1 - rk)
    if (rk > 0) tetraAdd((k0 + 1) * slice, input[o], input[o + 1], input[o + 2], rk)
    for (let c = 0; c < outCh; c++) out[i * outCh + c] = acc[c]
  }
  return l.linear ? unlinInPlace(out) : out
}
