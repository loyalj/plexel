/**
 * The painting tools' settings: the Brush's, the Eraser's, the Mixer
 * Brush's and Smudge's own brush (each tool keeps its own, as in
 * Photoshop), the Mixer's and Smudge's settings beside theirs, the Colour
 * Picker's sample size, and the brush presets the user has saved.
 * App-wide and remembered by the browser, like the colours.
 */
import { BRUSH_PRESETS, DEFAULT_BRUSH, DEFAULT_MIXER, DEFAULT_SMUDGE, presetSettings, readBrush, readMixer, readSmudge, type BrushSettings, type MixerSettings, type SmudgeSettings } from '../brush/defs'
import { Listeners } from '../lib/listeners'

export type PaintTool = 'brush' | 'eraser' | 'mixer' | 'smudge' | 'clone' | 'heal' | 'spot'
export const PAINT_TOOLS: PaintTool[] = ['brush', 'eraser', 'mixer', 'smudge', 'clone', 'heal', 'spot']

export interface UserPreset {
  id: string
  name: string
  settings: BrushSettings
  /** Where it came from: an imported file's name, Defined, or none for one saved here. */
  group?: string
}

export interface BrushState {
  brush: BrushSettings
  eraser: BrushSettings
  mixer: BrushSettings
  smudge: BrushSettings
  /** The Clone Stamp's, the Healing Brush's and the Spot Healing Brush's brushes. */
  clone: BrushSettings
  heal: BrushSettings
  spot: BrushSettings
  mixerSettings: MixerSettings
  smudgeSettings: SmudgeSettings
  /** The preset each tool last took its settings from, for the panel's highlight. */
  preset: Record<PaintTool, string | null>
  /** The Colour Picker's square, in pixels a side: 1, 3 or 5. */
  sample: 1 | 3 | 5
  user: UserPreset[]
  /** Protect Texture: a preset chosen with a texture of its own takes the one the tool has instead, at its scale. */
  protectTexture: boolean
}

const KEY = 'plexel.brushes.v1'

const defaults = (): BrushState => ({
  brush: presetSettings(BRUSH_PRESETS[0]),
  eraser: { ...DEFAULT_BRUSH, hardness: 1, dynamics: [] },
  mixer: { ...presetSettings(BRUSH_PRESETS[1]), size: 60 },
  smudge: { ...DEFAULT_BRUSH, size: 40, hardness: 0.5, spacing: 0.1, dynamics: [] },
  clone: { ...DEFAULT_BRUSH, size: 60, hardness: 0.5, spacing: 0.1, dynamics: [] },
  heal: { ...DEFAULT_BRUSH, size: 40, hardness: 0.75, spacing: 0.1, dynamics: [] },
  spot: { ...DEFAULT_BRUSH, size: 30, hardness: 0.6, spacing: 0.1, dynamics: [] },
  mixerSettings: { ...DEFAULT_MIXER },
  smudgeSettings: { ...DEFAULT_SMUDGE },
  preset: { brush: BRUSH_PRESETS[0].id, eraser: null, mixer: BRUSH_PRESETS[1].id, smudge: null, clone: null, heal: null, spot: null },
  sample: 1,
  user: [],
  protectTexture: false,
})

function load(): BrushState {
  const d = defaults()
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (!raw || typeof raw !== 'object') return d
    const preset = (t: PaintTool) => (typeof raw.preset?.[t] === 'string' ? raw.preset[t] : raw.preset && t in raw.preset ? null : d.preset[t])
    return {
      brush: raw.brush ? readBrush(raw.brush) : d.brush,
      eraser: raw.eraser ? readBrush(raw.eraser) : d.eraser,
      mixer: raw.mixer ? readBrush(raw.mixer) : d.mixer,
      smudge: raw.smudge ? readBrush(raw.smudge) : d.smudge,
      clone: raw.clone ? readBrush(raw.clone) : d.clone,
      heal: raw.heal ? readBrush(raw.heal) : d.heal,
      spot: raw.spot ? readBrush(raw.spot) : d.spot,
      mixerSettings: raw.mixerSettings ? readMixer(raw.mixerSettings) : d.mixerSettings,
      smudgeSettings: raw.smudgeSettings ? readSmudge(raw.smudgeSettings) : d.smudgeSettings,
      preset: { brush: preset('brush'), eraser: preset('eraser'), mixer: preset('mixer'), smudge: preset('smudge'), clone: preset('clone'), heal: preset('heal'), spot: preset('spot') },
      sample: [1, 3, 5].includes(raw.sample) ? raw.sample : 1,
      protectTexture: raw.protectTexture === true,
      user: Array.isArray(raw.user)
        ? raw.user
            .filter((u: unknown) => u && typeof u === 'object' && typeof (u as UserPreset).id === 'string' && typeof (u as UserPreset).name === 'string')
            .map((u: UserPreset) => ({ id: u.id, name: u.name, settings: readBrush(u.settings), ...(typeof u.group === 'string' ? { group: u.group } : {}) }))
        : [],
    }
  } catch {
    return d
  }
}

