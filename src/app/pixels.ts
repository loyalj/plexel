/**
 * Pixels, from the page's side: making tile sets for documents, and
 * telling the engine which sets are still in use.
 *
 * The engine holds every tile set; documents hold their ids. A set is in
 * use while any open document's history (past, present or future) refers
 * to it, so undo can always go back to it. Shortly after the documents
 * change, the engine is told the sets in use, and frees the rest.
 */
import { tileSetsOf } from '../doc/edit'
import type { Doc } from '../doc/types'
import { engine } from '../engine/EngineHost'
import { quantise, type TileFormat } from '../tiles/format'
import type { ColourValue } from '../color/value'
import { colourEngine } from './colour'
import { colourSettings } from './colourSettings'
import { documents } from './documents'

export const formatOf = (doc: Doc): TileFormat => ({ mode: doc.mode, depth: doc.depth })

/** Others that keep sets alive outside any document: the clipboard. */
const keepers: (() => Iterable<string>)[] = []
export const keepAlive = (fn: () => Iterable<string>) => keepers.push(fn)

/** Every set any open document's history refers to, and every set kept alive besides. */
function liveSets(): Set<string> {
  const live = new Set<string>()
  for (const fn of keepers) for (const id of fn()) live.add(id)
  for (const d of documents().getState().docs) {
    const h = d.history
    for (const doc of [...h.past, h.present, ...h.future]) for (const id of tileSetsOf(doc)) live.add(id)
    if (d.saved) for (const id of tileSetsOf(d.saved)) live.add(id)
    if (d.lastSelection) live.add(d.lastSelection)
  }
  return live
}

const GC_MS = 1500
let gcTimer: ReturnType<typeof setTimeout> | null = null
/** Sets held for an operation in flight (a save packing them, a fill about to be committed). */
const held = new Map<string, number>()

export function hold(ids: Iterable<string>): () => void {
  const list = [...ids]
  for (const id of list) held.set(id, (held.get(id) ?? 0) + 1)
  return () => {
    for (const id of list) {
      const n = (held.get(id) ?? 1) - 1
      if (n <= 0) held.delete(id)
      else held.set(id, n)
    }
  }
}

/**
 * The most history may hold in tiles nothing newer uses: past it, the
 * oldest steps are forgotten, however few there are. Strokes on a big
 * image each hold on to the tiles they replaced, and a hundred of them
 * could otherwise fill the disk the tile store spills to.
 */
const HISTORY_BYTES = 1024 * 1024 * 1024

/** Strings this long or longer count against history; shorter ones (names, settings) are noise. */
const LONG_STRING = 1024
const heavy = new WeakMap<object, number>()

/** The bytes of a value's long strings, all the way down (a node's parameters, effects, smart object contents), kept by object. */
function heavyBytes(v: unknown): number {
  if (typeof v === 'string') return v.length >= LONG_STRING ? v.length : 0
  if (!v || typeof v !== 'object') return 0
  const had = heavy.get(v)
  if (had !== undefined) return had
  let n = 0
  for (const x of Array.isArray(v) ? v : Object.values(v)) n += heavyBytes(x)
  heavy.set(v, n)
  return n
}

/**
 * What a past state holds, outside tiles, that the state after it doesn't:
 * its nodes that the next step replaced (unchanged nodes are the same
 * objects in both), by their long strings.
 */
function stepBytes(older: Doc, newer: Doc): number {
  let n = 0
  for (const [id, node] of Object.entries(older.nodes)) if (newer.nodes[id] !== node) n += heavyBytes(node)
  return n
}

/** Trims each document's history to HISTORY_BYTES (check-paint lowers it), oldest steps first, counting tiles and what else steps hold (stepBytes). */
async function capHistory() {
  for (const d of documents().getState().docs) {
    const h = d.history
    if (!h.past.length) continue
    const kept = [...tileSetsOf(h.present), ...h.future.flatMap(tileSetsOf), ...(d.saved ? tileSetsOf(d.saved) : [])]
    const newestFirst = [...h.past].reverse()
    const past = newestFirst.map(tileSetsOf)
    const cost = await engine().call('tiles.historyCost', { past, kept })
    // What a step holds that isn't tiles: a Liquify field, say, half a megabyte of text a stroke.
    newestFirst.forEach((older, i) => (cost[i] += stepBytes(older, i ? newestFirst[i - 1] : h.present)))
    let total = 0
    let keep = cost.length
    const cap = (globalThis as { plexelHistoryBytes?: number }).plexelHistoryBytes ?? HISTORY_BYTES
    for (let i = 0; i < cost.length; i++) {
      total += cost[i]
      if (total > cap) {
        keep = i
        break
      }
    }
    if (keep < h.past.length) documents().trimHistory(d.key, keep)
  }
}

async function collectNow() {
  if (gcTimer) clearTimeout(gcTimer)
  gcTimer = null
  // A failure here keeps more history than it should, not less: said, and collection goes on.
  await capHistory().catch((e) => console.warn('History couldn’t be trimmed:', e))
  const live = liveSets()
  for (const id of held.keys()) live.add(id)
  return engine().call('tiles.gc', { live: [...live] })
}

/** Starts collecting unused sets whenever the documents change. */
export function startCollecting() {
  return documents().subscribe(() => {
    if (gcTimer) clearTimeout(gcTimer)
    gcTimer = setTimeout(() => void collectNow().catch((e) => console.warn('Unused tiles couldn’t be collected:', e)), GC_MS)
  })
}

/**
 * The samples for a colour in a document: converted to the document's
 * space and profile with the intent in Colour Settings, quantised to its depth, alpha
 * last. Also says whether the colour had to be clipped to fit.
 */
export async function samplesFor(doc: Doc, colour: ColourValue, alpha = 1): Promise<{ value: number[]; clipped: boolean }> {
  const { converter } = await colourEngine()
  const { intent, blackPointCompensation } = colourSettings.get()
  const { c, clipped } = converter.convert(colour, { space: doc.mode, profile: doc.profile }, intent, blackPointCompensation)
  return { value: quantise(formatOf(doc), c, alpha), clipped }
}

/** A new set filling the whole canvas with one colour. */
export async function fillSet(doc: Doc, colour: ColourValue): Promise<{ id: string; clipped: boolean }> {
  const { value, clipped } = await samplesFor(doc, colour)
  const id = await engine().call('tiles.fill', { format: formatOf(doc), width: doc.width, height: doc.height, value })
  return { id, clipped }
}

/** Paper white and full black, in a document's own numbers. */
export function paper(doc: Doc, which: 'white' | 'black'): ColourValue {
  const profile = doc.profile
  if (doc.mode === 'cmyk') return { space: 'cmyk', profile, c: which === 'white' ? [0, 0, 0, 0] : [0, 0, 0, 1] }
  if (doc.mode === 'gray') return { space: 'gray', profile, c: [which === 'white' ? 1 : 0] }
  return { space: 'rgb', profile, c: which === 'white' ? [1, 1, 1] : [0, 0, 0] }
}
