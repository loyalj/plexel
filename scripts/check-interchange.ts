/**
 * Interchange, headless: PSD and PSB read and written, Photoshop's
 * descriptors and EngineData, our JPEG decoder, SVG read and written, PDF
 * written. The page-side parts (pixels, renders, the dialogs) are in
 * check-interchange.mjs; this is the format code alone.
 *
 * The PSD files are psd-tools' test files (Photoshop's own, a few from GIMP
 * and others), the JPEGs jpeg-js's with its decoded references, the SVGs
 * resvg's. Every PSD must parse and come over as the layers it has; written
 * back, a file must read the same; what Photoshop stores as data (the
 * descriptors, the text engine's) must survive a round trip byte for byte.
 * PDFs are read back by pdf.js, which is what a browser would show them
 * with.
 *
 * Run with: npm run check:interchange
 */
import { readFileSync, readdirSync } from 'node:fs'
import { DEFAULT_PROFILES, createDoc, insertNode } from '../src/doc/edit'
import { makeNode } from '../src/doc/nodes'
import type { Doc, DocNode } from '../src/doc/types'
import type { DocSwatch } from '../src/doc/swatches'
import { fillItem, solid, strokeItem } from '../src/doc/vector'
import { decodeJpegPixels } from '../src/io/jpegDecode'
import { Reader, Writer } from '../src/io/psd/bin'
import { docToPlan } from '../src/io/psd/fromDoc'
import { block, readPath, readCurves, readHueSat, readLevels, readSmartObject, readTypeTool, versionedDescriptor } from '../src/io/psd/blocks'
import { warpFromPsd } from '../src/io/psd/warp'
import { obj as dObj, list as dList } from '../src/io/psd/descriptor'
import { readDescriptor, writeDescriptor } from '../src/io/psd/descriptor'
import { readEngineData, writeEngineData } from '../src/io/psd/engineData'
import { packBits, readPsd, writePsd, type PsdFile } from '../src/io/psd/format'
import { psdToDoc, readGuides, type PsdHost } from '../src/io/psd/toDoc'
import { docToPdf, type PdfHost } from '../src/io/pdf/write'
import { parsePathData, parseTransform, resampleStops, svgToDoc } from '../src/io/svg/read'
import { docToSvg, pathD, type SvgHost } from '../src/io/svg/write'
import { parseXml, type XmlElement } from '../src/io/svg/xml'
import { deflateSync, inflateSync } from 'node:zlib'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])
const raw8 = (s: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number } | null) => (s ? new Uint8Array(s.buffer, s.byteOffset, s.byteLength) : new Uint8Array(0))
const PSD = 'scripts/fixtures/psd/'
const fixture = (f: string) => new Uint8Array(readFileSync(f))

// --- PSD: reading ---------------------------------------------------------------------------------

