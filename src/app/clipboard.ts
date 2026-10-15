/**
 * The clipboard: Cut, Copy, Copy Merged, Paste and its kinds, Layer via
 * Copy and Cut, Duplicate Layer, the layer style clipboard, and New from
 * Clipboard.
 *
 * What's copied is kept here as a fragment (doc/fragment.ts): a small
 * document holding the copied layers, or one pixel layer of copied pixels,
 * in the colours they came from. Pasting converts it into the document
 * being pasted into and puts its layers in with new ids, as one step.
 *
 * The system clipboard gets a picture of it (an sRGB PNG) for other apps,
 * the words of a copied text layer, and in its HTML a marker naming this
 * copy. A paste that finds the marker pastes the fragment, live; one that
 * doesn't takes what another app put there: an image, SVG markup or text.
 * The keys paste through the browser's paste event, which needs no
 * permission; the Edit menu reads the clipboard, which asks for it once.
 */
import { convertDoc, pixelSets } from '../doc/convert'
import { addMask, createDoc, insertNode, removeNode, setSelection, setTiles, tileSetsOf } from '../doc/edit'
import { fragmentOf, pasteFragment, pixelFragment } from '../doc/fragment'
import { makeNode } from '../doc/nodes'
import { recolourLinked } from '../doc/swatches'
import { contentFrom, plainText } from '../doc/text'
import { freshName, placeOf } from '../doc/tree'
import type { Doc, DocNode, LayerFx, NodeId } from '../doc/types'
import { fillItem, solid } from '../doc/vector'
import type { ClipSource } from '../engine/clipHost'
import { engine } from '../engine/EngineHost'
import { assets } from '../io/assets'
import { pathD } from '../io/svg/pathData'
import { pathBounds, type PathData } from '../geom/path'
import { viewQuad } from '../render/view'
import { colourEngine, swatchIn } from './colour'
import { colourSettings } from './colourSettings'
import { swatchColourIn } from './docSwatches'
import { documents, newId, type OpenDoc } from './documents'
import { notify } from './notices'
import { openImage } from './files'
// SVG is read by a module loaded when something is first pasted as SVG (app/files.ts says why).
const readSvg = async (text: string, name: string) => (await import('./svg')).readSvg(text, name)
import { formatOf, hold, keepAlive } from './pixels'
import { pixelMaskOf } from './selection'
import { typeSettings } from './typeSettings'
import { views } from './views'
import { Listeners } from '../lib/listeners'

/** This page's own name for its copies: another tab's marker is someone else's. */
const SESSION = newId('s')

export interface ClipData {
  /** The copied layers under a root, in their source's mode, depth and profile. */
  frag: Doc
  /** Pixels (one pixel layer, pasted as a new "Layer n") or layers copied live. */
  kind: 'pixels' | 'layers'
  /** What it covers in the source document, [x0, y0, x1, y1); null when that isn't known. */
  bounds: [number, number, number, number] | null
  /** The document it was copied from. */
  source: string
}

interface Clip {
  id: string
  /** The copy in the making: the engine reads pixels and draws its picture. Null when there was nothing to copy. */
  ready: Promise<ClipData | null>
  /** Done, once it's done. */
  data: ClipData | null
  /** What's on the system clipboard with it couldn't be written there: a paste without the marker means this one. */
  localOnly: boolean
}

/** A path copied with the Pen or Direct Selection: in document pixels. */
interface PathClip {
  id: string
  path: PathData
}

let current: Clip | null = null
let pathClip: PathClip | null = null
/** The layer style clipboard, kept apart, as Photoshop keeps it. */
let styleClip: { fx: LayerFx[]; doc: Doc } | null = null

const changes = new Listeners()
let version = 0
const changed = () => {
  version++
  changes.emit()
}
/** Changes whenever something is copied, for React to notice. */
export const clipVersion = () => version
/** For the menus: whether there's anything to paste changes as copies are made. */
export const subscribeClipboard = (fn: () => void) => {
  return changes.subscribe(fn)
}

keepAlive(() => (current?.data ? tileSetsOf(current.data.frag) : []))

/** Whether Plexel holds a copy of its own (the system clipboard may hold more: Paste reads it). */
export const hasClip = () => !!(current?.data || pathClip)
export const hasStyleClip = () => !!styleClip

// --- the system clipboard -----------------------------------------------------------------

