/**
 * Quick Selection and the Magnetic Lasso, headless: a stroke grown out to a
 * disc's edge (and on a bigger window, cut small first), over-selection
 * taken back by subtracting, one of two touching objects picked out, the
 * guarantees round the stroke and the window's edge, and the live wire held
 * to a disc's outline where the straight line cuts across it. With timings.
 *
 * Run with: node scripts/run-ts.mjs check-segment
 */
import { quickSelect, type QuickSelectInput } from '../src/select/quickSelect'
import { EdgeMap, liveWire, snapToEdge, stableAnchor } from '../src/select/liveWire'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}
const pct = (v: number) => `${(v * 100).toFixed(1)}%`

/** A seeded random number generator (mulberry32), so failures repeat. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** An RGBA image, each pixel `paint(x, y)`'s colour with noise of ±`noise` per channel. */
function picture(w: number, h: number, noise: number, paint: (x: number, y: number) => [number, number, number], seed = 1): Uint8Array {
  const r = rng(seed)
  const img = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = paint(x, y)
      const o = (y * w + x) * 4
      for (let k = 0; k < 3; k++) img[o + k] = Math.min(255, Math.max(0, Math.round(c[k] + (r() * 2 - 1) * noise)))
      img[o + 3] = 255
    }
  }
  return img
}

const GRAY: [number, number, number] = [128, 128, 128]
const RED: [number, number, number] = [200, 40, 40]

/** A brush stroke of radius r along a line. */
function strokeLine(w: number, h: number, x0: number, y0: number, x1: number, y1: number, r: number): Uint8Array {
  const s = new Uint8Array(w * h)
  const dx = x1 - x0
  const dy = y1 - y0
  const l2 = dx * dx + dy * dy || 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / l2))
      const ex = x - x0 - t * dx
      const ey = y - y0 - t * dy
      if (ex * ex + ey * ey <= r * r) s[y * w + x] = 1
    }
  }
  return s
}

/** The share of `inside` pixels selected, and of the rest. */
function shares(sel: Float32Array, inside: (p: number) => boolean): [number, number] {
  let a = 0
  let an = 0
  let b = 0
  let bn = 0
  for (let p = 0; p < sel.length; p++) {
    if (inside(p)) {
      a += sel[p]
      an++
    } else {
      b += sel[p]
      bn++
    }
  }
  return [a / (an || 1), b / (bn || 1)]
}

/** Whether the result keeps the promises: superset (add) or subset (subtract), and the window's edge untouched. */
function guarantees(i: QuickSelectInput, out: Float32Array): boolean {
  const { width: w, height: h } = i
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const c = i.current[p]
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        if (out[p] !== c) return false
        continue
      }
      if (out[p] < 0 || out[p] > 1) return false
      if (i.mode === 'add' && (out[p] < c || (i.stroke[p] && out[p] !== 1))) return false
      if (i.mode === 'subtract' && (out[p] > c || (i.stroke[p] && out[p] !== 0))) return false
    }
  }
  return true
}

/** fn's result and its mean time over `runs` runs after a warm-up; with no runs, the time of the first, cold. */
function time<T>(fn: () => T, runs = 1): [T, number] {
  let t0 = performance.now()
  let r = fn()
  if (!runs) return [r, performance.now() - t0]
  t0 = performance.now()
  for (let k = 0; k < runs; k++) r = fn()
  return [r, (performance.now() - t0) / runs]
}

function disc(size: number, radius: number, noise: number, seed = 1) {
  const c = size / 2
  const inDisc = (x: number, y: number) => (x - c) ** 2 + (y - c) ** 2 <= radius * radius
  return { image: picture(size, size, noise, (x, y) => (inDisc(x + 0.5, y + 0.5) ? RED : GRAY), seed), inDisc: (p: number) => inDisc((p % size) + 0.5, Math.floor(p / size) + 0.5), c }
}

