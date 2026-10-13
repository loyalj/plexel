/**
 * Content-aware fill: a hole in an image made up from the rest of it.
 *
 * Multi-scale PatchMatch completion, after Wexler, Shechtman and Irani
 * (“Space-Time Completion of Video”) and Barnes et al. (“PatchMatch”),
 * which is what Photoshop’s Content-Aware Fill grew from. The image is
 * halved until the hole is a few pixels across, and there the hole is
 * filled roughly, from its edge inwards. Then, level by level back up to
 * full size, every patch touching the hole is matched with the patch most
 * like it from outside the hole (PatchMatch’s propagation and random
 * search), and each hole pixel becomes the weighted mean of what the
 * patches over it say it should be: patches nearer the known edge, and
 * patches that match better, count for more.
 *
 * Only the hole and a margin round it are worked on at each level, but
 * patches come from anywhere the source allows. Pure arithmetic on typed
 * arrays, with no DOM and no GPU: the engine worker runs it, and so do the
 * checks, in Node.
 */

export interface InpaintInput {
  /** Straight (not premultiplied) 8-bit pixels, row-major, interleaved, `channels` values each, alpha last (RGB+A = 4, Gray+A = 2, CMYK+A = 5; CMYK values are ink amounts). */
  image: Uint8Array
  channels: number
  width: number
  height: number
  /** 0..1 per pixel: how much to replace. 1 = fill entirely, 0 = keep; values between are blended (a feathered selection). */
  hole: Float32Array
  /** Optional: 1 where patches may be sampled from. Default: everywhere the hole is 0. */
  source?: Uint8Array
  /** Patch size in pixels (odd), default 7. */
  patch?: number
  /** Seed for the random search, so results are repeatable. Default 1. */
  seed?: number
  /** Called now and then with progress 0..1. */
  onProgress?(f: number): void
  /** Polled now and then; when it returns true, stop and throw an Error('cancelled'). */
  shouldStop?(): boolean
}

/** One level of the pyramid. */
interface Level {
  w: number
  h: number
  img: Uint8Array
  /** 1 where a pixel is to be made up, and so can’t be matched against. */
  unknown: Uint8Array
  /** 1 where a pixel may be sampled from. */
  source: Uint8Array
}

/** The pixels a whole patch can be taken from, centred there: as a mask, and listed for picking at random. */
interface Centres {
  mask: Uint8Array
  list: Int32Array
}

/** The part of a level being worked on: the hole’s bounding box and a margin of two patch radii. */
interface Field {
  x0: number
  y0: number
  rw: number
  rh: number
  /** 1 for each pixel to be synthesised (the hole, soft parts too). */
  want: Uint8Array
  /** The centres of the patches that touch a wanted pixel, as region indices, in scan order. */
  targets: Int32Array
  /** Region index to target number, or −1. */
  tix: Int32Array
  /** How much each target patch is trusted: less the further its centre is inside the hole. */
  conf: Float32Array
  /** The region’s pixels as they stand: known ones as they are, hole ones as filled so far. */
  cur: Float32Array
  /** What the patches say each wanted pixel should be. */
  syn: Float32Array
  /** For each target, the centre of the source patch it matches, as a level pixel index, and how far apart they are. */
  nnf: Int32Array
  cost: Float32Array
  /** The furthest any hole pixel is from a known one. */
  thickness: number
}

/** How fast a hole pixel’s trust falls off with its distance from the known edge (Wexler’s γ). */
const GAMMA = 1.3
/** Rounds of search and voting: at the coarsest level, between, and at full size. */
const ROUNDS = { top: 12, mid: 6, fine: 4 }

