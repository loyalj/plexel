/**
 * Fonts travelling with documents. A saved .pxll carries the files of the
 * fonts its text uses (fonts/<hash>.font), where the font's licence lets it
 * be embedded in an editable document, so it opens with its text as it was
 * on another computer. Built-in fonts aren't carried: every copy of Plexel
 * has them.
 *
 * The journal keeps fonts that came from a document likewise, so a session
 * restored after a crash still has them.
 */
import { fontsUsed } from '../doc/text'
import type { Doc } from '../doc/types'
import { sha256 } from '../io/assets'
import { fontLibraryNow } from './fonts'




/**
 * The font files to carry with a document: used by its text, loaded, not
 * built in, and allowed by their licences. `sources` narrows which (the
 * journal keeps only a document's own).
 */
export async function fontsToCarry(doc: Doc, sources: ('local' | 'user' | 'document')[] = ['local', 'user', 'document']): Promise<{ hash: string; bytes: Uint8Array }[]> {
  const lib = fontLibraryNow()
  if (!lib) return []
  const out = new Map<string, Uint8Array>()
  for (const { family, style } of fontsUsed(doc)) {
    const e = lib.resolve(family, style)
    if (!e || e.source === 'builtin' || !sources.includes(e.source) || e.embeddable === false) continue
    const bytes = lib.bytesOf(family, style)
    if (!bytes) continue
    out.set(await sha256(bytes), bytes)
  }
  return [...out].map(([hash, bytes]) => ({ hash, bytes }))
}
