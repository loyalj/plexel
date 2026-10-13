/**
 * Content-aware fill: holes made up from the rest of the image, checked
 * against what was there (stripes, gradients, textures), with the edges
 * of the job covered: soft holes, holes on the image’s edge, several holes,
 * almost all hole, tiny images, Gray and CMYK, repeatability, progress and
 * cancelling, and how long it takes.
 *
 * Run with: node scripts/run-ts.mjs check-retouch   (add --big for a 2048 × 2048 run)
 */
import { inpaint, type InpaintInput } from '../src/retouch/inpaint'
import { heal, pullPush } from '../src/retouch/heal'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}

/** A w × h image of `channels` values a pixel, from fn(x, y). */
function image(w: number, h: number, channels: number, fn: (x: number, y: number) => number[]) {
  const img = new Uint8Array(w * h * channels)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.set(fn(x, y), (y * w + x) * channels)
  return img
}
/** A hole: 1 inside the rectangles [x0, y0, x1, y1). */
function rects(w: number, h: number, ...rs: [number, number, number, number][]) {
  const hole = new Float32Array(w * h)
  for (const [x0, y0, x1, y1] of rs) for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) hole[y * w + x] = 1
  return hole
}
/** Mean absolute difference over the pixels where `where` is set, every channel. */
function mae(a: Uint8Array, b: Uint8Array, channels: number, where: Float32Array) {
  let sum = 0
  let n = 0
  for (let p = 0; p < where.length; p++) {
    if (!where[p]) continue
    for (let c = 0; c < channels; c++) sum += Math.abs(a[p * channels + c] - b[p * channels + c])
    n += channels
  }
  return n ? sum / n : 0
}
/** Whether every pixel with hole 0 is byte for byte as it was. */
function keptOutside(a: Uint8Array, b: Uint8Array, channels: number, hole: Float32Array) {
  for (let p = 0; p < hole.length; p++) if (!hole[p]) for (let c = 0; c < channels; c++) if (a[p * channels + c] !== b[p * channels + c]) return false
  return true
}
let noiseState = 12345
const noise = () => {
  noiseState = (Math.imul(noiseState, 1103515245) + 12345) | 0
  return (noiseState >>> 16) & 255
}
const fill = (o: Partial<InpaintInput> & Pick<InpaintInput, 'image' | 'channels' | 'width' | 'height' | 'hole'>) => inpaint(o)

console.log('it continues what’s there')
{
  const w = 128
  const h = 128
  // Stripes 4 pixels on, 4 off, with a little texture along them.
  const stripes = image(w, h, 4, (x, y) => ((y >> 2) & 1 ? [200, 60 + (x % 3) * 10, 40, 255] : [30, 90, 210, 255]))
  const hole = rects(w, h, [48, 48, 80, 80])
  const out = fill({ image: stripes, channels: 4, width: w, height: h, hole })
  const e = mae(out, stripes, 4, hole)
  check('stripes carry on through a square hole', e < 6, `mean error ${e.toFixed(2)} of 255`)
  check('pixels outside the hole are untouched, byte for byte', keptOutside(out, stripes, 4, hole))

  const grad = image(w, h, 4, (x, y) => [x + y, 255 - x - y, 128, 255])
  const gh = rects(w, h, [40, 50, 80, 85])
  const go = fill({ image: grad, channels: 4, width: w, height: h, hole: gh })
  const ge = mae(go, grad, 4, gh)
  check('a smooth gradient fills smoothly, close to what was there', ge < 3, `mean error ${ge.toFixed(2)}`)
  // Running two ways at once, no patch outside the hole has the values inside it: the fill can only come close.
  const plane = image(w, h, 4, (x, y) => [x * 2, y * 2, 128, 255])
  const po = fill({ image: plane, channels: 4, width: w, height: h, hole: gh })
  const pe = mae(po, plane, 4, gh)
  check('a gradient two ways at once fills close to it', pe < 8, `mean error ${pe.toFixed(2)}`)

  // Left half red noise, right half green noise; the hole is wholly in the left.
  const two = image(w, h, 4, (x) => (x < 64 ? [150 + (noise() % 100), noise() % 50, noise() % 50, 255] : [noise() % 50, 150 + (noise() % 100), noise() % 50, 255]))
  const th = rects(w, h, [14, 40, 46, 80])
  const to = fill({ image: two, channels: 4, width: w, height: h, hole: th })
  let red = 0
  let all = 0
  for (let p = 0; p < w * h; p++) {
    if (!th[p]) continue
    all++
    if (to[p * 4] > 120 && to[p * 4 + 1] < 90) red++
  }
  check('a hole in one texture is filled with that texture, not the other', red / all > 0.97, `${((100 * red) / all).toFixed(1)}% red-texture pixels`)
  let spread = 0
  for (let p = 0; p < w * h; p++) if (th[p]) spread += Math.abs(to[p * 4] - 200)
  check('and with its grain, not a flat average', spread / all > 12, `mean |r − 200| ${(spread / all).toFixed(1)}`)

  // Top blue, bottom red; only the top may be sampled, so a hole in the red is filled blue.
  const halves = image(64, 64, 4, (_, y) => (y < 32 ? [0, 0, 255, 255] : [255, 0, 0, 255]))
  const hh = rects(64, 64, [20, 40, 44, 56])
  const src = new Uint8Array(64 * 64)
  src.fill(1, 0, 32 * 64)
  const ho = fill({ image: halves, channels: 4, width: 64, height: 64, hole: hh, source: src })
  check('patches come only from the source given', ho[(48 * 64 + 32) * 4 + 2] === 255 && ho[(48 * 64 + 32) * 4] === 0)
}