console.log('quick selection')
for (const autoEnhance of [false, true]) {
  const S = 300
  const { image, inDisc, c } = disc(S, 70, 25)
  const i: QuickSelectInput = { image, channels: 4, width: S, height: S, current: new Float32Array(S * S), stroke: strokeLine(S, S, c - 20, c, c + 20, c, 6), mode: 'add', autoEnhance }
  const [out, ms] = time(() => quickSelect(i))
  const [fg, bg] = shares(out, inDisc)
  check(`a short stroke in a red disc selects it${autoEnhance ? ' (auto-enhance)' : ''}`, fg >= 0.9 && bg < 0.03, `disc ${pct(fg)}, background ${pct(bg)}, ${ms.toFixed(1)} ms for ${S}×${S}`)
  check('  superset of selection and stroke, edge ring kept', guarantees(i, out))
  if (autoEnhance) {
    let soft = 0
    for (const v of out) if (v > 0 && v < 1) soft++
    check('  auto-enhance softens the edge', soft > 100 && soft < 2 * Math.PI * 70 * 4, `${soft} soft pixels`)
  } else check('  without auto-enhance the result is hard', out.every((v) => v === 0 || v === 1))
}
{
  // Over-selected: a disc 15 px too big. A stroke on the background ring takes the excess back.
  const S = 300
  const { image, inDisc, c } = disc(S, 70, 25, 2)
  const current = new Float32Array(S * S)
  for (let p = 0; p < S * S; p++) if (((p % S) + 0.5 - c) ** 2 + (Math.floor(p / S) + 0.5 - c) ** 2 <= 85 * 85) current[p] = 1
  const i: QuickSelectInput = { image, channels: 4, width: S, height: S, current, stroke: strokeLine(S, S, c - 8, c - 78, c + 8, c - 78, 3), mode: 'subtract', autoEnhance: false }
  const [out, ms] = time(() => quickSelect(i))
  const [fg, bg] = shares(out, inDisc)
  check('subtracting on the over-selected background takes it back', fg >= 0.97 && bg < 0.03, `disc ${pct(fg)}, background ${pct(bg)}, ${ms.toFixed(1)} ms`)
  check('  subset of selection minus stroke, edge ring kept', guarantees(i, out))
}
{
  // Two touching squares, blue and green, on gray; the stroke is on the blue one.
  const W = 320
  const H = 240
  const blue = (x: number, y: number) => x >= 60 && x < 160 && y >= 60 && y < 180
  const green = (x: number, y: number) => x >= 160 && x < 260 && y >= 60 && y < 180
  const image = picture(W, H, 20, (x, y) => (blue(x, y) ? [40, 60, 200] : green(x, y) ? [40, 180, 60] : GRAY), 3)
  const i: QuickSelectInput = { image, channels: 4, width: W, height: H, current: new Float32Array(W * H), stroke: strokeLine(W, H, 100, 120, 125, 120, 5), mode: 'add', autoEnhance: false }
  const out = quickSelect(i)
  const at = (p: number): [number, number] => [p % W, Math.floor(p / W)]
  const [b] = shares(out, (p) => blue(...at(p)))
  const [g] = shares(out, (p) => green(...at(p)))
  const [, rest] = shares(out, (p) => blue(...at(p)) || green(...at(p)))
  check('of two touching objects, the stroked one is selected', b >= 0.9 && g < 0.03 && rest < 0.03, `blue ${pct(b)}, green ${pct(g)}, background ${pct(rest)}`)
  check('  guarantees hold', guarantees(i, out))
}
{
  // Gray + alpha and CMYK + alpha images go through too.
  const S = 200
  const c = S / 2
  const inD = (x: number, y: number) => (x - c) ** 2 + (y - c) ** 2 <= 50 * 50
  const r = rng(4)
  const gray = new Uint8Array(S * S * 2)
  const cmyk = new Uint8Array(S * S * 5)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const p = y * S + x
      const n = (r() * 2 - 1) * 15
      gray[p * 2] = Math.round((inD(x, y) ? 40 : 190) + n)
      gray[p * 2 + 1] = 255
      cmyk.set(inD(x, y) ? [10, 200, 200, 0, 255] : [0, 0, 0, Math.round(120 + n), 255], p * 5)
    }
  }
  const inDisc = (p: number) => inD(p % S, Math.floor(p / S))
  for (const [name, image, channels] of [
    ['gray', gray, 2],
    ['CMYK', cmyk, 5],
  ] as const) {
    const out = quickSelect({ image, channels, width: S, height: S, current: new Float32Array(S * S), stroke: strokeLine(S, S, c - 10, c, c + 10, c, 4), mode: 'add', autoEnhance: false })
    const [fg, bg] = shares(out, inDisc)
    check(`a ${name} image`, fg >= 0.9 && bg < 0.03, `disc ${pct(fg)}, background ${pct(bg)}`)
  }
}
{
  // A window that cuts through the object: what's in the window grows to the edge, never into the background.
  const S = 300
  const big = (x: number, y: number) => (x - 330) ** 2 + (y - 150) ** 2 <= 200 * 200
  const image = picture(S, S, 25, (x, y) => (big(x + 0.5, y + 0.5) ? RED : GRAY), 9)
  const inside = (p: number) => big((p % S) + 0.5, Math.floor(p / S) + 0.5)
  const i: QuickSelectInput = { image, channels: 4, width: S, height: S, current: new Float32Array(S * S), stroke: strokeLine(S, S, 220, 150, 250, 150, 8), mode: 'add', autoEnhance: false }
  const out = quickSelect(i)
  const [fg, bg] = shares(out, inside)
  check('an object running out of the window', fg >= 0.9 && bg < 0.03, `object ${pct(fg)}, background ${pct(bg)}`)
  check('  guarantees hold', guarantees(i, out))
}
{
  const S = 512
  const { image, inDisc, c } = disc(S, 120, 25, 5)
  const i: QuickSelectInput = { image, channels: 4, width: S, height: S, current: new Float32Array(S * S), stroke: strokeLine(S, S, c - 30, c, c + 30, c, 10), mode: 'add', autoEnhance: true }
  const [out, ms] = time(() => quickSelect(i), 3)
  const [fg, bg] = shares(out, inDisc)
  check('a 512 × 512 window', fg >= 0.9 && bg < 0.03 && ms < 150, `disc ${pct(fg)}, background ${pct(bg)}, ${ms.toFixed(1)} ms`)
}
{
  const S = 1024
  const { image, inDisc, c } = disc(S, 250, 25, 6)
  const i: QuickSelectInput = { image, channels: 4, width: S, height: S, current: new Float32Array(S * S), stroke: strokeLine(S, S, c - 60, c, c + 60, c, 20), mode: 'add', autoEnhance: false }
  const [out, ms] = time(() => quickSelect(i))
  const [fg, bg] = shares(out, inDisc)
  // The edge, refined at full size: few pixels wrong beside the true circle.
  let wrong = 0
  for (let p = 0; p < S * S; p++) if ((out[p] >= 0.5) !== inDisc(p)) wrong++
  check('a 1024 × 1024 window, cut small then refined', fg >= 0.95 && bg < 0.01 && wrong < 2 * Math.PI * 250 * 1.5, `disc ${pct(fg)}, background ${pct(bg)}, ${wrong} pixels wrong, ${ms.toFixed(1)} ms`)
  check('  guarantees hold', guarantees(i, out))
}