/** Returns a new image the same layout as `image`: pixels with hole 0 unchanged, hole pixels synthesised from the rest, soft hole pixels mixed by their hole value. */
export function inpaint(i: InpaintInput): Uint8Array {
  const { image, channels: C, width: W, height: H, hole } = i
  const n = W * H
  const out = image.slice()
  const unknown = new Uint8Array(n)
  const source = new Uint8Array(n)
  const want = new Uint8Array(n)
  let any = false
  for (let p = 0; p < n; p++) {
    const v = hole[p]
    if (v > 0) {
      want[p] = 1
      any = true
    }
    if (v >= 0.5) unknown[p] = 1
    source[p] = (i.source ? i.source[p] && v < 0.5 : v <= 0) ? 1 : 0
  }
  if (!any) return out

  let state = (Math.imul((i.seed ?? 1) | 0, 0x9e3779b1) ^ 0x2545f491) | 0 || 1
  const rnd = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
  const stop = () => {
    if (i.shouldStop?.()) throw new Error('cancelled')
  }
  const finest: Level = { w: W, h: H, img: image, unknown, source }

  // The largest patch up to the one asked for that fits and has somewhere to come from.
  let r = -1
  let centres: Centres | null = null
  for (let q = Math.max(1, Math.floor(i.patch ?? 7) | 1); q >= 1 && !centres; q -= 2) {
    if (q > Math.min(W, H)) continue
    const c = validCentres(finest, q >> 1)
    if (c.list.length) {
      centres = c
      r = q >> 1
    }
  }
  if (!centres) {
    // Nothing to sample from: the hole is smoothed in from its edge.
    const f = field(finest, want, 1, C)
    peel(finest, f, C)
    f.syn.set(f.cur)
    finish(out, image, hole, f, C, W)
    i.onProgress?.(1)
    return out
  }

  const fine = field(finest, want, r, C)
  const levels = [finest]
  const cs = [centres]
  for (let span = fine.thickness; span > 3; span /= 2) {
    const lv = halve(levels[levels.length - 1], C)
    if (Math.min(lv.w, lv.h) < 2 * r + 1) break
    const c = validCentres(lv, r)
    if (!c.list.length) break
    levels.push(lv)
    cs.push(c)
  }

  const top = levels.length - 1
  const rounds = (l: number) => (l === top ? ROUNDS.top : l === 0 ? ROUNDS.fine : ROUNDS.mid)
  let total = 0
  for (let l = 0; l <= top; l++) total += (rounds(l) + 1) / 4 ** l
  let done = 0
  const step = (l: number) => {
    done += 1 / 4 ** l
    i.onProgress?.(Math.min(1, done / total))
  }

  let prev: Field | null = null
  for (let l = top; l >= 0; l--) {
    stop()
    const lv = levels[l]
    const c = cs[l]
    const f = l === 0 ? fine : field(lv, lv.unknown, r, C)
    const dist = distance(lv, f, r, C)
    if (!prev) {
      peel(lv, f, C)
      for (let k = 0; k < f.targets.length; k++) f.nnf[k] = c.list[rnd() % c.list.length]
    } else {
      upsample(prev, levels[l + 1], f, lv, c, C, rnd)
      costs(f, dist)
      vote(lv, f, r, C)
    }
    step(l)
    for (let it = 0; it < rounds(l); it++) {
      stop()
      costs(f, dist)
      search(lv, f, c, r, it, dist, rnd, stop)
      vote(lv, f, r, C)
      step(l)
    }
    prev = f
  }
  finish(out, image, hole, fine, C, W)
  i.onProgress?.(1)
  return out
}

/** Each wanted pixel mixed from the original to what was made for it, by its hole value. */
function finish(out: Uint8Array, image: Uint8Array, hole: Float32Array, f: Field, C: number, W: number) {
  for (let ry = 0; ry < f.rh; ry++) {
    for (let rx = 0; rx < f.rw; rx++) {
      const rq = ry * f.rw + rx
      if (!f.want[rq]) continue
      const p = (f.y0 + ry) * W + f.x0 + rx
      const k = Math.min(1, hole[p])
      for (let c = 0; c < C; c++) {
        const v = image[p * C + c] * (1 - k) + f.syn[rq * C + c] * k
        out[p * C + c] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v)
      }
    }
  }
}

