/**
 * Matting: Select and Mask's edge detection, refine edge brush and
 * colour decontamination.
 *
 * A selection's edge is a hard guess at where the subject stops. Near it
 * (within the edge detection radius, and wherever the refine brush has been)
 * the coverage is worked out again from the image: each pixel there is taken
 * as a mix αF + (1 − α)B of a foreground colour F found nearby inside the
 * selection and a background colour B found nearby outside it, and α is how
 * far along from B to F its colour sits. Hair and fur come out soft, as
 * they are, instead of cut. Decontaminate Colours uses the same mix the other
 * way round: knowing α, it takes B out of an edge pixel's colour.
 *
 * Everything works on one window of straight 8-bit pixels (alpha last) and
 * its coverage, on the CPU, with no DOM: the engine worker runs it, and so
 * do the checks, in Node.
 */
import { clamp01 } from '../lib/num'

/**
 * The band to re-estimate: within `radius` pixels of the selection's edge (where coverage crosses 0.5), and,
 * with `smart`, narrower where the edge is crisp in the image and wider where it's soft or busy, as Photoshop's
 * Smart Radius does; plus wherever `brushed` is 1 (the refine brush). 1 inside the band, 0 outside, soft at its rim.
 */
export function edgeBand(o: { image: Uint8Array; channels: number; width: number; height: number; coverage: Float32Array; radius: number; smart: boolean; brushed?: Uint8Array }): Float32Array {
  const { coverage, width: w, height: h, radius } = o
  const n = w * h
  const band = new Float32Array(n)
  if (radius > 0) {
    // Pixels either side of where coverage crosses 0.5.
    const site = new Uint8Array(n)
    let any = false
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const a = coverage[i] >= 0.5
        if (x + 1 < w && coverage[i + 1] >= 0.5 !== a) site[i] = site[i + 1] = 1
        if (y + 1 < h && coverage[i + w] >= 0.5 !== a) site[i] = site[i + w] = 1
        if (site[i]) any = true
      }
    }
    if (any) {
      const r = o.smart ? smartRadii(o.image, o.channels, w, h, site, radius) : null
      const { d2, near } = distances(site, w, h)
      for (let i = 0; i < n; i++) {
        if (near[i] < 0) continue
        const ri = r ? r[near[i]] : radius
        band[i] = clamp01((ri + 1 - Math.sqrt(d2[i])) / 2)
      }
    }
  }
  if (o.brushed) for (let i = 0; i < n; i++) if (o.brushed[i]) band[i] = 1
  return band
}

