/**
 * The document as JSON, and back.
 *
 * Writing is plain: the document is already plain data. Reading is where
 * the care goes, because what comes in may be from an older build, a newer
 * one, a crash halfway through a write, or a hand edit. The loader:
 *
 * - refuses a file newer than this build, saying which, instead of
 *   half-reading it;
 * - upgrades older formats step by step through MIGRATIONS, and renamed node
 *   kinds through KIND_RENAMES, so a rename never needs a format bump;
 * - reads every field with a default, clamping what's out of range;
 * - repairs the tree: nodes in a list they can't be in, nodes listed twice,
 *   cycles, references to nodes that aren't there, a missing root;
 * - and says what it repaired in `warnings`, rather than throwing.
 *
 * A layer that belongs nowhere is put back at the top of the document
 * rather than dropped: the user can delete it, but can't get back what a
 * loader threw away.
 */
import { readTextStyles } from './text'
import { readSwatches } from './swatches'
import { readColourValue } from '../color/value'
import { readGraphicStyles } from './graphicStyles'
import { readBrush, type VectorBrush } from './vectorBrush'
import { brushReaders } from './vector'
import { MAX_PATTERN } from '../vector/paint'
import { DOC_FORMAT, DEFAULT_PROFILES } from './edit'
import { NODE_DEFS, isBlendMode, isEffectKind, isLayerKind, makeNode, nodeDef } from './nodes'
import { isObject, readBool, readInt, readNumber, readOneOf, readString, type Warn } from './read'
import {
  IDENTITY,
  MAX_RESOLUTION,
  MAX_SIDE,
  MIN_RESOLUTION,
  type Affine,
  type ColourMode,
  type ColourTag,
  type Doc,
  type DocChannel,
  type DocNode,
  type DocPattern,
  type DocSymbol,
  type LayerFx,
  type Guide,
  type NodeId,
  type NodeKind,
  type ProfileRef,
  TILINGS,
} from './types'

/** What a document file says it is, so a stray JSON file is told apart from a document. */
export const DOC_APP = 'plexel'
/** What documents said before the app was renamed; still read. */
const OLD_APPS = new Set(['pixlayer'])

/**
 * Upgrades, by the format they upgrade from: MIGRATIONS[1] turns a format-1
 * document into format 2. Each works on the raw JSON, before anything is
 * read, and only has to know about its own step.
 */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {}

/** Node kinds that have been renamed: old name to new. Read before the kind is looked up. */
const KIND_RENAMES: Record<string, NodeKind> = {}

export function docToJson(doc: Doc): string {
  return JSON.stringify({ format: DOC_FORMAT, app: DOC_APP, doc })
}

export type ReadResult = { ok: true; doc: Doc; warnings: string[] } | { ok: false; error: string }

export function readDocJson(input: string | unknown): ReadResult {
  let raw: unknown = input
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input)
    } catch {
      return { ok: false, error: 'The document is not valid JSON. The file may be damaged or incomplete.' }
    }
  }
  if (!isObject(raw) || (raw.app !== DOC_APP && !OLD_APPS.has(raw.app as string)) || !isObject(raw.doc)) {
    return { ok: false, error: 'This is not a Plexel document.' }
  }
  const format = raw.format
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) {
    return { ok: false, error: 'The document has no format number, so it can’t be read safely.' }
  }
  if (format > DOC_FORMAT) {
    return {
      ok: false,
      error: `This document was saved by a newer version of Plexel (format ${format}). This version reads up to format ${DOC_FORMAT}. Reload the page to get the newest version.`,
    }
  }
  let body = raw.doc as Record<string, unknown>
  for (let f = format; f < DOC_FORMAT; f++) body = MIGRATIONS[f]?.(body) ?? body

  const warnings = new Map<string, number>()
  const warn: Warn = (m) => warnings.set(m, (warnings.get(m) ?? 0) + 1)
  const doc = readBody(body, warn)
  return {
    ok: true,
    doc,
    warnings: [...warnings].map(([m, n]) => (n > 1 ? `${m} (${n} times)` : m)),
  }
}

// --- the body ----------------------------------------------------------------

const MODES: readonly ColourMode[] = ['rgb', 'gray', 'cmyk']
const DEPTHS = [8, 16] as const
const TAGS: readonly ColourTag[] = ['red', 'orange', 'yellow', 'green', 'blue', 'violet', 'gray']
const validId = (v: unknown): v is NodeId => typeof v === 'string' && v.length > 0 && v.length <= 64

function readProfile(v: unknown, mode: ColourMode, warn: Warn): ProfileRef {
  if (isObject(v)) {
    if (typeof v.builtin === 'string' && v.builtin) return { builtin: v.builtin }
    if (typeof v.asset === 'string' && v.asset) return { asset: v.asset }
  }
  warn('The document’s colour profile could not be read; used the default for its mode')
  return DEFAULT_PROFILES[mode]
}