/** Where a whole patch of radius r lies on the image and in the source. */
function validCentres(lv: Level, r: number): Centres {
  const { w, h, source } = lv
  const p = 2 * r + 1
  const across = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    let run = 0
    for (let x = 0; x < w; x++) {
      run = source[y * w + x] ? run + 1 : 0
      if (run >= p) across[y * w + x - r] = 1
    }
  }
  const mask = new Uint8Array(w * h)
  let count = 0
  for (let x = 0; x < w; x++) {
    let run = 0
    for (let y = 0; y < h; y++) {
      run = across[y * w + x] ? run + 1 : 0
      if (run >= p) {
        mask[(y - r) * w + x] = 1
        count++
      }
    }
  }
  const list = new Int32Array(count)
  for (let q = 0, k = 0; q < w * h; q++) if (mask[q]) list[k++] = q
  return { mask, list }
}

/** The next level down: half the size, each pixel the mean of four; unknown if any of them is, a source only if all are. */
function halve(lv: Level, C: number): Level {
  const { w: W, h: H } = lv
  const w = (W + 1) >> 1
  const h = (H + 1) >> 1
  const img = new Uint8Array(w * h * C)
  const unknown = new Uint8Array(w * h)
  const source = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const ya = 2 * y * W
    const yb = Math.min(H - 1, 2 * y + 1) * W
    for (let x = 0; x < w; x++) {
      const xa = 2 * x
      const xb = Math.min(W - 1, 2 * x + 1)
      const a = ya + xa
      const b = ya + xb
      const c = yb + xa
      const d = yb + xb
      const q = y * w + x
      unknown[q] = lv.unknown[a] | lv.unknown[b] | lv.unknown[c] | lv.unknown[d]
      source[q] = lv.source[a] & lv.source[b] & lv.source[c] & lv.source[d]
      for (let ch = 0; ch < C; ch++) img[q * C + ch] = (lv.img[a * C + ch] + lv.img[b * C + ch] + lv.img[c * C + ch] + lv.img[d * C + ch] + 2) >> 2
    }
  }
  return { w, h, img, unknown, source }
}

/** Marks every pixel within r (a square) of a marked one, in place. */
function spread(a: Uint8Array, w: number, h: number, r: number) {
  if (r <= 0) return
  const line = new Uint8Array(Math.max(w, h))
  const pass = (len: number, lines: number, at: (k: number, i: number) => number) => {
    for (let k = 0; k < lines; k++) {
      let last = -Infinity
      for (let i = 0; i < len; i++) {
        if (a[at(k, i)]) last = i
        line[i] = i - last <= r ? 1 : 0
      }
      last = Infinity
      for (let i = len - 1; i >= 0; i--) {
        if (a[at(k, i)]) last = i
        if (last - i <= r) line[i] = 1
      }
      for (let i = 0; i < len; i++) a[at(k, i)] = line[i]
    }
  }
  pass(w, h, (k, i) => k * w + i)
  pass(h, w, (k, i) => i * w + k)
}