/** A transparent pixel, for when there's nothing to show: the clipboard still needs the marker. */
const EMPTY_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
/** Bigger pictures than this go on the clipboard as PNG only, not in its HTML too. */
const HTML_IMAGE_BYTES = 8 * 1024 * 1024
const MARKER = /<meta[^>]*name="plexel-clip"[^>]*content="([^"]+)"/i

function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Puts a copy on the system clipboard: its picture as PNG, the same in
 * HTML (with the marker, so a paste here knows it), and `text` as plain
 * text when there is some. Called while the key press or click that
 * copied still counts, so the browser allows it; the picture can follow.
 */
function writeSystem(clip: { id: string; localOnly: boolean }, png: Promise<Uint8Array | null>, text: string | null) {
  const cb = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  if (!cb?.write || typeof ClipboardItem === 'undefined') {
    clip.localOnly = true
    return
  }
  const marker = `${SESSION}:${clip.id}`
  const bytes = png.catch(() => null)
  const items: Record<string, Promise<Blob> | Blob> = {
    'image/png': bytes.then((b) => new Blob([(b ?? EMPTY_PNG) as BlobPart], { type: 'image/png' })),
    'text/html': bytes.then((b) => {
      const img = b && b.length <= HTML_IMAGE_BYTES ? `<img src="data:image/png;base64,${base64(b)}">` : text ? `<p>${escapeHtml(text)}</p>` : ''
      return new Blob([`<meta name="plexel-clip" content="${marker}">${img}`], { type: 'text/html' })
    }),
  }
  if (text !== null) items['text/plain'] = new Blob([text], { type: 'text/plain' })
  try {
    cb.write([new ClipboardItem(items)]).catch(() => {
      clip.localOnly = true
    })
  } catch {
    clip.localOnly = true
  }
}

/** What a paste found on the system clipboard. */
interface Incoming {
  marker: string | null
  image: Blob | null
  text: string | null
}

function fromTransfer(data: DataTransfer): Incoming {
  const html = data.getData('text/html')
  const file = [...data.files].find((f) => f.type.startsWith('image/')) ?? null
  const text = data.getData('text/plain')
  return { marker: MARKER.exec(html)?.[1] ?? null, image: file, text: text || null }
}

/** Reads the clipboard for a paste from the menu, which the browser asks permission for. Null when it says no. */
async function readSystem(): Promise<Incoming | null> {
  const cb = navigator.clipboard
  if (!cb?.read) return null
  try {
    const items = await cb.read()
    const out: Incoming = { marker: null, image: null, text: null }
    for (const it of items) {
      if (it.types.includes('text/html') && !out.marker) out.marker = MARKER.exec(await (await it.getType('text/html')).text())?.[1] ?? null
      const img = it.types.find((t) => t.startsWith('image/') && t !== 'image/svg+xml')
      if (img && !out.image) out.image = await it.getType(img)
      if (it.types.includes('text/plain') && out.text === null) out.text = (await (await it.getType('text/plain')).text()) || null
    }
    return out
  } catch {
    return null
  }
}

// --- copying --------------------------------------------------------------------------------

const active = () => documents().active()

/** Why a layer can't have its pixels taken, or null when it can. */
function lockedAgainst(node: DocNode): string | null {
  return node.locked.all || node.locked.pixels ? `“${node.name}” is locked against painting, so it was copied, not cut. Unlock it in the Properties panel.` : null
}

/** What Copy takes in a document as it stands: a path, pixels from a source, a layer, or nothing. */
type CopyPlan =
  | { kind: 'path'; path: PathData; text: string; cut: (() => void) | null }
  | { kind: 'pixels'; source: ClipSource; node: DocNode | null }
  | { kind: 'layer'; node: DocNode }

/** Vector tools register what they have selected, so Copy can take it. */
let pathSource: (() => { path: PathData; cut: () => void } | null) | null = null
export const setPathSource = (fn: typeof pathSource) => (pathSource = fn)

function planCopy(d: OpenDoc, merged: boolean): CopyPlan | null {
  const doc = d.history.present
  if (merged) return { kind: 'pixels', source: { kind: 'merged' }, node: null }
  const p = pathSource?.()
  if (p) return { kind: 'path', path: p.path, text: svgOfPath(p.path), cut: p.cut }
  const node = d.selected ? (doc.nodes[d.selected] ?? null) : null
  if (doc.selection) {
    if (!node) return null
    const mask = d.maskTarget === 'pixel' ? pixelMaskOf(doc, node) : null
    if (mask) return { kind: 'pixels', source: { kind: 'mask', node: mask.id }, node: mask }
    return { kind: 'pixels', source: { kind: 'node', node: node.id }, node }
  }
  return node && node.kind !== 'mask' ? { kind: 'layer', node } : null
}

