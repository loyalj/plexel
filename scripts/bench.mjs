/**
 * The bench: what PERFORMANCE.md's numbers come from, on this machine's
 * GPU, in Chrome.
 *
 *   uploads    tiles from the tile store into the GPU atlas, in MB/s
 *   compositing  a view's worth of tiles under eight blended layers, per
 *              storage format: what the 16-bit decision rests on
 *   first frame  a 96-megapixel document, from being opened to its first
 *              frame and to its last tile
 *   pan, zoom, rotate  frame by frame, at 100% on that document: frame
 *              intervals, CPU time to build each frame, tiles still to do
 *   painting   a long stroke on that document, four pen samples a frame:
 *              frame times while painting, and the bake when the pen lifts;
 *              the same with the Mixer Brush and with Smudge
 *   selections  on that document: Select All, an ellipse, a 20-pixel
 *              feather, the magic wand; then panning with the ellipse as a
 *              layer mask and its marching ants on screen
 *
 * Every figure is printed, and the lot is written as JSON to the path in
 * BENCH_OUT if that's set. Budgets live in PERFORMANCE.md; this reports,
 * and says which budgets it met.
 *
 * Run with: npm run bench
 */
import { writeFileSync } from 'node:fs'
import { finish, open, waitForEngine, waitUntil } from './harness.mjs'

const { page, url } = await open({ viewport: { width: 1600, height: 1000 } })
await page.goto(url)
await waitForEngine(page)

const call = (method, args) => page.evaluate((m, a) => globalThis.plexel.engine().call(m, a), method, args)
const probe = (args) => call('test.probe', args)
const out = { when: new Date().toISOString() }
const ms = (x) => `${x.toFixed(1)} ms`
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0
}

const gpu = await page.evaluate(() => globalThis.plexel.engine().getState().gpu)
out.gpu = { vendor: gpu.vendor, architecture: gpu.architecture, description: gpu.description, features: gpu.features }
console.log(`\nGPU: ${[gpu.vendor, gpu.architecture, gpu.description].filter(Boolean).join(' · ')}`)

// --- uploads ---------------------------------------------------------------------------
console.log('\nuploads (tile store → GPU atlas)')
out.upload = {}
for (const [mode, depth, count] of [['rgb', 8, 256], ['rgb', 16, 128], ['cmyk', 8, 128]]) {
  const r = await probe({ kind: 'bench.upload', mode, depth, count })
  out.upload[`${mode}/${depth}`] = r
  console.log(`  ${mode.toUpperCase()} ${depth}-bit: ${count} tiles in ${ms(r.ms)}, ${(r.bytesPerSecond / 1e6).toFixed(0)} MB/s`)
}

// --- compositing per storage format ----------------------------------------------------------
console.log('\ncompositing: 8 blended layers over 16 tiles, GPU time')
out.composite = {}
const f16 = gpu.features.includes('shader-f16')
for (const [depth, stores] of [[8, f16 ? ['f32', 'f16'] : ['f32']], [16, f16 ? ['f32', 'f16'] : ['f32']]]) {
  for (const store of stores) {
    const r = await probe({ kind: 'bench.composite', mode: 'rgb', depth, store, layers: 8, count: 16 })
    out.composite[`${depth}/${store}`] = r
    console.log(`  RGB ${depth}-bit in ${store}: ${ms(r.ms)} (${ms(r.perTileMs)} a tile), ${(r.bufferBytes / 1024).toFixed(0)} KB a composite tile`)
  }
}

