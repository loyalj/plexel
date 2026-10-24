/**
 * The font library: every font the app knows, by family and style, and
 * layout's font provider (text/layout.ts).
 *
 * A file can hold several faces (a collection), and a variable face has
 * named instances (Thin, Bold, Black Italic...): each is a style of its
 * family, the instance's coordinates applied when it's used. Fonts are
 * known before they're loaded (the system's, listed by Local Font Access,
 * and the built-in fallbacks): asking for one starts its load, layout uses
 * the default meanwhile, and `version` moves on when it arrives so text is
 * laid out again.
 *
 * Where fonts come from (bundled, the system, added, a document) is the
 * page's business (app/fonts.ts); this is the same in Node, for the checks.
 *
 * A font is asked for by family and style, and found (`resolve`) by the
 * first of: that family and style; a PostScript name (as Photoshop files
 * name fonts, with no style), then a family and style guessed from one;
 * a full name, PostScript name or family and style written another way
 * (spaces, hyphens, case and a trailing Regular don't count); the family's
 * nearest style. A system font keeps the names the browser listed it by
 * when its file is read, so text that asked for it by them still finds it;
 * the names in the file are kept too, as aliases the font menu doesn't list.
 * A font known but not read yet is `pending`, not missing.
 */
import { DEFAULT_FONT } from '../doc/text'
import { embeddable, type Face, type HarfBuzz } from './hb'
import type { FontProvider } from './layout'
import { Listeners } from '../lib/listeners'

export type FontSource = 'builtin' | 'local' | 'user' | 'document'

export interface FontEntry {
  family: string
  style: string
  weight: number
  italic: boolean
  source: FontSource
  /** The file it's in, by whatever key its source uses (a URL, a hash, a PostScript name). */
  file: string
  /** Which face in the file, and (a named instance) its coordinates. */
  index: number
  coords: Record<string, number>
  /** Whether its licence lets a document carry it. Unknown until loaded. */
  embeddable: boolean | null
  postscript: string
  /** Its full name ("Arial Bold"), when known. */
  full?: string
  /** Another name for a font listed under one of its own: found by it, not listed. */
  alias?: boolean
}

interface FileState {
  source: FontSource
  load: () => Promise<Uint8Array>
  state: 'known' | 'loading' | 'loaded' | 'failed'
  bytes?: Uint8Array
  faces: (Face | null)[]
}

/** Scripts the built-in fallbacks cover, by ISO 15924 tag. */
export type Fallbacks = Record<string, string[]>

const key = (family: string, style: string) => `${family.toLowerCase()}\u0000${style.toLowerCase()}`

export class FontLibrary implements FontProvider {
  private entries = new Map<string, FontEntry>()
  private files = new Map<string, FileState>()
  private fallbackFiles: Fallbacks = {}
  private changes = new Listeners()
  /** Moves on whenever a font arrives or the list changes: layouts made before it are stale. */
  version = 0

  constructor(private hb: HarfBuzz) {}