/** A path as a small SVG document, for other apps to paste. */
function svgOfPath(path: PathData): string {
  const b = pathBounds(path) ?? [0, 0, 0, 0]
  const w = Math.max(1, Math.ceil(b[2]))
  const h = Math.max(1, Math.ceil(b[3]))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${pathD(path)}" fill="none" stroke="black"${path.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''}/></svg>`
}

/** Whether Copy (or with `merged`, Copy Merged) has something to take in the front document. */
export function canCopy(merged = false): boolean {
  const d = active()
  return !!d && !!planCopy(d, merged)
}

/**
 * Copy, Cut or Copy Merged. Decides at once what's being copied and puts
 * it on the system clipboard while the key press still allows it; the
 * engine's part follows. Returns false when there was nothing to copy, so
 * the browser can copy what it would have (text selected on the page).
 */
export function copy(o: { cut?: boolean; merged?: boolean } = {}): boolean {
  const d = active()
  if (!d) return false
  const plan = planCopy(d, !!o.merged)
  if (!plan) return false
  const key = d.key
  const doc = d.history.present
  const label = o.cut ? 'Cut' : o.merged ? 'Copy Merged' : 'Copy'

  if (plan.kind === 'path') {
    pathClip = { id: newId('c'), path: plan.path }
    current = null
    const clip = { id: pathClip.id, localOnly: false }
    writeSystem(clip, Promise.resolve(null), plan.text)
    if (o.cut) plan.cut?.()
    changed()
    return true
  }

  const clip: Clip = { id: newId('c'), ready: Promise.resolve(null), data: null, localOnly: false }
  let png: Promise<Uint8Array | null>
  if (plan.kind === 'layer') {
    const node = plan.node
    const frag = fragmentOf(doc, [node.id], newId('r'))
    const shot = engine()
      .call('clip.nodePng', { key, node: node.id })
      .catch(() => null)
    png = shot.then((s) => s?.png ?? null)
    clip.ready = (async () => {
      const bounds = await engine()
        .call('clip.bounds', { key, node: node.id })
        .catch(() => null)
      await shot
      return { frag, kind: 'layers' as const, bounds, source: key }
    })()
    writeSystem(clip, png, node.kind === 'text' ? plainText(node.props.content) : null)
  } else {
    const selection = doc.selection?.tiles ?? null
    const pixels = engine().call('clip.pixels', { key, source: plan.source, selection })
    const release = pixels.then((p) => hold(p.set ? [p.set] : []))
    clip.ready = pixels.then((p) => {
      if (!p.set || !p.bounds) return null
      const space = p.format.mode === doc.mode ? doc : { ...doc, mode: p.format.mode, depth: p.format.depth, profile: { builtin: 'gray-gamma-2.2' } }
      const frag = pixelFragment(space, newId('r'), newId('n'), 'Layer', p.set, p.transform)
      return { frag, kind: 'pixels' as const, bounds: p.bounds, source: key }
    })
    png = pixels.then((p) =>
      p.set && p.bounds
        ? engine().call('clip.png', { space: p.format.mode === doc.mode ? { mode: doc.mode, depth: doc.depth, profile: doc.profile } : { mode: 'gray', depth: 8, profile: { builtin: 'gray-gamma-2.2' } }, set: p.set, transform: p.transform, bounds: p.bounds })
        : null,
    )
    void Promise.allSettled([clip.ready, png]).then(() => release.then((r) => r()))
    writeSystem(clip, png, null)
  }
  current = clip
  pathClip = null
  void clip.ready
    .then(async (data) => {
      clip.data = data
      if (current === clip) changed()
      if (!data) {
        notify('info', `${label} found nothing: the selected area is empty.`)
        return
      }
      if (o.cut) await cutAway(key, doc, plan)
    })
    .catch((e) => notify('error', `${label} didn’t work.`, [e instanceof Error ? e.message : String(e)]))
  changed()
  return true
}