// --- a big document ---------------------------------------------------------------------------
console.log('\na 12,000 × 8,000 document (96 MP), one layer of noise over a white background')
const W = 12000
const H = 8000
let t = Date.now()
const noise = await probe({ kind: 'bench.noise', mode: 'rgb', depth: 8, width: W, height: H })
const white = await call('tiles.fill', { format: { mode: 'rgb', depth: 8 }, width: W, height: H, value: [255, 255, 255, 255] })
out.makeMs = Date.now() - t
console.log(`  made its tiles in ${ms(out.makeMs)}`)
// Frames are recorded on the page as they're reported.
await page.evaluate(() => {
  globalThis.benchFrames = []
  globalThis.plexel.engine().onFrame((m) => globalThis.benchFrames.push({ at: performance.now(), ms: m.ms, rendered: m.rendered, pending: m.pending }))
})
const opened = await page.evaluate(
  (w, h, noiseId, whiteId) => {
    const { createDoc, insertNode, makeNode } = globalThis.plexel.doc
    let doc = createDoc({ name: 'Bench', width: w, height: h, resolution: 300, mode: 'rgb', depth: 8, profile: { builtin: 'srgb' } }, 'bench-root')
    doc = insertNode(doc, makeNode('pixel', 'bench-bg', 'Background', { tiles: whiteId }), doc.root, 0)
    doc = insertNode(doc, makeNode('pixel', 'bench-noise', 'Noise', { tiles: noiseId }), doc.root, 1)
    globalThis.benchFrames.length = 0
    const at = performance.now()
    globalThis.plexel.documents().add({ doc, file: null, saved: true })
    return at
  },
  W,
  H,
  noise,
  white,
)
await waitUntil(page, () => globalThis.benchFrames.some((f) => f.rendered > 0), { timeout: 20000 })
await waitUntil(page, () => { const f = globalThis.benchFrames; return f.length > 2 && f[f.length - 1].pending === 0 }, { timeout: 60000 })
const first = await page.evaluate((t0) => {
  const f = globalThis.benchFrames
  return { firstPicture: f.find((x) => x.rendered > 0).at - t0, complete: f[f.length - 1].at - t0, frames: f.length, tiles: f.reduce((a, x) => a + x.rendered, 0) }
}, opened)
out.firstFrame = first
console.log(`  first picture after ${ms(first.firstPicture)}, every tile in view after ${ms(first.complete)} (${first.tiles} tiles over ${first.frames} frames)`)

/** Runs `step` once a frame for `n` frames and reports what the engine did meanwhile. */
async function frames(name, n, step) {
  await page.evaluate(() => (globalThis.benchFrames.length = 0))
  await page.evaluate(
    (count, body) =>
      new Promise((resolve) => {
        const fn = new Function('i', body)
        let i = 0
        const tick = () => {
          fn(i)
          if (++i < count) requestAnimationFrame(tick)
          else resolve()
        }
        requestAnimationFrame(tick)
      }),
    n,
    step,
  )
  await waitUntil(page, () => { const f = globalThis.benchFrames; return f.length && f[f.length - 1].pending === 0 }, { timeout: 60000 })
  const f = await page.evaluate(() => globalThis.benchFrames)
  const gaps = f.slice(1).map((x, i) => x.at - f[i].at)
  const r = {
    frames: f.length,
    intervalMedian: pct(gaps, 50),
    intervalP95: pct(gaps, 95),
    cpuMedian: pct(f.map((x) => x.ms), 50),
    cpuP95: pct(f.map((x) => x.ms), 95),
    tiles: f.reduce((a, x) => a + x.rendered, 0),
    maxPending: Math.max(...f.map((x) => x.pending)),
    settleMs: f[f.length - 1].at - f[0].at,
  }
  out[name] = r
  console.log(`  ${name}: ${r.frames} frames, interval median ${ms(r.intervalMedian)} p95 ${ms(r.intervalP95)}; CPU median ${ms(r.cpuMedian)} p95 ${ms(r.cpuP95)}; ${r.tiles} tiles rendered, at most ${r.maxPending} waiting`)
  return r
}

// The display's own rate, which no engine frame can beat.
const display = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const t = []
      const tick = (now) => {
        t.push(now)
        if (t.length < 61) requestAnimationFrame(tick)
        else resolve(t.slice(1).map((x, i) => x - t[i]))
      }
      requestAnimationFrame(tick)
    }),
)
out.displayInterval = pct(display, 50)
console.log(`\nthe display refreshes every ${ms(out.displayInterval)}`)

console.log('\nat 100%')
await page.evaluate(() => globalThis.plexel.views().actualSize())
await waitUntil(page, () => { const f = globalThis.benchFrames; return f.length && f[f.length - 1].pending === 0 }, { timeout: 60000 })
await frames('pan', 120, 'globalThis.plexel.views().pan(-12, -4)')
await frames('zoom', 120, 'globalThis.plexel.views().zoomBy(i < 60 ? 0.97 : 1 / 0.97, [800, 500])')
await frames('rotate', 90, 'globalThis.plexel.views().rotateBy(1)')

