/**
 * Strokes being painted, in the engine worker (ARCHITECTURE.md,
 * "Painting").
 *
 * A stroke runs here from first sample to last: the brush engine
 * (brush/stroke.ts) turns samples into dabs, each frame's new dabs are
 * mapped into the layer's own pixels and stamped by the GPU into stroke
 * tiles (one per layer tile the stroke reaches, in a growing storage
 * buffer), and the render graph lays the stroke onto the layer as it reads
 * it, so the canvas shows it at once at any zoom or angle. The layer's
 * tiles aren't touched until the pen lifts.
 *
 * Then `finish` bakes: each touched tile, with the stroke laid on, read
 * back at the document's depth and made into new tiles, and a new tile set
 * derived from the layer's old one that shares every tile the stroke
 * didn't touch. The page commits that set as one history step. The stroke
 * stays on screen until the document arrives with the new set, so nothing
 * flickers in between.
 */
import { colourVaries, type BrushSettings, type TipId } from '../brush/defs'
import { dabColour } from '../brush/colour'
import { toLayer, wrapDab, type Dab, type LayerDab } from '../brush/dab'
import { StrokeBuilder, type PenSample } from '../brush/stroke'
import { TEXTURE_MODE_INDEX, textureImage } from '../brush/textures'
import { packTips, tipImage, type TipImage } from '../brush/tips'
import type { CmykTables } from '../color/cmykAdjust'
import { tileWraps, type ColourMode, type Depth } from '../doc/types'
import { DUAL_INDEX, colourOffset, layoutOf, strokeStride, type StrokeLayout } from './ref/paint'
import { COLOUR_CHANNELS, TILE, TILE_PIXELS, newSamples, planesOf, type Samples, type TileFormat } from '../tiles/format'
import type { TileId, TileStore } from '../tiles/store'
import type { Kernels, Ring } from './gpu/kernels'
import { NotReady, type Residency } from './residency'
import { transformRect, union, type Rect, type Scene } from './scene'
import { DAB_FLOATS, STAMP_PARAMS_BYTES } from './shaders/paint'
import { DEPOSIT_PARAMS_BYTES, PICK_ALL_PARAMS_BYTES, PICK_PARAMS_BYTES } from './shaders/sample'
import { CLONE_PARAMS_BYTES, writeCloneParams } from './shaders/clone'
import { foldedTiles } from './view'
import { tileBufferBytes, type BufferFormat } from './shaders/common'
import { MIXER_PICK, PATCH } from './ref/sample'
import { PARAMS_BYTES, writeParams } from './shaders/composite'
import { blendIndex } from './blendModes'

export interface StrokeStart {
  id: number
  key: string
  /** The node painted: a pixel layer, a mask, or SELECTION_NODE for Quick Mask. */
  node: string
  settings: BrushSettings
  eraser: boolean
  seed: number
  /** The foreground and background in the document's own terms, 0..1 per channel. */
  fg: number[]
  bg: number[]
  /** The selection the stroke is confined to (its coverage multiplies the stroke's), or none. */
  selection?: string | null
  /** Smudge or the Mixer Brush: the brush picks paint up from the canvas (render/ref/sample.ts). */
  sampling?: StrokeSampling
  /**
   * The Clone Stamp (and the Healing Brush as it's painted): each dab lays
   * on the source at `offset` from it (document pixels: the source is
   * where the dab is plus the offset), from the layer as the stroke found
   * it or, with `sampleAll`, from the document as it shows.
   */
  clone?: { offset: [number, number]; sampleAll: boolean }
  /**
   * A retouching stroke finished on the CPU when the pen lifts, from the
   * dabs it placed (engine/retouchHost.ts): healed (the Healing Brush) or
   * filled from round it (the Spot Healing Brush). What's painted until
   * then is a preview.
   */
  retouch?: 'heal' | 'spot'
}

export interface StrokeSampling {
  tool: 'smudge' | 'mixer'
  strength: number
  fingerPainting: boolean
  wet: number
  load: number
  mix: number
  /** The Mixer's reservoir: loaded with this colour (the document's own terms), clean (null), or as the last stroke left it. */
  reservoir: number[] | null | 'keep'
  sampleAll: boolean
}

/** The document as it shows, one composite tile at a time, for Sample All Layers: the renderer's. */
export interface CompositeSource {
  format: BufferFormat
  /** Document tile (tx, ty) rendered into a pooled buffer, encoded in `enc`; null when nothing's there. */
  render(enc: GPUCommandEncoder, tx: number, ty: number): GPUBuffer | null
  release(b: GPUBuffer): void
}

/** What the Mixer's reservoir held when a stroke ended, for the next stroke to carry on with. */
export interface Reservoir {
  buffer: GPUBuffer
  amount: number
  channels: number
}

/** The node id a stroke paints when it paints the selection itself, in Quick Mask. */
export const SELECTION_NODE = '#selection'

/** What a stroke paints: a tile set in a format, through a transform. */
export interface StrokeTarget {
  set: string | null
  transform: number[]
  mode: ColourMode
  depth: Depth
}

/**
 * Coverage of the selection for a layer tile, in the layer's pixels: what
 * the stroke's coverage is multiplied by there. The renderer reads it from
 * the tile store.
 */
export type SelectionSampler = (tx: number, ty: number) => Promise<Float32Array>

/** Most stroke tiles one stroke may hold: about 256 MB of coverage. */
const MAX_TILES = 1024


/**
 * The brush tips on the GPU: every tip any stroke has used, packed into one
 * buffer of levels and a table, grown (and the old buffers let go after the
 * frame) when a stroke brings a new one.
 */
export class TipBank {
  private ids: TipId[] = []
  private images: TipImage[] = []
  data: GPUBuffer
  table: GPUBuffer

  constructor(private device: GPUDevice) {
    for (const t of ['chalk', 'spatter', 'bristle']) {
      this.ids.push(t)
      this.images.push(tipImage(t)!)
    }
    const { data, table } = this.upload()
    this.data = data
    this.table = table
  }

