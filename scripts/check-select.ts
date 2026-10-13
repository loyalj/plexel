/**
 * Selections as coverage: shapes, combining, inverse, feather, expand and
 * contract, Select and Mask's refinements, the magic wand, and filling and
 * clearing a layer through a selection. All on the CPU, as the engine
 * worker runs them.
 *
 * Run with: npm run check:select
 */
import { TILE, TILE_PIXELS, newSamples, type TileFormat } from '../src/tiles/format'
import { memorySpill } from '../src/tiles/spill'
import { TileStore, type SetId } from '../src/tiles/store'
import {
  COVER,
  CoverReader,
  applyMask,
  exactBounds,
  offset,
  combine,
  coverBounds,
  ellipsePoints,
  feather,
  gaussBoxes,
  grow,
  invert,
  rasterizePolygon,
  refine,
  selectAll,
  throughCover,
  wand,
  colourRange,
  hitsToSet,
  pasteWindow,
  similarHits,
  transformCover,
  valuesToSet,
} from '../src/tiles/coverage'
import { fillLayer } from '../src/tiles/fill'
import { over, atop } from '../src/render/ref/composite'
import { toWorking, fromWorking } from '../src/render/ref/working'
import { gradientAnchor, paintAt, paintParams, wrapPoint } from '../src/vector/paint'
import { nearestCopy } from '../src/app/tiling'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol

const store = new TileStore({ budget: 1e9, spill: memorySpill(), shared: false })
const W = 1000
const H = 800

/** How many pixels a set covers, counting partial coverage. */
async function area(set: SetId): Promise<number> {
  const r = new CoverReader(store, set)
  let sum = 0
  for (const k of store.getSet(set).tiles.keys()) {
    const [x, y] = k.split(',').map(Number)
    const t = await r.tile(x, y)
    if (typeof t === 'number') sum += t * TILE_PIXELS
    else for (let i = 0; i < TILE_PIXELS; i++) sum += t[i]
  }
  return sum
}
const at = (set: SetId, x: number, y: number) => new CoverReader(store, set).at(x, y)
const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
]

console.log('shapes')
{
  const r = rasterizePolygon(store, rect(100, 50, 400, 300), W, H)
  check('a rectangle covers its area exactly', (await area(r)) === 300 * 250, String(await area(r)))
  check('inside is covered, outside not', (await at(r, 200, 200)) === 1 && (await at(r, 99, 200)) === 0 && (await at(r, 400, 200)) === 0)
  const half = rasterizePolygon(store, rect(10.5, 10, 20, 20), W, H)
  check('a half-covered pixel is half selected', near(await at(half, 10, 15), 0.5, 0.003), String(await at(half, 10, 15)))
  const hard = rasterizePolygon(store, rect(10.5, 10.25, 20, 20), W, H, false)
  const hv = await at(hard, 10, 15)
  check('without anti-aliasing, coverage is all or nothing', hv === 0 || hv === 1)
  const big = rasterizePolygon(store, rect(0, 0, 768, 512), W, H)
  const uniform = [...store.getSet(big).tiles.values()].filter((t) => store.isUniform(t)).length
  check('whole tiles inside a shape cost no pixels', uniform === 6, `${uniform} uniform tiles`)

  const e = rasterizePolygon(store, ellipsePoints(500, 400, 300, 200), W, H)
  const ea = await area(e)
  check('an ellipse covers πab', near(ea, Math.PI * 300 * 200, Math.PI * 300 * 200 * 0.001), `${ea.toFixed(0)} vs ${(Math.PI * 60000).toFixed(0)}`)
  const clipped = rasterizePolygon(store, rect(-100, -100, 50, 50), W, H)
  check('shapes are clipped to the canvas', (await area(clipped)) === 50 * 50)
  const off = rasterizePolygon(store, rect(1200, 900, 1300, 1000), W, H)
  check('a shape off the canvas selects nothing', store.getSet(off).tiles.size === 0)
  // A bow tie: two triangles meeting at a point; a figure eight leaves its crossing out.
  const bow = rasterizePolygon(store, [[100, 100], [300, 300], [300, 100], [100, 300]], W, H)
  check('a lasso crossing itself fills each loop', near(await area(bow), 20000, 20), String(await area(bow)))
  const star = rasterizePolygon(store, [[200, 100], [260, 300], [100, 180], [300, 180], [140, 300]], W, H)
  check('the middle of a five-point star is left out (even-odd)', (await at(star, 200, 200)) === 0 && (await at(star, 200, 130)) === 1)
}