  subscribe = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }

  private changed() {
    this.version++
    this.changes.emit()
  }

  /**
   * A font file whose bytes are at hand: every face and named instance
   * registered now. Returns the entries made.
   */
  addFile(file: string, bytes: Uint8Array, source: FontSource): FontEntry[] {
    const st: FileState = { source, load: async () => bytes, state: 'loaded', bytes, faces: [] }
    this.files.set(file, st)
    const made = this.register(file, st)
    this.changed()
    return made
  }

  /** A file known by name, loaded when a font in it is first wanted. `entries` are what's known of it so far. */
  addLazy(file: string, source: FontSource, load: () => Promise<Uint8Array>, entries: Omit<FontEntry, 'file' | 'source' | 'embeddable'>[]) {
    if (this.files.has(file)) return
    this.files.set(file, { source, load, state: 'known', faces: [] })
    for (const e of entries) this.put({ ...e, file, source, embeddable: null })
    this.changed()
  }

  /** Fonts to try for characters of a script the chosen font lacks: files in the order given. */
  setFallbacks(f: Fallbacks) {
    this.fallbackFiles = f
  }

  private put(e: FontEntry) {
    const k = key(e.family, e.style)
    // A font already known from a better source (a document's own copy loses to nothing) stays.
    const have = this.entries.get(k)
    if (have && have.source !== 'document' && e.source === 'document') return
    this.entries.set(k, e)
  }

  /** Every face and instance in a file, as entries; put in the library unless `insert` is false. */
  private register(file: string, st: FileState, insert = true): FontEntry[] {
    const bytes = st.bytes!
    const made: FontEntry[] = []
    const count = Math.max(1, this.hb.faceCount(bytes))
    for (let i = 0; i < count; i++) {
      const face = this.hb.openFace(bytes, i)
      st.faces[i] = face
      if (!face) continue
      const info = face.info
      const base = { family: info.family, weight: info.weight, italic: info.italic, source: st.source, file, index: i, embeddable: embeddable(info.fsType), postscript: info.postscript, full: info.full }
      // A variable face's named instances are its styles; a static face is one.
      // Each instance has a PostScript name of its own, as Adobe makes one: the face's prefix and the instance's name.
      const prefix = info.postscript.split('-')[0] || info.family.replace(/[^A-Za-z0-9]/g, '')
      if (info.instances.length) for (const inst of info.instances) made.push({ ...base, style: inst.name, coords: inst.coords, weight: inst.coords.wght ?? info.weight, postscript: `${prefix}-${inst.name.replace(/[^A-Za-z0-9]/g, '')}` })
      if (!info.instances.some((x) => x.name.toLowerCase() === info.subfamily.toLowerCase())) made.push({ ...base, style: info.subfamily || 'Regular', coords: {} })
    }
    if (insert) for (const e of made) this.put(e)
    return made
  }

  /**
   * A system font's file read: the names the browser listed it by (`before`)
   * stay, now pointing at the face in the file they name (by PostScript
   * name, then style, then the nearest weight and slant); the file's own
   * names for it are aliases, and its other faces (a collection's, listed
   * by the browser on their own) are added only where nothing has the name.
   */
  private keepNames(before: FontEntry[], made: FontEntry[]) {
    const used = new Set<FontEntry>()
    for (const o of before) {
      const m =
        made.find((x) => x.postscript === o.postscript) ??
        made.find((x) => norm(x.style) === norm(o.style) && x.italic === o.italic) ??
        made.filter((x) => x.italic === o.italic).sort((a, b) => Math.abs(a.weight - o.weight) - Math.abs(b.weight - o.weight))[0] ??
        made[0]
      if (!m) continue
      used.add(m)
      this.entries.set(key(o.family, o.style), { ...m, family: o.family, style: o.style, postscript: o.postscript || m.postscript, ...(o.full ? { full: o.full } : {}) })
    }
    for (const m of made) {
      const k = key(m.family, m.style)
      if (this.entries.has(k)) continue
      this.entries.set(k, used.has(m) ? { ...m, alias: true } : m)
    }
  }

  private async load(file: string) {
    const st = this.files.get(file)
    if (!st || st.state !== 'known') return
    st.state = 'loading'
    try {
      st.bytes = await st.load()
      st.state = 'loaded'
      const before: FontEntry[] = []
      for (const [k, e] of [...this.entries])
        if (e.file === file) {
          before.push(e)
          this.entries.delete(k)
        }
      if (st.source === 'local' && before.length) this.keepNames(before, this.register(file, st, false))
      // A bundled font: what was known of it by name gives way to what the file says.
      else this.register(file, st)
    } catch {
      st.state = 'failed'
    }
    this.changed()
  }

  /** Every family, with its styles, the way the font menu lists them. */
  families(): { family: string; styles: FontEntry[] }[] {
    const by = new Map<string, FontEntry[]>()
    for (const e of this.entries.values()) if (!e.alias) by.set(e.family, [...(by.get(e.family) ?? []), e])
    return [...by]
      .map(([family, styles]) => ({ family, styles: styles.sort((a, b) => Number(a.italic) - Number(b.italic) || a.weight - b.weight || a.style.localeCompare(b.style)) }))
      .sort((a, b) => a.family.localeCompare(b.family))
  }

  entry(family: string, style: string): FontEntry | null {
    return this.entries.get(key(family, style)) ?? null
  }

  /** The font asked for by a family and style, by the first name that finds it (see the top); null when nothing does. */
  resolve(family: string, style: string): FontEntry | null {
    const exact = this.entry(family, style)
    if (exact) return exact
    if (!style) {
      // A PostScript name, as a Photoshop file gives it.
      const ps = this.byPostscript(family)
      if (ps) return ps
      const g = guessFamily(family)
      const guessed = this.entry(g.family, g.style) ?? (this.hasFamily(g.family) ? this.nearest(g.family, g.style) : null)
      if (guessed) return guessed
    }
    const want = norm(family + style)
    const wantFamily = norm(family)
    for (const e of this.entries.values()) {
      if (norm(e.postscript) === want || norm(e.family + e.style) === want || (e.full && norm(e.full) === want)) return e
      if (!style && (norm(e.postscript) === wantFamily || (e.full && norm(e.full) === wantFamily))) return e
    }
    return this.hasFamily(family) ? this.nearest(family, style) : null
  }

  /** Whether a font face() has nothing for yet is known and still loading (or about to): pending, not missing. */
  pending(family: string, style: string): boolean {
    const e = this.resolve(family, style)
    const st = e ? this.files.get(e.file) : undefined
    return !!st && (st.state === 'known' || st.state === 'loading')
  }

  /** Where a font is: here, on its way, or not to be had. */
  status(family: string, style: string): 'ready' | 'loading' | 'missing' {
    const e = this.resolve(family, style)
    const st = e ? this.files.get(e.file) : undefined
    if (!st || st.state === 'failed') return 'missing'
    return st.state === 'loaded' ? 'ready' : 'loading'
  }

  /** Starts loading a font's file without waiting for it (the font menu's previews). */
  want(family: string, style: string) {
    const e = this.resolve(family, style)
    if (e) void this.load(e.file)
  }

  /**
   * A font by its PostScript name (as Photoshop files name them): a face or
   * a variable font's instance named so exactly, a static face before an
   * instance; otherwise a variable face's own name, as its Regular.
   */
  byPostscript(name: string): FontEntry | null {
    let found: FontEntry | null = null
    for (const e of this.entries.values()) {
      if (e.postscript !== name) continue
      if (!Object.keys(e.coords).length) return e
      found ??= e
    }
    if (found) return found
    const prefix = name.split('-')[0]
    const faces = [...this.entries.values()].filter((e) => Object.keys(e.coords).length && e.postscript.split('-')[0] === prefix)
    return faces.find((e) => /^regular$/i.test(e.style)) ?? faces[0] ?? null
  }

    /** Whether a family is known at all (loaded or not). */
  hasFamily(family: string): boolean {
    const f = family.toLowerCase()
    for (const e of this.entries.values()) if (e.family.toLowerCase() === f) return true
    return false
  }

  /** The bytes of the file a font is in, when loaded: for embedding in a document. */
  bytesOf(family: string, style: string): Uint8Array | null {
    const e = this.resolve(family, style)
    return e ? (this.files.get(e.file)?.bytes ?? null) : null
  }

  /**
   * The face for a family and style, ready to shape with; null when it
   * isn't known, or not loaded yet (its load starts, and `version` moves
   * when it's in). A family known in another style gives its nearest.
   */
  face(family: string, style: string): { face: Face; coords: Record<string, number> } | null {
    const e = this.resolve(family, style)
    if (!e) return null
    const st = this.files.get(e.file)
    if (!st) return null
    if (st.state !== 'loaded') {
      void this.load(e.file)
      return null
    }
    const face = st.faces[e.index]
    return face ? { face, coords: e.coords } : null
  }

  /** The style of a family closest to the one asked for: by weight and slant, read from its name. */
  private nearest(family: string, style: string): FontEntry | null {
    const want = styleWeight(style)
    const italic = /italic|oblique/i.test(style)
    let best: FontEntry | null = null
    let score = Infinity
    for (const e of this.entries.values()) {
      if (e.family.toLowerCase() !== family.toLowerCase()) continue
      const s = Math.abs(e.weight - want) + (e.italic === italic ? 0 : 1000)
      if (s < score) {
        score = s
        best = e
      }
    }
    return best
  }

  fallbacks(script: string): Face[] {
    const out: Face[] = []
    for (const file of this.fallbackFiles[script] ?? []) {
      const st = this.files.get(file)
      if (!st) continue
      if (st.state === 'known') void this.load(file)
      for (const f of st.faces) if (f) out.push(f)
    }
    // Then the default, for anything common.
    const d = this.face(DEFAULT_FONT, 'Regular')
    if (d && !out.includes(d.face)) out.push(d.face)
    return out
  }

  defaultFace(): { face: Face; coords: Record<string, number> } {
    const d = this.face(DEFAULT_FONT, 'Regular')
    if (d) return d
    // Whatever's loaded, while the default isn't yet.
    for (const st of this.files.values()) for (const f of st.faces) if (f) return { face: f, coords: {} }
    throw new Error('No font is loaded')
  }

  /** Whether any font is ready to lay text out with. */
  ready(): boolean {
    for (const st of this.files.values()) if (st.faces.some(Boolean)) return true
    return false
  }
}

