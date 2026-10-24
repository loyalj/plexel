/**
 * The checks' probes: the GPU held to the CPU references, inside the engine
 * worker, on the real device. check-gpu calls these and judges the numbers.
 *
 * Each probe builds small documents out of random tiles, renders them
 * through the real render graph, reads the composite back, and compares it
 * pixel by pixel with ref/composite.ts, ref/blend.ts, ref/resample.ts and
 * color/lut.ts given the same samples. Loaded only when a check asks.
 */
import { builtinBrushes } from '../vector/brushLibrary'
import { BLEND_MODES, type BlendModeId, type ColourMode, type Depth, type DocNode, type LayerFx } from '../doc/types'
import { makeNode } from '../doc/nodes'
import { TILE, TILE_PIXELS, newSamples, planesOf, type Samples, type TileFormat } from '../tiles/format'
import type { TileStore } from '../tiles/store'
import { PLAIN_LOOK, displayRef, lutGamut, sampleLut, type Look } from '../color/lut'
import { DEFAULT_LOOK } from '../color/proof'
import { writeLutParams } from '../render/shaders/display'
import { cmykTablesFor } from '../engine/colourHost'
import { lutFor, colour } from '../engine/colourHost'
import type { Renderer } from '../render/renderer'
import { apply, clear, dissolve, tint, type Op, type Px } from '../render/ref/composite'
import { programFor, runProgram } from '../adjust/defs'
import { FILTER_BY_ID, filterValues, type Region } from '../filters/defs'
import { activeFx, fxValues } from '../fx/defs'
import { fxLayers } from '../fx/ref'
import { bakeEffects } from '../render/readback'
import { sample, type Filter } from '../render/ref/resample'
import { reduce, toWorking } from '../render/ref/working'
import { seedOf } from '../render/graph'
import type { SceneUpdate } from '../render/scene'
import { strideOf, tileBufferBytes, type Store } from '../render/shaders/common'
import { invert, multiply, type Matrix } from '../render/view'
import { DEFAULT_AIRBRUSH, DEFAULT_BRISTLE, DEFAULT_BRUSH, DEFAULT_DUAL, DEFAULT_ERODIBLE, DEFAULT_TEXTURE, colourVaries, type BrushSettings } from '../brush/defs'
import { toLayer } from '../brush/dab'
import { dabColour } from '../brush/colour'
import { strokeDabs, type PenSample } from '../brush/stroke'
import { registerTip, tipFromBytes } from '../brush/tips'
import { rng } from '../brush/rng'
import { applyStroke, colourAt, coverageAt, layoutOf, newStrokeTile, stamp, styleOf } from '../render/ref/paint'
import { deposit, drain, newLoad, newSampleTile, pickUp, withSample, type SampleTile, type SampleTool } from '../render/ref/sample'
import type { StrokeSampling } from '../render/strokes'
import { fromWorking } from '../render/ref/working'
import { CoverReader, coverForTile, ellipsePoints, feather, rasterizePolygon } from '../tiles/coverage'
import { fillItem, gradientPaint, paintIn, solid, strokeItem, type AppearanceItem, type Geometry, type GradientType, type Paint } from '../doc/vector'
import { fillSegments, rasterRegion, regionSegments } from '../geom/raster'
import { type PathData } from '../geom/path'
import { encodeField, liquifyDab, newField } from '../geom/warp'
import { flattenOutline, glyphsToPath, isGlyphs, type GlyphSet } from '../geom/glyphs'
import { contentFrom } from '../doc/text'
import { levelMatrix, vectorOutline, FLATTEN_TOL } from '../vector/outline'
import { paintAt, paintParams, patternLevels, type PatternImage } from '../vector/paint'
import { patternPixels } from '../tiles/patterns'
import type { SceneDoc } from '../render/scene'
import { NotReady } from '../render/residency'
import { shapeOf } from '../vector/shape'

let seed = 99
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)

/** A tile of random samples; a quarter of its pixels transparent and a quarter opaque, the rest in between. */
function randomTile(f: TileFormat): Samples {
  const s = newSamples(f)
  const max = f.depth === 16 ? 65535 : 255
  const planes = planesOf(f)
  for (let i = 0; i < TILE_PIXELS; i++) {
    for (let p = 0; p < planes - 1; p++) s[p * TILE_PIXELS + i] = Math.floor(rand() * (max + 1))
    const r = rand()
    s[(planes - 1) * TILE_PIXELS + i] = r < 0.25 ? 0 : r < 0.5 ? max : Math.floor(rand() * (max + 1))
  }
  return s
}

function pixelOf(f: TileFormat, s: Samples, i: number): Px {
  const max = f.depth === 16 ? 65535 : 255
  const planes = planesOf(f)
  return toWorking(f.mode, Array.from({ length: planes }, (_, p) => s[p * TILE_PIXELS + i] / max))
}