/** Cut's second half: what was copied taken out of the document, if it hasn't moved on meanwhile. */
async function cutAway(key: string, before: Doc, plan: CopyPlan) {
  const d = documents().get(key)
  if (!d) return
  const doc = d.history.present
  if (plan.kind === 'layer') {
    if (doc !== before) return notify('info', 'The document changed while it was being copied, so the layer was copied, not cut.')
    documents().commit((x) => removeNode(x, plan.node.id), { key, label: 'Cut' })
    return
  }
  if (plan.kind !== 'pixels' || !plan.node) return
  const node = plan.node
  if (node.kind !== 'pixel' && node.kind !== 'mask') return notify('info', `“${node.name}” isn’t made of pixels, so it was copied, not cut. Rasterize it to cut from it.`)
  const why = lockedAgainst(doc.nodes[node.id] ?? node)
  if (why) return notify('info', why)
  const sel = before.selection?.tiles ?? null
  if (doc.selection?.tiles !== sel || doc.nodes[node.id] !== before.nodes[node.id]) return notify('info', 'The document changed while it was being copied, so the pixels were copied, not cut.')
  const set = await clearedThrough(doc, node, sel)
  if (set === undefined) return
  const release = set ? hold([set]) : () => {}
  documents().commit((x) => setTiles(x, node.id, set), { key, label: 'Cut' })
  release()
}

/** A pixel layer's or a mask's tiles with what `cover` covers cleared (a mask is hidden there); undefined when it can't be. */
async function clearedThrough(doc: Doc, node: DocNode, cover: string | null): Promise<string | null | undefined> {
  if (node.kind !== 'pixel' && node.kind !== 'mask') return undefined
  const format = node.kind === 'mask' ? { mode: 'gray' as const, depth: 8 as const } : formatOf(doc)
  let layer = node.props.tiles
  if (node.kind === 'mask' && !layer && node.props.outside > 0)
    layer = await engine().call('select.fill', { layer: null, format, transform: node.transform, cover: null, width: doc.width, height: doc.height, value: [Math.round(node.props.outside * 255), 255] })
  return engine().call('select.fill', { layer, format, transform: node.transform, cover, width: doc.width, height: doc.height, value: node.kind === 'mask' ? [0, 255] : null })
}

// --- pasting ----------------------------------------------------------------------------------

export type PasteHow = 'paste' | 'in-place' | 'into' | 'outside'

const PASTE_LABELS: Record<PasteHow, string> = { paste: 'Paste', 'in-place': 'Paste in Place', into: 'Paste Into', outside: 'Paste Outside' }

/**
 * Paste. With `data` (the browser's paste event), from what that carries;
 * without (the menu), from reading the clipboard. Plexel's own copy comes
 * back live; anything else as a layer of its kind.
 */
export async function paste(how: PasteHow, data?: DataTransfer | null): Promise<unknown> {
  const incoming = data ? fromTransfer(data) : await readSystem()
  const label = PASTE_LABELS[how]
  const ours = incoming?.marker === `${SESSION}:${current?.id}` || incoming?.marker === `${SESSION}:${pathClip?.id}`
  // Ours, or nothing readable and a copy of ours that never reached the system clipboard.
  const useOwn = ours || ((!incoming || (!incoming.image && !incoming.text)) && (!!pathClip || !!current))
  try {
    if (useOwn && pathClip && (!current || incoming?.marker === `${SESSION}:${pathClip.id}`)) return pastePath(pathClip.path)
    if (useOwn && current) {
      const c = await current.ready
      if (!c) return notify('info', 'The last copy found nothing to paste.')
      return await pasteClip(c, how, label)
    }
    if (!incoming) return notify('info', 'The browser didn’t let Plexel read the clipboard. Paste with Ctrl+V instead, or allow clipboard access for this site.')
    if (incoming.image) return await pasteImage(incoming.image, how, label)
    const text = incoming.text?.trim()
    if (text && /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text)) return await pasteSvg(text, how, label)
    if (text) return pasteText(incoming.text!, label)
    notify('info', 'There’s nothing on the clipboard Plexel can paste.')
  } catch (e) {
    notify('error', `${label} didn’t work.`, [e instanceof Error ? e.message : String(e)])
  }
}

