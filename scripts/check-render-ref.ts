/**
 * The render graph's CPU references, against formulas and known values:
 * every blend mode, the compositing operations, dissolve, the resampling
 * filters, the working space and the mip reduction, and the view maths.
 *
 * These are what check-gpu holds the GPU to, so they are held here to
 * Photoshop's definitions: neutral colours that change nothing, modes that
 * commute, known results, and the cases every editor agrees on.
 *
 * Run with: npm run check:render-ref
 */
import { BLEND_MODES, type BlendModeId, type ColourMode } from '../src/doc/types'
import { BLEND_DEFS, BLEND_BY_ID, blendIndex } from '../src/render/blendModes'
import { SEPARABLE, blendColour } from '../src/render/ref/blend'
import { apply, atop, clear, dissolve, dissolveThreshold, knock, lerp, over, type Px } from '../src/render/ref/composite'
import { FILTERS, cubic, lanczos3, sample, weights } from '../src/render/ref/resample'
import { fromWorking, reduce, toWorking } from '../src/render/ref/working'
import { Scene, transformRect, type Extent } from '../src/render/scene'
import { makeNode } from '../src/doc/nodes'
import type { DocNode } from '../src/doc/types'
import {
  apply as applyM,
  convexOverlap,
  docPoint,
  fitView,
  invert,
  mipLevel,
  panBy,
  stepZoom,
  tileRect,
  viewMatrix,
  viewQuad,
  visibleTiles,
  foldedTiles,
  zoomAt,
  paneAt,
  paneCanvas,
  paneMatrix,
  paneRects,
  type Canvas,
  type View,
} from '../src/render/view'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}
let seed = 7
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps
const nearAll = (a: number[], b: number[], eps = 1e-9) => a.length === b.length && a.every((v, i) => near(v, b[i], eps))
const nearPx = (a: Px, b: Px, eps = 1e-9) => near(a.a, b.a, eps) && nearAll(a.c, b.c, eps)
const randColour = (n: number) => Array.from({ length: n }, rand)
const randPx = (n: number): Px => {
  const a = rand()
  return { c: randColour(n).map((v) => v * a), a }
}
const fmt = (v: number[]) => v.map((x) => x.toFixed(4)).join(',')
const LAYER_MODES = BLEND_MODES.filter((m) => m !== 'pass-through')

// --- the registry ---------------------------------------------------------------
console.log('\nthe registry')
check('every blend mode has a definition, with a label', BLEND_MODES.every((m) => BLEND_BY_ID.get(m)?.label))
check('Linear Dodge is labelled as Photoshop labels it', BLEND_BY_ID.get('linear-dodge')!.label === 'Linear Dodge (Add)')
const nonSep = ['darker-color', 'lighter-color', 'hue', 'saturation', 'color', 'luminosity', 'pass-through']
check(
  'every separable mode has WGSL and a CPU reference; the rest are the whole-colour ones',
  BLEND_DEFS.every((d) => (nonSep.includes(d.id) ? !d.wgsl && !SEPARABLE[d.id] : !!d.wgsl && !!SEPARABLE[d.id])),
)
check('a mode’s index is its place in the list, which is what the kernel receives', BLEND_MODES.every((m, i) => blendIndex(m) === i))

