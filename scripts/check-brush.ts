/**
 * The brush engine and painting's CPU reference: settings read back
 * defensively, curves, the seeded generator, dab placement (spacing,
 * smoothing, pressure, jitter, taps), dabs mapped onto transformed layers,
 * the tip shapes, and the stroke buffer's flow and opacity, which must
 * behave as Photoshop's do.
 *
 * Run with: npm run check:brush
 */
import { BRUSH_PRESETS, DEFAULT_BRUSH, DEFAULT_DUAL, DEFAULT_TEXTURE, LINEAR, colourVaries, curveAt, presetSettings, readBrush, readMixer, withControl, withPressure, hasDynamic, type BrushSettings } from '../src/brush/defs'
import { dabColour, hsvToRgb, rgbToHsv } from '../src/brush/colour'
import { dabMask, edgeness, hash01, noisy, roundMask, toLayer, wrapDab, type Dab } from '../src/brush/dab'
import { rng } from '../src/brush/rng'
import { readFileSync } from 'node:fs'
import { cursorLoops, tipOutline } from '../src/brush/outline'
import { AbrError, readAbr, renamePatterns } from '../src/io/abr'
import { Writer } from '../src/io/psd/bin'
import { D, desc, writeDescriptor } from '../src/io/psd/descriptor'
import { BUILD_UP_MS, StrokeBuilder, strokeDabs, type PenSample } from '../src/brush/stroke'
import { BUILTIN_TEXTURES, adjustTexture, sampleTexture, textureImage, textured } from '../src/brush/textures'
import { BUILTIN_TIP_SIZE, levelSize, makeTip, mipChain, registerTip, sampleTip, tipFromBytes, tipId, tipImage } from '../src/brush/tips'
import { applyReplace, applyStroke, colourAt, coverageAt, layoutOf, newStrokeTile, onCanvas, stamp, styleOf, type StrokeLayout } from '../src/render/ref/paint'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps
const ID = [1, 0, 0, 1, 0, 0]
const line = (x0: number, y0: number, x1: number, y1: number, n: number, pressure = (_t: number) => 0.5): PenSample[] =>
  Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1)
    return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, pressure: pressure(t), tiltX: 0, tiltY: 0, twist: 0, t: i * 8 }
  })
const brush = (o: Partial<BrushSettings> = {}): BrushSettings => ({ ...DEFAULT_BRUSH, smoothing: 0, dynamics: [], ...o })
const dab = (o: Partial<Dab> = {}): Dab => ({ x: 50, y: 50, size: 20, angle: 0, roundness: 1, flipX: false, flipY: false, hardness: 1, opacity: 1, flow: 1, colour: 0, hsb: [0, 0, 0], tip: 'round', texDepth: 1, wet: 1, mix: 1, grain: 0, dual: false, ...o })
const PLAIN: StrokeLayout = { raw: false, dual: false, channels: 0 }
const clip = { t: ID, width: 1000, height: 1000 }

// --- settings ------------------------------------------------------------------
console.log('\nsettings')
check('every preset reads back as itself', BRUSH_PRESETS.every((p) => JSON.stringify(readBrush(JSON.parse(JSON.stringify(presetSettings(p))))) === JSON.stringify(presetSettings(p))))
{
  const warnings: string[] = []
  const b = readBrush({ size: -4, tip: 'nonsense', hardness: 'hard', dynamics: [{ input: 'mood', target: 'size', curve: [0, 'x'] }] }, (w) => warnings.push(w))
  check('nonsense settings come back usable, clamped, and said so', b.size === 1 && b.tip === 'round' && b.hardness === DEFAULT_BRUSH.hardness && b.dynamics[0].input === 'pressure' && b.dynamics[0].curve.join() === '0,1' && warnings.length >= 3, warnings.join('; '))
  check('nothing at all gives the default brush', JSON.stringify(readBrush(undefined)) === JSON.stringify(DEFAULT_BRUSH))
  const old = readBrush({ tip: 'chalk', size: 40, hardness: 0.5, colourJitter: 0.3, dynamics: [{ input: 'pressure', target: 'size', curve: [0, 1], min: 0.2 }] })
  check('settings saved before phase 12 read with every new section at its default', old.tip === 'chalk' && old.size === 40 && old.texture === null && old.dual === null && old.count === 1 && !old.wetEdges && old.colourPerTip)
  const tex = readBrush({ texture: { id: 'canvas', mode: 'height', depth: 2, scale: 0.5 }, dual: { tip: 'tip:abcdef0123456789', mode: 'darken', count: 40 }, tip: 'tip:abcdef0123456789' })
  check('a texture and a dual brush read back, clamped', tex.texture?.id === 'canvas' && tex.texture.mode === 'height' && tex.texture.depth === 1 && tex.dual?.tip === 'tip:abcdef0123456789' && tex.dual.count === 16 && tex.tip === 'tip:abcdef0123456789')
  check('an unknown tip or texture falls back', readBrush({ tip: 'tip:../x' }).tip === 'round' && readBrush({ texture: { id: 'nope' } }).texture?.id === 'paper')
  const fade = readBrush({ dynamics: [{ input: 'fade', target: 'size', curve: [0, 1], min: 0, steps: 12 }] })
  check('a Fade control keeps its steps', fade.dynamics[0].input === 'fade' && fade.dynamics[0].steps === 12)
  check('the mixer’s settings read back clamped', readMixer({ wet: 3, load: 0 }).wet === 1 && readMixer({ wet: 3, load: 0 }).load === 0.01)
}
check('a curve is read between its points', near(curveAt([0, 1], 0.25), 0.25) && near(curveAt([0, 0.35, 1], 0.5), 0.35) && near(curveAt([0, 0.35, 1], 0.75), 0.675) && curveAt([0, 1], 2) === 1)
check('switching pressure for opacity on and off', hasDynamic(withPressure(brush(), 'opacity', true), 'pressure', 'opacity') && !hasDynamic(withPressure(withPressure(brush(), 'opacity', true), 'opacity', false), 'pressure', 'opacity'))
{
  const a = rng(42)
  const b = rng(42)
  const c = rng(43)
  const xs = Array.from({ length: 100 }, a)
  check('the generator is the same for the same seed and differs for another', xs.every((v) => v === b()) && xs.some((v) => v !== c()))
  check('and stays within 0..1, evenly', xs.every((v) => v >= 0 && v < 1) && Math.abs(xs.reduce((s, v) => s + v, 0) / 100 - 0.5) < 0.1)
}

