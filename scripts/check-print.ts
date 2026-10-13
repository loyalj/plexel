/**
 * Print colour, headless: soft-proof tables against LittleCMS's own
 * conversions chained, the gamut check, the display look's reference
 * (inks hidden, ink limit), the CMYK adjustment tables (forward against the
 * profile, inverse holding black, identity kept exactly), documents
 * converted (every colour it keeps, its pixel sets, what's dropped), tile
 * sets converted against the colour engine and requantised exactly,
 * document swatches (linking, tints, edits, mode changes, saving), and
 * Adobe Swatch Exchange files.
 *
 * Run with: npm run check:print
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FLAGS, startCms } from '../src/color/cms'
import { buildConvertLut, runConvertLut } from '../src/color/convertLut'
import { CT_K, CT_SIZE, buildCmykTables, cmykToRgbT, rgbToCmyT } from '../src/color/cmykAdjust'
import { PLAIN_LOOK, buildLookLut, displayRef, gamutFlags, lutGamut, sampleLut } from '../src/color/lut'
import { deltaE2000 } from '../src/color/models'
import { ProfileRegistry } from '../src/color/profiles'
import { DEFAULT_LOOK, tableKey } from '../src/color/proof'
import { programFor, runProgram } from '../src/adjust/defs'
import { convertDoc, pixelSets } from '../src/doc/convert'
import { DEFAULT_PROFILES, createDoc, insertNode } from '../src/doc/edit'
import { makeNode } from '../src/doc/nodes'
import { docToJson, readDocJson } from '../src/doc/serialize'
import { addSwatch, linkable, recolourLinked, removeSwatch, swatchPaint, swatchUses, tinted, updateSwatch, type DocSwatch, type SwatchColourFn } from '../src/doc/swatches'
import type { Doc, DocNode } from '../src/doc/types'
import { fillItem, solid, strokeItem, type Paint } from '../src/doc/vector'
import { readAse, writeAse } from '../src/io/ase'
import { convertSet } from '../src/tiles/convert'
import { TILE_PIXELS, newSamples } from '../src/tiles/format'
import { memorySpill } from '../src/tiles/spill'
import { TileStore } from '../src/tiles/store'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}
const fmt = (x: number) => (Math.abs(x) < 1e-3 && x !== 0 ? x.toExponential(1) : x.toFixed(4))
let seed = 11
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)

const cms = await startCms(readFileSync(join(process.cwd(), 'src/color/wasm/pxcms.wasm')))
const registry = new ProfileRegistry(cms, new Map())
const srgb = registry.builtin('srgb')
const p3 = registry.builtin('display-p3')
const cmyk = registry.builtin('generic-cmyk')
const adobe = registry.builtin('adobe-rgb-compatible')
const gray = registry.builtin('gray-gamma-2.2')
const lab = registry.lab()
const toLab = (p: typeof srgb) => cms.transform(p, lab, 'relative', 0)

// --- soft-proofing --------------------------------------------------------------------------------
console.log('\nsoft-proofing')
{
  // An RGB document proofed on CMYK, shown on sRGB: the table against the two conversions chained.
  const cond = { profile: cmyk, intent: 'relative' as const, bpc: true, paper: false, black: false }
  const lut = buildLookLut(cms, adobe, srgb, { proof: cond })
  const t1 = cms.transform(adobe, cmyk, 'relative', FLAGS.blackPointCompensation)
  const t2 = cms.transform(cmyk, srgb, 'relative', FLAGS.blackPointCompensation)
  let worst = 0
  for (let i = 0; i < 300; i++) {
    const c = [rand(), rand(), rand()]
    const want = t2.one(t1.one(c).map((v) => Math.min(1, Math.max(0, v))))
    const got = sampleLut(lut, c)
    worst = Math.max(worst, deltaE2000(toLab(srgb).one(got), toLab(srgb).one(want)))
  }
  check('an RGB document proofed on CMYK: the table is the conversion there and back to the screen', worst < 1.5, `worst ${fmt(worst)} ΔE2000`)
  // Proofing changes what's shown: a saturated blue can't be printed, so its proof is duller.
  const plain = buildLookLut(cms, adobe, srgb)
  const blue = [0.05, 0.1, 1]
  const chroma = (rgb: number[]) => {
    const [, a, b] = toLab(srgb).one(rgb)
    return Math.hypot(a, b)
  }
  check('a colour the press can’t print is shown as it would print: duller', chroma(sampleLut(lut, blue)) < chroma(sampleLut(plain, blue)) - 10, `${chroma(sampleLut(plain, blue)).toFixed(0)} → ${chroma(sampleLut(lut, blue)).toFixed(0)} chroma`)
  // Simulating black ink shows the ink's own black, lighter than the screen's.
  const ink = buildLookLut(cms, adobe, srgb, { proof: { ...cond, black: true } })
  const L = (rgb: number[]) => toLab(srgb).one(rgb)[0]
  check('simulating black ink shows black as the ink prints it, not the screen’s black', L(sampleLut(ink, [0, 0, 0])) > L(sampleLut(lut, [0, 0, 0])) + 2, `L ${L(sampleLut(lut, [0, 0, 0])).toFixed(1)} → ${L(sampleLut(ink, [0, 0, 0])).toFixed(1)}`)
  // A CMYK document proofed on its own profile looks as it does unproofed.
  const own = buildLookLut(cms, cmyk, srgb, { proof: cond })
  const unproofed = buildLookLut(cms, cmyk, srgb)
  let diff = 0
  for (let i = 0; i < 200; i++) {
    const c = [rand(), rand(), rand(), rand() * 0.6]
    diff = Math.max(diff, deltaE2000(toLab(srgb).one(sampleLut(own, c)), toLab(srgb).one(sampleLut(unproofed, c))))
  }
  check('a CMYK document proofed on its own condition looks as it does unproofed', diff < 2, `worst ${fmt(diff)} ΔE2000`)
  check('a look’s table key changes with the condition and not with the inks', tableKey({ ...DEFAULT_LOOK, proof: true }) !== tableKey(DEFAULT_LOOK) && tableKey({ ...DEFAULT_LOOK, inks: [false, true, true, true] }) === tableKey(DEFAULT_LOOK))
  for (const t of [t1, t2]) t.close()
}

// --- the gamut warning ------------------------------------------------------------------------------
console.log('\nthe gamut warning')
{
  const pts = new Float32Array([0.5, 0.5, 0.5, 0.05, 0.1, 1, 0, 1, 0, 0.8, 0.6, 0.5, 1, 1, 1, 0, 0, 0])
  const f = gamutFlags(cms, srgb, cmyk, 'relative', true, pts, 6)
  check('grey, a skin tone, white and black can be printed', f[0] === 0 && f[3] === 0 && f[4] === 0 && f[5] === 0, [...f].join(''))
  check('saturated blue and green can’t', f[1] === 1 && f[2] === 1, [...f].join(''))
  const p3green = gamutFlags(cms, p3, srgb, 'relative', true, new Float32Array([0, 1, 0, 0.5, 0.5, 0.5]), 2)
  check('against an RGB condition too: Display P3’s green is outside sRGB, its grey isn’t', p3green[0] === 1 && p3green[1] === 0)
  const lut = buildLookLut(cms, srgb, srgb, { gamut: { profile: cmyk, intent: 'relative', bpc: true } })
  check('the table carries it: marked past half, the colour itself untouched', lutGamut(lut, [0.05, 0.1, 1]) > 0.5 && lutGamut(lut, [0.5, 0.5, 0.5]) < 0.5 && Math.abs(sampleLut(lut, [0.5, 0.5, 0.5])[0] - 0.5) < 2e-3)
  const look = { ...PLAIN_LOOK, gamut: true }
  check('and the display marks it in the alarm colour', displayRef(lut, look, [0.05, 0.1, 1]).every((v, i) => v === look.alarm[i]) && displayRef(lut, look, [0.5, 0.5, 0.5])[0] !== look.alarm[0] + 1)
}

// --- separations ------------------------------------------------------------------------------------
console.log('\nseparations')
{
  const lut = buildLookLut(cms, cmyk, srgb)
  const c = [0.6, 0.3, 0.2, 0.4]
  const cyanOnly = displayRef(lut, { ...PLAIN_LOOK, inks: [true, false, false, false] }, c)
  check('one ink shown is that ink alone, the others as none', Math.max(...cyanOnly.map((v, i) => Math.abs(v - sampleLut(lut, [0.6, 0, 0, 0])[i]))) < 1e-9)
  const over = { ...PLAIN_LOOK, inkLimit: 3 }
  check('coverage over the limit is marked, under it isn’t', displayRef(lut, over, [1, 1, 1, 0.5]).every((v, i) => v === over.inkAlarm[i]) && displayRef(lut, over, c).some((v, i) => v !== over.inkAlarm[i]))
}

// --- CMYK colour adjustments ------------------------------------------------------------------------
console.log('\nCMYK colour adjustments through the profile')
{
  const t0 = performance.now()
  const tables = buildCmykTables(cms, cmyk, adobe)
  const ms = performance.now() - t0
  check('the tables are made from the profile', tables.size === CT_SIZE && tables.kSlices === CT_K, `${ms.toFixed(0)} ms`)
  const fwd = cms.transform(cmyk, adobe, 'relative', FLAGS.blackPointCompensation)
  let worst = 0
  let sum = 0
  for (let i = 0; i < 500; i++) {
    const light = [rand(), rand(), rand(), rand()]
    const want = fwd.one(light.map((v) => 1 - v))
    const e = deltaE2000(toLab(adobe).one(cmykToRgbT(tables, light)), toLab(adobe).one(want))
    worst = Math.max(worst, e)
    sum += e
  }
  // The display tables' measure (check:color): small on average, a little more in the deepest shadows.
  check('forward: a CMYK colour reads as its profile says', sum / 500 < 0.3 && worst < 3, `mean ${fmt(sum / 500)}, worst ${fmt(worst)} ΔE2000`)
  // Inverse: back to C, M, Y with K held, for colours that ink can make.
  let back = 0
  for (let i = 0; i < 200; i++) {
    const light = [0.15 + rand() * 0.7, 0.15 + rand() * 0.7, 0.15 + rand() * 0.7, 0.3 + rand() * 0.7]
    const rgb = cmykToRgbT(tables, light)
    const cmy = rgbToCmyT(tables, rgb, light[3])
    back = Math.max(back, deltaE2000(toLab(adobe).one(cmykToRgbT(tables, [...cmy, light[3]])), toLab(adobe).one(rgb)))
  }
  check('inverse: the C, M, Y found with black held make the same colour', back < 1.5, `worst ${fmt(back)} ΔE2000`)
  const id = programFor('hue-saturation', { hue: 0, saturation: 0, lightness: 0 }, 'cmyk')!
  let moved = 0
  for (let i = 0; i < 100; i++) {
    const c = [rand(), rand(), rand(), rand()]
    const out = runProgram(id, 'cmyk', c, tables)
    moved = Math.max(moved, ...out.map((v, k) => Math.abs(v - c[k])))
  }
  check('an adjustment that changes nothing leaves CMYK exactly as it was', moved < 1e-6, `worst ${fmt(moved)}`)
  const hue = programFor('hue-saturation', { hue: 120, saturation: 0, lightness: 0 }, 'cmyk')!
  const red = [1 - 0, 1 - 0.9, 1 - 0.85, 1 - 0.1]
  const turned = runProgram(hue, 'cmyk', red, tables)
  const before = toLab(adobe).one(cmykToRgbT(tables, red))
  const after = toLab(adobe).one(cmykToRgbT(tables, turned))
  const hueOf = ([, a, b]: number[]) => (Math.atan2(b, a) * 180) / Math.PI
  check('turning a red by 120° makes it green, through the profile', Math.abs(((hueOf(after) - hueOf(before) + 540) % 360) - 180) > 60 && after[1] < 0, `hue ${hueOf(before).toFixed(0)}° → ${hueOf(after).toFixed(0)}°`)
  check('and black ink stays where it was', turned[3] === red[3])
  const desat = runProgram(programFor('hue-saturation', { hue: 0, saturation: -100, lightness: 0 }, 'cmyk')!, 'cmyk', red, tables)
  const [, da, db] = toLab(adobe).one(cmykToRgbT(tables, desat))
  check('desaturating a CMYK colour makes it neutral', Math.hypot(da, db) < 6, `chroma ${Math.hypot(da, db).toFixed(1)}`)
  fwd.close()
}

// --- documents converted ----------------------------------------------------------------------------
console.log('\ndocuments converted')
{
  let doc = createDoc({ name: 'Flyer', width: 600, height: 400, resolution: 300, mode: 'rgb', depth: 8, profile: DEFAULT_PROFILES.rgb }, 'root')
  const px = makeNode('pixel', 'px', 'Photo', { tiles: 'set-a', resample: 'bicubic' })
  px.fx = [{ kind: 'colour-overlay', enabled: true, params: { colour: [1, 0, 0] } }]
  doc = insertNode(doc, px, 'root', 0)
  doc = insertNode(doc, makeNode('vector', 'v', 'Shape', { geometry: null, appearance: [fillItem(solid([0, 0, 1])), strokeItem({ kind: 'gradient', type: 'linear', stops: [{ at: 0, colour: [1, 1, 0], alpha: 1 }, { at: 1, colour: [0, 1, 1], alpha: 1 }], angle: 0, scale: 100, reverse: false }, 2)] }), 'root', 1)
  doc = insertNode(doc, makeNode('adjustment', 'gm', 'Gradient Map', { adjustment: 'gradient-map', params: { gradient: [{ at: 0, colour: [0, 0, 0] }, { at: 1, colour: [1, 0.5, 0] }] } }), 'root', 2)
  doc = insertNode(doc, makeNode('adjustment', 'cv', 'Curves', { adjustment: 'curves', params: { curves: { master: [[0, 0.1], [1, 1]], red: [[0, 0], [0.5, 0.7], [1, 1]] } } }), 'root', 3)
  const inner = insertNode(createDoc({ name: 'Inside', width: 100, height: 100, resolution: 300, mode: 'rgb', depth: 8, profile: DEFAULT_PROFILES.rgb }, 'r2'), makeNode('pixel', 'p2', 'Inner', { tiles: 'set-b', resample: 'bicubic' }), 'r2', 0)
  doc = insertNode(doc, makeNode('embedded', 'so', 'Smart', { asset: null, content: inner }), 'root', 4)
  check('every pixel set is found, smart objects’ contents too', pixelSets(doc).sort().join() === 'set-a,set-b')
  const seen: number[][] = []
  const fn = (c: number[]) => {
    seen.push(c)
    return [c[0], c[1], c[2], 0.5]
  }
  const r = convertDoc(doc, { mode: 'cmyk', profile: DEFAULT_PROFILES.cmyk, depth: 16 }, fn, new Map([['set-a', 'set-a2'], ['set-b', 'set-b2']]))
  const n = r.doc.nodes as Record<string, DocNode>
  const fills = (n.v as Extract<DocNode, { kind: 'vector' }>).props.appearance
  check('the document is in its new mode, profile and depth', r.doc.mode === 'cmyk' && r.doc.depth === 16 && JSON.stringify(r.doc.profile) === JSON.stringify(DEFAULT_PROFILES.cmyk))
  check('pixels go to their converted sets, in smart objects too', (n.px as Extract<DocNode, { kind: 'pixel' }>).props.tiles === 'set-a2' && ((n.so as Extract<DocNode, { kind: 'embedded' }>).props.content!.nodes.p2 as Extract<DocNode, { kind: 'pixel' }>).props.tiles === 'set-b2')
  check('the smart object’s contents are in the new mode too', (n.so as Extract<DocNode, { kind: 'embedded' }>).props.content!.mode === 'cmyk')
  const p0 = fills[0].paint as Extract<Paint, { kind: 'solid' }>
  const p1 = fills[1].paint as Extract<Paint, { kind: 'gradient' }>
  check('fills and gradient stops are converted', p0.colour.length === 4 && p1.stops.every((s) => s.colour.length === 4))
  check('effects’ colours are converted', ((n.px.fx[0].params.colour as number[]) ?? []).length === 4)
  check('adjustments’ gradients are converted', ((n.gm as Extract<DocNode, { kind: 'adjustment' }>).props.params.gradient as { colour: number[] }[]).every((s) => s.colour.length === 4))
  const curves = (n.cv as Extract<DocNode, { kind: 'adjustment' }>).props.params.curves as Record<string, unknown>
  check('Curves keeps its master curve, and drops the old mode’s channels, saying so', JSON.stringify(curves.master) === JSON.stringify([[0, 0.1], [1, 1]]) && !('red' in curves) && r.warnings.some((w) => /Curves/.test(w)))
  check('masks and the selection aren’t colour: left as they were', r.doc.selection === doc.selection)
  const lost = convertDoc(doc, { mode: 'cmyk', profile: DEFAULT_PROFILES.cmyk, depth: 8 }, fn, new Map())
  check('a layer whose pixels weren’t converted is emptied, and that’s said', (lost.doc.nodes.px as Extract<DocNode, { kind: 'pixel' }>).props.tiles === null && lost.warnings.some((w) => /pixels/.test(w)))
  // Patterns are pixels too, and fill layers' paints are colours.
  const withPat: typeof doc = {
    ...doc,
    patterns: [{ id: 'pt', name: 'P', tiles: 'set-p', width: 8, height: 8 }],
    nodes: { ...doc.nodes, fl: makeNode('fill', 'fl', 'Fill', { paint: { kind: 'solid', colour: [0.2, 0.4, 0.6] } }) },
  }
  check('a document’s patterns are among its pixel sets', pixelSets(withPat).includes('set-p'))
  const cp = convertDoc(withPat, { mode: 'cmyk', profile: DEFAULT_PROFILES.cmyk, depth: 8 }, fn, new Map([['set-a', 'a2'], ['set-b', 'b2'], ['set-p', 'p2']]))
  const fl = cp.doc.nodes.fl as Extract<DocNode, { kind: 'fill' }>
  check('patterns go to their converted sets, fill layers’ colours are converted', cp.doc.patterns?.[0].tiles === 'p2' && fl.props.paint.kind === 'solid' && fl.props.paint.colour.length === 4)
  const noPat = convertDoc(withPat, { mode: 'cmyk', profile: DEFAULT_PROFILES.cmyk, depth: 8 }, fn, new Map())
  check('a pattern that wasn’t converted is left out, and that’s said', !noPat.doc.patterns?.length && noPat.warnings.some((w) => /pattern/.test(w)))
}

// --- tile sets converted ----------------------------------------------------------------------------
console.log('\ntile sets converted')
{
  const store = new TileStore({ budget: 1e9, spill: memorySpill(), shared: false })
  const f8 = { mode: 'rgb' as const, depth: 8 as const }
  const s = newSamples(f8)
  for (let p = 0; p < TILE_PIXELS; p++) {
    s[p] = p & 255
    s[TILE_PIXELS + p] = (p >> 8) & 255
    s[2 * TILE_PIXELS + p] = (p * 7) & 255
    s[3 * TILE_PIXELS + p] = p % 3 ? 255 : 128
  }
  const data = store.data(f8, s)
  const flat = store.uniform(f8, [200, 30, 40, 255])
  const set = store.createSet(f8, [[0, 0, data], [1, 0, flat], [2, 0, flat]])
  const t = cms.transform(srgb, cmyk, 'relative', FLAGS.blackPointCompensation)
  const out = await convertSet(store, set, { mode: 'cmyk', depth: 16 }, (c, n) => t.run(c, n))
  const got = store.getSet(out)
  check('a converted set is in the new format, every tile there', got.format.mode === 'cmyk' && got.format.depth === 16 && got.tiles.size === 3)
  const u = store.isUniform(got.tiles.get('1,0')!)
  const want = t.one([200 / 255, 30 / 255, 40 / 255])
  check('a uniform tile stays one value, converted once, and shared where it was', !!u && u.slice(0, 4).every((v, i) => Math.abs(v / 65535 - want[i]) < 1 / 65535) && u[4] === 65535 && got.tiles.get('1,0') === got.tiles.get('2,0'))
  const o = await store.samples(got.tiles.get('0,0')!)
  let worst = 0
  let alphaOk = true
  for (let i = 0; i < 400; i++) {
    const p = Math.floor(rand() * TILE_PIXELS)
    const w = t.one([s[p] / 255, s[TILE_PIXELS + p] / 255, s[2 * TILE_PIXELS + p] / 255])
    for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(o[c * TILE_PIXELS + p] / 65535 - w[c]))
    if (o[4 * TILE_PIXELS + p] !== s[3 * TILE_PIXELS + p] * 257) alphaOk = false
  }
  check('every pixel is the colour engine’s conversion, quantised', worst <= 1 / 65535, `worst ${fmt(worst * 65535)} steps`)
  check('alpha is kept, rescaled exactly to 16 bits', alphaOk)
  const deep = await convertSet(store, set, { mode: 'rgb', depth: 16 }, null)
  const d = await store.samples(store.getSet(deep).tiles.get('0,0')!)
  let exact = true
  for (let p = 0; p < TILE_PIXELS * 4; p += 97) if (d[p] !== s[p] * 257) exact = false
  check('8 to 16 bits alone is exact: every sample times 257', exact)
  const back = await convertSet(store, deep, f8, null)
  const b = await store.samples(store.getSet(back).tiles.get('0,0')!)
  check('and back to 8 bits gives the same samples', b.every((v, i) => v === s[i]))
  check('the old set is still there, for Undo', store.hasSet(set))
  t.close()
}

// --- converting many pixels -----------------------------------------------------------------------
console.log('\nconverting many pixels: the conversion sampled on a grid')
{
  const pairs: [string, typeof srgb, typeof srgb][] = [
    ['RGB to CMYK', srgb, cmyk],
    ['CMYK to RGB', cmyk, adobe],
    ['Gray to RGB', gray, srgb],
    ['RGB to Gray', p3, gray],
    ['CMYK to Gray', cmyk, gray],
  ]
  for (const [name, from, to] of pairs) {
    const lut = buildConvertLut(cms, from, to, 'relative', true)
    const t = cms.transform(from, to, 'relative', FLAGS.blackPointCompensation)
    const n = 20000
    const input = new Float32Array(n * from.channels)
    for (let i = 0; i < input.length; i++) input[i] = rand()
    const t0 = performance.now()
    const got = runConvertLut(lut, input, n)
    const mpx = n / (performance.now() - t0) / 1000
    const want = t.run(input, n)
    const lt = toLab(to)
    let worst = 0
    let sum = 0
    const gl = lt.run(got, n)
    const wl = lt.run(want, n)
    for (let i = 0; i < n; i++) {
      const e = deltaE2000([gl[i * 3], gl[i * 3 + 1], gl[i * 3 + 2]], [wl[i * 3], wl[i * 3 + 1], wl[i * 3 + 2]])
      worst = Math.max(worst, e)
      sum += e
    }
    check(`${name}: within a ΔE2000 of the colour engine’s own answer, the deepest shadows too`, sum / n < 0.1 && worst < 1, `mean ${fmt(sum / n)}, worst ${fmt(worst)}`)
    void mpx
    t.close()
  }
}

// --- document swatches ------------------------------------------------------------------------------
console.log('\ndocument swatches')
{
  const conv = (s: DocSwatch, tint: number, mode: 'rgb' | 'cmyk') => {
    const t = cms.transform(s.colour.space === 'cmyk' ? cmyk : srgb, mode === 'cmyk' ? cmyk : srgb, 'relative', FLAGS.blackPointCompensation)
    const c = s.colour.space === mode ? s.colour.c : t.one(s.colour.c)
    t.close()
    return tinted(c, mode, tint)
  }
  const inRgb: SwatchColourFn = (s, t) => conv(s, t, 'rgb')
  let doc = createDoc({ name: 'Brand', width: 100, height: 100, resolution: 300, mode: 'rgb', depth: 8, profile: DEFAULT_PROFILES.rgb }, 'root')
  const spot: DocSwatch = { id: 'w1', name: 'House Red', kind: 'spot', colour: { space: 'cmyk', profile: DEFAULT_PROFILES.cmyk, c: [0, 0.9, 0.8, 0] } }
  const proc: DocSwatch = { id: 'w2', name: 'Grey', kind: 'process', colour: { space: 'rgb', profile: DEFAULT_PROFILES.rgb, c: [0.5, 0.5, 0.5] } }
  doc = addSwatch(addSwatch(doc, spot), proc)
  const linked = swatchPaint(spot, 0.5, inRgb)
  const plain = swatchPaint(proc, 0.5, inRgb)
  check('a spot swatch links the paint, at its tint; a process one only gives its colour', (linked as { swatch?: string; tint?: number }).swatch === 'w1' && (linked as { tint?: number }).tint === 0.5 && !('swatch' in plain) && linkable(spot) && !linkable(proc))
  check('a tint is the ink scaled in CMYK, towards white in RGB', tinted([0, 0.9, 0.8, 0], 'cmyk', 0.5).join() === [0, 0.45, 0.4, 0].join() && tinted([0, 1, 0], 'rgb', 0.5).join() === [0.5, 1, 0.5].join())
  doc = insertNode(doc, makeNode('vector', 'a', 'A', { geometry: null, appearance: [fillItem(linked)] }), 'root', 0)
  doc = insertNode(doc, makeNode('text', 't', 'T', { mode: 'point', content: { paragraphs: [{ runs: [{ text: 'x', style: null, props: {} }], style: null, props: {} }] }, frame: null, pathOffset: 0, appearance: [fillItem(swatchPaint(spot, 1, inRgb))] }), 'root', 1)
  check('the document counts each swatch’s uses', swatchUses(doc).get('w1') === 2)
  const fillOf = (d: Doc, id: string) => ((d.nodes[id] as Extract<DocNode, { kind: 'vector' }>).props.appearance[0].paint as Extract<Paint, { kind: 'solid' }>)
  const blue = { space: 'rgb' as const, profile: DEFAULT_PROFILES.rgb, c: [0, 0, 1] }
  const changed = updateSwatch(doc, 'w1', { colour: blue }, inRgb)
  check('changing a spot swatch changes every fill linked to it, at its own tint', fillOf(changed, 'a').colour.join() === [0.5, 0.5, 1].join() && fillOf(changed, 't').colour.join() === [0, 0, 1].join())
  const json = docToJson(changed)
  const back = readDocJson(json)
  check('swatches and links survive saving', back.ok && back.doc.swatches?.length === 2 && fillOf(back.doc, 'a').swatch === 'w1' && fillOf(back.doc, 'a').tint === 0.5 && back.doc.swatches[0].kind === 'spot')
  const removed = removeSwatch(changed, 'w1')
  check('deleting a swatch unlinks its fills, which keep their colour', !fillOf(removed, 'a').swatch && fillOf(removed, 'a').colour.join() === fillOf(changed, 'a').colour.join() && removed.swatches!.length === 1)
  const asCmyk = recolourLinked({ ...doc, mode: 'cmyk', profile: DEFAULT_PROFILES.cmyk }, (s, t) => conv(s, t, 'cmyk'))
  check('after a change to CMYK a spot’s fills are its own CMYK numbers, tinted, not a round trip', fillOf(asCmyk, 'a').colour.map((v) => +v.toFixed(6)).join() === [0, 0.45, 0.4, 0].join())
  const raw = JSON.parse(json)
  const broken = readDocJson(JSON.stringify({ ...raw, doc: { ...raw.doc, swatches: [{ id: 'x', name: 'Bad', kind: 'spot', colour: { space: 'cmyk', c: [1] } }, 'nonsense'] } }))
  check('unreadable swatches are left out and said', broken.ok && broken.doc.swatches!.length === 0 && broken.warnings.some((w) => /swatch/.test(w)))
}

// --- Adobe Swatch Exchange --------------------------------------------------------------------------
console.log('\nAdobe Swatch Exchange')
{
  const list: Omit<DocSwatch, 'id'>[] = [
    { name: 'House Red', kind: 'spot', colour: { space: 'cmyk', profile: DEFAULT_PROFILES.cmyk, c: [0, 0.9, 0.8, 0] } },
    { name: 'Sky', kind: 'global', colour: { space: 'rgb', profile: DEFAULT_PROFILES.rgb, c: [0.2, 0.6, 0.9] } },
    { name: 'Lab grün', kind: 'process', colour: { space: 'lab', profile: null, c: [60, -50, 40] } },
    { name: 'Mid', kind: 'process', colour: { space: 'gray', profile: DEFAULT_PROFILES.gray, c: [0.5] } },
  ]
  const bytes = writeAse(list)
  check('written as an ASEF file, version 1, a block each', String.fromCharCode(...bytes.subarray(0, 4)) === 'ASEF' && new DataView(bytes.buffer).getUint32(8) === 4)
  const r = readAse(bytes)
  const same = (a: number[], b: number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
  check('read back: names (Unicode too), kinds, models and numbers', r.ok && r.swatches.length === 4 && r.swatches.every((s, i) => s.name === list[i].name && s.kind === list[i].kind && s.colour.space === list[i].colour.space && same(s.colour.c, list[i].colour.c, 1e-5)))
  // A file as another app writes it: a group round its colours.
  const group = new Uint8Array([0x41, 0x53, 0x45, 0x46, 0, 1, 0, 0, 0, 0, 0, 3, 0xc0, 0x01, 0, 0, 0, 12, 0, 5, 0, 66, 0, 114, 0, 97, 0, 110, 0, 0])
  const inner = writeAse([list[1]]).subarray(12)
  const end = new Uint8Array([0xc0, 0x02, 0, 0, 0, 0])
  const file = new Uint8Array([...group, ...inner, ...end])
  const g = readAse(file)
  check('colours inside a group are read', g.ok && g.swatches.length === 1 && g.swatches[0].name === 'Sky')
  const notAse = readAse(new TextEncoder().encode('GIMP Palette\nName: x\n'))
  const short = readAse(bytes.subarray(0, bytes.length - 5))
  check('a file that isn’t one, or ends early, is refused saying so', !notAse.ok && !short.ok && /isn’t/.test(notAse.error) && /ends/.test(short.error))
}

for (const p of [lab]) p.close()
void gray
console.log(`\n${failures === 0 ? 'all clear' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
