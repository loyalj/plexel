/**
 * The brush engine and painting's CPU reference: settings read back
 * defensively, curves, the seeded generator, dab placement (spacing,
 * smoothing, pressure, jitter, taps), dabs mapped onto transformed layers,
 * the tip shapes, and the stroke buffer's flow and opacity, which must
 * behave as Photoshop's do.
 *
 * Run with: npm run check:brush
 */
import { BRUSH_PRESETS, DEFAULT_AIRBRUSH, DEFAULT_BRISTLE, DEFAULT_BRUSH, DEFAULT_DUAL, DEFAULT_ERODIBLE, DEFAULT_TEXTURE, LINEAR, colourVaries, curveAt, presetSettings, readBrush, readMixer, withControl, withPressure, hasDynamic, pressureSizeShare, type BrushSettings } from '../src/brush/defs'
import { dabColour, hsvToRgb, rgbToHsv } from '../src/brush/colour'
import { dabMask, edgeness, hash01, noisy, roundMask, toLayer, wrapDab, type Dab } from '../src/brush/dab'
import { rng } from '../src/brush/rng'
import { readFileSync } from 'node:fs'
import { cursorLoops, tipOutline } from '../src/brush/outline'
import { AbrError, readAbr, renamePatterns } from '../src/io/abr'
import { writeAbr } from '../src/io/abrWrite'
import { TplError, readTpl } from '../src/io/tpl'
import { BRISTLE_LEVELS, WEAR_LEVELS, Wear, bristleTipId, generateTip, isGeneratedTip } from '../src/brush/special'
import { Writer } from '../src/io/psd/bin'
import { D, desc, writeDescriptor } from '../src/io/psd/descriptor'
import { BUILD_UP_MS, StrokeBuilder, strokeDabs, type PenSample } from '../src/brush/stroke'
import { BUILTIN_TEXTURES, adjustTexture, sampleTexture, textureImage, textured } from '../src/brush/textures'
import { BUILTIN_TIP_SIZE, hasTip, levelSize, makeTip, mipChain, registerTip, sampleTip, tipFromBytes, tipId, tipImage } from '../src/brush/tips'
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
{
  // The cursor's inner ring: the size the stroke paints at a pressure, from the size's pressure control alone.
  const sized = brush({ size: 30, dynamics: [{ input: 'pressure', target: 'size', curve: [0, 0.35, 1], min: 0.1 }, { input: 'pressure', target: 'opacity', curve: LINEAR, min: 0 }] })
  const dab = new StrokeBuilder(sized, 1).add({ x: 10, y: 10, pressure: 0.3, tiltX: 0, tiltY: 0, twist: 0, t: 0 })[0]
  check('the cursor’s pressure size is the size a dab paints', !!dab && near(30 * pressureSizeShare(sized, 0.3)!, dab.size))
  check('and there’s none when pressure doesn’t size the brush', pressureSizeShare(brush({ dynamics: [{ input: 'pressure', target: 'opacity', curve: LINEAR, min: 0 }] }), 0.3) === null)
}
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
  check('its angle follows the pen’s rotation as the stroke began, as it asked', !!d && d.dynamics.some((x) => x.input === 'initial-twist' && x.target === 'angle') && !dyn.warnings.some((w) => w.includes('rotation')))
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
  check('a stylus wheel control comes in as one', f.presets[1]?.settings.dynamics.some((x) => x.input === 'wheel' && x.target === 'size') === true && !f.warnings.some((w) => w.includes('wheel')))
  // Bristle, erodible and airbrush tips: their shape by Photoshop's menu order under their class, settings found by name.
  const special = (name: string, cls: string, items: [string, ReturnType<typeof D.bool>][]) => desc('brushPreset', [['Nm  ', D.text(name)], ['Brsh', D.obj(cls, [['Dmtr', D.unit('#Pxl', 36)], ['Spcn', D.unit('#Prc', 2)], ['Intr', D.bool(true)], ...items])]])
  const sf = readAbr(
    modern([
      special('Fan', 'dBrush', [['Shp ', D.long(9)], ['bristleDensity', D.unit('#Prc', 40)], ['bristleLength', D.unit('#Prc', 150)], ['bristleThickness', D.unit('#Prc', 20)], ['bristleStiffness', D.unit('#Prc', 70)]]),
      special('Chisel', 'dTips', [['Shp ', D.long(1)], ['softness', D.unit('#Prc', 80)]]),
      special('Spray', 'dTips', [['Shp ', D.long(5)], ['Hrdn', D.unit('#Prc', 60)], ['distortion', D.unit('#Prc', 30)]]),
      special('Odd', 'dBrush', [['Shp ', D.long(42)]]),
    ]),
  )
  const [fan, chisel, spray, odd] = sf.presets.map((p) => p.settings.special)
  check('a bristle tip: Flat Fan, its bristles, length, thickness and stiffness', fan?.kind === 'bristle' && fan.shape === 'flat-fan' && near(fan.bristles, 0.4) && near(fan.length, 1.5) && near(fan.thickness, 0.2) && near(fan.stiffness, 0.7))
  check('an erodible flat with its softness', chisel?.kind === 'erodible' && chisel.shape === 'flat' && near(chisel.softness, 0.8))
  check('dTips 5 is the airbrush, not a sixth erodible shape', spray?.kind === 'airbrush' && near(spray.hardness, 0.6) && near(spray.distortion, 0.3))
  check('a shape Plexel doesn’t know comes in as a default, named; settings not found are said', odd?.kind === 'bristle' && odd.shape === 'round-point' && sf.warnings.some((w) => w.includes('Odd') && w.includes('shape')) && sf.warnings.some((w) => w.includes('Spray') && w.includes('defaults')))
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