  private upload() {
    const { table, data } = packTips(this.images)
    const d = this.device.createBuffer({ label: 'brush tips', size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(d, 0, data as Float32Array<ArrayBuffer>)
    const t = this.device.createBuffer({ label: 'brush tip table', size: table.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(t, 0, table as Uint32Array<ArrayBuffer>)
    return { data: d, table: t }
  }

  /** A tip's index on the GPU (−1 for the round tip), uploading it the first time; null if it isn't known here. */
  index(id: TipId, doomed: GPUBuffer[]): number | null {
    if (id === 'round') return -1
    const have = this.ids.indexOf(id)
    if (have >= 0) return have
    const img = tipImage(id)
    if (!img) return null
    this.ids.push(id)
    this.images.push(img)
    doomed.push(this.data, this.table)
    const { data, table } = this.upload()
    this.data = data
    this.table = table
    return this.ids.length - 1
  }
}

export class LiveStroke {
  /** Stroke tile slot by layer tile, `x,y`. */
  tiles = new Map<string, number>()
  buffer: GPUBuffer
  capacity: number
  /** What a stroke pixel holds (ref/paint.ts): coverage, the main and dual coverage kept apart, colour. */
  readonly layout: StrokeLayout
  /** Floats per stroke pixel. */
  readonly stride: number
  readonly channels: number
  /** The paper, when the brush has a texture. */
  private texture: GPUBuffer | null = null
  private textureWidth = 1
  /** For Build-up: the last sample's time, and when (here) it came. */
  private lastSampleT = 0
  private lastSampleAt = 0
  /** The layer's tiles as the stroke began; null for a layer with none. */
  readonly base: string | null
  readonly transform: number[]
  private builder: StrokeBuilder
  /**
   * Dabs placed and not stamped yet. In a tiled document a sampling stroke's
   * dab carries its copies: it picks up once, where it is in the document,
   * and puts that paint down at each copy.
   */
  private pending: (LayerDab & { copies?: LayerDab[] })[] = []
  /** Whether the document repeats across and down: dabs over an edge are stamped at the other side too. */
  private wrap: { x: boolean; y: boolean } = { x: false, y: false }
  /** A retouching stroke's dabs, every one placed (copies too), in the layer's pixels: what's healed when the pen lifts. */
  readonly placed: LayerDab[] = []

  /** Whether the stroke's pixels are a sampling stroke's (how far towards a paint, and the paint): Smudge, the Mixer, the Clone Stamp. */
  get replaces(): boolean {
    return !!this.start.sampling || !!this.start.clone
  }
  /** Where the stroke reaches, in document pixels. */
  docBounds: Rect | null = null
  /** The set it baked into, once the pen has lifted. */
  result: string | null | undefined = undefined
  /** Dabs that fell past the stroke-tile limit and weren't painted. */
  overflow = false
  /** Working-space straight colours: the stroke's, or each dab's mix of foreground and background. */
  private fg: number[]
  private bg: number[]
  readonly mode: ColourMode
  readonly depth: Depth
  /** The selection's coverage per stroke tile slot, when the stroke is confined to one. */
  selBuffer: GPUBuffer | null = null
  /** A sampling stroke's carried paint and reservoir (PATCH² texels, channels + 1 floats each), and how full the reservoir is. */
  private carried: GPUBuffer | null = null
  private reservoir: GPUBuffer | null = null
  amount = 0
  private picked = false
  private selWrites = new Set<Promise<void>>()

  constructor(
    private device: GPUDevice,
    readonly start: StrokeStart,
    target: StrokeTarget,
    readonly scene: Scene,
    private sel: SelectionSampler | null = null,
    private onSelection: () => void = () => {},
    /** The CMYK profile's tables, for colour jitter through the profile. */
    private tables: CmykTables | null = null,
    /** The Mixer's reservoir from the last stroke, for one that keeps it. */
    carry: Reservoir | null = null,
  ) {
    this.mode = target.mode
    this.depth = target.depth
    this.channels = COLOUR_CHANNELS[this.mode]
    const b = start.settings
    const varies = !start.eraser && colourVaries(b)
    this.layout = layoutOf(b, varies, this.channels)
    // A sampling stroke's pixel: how far the layer goes towards its paint, the paint premultiplied, its alpha.
    this.stride = start.sampling || start.clone ? this.channels + 2 : strokeStride(this.layout)
    if (b.texture) {
      const img = textureImage(b.texture.id) ?? textureImage('paper')!
      this.textureWidth = img.width
      this.texture = device.createBuffer({ label: 'brush texture', size: img.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(this.texture, 0, img.data as Float32Array<ArrayBuffer>)
    }
    this.base = target.set
    this.transform = [...target.transform]
    this.wrap = tileWraps(scene.doc?.tiled)
    this.builder = new StrokeBuilder(start.settings, start.seed)
    const work = (v: number[]) => (this.mode === 'cmyk' ? v.map((x) => 1 - x) : v)
    this.fg = work(start.fg)
    this.bg = work(start.bg)
    this.capacity = 16
    this.buffer = this.makeBuffer(this.capacity)
    if (sel) this.selBuffer = this.makeSelBuffer(this.capacity)
    if (start.sampling) {
      const bytes = PATCH * PATCH * (this.channels + 1) * 4
      const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
      this.carried = device.createBuffer({ label: 'carried paint', size: bytes, usage })
      const keep = start.sampling.reservoir === 'keep' && carry && carry.channels === this.channels ? carry : null
      if (keep) {
        this.reservoir = keep.buffer
        this.amount = keep.amount
      } else {
        carry?.buffer.destroy()
        this.reservoir = device.createBuffer({ label: 'mixer reservoir', size: bytes, usage })
        const r = start.sampling.reservoir
        if (Array.isArray(r)) {
          // Loaded: the colour, opaque, in every texel.
          const w = this.mode === 'cmyk' ? r.map((x) => 1 - x) : r
          const texel = [...w.slice(0, this.channels), 1]
          const data = new Float32Array(PATCH * PATCH * (this.channels + 1))
          for (let i = 0; i < PATCH * PATCH; i++) data.set(texel, i * texel.length)
          device.queue.writeBuffer(this.reservoir, 0, data as Float32Array<ArrayBuffer>)
          this.amount = 1
        }
      }
    }
  }

  /** The Mixer's reservoir as the stroke leaves it, handed on; the stroke no longer owns it. */
  takeReservoir(): Reservoir | null {
    if (!this.reservoir || this.start.sampling?.tool !== 'mixer') return null
    const r = { buffer: this.reservoir, amount: this.amount, channels: this.channels }
    this.reservoir = null
    return r
  }

  private makeSelBuffer(tiles: number) {
    return this.device.createBuffer({ label: 'stroke selection', size: tiles * TILE_PIXELS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
  }

  /** Resolves once every stroke tile has its selection coverage: before baking. */
  async selectionReady() {
    while (this.selWrites.size) await Promise.all([...this.selWrites])
  }

  private get tileBytes() {
    return TILE_PIXELS * this.stride * 4
  }

  private makeBuffer(tiles: number) {
    return this.device.createBuffer({ label: 'stroke tiles', size: tiles * this.tileBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
  }

  /** The stroke's colour for the kernel, when it's one colour. */
  get colour() {
    return this.fg
  }

  /** A dab into the layer, with its copies where the document is a tile (brush/dab.ts wrapDab). */
  private queue(d: Dab) {
    const doc = this.scene.doc
    const all = doc ? wrapDab(d, doc.width, doc.height, this.wrap) : [d]
    if (this.start.retouch) for (const c of all) this.placed.push(toLayer(c, this.transform))
    if (all.length === 1) this.pending.push(toLayer(all[0], this.transform))
    else if (this.start.sampling) {
      const copies = all.map((c) => toLayer(c, this.transform))
      this.pending.push({ ...copies[0], copies })
    } else for (const c of all) this.pending.push(toLayer(c, this.transform))
  }

  add(samples: PenSample[]) {
    for (const s of samples) for (const d of this.builder.add(s)) this.queue(d)
    if (samples.length) {
      this.lastSampleT = samples[samples.length - 1].t
      this.lastSampleAt = performance.now()
    }
  }

  /** Build-up: time has passed with the pen down; paint keeps building where it rests. */
  tick() {
    if (!this.start.settings.buildUp || this.result !== undefined || !this.lastSampleAt) return
    const now = this.lastSampleT + (performance.now() - this.lastSampleAt)
    for (const d of this.builder.tick(now)) this.queue(d)
  }

  end() {
    for (const d of this.builder.finish()) this.queue(d)
  }

  get hasPending() {
    return this.pending.length > 0
  }

  private dabColour(d: LayerDab) {
    return dabColour(this.fg, this.bg, d.colour, d.hsb, this.mode, this.tables)
  }

  /**
   * Stamps the dabs placed since last time, in `enc`, and returns where they
   * fell in the document. Old buffers replaced by a growth are returned too,
   * to be destroyed after the frame is submitted.
   */
  stamp(enc: GPUCommandEncoder, k: Kernels, params: Ring, storage: Ring, tips: TipBank, doomed: GPUBuffer[], residency?: Residency, composite?: CompositeSource): Rect | null {
    if (!this.pending.length) return null
    if (this.start.sampling) return residency ? this.stampSampling(enc, k, params, storage, tips, doomed, residency, composite) : null
    if (this.start.clone) return residency ? this.stampClone(enc, k, params, storage, tips, doomed, residency, composite) : null
    const dabs = this.pending
    this.pending = []
    const doc = this.scene.doc!
    const t = this.transform
    let dirty: Rect | null = null
    // Which layer tiles each dab reaches, clipped to the canvas as seen from the layer.
    const canvasInLayer = transformRect(invertAffine(t), [0, 0, doc.width, doc.height])
    const byTile = new Map<string, LayerDab[]>()
    for (const d of dabs) {
      const x0 = Math.floor(Math.max(d.box[0], canvasInLayer[0]) / TILE)
      const y0 = Math.floor(Math.max(d.box[1], canvasInLayer[1]) / TILE)
      const x1 = Math.floor(Math.min(d.box[2], canvasInLayer[2]) / TILE)
      const y1 = Math.floor(Math.min(d.box[3], canvasInLayer[3]) / TILE)
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const key = `${x},${y}`
        let list = byTile.get(key)
        if (!list) byTile.set(key, (list = []))
        list.push(d)
      }
      dirty = union(dirty, transformRect(t, d.box))
    }
    for (const [key, list] of byTile) {
      const slot = this.slotFor(key, enc, doomed)
      if (slot === null) {
        this.overflow = true
        continue
      }
      const [tx, ty] = key.split(',').map(Number)
      const ox = tx * TILE
      const oy = ty * TILE
      const data = new Float32Array(list.length * DAB_FLOATS)
      const bits = new Uint32Array(data.buffer)
      list.forEach((d, i) => {
        const o = i * DAB_FLOATS
        const c = this.layout.channels ? this.dabColour(d) : [0, 0, 0, 0]
        data.set([d.cx - ox, d.cy - oy, d.aa, d.hardness], o)
        data.set(d.a, o + 4)
        // A tip the engine hasn't been given draws nothing; the page sends tips before strokes that use them.
        data.set([d.opacity, d.flow, tips.index(d.tip, doomed) ?? -1, d.dual ? 1 : 0], o + 8)
        data.set([...c, 0, 0, 0, 0].slice(0, 4), o + 12)
        data.set([d.box[0] - ox, d.box[1] - oy, d.box[2] - ox, d.box[3] - oy], o + 16)
        data[o + 20] = d.texDepth
        bits[o + 21] = d.grain >>> 0
      })
      const b = this.start.settings
      const tex = b.texture
      const p = new ArrayBuffer(STAMP_PARAMS_BYTES)
      new Uint32Array(p, 0, 4).set([list.length, this.stride, slot, this.layout.channels])
      // The layer's transform with its translation moved to this tile's corner, in doubles.
      new Float32Array(p, 16, 8).set([t[0], t[1], t[2], t[3], t[0] * ox + t[2] * oy + t[4], t[1] * ox + t[3] * oy + t[5], doc.width, doc.height])
      new Uint32Array(p, 48, 4).set([b.noise ? 1 : 0, b.wetEdges ? 1 : 0, this.layout.raw ? 1 : 0, this.layout.dual ? 1 : 0])
      new Int32Array(p, 64, 4).set([ox, oy, b.dual ? DUAL_INDEX[b.dual.mode] + 1 : 0, colourOffset(this.layout)])
      new Uint32Array(p, 80, 4).set([tex ? (tex.eachTip ? 2 : 1) : 0, tex ? TEXTURE_MODE_INDEX[tex.mode] : 0, tex?.invert ? 1 : 0, this.textureWidth])
      new Float32Array(p, 96, 4).set(tex ? [tex.scale, tex.brightness, tex.contrast, tex.depth] : [1, 0, 0, 0])
      const pu = params.put(p)
      const pd = storage.put(data)
      const pipe = k.stampPipeline()
      const pass = enc.beginComputePass({ label: 'stamp dabs' })
      pass.setPipeline(pipe)
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: pipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: pu.buffer, offset: pu.offset, size: STAMP_PARAMS_BYTES } },
            { binding: 1, resource: { buffer: pd.buffer, offset: pd.offset, size: pd.size } },
            { binding: 2, resource: { buffer: this.buffer } },
            { binding: 3, resource: { buffer: tips.data } },
            { binding: 4, resource: { buffer: tips.table } },
            { binding: 5, resource: { buffer: this.texture ?? k.dummy } },
          ],
        }),
      )
      pass.dispatchWorkgroups(TILE / 16, TILE / 16)
      pass.end()
    }
    this.docBounds = union(this.docBounds, dirty)
    return dirty
  }

  /**
   * A sampling stroke's dabs, one after another: each picks up what's under
   * it (the layer through the atlas, with this stroke so far), then puts its
   * paint down. Throws NotReady, keeping the dabs not yet done, when the
   * layer's tiles have to come back from disk first.
   */
  private stampSampling(enc: GPUCommandEncoder, k: Kernels, params: Ring, storage: Ring, tips: TipBank, doomed: GPUBuffer[], residency: Residency, composite?: CompositeSource): Rect | null {
    const sm = this.start.sampling!
    const doc = this.scene.doc!
    const t = this.transform
    const n = this.channels
    const b = this.start.settings
    const canvasInLayer = transformRect(invertAffine(t), [0, 0, doc.width, doc.height])
    const fg = (this.mode === 'cmyk' ? this.start.fg.map((x) => 1 - x) : this.start.fg).slice(0, n)
    let dirty: Rect | null = null
    // Sample All Layers: the document as it shows under this frame's dabs, rendered once, in one window.
    let all: { buffer: GPUBuffer; x0: number; y0: number; w: number; h: number } | null = null
    if (sm.sampleAll && composite && this.mode === doc.mode) {
      let r: Rect | null = null
      for (const d of this.pending) for (const c of d.copies ?? [d]) r = union(r, transformRect(t, c.box))
      if (r) {
        const x0 = Math.max(0, Math.floor((r[0] - 1) / TILE))
        const y0 = Math.max(0, Math.floor((r[1] - 1) / TILE))
        const x1 = Math.min(Math.ceil(doc.width / TILE) - 1, Math.floor((r[2] + 1) / TILE))
        const y1 = Math.min(Math.ceil(doc.height / TILE) - 1, Math.floor((r[3] + 1) / TILE))
        if (x1 >= x0 && y1 >= y0) {
          const tb = tileBufferBytes(composite.format)
          const w = x1 - x0 + 1
          const h = y1 - y0 + 1
          const buffer = this.device.createBuffer({ label: 'sample all layers', size: tb * w * h, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
              const tile = composite.render(enc, x0 + x, y0 + y)
              if (tile) {
                enc.copyBufferToBuffer(tile, 0, buffer, (y * w + x) * tb, tb)
                composite.release(tile)
              } else enc.clearBuffer(buffer, (y * w + x) * tb, tb)
            }
          doomed.push(buffer)
          all = { buffer, x0, y0, w, h }
        }
      }
    }
    // A tiled document's pick-up wraps in the layer where the layer sits on whole pixels unturned, so its pixels repeat with the document.
    const plain = t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1 && Number.isInteger(t[4]) && Number.isInteger(t[5])
    const pickWrap = { x: this.wrap.x && plain, y: this.wrap.y && plain }
    while (this.pending.length) {
      const d = this.pending[0]
      // Where its paint goes: the dab, or in a tiled document each copy of it on the canvas.
      const places = (d.copies ?? [d])
        .map((c) => {
          // The tiles the copy can paint (on the canvas), each with its stroke slot.
          const x0 = Math.floor(Math.max(c.box[0], canvasInLayer[0]) / TILE)
          const y0 = Math.floor(Math.max(c.box[1], canvasInLayer[1]) / TILE)
          const x1 = Math.floor(Math.min(c.box[2], canvasInLayer[2]) / TILE)
          const y1 = Math.floor(Math.min(c.box[3], canvasInLayer[3]) / TILE)
          return { c, x0, y0, x1, y1 }
        })
        .filter((p) => p.x1 >= p.x0 && p.y1 >= p.y0)
      if (!places.length) {
        this.pending.shift()
        continue
      }
      for (const p of places)
        for (let y = p.y0; y <= p.y1; y++)
          for (let x = p.x0; x <= p.x1; x++) if (this.slotFor(`${x},${y}`, enc, doomed) === null) this.overflow = true
      // What the pick-up reads: every layer tile the patch can land on, a pixel past the box; and, where it
      // wraps, the tiles at the other side it lands on, which are under the copies.
      const reads = (pickWrap.x || pickWrap.y ? places.map((p) => p.c) : [d]).map((c) => [c.box[0] - 1, c.box[1] - 1, c.box[2] + 1, c.box[3] + 1])
      const wx0 = Math.floor(Math.min(...reads.map((r) => r[0])) / TILE)
      const wy0 = Math.floor(Math.min(...reads.map((r) => r[1])) / TILE)
      const ww = Math.floor(Math.max(...reads.map((r) => r[2])) / TILE) - wx0 + 1
      const wh = Math.floor(Math.max(...reads.map((r) => r[3])) / TILE) - wy0 + 1
      const needed = (tx: number, ty: number) => reads.some((r) => tx >= Math.floor(r[0] / TILE) && tx <= Math.floor(r[2] / TILE) && ty >= Math.floor(r[1] / TILE) && ty <= Math.floor(r[3] / TILE))
      const win = new Int32Array(ww * wh)
      const swin = new Int32Array(ww * wh)
      const uniforms: number[] = []
      for (let y = 0; y < wh; y++)
        for (let x = 0; x < ww; x++) {
          // Between copies at opposite edges, nothing's read: those tiles aren't paged in.
          if (!needed(wx0 + x, wy0 + y)) {
            win[y * ww + x] = -1
            swin[y * ww + x] = -1
            continue
          }
          // Throws NotReady when a tile's on disk: the dab stays pending for the next frame.
          const res = this.base ? residency.resolve(enc, this.base, 0, wx0 + x, wy0 + y) : { kind: 'empty' as const }
          if (res.kind === 'slot') win[y * ww + x] = res.slot
          else if (res.kind === 'uniform') {
            const u = uniforms.length / 8
            uniforms.push(...res.value.slice(0, -1), ...new Array(4 - (res.value.length - 1)).fill(0), res.value[res.value.length - 1], 0, 0, 0)
            win[y * ww + x] = -2 - u
          } else win[y * ww + x] = -1
          swin[y * ww + x] = this.slotAt(wx0 + x, wy0 + y)
        }
      this.pending.shift()
      // Picking up what's under the dab, then putting paint down (ref/sample.ts).
      const pickUpHere = (first: boolean) => {
        const det = d.a[0] * d.a[3] - d.a[1] * d.a[2] || 1e-12
        const pp = new ArrayBuffer(PICK_PARAMS_BYTES)
        const pf = new Float32Array(pp)
        const pu32 = new Uint32Array(pp)
        const pi32 = new Int32Array(pp)
        pf.set([d.a[3] / det, -d.a[1] / det, -d.a[2] / det, d.a[0] / det], 0)
        pf.set([d.cx - wx0 * TILE, d.cy - wy0 * TILE, sm.strength * d.opacity, sm.wet * d.wet * MIXER_PICK], 4)
        pi32.set([wx0, wy0, ww, wh], 8)
        const ks = this.kernelStroke()
        pu32.set([ks.stride, ks.blend, 2, (ks.selection ? 1 : 0) | (1 << 8)], 12)
        pf.set([...fg, 0, 0, 0, 0].slice(0, 4), 16)
        pu32.set([sm.tool === 'mixer' ? 1 : 0, first ? 1 : 0, sm.fingerPainting ? 1 : 0, 0], 20)
        pf.set([...fg, 0, 0, 0, 0].slice(0, 4), 24)
        pf.set([1, sm.tool === 'mixer' ? sm.wet * d.wet * sm.mix * d.mix * MIXER_PICK : 0, 0, 0], 28)
        // Where the reads wrap: the period in layer pixels (0 for none), and the canvas's corner relative to the window.
        pi32.set([pickWrap.x ? doc.width : 0, pickWrap.y ? doc.height : 0, Math.round(-t[4]) - wx0 * TILE, Math.round(-t[5]) - wy0 * TILE], 32)
        if (all && composite) {
          // From the document as it shows: the layer's transform takes patch texels there.
          const ap = new ArrayBuffer(PICK_ALL_PARAMS_BYTES)
          const af = new Float32Array(ap)
          const au = new Uint32Array(ap)
          af.set([d.a[3] / det, -d.a[1] / det, -d.a[2] / det, d.a[0] / det], 0)
          af.set([d.cx, d.cy, sm.strength * d.opacity, sm.wet * d.wet * MIXER_PICK], 4)
          af.set([t[0], t[1], t[2], t[3], t[4] - all.x0 * TILE, t[5] - all.y0 * TILE, sm.tool === 'mixer' ? sm.wet * d.wet * sm.mix * d.mix * MIXER_PICK : 0, 0], 8)
          au.set([all.w, all.h, sm.tool === 'mixer' ? 1 : 0, (first ? 1 : 0) | (sm.fingerPainting ? 2 : 0)], 16)
          af.set([...fg, 0, 0, 0, 0].slice(0, 4), 20)
          // The document repeats: reads wrap at its edges (the window's corner, to get back to document pixels).
          new Int32Array(ap).set([this.wrap.x ? doc.width : 0, this.wrap.y ? doc.height : 0, all.x0 * TILE, all.y0 * TILE], 24)
          const ape = params.put(ap)
          const pa = k.pickAllPipeline(composite.format)
          const p2 = enc.beginComputePass({ label: 'pick up from the image' })
          p2.setPipeline(pa)
          p2.setBindGroup(
            0,
            this.device.createBindGroup({
              layout: pa.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: ape.buffer, offset: ape.offset, size: PICK_ALL_PARAMS_BYTES } },
                { binding: 1, resource: { buffer: all.buffer } },
                { binding: 2, resource: { buffer: this.carried! } },
                { binding: 3, resource: { buffer: this.reservoir! } },
              ],
            }),
          )
          p2.dispatchWorkgroups(PATCH / 16, PATCH / 16)
          p2.end()
        }
        const pick = k.pickPipeline(this.mode, this.depth)
        const pw = storage.put(win)
        const ps = storage.put(swin)
        const puni = storage.put(new Float32Array(uniforms.length ? uniforms : [0, 0, 0, 0, 0, 0, 0, 0]))
        const pparams = params.put(pp)
        const pickEntries: GPUBindGroupEntry[] = [
          { binding: 0, resource: { buffer: pparams.buffer, offset: pparams.offset, size: PICK_PARAMS_BYTES } },
          { binding: 4, resource: residency.atlas.textures[0].createView({ dimension: '2d-array' }) },
          { binding: 6, resource: { buffer: pw.buffer, offset: pw.offset, size: pw.size } },
          { binding: 7, resource: { buffer: puni.buffer, offset: puni.offset, size: Math.floor(puni.size / 16) * 16 } },
          { binding: 8, resource: { buffer: ps.buffer, offset: ps.offset, size: ps.size } },
          { binding: 9, resource: { buffer: this.buffer } },
          { binding: 11, resource: { buffer: this.selBuffer ?? k.dummy } },
          { binding: 12, resource: { buffer: this.carried! } },
          { binding: 13, resource: { buffer: this.reservoir! } },
        ]
        if (this.mode === 'cmyk') pickEntries.push({ binding: 5, resource: residency.atlas.textures[1].createView({ dimension: '2d-array' }) })
        if (!all) {
          const pass = enc.beginComputePass({ label: 'pick up' })
          pass.setPipeline(pick)
          pass.setBindGroup(0, this.device.createBindGroup({ layout: pick.getBindGroupLayout(0), entries: pickEntries }))
          pass.dispatchWorkgroups(PATCH / 16, PATCH / 16)
          pass.end()
        }
      }
      pickUpHere(!this.picked)
      this.picked = true
      // Putting it down, over the box: at each copy, the same paint.
      for (const { c, x0, y0, x1, y1 } of places) {
        const tw = x1 - x0 + 1
        const th = y1 - y0 + 1
        const slots = new Int32Array(tw * th)
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) slots[y * tw + x] = this.tiles.get(`${x0 + x},${y0 + y}`) ?? -1
        const bx0 = Math.floor(c.box[0])
        const by0 = Math.floor(c.box[1])
        const bw = Math.ceil(c.box[2]) - bx0 + 1
        const bh = Math.ceil(c.box[3]) - by0 + 1
        const dp = new ArrayBuffer(DEPOSIT_PARAMS_BYTES)
        const df = new Float32Array(dp)
        const du32 = new Uint32Array(dp)
        const di32 = new Int32Array(dp)
        df.set(c.a, 0)
        df.set([c.cx, c.cy, c.aa, c.hardness], 4)
        di32.set([bx0, by0, bw, bh], 8)
        di32.set([x0, y0, tw, th], 12)
        df.set([d.flow, tips.index(d.tip, doomed) ?? -1, sm.mix * d.mix, sm.wet * d.wet], 16)
        du32.set([sm.tool === 'mixer' ? 1 : 0, b.noise ? 1 : 0, b.wetEdges ? 1 : 0, d.grain >>> 0], 20)
        df.set([t[0], t[1], t[2], t[3], t[4], t[5], doc.width, doc.height], 24)
        df.set([this.amount, 0, 0, 0], 32)
        const dparams = params.put(dp)
        const dslots = storage.put(slots)
        const dep = k.depositPipeline(this.mode)
        const pass = enc.beginComputePass({ label: 'put paint down' })
        pass.setPipeline(dep)
        pass.setBindGroup(
          0,
          this.device.createBindGroup({
            layout: dep.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: dparams.buffer, offset: dparams.offset, size: DEPOSIT_PARAMS_BYTES } },
              { binding: 1, resource: { buffer: this.carried! } },
              { binding: 2, resource: { buffer: this.reservoir! } },
              { binding: 3, resource: { buffer: this.buffer } },
              { binding: 4, resource: { buffer: tips.data } },
              { binding: 5, resource: { buffer: tips.table } },
              { binding: 6, resource: { buffer: dslots.buffer, offset: dslots.offset, size: dslots.size } },
            ],
          }),
        )
        pass.dispatchWorkgroups(Math.ceil(bw / 16), Math.ceil(bh / 16))
        pass.end()
        dirty = union(dirty, transformRect(t, c.box))
      }
      if (sm.tool === 'mixer') this.amount *= 1 - (1 - sm.load) * 0.05 * d.flow
    }
    this.docBounds = union(this.docBounds, dirty)
    return dirty
  }

  /**
   * The Clone Stamp's dabs, one after another: each the source under it,
   * moved by the offset, laid on through the tip (shaders/clone.ts). The
   * source is the layer as the stroke found it (the atlas, through a window
   * of the tiles the source boxes reach) or the document's composite.
   * Throws NotReady, keeping the dabs not yet done, when the layer's tiles
   * have to come back from disk first.
   */
  private stampClone(enc: GPUCommandEncoder, k: Kernels, params: Ring, storage: Ring, tips: TipBank, doomed: GPUBuffer[], residency: Residency, composite?: CompositeSource): Rect | null {
    const cl = this.start.clone!
    const doc = this.scene.doc!
    const t = this.transform
    const b = this.start.settings
    const canvasInLayer = transformRect(invertAffine(t), [0, 0, doc.width, doc.height])
    const plain = t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1 && Number.isInteger(t[4]) && Number.isInteger(t[5])
    // The offset in the layer's pixels (its transform's linear part, inverted).
    const inv = invertAffine(t)
    const ol: [number, number] = [inv[0] * cl.offset[0] + inv[2] * cl.offset[1], inv[1] * cl.offset[0] + inv[3] * cl.offset[1]]
    let dirty: Rect | null = null
    // Sample All Layers: the document's composite under the frame's source boxes, rendered once into one window.
    let all: { buffer: GPUBuffer; x0: number; y0: number; w: number; h: number } | null = null
    if (cl.sampleAll && composite && this.mode === doc.mode) {
      let r: Rect | null = null
      for (const d of this.pending) {
        const db = transformRect(t, d.box)
        r = union(r, [db[0] + cl.offset[0], db[1] + cl.offset[1], db[2] + cl.offset[0], db[3] + cl.offset[1]])
      }
      if (r) {
        const cols = foldedTiles(r[0] - 2, r[2] + 2, doc.width, TILE, this.wrap.x)
        const rows = foldedTiles(r[1] - 2, r[3] + 2, doc.height, TILE, this.wrap.y)
        if (cols.length && rows.length) {
          const x0 = Math.min(...cols)
          const y0 = Math.min(...rows)
          const w = Math.max(...cols) - x0 + 1
          const h = Math.max(...rows) - y0 + 1
          const tb = tileBufferBytes(composite.format)
          const buffer = this.device.createBuffer({ label: 'clone from the image', size: tb * w * h, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
              const tile = cols.includes(x0 + x) && rows.includes(y0 + y) ? composite.render(enc, x0 + x, y0 + y) : null
              if (tile) {
                enc.copyBufferToBuffer(tile, 0, buffer, (y * w + x) * tb, tb)
                composite.release(tile)
              } else enc.clearBuffer(buffer, (y * w + x) * tb, tb)
            }
          doomed.push(buffer)
          all = { buffer, x0, y0, w, h }
        }
      }
    }
    // A tiled document's reads wrap in the layer where it's on whole pixels, unturned.
    const wrapLayer = { x: this.wrap.x && plain, y: this.wrap.y && plain }
    while (this.pending.length) {
      const d = this.pending[0]
      const x0 = Math.floor(Math.max(d.box[0], canvasInLayer[0]) / TILE)
      const y0 = Math.floor(Math.max(d.box[1], canvasInLayer[1]) / TILE)
      const x1 = Math.floor(Math.min(d.box[2], canvasInLayer[2]) / TILE)
      const y1 = Math.floor(Math.min(d.box[3], canvasInLayer[3]) / TILE)
      if (x1 < x0 || y1 < y0) {
        this.pending.shift()
        continue
      }
      const tw = x1 - x0 + 1
      const th = y1 - y0 + 1
      const slots = new Int32Array(tw * th)
      for (let y = 0; y < th; y++)
        for (let x = 0; x < tw; x++) {
          const slot = this.slotFor(`${x0 + x},${y0 + y}`, enc, doomed)
          if (slot === null) this.overflow = true
          slots[y * tw + x] = slot ?? -1
        }
      // The source window.
      let win: [number, number, number, number]
      let src: number[]
      let wrap: [number, number, number, number]
      const entries: GPUBindGroupEntry[] = []
      let pipe: GPUComputePipeline
      if (all && composite) {
        // Layer pixel → document → the source → the window's pixels.
        win = [all.x0, all.y0, all.w, all.h]
        src = [t[0], t[1], t[2], t[3], t[4] + cl.offset[0] - all.x0 * TILE, t[5] + cl.offset[1] - all.y0 * TILE]
        wrap = [this.wrap.x ? doc.width : 0, this.wrap.y ? doc.height : 0, all.x0 * TILE, all.y0 * TILE]
        pipe = k.clonePipeline(this.mode, this.depth, 'composite', composite.format)
        entries.push({ binding: 9, resource: { buffer: all.buffer } })
      } else {
        // The layer's tiles under the source box, a pixel past it; and, wrapping, where those are folded to.
        const sb = [d.box[0] + ol[0] - 2, d.box[1] + ol[1] - 2, d.box[2] + ol[0] + 2, d.box[3] + ol[1] + 2]
        const cx = Math.round(-t[4])
        const cy = Math.round(-t[5])
        const fold = (lo: number, hi: number, corner: number, size: number, on: boolean) => foldedTiles(lo - corner, hi - corner, size, TILE, on).map((v) => v)
        const colsRaw = wrapLayer.x ? fold(sb[0], sb[2], cx, doc.width, true).map((c) => c) : null
        const rowsRaw = wrapLayer.y ? fold(sb[1], sb[3], cy, doc.height, true) : null
        // Folded tile indices are relative to the canvas's corner in the layer; whole-tile corners only when it's on a tile.
        const tilesFor = (lo: number, hi: number, corner: number, size: number, on: boolean, raw: number[] | null) => {
          if (!on || raw === null) return [Math.floor(lo / TILE), Math.floor(hi / TILE)]
          const pts = raw.flatMap((c) => [corner + c * TILE, corner + Math.min(size, (c + 1) * TILE) - 1])
          return [Math.floor(Math.min(...pts) / TILE), Math.floor(Math.max(...pts) / TILE)]
        }
        const [wx0, wx1] = tilesFor(sb[0], sb[2], cx, doc.width, wrapLayer.x, colsRaw)
        const [wy0, wy1] = tilesFor(sb[1], sb[3], cy, doc.height, wrapLayer.y, rowsRaw)
        const ww = wx1 - wx0 + 1
        const wh = wy1 - wy0 + 1
        const table = new Int32Array(ww * wh)
        const uniforms: number[] = []
        for (let y = 0; y < wh; y++)
          for (let x = 0; x < ww; x++) {
            // Throws NotReady when a tile's on disk: the dab stays pending for the next frame.
            const res = this.base ? residency.resolve(enc, this.base, 0, wx0 + x, wy0 + y) : { kind: 'empty' as const }
            if (res.kind === 'slot') table[y * ww + x] = res.slot
            else if (res.kind === 'uniform') {
              const u = uniforms.length / 8
              uniforms.push(...res.value.slice(0, -1), ...new Array(4 - (res.value.length - 1)).fill(0), res.value[res.value.length - 1], 0, 0, 0)
              table[y * ww + x] = -2 - u
            } else table[y * ww + x] = -1
          }
        win = [wx0, wy0, ww, wh]
        src = [1, 0, 0, 1, ol[0] - wx0 * TILE, ol[1] - wy0 * TILE]
        wrap = [wrapLayer.x ? doc.width : 0, wrapLayer.y ? doc.height : 0, cx - wx0 * TILE, cy - wy0 * TILE]
        pipe = k.clonePipeline(this.mode, this.depth, 'layer', { mode: this.mode, store: 'f32' })
        const pw = storage.put(table)
        const pu = storage.put(new Float32Array(uniforms.length ? uniforms : [0, 0, 0, 0, 0, 0, 0, 0]))
        entries.push(
          { binding: 4, resource: residency.atlas.textures[0].createView({ dimension: '2d-array' }) },
          { binding: 6, resource: { buffer: pw.buffer, offset: pw.offset, size: pw.size } },
          { binding: 7, resource: { buffer: pu.buffer, offset: pu.offset, size: Math.floor(pu.size / 16) * 16 } },
        )
        if (this.mode === 'cmyk') entries.push({ binding: 5, resource: residency.atlas.textures[1].createView({ dimension: '2d-array' }) })
      }
      this.pending.shift()
      const bx0 = Math.floor(d.box[0])
      const by0 = Math.floor(d.box[1])
      const bw = Math.ceil(d.box[2]) - bx0 + 1
      const bh = Math.ceil(d.box[3]) - by0 + 1
      const cp = new ArrayBuffer(CLONE_PARAMS_BYTES)
      writeCloneParams(cp, {
        a: d.a,
        centre: [d.cx, d.cy],
        aa: d.aa,
        hardness: d.hardness,
        box: [bx0, by0, bw, bh],
        tiles: [x0, y0, tw, th],
        flow: d.flow,
        tip: tips.index(d.tip, doomed) ?? -1,
        opacity: d.opacity,
        noise: b.noise,
        wetEdges: b.wetEdges,
        grain: d.grain,
        t,
        width: doc.width,
        height: doc.height,
        src,
        win,
        wrap,
      })
      const pp = params.put(cp)
      const ps = storage.put(slots)
      const pass = enc.beginComputePass({ label: 'clone' })
      pass.setPipeline(pipe)
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: pipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: pp.buffer, offset: pp.offset, size: CLONE_PARAMS_BYTES } },
            { binding: 1, resource: { buffer: this.buffer } },
            { binding: 2, resource: { buffer: tips.data } },
            { binding: 3, resource: { buffer: tips.table } },
            { binding: 8, resource: { buffer: ps.buffer, offset: ps.offset, size: ps.size } },
            ...entries,
          ],
        }),
      )
      pass.dispatchWorkgroups(Math.ceil(bw / 16), Math.ceil(bh / 16))
      pass.end()
      dirty = union(dirty, transformRect(t, d.box))
    }
    this.docBounds = union(this.docBounds, dirty)
    return dirty
  }

  /** The slot for a layer tile, cleared on first use; grows the buffer when full. */
  private slotFor(key: string, enc: GPUCommandEncoder, doomed: GPUBuffer[]): number | null {
    const have = this.tiles.get(key)
    if (have !== undefined) return have
    const slot = this.tiles.size
    if (slot >= MAX_TILES) return null
    if (slot >= this.capacity) {
      const bigger = Math.min(MAX_TILES, this.capacity * 2)
      const next = this.makeBuffer(bigger)
      enc.copyBufferToBuffer(this.buffer, 0, next, 0, this.capacity * this.tileBytes)
      doomed.push(this.buffer)
      this.buffer = next
      if (this.selBuffer) {
        const nextSel = this.makeSelBuffer(bigger)
        enc.copyBufferToBuffer(this.selBuffer, 0, nextSel, 0, this.capacity * TILE_PIXELS * 4)
        doomed.push(this.selBuffer)
        this.selBuffer = nextSel
      }
      this.capacity = bigger
    }
    enc.clearBuffer(this.buffer, slot * this.tileBytes, this.tileBytes)
    this.tiles.set(key, slot)
    if (this.sel && this.selBuffer) {
      // Nothing shows in the tile until its selection coverage is there,
      // a frame later: the stroke never shows outside the selection.
      enc.clearBuffer(this.selBuffer, slot * TILE_PIXELS * 4, TILE_PIXELS * 4)
      const [tx, ty] = key.split(',').map(Number)
      const w = this.sel(tx, ty).then((cover) => {
        this.device.queue.writeBuffer(this.selBuffer!, slot * TILE_PIXELS * 4, cover as Float32Array<ArrayBuffer>)
        this.selWrites.delete(w)
        this.onSelection()
      })
      this.selWrites.add(w)
    }
    return slot
  }

  /** The stroke tile slot for layer tile (x, y), or −1. */
  slotAt(x: number, y: number): number {
    return this.tiles.get(`${x},${y}`) ?? -1
  }

  /** The layer tiles the stroke reaches: min and max, inclusive, or null. */
  get extent(): { x0: number; y0: number; x1: number; y1: number } | null {
    let e: { x0: number; y0: number; x1: number; y1: number } | null = null
    for (const key of this.tiles.keys()) {
      const [x, y] = key.split(',').map(Number)
      e = e ? { x0: Math.min(e.x0, x), y0: Math.min(e.y0, y), x1: Math.max(e.x1, x), y1: Math.max(e.y1, y) } : { x0: x, y0: y, x1: x, y1: y }
    }
    return e
  }

  /** The kernel's stroke fields. */
  kernelStroke() {
    if (this.replaces) return { stride: this.stride, blend: 0, eraser: false, replace: true, colour: this.fg, selection: !!this.selBuffer, colourOffset: 1 }
    return { stride: this.stride, blend: blendIndex(this.start.eraser ? 'normal' : this.start.settings.mode), eraser: this.start.eraser, colour: this.fg, selection: !!this.selBuffer, colourOffset: colourOffset(this.layout) }
  }

  /** Every GPU buffer the stroke owns, to be destroyed once the frame using them is done. */
  buffers(): GPUBuffer[] {
    return [this.buffer, this.selBuffer, this.texture, this.carried, this.reservoir].filter((x): x is GPUBuffer => !!x)
  }

  destroy() {
    for (const b of this.buffers()) b.destroy()
  }
}

