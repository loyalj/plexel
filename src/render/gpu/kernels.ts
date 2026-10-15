/**
 * The render kernels on a device: pipelines made the first time each
 * variant is needed, the rings that hold each dispatch's small inputs, and
 * a pool of composite buffers.
 *
 * Every dispatch gets its own slice of a ring buffer for its parameters
 * (and window table), written with queue.writeBuffer. Writes land before
 * the frame's commands run, so slices are never reused within a frame; a
 * ring that fills mid-frame asks its owner to submit what's encoded first
 * (`onFull`), after which the queue's order makes reuse safe.
 */
import { compositeWgsl, variantKey, type CompositeVariant } from '../shaders/composite'
import { displayWgsl } from '../shaders/display'
import { mipWgsl } from '../shaders/mip'
import { uploadWgsl } from '../shaders/upload'
import { tileBufferBytes, type BufferFormat } from '../shaders/common'
import type { ColourMode, Depth } from '../../doc/types'
import { tileFormats } from './atlas'
import screenWgsl from '../shaders/screen.wgsl?raw'
import { stampWgsl } from '../shaders/paint'
import { depositWgsl, pickAllWgsl, pickWgsl } from '../shaders/sample'
import { cloneWgsl } from '../shaders/clone'
import { maskShowWgsl, maskWgsl } from '../shaders/mask'
import { overlayWgsl } from '../shaders/overlay'
import { adjustWgsl } from '../shaders/adjust'
import { filterWgsl } from '../shaders/filter'
import { fxWgsl } from '../shaders/fx'
import { warpWgsl } from '../shaders/warp'
import { storeWgsl } from '../shaders/store'
import { RASTER_WGSL, paintWgsl } from '../shaders/vector'

/** Writes up to this size are held back and sent together by a batched ring (Ring.flush). */
const SMALL_WRITE = 4096

export class Ring {
  readonly buffer: GPUBuffer
  private at = 0
  private align: number
  private usage: GPUBufferUsageFlags
  /** Buffers of their own for writes bigger than the whole ring, let go at the next reset. */
  private oversized: GPUBuffer[] = []
  /**
   * With `batched`, the ring's contents on the CPU: small writes (a
   * dispatch's parameters, a tile's window) go here, and `flush` sends what
   * was written in one queue write, where a frame of busy tiles made
   * thousands. [lo, hi) is what hasn't been sent yet.
   */
  private cpu: Uint8Array<ArrayBuffer> | null
  private lo = Infinity
  private hi = 0

  constructor(
    private device: GPUDevice,
    label: string,
    readonly size: number,
    usage: GPUBufferUsageFlags,
    private onFull: () => void,
    batched = false,
  ) {
    this.usage = usage | GPUBufferUsage.COPY_DST
    this.buffer = device.createBuffer({ label, size, usage: this.usage })
    this.align = Math.max(device.limits.minUniformBufferOffsetAlignment, device.limits.minStorageBufferOffsetAlignment)
    this.cpu = batched ? new Uint8Array(size) : null
  }

  /** Writes `data` into a fresh slice and returns where it is. */
  put(data: ArrayBuffer | ArrayBufferView): { buffer: GPUBuffer; offset: number; size: number } {
    const bytes = data instanceof ArrayBuffer ? data.byteLength : data.byteLength
    const size = Math.max(32, Math.ceil(bytes / 4) * 4)
    const src = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    if (size > this.size) {
      // It would never fit, however empty the ring (a tile of dense text, say): a buffer of its own.
      const own = this.device.createBuffer({ label: 'ring overflow', size, usage: this.usage })
      this.device.queue.writeBuffer(own, 0, src as Uint8Array<ArrayBuffer>)
      this.oversized.push(own)
      return { buffer: own, offset: 0, size }
    }
    if (this.at + size > this.size) {
      this.onFull()
      this.at = 0
    }
    const offset = this.at
    if (this.cpu && bytes <= SMALL_WRITE) {
      this.cpu.set(src, offset)
      if (offset < this.lo) this.lo = offset
      if (offset + bytes > this.hi) this.hi = offset + bytes
    } else {
      // What's held back goes first, so a flush can never write over this.
      this.flush()
      this.device.queue.writeBuffer(this.buffer, offset, src as Uint8Array<ArrayBuffer>)
    }
    this.at = Math.ceil((offset + size) / this.align) * this.align
    return { buffer: this.buffer, offset, size }
  }