// --- placing dabs ------------------------------------------------------------------
console.log('\nplacing dabs')
{
  const dabs = strokeDabs(brush({ size: 20, spacing: 0.25 }), 1, line(0, 0, 300, 0, 31))
  const gaps = dabs.slice(1).map((d, i) => d.x - dabs[i].x)
  check('dabs are spaced at spacing × diameter along the stroke', dabs.length === 61 && gaps.every((g) => near(g, 5, 1e-6)), `${dabs.length} dabs, gaps ${Math.min(...gaps).toFixed(3)}..${Math.max(...gaps).toFixed(3)}`)
  check('the first dab is where the pen went down', dabs[0].x === 0 && dabs[0].y === 0)
  const fewer = strokeDabs(brush({ size: 20, spacing: 0.25 }), 1, line(0, 0, 300, 0, 4))
  check('however many samples the pen gives, the spacing is the same', fewer.length === dabs.length && fewer.every((d, i) => near(d.x, dabs[i].x, 1e-6)))
  const tap = strokeDabs(brush(), 1, [{ x: 10, y: 10, pressure: 0.5, tiltX: 0, tiltY: 0, twist: 0, t: 0 }])
  check('a tap leaves one dab', tap.length === 1 && tap[0].x === 10)
  const p = strokeDabs(brush({ size: 40, dynamics: [{ input: 'pressure', target: 'size', curve: [0, 1], min: 0.25 }] }), 1, line(0, 0, 400, 0, 50, (t) => t))
  check('pressure sets the size, from its minimum to full', near(p[0].size, 10) && near(p[p.length - 1].size, 40, 0.8), `${p[0].size} → ${p[p.length - 1].size}`)
  const pg = p.slice(1).map((d, i) => d.x - p[i].x)
  check('and thinner dabs are placed closer together', pg[0] < pg[pg.length - 1])
  const sm = strokeDabs(brush({ smoothing: 0.8, spacing: 0.1 }), 1, [...line(0, 0, 100, 0, 11), ...line(100, 0, 100, 100, 11).slice(1)])
  const corner = sm.filter((d) => d.x > 99.9 && d.y < 1)
  check('smoothing rounds the corner off', corner.length === 0)
  const lastGap = Math.hypot(sm[sm.length - 1].x - 100, sm[sm.length - 1].y - 100)
  check('and the stroke still reaches where the pen lifted, to within one spacing', lastGap <= DEFAULT_BRUSH.size * 0.1, lastGap.toFixed(3))
  const j = brush({ sizeJitter: 0.5, angleJitter: 1, scatter: 1, colourJitter: 1 })
  const j1 = strokeDabs(j, 7, line(0, 0, 300, 0, 20))
  const j2 = strokeDabs(j, 7, line(0, 0, 300, 0, 20))
  const j3 = strokeDabs(j, 8, line(0, 0, 300, 0, 20))
  check('jitter is the same for the same seed', JSON.stringify(j1) === JSON.stringify(j2))
  check('and different for another', JSON.stringify(j1) !== JSON.stringify(j3))
  check('scatter moves dabs sideways, within the diameter', j1.some((d) => Math.abs(d.y) > 1) && j1.every((d) => Math.abs(d.y) <= DEFAULT_BRUSH.size))
  check('colour jitter mixes towards the background colour', j1.some((d) => d.colour > 0.2) && j1.every((d) => d.colour >= 0 && d.colour <= 1))
}