/** Coverage re-estimated from the image inside the band; unchanged outside it (blended across the band's soft rim). */
export function refineEdge(o: { image: Uint8Array; channels: number; width: number; height: number; coverage: Float32Array; band: Float32Array }): Float32Array {
  const { image, channels: ch, width: w, height: h, coverage, band } = o
  const n = w * h
  const nc = ch - 1
  const out = Float32Array.from(coverage)
  // The trimap: 1 known foreground, 2 known background, 3 to solve.
  const label = new Uint8Array(n)
  let m = 0
  for (let i = 0; i < n; i++) {
    if (band[i] > 0) {
      label[i] = 3
      m++
    } else if (coverage[i] >= 0.95) label[i] = 1
    else if (coverage[i] <= 0.05) label[i] = 2
  }
  if (!m) return out
  const px = new Int32Array(m)
  const slot = new Int32Array(n).fill(-1)
  for (let i = 0, k = 0; i < n; i++) if (label[i] === 3) slot[(px[k] = i)] = k++

  // Each pixel's best pair of samples from the known pixels nearest it along a few rays.
  const bestF = new Float32Array(m * nc)
  const bestB = new Float32Array(m * nc)
  const found = new Uint8Array(m)
  const fs = new Int32Array(RAYS)
  const bs = new Int32Array(RAYS)
  for (let k = 0; k < m; k++) {
    const i = px[k]
    const x = i % w
    const y = (i - x) / w
    const got = gather(label, w, h, x, y, fs, bs)
    const nf = got & 255
    const nb = got >> 8
    if (!nf || !nb) continue
    let best = Infinity
    let bf = 0
    let bb = 0
    for (let a = 0; a < nf; a++) {
      const fi = fs[a]
      const df = dist(fi, w, x, y)
      for (let b = 0; b < nb; b++) {
        const bi = bs[b]
        const db = dist(bi, w, x, y)
        const cost = distortion(image, ch, i * ch, fi * ch, bi * ch, -1) + SPATIAL * (df + db)
        if (cost < best) {
          best = cost
          bf = fi
          bb = bi
        }
      }
    }
    found[k] = 1
    for (let c = 0; c < nc; c++) {
      bestF[k * nc + c] = image[bf * ch + c]
      bestB[k * nc + c] = image[bb * ch + c]
    }
  }

  // Shared sampling: each pixel tries its neighbours' pairs too, and keeps the one that explains its colour best.
  const raw = Float32Array.from(coverage)
  const conf = new Float32Array(n).fill(1)
  const I = new Float32Array(nc)
  const sigma2 = 2 * (CONF_SIGMA * CONF_SIGMA * nc) / 3
  const tau = PURE_BIAS * Math.sqrt(nc / 3)
  for (let k = 0; k < m; k++) {
    const i = px[k]
    conf[i] = 0
    if (!found[k]) continue
    const x = i % w
    const y = (i - x) / w
    for (let c = 0; c < nc; c++) I[c] = image[i * ch + c]
    let best = Infinity
    let alpha = 0
    let err = 0
    let sep = 0
    for (let dy = -SHARE; dy <= SHARE; dy++) {
      const yy = y + dy
      if (yy < 0 || yy >= h) continue
      for (let dx = -SHARE; dx <= SHARE; dx++) {
        const xx = x + dx
        if (xx < 0 || xx >= w) continue
        const q = slot[yy * w + xx]
        if (q < 0 || !found[q]) continue
        let fb = 0
        let ib = 0
        for (let c = 0; c < nc; c++) {
          const d = bestF[q * nc + c] - bestB[q * nc + c]
          fb += d * d
          ib += (I[c] - bestB[q * nc + c]) * d
        }
        const a = fb > 1 ? clamp01(ib / fb) : 0.5
        let e = 0
        let e0 = 0
        let e1 = 0
        for (let c = 0; c < nc; c++) {
          const f = bestF[q * nc + c]
          const b = bestB[q * nc + c]
          const d = I[c] - (a * f + (1 - a) * b)
          e += d * d
          e0 += (I[c] - b) * (I[c] - b)
          e1 += (I[c] - f) * (I[c] - f)
        }
        // A pixel is taken as wholly one or the other unless a mix explains it clearly better.
        const mixed = Math.sqrt(e) + tau
        const pure = Math.sqrt(Math.min(e0, e1))
        const cost = Math.min(mixed, pure)
        if (cost < best) {
          best = cost
          alpha = mixed < pure ? a : e1 < e0 ? 1 : 0
          err = mixed < pure ? e : Math.min(e0, e1)
          sep = fb
        }
      }
    }
    raw[i] = alpha
    conf[i] = Math.exp(-err / sigma2) * Math.min(1, Math.sqrt(sep) / MIN_SEPARATION)
  }

  // Smoothed with the image as guide, so α follows the image's own edges; where the samples explain a pixel well, they win.
  const smooth = guidedFilter(image, ch, w, h, raw, GUIDE_RADIUS, GUIDE_EPS)
  for (let k = 0; k < m; k++) {
    const i = px[k]
    if (!found[k]) continue
    const c = conf[i]
    const a = clamp01(c * raw[i] + (1 - c) * smooth[i])
    out[i] = band[i] * a + (1 - band[i]) * coverage[i]
  }
  return out
}

