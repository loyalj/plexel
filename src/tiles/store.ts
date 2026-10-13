/**
 * The tile store: every pixel of every open document, in 256-pixel tiles.
 *
 * A **tile set** is a layer's pixels: an immutable map from tile
 * coordinates to tiles, under an id the document holds. A tile missing from
 * the map is transparent. Changing pixels never changes a set; it makes a
 * new one (`derive`) that shares every tile it didn't touch, and the
 * document swaps one id for the other. That is the whole of pixel undo: the
 * old set is still there, and undo points the layer back at it.
 *
 * A **tile** is either uniform (one value for every pixel, stored as that
 * value: a filled background costs bytes, not megabytes) or data, held in
 * fixed-size slots carved from large slabs, shared memory when the page is
 * cross-origin isolated. Tiles are reference-counted by the sets that hold
 * them, and sets are kept alive by the caller saying which are still in
 * use (`gc`), which is every set any open document's history refers to.
 *
 * Memory is held to a budget. Past it, the data tiles used least recently
 * are spilled (spill.ts) and their slots reused, and read back when they
 * are next asked for.
 *
 * Nothing here touches the DOM or the GPU, so all of it runs in Node.
 */
import { TILE, formatKey, newSamples, planesOf, tileBytes, tileSamples, type Samples, type TileFormat } from './format'
import type { SpillStore } from './spill'

export type TileId = number
export type SetId = string

interface Pool {
  bytes: number
  slabs: ArrayBufferLike[]
  free: number[]
  perSlab: number
}

interface TileRec {
  id: TileId
  format: TileFormat
  /** How many set entries hold this tile. */
  refs: number
  uniform: number[] | null
  /** Where a resident data tile's samples are, as a slot in its format's pool. */
  slot: number | null
  /** Bytes on their way to the spill store, still readable until the write lands. */
  pending: Uint8Array | null
  spilled: boolean
  hash: string | null
  /** Where an unread tile's bytes are in a file, for a tile read on demand. */
  lazy: LazySource | null
}

/**
 * A tile still in the file it came from: `length` bytes at `offset` in
 * `blob`, stored as pack.ts stores tiles. Read when first needed; when
 * memory runs short it's dropped rather than spilled, since the file
 * still has it.
 */
export interface LazySource {
  blob: Blob
  offset: number
  length: number
  kind: number
  decode(kind: number, bytes: Uint8Array): Promise<Samples>
}

interface SetRec {
  id: SetId
  format: TileFormat
  tiles: ReadonlyMap<string, TileId>
  /** Worked out on first use. */
  extent?: { x0: number; y0: number; x1: number; y1: number } | null
}

export interface StoreStats {
  sets: number
  tiles: number
  uniformTiles: number
  dataTiles: number
  residentTiles: number
  residentBytes: number
  spilledTiles: number
  slabBytes: number
  budget: number
}

/** Slab size: about 8 MB, rounded to whole tiles. */
const SLAB_TARGET = 8 * 1024 * 1024
const key = (x: number, y: number) => `${x},${y}`
export const parseKey = (k: string) => k.split(',').map(Number) as [number, number]

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

export class TileStore {
  private tiles = new Map<TileId, TileRec>()
  private sets = new Map<SetId, SetRec>()
  private pools = new Map<string, Pool>()
  /** Resident data tiles, least recently used first (a Map keeps insertion order). */
  private lru = new Map<TileId, TileRec>()
  private uniforms = new Map<string, TileId>()
  private nextTile = 1
  private residentBytes = 0
  private writes = new Set<Promise<void>>()
  private shared: boolean

  constructor(
    private opts: { budget: number; spill: SpillStore; shared?: boolean; newSetId?: () => SetId },
  ) {
    this.shared = opts.shared ?? (typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true)
    if (!littleEndian) throw new Error('The tile store assumes a little-endian machine')
  }

  /** Changes where tiles spill to. Only before anything has spilled: tiles already out stay where they went. */
  setSpill(spill: SpillStore) {
    this.opts.spill = spill
  }

  setBudget(bytes: number) {
    this.opts.budget = bytes
    this.enforce()
  }

  // --- memory ---------------------------------------------------------------

  private pool(f: TileFormat): Pool {
    const k = formatKey(f)
    let p = this.pools.get(k)
    if (!p) {
      const bytes = tileBytes(f)
      p = { bytes, slabs: [], free: [], perSlab: Math.max(1, Math.floor(SLAB_TARGET / bytes)) }
      this.pools.set(k, p)
    }
    return p
  }