console.log('whole selections')
{
  const all = selectAll(store, 600, 300)
  check('Select All covers the canvas and no more', (await area(all)) === 600 * 300 && (await at(all, 599, 299)) === 1 && (await at(all, 600, 0)) === 0)
  const inv = await invert(store, rasterizePolygon(store, rect(100, 100, 200, 200), W, H), W, H)
  check('Inverse covers the rest of the canvas', (await area(inv)) === W * H - 10000, String(await area(inv)))
  const back = await invert(store, inv, W, H)
  check('Inverse twice is the selection again', (await area(back)) === 10000 && (await at(back, 150, 150)) === 1)
  const none = await invert(store, null, W, H)
  check('Inverse of nothing is everything', (await area(none)) === W * H)
  const huge = selectAll(store, 100000, 100000)
  check('selecting a 10-gigapixel canvas costs a few tiles of pixels', [...store.getSet(huge).tiles.values()].filter((t) => !store.isUniform(t)).length === 391 + 391 - 1)

  const a = rasterizePolygon(store, rect(100, 100, 300, 300), W, H)
  const b = rasterizePolygon(store, rect(200, 200, 400, 400), W, H)
  check('replace takes the new shape', (await combine(store, a, b, 'replace', W, H)) === b)
  check('add is the union', (await area(await combine(store, a, b, 'add', W, H))) === 70000)
  check('subtract takes the new shape away', (await area(await combine(store, a, b, 'subtract', W, H))) === 30000)
  check('intersect keeps what both cover', (await area(await combine(store, a, b, 'intersect', W, H))) === 10000)
  check('adding to nothing is the shape', (await combine(store, null, b, 'add', W, H)) === b)
  check('intersecting with nothing is nothing', (await area(await combine(store, null, b, 'intersect', W, H))) === 0)
  check('a selection knows its bounds', JSON.stringify(coverBounds(store, a)) === JSON.stringify([0, 0, 512, 512]))
}

console.log('modify')
{
  const boxes = gaussBoxes(4)
  const variance = boxes.reduce((s, r) => s + ((2 * r + 1) ** 2 - 1) / 12, 0)
  check('three boxes make about the Gaussian asked for', near(Math.sqrt(variance), 4, 0.5), `σ ≈ ${Math.sqrt(variance).toFixed(2)}`)
  const r = rasterizePolygon(store, rect(200, 200, 600, 500), W, H)
  const f = await feather(store, r, 20, W, H)
  check('feathering keeps the area', near(await area(f), 120000, 1200), String((await area(f)).toFixed(0)))
  check('a feathered edge is half selected at the old edge', near(await at(f, 200, 350), 0.5, 0.06), String(await at(f, 200, 350)))
  check('and fades out past it', (await at(f, 170, 350)) < 0.1 && (await at(f, 230, 350)) > 0.9)
  check('across tile seams too', near(await at(f, 255, 200), await at(f, 256, 200), 0.02))
  check('feathering by 0 changes nothing', (await feather(store, r, 0, W, H)) === r)

  const ex = await grow(store, r, 10, W, H)
  check('Expand grows each side', (await area(ex)) === 420 * 320, String(await area(ex)))
  const ct = await grow(store, r, -10, W, H)
  check('Contract shrinks each side', (await area(ct)) === 380 * 280, String(await area(ct)))
  check('Expand across a tile seam', (await at(ex, 190, 256)) === 1 && (await at(ex, 189, 256)) === 0)

  const out = await refine(store, f, { smooth: 0, feather: 0, contrast: 0, shift: 0.5 }, W, H)
  check('Shift Edge out widens the selection', (await area(out)) > (await area(f)) + 1000)
  const sharp = await refine(store, f, { smooth: 0, feather: 0, contrast: 0.9, shift: 0 }, W, H)
  check('Contrast sharpens a soft edge', (await at(sharp, 190, 350)) === 0 && (await at(sharp, 210, 350)) === 1)
  const jag = rasterizePolygon(store, [[100, 100], [300, 100], [300, 200], [200, 200], [200, 300], [100, 300]], W, H)
  const smooth = await refine(store, jag, { smooth: 10, feather: 0, contrast: 0, shift: 0 }, W, H)
  check('Smooth rounds an inner corner off', (await at(smooth, 202, 202)) > 0 && (await at(smooth, 150, 150)) === 1)
  check('and keeps the edge crisp', (await at(smooth, 150, 90)) === 0 && (await at(smooth, 150, 110)) === 1)
}