/** The region round what’s wanted at a level, its patches to match, and how far each is inside the hole. */
function field(lv: Level, want: Uint8Array, r: number, C: number): Field {
  const { w, h } = lv
  let bx0 = w
  let by0 = h
  let bx1 = -1
  let by1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!want[y * w + x]) continue
      if (x < bx0) bx0 = x
      if (x > bx1) bx1 = x
      if (y < by0) by0 = y
      by1 = y
    }
  }
  const x0 = Math.max(0, bx0 - 2 * r)
  const y0 = Math.max(0, by0 - 2 * r)
  const rw = Math.min(w, bx1 + 2 * r + 1) - x0
  const rh = Math.min(h, by1 + 2 * r + 1) - y0
  const m = Math.max(0, rw * rh)
  const wr = new Uint8Array(m)
  const cur = new Float32Array(m * C)
  for (let ry = 0; ry < rh; ry++) {
    const p = (y0 + ry) * w + x0
    wr.set(want.subarray(p, p + rw), ry * rw)
    for (let k = 0; k < rw * C; k++) cur[ry * rw * C + k] = lv.img[p * C + k]
  }
  const near = wr.slice()
  spread(near, rw, rh, r)
  const tix = new Int32Array(m).fill(-1)
  let count = 0
  for (let q = 0; q < m; q++) if (near[q]) tix[q] = count++
  const targets = new Int32Array(count)
  for (let q = 0; q < m; q++) if (near[q]) targets[tix[q]] = q

  // Chamfer distance from the nearest known pixel.
  const d = new Float32Array(m)
  for (let ry = 0; ry < rh; ry++) for (let rx = 0; rx < rw; rx++) d[ry * rw + rx] = lv.unknown[(y0 + ry) * w + x0 + rx] ? Infinity : 0
  const D = Math.SQRT2
  const relax = (q: number, x: number, y: number, dx: number, dy: number, cost: number) => {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) return
    const v = d[ny * rw + nx] + cost
    if (v < d[q]) d[q] = v
  }
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const q = y * rw + x
      if (!d[q]) continue
      relax(q, x, y, -1, 0, 1)
      relax(q, x, y, -1, -1, D)
      relax(q, x, y, 0, -1, 1)
      relax(q, x, y, 1, -1, D)
    }
  }
  let thickness = 0
  for (let y = rh - 1; y >= 0; y--) {
    for (let x = rw - 1; x >= 0; x--) {
      const q = y * rw + x
      if (!d[q]) continue
      relax(q, x, y, 1, 0, 1)
      relax(q, x, y, 1, 1, D)
      relax(q, x, y, 0, 1, 1)
      relax(q, x, y, -1, 1, D)
      if (d[q] > thickness) thickness = d[q]
    }
  }
  const conf = new Float32Array(count)
  for (let k = 0; k < count; k++) conf[k] = GAMMA ** -Math.min(60, d[targets[k]])
  return { x0, y0, rw, rh, want: wr, targets, tix, conf, cur, syn: new Float32Array(m * C), nnf: new Int32Array(count), cost: new Float32Array(count), thickness: Number.isFinite(thickness) ? thickness : Math.max(rw, rh) }
}

/** A rough first fill, from the edge inwards: each ring of the hole the mean of what’s already there round it. */
function peel(lv: Level, f: Field, C: number) {
  const { rw, rh, cur } = f
  const have = new Uint8Array(rw * rh)
  let left = 0
  for (let ry = 0; ry < rh; ry++) {
    for (let rx = 0; rx < rw; rx++) {
      const unknown = lv.unknown[(f.y0 + ry) * lv.w + f.x0 + rx]
      have[ry * rw + rx] = unknown ? 0 : 1
      left += unknown
    }
  }
  const ring = new Int32Array(rw * rh)
  const sum = new Float64Array(C)
  while (left) {
    let m = 0
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        if (have[y * rw + x]) continue
        let next = false
        for (let dy = -1; dy <= 1 && !next; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx >= 0 && ny >= 0 && nx < rw && ny < rh && have[ny * rw + nx]) {
            next = true
            break
          }
        }
        if (next) ring[m++] = y * rw + x
      }
    }
    if (!m) break
    for (let k = 0; k < m; k++) {
      const q = ring[k]
      const x = q % rw
      const y = (q / rw) | 0
      sum.fill(0)
      let n = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= rw || ny >= rh || !have[ny * rw + nx]) continue
        for (let c = 0; c < C; c++) sum[c] += cur[(ny * rw + nx) * C + c]
        n++
      }
      for (let c = 0; c < C; c++) cur[q * C + c] = sum[c] / n
    }
    for (let k = 0; k < m; k++) have[ring[k]] = 1
    left -= m
  }
}

type Distance = (tx: number, ty: number, s: number, best: number) => number