// --- painting --------------------------------------------------------------------------
console.log('\npainting on it at 100%: a 60-pixel brush, four pen samples a frame for 120 frames')
// The brush's own settings filled out from the app's defaults, so the bench paints what the app would.
const brush = { tip: 'round', size: 60, hardness: 0.8, spacing: 0.1, smoothing: 0.1, dynamics: [{ input: 'pressure', target: 'size', curve: [0, 1], min: 0.15 }] }
/** A 480-sample stroke across the view, four samples a frame, then the time to bake it; with `sampling`, Smudge's or the Mixer's. */
const paintStroke = async (label, settings, sampling, id) => {
  await page.evaluate(() => (globalThis.benchFrames.length = 0))
  const painted = await page.evaluate(
    async (settings, sampling, id) => {
      const e = globalThis.plexel.engine()
      const d = globalThis.plexel.documents().active()
      const v = globalThis.plexel.views().front()
      const full = { ...globalThis.plexel.brushes().get().brush, ...settings }
      e.beginStroke({ id, key: d.key, node: 'bench-noise', settings: full, eraser: false, seed: 1, fg: [1, 0.2, 0], bg: [0, 0, 1], ...(sampling ? { sampling } : {}) })
      let t = 0
      for (let f = 0; f < 120; f++) {
        await new Promise((r) => requestAnimationFrame(r))
        const samples = []
        for (let k = 0; k < 4; k++, t++) samples.push({ x: v.cx - 500 + t * 2, y: v.cy + Math.sin(t / 30) * 200, pressure: 0.5 + 0.5 * Math.sin(t / 40), tiltX: 0, tiltY: 0, twist: 0, t: t * 4 })
        e.strokeSamples(id, samples)
      }
      const t0 = performance.now()
      await e.call('stroke.end', { id })
      return { bakeMs: performance.now() - t0 }
    },
    settings,
    sampling,
    id,
  )
  const pf = await page.evaluate(() => globalThis.benchFrames)
  const pgaps = pf.slice(1).map((x, i) => x.at - pf[i].at)
  const r = {
    frames: pf.length,
    intervalMedian: pct(pgaps, 50),
    intervalP95: pct(pgaps, 95),
    cpuMedian: pct(pf.map((x) => x.ms), 50),
    cpuP95: pct(pf.map((x) => x.ms), 95),
    bakeMs: painted.bakeMs,
  }
  console.log(`  ${label}: ${pf.length} frames, interval median ${ms(r.intervalMedian)} p95 ${ms(r.intervalP95)}; CPU median ${ms(r.cpuMedian)} p95 ${ms(r.cpuP95)}; baked ${ms(r.bakeMs)} after the pen lifts`)
  return r
}
out.paint = await paintStroke('the Brush', brush, null, 4242)
// The Mixer and Smudge pick up a 64 × 64 patch and put it down every dab, the same stroke.
out.paintMixer = await paintStroke('the Mixer Brush, wet, loaded, half mix', brush, { tool: 'mixer', strength: 0, fingerPainting: false, wet: 1, load: 0.5, mix: 0.5, reservoir: [0, 0.4, 1], sampleAll: false }, 4243)
out.paintSmudge = await paintStroke('Smudge at 70%', brush, { tool: 'smudge', strength: 0.7, fingerPainting: false, wet: 0, load: 0, mix: 0, reservoir: null, sampleAll: false }, 4244)

// --- selections and masks ----------------------------------------------------------------------
console.log('\nselections and masks on it')
const timed = async (name, fn) => {
  const t0 = Date.now()
  const r = await fn()
  out.select ??= {}
  out.select[name] = Date.now() - t0
  console.log(`  ${name}: ${ms(out.select[name])}`)
  return r
}
const key = await page.evaluate(() => globalThis.plexel.documents().active().key)
await timed('Select All', () => call('select.all', { width: W, height: H }))
const ellipse = await timed('an ellipse filling the canvas', () => call('select.shape', { width: W, height: H, shape: { kind: 'ellipse', x0: 200, y0: 200, x1: W - 200, y1: H - 200 }, antialias: true, feather: 0, op: 'replace', current: null }))
const feathered = await timed('feathering it by 20 px', () => call('select.modify', { width: W, height: H, current: ellipse, modify: { kind: 'feather', radius: 20 } }))
await timed('the magic wand on the composite', () => call('select.wand', { key, x: 10, y: 10, tolerance: 32, contiguous: true, node: null, antialias: true, op: 'replace', current: null }))
// The feathered ellipse as the noise layer's mask, and as the selection.
await page.evaluate((sel) => {
  const store = globalThis.plexel.documents()
  store.commit((d) => {
    const mask = { ...d.nodes['bench-noise'] }
    const m = { id: 'bench-mask', kind: 'mask', name: 'Mask', visible: true, locked: { pixels: false, position: false, all: false }, opacity: 1, fillOpacity: 1, blend: 'normal', blendIf: null, transform: [1, 0, 0, 1, 0, 0], masks: [], effects: [], fx: [], tag: null, props: { source: 'pixel', tiles: sel, geometry: null, density: 1, feather: 8, invert: false, outside: 0 } }
    return { ...d, selection: { tiles: sel, path: null }, nodes: { ...d.nodes, 'bench-mask': m, 'bench-noise': { ...mask, masks: ['bench-mask'] } } }
  })
}, feathered)
await waitUntil(page, () => { const f = globalThis.benchFrames; return f.length && f[f.length - 1].pending === 0 }, { timeout: 60000 })
await frames('pan with a mask and ants', 120, 'globalThis.plexel.views().pan(12, 4)')