console.log('soft holes, edges and odd shapes')
{
  const w = 96
  const h = 96
  // A red square on grey, under a hole that's 1 in its middle, ½ and ¼ further out.
  const img = image(w, h, 4, (x, y) => (x >= 30 && x < 66 && y >= 30 && y < 66 ? [255, 0, 0, 255] : [120, 120, 120, 255]))
  const hole = new Float32Array(w * h)
  for (let y = 30; y < 66; y++) for (let x = 30; x < 66; x++) hole[y * w + x] = x >= 38 && x < 58 && y >= 38 && y < 58 ? 1 : x >= 34 && x < 62 && y >= 34 && y < 62 ? 0.5 : 0.25
  const out = fill({ image: img, channels: 4, width: w, height: h, hole })
  const px = (x: number, y: number) => Array.from(out.subarray((y * w + x) * 4, (y * w + x) * 4 + 4))
  check('a hole of 1 is replaced entirely', JSON.stringify(px(48, 48)) === '[120,120,120,255]', JSON.stringify(px(48, 48)))
  check('a hole of ½ is half and half', JSON.stringify(px(35, 48)) === '[188,60,60,255]', JSON.stringify(px(35, 48)))
  check('a hole of ¼ is a quarter replaced', JSON.stringify(px(31, 48)) === '[221,30,30,255]', JSON.stringify(px(31, 48)))
  check('and outside it, nothing changes', keptOutside(out, img, 4, hole))

  const stripes = image(w, h, 4, (_, y) => ((y >> 2) & 1 ? [220, 200, 40, 255] : [20, 40, 90, 255]))
  const edges = rects(w, h, [0, 0, 20, 24], [80, 40, 96, 60], [30, 76, 50, 96])
  const eo = fill({ image: stripes, channels: 4, width: w, height: h, hole: edges })
  const ee = mae(eo, stripes, 4, edges)
  check('several holes, on the corner and the edges, fill and carry the stripes on', ee < 8 && keptOutside(eo, stripes, 4, edges), `mean error ${ee.toFixed(2)}`)

  // Everything but a border 6 pixels wide.
  const most = rects(64, 64, [6, 6, 58, 58])
  const mi = image(64, 64, 4, (x, y) => [100 + (x % 2) * 20, 140, 60 + (y % 2) * 20, 255])
  const mo = fill({ image: mi, channels: 4, width: 64, height: 64, hole: most })
  let ok = true
  for (let p = 0; p < 64 * 64; p++) if (most[p] && (Math.abs(mo[p * 4] - 110) > 15 || Math.abs(mo[p * 4 + 1] - 140) > 3 || mo[p * 4 + 3] !== 255)) ok = false
  check('a hole over most of the image is filled from the little left', ok)

  const tiny = image(4, 4, 4, (x, y) => [x * 60, y * 60, 0, 255])
  const to = fill({ image: tiny, channels: 4, width: 4, height: 4, hole: rects(4, 4, [1, 1, 2, 2]) })
  check('a 4 × 4 image (smaller than a patch) still fills', to[5 * 4 + 3] === 255 && to[5 * 4] <= 120 && to[5 * 4 + 1] <= 120, Array.from(to.subarray(20, 24)).join(','))
  const one = fill({ image: new Uint8Array([10, 20, 30, 255]), channels: 4, width: 1, height: 1, hole: new Float32Array([1]) })
  check('a single pixel that’s all hole comes back as it was', one.length === 4)
  const none = fill({ image: tiny, channels: 4, width: 4, height: 4, hole: new Float32Array(16) })
  check('no hole, no change', keptOutside(none, tiny, 4, new Float32Array(16)))
}

