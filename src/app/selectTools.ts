/**
 * The selection tools' settings: the Marquee's shape, the Lasso's kind,
 * the Magic Wand's tolerance and the rest, and the way a new selection
 * combines with the one there is (the options bar's four buttons, which
 * Shift and Alt override for one drag). App-wide and remembered by the
 * browser, like the brushes.
 */
import type { CombineOp } from '../tiles/coverage'
import { Listeners } from '../lib/listeners'

export interface SelectToolState {
  /** How a new shape combines with the selection, when no key says otherwise. */
  op: CombineOp
  marquee: { shape: 'rect' | 'ellipse'; feather: number; antialias: boolean }
  /** The Magnetic Lasso's width (px), contrast (0..1) and frequency (0..100) are Photoshop's. */
  lasso: { mode: 'freehand' | 'polygonal' | 'magnetic'; feather: number; antialias: boolean; width: number; contrast: number; frequency: number }
  wand: { tolerance: number; contiguous: boolean; sampleAll: boolean; antialias: boolean }
  /** Quick Selection's brush diameter in document pixels. */
  quick: { size: number; sampleAll: boolean; autoEnhance: boolean }
}

const KEY = 'plexel.selectTools.v1'

const defaultSelectTools = (): SelectToolState => ({
  op: 'replace',
  marquee: { shape: 'rect', feather: 0, antialias: true },
  lasso: { mode: 'freehand', feather: 0, antialias: true, width: 10, contrast: 0.1, frequency: 57 },
  wand: { tolerance: 32, contiguous: true, sampleAll: false, antialias: true },
  quick: { size: 30, sampleAll: false, autoEnhance: true },
})

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)

/** Settings as saved, repaired where they're missing or wrong. */
function readSelectTools(raw: unknown): SelectToolState {
  const d = defaultSelectTools()
  if (!raw || typeof raw !== 'object') return d
  const r = raw as Record<string, Record<string, unknown> | undefined>
  const op = (raw as { op?: unknown }).op
  return {
    op: op === 'add' || op === 'subtract' || op === 'intersect' ? op : 'replace',
    marquee: {
      shape: r.marquee?.shape === 'ellipse' ? 'ellipse' : 'rect',
      feather: num(r.marquee?.feather, 0, 1000, 0),
      antialias: bool(r.marquee?.antialias, true),
    },
    lasso: {
      mode: r.lasso?.mode === 'polygonal' || r.lasso?.mode === 'magnetic' ? r.lasso.mode : 'freehand',
      feather: num(r.lasso?.feather, 0, 1000, 0),
      antialias: bool(r.lasso?.antialias, true),
      width: num(r.lasso?.width, 1, 256, 10),
      contrast: num(r.lasso?.contrast, 0.01, 1, 0.1),
      frequency: num(r.lasso?.frequency, 0, 100, 57),
    },
    wand: {
      tolerance: num(r.wand?.tolerance, 0, 255, 32),
      contiguous: bool(r.wand?.contiguous, true),
      sampleAll: bool(r.wand?.sampleAll, false),
      antialias: bool(r.wand?.antialias, true),
    },
    quick: {
      size: num(r.quick?.size, 1, 2000, 30),
      sampleAll: bool(r.quick?.sampleAll, false),
      autoEnhance: bool(r.quick?.autoEnhance, true),
    },
  }
}

class SelectToolStore {
  private state: SelectToolState
  private changes = new Listeners()

  constructor() {
    let raw: unknown = null
    try {
      raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    } catch {
      raw = null
    }
    this.state = readSelectTools(raw)
  }

  get = () => this.state

  subscribe = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }

  update<K extends keyof SelectToolState>(key: K, patch: SelectToolState[K] extends object ? Partial<SelectToolState[K]> : SelectToolState[K]) {
    const cur = this.state[key]
    const next = typeof cur === 'object' ? { ...cur, ...(patch as object) } : patch
    this.state = { ...this.state, [key]: next }
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state))
    } catch {
      // Not remembered; still used.
    }
    this.changes.emit()
  }
}

let store: SelectToolStore | null = null
export const selectTools = () => (store ??= new SelectToolStore())

/** The combination a drag makes: Shift adds, Alt subtracts, both intersect; otherwise the options bar's. */
export function opFor(mods: { shiftKey: boolean; altKey: boolean }, fallback: CombineOp): CombineOp {
  if (mods.shiftKey && mods.altKey) return 'intersect'
  if (mods.shiftKey) return 'add'
  if (mods.altKey) return 'subtract'
  return fallback
}