  /** Sends the small writes held back since the last flush. Called before every submit that reads the ring. */
  flush() {
    if (!this.cpu || this.hi <= this.lo) return
    this.device.queue.writeBuffer(this.buffer, this.lo, this.cpu.subarray(this.lo, this.hi))
    this.lo = Infinity
    this.hi = 0
  }

  /** Whether `bytes` would go in without the ring filling: for callers with another way to do without it. */
  fits(bytes: number): boolean {
    return this.at + Math.max(32, Math.ceil(bytes / 4) * 4) <= this.size
  }

  /** How full the ring is, 0..1: the renderer stops starting tiles well before it fills. */
  get used() {
    return this.at / this.size
  }

  /** A new frame: after a submit, the whole ring is free again. */
  reset() {
    this.at = 0
    // Nothing held back survives a reset: what wasn't submitted is abandoned with its commands.
    this.lo = Infinity
    this.hi = 0
    // Work already submitted that reads them still runs; they're freed once it has.
    for (const b of this.oversized.splice(0)) b.destroy()
  }
}

/** Composite buffers, reused by size. */
export class BufferPool {
  private free = new Map<number, GPUBuffer[]>()
  private live = 0

  constructor(private device: GPUDevice) {}

  acquire(f: BufferFormat): GPUBuffer {
    return this.acquireBytes(tileBufferBytes(f))
  }

  /** A buffer of `bytes`, for scratch that isn't a composite tile (masks). */
  acquireBytes(bytes: number): GPUBuffer {
    const list = this.free.get(bytes)
    this.live++
    return (
      list?.pop() ??
      this.device.createBuffer({
        label: 'composite tile',
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      })
    )
  }

  release(b: GPUBuffer) {
    this.live--
    const list = this.free.get(b.size) ?? []
    list.push(b)
    this.free.set(b.size, list)
  }

  /** Lets go of spare buffers beyond a few of each size. */
  trim(keep = 8) {
    for (const list of this.free.values()) while (list.length > keep) list.pop()!.destroy()
  }

  get inUse() {
    return this.live
  }
}

export class Kernels {
  private composite = new Map<string, GPUComputePipeline>()
  private display = new Map<string, { tile: GPUComputePipeline; bytes: GPUComputePipeline; probe: GPUComputePipeline; probeLook: GPUComputePipeline }>()
  private mip = new Map<string, GPURenderPipeline>()
  private upload = new Map<string, GPURenderPipeline>()
  private screenPipeline: GPURenderPipeline | null = null
  private overlay: GPURenderPipeline | null = null
  private adjusts = new Map<string, GPUComputePipeline>()
  private filterModules = new Map<string, GPUShaderModule>()
  private filters = new Map<string, GPUComputePipeline>()
  private fxModules = new Map<string, GPUShaderModule>()
  private stores = new Map<string, GPURenderPipeline>()
  private fxs = new Map<string, GPUComputePipeline>()
  private stamp: GPUComputePipeline | null = null
  private picks = new Map<string, GPUComputePipeline>()
  private deposits = new Map<string, GPUComputePipeline>()
  private bakes = new Map<string, GPUComputePipeline>()
  private masks = new Map<boolean, { sample: GPUComputePipeline; blurH: GPUComputePipeline; finish: GPUComputePipeline }>()
  private maskShows = new Map<string, GPUComputePipeline>()
  private rasterP: GPUComputePipeline | null = null
  private paints = new Map<string, GPUComputePipeline>()
  private warps = new Map<string, GPUComputePipeline>()
  /** Stands in for a binding a dispatch doesn't use. */
  readonly dummy: GPUBuffer