// --- adjustments and a live filter -------------------------------------------------------------
console.log('\nthree adjustment layers and a live blur on it')
await page.evaluate(() => (globalThis.benchFrames.length = 0))
await page.evaluate(() => {
  const store = globalThis.plexel.documents()
  store.commit((d) => {
    const { makeNode } = globalThis.plexel.doc
    const curves = makeNode('adjustment', 'bench-curves', 'Curves', { adjustment: 'curves', params: { curves: { master: [[0, 0], [0.3, 0.2], [0.7, 0.85], [1, 1]] } } })
    const hue = makeNode('adjustment', 'bench-hue', 'Hue/Saturation', { adjustment: 'hue-saturation', params: { hue: 30, saturation: 20 } })
    const levels = makeNode('adjustment', 'bench-levels', 'Levels', { adjustment: 'levels', params: {} })
    const blur = makeNode('filter', 'bench-blur', 'Gaussian Blur', { filter: 'gaussian-blur', params: { radius: 8 } })
    const root = d.nodes[d.root]
    const noise = d.nodes['bench-noise']
    return {
      ...d,
      nodes: { ...d.nodes, 'bench-curves': curves, 'bench-hue': hue, 'bench-levels': levels, 'bench-blur': blur, 'bench-noise': { ...noise, effects: ['bench-blur'] }, [d.root]: { ...root, children: [...root.children, 'bench-curves', 'bench-hue', 'bench-levels'] } },
    }
  })
})
const t7 = Date.now()
// Frames since the change: some drawing tiles, the last with none left.
await waitUntil(page, () => { const f = globalThis.benchFrames; return f.some((x) => x.rendered > 0) && f[f.length - 1].pending === 0 }, { timeout: 120000 })
out.effectsRedrawMs = Date.now() - t7
console.log(`  every tile in view drawn again with them in ${ms(out.effectsRedrawMs)}`)
await frames('pan with adjustments and a blur', 120, 'globalThis.plexel.views().pan(-12, -4)')

