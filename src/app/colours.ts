/**
 * The foreground and background colours, and which model the Colour panel
 * shows them in. App-wide, as in Photoshop, not per document, and
 * remembered by the browser.
 *
 * Each colour keeps the space and profile it was picked in (color/value.ts):
 * a CMYK foreground stays those inks however documents change around it.
 */
import { BLACK, CHANNELS, WHITE, type ColourValue, type ValueSpace } from '../color/value'

export type PickerModel = 'rgb' | 'hsb' | 'lab' | 'cmyk' | 'gray'
export const PICKER_MODELS: { id: PickerModel; label: string }[] = [
  { id: 'rgb', label: 'RGB' },
  { id: 'hsb', label: 'HSB' },
  { id: 'lab', label: 'Lab' },
  { id: 'cmyk', label: 'CMYK' },
  { id: 'gray', label: 'Gray' },
]

export interface Colours {
  fg: ColourValue
  bg: ColourValue
  model: PickerModel
}

const KEY = 'plexel.colours.v1'
const DEFAULT: Colours = { fg: BLACK, bg: WHITE, model: 'hsb' }
const SPACES: ValueSpace[] = ['rgb', 'gray', 'cmyk', 'lab']

function readValue(v: unknown): ColourValue | null {
  if (!v || typeof v !== 'object') return null
  const { space, profile, c } = v as Partial<ColourValue>
  if (!SPACES.includes(space as ValueSpace) || !Array.isArray(c) || c.length !== CHANNELS[space as ValueSpace]) return null
  if (!c.every((x) => typeof x === 'number' && Number.isFinite(x))) return null
  const p = profile && typeof profile === 'object' && ('builtin' in profile || 'asset' in profile) ? profile : null
  if (space !== 'lab' && !p) return null
  return { space: space as ValueSpace, profile: space === 'lab' ? null : p, c: [...c] }
}

function load(): Colours {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (!raw) return DEFAULT
    return {
      fg: readValue(raw.fg) ?? DEFAULT.fg,
      bg: readValue(raw.bg) ?? DEFAULT.bg,
      model: PICKER_MODELS.some((m) => m.id === raw.model) ? raw.model : DEFAULT.model,
    }
  } catch {
    return DEFAULT
  }
}

class ColourStore {
  private state: Colours = load()
  private listeners = new Set<() => void>()

  get = () => this.state
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private set(next: Colours) {
    this.state = next
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // The colours just won't survive the tab.
    }
    for (const fn of this.listeners) fn()
  }

  setFg(fg: ColourValue) {
    this.set({ ...this.state, fg })
  }
  setBg(bg: ColourValue) {
    this.set({ ...this.state, bg })
  }
  setModel(model: PickerModel) {
    this.set({ ...this.state, model })
  }
  /** X in Photoshop: foreground and background change places. */
  swap() {
    this.set({ ...this.state, fg: this.state.bg, bg: this.state.fg })
  }
  /** D in Photoshop: black on white. */
  reset() {
    this.set({ ...this.state, fg: BLACK, bg: WHITE })
  }
}

let store: ColourStore | null = null
export const colours = () => (store ??= new ColourStore())
