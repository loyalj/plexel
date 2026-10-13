/**
 * Appearance: which palette the interface is painted in.
 *
 * Two independent axes, as in Fresyn. A *theme* is a family of colours and a
 * *mode* is dark or light, and every theme has both, so picking one never
 * undoes the other.
 *
 * The values live in theme.css. This module only knows the names, because
 * a palette is the stylesheet's business. The one rule a theme can't break
 * is the pasteboard: it stays a neutral grey in every palette, because the
 * colour around an image changes how the image's colours are seen.
 * check-theme holds every palette to that.
 */

export type ThemeId = 'graphite' | 'darkroom' | 'fjord'
export type Mode = 'dark' | 'light'

export interface Appearance {
  theme: ThemeId
  mode: Mode
}

export interface ThemeInfo {
  id: ThemeId
  /** As it appears in the menu and the palette. */
  name: string
}

/** The order the menu lists them in. */
export const THEMES: ThemeInfo[] = [
  { id: 'graphite', name: 'Graphite' },
  { id: 'darkroom', name: 'Darkroom' },
  { id: 'fjord', name: 'Fjord' },
]

export const DEFAULT_APPEARANCE: Appearance = { theme: 'graphite', mode: 'dark' }

const KEY = 'plexel.appearance.v1'
const THEME_IDS = new Set<string>(THEMES.map((t) => t.id))

/**
 * Paint the document. Attributes on <html> rather than a class, so each
 * combination is one selector and no rule has to care which one is on.
 */
export function applyAppearance(a: Appearance) {
  const root = document.documentElement
  root.dataset.theme = a.theme
  root.dataset.mode = a.mode
}

/**
 * Guarded: storage throws outright in some private windows, and losing a
 * colour preference is never a reason to take the app down with it.
 */
export function loadAppearance(): Appearance {
  let text: string | null = null
  try {
    text = localStorage.getItem(KEY)
  } catch {
    return DEFAULT_APPEARANCE
  }
  if (!text) return DEFAULT_APPEARANCE
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) return DEFAULT_APPEARANCE
    const { theme, mode } = raw as Partial<Appearance>
    // A theme since renamed or removed falls back, rather than leaving
    // <html> with an attribute no selector matches.
    return {
      theme: typeof theme === 'string' && THEME_IDS.has(theme) ? (theme as ThemeId) : DEFAULT_APPEARANCE.theme,
      mode: mode === 'light' || mode === 'dark' ? mode : DEFAULT_APPEARANCE.mode,
    }
  } catch {
    return DEFAULT_APPEARANCE
  }
}

export function saveAppearance(a: Appearance) {
  try {
    localStorage.setItem(KEY, JSON.stringify(a))
  } catch {
    // The choice simply won't survive the tab.
  }
}
