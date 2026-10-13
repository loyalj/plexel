/**
 * Interchange in Chrome: files from other apps opened and drawn, and what
 * Plexel writes read back.
 *
 *   Photoshop's own renders: psd-tools' adjustment files carry the
 *   composite Photoshop drew; each opens and draws to match it.
 *   resvg's test suite: each SVG opens and draws as resvg drew it.
 *   Round trips: a PSD opened, written as PSD (and PSB) and opened again
 *   draws the same and has the same layers.
 *   SVG out: Chrome draws Plexel's SVG as Plexel draws the document.
 *   PDF out: pdf.js reads it, at the document's size, with its press
 *   furniture when it's CMYK.
 *   CMYK JPEGs open as CMYK, through our own decoder.
 *   The Export dialog offers the new formats.
 *
 * Run with: npm run check:interchange-browser
 */
import { readFileSync, readdirSync } from 'node:fs'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { check, finish, frames, open, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(url)
await waitForEngine(page)

/** Opens a file from disk through the app's own Open, as if picked. */
const openFile = (path, name = path.split('/').pop()) =>
  page.evaluate(
    async (b64, name) => {
      const P = globalThis.plexel
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      await P.files.openFile(new File([bytes], name), null)
      await P.engine().call('render.idle', {})
      const d = P.documents().active()
      return { key: d.key, mode: d.history.present.mode, width: d.history.present.width, height: d.history.present.height, label: d.history.past?.length ?? 0 }
    },
    readFileSync(path).toString('base64'),
    name,
  )

/** The active document as drawn: straight RGBA over its whole canvas, sRGB, or in the document's own values. */
const render = (srgb = true) =>
  page.evaluate(async (srgb) => {
    const P = globalThis.plexel
    const d = P.documents().active()
    await P.engine().call('render.idle', {})
    const r = await P.engine().call('render.nodeImage', { key: d.key, node: null, srgb })
    const W = d.history.present.width
    const H = d.history.present.height
    const ch = r.channels
    const out = new Array(W * H * 4).fill(0)
    for (let y = 0; y < r.h; y++)
      for (let x = 0; x < r.w; x++) {
        const X = x + r.x
        const Y = y + r.y
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue
        const i = (y * r.w + x) * ch
        const o = (Y * W + X) * 4
        const a = r.data[i + ch - 1]
        out[o] = r.data[i]
        out[o + 1] = ch >= 4 ? r.data[i + 1] : r.data[i]
        out[o + 2] = ch >= 4 ? r.data[i + 2] : r.data[i]
        out[o + 3] = a
      }
    return { W, H, data: out }
  }, srgb)

/** How far two renders are apart, over white: mean and the share of pixels more than 16 levels out, leaving a border of `edge` pixels. */
function compare(a, sample, edge = 0) {
  let sum = 0
  let n = 0
  let bad = 0
  for (let y = edge; y < a.H - edge; y++)
    for (let x = edge; x < a.W - edge; x++) {
      const o = (y * a.W + x) * 4
      const al = a.data[o + 3] / 255
      const ours = [0, 1, 2].map((c) => a.data[o + c] * al + 255 * (1 - al))
      const t = sample(x, y)
      const tl = (t[3] ?? 255) / 255
      const theirs = [0, 1, 2].map((c) => t[c] * tl + 255 * (1 - tl))
      const e = Math.max(...ours.map((v, c) => Math.abs(v - theirs[c])))
      sum += e
      n++
      if (e > 16) bad++
    }
  return { mean: sum / n, over: (bad / n) * 100 }
}
const fmt = (r) => `mean ${r.mean.toFixed(2)}, ${r.over.toFixed(2)}% over 16`
const refSampler = (png, W, H) => {
  const sx = png.width / W
  const sy = png.height / H
  return (x, y) => pixelAt(png, Math.min(png.width - 1, Math.floor((x + 0.5) * sx)), Math.min(png.height - 1, Math.floor((y + 0.5) * sy)))
}

// --- Photoshop's renders ----------------------------------------------------------------------------

console.log('adjustment layers draw as Photoshop drew them')
const PSD = 'scripts/fixtures/psd/'
// Mean and share-over-16 allowed. Brightness/Contrast's curve isn't published (ours is fitted to
// Photoshop's renders). Hue/Saturation's colour ranges come in, but this file's overlap and wrap round (custom
// limits) and Photoshop doesn't publish how overlapping ranges combine: with them it's further out than without.
const ADJ = {
  invert: [1, 0.5],
  threshold: [1.5, 0.5],
  levels: [1.5, 0.5],
  curves: [1.5, 0.5],
  exposure: [1.5, 0.5],
  posterize: [1.5, 0.5],
  brightnesscontrast: [10, 13],
  huesaturation: [19, 30],
}
for (const [name, [mean, over]] of Object.entries(ADJ)) {
  await openFile(`${PSD}adj_${name}_rgb.psd`)
  const a = await render(true)
  const r = compare(a, refSampler(decodePng(readFileSync(`${PSD}adj_${name}_rgb.png`)), a.W, a.H))
  check(`${name}`, r.mean <= mean && r.over <= over, fmt(r))
}
// Gray: psd-tools' PNG for this one isn't Photoshop's composite (the RGB ones are, exactly), so the
// composite Photoshop saved in the file is the reference, taken out as raw gray, in the file's own values.
await openFile(`${PSD}adj_levels_grayscale.psd`)
const g = await render(false)
const comp = readFileSync(`${PSD}adj_levels_grayscale.composite.gray`)
const gr = compare(g, (x, y) => [comp[y * g.W + x], comp[y * g.W + x], comp[y * g.W + x], 255])
check('levels, in a grayscale document (its own values)', gr.mean <= 1.5 && gr.over <= 0.5, fmt(gr))

// --- resvg's renders --------------------------------------------------------------------------------

console.log('\nSVGs draw as resvg drew them')
const SVG = 'scripts/fixtures/svg/'
for (const f of readdirSync(SVG).filter((f) => f.endsWith('.svg'))) {
  await openFile(SVG + f)
  const a = await render(true)
  // resvg drew them at 1.5×; the 1px frame round every case doesn't sample alike at the two sizes, so the edge is left out.
  const r = compare(a, refSampler(decodePng(readFileSync(SVG + f.replace(/\.svg$/, '.png'))), a.W, a.H), 3)
  // An embedded bitmap is resampled smoothly by resvg at 3.75×, which no 1× render can match exactly.
  const [mean, over] = f.includes('image') ? [12, 16] : [2, 3]
  check(f.replace(/\.svg$/, ''), r.mean <= mean && r.over <= over, fmt(r))
}

// --- round trips ------------------------------------------------------------------------------------

console.log('\nPSD written and read back draws the same')
const roundTrip = (psb) =>
  page.evaluate(async (psb) => {
    const P = globalThis.plexel
    const d = P.documents().active()
    const sig = (doc) =>
      Object.values(doc.nodes)
        .filter((n) => n.kind !== 'mask')
        .map((n) => `${n.kind}:${n.name}:${n.blend}:${Math.round(n.opacity * 100)}:${n.visible}:${n.fx.map((x) => x.kind).join('+')}:${n.masks.length}:${n.children?.length ?? 0}`)
        .sort()
        .join('|')
    const before = sig(d.history.present)
    const ex = await P.exports.psdOf(d.history.present, d.key, psb)
    const head = Array.from(ex.bytes.subarray(0, 6))
    await P.files.openFile(new File([ex.bytes], `round-trip.${psb ? 'psb' : 'psd'}`), null)
    await P.engine().call('render.idle', {})
    const after = sig(P.documents().active().history.present)
    return { same: before === after, head, warnings: ex.warnings, before, after }
  }, psb)
// Photoshop's patterns are images and Plexel's aren't yet, so a Pattern Overlay can't be written; it's said so,
// and the round trip is judged without it.
await openFile(PSD + 'layer_effects.psd')
const patternWarned = await page.evaluate(async () => {
  const P = globalThis.plexel
  const d = P.documents().active()
  return (await P.exports.psdOf(d.history.present, d.key, false)).warnings.some((w) => /Pattern Overlay/.test(w))
})
check('a Pattern Overlay, which can’t be written yet, is named as left out', patternWarned)
for (const f of ['blend-and-clipping.psd', 'layer_effects.psd', 'adj_curves_rgb.psd', 'mask.psd', 'vector-mask.psd', 'group.psd', 'text.psd', '4x4_8bit_cmyk.psd']) {
  await openFile(PSD + f)
  await page.evaluate(() => {
    const P = globalThis.plexel
    P.documents().commit((doc) => ({ ...doc, nodes: Object.fromEntries(Object.entries(doc.nodes).map(([k, n]) => [k, n.fx.some((x) => x.kind === 'pattern-overlay') ? { ...n, fx: n.fx.filter((x) => x.kind !== 'pattern-overlay') } : n])) }))
  })
  const a = await render(true)
  const r = await roundTrip(false)
  const b = await render(true)
  const d = compare(a, (x, y) => b.data.slice((y * b.W + x) * 4, (y * b.W + x) * 4 + 4))
  check(`${f}: the same layers, drawn the same`, r.same && d.mean <= 0.5 && d.over <= 0.2, `${fmt(d)}${r.same ? '' : `\n      before ${r.before.slice(0, 300)}\n      after  ${r.after.slice(0, 300)}`}`)
}
await openFile(PSD + 'group.psd')
const big = await roundTrip(true)
check('written as PSB, it’s a PSB (version 2) and reads back the same', big.same && big.head.join() === [56, 66, 80, 83, 0, 2].join())

// --- SVG and PDF out --------------------------------------------------------------------------------

console.log('\nSVG out: Chrome draws it as Plexel does')
const svgDrawn = async (outlines) => {
  const r = await page.evaluate(async (outlines) => {
    const P = globalThis.plexel
    const d = P.documents().active()
    const ex = await P.exports.svgOf(d.history.present, outlines)
    const text = new TextDecoder().decode(ex.bytes)
    const W = d.history.present.width
    const H = d.history.present.height
    const img = new Image()
    img.src = URL.createObjectURL(new Blob([ex.bytes], { type: 'image/svg+xml' }))
    await img.decode()
    const c = new OffscreenCanvas(W, H)
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0, W, H)
    return { W, H, data: Array.from(g.getImageData(0, 0, W, H).data), text: text.slice(0, 200000), warnings: ex.warnings }
  }, outlines)
  return r
}
for (const f of ['blend-and-clipping.psd', 'minimal_shape-layer.psd', 'clipping-mask.psd', 'layer_effects.psd']) {
  await openFile(PSD + f)
  const a = await render(true)
  const s = await svgDrawn(false)
  const d = compare(a, (x, y) => s.data.slice((y * s.W + x) * 4, (y * s.W + x) * 4 + 4))
  check(`${f}`, d.mean <= 2.5 && d.over <= 3, fmt(d))
}
await openFile(PSD + 'minimal_shape-layer.psd')
const shape = await svgDrawn(false)
check('a shape layer is a vector path in the SVG, not a picture', /<path[^>]+d="M/.test(shape.text) && !shape.text.includes('<image'))
await openFile(PSD + 'text.psd')
const live = await svgDrawn(false)
const outl = await svgDrawn(true)
check('text is live <text> by default, paths as outlines', live.text.includes('<text') && !outl.text.includes('<text') && outl.text.includes('<path'))

console.log('\nPDF out: pdf.js reads it')
const names = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]))
const pdfOf = () =>
  page.evaluate(async () => {
    const P = globalThis.plexel
    const d = P.documents().active()
    const ex = await P.exports.pdfOf(d.history.present)
    let s = ''
    for (let i = 0; i < ex.bytes.length; i += 0x8000) s += String.fromCharCode(...ex.bytes.subarray(i, i + 0x8000))
    return { b64: btoa(s), warnings: ex.warnings, w: d.history.present.width, h: d.history.present.height, res: d.history.present.resolution }
  })