// --- vectors ------------------------------------------------------------------------------------
console.log('\ntwo hundred shapes, a compound shape and a path of 4,000 points')
await page.evaluate(() => (globalThis.benchFrames.length = 0))
await page.evaluate(() => {
  const store = globalThis.plexel.documents()
  store.commit((d) => {
    const { makeNode } = globalThis.plexel.doc
    const nodes = { ...d.nodes }
    const ids = []
    let seed = 5
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
    const colour = () => [rand(), rand(), rand()]
    const types = ['rect', 'ellipse', 'star', 'polygon']
    for (let i = 0; i < 200; i++) {
      const t = types[i % 4]
      const w = 200 + rand() * 1400
      const h = 200 + rand() * 1400
      const x = rand() * (d.width - w)
      const y = rand() * (d.height - h)
      const shape = t === 'rect' ? { type: t, x, y, w, h, radii: [40, 40, 40, 40], corner: 'round' } : t === 'star' ? { type: t, x, y, w, h, points: 7, inner: 0.5 } : t === 'polygon' ? { type: t, x, y, w, h, sides: 6 } : { type: t, x, y, w, h }
      const paint = i % 3 === 0 ? { kind: 'gradient', type: 'linear', stops: [{ at: 0, colour: colour(), alpha: 1 }, { at: 1, colour: colour(), alpha: 0.6 }], angle: 30, scale: 100, reverse: false } : i % 7 === 0 ? { kind: 'pattern', pattern: 'dots', colour: colour(), background: colour(), backgroundAlpha: 1, size: 24, angle: 15 } : { kind: 'solid', colour: colour() }
      const appearance = [{ kind: 'fill', enabled: true, paint, opacity: 0.85, blend: 'normal' }]
      if (i % 2) appearance.push({ kind: 'stroke', enabled: true, paint: { kind: 'solid', colour: colour() }, opacity: 1, blend: 'normal', width: 12, join: 'round', cap: 'round', miter: 4, dash: i % 4 === 1 ? [30, 15] : [], dashOffset: 0, align: 'centre' })
      const id = `bench-shape-${i}`
      nodes[id] = makeNode('vector', id, `Shape ${i}`, { geometry: { kind: 'shape', shape }, appearance })
      ids.push(id)
    }
    // A compound: a big ring with circles taken out of it.
    const ring = (id, x, y, r) => makeNode('vector', id, id, { geometry: { kind: 'shape', shape: { type: 'ellipse', x: x - r, y: y - r, w: 2 * r, h: 2 * r } }, appearance: [] })
    const kids = ['bench-c0', 'bench-c1', 'bench-c2', 'bench-c3']
    nodes['bench-c0'] = ring('bench-c0', d.width / 2, d.height / 2, 2500)
    nodes['bench-c1'] = ring('bench-c1', d.width / 2, d.height / 2, 1800)
    nodes['bench-c2'] = ring('bench-c2', d.width / 2 - 1500, d.height / 2, 900)
    nodes['bench-c3'] = ring('bench-c3', d.width / 2 + 1500, d.height / 2, 900)
    const compound = makeNode('boolean', 'bench-compound', 'Compound', { ops: { 'bench-c1': 'subtract', 'bench-c2': 'add', 'bench-c3': 'exclude' }, appearance: [{ kind: 'fill', enabled: true, paint: { kind: 'solid', colour: [0.2, 0.4, 0.9] }, opacity: 0.7, blend: 'multiply' }, { kind: 'stroke', enabled: true, paint: { kind: 'solid', colour: [0, 0, 0] }, opacity: 1, blend: 'normal', width: 20, join: 'miter', cap: 'butt', miter: 4, dash: [], dashOffset: 0, align: 'outside' }] })
    compound.children = kids
    nodes['bench-compound'] = compound
    for (const k of kids) nodes[k] = nodes[k]
    // A long scribble: a path of 4,000 smooth points.
    const anchors = []
    for (let i = 0; i < 4000; i++) {
      const t = i / 4000
      const x = d.width * (0.1 + 0.8 * t)
      const y = d.height * (0.5 + 0.35 * Math.sin(t * 60) * Math.cos(t * 7))
      anchors.push({ p: [x, y], in: [x - 6, y - 4], out: [x + 6, y + 4], smooth: true })
    }
    nodes['bench-path'] = makeNode('vector', 'bench-path', 'Scribble', { geometry: { kind: 'path', path: { fillRule: 'nonzero', subpaths: [{ closed: false, anchors }] } }, appearance: [{ kind: 'stroke', enabled: true, paint: { kind: 'solid', colour: [0.9, 0.1, 0.1] }, opacity: 1, blend: 'normal', width: 16, join: 'round', cap: 'round', miter: 4, dash: [], dashOffset: 0, align: 'centre' }] })
    const root = nodes[d.root]
    nodes[d.root] = { ...root, children: [...root.children, ...ids, 'bench-compound', 'bench-path'] }
    return { ...d, nodes }
  })
})
const t8 = Date.now()
await waitUntil(page, () => { const f = globalThis.benchFrames; return f.some((x) => x.rendered > 0) && f[f.length - 1].pending === 0 }, { timeout: 120000 })
out.vectorRedrawMs = Date.now() - t8
console.log(`  every tile in view drawn again with them in ${ms(out.vectorRedrawMs)}`)
await frames('pan with shapes', 120, 'globalThis.plexel.views().pan(12, -4)')
await page.evaluate(() => (globalThis.benchFrames.length = 0))
// Zoomed out to the whole document: every shape at once, from the coarse mips.
const t9 = Date.now()
await page.evaluate(() => globalThis.plexel.views().fit())
await waitUntil(page, () => { const f = globalThis.benchFrames; return f.some((x) => x.rendered > 0) && f[f.length - 1].pending === 0 }, { timeout: 120000 })
out.vectorFitMs = Date.now() - t9
console.log(`  fitted on screen, every shape drawn in ${ms(out.vectorFitMs)}`)

