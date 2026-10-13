/**
 * Adjustments, live filters and layer effects, headless: the registries,
 * reading their parameters back (defaults, limits, the wrong shapes), each
 * adjustment's program against what the adjustment means, the filter
 * references against what each filter should do to simple images, and the
 * effects' planes (jump flooding against brute force).
 *
 * The GPU is held to these same references in check:gpu.
 *
 * Run with: npm run check:adjust
 */
import { ADJUSTMENT_DEFS, LUT_SIZE, cubeColours, cubeProgram, curveFn, gradientAt, levelsFn, luma, parseCube, programFor, rangeWeight, runProgram, selectiveWeights, type StoredCube } from '../src/adjust/defs'
import { FILTER_CATEGORIES, cloudsAt, lensRegion } from '../src/filters/defs'
import { CHANNELS, defaultParams, readCurve, readLevels, readParamValues } from '../src/doc/params'
import { FILTER_DEFS, FILTER_BY_ID, boxPass, filterValues, gaussianRegion, motionTaps, noiseAt, type Region } from '../src/filters/defs'
import { FX_DEFS, activeFx, fxValues } from '../src/fx/defs'
import { fxLayers, jumpFlood, shadowOffset } from '../src/fx/ref'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol
const nearAll = (a: number[], b: number[], tol = 1e-3) => a.length === b.length && a.every((v, i) => near(v, b[i], tol))
const run = (id: string, params: Record<string, unknown>, mode: 'rgb' | 'gray' | 'cmyk', c: number[]) => runProgram(programFor(id, params, mode)!, mode, c)

console.log('\nregistries')
for (const [name, list] of [
  ['adjustments', ADJUSTMENT_DEFS],
  ['filters', FILTER_DEFS],
] as const) {
  const ids = list.map((d) => d.id)
  check(`${name} have unique ids`, new Set(ids).size === ids.length)
}
check('effects have unique kinds', new Set(FX_DEFS.map((d) => d.kind)).size === FX_DEFS.length)
for (const d of [...ADJUSTMENT_DEFS, ...FILTER_DEFS, ...FX_DEFS]) {
  const keys = d.params.map((p) => p.key)
  const label = 'id' in d ? d.id : d.kind
  check(`${label}: parameters have unique keys and defaults in range`, new Set(keys).size === keys.length && d.params.every((p) => p.kind !== 'number' || (p.default >= p.min && p.default <= p.max)))
}
for (const mode of ['rgb', 'gray', 'cmyk'] as const) {
  check(`every adjustment compiles in ${mode.toUpperCase()} with its defaults`, ADJUSTMENT_DEFS.every((d) => !!d.compile(defaultParams(d.params, mode), mode)))
}
check('an adjustment this build doesn’t know has no program, and isn’t drawn', programFor('time-travel', {}, 'rgb') === null)

console.log('\nreading parameters')
const levelsDef = ADJUSTMENT_DEFS.find((d) => d.id === 'levels')!.params
const read = readParamValues(levelsDef, { levels: { master: { inBlack: 2, inWhite: -1, gamma: 'x' } } }, 'rgb')
const m = (read.levels as Record<string, { inBlack: number; inWhite: number; gamma: number }>).master
check('levels out of range are brought back in, the white point above the black', m.inBlack <= 0.996 && m.inWhite > m.inBlack && m.gamma === 1, JSON.stringify(m))
check('every channel of the mode gets its own levels', Object.keys(read.levels as object).join() === CHANNELS.rgb.join())
check('a curve that isn’t one is the straight line', JSON.stringify(readCurve('nope')) === '[[0,0],[1,1]]')
check('a curve’s points are sorted and kept in range', JSON.stringify(readCurve([[0.8, 2], [0.1, -1], [0.1, 0.5]])) === '[[0.1,0],[0.8,1]]')
check('a colour of the wrong length takes the default, in the mode’s terms', JSON.stringify(readParamValues(FX_DEFS[0].params, { colour: [1, 2] }, 'cmyk').colour) === '[0,0,0,1]')
check('a choice that isn’t one of the options takes the default', readParamValues(FX_DEFS[0].params, { blend: 'glow' }, 'rgb').blend === 'multiply')
check('a gradient needs two stops', (readParamValues([{ key: 'g', kind: 'gradient', label: 'G' }], { g: [{ at: 0.5, colour: [1, 0, 0] }] }, 'rgb').g as unknown[]).length === 2)
check('unknown parameters are dropped', !('sparkle' in readParamValues(levelsDef, { sparkle: 1 }, 'rgb')))
check('readLevels makes sense of nothing', JSON.stringify(readLevels(undefined)) === JSON.stringify({ inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 }))