/** Edge pixels' colours with the background taken out: where 0 < alpha < 1, the estimated foreground colour. Alpha channel left as is. */
export function decontaminate(o: { image: Uint8Array; channels: number; width: number; height: number; alpha: Float32Array; amount: number }): Uint8Array {
  const { image, channels: ch, width: w, height: h, alpha } = o
  const n = w * h
  const nc = ch - 1
  const out = Uint8Array.from(image)
  const amount = clamp01(o.amount)
  if (!amount) return out
  const label = new Uint8Array(n)
  for (let i = 0; i < n; i++) label[i] = alpha[i] >= 0.98 ? 1 : alpha[i] <= 0.02 ? 2 : 3
  const fs = new Int32Array(RAYS)
  const bs = new Int32Array(RAYS)
  for (let i = 0; i < n; i++) {
    const a = alpha[i]
    if (!(a > 0 && a < 1)) continue
    const x = i % w
    const y = (i - x) / w
    const got = gather(label, w, h, x, y, fs, bs)
    const nf = got & 255
    const nb = got >> 8
    if (!nf) continue
    let bf = fs[0]
    let bb = -1
    let best = Infinity
    for (let p = 0; p < nf; p++) {
      const fi = fs[p]
      const df = dist(fi, w, x, y)
      if (!nb) {
        if (df < best) {
          best = df
          bf = fi
        }
        continue
      }
      for (let q = 0; q < nb; q++) {
        const bi = bs[q]
        const db = dist(bi, w, x, y)
        const cost = distortion(image, ch, i * ch, fi * ch, bi * ch, a) + SPATIAL * (df + db)
        if (cost < best) {
          best = cost
          bf = fi
          bb = bi
        }
      }
    }
    for (let c = 0; c < nc; c++) {
      const v = image[i * ch + c]
      const f = image[bf * ch + c]
      // What the pair doesn't explain is put down to the foreground, as far as the pixel is foreground.
      const fe = bb < 0 ? f : f + a * (v - (a * f + (1 - a) * image[bb * ch + c]))
      out[i * ch + c] = Math.round(Math.min(255, Math.max(0, v + amount * (fe - v))))
    }
  }
  return out
}

// --- sampling --------------------------------------------------------------------

/** Rays cast from a pixel to find known colours, and how far they go. */
const RAYS = 12
const REACH = 128
/** Rays start at a different angle from pixel to pixel, so neighbours see different samples and can share them. */
const TURNS = 4
const DIRS = Array.from({ length: TURNS * RAYS }, (_, k) => {
  const t = ((k % RAYS) + Math.floor(k / RAYS) / TURNS) * ((Math.PI * 2) / RAYS)
  return [Math.cos(t), Math.sin(t)]
})
/** Colour distortion a pixel of distance to the samples is worth. */
const SPATIAL = 0.4
const SHARE = 2
/** How much better (in colour distance) a mix must explain a pixel than pure foreground or background does. */
const PURE_BIAS = 10
const CONF_SIGMA = 10
const MIN_SEPARATION = 24
const GUIDE_RADIUS = 2
const GUIDE_EPS = 0.002

/**
 * The first known foreground and background pixel along each ray from (x, y): their indices into `fs` and `bs`,
 * and how many of each, packed as nf + 256 nb.
 */
function gather(label: Uint8Array, w: number, h: number, x: number, y: number, fs: Int32Array, bs: Int32Array): number {
  let nf = 0
  let nb = 0
  const turn = ((x * 3 + y * 5) % TURNS) * RAYS
  for (let r = 0; r < RAYS; r++) {
    const [dx, dy] = DIRS[turn + r]
    for (let t = 1; t <= REACH; t++) {
      const xx = Math.round(x + dx * t)
      const yy = Math.round(y + dy * t)
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) break
      const j = yy * w + xx
      const l = label[j]
      if (l === 1) {
        fs[nf++] = j
        break
      }
      if (l === 2) {
        bs[nb++] = j
        break
      }
    }
  }
  return nf + (nb << 8)
}

/** How far colour I (at offset i) is from the mix of F and B: at `alpha`, or with alpha < 0, at the best α for I. */
function distortion(image: Uint8Array, ch: number, i: number, f: number, b: number, alpha: number): number {
  const nc = ch - 1
  let a = alpha
  if (a < 0) {
    let fb = 0
    let ib = 0
    for (let c = 0; c < nc; c++) {
      const d = image[f + c] - image[b + c]
      fb += d * d
      ib += (image[i + c] - image[b + c]) * d
    }
    a = fb > 1 ? clamp01(ib / fb) : 0.5
  }
  let e = 0
  for (let c = 0; c < nc; c++) {
    const d = image[i + c] - (a * image[f + c] + (1 - a) * image[b + c])
    e += d * d
  }
  return Math.sqrt(e)
}