const halfToFloat = (h: number) => {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return s * m * 2 ** -24
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

const DISCONTINUOUS = new Set<BlendModeId>(['hard-mix', 'darker-color', 'lighter-color', 'dissolve', 'divide', 'color-dodge', 'color-burn', 'vivid-light', 'hue', 'saturation', 'color', 'luminosity'])

interface Case {
  name: string
  update: SceneUpdate
  expect: (i: number) => Px
}

/** Renders each case's tile (0, 0) at level 0 and reads back its working-space pixels. */
async function renderCases(r: Renderer, f: TileFormat, store: Store, cases: Case[]): Promise<Float32Array[]> {
  const before = r.store8
  if (f.depth === 8) r.store8 = store
  const format = { mode: f.mode, store }
  const bytes = tileBufferBytes(format)
  const out: Float32Array[] = []
  try {
    for (let b = 0; b < cases.length; b += 12) {
      const batch = cases.slice(b, b + 12)
      const staging = r.device.createBuffer({ size: bytes * batch.length, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
      const keys = batch.map((_, i) => `probe-${b + i}`)
      batch.forEach((c, i) => r.updateScene(keys[i], c.update))
      const enc = r.beginWork()
      batch.forEach((_, i) => {
        const s = r.docState(keys[i])!
        const job = r.job(s, 0, 0, 0, enc)
        if (f.depth === 16 && store === 'f16') job.format = { mode: f.mode, store: 'f16' }
        const buf = r.renderTile(job)
        if (buf) {
          enc.copyBufferToBuffer(buf, 0, staging, i * bytes, bytes)
          r.bufferPool.release(buf)
        }
      })
      r.finishWork(enc)
      await staging.mapAsync(GPUMapMode.READ)
      const raw = staging.getMappedRange()
      for (let i = 0; i < batch.length; i++) {
        if (store === 'f16') {
          const h = new Uint16Array(raw, i * bytes, bytes / 2)
          out.push(Float32Array.from(h, halfToFloat))
        } else out.push(new Float32Array(raw.slice(i * bytes, (i + 1) * bytes)))
      }
      staging.unmap()
      staging.destroy()
      for (const k of keys) r.close(k)
    }
  } finally {
    r.store8 = before
  }
  return out
}

/**
 * Every `every`th pixel against the reference. The pixels are independent
 * random samples, so a spread-out subset proves what all of them would, and
 * the reference, which is plain JavaScript, costs most of a probe's time.
 */
function compare(f: TileFormat, got: Float32Array, expect: (i: number) => Px, tol: number, every = 1) {
  const stride = strideOf(f.mode)
  const n = stride - 1
  let maxErr = 0
  let bad = 0
  let first: { x: number; y: number; got: number[]; want: number[] } | null = null
  let counted = 0
  for (let i = 0; i < TILE_PIXELS; i += every) {
    counted++
    const e = expect(i)
    let err = Math.abs(got[i * stride + n] - e.a)
    for (let c = 0; c < n; c++) err = Math.max(err, Math.abs(got[i * stride + c] - e.c[c]))
    maxErr = Math.max(maxErr, err)
    if (err > tol) {
      bad++
      first ??= { x: i % TILE, y: Math.floor(i / TILE), got: Array.from(got.subarray(i * stride, (i + 1) * stride)), want: [...e.c, e.a] }
    }
  }
  return { maxErr, bad: bad / counted, first }
}

const docOf = (f: TileFormat, root: string) => ({ width: TILE, height: TILE, mode: f.mode, depth: f.depth, profile: { builtin: f.mode === 'cmyk' ? 'generic-cmyk' : f.mode === 'gray' ? 'gray-gamma-2.2' : 'srgb' }, root, selection: null as string | null })

let version = 1
function update(f: TileFormat, nodes: DocNode[]): SceneUpdate {
  return { doc: docOf(f, nodes[0].id), nodes: nodes.map((node) => ({ node, version: version++ })), removed: [], reset: true }
}

/**
 * Every blend mode under every operation, in one colour mode and depth,
 * against the CPU reference. Returns one row per case.
 */
async function compositeProbe(r: Renderer, tiles: TileStore, mode: ColourMode, depth: Depth, store: Store, modes: BlendModeId[]) {
  const f: TileFormat = { mode, depth }
  const sa = randomTile(f)
  const sb = randomTile(f)
  const A = tiles.createSet(f, [[0, 0, tiles.data(f, sa)]])
  const B = tiles.createSet(f, [[0, 0, tiles.data(f, sb)]])
  const pa = (i: number) => pixelOf(f, sa, i)
  const pb = (i: number) => pixelOf(f, sb, i)
  const cases: (Case & { op: Op; blend: BlendModeId })[] = []
  for (const blend of modes) {
    const k = 0.8 * 0.9
    const ops: Op[] = ['over', 'atop', 'knock', 'lerp']
    for (const op of ops) {
      const root = makeNode('group', 'root')
      const a = makeNode('pixel', 'a', 'A', { tiles: A, resample: 'nearest' })
      const b = makeNode('pixel', `b-${blend}`, 'B', { tiles: B, resample: 'nearest' })
      b.blend = blend
      b.opacity = 0.8
      b.fillOpacity = 0.9
      let nodes: DocNode[]
      let expect: (i: number) => Px
      const dis = (i: number, kk: number): { px: Px; k: number; mode: BlendModeId } => {
        if (blend !== 'dissolve') return { px: pb(i), k: kk, mode: blend }
        const d = dissolve(pb(i), kk, i % TILE, Math.floor(i / TILE), seedOf(b.id))
        return { ...d, mode: 'normal' }
      }
      if (op === 'over') {
        root.children = ['a', b.id]
        nodes = [root, a, b]
        expect = (i) => {
          const d = dis(i, k)
          return apply('over', pa(i), d.px, d.mode, d.k)
        }
      } else if (op === 'atop') {
        a.children = [b.id]
        root.children = ['a']
        nodes = [root, a, b]
        expect = (i) => {
          const d = dis(i, k)
          return apply('atop', pa(i), d.px, d.mode, d.k)
        }
      } else if (op === 'knock') {
        const g = makeNode('group', 'g', 'G', { knockout: 'shallow' })
        g.children = [b.id]
        root.children = ['a', 'g']
        nodes = [root, a, g, b]
        expect = (i) => {
          const d = dis(i, k)
          return apply('knock', pa(i), d.px, d.mode, d.k, pa(i))
        }
      } else {
        const g = makeNode('group', 'g', 'G')
        g.opacity = 0.6
        g.children = [b.id]
        root.children = ['a', 'g']
        nodes = [root, a, g, b]
        expect = (i) => {
          const d = dis(i, k)
          return apply('lerp', pa(i), apply('over', pa(i), d.px, d.mode, d.k), 'normal', 0.6)
        }
      }
      cases.push({ name: `${blend} ${op}`, op, blend, update: update(f, nodes), expect })
    }
  }
  const got = await renderCases(r, f, store, cases)
  const tol = store === 'f16' ? 4e-3 : 2e-4
  // 13 is prime, so the subset walks across rows and columns alike.
  return cases.map((c, i) => ({ blend: c.blend, op: c.op, discontinuous: DISCONTINUOUS.has(c.blend), tol, ...compare(f, got[i], c.expect, tol, 13) }))
}

/** A transformed layer through each filter, against ref/resample.ts, magnified and minified (through a mip). */
async function resampleProbe(r: Renderer, tiles: TileStore, mode: ColourMode, depth: Depth) {
  const f: TileFormat = { mode, depth }
  const src = [0, 1, 2, 3].map(() => randomTile(f))
  const set = tiles.createSet(f, src.map((s, i) => [i & 1, i >> 1, tiles.data(f, s)] as [number, number, number]))
  // The layer's own pixels as working pixels, and its first mip level.
  const texel0 = (x: number, y: number): Px => {
    if (x < 0 || y < 0 || x >= 512 || y >= 512) return clear(strideOf(mode) - 1)
    return pixelOf(f, src[(y >> 8) * 2 + (x >> 8)], (y & 255) * TILE + (x & 255))
  }
  const max = depth === 16 ? 65535 : 255
  const straight = (x: number, y: number) => {
    const s = src[(y >> 8) * 2 + (x >> 8)]
    return Array.from({ length: planesOf(f) }, (_, p) => s[p * TILE_PIXELS + (y & 255) * TILE + (x & 255)] / max)
  }
  const mip1 = (x: number, y: number): Px => {
    if (x < 0 || y < 0 || x >= 256 || y >= 256) return clear(strideOf(mode) - 1)
    const v = reduce([straight(2 * x, 2 * y), straight(2 * x + 1, 2 * y), straight(2 * x, 2 * y + 1), straight(2 * x + 1, 2 * y + 1)])
    // The mip is stored at the document's depth.
    return toWorking(mode, v.map((c) => Math.round(c * max) / max))
  }
  const transforms: { name: string; t: Matrix; level: number }[] = [
    { name: 'rotated and enlarged', t: multiply([1, 0, 0, 1, 40, -30], [Math.cos(0.3) * 1.7, Math.sin(0.3) * 1.7, -Math.sin(0.3) * 1.7, Math.cos(0.3) * 1.7, 0, 0]), level: 0 },
    { name: 'shrunk to 40%, through a mip', t: [0.4, 0, 0, 0.4, 13.37, 7.71], level: 0 },
    // The tile drawn reads the layer from its second column of tiles on,
    // so the window doesn't start at the layer's first tile.
    { name: 'moved left, read from its second tile on', t: [1.2, 0, 0, 1.2, -350.613, -10.2917], level: 0 },
  ]
  const cases: Case[] = []
  const filters: Filter[] = ['nearest', 'bilinear', 'bicubic', 'lanczos']
  for (const { name, t } of transforms) {
    for (const filter of filters) {
      const root = makeNode('group', 'root')
      const p = makeNode('pixel', 'p', 'P', { tiles: set, resample: filter })
      p.transform = t as DocNode['transform']
      root.children = ['p']
      const inv = invert(t)
      const minified = Math.abs(t[0] * t[3] - t[1] * t[2]) < 1
      const expect = (i: number): Px => {
        const ox = (i % TILE) + 0.5
        const oy = Math.floor(i / TILE) + 0.5
        const lx = inv[0] * ox + inv[2] * oy + inv[4]
        const ly = inv[1] * ox + inv[3] * oy + inv[5]
        const s = minified ? sample(mip1, lx / 2, ly / 2, filter, strideOf(mode) - 1) : sample(texel0, lx, ly, filter, strideOf(mode) - 1)
        return apply('over', clear(strideOf(mode) - 1), s, 'normal', 1)
      }
      cases.push({ name: `${name}, ${filter}`, update: update(f, [root, p]), expect })
    }
  }
  const got = await renderCases(r, f, 'f32', cases)
  // Positions are float32 on the GPU, so a nearest-neighbour sample right on
  // a pixel edge can land on the other pixel: judged by the share of pixels.
  // Mips are stored at the document's depth, and a GPU may round the last
  // bit of an 8-bit store either way.
  const tol = depth === 8 ? 6e-3 : 2e-3
  return cases.map((c, i) => ({ name: c.name, tol, ...compare(f, got[i], c.expect, tol, 5) }))
}

/** The display table sampled on the GPU, against sampleLut. */
async function lutProbe(r: Renderer, mode: ColourMode) {
  await colour()
  const profile = { builtin: mode === 'cmyk' ? 'generic-cmyk' : mode === 'gray' ? 'gray-gamma-2.2' : 'adobe-rgb-compatible' }
  const got = lutFor(mode, profile, 'display-p3')!
  const n = 4096
  const input = new Float32Array(n * 4)
  for (let i = 0; i < input.length; i++) input[i] = rand()
  // Grid points and the corners, where a table is easiest to get wrong.
  for (let i = 0; i < 8; i++) input.set([i & 1, (i >> 1) & 1, (i >> 2) & 1, i & 1], i * 4)
  const device = r.device
  const lutBuf = device.createBuffer({ size: got.lut.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(lutBuf, 0, got.lut.data as Float32Array<ArrayBuffer>)
  const params = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(params, 0, writeLutParams(got.lut, PLAIN_LOOK))
  const inBuf = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(inBuf, 0, input)
  const outBuf = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
  const staging = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const p = r.kernelSet.displayPipelines({ mode, store: 'f32' }).probe
  const enc = device.createCommandEncoder()
  const pass = enc.beginComputePass()
  pass.setPipeline(p)
  pass.setBindGroup(0, device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: params } }, { binding: 2, resource: { buffer: lutBuf } }] }))
  pass.setBindGroup(1, device.createBindGroup({ layout: p.getBindGroupLayout(1), entries: [{ binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }] }))
  pass.dispatchWorkgroups(Math.ceil(n / 64))
  pass.end()
  enc.copyBufferToBuffer(outBuf, 0, staging, 0, input.byteLength)
  device.queue.submit([enc.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const out = new Float32Array(staging.getMappedRange().slice(0))
  staging.unmap()
  let maxErr = 0
  for (let i = 0; i < n; i++) {
    const c = Array.from(input.subarray(i * 4, i * 4 + 4))
    const want = sampleLut(got.lut, mode === 'gray' ? [c[0]] : mode === 'rgb' ? c.slice(0, 3) : c)
    for (let k = 0; k < 3; k++) maxErr = Math.max(maxErr, Math.abs(out[i * 4 + k] - want[k]))
  }
  for (const b of [lutBuf, params, inBuf, outBuf, staging]) b.destroy()
  return { maxErr, samples: n, size: got.lut.size, dims: got.lut.dims }
}

/**
 * The display pass's look on the GPU (proofed, the gamut marked, inks
 * hidden, coverage over a limit marked) against `displayRef`. Colours at
 * the edge of a mark (the gamut table's A within a hair of half, the ink
 * total within a hair of the limit) can fall either way in float32 and are
 * left out.
 */
async function lookProbe(r: Renderer, mode: ColourMode) {
  await colour()
  const profile = { builtin: mode === 'cmyk' ? 'generic-cmyk' : mode === 'gray' ? 'gray-gamma-2.2' : 'adobe-rgb-compatible' }
  const docLook = { ...DEFAULT_LOOK, proof: true, gamut: true, setup: { ...DEFAULT_LOOK.setup, profile: mode === 'cmyk' ? { builtin: 'gray-gamma-2.2' } : { builtin: 'generic-cmyk' }, mode: mode === 'cmyk' ? ('gray' as const) : ('cmyk' as const) } }
  const got = lutFor(mode, profile, 'display-p3', docLook)!
  const look: Look = { ...PLAIN_LOOK, gamut: true, inks: mode === 'cmyk' ? [true, false, true, true] : [true, true, true, true], inkLimit: mode === 'cmyk' ? 2.6 : 0 }
  const n = 4096
  const input = new Float32Array(n * 4)
  for (let i = 0; i < input.length; i++) input[i] = rand()
  const device = r.device
  const lutBuf = device.createBuffer({ size: got.lut.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(lutBuf, 0, got.lut.data as Float32Array<ArrayBuffer>)
  const params = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(params, 0, writeLutParams(got.lut, look))
  const inBuf = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(inBuf, 0, input)
  const outBuf = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
  const staging = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const p = r.kernelSet.displayPipelines({ mode, store: 'f32' }).probeLook
  const enc = device.createCommandEncoder()
  const pass = enc.beginComputePass()
  pass.setPipeline(p)
  pass.setBindGroup(0, device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: params } }, { binding: 2, resource: { buffer: lutBuf } }] }))
  pass.setBindGroup(1, device.createBindGroup({ layout: p.getBindGroupLayout(1), entries: [{ binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }] }))
  pass.dispatchWorkgroups(Math.ceil(n / 64))
  pass.end()
  enc.copyBufferToBuffer(outBuf, 0, staging, 0, input.byteLength)
  device.queue.submit([enc.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const out = new Float32Array(staging.getMappedRange().slice(0))
  staging.unmap()
  let maxErr = 0
  let marked = 0
  let inkMarked = 0
  let compared = 0
  for (let i = 0; i < n; i++) {
    const c = Array.from(input.subarray(i * 4, i * 4 + 4))
    const v = mode === 'gray' ? [c[0]] : mode === 'rgb' ? c.slice(0, 3) : c
    const masked = mode === 'cmyk' ? v.map((x, k) => (look.inks[k] ? x : 0)) : v
    const g = lutGamut(got.lut, masked)
    const total = Math.fround(Math.fround(Math.fround(c[0] + c[1]) + c[2]) + c[3])
    if (Math.abs(g - 0.5) < 1e-4 || (look.inkLimit > 0 && Math.abs(total - look.inkLimit) < 1e-4)) continue
    compared++
    const want = displayRef(got.lut, look, v)
    if (g >= 0.5) marked++
    if (look.inkLimit > 0 && total > look.inkLimit) inkMarked++
    for (let k = 0; k < 3; k++) maxErr = Math.max(maxErr, Math.abs(out[i * 4 + k] - want[k]))
  }
  for (const b of [lutBuf, params, inBuf, outBuf, staging]) b.destroy()
  return { maxErr, compared, marked, inkMarked }
}

// --- painting ----------------------------------------------------------------------------

/**
 * Strokes painted through the engine (stamped and baked on the GPU) against
 * the CPU reference: every sample of every tile the stroke touched, in the
 * document's own numbers. Returns, per case, the largest difference in
 * sample steps and the share of samples that differ at all.
 */
async function paintProbe(r: Renderer, tiles: TileStore, mode: ColourMode, depth: Depth) {
  const f: TileFormat = { mode, depth }
  const max = depth === 16 ? 65535 : 255
  const planes = planesOf(f)
  const base = randomTile(f)
  const set = tiles.createSet(f, [[0, 0, tiles.data(f, base)]])
  const samples: PenSample[] = Array.from({ length: 24 }, (_, i) => ({ x: 20 + i * 18, y: 120 + Math.sin(i / 3) * 70, pressure: 0.3 + 0.7 * Math.abs(Math.sin(i / 5)), tiltX: 0, tiltY: 0, twist: 0, t: i * 9 }))
  const n = COLOURS[mode]
  const fg = Array.from({ length: n }, (_, i) => (i * 0.37 + 0.2) % 1)
  const bg = Array.from({ length: n }, (_, i) => (i * 0.61 + 0.5) % 1)
  const brush = (o: Partial<BrushSettings>): BrushSettings => ({ ...DEFAULT_BRUSH, smoothing: 0.2, size: 40, ...o })
  // A selection with a soft edge that the stroke crosses: an ellipse, feathered.
  const selection = await feather(tiles, rasterizePolygon(tiles, ellipsePoints(240, 130, 150, 70), 480, 300), 16, 480, 300)
  const selReader = new CoverReader(tiles, selection)
  const tilted = { tiltX: 40, tiltY: 15, rotation: null, pressure: null }
  const cases: { name: string; settings: BrushSettings; eraser: boolean; t: number[]; selection?: boolean; planes?: boolean[]; wear?: number }[] = [
    { name: 'a hard round brush', settings: brush({ hardness: 1 }), eraser: false, t: [1, 0, 0, 1, 0, 0] },
    { name: 'a soft one at 40% flow, 70% opacity', settings: brush({ hardness: 0, flow: 0.4, opacity: 0.7 }), eraser: false, t: [1, 0, 0, 1, 0, 0] },
    { name: 'Multiply', settings: brush({ mode: 'multiply' }), eraser: false, t: [1, 0, 0, 1, 0, 0] },
    { name: 'the eraser at 60% flow', settings: brush({ flow: 0.6 }), eraser: true, t: [1, 0, 0, 1, 0, 0] },
    { name: 'colour jitter (colour kept per pixel)', settings: brush({ colourJitter: 1, spacing: 0.3 }), eraser: false, t: [1, 0, 0, 1, 0, 0] },
    { name: 'a sampled tip, turned at random', settings: brush({ tip: 'chalk', angleJitter: 1, size: 50 }), eraser: false, t: [1, 0, 0, 1, 0, 0] },
    { name: 'on a layer turned 30° and scaled 1.3×', settings: brush({ roundness: 0.5, angle: 20 }), eraser: false, t: [Math.cos(0.5) * 1.3, Math.sin(0.5) * 1.3, -Math.sin(0.5) * 1.3, Math.cos(0.5) * 1.3, 60, -20] },
    { name: 'confined to a feathered selection', settings: brush({ hardness: 0.5 }), eraser: false, t: [1, 0, 0, 1, 0, 0], selection: true },
    { name: 'the eraser, confined, on a turned layer', settings: brush({ flow: 0.8 }), eraser: true, t: [Math.cos(0.3), Math.sin(0.3), -Math.sin(0.3), Math.cos(0.3), 30, -10], selection: true },
    { name: 'an image tip, 300 × 180, stamped small through its mips, flipped', settings: brush({ tip: PROBE_TIP, size: 30, flipX: true, angleJitter: 0.3 }), eraser: false, t: [1, 0, 0, 1, 0, 0] },
    { name: 'and large, squashed', settings: brush({ tip: PROBE_TIP, size: 140, roundness: 0.6, spacing: 0.4 }), eraser: false, t: [1, 0, 0, 1, 0, 0] },
    { name: 'a texture in each tip, its depth jittered', settings: brush({ texture: { ...DEFAULT_TEXTURE, id: 'canvas', eachTip: true, depthJitter: 0.6, mode: 'subtract', scale: 0.7, contrast: 30 } }), eraser: false, t: [1, 0, 0, 1, 0, 0] },
    { name: 'a texture over the whole stroke, Height, on a turned layer', settings: brush({ flow: 0.5, texture: { ...DEFAULT_TEXTURE, id: 'rough', mode: 'height', depth: 0.8, brightness: 20, invert: true } }), eraser: false, t: [Math.cos(0.4), Math.sin(0.4), -Math.sin(0.4), Math.cos(0.4), 40, -30] },
    { name: 'a dual brush, Colour Burn', settings: brush({ dual: { ...DEFAULT_DUAL, mode: 'color-burn', size: 25 } }), eraser: false, t: [1, 0, 0, 1, 0, 0] },
    { name: 'Noise and Wet Edges, soft', settings: brush({ hardness: 0.2, noise: true, wetEdges: true, flow: 0.6 }), eraser: false, t: [1, 0, 0, 1, 0, 0] },
    { name: 'hue, saturation and brightness jitter, per tip', settings: brush({ hueJitter: 0.4, saturationJitter: 0.5, brightnessJitter: 0.3, spacing: 0.3 }), eraser: false, t: [1, 0, 0, 1, 0, 0] },
    { name: 'a dual brush and a stroke-wide texture, with colour', settings: brush({ colourJitter: 0.6, dual: { ...DEFAULT_DUAL, mode: 'overlay' }, texture: { ...DEFAULT_TEXTURE, id: 'burlap', depth: 0.5, mode: 'linear-burn' } }), eraser: false, t: [1, 0, 0, 1, 0, 0] },
    // The Channels panel's target: the first colour channel alone (the last, in Gray), the rest kept.
    { name: 'a bristle tip, pressed and tilted (its footprints change as it splays)', settings: brush({ special: { ...DEFAULT_BRISTLE, shape: 'flat-curve', bristles: 0.5 }, spacing: 0.03, size: 50, pose: tilted }), eraser: false, t: [1, 0, 0, 1, 0, 0] },
    { name: 'an erodible triangle, part worn, on a turned layer', settings: brush({ special: { ...DEFAULT_ERODIBLE, shape: 'triangle', softness: 1 }, size: 30, spacing: 0.08 }), eraser: false, t: [Math.cos(0.3), Math.sin(0.3), -Math.sin(0.3), Math.cos(0.3), 30, -10], wear: 0.4 },
    { name: 'an erodible point, worn as it goes, on its side', settings: brush({ special: { ...DEFAULT_ERODIBLE, softness: 1 }, size: 24, spacing: 0.06, pose: tilted }), eraser: false, t: [1, 0, 0, 1, 0, 0] },
    { name: 'an airbrush tip, tilted (its spray leaning)', settings: brush({ special: { ...DEFAULT_AIRBRUSH, granularity: 0.7, spatterAmount: 0.8 }, size: 70, spacing: 0.2, flow: 0.5, pose: tilted }), eraser: false, t: [1, 0, 0, 1, 0, 0] },
    { name: 'on some colour channels only, soft, in Multiply', settings: brush({ hardness: 0.3, mode: 'multiply', colourJitter: 0.5 }), eraser: false, t: [1, 0, 0, 1, 0, 0], planes: Array.from({ length: COLOURS[mode] }, (_, i) => i === 0 || i === 2) },
  ]
  const out = []
  for (const [i, c] of cases.entries()) {
    const key = `paint-probe-${i}`
    const root = makeNode('group', 'root')
    const node = makeNode('pixel', 'p', 'P', { tiles: set })
    node.transform = c.t as DocNode['transform']
    root.children = ['p']
    r.updateScene(key, { doc: { ...docOf(f, 'root'), width: 480, height: 300 }, nodes: [root, node].map((x) => ({ node: x, version: version++ })), removed: [], reset: true })
    const seed = 1234 + i
    const id = 900000 + i
    const why = r.beginStroke({ id, key, node: 'p', settings: c.settings, eraser: c.eraser, seed, fg, bg, selection: c.selection ? selection : null, ...(c.planes ? { planes: c.planes } : {}), ...(c.wear !== undefined ? { wear: c.wear } : {}) })
    if (why) throw new Error(why)
    r.addSamples(id, samples)
    const { set: result } = await r.endStroke(id)
    // The reference: the same dabs, stamped and laid on by the CPU.
    const dabs = strokeDabs(c.settings, seed, samples, { wear: c.wear }).map((d) => toLayer(d, c.t))
    const work = (v: number[]) => (mode === 'cmyk' ? v.map((x) => 1 - x) : v)
    const fgw = work(fg)
    const bgw = work(bg)
    const b = c.settings
    const varies = !c.eraser && colourVaries(b)
    const tables = mode === 'cmyk' ? cmykTablesFor(docOf(f, 'x').profile) : null
    const colours = varies ? dabs.map((d) => dabColour(fgw, bgw, d.colour, d.hsb, mode, tables)) : null
    const layout = layoutOf(b, varies, n)
    const style = styleOf(b)
    const clip = { t: c.t, width: 480, height: 300 }
    let worst = 0
    let differ = 0
    let total = 0
    const touched = new Set<string>()
    for (const d of dabs) for (let y = Math.floor(d.box[1] / TILE); y <= Math.floor(d.box[3] / TILE); y++) for (let x = Math.floor(d.box[0] / TILE); x <= Math.floor(d.box[2] / TILE); x++) touched.add(`${x},${y}`)
    for (const k of touched) {
      const [tx, ty] = k.split(',').map(Number)
      const st = newStrokeTile(layout)
      stamp(st, tx, ty, dabs, colours, clip, style)
      const selCover = c.selection ? await coverForTile(selReader, c.t, tx, ty) : null
      const before = tx === 0 && ty === 0 ? base : null
      const tileId = result ? tiles.tileAt(result, tx, ty) : undefined
      const got = tileId !== undefined ? await tiles.samples(tileId) : null
      // Every 3rd pixel: the reference is plain JavaScript, and slow.
      for (let p = 0; p < TILE_PIXELS; p += 3) {
        const L: Px = before ? pixelOf(f, before, p) : clear(n)
        // The selection under this layer pixel's centre, through the layer's transform.
        const k = selCover ? selCover[p] : 1
        const colour = layout.channels ? colourAt(st, p) : fgw
        const want = fromWorking(mode, applyStroke(L, coverageAt(st, p) * k, colour, c.settings.mode, c.eraser, c.planes)).map((v) => Math.round(v * max))
        for (let q = 0; q < planes; q++) {
          // A pixel left fully transparent stores its colour as nothing.
          if (want[planes - 1] === 0 && q < planes - 1) continue
          const g = got ? got[q * TILE_PIXELS + p] : 0
          const diff = Math.abs(g - want[q])
          worst = Math.max(worst, diff)
          if (diff) differ++
          total++
        }
      }
    }
    out.push({ name: c.name, worst, differ: differ / Math.max(1, total), tiles: touched.size })
    r.close(key)
  }
  return out
}

const COLOURS: Record<ColourMode, number> = { rgb: 3, gray: 1, cmyk: 4 }

/**
 * Smudge and Mixer strokes through the engine (picked up, put down and
 * baked on the GPU) against the CPU reference doing the same dabs in the
 * same order (ref/sample.ts).
 */
async function sampleProbe(r: Renderer, tiles: TileStore, mode: ColourMode, depth: Depth) {
  const f: TileFormat = { mode, depth }
  const max = depth === 16 ? 65535 : 255
  const planes = planesOf(f)
  const n = COLOURS[mode]
  // Smooth colour across the tile with some soft shapes and transparent holes: something to smear.
  const base = newSamples(f)
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const i = y * TILE + x
      for (let p = 0; p < planes - 1; p++) base[p * TILE_PIXELS + i] = Math.round(((Math.sin(x / (17 + p * 5)) * Math.cos(y / (23 - p * 3)) + 1) / 2) * max)
      const hole = Math.hypot(x - 180, y - 90) < 30 ? 0 : 1
      base[(planes - 1) * TILE_PIXELS + i] = Math.round(hole * (0.6 + 0.4 * ((x * 7 + y * 3) % 50) / 50) * max)
    }
  const set = tiles.createSet(f, [[0, 0, tiles.data(f, base)]])
  const samples: PenSample[] = Array.from({ length: 18 }, (_, i) => ({ x: 30 + i * 11, y: 60 + Math.sin(i / 3) * 40, pressure: 0.4 + 0.6 * Math.abs(Math.sin(i / 4)), tiltX: 0, tiltY: 0, twist: 0, t: i * 9 }))
  const fg = Array.from({ length: n }, (_, i) => (i * 0.37 + 0.2) % 1)
  const brush = (o: Partial<BrushSettings>): BrushSettings => ({ ...DEFAULT_BRUSH, smoothing: 0.2, size: 34, spacing: 0.2, dynamics: [], ...o })
  const tool = (o: Partial<StrokeSampling>): StrokeSampling => ({ tool: 'smudge', strength: 0.7, fingerPainting: false, wet: 0.5, load: 0.5, mix: 0.5, reservoir: null, sampleAll: false, ...o })
  const turned = [Math.cos(0.4) * 1.2, Math.sin(0.4) * 1.2, -Math.sin(0.4) * 1.2, Math.cos(0.4) * 1.2, 40, -20]
  const cases: { name: string; settings: BrushSettings; sampling: StrokeSampling; t: number[] }[] = [
    { name: 'Smudge at 70%', settings: brush({ hardness: 0.6 }), sampling: tool({}), t: [1, 0, 0, 1, 0, 0] },
    { name: 'Smudge, Finger Painting, through a transparent hole', settings: brush({ hardness: 0.9, size: 40 }), sampling: tool({ fingerPainting: true, strength: 0.85 }), t: [1, 0, 0, 1, 0, 0] },
    { name: 'Smudge with a sampled tip', settings: brush({ tip: 'chalk', size: 44 }), sampling: tool({ strength: 0.5 }), t: [1, 0, 0, 1, 0, 0] },
    { name: 'Smudge on a turned layer', settings: brush({ size: 44 }), sampling: tool({ strength: 0.5 }), t: turned },
    { name: 'the Mixer, wet, loaded, half mix', settings: brush({ hardness: 0.7 }), sampling: tool({ tool: 'mixer', reservoir: fg }), t: [1, 0, 0, 1, 0, 0] },
    { name: 'the Mixer, dry, a light load running out', settings: brush({ hardness: 1, flow: 0.8 }), sampling: tool({ tool: 'mixer', wet: 0, mix: 0, load: 0.01, reservoir: fg }), t: [1, 0, 0, 1, 0, 0] },
    { name: 'the Mixer, very wet and clean, heavy mix, Noise', settings: brush({ hardness: 0.4, noise: true }), sampling: tool({ tool: 'mixer', wet: 1, mix: 1, reservoir: null }), t: turned },
    { name: 'Smudge sampling all layers (the image as it shows when the frame began)', settings: brush({ hardness: 0.6 }), sampling: tool({ sampleAll: true }), t: [1, 0, 0, 1, 0, 0] },
    { name: 'the Mixer sampling all layers', settings: brush({ hardness: 0.8 }), sampling: tool({ tool: 'mixer', wet: 0.7, mix: 0.6, reservoir: fg, sampleAll: true }), t: [1, 0, 0, 1, 0, 0] },
  ]
  const out = []
  for (const [i, c] of cases.entries()) {
    const key = `sample-probe-${i}`
    const root = makeNode('group', 'root')
    const node = makeNode('pixel', 'p', 'P', { tiles: set })
    node.transform = c.t as DocNode['transform']
    root.children = ['p']
    r.updateScene(key, { doc: { ...docOf(f, 'root'), width: 300, height: 200 }, nodes: [root, node].map((x) => ({ node: x, version: version++ })), removed: [], reset: true })
    const seed = 777 + i
    const id = 950000 + i
    const why = r.beginStroke({ id, key, node: 'p', settings: c.settings, eraser: false, seed, fg, bg: fg, sampling: c.sampling })
    if (why) throw new Error(why)
    r.addSamples(id, samples)
    const { set: result } = await r.endStroke(id)
    // The reference.
    const dabs = strokeDabs(c.settings, seed, samples).map((d) => toLayer(d, c.t))
    const work = (v: number[]) => (mode === 'cmyk' ? v.map((x) => 1 - x) : v)
    const fgw = work(fg)
    const sm = c.sampling
    const st: SampleTool = { kind: sm.tool, strength: sm.strength, fingerPainting: sm.fingerPainting, wet: sm.wet, load: sm.load, mix: sm.mix }
    const load = newLoad(n, Array.isArray(sm.reservoir) ? { c: work(sm.reservoir), a: 1 } : null)
    const stiles = new Map<string, SampleTile>()
    const style = { noise: c.settings.noise, wetEdges: c.settings.wetEdges }
    const read = (ix: number, iy: number): Px => {
      const tx = Math.floor(ix / TILE)
      const ty = Math.floor(iy / TILE)
      const i = (iy - ty * TILE) * TILE + (ix - tx * TILE)
      const L: Px = tx === 0 && ty === 0 ? pixelOf(f, base, i) : clear(n)
      // Sampling all layers reads the image as it showed when the frame began: here, all in one frame, the layer alone.
      if (sm.sampleAll) return ix < 0 || iy < 0 || ix >= 300 || iy >= 200 ? clear(n) : L
      const t = stiles.get(`${tx},${ty}`)
      return t ? withSample(L, t, i) : L
    }
    const clip = { t: c.t, width: 300, height: 200 }
    const inv = (() => {
      const t = c.t
      const det = t[0] * t[3] - t[1] * t[2]
      return [t[3] / det, -t[1] / det, -t[2] / det, t[0] / det, (t[2] * t[5] - t[3] * t[4]) / det, (t[1] * t[4] - t[0] * t[5]) / det]
    })()
    const corners = [[0, 0], [300, 0], [0, 200], [300, 200]].map(([x, y]) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]])
    const cv = [Math.min(...corners.map((p) => p[0])), Math.min(...corners.map((p) => p[1])), Math.max(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[1]))]
    for (const d of dabs) {
      const x0 = Math.floor(Math.max(d.box[0], cv[0]) / TILE)
      const y0 = Math.floor(Math.max(d.box[1], cv[1]) / TILE)
      const x1 = Math.floor(Math.min(d.box[2], cv[2]) / TILE)
      const y1 = Math.floor(Math.min(d.box[3], cv[3]) / TILE)
      if (x1 < x0 || y1 < y0) continue
      pickUp(load, d, st, read, { c: fgw, a: 1 })
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const k = `${x},${y}`
          if (!stiles.has(k)) stiles.set(k, newSampleTile(n))
          deposit(stiles.get(k)!, x, y, load, d, st, clip, style)
        }
      if (st.kind === 'mixer') drain(load, d, st)
    }
    let worst = 0
    let differ = 0
    let total = 0
    for (const [k, t] of stiles) {
      const [tx, ty] = k.split(',').map(Number)
      const tileId = result ? tiles.tileAt(result, tx, ty) : undefined
      const got = tileId !== undefined ? await tiles.samples(tileId) : null
      for (let p = 0; p < TILE_PIXELS; p += 3) {
        const L: Px = tx === 0 && ty === 0 ? pixelOf(f, base, p) : clear(n)
        const want = fromWorking(mode, withSample(L, t, p)).map((v) => Math.round(v * max))
        for (let q = 0; q < planes; q++) {
          if (want[planes - 1] === 0 && q < planes - 1) continue
          const g = got ? got[q * TILE_PIXELS + p] : 0
          // Colour is compared premultiplied: a nearly transparent pixel's straight colour is its paint over a
          // tiny alpha, where float32's rounding is magnified, and where no difference can be seen.
          const weight = q < planes - 1 ? want[planes - 1] / max : 1
          const diff = Math.round(Math.abs(g - want[q]) * weight)
          worst = Math.max(worst, diff)
          if (diff) differ++
          total++
        }
      }
    }
    out.push({ name: c.name, worst, differ: differ / Math.max(1, total), tiles: stiles.size })
    r.close(key)
  }
  return out
}