console.log('\nadjustments mean what they say')
check('Invert takes x to 1 − x', nearAll(run('invert', {}, 'rgb', [0.2, 0.5, 0.9]), [0.8, 0.5, 0.1]))
check('in CMYK, Invert inverts the inks', nearAll(run('invert', {}, 'cmyk', [0.2, 0.5, 0.9, 1]), [0.8, 0.5, 0.1, 0]))
check('Posterize to 3 levels cuts the range in equal thirds, to 0, ½ and 1, as Photoshop does', nearAll(run('posterize', { levels: 3 }, 'gray', [0.3]), [0]) && nearAll(run('posterize', { levels: 3 }, 'gray', [0.4]), [0.5]) && nearAll(run('posterize', { levels: 3 }, 'gray', [0.7]), [1]))
check('Threshold at 128 makes dark black and light white', nearAll(run('threshold', { level: 128 }, 'rgb', [0.4, 0.4, 0.4]), [0, 0, 0]) && nearAll(run('threshold', { level: 128 }, 'rgb', [0.6, 0.6, 0.6]), [1, 1, 1]))
check('in CMYK, Threshold’s black is all K', nearAll(run('threshold', { level: 128 }, 'cmyk', [0.3, 0.3, 0.3, 0.3]), [1, 1, 1, 0]))
const lv = levelsFn({ inBlack: 0.2, inWhite: 0.8, gamma: 1, outBlack: 0, outWhite: 1 })
check('Levels maps its input black to 0 and white to 1, linearly between at gamma 1', near(lv(0.2), 0) && near(lv(0.8), 1) && near(lv(0.5), 0.5) && near(lv(0.1), 0))
check('Levels’ gamma lifts the middle', levelsFn({ inBlack: 0, inWhite: 1, gamma: 2, outBlack: 0, outWhite: 1 })(0.25) > 0.45)
check('the straight curve changes nothing', [0, 0.3, 0.7, 1].every((x) => near(curveFn([[0, 0], [1, 1]])(x), x)))
const s = curveFn([[0, 0], [0.25, 0.1], [0.75, 0.9], [1, 1]])
check('an S curve goes through its points and stays in range', near(s(0.25), 0.1) && near(s(0.75), 0.9) && Array.from({ length: 101 }, (_, i) => s(i / 100)).every((v, i, a) => v >= 0 && v <= 1 && (i === 0 || v >= a[i - 1] - 1e-12)))
check('a channel’s own Levels apply before the master, as Photoshop has it', nearAll(run('levels', { levels: { master: { inBlack: 0, inWhite: 0.5, gamma: 1, outBlack: 0, outWhite: 1 }, red: { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0.5, outWhite: 1 } } }, 'rgb', [0, 0, 0]), [1, 0, 0]))
const steep = curveFn([[0, 0], [0.4, 0.8], [0.5, 0.2], [1, 1]])
check('a curve is a natural spline: through every point, bending past them where they’re steep', near(steep(0.4), 0.8) && near(steep(0.5), 0.2) && steep(0.3) > 0.8 * 0.75)
check('Exposure works in linear light: +1 stop takes ½ to ½·2^(1/2.2)', near(run('exposure', { exposure: 1, offset: 0, gamma: 1 }, 'gray', [0.5])[0], 0.5 * Math.pow(2, 1 / 2.2), 1e-3))
check('Brightness/Contrast keeps its ends where they are', [[150, -21], [-95, -50], [23, 70]].every(([b, c]) => near(run('brightness-contrast', { brightness: b, contrast: c }, 'gray', [0])[0], 0, 1e-3) && near(run('brightness-contrast', { brightness: b, contrast: c }, 'gray', [1])[0], 1, 1e-3)))
check('and brightness lifts the middle', run('brightness-contrast', { brightness: 50, contrast: 0 }, 'gray', [0.5])[0] > 0.55)
check('legacy Brightness shifts every value, and clips', near(run('brightness-contrast', { brightness: 51, contrast: 0, legacy: true }, 'gray', [0.5])[0], 0.7, 2e-3) && near(run('brightness-contrast', { brightness: 51, contrast: 0, legacy: true }, 'gray', [0.9])[0], 1, 1e-3))
check('Saturation +100 takes any colour to full saturation', (() => { const o = run('hue-saturation', { hue: 0, saturation: 100, lightness: 0 }, 'rgb', [0.6, 0.5, 0.45]); return Math.max(...o) - Math.min(...o) > 0.9 })())
check('Curves per channel: lifting green leaves red and blue', (() => {
  const out = run('curves', { curves: { master: [[0, 0], [1, 1]], green: [[0, 0.5], [1, 1]] } }, 'rgb', [0.2, 0.2, 0.2])
  return near(out[0], 0.2, 2e-3) && near(out[2], 0.2, 2e-3) && near(out[1], 0.6, 2e-3)
})())
check('Hue +120° turns red green', nearAll(run('hue-saturation', { hue: 120 }, 'rgb', [1, 0, 0]), [0, 1, 0]))
check('Saturation −100 makes grey, keeping lightness', (() => {
  const o = run('hue-saturation', { saturation: -100 }, 'rgb', [0.8, 0.2, 0.2])
  return near(o[0], o[1]) && near(o[1], o[2]) && near(o[0], 0.5)
})())
check('Lightness +100 is white, −100 black', nearAll(run('hue-saturation', { lightness: 100 }, 'rgb', [0.3, 0.6, 0.1]), [1, 1, 1]) && nearAll(run('hue-saturation', { lightness: -100 }, 'rgb', [0.3, 0.6, 0.1]), [0, 0, 0]))
check('Hue/Saturation leaves Gray’s one channel as it was at zero', nearAll(run('hue-saturation', {}, 'gray', [0.37]), [0.37]))
const dull = run('vibrance', { vibrance: 100 }, 'rgb', [0.55, 0.45, 0.45])
const vivid = run('vibrance', { vibrance: 100 }, 'rgb', [0.95, 0.05, 0.05])
const gain = (o: number[], before: number) => (o[0] - o[1]) / before
check('Vibrance lifts dull colours more than vivid ones', gain(dull, 0.1) > 1.5 && gain(vivid, 0.9) < 1.2, `${gain(dull, 0.1).toFixed(2)}× / ${gain(vivid, 0.9).toFixed(2)}×`)
check('Colour Balance towards red, keeping luminosity', (() => {
  const c = [0.5, 0.5, 0.5]
  const o = run('colour-balance', { midtonesCyanRed: 60, preserveLuminosity: true }, 'rgb', c)
  return o[0] > o[1] && near(luma(o[0], o[1], o[2]), luma(0.5, 0.5, 0.5), 1e-6)
})())
check('Black & White’s defaults: pure red at 40%, yellow 60%, blue 20%, as Photoshop', near(run('black-white', {}, 'rgb', [1, 0, 0])[0], 0.4) && near(run('black-white', {}, 'rgb', [1, 1, 0])[0], 0.6) && near(run('black-white', {}, 'rgb', [0, 0, 1])[0], 0.2))
check('Black & White leaves greys grey', nearAll(run('black-white', {}, 'rgb', [0.3, 0.3, 0.3]), [0.3, 0.3, 0.3]))
check('Channel Mixer: red from green', nearAll(run('channel-mixer', { redFromRed: 0, redFromGreen: 100 }, 'rgb', [0.1, 0.7, 0.3]), [0.7, 0.7, 0.3]))
check('Gradient Map: black to white maps tones to themselves', [0, 0.25, 0.8].every((y) => near(run('gradient-map', {}, 'gray', [y])[0], y, 2e-3)))
check('and reversed, to their opposites', near(run('gradient-map', { reverse: true }, 'gray', [0.25])[0], 0.75, 2e-3))
check('a gradient between stops is a straight mix', nearAll(gradientAt([{ at: 0, colour: [0, 0, 0] }, { at: 1, colour: [1, 0.5, 0] }], 0.5), [0.5, 0.25, 0]))
check('tables have LUT_SIZE entries per channel', programFor('levels', {}, 'cmyk')!.table!.length === LUT_SIZE * 4)