console.log('magic wand')
{
  // Two red squares on white, one with a ramp beside it; channels RGBA.
  const w = 300
  const h = 200
  const img = new Uint8Array(w * h * 4).fill(255)
  const paint = (x0: number, y0: number, x1: number, y1: number, c: number[]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.set(c, (y * w + x) * 4)
  }
  paint(10, 10, 60, 60, [255, 0, 0, 255])
  paint(100, 10, 150, 60, [250, 5, 0, 255])
  for (let x = 200; x < 300; x++) paint(x, 100, x + 1, 200, [x - 200, x - 200, x - 200, 255])
  const one = wand(store, img, 4, w, h, 20, 20, 0, true, false)
  check('contiguous at tolerance 0 takes just the square clicked', (await area(one)) === 2500)
  const near5 = wand(store, img, 4, w, h, 20, 20, 5, false, false)
  check('not contiguous, it takes like colours anywhere', (await area(near5)) === 5000)
  const zero = wand(store, img, 4, w, h, 20, 20, 4, false, false)
  check('tolerance is how far any channel may be', (await area(zero)) === 2500)
  const ramp = wand(store, img, 4, w, h, 210, 150, 10, true, false)
  check('a ramp is taken as far as the tolerance', (await area(ramp)) === 21 * 100, String(await area(ramp)))
  const white = wand(store, img, 4, w, h, 0, 0, 0, true, false)
  check('flood fill goes around shapes', (await area(white)) === w * h - 5000 - 100 * 100, String(await area(white)))
  const flat = wand(store, new Uint8Array(600 * 600 * 4).fill(255), 4, 600, 600, 0, 0, 0, true, true)
  const wholeTiles = [...store.getSet(flat).tiles.values()].filter((t) => store.isUniform(t)).length
  check('a wand over a flat field makes whole tiles, not pixels', (await area(flat)) === 360000 && wholeTiles === 4, `${await area(flat)}, ${wholeTiles} whole`)
  const soft = wand(store, img, 4, w, h, 20, 20, 0, true, true)
  const sv = await at(soft, 10, 30)
  check('anti-aliasing softens the edge by a pixel', sv > 0.5 && sv < 1 && (await at(soft, 9, 30)) > 0 && (await at(soft, 30, 30)) === 1)
}

console.log('pixels through a selection')
{
  const f: TileFormat = { mode: 'rgb', depth: 8 }
  const s = newSamples(f)
  s.fill(100, 0, TILE_PIXELS * 3)
  s.fill(255, TILE_PIXELS * 3)
  const layer = store.createSet(f, [[0, 0, store.data(f, s)]])
  const sel = rasterizePolygon(store, rect(40, 40, 80, 80), W, H)
  const shifted = [1, 0, 0, 1, 20, 20]
  const reader = () => new CoverReader(store, sel)
  const cleared = await throughCover(store, layer, f, shifted, reader(), coverBounds(store, sel)!, null, 'clear')
  const px = async (set: SetId, x: number, y: number) => {
    const t = store.tileAt(set, Math.floor(x / TILE), Math.floor(y / TILE))
    if (t === undefined) return [0, 0, 0, 0]
    const v = await store.samples(t)
    const i = (y % TILE) * TILE + (x % TILE)
    return [0, 1, 2, 3].map((c) => v[c * TILE_PIXELS + i])
  }
  check('Delete clears what the selection covers, through the layer’s transform', (await px(cleared, 30, 30))[3] === 0 && (await px(cleared, 19, 30))[3] === 255 && (await px(cleared, 60, 60))[3] === 255)
  const red = await throughCover(store, layer, f, shifted, reader(), coverBounds(store, sel)!, [255, 0, 0, 255], 'fill')
  check('Fill lays colour on what the selection covers', JSON.stringify(await px(red, 30, 30)) === '[255,0,0,255]' && JSON.stringify(await px(red, 10, 10)) === '[100,100,100,255]')
  const soft = await feather(store, sel, 10, W, H)
  const half = await throughCover(store, layer, f, [1, 0, 0, 1, 0, 0], new CoverReader(store, soft), coverBounds(store, soft)!, [255, 0, 0, 255], 'fill')
  const edge = await px(half, 40, 60)
  check('a feathered selection fills partway at its edge', edge[0] > 150 && edge[0] < 210 && edge[3] === 255, JSON.stringify(edge))
  const fresh = await throughCover(store, null, f, [1, 0, 0, 1, 0, 0], reader(), coverBounds(store, sel)!, [0, 0, 255, 255], 'fill')
  check('filling an empty layer makes its tiles', JSON.stringify(await px(fresh, 50, 50)) === '[0,0,255,255]' && (await px(fresh, 10, 10))[3] === 0)
  check('tiles a fill doesn’t touch are shared', store.tileAt(red, 5, 5) === store.tileAt(layer, 5, 5))
}

