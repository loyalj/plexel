/**
 * The tile store, as the engine worker runs it: the store itself, its
 * spill folder in OPFS, the journal's tiles, and the calls the page makes.
 *
 * Each worker spills into a folder of its own, `spill-<id>`, and holds a
 * Web Lock named after it for as long as it lives. A worker starting up
 * clears every spill folder whose lock nobody holds: tiles left by a tab
 * that has closed or crashed. A second Plexel tab therefore never clears
 * the first one's tiles out from under it.
 */
import { opfsStoreAt, opfsStore } from '../io/opfs'
import { memoryStore } from '../io/journal'
import { TILE, planesOf, tileBytes, tilesCovering } from '../tiles/format'
import { TileJournal } from '../tiles/journal'
import { decodeSet, decodeSetLazy, encodeSet } from '../tiles/pack'
import { memorySpill, storeSpill } from '../tiles/spill'
import { TileStore } from '../tiles/store'
import type { EngineCalls } from './protocol'

/**
 * How much tile memory to keep before spilling: a quarter of what the
 * browser says the machine has (it caps the figure at 8 GB), and 1 GB when
 * it won't say.
 */
function defaultBudget(): number {
  const gb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  return gb ? Math.max(256, (gb * 1024) / 4) * 1024 * 1024 : 1024 * 1024 * 1024
}

const sessionId = Math.random().toString(36).slice(2, 10)
const SPILL_PREFIX = 'spill-'

async function prepareSpill() {
  const hasOpfs = typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory
  const hasLocks = typeof navigator !== 'undefined' && !!navigator.locks
  if (!hasOpfs || !hasLocks) return memorySpill()
  const name = `${SPILL_PREFIX}${sessionId}`
  // Held until the worker ends; the promise that would release it never settles.
  void navigator.locks.request(`plexel-${name}`, () => new Promise(() => {}))
  try {
    const held = new Set(((await navigator.locks.query()).held ?? []).map((l) => l.name))
    const root = await navigator.storage.getDirectory()
    for await (const entry of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (entry.startsWith(SPILL_PREFIX) && entry !== name && !held.has(`plexel-${entry}`)) {
        await root.removeEntry(entry, { recursive: true }).catch(() => {})
      }
    }
  } catch {
    // Old folders stay; they cost disk, not correctness.
  }
  return storeSpill(opfsStoreAt(name), 't')
}

export const store = new TileStore({ budget: defaultBudget(), spill: memorySpill() })
let ready: Promise<void> | null = null
let journal: TileJournal | null = null

/** Starts the spill store and the journal. Calls wait for this. */
function start(): Promise<void> {
  ready ??= (async () => {
    const spill = await prepareSpill()
    store.setSpill(spill)
    const hasOpfs = typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory
    journal = new TileJournal(store, hasOpfs ? opfsStore : memoryStore())
  })()
  return ready
}

/** Sets made in the engine that the page hasn't committed yet, kept from collection meanwhile. */
const pinned = new Map<string, number>()
export const pinSet = (id: string) => pinned.set(id, (pinned.get(id) ?? 0) + 1)
export const unpinSet = (id: string) => {
  const n = (pinned.get(id) ?? 1) - 1
  if (n <= 0) pinned.delete(id)
  else pinned.set(id, n)
}

/** Files tiles are read from on demand, by the page's name for each. */
const lazySources = new Map<string, Blob>()

export type Handler<M extends keyof EngineCalls> = (args: EngineCalls[M]['args']) => Promise<EngineCalls[M]['result']> | EngineCalls[M]['result']

type TileCall = 'tiles.fill' | 'tiles.describe' | 'tiles.pack' | 'tiles.unpack' | 'tiles.journal' | 'tiles.restore' | 'tiles.collectJournal' | 'tiles.gc' | 'tiles.stats' | 'tiles.unpackLazy' | 'tiles.materialize' | 'tiles.historyCost'

/** Called with the sets still in use after every collection, so the GPU can let go of the rest. */
export let onCollected: (live: ReadonlySet<string>) => void = () => {}
export const setOnCollected = (fn: (live: ReadonlySet<string>) => void) => (onCollected = fn)

export const tileHandlers: { [M in TileCall]: Handler<M> } = {
  'tiles.fill': ({ format, width, height, value }) => {
    if (value.length !== planesOf(format)) throw new Error(`A fill needs ${planesOf(format)} values`)
    const tile = store.uniform(format, value)
    return store.createSet(format, tilesCovering(width, height).map(([x, y]) => [x, y, tile]))
  },
  'tiles.describe': ({ ids }) => {
    const out: EngineCalls['tiles.describe']['result'] = {}
    for (const id of ids) out[id] = store.hasSet(id) ? store.describe(id) : { kind: 'missing' }
    return out
  },
  'tiles.pack': ({ id }) => encodeSet(store, id),
  'tiles.unpack': ({ id, bytes }) => decodeSet(store, bytes, id),
  'tiles.journal': async ({ ids }) => (await start(), journal!.write(ids)),
  'tiles.restore': async ({ ids }) => (await start(), journal!.restore(ids)),
  'tiles.collectJournal': async ({ live }) => (await start(), journal!.collect(live)),
  'tiles.gc': ({ live }) => {
    const keep = new Set([...live, ...pinned.keys()])
    const r = store.gc(keep)
    onCollected(keep)
    return r
  },
  'tiles.historyCost': ({ past, kept }) => {
    // Tiles the present and future hold cost nothing extra; walking back
    // from the newest past state, each state costs the tiles it adds.
    const seen = new Set<number>()
    const add = (sets: string[]) => {
      let bytes = 0
      for (const id of sets) {
        if (!store.hasSet(id)) continue
        const { format, tiles } = store.getSet(id)
        for (const t of tiles.values()) {
          if (seen.has(t)) continue
          seen.add(t)
          if (!store.isUniform(t)) bytes += tileBytes(format)
        }
      }
      return bytes
    }
    add(kept)
    return past.map(add)
  },
  'tiles.stats': () => ({ ...store.stats(), tileSize: TILE }),
  'tiles.unpackLazy': ({ id, source, file, start: at, length }) => {
    // One Blob per file, so materialize can find every tile it backs.
    if (!lazySources.has(source)) lazySources.set(source, file)
    return decodeSetLazy(store, lazySources.get(source)!, at, length, id)
  },
  'tiles.materialize': async ({ source }) => {
    const blob = lazySources.get(source)
    if (!blob) return 0
    lazySources.delete(source)
    return store.materialize(blob)
  },
}

/** Waits for the spill store and the journal. Every call does, first. */
export const tilesReady = start