/** A fragment converted into a document's mode, depth and profile, with Colour Settings' intent; the warnings say what couldn't come over. */
async function intoSpace(frag: Doc, target: Pick<Doc, 'mode' | 'depth' | 'profile'>): Promise<{ frag: Doc; release: () => void; warnings: string[] }> {
  const sameSpace = frag.mode === target.mode && JSON.stringify(frag.profile) === JSON.stringify(target.profile)
  if (sameSpace && frag.depth === target.depth) return { frag, release: () => {}, warnings: [] }
  const { cms, registry } = await colourEngine()
  const { intent, blackPointCompensation: bpc } = colourSettings.get()
  const profiles = [frag.profile, target.profile].flatMap((p) => ('asset' in p && assets().get(p.asset) ? [{ hash: p.asset, bytes: assets().get(p.asset)! }] : []))
  const sets = pixelSets(frag)
  const to = { mode: target.mode, profile: target.profile, depth: target.depth }
  const map = sets.length ? await engine().call('tiles.convert', { sets, from: { mode: frag.mode, profile: frag.profile, depth: frag.depth }, to, intent, bpc, profiles }) : {}
  const release = hold(Object.values(map))
  const t = sameSpace ? null : cms.transform(registry.resolve(frag.profile, frag.mode).profile, registry.resolve(target.profile, target.mode).profile, intent, bpc ? 0x2000 : 0)
  try {
    const r = convertDoc(frag, to, (c) => (t ? t.one(c).map((v) => Math.min(1, Math.max(0, v))) : [...c]), new Map(Object.entries(map)))
    const colourOf = swatchColourIn(r.doc)
    return { frag: colourOf ? recolourLinked(r.doc, colourOf) : r.doc, release, warnings: r.warnings }
  } finally {
    t?.close()
  }
}

/** Where pasted layers go: above the selected layer, in its group; otherwise at the top. */
function abovePlace(d: OpenDoc): { parent: NodeId; index: number } {
  const doc = d.history.present
  const place = d.selected ? placeOf(doc, d.selected) : null
  if (place?.slot === 'children' && doc.nodes[place.parent].kind !== 'boolean') return { parent: place.parent, index: place.index + 1 }
  return { parent: doc.root, index: doc.nodes[doc.root].children?.length ?? 0 }
}

/** Whether a document rectangle is wholly in the document's view. */
function inView(key: string, b: [number, number, number, number]): boolean {
  const v = views().get(key)
  const c = engine().canvasSize()
  if (!v || !c.width) return true
  const q = viewQuad(v, c)
  const inside = (x: number, y: number) => {
    let sign = 0
    for (let i = 0; i < q.length; i++) {
      const [ax, ay] = q[i]
      const [bx, by] = q[(i + 1) % q.length]
      const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
      if (Math.abs(cross) < 1e-9) continue
      if (sign && Math.sign(cross) !== sign) return false
      sign = Math.sign(cross)
    }
    return true
  }
  return inside(b[0], b[1]) && inside(b[2], b[1]) && inside(b[0], b[3]) && inside(b[2], b[3])
}

/** The middle of the document's view, in document pixels. */
function viewCentre(d: OpenDoc): [number, number] {
  const v = views().get(d.key)
  const doc = d.history.present
  return v ? [v.cx, v.cy] : [doc.width / 2, doc.height / 2]
}

/**
 * How far pasted content moves: not at all in place; onto the selection's
 * middle (pixels, and Paste Into and Outside); left where it was when
 * that's in view; otherwise to the middle of the view.
 */
async function offsetFor(d: OpenDoc, b: [number, number, number, number] | null, how: PasteHow, pixels: boolean): Promise<[number, number]> {
  if (!b || how === 'in-place') return [0, 0]
  const doc = d.history.present
  const cx = (b[0] + b[2]) / 2
  const cy = (b[1] + b[3]) / 2
  const sel = doc.selection?.tiles
  if (sel && (pixels || how === 'into' || how === 'outside')) {
    const s = await engine().call('select.bounds', { set: sel })
    if (s) return [Math.round((s[0] + s[2]) / 2 - cx), Math.round((s[1] + s[3]) / 2 - cy)]
  }
  if (inView(d.key, b)) return [0, 0]
  const [vx, vy] = viewCentre(d)
  return [Math.round(vx - cx), Math.round(vy - cy)]
}

async function pasteClip(c: ClipData, how: PasteHow, label: string) {
  const d = active()
  if (!d) return newDocFrom(c)
  const target = d.history.present
  const conv = await intoSpace(c.frag, target)
  try {
    const now = documents().get(d.key)
    if (!now) return
    const offset = await offsetFor(now, c.bounds, how, c.kind === 'pixels')
    await commitFragment(d.key, conv.frag, { how, offset, label, pixels: c.kind === 'pixels' })
  } finally {
    conv.release()
  }
  for (const w of new Set(conv.warnings)) notify('warning', w)
}