/** An image tip for the probes: an irregular blot, 300 × 180, made from a seed and registered here (the engine and its reference share it). */
const PROBE_TIP = (() => {
  const w = 300
  const h = 180
  const r = rng(77)
  const blobs = Array.from({ length: 30 }, () => ({ x: 20 + r() * 260, y: 20 + r() * 140, rad: 6 + r() * 30, s: 0.3 + r() * 0.7 }))
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0
      for (const b of blobs) v = Math.max(v, b.s * Math.max(0, 1 - Math.hypot(x + 0.5 - b.x, y + 0.5 - b.y) / b.rad))
      data[y * w + x] = Math.round(v * 255)
    }
  const id = 'tip:0probe0000000000'
  registerTip(id, tipFromBytes(w, h, data))
  return id
})()

// --- adjustments and live filters ---------------------------------------------------------

/** Settings to try each adjustment with: away from their defaults, so every part of each is used. */
const ADJUST_CASES: [string, string, Record<string, unknown>][] = [
  ['levels', 'Levels', { levels: { master: { inBlack: 0.1, inWhite: 0.9, gamma: 1.4, outBlack: 0.05, outWhite: 0.95 }, red: { inBlack: 0, inWhite: 1, gamma: 0.7, outBlack: 0, outWhite: 1 }, cyan: { inBlack: 0.2, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 } } }],
  ['curves', 'Curves', { curves: { master: [[0, 0], [0.25, 0.15], [0.75, 0.9], [1, 1]], green: [[0, 0.1], [1, 0.8]], magenta: [[0, 0], [0.5, 0.7], [1, 1]] } }],
  ['brightness-contrast', 'Brightness/Contrast', { brightness: 40, contrast: 30 }],
  ['exposure', 'Exposure', { exposure: 0.7, offset: -0.02, gamma: 1.2 }],
  ['invert', 'Invert', {}],
  ['posterize', 'Posterize', { levels: 5 }],
  ['threshold', 'Threshold', { level: 100 }],
  ['hue-saturation', 'Hue/Saturation', { hue: 40, saturation: 30, lightness: -10 }],
  ['hue-saturation', 'Hue/Saturation, colourised', { hue: -60, saturation: 50, lightness: 20, colorize: true }],
  ['vibrance', 'Vibrance', { vibrance: 60, saturation: -20 }],
  ['colour-balance', 'Colour Balance', { shadowsCyanRed: 30, midtonesYellowBlue: -40, highlightsMagentaGreen: 20 }],
  ['black-white', 'Black & White, tinted', { tint: true, reds: 70, blues: -20 }],
  ['channel-mixer', 'Channel Mixer', { redFromGreen: 30, blueConstant: 10, grayFromBlue: 60 }],
  ['gradient-map', 'Gradient Map', { gradient: [{ at: 0, colour: [0.1, 0.2, 0.6, 0.1] }, { at: 0.6, colour: [0.9, 0.4, 0.1, 0] }, { at: 1, colour: [1, 1, 0.8, 0] }], reverse: true }],
  ['hue-saturation', 'Hue/Saturation, by range', { hue: 10, redsHue: 40, redsSaturation: -30, bluesLightness: 25 }],
  ['selective-colour', 'Selective Colour', { reds_cyan: 40, reds_yellow: -30, neutrals_black: 20, blues_magenta: 50, method: 'relative' }],
  ['photo-filter', 'Photo Filter', { filter: 'cooling-80', density: 60, preserve: true }],
  ['colour-lookup', 'Colour Lookup, Teal and Orange', { look: 'teal-orange' }],
  ['colour-grading', 'Colour Grading', { shadowsWheel: [200, 60], highlightsWheel: [35, 40], midtonesLum: 20, balance: 10, blending: 70 }],
]