console.log('\nfilters')
const region = (size: number, fn: (x: number, y: number) => number[]): Region => {
  const stride = fn(0, 0).length
  const data = new Float64Array(size * size * stride)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data.set(fn(x, y), (y * size + x) * stride)
  return { size, stride, data }
}
const sum = (r: Region, c: number) => r.data.reduce((a, v, i) => (i % r.stride === c ? a + v : a), 0)
const dot = region(64, (x, y) => (x === 32 && y === 32 ? [1, 1] : [0, 0]))
const g = gaussianRegion(dot, 4)
check('a Gaussian blur keeps the total', near(sum(g, 1), 1, 1e-9))
check('and spreads a point evenly round it', near(g.data[(32 * 64 + 28) * 2 + 1], g.data[(32 * 64 + 36) * 2 + 1], 1e-12) && near(g.data[(28 * 64 + 32) * 2 + 1], g.data[(32 * 64 + 28) * 2 + 1], 1e-12))
const spread = Math.sqrt(Array.from({ length: 64 }, (_, x) => g.data[(32 * 64 + x) * 2 + 1] * (x - 32) ** 2).reduce((a, b) => a + b, 0) / Array.from({ length: 64 }, (_, x) => g.data[(32 * 64 + x) * 2 + 1]).reduce((a, b) => a + b, 0))
check('about as far as its radius', Math.abs(spread - 4) < 0.6, spread.toFixed(2))
const box = boxPass(region(9, (x) => [x === 4 ? 9 : 0]), 1, true)
check('a box pass is the mean of 2r + 1', near(box.data[3], 3) && near(box.data[4], 3) && near(box.data[5], 3) && near(box.data[2], 0))
const noisy = region(32, (x, y) => ((x * 7 + y * 3) % 11 === 0 ? [1, 1] : [0.5, 1]))
const med = FILTER_BY_ID.get('median')!.ref(noisy, filterValues('median', { radius: 1 }, 'gray'), { origin: [0, 0], scale: 1, seed: 0 })
check('Median takes out lone bright pixels', med.data[(10 * 32 + 10) * 2] === 0.5 && Array.from({ length: 30 }, (_, i) => med.data[((i + 1) * 32 + 15) * 2]).every((v) => v === 0.5))
check('noise is the same for the same pixel and seed, different for another seed', noiseAt(5, 9, 1, 0, false) === noiseAt(5, 9, 1, 0, false) && noiseAt(5, 9, 1, 0, false) !== noiseAt(5, 9, 2, 0, false))
const many = Array.from({ length: 4000 }, (_, i) => noiseAt(i % 100, Math.floor(i / 100), 7, 0, false))
check('uniform noise averages to nothing and stays within ±1', Math.abs(many.reduce((a, b) => a + b, 0) / many.length) < 0.05 && many.every((v) => v >= -1 && v <= 1))
const taps = motionTaps(0, 10)
check('Motion Blur samples evenly along its line, centred', taps.length === 11 && near(taps[0][0], -5) && near(taps[10][0], 5) && taps.every((t) => near(t[1], 0)))
check('at 90°, straight up and down', motionTaps(90, 4).every((t) => near(t[0], 0)))
const sharp = FILTER_BY_ID.get('unsharp-mask')!.ref(region(40, (x) => [x < 20 ? 0.3 : 0.7, 1]), filterValues('unsharp-mask', { amount: 100, radius: 2 }, 'gray'), { origin: [0, 0], scale: 1, seed: 0 })
check('Unsharp Mask darkens the dark side of an edge and lightens the light', sharp.data[(20 * 40 + 19) * 2] < 0.3 && sharp.data[(20 * 40 + 20) * 2] > 0.7)
check('and leaves flat ground alone', near(sharp.data[(20 * 40 + 5) * 2], 0.3, 1e-9))
check('reach grows with the radius and shrinks with the zoom', FILTER_BY_ID.get('gaussian-blur')!.reach({ radius: 10 }, 1) > FILTER_BY_ID.get('gaussian-blur')!.reach({ radius: 10 }, 4))