function readGuides(v: unknown, warn: Warn): Guide[] {
  if (!Array.isArray(v)) return []
  const out: Guide[] = []
  for (const g of v) {
    if (isObject(g) && (g.axis === 'x' || g.axis === 'y') && typeof g.at === 'number' && Number.isFinite(g.at)) {
      out.push({ axis: g.axis, at: g.at })
    } else warn('A guide could not be read; dropped it')
  }
  return out
}

function readSelection(v: unknown, warn: Warn): Doc['selection'] {
  if (v === null || v === undefined) return null
  if (isObject(v) && typeof v.tiles === 'string' && v.tiles) return { tiles: v.tiles, path: v.path ?? null }
  warn('The selection could not be read; deselected')
  return null
}

function readTransform(v: unknown, warn: Warn): Affine {
  if (Array.isArray(v) && v.length === 6 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) return v as Affine
  if (v !== undefined) warn('A layer’s transform could not be read; reset it')
  return [...IDENTITY]
}

/** Layer effects: kind, on or off, settings. Kinds this build doesn't know are kept, and not drawn. */
function readFx(v: unknown, warn: Warn): LayerFx[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) {
    warn('A layer’s effects could not be read; dropped them')
    return []
  }
  const out: LayerFx[] = []
  for (const f of v) {
    if (!isObject(f) || typeof f.kind !== 'string' || !f.kind) {
      warn('A layer effect could not be read; dropped it')
      continue
    }
    out.push({ kind: f.kind, enabled: readBool(f.enabled, true, 'A layer effect’s switch', warn), params: isObject(f.params) ? f.params : {} })
  }
  return out
}

/** How deep smart objects inside smart objects may go before the loader stops reading them. */
const MAX_NESTING = 16
let nesting = 0

function readIdList(v: unknown): NodeId[] {
  return Array.isArray(v) ? v.filter(validId) : []
}

/** One node from its raw JSON, or null if it can't be a node at all. */
function readNode(key: string, r: unknown, warn: Warn): DocNode | null {
  if (!isObject(r)) {
    warn('A layer could not be read; dropped it')
    return null
  }
  const rawKind = typeof r.kind === 'string' ? (KIND_RENAMES[r.kind] ?? r.kind) : ''
  if (!(rawKind in NODE_DEFS)) {
    warn(`A layer of a kind this version doesn’t know (“${String(r.kind)}”) was dropped`)
    return null
  }
  const kind = rawKind as NodeKind
  const def = nodeDef(kind)
  const base = makeNode(kind, key)
  const locked = isObject(r.locked) ? r.locked : {}
  const blend = isBlendMode(r.blend) && (r.blend !== 'pass-through' || kind === 'group') ? r.blend : base.blend
  if (r.blend !== undefined && r.blend !== blend) warn(`A blend mode “${String(r.blend)}” can’t be used there; used ${blend}`)
  const node = {
    ...base,
    name: readString(r.name, def.defaultName, 'A layer’s name', warn),
    visible: readBool(r.visible, true, 'A layer’s visibility', warn),
    locked: {
      pixels: readBool(locked.pixels, false, 'A layer’s lock', warn),
      position: readBool(locked.position, false, 'A layer’s lock', warn),
      all: readBool(locked.all, false, 'A layer’s lock', warn),
    },
    opacity: readNumber(r.opacity, 1, 0, 1, 'A layer’s opacity', warn),
    fillOpacity: readNumber(r.fillOpacity, 1, 0, 1, 'A layer’s fill opacity', warn),
    blend,
    transform: readTransform(r.transform, warn),
    masks: readIdList(r.masks),
    effects: readIdList(r.effects),
    fx: readFx(r.fx, warn),
    tag: r.tag === null || r.tag === undefined ? null : readOneOf(r.tag, TAGS, 'gray', 'A layer’s colour tag', warn),
    props: def.readProps(r.props, warn),
  } as DocNode
  if (def.container) node.children = readIdList(r.children)
  if (node.kind === 'embedded') {
    const raw = isObject(r.props) ? r.props.content : undefined
    if (isObject(raw)) {
      if (nesting >= MAX_NESTING) warn('Smart objects were nested too deep to read; the innermost were emptied')
      else {
        nesting++
        try {
          node.props = { ...node.props, content: readBody(raw, (m) => warn(`In smart object “${node.name}”: ${m}`)) }
        } finally {
          nesting--
        }
      }
    }
  }
  return node
}