console.log('\nbristle, erodible and airbrush tips, the stylus wheel and Initial Rotation')
{
  const bristle = { ...DEFAULT_BRISTLE }
  const r1 = readBrush({ special: { kind: 'bristle', shape: 'flat-angle', bristles: 2, length: 0.1, thickness: 0.5, stiffness: 0.3 } })
  check('a bristle tip reads back, out-of-range values held in range', r1.special?.kind === 'bristle' && r1.special.shape === 'flat-angle' && r1.special.bristles === 1 && r1.special.length === 0.25)
  const warned: string[] = []
  check('a kind of tip that isn’t known is none, said', readBrush({ special: { kind: 'sponge' } }, (w) => warned.push(w)).special === null && warned.length === 1)
  check('every preset with a special tip reads back as itself', BRUSH_PRESETS.filter((p) => p.settings.special).every((p) => JSON.stringify(readBrush(JSON.parse(JSON.stringify(presetSettings(p))))) === JSON.stringify(presetSettings(p))))
  // Footprints: made from their names, the same each time.
  const id0 = bristleTipId(bristle, 0)
  const id11 = bristleTipId(bristle, BRISTLE_LEVELS - 1)
  const a = generateTip(id11)!
  const b = generateTip(id11)!
  check('a footprint is made from its name, the same every time', a.data.every((v, i) => v === b.data[i]) && isGeneratedTip(id11) && hasTip(id11) && !!tipImage(id11))
  const extent = (d: Float32Array) => {
    let far = 0
    for (let y = 0; y < a.size; y++) for (let x = 0; x < a.size; x++) if (d[y * a.size + x] > 0.3) far = Math.max(far, Math.hypot(x + 0.5 - a.size / 2, y + 0.5 - a.size / 2))
    return far
  }
  const sum = (d: Float32Array) => d.reduce((s, v) => s + v, 0)
  const light = generateTip(id0)!.data
  check('pressed harder, a pointed brush’s hairs splay further and more of them touch', extent(a.data) > extent(light) * 1.3 && sum(a.data) > sum(light) * 2, `${extent(light).toFixed(0)} → ${extent(a.data).toFixed(0)} px`)
  const stiff = generateTip(bristleTipId({ ...bristle, stiffness: 1 }, BRISTLE_LEVELS - 1))!.data
  const soft = generateTip(bristleTipId({ ...bristle, stiffness: 0.05 }, BRISTLE_LEVELS - 1))!.data
  const ratio = (d: Float32Array) => extent(d) / extent(generateTip(bristleTipId({ ...bristle, stiffness: d === stiff ? 1 : 0.05 }, 0))!.data)
  check('stiff hairs splay less than soft ones', ratio(stiff) < ratio(soft), `${ratio(stiff).toFixed(2)} vs ${ratio(soft).toFixed(2)}`)
  check('a name that isn’t a footprint’s makes none', generateTip('gen:b:99:1:1:1:1:1') === null && generateTip('gen:q:1') === null && generateTip('gen:a:1:2') === null)
  const dabsOf = (o: Partial<BrushSettings>, s: PenSample[], wear?: number) => strokeDabs(brush({ size: 30, spacing: 0.1, ...o }), 7, s, { wear })
  const hard = dabsOf({ special: bristle }, line(0, 0, 200, 0, 20, (t) => t))
  const levels = hard.map((d) => Number(d.tip.split(':').pop()))
  check('a bristle stroke pressed harder as it goes goes deeper', hard.every((d) => d.tip.startsWith('gen:b:')) && levels[levels.length - 1] > levels[0])
  // Erodible: wear.
  const pencil: Partial<BrushSettings> = { special: { ...DEFAULT_ERODIBLE, softness: 1 } }
  const long = dabsOf(pencil, line(0, 0, 3000, 0, 200, () => 0.5))
  check('an erodible point blunts as it draws', long[long.length - 1].size > long[0].size * 1.5, `${long[0].size.toFixed(1)} → ${long[long.length - 1].size.toFixed(1)} px`)
  const worn = dabsOf(pencil, line(0, 0, 100, 0, 10, () => 0.5), 0.8)
  check('a worn one starts wide', worn[0].size > long[0].size * 2)
  const sb = new StrokeBuilder(brush({ size: 30, ...pencil }), 1, { wear: 0.1 })
  for (const s of line(0, 0, 600, 0, 40, () => 1)) sb.add(s)
  const w = new Wear({ ...DEFAULT_ERODIBLE, softness: 1 }, 30, 0.1)
  for (const s of line(0, 0, 600, 0, 40, () => 1)) w.add(s.x, s.y, s.pressure)
  check('the page counts wear as the stroke does', near(sb.wearNow, w.value) && sb.wearNow > 0.1, `${sb.wearNow.toFixed(4)}`)
  const zero = new Wear({ ...DEFAULT_ERODIBLE, softness: 0 }, 30, 0.2)
  zero.add(0, 0, 1)
  zero.add(500, 0, 1)
  check('a tip with no softness doesn’t wear', zero.value === 0.2)
  const tri = dabsOf({ special: { ...DEFAULT_ERODIBLE, shape: 'triangle' } }, line(0, 0, 50, 0, 5), 0.5)
  check('a square or triangle draws its worn image; point, round and flat the round tip', tri.every((d) => d.tip === `gen:e:4:${Math.round(0.5 * (WEAR_LEVELS - 1))}`) && long.every((d) => d.tip === 'round'))
  const tilt = (s: PenSample[]) => s.map((x) => ({ ...x, tiltX: 60, tiltY: 0 }))
  const side = dabsOf(pencil, tilt(line(0, 0, 100, 0, 10)))
  check('tilted, a point draws with its side: wider and flatter, along the lean', side[0].size > long[0].size * 1.3 && side[0].roundness < 0.6 && near(side[0].angle, 0))
  // Airbrush: the spray leans.
  const air: Partial<BrushSettings> = { special: { ...DEFAULT_AIRBRUSH, distortion: 1 } }
  const upright = dabsOf(air, line(100, 100, 100.5, 100, 2))
  const leaning = dabsOf(air, line(100, 100, 100.5, 100, 2).map((x) => ({ ...x, tiltX: 0, tiltY: 60 })))
  check('an upright airbrush sprays round, where the pen is', near(upright[0].x, 100) && near(upright[0].y, 100) && upright[0].roundness === 1)
  check('tilted, it stretches the way the pen leans and moves that way', leaning[0].y > 100 + 3 && near(leaning[0].x, 100, 1e-6) && leaning[0].roundness < 0.7 && near(leaning[0].angle, Math.PI / 2) && leaning[0].size > upright[0].size)
  const sprays = new Set(dabsOf(air, line(0, 0, 300, 0, 30)).map((d) => d.tip))
  check('its dabs are of several variants', sprays.size >= 4 && [...sprays].every((t) => t.startsWith('gen:a:')))
  // The stylus wheel and Initial Rotation.
  const wheelFlow = brush({ flow: 0.8, dynamics: [{ input: 'wheel', target: 'flow', curve: [...LINEAR], min: 0 }] })
  const wheeled = strokeDabs(wheelFlow, 1, line(0, 0, 100, 0, 5).map((s) => ({ ...s, wheel: 0.25 })))
  check('the wheel sets flow through its control', wheeled.every((d) => near(d.flow, 0.2)))
  check('a pen without a wheel counts as turned full on', strokeDabs(wheelFlow, 1, line(0, 0, 100, 0, 5)).every((d) => near(d.flow, 0.8)))
  const turns = line(0, 0, 100, 0, 5).map((s, i) => ({ ...s, twist: 90 + i * 40 }))
  const init = strokeDabs(brush({ dynamics: [{ input: 'initial-twist', target: 'angle', curve: [...LINEAR], min: 0 }] }), 1, turns)
  check('Initial Rotation holds the pen’s rotation as the stroke began', init.every((d) => near(d.angle, Math.PI / 2)))
}

