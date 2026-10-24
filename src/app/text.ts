/**
 * Text on the page: each text node laid out (text/layout.ts) with the fonts
 * loaded, once per change, and its glyphs attached to the node on its way
 * to the engine, which draws them as it draws shapes. When a font arrives,
 * text that asked for it is laid out again and sent again.
 *
 * A text layer opened from a Photoshop file keeps the pixels Photoshop drew
 * it with (its `stand`): while a font it asks for is missing or still
 * loading, the engine gets those pixels in place of the glyphs, so it looks
 * as it did in Photoshop until the font is here or the text is edited.
 *
 * Fonts start loading the first time a document with text is open or the
 * Type tool is chosen, not before; so does the layout itself (text/layout.ts,
 * with its line breaking and bidi tables), which isn't in the app's first
 * download.
 */
import type { Affine, Doc, DocNode, TextStand } from '../doc/types'
import { compose } from '../geom/affine'
import { geometryPath } from '../doc/vector'
import { EMPTY_GLYPHS } from '../geom/glyphs'
import type { TextLayout, layoutText as LayoutText } from '../text/layout'
import { engine } from '../engine/EngineHost'
import { tools } from '../tools'
import { documents } from './documents'
import { fontLibrary, fontLibraryNow, systemFontsSettled } from './fonts'
import { hyphenation } from '../text/hyphenate'
import { notify } from './notices'
import { Listeners } from '../lib/listeners'

type TextNode = DocNode & { kind: 'text' }

const layouts = new WeakMap<DocNode, { version: string; styles: Doc['textStyles']; layout: TextLayout }>()

/** What a layout depends on beyond the node: the fonts' version and the hyphenation patterns'. */
const versionNow = () => `${fontLibraryNow()?.version ?? -1}|${hyphenation().version}`

/** The layout module, once loaded (with the fonts, in start). */
let layoutText: typeof LayoutText | null = null

/** A text node laid out with the fonts loaded now; null until any are, and the layout is. */
export function layoutOf(node: DocNode, doc: Doc): TextLayout | null {
  if (node.kind !== 'text') return null
  const lib = fontLibraryNow()
  if (!lib?.ready() || !layoutText) return null
  const hit = layouts.get(node)
  const version = versionNow()
  if (hit && hit.version === version && hit.styles === doc.textStyles) return hit.layout
  const n = node as TextNode
  const layout = layoutText({ content: n.props.content, styles: doc.textStyles, mode: n.props.mode, frame: n.props.frame ? geometryPath(n.props.frame) : null, pathOffset: n.props.pathOffset, hyphenator: hyphenation() }, lib)
  layouts.set(node, { version, styles: doc.textStyles, layout })
  noteMissing(layout, lib.version)
  return layout
}

const decorated = new WeakMap<DocNode, { version: string; styles: Doc['textStyles']; node: DocNode }>()

/** A node as the engine gets it: text with its glyphs, a smart object with its contents' text likewise. */
function decorate(node: DocNode, doc: Doc): DocNode {
  const version = versionNow()
  const hit = decorated.get(node)
  if (hit && hit.version === version && hit.styles === doc.textStyles) return hit.node
  let out = node
  if (node.kind === 'text') {
    const layout = layoutOf(node, doc)
    const stand = node.props.stand
    out = stand && (!layout || layout.missing.length || layout.pending.length) ? standIn(node, stand) : ({ ...node, props: { ...node.props, layout: layout?.glyphs ?? EMPTY_GLYPHS } } as DocNode)
  } else if (node.kind === 'embedded' && node.props.content) {
    const c = node.props.content
    if (Object.values(c.nodes).some((n) => n.kind === 'text' || n.kind === 'embedded')) {
      const nodes = Object.fromEntries(Object.entries(c.nodes).map(([id, n]) => [id, n.kind === 'text' || n.kind === 'embedded' ? decorate(n, c) : n]))
      out = { ...node, props: { ...node.props, content: { ...c, nodes } } } as DocNode
    }
  }
  decorated.set(node, { version, styles: doc.textStyles, node: out })
  return out
}

/** A text node as the engine gets it while its fonts aren't here: the pixels another app drew it with, placed through the node. */
function standIn(node: TextNode, stand: TextStand): DocNode {
  return { ...node, kind: 'pixel', props: { tiles: stand.tiles, resample: 'bicubic' }, transform: compose(node.transform, stand.m) as Affine } as unknown as DocNode
}

// --- missing fonts -----------------------------------------------------------------------------

/** Fonts already warned about, and those a layout found missing, with the library's version then. */
const told = new Set<string>()
const seen = new Map<string, number>()
let saying: Promise<void> | null = null

/**
 * A layout's missing fonts, warned about once each: after the system's
 * fonts have been listed (when the browser lets them be without asking) and
 * text has been laid out again with them, only those still missing then.
 * Fonts still loading aren't missing (TextLayout.pending).
 */
function noteMissing(layout: TextLayout, version: number) {
  for (const m of layout.missing) if (!told.has(m)) seen.set(m, version)
  if (!seen.size || saying) return
  saying = (async () => {
    await systemFontsSettled()
    // Two frames: a font list arriving lays text out again on the next one.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    saying = null
    const now = fontLibraryNow()?.version
    const fresh = [...seen].filter(([m, v]) => v === now && !told.has(m)).map(([m]) => m)
    seen.clear()
    if (!fresh.length) return
    for (const m of fresh) told.add(m)
    notify('warning', `${fresh.length === 1 ? 'A font this document uses isn’t' : 'Fonts this document uses aren’t'} available: ${fresh.join(', ')}. Its text is shown in Inter (text from a Photoshop file as Photoshop drew it) until ${fresh.length === 1 ? 'it’s' : 'they’re'} added (Type → Add Fonts…, or Load System Fonts). The text keeps asking for ${fresh.length === 1 ? 'it' : 'them'}.`)
  })()
}

// --- starting ------------------------------------------------------------------------------------

let started = false

/**
 * Moves on whenever text is laid out again for fonts (the library starting,
 * a font arriving), for what shows text other than the canvas: the Layers
 * panel's thumbnails.
 */
let epoch = 0
const epochChanges = new Listeners()
const bumpEpoch = () => {
  epoch++
  epochChanges.emit()
}
export const textEpoch = {
  get: () => epoch,
  subscribe: (fn: () => void) => {
    return epochChanges.subscribe(fn)
  },
}

/** The fonts and the layout, both: what start waits for, and startFonts gives. */
let ready: Promise<Awaited<ReturnType<typeof fontLibrary>>> | null = null

function start() {
  if (started) return
  started = true
  ready = Promise.all([fontLibrary(), import('../text/layout')]).then(([lib, m]) => {
    layoutText = m.layoutText
    return lib
  })
  void ready.then((lib) => {
    engine().setDecorator(decorate)
    bumpEpoch()
    // A font or a language's hyphenation arriving: text is laid out and sent again, once a frame at most.
    let pending = false
    const again = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        engine().redecorate()
        bumpEpoch()
      })
    }
    lib.subscribe(again)
    hyphenation().subscribe(again)
  })
}

const hasText = (doc: Doc): boolean => Object.values(doc.nodes).some((n) => n.kind === 'text' || (n.kind === 'embedded' && !!n.props.content && hasText(n.props.content)))

documents().subscribe(() => {
  if (!started && documents().getState().docs.some((d) => hasText(d.history.present))) start()
})
tools().subscribe(() => {
  if (tools().get() === 'type') start()
})

/** Starts the fonts now: the checks and the Type tool call it. */
export const startFonts = () => {
  start()
  return ready!
}
