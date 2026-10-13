/**
 * The renderer: everything the engine worker draws, and when.
 *
 * It keeps a Scene and a View for each open document, and draws the one in
 * front. Each frame it works out which tiles the view needs at the mip
 * level that suits the zoom, renders the ones that are missing or out of
 * date (nearest the centre first, within a time budget), converts them
 * through the display table into the display atlas, and draws the screen
 * from whatever is ready. Until a tile is ready the screen shows its last
 * result, or a coarser level, so nothing ever waits on a frame.
 *
 * An edit marks the display tiles it touched as stale rather than dropping
 * them: the old image stays up until the new one is there.
 */
import type { DisplayProfileId } from '../color/profiles'
import { tileWraps, type ColourMode, type Depth, type DocNode, type ProfileRef } from '../doc/types'
import { TILE } from '../tiles/format'
import type { TileStore } from '../tiles/store'
import { lutFor, colourNow, colour, cmykTablesFor } from '../engine/colourHost'
import { cmykTableData } from './shaders/adjust'
import { Atlas } from './gpu/atlas'
import { BufferPool, Kernels, Ring } from './gpu/kernels'
import { Graph, type TileJob } from './graph'
import { AtlasFull, NotReady, Residency } from './residency'
import { Scene, intersects, scenePatterns, type Rect, type SceneUpdate } from './scene'
import { patternLevels, type PatternImage } from '../vector/paint'
import { patternBuffer } from './shaders/vector'
import { patternPixels } from '../tiles/patterns'
import type { BufferFormat, Store } from './shaders/common'
import { LUT_PARAMS_BYTES, writeLutParams } from './shaders/display'
import { DEFAULT_LOOK, type DocLook } from '../color/proof'
import { PLAIN_LOOK, type Look } from '../color/lut'
import { invert, mipLevel, multiply, paneCanvas, paneMatrix, paneRects, tileRect, visibleTiles, apply as applyM, type Canvas, type Matrix, type Pane, type View } from './view'
import type { Lut } from '../color/lut'
import { LiveStroke, SELECTION_NODE, TipBank, bake, type Reservoir, type StrokeStart, type StrokeTarget } from './strokes'
import { CoverReader, coverForTile } from '../tiles/coverage'
import { NO_OVERLAY, VERTEX_FLOATS, tessellate, type Overlay, type OverlayShape, type OverlayView } from './overlay'
import type { BrushCursor } from '../engine/protocol'
import { OVERLAY_PARAMS_BYTES } from './shaders/overlay'
import type { MaskLike } from './graph'
import { RingReader, type Ring as PenRing } from '../input/penRing'
import type { PenSample } from '../brush/stroke'

export type Rgb = [number, number, number]

/** Budgets, in bytes of GPU memory. */
const TILE_BUDGET = 512 * 1024 * 1024
const DISPLAY_BUDGET = 256 * 1024 * 1024
const GROUP_CACHE_BUDGET = 192 * 1024 * 1024
/** How long a frame may spend encoding new tiles, in milliseconds. */
const FRAME_BUDGET_MS = 10
// Ten vec4s, then three levels of five.
const SCREEN_BYTES = 160 + 3 * 80
/** GPU memory for the selection's coverage tiles. */
const SELECTION_BUDGET = 64 * 1024 * 1024
/** How often the marching ants crawl a step, in milliseconds. */
const ANTS_MS = 120
const CHECK_A: Rgb = [1, 1, 1]
const CHECK_B: Rgb = [0.8, 0.8, 0.8]
const CHECK = 8

interface DocState {
  scene: Scene
  view: View | null
  /** How it's looked at: proofing, the gamut warning, separations. */
  look: DocLook
  /** Display tiles by `level:tx,ty`: an atlas slot, or -2 for a tile with nothing on it. */
  display: Map<string, { slot: number; stale: boolean }>
  lut: { key: string; buffer: GPUBuffer; params: GPUBuffer } | null
  /** What the tools draw over it. */
  overlay: Overlay
  /** A split view's second pane (app/views.ts), and where the canvas is cut: a share of its width. */
  second: View | null
  split: number
  /** The selection's coverage tiles, by `level:tx,ty`: an atlas slot, -2 for none, -3 for all. */
  sel: Map<string, { slot: number; stale: boolean }>
  /** The selection set those tiles are of. */
  selSet: string | null
}

export interface FrameInfo {
  rendered: number
  pending: number
  ms: number
  level: number | null
}

/** How many patterns made from pixels are kept on the GPU at once. */
const PATTERNS_KEPT = 32