// --- separable modes ---------------------------------------------------------------
console.log('\nblend modes')
const B = (m: BlendModeId, b: number, s: number) => blendColour(m, [b], [s])[0]
check('Multiply: 0.5 × 0.5 is 0.25', near(B('multiply', 0.5, 0.5), 0.25))
check('Screen: 0.5 and 0.5 is 0.75', near(B('screen', 0.5, 0.5), 0.75))
check('Linear Burn bottoms out at black', B('linear-burn', 0.3, 0.4) === 0 && near(B('linear-burn', 0.8, 0.5), 0.3))
check('Linear Dodge (Add) tops out at white', B('linear-dodge', 0.7, 0.6) === 1 && near(B('linear-dodge', 0.2, 0.3), 0.5))
check('Subtract and Divide', near(B('subtract', 0.7, 0.2), 0.5) && near(B('divide', 0.25, 0.5), 0.5) && B('divide', 0.25, 0) === 1 && B('divide', 0, 0) === 0)
check('Color Dodge: black stays black, a white source makes white', B('color-dodge', 0, 1) === 0 && B('color-dodge', 0.2, 1) === 1 && near(B('color-dodge', 0.25, 0.5), 0.5))
check('Color Burn: white stays white, a black source makes black', B('color-burn', 1, 0) === 1 && B('color-burn', 0.8, 0) === 0 && near(B('color-burn', 0.75, 0.5), 0.5))
check('Hard Mix is black or white', B('hard-mix', 0.4, 0.7) === 1 && B('hard-mix', 0.4, 0.5) === 0)
check('Difference of a colour with itself is black', [0, 0.3, 0.77, 1].every((v) => B('difference', v, v) === 0))
check('Exclusion of grey with anything is grey', [0, 0.3, 1].every((v) => near(B('exclusion', v, 0.5), 0.5)))
check('Pin Light: dark sources darken, light ones lighten', B('pin-light', 0.8, 0.2) === 0.4 && B('pin-light', 0.2, 0.8) === 0.6000000000000001)
check('Soft Light is Photoshop’s: a light source on 0.25 gives 0.25 + (2s − 1)(√b − b)', near(B('soft-light', 0.25, 0.75), 0.25 + 0.5 * (0.5 - 0.25)))

// Neutral colours: the source that changes nothing, whatever the backdrop.
const NEUTRAL: [BlendModeId, number][] = [
  ['multiply', 1], ['darken', 1], ['color-burn', 1], ['linear-burn', 1],
  ['screen', 0], ['lighten', 0], ['color-dodge', 0], ['linear-dodge', 0], ['subtract', 0], ['difference', 0], ['exclusion', 0],
  ['overlay', 0.5], ['soft-light', 0.5], ['hard-light', 0.5], ['vivid-light', 0.5], ['linear-light', 0.5], ['pin-light', 0.5], ['divide', 1],
]
for (const [m, n] of NEUTRAL) {
  const bs = Array.from({ length: 50 }, rand)
  check(`${BLEND_BY_ID.get(m)!.label}: a source of ${n} leaves the backdrop as it was`, bs.every((b) => near(B(m, b, n), b, 1e-12)))
}
for (const m of ['multiply', 'screen', 'darken', 'lighten', 'difference', 'exclusion', 'linear-dodge', 'linear-burn'] as BlendModeId[]) {
  const pairs = Array.from({ length: 50 }, () => [rand(), rand()])
  check(`${BLEND_BY_ID.get(m)!.label} doesn’t care which is on top`, pairs.every(([a, b]) => near(B(m, a, b), B(m, b, a), 1e-12)))
}
check('Overlay is Hard Light with the layers swapped', Array.from({ length: 50 }, () => [rand(), rand()]).every(([b, s]) => near(B('overlay', b, s), B('hard-light', s, b))))
{
  let inRange = true
  for (const m of LAYER_MODES) for (let i = 0; i < 200; i++) for (const n of [1, 3, 4]) if (blendColour(m, randColour(n), randColour(n)).some((v) => !(v >= -1e-12 && v <= 1 + 1e-12))) inRange = false
  check('every mode keeps every channel within 0..1, in Gray, RGB and CMYK', inRange)
}
{
  const b = [0.2, 0.5, 0.9]
  const s = [0.8, 0.1, 0.3]
  const lum = (c: number[]) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
  check('Luminosity takes the source’s luminance', near(lum(blendColour('luminosity', b, s)), lum(s), 1e-9))
  check('Color keeps the backdrop’s luminance', near(lum(blendColour('color', b, s)), lum(b), 1e-9))
  check('Hue and Saturation keep the backdrop’s luminance too', near(lum(blendColour('hue', b, s)), lum(b), 1e-9) && near(lum(blendColour('saturation', b, s)), lum(b), 1e-9))
  check('Hue on a grey backdrop gives grey', (() => {
    const r = blendColour('hue', [0.4, 0.4, 0.4], s)
    return near(r[0], r[1]) && near(r[1], r[2])
  })())
  check('Darker Color picks one whole colour', fmt(blendColour('darker-color', b, s)) === fmt(s) && fmt(blendColour('lighter-color', b, s)) === fmt(b))
  check('in Gray, Luminosity takes the source and Hue, Saturation and Color keep the backdrop', blendColour('luminosity', [0.2], [0.7])[0] === 0.7 && ['hue', 'saturation', 'color'].every((m) => blendColour(m as BlendModeId, [0.2], [0.7])[0] === 0.2))
  const ck = blendColour('luminosity', [0.2, 0.5, 0.9, 0.3], [0.8, 0.1, 0.3, 0.6])
  check('in CMYK, Luminosity takes the source’s black and Color keeps the backdrop’s', ck[3] === 0.6 && blendColour('color', [0.2, 0.5, 0.9, 0.3], [0.8, 0.1, 0.3, 0.6])[3] === 0.3)
}