// --- type ---------------------------------------------------------------------------------------
console.log('\na page of dense text: 60,000 characters of area text, set every-line')
await page.evaluate(() => globalThis.plexel.text.startFonts().then(() => true))
await page.evaluate(() => globalThis.plexel.views().fit())
await page.evaluate(() => (globalThis.benchFrames.length = 0))
const WORDS = 'the quick brown fox jumps over a lazy dog while sphinxes of black quartz judge my vow and five boxing wizards jump quickly past'.split(' ')
const paragraphs = []
{
  let seed = 9
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  let total = 0
  while (total < 60000) {
    const words = []
    let len = 0
    while (len < 700) {
      const w = WORDS[Math.floor(rand() * WORDS.length)]
      words.push(w)
      len += w.length + 1
    }
    const text = words.join(' ').replace(/^./, (c) => c.toUpperCase()) + '.'
    paragraphs.push(text)
    total += text.length + 1
  }
}
out.textChars = paragraphs.reduce((a, p) => a + p.length + 1, 0)
const t10 = Date.now()
await page.evaluate((paras) => {
  const store = globalThis.plexel.documents()
  store.commit((d) => {
    const { makeNode } = globalThis.plexel.doc
    const n = makeNode('text', 'bench-text', 'Dense text', {
      mode: 'area',
      content: { paragraphs: paras.map((text) => ({ runs: [{ text, style: null, props: { size: 22 } }], style: null, props: { align: 'justify', spaceAfter: 11 } })) },
      frame: { kind: 'shape', shape: { type: 'rect', x: 600, y: 600, w: 5200, h: 6800, radii: [0, 0, 0, 0], corner: 'round' } },
      pathOffset: 0,
      appearance: [{ kind: 'fill', enabled: true, paint: { kind: 'solid', colour: [0.05, 0.05, 0.1] }, opacity: 1, blend: 'normal' }],
    })
    const root = d.nodes[d.root]
    return { ...d, nodes: { ...d.nodes, 'bench-text': n, [d.root]: { ...root, children: [...root.children, 'bench-text'] } } }
  })
}, paragraphs)
await waitUntil(page, () => { const f = globalThis.benchFrames; return f.some((x) => x.rendered > 0) && f[f.length - 1].pending === 0 }, { timeout: 120000 })
out.textRedrawMs = Date.now() - t10
// Layout alone, again from nothing (a copy of the node misses the cache).
const lay = await page.evaluate(() => {
  const d = globalThis.plexel.documents().active().history.present
  const n = { ...d.nodes['bench-text'] }
  const t = performance.now()
  const l = globalThis.plexel.text.layoutOf(n, d)
  return { ms: performance.now() - t, glyphs: l.glyphs.placements.length / 7, outlines: l.glyphs.outlines.length, lines: l.lines.length, overflow: l.overflow }
})
out.textLayout = lay
console.log(`  laid out (HarfBuzz, line breaking, Knuth–Plass) in ${ms(lay.ms)}: ${lay.glyphs} glyphs from ${lay.outlines} outlines, ${lay.lines} lines${lay.overflow ? ', overflowing' : ''}`)
console.log(`  fitted on screen, laid out and every glyph drawn in ${ms(out.textRedrawMs)}`)
// At 100%, over the text: then panning across it.
await page.evaluate(() => {
  globalThis.plexel.views().actualSize()
  globalThis.plexel.views().centreOn(2000, 2000)
})
await page.evaluate(() => (globalThis.benchFrames.length = 0))
const t11 = Date.now()
await waitUntil(page, () => { const f = globalThis.benchFrames; return f.some((x) => x.rendered > 0) && f[f.length - 1].pending === 0 }, { timeout: 120000 })
out.textCloseMs = Date.now() - t11
console.log(`  at 100%, every tile in view drawn in ${ms(out.textCloseMs)}`)
await frames('pan over text', 120, 'globalThis.plexel.views().pan(-10, -6)')

// --- print colour ---------------------------------------------------------------------------------
console.log('\nprint colour: the 96 MP document proofed on CMYK, then converted to it')
await page.evaluate(() => globalThis.plexel.views().fit())
await waitUntil(page, () => { const f = globalThis.benchFrames; return f.length && f[f.length - 1].pending === 0 }, { timeout: 120000 })
await page.evaluate(() => (globalThis.benchFrames.length = 0))
const t12 = Date.now()
await page.evaluate(() => {
  const key = globalThis.plexel.documents().getState().active
  globalThis.plexel.proofing.update(key, { proof: true, gamut: true })
})
await waitUntil(page, () => { const f = globalThis.benchFrames; return f.some((x) => x.rendered > 0) && f[f.length - 1].pending === 0 }, { timeout: 120000 })
out.proofRedrawMs = Date.now() - t12
console.log(`  Proof Colours and the Gamut Warning on: every tile in view drawn again in ${ms(out.proofRedrawMs)}`)
await frames('pan proofed', 120, 'globalThis.plexel.views().pan(10, 6)')
await page.evaluate(() => {
  const key = globalThis.plexel.documents().getState().active
  globalThis.plexel.proofing.update(key, { proof: false, gamut: false })
})
await page.evaluate(() => (globalThis.benchFrames.length = 0))
const t13 = Date.now()
const converted = await page.evaluate(() => globalThis.plexel.convert.convertDocument({ mode: 'cmyk', profile: { builtin: 'generic-cmyk' }, depth: 8 }, 'relative', true, 'CMYK Colour'))
out.convertMs = Date.now() - t13
await waitUntil(page, () => { const f = globalThis.benchFrames; return f.some((x) => x.rendered > 0) && f[f.length - 1].pending === 0 }, { timeout: 120000 })
out.convertDrawnMs = Date.now() - t13
console.log(`  converted to CMYK${converted ? '' : ' (FAILED)'}: pixels and everything else in ${ms(out.convertMs)}, drawn in CMYK after ${ms(out.convertDrawnMs)}`)