function invertAffine(t: number[]): number[] {
  const det = t[0] * t[3] - t[1] * t[2] || 1e-12
  return [t[3] / det, -t[1] / det, -t[2] / det, t[0] / det, (t[2] * t[5] - t[3] * t[4]) / det, (t[1] * t[4] - t[0] * t[5]) / det]
}

/**
 * Bakes a finished stroke: every tile it touched, with the stroke laid on,
 * read back and made into tiles, and the new set. Throws NotReady when the
 * layer's tiles have to come back from disk first; the caller waits and
 * tries again.
 */
export async function bake(
  s: LiveStroke,
  device: GPUDevice,
  k: Kernels,
  residency: Residency,
  store: TileStore,
  work: { begin(): GPUCommandEncoder; finish(enc: GPUCommandEncoder): void; params: Ring; storage: Ring },
): Promise<string | null> {
  const f: TileFormat = { mode: s.mode, depth: s.depth }
  const planes = planesOf(f)
  const keys = [...s.tiles.keys()]
  if (!keys.length) return s.base
  await s.selectionReady()
  const outBytes = planes * TILE_PIXELS * 4
  const staging = device.createBuffer({ label: 'bake readback', size: outBytes * keys.length, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const outs: GPUBuffer[] = []
  try {
    const enc = work.begin()
    try {
      const variant = { mode: s.mode, store: 'f32' as const, source: 'pixel' as const, depth: s.depth, stroke: true }
      const pipe = k.bakePipeline(variant)
      keys.forEach((key, i) => {
        const [x, y] = key.split(',').map(Number)
        const res = s.base ? residency.resolve(enc, s.base, 0, x, y) : { kind: 'empty' as const }
        const entry = res.kind === 'slot' ? res.slot : res.kind === 'uniform' ? -2 : -1
        const uniforms = res.kind === 'uniform' ? [...res.value.slice(0, -1), ...new Array(4 - (res.value.length - 1)).fill(0), res.value[res.value.length - 1], 0, 0, 0] : [0, 0, 0, 0, 0, 0, 0, 0]
        const params = new ArrayBuffer(PARAMS_BYTES)
        writeParams(params, { m: [1, 0, 0, 1, 0, 0], op: 0, blend: 0, filter: 0, flags: 0, k: 1, seed: 0, origin: [0, 0], win: [0, 0, 1, 1], stroke: s.kernelStroke() })
        const pu = work.params.put(params)
        const pw = work.storage.put(new Int32Array([entry]))
        const pun = work.storage.put(new Float32Array(uniforms))
        const ps = work.storage.put(new Int32Array([s.tiles.get(key)!]))
        const out = device.createBuffer({ label: 'baked tile', size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
        outs.push(out)
        const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: { buffer: pu.buffer, offset: pu.offset, size: PARAMS_BYTES } },
          { binding: 4, resource: residency.atlas.textures[0].createView({ dimension: '2d-array' }) },
          { binding: 6, resource: { buffer: pw.buffer, offset: pw.offset, size: pw.size } },
          { binding: 7, resource: { buffer: pun.buffer, offset: pun.offset, size: Math.floor(pun.size / 16) * 16 } },
          { binding: 8, resource: { buffer: ps.buffer, offset: ps.offset, size: ps.size } },
          { binding: 9, resource: { buffer: s.buffer } },
          { binding: 10, resource: { buffer: out } },
          { binding: 11, resource: { buffer: s.selBuffer ?? k.dummy } },
        ]
        if (s.mode === 'cmyk') entries.push({ binding: 5, resource: residency.atlas.textures[1].createView({ dimension: '2d-array' }) })
        const pass = enc.beginComputePass({ label: 'bake stroke' })
        pass.setPipeline(pipe)
        pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries }))
        pass.dispatchWorkgroups(TILE / 16, TILE / 16)
        pass.end()
        enc.copyBufferToBuffer(out, 0, staging, i * outBytes, outBytes)
      })
    } finally {
      work.finish(enc)
    }
    await staging.mapAsync(GPUMapMode.READ)
    const all = new Uint32Array(staging.getMappedRange().slice(0))
    staging.unmap()
    const changes: [number, number, TileId | null][] = []
    keys.forEach((key, i) => {
      const [x, y] = key.split(',').map(Number)
      const src = all.subarray((i * outBytes) / 4, ((i + 1) * outBytes) / 4)
      const samples: Samples = newSamples(f)
      samples.set(src)
      // Fully transparent: no tile at all, so sets stay sparse.
      const alpha = samples.subarray((planes - 1) * TILE_PIXELS)
      if (alpha.every((v) => v === 0)) {
        changes.push([x, y, null])
        return
      }
      const old = s.base ? store.tileAt(s.base, x, y) : undefined
      const peek = old !== undefined ? store.peek(old) : null
      if (peek && peek.length === samples.length && peek.every((v, j) => v === samples[j])) return
      changes.push([x, y, store.data(f, samples)])
    })
    if (!changes.length) return s.base
    if (s.base) return store.derive(s.base, changes)
    return store.createSet(f, changes.filter((c): c is [number, number, TileId] => c[2] !== null))
  } finally {
    staging.destroy()
    for (const o of outs) o.destroy()
  }
}

export { NotReady }