console.log('magnetic lasso')
{
  const S = 300
  const R = 70
  const { image, c } = disc(S, R, 25, 7)
  const map = new EdgeMap(image, 4, S, S)
  const onCircle = (deg: number): [number, number] => {
    const a = (deg * Math.PI) / 180
    return [Math.round(c + R * Math.cos(a)), Math.round(c + R * Math.sin(a))]
  }
  const off = (p: [number, number]) => Math.abs(Math.hypot(p[0] + 0.5 - c, p[1] + 0.5 - c) - R)
  const snapped = snapToEdge(map, c + R - 6, c, 8)
  check('snapToEdge finds the disc edge', off(snapped) <= 1.5, `(${snapped}) is ${off(snapped).toFixed(2)} px off`)
  check('  the edge is stronger than the noise', map.strength(...snapped) > 3 * map.strength(c - R - 20, c), `${map.strength(...snapped).toFixed(2)} vs ${map.strength(c - R - 20, c).toFixed(2)}`)

  const from = snapToEdge(map, ...onCircle(200), 3)
  const to = snapToEdge(map, ...onCircle(290), 3)
  const [path, cold] = time(() => liveWire(new EdgeMap(image, 4, S, S), from, to, { width: 30, contrast: 0.1 }), 0)
  const [, warm] = time(() => liveWire(map, from, to, { width: 30, contrast: 0.1 }), 20)
  const mean = path.reduce((s, p) => s + off(p), 0) / path.length
  const ends = path[0][0] === from[0] && path[0][1] === from[1] && path[path.length - 1][0] === to[0] && path[path.length - 1][1] === to[1]
  let joined = true
  for (let k = 1; k < path.length; k++) if (Math.max(Math.abs(path[k][0] - path[k - 1][0]), Math.abs(path[k][1] - path[k - 1][1])) !== 1) joined = false
  check('the wire across a 90° arc keeps to the edge', mean < 1.5 && ends && joined, `mean ${mean.toFixed(2)} px off the circle over ${path.length} px; ${cold.toFixed(1)} ms cold, ${warm.toFixed(2)} ms warm`)
  // The straight line between them would be up to R(1 − cos 45°) ≈ 20 px inside.
  const mid = path[path.length >> 1]
  check('  where the straight line cuts across the disc', off(mid) < 2, `mid-path ${off(mid).toFixed(2)} px off`)
  const flat = liveWire(map, from, to, { width: 30, contrast: 1.01 })
  const straight = (p: [number, number]) => Math.abs((to[0] - from[0]) * (from[1] - p[1]) - (from[0] - p[0]) * (to[1] - from[1])) / Math.hypot(to[0] - from[0], to[1] - from[1])
  const flatMean = flat.reduce((s, p) => s + straight(p), 0) / flat.length
  check('  above every edge’s contrast, the wire runs straight', flatMean < 1.5, `mean ${flatMean.toFixed(2)} px off the line`)

  const n = stableAnchor(path, 100)
  check('stableAnchor fixes one about every 10 px at frequency 100', n >= 7 && n <= 10, `index ${n}`)
  check('  and none on a short path at frequency 0', stableAnchor(path.slice(0, 50), 0) === -1)
  const moved = path.slice(0, 5).concat(path.slice(5).map(([x, y]) => [x + 1, y] as [number, number]))
  check('  and only on the stretch that held still', stableAnchor(path, 100, moved) === -1)
}
{
  // A ~300 px wire, Photoshop's widest usual corridor.
  const S = 800
  const R = 300
  const { image, c } = disc(S, R, 25, 8)
  const map = new EdgeMap(image, 4, S, S)
  const at = (deg: number): [number, number] => {
    const a = (deg * Math.PI) / 180
    return snapToEdge(map, c + R * Math.cos(a), c + R * Math.sin(a), 3)
  }
  const from = at(190)
  const to = at(245)
  const [path, cold] = time(() => liveWire(new EdgeMap(image, 4, S, S), from, to, { width: 40, contrast: 0.1 }), 0)
  const [, warm] = time(() => liveWire(map, from, to, { width: 40, contrast: 0.1 }), 20)
  const mean = path.reduce((s, p) => s + Math.abs(Math.hypot(p[0] + 0.5 - c, p[1] + 0.5 - c) - R), 0) / path.length
  check(`a ${Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]))} px segment, width 40`, mean < 1.5 && warm < 10, `mean ${mean.toFixed(2)} px off; ${cold.toFixed(1)} ms cold, ${warm.toFixed(2)} ms warm`)
}

console.log(failures ? `\n${failures} failed` : '\nall clear')
process.exit(failures ? 1 : 0)