/**
 * Every adjustment as an adjustment layer at 80% over a random layer,
 * against `tint` of the layer with its adjusted copy (runProgram); then one
 * in Luminosity, one clipped, and one as the layer's own effect.
 */
async function adjustProbe(r: Renderer, tiles: TileStore, mode: ColourMode, depth: Depth) {
  const f: TileFormat = { mode, depth }
  const n = COLOURS[mode]
  const sa = randomTile(f)
  const A = tiles.createSet(f, [[0, 0, tiles.data(f, sa)]])
  const pa = (i: number) => pixelOf(f, sa, i)
  // A CMYK document's colour adjustments go through its profile's tables, as the graph's do.
  await colour()
  const tables = mode === 'cmyk' ? cmykTablesFor(docOf(f, 'x').profile) : null
  const adjusted = (p: Px, prog: NonNullable<ReturnType<typeof programFor>>): Px => {
    if (p.a <= 0) return p
    const sc = p.c.map((v) => Math.min(1, Math.max(0, v / p.a)))
    return { c: runProgram(prog, mode, sc, tables).map((v) => v * p.a), a: p.a }
  }
  const cases: (Case & { tol: number; discontinuous: boolean })[] = []
  const add = (name: string, nodes: DocNode[], expect: (i: number) => Px, discontinuous: boolean) => cases.push({ name, update: update(f, nodes), expect, tol: 2e-3, discontinuous })
  for (const [id, name, params] of ADJUST_CASES) {
    const prog = programFor(id, params, mode)!
    const root = makeNode('group', 'root')
    const a = makeNode('pixel', 'a', 'A', { tiles: A, resample: 'nearest' })
    const adj = makeNode('adjustment', `adj-${id}`, name, { adjustment: id, params })
    adj.opacity = 0.8
    root.children = ['a', adj.id]
    add(name, [root, a, adj], (i) => tint(pa(i), adjusted(pa(i), prog), 'normal', 0.8), id === 'threshold' || id === 'posterize')
  }
  {
    const params = ADJUST_CASES[1][2]
    const prog = programFor('curves', params, mode)!
    const root = makeNode('group', 'root')
    const a = makeNode('pixel', 'a', 'A', { tiles: A, resample: 'nearest' })
    const adj = makeNode('adjustment', 'adj-lum', 'Curves', { adjustment: 'curves', params })
    adj.blend = 'luminosity'
    root.children = ['a', adj.id]
    add('Curves in Luminosity', [root, a, adj], (i) => tint(pa(i), adjusted(pa(i), prog), 'luminosity', 1), false)
    const root2 = makeNode('group', 'root')
    const a2 = makeNode('pixel', 'a', 'A', { tiles: A, resample: 'nearest' })
    const clip = makeNode('adjustment', 'adj-clip', 'Curves', { adjustment: 'curves', params })
    a2.children = ['adj-clip']
    root2.children = ['a']
    add('Curves clipped to the layer', [root2, a2, clip], (i) => tint(pa(i), adjusted(pa(i), prog), 'normal', 1), false)
    const root3 = makeNode('group', 'root')
    const a3 = makeNode('pixel', 'a', 'A', { tiles: A, resample: 'nearest' })
    const eff = makeNode('adjustment', 'adj-eff', 'Curves', { adjustment: 'curves', params })
    a3.effects = ['adj-eff']
    root3.children = ['a']
    add('Curves as the layer’s own effect', [root3, a3, eff], (i) => apply('over', clear(n), adjusted(pa(i), prog), 'normal', 1), false)
  }
  const got = await renderCases(r, f, 'f32', cases)
  return cases.map((c, i) => ({ name: c.name, tol: c.tol, discontinuous: c.discontinuous, ...compare(f, got[i], c.expect, c.tol, 2) }))
}

/** Settings to try each live filter with. */
/** A Liquify field for the probe: a push across the middle tile and a twirl. */
const probeField = (() => {
  const f = newField([0, 0, TILE * 3, TILE * 3])
  for (let i = 0; i < 12; i++) liquifyDab(f, 'warp', 300 + i * 10, 380, 10, 4, 120, 0.8)
  for (let i = 0; i < 6; i++) liquifyDab(f, 'twirl-cw', 450, 450, 0, 0, 100, 1)
  return encodeField(f)
})()

/** Each filter's id, a name for it, its settings, and (for warps, read through a grid) how near it must come. */
const FILTER_CASES: [string, string, Record<string, unknown>, number?, number?][] = [
  ['gaussian-blur', 'Gaussian Blur, 6 px', { radius: 6 }],
  ['box-blur', 'Box Blur, 5 px', { radius: 5 }],
  ['unsharp-mask', 'Unsharp Mask', { amount: 150, radius: 3, threshold: 4 }],
  ['high-pass', 'High Pass', { radius: 8 }],
  ['add-noise', 'Add Noise, Gaussian', { amount: 20, distribution: 'gaussian' }],
  ['add-noise', 'Add Noise, uniform and monochromatic', { amount: 30, monochromatic: true }],
  ['median', 'Median, 2 px', { radius: 2 }],
  ['motion-blur', 'Motion Blur, 30°, 25 px', { angle: 30, distance: 25 }],
  ['lens-blur', 'Lens Blur, 6 px with highlights', { radius: 6, brightness: 40, threshold: 150 }],
  ['surface-blur', 'Surface Blur', { radius: 8, threshold: 40 }],
  ['smart-sharpen', 'Smart Sharpen, lens', { amount: 120, radius: 2, remove: 'lens', noise: 5 }],
  ['smart-sharpen', 'Smart Sharpen, motion', { amount: 80, radius: 3, remove: 'motion', angle: 20, noise: 0 }],
  ['emboss', 'Emboss', { angle: 120, height: 3, amount: 150 }],
  ['find-edges', 'Find Edges', {}],
  ['solarize', 'Solarize', {}],
  ['lighting', 'Lighting Effects', { angle: 60, altitude: 35, intensity: 120, ambience: 20, height: 12, gloss: 40, colour: [1, 0.9, 0.8, 0] }],
  ['clouds', 'Clouds', { from: [0.1, 0.2, 0.5, 0], to: [1, 0.95, 0.9, 0], scale: 150, seed: 7 }],
  ['mosaic', 'Mosaic, 13 px', { cell: 13 }],
  ['drop-shadow', 'Drop Shadow', { colour: [0.1, 0.1, 0.4, 0.9], opacity: 80, angle: 135, distance: 9, size: 8 }],
  ['outer-glow', 'Outer Glow', { colour: [1, 0.9, 0.3, 0], opacity: 90, size: 12 }],
  ['dust-scratches', 'Dust & Scratches', { radius: 2, threshold: 20 }],
  ['minimum', 'Minimum, 3 px', { radius: 3 }],
  ['maximum', 'Maximum, 2 px', { radius: 2 }],
  ['twirl', 'Twirl', { angle: 140, frame: [768, 0, 0, 768, 0, 0] }, 0.05],
  ['pinch', 'Pinch', { amount: 60, frame: [768, 0, 0, 768, 0, 0] }, 0.05],
  ['spherize', 'Spherize', { amount: -70, frame: [768, 0, 0, 768, 0, 0] }, 0.05],
  ['zigzag', 'ZigZag, pond ripples', { amount: 30, ridges: 6, frame: [768, 0, 0, 768, 0, 0] }, 0.05],
  // Polar Coordinates' seam (straight up from the middle) and its middle are read to the nearest pixel: a line of them.
  ['polar', 'Polar Coordinates', { way: 'to-polar', frame: [768, 0, 0, 768, 0, 0] }, 0.05, 0.015],
  ['wave', 'Wave', { generators: 3, minWavelength: 40, maxWavelength: 120, minAmplitude: 4, maxAmplitude: 12 }, 0.05],
  ['ripple', 'Ripple', { amount: 100, size: 'large' }, 0.05],
  ['warp', 'Warp, in perspective', { frame: [768, 0, 0, 768, 0, 0], corners: [60, 40, 700, 0, 768, 768, 0, 700] }],
  ['warp', 'Warp, Flag', { style: 'flag', bend: 25, frame: [768, 0, 0, 768, 0, 0] }, 0.02],
  // A field read through a grid 2 pixels apart: a tenth of a pixel out at worst, across a hard edge.
  ['liquify', 'Liquify, a push and a twirl', { field: probeField }, 0.1],
]

/**
 * Each live filter on a layer of three by three random tiles, the middle
 * tile drawn through the render graph against the reference run on the
 * whole layer; then a chain (a blur, then Invert as an effect) and a filter
 * at 60% opacity.
 */
/**
 * A layer of three by three tiles for the filter and effect probes: smooth
 * colour, with shapes cut out of its alpha, so blurs, sharpening, shadows
 * and strokes all have edges to work on. `shapes` makes the alpha hard:
 * discs and bars, solid inside.
 */
function probeLayer(tiles: TileStore, f: TileFormat, shapes = false): { set: string; whole: Region } {
  const n = COLOURS[f.mode]
  const S = n + 1
  const SIZE = TILE * 3
  const raw: Samples[] = []
  const entries: [number, number, number][] = []
  const max = f.depth === 16 ? 65535 : 255
  for (let ty = 0; ty < 3; ty++) for (let tx = 0; tx < 3; tx++) {
    const t = newSamples(f)
    for (let i = 0; i < TILE_PIXELS; i++) {
      const x = tx * TILE + (i % TILE)
      const y = ty * TILE + Math.floor(i / TILE)
      for (let c = 0; c < n; c++) t[c * TILE_PIXELS + i] = Math.round(max * (0.5 + 0.45 * Math.sin(x / (9 + c * 4)) * Math.cos(y / (13 + c * 3))))
      let a: number
      if (shapes) {
        const d = Math.hypot(x - 384, y - 384)
        const bar = Math.abs(y - 300) < 18 && x > 150 && x < 620
        a = Math.max(Math.min(1, Math.max(0, 120.5 - d)), bar ? 1 : 0, Math.hypot(x - 300, y - 470) < 40 ? 1 : 0)
      } else a = (x + y) % 97 < 6 ? 0 : 0.6 + 0.4 * Math.sin(x / 31)
      t[n * TILE_PIXELS + i] = Math.round(max * a)
    }
    raw.push(t)
    entries.push([tx, ty, tiles.data(f, t)])
  }
  const set = tiles.createSet(f, entries)
  // The whole layer as one region, premultiplied working space.
  const whole: Region = { size: SIZE, stride: S, data: new Float64Array(SIZE * SIZE * S) }
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const t = raw[Math.floor(y / TILE) * 3 + Math.floor(x / TILE)]
    const p = pixelOf(f, t, (y % TILE) * TILE + (x % TILE))
    const o = (y * SIZE + x) * S
    p.c.forEach((v, c) => (whole.data[o + c] = v))
    whole.data[o + n] = p.a
  }
  return { set, whole }
}