// --- compositing ------------------------------------------------------------------------
console.log('\ncompositing')
{
  const n = 3
  const dst = randPx(n)
  const opaque: Px = { c: [0.2, 0.4, 0.6], a: 1 }
  check('an opaque Normal layer replaces what’s below', nearPx(over(dst, opaque, 'normal', 1), opaque))
  check('at 0% opacity it changes nothing', nearPx(over(dst, opaque, 'multiply', 0), dst))
  let blind = true
  for (const m of LAYER_MODES) {
    const s = randPx(n)
    if (!nearPx(over(clear(n), s, m, 0.7), { c: s.c.map((v) => v * 0.7), a: s.a * 0.7 }, 1e-12)) blind = false
  }
  check('over transparency, every blend mode is Normal', blind)
  let alphaOk = true
  for (let i = 0; i < 100; i++) {
    const d = randPx(n)
    const s = randPx(n)
    const k = rand()
    if (!near(over(d, s, 'screen', k).a, s.a * k + d.a * (1 - s.a * k), 1e-12)) alphaOk = false
  }
  check('alpha is αs + αb(1 − αs) whatever the mode', alphaOk)
  const half: Px = { c: [0.5, 0.25, 0.125], a: 0.5 }
  const r = over({ c: [0, 0, 1], a: 1 }, half, 'normal', 1)
  check('a half-transparent layer mixes half and half', nearPx(r, { c: [0.5, 0.25, 0.625], a: 1 }), fmt([...r.c, r.a]))

  const base: Px = { c: [0.5, 0, 0], a: 0.5 }
  const clipped = atop(base, { c: [0, 0, 1], a: 1 }, 'normal', 1)
  check('a clipped layer keeps the base’s alpha and takes its colour within it', nearPx(clipped, { c: [0, 0, 0.5], a: 0.5 }), fmt([...clipped.c, clipped.a]))
  check('a clipped layer over nothing shows nothing', nearPx(atop(clear(3), opaque, 'normal', 1), clear(3)))
  check('a clipped Multiply-white layer changes nothing, even where the base is half there', nearPx(atop(base, { c: [1, 1, 1], a: 1 }, 'multiply', 1), base))

  const a = randPx(n)
  const b = randPx(n)
  check('lerp is the backdrop at 0 and the source at 1', nearPx(lerp(a, b, 0), a) && nearPx(lerp(a, b, 1), b))

  const kb = randPx(n)
  check('a knockout layer at 0% fill punches through to the knockout backdrop', nearPx(knock(dst, opaque, kb, 'normal', 0), kb))
  check('an opaque one at 100% is just itself', nearPx(knock(dst, opaque, kb, 'normal', 1), opaque))
  let same = true
  for (let i = 0; i < 100; i++) {
    const s = randPx(n)
    const k = rand()
    if (!nearPx(knock(kb, s, kb, 'normal', k), over(kb, s, 'normal', k), 1e-12)) same = false
  }
  check('a knockout layer over its own backdrop is the same as laying it on normally', same)
  check('apply() runs each operation by name', nearPx(apply('over', dst, opaque, 'normal', 1), opaque) && nearPx(apply('lerp', a, b, 'normal', 1), b))

  const ts = Array.from({ length: 4096 }, (_, i) => dissolveThreshold(i % 64, Math.floor(i / 64), 3))
  const mean = ts.reduce((x, y) => x + y, 0) / ts.length
  check('dissolve’s thresholds are spread evenly over 0..1', mean > 0.47 && mean < 0.53 && Math.min(...ts) >= 0 && Math.max(...ts) < 1, mean.toFixed(3))
  check('and are the same every time for the same pixel and seed, but not for another seed', dissolveThreshold(10, 20, 3) === dissolveThreshold(10, 20, 3) && dissolveThreshold(10, 20, 3) !== dissolveThreshold(10, 20, 4))
  const kept = ts.filter((t) => dissolve({ c: [0.3], a: 0.3 }, 1, 0, 0, 0) && t < 0.3).length / ts.length
  check('a 30% Dissolve layer keeps about 30% of its pixels, each fully opaque', kept > 0.27 && kept < 0.33 && (() => {
    const d = dissolve({ c: [0.3, 0.15, 0], a: 0.5 }, 1, 0, 0, 0)
    return d.px.a === 0 || (d.px.a === 1 && nearAll(d.px.c, [0.6, 0.3, 0]))
  })(), kept.toFixed(3))
}

