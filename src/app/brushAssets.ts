/**
 * Brush tips and patterns made from images: tips from Define Brush Preset
 * and ABR files, patterns from ABR files (for textures). Kept in the
 * browser (IndexedDB, a database of their own), by content hash, so a
 * brush that names one finds it next time; registered on the page for the
 * previews (brush/tips.ts, brush/textures.ts), and sent to the engine once,
 * before the first stroke that needs it.
 */
import type { BrushSettings } from '../brush/defs'
import { registerTexture } from '../brush/textures'
import { registerTip, tipFromBytes } from '../brush/tips'
import { engine } from '../engine/EngineHost'
import { Listeners } from '../lib/listeners'

export interface BrushAsset {
  id: string
  kind: 'tip' | 'pattern'
  name: string
  width: number
  height: number
  /** 8-bit grey: a tip's coverage, or a pattern's lightness. */
  data: Uint8Array
}

const DB = 'plexel-brushes'
const STORE = 'assets'

let dbPromise: Promise<IDBDatabase | null> | null = null
function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function request<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return db().then(
    (d) =>
      new Promise((resolve) => {
        if (!d) return resolve(null)
        try {
          const r = fn(d.transaction(STORE, mode).objectStore(STORE))
          r.onsuccess = () => resolve(r.result)
          r.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

/** A pattern's grey image as a texture: 0..1. */
const textureOf = (a: BrushAsset) => ({ width: a.width, height: a.height, data: Float32Array.from(a.data, (v) => v / 255) })

class BrushAssets {
  private items = new Map<string, BrushAsset>()
  private sent = new Set<string>()
  private changes = new Listeners()
  /** Everything stored, read back once. */
  readonly ready: Promise<void>

  constructor() {
    this.ready = request('readonly', (s) => s.getAll()).then((all) => {
      for (const a of (all ?? []) as BrushAsset[]) if (a && typeof a.id === 'string' && a.data instanceof Uint8Array) this.register(a)
      this.emit()
    })
  }

  subscribe = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }

  private emit() {
    this.changes.emit()
  }

  private register(a: BrushAsset) {
    this.items.set(a.id, a)
    if (a.kind === 'tip') registerTip(a.id, tipFromBytes(a.width, a.height, a.data))
    else registerTexture(a.id, textureOf(a))
  }

  get(id: string) {
    return this.items.get(id) ?? null
  }

  list(kind: BrushAsset['kind']) {
    return [...this.items.values()].filter((a) => a.kind === kind)
  }

  /** Adds one (a tip or pattern already here by its hash is kept as it is) and keeps it. */
  async add(a: BrushAsset) {
    if (this.items.has(a.id)) return
    this.register(a)
    this.emit()
    await request('readwrite', (s) => s.put(a, a.id))
  }

  async remove(id: string) {
    this.items.delete(id)
    this.emit()
    await request('readwrite', (s) => s.delete(id))
  }

  /** Sends the engine the image tips and patterns a brush uses that it hasn't been given yet. */
  sendFor(b: BrushSettings) {
    const ids = [b.tip, b.dual?.tip, b.texture?.id].filter((x): x is string => !!x && (x.startsWith('tip:') || x.startsWith('pat:')))
    const tips: BrushAsset[] = []
    const textures: BrushAsset[] = []
    for (const id of ids) {
      if (this.sent.has(id)) continue
      const a = this.items.get(id)
      if (!a) continue
      ;(a.kind === 'tip' ? tips : textures).push(a)
      this.sent.add(id)
    }
    if (tips.length || textures.length) engine().sendBrushAssets(tips, textures)
  }
}

let assets: BrushAssets | null = null
export const brushAssets = () => (assets ??= new BrushAssets())
