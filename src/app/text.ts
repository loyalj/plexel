/**
 * Text on the page: each text node laid out (text/layout.ts) with the fonts
 * loaded, once per change, and its glyphs attached to the node on its way
 * to the engine, which draws them as it draws shapes. When a font arrives,
 * text that asked for it is laid out again and sent again.
 *
 * Fonts start loading the first time a document with text is open or the
 * Type tool is chosen, not before; so does the layout itself (text/layout.ts,
 * with its line breaking and bidi tables), which isn't in the app's first
 * download.
 */
import type { Doc, DocNode } from '../doc/types'
import { geometryPath } from '../doc/vector'
import { EMPTY_GLYPHS } from '../geom/glyphs'
import type { TextLayout, layoutText as LayoutText } from '../text/layout'
import { engine } from '../engine/EngineHost'
import { tools } from '../tools'
import { documents } from './documents'
import { fontLibrary, fontLibraryNow } from './fonts'
import { notify } from './notices'
import { Listeners } from '../lib/listeners'

type TextNode = DocNode & { kind: 'text' }

const layouts = new WeakMap<DocNode, { version: number; styles: Doc['textStyles']; layout: TextLayout }>()

/** The layout module, once loaded (with the fonts, in start). */
let layoutText: typeof LayoutText | null = null

/** A text node laid out with the fonts loaded now; null until any are, and the layout is. */
export function layoutOf(node: DocNode, doc: Doc): TextLayout | null {
  if (node.kind !== 'text') return null
  const lib = fontLibraryNow()
  if (!lib?.ready() || !layoutText) return null
  const hit = layouts.get(node)
  if (hit && hit.version === lib.version && hit.styles === doc.textStyles) return hit.layout
  const n = node as TextNode
  const layout = layoutText({ content: n.props.content, styles: doc.textStyles, mode: n.props.mode, frame: n.props.frame ? geometryPath(n.props.frame) : null, pathOffset: n.props.pathOffset }, lib)
  layouts.set(node, { version: lib.version, styles: doc.textStyles, layout })
  noteMissing(doc, layout)
  return layout
}

const decorated = new WeakMap<DocNode, { version: number; styles: Doc['textStyles']; node: DocNode }>()

/** A node as the engine gets it: text with its glyphs, a smart object with its contents' text likewise. */
function decorate(node: DocNode, doc: Doc): DocNode {
  const lib = fontLibraryNow()
  const version = lib?.version ?? -1
  const hit = decorated.get(node)
  if (hit && hit.version === version && hit.styles === doc.textStyles) return hit.node
  let out = node
  if (node.kind === 'text') {
    out = { ...node, props: { ...node.props, layout: layoutOf(node, doc)?.glyphs ?? EMPTY_GLYPHS } } as DocNode
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

// --- missing fonts -----------------------------------------------------------------------------

const told = new Set<string>()

function noteMissing(doc: Doc, layout: TextLayout) {
  const fresh = layout.missing.filter((m) => !told.has(m))
  if (!fresh.length) return
  for (const m of fresh) told.add(m)
  // Said once a font, after the layout settles.
  queueMicrotask(() => notify('warning', `${fresh.length === 1 ? 'A font this document uses isn’t' : 'Fonts this document uses aren’t'} available: ${fresh.join(', ')}. Its text is shown in Inter until ${fresh.length === 1 ? 'it’s' : 'they’re'} added (Type → Add Fonts…, or Load System Fonts). The text keeps asking for ${fresh.length === 1 ? 'it' : 'them'}.`))
  void doc
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
    // A font arriving: text is laid out and sent again, once a frame at most.
    let pending = false
    lib.subscribe(() => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        engine().redecorate()
        bumpEpoch()
      })
    })
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