/** The patch distance at a level: sum of squared differences over every channel, between the target patch as it stands and a source patch, stopping once past `best`. */
function distance(lv: Level, f: Field, r: number, C: number): Distance {
  const { w, h, img } = lv
  const { x0, y0, rw, cur } = f
  return (tx, ty, s, best) => {
    const ya = ty < r ? -ty : -r
    const yb = ty + r >= h ? h - 1 - ty : r
    const xa = tx < r ? -tx : -r
    const xb = tx + r >= w ? w - 1 - tx : r
    const run = (xb - xa + 1) * C
    let d = 0
    for (let dy = ya; dy <= yb; dy++) {
      let ci = ((ty + dy - y0) * rw + tx + xa - x0) * C
      let si = (s + dy * w + xa) * C
      const end = ci + run
      while (ci < end) {
        const e = cur[ci++] - img[si++]
        d += e * e
      }
      if (d >= best) return d
    }
    return d
  }
}

/** How many of a patch’s pixels are on the image. */
function onImage(lv: Level, r: number, tx: number, ty: number) {
  return (Math.min(lv.w - 1, tx + r) - Math.max(0, tx - r) + 1) * (Math.min(lv.h - 1, ty + r) - Math.max(0, ty - r) + 1)
}

function costs(f: Field, dist: Distance) {
  for (let k = 0; k < f.targets.length; k++) {
    const q = f.targets[k]
    f.cost[k] = dist(f.x0 + (q % f.rw), f.y0 + ((q / f.rw) | 0), f.nnf[k], Infinity)
  }
}

/** One PatchMatch pass: each target tries its neighbours’ matches moved by one, then random ones nearer and nearer its own. Alternate passes run backwards. */
function search(lv: Level, f: Field, c: Centres, r: number, round: number, dist: Distance, rnd: () => number, stop: () => void) {
  const { w, h } = lv
  const { rw, targets, tix, nnf, cost } = f
  const dir = round % 2 ? -1 : 1
  const T = targets.length
  const lo = r
  const hix = w - 1 - r
  const hiy = h - 1 - r
  for (let j = 0; j < T; j++) {
    if ((j & 4095) === 4095) stop()
    const k = dir > 0 ? j : T - 1 - j
    const q = targets[k]
    const qx = q % rw
    const tx = f.x0 + qx
    const ty = f.y0 + ((q / rw) | 0)
    let best = nnf[k]
    let bc = cost[k]
    if (qx - dir >= 0 && qx - dir < rw) {
      const nk = tix[q - dir]
      if (nk >= 0) {
        const s = nnf[nk] + dir
        if (s !== best && s >= 0 && s < w * h && c.mask[s]) {
          const d = dist(tx, ty, s, bc)
          if (d < bc) {
            bc = d
            best = s
          }
        }
      }
    }
    const up = q - dir * rw
    if (up >= 0 && up < tix.length) {
      const nk = tix[up]
      if (nk >= 0) {
        const s = nnf[nk] + dir * w
        if (s !== best && s >= 0 && s < w * h && c.mask[s]) {
          const d = dist(tx, ty, s, bc)
          if (d < bc) {
            bc = d
            best = s
          }
        }
      }
    }
    let bx = best % w
    let by = (best / w) | 0
    for (let rad = Math.max(w, h); rad >= 1; rad >>= 1) {
      let x = bx + (rnd() % (2 * rad + 1)) - rad
      let y = by + (rnd() % (2 * rad + 1)) - rad
      x = x < lo ? lo : x > hix ? hix : x
      y = y < lo ? lo : y > hiy ? hiy : y
      const s = y * w + x
      if (s === best || !c.mask[s]) continue
      const d = dist(tx, ty, s, bc)
      if (d < bc) {
        bc = d
        best = s
        bx = x
        by = y
      }
    }
    nnf[k] = best
    cost[k] = bc
  }
}

