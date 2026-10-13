/**
 * Select and Mask's matting: edge detection (radius and Smart Radius), the
 * refine edge brush and colour decontamination. Each image is made as
 * αF + (1 − α)B from a known α, the selection is that α cut hard at 0.5,
 * and refining it should bring it back close to α.
 *
 * Run with: node scripts/run-ts.mjs check-matte
 */
import { decontaminate, edgeBand, refineEdge } from '../src/select/matte'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}

/** A hash to 0..1, for texture that's the same every run. */
const hash = (x: number, y: number) => {
  let v = Math.imul(x, 374761393) + Math.imul(y, 668265263)
  v = Math.imul(v ^ (v >>> 13), 1274126177)
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296
}

interface Scene {
  image: Uint8Array
  channels: number
  width: number
  height: number
  alpha: Float32Array
  fg: (x: number, y: number) => number[]
}

/** An image composited from α over a textured background, `channels` values a pixel with alpha last. */
function scene(width: number, height: number, channels: number, alpha: (x: number, y: number) => number, fg: (x: number, y: number) => number[], bg: (x: number, y: number) => number[]): Scene {
  const image = new Uint8Array(width * height * channels)
  const a = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const t = alpha(x, y)
      a[i] = t
      const f = fg(x, y)
      const b = bg(x, y)
      for (let c = 0; c < channels - 1; c++) image[i * channels + c] = Math.round(t * f[c] + (1 - t) * b[c])
      image[i * channels + channels - 1] = 255
    }
  }
  return { image, channels, width, height, alpha: a, fg }
}

const smoothstep = (e0: number, e1: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
/** A disc's α with an edge `soft` pixels wide. */
const disc = (cx: number, cy: number, r: number, soft: number) => (x: number, y: number) => 1 - smoothstep(r - soft / 2, r + soft / 2, Math.hypot(x + 0.5 - cx, y + 0.5 - cy))

const palette = {
  4: { fg: [225, 140, 60], bg: [40, 90, 170] },
  2: { fg: [210], bg: [50] },
  5: { fg: [10, 50, 90, 0], bg: [80, 30, 5, 20] },
} as Record<number, { fg: number[]; bg: number[] }>
const texturedBg = (base: number[]) => (x: number, y: number) => base.map((v, c) => Math.min(255, Math.max(0, v + 25 * Math.sin(x / 6 + c) * Math.cos(y / 5 - c) + 16 * (hash(x + c * 7919, y) - 0.5))))
const flatFg = (base: number[]) => (x: number, y: number) => base.map((v) => Math.min(255, Math.max(0, v + 6 * (hash(y, x) - 0.5))))

const hardOf = (a: Float32Array) => a.map((v) => (v >= 0.5 ? 1 : 0))

/** Mean |α − truth| over the band, weighted by the band. */
function bandError(a: Float32Array, truth: Float32Array, band: Float32Array): number {
  let s = 0
  let n = 0
  for (let i = 0; i < a.length; i++) {
    if (band[i] <= 0) continue
    s += band[i] * Math.abs(a[i] - truth[i])
    n += band[i]
  }
  return s / n
}

function unchangedOutside(a: Float32Array, coverage: Float32Array, band: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (band[i] <= 0 && a[i] !== coverage[i]) return false
  return true
}

const noNaN = (a: Float32Array) => a.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)

function refineCase(name: string, s: Scene, radius: number, smart: boolean, brushed?: Uint8Array, factor = 0.4) {
  const coverage = hardOf(s.alpha)
  const t0 = performance.now()
  const band = edgeBand({ ...s, coverage, radius, smart, brushed })
  const t1 = performance.now()
  const refined = refineEdge({ ...s, coverage, band })
  const t2 = performance.now()
  const before = bandError(coverage, s.alpha, band)
  const after = bandError(refined, s.alpha, band)
  check(`${name}: error in the band drops`, after < before * factor && noNaN(refined), `hard ${before.toFixed(4)} -> refined ${after.toFixed(4)} (${((after / before) * 100).toFixed(0)}%)  [band ${(t1 - t0).toFixed(0)} ms, refine ${(t2 - t1).toFixed(0)} ms]`)
  check(`${name}: outside the band, unchanged`, unchangedOutside(refined, coverage, band))
  return { coverage, band, refined }
}