  private alloc(f: TileFormat): number {
    const p = this.pool(f)
    if (!p.free.length) {
      const base = p.slabs.length * p.perSlab
      const size = p.perSlab * p.bytes
      p.slabs.push(this.shared ? new SharedArrayBuffer(size) : new ArrayBuffer(size))
      for (let i = p.perSlab - 1; i >= 0; i--) p.free.push(base + i)
    }
    return p.free.pop()!
  }

  private bytesAt(f: TileFormat, slot: number): Uint8Array {
    const p = this.pool(f)
    const slab = p.slabs[Math.floor(slot / p.perSlab)]
    return new Uint8Array(slab, (slot % p.perSlab) * p.bytes, p.bytes)
  }

  private samplesAt(f: TileFormat, slot: number): Samples {
    const b = this.bytesAt(f, slot)
    return f.depth === 16 ? new Uint16Array(b.buffer, b.byteOffset, tileSamples(f)) : b
  }

  private release(rec: TileRec) {
    if (rec.slot === null) return
    this.pool(rec.format).free.push(rec.slot)
    this.residentBytes -= tileBytes(rec.format)
    rec.slot = null
    this.lru.delete(rec.id)
  }

  private touch(rec: TileRec) {
    this.lru.delete(rec.id)
    this.lru.set(rec.id, rec)
  }

  /** Spills the least recently used tiles until memory is within the budget. */
  private enforce(keep?: TileId) {
    for (const rec of this.lru.values()) {
      if (this.residentBytes <= this.opts.budget) break
      if (rec.id === keep) continue
      if (rec.lazy) {
        // Still in its file: let it go, and read it again when it's wanted.
        this.release(rec)
        continue
      }
      const bytes = this.bytesAt(rec.format, rec.slot!).slice()
      this.release(rec)
      rec.pending = bytes
      rec.spilled = true
      const w = this.opts.spill
        .write(rec.id, bytes)
        .then(() => {
          if (rec.pending === bytes) rec.pending = null
        })
        .finally(() => this.writes.delete(w))
      this.writes.add(w)
    }
  }

  /** Waits for every spill write in flight; for the checks and for a clean shutdown. */
  async settle() {
    while (this.writes.size) await Promise.all([...this.writes])
  }

  // --- tiles -----------------------------------------------------------------

  /** A tile with one value for every pixel: one sample per plane, alpha last. Equal values share a tile. */
  uniform(f: TileFormat, value: number[]): TileId {
    if (value.length !== planesOf(f)) throw new Error(`A ${f.mode} tile needs ${planesOf(f)} values, not ${value.length}`)
    const k = `${formatKey(f)}:${value.join(',')}`
    const found = this.uniforms.get(k)
    if (found !== undefined) return found
    const id = this.nextTile++
    this.tiles.set(id, { id, format: f, refs: 0, uniform: [...value], slot: null, pending: null, spilled: false, hash: null, lazy: null })
    this.uniforms.set(k, id)
    return id
  }

  /**
   * A tile from its samples, planar, copied in. A tile whose every plane
   * holds one value becomes a uniform tile, so a fill never costs a slot.
   */
  data(f: TileFormat, samples: Samples): TileId {
    if (samples.length !== tileSamples(f)) throw new Error(`A ${f.mode}/${f.depth} tile has ${tileSamples(f)} samples, not ${samples.length}`)
    const uniform = uniformValue(f, samples)
    if (uniform) return this.uniform(f, uniform)
    const id = this.nextTile++
    const slot = this.alloc(f)
    this.samplesAt(f, slot).set(samples)
    const rec: TileRec = { id, format: f, refs: 0, uniform: null, slot, pending: null, spilled: false, hash: null, lazy: null }
    this.tiles.set(id, rec)
    this.residentBytes += tileBytes(f)
    this.touch(rec)
    this.enforce(id)
    return id
  }

  /** A tile that stays in its file until it's first read (LazySource). */
  lazy(f: TileFormat, source: LazySource): TileId {
    const id = this.nextTile++
    this.tiles.set(id, { id, format: f, refs: 0, uniform: null, slot: null, pending: null, spilled: false, hash: null, lazy: source })
    return id
  }

  /**
   * Reads every tile still waiting in `blob` and cuts it loose from the
   * file: the file is about to be overwritten. Tiles past the memory
   * budget spill as usual. Returns how many were read.
   */
  async materialize(blob: Blob): Promise<number> {
    let n = 0
    for (const rec of [...this.tiles.values()]) {
      if (rec.lazy?.blob !== blob) continue
      if (rec.slot === null) await this.load(rec)
      // In memory now, and kept there through the load, so from here on
      // it spills like any other tile.
      rec.lazy = null
      n++
    }
    return n
  }

  private rec(id: TileId): TileRec {
    const r = this.tiles.get(id)
    if (!r) throw new Error(`No tile ${id}`)
    return r
  }