// --- Photoshop's sections ----------------------------------------------------------------
console.log('\nthe Brush Settings sections')
{
  const fade = strokeDabs(brush({ size: 20, spacing: 0.25, dynamics: [{ input: 'fade', target: 'size', curve: LINEAR, min: 0, steps: 10 }] }), 1, line(0, 0, 300, 0, 31))
  check('Fade takes the size from full to its minimum over its steps, then holds', near(fade[0].size, 20) && fade[5].size < 12 && fade[10].size <= 0.5 + 1e-9 && fade[20].size <= 0.5 + 1e-9, fade.slice(0, 12).map((d) => d.size.toFixed(1)).join(' '))
  const dir = strokeDabs(brush({ dynamics: [{ input: 'direction', target: 'angle', curve: LINEAR, min: 0 }] }), 1, [...line(0, 0, 100, 0, 6), ...line(100, 0, 100, 100, 6).slice(1)])
  check('Direction turns the tip with the stroke', near(dir[3].angle, 0, 1e-6) && near(dir[dir.length - 1].angle, Math.PI / 2, 1e-6), `${dir[3].angle.toFixed(3)}, ${dir[dir.length - 1].angle.toFixed(3)}`)
  const init = strokeDabs(brush({ dynamics: [{ input: 'initial-direction', target: 'angle', curve: LINEAR, min: 0 }] }), 1, [...line(0, 0, 0, 100, 6), ...line(0, 100, 100, 100, 6).slice(1)])
  check('Initial Direction keeps the first heading', near(init[init.length - 1].angle, Math.PI / 2, 1e-6))
  const round = strokeDabs(brush({ roundnessJitter: 1, minRoundness: 0.4 }), 3, line(0, 0, 300, 0, 20))
  check('roundness jitter stays at or above its minimum', round.every((d) => d.roundness >= 0.4 - 1e-9 && d.roundness <= 1) && round.some((d) => d.roundness < 0.8))
  const flips = strokeDabs(brush({ flipXJitter: true }), 3, line(0, 0, 300, 0, 20))
  check('flip jitter flips some dabs and not others', flips.some((d) => d.flipX) && flips.some((d) => !d.flipX))
  const counted = strokeDabs(brush({ count: 4, scatter: 1, scatterBothAxes: true }), 5, line(0, 0, 300, 0, 31))
  const plain = strokeDabs(brush({}), 5, line(0, 0, 300, 0, 31))
  check('Count lays that many dabs at each step', counted.length === plain.length * 4)
  check('both axes scatter along the stroke too', counted.some((d, i) => Math.abs(d.x - plain[Math.floor(i / 4)].x) > 2))
  const fewer = strokeDabs(brush({ count: 4, countJitter: 1 }), 5, line(0, 0, 300, 0, 31))
  check('count jitter lays fewer, never none', fewer.length < counted.length && fewer.length >= plain.length)
  const posed = strokeDabs(brush({ pose: { tiltX: null, tiltY: null, rotation: null, pressure: 1 }, dynamics: [{ input: 'pressure', target: 'size', curve: LINEAR, min: 0 }] }), 1, line(0, 0, 100, 0, 10, () => 0.1))
  check('Brush Pose overrides the pen’s pressure', posed.every((d) => near(d.size, DEFAULT_BRUSH.size)))
  const hsb = strokeDabs(brush({ hueJitter: 0.5, saturationJitter: 0.4, brightnessJitter: 0.2 }), 2, line(0, 0, 300, 0, 20))
  check('hue, saturation and brightness jitter vary per dab', new Set(hsb.map((d) => d.hsb.join())).size > 5 && hsb.every((d) => Math.abs(d.hsb[0]) <= 0.25 && Math.abs(d.hsb[1]) <= 0.4 && Math.abs(d.hsb[2]) <= 0.2))
  const once = strokeDabs(brush({ hueJitter: 0.5, colourPerTip: false }), 2, line(0, 0, 300, 0, 20))
  check('or once for the whole stroke', new Set(once.map((d) => d.hsb.join())).size === 1)
  check('a varying colour keeps colour per pixel', colourVaries(brush({ hueJitter: 0.1 })) && colourVaries(brush({ purity: -1 })) && !colourVaries(brush({})))
  const dual = strokeDabs(brush({ dual: { ...DEFAULT_DUAL, spacing: 1, size: 10, count: 2 } }), 1, line(0, 0, 100, 0, 11))
  check('a dual brush lays its own dabs, at its own spacing, marked', dual.filter((d) => d.dual).length === 2 * 11 && dual.every((d) => !d.dual || (d.size === 10 && d.tip === DEFAULT_DUAL.tip)))
  const tex = strokeDabs(brush({ texture: { ...DEFAULT_TEXTURE, eachTip: true, depth: 0.8, depthJitter: 1, minDepth: 0.5 } }), 1, line(0, 0, 300, 0, 20))
  check('texture depth in each tip varies, never below its minimum', tex.every((d) => d.texDepth >= 0.8 * 0.5 - 1e-9 && d.texDepth <= 0.8) && new Set(tex.map((d) => d.texDepth)).size > 3)
  // Build-up: the pen held still for 200 ms lays BUILD_UP_MS-spaced dabs there.
  const air = new StrokeBuilder(brush({ buildUp: true }), 1)
  const first = air.add({ x: 10, y: 10, pressure: 0.5, tiltX: 0, tiltY: 0, twist: 0, t: 1000 })
  const held = air.tick(1200)
  check('Build-up keeps laying dabs where the pen rests', first.length === 1 && held.length === Math.floor(200 / BUILD_UP_MS) && held.every((d) => d.x === 10 && d.y === 10), `${held.length}`)
  check('and nothing without it', new StrokeBuilder(brush(), 1).tick(5000).length === 0)
  // A pulled string: small wobbles inside the string's length don't move the stroke.
  const ps = new StrokeBuilder(brush({ pulledString: true, smoothing: 0.5, size: 20 }), 1)
  ps.add({ x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, twist: 0, t: 0 })
  const wobble = [...ps.add({ x: 10, y: 5, pressure: 0.5, tiltX: 0, tiltY: 0, twist: 0, t: 10 }), ...ps.add({ x: -8, y: 12, pressure: 0.5, tiltX: 0, tiltY: 0, twist: 0, t: 20 })]
  const pulled = ps.add({ x: 100, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, twist: 0, t: 30 })
  check('a pulled string ignores the pen inside its length, then follows it at that length', wobble.length === 0 && pulled.length > 0 && pulled[pulled.length - 1].x <= 100 - 30 + 1e-6 && pulled[pulled.length - 1].x > 60, `${pulled[pulled.length - 1]?.x.toFixed(2)}`)
  const ctl = withControl(brush(), 'roundness', { input: 'tilt', curve: LINEAR, min: 0.3 })
  check('a section’s control is one dynamic, replaced or taken away', ctl.dynamics.filter((d) => d.target === 'roundness').length === 1 && withControl(ctl, 'roundness', null).dynamics.every((d) => d.target !== 'roundness'))
}