/** Renders tile (1, 1) of a three-by-three document, in f32, and reads it back. */
async function renderMiddle(r: Renderer, f: TileFormat, key: string, nodes: DocNode[], patterns?: SceneDoc['patterns']): Promise<Float32Array> {
  const format = { mode: f.mode, store: 'f32' as Store }
  const bytes = tileBufferBytes(format)
  r.updateScene(key, { doc: { ...docOf(f, nodes[0].id), width: TILE * 3, height: TILE * 3, patterns }, nodes: nodes.map((node) => ({ node, version: version++ })), removed: [], reset: true })
  const before = r.store8
  if (f.depth === 8) r.store8 = 'f32'
  const staging = r.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  try {
    // A pattern's pyramid is read the first time it's drawn: the tile waits, then goes again.
    for (let tries = 0; ; tries++) {
      const enc = r.beginWork()
      try {
        const job = r.job(r.docState(key)!, 0, 1, 1, enc)
        job.format = format
        const buf = r.renderTile(job)
        if (buf) {
          enc.copyBufferToBuffer(buf, 0, staging, 0, bytes)
          r.bufferPool.release(buf)
        }
        r.finishWork(enc)
        break
      } catch (e) {
        r.finishWork(enc)
        if (!(e instanceof NotReady) || tries > 5) throw e
        await Promise.all(e.waits)
      }
    }
    await staging.mapAsync(GPUMapMode.READ)
    const got = new Float32Array(staging.getMappedRange().slice(0))
    staging.unmap()
    return got
  } finally {
    staging.destroy()
    r.store8 = before
    r.close(key)
  }
}

/** Settings to try the layer effects with, alone and together. */
const FX_CASES: { name: string; fx: LayerFx[]; opacity?: number; fill?: number; blend?: BlendModeId }[] = [
  { name: 'Drop Shadow', fx: [{ kind: 'drop-shadow', enabled: true, params: { distance: 12, size: 10, spread: 20 } }] },
  { name: 'Outer Glow', fx: [{ kind: 'outer-glow', enabled: true, params: { size: 12, spread: 10 } }] },
  { name: 'Inner Shadow', fx: [{ kind: 'inner-shadow', enabled: true, params: { distance: 6, size: 8 } }] },
  { name: 'Inner Glow, from the edge', fx: [{ kind: 'inner-glow', enabled: true, params: { size: 9 } }] },
  { name: 'Inner Glow, from the centre', fx: [{ kind: 'inner-glow', enabled: true, params: { size: 9, source: 'centre', blend: 'normal' } }] },
  { name: 'Satin', fx: [{ kind: 'satin', enabled: true, params: {} }] },
  { name: 'Colour Overlay at 30% fill', fill: 0.3, fx: [{ kind: 'colour-overlay', enabled: true, params: { opacity: 70 } }] },
  { name: 'Gradient Overlay', fx: [{ kind: 'gradient-overlay', enabled: true, params: { angle: 30, blend: 'multiply' } }] },
  { name: 'Pattern Overlay, dots turned', fx: [{ kind: 'pattern-overlay', enabled: true, params: { pattern: 'dots', scale: 11, angle: 25, backgroundOpacity: 40, opacity: 80 } }] },
  { name: 'Pattern Overlay, checkerboard in Multiply', fx: [{ kind: 'pattern-overlay', enabled: true, params: { pattern: 'checker', scale: 7, blend: 'multiply' } }] },
  { name: 'Pattern Overlay, a document pattern, turned and scaled', fx: [{ kind: 'pattern-overlay', enabled: true, params: { image: 'probe-pattern', imageScale: 170, angle: 20, opacity: 90 } }] },
  { name: 'Pattern Overlay, a document pattern drawn small (its pyramid), in Multiply', fx: [{ kind: 'pattern-overlay', enabled: true, params: { image: 'probe-pattern', imageScale: 13, blend: 'multiply' } }] },
  { name: 'Bevel & Emboss, inner', fx: [{ kind: 'bevel', enabled: true, params: { size: 8 } }] },
  { name: 'Bevel & Emboss, emboss, down', fx: [{ kind: 'bevel', enabled: true, params: { size: 6, style: 'emboss', direction: 'down', soften: 2 } }] },
  { name: 'Stroke, outside', fx: [{ kind: 'stroke', enabled: true, params: { size: 4 } }] },
  { name: 'Stroke, inside', fx: [{ kind: 'stroke', enabled: true, params: { size: 3, position: 'inside' } }] },
  { name: 'Stroke, centre', fx: [{ kind: 'stroke', enabled: true, params: { size: 6, position: 'centre' } }] },
  {
    name: 'together, at 80% opacity and 50% fill',
    opacity: 0.8,
    fill: 0.5,
    fx: [
      { kind: 'stroke', enabled: true, params: { size: 3 } },
      { kind: 'colour-overlay', enabled: true, params: { opacity: 40 } },
      { kind: 'drop-shadow', enabled: true, params: {} },
      { kind: 'outer-glow', enabled: false, params: {} },
    ],
  },
  { name: 'Colour Dodge at 50% fill (one of the special eight)', blend: 'color-dodge', fill: 0.5, fx: [{ kind: 'drop-shadow', enabled: true, params: { distance: 8 } }] },
]

/**
 * Layer effects through the render graph, on a layer of shapes over a
 * backdrop, against fx/ref.ts and the composition Photoshop's order makes.
 */
async function fxProbe(r: Renderer, tiles: TileStore, mode: ColourMode, depth: Depth) {
  const f: TileFormat = { mode, depth }
  const n = COLOURS[mode]
  const S = n + 1
  const SIZE = TILE * 3
  const { set, whole } = probeLayer(tiles, f, true)
  const back = probeLayer(tiles, f, false)
  const pat = probePattern(tiles, f)
  const img: PatternImage = { key: pat.tiles, w: pat.width, h: pat.height, levels: patternLevels(pat.width, pat.height, await patternPixels(tiles, pat.tiles, pat.width, pat.height)) }
  const out = []
  for (const [k, c] of FX_CASES.entries()) {
    const root = makeNode('group', 'root')
    const bg = makeNode('pixel', 'bg', 'Backdrop', { tiles: back.set, resample: 'nearest' })
    const a = makeNode('pixel', 'a', 'A', { tiles: set, resample: 'nearest' })
    a.fx = c.fx
    a.opacity = c.opacity ?? 1
    a.fillOpacity = c.fill ?? 1
    a.blend = c.blend ?? 'normal'
    root.children = ['bg', 'a']
    const got = await renderMiddle(r, f, `fx-probe-${k}`, [root, bg, a], [pat])
    const list = activeFx(c.fx).map((x) => ({ kind: x.kind, v: fxValues(x, mode) }))
    const layers = fxLayers(whole, list, { scale: 1, mode, bounds: [0, 0, SIZE, SIZE], pattern: (id) => (id === PROBE_PATTERN ? img : undefined) })
    const special = ['color-burn', 'linear-burn', 'color-dodge', 'linear-dodge', 'vivid-light', 'linear-light', 'hard-mix', 'difference'].includes(a.blend)
    const pxAt = (reg: Region, o: number): Px => ({ c: Array.from(reg.data.subarray(o, o + n)), a: reg.data[o + n] })
    const expect = (i: number): Px => {
      const o = ((TILE + Math.floor(i / TILE)) * SIZE + TILE + (i % TILE)) * S
      let d = pxAt(back.whole, o)
      for (const L of layers.filter((x) => x.place === 'below')) d = apply('over', d, pxAt(L.px, o), L.blend as BlendModeId, L.k * a.opacity)
      let inner = apply('over', clear(n), pxAt(whole, o), 'normal', special ? 1 : a.fillOpacity)
      for (const L of layers.filter((x) => x.place === 'on')) inner = apply('over', inner, pxAt(L.px, o), L.blend as BlendModeId, L.k)
      for (const L of layers.filter((x) => x.place === 'over')) inner = apply('over', inner, pxAt(L.px, o), L.blend as BlendModeId, L.k)
      return apply('over', d, inner, a.blend, a.opacity * (special ? a.fillOpacity : 1))
    }
    out.push({ name: c.name, tol: 3e-3, ...compare(f, got, expect, 3e-3, 3) })
  }
  return out
}

/** Shapes to draw, each with an appearance stack, a transform, and how the node is laid on. */
function vectorCases(mode: ColourMode): { name: string; nodes: (root: DocNode) => DocNode[]; blend?: BlendModeId; opacity?: number }[] {
  const ink = (rgb: number[], gray: number, cmyk: number[]) => (mode === 'rgb' ? rgb : mode === 'gray' ? [gray] : cmyk)
  const red = ink([0.9, 0.1, 0.2], 0.3, [0.05, 0.9, 0.8, 0.05])
  const blue = ink([0.1, 0.3, 0.9], 0.7, [0.9, 0.6, 0, 0.1])
  const pale = ink([0.95, 0.9, 0.6], 0.9, [0.02, 0.05, 0.4, 0])
  const shape = (g: Geometry, appearance: AppearanceItem[], t: DocNode['transform'] = [1, 0, 0, 1, 0, 0], id = 'v'): DocNode => {
    const n = makeNode('vector', id, 'Shape', { geometry: g, appearance })
    n.transform = t
    return n
  }
  const star: Geometry = { kind: 'shape', shape: { type: 'star', x: 230, y: 220, w: 320, h: 300, points: 7, inner: 0.45 } }
  const rect: Geometry = { kind: 'shape', shape: { type: 'rect', x: 280, y: 290, w: 220, h: 180, radii: [30, 0, 60, 10], corner: 'round' } }
  const ellipse: Geometry = { kind: 'shape', shape: { type: 'ellipse', x: 250, y: 260, w: 270, h: 230 } }
  const turn = (a: number, k = 1): DocNode['transform'] => {
    // About the middle of the document, so the shape stays over tile (1, 1).
    const c = Math.cos(a) * k
    const si = Math.sin(a) * k
    return [c, si, -si, c, 384 - c * 384 + si * 384, 384 - si * 384 - c * 384]
  }
  const twoCircles: PathData = {
    fillRule: 'evenodd',
    subpaths: [...flattenToAnchors(260, 270, 110), ...flattenToAnchors(380, 330, 120)],
  }
  const grad = (type: GradientType, o: Partial<Extract<Paint, { kind: 'gradient' }>> = {}): Paint => {
    const g = gradientPaint(red, blue) as Extract<Paint, { kind: 'gradient' }>
    return { ...g, type, stops: [g.stops[0], { at: 0.4, colour: pale, alpha: 0.5 }, g.stops[1]], ...o }
  }
  const stroke = (paint: Paint, width: number, o: Partial<Extract<AppearanceItem, { kind: 'stroke' }>> = {}) => ({ ...strokeItem(paint, width), ...o }) as AppearanceItem
  const text = (layout: GlyphSet, appearance: AppearanceItem[], t: DocNode['transform'] = [1, 0, 0, 1, 0, 0]): DocNode => {
    const n = makeNode('text', 'v', 'Text', { mode: 'point', content: contentFrom('probe'), frame: null, pathOffset: 0, appearance, layout })
    n.transform = t
    return n
  }
  return [
    { name: 'a star filled', nodes: () => [shape(star, [fillItem(solid(red))])] },
    { name: 'two circles in one path, even-odd', nodes: () => [shape({ kind: 'path', path: twoCircles }, [fillItem(solid(blue))])] },
    { name: 'a linear gradient on a turned rectangle', nodes: () => [shape(rect, [fillItem(grad('linear', { angle: 30 }))], turn(0.4, 1.1))] },
    { name: 'a radial gradient, reversed', nodes: () => [shape(ellipse, [fillItem(grad('radial', { reverse: true, scale: 80 }))])] },
    { name: 'an angular gradient', nodes: () => [shape(ellipse, [fillItem(grad('angular', { angle: 60 }))])] },
    { name: 'a diamond gradient', nodes: () => [shape(rect, [fillItem(grad('diamond'))])] },
    { name: 'a pattern of dots, turned', nodes: () => [shape(star, [fillItem({ kind: 'pattern', pattern: 'dots', colour: red, background: pale, backgroundAlpha: 0.4, size: 14, angle: 20 })])] },
    { name: 'a checkerboard, scaled with its shape', nodes: () => [shape(rect, [fillItem({ kind: 'pattern', pattern: 'checker', colour: blue, background: pale, backgroundAlpha: 1, size: 9, angle: 0 })], turn(-0.2, 0.7))] },
    { name: 'a reflected gradient', nodes: () => [shape(rect, [fillItem(grad('reflected', { angle: 20, scale: 70 }))])] },
    { name: 'a linear gradient along a line', nodes: () => [shape(star, [fillItem(grad('linear', { line: [250, 260, 470, 430] }))])] },
    { name: 'a radial gradient along a line, on a turned shape', nodes: () => [shape(ellipse, [fillItem(grad('radial', { line: [380, 360, 470, 300], reverse: true }))], turn(0.3, 0.9))] },
    { name: 'an angular gradient along a line', nodes: () => [shape(ellipse, [fillItem(grad('angular', { line: [390, 370, 300, 420] }))])] },
    { name: 'a reflected diamond along a line', nodes: () => [shape(rect, [fillItem(grad('diamond', { line: [390, 380, 420, 470] })), stroke(grad('reflected', { line: [300, 300, 380, 380] }), 10)])] },
    { name: 'a pattern from pixels, turned', nodes: () => [shape(star, [fillItem({ kind: 'pattern', pattern: PROBE_PATTERN, colour: red, background: pale, backgroundAlpha: 1, size: 37 * 1.7, angle: 25 })])] },
    { name: 'a pattern from pixels, drawn small (its pyramid)', nodes: () => [shape(rect, [fillItem({ kind: 'pattern', pattern: PROBE_PATTERN, colour: red, background: pale, backgroundAlpha: 1, size: 37 * 0.13, angle: 0 })], turn(0.1))] },
    {
      name: 'a fill and a mitred stroke in Multiply at 70%',
      nodes: () => [shape(star, [fillItem(solid(pale)), stroke(solid(blue), 14, { blend: 'multiply', opacity: 0.7 })])],
    },
    { name: 'a stroke inside, round joins', nodes: () => [shape(star, [stroke(solid(red), 16, { align: 'inside', join: 'round' })])] },
    // Vector brushes: parts in their own paints, laid on together at the stroke's opacity.
    { name: 'an art brush of three colours round an ellipse, at 70%', nodes: () => [shape(ellipse, [stroke(solid(blue), 30, { opacity: 0.7, brush: builtinBrushes(mode).find((b) => b.id === 'builtin:ribbon') })])] },
    { name: 'a pattern brush with corner tiles round a turned rectangle', nodes: () => [shape(rect, [stroke(solid(red), 24, { brush: builtinBrushes(mode).find((b) => b.id === 'builtin:railroad') })], turn(0.2))] },
    { name: 'a scatter brush along a line', nodes: () => [shape({ kind: 'shape', shape: { type: 'line', x1: 240, y1: 300, x2: 540, y2: 470 } }, [stroke(solid(blue), 48, { brush: builtinBrushes(mode).find((b) => b.id === 'builtin:stars') })])] },
    { name: 'a stroke outside, bevelled, with a gradient', nodes: () => [shape(rect, [stroke(grad('linear', { angle: 0 }), 18, { align: 'outside', join: 'bevel' })], turn(0.25))] },
    // Gradients along and across strokes, freeform gradients and meshes (vector/paint.ts's fields).
    { name: 'a gradient along a stroke round an ellipse', nodes: () => [shape(ellipse, [stroke(grad('linear', { stroke: 'along' }), 22)])] },
    { name: 'a gradient across a mitred stroke with a width profile', nodes: () => [shape(star, [stroke(grad('linear', { stroke: 'across', reverse: true }), 26, { profile: [{ at: 0, left: 0.4, right: 1 }, { at: 0.5, left: 1.6, right: 0.7 }, { at: 1, left: 0.4, right: 1 }] })], turn(0.15))] },
    { name: 'a gradient across an inside stroke on a turned rectangle', nodes: () => [shape(rect, [stroke(grad('linear', { stroke: 'across' }), 20, { align: 'inside' })], turn(-0.3, 1.1))] },
    {
      name: 'a freeform gradient of three points, one see-through',
      nodes: () => [
        shape(star, [
          fillItem({
            kind: 'freeform',
            points: [
              { p: [300, 300], colour: red, alpha: 1, spread: 1 },
              { p: [450, 330], colour: blue, alpha: 0.6, spread: 1.6 },
              { p: [380, 460], colour: pale, alpha: 1, spread: 0.7 },
            ],
          }),
        ]),
      ],
    },
    {
      name: 'a warped 2 × 2 mesh on a turned shape, past its edge',
      nodes: () => [
        shape(
          ellipse,
          [
            fillItem({
              kind: 'mesh',
              cols: 2,
              rows: 2,
              nodes: [
                [270, 270, red, 1],
                [380, 280, pale, 1],
                [500, 270, blue, 1],
                [260, 380, blue, 1],
                [410, 360, red, 0.5],
                [490, 390, pale, 1],
                [270, 470, pale, 1],
                [380, 500, blue, 1],
                [480, 460, red, 1],
              ].map(([x, y, colour, alpha]) => ({ p: [x as number, y as number] as [number, number], colour: colour as number[], alpha: alpha as number })),
            }),
          ],
          turn(0.2, 1.05),
        ),
      ],
    },
    {
      name: 'a dashed line with round caps',
      nodes: () => [shape({ kind: 'shape', shape: { type: 'line', x1: 240, y1: 280, x2: 540, y2: 500 } }, [stroke(solid(blue), 12, { cap: 'round', dash: [30, 18] })])],
    },
    {
      name: 'fill and stroke in Screen at 60% over the backdrop',
      blend: 'screen',
      opacity: 0.6,
      nodes: () => [shape(ellipse, [fillItem(solid(red)), stroke(solid(pale), 8)])],
    },
    {
      name: 'dense text: 600 small glyphs, counters and curves',
      nodes: () => [text(probeGlyphs(13, 236, 250, 530, 525, 8.5, 15), [fillItem(solid(blue))])],
    },
    {
      name: 'large glyphs, turned, filled and stroked',
      nodes: () => [text(probeGlyphs(150, 250, 380, 520, 520, 120, 140), [fillItem(grad('linear', { angle: 45 })), stroke(solid(red), 5)], turn(0.3))],
    },
    {
      name: 'a compound shape: a rectangle minus a circle',
      nodes: (root) => {
        const c = makeNode('boolean', 'v', 'Compound', { ops: { b: 'subtract' }, appearance: [fillItem(solid(blue)), stroke(solid(red), 6)] })
        c.children = ['a2', 'b']
        root.children = [...(root.children ?? []).filter((x) => x !== 'v'), 'v']
        return [c, shape(rect, [], [1, 0, 0, 1, 0, 0], 'a2'), shape({ kind: 'shape', shape: { type: 'ellipse', x: 330, y: 300, w: 160, h: 160 } }, [], [1, 0, 0, 1, 0, 0], 'b')]
      },
    },
  ]
}