// --- resampling ------------------------------------------------------------------------
console.log('\nresampling')
{
  check('the cubic and Lanczos kernels are 1 at 0 and 0 at every other whole number', [1, 2, 3].every((i) => near(cubic(i), 0) && near(lanczos3(i), 0)) && cubic(0) === 1 && lanczos3(0) === 1)
  const filters = FILTERS.filter((f) => f !== 'nearest') as ('bilinear' | 'bicubic' | 'lanczos')[]
  check('every filter’s weights sum to 1', filters.every((f) => [0.1, 0.5, 0.73, 3.99].every((p) => near(weights(f, p).w.reduce((a, b) => a + b, 0), 1, 1e-12))))
  const W = 16
  const img = Array.from({ length: W * W }, () => ({ c: [rand(), rand(), rand()], a: 1 })).map((p) => ({ c: p.c.map((v) => v * 0.8), a: 0.8 }))
  const texel = (x: number, y: number): Px => (x < 0 || y < 0 || x >= W || y >= W ? clear(3) : img[y * W + x])
  let exact = true
  for (const f of FILTERS) for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (!nearPx(sample(texel, x + 0.5, y + 0.5, f, 3), img[y * W + x], 1e-12)) exact = false
  check('at pixel centres every filter returns the source exactly', exact)
  const mid = sample(texel, 2, 3.5, 'bilinear', 3)
  const avg = { c: img[3 * W + 1].c.map((v, i) => (v + img[3 * W + 2].c[i]) / 2), a: 0.8 }
  check('bilinear halfway between two pixels is their average', nearPx(mid, avg, 1e-12))
  const edge = (x: number, _y: number): Px => (x < 4 ? { c: [1, 1, 1], a: 1 } : { c: [0, 0, 0], a: 0 })
  let valid = true
  for (const f of filters) for (let x = 1; x < 8; x += 0.25) {
    const p = sample(edge, x, 2.5, f, 3)
    if (p.a < 0 || p.a > 1 || p.c.some((v) => v < 0 || v > p.a + 1e-15)) valid = false
  }
  check('at a hard edge the overshoot of bicubic and Lanczos is clamped to a valid pixel', valid)
}

// --- the working space and mips -----------------------------------------------------------------
console.log('\nworking space')
{
  const modes: [ColourMode, number][] = [['rgb', 3], ['gray', 1], ['cmyk', 4]]
  let round = true
  for (const [m, n] of modes) for (let i = 0; i < 100; i++) {
    const v = [...randColour(n), 0.05 + rand() * 0.95]
    if (!nearAll(fromWorking(m, toWorking(m, v)), v, 1e-12)) round = false
  }
  check('samples go into the working space and back unchanged, in every mode', round)
  const w = toWorking('cmyk', [1, 0, 0.25, 0, 0.5])
  check('CMYK becomes light, premultiplied: full cyan at 50% is 0 light in that channel', nearAll(w.c, [0, 0.5, 0.375, 0.5]) && w.a === 0.5)
  const m = reduce([[1, 0, 0, 1], [1, 0, 0, 1], [0, 0, 0, 0], [0, 0, 0, 0]])
  check('a mip pixel half over transparency keeps its colour and halves its alpha', nearAll(m, [1, 0, 0, 0.5]))
  check('four transparent pixels reduce to transparent', nearAll(reduce([[0.3, 0], [0.7, 0], [0.1, 0], [0.9, 0]]), [0, 0]))
}