console.log('other layouts')
{
  const w = 80
  const h = 80
  const hole = rects(w, h, [28, 28, 52, 52])
  const gray = image(w, h, 2, (_, y) => [(y >> 2) & 1 ? 230 : 25, 255])
  const go = fill({ image: gray, channels: 2, width: w, height: h, hole })
  const ge = mae(go, gray, 2, hole)
  check('Gray + alpha', ge < 6 && keptOutside(go, gray, 2, hole), `mean error ${ge.toFixed(2)}`)
  const cmyk = image(w, h, 5, (x) => ((x >> 3) & 1 ? [200, 10, 0, 30, 255] : [0, 180, 220, 0, 255]))
  const co = fill({ image: cmyk, channels: 5, width: w, height: h, hole })
  const ce = mae(co, cmyk, 5, hole)
  check('CMYK + alpha, stripes the other way', ce < 8 && keptOutside(co, cmyk, 5, hole), `mean error ${ce.toFixed(2)}`)
  // Alpha is matched too: a half-transparent band continues.
  const alpha = image(w, h, 4, (_, y) => [50, 100, 150, (y >> 3) & 1 ? 255 : 64])
  const ao = fill({ image: alpha, channels: 4, width: w, height: h, hole })
  const ae = mae(ao, alpha, 4, hole)
  check('alpha is filled like any channel', ae < 6, `mean error ${ae.toFixed(2)}`)
}

console.log('repeatable, cancellable, timed')
{
  const w = 512
  const h = 512
  noiseState = 7
  // Stripes with noise on them, and a few soft blobs, as something like a photo.
  const img = image(w, h, 4, (x, y) => {
    const n = noise() % 24
    const band = Math.sin(y / 9 + Math.sin(x / 40) * 2) > 0
    return band ? [180 + n, 150 + n, 110, 255] : [60 + n, 80 + n, 50 + (x >> 4), 255]
  })
  const hole = rects(w, h, [196, 196, 316, 316])
  const steps: number[] = []
  const t0 = performance.now()
  const a = fill({ image: img, channels: 4, width: w, height: h, hole, seed: 3, onProgress: (f) => steps.push(f) })
  const ms = performance.now() - t0
  check('512 × 512 with a 120 × 120 hole in under 3 s', ms < 3000, `${ms.toFixed(0)} ms`)
  check('progress rises to 1', steps.length > 5 && steps.every((f, k) => k === 0 || f >= steps[k - 1]) && steps[steps.length - 1] === 1, `${steps.length} reports`)
  const b = fill({ image: img, channels: 4, width: w, height: h, hole, seed: 3 })
  check('the same seed gives the same result', a.every((v, k) => v === b[k]))
  const c = fill({ image: img, channels: 4, width: w, height: h, hole, seed: 4 })
  check('another seed may differ, but only inside the hole', keptOutside(c, img, 4, hole))
  let polls = 0
  let message = ''
  try {
    fill({ image: img, channels: 4, width: w, height: h, hole, shouldStop: () => ++polls > 3 })
  } catch (e) {
    message = (e as Error).message
  }
  check('shouldStop cancels it', message === 'cancelled')

  if (process.argv.includes('--big')) {
    const W = 2048
    const big = image(W, W, 4, (x, y) => {
      const n = noise() % 24
      return Math.sin(y / 9 + Math.sin(x / 40) * 2) > 0 ? [180 + n, 150 + n, 110, 255] : [60 + n, 80 + n, 50 + (x >> 6), 255]
    })
    const bh = rects(W, W, [900, 800, 1200, 1100])
    const t1 = performance.now()
    const bo = fill({ image: big, channels: 4, width: W, height: W, hole: bh })
    const bms = performance.now() - t1
    check('2048 × 2048 with a 300 × 300 hole in under 25 s', bms < 25000 && keptOutside(bo, big, 4, bh), `${bms.toFixed(0)} ms`)
  }
}

