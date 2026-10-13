/**
 * Healing: the Healing Brush's and the Patch tool's blend. What's painted
 * (or patched) takes its texture from the source and its colour and tone
 * from round where it lands, so it melts in.
 *
 * Inside the area the result is the source plus a correction: at the area's
 * edge the correction is exactly what the destination differs from the
 * source by, and inside it's spread smoothly between those edge values (a
 * membrane: the smoothest field that meets them, after Pérez et al.'s
 * Poisson image editing, which is what Photoshop's healing grew from). It's
 * found by a pull-push pyramid (Gortler et al.), which fills it in at once
 * from coarse to fine, then relaxed towards the true membrane at full size.
 * Coverage between 0 and 1 (a soft brush, a feathered selection) mixes the
 * healed result with the destination by that much.
 *
 * Pure arithmetic on typed arrays: the engine runs it, and so do the checks.
 */

export interface HealInput {
  /** The destination, premultiplied, `stride` values a pixel (colour channels, then alpha), row-major. */
  dest: Float32Array
  /** The source at the same pixels (where the texture comes from), as `dest`. */
  source: Float32Array
  /** 0..1 a pixel: how much of each pixel is healed. */
  k: Float32Array
  width: number
  height: number
  stride: number
  /** Relaxation sweeps after the pyramid; more is closer to the true membrane, and slower. */
  sweeps?: number
}

/**
 * The healed pixels, as `dest`. Pixels with no coverage are the
 * destination as it was.
 */
export function heal(i: HealInput): Float32Array {
  const { dest, source, k, width: w, height: h, stride: s } = i
  const n = w * h
  // Where the correction is known: uncovered pixels touching covered ones (the area's edge), and covered
  // pixels on the window's own border, which have nothing outside them to take it from.
  const known = new Uint8Array(n)
  let any = false
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (k[p] > 0) {
        any = true
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) known[p] = 1
        continue
      }
      const touches = (x > 0 && k[p - 1] > 0) || (x < w - 1 && k[p + 1] > 0) || (y > 0 && k[p - w] > 0) || (y < h - 1 && k[p + w] > 0)
      if (touches) known[p] = 1
    }
  const out = new Float32Array(dest)
  if (!any) return out
  const f = new Float32Array(n * s)
  for (let p = 0; p < n; p++) if (known[p]) for (let c = 0; c < s; c++) f[p * s + c] = dest[p * s + c] - source[p * s + c]
  const field = pullPush(f, known, w, h, s)
  relax(field, known, k, w, h, s, i.sweeps ?? 40)
  for (let p = 0; p < n; p++) {
    const kk = Math.min(1, Math.max(0, k[p]))
    if (kk <= 0) continue
    const o = p * s
    // Healed: the source plus the correction, alpha first so colour can be held inside it.
    const a = Math.min(1, Math.max(0, source[o + s - 1] + field[o + s - 1]))
    const ha = dest[o + s - 1] + (a - dest[o + s - 1]) * kk
    out[o + s - 1] = ha
    for (let c = 0; c < s - 1; c++) {
      const v = Math.min(a, Math.max(0, source[o + c] + field[o + c]))
      out[o + c] = Math.min(ha, Math.max(0, dest[o + c] + (v - dest[o + c]) * kk))
    }
  }
  return out
}

/**
 * Values known at some pixels (`known`), filled in everywhere: halved until
 * a level is one pixel or every pixel is known, each level's pixel the
 * weighted mean of the four under it; then back up, each pixel keeping as
 * much of its own as its weight says and taking the rest from the level
 * above, interpolated.
 */
export function pullPush(values: Float32Array, known: Uint8Array, w: number, h: number, s: number): Float32Array {
  type Level = { w: number; h: number; v: Float32Array; wt: Float32Array }
  const first: Level = { w, h, v: new Float32Array(values), wt: new Float32Array(w * h) }
  for (let p = 0; p < w * h; p++) first.wt[p] = known[p] ? 1 : 0
  const levels: Level[] = [first]
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const a = levels[levels.length - 1]
    const bw = Math.max(1, Math.ceil(a.w / 2))
    const bh = Math.max(1, Math.ceil(a.h / 2))
    const b: Level = { w: bw, h: bh, v: new Float32Array(bw * bh * s), wt: new Float32Array(bw * bh) }
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++) {
        let wsum = 0
        const q = y * bw + x
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const sx = 2 * x + dx
            const sy = 2 * y + dy
            if (sx >= a.w || sy >= a.h) continue
            const p = sy * a.w + sx
            const wt = a.wt[p]
            if (wt <= 0) continue
            wsum += wt
            for (let c = 0; c < s; c++) b.v[q * s + c] += a.v[p * s + c] * wt
          }
        if (wsum > 0) for (let c = 0; c < s; c++) b.v[q * s + c] /= wsum
        b.wt[q] = Math.min(1, wsum)
      }
    levels.push(b)
    if (bw === 1 && bh === 1) break
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const a = levels[l]
    const up = levels[l + 1]
    for (let y = 0; y < a.h; y++)
      for (let x = 0; x < a.w; x++) {
        const p = y * a.w + x
        const wt = a.wt[p]
        if (wt >= 1) continue
        // The level above at this pixel's centre, bilinearly.
        const fx = Math.min(up.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5))
        const fy = Math.min(up.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5))
        const x0 = Math.floor(fx)
        const y0 = Math.floor(fy)
        const x1 = Math.min(up.w - 1, x0 + 1)
        const y1 = Math.min(up.h - 1, y0 + 1)
        const tx = fx - x0
        const ty = fy - y0
        for (let c = 0; c < s; c++) {
          const v00 = up.v[(y0 * up.w + x0) * s + c]
          const v10 = up.v[(y0 * up.w + x1) * s + c]
          const v01 = up.v[(y1 * up.w + x0) * s + c]
          const v11 = up.v[(y1 * up.w + x1) * s + c]
          const u = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty
          a.v[p * s + c] = a.v[p * s + c] * wt + u * (1 - wt)
        }
        a.wt[p] = 1
      }
  }
  return levels[0].v
}

/** Jacobi sweeps over the covered pixels: each the mean of its four neighbours, the known ones held. */
function relax(f: Float32Array, known: Uint8Array, k: Float32Array, w: number, h: number, s: number, sweeps: number) {
  const next = new Float32Array(f.length)
  for (let it = 0; it < sweeps; it++) {
    next.set(f)
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x
        if (known[p] || k[p] <= 0) continue
        for (let c = 0; c < s; c++) next[p * s + c] = (f[(p - 1) * s + c] + f[(p + 1) * s + c] + f[(p - w) * s + c] + f[(p + w) * s + c]) / 4
      }
    f.set(next)
  }
}