console.log('PSD and PSB files open')
let ids = 0
const host: PsdHost = {
  pixels: () => `set${ids++}`,
  mask: () => `mask${ids++}`,
  colour: (v) => v.c.slice() as never,
  labToRgb: (L) => [new Float32Array(L.length), new Float32Array(L.length), new Float32Array(L.length)],
  open: async () => null,
  profile: (_icc, mode) => DEFAULT_PROFILES[mode],
  working: DEFAULT_PROFILES,
  newId: (p) => `${p}${ids++}`,
}
const opened = new Map<string, { file: PsdFile; doc: Doc; warnings: string[]; fonts: string[] }>()
const files = readdirSync(PSD).filter((f) => /\.ps[db]$/.test(f))
const broken: string[] = []
for (const f of files) {
  try {
    const file = await readPsd(fixture(PSD + f), { composite: true })
    const r = await psdToDoc(file, host)
    opened.set(f, { file, ...r })
  } catch (e) {
    broken.push(`${f}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
check(`all ${files.length} of psd-tools’ files parse and come over`, broken.length === 0, broken.join('; '))
const kinds = (f: string) => {
  const out: Record<string, number> = {}
  for (const n of Object.values(opened.get(f)?.doc.nodes ?? {})) out[n.kind] = (out[n.kind] ?? 0) + 1
  return out
}
const nodesOf = (f: string, kind: string) => Object.values(opened.get(f)?.doc.nodes ?? {}).filter((n) => n.kind === kind)
const warned = (f: string, re: RegExp) => (opened.get(f)?.warnings ?? []).some((w) => re.test(w))

check('a PSB reads as one, with its layers', opened.get('2layers.psb')?.file.psb === true && kinds('2layers.psb').pixel === 2)
check('every depth: 1, 8, 16 and 32 bits', ['4x4_1bit_bitmap.psd', '4x4_8bit_rgb.psd', '4x4_16bit_rgb.psd', '4x4_32bit_rgb.psd'].every((f, i) => opened.get(f)?.file.depth === [1, 8, 16, 32][i]))
check('every mode comes over as one of Plexel’s, saying what changed', opened.get('4x4_8bit_cmyk.psd')?.doc.mode === 'cmyk' && opened.get('4x4_8bit_grayscale.psd')?.doc.mode === 'gray' && opened.get('4x4_8bit_lab.psd')?.doc.mode === 'rgb' && warned('4x4_8bit_lab.psd', /Lab/) && warned('4x4_8bit_index_color.psd', /indexed/) && warned('4x4_8bit_duotone.psd', /duotone/) && warned('4x4_1bit_bitmap.psd', /bitmap/i))
check('32 bits open at 16, and say so', opened.get('4x4_32bit_rgb.psd')?.doc.depth === 16 && warned('4x4_32bit_rgb.psd', /32-bit/))
check('groups are groups', nodesOf('group.psd', 'group').length === 2 && nodesOf('passthrough_blendmodes1.psd', 'group').length === 4)
check('pass-through groups stay pass-through', nodesOf('passthrough_blendmodes1.psd', 'group').some((g) => g.blend === 'pass-through'))
check('a layer mask comes over as a pixel mask', nodesOf('mask.psd', 'mask').some((m) => (m.props as { source: string }).source !== 'vector'))
check('a vector mask comes over as a vector mask', nodesOf('vector-mask.psd', 'mask').some((m) => (m.props as { source: string }).source === 'vector'))
check('shape layers come over as live vectors', nodesOf('minimal_shape-layer.psd', 'vector').length === 1 && kinds('minimal_shape-layer.psd').pixel === undefined)
check(
  'solid colour and gradient fill layers are fill layers, with their paints',
  nodesOf('minimal_solid-color-fill.psd', 'fill').some((n) => (n.props as { paint: { kind: string } }).paint.kind === 'solid') &&
    nodesOf('minimal_gradient-fill.psd', 'fill').some((n) => (n.props as { paint: { kind: string } }).paint.kind === 'gradient'),
)
check('type layers are live text, with their fonts asked for', nodesOf('text.psd', 'text').length === 1 && (opened.get('text.psd')?.fonts ?? []).includes('ArialMT') && nodesOf('layer_effects.psd', 'text').length === 11)
check('hidden layers stay hidden', Object.values(opened.get('hidden-layer.psd')!.doc.nodes).some((n) => !n.visible))
// Plexel's clipping is nesting: a clipped layer is a child of the one it's clipped to.
check('clipped layers stay clipped, as children of their base', Object.values(opened.get('clipping-mask.psd')!.doc.nodes).some((n) => n.kind !== 'group' && (n.children?.length ?? 0) > 0))
check('layer names in emoji come over', Object.values(opened.get('layer-name-emoji.psd')!.doc.nodes).some((n) => /\p{Extended_Pictographic}/u.test(n.name)))
const fxCount = (f: string) => Object.values(opened.get(f)!.doc.nodes).reduce((s, n) => s + ((n as DocNode & { fx?: unknown[] }).fx?.length ?? 0), 0)
check('layer effects come over', fxCount('layer_effects.psd') >= 10 && fxCount('fx_outside-stroke.psd') === 1)
check('fill opacity comes over apart from opacity', Object.values(opened.get('opacity-fill.psd')!.doc.nodes).some((n) => (n as DocNode & { fillOpacity?: number }).fillOpacity !== undefined && (n as DocNode & { fillOpacity?: number }).fillOpacity! < 1))
const adjOf = (f: string) => nodesOf(f, 'adjustment').map((n) => (n.props as { adjustment: string }).adjustment)
check('adjustment layers come over as theirs', ['brightnesscontrast:brightness-contrast', 'curves:curves', 'exposure:exposure', 'huesaturation:hue-saturation', 'invert:invert', 'levels:levels', 'posterize:posterize', 'threshold:threshold'].every((p) => {
  const [f, a] = p.split(':')
  return adjOf(`adj_${f}_rgb.psd`).length > 0 && adjOf(`adj_${f}_rgb.psd`).every((x) => x === a)
}))
check('Hue/Saturation’s colour ranges come over, without a warning', !warned('adj_huesaturation_rgb.psd', /colour ranges/))
check('spot channels are named as left out', warned('cmyk-spot.psd', /spot/))
check('a smart object whose contents can’t open comes in as its pixels, saying so', nodesOf('minimal_smartobject-layer.psd', 'pixel').length === 1 && warned('minimal_smartobject-layer.psd', /smart object/))

const lv = opened.get('adj_levels_rgb.psd')!.file.layers.find((l) => l.name === 'Levels 4')!
const recs = readLevels(block(lv.blocks, 'levl')!)
check('Levels records read as Photoshop wrote them', recs[0].inBlack === 48 && recs[0].inWhite === 135 && recs[0].outBlack === 74 && recs[0].outWhite === 141 && near(recs[3].gamma, 2.12))
const cv = opened.get('adj_curves_rgb.psd')!.file.layers.find((l) => l.name === 'Curves 2')!
const curves = readCurves(block(cv.blocks, 'curv')!)
check('Curves points read per channel', JSON.stringify(curves.get(0)) === '[[26,3],[55,84],[171,170],[255,255]]' && JSON.stringify(curves.get(3)) === '[[0,0],[167,110],[255,166]]')
const hs = readHueSat(block(opened.get('adj_huesaturation_rgb.psd')!.file.layers.find((l) => l.name === 'Hue/Saturation 4')!.blocks, 'hue2')!)
check('Hue/Saturation reads master and ranges', hs.master.join() === '122,100,-37' && hs.ranges.length === 6)

// --- PSD: writing ---------------------------------------------------------------------------------

console.log('\nPSD and PSB files write back the same')
for (const f of ['group.psd', 'mask.psd', 'vector-mask.psd', 'layer_effects.psd', 'text.psd', '4x4_16bit_rgb.psd', '4x4_8bit_cmyk.psd', '2layers.psb']) {
  const a = opened.get(f)!.file
  const bytes = await writePsd(a)
  const b = await readPsd(bytes, { composite: true })
  const ok =
    b.psb === a.psb &&
    b.width === a.width &&
    b.height === a.height &&
    b.depth === a.depth &&
    b.mode === a.mode &&
    b.layers.length === a.layers.length &&
    b.layers.every((l, i) => {
      const m = a.layers[i]
      return l.name === m.name && l.blend === m.blend && l.opacity === m.opacity && l.clipping === m.clipping && l.top === m.top && l.left === m.left && l.channels.length === m.channels.length && l.channels.every((c, k) => c.id === m.channels[k].id && same(raw8(c.data), raw8(m.channels[k].data))) && l.blocks.length === m.blocks.length && l.blocks.every((x, k) => x.key === m.blocks[k].key && same(x.data, m.blocks[k].data))
    }) &&
    (a.composite === null || (b.composite !== null && b.composite.every((p, i) => same(raw8(p), raw8(a.composite![i])))))
  check(`${f}: layers, channels, blocks and composite`, ok)
}
const psbOf = await readPsd(await writePsd({ ...opened.get('group.psd')!.file, psb: true }), { composite: true })
check('a PSD written as a PSB reads back as one, the same', psbOf.psb && psbOf.layers.length === opened.get('group.psd')!.file.layers.length)
const row = new Uint8Array([1, 1, 1, 1, 2, 3, 4, 5, 5, 5, 9])
const unpack = (p: Uint8Array) => {
  const out: number[] = []
  for (let i = 0; i < p.length; ) {
    const n = (p[i] << 24) >> 24
    i++
    if (n >= 0) for (let k = 0; k <= n; k++) out.push(p[i++])
    else if (n > -128) {
      for (let k = 0; k < 1 - n; k++) out.push(p[i])
      i++
    }
  }
  return new Uint8Array(out)
}
check('PackBits round-trips, runs and literals', same(unpack(packBits(row)), row) && same(unpack(packBits(new Uint8Array(300).fill(7))), new Uint8Array(300).fill(7)))

// What Plexel writes of its own documents: the layer records' blocks, read back by our reader.
{
  let d = createDoc({ name: 'Plan', width: 200, height: 100, resolution: 72, mode: 'rgb', depth: 8, profile: DEFAULT_PROFILES.rgb }, 'root')
  d = insertNode(d, makeNode('vector', 'v', 'Shape', { geometry: { kind: 'shape', shape: { type: 'rect', x: 20, y: 10, w: 100, h: 50, radii: [0, 0, 0, 0], corner: 'round' } } as never, appearance: [fillItem(solid([1, 0, 0]))] }), 'root', 0)
  d = insertNode(d, makeNode('adjustment', 'a', 'Curves', { adjustment: 'curves', params: { curves: { master: [[0, 0], [0.5, 0.7], [1, 1]] } } } as never), 'root', 1)
  const { plan } = await docToPlan(d, 'k', { psName: (f) => f, smartObject: async () => null, icc: null })
  const shape = plan.layers.find((l) => l.name === 'Shape')
  const vm = shape && block(shape.blocks, 'vmsk')
  const path = vm ? readPath(vm, 200, 100) : null
  const knots = path?.subpaths[0]?.knots.map((k) => k.anchor.map((v) => Math.round(v)).join(',')) ?? []
  check('a shape’s vector mask writes as Photoshop’s path records and reads back point for point', knots.join(' ') === '20,10 120,10 120,60 20,60', knots.join(' '))
  check('with its fill as a solid colour fill', !!shape && !!block(shape.blocks, 'SoCo'))
  const cl = plan.layers.find((l) => l.name === 'Curves')
  const cb = cl && block(cl.blocks, 'curv')
  check('an adjustment writes Photoshop’s own block, which reads back', !!cb && JSON.stringify(readCurves(cb).get(0)) === '[[0,0],[128,179],[255,255]]', cb ? JSON.stringify([...readCurves(cb)]) : '')
}

// A smart object's warp: its corners as the placed layer's, its style as Photoshop's warp, and back.
{
  const content = createDoc({ name: 'In', width: 100, height: 50, resolution: 72, mode: 'rgb', depth: 8, profile: DEFAULT_PROFILES.rgb }, 'r2')
  let d = createDoc({ name: 'Warped', width: 300, height: 200, resolution: 72, mode: 'rgb', depth: 8, profile: DEFAULT_PROFILES.rgb }, 'root')
  const so = makeNode('embedded', 's', 'Placed', { asset: null, content })
  so.transform = [2, 0, 0, 2, 10, 20]
  const params = { style: 'flag', bend: 40, horizontal: 10, vertical: 0, orient: 'horizontal', frame: [100, 0, 0, 50, 0, 0], corners: [10, 0, 100, 0, 100, 50, 0, 50] }
  const w = makeNode('filter', 'w', 'Warp', { filter: 'warp', params })
  so.effects = ['w']
  d = insertNode(d, so, 'root', 0)
  d = { ...d, nodes: { ...d.nodes, w } }
  const { plan, warnings } = await docToPlan(d, 'k', { psName: (f) => f, smartObject: async () => new Uint8Array(16), icc: null })
  const layer = plan.layers.find((l) => l.name === 'Placed')
  const sd = layer && block(layer.blocks, 'SoLd')
  const desc = sd ? readSmartObject(sd) : null
  const trnf = dList(desc ?? undefined, 'Trnf').map((v) => (v.t === 'doub' ? v.v : NaN))
  check('a smart object’s perspective writes as its placed corners', trnf.join() === '30,20,210,20,210,120,10,120', trnf.join())
  check('and it isn’t warned about as a live filter', !warnings.some((x) => /Live filters/.test(x)), warnings.join('; '))
  const back = warpFromPsd(dObj(desc ?? undefined, 'warp'), [100, 0, 0, 50, 0, 0], [10, 0, 100, 0, 100, 50, 0, 50])
  check('its style reads back as the Warp effect’s', back?.style === 'flag' && back?.bend === 40 && back?.horizontal === 10, JSON.stringify(back))
}

// Guides: Photoshop's resource 1032, in 1/32 pixels, written and read back.
{
  let d = createDoc({ name: 'Guides', width: 200, height: 100, resolution: 72, mode: 'rgb', depth: 8, profile: DEFAULT_PROFILES.rgb }, 'root')
  d = { ...d, guides: [{ axis: 'x', at: 50 }, { axis: 'y', at: 25.5 }, { axis: 'x', at: 133.25 }] }
  const { plan } = await docToPlan(d, 'k', { psName: (f) => f, smartObject: async () => null, icc: null })
  const res = plan.resources.find((r) => r.id === 1032)
  const back = readGuides(res?.data)
  check('guides write as Photoshop’s guide resource and read back exactly', JSON.stringify(back) === JSON.stringify(d.guides), JSON.stringify(back))
  const none = await docToPlan({ ...d, guides: [] }, 'k', { psName: (f) => f, smartObject: async () => null, icc: null })
  check('a document without guides writes no guide resource', !none.plan.resources.some((r) => r.id === 1032))
}

// --- descriptors and EngineData --------------------------------------------------------------------

console.log('\nPhotoshop’s descriptors and text engine data round-trip')
let descriptors = 0
let descBad = 0
for (const [, o] of opened)
  for (const l of o.file.layers)
    for (const b of l.blocks) {
      const at = b.key === 'lfx2' || b.key === 'lmfx' ? 8 : ['SoCo', 'GdFl', 'vstk', 'vscg', 'CgEd', 'vibA', 'blwh', 'artb'].includes(b.key) ? 4 : -1
      if (at < 0) continue
      descriptors++
      try {
        const r = new Reader(b.data)
        r.skip(at)
        const d = readDescriptor(r)
        const end = r.pos
        const w = new Writer()
        writeDescriptor(w, d)
        if (!same(w.done(), b.data.subarray(at, end))) descBad++
      } catch {
        descBad++
      }
    }
check(`${descriptors} descriptors read and write back byte for byte`, descriptors > 30 && descBad === 0, descBad ? `${descBad} differ` : '')
let engines = 0
let engineBad = 0
for (const [, o] of opened)
  for (const l of o.file.layers) {
    const ty = block(l.blocks, 'TySh')
    if (!ty) continue
    const t = readTypeTool(ty)
    if (!t.engine) continue
    engines++
    if (JSON.stringify(readEngineData(writeEngineData(t.engine))) !== JSON.stringify(t.engine)) engineBad++
  }
check(`${engines} text layers’ EngineData read, write and read the same`, engines >= 15 && engineBad === 0)
const ed = readEngineData(Uint8Array.from('<< /A 1 /B [ 2.5 -3 ] /C (\xfe\xff\x00h\x00i) /D true /E /Name >>', (c) => c.charCodeAt(0)))
check('EngineData: numbers, arrays, UTF-16 strings, booleans and names', JSON.stringify(ed) === JSON.stringify({ A: 1, B: [2.5, -3], C: 'hi', D: true, E: { name: 'Name' } }))
const desc1 = versionedDescriptor(block(opened.get('adj_brightnesscontrast_rgb.psd')!.file.layers.find((l) => l.name === 'Brightness/Contrast 1')!.blocks, 'CgEd')!)
check('a versioned descriptor gives its values', desc1.items.some(([k, v]) => k === 'Brgh' && v.t === 'long' && v.v === -95))

// --- JPEG -----------------------------------------------------------------------------------------

console.log('\nJPEGs decode as the reference decoder has them')
for (const n of ['rgb', 'skater-progressive', 'cmyktest', 'tree-cmyk']) {
  const r = decodeJpegPixels(fixture(`scripts/fixtures/jpeg/${n}.jpg`))
  const ref = readFileSync(`scripts/fixtures/jpeg/${n}.rgba`)
  const c = r.data.length / (r.width * r.height)
  let sum = 0
  let worst = 0
  for (let i = 0; i < r.width * r.height; i++) {
    const p = Array.from(r.data.subarray(i * c, i * c + c))
    // CMYK comes back as ink; the reference took it to RGB the plain way.
    const rgb = r.mode === 'cmyk' ? p.slice(0, 3).map((v) => 255 * (1 - v / 255) * (1 - p[3] / 255)) : p.slice(0, 3)
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(rgb[k] - ref[i * 4 + k])
      sum += d
      worst = Math.max(worst, d)
    }
  }
  const mean = sum / (r.width * r.height * 3)
  check(`${n}: ${r.width}×${r.height} ${r.mode}${n.includes('progressive') ? ', progressive' : ''}`, mean < 1 && worst <= 6, `mean ${mean.toFixed(2)} worst ${worst}`)
}
const tree = decodeJpegPixels(fixture('scripts/fixtures/jpeg/tree-cmyk.jpg'))
const plain = decodeJpegPixels(fixture('scripts/fixtures/jpeg/tree-cmyk-notransform.jpg'))
let td = 0
for (let i = 0; i < tree.data.length; i++) td += Math.abs(tree.data[i] - plain[i as never])
check('Adobe’s YCCK and plain CMYK decode to the same inks', tree.mode === 'cmyk' && plain.mode === 'cmyk' && tree.width === plain.width)
const red = decodeJpegPixels(fixture('scripts/fixtures/jpeg/redbox-with-rst.jpg'))
const mid = (red.height / 2) * red.width + red.width / 2
check('restart markers: the red box is red throughout', red.data[mid * 4] > 200 && red.data[mid * 4 + 1] < 60 && red.data[(red.width * red.height - red.width / 2) * 4] !== undefined)
const grey = decodeJpegPixels(fixture('scripts/fixtures/jpeg/cmyk-grey.jpg'))
check('a CMYK JPEG keeps its four channels and alpha', grey.mode === 'cmyk' && grey.data.length === grey.width * grey.height * 5)

// --- SVG: reading ---------------------------------------------------------------------------------

console.log('\nSVG reads')
const p = parsePathData('M10 20 l5 0 h5 v5 z m1,1 C 1 2 3 4 5 6 s 1 1 2 2 Q 0 0 1 1 t 2 2 A 5 5 0 0 1 20 20')
check('path data: every command, relative and absolute', p.subpaths.length === 2 && p.subpaths[0].closed && p.subpaths[0].anchors.length === 4 && p.subpaths[0].anchors[3].p.join() === '20,25' && p.subpaths[1].anchors[0].p.join() === '11,21')
check('arc flags run together ("10")', parsePathData('M0 0a5 5 0 1020 0').subpaths[0].anchors.length > 1)
check('path data must open with a moveto, or draw nothing', parsePathData('A 5 5 0 0 1 50 50').subpaths.length === 0)
const t = parseTransform('translate(10 20) rotate(90) scale(2)')
check('transforms compose left to right', near(t[0], 0) && near(t[1], 2) && near(t[2], -2) && near(t[3], 0) && near(t[4], 10) && near(t[5], 20))
check('skewX', near(parseTransform('skewX(45)')[2], 1))
const rs = resampleStops([{ at: 0, colour: [0, 0, 0], alpha: 1 }, { at: 1, colour: [1, 1, 1], alpha: 1 }], 0.25)
check('stops resampled into a shifted gradient keep its colours where they were', rs.length >= 2 && rs.some((s) => near(s.at, 0.25, 0.02) && near(s.colour[0], 0, 0.02)))
const NAMED: Record<string, [number, number, number]> = { green: [0, 128 / 255, 0], black: [0, 0, 0], white: [1, 1, 1], red: [1, 0, 0], blue: [0, 0, 1], seagreen: [46 / 255, 139 / 255, 87 / 255] }
const svgHost = { newId: (p: string) => `${p}${ids++}`, namedColour: (n: string) => NAMED[n.toLowerCase()] ?? null }
const SVG = 'scripts/fixtures/svg/'
const svgs = readdirSync(SVG).filter((f) => f.endsWith('.svg'))
const svgBroken: string[] = []
const svgDocs = new Map<string, ReturnType<typeof svgToDoc>>()
for (const f of svgs) {
  try {
    svgDocs.set(f, svgToDoc(readFileSync(SVG + f, 'utf8'), f, svgHost))
  } catch (e) {
    svgBroken.push(`${f}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
check(`all ${svgs.length} of resvg’s cases read`, svgBroken.length === 0, svgBroken.join('; '))
const sv = (f: string) => svgDocs.get(f)!.doc
check('the viewBox is the document’s size', sv('shapes_rect_simple-case.svg').width === 200 && sv('structure_image_embedded-png.svg').width === 80)
check('an embedded PNG comes out to be decoded, at its box', svgDocs.get('structure_image_embedded-png.svg')!.images.length === 1 && svgDocs.get('structure_image_embedded-png.svg')!.images[0].width === 64)
check('a clip path in the box’s units becomes a vector mask', Object.values(sv('masking_clipPath_clip-path-with-transform.svg').nodes).some((n) => n.kind === 'mask'))
check('mix-blend-mode comes over', Object.values(sv('painting_mix-blend-mode_multiply.svg').nodes).some((n) => n.blend === 'multiply'))
check('a dashed circle comes in as its path, so its dashes start where SVG’s do', Object.values(sv('painting_stroke-dasharray_even-count.svg').nodes).some((n) => n.kind === 'vector' && (n.props as { geometry: { kind: string } }).geometry.kind === 'path'))

// --- SVG: writing ---------------------------------------------------------------------------------

console.log('\nSVG writes')
let doc = createDoc({ name: 'Out', width: 200, height: 100, resolution: 72, mode: 'rgb', depth: 8, profile: DEFAULT_PROFILES.rgb }, 'root')
doc = insertNode(doc, makeNode('vector', 'r', 'Box', { geometry: { kind: 'shape', shape: { type: 'rect', x: 10, y: 10, w: 80, h: 40, radii: [0, 0, 0, 0], corner: 'round' } } as never, appearance: [fillItem(solid([1, 0, 0])), strokeItem(solid([0, 0, 1]), 4)] }), 'root', 0)
doc = insertNode(doc, makeNode('vector', 'g', 'Ramp', { geometry: { kind: 'shape', shape: { type: 'ellipse', x: 110, y: 10, w: 80, h: 80 } } as never, appearance: [fillItem({ kind: 'gradient', type: 'linear', stops: [{ at: 0, colour: [1, 1, 0], alpha: 1 }, { at: 1, colour: [0, 1, 1], alpha: 1 }], angle: 0, scale: 100, reverse: false })] }), 'root', 1)
doc = { ...doc, nodes: { ...doc.nodes, g: { ...doc.nodes.g, blend: 'multiply', opacity: 0.5 } } }
const hex = (c: number[]) => '#' + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
const sHost: SvgHost = { colour: (c) => hex(c as number[]), image: async () => null, flattened: async () => null, layout: () => null, textAsOutlines: false }
const out = await docToSvg(doc, sHost)
const tree2 = parseXml(out.svg)
const all = (e: XmlElement): XmlElement[] => [e, ...e.children.flatMap((c) => (typeof c === 'string' ? [] : all(c)))]
const els = all(tree2)
check('it’s well-formed SVG at the document’s size', tree2.name === 'svg' && tree2.attrs.viewBox === '0 0 200 100')
check('shapes are vectors: fill, stroke, gradient', els.some((e) => e.attrs.fill === '#ff0000') && els.some((e) => e.attrs.stroke === '#0000ff') && els.some((e) => e.name === 'linearGradient'))
check('blend and opacity are kept', out.svg.includes('mix-blend-mode:multiply') || out.svg.includes('mix-blend-mode: multiply'))
const back = svgToDoc(out.svg, 'back.svg', svgHost)
const vecs = Object.values(back.doc.nodes).filter((n) => n.kind === 'vector')
// Each layer is written as a group (its opacity and blend) around its fills and strokes.
check('and it reads back: the shapes, the gradient, the blend and opacity', vecs.length >= 2 && Object.values(back.doc.nodes).some((n) => n.kind === 'group' && n.blend === 'multiply' && near(n.opacity, 0.5)) && vecs.some((n) => JSON.stringify(n.props).includes('"gradient"')))
check('a path’s d is short and exact', pathD({ fillRule: 'nonzero', subpaths: [{ closed: true, anchors: [{ p: [0, 0], in: null, out: null, smooth: false }, { p: [10, 0], in: null, out: null, smooth: false }, { p: [10, 10], in: null, out: null, smooth: false }] }] }).trim().match(/^M0 0L10 0L10 10(L0 0)?Z$/) !== null)

// Photoshop's shapes stroke inside by default: written as vectors, not pictures.
let aligned = createDoc({ name: 'Aligned', width: 100, height: 100, resolution: 72, mode: 'rgb', depth: 8, profile: DEFAULT_PROFILES.rgb }, 'root')
for (const [i, align] of (['inside', 'outside'] as const).entries())
  aligned = insertNode(aligned, makeNode('vector', `s${i}`, align, { geometry: { kind: 'shape', shape: { type: 'rect', x: 10 + i * 50, y: 10, w: 30, h: 30, radii: [0, 0, 0, 0], corner: 'round' } } as never, appearance: [{ ...strokeItem(solid([0, 0, 0]), 4), align }] }), 'root', i)
const al = (await docToSvg(aligned, sHost)).svg
check('inside and outside strokes are vectors: twice as wide, clipped to the shape or masked from it', !al.includes('<image') && /<clipPath[^>]*><use[^>]*clip-rule/.test(al) && al.includes('<mask') && (al.match(/stroke-width="8"/g) ?? []).length === 2)

// --- PDF ------------------------------------------------------------------------------------------

console.log('\nPDF writes, and pdf.js reads it')
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const opName = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]))
const pdfHost = (icc: Uint8Array | null): PdfHost => ({
  image: async () => null,
  flattened: async () => null,
  layout: () => null,
  icc,
  profileName: icc ? 'Test CMYK' : 'sRGB',
  spotColour: (s) => s.colour.c.slice() as never,
  deflate: async (b) => new Uint8Array(deflateSync(b)),
  now: new Date('2026-10-11T12:00:00Z'),
})
const readPdf = async (bytes: Uint8Array) => {
  const d = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise
  const page = await d.getPage(1)
  const ops = (await page.getOperatorList()).fnArray.map((f) => opName[f])
  return { pages: d.numPages, view: page.view, ops, info: (await d.getMetadata()).info as Record<string, unknown> }
}
const fakeIcc = new Uint8Array(128 + 4)
const pdf = await docToPdf(doc, pdfHost(fakeIcc))
const text = new TextDecoder('latin1').decode(pdf.bytes)
const rp = await readPdf(pdf.bytes)
check('one page, the document’s size in points', rp.pages === 1 && near(rp.view[2], 200, 0.01) && near(rp.view[3], 100, 0.01))
check('shapes are drawn as paths, the gradient as a shading', rp.ops.includes('constructPath') && (rp.ops.includes('shadingFill') || text.includes('/ShadingType')))
check('the multiply blend and the opacity are in a graphics state', /\/BM\s*\/Multiply/.test(text) && /\/ca\s+0\.5/.test(text))
check('colours are in the document’s profile (ICCBased)', text.includes('/ICCBased'))
check('the title is the document’s', rp.info.Title === 'Out')
const xrefOk = (() => {
  const at = Number(/startxref\s+(\d+)/.exec(text)?.[1] ?? -1)
  if (!text.startsWith('xref', at)) return false
  const entries = [...text.slice(at).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]))
  return entries.every((o) => /^\d+ 0 obj/.test(text.slice(o, o + 20)))
})()
check('every cross-reference points at its object', xrefOk)