console.log('moving, bounds and masks')
{
  const r = rasterizePolygon(store, rect(100, 100, 300, 200), W, H)
  const moved = await offset(store, r, 250, -150, W, H)
  check('a selection moves by whole pixels, across tiles', (await at(moved, 350, 10)) === 1 && (await at(moved, 349, 10)) === 0 && (await area(moved)) === 200 * 50)
  check('and is clipped to the canvas', (await area(await offset(store, r, 900, 0, W, H))) === 0)
  check('its exact bounds', JSON.stringify(await exactBounds(store, r)) === '[100,100,300,200]', JSON.stringify(await exactBounds(store, r)))
  check('an empty selection has none', (await exactBounds(store, selectAll(store, 0, 0))) === null)

  // A wand on a half-size image makes a full-size selection.
  const img = new Uint8Array(100 * 50 * 4).fill(255)
  for (let y = 10; y < 20; y++) for (let x = 10; x < 30; x++) img.set([0, 0, 0, 255], (y * 100 + x) * 4)
  const half = wand(store, img, 4, 100, 50, 15, 15, 0, true, false, 1, 200, 100)
  check('a wand read from a mip level selects at full size', (await area(half)) === 40 * 20 && (await at(half, 20, 20)) === 1 && (await at(half, 19, 20)) === 0)

  const f: TileFormat = { mode: 'gray', depth: 8 }
  const s = newSamples(f)
  s.fill(200, 0, TILE_PIXELS)
  s.fill(255, TILE_PIXELS)
  const layer = store.createSet(f, [[0, 0, store.data(f, s)], [1, 0, store.data(f, s)]])
  const maskSet = rasterizePolygon(store, rect(0, 0, 128, 256), W, H)
  const alphaAt = async (set: SetId, x: number, y: number) => {
    const t = store.tileAt(set, Math.floor(x / TILE), Math.floor(y / TILE))
    return t === undefined ? 0 : (await store.samples(t))[TILE_PIXELS + (y % TILE) * TILE + (x % TILE)]
  }
  const id: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0]
  const applied = await applyMask(store, layer, f, id, { tiles: maskSet, transform: id, outside: 0, invert: false, density: 1, feather: 0 }, W, H)
  check('Apply Layer Mask keeps what the mask shows', (await alphaAt(applied, 10, 10)) === 255 && (await alphaAt(applied, 200, 10)) === 0)
  check('and drops tiles it hides entirely', store.tileAt(applied, 1, 0) === undefined)
  const thin = await applyMask(store, layer, f, id, { tiles: maskSet, transform: id, outside: 0, invert: true, density: 0.5, feather: 0 }, W, H)
  check('inverted at half density, shown parts stay and hidden ones half fade', (await alphaAt(thin, 10, 10)) === 128 && (await alphaAt(thin, 200, 10)) === 255, `${await alphaAt(thin, 10, 10)} ${await alphaAt(thin, 200, 10)}`)
  const moved2 = await applyMask(store, layer, f, [1, 0, 0, 1, 64, 0], { tiles: maskSet, transform: id, outside: 0, invert: false, density: 1, feather: 0 }, W, H)
  check('through the layer’s transform', (await alphaAt(moved2, 10, 10)) === 255 && (await alphaAt(moved2, 70, 10)) === 0)
  const soft = await applyMask(store, layer, f, id, { tiles: maskSet, transform: id, outside: 0, invert: false, density: 1, feather: 16 }, W, H)
  const edge = await alphaAt(soft, 128, 10)
  check('and with its feather', edge > 90 && edge < 165, String(edge))

  const partial = newSamples(COVER)
  partial.fill(0, 0, TILE_PIXELS)
  partial.fill(128, TILE_PIXELS)
  const painted = store.createSet(COVER, [[0, 0, store.data(COVER, partial)]])
  check('a mask painted half on where it had no tiles is half its outside value', near(await new CoverReader(store, painted, 1).at(5, 5), 1 - 128 / 255, 1e-6))
}

