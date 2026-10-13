/**
 * Texture-array atlases with least-recently-used eviction: tiles on the
 * GPU (ARCHITECTURE.md, "GPU residency").
 *
 * Each slot is one 256 × 256 layer of a 2D array texture, so any number of
 * tiles can be read through a single binding. An atlas starts small and
 * doubles (copying what it holds) up to its budget; past that, the slot used
 * least recently is reused. Slots used in the frame being built are
 * pinned: a queue write lands before the frame's commands run, so reusing
 * one mid-frame would change what an earlier command reads.
 *
 * A growth copies what the atlas holds into the bigger textures inside the
 * frame's own command encoder, so it lands after the frame's earlier
 * commands have written into the old ones; the old slots stay pinned for
 * the rest of the frame, so nothing queued writes into one before that
 * copy runs. The replaced textures are destroyed once the frame has been
 * submitted (`afterSubmit`).
 */
import type { ColourMode, Depth } from '../../doc/types'
import { TILE, TILE_PIXELS, planesOf, type Samples } from '../../tiles/format'

export interface AtlasOptions {
  label: string
  /** The textures' formats: one for most, two for CMYK's five planes. */
  formats: GPUTextureFormat[]
  usage: GPUTextureUsageFlags
  bytesPerLayer: number
  budget: number
  start?: number
  /** The command encoder of the frame being built, if one is: a growth is recorded there. */
  encoder?: () => GPUCommandEncoder | null
}

export class Atlas<K = string> {
  textures: GPUTexture[] = []
  capacity = 0
  private maxLayers: number
  private slots = new Map<K, number>()
  private keys: (K | undefined)[] = []
  private free: number[] = []
  private pinned = new Set<number>()
  private doomed: GPUTexture[] = []

  constructor(
    private device: GPUDevice,
    private o: AtlasOptions,
  ) {
    this.maxLayers = Math.max(8, Math.min(device.limits.maxTextureArrayLayers, Math.floor(o.budget / o.bytesPerLayer)))
    this.resize(Math.min(this.maxLayers, o.start ?? 32))
  }

  private resize(layers: number) {
    const next = this.o.formats.map((format, i) =>
      this.device.createTexture({
        label: `${this.o.label}${i ? ` ${i}` : ''}`,
        size: [TILE, TILE, layers],
        format,
        usage: this.o.usage | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      }),
    )
    if (this.textures.length && this.capacity) {
      const frame = this.o.encoder?.() ?? null
      const enc = frame ?? this.device.createCommandEncoder({ label: `${this.o.label} grow` })
      this.textures.forEach((t, i) => enc.copyTextureToTexture({ texture: t }, { texture: next[i] }, [TILE, TILE, this.capacity]))
      if (!frame) this.device.queue.submit([enc.finish()])
      this.doomed.push(...this.textures)
      for (let s = 0; s < this.capacity; s++) this.pinned.add(s)
    }
    for (let l = layers - 1; l >= this.capacity; l--) this.free.push(l)
    this.keys.length = layers
    this.textures = next
    this.capacity = layers
  }

  /** The slot holding `key`, marked as used now, or undefined. */
  get(key: K): number | undefined {
    const s = this.slots.get(key)
    if (s === undefined) return undefined
    this.slots.delete(key)
    this.slots.set(key, s)
    this.pinned.add(s)
    return s
  }

  has(key: K) {
    return this.slots.has(key)
  }

  /**
   * A slot for `key`, pinned for this frame. Grows the atlas if it can,
   * otherwise takes the least recently used unpinned slot. Null when every
   * slot is pinned: the frame asked for more than the budget holds.
   */
  alloc(key: K): number | null {
    const had = this.get(key)
    if (had !== undefined) return had
    if (!this.free.length && this.capacity < this.maxLayers) this.resize(Math.min(this.maxLayers, this.capacity * 2))
    let slot = this.free.pop()
    if (slot === undefined) {
      for (const [k, s] of this.slots) {
        if (this.pinned.has(s)) continue
        this.slots.delete(k)
        this.onEvict?.(k)
        slot = s
        break
      }
    }
    if (slot === undefined) return null
    this.slots.set(key, slot)
    this.keys[slot] = key
    this.pinned.add(slot)
    return slot
  }

