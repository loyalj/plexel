/**
 * Photoshop files on the page: opened (the engine parses and maps them,
 * engine/psdHost.ts) into a new document, their embedded profiles kept,
 * and their text's fonts found by PostScript name.
 *
 * An opened PSD isn't tied to its file: saving makes a .pxll, as with an
 * image; File → Export writes a PSD (app/exports.ts).
 */
import type { CharProps } from '../doc/text'
import type { Doc, DocNode } from '../doc/types'
import { engine } from '../engine/EngineHost'
import { assets } from '../io/assets'
import type { FontLibrary } from '../text/fonts'
import { colourSettings } from './colourSettings'
import { documents } from './documents'
import { fontLibrary, systemFontsSettled } from './fonts'
import { notify } from './notices'
import { isCancelled, runJob } from './jobs'

/** Each run's font from its PostScript name (style left empty by the import) to a family and style, where the font is here. */
function resolveFonts(doc: Doc, lib: FontLibrary | null): Doc {
  const fix = (d: Doc): Doc => {
    const nodes: Record<string, DocNode> = {}
    let changed = false
    for (const [id, n] of Object.entries(d.nodes)) {
      if (n.kind === 'embedded' && n.props.content) {
        const c = fix(n.props.content)
        if (c !== n.props.content) {
          nodes[id] = { ...n, props: { ...n.props, content: c } } as DocNode
          changed = true
          continue
        }
      }
      if (n.kind !== 'text') {
        nodes[id] = n
        continue
      }
      const paragraphs = n.props.content.paragraphs.map((p) => ({
        ...p,
        runs: p.runs.map((r) => {
          const ps = r.props.font
          if (!ps || r.props.style !== '') return r
          // Found now: its family and style. Not here: the PostScript name is kept, with no style, for the
          // library to find it by when it arrives (text/fonts.ts, resolve), or guess a family from meanwhile.
          const e = lib?.resolve(ps, '')
          if (!e) return r
          const props: Partial<CharProps> = { ...r.props, font: e.family, style: e.style }
          return { ...r, props }
        }),
      }))
      nodes[id] = { ...n, props: { ...n.props, content: { ...n.props.content, paragraphs } } } as DocNode
      changed = true
    }
    return changed ? { ...d, nodes } : d
  }
  return fix(doc)
}

export async function openPsd(file: File): Promise<boolean> {
  try {
    const s = colourSettings.get()
    const bytes = new Uint8Array(await file.arrayBuffer())
    // The file's bytes are handed over, not copied: a big PSD is hundreds of megabytes.
    const r = await runJob(`Opening “${file.name}”`, (job) => engine().call('psd.open', { bytes, name: file.name, working: s.working, intent: s.intent, bpc: s.blackPointCompensation, job }, [bytes.buffer]))
    for (const p of r.profiles) await assets().putAs(p.hash, p.bytes)
    const lib = r.fonts.length ? await fontLibrary().catch(() => null) : null
    // The system's fonts, when the browser lets them be listed without asking, are listed first.
    if (lib) await systemFontsSettled()
    const doc = resolveFonts(r.doc, lib)
    documents().add({ doc, file: null, saved: false, label: 'Open Photoshop File' })
    if (r.warnings.length) notify('warning', `“${file.name}” opened, with a few things that couldn’t come over as they were.`, r.warnings)
    return true
  } catch (e) {
    if (isCancelled(e)) return false
    notify('error', `“${file.name}” couldn’t be opened.`, [e instanceof Error ? e.message : String(e)])
    return false
  }
}