// --- the view -------------------------------------------------------------------------------------
console.log('\nthe view')
{
  const c: Canvas = { width: 1600, height: 1000, dpr: 2 }
  const v: View = { cx: 500, cy: 300, zoom: 1, rotation: 0 }
  const m = viewMatrix(v, c)
  const [x, y] = applyM(m, 500, 300)
  check('the view’s centre is the canvas’s centre', x === 800 && y === 500)
  check('at 100% one document pixel is dpr device pixels', near(applyM(m, 501, 300)[0] - x, 2))
  const [x2, y2] = applyM(viewMatrix({ ...v, cx: 500.3, cy: 300.7 }, c), 0, 0)
  check('unrotated, document pixels land on whole device pixels', Number.isInteger(x2) && Number.isInteger(y2))
  const r: View = { ...v, rotation: 30, zoom: 0.37 }
  const [px, py] = docPoint(r, c, 123, 456)
  const [bx, by] = applyM(viewMatrix(r, c), px, py)
  check('device to document and back is exact', near(bx, 123, 1e-9) && near(by, 456, 1e-9))
  const inv = invert(viewMatrix(r, c))
  const id = viewMatrix(r, c)
  check('the inverse matrix is one', near(applyM(id, ...applyM(inv, 10, 20))[0], 10, 1e-9))
  const r90 = viewMatrix({ ...v, rotation: 90 }, c)
  check('rotating 90° turns the document’s x axis down the screen', near(r90[0], 0, 1e-12) && near(r90[1], 2, 1e-12))
  const z = zoomAt(r, c, 2.5, 300, 200)
  const before = docPoint(r, c, 300, 200)
  const after = docPoint(z, c, 300, 200)
  check('zooming at a point keeps the document point under it', near(before[0], after[0], 1e-6) && near(before[1], after[1], 1e-6))
  const p = panBy(r, c, 40, -25)
  const d0 = docPoint(r, c, 100, 100)
  const d1 = docPoint(p, c, 140, 75)
  check('panning moves the document with the pointer, rotated or not', near(d0[0], d1[0], 1e-6) && near(d0[1], d1[1], 1e-6))
  const fit = fitView(4000, 3000, c)
  const corner = applyM(viewMatrix(fit, c), 4000, 3000)
  check('Fit puts the document within the margin, centred', near(fit.zoom, (500 - 64) / 3000 * 1, 1e-9) && corner[1] <= 1000 - 64 + 1, `${fit.zoom}`)
  check('a small document opens at 100%, not blown up', fitView(100, 100, c).zoom === 1 && fitView(100, 100, c, 32, false).zoom > 1)
  check('zoom steps go 100% → 200% and 100% → 66.67%', stepZoom(1, 1) === 2 && stepZoom(1, -1) === 0.6667 && stepZoom(0.7, -1) === 0.6667)
  check('the mip level halves with the zoom, in device pixels', mipLevel(1, 1) === 0 && mipLevel(0.5, 1) === 1 && mipLevel(0.49, 1) === 1 && mipLevel(0.24, 1) === 2 && mipLevel(0.5, 2) === 0 && mipLevel(0.7, 1) === 0)
  check('tile rectangles double with each level', tileRect(2, 1, 0).join() === '1024,0,2048,1024')

  const fitTiles = visibleTiles(fit, c, mipLevel(fit.zoom, c.dpr), 4000, 3000)
  const L = mipLevel(fit.zoom, c.dpr)
  const span = 256 * 2 ** L
  check('a fitted document needs every one of its tiles at that level', fitTiles.length === Math.ceil(4000 / span) * Math.ceil(3000 / span), `${fitTiles.length} at level ${L}`)
  const rot: View = { cx: 2000, cy: 1500, zoom: 0.5, rotation: 37 }
  const tiles = visibleTiles(rot, c, 1, 4000, 3000)
  const set = new Set(tiles.map(([a, b]) => `${a},${b}`))
  let covered = true
  for (let i = 0; i < 400; i++) {
    const [qx, qy] = docPoint(rot, c, rand() * c.width, rand() * c.height)
    if (qx < 0 || qy < 0 || qx >= 4000 || qy >= 3000) continue
    if (!set.has(`${Math.floor(qx / 512)},${Math.floor(qy / 512)}`)) covered = false
  }
  check('rotated, every document point on screen is in a visible tile', covered, `${tiles.length} tiles`)
  check('and tiles wholly off screen in the corners are left out', tiles.length < Math.ceil(4000 / 512) * Math.ceil(3000 / 512))
  const d = tiles.map(([a, b]) => ((a + 0.5) * 512 - 2000) ** 2 + ((b + 0.5) * 512 - 1500) ** 2)
  check('the centre’s tiles come first', d.every((v, i) => i === 0 || v >= d[i - 1]))
  check('the separating axis test sees overlap and its absence', convexOverlap([[0, 0], [2, 0], [2, 2], [0, 2]], [[1, 1], [3, 1], [3, 3]]) && !convexOverlap([[0, 0], [1, 0], [1, 1], [0, 1]], [[2, 2], [3, 2], [3, 3]]))
  check('the view’s quad has the canvas’s corners', viewQuad(v, c).length === 4)
}