// --- filters ------------------------------------------------------------------------

/** A guided filter of `p` with the image's grey (the mean of its colour channels) as guide. */
function guidedFilter(image: Uint8Array, ch: number, w: number, h: number, p: Float32Array, r: number, eps: number): Float32Array {
  const n = w * h
  const nc = ch - 1
  const g = new Float32Array(n)
  const gp = new Float32Array(n)
  const gg = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let c = 0; c < nc; c++) s += image[i * ch + c]
    const v = s / (255 * nc)
    g[i] = v
    gp[i] = v * p[i]
    gg[i] = v * v
  }
  const mg = boxMean(g, w, h, r)
  const mp = boxMean(p, w, h, r)
  const mgp = boxMean(gp, w, h, r)
  const mgg = boxMean(gg, w, h, r)
  const a = gp
  const b = gg
  for (let i = 0; i < n; i++) {
    a[i] = (mgp[i] - mg[i] * mp[i]) / (mgg[i] - mg[i] * mg[i] + eps)
    b[i] = mp[i] - a[i] * mg[i]
  }
  const ma = boxMean(a, w, h, r)
  const mb = boxMean(b, w, h, r)
  for (let i = 0; i < n; i++) ma[i] = ma[i] * g[i] + mb[i]
  return ma
}

/** The mean over a (2r + 1)² square round each pixel, of the part of it on the image. */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const acc = new Float64Array(Math.max(w, h) + 1)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) acc[x + 1] = acc[x] + src[y * w + x]
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r)
      const hi = Math.min(w, x + r + 1)
      tmp[y * w + x] = (acc[hi] - acc[lo]) / (hi - lo)
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) acc[y + 1] = acc[y] + tmp[y * w + x]
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - r)
      const hi = Math.min(h, y + r + 1)
      out[y * w + x] = (acc[hi] - acc[lo]) / (hi - lo)
    }
  }
  return out
}

/** The largest value over a (2r + 1)² square round each pixel: van Herk / Gil–Werman, a few steps a pixel whatever r is. */
function maxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const out = new Float32Array(w * h)
  const len = Math.max(w, h)
  // The line, padded r either side with -∞.
  const line = new Float32Array(len + 2 * r)
  const res = new Float32Array(len)
  const g = new Float32Array(len + 2 * r)
  const hh = new Float32Array(len + 2 * r)
  const k = 2 * r + 1
  const pass = (n: number) => {
    const total = n + 2 * r
    line.fill(-Infinity, 0, r)
    line.fill(-Infinity, n + r, total)
    for (let i = 0; i < total; i++) {
      const v = line[i]
      g[i] = i % k === 0 || v > g[i - 1] ? v : g[i - 1]
    }
    for (let i = total - 1; i >= 0; i--) {
      const v = line[i]
      hh[i] = i === total - 1 || (i + 1) % k === 0 || v > hh[i + 1] ? v : hh[i + 1]
    }
    for (let i = 0; i < n; i++) res[i] = hh[i] > g[i + 2 * r] ? hh[i] : g[i + 2 * r]
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) line[x + r] = src[y * w + x]
    pass(w)
    for (let x = 0; x < w; x++) out[y * w + x] = res[x]
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y + r] = out[y * w + x]
    pass(h)
    for (let y = 0; y < h; y++) out[y * w + x] = res[y]
  }
  return out
}

// --- edge detection ------------------------------------------------------------------

/**
 * Smart Radius: a radius for each edge pixel, from how wide the image's edge there is (its contrast over its
 * steepest step: about 2 for a crisp edge, its width for a soft one), widened where the image is busy (much more
 * change round about than one edge makes), then evened out along the edge.
 */
