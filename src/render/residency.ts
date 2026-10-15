/**
 * Tiles on the GPU: which of a tile set's tiles, at which mip level, are in
 * the atlas, and getting them there.
 *
 * Level 0 is the tiles themselves, uploaded from the tile store and keyed
 * by tile id, so sets that share a tile (every set derived from another)
 * share its upload. Levels above are built on the GPU from the four tiles
 * below, keyed by what's under them: a hash of the four children's keys.
 * Two sets that share the tiles under a mip tile share the mip tile too, so
 * after a brush stroke only the mips above the tiles it changed are built
 * again, not the layer's whole pyramid.
 *
 * What a mip tile holds is worked out from the store's bookkeeping before
 * any pixels move: four missing children make a missing tile, and four
 * equal uniform ones a uniform tile, so a filled background costs nothing
 * on the GPU at any level.
 */
import type { ColourMode, Depth } from '../doc/types'
import { TILE, maxSample, type TileFormat } from '../tiles/format'
import type { TileId, TileStore } from '../tiles/store'
import { Atlas, tileFormats, tileLayerBytes, uploadTile } from './gpu/atlas'
import type { Kernels, Ring } from './gpu/kernels'
import { MIP_PARAMS_BYTES } from './shaders/mip'

/** What a tile is, at any level: nothing, one value (straight, 0..1, alpha last), or pixels in the atlas. */
export type TileInfo = { kind: 'empty' } | { kind: 'uniform'; value: number[] } | { kind: 'data'; key: string }

/** The answer for a tile in a window: its atlas slot, or what to read instead. */
export type Resolved = { kind: 'empty' } | { kind: 'uniform'; value: number[] } | { kind: 'slot'; slot: number }

export class NotReady extends Error {
  constructor(readonly waits: Promise<void>[]) {
    super('Tiles are still being read back')
  }
}

export class AtlasFull extends Error {}

/** The frame's upload ring is full: the frame stops, and the tile is uploaded next frame. */
export class UploadsFull extends Error {}

const EMPTY = { kind: 'empty' } as const

export class Residency {
  readonly atlas: Atlas<string>
  private infos = new Map<string, TileInfo>()
  private scratch: GPUTexture[]
  private waiting = new Map<TileId, Promise<void>>()
  uploads = 0
  mipsBuilt = 0
  /** Whether `enc` is a frame's: a full upload ring stops a frame, and falls back to the CPU for work outside the frames. */
  isFrame: (enc: GPUCommandEncoder) => boolean = () => false

  constructor(
    private device: GPUDevice,
    private store: TileStore,
    private kernels: Kernels,
    /** Where each mip pass's parameters go, for the frame being built. */
    private params: Ring,
    /** Where uploads' samples go, unchanged, for the GPU to pack into the atlas. */
    private uploadRing: Ring,
    readonly mode: ColourMode,
    readonly depth: Depth,
    budget: number,
    encoder: () => GPUCommandEncoder | null,
  ) {
    this.atlas = new Atlas(device, {
      encoder,
      label: `tiles ${mode}/${depth}`,
      formats: tileFormats(mode, depth),
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      bytesPerLayer: tileLayerBytes(mode, depth),
      budget,
    })
    this.scratch = tileFormats(mode, depth).map((format) =>
      device.createTexture({ label: 'mip scratch', size: [TILE, TILE, 4], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }),
    )
  }

  private get format(): TileFormat {
    return { mode: this.mode, depth: this.depth }
  }

  private straight(value: number[]) {
    const max = maxSample(this.format)
    return value.map((v) => v / max)
  }

  /** What tile (x, y) of `set` at mip `m` holds, from the store's bookkeeping alone. */
  info(set: string, m: number, x: number, y: number): TileInfo {
    const e = this.store.extent(set)
    if (!e || x < e.x0 >> m || y < e.y0 >> m || x > e.x1 >> m || y > e.y1 >> m) return EMPTY
    if (m === 0) {
      const t = this.store.tileAt(set, x, y)
      if (t === undefined) return EMPTY
      const u = this.store.isUniform(t)
      return u ? (u[u.length - 1] === 0 ? EMPTY : { kind: 'uniform', value: this.straight(u) }) : { kind: 'data', key: `t${t}` }
    }
    const key = `${set}/${m}/${x},${y}`
    let info = this.infos.get(key)
    if (!info) {
      const kids = [0, 1, 2, 3].map((i) => this.info(set, m - 1, 2 * x + (i & 1), 2 * y + (i >> 1)))
      if (kids.every((k) => k.kind === 'empty')) info = EMPTY
      else if (kids.every((k) => k.kind === 'uniform' && k.value.join() === (kids[0] as { value: number[] }).value.join())) info = kids[0]
      else info = { kind: 'data', key: `${m}:${contentHash(kids.map((k) => (k.kind === 'data' ? k.key : k.kind === 'uniform' ? `u${k.value.join(',')}` : 'e')).join('|'))}` }
      this.infos.set(key, info)
    }
    return info
  }

