/**
 * Colour: the LittleCMS engine, every built-in profile, the generic CMYK
 * ink model, finding a document's profile, converting colours (with gamut
 * warnings), the picker models, and the display lookup tables.
 *
 * Values are held to published references where there are some: sRGB's
 * primaries in Lab, Display P3 and Adobe RGB conversions, the CIEDE2000
 * test pairs from Sharma, Wu and Dalal. Differences are reported in
 * ΔE2000, the measure that matches what people see; under 1 is invisible.
 *
 * Run with: npm run check:color
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CmsError, startCms } from '../src/color/cms'
import { cmykToLab, labToCmyk } from '../src/color/cmykModel'
import { buildDisplayLut, sampleLut } from '../src/color/lut'
import { deltaE2000, formatHex, hsbToRgb, hslToRgb, labToLch, lchToLab, parseHex, rgbToHsb, rgbToHsl } from '../src/color/models'
import { BUILTIN_PROFILES, DEFAULT_PROFILE_ID, ProfileRegistry } from '../src/color/profiles'
import { Converter } from '../src/color/value'
import { DEFAULT_PROFILES } from '../src/doc/edit'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}
const fmt = (v: number[]) => v.map((x) => x.toFixed(3)).join(', ')
const close = (a: number[], b: number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
let seed = 7
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)

const cms = await startCms(readFileSync(join(process.cwd(), 'src/color/wasm/pxcms.wasm')))
const assets = new Map<string, Uint8Array>()
const registry = new ProfileRegistry(cms, assets)
const conv = new Converter(registry)
const lab = registry.lab()
const srgb = registry.builtin('srgb')

// --- the engine ----------------------------------------------------------------
console.log('\nengine')
const toLab = cms.transform(srgb, lab)
// Lindbloom's sRGB primaries under D50.
const refs: [number[], number[], string][] = [
  [[1, 1, 1], [100, 0, 0], 'white'],
  [[1, 0, 0], [54.29, 80.8, 69.89], 'red'],
  [[0, 1, 0], [87.82, -79.29, 80.99], 'green'],
  [[0, 0, 1], [29.57, 68.3, -112.03], 'blue'],
  [[0.5, 0.5, 0.5], [53.39, 0, 0], '50% grey'],
]
for (const [rgb, want, name] of refs) {
  const got = toLab.one(rgb)
  check(`sRGB ${name} is Lab ${fmt(want)}`, deltaE2000(got, want) < 0.1, fmt(got))
}
let refused = ''
try {
  cms.openProfile(new Uint8Array([1, 2, 3, 4]))
} catch (e) {
  refused = e instanceof CmsError ? e.message : ''
}
check('bytes that aren’t a profile are refused with a reason', /not a usable ICC profile/.test(refused), refused)

// --- built-in profiles -------------------------------------------------------------
console.log('\nbuilt-in profiles')
for (const def of BUILTIN_PROFILES) {
  const p = registry.builtin(def.id)
  check(`${def.name}: builds as a ${def.mode.toUpperCase()} profile`, p.space === def.mode, `${p.space}, ${p.channels} channels`)
  const bytes = p.bytes()
  const again = cms.openProfile(bytes)
  const probe = def.mode === 'gray' ? [0.3] : def.mode === 'cmyk' ? [0.2, 0.5, 0.1, 0.3] : [0.2, 0.6, 0.9]
  const a = cms.transform(p, lab).one(probe)
  const b = cms.transform(again, lab).one(probe)
  check(`${def.name}: survives being saved as ICC bytes and read back`, deltaE2000(a, b) < 0.01 && again.description === p.description, `${bytes.length} bytes, “${again.description}”`)
  again.close()
}
check('the document defaults name built-in profiles of their own mode', (['rgb', 'gray', 'cmyk'] as const).every((m) => 'builtin' in DEFAULT_PROFILES[m] && DEFAULT_PROFILES[m].builtin === DEFAULT_PROFILE_ID[m]))

const srgbTo = (id: string, rgb: number[]) => cms.transform(srgb, registry.builtin(id), 'relative', 0).one(rgb)
check('sRGB red in Display P3 is about 0.917, 0.200, 0.139', close(srgbTo('display-p3', [1, 0, 0]), [0.9175, 0.2003, 0.1387], 0.003), fmt(srgbTo('display-p3', [1, 0, 0])))
check('sRGB red in Adobe RGB is about 0.859, 0, 0', close(srgbTo('adobe-rgb-compatible', [1, 0, 0]), [0.8587, 0, 0], 0.01), fmt(srgbTo('adobe-rgb-compatible', [1, 0, 0])))
check('Display P3 green is outside sRGB', cms.transform(registry.builtin('display-p3'), srgb, 'relative', 0).one([0, 1, 0])[0] < -0.01)
const g22 = cms.transform(registry.builtin('gray-gamma-2.2'), lab).one([0.5])
check('Gray Gamma 2.2 puts a 50% grey at L* 53.8', Math.abs(g22[0] - 53.78) < 0.2, fmt(g22))
const g18 = cms.transform(registry.builtin('gray-gamma-1.8'), lab).one([0.5])
check('Gray Gamma 1.8 puts a 50% grey lighter, at L* 60.5', Math.abs(g18[0] - 60.53) < 0.2, fmt(g18))

// --- the CMYK ink model --------------------------------------------------------------
console.log('\ngeneric CMYK')
let worstModel = 0
for (let i = 0; i < 500; i++) {
  const cmyk = [rand(), rand(), rand(), rand() * 0.6]
  const l = cmykToLab(cmyk)
  worstModel = Math.max(worstModel, deltaE2000(l, cmykToLab(labToCmyk(l))))
}
check('the model inverts exactly: Lab → CMYK → Lab comes back', worstModel < 0.01, `worst ΔE2000 ${worstModel.toFixed(4)}`)
check('paper white needs no ink', labToCmyk([100, 0, 0]).every((v) => v < 0.005), fmt(labToCmyk([100, 0, 0])))
const grey = labToCmyk([50, 0, 0])
check('a mid grey prints mostly with black (grey component replacement)', grey[3] > grey[0] && grey[3] > 0.3, fmt(grey))
const light = labToCmyk([92, 0, 0])
check('a light grey has no black, so highlights stay clean', light[3] < 0.005, fmt(light))
const blackL = cmykToLab([1, 1, 1, 1])[0]
check('the darkest black isn’t perfectly black', blackL > 10 && blackL < 25, `L* ${blackL.toFixed(1)}`)

const cmykP = registry.builtin('generic-cmyk')
const fwd = cms.transform(cmykP, lab)
let sum = 0
let worst = 0
for (let i = 0; i < 1000; i++) {
  const c = [rand(), rand(), rand(), rand()]
  const d = deltaE2000(fwd.one(c), cmykToLab(c))
  sum += d
  worst = Math.max(worst, d)
}
check('the profile’s CMYK → Lab table matches the model', sum / 1000 < 0.3 && worst < 1.5, `mean ${(sum / 1000).toFixed(3)}, worst ${worst.toFixed(3)} ΔE2000`)
const back = cms.transform(lab, cmykP)
sum = 0
worst = 0
for (let i = 0; i < 1000; i++) {
  const l = cmykToLab([rand(), rand(), rand(), rand() * 0.5])
  const d = deltaE2000(fwd.one(back.one(l)), l)
  sum += d
  worst = Math.max(worst, d)
}
check('and Lab → CMYK → Lab through the profile stays where it was', sum / 1000 < 0.5 && worst < 2.5, `mean ${(sum / 1000).toFixed(3)}, worst ${worst.toFixed(3)} ΔE2000`)

// --- resolving a document's profile ------------------------------------------------------
console.log('\nresolving')
check('a built-in profile resolves to itself', !registry.resolve({ builtin: 'display-p3' }, 'rgb').substituted)
const unknown = registry.resolve({ builtin: 'coated-fogra39' }, 'cmyk')
check('an unknown built-in falls back to the mode’s default, saying why', unknown.profile === cmykP && /isn’t one this version has/.test(unknown.substituted ?? ''))
check('a profile for another mode falls back', /is for RGB, not CMYK/.test(registry.resolve({ builtin: 'srgb' }, 'cmyk').substituted ?? ''))
check('a missing embedded profile falls back', /missing/.test(registry.resolve({ asset: 'nope' }, 'rgb').substituted ?? ''))
assets.set('junk', new Uint8Array([9, 9, 9]))
check('an unreadable embedded profile falls back', /can’t be read/.test(registry.resolve({ asset: 'junk' }, 'rgb').substituted ?? ''))
assets.set('p3', registry.builtin('display-p3').bytes())
const emb = registry.resolve({ asset: 'p3' }, 'rgb')
check('an embedded profile is read from its bytes', !emb.substituted && emb.profile.description === 'Display P3')

// --- converting colours -------------------------------------------------------------------
console.log('\nconverting')
const sRGB = { builtin: 'srgb' }
const P3 = { builtin: 'display-p3' }
const CMYK = { builtin: 'generic-cmyk' }
const p3green = conv.convert({ space: 'rgb', profile: P3, c: [0, 1, 0] }, { space: 'rgb', profile: sRGB })
check('P3 green into sRGB is clipped, and says so', p3green.clipped && p3green.c.every((v) => v >= 0 && v <= 1), fmt(p3green.c))
check('sRGB grey into P3 is not clipped', !conv.convert({ space: 'rgb', profile: sRGB, c: [0.4, 0.4, 0.4] }, { space: 'rgb', profile: P3 }).clipped)
const blue = conv.convert({ space: 'rgb', profile: sRGB, c: [0, 0, 1] }, { space: 'cmyk', profile: CMYK })
check('sRGB’s pure blue is outside the CMYK gamut', blue.clipped, fmt(blue.c))
check('sRGB black is in the CMYK gamut: with black-point compensation it maps to the darkest black', !conv.convert({ space: 'rgb', profile: sRGB, c: [0, 0, 0] }, { space: 'cmyk', profile: CMYK }).clipped)
check('without it, it is out', conv.convert({ space: 'rgb', profile: sRGB, c: [0, 0, 0] }, { space: 'cmyk', profile: CMYK }, 'relative', false).clipped)
const skin = conv.convert({ space: 'rgb', profile: sRGB, c: [0.85, 0.65, 0.55] }, { space: 'cmyk', profile: CMYK })
check('a skin tone is inside it', !skin.clipped, fmt(skin.c))
const labWhite = conv.convert({ space: 'lab', profile: null, c: [100, 0, 0] }, { space: 'rgb', profile: sRGB })
check('Lab white is sRGB white', close(labWhite.c, [1, 1, 1], 0.002), fmt(labWhite.c))
const gray = conv.convert({ space: 'gray', profile: { builtin: 'gray-gamma-2.2' }, c: [0.5] }, { space: 'rgb', profile: sRGB })
check('a gray becomes a neutral RGB', Math.abs(gray.c[0] - gray.c[1]) < 0.002 && Math.abs(gray.c[1] - gray.c[2]) < 0.002, fmt(gray.c))
const same = { space: 'cmyk' as const, profile: CMYK, c: [0.1, 0.2, 0.3, 0.4] }
check('converting to the same space and profile changes nothing', conv.convert(same, { space: 'cmyk', profile: CMYK }).c.join() === same.c.join())

// --- picker models --------------------------------------------------------------------------
console.log('\npicker models')
let worstHsb = 0
let worstHsl = 0
let worstLch = 0
for (let i = 0; i < 1000; i++) {
  const rgb = [rand(), rand(), rand()]
  worstHsb = Math.max(worstHsb, ...hsbToRgb(rgbToHsb(rgb)).map((v, j) => Math.abs(v - rgb[j])))
  worstHsl = Math.max(worstHsl, ...hslToRgb(rgbToHsl(rgb)).map((v, j) => Math.abs(v - rgb[j])))
  const l = [rand() * 100, rand() * 200 - 100, rand() * 200 - 100]
  worstLch = Math.max(worstLch, ...lchToLab(labToLch(l)).map((v, j) => Math.abs(v - l[j])))
}
check('RGB → HSB → RGB round-trips', worstHsb < 1e-9, worstHsb.toExponential(1))
check('RGB → HSL → RGB round-trips', worstHsl < 1e-9, worstHsl.toExponential(1))
check('Lab → LCh → Lab round-trips', worstLch < 1e-9, worstLch.toExponential(1))
check('pure red is hue 0, full saturation and brightness', close(rgbToHsb([1, 0, 0]), [0, 1, 1], 1e-9))
check('cyan is hue 180', Math.abs(rgbToHsb([0, 1, 1])[0] - 180) < 1e-9)
check('#3a66db reads as its RGB and writes back the same', formatHex(parseHex('#3a66db')!) === '#3a66db')
check('#abc is shorthand for #aabbcc', formatHex(parseHex('abc')!) === '#aabbcc')
check('a hex that isn’t one is refused', parseHex('#12345') === null && parseHex('ggg') === null)
// Sharma, Wu and Dalal (2005), test pairs 1, 7 and 17.
const pairs: [number[], number[], number][] = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 0, 0], [50, -1, 2], 2.3669],
  [[50, 2.5, 0], [73, 25, -18], 27.1492],
]
for (const [a, b, want] of pairs) check(`CIEDE2000 of a Sharma test pair is ${want}`, Math.abs(deltaE2000(a, b) - want) < 1e-4, deltaE2000(a, b).toFixed(4))

// --- display tables ---------------------------------------------------------------------------
console.log('\ndisplay tables')
const display = registry.builtin('srgb')
const displayToLab = cms.transform(display, lab)
for (const def of BUILTIN_PROFILES) {
  const from = registry.builtin(def.id)
  const t0 = Date.now()
  const lut = buildDisplayLut(cms, from, display)
  const built = Date.now() - t0
  const direct = cms.transform(from, display, 'relative', 0x2000)
  let s = 0
  let w = 0
  const n = 1500
  for (let i = 0; i < n; i++) {
    const c = def.mode === 'gray' ? [rand()] : def.mode === 'cmyk' ? [rand(), rand(), rand(), rand()] : [rand(), rand(), rand()]
    const want = direct.one(c).map((v) => Math.min(1, Math.max(0, v)))
    const d = deltaE2000(displayToLab.one(sampleLut(lut, c)), displayToLab.one(want))
    s += d
    w = Math.max(w, d)
  }
  direct.close()
  check(`${def.name} → sRGB display: the table matches the engine`, s / n < 0.5 && w < 2, `mean ${(s / n).toFixed(3)}, worst ${w.toFixed(3)} ΔE2000, ${lut.data.length / 4} entries, built in ${built} ms`)
}

console.log(`\n${failures === 0 ? 'all clear' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