function smartRadii(image: Uint8Array, ch: number, w: number, h: number, site: Uint8Array, radius: number): Float32Array {
  const n = w * h
  const nc = ch - 1
  const R = Math.max(3, Math.min(64, Math.ceil(radius)))
  const grad = new Float32Array(n)
  const range = new Float32Array(n)
  const plane = new Float32Array(n)
  for (let c = 0; c < nc; c++) {
    for (let i = 0; i < n; i++) plane[i] = image[i * ch + c]
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - 1)
      const y1 = Math.min(h - 1, y + 1)
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - 1)
        const x1 = Math.min(w - 1, x + 1)
        const gx = x1 > x0 ? (plane[y * w + x1] - plane[y * w + x0]) / (x1 - x0) : 0
        const gy = y1 > y0 ? (plane[y1 * w + x] - plane[y0 * w + x]) / (y1 - y0) : 0
        const i = y * w + x
        grad[i] = Math.max(grad[i], Math.sqrt(gx * gx + gy * gy))
      }
    }
    const hi = maxFilter(plane, w, h, R)
    for (let i = 0; i < n; i++) plane[i] = -plane[i]
    const lo = maxFilter(plane, w, h, R)
    for (let i = 0; i < n; i++) range[i] = Math.max(range[i], hi[i] + lo[i])
  }
  const steepest = maxFilter(grad, w, h, R)
  const mean = boxMean(grad, w, h, R)
  const r = new Float32Array(n)
  const low = Math.min(radius, 2)
  for (let i = 0; i < n; i++) {
    if (!site[i]) continue
    if (range[i] < 12) {
      r[i] = radius
      continue
    }
    const width = range[i] / Math.max(steepest[i], 1e-3)
    const busy = Math.max(1, (mean[i] * (2 * R + 1)) / range[i])
    r[i] = Math.min(radius, Math.max(low, 1.5 * width * busy))
  }
  const s = Math.max(2, Math.round(radius / 2))
  const num = boxMean(r, w, h, s)
  const den = new Float32Array(n)
  for (let i = 0; i < n; i++) den[i] = site[i]
  const wt = boxMean(den, w, h, s)
  for (let i = 0; i < n; i++) if (site[i]) r[i] = num[i] / wt[i]
  return r
}

/** Each pixel's squared distance to the nearest site and which site that is (−1 for none): an exact Euclidean distance transform (Felzenszwalb–Huttenlocher). */
function distances(site: Uint8Array, w: number, h: number): { d2: Float32Array; near: Int32Array } {
  const n = w * h
  // Down each column: the row of the nearest site in it.
  const row = new Int32Array(n).fill(-1)
  for (let x = 0; x < w; x++) {
    let last = -1
    for (let y = 0; y < h; y++) {
      if (site[y * w + x]) last = y
      row[y * w + x] = last
    }
    let next = -1
    for (let y = h - 1; y >= 0; y--) {
      const i = y * w + x
      if (site[i]) next = y
      if (next >= 0 && (row[i] < 0 || next - y < y - row[i])) row[i] = next
    }
  }
  // Along each row: the lower envelope of the columns' parabolas.
  const d2 = new Float32Array(n).fill(Infinity)
  const near = new Int32Array(n).fill(-1)
  const f = new Float64Array(w)
  const v = new Int32Array(w)
  const z = new Float64Array(w + 1)
  for (let y = 0; y < h; y++) {
    let k = -1
    for (let q = 0; q < w; q++) {
      const r = row[y * w + q]
      if (r < 0) continue
      f[q] = (y - r) * (y - r)
      if (k < 0) {
        k = 0
        v[0] = q
        z[0] = -Infinity
        z[1] = Infinity
        continue
      }
      let s = 0
      for (;;) {
        const p = v[k]
        s = (f[q] + q * q - (f[p] + p * p)) / (2 * (q - p))
        if (s <= z[k]) k--
        else break
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = Infinity
    }
    if (k < 0) continue
    k = 0
    for (let q = 0; q < w; q++) {
      while (z[k + 1] < q) k++
      const p = v[k]
      d2[y * w + q] = (q - p) * (q - p) + f[p]
      near[y * w + q] = row[y * w + p] * w + p
    }
  }
  return { d2, near }
}

/** How far pixel j is from (x, y). */
function dist(j: number, w: number, x: number, y: number): number {
  const dx = (j % w) - x
  const dy = ((j / w) | 0) - y
  return Math.sqrt(dx * dx + dy * dy)
}