const readPdf = async (b64) => {
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
  const doc = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise
  const p = await doc.getPage(1)
  const ops = (await p.getOperatorList()).fnArray.map((f) => names[f])
  return { pages: doc.numPages, view: p.view, ops, text: Buffer.from(bytes).toString('latin1') }
}
await openFile(PSD + 'group.psd')
const p1 = await pdfOf()
const r1 = await readPdf(p1.b64)
check('one page at the document’s size in points', r1.pages === 1 && Math.abs(r1.view[2] - (p1.w / p1.res) * 72) < 0.5 && Math.abs(r1.view[3] - (p1.h / p1.res) * 72) < 0.5, `${r1.view.join(' ')}`)
check('a shape layer is a path and a pixel layer an image', r1.ops.includes('constructPath') && r1.ops.includes('paintImageXObject'), [...new Set(r1.ops)].join(' '))
await openFile(PSD + 'text.psd')
const r3 = await readPdf((await pdfOf()).b64)
check('text is drawn as outlines', r3.ops.includes('constructPath') && !r3.ops.includes('showText'), [...new Set(r3.ops)].join(' ') + ' paths ' + r3.ops.filter((o) => o === 'constructPath').length)
// Blend modes PDF hasn't (Linear Burn and the like) flatten what's under them to one image.
await openFile(PSD + 'blend-and-clipping.psd')
const r4 = await readPdf((await pdfOf()).b64)
check('blends PDF lacks are flattened into an image, and it still draws', r4.pages === 1 && r4.ops.includes('paintImageXObject'))
await openFile(PSD + '4x4_8bit_cmyk.psd')
const p2 = await readPdf((await pdfOf()).b64)
check('a CMYK document: PDF/X output intent with its profile, and trim and bleed boxes', p2.text.includes('/OutputIntents') && p2.text.includes('/DestOutputProfile') && p2.text.includes('/TrimBox') && p2.text.includes('/BleedBox') && /\/N 4/.test(p2.text))