// --- colour dynamics --------------------------------------------------------------------
console.log('\ncolour dynamics')
{
  const back = hsvToRgb(...rgbToHsv(0.2, 0.6, 0.3))
  check('HSB round-trips', back.every((v, i) => near(v, [0.2, 0.6, 0.3][i], 1e-9)))
  const turned = dabColour([1, 0, 0], [0, 0, 1], 0, [1 / 3, 0, 0], 'rgb')
  check('a third of a turn takes red to green', near(turned[0], 0, 1e-9) && near(turned[1], 1, 1e-9))
  check('purity −1 takes the colour to grey', (() => {
    const g = dabColour([0.8, 0.2, 0.2], [0, 0, 0], 0, [0, -1, 0], 'rgb')
    return near(g[0], g[1], 1e-9) && near(g[1], g[2], 1e-9)
  })())
  check('in Gray only brightness moves it', near(dabColour([0.5], [0], 0, [0.3, 0.5, 0.2], 'gray')[0], 0.7, 1e-9))
  const k = dabColour([0.9, 0.2, 0.3, 0.6], [1, 1, 1, 1], 0, [0.2, 0, 0], 'cmyk')
  check('in CMYK black is kept', near(k[3], 0.6, 1e-12) && k.slice(0, 3).some((v, i) => Math.abs(v - [0.9, 0.2, 0.3][i]) > 0.05))
}

// --- dabs on layers ---------------------------------------------------------------------
console.log('\ndabs on layers')
{
  const d = toLayer(dab({ size: 20 }), ID)
  check('on an untransformed layer a dab is where it was put', d.cx === 50 && d.cy === 50 && near(dabMask(d, 50, 50), 1) && dabMask(d, 60.5, 50) === 0)
  check('its box holds it', d.box[0] <= 40 && d.box[2] >= 60)
  // A layer scaled up 2× about the origin: a 20-pixel dab is 10 layer pixels across.
  const s = toLayer(dab({ size: 20, x: 100, y: 100 }), [2, 0, 0, 2, 0, 0])
  check('on a layer scaled 2× it covers half as many layer pixels', s.cx === 50 && dabMask(s, 50 + 3.9, 50) > 0.99 && dabMask(s, 50 + 5.2, 50) === 0)
  // Turned 90°: a dab squashed along x in the document is squashed along y in the layer.
  const r = toLayer(dab({ size: 20, roundness: 0.5, x: 0, y: 0 }), [0, 1, -1, 0, 0, 0])
  check('on a turned layer a squashed dab turns with it', dabMask(r, 0, 8) > 0 && dabMask(r, 8, 0) === 0, `${dabMask(r, 0, 8)} / ${dabMask(r, 8, 0)}`)
  check('a hard tip has an edge one pixel wide', roundMask(1 - 0.5 / 10, 1, 1 / 10) > 0.4 && roundMask(1 - 0.5 / 10, 1, 1 / 10) < 0.6 && roundMask(0.8, 1, 0.1) === 1)
  check('a soft tip falls off from the middle', roundMask(0, 0, 0.1) === 1 && roundMask(0.5, 0, 0.1) === 0.5 && roundMask(0.9, 0, 0.1) < 0.05)
  check('every built-in sampled tip has something in it, within 0..1', ['chalk', 'spatter', 'bristle'].every((t) => {
    const img = tipImage(t)!
    return img.width === BUILTIN_TIP_SIZE && img.levels[0].some((v) => v > 0.5) && img.levels[0].every((v) => v >= 0 && v <= 1)
  }))
  check('sampled tips come out the same every time', tipImage('chalk') === tipImage('chalk'))
  const flipped = toLayer(dab({ size: 20, flipX: true }), ID)
  check('a flip mirrors the dab', near(flipped.a[0], -0.1) && near(toLayer(dab({ size: 20 }), ID).a[0], 0.1))
}

// --- image tips ---------------------------------------------------------------------------
console.log('\nimage tips')
{
  const chain = mipChain(5, 3, new Float32Array(15).fill(1))
  check('a mip chain halves, rounding up, to one texel', chain.length === 4 && levelSize({ width: 5, height: 3 }, 1).join() === '3,2' && levelSize({ width: 5, height: 3 }, 3).join() === '1,1')
  check('and past an odd edge counts as empty', near(chain[1][2], 0.5) && near(chain[1][0], 1))
  const bytes = new Uint8Array(300 * 100)
  for (let y = 0; y < 100; y++) for (let x = 0; x < 300; x++) bytes[y * 300 + x] = x < 150 ? 255 : 0
  const id = tipId(300, 100, bytes)
  check('a tip’s id is its content', id === tipId(300, 100, bytes) && id !== tipId(300, 100, bytes.map((v) => 255 - v)) && /^tip:[0-9a-f]{16}$/.test(id))
  const tip = tipFromBytes(300, 100, bytes)
  registerTip(id, tip)
  check('a wide tip spans the dab’s width and keeps its proportion', near(sampleTip(tip, -0.5, 0, 0.001), 1) && near(sampleTip(tip, 0.5, 0, 0.001), 0) && sampleTip(tip, -0.5, 0.5, 0.001) === 0 && near(sampleTip(tip, -0.5, 0.3, 0.001), 1))
  // Stamped 40 pixels wide, a texel of level 0 is an eighth of a pixel: it reads level 3, where the edge is soft.
  const sharp = sampleTip(tip, -0.03, 0, 0.001)
  const small = sampleTip(tip, -0.03, 0, 16 / 300)
  check('stamped small it reads a coarser level: the edge softens', near(sharp, 1) && small > 0.3 && small < 0.95, `${sharp.toFixed(3)} / ${small.toFixed(3)}`)
  check('a huge image is scaled down to the largest tip', makeTip(3000, 1000, new Float32Array(3000 * 1000)).width === 1024)
  const d = toLayer(dab({ tip: id, size: 40 }), ID)
  check('a dab with an image tip is covered by it', dabMask(d, 40, 50) > 0.9 && dabMask(d, 60, 50) < 0.01 && dabMask(d, 40, 50 + 15) === 0)
}