export class Renderer {
  private kernels: Kernels
  private pool: BufferPool
  private params: Ring
  private storage: Ring
  private graph: Graph
  private residencies = new Map<string, Residency>()
  private displayAtlas: Atlas<string>
  private selAtlas: Atlas<string>
  private docs = new Map<string, DocState>()
  front: string | null = null
  private canvas: Canvas = { width: 1, height: 1, dpr: 1 }
  display: DisplayProfileId = 'srgb'
  private pasteboard: Rgb = [0.25, 0.25, 0.25]
  /** Composite storage for 8-bit documents; 16-bit ones are always f32. */
  store8: Store
  /** Frames submitted and not yet done on the GPU. Two may be: one running, one queued behind it. */
  private inFlight = 0
  /** The encoder being filled, for atlases that grow mid-frame. */
  private encoder: GPUCommandEncoder | null = null
  /** Strokes being painted, by id, and by document and node. */
  private strokes = new Map<number, LiveStroke>()
  private strokeOn = new Map<string, LiveStroke>()
  private ring: RingReader | null = null
  /**
   * Samples that came through the ring before their stroke's begin message
   * did (the ring doesn't wait for the message queue), held until it does.
   */
  private early = new Map<number, PenSample[]>()
  private tips: TipBank | null = null
  /** What the Mixer's reservoir held after its last stroke. */
  private mixerCarry: Reservoir | null = null
  /** Buffers replaced during the frame, destroyed once it's submitted. */
  private doomed: GPUBuffer[] = []
  /** The brush cursor, in document pixels, for the document in front. */
  private cursor: BrushCursor | null = null
  /** Keeps a stroke's new tile set from being collected before the page commits it. */
  pins: { pin(id: string): void; unpin(id: string): void } = { pin: () => {}, unpin: () => {} }
  stats = { tiles: 0, uploads: 0, mips: 0, dispatches: 0 }
  private antsTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly device: GPUDevice,
    private context: GPUCanvasContext,
    canvasFormat: GPUTextureFormat,
    private tiles: TileStore,
    features: string[],
    private requestFrame: () => void,
  ) {
    this.kernels = new Kernels(device, canvasFormat)
    this.pool = new BufferPool(device)
    const full = () => {
      throw new RingFull()
    }
    this.params = new Ring(device, 'params', 2 * 1024 * 1024, GPUBufferUsage.UNIFORM, full)
    // Copied from as well: a constant selection tile goes into its atlas from here.
    this.storage = new Ring(device, 'windows', 8 * 1024 * 1024, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, full)
    this.graph = new Graph(device, this.kernels, this.pool, this.params, this.storage, GROUP_CACHE_BUDGET)
    this.displayAtlas = new Atlas<string>(device, {
      label: 'display tiles',
      formats: ['rgba16float'],
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      bytesPerLayer: TILE * TILE * 8,
      budget: DISPLAY_BUDGET,
      start: 64,
      encoder: () => this.encoder,
    })
    this.displayAtlas.onEvict = (key) => {
      const [doc, rest] = key.split('|')
      this.docs.get(doc)?.display.delete(rest)
    }
    this.selAtlas = new Atlas<string>(device, {
      label: 'selection tiles',
      formats: ['r32float'],
      usage: GPUTextureUsage.TEXTURE_BINDING,
      bytesPerLayer: TILE * TILE * 4,
      budget: SELECTION_BUDGET,
      start: 16,
      encoder: () => this.encoder,
    })
    this.selAtlas.onEvict = (key) => {
      const [doc, rest] = key.split('|')
      this.docs.get(doc)?.sel.delete(rest)
    }
    this.store8 = features.includes('shader-f16') ? 'f16' : 'f32'
    this.graph.liveStroke = (doc, node) => this.strokeOn.get(`${doc}|${node}`)
    this.graph.subScene = (parent, node) => this.subScene(parent, node)
    this.graph.cmykTables = (profile) => this.cmykTableBuffer(profile)
    this.graph.patternOf = (scene, id) => this.patternOf(scene, id)
  }

  /** Patterns made from pixels on the GPU, by tile set, most recently used last. */
  private patterns = new Map<string, { image: PatternImage; buffer: GPUBuffer }>()
  private patternsReading = new Map<string, Promise<void>>()

  /**
   * A scene's pattern by id, its pyramid on the GPU: built the first time
   * it's drawn (the tile waits, NotReady, while its pixels are read), then
   * kept by its tile set, which never changes.
   */
  private patternOf(scene: Scene, id: string): { image: PatternImage; buffer: GPUBuffer } | undefined {
    const p = scene.doc?.patterns?.find((x) => x.id === id)
    if (!p || !this.tiles.hasSet(p.tiles)) return undefined
    const hit = this.patterns.get(p.tiles)
    if (hit) {
      this.patterns.delete(p.tiles)
      this.patterns.set(p.tiles, hit)
      return hit
    }
    let reading = this.patternsReading.get(p.tiles)
    if (!reading) {
      reading = patternPixels(this.tiles, p.tiles, p.width, p.height)
        .then((px) => {
          const image: PatternImage = { key: p.tiles, w: p.width, h: p.height, levels: patternLevels(p.width, p.height, px) }
          const data = patternBuffer(image.levels)
          const buffer = this.device.createBuffer({ label: 'pattern', size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
          this.device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>)
          this.patterns.set(p.tiles, { image, buffer })
          // A few dozen patterns at most are kept; the oldest goes.
          if (this.patterns.size > PATTERNS_KEPT) {
            // Let go, not destroyed: a frame being built may still use it.
            this.patterns.delete(this.patterns.keys().next().value!)
          }
        })
        .finally(() => this.patternsReading.delete(p.tiles))
      this.patternsReading.set(p.tiles, reading)
    }
    throw new NotReady([reading])
  }

  private cmykBuffers = new Map<string, GPUBuffer>()
  private offscreenLuts = new Map<string, { buffer: GPUBuffer; params: GPUBuffer }>()

  /** A CMYK profile's adjustment tables on the GPU, made once per profile. */
  private cmykTableBuffer(profile: ProfileRef): GPUBuffer | null {
    const key = JSON.stringify(profile)
    let b = this.cmykBuffers.get(key)
    if (b) return b
    const t = cmykTablesFor(profile)
    // Not drawn the rough way and left so: the tile waits for the colour engine.
    if (!t) throw new NotReady([colour().then(() => {})])
    const data = cmykTableData(t)
    b = this.device.createBuffer({ label: 'cmyk tables', size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>)
    this.cmykBuffers.set(key, b)
    return b
  }

  /** Smart objects' contents, as scenes of their own, by `parent key/node id`. */
  private subs = new Map<string, { scene: Scene; content: object }>()
  private nodeVersions = new WeakMap<object, number>()
  private nextVersion = 1

  /** A smart object's contents as a scene: made the first time it's drawn, and again when they change. */
  private subScene(parent: Scene, node: DocNode): Scene | null {
    if (node.kind !== 'embedded' || !node.props.content) return null
    const c = node.props.content
    const key = `${parent.key}/${node.id}`
    let e = this.subs.get(key)
    if (!e || e.content !== c) {
      const scene = e?.scene ?? new Scene(key, (id) => (this.tiles.hasSet(id) ? this.tiles.extent(id) : null))
      const version = (n: object) => {
        let v = this.nodeVersions.get(n)
        if (v === undefined) this.nodeVersions.set(n, (v = this.nextVersion++))
        return v
      }
      scene.apply({
        doc: { width: c.width, height: c.height, mode: c.mode, depth: c.depth, profile: c.profile, root: c.root, selection: null, patterns: scenePatterns(c) },
        nodes: Object.values(c.nodes).map((n) => ({ node: n, version: version(n) })),
        removed: [],
        reset: true,
      })
      e = { scene, content: c }
      this.subs.set(key, e)
    }
    return e.scene
  }

  // --- state from the page ------------------------------------------------------

  resize(c: Canvas) {
    this.canvas = c
  }

  setPasteboard(rgb: Rgb) {
    this.pasteboard = rgb
  }

  setDisplay(d: DisplayProfileId) {
    if (d === this.display) return
    this.display = d
    for (const s of this.docs.values()) this.markAll(s)
  }

  private state(key: string): DocState {
    let s = this.docs.get(key)
    if (!s) {
      s = { scene: new Scene(key, (id) => (this.tiles.hasSet(id) ? this.tiles.extent(id) : null)), view: null, second: null, split: 0.5, look: DEFAULT_LOOK, display: new Map(), lut: null, overlay: NO_OVERLAY, sel: new Map(), selSet: null }
      this.docs.set(key, s)
    }
    return s
  }

  updateScene(key: string, u: SceneUpdate) {
    const s = this.state(key)
    const formatBefore = s.scene.doc ? `${s.scene.doc.mode}/${s.scene.doc.depth}` : null
    const { dirty, colour } = s.scene.apply(u)
    if (u.doc.selection !== s.selSet || dirty === 'all') this.dropSelection(key, s)
    s.selSet = u.doc.selection
    const formatAfter = `${u.doc.mode}/${u.doc.depth}`
    if (dirty === 'all' || formatBefore !== formatAfter) {
      this.dropDisplay(key, s)
      this.graph.forget(key)
    } else {
      if (colour) this.markAll(s)
      this.markDirty(s, dirty)
      this.graph.forget(key, new Set(s.scene.nodes.keys()))
    }
    // A finished stroke goes once the document has its result (or has moved on).
    for (const st of [...this.strokes.values()]) {
      if (st.start.key !== key || st.result === undefined) continue
      const t = this.targetOf(s, st.start)
      if (typeof t === 'string' || t.set === st.result) this.dropStroke(st)
    }
  }

  /**
   * A tiled document's dirty regions with their copies a whole period away
   * that reach the canvas: a change past one edge shows at the other.
   */
  private wrapDirty(s: DocState, dirty: Rect[]): Rect[] {
    const doc = s.scene.doc
    const w = tileWraps(doc?.tiled)
    if (!doc || (!w.x && !w.y)) return dirty
    const out: Rect[] = []
    for (const d of dirty) {
      // As wide as everywhere (an adjustment, a fill layer), or many periods: it reaches every tile already.
      if (d[2] - d[0] > 64 * doc.width || d[3] - d[1] > 64 * doc.height) {
        out.push(d)
        continue
      }
      const ks = (lo: number, hi: number, size: number, on: boolean) => {
        if (!on) return [0]
        const r: number[] = []
        for (let k = Math.floor(-hi / size); k * size < size - lo; k++) if (lo + k * size < size && hi + k * size > 0) r.push(k * size)
        return r.length ? r : [0]
      }
      for (const ky of ks(d[1], d[3], doc.height, w.y)) for (const kx of ks(d[0], d[2], doc.width, w.x)) out.push([d[0] + kx, d[1] + ky, d[2] + kx, d[3] + ky])
    }
    return out
  }

  /** Marks the display tiles a set of document regions touches as stale. */
  private markDirty(s: DocState, regions: Rect[]) {
    if (!regions.length) return
    const dirty = this.wrapDirty(s, regions)
    for (const [k, e] of s.display) {
      if (e.stale) continue
      const [lev, rest] = k.split(':')
      const [tx, ty] = rest.split(',').map(Number)
      const r = tileRect(Number(lev), tx, ty)
      if (dirty.some((d) => intersects(d, r as Rect))) e.stale = true
    }
  }

  // --- strokes -------------------------------------------------------------------

  setPenRing(r: PenRing) {
    this.ring = new RingReader(r)
  }

  /** What a stroke paints: a pixel layer, a mask, or the selection itself (Quick Mask). */
  private targetOf(s: DocState, start: StrokeStart): StrokeTarget | string {
    const doc = s.scene.doc
    if (!doc) return 'That document isn’t open any more.'
    if (start.node === SELECTION_NODE) return { set: doc.selection, transform: [1, 0, 0, 1, 0, 0], mode: 'gray', depth: 8 }
    const node = s.scene.node(start.node)
    if (!node) return 'That layer isn’t there any more.'
    if (node.kind === 'pixel') return { set: node.props.tiles, transform: node.transform, mode: doc.mode, depth: doc.depth }
    if (node.kind === 'mask' && node.props.source === 'pixel') return { set: node.props.tiles, transform: node.transform, mode: 'gray', depth: 8 }
    return 'Painting needs a pixel layer or a mask.'
  }

  /**
   * Finishes a retouching stroke (the Healing Brush, the Spot Healing
   * Brush) on the CPU from its dabs, in place of the bake: the engine's
   * (engine/retouchHost.ts), set by the worker.
   */
  finishRetouch: ((st: LiveStroke) => Promise<string | null>) | null = null

  /** Starts a stroke; says why not when it can't. */
  beginStroke(start: StrokeStart): string | null {
    const s = this.docs.get(start.key)
    if (!s) return 'That document isn’t open any more.'
    const target = this.targetOf(s, start)
    if (typeof target === 'string') return target
    const existing = this.strokeOn.get(`${start.key}|${start.node}`)
    if (existing) this.dropStroke(existing)
    // Confined to the selection: each stroke tile's share of it, in the target's pixels.
    const selection = start.selection && this.tiles.hasSet(start.selection) ? start.selection : null
    const reader = selection ? new CoverReader(this.tiles, selection) : null
    const sampler = reader ? (tx: number, ty: number) => coverForTile(reader, target.transform, tx, ty) : null
    const tables = target.mode === 'cmyk' && s.scene.doc ? cmykTablesFor(s.scene.doc.profile) : null
    const st = new LiveStroke(
      this.device,
      start,
      target,
      s.scene,
      sampler,
      () => {
        if (st.docBounds) this.markDirty(s, [st.docBounds])
        s.scene.setLive(start.node, st.docBounds)
        this.requestFrame()
      },
      tables,
      start.sampling?.tool === 'mixer' ? this.takeCarry() : null,
    )
    this.strokes.set(start.id, st)
    this.strokeOn.set(`${start.key}|${start.node}`, st)
    const early = this.early.get(start.id)
    this.early.clear()
    if (early) st.add(early)
    this.requestFrame()
    return null
  }

  addSamples(id: number, samples: PenSample[]) {
    const st = this.strokes.get(id)
    if (!st) {
      this.early.set(id, [...(this.early.get(id) ?? []), ...samples])
      return
    }
    if (st.result !== undefined) return
    st.add(samples)
    this.requestFrame()
  }

  private drainRing() {
    if (!this.ring) return
    const got = this.ring.drain()
    if (!got.length) return
    const by = new Map<number, PenSample[]>()
    for (const { stroke, sample } of got) {
      const list = by.get(stroke) ?? []
      list.push(sample)
      by.set(stroke, list)
    }
    for (const [id, list] of by) this.addSamples(id, list)
  }

  /** Whether a stroke is still taking samples: frames keep coming to read the ring. */
  get painting() {
    return [...this.strokes.values()].some((st) => st.result === undefined)
  }

  /** Stamps every stroke's new dabs into `enc`, and marks what they touched. */
  private stampStrokes(enc: GPUCommandEncoder) {
    for (const st of this.strokes.values()) {
      st.tick()
      if (!st.hasPending) continue
      this.tips ??= new TipBank(this.device)
      let dirty: ReturnType<LiveStroke['stamp']> = null
      try {
        const ds = this.docs.get(st.start.key)
        const composite =
          (st.start.sampling?.sampleAll || st.start.clone?.sampleAll) && ds?.scene.doc
            ? { format: this.bufferFormat(ds.scene.doc.mode, ds.scene.doc.depth), render: (e: GPUCommandEncoder, tx: number, ty: number) => this.renderTile(this.job(ds, 0, tx, ty, e)), release: (b: GPUBuffer) => this.pool.release(b) }
            : undefined
        dirty = st.stamp(enc, this.kernels, this.params, this.storage, this.tips, this.doomed, st.replaces ? this.residency(st.mode, st.depth) : undefined, composite)
      } catch (e) {
        // A sampling stroke reads the layer: a tile still on disk holds its next dab back a frame.
        if (!(e instanceof NotReady)) throw e
        void Promise.allSettled(e.waits).then(() => this.requestFrame())
        dirty = st.docBounds
      }
      const s = this.docs.get(st.start.key)
      if (!dirty || !s) continue
      s.scene.setLive(st.start.node, st.docBounds)
      // A warped layer shows a stroke somewhere else: wherever the layer is drawn.
      const shown = s.scene.warped(st.start.node) ? s.scene.bounds(st.start.node) : null
      // A filter layer above spreads the stroke as far as it reads.
      const g = s.scene.filterLayerReach()
      const r = shown ?? dirty
      this.markDirty(s, [g ? [r[0] - g, r[1] - g, r[2] + g, r[3] + g] : r])
      if (st.start.node === SELECTION_NODE) this.markSelection(s, [dirty])
    }
  }

  /**
   * Ends a stroke: its last dabs, then the bake into a new tile set, which
   * the page commits. The set is pinned until the document arrives with
   * it. Returns the set, or the layer's old one if nothing changed.
   */
  async endStroke(id: number): Promise<{ set: string | null; overflow: boolean }> {
    this.drainRing()
    const st = this.strokes.get(id)
    if (!st) throw new Error('That stroke isn’t being painted.')
    st.end()
    for (let tries = 0; ; tries++) {
      try {
        const enc = this.beginWork()
        try {
          this.stampStrokes(enc)
        } finally {
          this.finishWork(enc)
        }
        const set =
          st.start.retouch && this.finishRetouch
            ? await this.finishRetouch(st)
            : await bake(st, this.device, this.kernels, this.residency(st.mode, st.depth), this.tiles, {
                begin: () => this.beginWork(),
                finish: (e) => this.finishWork(e),
                params: this.params,
                storage: this.storage,
              })
        st.result = set
        if (set) this.pins.pin(set)
        const r = st.takeReservoir()
        if (r) {
          this.mixerCarry?.buffer.destroy()
          this.mixerCarry = r
        }
        this.requestFrame()
        return { set, overflow: st.overflow }
      } catch (e) {
        if (!(e instanceof NotReady) || tries > 50) {
          this.dropStroke(st)
          throw e
        }
        await Promise.allSettled(e.waits)
      }
    }
  }

  /** The Mixer's reservoir from its last stroke, handed to the next (which owns it from then). */
  private takeCarry(): Reservoir | null {
    const c = this.mixerCarry
    this.mixerCarry = null
    return c
  }

  /** Abandons a stroke: the layer shows as it was. */
  cancelStroke(id: number) {
    this.early.delete(id)
    const st = this.strokes.get(id)
    if (st) this.dropStroke(st)
  }

  private dropStroke(st: LiveStroke) {
    this.strokes.delete(st.start.id)
    if (this.strokeOn.get(`${st.start.key}|${st.start.node}`) === st) this.strokeOn.delete(`${st.start.key}|${st.start.node}`)
    const s = this.docs.get(st.start.key)
    if (s) {
      if (st.docBounds) this.markDirty(s, [st.docBounds])
      if (st.docBounds && st.start.node === SELECTION_NODE) this.markSelection(s, [st.docBounds])
      s.scene.setLive(st.start.node, null)
    }
    if (st.result) this.pins.unpin(st.result)
    this.doomed.push(...st.buffers())
    this.requestFrame()
  }

  /** Where the brush cursor is (document pixels, its diameter), or null to hide it. */
  setCursor(c: BrushCursor | null) {
    this.cursor = c
  }

  setView(key: string, v: View) {
    this.state(key).view = v
  }

  /** A document's look: its display tiles are drawn again through it. */
  setLook(key: string, l: DocLook) {
    const s = this.state(key)
    if (JSON.stringify(s.look) === JSON.stringify(l)) return
    s.look = l
    this.markAll(s)
  }

  /** A split view's second pane and where the cut is; null for one pane. */
  setSplit(key: string, second: View | null, split: number) {
    const s = this.state(key)
    s.second = second
    s.split = split
  }

  /** What the tools draw over a document. */
  setOverlay(key: string, o: Overlay) {
    this.state(key).overlay = o
  }

  /** Marks the selection's coverage tiles a set of regions touches as stale. */
  private markSelection(s: DocState, dirty: Rect[]) {
    for (const [k, e] of s.sel) {
      if (e.stale) continue
      const [lev, rest] = k.split(':')
      const [tx, ty] = rest.split(',').map(Number)
      if (dirty.some((d) => intersects(d, tileRect(Number(lev), tx, ty) as Rect))) e.stale = true
    }
  }

  private dropSelection(key: string, s: DocState) {
    for (const k of s.sel.keys()) this.selAtlas.drop(`${key}|${k}`)
    s.sel.clear()
  }

  setFront(key: string | null) {
    this.front = key
  }

  close(key: string) {
    const s = this.docs.get(key)
    if (!s) return
    for (const st of [...this.strokes.values()]) if (st.start.key === key) this.dropStroke(st)
    this.dropDisplay(key, s)
    this.graph.forget(key)
    s.lut?.buffer.destroy()
    s.lut?.params.destroy()
    this.dropSelection(key, s)
    for (const k of [...this.subs.keys()]) if (k.startsWith(`${key}/`)) this.subs.delete(k)
    this.docs.delete(key)
  }

  /** Tile sets nobody holds any more: their mips can go. */
  forgetSets(live: ReadonlySet<string>) {
    for (const r of this.residencies.values()) r.forget(live)
  }

  private markAll(s: DocState) {
    for (const e of s.display.values()) e.stale = true
  }

  private dropDisplay(key: string, s: DocState) {
    for (const k of s.display.keys()) this.displayAtlas.drop(`${key}|${k}`)
    s.display.clear()
  }

  // --- pieces -------------------------------------------------------------------

  residency(mode: ColourMode, depth: Depth): Residency {
    const k = `${mode}/${depth}`
    let r = this.residencies.get(k)
    if (!r) {
      r = new Residency(this.device, this.tiles, this.kernels, this.params, mode, depth, TILE_BUDGET, () => this.encoder)
      this.residencies.set(k, r)
    }
    return r
  }

  bufferFormat(mode: ColourMode, depth: Depth): BufferFormat {
    return { mode, store: depth === 8 ? this.store8 : 'f32' }
  }

  /** The document's display table on the GPU, for `target` (the display, or sRGB for files). */
  lutBuffers(s: DocState, target: DisplayProfileId, canvas = false): { buffer: GPUBuffer; params: GPUBuffer; lut: Lut } | null {
    const doc = s.scene.doc!
    // Only the canvas is proofed: files and thumbnails are the document as it is.
    const screen = canvas && target === this.display
    const got = lutFor(doc.mode, doc.profile, target, screen ? s.look : null)
    if (!got) {
      void colour().then(() => this.requestFrame())
      return null
    }
    const look = screen ? lookOf(s.look, doc.mode) : PLAIN_LOOK
    const key = `${got.key}#${JSON.stringify(look)}`
    if (screen && s.lut?.key === key) return { buffer: s.lut.buffer, params: s.lut.params, lut: got.lut }
    // Thumbnails, previews and exports share a few tables, kept rather than made each time.
    const kept = screen ? undefined : this.offscreenLuts.get(key)
    if (kept) {
      this.offscreenLuts.delete(key)
      this.offscreenLuts.set(key, kept)
      return { ...kept, lut: got.lut }
    }
    const buffer = this.device.createBuffer({ label: 'display table', size: got.lut.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(buffer, 0, got.lut.data as Float32Array<ArrayBuffer>)
    const params = this.device.createBuffer({ label: 'display table params', size: LUT_PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(params, 0, writeLutParams(got.lut, look))
    if (screen) {
      s.lut?.buffer.destroy()
      s.lut?.params.destroy()
      s.lut = { key, buffer, params }
    } else {
      this.offscreenLuts.set(key, { buffer, params })
      while (this.offscreenLuts.size > 6) {
        const [k, old] = this.offscreenLuts.entries().next().value!
        this.offscreenLuts.delete(k)
        // Encoded work may still use it: gone once this frame's queue is done.
        this.doomed.push(old.buffer, old.params)
      }
    }
    return { buffer, params, lut: got.lut }
  }

  docState(key: string) {
    return this.docs.get(key) ?? null
  }

  /** A job for one tile of a document, encoded into `enc`. */
  job(s: DocState, level: number, tx: number, ty: number, enc: GPUCommandEncoder): TileJob {
    const doc = s.scene.doc!
    return {
      scene: s.scene,
      level,
      tx,
      ty,
      rect: tileRect(level, tx, ty) as Rect,
      enc,
      format: this.bufferFormat(doc.mode, doc.depth),
      residency: this.residency(doc.mode, doc.depth),
      masks: this.residency('gray', 8),
    }
  }

  renderTile(job: TileJob): GPUBuffer | null {
    return this.graph.renderTile(job)
  }

  /** A node's own content alone, for Rasterize. */
  renderContentTile(job: TileJob, id: string): GPUBuffer | null {
    return this.graph.renderContent(job, id)
  }

  /** One node on its own, at full strength, for its thumbnail. */
  renderNodeTile(job: TileJob, id: string): GPUBuffer | null {
    return this.graph.renderNode(job, id)
  }

  /** Encodes a composite tile's conversion into a display atlas slot. */
  private toDisplay(enc: GPUCommandEncoder, f: BufferFormat, lut: { buffer: GPUBuffer; params: GPUBuffer }, src: GPUBuffer, slot: number) {
    const p = this.kernels.displayPipelines(f).tile
    const pass = enc.beginComputePass({ label: 'to display' })
    pass.setPipeline(p)
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: lut.params } },
          { binding: 1, resource: { buffer: src } },
          { binding: 2, resource: { buffer: lut.buffer } },
          { binding: 3, resource: this.displayAtlas.textures[0].createView({ dimension: '2d', baseArrayLayer: slot, arrayLayerCount: 1 }) },
        ],
      }),
    )
    pass.dispatchWorkgroups(TILE / 16, TILE / 16)
    pass.end()
  }

  /** Encodes a composite tile's conversion into straight 8-bit RGBA, into `out` at `offset`. */
  toBytes(enc: GPUCommandEncoder, f: BufferFormat, lut: { buffer: GPUBuffer; params: GPUBuffer }, src: GPUBuffer, out: GPUBuffer) {
    const p = this.kernels.displayPipelines(f).bytes
    const pass = enc.beginComputePass({ label: 'to bytes' })
    pass.setPipeline(p)
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: lut.params } },
          { binding: 1, resource: { buffer: src } },
          { binding: 2, resource: { buffer: lut.buffer } },
          { binding: 4, resource: { buffer: out } },
        ],
      }),
    )
    pass.dispatchWorkgroups(TILE / 16, TILE / 16)
    pass.end()
  }

  get kernelSet() {
    return this.kernels
  }

  get bufferPool() {
    return this.pool
  }

  /** Starts a frame's worth of encoding for a call outside the frame loop (thumbnails, exports, checks). */
  beginWork(): GPUCommandEncoder {
    this.params.reset()
    this.storage.reset()
    for (const r of this.residencies.values()) r.atlas.beginFrame()
    this.encoder = this.device.createCommandEncoder({ label: 'work' })
    return this.encoder
  }

  finishWork(enc: GPUCommandEncoder) {
    this.encoder = null
    this.device.queue.submit([enc.finish()])
    this.afterSubmit()
  }

  private afterSubmit() {
    for (const r of this.residencies.values()) r.atlas.afterSubmit()
    this.displayAtlas.afterSubmit()
    this.selAtlas.afterSubmit()
    for (const b of this.doomed.splice(0)) b.destroy()
  }

  // --- the frame ------------------------------------------------------------------

  /** Draws a frame, if the previous one has finished on the GPU. Returns what it did, or null if it waited. */
  draw(): FrameInfo | null {
    if (this.inFlight >= 2) return null
    const t0 = performance.now()
    const s = this.front ? this.docs.get(this.front) : undefined
    this.params.reset()
    this.storage.reset()
    for (const r of this.residencies.values()) r.atlas.beginFrame()
    this.displayAtlas.beginFrame()
    this.selAtlas.beginFrame()
    const enc = this.device.createCommandEncoder({ label: 'frame' })
    this.encoder = enc
    this.drainRing()
    this.stampStrokes(enc)

    let rendered = 0
    let pending = 0
    let level: number | null = null
    // Each pane on screen (two in a split view), with the levels and tiles it shows.
    const shown: ShownPane[] = []
    const lut = s?.scene.doc && s.view ? this.lutBuffers(s, this.display, true) : null
    if (s && s.view && s.scene.doc && lut) {
      const doc = s.scene.doc
      const top = Math.max(0, Math.ceil(Math.log2(Math.max(doc.width, doc.height) / TILE)))
      for (const { view, pane } of this.panesOf(s)) {
        const pc = paneCanvas(this.canvas, pane)
        const lev = mipLevel(view.zoom, this.canvas.dpr)
        const levels = [0, 1, 2]
          .map((j) => Math.min(lev + j, Math.max(lev, top)))
          .filter((l, i, a) => a.indexOf(l) === i)
          .map((l) => ({ level: l, tiles: visibleTiles(view, pc, l, doc.width, doc.height, this.wrapOf(s)) }))
        shown.push({ view, pane, levels })
        level ??= lev
      }
      // What's on screen now stays put while new tiles take slots.
      for (const p of shown) for (const { level: l, tiles } of p.levels) for (const [x, y] of tiles) this.displayAtlas.get(`${this.front}|${l}:${x},${y}`)

      // The coarsest level first where it's missing, for a quick whole
      // picture; then the level being shown, missing or stale; pane by pane.
      const work: [number, number, number][] = []
      const queued = new Set<string>()
      const want = (l: number, x: number, y: number) => {
        const k = `${l}:${x},${y}`
        if (queued.has(k)) return
        queued.add(k)
        work.push([l, x, y])
      }
      for (const p of shown) {
        const coarse = p.levels[p.levels.length - 1]
        if (coarse.level !== p.levels[0].level) for (const [x, y] of coarse.tiles) if (!s.display.has(`${coarse.level}:${x},${y}`)) want(coarse.level, x, y)
      }
      for (const p of shown) {
        for (const [x, y] of p.levels[0].tiles) {
          const e = s.display.get(`${p.levels[0].level}:${x},${y}`)
          if (!e || e.stale) want(p.levels[0].level, x, y)
        }
      }
      const format = this.bufferFormat(doc.mode, doc.depth)
      const waits: Promise<void>[] = []
      for (const [l, x, y] of work) {
        if (performance.now() - t0 > FRAME_BUDGET_MS || this.params.used > 0.5 || this.storage.used > 0.5) {
          pending++
          continue
        }
        try {
          const buf = this.renderTile(this.job(s, l, x, y, enc))
          const key = `${l}:${x},${y}`
          const old = s.display.get(key)
          if (!buf) {
            if (old && old.slot >= 0) this.displayAtlas.drop(`${this.front}|${key}`)
            s.display.set(key, { slot: -2, stale: false })
          } else {
            const slot = old && old.slot >= 0 ? old.slot : this.displayAtlas.alloc(`${this.front}|${key}`)
            if (slot === null) {
              this.pool.release(buf)
              pending++
              break
            }
            this.toDisplay(enc, format, lut, buf, slot)
            this.pool.release(buf)
            s.display.set(key, { slot, stale: false })
          }
          rendered++
        } catch (e) {
          pending++
          if (e instanceof NotReady) waits.push(...e.waits)
          else if (e instanceof AtlasFull || e instanceof RingFull) break
          else throw e
        }
      }
      for (const p of shown) pending += this.renderSelection(s, p.levels[0], enc, t0, waits)
      if (waits.length) void Promise.allSettled(waits).then(() => this.requestFrame())
    }

    this.drawScreen(enc, s, shown)
    this.encoder = null
    this.device.queue.submit([enc.finish()])
    this.afterSubmit()
    this.inFlight++
    void this.device.queue.onSubmittedWorkDone().then(() => {
      this.inFlight--
      if (pending || this.painting) this.requestFrame()
    })
    // The ants crawl while they show.
    if (s && this.antsShowing(s) && !this.antsTimer) {
      this.antsTimer = setTimeout(() => {
        this.antsTimer = null
        this.requestFrame()
      }, ANTS_MS)
    }
    this.stats.tiles += rendered
    this.stats.dispatches = this.graph.dispatches
    this.stats.uploads = [...this.residencies.values()].reduce((a, r) => a + r.uploads, 0)
    this.stats.mips = [...this.residencies.values()].reduce((a, r) => a + r.mipsBuilt, 0)
    return { rendered, pending, ms: performance.now() - t0, level }
  }

  /** Where the view repeats a document: a tiled one, while Tiled View is on. */
  private wrapOf(s: DocState): { x: boolean; y: boolean } {
    const w = tileWraps(s.scene.doc?.tiled)
    const on = s.overlay.tiledView !== false
    return { x: on && w.x, y: on && w.y }
  }

  /** The panes a document is shown in: its view across the canvas, or two side by side in a split view. */
  private panesOf(s: DocState): { view: View; pane: Pane }[] {
    if (!s.view) return []
    const split = s.second ? s.split : null
    const rects = paneRects(this.canvas, split)
    return split === null || !s.second ? [{ view: s.view, pane: rects[0] }] : [{ view: s.view, pane: rects[0] }, { view: s.second, pane: rects[1] }]
  }

  /** Whether marching ants are on screen, so frames keep coming to crawl them. */
  private antsShowing(s: DocState): boolean {
    if (s.overlay.shapes.some((o) => o.kind === 'path' && o.style === 'ants')) return true
    return !!s.scene.doc?.selection && !s.overlay.quickMask && !s.overlay.hideAnts
  }

  /**
   * The selection's coverage for the tiles on screen at the level shown,
   * into its atlas: for the ants, and for Quick Mask's tint. Within the
   * frame's budget; returns how many tiles are left for later.
   */
  private renderSelection(s: DocState, lv: { level: number; tiles: [number, number][] } | undefined, enc: GPUCommandEncoder, t0: number, waits: Promise<void>[]): number {
    const doc = s.scene.doc!
    const painting = this.strokeOn.has(`${s.scene.key}|${SELECTION_NODE}`)
    if (!lv || (!doc.selection && !painting && !s.overlay.quickMask)) return 0
    const mask: MaskLike = { id: SELECTION_NODE, transform: [1, 0, 0, 1, 0, 0], props: { tiles: doc.selection, outside: 0, invert: false, density: 1, feather: 0 } }
    let pending = 0
    for (const [x, y] of lv.tiles) {
      const key = `${lv.level}:${x},${y}`
      const atlasKey = `${s.scene.key}|${key}`
      const e = s.sel.get(key)
      if (e && e.slot >= 0) this.selAtlas.get(atlasKey)
      if (e && !e.stale) continue
      if (performance.now() - t0 > FRAME_BUDGET_MS || this.params.used > 0.5 || this.storage.used > 0.5) {
        pending++
        continue
      }
      try {
        const r = this.graph.coverOf(this.job(s, lv.level, x, y, enc), mask, null)
        if (typeof r === 'number' && (r <= 0 || r >= 1)) {
          if (e && e.slot >= 0) this.selAtlas.drop(atlasKey)
          s.sel.set(key, { slot: r <= 0 ? -2 : -3, stale: false })
          continue
        }
        const slot = e && e.slot >= 0 ? e.slot : this.selAtlas.alloc(atlasKey)
        if (slot === null) {
          if (typeof r !== 'number') this.graph.release(r)
          pending++
          break
        }
        const src = typeof r === 'number' ? this.storage.put(new Float32Array(TILE * TILE).fill(r)) : { buffer: r, offset: 0 }
        enc.copyBufferToTexture({ buffer: src.buffer, offset: src.offset, bytesPerRow: TILE * 4 }, { texture: this.selAtlas.textures[0], origin: [0, 0, slot] }, [TILE, TILE, 1])
        if (typeof r !== 'number') this.graph.release(r)
        s.sel.set(key, { slot, stale: false })
      } catch (err) {
        pending++
        if (err instanceof NotReady) waits.push(...err.waits)
        else if (err instanceof AtlasFull || err instanceof RingFull) break
        else throw err
      }
    }
    return pending
  }

  /** Whether a frame was skipped because the GPU was still busy with the last two. */
  get busy() {
    return this.inFlight >= 2
  }

  private drawScreen(enc: GPUCommandEncoder, s: DocState | undefined, shown: ShownPane[]) {
    const pass = enc.beginRenderPass({
      label: 'screen',
      colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    })
    // With nothing to show, the pasteboard alone, across the canvas.
    const panes: (ShownPane | null)[] = shown.length ? shown : [null]
    for (const p of panes) {
      const rect = p?.pane ?? { x: 0, width: this.canvas.width }
      pass.setScissorRect(rect.x, 0, Math.max(1, Math.min(rect.width, this.canvas.width - rect.x)), this.canvas.height)
      this.drawPane(pass, s, p)
    }
    pass.end()
  }

  /** One pane of the screen: the document through its view, then the overlay. */
  private drawPane(pass: GPURenderPassEncoder, s: DocState | undefined, shownPane: ShownPane | null) {
    const levels = shownPane?.levels ?? []
    const u = new ArrayBuffer(SCREEN_BYTES)
    const f = new Float32Array(u)
    const i = new Int32Array(u)
    const w = new Uint32Array(u)
    const pb = this.display === 'srgb' ? this.pasteboard : themeIn(this.pasteboard, this.display)
    f.set([...pb, 1], 0)
    f.set([...themeIn(CHECK_A, this.display), 1], 4)
    f.set([...themeIn(CHECK_B, this.display), 1], 8)
    const map: number[] = []
    const selMap: number[] = []
    let overlay: Float32Array | null = null
    let overlayColours: OverlayView['colours'] | null = null
    const time = Math.floor(performance.now() / ANTS_MS) % 8
    if (shownPane && s?.scene.doc && levels.length) {
      const doc = s.scene.doc
      const view = shownPane.view
      const pane = shownPane.pane
      const vm = paneMatrix(view, this.canvas, pane)
      const inv = invert(vm)
      const origin = applyM(vm, 0, 0)
      const sl = view.zoom * this.canvas.dpr * 2 ** levels[0].level
      const nearest = sl >= 1 - 1e-9 && (view.rotation === 0 || sl >= 2)
      f.set([Math.max(1, Math.round(CHECK * this.canvas.dpr)), origin[0], origin[1], nearest ? 1 : 0], 12)
      // The brush cursor: a ring for a round tip, otherwise the tip's outline, drawn as overlay lines.
      const cursorShapes: OverlayShape[] = []
      if (this.cursor && this.cursor.key === this.front) {
        const [cx, cy] = applyM(vm, this.cursor.x, this.cursor.y)
        if (this.cursor.loops?.length) for (const loop of this.cursor.loops) cursorShapes.push({ kind: 'path', points: loop, closed: true, style: 'line' })
        else f.set([cx, cy, (this.cursor.size / 2) * view.zoom * this.canvas.dpr, 1], 20)
      }
      const o = s.overlay
      const showSel = (!!doc.selection || o.quickMask || this.strokeOn.has(`${s.scene.key}|${SELECTION_NODE}`)) && (o.quickMask || !o.hideAnts)
      const shade = o.shade && o.shade.length === 4 ? o.shade.map(([x, y]) => applyM(vm, x, y)) : null
      f.set([showSel ? 1 : 0, o.quickMask ? 1 : 0, time, shade ? 1 : 0], 24)
      if (shade) f.set(shade.flat(), 28)
      if (o.shapes.length || cursorShapes.length || o.view) overlay = tessellate([...o.shapes, ...cursorShapes], vm, this.canvas.dpr, { width: pane.width, height: this.canvas.height, x: pane.x }, o.view ?? null)
      if (o.view) overlayColours = o.view.colours
      const wrap = this.wrapOf(s)
      f.set([wrap.x ? 1 : 0, wrap.y ? 1 : 0, 0, 0], 36)
      levels.forEach(({ level, tiles }, j) => {
        const span = 2 ** level
        const xs = tiles.map((t) => t[0])
        const ys = tiles.map((t) => t[1])
        const gx = xs.length ? Math.min(...xs) : 0
        const gy = ys.length ? Math.min(...ys) : 0
        const cols = xs.length ? Math.max(...xs) - gx + 1 : 0
        const rows = ys.length ? Math.max(...ys) - gy + 1 : 0
        // Device pixels to this level's pixels, relative to the grid's corner.
        const m: Matrix = multiply([1 / span, 0, 0, 1 / span, -gx * TILE, -gy * TILE], inv)
        const base = 40 + j * 20
        f.set([m[0], m[1], m[2], m[3]], base)
        f.set([m[4], m[5], 0, 0], base + 4)
        i.set([gx, gy, cols, rows], base + 8)
        w.set([map.length, Math.ceil(doc.width / (TILE * span)), Math.ceil(doc.height / (TILE * span)), 1], base + 12)
        i.set([Math.ceil(doc.width / span), Math.ceil(doc.height / span), wrap.x ? 1 : 0, wrap.y ? 1 : 0], base + 16)
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            const e = s.display.get(`${level}:${gx + x},${gy + y}`)
            map.push(e ? e.slot : -1)
            if (j === 0) selMap.push(s.sel.get(`${level}:${gx + x},${gy + y}`)?.slot ?? -1)
          }
        }
        if (j === 0) f.set([-gx * TILE, -gy * TILE, doc.width / span - gx * TILE, doc.height / span - gy * TILE], 16)
      })
    }
    if (!map.length) map.push(-1)
    if (!selMap.length) selMap.push(-1)
    const pipeline = this.kernels.screen()
    const pu = this.params.put(u)
    const pm = this.storage.put(new Int32Array(map))
    const ps = this.storage.put(new Int32Array(selMap))
    pass.setPipeline(pipeline)
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: pu.buffer, offset: pu.offset, size: SCREEN_BYTES } },
          { binding: 1, resource: { buffer: pm.buffer, offset: pm.offset, size: pm.size } },
          { binding: 2, resource: this.displayAtlas.textures[0].createView({ dimension: '2d-array' }) },
          { binding: 3, resource: { buffer: ps.buffer, offset: ps.offset, size: ps.size } },
          { binding: 4, resource: this.selAtlas.textures[0].createView({ dimension: '2d-array' }) },
        ],
      }),
    )
    pass.draw(3)
    if (overlay && overlay.length) {
      const op = this.kernels.overlayPipeline()
      const pv = this.storage.put(overlay)
      const c = overlayColours ?? { guide: [0, 1, 1], smart: [1, 0.2, 0.8], grid: [0.5, 0.5, 0.5] }
      const po = this.params.put(new Float32Array([this.canvas.width, this.canvas.height, time, 0, ...c.guide, 1, ...c.smart, 1, ...c.grid, 1]))
      pass.setPipeline(op)
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: op.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: po.buffer, offset: po.offset, size: OVERLAY_PARAMS_BYTES } },
            { binding: 1, resource: { buffer: pv.buffer, offset: pv.offset, size: pv.size } },
          ],
        }),
      )
      pass.draw(overlay.length / VERTEX_FLOATS)
    }
  }

  /** Numbers for Help → Graphics Information and the bench. */
  gpuStats() {
    return {
      tileAtlasBytes: [...this.residencies.values()].reduce((a, r) => a + r.atlas.bytes, 0),
      tileAtlasUsed: [...this.residencies.values()].reduce((a, r) => a + r.atlas.used, 0),
      displayAtlasBytes: this.displayAtlas.bytes,
      displayTiles: this.displayAtlas.used,
      groupCacheBytes: this.graph.cachedBytes,
      store8: this.store8,
      ...this.stats,
    }
  }
}