class BrushStore {
  private state = load()
  private changes = new Listeners()
  /** Load or Clean, asked for in the options bar: what the Mixer's next stroke starts with, once. */
  private nextReservoir: 'load' | 'clean' | null = null

  get = () => this.state

  subscribe = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }

  private set(next: BrushState) {
    this.state = next
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // Kept for this tab only.
    }
    this.changes.emit()
  }

  /** Changes one tool's brush; it no longer matches its preset. */
  update(tool: PaintTool, patch: Partial<BrushSettings>) {
    this.set({ ...this.state, [tool]: { ...this.state[tool], ...patch }, preset: { ...this.state.preset, [tool]: null } })
  }

  /** Takes a preset's settings, keeping the size the tool had if the preset doesn't say one. */
  choose(tool: PaintTool, id: string) {
    const builtin = BRUSH_PRESETS.find((p) => p.id === id)
    const user = this.state.user.find((p) => p.id === id)
    const settings = builtin ? presetSettings(builtin) : user ? { ...user.settings } : null
    if (!settings) return
    const had = this.state[tool].texture
    if (this.state.protectTexture && had && settings.texture) settings.texture = { ...settings.texture, id: had.id, scale: had.scale }
    this.set({ ...this.state, [tool]: settings, preset: { ...this.state.preset, [tool]: id } })
  }

  setProtectTexture(on: boolean) {
    this.set({ ...this.state, protectTexture: on })
  }

  updateMixer(patch: Partial<MixerSettings>) {
    this.set({ ...this.state, mixerSettings: { ...this.state.mixerSettings, ...patch } })
  }

  updateSmudge(patch: Partial<SmudgeSettings>) {
    this.set({ ...this.state, smudgeSettings: { ...this.state.smudgeSettings, ...patch } })
  }

  /** The Mixer's Load or Clean button: the next stroke starts loaded with the foreground, or clean. */
  setNextReservoir(what: 'load' | 'clean') {
    this.nextReservoir = what
    this.changes.emit()
  }

  /** What the Mixer's next stroke starts with: loaded, clean, or as the last one left it. Taken once. */
  takeReservoir(): 'load' | 'clean' | 'keep' {
    const m = this.state.mixerSettings
    const asked = this.nextReservoir
    this.nextReservoir = null
    if (asked) return asked
    if (m.cleanEach && !m.loadEach) return 'clean'
    if (m.loadEach) return 'load'
    return 'keep'
  }

  setSample(sample: 1 | 3 | 5) {
    this.set({ ...this.state, sample })
  }

  /** Saves a tool's current brush as a preset of the user's own. */
  save(tool: PaintTool, name: string) {
    const id = `user-${Date.now().toString(36)}`
    this.set({ ...this.state, user: [...this.state.user, { id, name: name.trim() || 'My Brush', settings: { ...this.state[tool] } }], preset: { ...this.state.preset, [tool]: id } })
  }

  /** Presets from elsewhere (an ABR file, Define Brush Preset), added together under `group`. */
  addPresets(list: { name: string; settings: BrushSettings }[], group: string) {
    const stamp = Date.now().toString(36)
    const added = list.map((p, i) => ({ id: `user-${stamp}-${i}`, name: p.name.trim() || 'Brush', settings: p.settings, group }))
    this.set({ ...this.state, user: [...this.state.user, ...added] })
  }

  /** Every preset of a group taken away. */
  removeGroup(group: string) {
    this.set({ ...this.state, user: this.state.user.filter((p) => p.group !== group) })
  }

  remove(id: string) {
    this.set({ ...this.state, user: this.state.user.filter((p) => p.id !== id) })
  }
}

let store: BrushStore | null = null
export const brushes = () => (store ??= new BrushStore())

// --- pen settings -------------------------------------------------------------

const PEN_KEY = 'plexel.pen.v1'

/**
 * How pressure responds: an exponent on the pen's pressure. Below 1 is
 * soft (light pressure does more), above 1 firm.
 */
export interface PenSettings {
  response: number
}

function loadPen(): PenSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(PEN_KEY) ?? 'null')
    const r = raw?.response
    return { response: typeof r === 'number' && r >= 0.3 && r <= 3 ? r : 1 }
  } catch {
    return { response: 1 }
  }
}

let pen: PenSettings | null = null
const penChanges = new Listeners()
export const penSettings = {
  get: () => (pen ??= loadPen()),
  set(next: PenSettings) {
    pen = next
    try {
      localStorage.setItem(PEN_KEY, JSON.stringify(next))
    } catch {
      // Kept for this tab only.
    }
    penChanges.emit()
  },
  subscribe(fn: () => void) {
    return penChanges.subscribe(fn)
  },
}

/** A pen's pressure through the response curve. */
export const applyResponse = (p: number, response: number) => Math.min(1, Math.max(0, p)) ** response