console.log('edge detection and refine')
const W = 512
const H = 512
const rgb = palette[4]
{
  const s = scene(W, H, 4, disc(256, 256, 160, 8), flatFg(rgb.fg), texturedBg(rgb.bg))
  const { band } = refineCase('soft disc, RGB, radius 10', s, 10, false)
  check('the band is 1 near the edge and 0 far from it', band[256 * W + 256 + 160] === 1 && band[256 * W + 256] === 0 && band[256 * W + 256 + 175] === 0)
  refineCase('soft disc, RGB, Smart Radius 16', s, 16, true)
}

{
  // Hair: thin strands at partial α out of a head, over texture; the refine brush covers where they are.
  const cx = 256
  const cy = 280
  const strands: { a0: number; len: number; bend: number; peak: number }[] = []
  for (let k = 0; k < 48; k++) strands.push({ a0: (k / 48) * Math.PI * 2 + hash(k, 1) * 0.1, len: 30 + 40 * hash(k, 2), bend: (hash(k, 3) - 0.5) * 0.02, peak: 0.45 + 0.4 * hash(k, 4) })
  const head = disc(cx, cy, 120, 2)
  const alpha = (x: number, y: number) => {
    let a = head(x, y)
    const dx = x + 0.5 - cx
    const dy = y + 0.5 - cy
    const r = Math.hypot(dx, dy)
    if (r < 115 || r > 195) return a
    const ang = Math.atan2(dy, dx)
    for (const st of strands) {
      const along = r - 118
      if (along > st.len) continue
      let da = ang - (st.a0 + st.bend * along)
      da = Math.atan2(Math.sin(da), Math.cos(da))
      const off = da * r
      const fade = 1 - smoothstep(st.len * 0.6, st.len, along)
      a = Math.max(a, st.peak * fade * Math.exp(-(off * off) / (2 * 0.8 * 0.8)))
    }
    return a
  }
  const s = scene(W, H, 4, alpha, flatFg([90, 60, 30]), texturedBg([170, 200, 225]))
  const brushed = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
    if (r > 112 && r < 196) brushed[y * W + x] = 1
  }
  const { band } = refineCase('hair over texture, refine brush', s, 4, false, brushed, 0.5)
  check('the brushed area is all in the band', band.every((v, i) => !brushed[i] || v === 1))
}

{
  // Smart Radius on the same selection: a crisp edge gets a narrow band, a soft one a wide one.
  const area = (b: Float32Array) => b.reduce((s, v) => s + v, 0)
  const crisp = scene(W, H, 4, disc(256, 256, 160, 1), flatFg(rgb.fg), (x, y) => rgb.bg.map((v) => v + 0 * x * y))
  const soft = scene(W, H, 4, disc(256, 256, 160, 24), flatFg(rgb.fg), (x, y) => rgb.bg.map((v) => v + 0 * x * y))
  const coverage = hardOf(crisp.alpha)
  const bc = area(edgeBand({ ...crisp, coverage, radius: 20, smart: true }))
  const bs = area(edgeBand({ ...soft, coverage, radius: 20, smart: true }))
  const bp = area(edgeBand({ ...crisp, coverage, radius: 20, smart: false }))
  const perimeter = 2 * Math.PI * 160
  check('Smart Radius: narrower on a crisp edge than a soft one', bc < bs * 0.5, `mean band width crisp ${(bc / perimeter).toFixed(1)} px, soft ${(bs / perimeter).toFixed(1)} px, plain radius 20: ${(bp / perimeter).toFixed(1)} px`)
}

