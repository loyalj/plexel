/**
 * Fonts on the page: the shaper (HarfBuzz in WebAssembly) and the font
 * library (text/fonts.ts), filled from four places:
 *
 * - built in: Inter (a variable font, the default) and Noto fallbacks for
 *   Arabic and Devanagari, under /fonts, each fetched when first wanted;
 * - the system's, listed by Local Font Access in Chromium when asked
 *   (Type → Load System Fonts; the browser asks permission), each read when
 *   first used;
 * - added by the user (Type → Add Fonts…), kept in the browser's private
 *   storage (OPFS) so they're there next time;
 * - a document's own, carried in its .pxll file.
 *
 * Text is laid out with whatever is loaded; when a font arrives the
 * library's version moves on and text is laid out again (app/text.ts).
 */
import wasmUrl from '../text/wasm/pxhb.wasm?url'
import { startHarfBuzz } from '../text/hb'
import { FontLibrary, styleWeight, type FontEntry } from '../text/fonts'
import { sha256 } from '../io/assets'
import { notify } from './notices'

let library: FontLibrary | null = null
let starting: Promise<FontLibrary> | null = null

const INTER_WEIGHTS: [string, number][] = [
  ['Thin', 100],
  ['ExtraLight', 200],
  ['Light', 300],
  ['Regular', 400],
  ['Medium', 500],
  ['SemiBold', 600],
  ['Bold', 700],
  ['ExtraBold', 800],
  ['Black', 900],
]

const fetchBytes = (url: string) => async () => new Uint8Array(await (await fetch(url)).arrayBuffer())

/**
 * The font library, started the first time anything asks: the shaper,
 * then Inter's upright face (the default) loaded before it resolves, so
 * text can always be laid out.
 */
export function fontLibrary(): Promise<FontLibrary> {
  return (starting ??= (async () => {
    const hb = await startHarfBuzz(await (await fetch(wasmUrl)).arrayBuffer())
    const lib = new FontLibrary(hb)
    lib.addFile('/fonts/InterVariable.ttf', await fetchBytes('/fonts/InterVariable.ttf')(), 'builtin')
    const base = { family: 'Inter Variable', italic: true, index: 0 }
    lib.addLazy(
      '/fonts/InterVariable-Italic.ttf',
      'builtin',
      fetchBytes('/fonts/InterVariable-Italic.ttf'),
      INTER_WEIGHTS.map(([name, wght]) => {
        const style = name === 'Regular' ? 'Italic' : `${name} Italic`
        // Each instance's own PostScript name, as the library makes them once the file is read.
        return { ...base, style, weight: wght, coords: { wght }, postscript: `InterVariableItalic-${style.replace(/[^A-Za-z0-9]/g, '')}` }
      }),
    )
    lib.addLazy('/fonts/NotoSansArabic-Regular.ttf', 'builtin', fetchBytes('/fonts/NotoSansArabic-Regular.ttf'), [{ family: 'Noto Sans Arabic', style: 'Regular', weight: 400, italic: false, index: 0, coords: {}, postscript: 'NotoSansArabic-Regular' }])
    lib.addLazy('/fonts/NotoSansDevanagari-Regular.ttf', 'builtin', fetchBytes('/fonts/NotoSansDevanagari-Regular.ttf'), [{ family: 'Noto Sans Devanagari', style: 'Regular', weight: 400, italic: false, index: 0, coords: {}, postscript: 'NotoSansDevanagari-Regular' }])
    lib.setFallbacks({ Arab: ['/fonts/NotoSansArabic-Regular.ttf'], Deva: ['/fonts/NotoSansDevanagari-Regular.ttf'] })
    library = lib
    void loadUserFonts(lib)
    return lib
  })())
}

/** The library if it has started, for code that can't wait (layout on the page). */
export const fontLibraryNow = () => library

// --- system fonts -------------------------------------------------------------------------------

interface LocalFontData {
  family: string
  style: string
  fullName: string
  postscriptName: string
  blob(): Promise<Blob>
}

export const canLoadSystemFonts = () => typeof (globalThis as { queryLocalFonts?: unknown }).queryLocalFonts === 'function'

let systemLoaded = false
export const systemFontsLoaded = () => systemLoaded

/** Type → Load System Fonts: the fonts installed on this computer, listed (the browser asks first). */
export async function loadSystemFonts(): Promise<number> {
  const query = (globalThis as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts
  if (!query) {
    notify('info', 'This browser doesn’t let pages list the fonts installed on the computer. Type → Add Fonts… adds font files.')
    return 0
  }
  const lib = await fontLibrary()
  let list: LocalFontData[]
  try {
    list = await query()
  } catch {
    notify('info', 'Plexel wasn’t allowed to list the system’s fonts. Type → Add Fonts… adds font files instead.')
    return 0
  }
  for (const fd of list) {
    lib.addLazy(`local:${fd.postscriptName}`, 'local', async () => new Uint8Array(await (await fd.blob()).arrayBuffer()), [
      { family: fd.family, style: fd.style, weight: styleWeight(fd.style), italic: /italic|oblique/i.test(fd.style), index: 0, coords: {}, postscript: fd.postscriptName },
    ])
  }
  systemLoaded = true
  return list.length
}

// --- fonts the user adds ------------------------------------------------------------------------

const FONT_DIR = 'fonts'

async function fontDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(FONT_DIR, { create: true })
  } catch {
    return null
  }
}

async function loadUserFonts(lib: FontLibrary) {
  const dir = await fontDir()
  if (!dir) return
  for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (handle.kind !== 'file') continue
    try {
      const bytes = new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer())
      lib.addFile(`user:${name}`, bytes, 'user')
    } catch {
      // A damaged copy is left; the rest still load.
    }
  }
}

/** Type → Add Fonts…: font files (TrueType, OpenType, collections) kept for good. Returns the families added. */
export async function addFontFiles(files: File[]): Promise<string[]> {
  const lib = await fontLibrary()
  const dir = await fontDir()
  const families = new Set<string>()
  const refused: string[] = []
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const hash = await sha256(bytes)
    let made: FontEntry[] = []
    try {
      made = lib.addFile(`user:${hash}`, bytes, 'user')
    } catch {
      made = []
    }
    if (!made.length) {
      refused.push(file.name)
      continue
    }
    for (const e of made) families.add(e.family)
    if (dir) {
      try {
        const w = await (await dir.getFileHandle(hash, { create: true })).createWritable()
        await w.write(bytes as BufferSource)
        await w.close()
      } catch {
        // Used now, not kept: said below.
      }
    }
  }
  if (refused.length) notify('warning', `${refused.join(', ')} ${refused.length === 1 ? 'isn’t a font' : 'aren’t fonts'} Plexel can read: TrueType (.ttf), OpenType (.otf) and collections (.ttc) are.`)
  return [...families]
}

/** A document's own fonts, from its file: registered as the document's, behind any of the same name already here. */
export async function addDocumentFonts(fonts: Map<string, Uint8Array>) {
  if (!fonts.size) return
  const lib = await fontLibrary()
  for (const [hash, bytes] of fonts) lib.addFile(`doc:${hash}`, bytes, 'document')
}