console.log('\nlayer effects')
const disc = region(48, (x, y) => (Math.hypot(x - 24, y - 24) < 10 ? [1, 1] : [0, 0]))
const out = jumpFlood(disc, false)
let worst = 0
for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) {
  let best = 1e9
  for (let sy = 0; sy < 48; sy++) for (let sx = 0; sx < 48; sx++) if (disc.data[(sy * 48 + sx) * 2 + 1] >= 0.5) best = Math.min(best, Math.hypot(sx - x, sy - y))
  worst = Math.max(worst, Math.abs(out[y * 48 + x] - best))
}
check('jump flooding finds the nearest pixel of the shape, as brute force does', worst < 1e-9, `worst ${worst}`)
check('a shadow falls away from the light: from 120°, down and to the right', (() => {
  const [x, y] = shadowOffset(120, 10)
  return x > 0 && y > 0
})())
check('only effects switched on draw, in Photoshop’s order', activeFx([{ kind: 'stroke', enabled: true, params: {} }, { kind: 'drop-shadow', enabled: true, params: {} }, { kind: 'satin', enabled: false, params: {} }]).map((f) => f.kind).join() === 'drop-shadow,stroke')
const stroke = fxLayers(disc, [{ kind: 'stroke', v: fxValues({ kind: 'stroke', enabled: true, params: { size: 3 } }, 'gray') }], { scale: 1, mode: 'gray', bounds: [0, 0, 48, 48] })[0]
const cov = (x: number, y: number) => stroke.px.data[(y * 48 + x) * 2 + 1]
check('an outside stroke rings the shape and stays out of it', cov(24 + 11, 24) > 0.99 && cov(24 + 15, 24) === 0 && cov(24, 24) === 0)
const shadow = fxLayers(disc, [{ kind: 'drop-shadow', v: fxValues({ kind: 'drop-shadow', enabled: true, params: { distance: 6, size: 0, angle: 180 } }, 'gray') }], { scale: 1, mode: 'gray', bounds: [0, 0, 48, 48] })[0]
check('a hard drop shadow is the shape moved away from the light', shadow.px.data[(24 * 48 + 24 + 14) * 2 + 1] > 0.99 && shadow.px.data[(24 * 48 + 24 - 12) * 2 + 1] === 0 && shadow.place === 'below')

