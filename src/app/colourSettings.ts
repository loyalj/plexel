/**
 * Colour settings: which profile the display has, and how colours are
 * converted into documents. Per browser, as Photoshop keeps them per
 * machine.
 *
 * Browsers don't tell a page the monitor's profile, so the user says
 * whether their display is ordinary (sRGB) or wide-gamut (Display P3, as
 * on recent Macs and many laptops). Everything shown on screen is
 * converted to it: colour swatches now, the canvas from phase 4.
 */
import type { Intent } from '../color/cms'
import { BUILTIN_BY_ID, DEFAULT_PROFILE_ID, DISPLAY_PROFILE_IDS, type DisplayProfileId } from '../color/profiles'
import type { ColourMode, ProfileRef } from '../doc/types'
import { Listeners } from '../lib/listeners'

export interface ColourSettings {
  display: DisplayProfileId
  /** For colours converted into a document: fills, picked colours. */
  intent: Intent
  blackPointCompensation: boolean
  /**
   * The working spaces: the profile each mode's new documents get, and
   * what Image → Mode converts to. Working CMYK is also the proof
   * condition a document starts with.
   */
  working: Record<ColourMode, ProfileRef>
}

const DEFAULT_WORKING: Record<ColourMode, ProfileRef> = {
  rgb: { builtin: DEFAULT_PROFILE_ID.rgb },
  cmyk: { builtin: DEFAULT_PROFILE_ID.cmyk },
  gray: { builtin: DEFAULT_PROFILE_ID.gray },
}

/** A working space read back: a built-in for the mode, or a loaded profile by hash. */
function readWorking(v: unknown, mode: ColourMode): ProfileRef {
  if (v && typeof v === 'object') {
    const r = v as Record<string, unknown>
    if (typeof r.builtin === 'string' && BUILTIN_BY_ID.get(r.builtin)?.mode === mode) return { builtin: r.builtin }
    if (typeof r.asset === 'string' && /^[0-9a-f]{64}$/.test(r.asset)) return { asset: r.asset }
  }
  return DEFAULT_WORKING[mode]
}

const KEY = 'plexel.colourSettings.v1'
const INTENTS: Intent[] = ['perceptual', 'relative', 'saturation', 'absolute']

/** A wide-gamut screen gets Display P3 by default, which the browser does say. */
function defaults(): ColourSettings {
  const p3 = typeof matchMedia === 'function' && matchMedia('(color-gamut: p3)').matches
  return { display: p3 ? 'display-p3' : 'srgb', intent: 'relative', blackPointCompensation: true, working: DEFAULT_WORKING }
}

function load(): ColourSettings {
  const d = defaults()
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (!raw || typeof raw !== 'object') return d
    return {
      display: DISPLAY_PROFILE_IDS.includes(raw.display) ? raw.display : d.display,
      intent: INTENTS.includes(raw.intent) ? raw.intent : d.intent,
      blackPointCompensation: typeof raw.blackPointCompensation === 'boolean' ? raw.blackPointCompensation : d.blackPointCompensation,
      working: { rgb: readWorking(raw.working?.rgb, 'rgb'), cmyk: readWorking(raw.working?.cmyk, 'cmyk'), gray: readWorking(raw.working?.gray, 'gray') },
    }
  } catch {
    return d
  }
}

let state: ColourSettings | null = null
const changes = new Listeners()

export const colourSettings = {
  get: () => (state ??= load()),
  subscribe(fn: () => void) {
    return changes.subscribe(fn)
  },
  set(next: ColourSettings) {
    state = next
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // Kept for this tab only.
    }
    changes.emit()
  },
}

export const INTENT_NAMES: Record<Intent, string> = {
  perceptual: 'Perceptual',
  relative: 'Relative Colorimetric',
  saturation: 'Saturation',
  absolute: 'Absolute Colorimetric',
}