console.log('\nbrushes out as ABR, and Photoshop’s tool presets (TPL)')
{
  const userTip = { name: 'Mine', width: 5, height: 3, data: Uint8Array.from({ length: 15 }, (_, i) => i * 17) }
  const userId = tipId(userTip.width, userTip.height, userTip.data)
  const list = [...BRUSH_PRESETS.map((p) => ({ name: p.name, settings: presetSettings(p) })), { name: 'Own tip, curved', settings: brush({ tip: userId, size: 33, dynamics: [{ input: 'pressure', target: 'size', curve: [0, 0.3, 1], min: 0.2 }, { input: 'speed', target: 'opacity', curve: [...LINEAR], min: 0 }] }) }]
  const out = writeAbr(list, (id) => (id === userId ? userTip : null))
  const back = readAbr(out.bytes)
  check('every brush makes the round trip unchanged', back.presets.length === list.length && back.presets.every((p, i) => p.name === list[i].name && JSON.stringify(p.settings) === JSON.stringify(list[i].settings)))
  check('image tips go in once each, a user’s exactly', back.tips.some((t) => t.id === userId && t.data.every((v, i) => v === userTip.data[i])) && new Set(back.tips.map((t) => t.id)).size === back.tips.length)
  check('textures’ patterns go in with them', ['paper', 'rough', 'canvas'].every((n) => back.patterns.some((p) => p.name === n)))
  check('what Photoshop has no place for is named', out.notes.some((n) => n.includes('curves')) && out.notes.some((n) => n.includes('Speed')) && out.notes.some((n) => n.includes('footprint')))
  // Photoshop's keys alone, as Photoshop reads them: Plexel's own copy hidden.
  const bytes = Uint8Array.from(out.bytes)
  const text = new TextDecoder('latin1').decode(bytes)
  for (let at = text.indexOf('plexelBrush'); at >= 0; at = text.indexOf('plexelBrush', at + 1)) bytes[at] = 'q'.charCodeAt(0)
  const ps = readAbr(bytes)
  const by = (n: string) => ps.presets.find((p) => p.name === n)?.settings
  const cal = by('Calligraphy')
  const air = by('Spray Paint')
  const own = by('Own tip, curved')
  check('Photoshop’s keys alone: a round tip’s shape and control', !!cal && cal.tip === 'round' && near(cal.roundness, 0.25) && cal.angle === 45 && near(cal.hardness, 0.95) && cal.dynamics.some((d) => d.input === 'pressure' && d.target === 'size'))
  check('a special tip as an image of its footprint, a user’s tip as itself', !!air && air.tip.startsWith('tip:') && air.special === null && own?.tip === userId && own.size === 33)
  check('the options bar’s settings and Build-up', !!air && near(air.flow, 0.4) && air.buildUp && near(air.opacity, 1))

  // A TPL file as Photoshop lays one out: patterns, then the presets, each a name and a descriptor whose class is its tool.
  const tpl = (presets: [string, ReturnType<typeof desc>][]) => {
    const w = new Writer()
    w.sig('8BTP')
    w.u32(3)
    w.u32(4)
    const section = (key: string, body: () => void) => {
      w.sig('8BIM')
      w.sig(key)
      const end = w.mark()
      body()
      end()
      w.pad(4)
    }
    section('tppa', () => {})
    section('tpsh', () => {})
    section('tptp', () => {
      w.u32(presets.length)
      for (const [name, d] of presets) {
        w.unicode(`$$$/Presets/Tools/X=${name}`)
        w.u32(16)
        writeDescriptor(w, d)
      }
    })
    return w.done()
  }
  const t = readTpl(
    tpl([
      ['Soft Multiply', desc('paintbrushTool', [['Opct', D.long(50)], ['Md  ', D.enum('BlnM', 'Mltp')], ['Brsh', D.obj('computedBrush', [['Dmtr', D.unit('#Pxl', 64)], ['Hrdn', D.unit('#Prc', 10)], ['Angl', D.unit('#Ang', 0)], ['Rndn', D.unit('#Prc', 100)], ['Spcn', D.unit('#Prc', 25)], ['Intr', D.bool(true)]])], ['useTipDynamics', D.bool(true)], ['szVr', D.obj('brVr', [['bVTy', D.long(2)], ['jitter', D.unit('#Prc', 0)]])], ['minimumDiameter', D.unit('#Prc', 30)]])],
      ['Pencil', desc('pencilTool', [['Brsh', D.obj('computedBrush', [['Dmtr', D.unit('#Pxl', 3)], ['Hrdn', D.unit('#Prc', 0)]])]])],
      ['Loose Fill', desc('bucketTool', [['Md  ', D.enum('BlnM', 'Nrml')], ['Opct', D.long(40)], ['BckT', D.long(10)], ['BckA', D.bool(false)], ['BckS', D.bool(true)], ['Cntg', D.bool(false)]])],
      ['Radial Screen', desc('GrTl', [['Md  ', D.enum('BlnM', 'Scrn')], ['Opct', D.long(90)], ['GrdT', D.long(1)], ['GrdR', D.long(1)]])],
      ['Star', desc('polygonTool', [['sides', D.long(6)], ['indent', D.unit('#Prc', 40)], ['doIndent', D.bool(true)]])],
      ['Headline', desc('typeCreateOrEditTool', [['textToolCharacterOptions', D.obj('null', [['TxtS', D.obj('null', [['FntN', D.text('Inter')], ['FntS', D.text('Bold')], ['Sz  ', D.unit('#Pnt', 30)], ['Trck', D.long(50)]])]])], ['textToolParagraphOptions', D.obj('null', [['paragraphStyle', D.obj('null', [['Algn', D.enum('Alg ', 'Cntr')]])]])]])],
      ['Wand 5', desc('magicWandTool', [['Tlrn', D.long(5)], ['AntA', D.bool(false)], ['Cntg', D.bool(true)]])],
      ['Crop 4 × 6', desc('cropTool', [])],
      ['Sponge', desc('saturationTool', [])],
    ]),
  )
  const p = (n: string) => t.presets.find((x) => x.name === n)
  const soft = p('Soft Multiply')?.options.brush as BrushSettings | undefined
  check('a TPL file: the presets for tools Plexel has, by name', t.presets.length === 7 && p('Soft Multiply')?.tool === 'brush' && p('Loose Fill')?.tool === 'bucket' && p('Radial Screen')?.tool === 'gradient')
  check('a Brush preset: its tip, its control and its options beside it', !!soft && soft.size === 64 && near(soft.hardness, 0.1) && near(soft.opacity, 0.5) && soft.mode === 'multiply' && soft.dynamics.some((d) => d.input === 'pressure' && d.target === 'size' && near(d.min, 0.3)))
  check('Photoshop’s Pencil is the Brush, hard', p('Pencil')?.tool === 'brush' && (p('Pencil')?.options.brush as BrushSettings).hardness === 1)
  check('the Paint Bucket’s tolerance, anti-alias, all layers and contiguous', JSON.stringify(p('Loose Fill')?.options.bucket) === JSON.stringify({ blend: 'normal', opacity: 0.4, tolerance: 10, antialias: false, contiguous: false, sampleAll: true }))
  check('the Gradient tool by its short class: Radial, reversed, Screen at 90%', JSON.stringify(p('Radial Screen')?.options.gradient) === JSON.stringify({ blend: 'screen', opacity: 0.9, reverse: true, type: 'radial' }))
  check('a polygon with an indent is a star', JSON.stringify(p('Star')?.options.shape) === JSON.stringify({ type: 'star', points: 6, inner: 0.6 }))
  const type = p('Headline')?.options.type as { char: Record<string, unknown>; para: Record<string, unknown> } | undefined
  check('the Type tool: its font, size, tracking and alignment', !!type && type.char.font === 'Inter' && type.char.style === 'Bold' && type.char.size === 30 && type.char.tracking === 50 && type.para.align === 'centre')
  check('the Magic Wand’s tolerance and switches', JSON.stringify(p('Wand 5')?.options.wand) === JSON.stringify({ tolerance: 5, antialias: false, contiguous: true }))
  check('presets Plexel can’t use are left out, each said', t.warnings.some((x) => x.includes('Crop 4 × 6') && x.includes('Crop’s')) && t.warnings.some((x) => x.includes('Sponge') && x.includes('saturationTool')))
  let refused = false
  try {
    readTpl(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))
  } catch (e) {
    refused = e instanceof TplError
  }
  check('a file that isn’t one is refused', refused)
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