  constructor(
    private device: GPUDevice,
    readonly canvasFormat: GPUTextureFormat,
  ) {
    this.dummy = device.createBuffer({ label: 'unused binding', size: 64, usage: GPUBufferUsage.STORAGE })
  }

  private module(label: string, code: string) {
    return this.device.createShaderModule({ label, code })
  }

  compositePipeline(v: CompositeVariant): GPUComputePipeline {
    const key = variantKey(v)
    let p = this.composite.get(key)
    if (!p) {
      p = this.device.createComputePipeline({
        label: `composite ${key}`,
        layout: 'auto',
        compute: { module: this.module(`composite ${key}`, compositeWgsl(v)), entryPoint: 'main' },
      })
      this.composite.set(key, p)
    }
    return p
  }

  /** Stamping dabs into stroke tiles. */
  stampPipeline(): GPUComputePipeline {
    this.stamp ??= this.device.createComputePipeline({ label: 'stamp dabs', layout: 'auto', compute: { module: this.module('stamp', stampWgsl), entryPoint: 'main' } })
    return this.stamp
  }

  /** Smudge and the Mixer picking up what's under a dab (shaders/sample.ts), per document format. */
  pickPipeline(mode: ColourMode, depth: Depth): GPUComputePipeline {
    const key = `${mode}/${depth}`
    let p = this.picks.get(key)
    if (!p) {
      p = this.device.createComputePipeline({ label: `pick ${key}`, layout: 'auto', compute: { module: this.module(`pick ${key}`, pickWgsl(mode, depth)), entryPoint: 'pick' } })
      this.picks.set(key, p)
    }
    return p
  }

  /** Picking up with Sample All Layers, from the composite, per buffer format. */
  pickAllPipeline(f: BufferFormat): GPUComputePipeline {
    const key = `all ${f.mode}/${f.store}`
    let p = this.picks.get(key)
    if (!p) {
      p = this.device.createComputePipeline({ label: `pick ${key}`, layout: 'auto', compute: { module: this.module(`pick ${key}`, pickAllWgsl(f)), entryPoint: 'pick' } })
      this.picks.set(key, p)
    }
    return p
  }

  /** The Clone Stamp's dabs: from the layer through the atlas, or from the composite (keyed by its format). */
  clonePipeline(mode: ColourMode, depth: Depth, source: 'layer' | 'composite', comp: BufferFormat): GPUComputePipeline {
    const key = `clone ${mode}/${depth}/${source}/${comp.store}`
    let p = this.picks.get(key)
    if (!p) {
      p = this.device.createComputePipeline({ label: key, layout: 'auto', compute: { module: this.module(key, cloneWgsl(mode, depth, source, comp)), entryPoint: 'clone' } })
      this.picks.set(key, p)
    }
    return p
  }

  /** And putting it down. */
  depositPipeline(mode: ColourMode): GPUComputePipeline {
    let p = this.deposits.get(mode)
    if (!p) {
      p = this.device.createComputePipeline({ label: `deposit ${mode}`, layout: 'auto', compute: { module: this.module(`deposit ${mode}`, depositWgsl(mode)), entryPoint: 'deposit' } })
      this.deposits.set(mode, p)
    }
    return p
  }

  /** Baking a stroke into its tiles: the stroke variant's second entry point. */
  bakePipeline(v: CompositeVariant): GPUComputePipeline {
    const key = variantKey(v)
    let p = this.bakes.get(key)
    if (!p) {
      p = this.device.createComputePipeline({ label: `bake ${key}`, layout: 'auto', compute: { module: this.module(`bake ${key}`, compositeWgsl(v)), entryPoint: 'bake' } })
      this.bakes.set(key, p)
    }
    return p
  }