  isUniform(id: TileId): number[] | null {
    return this.rec(id).uniform
  }

  formatOf(id: TileId): TileFormat {
    return this.rec(id).format
  }

  /** A tile's samples, as a copy, reading it back in first if it was spilled. */
  async samples(id: TileId): Promise<Samples> {
    const rec = this.rec(id)
    if (rec.uniform) {
      const out = newSamples(rec.format)
      for (let p = 0; p < rec.uniform.length; p++) out.fill(rec.uniform[p], p * TILE * TILE, (p + 1) * TILE * TILE)
      return out
    }
    if (rec.slot === null) await this.load(rec)
    this.touch(rec)
    return this.samplesAt(rec.format, rec.slot!).slice()
  }

  /**
   * A data tile's samples right now, without a copy, if it's in memory;
   * null if it has to be read back first (`prefetch` starts that). The
   * view is valid until the store next changes, so it's for reading at
   * once: the renderer uploads it to the GPU and lets it go.
   */
  peek(id: TileId): Samples | null {
    const rec = this.rec(id)
    if (rec.uniform || rec.slot === null) return null
    this.touch(rec)
    return this.samplesAt(rec.format, rec.slot)
  }

  /** Reads a spilled tile back into memory, for `peek`. */
  async prefetch(id: TileId): Promise<void> {
    const rec = this.rec(id)
    if (rec.uniform || rec.slot !== null) return
    await this.load(rec)
  }

  private async load(rec: TileRec) {
    if (rec.lazy && !rec.spilled) {
      const l = rec.lazy
      const samples = await l.decode(l.kind, new Uint8Array(await l.blob.slice(l.offset, l.offset + l.length).arrayBuffer()))
      if (rec.slot !== null) return
      const slot = this.alloc(rec.format)
      this.samplesAt(rec.format, slot).set(samples)
      rec.slot = slot
      this.residentBytes += tileBytes(rec.format)
      this.touch(rec)
      this.enforce(rec.id)
      return
    }
    const bytes = rec.pending ?? (await this.opts.spill.read(rec.id))
    if (rec.slot !== null) return
    const slot = this.alloc(rec.format)
    this.bytesAt(rec.format, slot).set(bytes)
    rec.slot = slot
    rec.pending = null
    rec.spilled = false
    this.residentBytes += tileBytes(rec.format)
    this.touch(rec)
    void this.opts.spill.remove(rec.id).catch(() => {})
    this.enforce(rec.id)
  }