console.log('\nTransform Selection and alpha channels')
{
  const r = rasterizePolygon(store, rect(100, 100, 300, 200), W, H)
  const moved = await transformCover(store, r, [1, 0, 0, 1, 50, 30], W, H)
  check('a move by whole pixels moves the selection exactly', (await area(moved)) === 200 * 100 && (await at(moved, 150, 130)) === 1 && (await at(moved, 149, 130)) === 0, String(await area(moved)))
  const doubled = await transformCover(store, r, [2, 0, 0, 2, -100, -100], W, H)
  const da = await area(doubled)
  check('scaled by two about the corner, it covers four times the area', near(da, 4 * 200 * 100, 600), da.toFixed(0))
  check('and lands where the transform puts it', (await at(doubled, 120, 120)) === 1 && (await at(doubled, 95, 120)) === 0)
  const turned = await transformCover(store, rasterizePolygon(store, rect(400, 300, 600, 500), W, H), [0, 1, -1, 0, 1000, -200], W, H)
  check('a quarter turn keeps its area', near(await area(turned), 200 * 200, 400), (await area(turned)).toFixed(0))
  const off = await transformCover(store, r, [1, 0, 0, 1, 5000, 0], W, H)
  check('moved off the canvas, nothing is left', store.getSet(off).tiles.size === 0)
}

console.log('\nwindows written back (Quick Selection, Refine Edge)')
{
  const base = rasterizePolygon(store, rect(0, 0, 600, 400), W, H)
  const w = 300
  const h = 200
  const values = new Float32Array(w * h).fill(0)
  for (let y = 50; y < 150; y++) for (let x = 50; x < 250; x++) values[y * w + x] = 1
  const pasted = await pasteWindow(store, base, 500, 300, w, h, values, W, H)
  check('inside the window the new values, outside it the old', (await at(pasted, 560, 360)) === 1 && (await at(pasted, 510, 310)) === 0 && (await at(pasted, 100, 100)) === 1 && (await at(pasted, 900, 600)) === 0)
  const shared = [...store.getSet(base).tiles].filter(([k, t]) => store.getSet(pasted).tiles.get(k) === t).length
  check('tiles the window doesn’t touch are shared', shared >= 2, `${shared} shared`)
  const small = new Float32Array(10 * 10).fill(1)
  const scaled = await pasteWindow(store, null, 4, 4, 10, 10, small, W, H, 2)
  check('a window from a quarter-size image covers four times the pixels', near(await area(scaled), 40 * 40, 80), (await area(scaled)).toFixed(0))
  const hits = new Uint8Array(100 * 80)
  for (let y = 20; y < 60; y++) for (let x = 10; x < 50; x++) hits[y * 100 + x] = 1
  const set = hitsToSet(store, hits, 100, 80, false, 3, W, 640)
  check('hits from an eighth-size image cover their pixels at full size', (await area(set)) === 40 * 8 * 40 * 8, String(await area(set)))
  const v = new Float32Array(100 * 80).fill(0.25)
  const vs = valuesToSet(store, v, 100, 80, 3, W, 640)
  check('values at an eighth of the size fill the canvas at that value', near(await at(vs, 500, 300), 0.25, 0.003) && near(await area(vs), 0.25 * W * 640, W * 640 * 0.003))
}