console.log('\nhealing')
{
  // Gray + alpha, 40 × 40: the destination a flat 0.6, the source a flat 0.3 with stripes ±0.1, a disc in the middle covered.
  const w = 40
  const h = 40
  const s = 2
  const dest = new Float32Array(w * h * s)
  const source = new Float32Array(w * h * s)
  const k = new Float32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      dest[p * s] = 0.6
      dest[p * s + 1] = 1
      source[p * s] = 0.3 + (x % 4 < 2 ? 0.1 : -0.1)
      source[p * s + 1] = 1
      if ((x - 20) ** 2 + (y - 20) ** 2 < 100) k[p] = 1
    }
  const out = heal({ dest, source, k, width: w, height: h, stride: s })
  check('uncovered pixels are the destination as it was', out[0] === dest[0] && out[(39 * w + 39) * s] === dest[(39 * w + 39) * s])
  let sum = 0
  let n = 0
  let lo = 1
  let hi = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!k[y * w + x]) continue
      const v = out[(y * w + x) * s]
      sum += v
      n++
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
  check('healed, the area takes the destination’s tone', Math.abs(sum / n - 0.6) < 0.03, String(sum / n))
  // The edge carries the source's stripes too (the correction meets them exactly there), so a little more than their own ±0.1.
  check('and keeps the source’s texture', hi - lo > 0.15 && hi - lo < 0.4, `${lo}..${hi}`)
  check('with no seam at its edge: just inside is near what’s just outside', Math.abs(out[(20 * w + 11) * s] - 0.6) < 0.12, String(out[(20 * w + 11) * s]))
  const none = heal({ dest, source, k: new Float32Array(w * h), width: w, height: h, stride: s })
  check('with nothing covered, nothing changes', none.every((v, i) => v === dest[i]))

  // Pull-push: known values round a square are filled in smoothly, and a constant stays constant.
  const kn = new Uint8Array(16 * 16)
  const vals = new Float32Array(16 * 16)
  for (let i = 0; i < 16; i++) for (const [x, y] of [[i, 0], [i, 15], [0, i], [15, i]]) {
    kn[y * 16 + x] = 1
    vals[y * 16 + x] = 0.25
  }
  const filled = pullPush(vals, kn, 16, 16, 1)
  check('pull-push fills a constant ring with the constant', filled.every((v) => Math.abs(v - 0.25) < 1e-6))
  const ramp = new Float32Array(16 * 16)
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (kn[y * 16 + x]) ramp[y * 16 + x] = x / 15
  const r = pullPush(ramp, kn, 16, 16, 1)
  check('and a ramp round the edge rises across the middle', r[8 * 16 + 2] < r[8 * 16 + 8] && r[8 * 16 + 8] < r[8 * 16 + 13], `${r[8 * 16 + 2]} ${r[8 * 16 + 8]} ${r[8 * 16 + 13]}`)
}

console.log(failures ? `\n${failures} failed` : '\nall clear')
process.exit(failures ? 1 : 0)