console.log('other channels and edges of the image')
{
  const g = palette[2]
  refineCase('soft disc, Gray', scene(W, H, 2, disc(256, 256, 150, 8), flatFg(g.fg), texturedBg(g.bg)), 10, false)
  const k = palette[5]
  refineCase('soft disc, CMYK', scene(W, H, 5, disc(256, 256, 150, 8), flatFg(k.fg), texturedBg(k.bg)), 10, false)
  refineCase('a disc cut by the image’s edge', scene(W, H, 4, disc(40, 60, 150, 8), flatFg(rgb.fg), texturedBg(rgb.bg)), 12, true)

  const s = scene(64, 64, 4, () => 1, flatFg(rgb.fg), texturedBg(rgb.bg))
  const all = new Float32Array(64 * 64).fill(1)
  const none = edgeBand({ ...s, coverage: all, radius: 10, smart: true })
  check('a selection with no edge has no band', none.every((v) => v === 0))
  const everywhere = new Uint8Array(64 * 64).fill(1)
  const half = all.map((_, i) => ((i % 64) < 32 ? 1 : 0))
  const band = edgeBand({ ...s, coverage: half, radius: 10, smart: false, brushed: everywhere })
  const r = refineEdge({ ...s, coverage: half, band })
  check('with nothing known round about, the coverage is kept', r.every((v, i) => v === half[i]))
}

console.log('decontaminate')
for (const ch of [4, 2, 5]) {
  const p = palette[ch]
  const s = scene(W, H, ch, disc(256, 256, 150, 10), flatFg(p.fg), texturedBg(p.bg))
  const out = decontaminate({ ...s, alpha: s.alpha, amount: 1 })
  let before = 0
  let after = 0
  let n = 0
  let alphaKept = true
  let elsewhere = true
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (out[i * ch + ch - 1] !== s.image[i * ch + ch - 1]) alphaKept = false
    const a = s.alpha[i]
    if (a <= 0 || a >= 1) {
      for (let c = 0; c < ch; c++) if (out[i * ch + c] !== s.image[i * ch + c]) elsewhere = false
      continue
    }
    if (a < 0.1) continue
    const f = s.fg(x, y)
    for (let c = 0; c < ch - 1; c++) {
      before += Math.abs(s.image[i * ch + c] - f[c])
      after += Math.abs(out[i * ch + c] - f[c])
    }
    n += ch - 1
  }
  check(`channels ${ch}: edge colours come close to the foreground`, after / n < (before / n) * 0.25, `mean |colour − F| ${(before / n).toFixed(1)} -> ${(after / n).toFixed(1)}`)
  check(`channels ${ch}: alpha, and pixels not on the edge, left as they are`, alphaKept && elsewhere)
  const halfway = decontaminate({ ...s, alpha: s.alpha, amount: 0.5 })
  const i = (256 * W + 256 + 150) * ch
  check(`channels ${ch}: amount 0.5 goes halfway`, Math.abs(halfway[i] - (s.image[i] + out[i]) / 2) <= 1)
}

console.log('timing')
{
  const N = 1024
  const s = scene(N, N, 4, disc(512, 512, 400, 6), flatFg(rgb.fg), texturedBg(rgb.bg))
  const coverage = hardOf(s.alpha)
  for (const smart of [false, true]) {
    const t0 = performance.now()
    const band = edgeBand({ ...s, coverage, radius: 20, smart })
    const t1 = performance.now()
    const refined = refineEdge({ ...s, coverage, band })
    const t2 = performance.now()
    const t3 = performance.now()
    decontaminate({ ...s, alpha: refined, amount: 1 })
    const t4 = performance.now()
    check(
      `1024 × 1024, radius 20${smart ? ', Smart Radius' : ''}: under 1.5 s`,
      t2 - t0 < 1500,
      `band ${(t1 - t0).toFixed(0)} ms + refine ${(t2 - t1).toFixed(0)} ms = ${(t2 - t0).toFixed(0)} ms; decontaminate ${(t4 - t3).toFixed(0)} ms; error ${bandError(coverage, s.alpha, band).toFixed(4)} -> ${bandError(refined, s.alpha, band).toFixed(4)}`,
    )
  }
}

console.log(failures ? `\n${failures} failed` : '\nall clear')
process.exit(failures ? 1 : 0)
