/**
 * Interface settings: how big and how dense the interface is, how much
 * contrast and motion it has, and how much it explains itself.
 *
 * View state, like the appearance and the workspace: per browser, under
 * its own versioned key, loaded defensively (a value out of range or of
 * the wrong type falls back to its default rather than being trusted).
 * Applying them is attributes on <html> and one custom property, so the
 * stylesheet does the rest:
 *
 * - `--ui-scale` zooms the interface around the canvas (menus, panels,
 *   bars, dialogs), never the canvas itself, whose pixels are the engine's.
 * - `data-density="compact"` tightens rows and bars for small screens.
 * - `data-contrast="more"` strengthens text, rules and focus rings over
 *   whichever theme is on.
 * - `data-motion="reduce"` stops transitions and animations, as the
 *   system's reduced-motion setting already does.
 */

export interface InterfacePrefs {
  /** The interface's size, 0.8 to 1.5 (1 is 100%). */
  scale: number
  density: 'comfortable' | 'compact'
  contrast: 'normal' | 'more'
  /** 'system' follows the operating system's reduced-motion setting. */
  motion: 'system' | 'reduce'
  /** Tooltips that list a tool's keys and say why something is unavailable; off, they give the name alone. */
  richTips: boolean
  /** The status bar's key hints for the tool in use. */
  keyHints: boolean
  /** Tab hides the panels (Shift+Tab the dock alone), as in Photoshop. Off, Tab only moves the focus. */
  tabHides: boolean
  /** Holding a tool's key uses the tool until it's let go (app/springTools.ts). Off, a tool key always switches for good. */
  springTools: boolean
}

export const SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5]

export const DEFAULT_PREFS: InterfacePrefs = {
  scale: 1,
  density: 'comfortable',
  contrast: 'normal',
  motion: 'system',
  richTips: true,
  keyHints: true,
  tabHides: true,
  springTools: true,
}

const KEY = 'plexel.interface.v1'

export function loadPrefs(): InterfacePrefs {
  let text: string | null = null
  try {
    text = localStorage.getItem(KEY)
  } catch {
    return DEFAULT_PREFS
  }
  return readPrefs(text)
}

/** Settings from their saved text: anything missing, malformed or out of range is its default. */
export function readPrefs(text: string | null): InterfacePrefs {
  if (!text) return DEFAULT_PREFS
  let raw: Partial<Record<keyof InterfacePrefs, unknown>>
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFS
    raw = parsed as typeof raw
  } catch {
    return DEFAULT_PREFS
  }
  const p = { ...DEFAULT_PREFS }
  if (typeof raw.scale === 'number' && SCALES.includes(raw.scale)) p.scale = raw.scale
  if (raw.density === 'compact' || raw.density === 'comfortable') p.density = raw.density
  if (raw.contrast === 'more' || raw.contrast === 'normal') p.contrast = raw.contrast
  if (raw.motion === 'reduce' || raw.motion === 'system') p.motion = raw.motion
  for (const k of ['richTips', 'keyHints', 'tabHides', 'springTools'] as const) if (typeof raw[k] === 'boolean') p[k] = raw[k]
  return p
}

export function applyPrefs(p: InterfacePrefs) {
  const root = document.documentElement
  root.style.setProperty('--ui-scale', String(p.scale))
  root.dataset.density = p.density
  root.dataset.contrast = p.contrast
  root.dataset.motion = p.motion
}

class PrefsStore {
  private value = DEFAULT_PREFS
  private listeners = new Set<() => void>()
  private loaded = false

  get = () => {
    if (!this.loaded) {
      this.loaded = true
      this.value = loadPrefs()
    }
    return this.value
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  update(change: Partial<InterfacePrefs>) {
    this.value = { ...this.get(), ...change }
    applyPrefs(this.value)
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value))
    } catch {
      // Kept for this visit only.
    }
    for (const fn of this.listeners) fn()
  }

  reset() {
    this.update(DEFAULT_PREFS)
  }
}

let store: PrefsStore | null = null
export const interfacePrefs = () => (store ??= new PrefsStore())
