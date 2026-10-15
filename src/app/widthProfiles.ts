/**
 * Width profiles saved under a name of your own (Properties' Save), kept
 * by the browser and listed after the presets, as Illustrator's Add to
 * Profiles does. A profile is its width points (geom/stroke.ts).
 */
import type { WidthPoint } from '../geom/stroke'
import { MAX_SHARE } from '../geom/width'
import { Listeners } from '../lib/listeners'

export interface SavedProfile {
  name: string
  points: WidthPoint[]
}

const KEY = 'plexel.widthProfiles.v1'
const LIMIT = 100

function readSaved(raw: unknown): SavedProfile[] {
  if (!Array.isArray(raw)) return []
  const out: SavedProfile[] = []
  for (const r of raw.slice(0, LIMIT)) {
    if (!r || typeof r !== 'object') continue
    const { name, points } = r as Record<string, unknown>
    if (typeof name !== 'string' || !name.trim() || !Array.isArray(points)) continue
    const pts: WidthPoint[] = []
    for (const p of points.slice(0, 64)) {
      if (!p || typeof p !== 'object') continue
      const { at, left, right } = p as Record<string, unknown>
      if ([at, left, right].every((v) => typeof v === 'number' && Number.isFinite(v))) pts.push({ at: Math.min(1, Math.max(0, at as number)), left: Math.min(MAX_SHARE, Math.max(0, left as number)), right: Math.min(MAX_SHARE, Math.max(0, right as number)) })
    }
    if (pts.length) out.push({ name: name.trim().slice(0, 80), points: pts.sort((a, b) => a.at - b.at) })
  }
  return out
}

class WidthProfileStore {
  private list: SavedProfile[]
  private changes = new Listeners()
  constructor() {
    let raw: unknown = null
    try {
      raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    } catch {
      raw = null
    }
    this.list = readSaved(raw)
  }
  get = () => this.list
  subscribe = (fn: () => void) => this.changes.subscribe(fn)
  private store(next: SavedProfile[]) {
    this.list = next
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // Not remembered after this visit; still listed now.
    }
    this.changes.emit()
  }
  /** Saved under `name`: one of that name already is replaced. */
  add(name: string, points: WidthPoint[]) {
    const n = name.trim()
    if (!n || !points.length) return
    this.store([...this.list.filter((p) => p.name !== n), { name: n, points: points.map((p) => ({ ...p })) }].slice(-LIMIT))
  }
  remove(name: string) {
    this.store(this.list.filter((p) => p.name !== name))
  }
}

let store: WidthProfileStore | null = null
export const widthProfiles = () => (store ??= new WidthProfileStore())
