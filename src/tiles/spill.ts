/**
 * Where tiles go when memory runs short.
 *
 * The tile store keeps its tiles in memory up to a budget. Past it, the
 * tiles used least recently are written out here and their memory reused;
 * a tile that's asked for again is read back in. In the browser this is a
 * folder in OPFS, cleared when the page starts (spilled tiles are a cache
 * of this session, not something to keep). In the checks it's memory.
 */
import type { JournalStore } from '../io/journal'

export interface SpillStore {
  write(id: number, bytes: Uint8Array): Promise<void>
  read(id: number): Promise<Uint8Array>
  remove(id: number): Promise<void>
}

export function memorySpill(): SpillStore & { files: Map<number, Uint8Array> } {
  const files = new Map<number, Uint8Array>()
  return {
    files,
    write: async (id, b) => void files.set(id, b.slice()),
    read: async (id) => {
      const b = files.get(id)
      if (!b) throw new Error(`Spilled tile ${id} is missing`)
      return b.slice()
    },
    remove: async (id) => void files.delete(id),
  }
}

/** A spill store over any journal-style store, under `dir`. */
export function storeSpill(store: JournalStore, dir = 'spill'): SpillStore {
  return {
    write: (id, b) => store.write(`${dir}/${id}`, b),
    read: async (id) => {
      const b = await store.read(`${dir}/${id}`)
      if (!b) throw new Error(`Spilled tile ${id} is missing`)
      return b
    },
    remove: (id) => store.remove(`${dir}/${id}`),
  }
}
