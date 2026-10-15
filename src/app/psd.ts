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
import { fontLibrary } from './fonts'
import { notify } from './notices'
import { isCancelled, runJob } from './jobs'


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
 * A PostScript name as a family and style, for a font that isn't here:
 * "Arial-BoldMT" is Arial Bold, "MyriadPro-Regular" Myriad Pro Regular.
 */
function guessFamily(ps: string): { family: string; style: string } {
  const [base, rest = 'Regular'] = ps.replace(/MT$/, '').split('-')
  const family = base.replace(/MT$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  const tail = rest.replace(/MT$/, '')
  const style = STYLES.find(([re]) => re.test(tail))?.[1] ?? tail.replace(/([a-z])([A-Z])/g, '$1 $2')
  return { family: family || ps, style: style || 'Regular' }
}

/** Each run's font from its PostScript name (style left empty by the import) to a family and style. */
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
          const e = lib?.byPostscript(ps)
          const props: Partial<CharProps> = { ...r.props, ...(e ? { font: e.family, style: e.style } : guessFamily(ps)) }
          if (!e) props.font = guessFamily(ps).family
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