/** A pane on screen this frame: its view, where it is, and the levels and tiles it shows. */
interface ShownPane {
  view: View
  pane: Pane
  levels: { level: number; tiles: [number, number][] }[]
}

export class RingFull extends Error {}

/** A theme colour (sRGB) as the display shows it. */
function themeIn(rgb: Rgb, display: DisplayProfileId): Rgb {
  if (display === 'srgb' || !colourNow()) return rgb
  return themeCache.get(`${rgb.join()}|${display}`) ?? cacheTheme(rgb, display)
}
const themeCache = new Map<string, Rgb>()
function cacheTheme(rgb: Rgb, display: DisplayProfileId): Rgb {
  const c = colourNow()!
  const t = c.cms.transform(c.registry.builtin('srgb'), c.registry.builtin(display), 'relative', 0)
  try {
    const out = t.one(rgb) as Rgb
    themeCache.set(`${rgb.join()}|${display}`, out)
    return out
  } finally {
    t.close()
  }
}

/** The display pass's part of a document's look (color/lut.ts). */
export function lookOf(l: DocLook, mode: ColourMode): Look {
  const cmyk = mode === 'cmyk'
  return {
    ...PLAIN_LOOK,
    inks: cmyk ? l.inks : [true, true, true, true],
    gamut: l.gamut,
    inkLimit: cmyk && l.inkWarning ? l.inkLimit / 100 : 0,
  }
}