// --- noise, wet edges, textures ---------------------------------------------------------------
console.log('\nNoise, Wet Edges and textures')
{
  check('the hash is the same for the same pixel and seed, and spreads', hash01(3, 4, 5) === hash01(3, 4, 5) && hash01(3, 4, 5) !== hash01(4, 3, 5) && hash01(-7, 9, 1) >= 0 && hash01(-7, 9, 1) < 1)
  check('Noise leaves full and empty alone, and varies the soft part', noisy(1, 0.9) === 1 && noisy(0, 0.9) === 0 && noisy(0.5, 0.9) > 0.5 && noisy(0.5, 0.1) < 0.5)
  const d = toLayer(dab({ size: 40, hardness: 1 }), ID)
  const inside = dabMask(d, 50, 50, { noise: false, wetEdges: true })
  const rim = dabMask(d, 50 + 18, 50, { noise: false, wetEdges: true })
  check('Wet Edges: lighter in the middle, heavier at the edge', inside < 0.5 && rim > inside, `${inside.toFixed(3)} / ${rim.toFixed(3)}`)
  check('edgeness grows towards the edge', edgeness(true, 0.3, 1) === 0 && edgeness(true, 0.99, 1) > 0.9)
  check('the built-in papers tile and stay in 0..1', BUILTIN_TEXTURES.every((t) => {
    const img = textureImage(t)!
    return img.data.every((v) => v >= 0 && v <= 1) && near(sampleTexture(img, 10.5, 20.5, 1), sampleTexture(img, 10.5 + img.width, 20.5 + img.height, 1), 1e-9)
  }))
  check('texture adjustments: invert, brightness, contrast', near(adjustTexture(0.2, { brightness: 0, contrast: 0, invert: true }), 0.8) && adjustTexture(0.5, { brightness: 150, contrast: 0, invert: false }) === 1 && adjustTexture(0.6, { brightness: 0, contrast: 100, invert: false }) > 0.8)
  check('Multiply and Subtract take paint away where the paper is low', near(textured(1, 0.3, 1, 0), 0.3) && near(textured(1, 0.3, 1, 1), 0.3) && near(textured(0.8, 0.9, 1, 1), 0.7))
  check('depth 0 changes nothing; half depth goes half way', textured(0.8, 0.1, 0, 0) === 0.8 && near(textured(1, 0.5, 0.5, 0), 0.75))
  check('Hard Mix is all or nothing', textured(0.6, 0.5, 1, 7) === 1 && textured(0.3, 0.5, 1, 7) === 0)
  // A stroke-wide texture: the coverage the layer gets is the textured main coverage.
  const b = brush({ texture: { ...DEFAULT_TEXTURE, id: 'canvas', depth: 1 } })
  const t = newStrokeTile(layoutOf(b, false, 0))
  stamp(t, 0, 0, [toLayer(dab({ size: 60, x: 128, y: 128 }), ID)], null, clip, styleOf(b))
  const raw = t.v[(128 * 256 + 128) * 2 + 1]
  check('a stroke-wide texture keeps the main coverage apart and textures what the layer gets', near(raw, 1) && coverageAt(t, 128 * 256 + 128) < 1 && coverageAt(t, 128 * 256 + 128) >= 0)
  const db = brush({ dual: { ...DEFAULT_DUAL, mode: 'multiply' } })
  const dt = newStrokeTile(layoutOf(db, false, 0))
  stamp(dt, 0, 0, [toLayer(dab({ size: 60, x: 128, y: 128 }), ID)], null, clip, styleOf(db))
  check('with a dual brush and none of its dabs yet, nothing shows', coverageAt(dt, 128 * 256 + 128) === 0)
  stamp(dt, 0, 0, [toLayer(dab({ size: 60, x: 128, y: 128, dual: true }), ID)], null, clip, styleOf(db))
  check('where its dabs fall, the stroke shows through them', near(coverageAt(dt, 128 * 256 + 128), 1))
}

// --- the stroke buffer ------------------------------------------------------------------------
console.log('\nflow and opacity')
{
  const at = (t: ReturnType<typeof newStrokeTile>, x: number, y: number) => coverageAt(t, y * 256 + x)
  const one = newStrokeTile(PLAIN)
  stamp(one, 0, 0, [toLayer(dab({ flow: 0.5 }), ID)], null, clip)
  check('one dab at 50% flow covers its middle by half', near(at(one, 50, 50), 0.5, 1e-6), String(at(one, 50, 50)))
  const two = newStrokeTile(PLAIN)
  stamp(two, 0, 0, [toLayer(dab({ flow: 0.5 }), ID), toLayer(dab({ flow: 0.5 }), ID)], null, clip)
  check('a second dab on top builds it up to three quarters', near(at(two, 50, 50), 0.75, 1e-6))
  const capped = newStrokeTile(PLAIN)
  stamp(capped, 0, 0, Array.from({ length: 40 }, () => toLayer(dab({ flow: 0.3, opacity: 0.6 }), ID)), null, clip)
  check('at 60% opacity, forty dabs approach 60% and never pass it', at(capped, 50, 50) <= 0.6 && at(capped, 50, 50) > 0.599, String(at(capped, 50, 50)))
  const lower = newStrokeTile(PLAIN)
  stamp(lower, 0, 0, [toLayer(dab({ opacity: 0.8 }), ID), toLayer(dab({ opacity: 0.3 }), ID)], null, clip)
  check('a lighter dab over a darker one in the same stroke doesn’t lighten it', near(at(lower, 50, 50), 0.8, 1e-6))
  const col = newStrokeTile({ raw: false, dual: false, channels: 3 })
  stamp(col, 0, 0, [toLayer(dab({ flow: 0.5 }), ID), toLayer(dab({ flow: 1 }), ID)], [[1, 0, 0], [0, 0, 1]], clip)
  const c = colourAt(col, 50 * 256 + 50)
  check('a stroke’s colour is each dab’s, weighted by what each added', near(c[0], 0.5, 1e-6) && near(c[2], 0.5, 1e-6) && near(at(col, 50, 50), 1), c.join())
  const edge = newStrokeTile(PLAIN)
  stamp(edge, 0, 0, [toLayer(dab({ x: 5, y: 5 }), ID)], null, { t: ID, width: 4, height: 1000 })
  check('nothing is painted past the edge of the canvas', at(edge, 3, 5) > 0 && at(edge, 4, 5) === 0 && onCanvas({ t: ID, width: 4, height: 4 }, 3.5, 3.5))
  const L = { c: [0.2, 0.4, 0.6], a: 1 }
  check('a full stroke in Normal replaces the layer’s colour', applyStroke(L, 1, [1, 0, 0], 'normal', false).c.join() === '1,0,0')
  check('in Multiply it multiplies', applyStroke(L, 1, [0.5, 0.5, 0.5], 'multiply', false).c.map((v) => v.toFixed(3)).join() === '0.100,0.200,0.300')
  const e = applyStroke(L, 0.25, [0, 0, 0], 'normal', true)
  check('the eraser takes away alpha, not colour', near(e.a, 0.75) && near(e.c[0] / e.a, 0.2))
  check('no coverage changes nothing', applyStroke(L, 0, [1, 1, 1], 'normal', false).c.join() === L.c.join())
  const half = applyReplace({ c: [0.4, 0.4, 0.4], a: 0.4 }, 0.5, { c: [0, 0, 0], a: 0 })
  check('a replacing stroke (Smudge, the Mixer Brush) can take paint away as well as put it down', near(half.a, 0.2) && near(half.c[0], 0.2))
}

