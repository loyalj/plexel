/**
 * What the font menu (ui/FontPicker.tsx) keeps and knows beyond the
 * library: favourite families and the ones used lately (kept in this
 * browser), what kind of face a family is, and how to draw its name in it.
 *
 * Kinds come from the family's name (Mono, Serif, Script and the names of
 * the best-known faces), so a font needn't be read to be sorted: sans serif
 * is what's left. Names are drawn in their own face: a system font by its
 * family name, which the browser finds itself; any other (built in, added,
 * a document's) from its bytes, once, as a FontFace of its own.
 */
import { Listeners } from '../lib/listeners'
import type { FontLibrary } from '../text/fonts'

const KEY = 'plexel.fontMenu'
const RECENT = 10

interface Prefs {
  favourites: string[]
  recent: string[]
}

function read(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>
    const list = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string').slice(0, 500) : [])
    return { favourites: list(v.favourites), recent: list(v.recent).slice(0, RECENT) }
  } catch {
    return { favourites: [], recent: [] }
  }
}

let prefs: Prefs | null = null
const changes = new Listeners()

function save(next: Prefs) {
  prefs = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Kept for this session only.
  }
  changes.emit()
}

export const fontMenu = {
  get: (): Prefs => (prefs ??= read()),
  subscribe: (fn: () => void) => changes.subscribe(fn),
  isFavourite: (family: string) => fontMenu.get().favourites.includes(family),
  toggleFavourite(family: string) {
    const p = fontMenu.get()
    save({ ...p, favourites: p.favourites.includes(family) ? p.favourites.filter((f) => f !== family) : [...p.favourites, family] })
  },
  /** A family picked: first among the recent ones. */
  used(family: string) {
    const p = fontMenu.get()
    save({ ...p, recent: [family, ...p.recent.filter((f) => f !== family)].slice(0, RECENT) })
  },
}

export type FontKind = 'sans' | 'serif' | 'mono' | 'script' | 'display'

export const FONT_KINDS: [FontKind, string][] = [
  ['sans', 'Sans'],
  ['serif', 'Serif'],
  ['mono', 'Mono'],
  ['script', 'Script'],
  ['display', 'Display'],
]

const MONO = /mono|code|courier|consol|menlo|inconsolata|terminal|typewriter|fixed/i
const SCRIPT = /script|hand|brush|callig|cursive|comic|marker|chalk|signature|pacifico|lobster|vivaldi|kunstler|edwardian|segoe print|ink free|mistral|gabriola|freestyle|bradley|lucida handwriting/i
const DISPLAY = /display|poster|stencil|impact|black ?letter|fraktur|gothic|western|bauhaus|broadway|jokerman|showcard|chiller|cooper|algerian|bebas|haettenschweiler|headline|deco|titling/i
const SERIF = /(?<!sans )serif|times|georgia|garamond|baskerville|bodoni|cambria|caslon|didot|palatino|book antiqua|century|constantia|minion|merriweather|playfair|libre baskerville|crimson|lora|charter|rockwell|sylfaen|perpetua|goudy|bookman|cochin|hoefler|sitka|noto serif|pt serif|source serif|roman/i

/** What kind of face a family is, from its name. */
export function fontKind(family: string): FontKind {
  if (MONO.test(family)) return 'mono'
  if (SCRIPT.test(family)) return 'script'
  if (DISPLAY.test(family)) return 'display'
  if (/sans/i.test(family)) return 'sans'
  if (SERIF.test(family)) return 'serif'
  return 'sans'
}

/** CSS families made for faces drawn from their bytes, by family. */
const faces = new Map<string, string>()

/**
 * The CSS font-family that draws a family's name in its own face: a system
 * font's own name; another's bytes, once loaded, as a face of their own
 * (nothing yet otherwise: the name is drawn in the interface's face).
 */
export function previewFamily(lib: FontLibrary, family: string, styles: { style: string; source: string }[]): string | null {
  const first = styles.find((s) => /^(regular|book|roman|normal)$/i.test(s.style)) ?? styles[0]
  if (!first) return null
  if (first.source === 'local') return `"${family.replace(/"/g, '')}"`
  const had = faces.get(family)
  if (had) return had
  const bytes = lib.bytesOf(family, first.style)
  if (!bytes || typeof FontFace === 'undefined') {
    lib.want(family, first.style)
    return null
  }
  const name = `plexel-preview-${faces.size}`
  try {
    const face = new FontFace(name, bytes.slice().buffer)
    document.fonts.add(face)
    void face.load().catch(() => {})
  } catch {
    return null
  }
  faces.set(family, `"${name}"`)
  return `"${name}"`
}