/** A converted fragment's layers into a document as one step: masked by the selection for Paste Into and Outside, the selection dropped after pixels. */
async function commitFragment(key: string, frag: Doc, o: { how: PasteHow; offset: [number, number]; label: string; pixels: boolean }) {
  const d = documents().get(key)
  if (!d) return
  const doc = d.history.present
  const sel = doc.selection?.tiles ?? null
  const masked = (o.how === 'into' || o.how === 'outside') && !!sel
  if ((o.how === 'into' || o.how === 'outside') && !sel) notify('info', `${o.label} needs a selection to paste into, so it pasted as it would have.`)
  let maskTiles: string | null = null
  if (masked) maskTiles = o.how === 'into' ? sel : await engine().call('select.invert', { width: doc.width, height: doc.height, current: sel })
  const release = maskTiles ? hold([maskTiles]) : () => {}
  try {
    const now = documents().get(key)
    if (!now) return
    const { parent, index } = abovePlace(now)
    let names = now.history.present
    const rename = o.pixels ? () => freshName(names, 'Layer') : undefined
    let ids: NodeId[] = []
    documents().commit(
      (x) => {
        names = x
        const r = pasteFragment(x, frag, { parent, index, offset: o.offset, newId, rename })
        ids = r.ids
        let out = r.doc
        if (masked) for (const id of ids) out = addMask(out, id, newId('m'), maskTiles, o.how === 'into' ? 0 : 1)
        if ((o.pixels || masked) && out.selection) out = setSelection(out, null)
        return out
      },
      { key, label: o.label },
    )
    if (sel && (o.pixels || masked) && !documents().get(key)?.history.present.selection) documents().setEditState({ lastSelection: sel }, key)
    if (ids.length) documents().select(ids[ids.length - 1], key)
  } finally {
    release()
  }
}

/** An image from another app, as a new layer: converted from its own profile (sRGB without one). */
async function pasteImage(blob: Blob, how: PasteHow, label: string) {
  const d = active()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (!d) {
    await openImage(new File([bytes as BlobPart], 'Pasted Image.png', { type: blob.type }))
    return
  }
  const doc = d.history.present
  const { intent, blackPointCompensation } = colourSettings.get()
  const r = await engine().call('image.import', { bytes, name: 'Pasted Image.png', into: { mode: doc.mode, depth: doc.depth, profile: doc.profile, intent, blackPointCompensation } })
  const release = hold([r.set])
  try {
    const frag = pixelFragment(doc, newId('r'), newId('n'), 'Layer', r.set, [1, 0, 0, 1, 0, 0])
    const bounds: [number, number, number, number] = [0, 0, r.width, r.height]
    const now = documents().get(d.key)
    if (!now) return
    // From another app there's no place it came from: the selection's middle, or the view's.
    let offset = await offsetFor(now, bounds, how === 'in-place' ? 'paste' : how, true)
    if (offset[0] === 0 && offset[1] === 0 && !now.history.present.selection) {
      const [vx, vy] = viewCentre(now)
      offset = [Math.round(vx - r.width / 2), Math.round(vy - r.height / 2)]
    }
    await commitFragment(d.key, frag, { how, offset, label, pixels: true })
  } finally {
    release()
  }
  if (r.warnings.length) notify('warning', 'The pasted image came in, with a few things to know.', r.warnings)
}

/** SVG markup from another app, as shapes, text and images: converted from sRGB. */
async function pasteSvg(text: string, how: PasteHow, label: string) {
  const r = await readSvg(text, 'Pasted SVG')
  const d = active()
  if (!d) {
    documents().add({ doc: r.doc, file: null, saved: false, label: 'New from Clipboard' })
    return
  }
  const frag = { ...r.doc }
  const conv = await intoSpace(frag, d.history.present)
  try {
    const now = documents().get(d.key)
    if (!now) return
    const b: [number, number, number, number] = [0, 0, r.doc.width, r.doc.height]
    let offset = await offsetFor(now, b, how === 'in-place' ? 'paste' : how, false)
    if (offset[0] === 0 && offset[1] === 0) {
      const [vx, vy] = viewCentre(now)
      offset = [Math.round(vx - r.doc.width / 2), Math.round(vy - r.doc.height / 2)]
    }
    await commitFragment(d.key, conv.frag, { how, offset, label, pixels: false })
  } finally {
    conv.release()
  }
  for (const w of new Set([...r.warnings, ...conv.warnings])) notify('warning', w)
}