console.log('\nOffset')
{
  const off = FILTER_BY_ID.get('offset')!
  const v = (o: Record<string, unknown>) => filterValues('offset', o, 'rgb')
  check('Offset is a filter that remaps, defaulting to Wrap Around', !!off.remap && v({}).edge === 'wrap')
  check('wrapping, a pixel comes from as far back, round the edge', JSON.stringify(off.remap!(10, 5, v({ horizontal: 30, vertical: 10 }), 100, 50)) === JSON.stringify([80, 45]))
  check('by a whole canvas, nothing moves', JSON.stringify(off.remap!(17, 23, v({ horizontal: 100, vertical: -50 }), 100, 50)) === JSON.stringify([17, 23]))
  check('repeating the edge, the gap takes the edge pixel', JSON.stringify(off.remap!(10, 5, v({ horizontal: 30, vertical: 10, edge: 'repeat' }), 100, 50)) === JSON.stringify([0, 0]))
  check('set to transparent, the gap is nothing', off.remap!(10, 5, v({ horizontal: 30, edge: 'transparent' }), 100, 50) === null && JSON.stringify(off.remap!(40, 5, v({ horizontal: 30, edge: 'transparent' }), 100, 50)) === JSON.stringify([10, 5]))
  // Offset by half twice is where it started.
  const half = v({ horizontal: 50, vertical: 25 })
  const twice = (x: number, y: number) => off.remap!(...(off.remap!(x, y, half, 100, 50) as [number, number]), half, 100, 50)
  check('wrapping by half twice is where it started', [[0, 0], [99, 49], [37, 11]].every(([x, y]) => JSON.stringify(twice(x, y)) === JSON.stringify([x, y])))
}