/** Each wanted pixel made the weighted mean of what the patches over it say, and hole pixels set to it. */
function vote(lv: Level, f: Field, r: number, C: number) {
  const { w, h, img, unknown } = lv
  const { x0, y0, rw, rh, targets, nnf, cost, conf, want, cur, syn } = f
  const T = targets.length
  // Wexler’s σ²: the 75th percentile of the per-value match distances, from a sample.
  const sample = new Float64Array(Math.min(T, 1024))
  for (let j = 0; j < sample.length; j++) {
    const k = Math.floor((j * T) / sample.length)
    const q = targets[k]
    sample[j] = cost[k] / (onImage(lv, r, x0 + (q % rw), y0 + ((q / rw) | 0)) * C)
  }
  sample.sort()
  const sigma2 = Math.max(1, sample.length ? sample[Math.floor(sample.length * 0.75)] : 1)
  const acc = new Float64Array(rw * rh * C)
  const ws = new Float64Array(rw * rh)
  for (let k = 0; k < T; k++) {
    const q = targets[k]
    const tx = x0 + (q % rw)
    const ty = y0 + ((q / rw) | 0)
    const n = onImage(lv, r, tx, ty)
    const wt = conf[k] * Math.exp(-Math.min(30, cost[k] / (n * C) / (2 * sigma2)))
    const s = nnf[k]
    for (let dy = -r; dy <= r; dy++) {
      const y = ty + dy
      if (y < 0 || y >= h) continue
      for (let dx = -r; dx <= r; dx++) {
        const x = tx + dx
        if (x < 0 || x >= w) continue
        const rq = (y - y0) * rw + x - x0
        if (!want[rq]) continue
        const si = (s + dy * w + dx) * C
        for (let c = 0; c < C; c++) acc[rq * C + c] += wt * img[si + c]
        ws[rq] += wt
      }
    }
  }
  for (let ry = 0; ry < rh; ry++) {
    for (let rx = 0; rx < rw; rx++) {
      const rq = ry * rw + rx
      if (!want[rq] || !ws[rq]) continue
      const known = !unknown[(y0 + ry) * w + x0 + rx]
      for (let c = 0; c < C; c++) {
        const v = acc[rq * C + c] / ws[rq]
        syn[rq * C + c] = v
        if (!known) cur[rq * C + c] = v
      }
    }
  }
}

/** A level’s field started from the one below: matches doubled up, hole pixels their parent’s colour. */
function upsample(pf: Field, plv: Level, f: Field, lv: Level, c: Centres, C: number, rnd: () => number) {
  const { w, h } = lv
  for (let k = 0; k < f.targets.length; k++) {
    const q = f.targets[k]
    const tx = f.x0 + (q % f.rw)
    const ty = f.y0 + ((q / f.rw) | 0)
    const px = Math.min(plv.w - 1, tx >> 1)
    const py = Math.min(plv.h - 1, ty >> 1)
    const prx = px - pf.x0
    const pry = py - pf.y0
    let s = -1
    if (prx >= 0 && pry >= 0 && prx < pf.rw && pry < pf.rh) {
      const pk = pf.tix[pry * pf.rw + prx]
      if (pk >= 0) {
        const ps = pf.nnf[pk]
        const sx = 2 * (ps % plv.w) + tx - 2 * px
        const sy = 2 * ((ps / plv.w) | 0) + ty - 2 * py
        if (sx >= 0 && sy >= 0 && sx < w && sy < h && c.mask[sy * w + sx]) s = sy * w + sx
      }
    }
    f.nnf[k] = s >= 0 ? s : c.list[rnd() % c.list.length]
  }
  for (let ry = 0; ry < f.rh; ry++) {
    for (let rx = 0; rx < f.rw; rx++) {
      const x = f.x0 + rx
      const y = f.y0 + ry
      if (!lv.unknown[y * w + x]) continue
      const prx = Math.min(plv.w - 1, x >> 1) - pf.x0
      const pry = Math.min(plv.h - 1, y >> 1) - pf.y0
      if (prx < 0 || pry < 0 || prx >= pf.rw || pry >= pf.rh) continue
      const pi = (pry * pf.rw + prx) * C
      const fi = (ry * f.rw + rx) * C
      for (let ch = 0; ch < C; ch++) f.cur[fi + ch] = pf.cur[pi + ch]
    }
  }
}