/**
 * Glyphs as text sets them: two outlines in font units (y up, 1000 to the
 * em), a ring and a D with its counter, placed many times over. The
 * renderer draws a glyph set without HarfBuzz, so these stand in for a
 * font's.
 */
function probeGlyphs(size: number, x0: number, y0: number, x1: number, y1: number, advance: number, leading: number): GlyphSet {
  const k = 0.5523
  const circle = (cx: number, cy: number, r: number, cw: boolean) => {
    const s = cw ? -1 : 1
    return [
      0, cx + r, cy,
      3, cx + r, cy + s * k * r, cx + k * r, cy + s * r, cx, cy + s * r,
      3, cx - k * r, cy + s * r, cx - r, cy + s * k * r, cx - r, cy,
      3, cx - r, cy - s * k * r, cx - k * r, cy - s * r, cx, cy - s * r,
      3, cx + k * r, cy - s * r, cx + r, cy - s * k * r, cx + r, cy,
      4,
    ]
  }
  const ring = [...circle(500, 400, 400, false), ...circle(500, 400, 250, true)]
  const d = [0, 100, 0, 1, 100, 800, 1, 400, 800, 3, 750, 800, 750, 0, 400, 0, 4, 0, 250, 200, 1, 400, 200, 3, 550, 200, 550, 600, 400, 600, 1, 250, 600, 4]
  const s = size / 1000
  const placements: number[] = []
  let i = 0
  for (let y = y0; y <= y1; y += leading) for (let x = x0; x <= x1; x += advance) placements.push(i++ % 3 === 2 ? 1 : 0, s, 0, 0, -s, x, y)
  return { kind: 'glyphs', outlines: [ring, d], placements }
}

/** How much of tile (1, 1) a case changes from the backdrop alone: a probe that drew nothing would pass otherwise. */
function drawnShare(back: Region, expect: (i: number) => Px, n: number): number {
  let changed = 0
  for (let i = 0; i < TILE_PIXELS; i += 3) {
    const o = ((TILE + Math.floor(i / TILE)) * TILE * 3 + TILE + (i % TILE)) * (n + 1)
    const e = expect(i)
    if (Math.abs(e.a - back.data[o + n]) > 0.01 || e.c.some((v, c) => Math.abs(v - back.data[o + c]) > 0.01)) changed++
  }
  return changed / Math.ceil(TILE_PIXELS / 3)
}

/** The probes' pattern made from pixels: an odd size, so its pyramid's levels round, with colour and alpha that vary. */
const PROBE_PATTERN = 'probe-pattern'
function probePattern(tiles: TileStore, f: TileFormat): { id: string; tiles: string; width: number; height: number } {
  const n = COLOURS[f.mode]
  const max = f.depth === 16 ? 65535 : 255
  const w = 37
  const h = 29
  const t = newSamples(f)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * TILE + x
      for (let c = 0; c < n; c++) t[c * TILE_PIXELS + i] = Math.round(max * (0.5 + 0.5 * Math.sin((x * (c + 1)) / 5 + y / 7)))
      t[n * TILE_PIXELS + i] = Math.round(max * (0.35 + 0.65 * (((x * 3 + y * 5) % 11) / 10)))
    }
  return { id: PROBE_PATTERN, tiles: tiles.createSet(f, [[0, 0, tiles.data(f, t)]]), width: w, height: h }
}

/** A circle as a subpath of corners, for a path with its own fill rule. */
function flattenToAnchors(cx: number, cy: number, r: number) {
  const pts = ellipsePoints(cx, cy, r, r)
  return [{ closed: true, anchors: pts.map(([x, y]) => ({ p: [x, y] as [number, number], in: null, out: null, smooth: false })) }]
}

/**
 * Shapes through the render graph (the coverage and paint kernels, the
 * appearance stack, compounds), over a backdrop, against geom/raster.ts's
 * coverage and vector/paint.ts's paints composed by ref/composite.ts.
 */
async function vectorProbe(r: Renderer, tiles: TileStore, mode: ColourMode, depth: Depth) {
  const f: TileFormat = { mode, depth }
  const n = COLOURS[mode]
  const S = n + 1
  const SIZE = TILE * 3
  const back = probeLayer(tiles, f, false)
  const pat = probePattern(tiles, f)
  const img: PatternImage = { key: pat.tiles, w: pat.width, h: pat.height, levels: patternLevels(pat.width, pat.height, await patternPixels(tiles, pat.tiles, pat.width, pat.height)) }
  const patterns = (id: string) => (id === PROBE_PATTERN ? img : undefined)
  const scenePats = [pat]
  const out = []
  for (const [k, c] of vectorCases(mode).entries()) {
    const root = makeNode('group', 'root')
    const bg = makeNode('pixel', 'bg', 'Backdrop', { tiles: back.set, resample: 'nearest' })
    root.children = ['bg', 'v']
    const nodes = c.nodes(root)
    const v = nodes[0]
    v.blend = c.blend ?? 'normal'
    v.opacity = c.opacity ?? 1
    const all = [root, bg, ...nodes]
    const got = await renderMiddle(r, f, `vector-probe-${k}`, all, scenePats)
    // The reference: each item's coverage and paint for tile (1, 1), composed in order.
    const byId = new Map(all.map((x) => [x.id, x]))
    const shape = shapeOf((id) => byId.get(id), v)!
    // Text's reference is its glyphs placed into one ordinary path: the glyph set drawn must be the same shape.
    const outline = vectorOutline(isGlyphs(shape.path) ? glyphsToPath(shape.path) : shape.path, shape.appearance, shape.transform, 0, mode)
    const x0 = TILE
    const y0 = TILE
    const toNode = multiply(invert(levelMatrix(shape.transform, 0) as Matrix), [1, 0, 0, 1, x0, y0])
    const coverOf = (segs: number[], rule: 'nonzero' | 'evenodd') => {
      const local: number[] = []
      const rows = new Float64Array(TILE)
      regionSegments(segs, x0, y0, TILE, TILE, local, rows)
      return rasterRegion(local, TILE, TILE, rule, rows)
    }
    const layers = outline.items.map((it) => {
      // A brush stroke's parts, each its coverage and paint, laid over one another before the item is.
      const parts = it.parts?.map((p) => ({ cov: coverOf(p.segs, p.rule), p: paintParams(p.paint, mode, toNode, outline.pathBox, patterns) }))
      const cov = coverOf(it.segs, it.rule)
      if (it.clip) {
        const cl: number[] = []
        const clRows = new Float64Array(TILE)
        regionSegments(it.clip.segs, x0, y0, TILE, TILE, cl, clRows)
        const cc = rasterRegion(cl, TILE, TILE, it.clip.rule, clRows)
        for (let i = 0; i < cov.length; i++) cov[i] *= it.clip.mode === 'inside' ? cc[i] : 1 - cc[i]
      }
      return { it, cov, parts, p: paintParams(it.item.paint, mode, toNode, outline.pathBox, patterns, it.centre) }
    })
    const expect = (i: number): Px => {
      const o = ((TILE + Math.floor(i / TILE)) * SIZE + TILE + (i % TILE)) * S
      const d: Px = { c: Array.from(back.whole.data.subarray(o, o + n)), a: back.whole.data[o + n] }
      let acc = clear(n)
      for (const L of layers) {
        let px: Px
        if (L.parts) {
          px = clear(n)
          for (const P of L.parts) {
            const pt = paintAt(P.p, i % TILE, Math.floor(i / TILE))
            const cv = P.cov[i]
            px = apply('over', px, { c: pt.c.slice(0, n).map((x) => x * cv), a: pt.a * cv }, 'normal', 1)
          }
        } else {
          const pt = paintAt(L.p, i % TILE, Math.floor(i / TILE))
          const cv = L.cov[i]
          px = { c: pt.c.slice(0, n).map((x) => x * cv), a: pt.a * cv }
        }
        acc = apply('over', acc, px, L.it.item.blend, L.it.item.opacity)
      }
      return apply('over', d, acc, v.blend, v.opacity)
    }
    out.push({ name: c.name, tol: 3e-3, drawn: drawnShare(back.whole, expect, n), ...compare(f, got, expect, 3e-3, 2) })
  }
  // Fill layers: a paint over the whole tile, laid on the backdrop; a gradient without a line across the canvas.
  const fills: { name: string; paint: Paint; t?: DocNode['transform']; blend?: BlendModeId; opacity?: number }[] = [
    { name: 'a fill layer of one colour, in Multiply at 60%', paint: solid(mode === 'rgb' ? [0.2, 0.6, 0.9] : mode === 'gray' ? [0.4] : [0.7, 0.2, 0, 0.1]), blend: 'multiply', opacity: 0.6 },
    { name: 'a gradient fill layer across the canvas', paint: { ...(gradientPaint(mode === 'rgb' ? [1, 0, 0] : mode === 'gray' ? [0] : [0, 1, 1, 0], mode === 'rgb' ? [0, 0, 1] : mode === 'gray' ? [1] : [1, 0, 0, 0]) as Extract<Paint, { kind: 'gradient' }>), angle: 35 } },
    { name: 'a reflected gradient fill layer along a line, moved and turned', paint: { ...(gradientPaint(mode === 'rgb' ? [1, 1, 0] : mode === 'gray' ? [0.2] : [0, 0, 1, 0], mode === 'rgb' ? [0, 0.5, 0] : mode === 'gray' ? [0.9] : [1, 0, 1, 0]) as Extract<Paint, { kind: 'gradient' }>), type: 'reflected', line: [380, 380, 460, 420] }, t: [Math.cos(0.4), Math.sin(0.4), -Math.sin(0.4), Math.cos(0.4), 40, -30] },
    { name: 'a pattern fill layer from pixels', paint: { kind: 'pattern', pattern: PROBE_PATTERN, colour: [0], background: [1], backgroundAlpha: 1, size: 37 * 0.8, angle: -15 } },
  ]
  for (const [k, c] of fills.entries()) {
    const root = makeNode('group', 'root')
    const bg = makeNode('pixel', 'bg', 'Backdrop', { tiles: back.set, resample: 'nearest' })
    const fill = makeNode('fill', 'fl', 'Fill', { paint: c.paint })
    fill.transform = c.t ?? [1, 0, 0, 1, 0, 0]
    fill.blend = c.blend ?? 'normal'
    fill.opacity = c.opacity ?? 1
    root.children = ['bg', 'fl']
    const got = await renderMiddle(r, f, `fill-probe-${k}`, [root, bg, fill], scenePats)
    const toNode = multiply(invert(fill.transform as Matrix), [1, 0, 0, 1, TILE, TILE])
    const p = paintParams(paintIn(c.paint, mode), mode, toNode, [0, 0, SIZE, SIZE], patterns)
    const expect = (i: number): Px => {
      const o = ((TILE + Math.floor(i / TILE)) * SIZE + TILE + (i % TILE)) * S
      const d: Px = { c: Array.from(back.whole.data.subarray(o, o + n)), a: back.whole.data[o + n] }
      const pt = paintAt(p, i % TILE, Math.floor(i / TILE))
      return apply('over', d, { c: pt.c.slice(0, n), a: pt.a }, fill.blend, fill.opacity)
    }
    out.push({ name: c.name, tol: 3e-3, drawn: drawnShare(back.whole, expect, n), ...compare(f, got, expect, 3e-3, 2) })
  }
  // A vector mask on the backdrop: its inside shows, density thins what it hides.
  for (const [k, m] of [
    { invert: false, density: 1 },
    { invert: true, density: 0.7 },
  ].entries()) {
    const root = makeNode('group', 'root')
    const bg = makeNode('pixel', 'bg', 'Backdrop', { tiles: back.set, resample: 'nearest' })
    const geometry: Geometry = { kind: 'shape', shape: { type: 'star', x: 220, y: 230, w: 330, h: 310, points: 6, inner: 0.5 } }
    const mask = makeNode('mask', 'm', 'Mask', { source: 'vector', geometry, invert: m.invert, density: m.density, outside: 1 })
    bg.masks = ['m']
    root.children = ['bg']
    const got = await renderMiddle(r, f, `vector-mask-probe-${k}`, [root, bg, mask])
    const segs = fillSegments(flattenOutline(shapeOf(() => undefined, makeNode('vector', 'x', 'x', { geometry, appearance: [] }))!.path, FLATTEN_TOL))
    const local: number[] = []
    regionSegments(segs, TILE, TILE, TILE, TILE, local)
    const cov = rasterRegion(local, TILE, TILE, 'nonzero')
    const expect = (i: number): Px => {
      const o = ((TILE + Math.floor(i / TILE)) * SIZE + TILE + (i % TILE)) * S
      const d: Px = { c: Array.from(back.whole.data.subarray(o, o + n)), a: back.whole.data[o + n] }
      let v = cov[i]
      if (m.invert) v = 1 - v
      v = 1 - m.density * (1 - v)
      return apply('over', clear(n), d, 'normal', v)
    }
    out.push({ name: `a vector mask${m.invert ? ', inverted, at 70% density' : ''}`, tol: 3e-3, drawn: drawnShare(back.whole, expect, n), ...compare(f, got, expect, 3e-3, 2) })
  }
  return out
}