  /** Called when a key loses its slot to another. */
  onEvict: ((key: K) => void) | null = null

  drop(key: K) {
    const s = this.slots.get(key)
    if (s === undefined) return
    this.slots.delete(key)
    this.keys[s] = undefined
    this.pinned.delete(s)
    this.free.push(s)
  }

  /** Every key held, least recently used first. */
  held(): K[] {
    return [...this.slots.keys()]
  }

  /** A new frame: nothing is pinned. */
  beginFrame() {
    this.pinned.clear()
  }

  /** The frame is submitted: textures a growth replaced can go. */
  afterSubmit() {
    for (const t of this.doomed.splice(0)) t.destroy()
  }

  get used() {
    return this.slots.size
  }

  get bytes() {
    return this.capacity * this.o.bytesPerLayer
  }

  destroy() {
    for (const t of [...this.textures, ...this.doomed]) t.destroy()
    this.textures = []
    this.doomed = []
  }
}

/** The atlas formats for a document's tiles: the colour planes (and alpha) in A, CMYK's alpha in B. */
export function tileFormats(mode: ColourMode, depth: Depth): GPUTextureFormat[] {
  const a: GPUTextureFormat = depth === 16 ? 'rgba16uint' : 'rgba8unorm'
  const b: GPUTextureFormat = depth === 16 ? 'r16uint' : 'r8unorm'
  return mode === 'cmyk' ? [a, b] : [a]
}

export const tileLayerBytes = (mode: ColourMode, depth: Depth) => TILE_PIXELS * (depth / 8) * (mode === 'cmyk' ? 5 : 4)

/**
 * A tile's planar samples, interleaved as the atlas textures hold them: RGB
 * as RGBA, Gray as gray and alpha in the first two of four, CMYK as CMYK
 * plus a separate alpha plane.
 */
export function interleave(mode: ColourMode, depth: Depth, s: Samples): (Uint8Array | Uint16Array)[] {
  const planes = planesOf({ mode, depth })
  const used = mode === 'gray' ? 2 : 4
  const N = TILE_PIXELS
  // Whole pixels at a time, as 32-bit words: four times fewer stores than
  // sample by sample, which is most of what an upload costs the CPU.
  const words = new Uint32Array(N * (depth / 8))
  if (depth === 8) {
    for (let i = 0; i < N; i++) words[i] = s[i] | (s[N + i] << 8) | (used === 4 ? (s[2 * N + i] << 16) | (s[3 * N + i] << 24) : 0)
  } else {
    for (let i = 0; i < N; i++) {
      words[2 * i] = s[i] | (s[N + i] << 16)
      words[2 * i + 1] = used === 4 ? s[2 * N + i] | (s[3 * N + i] << 16) : 0
    }
  }
  const A = depth === 16 ? new Uint16Array(words.buffer) : new Uint8Array(words.buffer)
  if (mode !== 'cmyk') return [A]
  const B = s.subarray((planes - 1) * TILE_PIXELS, planes * TILE_PIXELS)
  return [A, depth === 16 ? new Uint16Array(B) : new Uint8Array(B)]
}

/** Writes a tile's samples into an atlas slot. */
export function uploadTile<K>(device: GPUDevice, atlas: Atlas<K>, slot: number, mode: ColourMode, depth: Depth, s: Samples) {
  const parts = interleave(mode, depth, s)
  parts.forEach((data, i) => {
    const channels = i === 0 ? 4 : 1
    device.queue.writeTexture(
      { texture: atlas.textures[i], origin: [0, 0, slot] },
      data as Uint8Array<ArrayBuffer>,
      { bytesPerRow: TILE * channels * (depth / 8), rowsPerImage: TILE },
      [TILE, TILE, 1],
    )
  })
}
