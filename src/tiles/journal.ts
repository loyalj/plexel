/**
 * Tiles in the autosave journal (io/journal.ts keeps the documents).
 *
 *   tiles/<hash>       one data tile, filtered and deflated, named by the
 *                      SHA-256 of its pixels
 *   sets/<id>.json     a set: its format, and each tile's coordinates with
 *                      either its hash or, for a uniform tile, its value
 *
 * Content addressing is what keeps autosave cheap on a big image: a brush
 * stroke makes a new set that shares all but a few tiles with the old one,
 * so journalling it writes one small manifest and the few new tiles. A
 * tile already in the journal, under any set, is never written again.
 */
import type { JournalStore } from '../io/journal'
import { planesOf, type TileFormat } from './format'
import { KIND_SUB, decodeTile, encodeTile } from './pack'
import { parseKey, type SetId, type TileStore } from './store'

interface Manifest {
  v: 1
  format: TileFormat
  /** [x, y, 'u', ...values] for a uniform tile, [x, y, 'h', hash] for a data tile. */
  tiles: (number | string)[][]
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const validSet = (id: string) => /^[a-z0-9]+$/i.test(id)

export class TileJournal {
  /** Tile hashes known to be in the journal, and sets already written. */
  private blobs: Set<string> | null = null
  private written = new Set<SetId>()

  constructor(
    private store: TileStore,
    private journal: JournalStore,
  ) {}

  private async known(): Promise<Set<string>> {
    if (!this.blobs) this.blobs = new Set(await this.journal.list('tiles'))
    return this.blobs
  }

  /** Writes the sets that aren't in the journal yet. Sets are immutable, so one written is done. */
  async write(ids: Iterable<SetId>): Promise<number> {
    const blobs = await this.known()
    let tilesWritten = 0
    for (const id of ids) {
      if (this.written.has(id) || !this.store.hasSet(id) || !validSet(id)) continue
      const { format, tiles } = this.store.getSet(id)
      const manifest: Manifest = { v: 1, format, tiles: [] }
      for (const [k, t] of tiles) {
        const [x, y] = parseKey(k)
        const u = this.store.isUniform(t)
        if (u) {
          manifest.tiles.push([x, y, 'u', ...u])
          continue
        }
        const hash = await this.store.hashOf(t)
        if (!blobs.has(hash)) {
          await this.journal.write(`tiles/${hash}`, await encodeTile(format, await this.store.samples(t)))
          blobs.add(hash)
          tilesWritten++
        }
        manifest.tiles.push([x, y, 'h', hash])
      }
      await this.journal.write(`sets/${id}.json`, enc.encode(JSON.stringify(manifest)))
      this.written.add(id)
    }
    return tilesWritten
  }

  /**
   * Reads sets back from the journal into the store. A set whose manifest
   * or tiles can't be read is reported as missing, not thrown, so one
   * damaged layer costs that layer and not the document.
   */
  async restore(ids: Iterable<SetId>): Promise<{ restored: SetId[]; missing: SetId[] }> {
    const restored: SetId[] = []
    const missing: SetId[] = []
    for (const id of ids) {
      if (this.store.hasSet(id)) {
        restored.push(id)
        continue
      }
      try {
        const raw = validSet(id) ? await this.journal.read(`sets/${id}.json`) : null
        if (!raw) throw new Error('no manifest')
        const m = JSON.parse(dec.decode(raw)) as Manifest
        const f = m.format
        const planes = planesOf(f)
        const entries: [number, number, number][] = []
        for (const t of m.tiles) {
          const [x, y, kind] = t as [number, number, string]
          if (kind === 'u') {
            const value = t.slice(3) as number[]
            if (value.length !== planes) throw new Error('bad uniform tile')
            entries.push([x, y, this.store.uniform(f, value)])
          } else {
            const bytes = await this.journal.read(`tiles/${t[3]}`)
            if (!bytes) throw new Error('missing tile')
            entries.push([x, y, this.store.data(f, await decodeTile(f, KIND_SUB, bytes))])
          }
        }
        this.store.createSet(f, entries, id)
        this.written.add(id)
        restored.push(id)
      } catch {
        missing.push(id)
      }
    }
    return { restored, missing }
  }

  /**
   * Removes sets no document in the journal refers to any more, then tiles
   * no remaining set lists. Run after the session is written, with every
   * set the journalled documents hold.
   */
  async collect(live: Iterable<SetId>): Promise<{ sets: number; tiles: number }> {
    const keep = new Set(live)
    let sets = 0
    let tiles = 0
    const usedHashes = new Set<string>()
    for (const f of await this.journal.list('sets')) {
      const id = f.replace(/\.json$/, '')
      if (!keep.has(id)) {
        await this.journal.remove(`sets/${f}`)
        this.written.delete(id)
        sets++
        continue
      }
      const raw = await this.journal.read(`sets/${f}`)
      if (!raw) continue
      try {
        for (const t of (JSON.parse(dec.decode(raw)) as Manifest).tiles) if (t[2] === 'h') usedHashes.add(String(t[3]))
      } catch {
        // A damaged manifest keeps nothing alive.
      }
    }
    const blobs = await this.known()
    for (const h of [...blobs]) {
      if (usedHashes.has(h)) continue
      await this.journal.remove(`tiles/${h}`)
      blobs.delete(h)
      tiles++
    }
    return { sets, tiles }
  }
}