console.log('\nGrow, Similar and Colour Range')
{
  // Three bands: dark, mid and dark again, with a light square in the middle band.
  const w = 120
  const h = 60
  const img = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const v = x < 40 ? 30 : x < 80 ? 120 : 34
      img.set([v, v, v, 255], o)
      if (x >= 50 && x < 70 && y >= 20 && y < 40) img.set([240, 30, 30, 255], o)
    }
  const cover = new Float32Array(w * h)
  for (let y = 5; y < 10; y++) for (let x = 5; x < 10; x++) cover[y * w + x] = 1
  const grown = similarHits(img, 4, w, h, cover, 8, true)!
  const count = (hits: Uint8Array, x0: number, x1: number) => {
    let n = 0
    for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) n += hits[y * w + x]
    return n
  }
  check('Grow takes the band the selection is in, and stops at its edge', count(grown, 0, 40) === 40 * h && count(grown, 40, 120) === 0, `${count(grown, 0, 40)} ${count(grown, 40, 120)}`)
  const similar = similarHits(img, 4, w, h, cover, 8, false)!
  check('Similar takes the like band across the image too', count(similar, 80, 120) === 40 * h && count(similar, 40, 80) === 0)
  check('with nothing selected there’s nothing to grow from', similarHits(img, 4, w, h, new Float32Array(w * h), 8, true) === null)
  const sampled = colourRange(img, 4, w, h, 'rgb', 'sampled', [[240, 30, 30]], 40)
  check('Colour Range selects the sampled colour fully, and nothing far from it', sampled[30 * w + 60] === 1 && sampled[30 * w + 10] === 0)
  const fuzz = colourRange(img, 4, w, h, 'rgb', 'sampled', [[120, 120, 120]], 40)
  check('a colour within the fuzziness’s half is fully selected; beyond it, fading', fuzz[30 * w + 45] === 1 && fuzz[30 * w + 10] === 0)
  const reds = colourRange(img, 4, w, h, 'rgb', 'reds', [], 0)
  check('Reds picks the red square and not the grays', reds[30 * w + 60] === 1 && reds[30 * w + 45] === 0)
  const shadows = colourRange(img, 4, w, h, 'rgb', 'shadows', [], 0)
  const highlights = colourRange(img, 4, w, h, 'rgb', 'highlights', [], 0)
  check('Shadows picks the dark bands, Highlights none of them', shadows[30 * w + 10] === 1 && highlights[30 * w + 10] === 0)
}

console.log('\nfills with blend modes, opacity and Preserve Transparency')
{
  const f: TileFormat = { mode: 'rgb', depth: 8 }
  const s = newSamples(f)
  // Left half opaque orange, right half transparent.
  for (let i = 0; i < TILE_PIXELS; i++) {
    const opaque = i % TILE < 128
    s.set([200], i)
    s.set([120], TILE_PIXELS + i)
    s.set([40], 2 * TILE_PIXELS + i)
    s.set([opaque ? 255 : 0], 3 * TILE_PIXELS + i)
  }
  const layer = store.createSet(f, [[0, 0, store.data(f, s)]])
  const blue = paintParams({ kind: 'solid', colour: [0.1, 0.3, 0.9] }, 'rgb', [1, 0, 0, 1, 0, 0], null)
  const px = async (set: SetId | null, x: number, y: number) => {
    const t = set ? store.tileAt(set, 0, 0) : undefined
    if (t === undefined) return [0, 0, 0, 0]
    const v = await store.samples(t)
    return [0, 1, 2, 3].map((c) => v[c * TILE_PIXELS + y * TILE + x])
  }
  const canvas: [number, number, number, number] = [0, 0, TILE, TILE]
  const mult = await fillLayer(store, layer, f, [1, 0, 0, 1, 0, 0], null, canvas, { kind: 'paint', params: blue }, { blend: 'multiply', opacity: 0.5, preserve: false })
  const want = fromWorking('rgb', over(toWorking('rgb', [200 / 255, 120 / 255, 40 / 255, 1]), toWorking('rgb', [0.1, 0.3, 0.9, 1]), 'multiply', 0.5)).map((v) => Math.round(v * 255))
  const got = await px(mult, 10, 10)
  check('Multiply at 50% matches the compositing reference', got.every((v, i) => Math.abs(v - want[i]) <= 1), `${got} vs ${want}`)
  const onClear = await px(mult, 200, 10)
  check('over transparency it lays the colour at the opacity', Math.abs(onClear[3] - 128) <= 1 && Math.abs(onClear[2] - 230) <= 1, String(onClear))
  const kept = await fillLayer(store, layer, f, [1, 0, 0, 1, 0, 0], null, canvas, { kind: 'paint', params: blue }, { blend: 'screen', opacity: 1, preserve: true })
  const wantKept = fromWorking('rgb', atop(toWorking('rgb', [200 / 255, 120 / 255, 40 / 255, 1]), toWorking('rgb', [0.1, 0.3, 0.9, 1]), 'screen', 1)).map((v) => Math.round(v * 255))
  const gotKept = await px(kept, 10, 10)
  check('Preserve Transparency: the colour changes where there are pixels', gotKept.every((v, i) => Math.abs(v - wantKept[i]) <= 1), `${gotKept} vs ${wantKept}`)
  check('and nothing appears where there were none', (await px(kept, 200, 10))[3] === 0)
  const sel = rasterizePolygon(store, rect(0, 0, 64, TILE), W, H)
  const through = await fillLayer(store, layer, f, [1, 0, 0, 1, 0, 0], new CoverReader(store, sel), canvas, { kind: 'paint', params: blue }, { blend: 'normal', opacity: 1, preserve: false })
  check('through a selection, only what’s selected is filled', (await px(through, 10, 10))[2] === 230 && (await px(through, 100, 10))[2] === 40)
  const grad = paintParams({ kind: 'gradient', type: 'linear', stops: [{ at: 0, colour: [0, 0, 0], alpha: 1 }, { at: 1, colour: [1, 1, 1], alpha: 1 }], angle: 0, scale: 100, reverse: false, line: [0, 0, 256, 0] }, 'rgb', [1, 0, 0, 1, 0, 0], null)
  const gradient = await fillLayer(store, null, f, [1, 0, 0, 1, 0, 0], null, canvas, { kind: 'paint', params: grad }, { blend: 'normal', opacity: 1, preserve: false })
  const g0 = await px(gradient, 0, 5)
  const g1 = await px(gradient, 128, 5)
  const g2 = await px(gradient, 255, 5)
  check('a gradient along a line runs from its start to its end', g0[0] <= 1 && Math.abs(g1[0] - 128) <= 1 && g2[0] >= 254, `${g0[0]} ${g1[0]} ${g2[0]}`)
  const image = new Float32Array(10 * 10 * 5)
  for (let p = 0; p < 100; p++) image.set([0, 1, 0, 0, 1], p * 5)
  const fromImage = await fillLayer(store, layer, f, [1, 0, 0, 1, 0, 0], null, canvas, { kind: 'image', x0: 5, y0: 5, w: 10, h: 10, data: image }, { blend: 'normal', opacity: 1, preserve: false })
  check('an image source fills where it is and nowhere else', (await px(fromImage, 7, 7))[1] === 255 && (await px(fromImage, 30, 30))[1] === 120)
}