// --- JPEG ---------------------------------------------------------------------------------------------

console.log('\nCMYK JPEGs open, through our own decoder')
const jp = await openFile('scripts/fixtures/jpeg/cmyktest.jpg')
const jr = await render(true)
const ref = readFileSync('scripts/fixtures/jpeg/cmyktest.rgba')
// The reference is jpeg-js's plain CMYK-to-RGB; ours goes through the CMYK profile, so the colours differ
// (as they should) while the picture is the same: their lightness goes together, pixel for pixel.
const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
const xs = []
const ys = []
for (let i = 0; i < jr.W * jr.H; i++) {
  xs.push(luma(jr.data, i * 4))
  ys.push(luma(ref, i * 4))
}
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length
const mx = mean(xs)
const my = mean(ys)
const corr = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0))
check('it opens as a CMYK document, the right size, the same picture', jp.mode === 'cmyk' && jp.width === 300 && jp.height === 111 && corr > 0.95, `lightness correlation ${corr.toFixed(3)}`)
const prog = await openFile('scripts/fixtures/jpeg/skater-progressive.jpg')
check('progressive JPEGs open', prog.width === 256 && prog.mode === 'rgb')

// --- opening and the dialog -----------------------------------------------------------------------------

console.log('\nfiles route by what they are, and the Export dialog offers the formats')
const misnamed = await openFile(PSD + 'group.psd', 'group.bin')
check('a PSD is known by its signature whatever its name', misnamed.width === 100 && misnamed.height === 200)
const svgNamed = await openFile(SVG + 'shapes_rect_simple-case.svg', 'drawing')
check('so is an SVG', svgNamed.width === 200)
await page.keyboard.down('Control')
await page.keyboard.down('Alt')
await page.keyboard.down('Shift')
await page.keyboard.press('W')
await page.keyboard.up('Shift')
await page.keyboard.up('Alt')
await page.keyboard.up('Control')
await waitUntil(page, () => !!document.querySelector('#export-format'))
const formats = await page.$$eval('#export-format option', (os) => os.map((o) => o.value))
check('Export offers PSD, PSB, SVG and PDF', ['psd', 'psb', 'svg', 'pdf'].every((f) => formats.includes(f)), formats.join(' '))
await page.select('#export-format', 'svg')
await frames(page)
check('SVG offers text as outlines', !!(await page.$('[data-export-outlines]')))
await page.select('#export-format', 'pdf')
await frames(page)
const summary = await page.$eval('[data-export-summary]', (e) => e.textContent)
check('and each format says what it keeps', !!summary && summary.length > 20, summary ?? '')
await page.keyboard.press('Escape')

check('no errors on the page', errors.length === 0, errors.join(' | '))
await finish()