function readBody(b: Record<string, unknown>, warn: Warn): Doc {
  const mode = readOneOf(b.mode, MODES, 'rgb', 'The document’s colour mode', warn)
  const nodes: Record<NodeId, DocNode> = {}
  if (isObject(b.nodes)) {
    for (const [key, r] of Object.entries(b.nodes)) {
      if (!validId(key)) {
        warn('A layer with an unusable id was dropped')
        continue
      }
      const n = readNode(key, r, warn)
      if (n) nodes[key] = n
    }
  }

  let root = validId(b.root) ? b.root : ''
  if (!nodes[root] || nodes[root].kind !== 'group') {
    warn('The document’s top-level group was missing; made a new one')
    let id = 'root'
    while (nodes[id]) id += '_'
    nodes[id] = makeNode('group', id, 'Root')
    root = id
  }

  const doc: Doc = {
    name: readString(b.name, 'Untitled', 'The document’s name', warn).trim() || 'Untitled',
    width: readInt(b.width, 1920, 1, MAX_SIDE, 'The document’s width', warn),
    height: readInt(b.height, 1080, 1, MAX_SIDE, 'The document’s height', warn),
    resolution: readNumber(b.resolution, 72, MIN_RESOLUTION, MAX_RESOLUTION, 'The document’s resolution', warn),
    mode,
    depth: readOneOf(b.depth, DEPTHS, 8, 'The document’s bit depth', warn),
    profile: readProfile(b.profile, mode, warn),
    root,
    nodes,
    guides: readGuides(b.guides, warn),
    selection: readSelection(b.selection, warn),
  }
  if (b.textStyles !== undefined) doc.textStyles = readTextStyles(b.textStyles, warn)
  if (b.swatches !== undefined) doc.swatches = readSwatches(b.swatches, warn)
  if (b.graphicStyles !== undefined) doc.graphicStyles = readGraphicStyles(b.graphicStyles, warn)
  if (Array.isArray(b.vectorBrushes)) {
    const brushes = b.vectorBrushes.slice(0, 500).map((x) => readBrush(x, brushReaders(warn))).filter((x): x is VectorBrush => !!x)
    if (brushes.length < b.vectorBrushes.length) warn('some vector brushes were not readable; left them out')
    // One of each id.
    const seen = new Set<string>()
    const list = brushes.filter((x) => !seen.has(x.id) && !!seen.add(x.id))
    if (list.length) doc.vectorBrushes = list
  }
  const patterns = readPatterns(b.patterns, warn)
  if (patterns.length) doc.patterns = patterns
  const channels = readChannels(b.channels, warn)
  if (channels.length) doc.channels = channels
  const tiled = readOneOf(b.tiled, TILINGS, 'off', 'Whether the document is tiled', warn)
  if (tiled !== 'off') doc.tiled = tiled
  const symbols = readSymbols(b.symbols, warn)
  if (symbols.length) doc.symbols = symbols
  return repairTree(doc, warn)
}

/** Symbols: each an id, a name and its contents, a document of their own. */
function readSymbols(v: unknown, warn: Warn): DocSymbol[] {
  if (v === undefined || v === null) return []
  const out: DocSymbol[] = []
  const ids = new Set<string>()
  for (const s of Array.isArray(v) ? v : []) {
    if (!isObject(s) || !validId(s.id) || ids.has(s.id) || !isObject(s.content)) {
      warn('A symbol could not be read; left it out')
      continue
    }
    if (nesting >= MAX_NESTING) {
      warn('Symbols were nested too deep to read; the innermost were left out')
      continue
    }
    ids.add(s.id)
    const name = readString(s.name, 'Symbol', 'A symbol’s name', warn).trim() || 'Symbol'
    nesting++
    try {
      out.push({ id: s.id, name, content: readBody(s.content, (m) => warn(`In symbol “${name}”: ${m}`)) })
    } finally {
      nesting--
    }
  }
  return out
}

/** Patterns made from pixels: each an id, a name, a tile set and its size. */
function readPatterns(v: unknown, warn: Warn): DocPattern[] {
  if (v === undefined || v === null) return []
  const out: DocPattern[] = []
  const ids = new Set<string>()
  for (const p of Array.isArray(v) ? v : []) {
    if (!isObject(p) || !validId(p.id) || ids.has(p.id) || typeof p.tiles !== 'string' || !p.tiles) {
      warn('A pattern could not be read; left it out')
      continue
    }
    ids.add(p.id)
    out.push({
      id: p.id,
      name: readString(p.name, 'Pattern', 'A pattern’s name', warn).trim() || 'Pattern',
      tiles: p.tiles,
      width: readInt(p.width, 1, 1, MAX_PATTERN, 'A pattern’s width', warn),
      height: readInt(p.height, 1, 1, MAX_PATTERN, 'A pattern’s height', warn),
    })
  }
  return out
}