/** Plain text from another app, as a point text layer in the middle of the view, in the Character panel's settings and the foreground colour. */
function pasteText(text: string, label: string) {
  const d = active()
  if (!d) return notify('info', 'Open or make a document to paste text into.')
  const doc = d.history.present
  const settings = typeSettings().get()
  const fg = swatchIn(doc, 'fg') ?? (doc.mode === 'cmyk' ? [0, 0, 0, 1] : doc.mode === 'gray' ? [0] : [0, 0, 0])
  const content = contentFrom(text, settings.char)
  content.paragraphs = content.paragraphs.map((p) => ({ ...p, props: { ...settings.para } }))
  const id = newId('n')
  const name = text.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Text'
  const node = makeNode('text', id, name, { mode: 'point', content, frame: null, pathOffset: 0, appearance: [fillItem(solid(fg))] })
  const [vx, vy] = viewCentre(d)
  node.transform = [1, 0, 0, 1, Math.round(vx), Math.round(vy)]
  const { parent, index } = abovePlace(d)
  documents().commit((x) => insertNode(x, node, parent, index), { key: d.key, label })
  documents().select(id, d.key)
}

/** Vector tools register how a copied path goes back in: into the shape being edited, or as a new one. */
let pathSink: ((path: PathData) => void) | null = null
export const setPathSink = (fn: typeof pathSink) => (pathSink = fn)

function pastePath(path: PathData) {
  if (!active()) return notify('info', 'Open or make a document to paste a path into.')
  pathSink?.(path)
}

// --- Layer via Copy and Cut, Duplicate Layer --------------------------------------------------

/**
 * Layer via Copy (or Cut): the selected pixels into a new layer in place,
 * above; with nothing selected, Duplicate Layer.
 */
export async function layerVia(cut: boolean) {
  const d = active()
  if (!d) return
  const doc = d.history.present
  if (!doc.selection) {
    if (!cut) duplicateLayer()
    else notify('info', 'Layer via Cut needs a selection to cut from.')
    return
  }
  const plan = planCopy(d, false)
  if (!plan || plan.kind !== 'pixels' || !plan.node) return
  const label = cut ? 'Layer via Cut' : 'Layer via Copy'
  const node = plan.node
  if (cut) {
    if (node.kind !== 'pixel' && node.kind !== 'mask') return notify('info', `“${node.name}” isn’t made of pixels, so there’s nothing to cut. Rasterize it first, or use Layer via Copy.`)
    const why = lockedAgainst(node)
    if (why) return notify('info', `“${node.name}” is locked against painting. Unlock it in the Properties panel.`)
  }
  try {
    const sel = doc.selection.tiles
    const p = await engine().call('clip.pixels', { key: d.key, source: plan.source, selection: sel })
    if (!p.set || !p.bounds) return notify('info', `${label} found nothing: the selected area is empty.`)
    const releaseCopy = hold([p.set])
    try {
      const cleared = cut ? await clearedThrough(doc, node, sel) : undefined
      const releaseCut = cleared ? hold([cleared]) : () => {}
      try {
        const now = documents().get(d.key)
        if (!now || now.history.present !== doc) return notify('info', `The document changed while ${label} worked, so it was left out. Try again.`)
        const space = p.format.mode === doc.mode ? doc : { ...doc, mode: p.format.mode, depth: p.format.depth, profile: { builtin: 'gray-gamma-2.2' } }
        const conv = await intoSpace(pixelFragment(space, newId('r'), newId('n'), 'Layer', p.set, p.transform), doc)
        try {
          // Above the layer the pixels came from: a mask's layer, or the layer itself.
          const owner = node.kind === 'mask' ? d.selected! : node.id
          const place = placeOf(doc, owner)
          const parent = place?.slot === 'children' && doc.nodes[place.parent].kind !== 'boolean' ? place.parent : doc.root
          const index = place?.slot === 'children' && parent === place.parent ? place.index + 1 : (doc.nodes[doc.root].children?.length ?? 0)
          let ids: NodeId[] = []
          documents().commit(
            (x) => {
              let out = cut && cleared !== undefined ? setTiles(x, node.id, cleared) : x
              const r = pasteFragment(out, conv.frag, { parent, index, newId, rename: () => freshName(x, 'Layer') })
              ids = r.ids
              out = setSelection(r.doc, null)
              return out
            },
            { key: d.key, label },
          )
          documents().setEditState({ lastSelection: sel }, d.key)
          if (ids.length) documents().select(ids[ids.length - 1], d.key)
        } finally {
          conv.release()
        }
      } finally {
        releaseCut()
      }
    } finally {
      releaseCopy()
    }
  } catch (e) {
    notify('error', `${label} didn’t work.`, [e instanceof Error ? e.message : String(e)])
  }
}