  /** A content hash of the tile, for the journal: tiles with equal pixels hash equal. */
  async hashOf(id: TileId): Promise<string> {
    const rec = this.rec(id)
    if (rec.hash) return rec.hash
    const head = new TextEncoder().encode(`${formatKey(rec.format)}:${rec.uniform ? 'u' + rec.uniform.join(',') : 'd'}:`)
    let body: Uint8Array = new Uint8Array(0)
    if (!rec.uniform) {
      const s = await this.samples(id)
      body = new Uint8Array(s.buffer, s.byteOffset, s.byteLength)
    }
    const all = new Uint8Array(head.length + body.length)
    all.set(head)
    all.set(body, head.length)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all))
    rec.hash = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
    return rec.hash
  }

  // --- sets ------------------------------------------------------------------

  private newSetId(): SetId {
    if (this.opts.newSetId) return this.opts.newSetId()
    const b = new Uint8Array(9)
    crypto.getRandomValues(b)
    return 't' + [...b].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 14)
  }

  private holdAll(tiles: ReadonlyMap<string, TileId>) {
    for (const id of tiles.values()) this.rec(id).refs++
  }

  /**
   * A new set from tile coordinates and tiles. `id` is for sets arriving
   * from a file or the journal, which keep their ids; a set with that id
   * already here is the same set (ids are never reused), and is returned as
   * it is.
   */
  createSet(f: TileFormat, entries: Iterable<[number, number, TileId]>, id?: SetId): SetId {
    if (id && this.sets.has(id)) return id
    const tiles = new Map<string, TileId>()
    for (const [x, y, t] of entries) {
      if (formatKey(this.rec(t).format) !== formatKey(f)) throw new Error('A tile set can only hold tiles of its own format')
      tiles.set(key(x, y), t)
    }
    const sid = id ?? this.newSetId()
    this.holdAll(tiles)
    this.sets.set(sid, { id: sid, format: f, tiles })
    return sid
  }

  /** A new set: `from` with some tiles replaced, and null removing one. Every other tile is shared. */
  derive(from: SetId, changes: Iterable<[number, number, TileId | null]>): SetId {
    const base = this.setRec(from)
    const tiles = new Map(base.tiles)
    for (const [x, y, t] of changes) {
      if (t === null) tiles.delete(key(x, y))
      else {
        if (formatKey(this.rec(t).format) !== formatKey(base.format)) throw new Error('A tile set can only hold tiles of its own format')
        tiles.set(key(x, y), t)
      }
    }
    const sid = this.newSetId()
    this.holdAll(tiles)
    this.sets.set(sid, { id: sid, format: base.format, tiles })
    return sid
  }

  private setRec(id: SetId): SetRec {
    const s = this.sets.get(id)
    if (!s) throw new Error(`No tile set ${id}`)
    return s
  }

  hasSet(id: SetId) {
    return this.sets.has(id)
  }

  /** A set's format and its tiles by coordinate, read-only. */
  getSet(id: SetId): { format: TileFormat; tiles: ReadonlyMap<string, TileId> } {
    const s = this.setRec(id)
    return { format: s.format, tiles: s.tiles }
  }

  /** The tile coordinates a set reaches, inclusive, or null when it has no tiles. Sets never change, so this is worked out once. */
  extent(id: SetId): { x0: number; y0: number; x1: number; y1: number } | null {
    const s = this.setRec(id)
    if (s.extent !== undefined) return s.extent
    let e: { x0: number; y0: number; x1: number; y1: number } | null = null
    for (const k of s.tiles.keys()) {
      const [x, y] = parseKey(k)
      e = e ? { x0: Math.min(e.x0, x), y0: Math.min(e.y0, y), x1: Math.max(e.x1, x), y1: Math.max(e.y1, y) } : { x0: x, y0: y, x1: x, y1: y }
    }
    s.extent = e
    return e
  }

  /** The tile at (x, y) in a set, or undefined where it's transparent. */
  tileAt(id: SetId, x: number, y: number): TileId | undefined {
    return this.setRec(id).tiles.get(key(x, y))
  }

  /** What a set looks like, cheaply: empty, one value throughout, or mixed. For thumbnails and checks. */
  describe(id: SetId): { kind: 'empty' } | { kind: 'uniform'; value: number[]; tiles: number } | { kind: 'mixed'; tiles: number } {
    const s = this.setRec(id)
    if (!s.tiles.size) return { kind: 'empty' }
    let first: TileId | null = null
    for (const t of s.tiles.values()) {
      if (first === null) first = t
      if (t !== first || !this.rec(t).uniform) return { kind: 'mixed', tiles: s.tiles.size }
    }
    return { kind: 'uniform', value: [...this.rec(first!).uniform!], tiles: s.tiles.size }
  }

  /**
   * Frees every set not in `live`, then every tile no set holds. Returns
   * how much went. The caller passes every set id any open document's
   * history, autosave or save in progress still refers to.
   */
  gc(live: Iterable<SetId>): { sets: number; tiles: number } {
    const keep = new Set(live)
    let sets = 0
    for (const s of [...this.sets.values()]) {
      if (keep.has(s.id)) continue
      for (const t of s.tiles.values()) this.rec(t).refs--
      this.sets.delete(s.id)
      sets++
    }
    let tiles = 0
    for (const rec of [...this.tiles.values()]) {
      if (rec.refs > 0) continue
      this.release(rec)
      if (rec.spilled) void this.opts.spill.remove(rec.id).catch(() => {})
      if (rec.uniform) this.uniforms.delete(`${formatKey(rec.format)}:${rec.uniform.join(',')}`)
      this.tiles.delete(rec.id)
      tiles++
    }
    return { sets, tiles }
  }

  stats(): StoreStats {
    let uniformTiles = 0
    let spilledTiles = 0
    for (const t of this.tiles.values()) {
      if (t.uniform) uniformTiles++
      else if (t.slot === null) spilledTiles++
    }
    let slabBytes = 0
    for (const p of this.pools.values()) slabBytes += p.slabs.length * p.perSlab * p.bytes
    return {
      sets: this.sets.size,
      tiles: this.tiles.size,
      uniformTiles,
      dataTiles: this.tiles.size - uniformTiles,
      residentTiles: this.lru.size,
      residentBytes: this.residentBytes,
      spilledTiles,
      slabBytes,
      budget: this.opts.budget,
    }
  }
}

/** The one value of every plane, if each plane holds only one; otherwise null. */
function uniformValue(f: TileFormat, s: Samples): number[] | null {
  const n = TILE * TILE
  const out: number[] = []
  for (let p = 0; p < planesOf(f); p++) {
    const v = s[p * n]
    for (let i = p * n + 1; i < (p + 1) * n; i++) if (s[i] !== v) return null
    out.push(v)
  }
  return out
}