  /**
   * Tile (x, y) of `set` at mip `m`, ready to read: uploading it or building
   * it if it has to. Throws NotReady when tiles have to come back from disk
   * first, and AtlasFull when this frame has pinned every slot.
   */
  resolve(enc: GPUCommandEncoder, set: string, m: number, x: number, y: number): Resolved {
    const info = this.info(set, m, x, y)
    if (info.kind !== 'data') return info
    if (m === 0) {
      const t = this.store.tileAt(set, x, y)!
      const key = `t${t}`
      const have = this.atlas.get(key)
      if (have !== undefined) return { kind: 'slot', slot: have }
      const samples = this.store.peek(t)
      if (!samples) throw new NotReady([this.fetch(t)])
      // Packed on the GPU while the upload ring has room. Past that, a frame
      // stops (before taking a slot) and goes on next frame, as it does when
      // the atlas is full; work outside the frames (a thumbnail or export of
      // a big document reads many tiles in one go) interleaves here and
      // writes directly instead.
      const fits = this.uploadRing.fits(samples.byteLength)
      if (!fits && this.isFrame(enc)) throw new UploadsFull()
      const slot = this.atlas.alloc(key)
      if (slot === null) throw new AtlasFull()
      if (fits) this.upload(enc, slot, this.uploadRing.put(samples))
      else uploadTile(this.device, this.atlas, slot, this.mode, this.depth, samples)
      this.uploads++
      return { kind: 'slot', slot }
    }
    const key = `k${info.key}`
    const have = this.atlas.get(key)
    if (have !== undefined) return { kind: 'slot', slot: have }
    const waits: Promise<void>[] = []
    const kids: Resolved[] = []
    for (let i = 0; i < 4; i++) {
      try {
        kids.push(this.resolve(enc, set, m - 1, 2 * x + (i & 1), 2 * y + (i >> 1)))
      } catch (e) {
        if (!(e instanceof NotReady)) throw e
        waits.push(...e.waits)
        kids.push(EMPTY)
      }
    }
    if (waits.length) throw new NotReady(waits)
    const slot = this.atlas.alloc(key)
    if (slot === null) throw new AtlasFull()
    this.buildMip(enc, slot, kids)
    return { kind: 'slot', slot }
  }

  private fetch(t: TileId): Promise<void> {
    let p = this.waiting.get(t)
    if (!p) {
      p = this.store.prefetch(t).finally(() => this.waiting.delete(t))
      this.waiting.set(t, p)
    }
    return p
  }

  /** A tile's planar samples, already in the upload ring, packed into its atlas layer (shaders/upload.ts). */
  private upload(enc: GPUCommandEncoder, slot: number, data: { buffer: GPUBuffer; offset: number; size: number }) {
    const pipeline = this.kernels.uploadPipeline(this.mode, this.depth)
    const pass = enc.beginRenderPass({
      label: 'upload',
      colorAttachments: this.atlas.textures.map((t) => ({
        view: t.createView({ dimension: '2d', baseArrayLayer: slot, arrayLayerCount: 1 }),
        loadOp: 'clear' as const,
        storeOp: 'store' as const,
      })),
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: data.buffer, offset: data.offset, size: data.size } }] }))
    pass.draw(3)
    pass.end()
  }

  private buildMip(enc: GPUCommandEncoder, slot: number, kids: Resolved[]) {
    const params = new ArrayBuffer(MIP_PARAMS_BYTES)
    const kinds = new Uint32Array(params, 0, 4)
    const values = new Float32Array(params, 16)
    kids.forEach((k, i) => {
      if (k.kind === 'slot') {
        kinds[i] = 2
        this.atlas.textures.forEach((t, p) => enc.copyTextureToTexture({ texture: t, origin: [0, 0, k.slot] }, { texture: this.scratch[p], origin: [0, 0, i] }, [TILE, TILE, 1]))
      } else if (k.kind === 'uniform') {
        kinds[i] = 1
        const colour = k.value.slice(0, -1)
        values.set([...colour, ...new Array(4 - colour.length).fill(0)], i * 8)
        values[i * 8 + 4] = k.value[k.value.length - 1]
      }
    })
    const uniform = this.params.put(params)
    const pipeline = this.kernels.mipPipeline(this.mode, this.depth)
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: uniform.buffer, offset: uniform.offset, size: MIP_PARAMS_BYTES } },
      { binding: 1, resource: this.scratch[0].createView({ dimension: '2d-array' }) },
    ]
    if (this.mode === 'cmyk') entries.push({ binding: 2, resource: this.scratch[1].createView({ dimension: '2d-array' }) })
    const pass = enc.beginRenderPass({
      label: 'mip',
      colorAttachments: this.atlas.textures.map((t) => ({
        view: t.createView({ dimension: '2d', baseArrayLayer: slot, arrayLayerCount: 1 }),
        loadOp: 'clear' as const,
        storeOp: 'store' as const,
      })),
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }))
    pass.draw(3)
    pass.end()
    this.mipsBuilt++
  }

  /** Mip bookkeeping for sets nobody holds any more. Their mip tiles go when the atlas needs the room. */
  forget(live: ReadonlySet<string>) {
    for (const k of [...this.infos.keys()]) if (!live.has(k.slice(0, k.indexOf('/')))) this.infos.delete(k)
  }

  destroy() {
    this.atlas.destroy()
    for (const t of this.scratch) t.destroy()
  }
}

/** Two FNV-1a hashes of a string, as one key: short, and collisions are out of reach. */
function contentHash(s: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x5bd1e995)
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`
}