// --- the cursor's outline ---------------------------------------------------------
console.log('\nthe cursor’s outline')
{
  // A 40 × 20 tip: a filled square on the left, a smaller one on the right.
  const w = 40
  const h = 20
  const data = new Uint8Array(w * h)
  for (let y = 2; y < 18; y++) for (let x = 2; x < 18; x++) data[y * w + x] = 255
  for (let y = 6; y < 14; y++) for (let x = 26; x < 34; x++) data[y * w + x] = 255
  const id = tipId(w, h, data)
  registerTip(id, tipFromBytes(w, h, data))
  const loops = tipOutline(id)
  const box = (l: [number, number][]) => [Math.min(...l.map((p) => p[0])), Math.min(...l.map((p) => p[1])), Math.max(...l.map((p) => p[0])), Math.max(...l.map((p) => p[1]))]
  check('a tip of two shapes has two loops, the bigger first', loops.length === 2 && box(loops[0])[2] < 0 && box(loops[1])[0] > 0, String(loops.length))
  check('thinned to their corners: a square is a handful of points', loops.length === 2 && loops[0].length >= 4 && loops[0].length <= 12, String(loops[0]?.length))
  // The tip is 40 wide, so its left square spans x 2..18 of 40: −0.9..−0.1 in tip space, give or take a texel.
  const [x0, , x1] = loops[0] ? box(loops[0]) : [9, 9, 9]
  check('where the tip is, in tip space', Math.abs(x0 + 0.9) < 0.08 && Math.abs(x1 + 0.1) < 0.08, `${x0.toFixed(3)}..${x1.toFixed(3)}`)
  const turned = cursorLoops(id, 100, 50, 80, 90, 1, false, false)
  const [tx0, ty0, tx1, ty1] = box(turned[0])
  check('the cursor turns it with the brush: at 90° the left square is above the centre', ty1 < 50 && tx0 > 100 - 40 * 0.5 && tx1 < 100 + 40 * 0.5 && ty0 > 50 - 40, `${box(turned[0]).map((v) => v.toFixed(1))}`)
  const flipped = cursorLoops(id, 0, 0, 80, 0, 1, true, false)
  check('and flips it', box(flipped[0])[0] > 0)
  check('a blank tip has none', tipOutline((() => { const z = new Uint8Array(16); const zid = tipId(4, 4, z); registerTip(zid, tipFromBytes(4, 4, z)); return zid })()).length === 0)
  check('a round tip’s cursor is a circle at the radius', cursorLoops('round', 0, 0, 50, 0, 1, false, false)[0].every(([x, y]) => near(Math.hypot(x, y), 25, 1e-9)))
}