  /** Evaluating masks (shaders/mask.ts): one pipeline per entry point. */
  maskPipelines(stroke = false) {
    let p = this.masks.get(stroke)
    if (!p) {
      const module = this.module(stroke ? 'mask with stroke' : 'mask', maskWgsl(stroke))
      const make = (entryPoint: string) => this.device.createComputePipeline({ label: `mask ${entryPoint}${stroke ? ' with stroke' : ''}`, layout: 'auto', compute: { module, entryPoint } })
      p = { sample: make('sample'), blurH: make('blur_h'), finish: make('finish') }
      this.masks.set(stroke, p)
    }
    return p
  }

  /** A mask's coverage as a gray image in a document's format, for its thumbnail. */
  maskShowPipeline(f: BufferFormat): GPUComputePipeline {
    const key = `${f.mode}/${f.store}`
    let p = this.maskShows.get(key)
    if (!p) {
      p = this.device.createComputePipeline({ label: `mask show ${key}`, layout: 'auto', compute: { module: this.module(`mask show ${key}`, maskShowWgsl(f)), entryPoint: 'main' } })
      this.maskShows.set(key, p)
    }
    return p
  }

  displayPipelines(f: BufferFormat) {
    const key = `${f.mode}/${f.store}`
    let p = this.display.get(key)
    if (!p) {
      const module = this.module(`display ${key}`, displayWgsl(f))
      const make = (entryPoint: string) => this.device.createComputePipeline({ label: `display ${entryPoint} ${key}`, layout: 'auto', compute: { module, entryPoint } })
      p = { tile: make('to_tile'), bytes: make('to_bytes'), probe: make('probe'), probeLook: make('probe_look') }
      this.display.set(key, p)
    }
    return p
  }