/**
 * Smart objects: a layer inside one, the smart object scaled and turned,
 * against the same layer drawn directly through the combined transform.
 * Both go through the render graph; the contents are rendered at the mip
 * level the view needs, as the layer's own mips are, so they agree.
 */
async function smartProbe(r: Renderer, tiles: TileStore, mode: ColourMode, depth: Depth) {
  const f: TileFormat = { mode, depth }
  const { set } = probeLayer(tiles, f, true)
  const turn = (k: number, a: number, x: number, y: number) => [Math.cos(a) * k, Math.sin(a) * k, -Math.sin(a) * k, Math.cos(a) * k, x, y] as DocNode['transform']
  const cases: { name: string; t: DocNode['transform'] }[] = [
    { name: 'placed as it is', t: [1, 0, 0, 1, 0, 0] },
    { name: 'scaled to 37% and turned 20°', t: turn(0.37, 0.35, 300, 120) },
    { name: 'enlarged 1.6×', t: turn(1.6, 0, -180, -200) },
  ]
  const out = []
  for (const [k, c] of cases.entries()) {
    const inner = makeNode('pixel', 'a', 'A', { tiles: set, resample: 'bicubic' })
    const innerRoot = makeNode('group', 'inner-root')
    innerRoot.children = ['a']
    const content = { name: 'Contents', width: TILE * 3, height: TILE * 3, resolution: 72, mode, depth, profile: docOf(f, 'x').profile, root: 'inner-root', nodes: { 'inner-root': innerRoot, a: inner }, guides: [], selection: null }
    const root = makeNode('group', 'root')
    const so = makeNode('embedded', 'so', 'Smart', { content })
    so.transform = c.t
    root.children = ['so']
    const viaSmart = await renderMiddle(r, f, `smart-probe-${k}`, [root, so])
    const root2 = makeNode('group', 'root')
    const direct = makeNode('pixel', 'a', 'A', { tiles: set, resample: 'bicubic' })
    direct.transform = c.t
    root2.children = ['a']
    const plain = await renderMiddle(r, f, `smart-probe-direct-${k}`, [root2, direct])
    let maxErr = 0
    let bad = 0
    for (let i = 0; i < plain.length; i++) {
      const e = Math.abs(plain[i] - viaSmart[i])
      maxErr = Math.max(maxErr, e)
      if (e > 2e-3) bad++
    }
    // Something there to compare: alpha in most of the tile.
    let drawn = 0
    const S = COLOURS[mode] + 1
    for (let i = S - 1; i < plain.length; i += S) if (viaSmart[i] > 0) drawn++
    out.push({ name: c.name, maxErr, bad: bad / plain.length, drawn: drawn / (plain.length / S) })
  }
  return out
}

/**
 * A filter baked into a layer for good, against the same filter drawn
 * live: the middle tile's samples, which should differ by no more than the
 * rounding to the document's depth. Then through a selection of the left
 * half, which should leave the right half as it was.
 */
async function bakeProbe(r: Renderer, tiles: TileStore, mode: ColourMode, depth: Depth) {
  const f: TileFormat = { mode, depth }
  const { set } = probeLayer(tiles, f, true)
  const max = depth === 16 ? 65535 : 255
  const planes = planesOf(f)
  const key = 'bake-probe'
  const root = makeNode('group', 'root')
  const a = makeNode('pixel', 'a', 'A', { tiles: set, resample: 'nearest' })
  root.children = ['a']
  const blur = makeNode('filter', 'b', 'Blur', { filter: 'gaussian-blur', params: { radius: 5 } })
  r.updateScene(key, { doc: { ...docOf(f, 'root'), width: TILE * 3, height: TILE * 3 }, nodes: [root, a].map((node) => ({ node, version: version++ })), removed: [], reset: true })
  try {
    const baked = await bakeEffects(r, tiles, key, 'a', [blur], null)
    const half = rasterizePolygon(tiles, [[0, 0], [384, 0], [384, 768], [0, 768]], 768, 768, false)
    const partly = await bakeEffects(r, tiles, key, 'a', [blur], half)
    const live = makeNode('pixel', 'a', 'A', { tiles: set, resample: 'nearest' })
    live.effects = ['b']
    const got = await renderMiddle(r, f, 'bake-probe-live', [root, live, blur])
    const samples = async (s2: string | null) => {
      const id = s2 ? tiles.tileAt(s2, 1, 1) : undefined
      return id !== undefined ? await tiles.samples(id) : newSamples(f)
    }
    const b = await samples(baked)
    const p = await samples(partly)
    const o = await samples(set)
    let worst = 0
    let leftWorst = 0
    let rightWorst = 0
    for (let i = 0; i < TILE_PIXELS; i++) {
      // The live render, straight, in the document's terms, at its depth.
      const S = planes
      const al = got[i * S + S - 1]
      const qa = Math.round(Math.min(1, Math.max(0, al)) * max)
      if (qa > 2) for (let c = 0; c < planes - 1; c++) {
        const v = Math.min(1, Math.max(0, got[i * S + c] / al))
        const want = Math.round((mode === 'cmyk' ? 1 - v : v) * max)
        worst = Math.max(worst, Math.abs(b[c * TILE_PIXELS + i] - want))
      }
      worst = Math.max(worst, Math.abs(b[(planes - 1) * TILE_PIXELS + i] - qa))
      const x = 256 + (i % TILE)
      for (let c = 0; c < planes; c++) {
        if (x < 384 - 1) leftWorst = Math.max(leftWorst, Math.abs(p[c * TILE_PIXELS + i] - b[c * TILE_PIXELS + i]))
        if (x >= 384) rightWorst = Math.max(rightWorst, Math.abs(p[c * TILE_PIXELS + i] - o[c * TILE_PIXELS + i]))
      }
    }
    return { worst, leftWorst, rightWorst }
  } finally {
    r.close(key)
  }
}

async function filterProbe(r: Renderer, tiles: TileStore, mode: ColourMode, depth: Depth) {
  const f: TileFormat = { mode, depth }
  const n = COLOURS[mode]
  const S = n + 1
  const SIZE = TILE * 3
  const { set, whole } = probeLayer(tiles, f)
  const ctx = { origin: [0, 0] as [number, number], scale: 1, seed: 0 }
  const runs: { name: string; effects: DocNode[]; ref: () => Region; tol?: number; allowed?: number }[] = []
  for (const [id, name, params, tol, allowed] of FILTER_CASES) {
    const e = makeNode('filter', `flt-${runs.length}`, name, { filter: id, params })
    const v = filterValues(id, params, mode)
    runs.push({ name, effects: [e], ref: () => FILTER_BY_ID.get(id)!.ref(whole, v, { ...ctx, seed: seedOf(e.id) }), tol, allowed })
  }
  {
    const blur = makeNode('filter', 'chain-blur', 'Blur', { filter: 'gaussian-blur', params: { radius: 3 } })
    const inv = makeNode('adjustment', 'chain-inv', 'Invert', { adjustment: 'invert' })
    const prog = programFor('invert', {}, mode)!
    runs.push({
      name: 'a chain: Gaussian Blur, then Invert',
      effects: [blur, inv],
      ref: () => {
        const b = FILTER_BY_ID.get('gaussian-blur')!.ref(whole, filterValues('gaussian-blur', { radius: 3 }, mode), ctx)
        const out = new Float64Array(b.data)
        for (let i = 0; i < SIZE * SIZE; i++) {
          const o = i * S
          const a = out[o + n]
          if (a <= 0) continue
          const sc = Array.from({ length: n }, (_, c) => Math.min(1, Math.max(0, out[o + c] / a)))
          runProgram(prog, mode, sc, mode === 'cmyk' ? cmykTablesFor(docOf({ mode, depth }, 'x').profile) : null).forEach((v, c) => (out[o + c] = v * a))
        }
        return { ...b, data: out }
      },
    })
    const half = makeNode('filter', 'half-blur', 'Blur', { filter: 'box-blur', params: { radius: 7 } })
    half.opacity = 0.6
    runs.push({
      name: 'Box Blur at 60%',
      effects: [half],
      ref: () => {
        const b = FILTER_BY_ID.get('box-blur')!.ref(whole, filterValues('box-blur', { radius: 7 }, mode), ctx)
        return { ...b, data: b.data.map((v, i) => whole.data[i] + (v - whole.data[i]) * 0.6) }
      },
    })
  }
  const out = []
  const format = { mode, store: 'f32' as Store }
  const bytes = tileBufferBytes(format)
  for (const [k, run] of runs.entries()) {
    const key = `filter-probe-${k}`
    const root = makeNode('group', 'root')
    const a = makeNode('pixel', 'a', 'A', { tiles: set, resample: 'nearest' })
    a.effects = run.effects.map((e) => e.id)
    root.children = ['a']
    r.updateScene(key, { doc: { ...docOf(f, 'root'), width: SIZE, height: SIZE }, nodes: [root, a, ...run.effects].map((node) => ({ node, version: version++ })), removed: [], reset: true })
    const before = r.store8
    if (depth === 8) r.store8 = 'f32'
    const staging = r.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    try {
      const enc = r.beginWork()
      const job = r.job(r.docState(key)!, 0, 1, 1, enc)
      job.format = format
      const buf = r.renderTile(job)
      if (buf) {
        enc.copyBufferToBuffer(buf, 0, staging, 0, bytes)
        r.bufferPool.release(buf)
      }
      r.finishWork(enc)
      await staging.mapAsync(GPUMapMode.READ)
      const got = new Float32Array(staging.getMappedRange().slice(0))
      staging.unmap()
      const ref = run.ref()
      const expect = (i: number): Px => {
        const o = ((TILE + Math.floor(i / TILE)) * SIZE + TILE + (i % TILE)) * S
        return { c: Array.from(ref.data.subarray(o, o + n)), a: ref.data[o + n] }
      }
      const tol = run.tol ?? 2e-3
      out.push({ name: run.name, tol, allowed: run.allowed ?? 0.001, ...compare(f, got, expect, tol, 3) })
    } finally {
      staging.destroy()
      r.store8 = before
      r.close(key)
    }
  }
  return out
}

// --- masks ---------------------------------------------------------------------------------

/**
 * Masks through the render graph against a CPU reckoning of the same
 * sums: a mask's gray tiles sampled through its transform, `outside` where
 * it has none, blurred by a true Gaussian for its feather, inverted, thinned
 * by its density, masks multiplied, and the node laid on at its opacity
 * times that. On a layer, a group, a clipped layer and a pass-through group.
 */