// --- ABR files ------------------------------------------------------------------
console.log('\nABR files')
{
  const fixture = (name: string) => readAbr(new Uint8Array(readFileSync(`scripts/fixtures/abr/${name}`)))
  // Made by Photoshop (abrkit's probes): one sampled tip with shape dynamics, scattering and transfer.
  const dyn = fixture('photoshop_dynamics.abr')
  const d = dyn.presets[0]?.settings
  check('Photoshop’s dynamics probe is version 6 with one preset and its tip', dyn.version === 6 && dyn.presets.length === 1 && dyn.tips.length === 1)
  check('its tip is the sampled one, 15 × 14, by its content hash', !!d && d.tip === dyn.tips[0].id && dyn.tips[0].width === 15 && dyn.tips[0].height === 14 && d.tip === tipId(15, 14, dyn.tips[0].data))
  check('its tip shape: 15 px, 60% round, 30°, 40% spacing', !!d && d.size === 15 && near(d.roundness, 0.6) && d.angle === 30 && near(d.spacing, 0.4))
  check('its shape dynamics: size jitter 37%, angle 10%, roundness 30% down to 25%, flip X', !!d && near(d.sizeJitter, 0.37) && near(d.angleJitter, 0.1) && near(d.roundnessJitter, 0.3) && near(d.minRoundness, 0.25) && d.flipXJitter && !d.flipYJitter)
  check('its scattering: 250%, a count of 4 with 50% jitter', !!d && near(d.scatter, 2.5) && d.count === 4 && near(d.countJitter, 0.5))
  check('its transfer: opacity jitter 25%', !!d && near(d.opacityJitter, 0.25))
  check('its angle follows the pen’s rotation, and the stroke-start rotation it asked for is named', !!d && d.dynamics.some((x) => x.input === 'twist' && x.target === 'angle') && dyn.warnings.some((w) => w.includes('rotation')))
  const dual = fixture('photoshop_dual_brush.abr').presets[0]?.settings.dual
  check('Photoshop’s dual brush probe: a 25 px soft round in Colour Burn at 25% spacing', !!dual && dual.tip === 'round' && dual.size === 25 && dual.hardness === 0 && dual.mode === 'color-burn' && near(dual.spacing, 0.25))
  // CC0, from a set someone published: many sampled tips.
  const myer = fixture('myer-settlement-brushes.abr')
  check('a published set of 148 brushes reads whole, without complaint', myer.presets.length === 148 && myer.tips.length === 148 && myer.warnings.length === 0)
  check('each of its brushes uses a tip in the file, at that tip’s size', myer.presets.every((p) => { const t = myer.tips.find((x) => x.id === p.settings.tip); return !!t && p.settings.size === Math.max(t.width, t.height) }))
  check('its tips aren’t blank', myer.tips.every((t) => t.data.some((v) => v > 128)))
  check('its brushes read back as themselves', myer.presets.every((p) => JSON.stringify(readBrush(JSON.parse(JSON.stringify(p.settings)))) === JSON.stringify(p.settings)))

  // Versions 1 and 2, built here: a computed round and a sampled tip (raw in 1, PackBits in 2, with its name).
  const tip = Uint8Array.from({ length: 6 * 4 }, (_, i) => (i % 6) * 40)
  const legacy = (version: 1 | 2) => {
    const w = new Writer()
    w.u16(version)
    w.u16(2)
    w.u16(1)
    let end = w.mark()
    w.u32(0)
    w.u16(25) // spacing %
    w.u16(40) // diameter
    w.u16(50) // roundness %
    w.u16(200) // angle, 0..359
    w.u16(75) // hardness %
    end()
    w.u16(2)
    end = w.mark()
    w.u32(0)
    w.u16(10)
    if (version === 2) w.unicode('Rake')
    w.u8(0)
    w.zeros(8)
    w.i32(0)
    w.i32(0)
    w.i32(4)
    w.i32(6)
    w.u16(8)
    w.u8(version === 2 ? 1 : 0)
    if (version === 1) w.bytes(tip)
    else {
      // Each row as one literal run.
      for (let y = 0; y < 4; y++) w.u16(7)
      for (let y = 0; y < 4; y++) {
        w.u8(5)
        w.bytes(tip.subarray(y * 6, y * 6 + 6))
      }
    }
    end()
    return w.done()
  }
  for (const v of [1, 2] as const) {
    const f = readAbr(legacy(v))
    const [round, sampled] = f.presets.map((p) => p.settings)
    check(`version ${v}: a computed round (40 px, 75% hard, 50% round, −160°, 25% spacing)`, f.version === v && round?.tip === 'round' && round.size === 40 && near(round.hardness, 0.75) && near(round.roundness, 0.5) && round.angle === -160 && near(round.spacing, 0.25))
    check(`version ${v}: a sampled tip, its pixels exactly`, f.tips.length === 1 && f.tips[0].width === 6 && f.tips[0].height === 4 && f.tips[0].data.every((x, i) => x === tip[i]) && sampled?.tip === f.tips[0].id && sampled.size === 6 && near(sampled.spacing, 0.1))
    check(`version ${v}: ${v === 2 ? 'the tip’s own name' : 'a made-up name'}`, f.presets[1]?.name === (v === 2 ? 'Rake' : 'Sampled 2'))
  }

  // Version 6 built here: a sampled tip, a pattern (patt) and presets (desc) that use them.
  const modern = (presets: ReturnType<typeof desc>[], withPattern = true) => {
    const w = new Writer()
    w.u16(6)
    w.u16(2)
    const section = (key: string, body: () => void) => {
      w.sig('8BIM')
      w.sig(key)
      const end = w.mark()
      const from = w.pos
      body()
      w.pad(4, from)
      end()
    }
    section('samp', () => {
      const end = w.mark()
      const from = w.pos
      const id = '$abc-tip'
      w.u8(id.length)
      w.bytes(new TextEncoder().encode(id))
      w.zeros(264)
      w.i32(0)
      w.i32(0)
      w.i32(4)
      w.i32(6)
      w.u16(8)
      w.u8(0)
      w.bytes(tip)
      end()
      w.pad(4, from - 4)
    })
    if (withPattern)
      section('patt', () => {
        const end = w.mark()
        const from = w.pos
        w.u32(1)
        w.u32(3) // RGB
        w.i16(2)
        w.i16(3)
        w.unicode('Weave')
        w.pascal('$pat-1', 1)
        w.u32(3)
        const vma = w.mark()
        w.zeros(16)
        w.u32(3)
        for (const value of [200, 100, 50]) {
          w.u32(1)
          const ch = w.mark()
          w.u32(8)
          w.i32(0)
          w.i32(0)
          w.i32(2)
          w.i32(3)
          w.u16(8)
          w.u8(0)
          w.bytes(new Uint8Array(6).fill(value))
          ch()
        }
        vma()
        end()
        w.pad(4, from - 4)
      })
    section('desc', () => {
      w.u32(16)
      writeDescriptor(w, desc('null', [['Brsh', D.list(presets.map((p) => ({ t: 'Objc', v: p })))]]))
    })
    return w.done()
  }
  const preset = (name: string, extra: [string, ReturnType<typeof D.bool>][]) =>
    desc('brushPreset', [
      ['Nm  ', D.text(name)],
      ['Brsh', D.obj('sampledBrush', [['Dmtr', D.unit('#Pxl', 48)], ['Angl', D.unit('#Ang', 15)], ['Rndn', D.unit('#Prc', 80)], ['Spcn', D.unit('#Prc', 30)], ['Intr', D.bool(true)], ['sampledData', D.text('$abc-tip')]])],
      ...extra,
    ])
  const textured = preset('Grainy', [
    ['useTexture', D.bool(true)],
    ['Txtr', D.obj('Ptrn', [['Nm  ', D.text('Weave')], ['Idnt', D.text('$pat-1')]])],
    ['textureBlendMode', D.enum('BlnM', 'linearHeight')],
    ['textureScale', D.unit('#Prc', 50)],
    ['textureDepth', D.unit('#Prc', 80)],
    ['InvT', D.bool(true)],
    ['usePaintDynamics', D.bool(true)],
    ['opVr', D.obj('brVr', [['bVTy', D.long(2)], ['jitter', D.unit('#Prc', 20)], ['Mnm ', D.unit('#Prc', 10)]])],
    ['prVr', D.obj('brVr', [['bVTy', D.long(1)], ['fStp', D.long(12)], ['jitter', D.unit('#Prc', 0)]])],
    ['Wtdg', D.bool(true)],
    ['toolOptions', D.obj('brushToolOptions', [['Opct', D.long(70)], ['flow', D.long(40)], ['Md  ', D.enum('BlnM', 'Mltp')], ['smoothing', D.bool(true)], ['smoothingValue', D.long(30)]])],
  ])
  const wheel = preset('Wheel', [['useTipDynamics', D.bool(true)], ['szVr', D.obj('brVr', [['bVTy', D.long(4)], ['jitter', D.unit('#Prc', 0)]])]])
  const f = readAbr(modern([textured, wheel]))
  const g = f.presets[0]?.settings
  check('version 6: the sampled tip, the pattern and both presets', f.version === 6 && f.tips.length === 1 && f.patterns.length === 1 && f.presets.length === 2)
  check('the tip from samp is the preset’s, its pixels exactly', !!g && g.tip === f.tips[0].id && f.tips[0].data.every((x, i) => x === tip[i]))
  check('the tip shape from desc: 48 px, 15°, 80% round, 30% spacing', !!g && g.size === 48 && g.angle === 15 && near(g.roundness, 0.8) && near(g.spacing, 0.3))
  const pat = f.patterns[0]
  check('the RGB pattern comes in grey, at its size', pat?.width === 3 && pat.height === 2 && pat.data.every((v) => v === Math.round(0.299 * 200 + 0.587 * 100 + 0.114 * 50)))
  check('the texture: that pattern, Linear Height, 50%, 80% deep, inverted', !!g?.texture && g.texture.id === `pat:${pat?.id}` && g.texture.mode === 'linear-height' && near(g.texture.scale, 0.5) && near(g.texture.depth, 0.8) && g.texture.invert)
  check('transfer: opacity by pressure, jitter 20% down to 10%; flow fading over 12 steps', !!g && near(g.opacityJitter, 0.2) && g.dynamics.some((x) => x.input === 'pressure' && x.target === 'opacity' && near(x.min, 0.1)) && g.dynamics.some((x) => x.input === 'fade' && x.target === 'flow' && x.steps === 12))
  check('wet edges, the options bar (70%, 40% flow, Multiply) and 30% smoothing', !!g && g.wetEdges && near(g.opacity, 0.7) && near(g.flow, 0.4) && g.mode === 'multiply' && near(g.smoothing, 0.3))
  check('a stylus wheel control is left off and named', f.presets[1]?.settings.dynamics.length === 0 && f.warnings.some((w) => w.includes('wheel')))
  const renamed = renamePatterns(f, (p) => `pat:${p.width}x${p.height}`)
  check('patterns renamed by their pixels, the textures that use them too', renamed.patterns[0].id === 'pat:3x2' && renamed.presets[0].settings.texture?.id === 'pat:3x2')
  const lost = readAbr(modern([textured], false))
  check('a texture whose pattern isn’t in the file comes in with paper, and that’s named', lost.presets[0]?.settings.texture?.id === 'paper' && lost.warnings.some((w) => w.includes('pattern')))
  const refuses = (b: Uint8Array) => {
    try {
      readAbr(b)
      return false
    } catch (e) {
      return e instanceof AbrError
    }
  }
  check('version 5 is refused by name', refuses(Uint8Array.of(0, 5, 0, 1)))
  check('a cut-off file is refused, not thrown about', refuses(modern([textured]).subarray(0, 300)) || readAbr(modern([textured]).subarray(0, 300)).presets.length === 0)
}