// --- the scene ----------------------------------------------------------------------------------
console.log('\nthe scene')
{
  const extents: Record<string, Extent> = { s1: { x0: 0, y0: 0, x1: 1, y1: 0 }, s2: { x0: 2, y0: 2, x1: 2, y1: 2 }, empty: null }
  const scene = new Scene('d', (id) => extents[id] ?? null)
  const doc = { width: 1000, height: 1000, mode: 'rgb' as const, depth: 8 as const, profile: { builtin: 'srgb' }, root: 'root', selection: null as string | null }
  const root = makeNode('group', 'root')
  const a = makeNode('pixel', 'a', 'A', { tiles: 's1' })
  const b = makeNode('pixel', 'b', 'B', { tiles: 's2' })
  const g = makeNode('group', 'g', 'G')
  const c = makeNode('pixel', 'c', 'C', { tiles: 's2' })
  c.transform = [1, 0, 0, 1, -300, 0]
  g.children = ['c']
  root.children = ['a', 'b', 'g']
  let ver = 1
  const up = (nodes: DocNode[], o: { removed?: string[]; reset?: boolean; doc?: typeof doc | (Omit<typeof doc, 'profile' | 'width'> & { width: number; profile: { builtin: string } }) } = {}) =>
    scene.apply({ doc: o.doc ?? doc, nodes: nodes.map((node) => ({ node, version: ver++ })), removed: o.removed ?? [], reset: o.reset ?? false })
  check('the first scene changes everything', up([root, a, b, g, c], { reset: true }).dirty === 'all')
  check('a pixel layer covers its tiles', JSON.stringify(scene.bounds('a')) === JSON.stringify([0, 0, 512, 256]))
  check('through its transform', JSON.stringify(scene.bounds('c')) === JSON.stringify([212, 512, 468, 768]))
  check('a group covers its children', JSON.stringify(scene.bounds('g')) === JSON.stringify(scene.bounds('c')))
  const vRoot = scene.contentVersion('root')
  const vA = scene.contentVersion('a')
  const b2 = { ...b, opacity: 0.5 }
  const r1 = up([b2])
  check('changing a layer’s opacity dirties exactly that layer', r1.dirty !== 'all' && r1.dirty.length === 2 && r1.dirty.every((r) => r.join() === '512,512,768,768'), JSON.stringify(r1.dirty))
  check('and changes the content version of it and its ancestors, not its siblings', scene.contentVersion('root') !== vRoot && scene.contentVersion('a') === vA)
  const a2 = { ...a, transform: [1, 0, 0, 1, 100, 100] as DocNode['transform'] }
  const r2 = up([a2])
  check('moving a layer dirties where it was and where it went', r2.dirty !== 'all' && r2.dirty.map((r) => r.join()).sort().join(' ') === '0,0,512,256 100,100,612,356', JSON.stringify(r2.dirty))
  const root2 = { ...root, children: ['b', 'a', 'g'] }
  const r3 = up([root2])
  check('reordering dirties only the layers that moved', r3.dirty !== 'all' && r3.dirty.length === 4 && !r3.dirty.some((r) => r.join() === '212,512,468,768'), JSON.stringify(r3.dirty))
  const c2 = { ...c, visible: false }
  const r4 = up([c2])
  check('hiding a layer dirties where it was', r4.dirty !== 'all' && r4.dirty.some((r) => r.join() === '212,512,468,768'), JSON.stringify(r4.dirty))
  check('a hidden layer covers nothing', scene.bounds('c') === null && scene.bounds('g') === null)
  const g2 = { ...g, children: [] }
  const r5 = up([g2], { removed: ['c'] })
  check('removing a layer dirties where it was', r5.dirty !== 'all' && r5.dirty.some((r) => r.join() === '212,512,468,768'), JSON.stringify(r5.dirty))
  const clipped = makeNode('pixel', 'k', 'K', { tiles: 's1' })
  clipped.transform = [1, 0, 0, 1, 400, 500]
  const b3 = { ...b2, children: ['k'] }
  const r6 = up([b3, clipped])
  check('a layer clipped to another dirties no more than its base covers', r6.dirty !== 'all' && r6.dirty.length > 0 && r6.dirty.every((r) => r[0] >= 512 && r[1] >= 512 && r[2] <= 768 && r[3] <= 768), JSON.stringify(r6.dirty))
  check('a canvas size change changes everything', up([], { doc: { ...doc, width: 1200 } }).dirty === 'all')
  const r7 = up([], { doc: { ...doc, width: 1200, profile: { builtin: 'display-p3' } } })
  check('a profile change is a change of colour, not of pixels', r7.colour && r7.dirty !== 'all' && r7.dirty.length === 0)
  check('rectangles through an affine are bounded', transformRect([0, 1, -1, 0, 0, 0], [0, 0, 10, 20]).join() === '-20,0,0,10')
}