  mipPipeline(mode: ColourMode, depth: Depth): GPURenderPipeline {
    const key = `${mode}/${depth}`
    let p = this.mip.get(key)
    if (!p) {
      const module = this.module(`mip ${key}`, mipWgsl(mode, depth))
      p = this.device.createRenderPipeline({
        label: `mip ${key}`,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: tileFormats(mode, depth).map((format) => ({ format })) },
        primitive: { topology: 'triangle-list' },
      })
      this.mip.set(key, p)
    }
    return p
  }

  /** Planar samples from a storage buffer into an atlas layer (shaders/upload.ts). */
  uploadPipeline(mode: ColourMode, depth: Depth): GPURenderPipeline {
    const key = `${mode}/${depth}`
    let p = this.upload.get(key)
    if (!p) {
      const module = this.module(`upload ${key}`, uploadWgsl(mode, depth))
      p = this.device.createRenderPipeline({
        label: `upload ${key}`,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: tileFormats(mode, depth).map((format) => ({ format })) },
        primitive: { topology: 'triangle-list' },
      })
      this.upload.set(key, p)
    }
    return p
  }

  screen(): GPURenderPipeline {
    if (!this.screenPipeline) {
      const module = this.module('screen', screenWgsl)
      const F = GPUShaderStage.FRAGMENT
      // Spelt out: the selection's atlas is r32float, which an automatic
      // layout would expect to be filterable.
      const layout = this.device.createBindGroupLayout({
        label: 'screen',
        entries: [
          { binding: 0, visibility: F, buffer: { type: 'uniform' } },
          { binding: 1, visibility: F, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: F, texture: { sampleType: 'float', viewDimension: '2d-array' } },
          { binding: 3, visibility: F, buffer: { type: 'read-only-storage' } },
          { binding: 4, visibility: F, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
        ],
      })
      this.screenPipeline = this.device.createRenderPipeline({
        label: 'screen',
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: this.canvasFormat }] },
        primitive: { topology: 'triangle-list' },
      })
    }
    return this.screenPipeline
  }

  /** Running an adjustment's program on a composite tile, in place. */
  adjustPipeline(f: BufferFormat): GPUComputePipeline {
    const key = `${f.mode}/${f.store}`
    let p = this.adjusts.get(key)
    if (!p) {
      p = this.device.createComputePipeline({ label: `adjust ${key}`, layout: 'auto', compute: { module: this.module(`adjust ${key}`, adjustWgsl(f)), entryPoint: 'main' } })
      this.adjusts.set(key, p)
    }
    return p
  }

  /** One of the live filters' kernels (shaders/filter.ts), for a composite format. */
  filterPipeline(f: BufferFormat, entry: string): GPUComputePipeline {
    const key = `${f.mode}/${f.store}/${entry}`
    let p = this.filters.get(key)
    if (!p) {
      const mk = `${f.mode}/${f.store}`
      let module = this.filterModules.get(mk)
      if (!module) {
        module = this.module(`filters ${mk}`, filterWgsl(f))
        this.filterModules.set(mk, module)
      }
      p = this.device.createComputePipeline({ label: `filter ${key}`, layout: 'auto', compute: { module, entryPoint: entry } })
      this.filters.set(key, p)
    }
    return p
  }

  /** Geometric effects (shaders/warp.ts): regions are f32 whatever the tiles, so one per colour mode. */
  warpPipeline(mode: ColourMode): GPUComputePipeline {
    let p = this.warps.get(mode)
    if (!p) {
      p = this.device.createComputePipeline({ label: `warp ${mode}`, layout: 'auto', compute: { module: this.module(`warp ${mode}`, warpWgsl(mode)), entryPoint: 'warp' } })
      this.warps.set(mode, p)
    }
    return p
  }

  /** Vector coverage (shaders/vector.ts): one pipeline for every format, since it writes plain f32. */
  rasterPipeline(): GPUComputePipeline {
    return (this.rasterP ??= this.device.createComputePipeline({ label: 'vector raster', layout: 'auto', compute: { module: this.module('vector raster', RASTER_WGSL), entryPoint: 'raster' } }))
  }

  /** Coverage times a paint into a composite tile (shaders/vector.ts). */
  paintPipeline(f: BufferFormat): GPUComputePipeline {
    const key = `${f.mode}/${f.store}`
    let p = this.paints.get(key)
    if (!p) {
      p = this.device.createComputePipeline({ label: `vector paint ${key}`, layout: 'auto', compute: { module: this.module(`vector paint ${key}`, paintWgsl(f)), entryPoint: 'paint' } })
      this.paints.set(key, p)
    }
    return p
  }

  /** One of the layer effects' kernels (shaders/fx.ts), for a colour mode. */
  fxPipeline(f: BufferFormat, entry: string): GPUComputePipeline {
    const key = `${f.mode}/${entry}`
    let p = this.fxs.get(key)
    if (!p) {
      let module = this.fxModules.get(f.mode)
      if (!module) {
        module = this.module(`fx ${f.mode}`, fxWgsl(f))
        this.fxModules.set(f.mode, module)
      }
      p = this.device.createComputePipeline({ label: `fx ${key}`, layout: 'auto', compute: { module, entryPoint: entry } })
      this.fxs.set(key, p)
    }
    return p
  }

  /** A composite tile into a tile atlas slot: a smart object's contents. */
  storePipeline(f: BufferFormat, depth: Depth): GPURenderPipeline {
    const key = `${f.mode}/${f.store}/${depth}`
    let p = this.stores.get(key)
    if (!p) {
      const module = this.module(`store ${key}`, storeWgsl(f, depth))
      p = this.device.createRenderPipeline({
        label: `store ${key}`,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: tileFormats(f.mode, depth).map((format) => ({ format })) },
        primitive: { topology: 'triangle-list' },
      })
      this.stores.set(key, p)
    }
    return p
  }

  /** The overlay's lines and handles, drawn after the screen in its pass. */
  overlayPipeline(): GPURenderPipeline {
    if (!this.overlay) {
      const module = this.module('overlay', overlayWgsl)
      this.overlay = this.device.createRenderPipeline({
        label: 'overlay',
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        // Blended: a text selection's highlight lets the text show through. Every other ink is opaque.
        fragment: { module, entryPoint: 'fs', targets: [{ format: this.canvasFormat, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
        primitive: { topology: 'triangle-list' },
      })
    }
    return this.overlay
  }
}