// --- interchange ---------------------------------------------------------------------------------
console.log('\ninterchange: the 96 MP CMYK document, with its shapes, text and adjustments, as a PSD')
// Started on the page and waited for, since it runs longer than one call to the page may.
await page.evaluate(() => {
  const P = globalThis.plexel
  const d = P.documents().active()
  globalThis.benchPsd = null
  const t0 = performance.now()
  P.exports
    .psdOf(d.history.present, d.key, false)
    .then(async (ex) => {
      const writeMs = performance.now() - t0
      const t1 = performance.now()
      await P.files.openFile(new File([ex.bytes], 'bench.psd'), null)
      const openMs = performance.now() - t1
      const reopened = P.documents().active()
      const layers = Object.values(reopened.history.present.nodes).filter((n) => n.kind !== 'mask').length - 1
      globalThis.benchFrames.length = 0
      globalThis.benchPsd = { writeMs, size: ex.bytes.length, openMs, layers, warnings: ex.warnings.length, key: reopened.key, original: d.key, opened: t1 + openMs }
    })
    .catch((e) => (globalThis.benchPsd = { error: e instanceof Error ? e.message : String(e) }))
})
// Polled from here: a wait inside the page would be one call held open past the protocol's limit.
for (let i = 0; i < 1200 && !(await page.evaluate(() => globalThis.benchPsd !== null)); i++) await new Promise((r) => setTimeout(r, 1000))
const psd = await page.evaluate(() => globalThis.benchPsd)
out.psd = psd
if (!psd) console.log('  FAILED: not finished within 20 minutes')
else if (psd.error) console.log(`  FAILED: ${psd.error}`)
else {
  console.log(`  written in ${ms(psd.writeMs)} (${(psd.size / 2 ** 20).toFixed(0)} MB, ${psd.warnings} things said), opened again in ${ms(psd.openMs)} with ${psd.layers} layers`)
  // The reopened document drawn, fitted: until a frame has nothing left, for at most two minutes.
  let drawn = null
  for (let i = 0; i < 120 && drawn === null; i++) {
    // From the first frame that has the reopened document's tiles to draw: frames before it have nothing pending only because it hasn't started.
    drawn = await page.evaluate((at) => {
      const f = globalThis.benchFrames
      const k = f.findIndex((x) => x.pending > 0 || x.rendered > 0)
      const done = k < 0 ? undefined : f.slice(k).find((x) => x.pending === 0)
      return done ? done.at - at : null
    }, psd.opened)
    if (drawn === null) await new Promise((r) => setTimeout(r, 1000))
  }
  const last = await page.evaluate(() => globalThis.benchFrames.at(-1) ?? null)
  out.psd.drawnMs = drawn
  console.log(drawn !== null ? `  and drawn, fitted, ${ms(drawn)} after opening` : `  not drawn within two minutes of opening: ${last ? last.pending : '?'} tiles still waiting`)
  await page.evaluate((k, o) => { globalThis.plexel.documents().remove(k); globalThis.plexel.documents().activate(o) }, psd.key, psd.original)
}

const stats = await call('render.stats', {})
out.stats = stats
console.log(`\nGPU memory: tile atlas ${(stats.tileAtlasBytes / 2 ** 20).toFixed(0)} MB (${stats.tileAtlasUsed} tiles), display atlas ${(stats.displayAtlasBytes / 2 ** 20).toFixed(0)} MB (${stats.displayTiles} tiles), group cache ${(stats.groupCacheBytes / 2 ** 20).toFixed(0)} MB`)