/** Duplicate Layer: the selected layer and all it holds, in place, above it, named "… copy". */
export function duplicateLayer() {
  const d = active()
  if (!d?.selected) return
  const doc = d.history.present
  const node = doc.nodes[d.selected]
  if (!node || node.kind === 'mask' || placeOf(doc, node.id)?.slot !== 'children') return
  const frag = fragmentOf(doc, [node.id], newId('r'))
  const place = placeOf(doc, node.id)!
  let ids: NodeId[] = []
  documents().commit(
    (x) => {
      const r = pasteFragment(x, frag, { parent: place.parent, index: place.index + 1, newId, rename: (n) => copyName(x, n) })
      ids = r.ids
      return r.doc
    },
    { key: d.key, label: 'Duplicate Layer' },
  )
  if (ids.length) documents().select(ids[0], d.key)
}

/** "Name copy", then "Name copy 2" and on, as Photoshop names duplicates. */
function copyName(doc: Doc, name: string): string {
  const base = `${name.replace(/ copy( \d+)?$/, '')} copy`
  const used = new Set(Object.values(doc.nodes).map((n) => n.name))
  if (!used.has(base)) return base
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`
}

// --- layer styles -------------------------------------------------------------------------------

/** Copy Layer Style: the selected layer's effects, kept apart from the main clipboard. */
export function copyStyle() {
  const d = active()
  const node = d?.selected ? d.history.present.nodes[d.selected] : null
  if (!d || !node) return
  styleClip = { fx: node.fx.map((f) => ({ ...f, params: { ...f.params } })), doc: d.history.present }
  changed()
}

/** Paste Layer Style: the copied effects replace the selected layer's, converted into the document's colours. */
export async function pasteStyle() {
  const d = active()
  const node = d?.selected ? d.history.present.nodes[d.selected] : null
  if (!d || !node || !styleClip) return
  const src = styleClip.doc
  // Through a fragment of one empty layer carrying the effects, so they convert as a layer's do.
  const frag = pixelFragment(src, 'r', 'n', 'Style', null, [1, 0, 0, 1, 0, 0])
  frag.nodes.n = { ...frag.nodes.n, fx: styleClip.fx } as DocNode
  const conv = await intoSpace(frag, d.history.present)
  conv.release()
  const fx = conv.frag.nodes.n.fx
  documents().commit((x) => (x.nodes[node.id] ? { ...x, nodes: { ...x.nodes, [node.id]: { ...x.nodes[node.id], fx } as DocNode } } : x), { key: d.key, label: 'Paste Layer Style' })
  for (const w of new Set(conv.warnings)) notify('warning', w)
}

// --- New from Clipboard -----------------------------------------------------------------------

/** A new document the size of what's on the clipboard, with it pasted in. */
export async function newFromClipboard() {
  const incoming = await readSystem()
  const ours = !incoming || incoming.marker === `${SESSION}:${current?.id}` || (!incoming.image && !incoming.text)
  try {
    if (ours && current) {
      const c = await current.ready
      if (c) return newDocFrom(c)
    }
    if (incoming?.image) {
        await openImage(new File([incoming.image], 'Pasted Image.png', { type: incoming.image.type }))
      return
    }
    const text = incoming?.text?.trim()
    if (text && /<svg[\s>]/i.test(text)) {
          const r = await readSvg(text, 'Untitled')
      documents().add({ doc: r.doc, file: null, saved: false, label: 'New from Clipboard' })
      return
    }
    notify('info', incoming ? 'There’s no image or copy on the clipboard to make a document from.' : 'The browser didn’t let Plexel read the clipboard. Allow clipboard access for this site, or paste into a new document with Ctrl+V.')
  } catch (e) {
    notify('error', 'New from Clipboard didn’t work.', [e instanceof Error ? e.message : String(e)])
  }
}

/** A document just big enough for a copy, in its mode, depth and profile, with it pasted in place. */
function newDocFrom(c: ClipData) {
  const b = c.bounds ?? [0, 0, c.frag.width, c.frag.height]
  const width = Math.max(1, b[2] - b[0])
  const height = Math.max(1, b[3] - b[1])
  const f = c.frag
  const doc = createDoc({ name: 'Untitled', width, height, resolution: f.resolution, mode: f.mode, depth: f.depth, profile: f.profile }, newId('n'))
  const r = pasteFragment(doc, f, { parent: doc.root, index: 0, offset: [-b[0], -b[1]] as [number, number], newId, rename: c.kind === 'pixels' ? () => 'Layer 1' : undefined })
  const key = documents().add({ doc: r.doc, file: null, saved: false, label: 'New from Clipboard' })
  if (r.ids.length) documents().select(r.ids[r.ids.length - 1], key)
}