/** A name compared loosely: case, spaces, hyphens and a trailing "Regular" or "MT" left out. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/(regular|roman|book|normal)$/, '')
    .replace(/mt$/, '')

const STYLES: [RegExp, string][] = [
  [/^(BoldItalic|BoldIt|BdIt)$/i, 'Bold Italic'],
  [/^(Bold|Bd)$/i, 'Bold'],
  [/^(Italic|It|Oblique)$/i, 'Italic'],
  [/^(Semibold|SemiBold|Sb|Demi|DemiBold)$/i, 'SemiBold'],
  [/^(SemiboldIt|SemiboldItalic)$/i, 'SemiBold Italic'],
  [/^(Light|Lt)$/i, 'Light'],
  [/^(Medium|Md)$/i, 'Medium'],
  [/^(Black|Blk|Heavy)$/i, 'Black'],
  [/^(Regular|Roman|Book|Normal|Rg)$/i, 'Regular'],
]

/**
 * A PostScript name as a family and style, for a font not found by it:
 * "Arial-BoldMT" is Arial Bold, "MyriadPro-Regular" Myriad Pro Regular.
 */
export function guessFamily(ps: string): { family: string; style: string } {
  const [base, rest = 'Regular'] = ps.replace(/MT$/, '').split('-')
  const family = base.replace(/MT$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  const tail = rest.replace(/MT$/, '')
  const style = STYLES.find(([re]) => re.test(tail))?.[1] ?? tail.replace(/([a-z])([A-Z])/g, '$1 $2')
  return { family: family || ps, style: style || 'Regular' }
}

/** A weight from a style's name: Thin 100 to Black 900, Regular 400. */
export function styleWeight(style: string): number {
  const s = style.toLowerCase().replace(/[\s-]/g, '')
  const table: [RegExp, number][] = [
    [/thin|hairline/, 100],
    [/extralight|ultralight/, 200],
    [/light/, 300],
    [/medium/, 500],
    [/semibold|demibold/, 600],
    [/extrabold|ultrabold/, 800],
    [/bold/, 700],
    [/black|heavy/, 900],
  ]
  for (const [re, w] of table) if (re.test(s)) return w
  return 400
}