// --- against the budgets -----------------------------------------------------------------------
const BUDGETS = [
  ['uploads, RGB 8-bit, at least 500 MB/s', out.upload['rgb/8'].bytesPerSecond >= 500e6],
  ['a 96 MP document shows a first picture within 1 s', first.firstPicture <= 1000],
  ['and every tile in view within 3 s', first.complete <= 3000],
  ['panning keeps up with the display: median frame interval within 10% of its refresh', out.pan.intervalMedian <= out.displayInterval * 1.1],
  ['panning: CPU time a frame at most 8 ms at the 95th percentile', out.pan.cpuP95 <= 8],
  ['zooming keeps up with the display', out.zoom.intervalMedian <= out.displayInterval * 1.1],
  ['rotating keeps up with the display', out.rotate.intervalMedian <= out.displayInterval * 1.1],
  ['painting keeps up with the display', out.paint.intervalMedian <= out.displayInterval * 1.1],
  ['painting: CPU time a frame at most 8 ms at the 95th percentile', out.paint.cpuP95 <= 8],
  ['a stroke is baked within 250 ms of the pen lifting', out.paint.bakeMs <= 250],
  ['the Mixer Brush keeps up with the display', out.paintMixer.intervalMedian <= out.displayInterval * 1.1],
  ['and its CPU time a frame is at most 8 ms at the 95th percentile', out.paintMixer.cpuP95 <= 8],
  ['Smudge keeps up with the display', out.paintSmudge.intervalMedian <= out.displayInterval * 1.1],
  ['and its CPU time a frame is at most 8 ms at the 95th percentile', out.paintSmudge.cpuP95 <= 8],
  ['a Mixer or Smudge stroke is baked within 250 ms of the pen lifting', Math.max(out.paintMixer.bakeMs, out.paintSmudge.bakeMs) <= 250],
  ['Select All on 96 MP within 100 ms', out.select['Select All'] <= 100],
  ['an antialiased ellipse on 96 MP within 1 s', out.select['an ellipse filling the canvas'] <= 1000],
  ['feathering it within 2 s', out.select['feathering it by 20 px'] <= 2000],
  ['the magic wand on 96 MP within 3 s', out.select['the magic wand on the composite'] <= 3000],
  ['panning with a feathered mask and ants keeps up with the display', out['pan with a mask and ants'].intervalMedian <= out.displayInterval * 1.1],
  ['and its CPU time a frame is at most 8 ms at the 95th percentile', out['pan with a mask and ants'].cpuP95 <= 8],
  ['with three adjustment layers and a live blur, the view is drawn again within 3 s', out.effectsRedrawMs <= 3000],
  ['and panning keeps up with the display', out['pan with adjustments and a blur'].intervalMedian <= out.displayInterval * 1.1],
  ['its CPU time a frame at most 8 ms at the 95th percentile', out['pan with adjustments and a blur'].cpuP95 <= 8],
  ['with two hundred shapes, a compound and a 4,000-point path added, the view is drawn again within 3 s', out.vectorRedrawMs <= 3000],
  ['and panning with them keeps up with the display', out['pan with shapes'].intervalMedian <= out.displayInterval * 1.1],
  ['its CPU time a frame at most 8 ms at the 95th percentile', out['pan with shapes'].cpuP95 <= 8],
  ['fitting the whole document on screen draws every shape within 3 s', out.vectorFitMs <= 3000],
  ['60,000 characters of justified area text are laid out within 1 s', out.textLayout.ms <= 1000],
  ['and, fitted on screen, laid out and drawn within 3 s', out.textRedrawMs <= 3000],
  ['at 100% the view over the text is drawn within 1 s', out.textCloseMs <= 1000],
  ['panning over dense text keeps up with the display', out['pan over text'].intervalMedian <= out.displayInterval * 1.1],
  ['its CPU time a frame at most 8 ms at the 95th percentile', out['pan over text'].cpuP95 <= 8],
  ['proofing on CMYK with the gamut marked: the view drawn again within 3 s', out.proofRedrawMs <= 3000],
  ['panning proofed keeps up with the display', out['pan proofed'].intervalMedian <= out.displayInterval * 1.1],
  ['its CPU time a frame at most 8 ms at the 95th percentile', out['pan proofed'].cpuP95 <= 8],
  ['the 96 MP document converted to CMYK within 20 s', out.convertMs <= 20000],
  ['written as a PSD within 60 s', !!out.psd && !out.psd.error && out.psd.writeMs <= 60000],
  ['and opened again within 40 s', !!out.psd && !out.psd.error && out.psd.openMs <= 40000],
  ['and drawn within 3 s of opening', !!out.psd && out.psd.drawnMs !== null && out.psd.drawnMs <= 3000],
]
console.log('\nbudgets (PERFORMANCE.md)')
for (const [name, ok] of BUDGETS) console.log(`  ${ok ? 'met ' : 'MISS'}  ${name}`)
out.budgets = Object.fromEntries(BUDGETS)
if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify(out, null, 2))

await finish()