console.log('\ntiled documents')
{
  const both = { x: true, y: true }
  // A rectangle over the right edge: on a torus, its part past the edge is at the left.
  const over = rasterizePolygon(store, rect(W - 50, 100, W + 50, 200), W, H, true, both)
  check('a shape over the right edge is folded in at the left', (await at(over, 10, 150)) === 1 && (await at(over, W - 10, 150)) === 1 && (await at(over, 60, 150)) === 0)
  check('and covers exactly its own area', (await area(over)) === 100 * 100, String(await area(over)))
  const corner = rasterizePolygon(store, rect(-30, -20, 30, 20), W, H, true, both)
  check('over a corner it’s in all four', (await at(corner, 5, 5)) === 1 && (await at(corner, W - 5, 5)) === 1 && (await at(corner, 5, H - 5)) === 1 && (await at(corner, W - 5, H - 5)) === 1 && (await area(corner)) === 60 * 40)
  check('across only: folded across, clipped down', (await at(rasterizePolygon(store, rect(-30, -20, 30, 20), W, H, true, { x: true, y: false }), W - 5, 5)) === 1 && (await area(rasterizePolygon(store, rect(-30, -20, 30, 20), W, H, true, { x: true, y: false }))) === 60 * 20)
  const wide = rasterizePolygon(store, rect(-100, 0, W + 100, 10), W, H, true, both)
  check('a shape wider than the canvas covers the row once, not twice', (await area(wide)) === W * 10 && (await at(wide, 500, 5)) === 1)
  check('an ordinary document clips it as before', (await at(rasterizePolygon(store, rect(W - 50, 100, W + 50, 200), W, H), 10, 150)) === 0)

  const reader = new CoverReader(store, over, 0, { ...both, width: W, height: H })
  const win = await reader.window(W - 20, 140, 40, 1)
  check('a wrapping reader reads round the edge', win.every((v) => v === 1), Array.from(win).slice(15, 25).join())
  check('and a point past it at the other side', (await reader.at(W + 10, 150)) === 1 && (await reader.at(-10, 150)) === 1)

  const soft = await feather(store, over, 10, W, H, 0, both)
  check('Feather on a torus has no edge at the seam', (await at(soft, 0, 150)) > 0.98 && (await at(soft, W - 1, 150)) > 0.98, `${await at(soft, 0, 150)}`)
  const flat = await feather(store, over, 10, W, H)
  check('(an ordinary document’s does)', (await at(flat, W - 1, 150)) < 0.9)
  const moved = await offset(store, over, 100, 0, W, H, both)
  check('moving a selection on a torus wraps it round', (await at(moved, 110, 150)) === 1 && (await at(moved, W - 10, 150)) === 0 && (await area(moved)) === 100 * 100)
  const grown = await grow(store, over, 5, W, H, both)
  check('Expand on a torus grows across the seam evenly', (await at(grown, 54, 150)) === 1 && (await at(grown, W - 54, 150)) === 1 && (await at(grown, 56, 150)) === 0)
  const turned = await transformCover(store, rasterizePolygon(store, rect(100, 100, 200, 200), W, H), [1, 0, 0, 1, W - 150, 0], W, H, 0, both)
  check('Transform Selection on a torus brings what goes past an edge round', (await at(turned, W - 20, 150)) > 0.99 && (await at(turned, 20, 150)) > 0.99 && near(await area(turned), 100 * 100, 2))
  const pasted = await pasteWindow(store, null, W - 5, 10, 10, 2, new Float32Array(20).fill(1), W, H, 0, both)
  check('a window pasted over the edge lands both sides', (await at(pasted, W - 2, 10)) === 1 && (await at(pasted, 2, 10)) === 1 && (await area(pasted)) === 20)

  // The wand: a vertical black bar splits the white; on a torus the two sides are one region.
  const img = new Uint8Array(W * H * 2).fill(255)
  for (let y = 0; y < H; y++) for (let x = 480; x < 520; x++) img[(y * W + x) * 2] = 0
  const left = wand(store, img, 2, W, H, 100, 100, 10, true, false)
  check('on an ordinary document the wand stops at the canvas edge', (await at(left, 900, 100)) === 0 && (await at(left, 100, 100)) === 1)
  const round = wand(store, img, 2, W, H, 100, 100, 10, true, false, 0, W, H, both)
  check('on a torus it carries on round it, to the other side of the bar', (await at(round, 900, 100)) === 1 && (await at(round, 500, 100)) === 0)
  const aa = wand(store, img, 2, W, H, 100, 100, 10, true, true, 0, W, H, both)
  check('anti-aliased, with no soft edge at the seam', (await at(aa, 0, 100)) === 1 && (await at(aa, W - 1, 100)) === 1)

  // Gradients: the copy nearest the anchor.
  check('a point past the anchor’s half period is its nearer copy', JSON.stringify(wrapPoint([W, 0, W - 10, 0], 20, 5)) === JSON.stringify([W + 20, 5]) && JSON.stringify(wrapPoint([W, 0, W - 10, 0], W - 100, 5)) === JSON.stringify([W - 100, 5]))
  const grad = { kind: 'gradient', type: 'linear', stops: [{ at: 0, colour: [0, 0, 0], alpha: 1 }, { at: 1, colour: [1, 1, 1], alpha: 1 }], angle: 0, scale: 100, reverse: false, line: [W - 40, 0, W + 40, 0] } as never
  check('a linear gradient is anchored at its middle', JSON.stringify(gradientAnchor(grad)) === JSON.stringify([W, 0]))
  const pp = { ...paintParams(grad, 'rgb', [1, 0, 0, 1, 0, 0], [0, 0, W, H]), wrap: [W, 0, W, 0] as [number, number, number, number] }
  check('dragged over the seam, it runs on across it', paintAt(pp, 20, 0).c[0] > paintAt(pp, W - 20, 0).c[0] + 0.3, `${paintAt(pp, W - 20, 0).c[0]} → ${paintAt(pp, 20, 0).c[0]}`)

  // A lasso's corners clicked over a seam stay one shape.
  const doc = { tiled: 'both' as const, width: W, height: H }
  check('a corner clicked in the copy nearest the last one', JSON.stringify(nearestCopy(doc, [10, 50], [W - 10, 50])) === JSON.stringify([W + 10, 50]) && JSON.stringify(nearestCopy({ ...doc, tiled: undefined }, [10, 50], [W - 10, 50])) === JSON.stringify([10, 50]))
}

console.log(failures ? `\n${failures} failed` : '\nall clear')
process.exit(failures ? 1 : 0)