let cmyk = createDoc({ name: 'Press', width: 100, height: 100, resolution: 300, mode: 'cmyk', depth: 8, profile: DEFAULT_PROFILES.cmyk }, 'root')
const spot: DocSwatch = { id: 'w1', name: 'House Red', kind: 'spot', colour: { space: 'cmyk', profile: DEFAULT_PROFILES.cmyk, c: [0, 0.9, 0.8, 0] } }
cmyk = { ...cmyk, swatches: [spot] }
cmyk = insertNode(cmyk, makeNode('vector', 's', 'Spot', { geometry: { kind: 'shape', shape: { type: 'rect', x: 0, y: 0, w: 50, h: 50, radii: [0, 0, 0, 0], corner: 'round' } } as never, appearance: [fillItem({ kind: 'solid', colour: [0, 0.9, 0.8, 0], swatch: 'w1', tint: 1 } as never)] }), 'root', 0)
const pdf2 = await docToPdf(cmyk, pdfHost(fakeIcc))
const text2 = new TextDecoder('latin1').decode(pdf2.bytes)
const rp2 = await readPdf(pdf2.bytes)
check('CMYK: an output intent for PDF/X, with the profile', text2.includes('/OutputIntents') && text2.includes('/GTS_PDFX') && text2.includes('/DestOutputProfile'))
check('a spot swatch is a Separation of its own name', /\/Separation\s*\/House#20Red/.test(text2))
check('trim and bleed boxes are given', text2.includes('/TrimBox') && text2.includes('/BleedBox'))
check('and pdf.js draws it', rp2.pages === 1 && rp2.ops.includes('constructPath'))
const streams = [...text2.matchAll(/stream\r?\n/g)].length
check('streams are compressed', streams > 0 && text2.includes('/FlateDecode'))
/** Every stream in a PDF, inflated where it's compressed, as text. */
const streamsOf = (bytes: Uint8Array) => {
  const t = new TextDecoder('latin1').decode(bytes)
  const out: string[] = []
  for (const m of t.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length
    const end = t.indexOf('endstream', start)
    const body = bytes.subarray(start, end)
    try {
      out.push(new TextDecoder('latin1').decode(inflateSync(body)))
    } catch {
      out.push(t.slice(start, end))
    }
  }
  return out.join('\n')
}
const pdf3 = streamsOf((await docToPdf(aligned, pdfHost(fakeIcc))).bytes)
check('and in the PDF: a clip, then the doubled stroke', /W n\s+8 w/.test(pdf3) && /re\s[^Q]*W\* n\s+8 w/.test(pdf3))

console.log(failures ? `\n${failures} failure(s)` : '\nall clear')
process.exit(failures ? 1 : 0)