// --- split view's panes ----------------------------------------------------------------------
console.log('\nsplit view’s panes')
{
  const c: Canvas = { width: 1001, height: 600, dpr: 2 }
  const one = paneRects(c, null)
  check('one pane is the whole canvas', one.length === 1 && one[0].x === 0 && one[0].width === 1001)
  const two = paneRects(c, 0.5)
  check('two side by side, a gap of two CSS pixels between, filling the width', two.length === 2 && two[1].x - (two[0].x + two[0].width) === 4 && two[1].x + two[1].width === 1001, JSON.stringify(two))
  check('which pane a point is over, the nearer in the gap', paneAt(two, 10) === 0 && paneAt(two, 990) === 1 && paneAt(two, two[0].width + 1) === 0 && paneAt(two, two[1].x - 1) === 1)
  const v: View = { cx: 300, cy: 200, zoom: 1.5, rotation: 30 }
  const m = paneMatrix(v, c, two[1])
  const local = viewMatrix(v, paneCanvas(c, two[1]))
  check('a pane’s matrix is its own view moved to where the pane starts', m.slice(0, 4).join() === local.slice(0, 4).join() && m[4] === local[4] + two[1].x && m[5] === local[5])
  const centre = [m[0] * v.cx + m[2] * v.cy + m[4], m[1] * v.cx + m[3] * v.cy + m[5]]
  check('the view’s centre lands in the middle of its pane', Math.abs(centre[0] - (two[1].x + two[1].width / 2)) < 1e-6 && Math.abs(centre[1] - 300) < 1e-6, centre.join())
}

console.log('\ntiled view')
{
  check('without wrapping, columns are clamped to the document', foldedTiles(-300, 400, 1000, 256, false).join() === '0,1')
  check('wrapping, a span past the left edge folds to the right end', foldedTiles(-100, 100, 1000, 256, true).sort((a, b) => a - b).join() === '0,3')
  check('a span a period long or more needs every column', foldedTiles(-10, 1000, 1000, 256, true).length === 4)
  check('in a copy far off, the same columns as in the document', foldedTiles(5000 + 300, 5000 + 400, 1000, 256, true).join() === foldedTiles(300, 400, 1000, 256, true).join())
  const v: View = { cx: 0, cy: 0, zoom: 1, rotation: 0 }
  const c: Canvas = { width: 400, height: 400, dpr: 1 }
  const plain = visibleTiles(v, c, 0, 1000, 1000)
  const wrapped = visibleTiles(v, c, 0, 1000, 1000, { x: true, y: true })
  check('a view on the corner of a tiled document needs the tiles at every corner', plain.length === 1 && wrapped.length === 4 && wrapped.some(([x, y]) => x === 3 && y === 3), JSON.stringify(wrapped))
  check('nearest the centre first, round the torus', JSON.stringify(wrapped[0]) === JSON.stringify([0, 0]) || JSON.stringify(wrapped[0]) === JSON.stringify([3, 3]))
}

console.log(failures ? `\nFAIL (${failures})` : '\nPASS')
process.exit(failures ? 1 : 0)