console.log('\ntiled documents')
{
  const both = { x: true, y: true }
  check('a dab in a document that doesn’t repeat is left as it is', wrapDab(dab({ x: 5 }), 100, 100, { x: false, y: false }).length === 1)
  check('a dab clear of the edges is stamped once', wrapDab(dab({ x: 50, y: 50, size: 20 }), 100, 100, both).length === 1)
  const edge = wrapDab(dab({ x: 95, y: 50, size: 20 }), 100, 100, both)
  check('a dab over the right edge is stamped at the left too', edge.length === 2 && edge[0].x === 95 && edge[1].x === -5)
  const corner = wrapDab(dab({ x: 2, y: 98, size: 20 }), 100, 100, both)
  check('over a corner, four times', corner.length === 4 && corner.every((d) => d.x === 2 || d.x === 102))
  const far = wrapDab(dab({ x: 250, y: -30, size: 4 }), 100, 100, both)
  check('a dab off in a copy is brought into the document first', far.length === 1 && far[0].x === 50 && far[0].y === 70)
  check('across only: it wraps across, not down', wrapDab(dab({ x: 50, y: 99, size: 20 }), 100, 100, { x: true, y: false }).length === 1 && wrapDab(dab({ x: 99, y: 50, size: 20 }), 100, 100, { x: true, y: false }).length === 2)
  check('a dab wider than the document reaches every copy it touches', wrapDab(dab({ x: 50, y: 50, size: 300 }), 100, 100, { x: true, y: false }).length >= 5)
}

console.log(failures ? `\nFAIL (${failures})` : '\nPASS')
process.exit(failures ? 1 : 0)
