/**
 * The View menu's aids and how snapping behaves: rulers and their units,
 * whether guides, the grid, the pixel grid and smart guides show, what
 * snaps to what, the grid's spacing and the colours of all three, and what
 * Align lines layers up with.
 *
 * View state, like the interface settings: per browser, under its own
 * versioned key, loaded defensively. The guides themselves are the
 * document's (Doc.guides); the ruler's zero point is each open document's
 * (app/snapping.ts).
 */
import { UNITS, type Unit } from '../doc/units'
import { Listeners } from '../lib/listeners'

export type AlignTo = 'layers' | 'key' | 'canvas' | 'selection'

export interface SnapTo {
  guides: boolean
  grid: boolean
  /** Other layers' edges and centres. */
  layers: boolean
  /** The canvas's edges and centre. */
  document: boolean
  /** Shapes' anchor points. */
  points: boolean
  /** Whole pixels, for what didn't snap to anything else. */
  pixels: boolean
}

export interface GuidePrefs {
  rulers: boolean
  /** The rulers' units, and the readouts'. */
  units: Unit
  guides: boolean
  lockGuides: boolean
  grid: boolean
  pixelGrid: boolean
  smartGuides: boolean
  /** View → Snap: off, nothing snaps. */
  snap: boolean
  /** View → Tiled View: a tiled document's copies shown round it. */
  tiledView: boolean
  snapTo: SnapTo
  /** A grid line every `gridEvery` `gridUnit`s, each cell cut `gridSub` ways. */
  gridEvery: number
  gridUnit: Unit
  gridSub: number
  /** Colours as #rrggbb. */
  guideColour: string
  gridColour: string
  smartColour: string
  alignTo: AlignTo
}

export const SNAP_TARGETS: { id: keyof SnapTo; label: string }[] = [
  { id: 'guides', label: 'Guides' },
  { id: 'grid', label: 'Grid' },
  { id: 'layers', label: 'Layers' },
  { id: 'document', label: 'Document Bounds' },
  { id: 'points', label: 'Anchor Points' },
  { id: 'pixels', label: 'Pixels' },
]

export const ALIGN_TO: { id: AlignTo; label: string }[] = [
  { id: 'layers', label: 'Selected Layers' },
  { id: 'key', label: 'Key Layer' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'selection', label: 'Selection' },
]

export const DEFAULT_GUIDE_PREFS: GuidePrefs = {
  rulers: false,
  units: 'px',
  guides: true,
  lockGuides: false,
  grid: false,
  pixelGrid: true,
  smartGuides: true,
  snap: true,
  tiledView: true,
  snapTo: { guides: true, grid: true, layers: true, document: true, points: true, pixels: false },
  gridEvery: 100,
  gridUnit: 'px',
  gridSub: 4,
  guideColour: '#00c8ff',
  gridColour: '#808080',
  smartColour: '#ff2fb4',
  alignTo: 'layers',
}

const KEY = 'plexel.guides.v1'

const isUnit = (v: unknown): v is Unit => UNITS.some((u) => u.id === v)
const isColour = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)

/** Settings from their saved text: anything missing, malformed or out of range is its default. */
export function readGuidePrefs(text: string | null): GuidePrefs {
  if (!text) return DEFAULT_GUIDE_PREFS
  let raw: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_GUIDE_PREFS
    raw = parsed as Record<string, unknown>
  } catch {
    return DEFAULT_GUIDE_PREFS
  }
  const p: GuidePrefs = { ...DEFAULT_GUIDE_PREFS, snapTo: { ...DEFAULT_GUIDE_PREFS.snapTo } }
  for (const k of ['rulers', 'guides', 'lockGuides', 'grid', 'pixelGrid', 'smartGuides', 'snap', 'tiledView'] as const) if (typeof raw[k] === 'boolean') p[k] = raw[k]
  if (isUnit(raw.units)) p.units = raw.units
  if (isUnit(raw.gridUnit)) p.gridUnit = raw.gridUnit
  if (typeof raw.gridEvery === 'number' && Number.isFinite(raw.gridEvery) && raw.gridEvery > 0 && raw.gridEvery <= 100000) p.gridEvery = raw.gridEvery
  if (typeof raw.gridSub === 'number' && Number.isInteger(raw.gridSub) && raw.gridSub >= 1 && raw.gridSub <= 100) p.gridSub = raw.gridSub
  for (const k of ['guideColour', 'gridColour', 'smartColour'] as const) if (isColour(raw[k])) p[k] = (raw[k] as string).toLowerCase()
  if (ALIGN_TO.some((a) => a.id === raw.alignTo)) p.alignTo = raw.alignTo as AlignTo
  const s = raw.snapTo
  if (typeof s === 'object' && s !== null) for (const t of SNAP_TARGETS) if (typeof (s as Record<string, unknown>)[t.id] === 'boolean') p.snapTo[t.id] = (s as Record<string, boolean>)[t.id]
  return p
}

/** A #rrggbb colour as three channels from 0 to 1. */
export function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

class GuidePrefsStore {
  private value: GuidePrefs | null = null
  private changes = new Listeners()

  get = (): GuidePrefs => {
    if (!this.value) {
      let text: string | null = null
      try {
        text = localStorage.getItem(KEY)
      } catch {
        // No storage: the defaults.
      }
      this.value = readGuidePrefs(text)
    }
    return this.value
  }

  subscribe = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }

  update(change: Partial<GuidePrefs>) {
    this.value = { ...this.get(), ...change }
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value))
    } catch {
      // Kept for this visit only.
    }
    this.changes.emit()
  }

  toggle(k: 'rulers' | 'guides' | 'lockGuides' | 'grid' | 'pixelGrid' | 'smartGuides' | 'snap' | 'tiledView') {
    this.update({ [k]: !this.get()[k] })
  }

  toggleSnapTo(k: keyof SnapTo) {
    const s = this.get().snapTo
    this.update({ snapTo: { ...s, [k]: !s[k] } })
  }
}

let store: GuidePrefsStore | null = null
export const guidePrefs = () => (store ??= new GuidePrefsStore())