async function maskProbe(r: Renderer, tiles: TileStore, mode: ColourMode, depth: Depth) {
  const f: TileFormat = { mode, depth }
  const n = COLOURS[mode]
  const G: TileFormat = { mode: 'gray', depth: 8 }
  const sa = randomTile(f)
  const sb = randomTile(f)
  const A = tiles.createSet(f, [[0, 0, tiles.data(f, sa)]])
  const B = tiles.createSet(f, [[0, 0, tiles.data(f, sb)]])
  // A mask tile: smooth with some noise, so a blur has something to do.
  const ms = newSamples(G)
  for (let i = 0; i < TILE_PIXELS; i++) {
    const x = i % TILE
    const y = Math.floor(i / TILE)
    ms[i] = Math.max(0, Math.min(255, Math.round(128 + 100 * Math.sin(x / 17) * Math.cos(y / 23) + (rand() - 0.5) * 60)))
  }
  ms.fill(255, TILE_PIXELS)
  const M = tiles.createSet(G, [[0, 0, tiles.data(G, ms)]])
  const M2 = tiles.createSet(G, [[0, 0, tiles.data(G, ms.map((v, i) => (i < TILE_PIXELS ? 255 - v : 255)) as Samples)]])
  const pa = (i: number) => pixelOf(f, sa, i)
  const pb = (i: number) => pixelOf(f, sb, i)
  const raw = (set: string) => (set === M ? ms : M2 === set ? ms.map((v, i) => (i < TILE_PIXELS ? 255 - v : 255)) : null)!

  interface MaskSpec { tiles: string | null; outside: number; invert?: boolean; density?: number; feather?: number; t?: number[] }
  const maskNode = (id: string, m: MaskSpec) => {
    const node = makeNode('mask', id, 'Mask', { tiles: m.tiles, outside: m.outside, invert: !!m.invert, density: m.density ?? 1, feather: m.feather ?? 0 })
    if (m.t) node.transform = m.t as DocNode['transform']
    return node
  }
  /** The reference: every pixel's coverage from a mask spec. */
  const coverOf = (m: MaskSpec): Float32Array => {
    const t = m.t ?? [1, 0, 0, 1, 0, 0]
    const inv = invert(t as Matrix)
    const g = m.tiles ? raw(m.tiles) : null
    const value = (x: number, y: number) => {
      // (x, y) is a pixel centre in document pixels.
      const mx = inv[0] * x + inv[2] * y + inv[4]
      const my = inv[1] * x + inv[3] * y + inv[5]
      const texel = (ix: number, iy: number): Px => (g && ix >= 0 && iy >= 0 && ix < TILE && iy < TILE ? { c: [g[iy * TILE + ix] / 255], a: 1 } : { c: [0], a: 0 })
      const aligned = t.every((v, k) => (k < 4 ? v === [1, 0, 0, 1][k] : Number.isInteger(v)))
      const p = sample(texel, mx, my, aligned ? 'nearest' : 'bilinear', 1)
      return Math.min(1, Math.max(0, p.c[0] + (1 - p.a) * m.outside))
    }
    const sigma = (m.feather ?? 0) / 2
    const margin = sigma >= 0.25 ? Math.ceil(sigma * 3) : 0
    const size = TILE + 2 * margin
    const wide = new Float64Array(size * size)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) wide[y * size + x] = value(x - margin + 0.5, y - margin + 0.5)
    let cover = new Float64Array(TILE_PIXELS)
    if (!margin) cover = wide
    else {
      const w = Array.from({ length: 2 * margin + 1 }, (_, k) => Math.exp(-((k - margin) ** 2) / (2 * sigma * sigma)))
      const ws = w.reduce((a, v) => a + v, 0)
      const across = new Float64Array(TILE * size)
      for (let y = 0; y < size; y++) for (let x = 0; x < TILE; x++) {
        let sum = 0
        for (let k = 0; k < w.length; k++) sum += wide[y * size + x + k] * w[k]
        across[y * TILE + x] = sum / ws
      }
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        let sum = 0
        for (let k = 0; k < w.length; k++) sum += across[(y + k) * TILE + x] * w[k]
        cover[y * TILE + x] = sum / ws
      }
    }
    return Float32Array.from(cover, (v) => {
      let c = m.invert ? 1 - v : v
      c = 1 - (m.density ?? 1) * (1 - c)
      return c
    })
  }

  const cases: (Case & { tol: number })[] = []
  const add = (name: string, nodes: DocNode[], expect: (i: number) => Px, tol = 2e-4) => cases.push({ name, update: update(f, nodes), expect, tol })
  const layerWith = (name: string, specs: MaskSpec[], tol?: number) => {
    const root = makeNode('group', 'root')
    const b = makeNode('pixel', 'b', 'B', { tiles: B, resample: 'nearest' })
    b.opacity = 0.9
    const masks = specs.map((m, i) => maskNode(`m${i}`, m))
    b.masks = masks.map((m) => m.id)
    root.children = ['b']
    const covers = specs.map(coverOf)
    add(name, [root, b, ...masks], (i) => apply('over', clear(n), pb(i), 'normal', 0.9 * covers.reduce((a, c) => a * c[i], 1)), tol)
  }
  layerWith('a mask on a layer', [{ tiles: M, outside: 1 }])
  layerWith('inverted, at 60% density', [{ tiles: M, outside: 1, invert: true, density: 0.6 }])
  layerWith('a mask with no tiles, hiding everything', [{ tiles: null, outside: 0 }])
  layerWith('a mask that hides outside its tiles, moved off the tile', [{ tiles: M, outside: 0, t: [1, 0, 0, 1, 37.5, 12.25] }], 2e-3)
  layerWith('turned and scaled', [{ tiles: M, outside: 1, t: [Math.cos(0.4) * 1.2, Math.sin(0.4) * 1.2, -Math.sin(0.4) * 1.2, Math.cos(0.4) * 1.2, 40, -30] }], 2e-3)
  layerWith('feathered 12 px', [{ tiles: M, outside: 0, feather: 12 }], 5e-4)
  layerWith('two masks multiply', [{ tiles: M, outside: 1 }, { tiles: M2, outside: 1, density: 0.5 }])

  {
    const root = makeNode('group', 'root')
    const g = makeNode('group', 'g', 'G')
    g.blend = 'normal'
    g.opacity = 0.8
    const b = makeNode('pixel', 'b', 'B', { tiles: B, resample: 'nearest' })
    const m = maskNode('m0', { tiles: M, outside: 1 })
    g.masks = ['m0']
    g.children = ['b']
    root.children = ['g']
    const c = coverOf({ tiles: M, outside: 1 })
    add('a mask on an isolated group', [root, g, b, m], (i) => apply('over', clear(n), pb(i), 'normal', 0.8 * c[i]))
  }
  {
    const root = makeNode('group', 'root')
    const a = makeNode('pixel', 'a', 'A', { tiles: A, resample: 'nearest' })
    const b = makeNode('pixel', 'b', 'B', { tiles: B, resample: 'nearest' })
    b.blend = 'multiply'
    const m = maskNode('m0', { tiles: M, outside: 1 })
    b.masks = ['m0']
    a.children = ['b']
    root.children = ['a']
    const c = coverOf({ tiles: M, outside: 1 })
    add('a mask on a clipped layer', [root, a, b, m], (i) => apply('atop', pa(i), pb(i), 'multiply', c[i]))
  }
  {
    const root = makeNode('group', 'root')
    const a = makeNode('pixel', 'a', 'A', { tiles: A, resample: 'nearest' })
    const g = makeNode('group', 'g', 'G')
    g.opacity = 0.7
    const b = makeNode('pixel', 'b', 'B', { tiles: B, resample: 'nearest' })
    b.blend = 'screen'
    const m = maskNode('m0', { tiles: M, outside: 1, invert: true })
    g.masks = ['m0']
    g.children = ['b']
    root.children = ['a', 'g']
    const c = coverOf({ tiles: M, outside: 1, invert: true })
    add('a mask on a pass-through group', [root, a, g, b, m], (i) => apply('lerp', pa(i), apply('over', pa(i), pb(i), 'screen', 1), 'normal', 0.7 * c[i]))
  }

  const got = await renderCases(r, f, 'f32', cases)
  return cases.map((c, i) => ({ name: c.name, tol: c.tol, ...compare(f, got[i], c.expect, c.tol, 2) }))
}

// --- the bench's measurements ------------------------------------------------------------

/** A set of random data tiles covering width × height: a stand-in for a big photo, made fast. */
function noiseSet(tiles: TileStore, f: TileFormat, width: number, height: number): string {
  const entries: [number, number, number][] = []
  let x = 12345
  for (let ty = 0; ty < Math.ceil(height / TILE); ty++) {
    for (let tx = 0; tx < Math.ceil(width / TILE); tx++) {
      const s = newSamples(f)
      const words = new Uint32Array(s.buffer, s.byteOffset, s.byteLength / 4)
      for (let i = 0; i < words.length; i++) words[i] = x = (Math.imul(x, 1664525) + 1013904223) >>> 0
      // Opaque, so every layer covers what's below it.
      const max = f.depth === 16 ? 65535 : 255
      s.fill(max, (planesOf(f) - 1) * TILE_PIXELS)
      entries.push([tx, ty, tiles.data(f, s)])
    }
  }
  return tiles.createSet(f, entries)
}

/** Uploading `count` data tiles to the atlas: bytes per second, CPU to GPU-done. */
async function benchUpload(r: Renderer, tiles: TileStore, mode: ColourMode, depth: Depth, count: number) {
  const f: TileFormat = { mode, depth }
  const set = noiseSet(tiles, f, TILE * count, TILE)
  const res = r.residency(mode, depth)
  await r.device.queue.onSubmittedWorkDone()
  const t0 = performance.now()
  const enc = r.beginWork()
  for (let i = 0; i < count; i++) res.resolve(enc, set, 0, i, 0)
  r.finishWork(enc)
  await r.device.queue.onSubmittedWorkDone()
  const ms = performance.now() - t0
  const bytes = count * TILE_PIXELS * planesOf(f) * (depth / 8)
  return { ms, tiles: count, bytesPerSecond: bytes / (ms / 1000) }
}

/**
 * Compositing time for `layers` opaque noise layers over `count` tiles, in
 * a storage format: what one full redraw of a view of that many tiles
 * costs on the GPU.
 */
async function benchComposite(r: Renderer, tiles: TileStore, mode: ColourMode, depth: Depth, store: Store, layers: number, count: number) {
  const f: TileFormat = { mode, depth }
  const side = Math.ceil(Math.sqrt(count))
  const set = noiseSet(tiles, f, TILE * side, TILE * side)
  const root = makeNode('group', 'root')
  const nodes: DocNode[] = [root]
  for (let i = 0; i < layers; i++) {
    const n = makeNode('pixel', `l${i}`, `L${i}`, { tiles: set, resample: 'bilinear' })
    n.blend = i % 2 ? 'multiply' : 'screen'
    n.opacity = 0.8
    nodes.push(n)
  }
  root.children = nodes.slice(1).map((n) => n.id)
  const before = r.store8
  if (depth === 8) r.store8 = store
  const key = `bench-${store}`
  r.updateScene(key, { doc: { ...docOf(f, 'root'), width: TILE * side, height: TILE * side }, nodes: nodes.map((node) => ({ node, version: version++ })), removed: [], reset: true })
  try {
    // Once to upload, then timed.
    const run = async () => {
      const enc = r.beginWork()
      const s = r.docState(key)!
      for (let i = 0; i < count; i++) {
        const job = r.job(s, 0, i % side, Math.floor(i / side), enc)
        if (depth === 16) job.format = { mode, store }
        const buf = r.renderTile(job)
        if (buf) r.bufferPool.release(buf)
      }
      r.finishWork(enc)
      await r.device.queue.onSubmittedWorkDone()
    }
    await run()
    const t0 = performance.now()
    await run()
    const ms = performance.now() - t0
    return { ms, perTileMs: ms / count, layers, tiles: count, bufferBytes: tileBufferBytes({ mode, store }) }
  } finally {
    r.close(key)
    r.store8 = before
  }
}

export async function probe(r: Renderer, tiles: TileStore, features: string[], args: { kind: string; [k: string]: unknown }): Promise<unknown> {
  switch (args.kind) {
    case 'features':
      return { features, store8: r.store8 }
    case 'composite':
      return compositeProbe(r, tiles, args.mode as ColourMode, args.depth as Depth, args.store as Store, (args.modes as BlendModeId[] | undefined) ?? BLEND_MODES.filter((m) => m !== 'pass-through'))
    case 'resample':
      return resampleProbe(r, tiles, args.mode as ColourMode, args.depth as Depth)
    case 'lut':
      return lutProbe(r, args.mode as ColourMode)
    case 'look':
      return lookProbe(r, args.mode as ColourMode)
    case 'paint':
      return paintProbe(r, tiles, args.mode as ColourMode, args.depth as Depth)
    case 'sample':
      return sampleProbe(r, tiles, args.mode as ColourMode, args.depth as Depth)
    case 'adjust':
      return adjustProbe(r, tiles, args.mode as ColourMode, args.depth as Depth)
    case 'filter':
      return filterProbe(r, tiles, args.mode as ColourMode, args.depth as Depth)
    case 'fx':
      return fxProbe(r, tiles, args.mode as ColourMode, args.depth as Depth)
    case 'bake':
      return bakeProbe(r, tiles, args.mode as ColourMode, args.depth as Depth)
    case 'smart':
      return smartProbe(r, tiles, args.mode as ColourMode, args.depth as Depth)
    case 'mask':
      return maskProbe(r, tiles, args.mode as ColourMode, args.depth as Depth)
    case 'vector':
      return vectorProbe(r, tiles, args.mode as ColourMode, args.depth as Depth)
    case 'display':
      return r.front ? Object.fromEntries(r.docState(r.front)?.display ?? []) : null
    case 'bench.noise':
      return noiseSet(tiles, { mode: args.mode as ColourMode, depth: args.depth as Depth }, args.width as number, args.height as number)
    case 'bench.upload':
      return benchUpload(r, tiles, args.mode as ColourMode, args.depth as Depth, args.count as number)
    case 'bench.composite':
      return benchComposite(r, tiles, args.mode as ColourMode, args.depth as Depth, args.store as Store, args.layers as number, args.count as number)
    default:
      throw new Error(`No probe “${args.kind}”`)
  }
}