console.log('\nthe adjustment pack')
{
  const near = (a: number[], b: number[], t = 0.01) => a.every((v, i) => Math.abs(v - b[i]) <= t)
  // Colour cubes: read back trilinearly, they're the function at their points and close between.
  const fn = (c: number[]) => [c[0] * 0.8 + 0.1, c[1] * c[1], 1 - c[2]]
  const cube = cubeProgram(fn)
  check('a colour cube is its function at its points', near(runProgram(cube, 'rgb', [0.5, 0.25, 0.75]), fn([0.5, 0.25, 0.75]), 1e-6))
  check('and close between them', near(runProgram(cube, 'rgb', [0.33, 0.41, 0.12]), fn([0.33, 0.41, 0.12]), 0.005))
  check('a cube works on Gray through its lightness', runProgram(cube, 'gray', [0.5]).length === 1)
  // Selective Colour: reds belong to Reds, grays to Neutrals.
  const w = selectiveWeights([0.9, 0.2, 0.1])
  check('a red is mostly Reds, none of Blues', w.reds > 0.6 && !w.blues && !w.greens)
  check('a gray is all Neutrals', selectiveWeights([0.5, 0.5, 0.5]).neutrals === 1)
  const sel = programFor('selective-colour', { reds_cyan: 100, method: 'absolute' }, 'rgb')!
  const red = runProgram(sel, 'rgb', [0.9, 0.2, 0.1])
  check('more cyan in Reds takes red out of a red', red[0] < 0.6, JSON.stringify(red))
  check('and leaves a blue alone', near(runProgram(sel, 'rgb', [0.1, 0.2, 0.9]), [0.1, 0.2, 0.9], 0.02))
  // Photo Filter keeps lightness when asked, and tints.
  const warm = programFor('photo-filter', { filter: 'warming-85', density: 60, preserve: true }, 'rgb')!
  const g = runProgram(warm, 'rgb', [0.5, 0.5, 0.5])
  check('a warming filter warms a gray', g[0] > g[2] + 0.1, JSON.stringify(g))
  check('keeping its lightness', Math.abs(luma(g[0], g[1], g[2]) - 0.5) < 0.02)
  // Colour Lookup from a .cube file: the identity reads back as it was.
  const lines = ['TITLE "id"', 'LUT_3D_SIZE 2']
  for (let b = 0; b < 2; b++) for (let gg = 0; gg < 2; gg++) for (let r = 0; r < 2; r++) lines.push(`${r} ${gg} ${b}`)
  const parsed = parseCube(lines.join('\n'), 'id.cube') as StoredCube
  check('a .cube file reads', !('error' in parsed) && parsed.size === 2 && !!cubeColours(parsed))
  const lut = programFor('colour-lookup', { look: 'file', lut: parsed }, 'rgb')!
  check('and an identity table changes nothing', near(runProgram(lut, 'rgb', [0.2, 0.6, 0.9]), [0.2, 0.6, 0.9], 1e-4))
  check('a broken one says what’s wrong', 'error' in (parseCube('LUT_3D_SIZE 3\n0 0 0', 'x') as object) && 'error' in (parseCube('LUT_1D_SIZE 16', 'x') as object))
  // Colour Grading: a blue push in the shadows blues a dark gray more than a light one.
  const grade = programFor('colour-grading', { shadowsWheel: [240, 80] }, 'rgb')!
  const dk = runProgram(grade, 'rgb', [0.15, 0.15, 0.15])
  const lt = runProgram(grade, 'rgb', [0.9, 0.9, 0.9])
  check('Colour Grading’s shadow wheel moves the shadows most', dk[2] - dk[0] > 0.05 && dk[2] - dk[0] > lt[2] - lt[0] + 0.03, JSON.stringify([dk, lt]))
  // Hue/Saturation's ranges.
  check('Reds are whole within 15° of red, gone at 45°, round the circle', rangeWeight(10, [315, 345, 15, 45]) === 1 && rangeWeight(50, [315, 345, 15, 45]) === 0 && rangeWeight(350, [315, 345, 15, 45]) === 1 && Math.abs(rangeWeight(30, [315, 345, 15, 45]) - 0.5) < 1e-9)
  check('and limits of a file’s own are its', rangeWeight(100, [262, 322, 40, 133]) > 0 && rangeWeight(200, [262, 322, 40, 133]) === 0)
  const hs = programFor('hue-saturation', { redsSaturation: -100 }, 'rgb')!
  const r2 = runProgram(hs, 'rgb', [0.9, 0.1, 0.1])
  check('Reds at −100 saturation grays a red', Math.abs(r2[0] - r2[1]) < 0.05, JSON.stringify(r2))
  check('and leaves a green', near(runProgram(hs, 'rgb', [0.1, 0.8, 0.1]), [0.1, 0.8, 0.1], 0.02))
  check('only the master: Photoshop’s sums as before, not a cube', programFor('hue-saturation', { hue: 20 }, 'rgb')!.table === null)
  // The filter pack's references: Lens Blur's disc, and Clouds in range.
  const img = { size: 16, stride: 4, data: new Float64Array(16 * 16 * 4).map((_, i) => (i % 4 === 3 ? 1 : (i >> 2) % 16 === 8 ? 1 : 0)) }
  const lb = lensRegion(img, 3, 0, 1)
  check('Lens Blur spreads a line across its disc', lb.data[(5 * 16 + 6) * 4] > 0.05 && lb.data[(5 * 16 + 2) * 4] < 1e-9)
  const cl = [cloudsAt(1.3, 2.7, 3), cloudsAt(10.1, 0.2, 3), cloudsAt(1.3, 2.7, 4)]
  check('Clouds are 0..1, the same for a seed, other for another', cl.every((v) => v >= 0 && v <= 1) && cloudsAt(1.3, 2.7, 3) === cl[0] && cl[0] !== cl[2])
  check('every filter in the menu has a submenu of Photoshop’s', FILTER_DEFS.filter((f) => !f.hidden).every((f) => FILTER_CATEGORIES.includes(f.category ?? '')), FILTER_DEFS.filter((f) => !FILTER_CATEGORIES.includes(f.category ?? '')).map((f) => f.id).join())
}

console.log(`\n${failures === 0 ? 'all clear' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