/** Alpha and spot channels: each an id, a name, its coverage and where that lies, and how it shows. */
function readChannels(v: unknown, warn: Warn): DocChannel[] {
  if (v === undefined || v === null) return []
  const out: DocChannel[] = []
  const ids = new Set<string>()
  for (const c of Array.isArray(v) ? v : []) {
    if (!isObject(c) || !validId(c.id) || ids.has(c.id)) {
      warn('An alpha channel could not be read; left it out')
      continue
    }
    ids.add(c.id)
    const ch: DocChannel = {
      id: c.id,
      name: readString(c.name, 'Alpha', 'An alpha channel’s name', warn).trim() || 'Alpha',
      tiles: typeof c.tiles === 'string' && c.tiles ? c.tiles : null,
      transform: readTransform(c.transform, warn),
    }
    if (c.kind === 'spot') {
      const ink = readColourValue(c.ink)
      if (!ink) warn(`The spot channel “${ch.name}” had no readable ink; it came in as an alpha channel`)
      else {
        ch.kind = 'spot'
        ch.ink = ink
      }
    }
    if (c.opacity !== undefined) ch.opacity = readNumber(c.opacity, 0.5, 0, 1, 'A channel’s opacity', warn)
    if (ch.kind !== 'spot') {
      if (Array.isArray(c.tint) && c.tint.length === 3 && c.tint.every((x) => typeof x === 'number' && x >= 0 && x <= 1)) ch.tint = c.tint as [number, number, number]
      if (c.marks === 'selected') ch.marks = 'selected'
    }
    out.push(ch)
  }
  return out
}

/**
 * Makes the tree a tree. Walking from the root, each node keeps only the
 * references it may hold: children it accepts, mask nodes in `masks`, effect
 * nodes in `effects`, each node once. Whatever the walk didn't reach is an
 * orphan: a layer goes back at the top of the document, anything else is
 * dropped.
 */
function repairTree(doc: Doc, warn: Warn): Doc {
  const nodes = { ...doc.nodes }
  const seen = new Set<NodeId>()

  const visit = (id: NodeId) => {
    seen.add(id)
    const n = nodes[id]
    const def = nodeDef(n.kind)
    const keep = (list: NodeId[], fits: (k: DocNode) => boolean, what: string) =>
      list.filter((c) => {
        const child = nodes[c]
        if (!child) {
          warn(`A reference to a missing ${what} was removed`)
          return false
        }
        if (seen.has(c)) {
          warn(`A ${what} listed in two places was kept in the first`)
          return false
        }
        if (!fits(child)) {
          warn(`A ${nodeDef(child.kind).label.toLowerCase()} can’t be a ${what} there; moved it`)
          return false
        }
        seen.add(c)
        return true
      })
    const masks = keep(n.masks, (c) => nodeDef(c.kind).role === 'mask', 'mask')
    const effects = keep(n.effects, (c) => isEffectKind(c.kind), 'effect')
    const children = n.children ? keep(n.children, (c) => !!def.accepts?.(c.kind) && isLayerKind(c.kind), 'layer') : undefined
    let next = n
    if (masks.length !== n.masks.length || effects.length !== n.effects.length || children?.length !== n.children?.length) {
      next = { ...n, masks, effects, ...(children ? { children } : {}) } as DocNode
    }
    if (next.kind === 'boolean') {
      const kids = new Set(next.children)
      const ops = Object.fromEntries(Object.entries(next.props.ops).filter(([k]) => kids.has(k)))
      if (Object.keys(ops).length !== Object.keys(next.props.ops).length) next = { ...next, props: { ...next.props, ops } }
    }
    nodes[id] = next
    for (const c of [...masks, ...effects, ...(children ?? [])]) visit(c)
  }
  visit(doc.root)

  const orphans = Object.keys(nodes).filter((id) => !seen.has(id))
  if (orphans.length) {
    const rootNode = nodes[doc.root]
    const rescued: NodeId[] = []
    for (const id of orphans) {
      // Only the top of an orphaned branch goes to the root; its own
      // children come with it.
      const heldByOrphan = orphans.some((o) => o !== id && nodes[o].children?.includes(id))
      if (heldByOrphan) continue
      if (isLayerKind(nodes[id].kind)) rescued.push(id)
    }
    if (rescued.length) {
      nodes[doc.root] = { ...rootNode, children: [...rootNode.children!, ...rescued] } as DocNode
      warn(`${rescued.length === 1 ? 'A layer' : `${rescued.length} layers`} that belonged nowhere ${rescued.length === 1 ? 'was' : 'were'} put back at the top`)
    }
    // Walk the rescued branches so their own lists are repaired too.
    for (const id of rescued) if (!seen.has(id)) visit(id)
    const dropped = Object.keys(nodes).filter((id) => !seen.has(id))
    for (const id of dropped) delete nodes[id]
    if (dropped.length) warn(`${dropped.length} mask${dropped.length === 1 ? '' : 's'} or effect${dropped.length === 1 ? '' : 's'} that belonged nowhere ${dropped.length === 1 ? 'was' : 'were'} dropped`)
  }
  return { ...doc, nodes }
}
