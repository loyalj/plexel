/**
 * Fills, from the page's side: Edit → Fill's contents and blending, the
 * Gradient tool and the Paint Bucket laying their paint on pixels, Define
 * Pattern, and fill layers (Layer → New Fill Layer).
 *
 * The pixel work is the engine's (engine/fillHost.ts); this decides what's
 * filled (an alpha or spot channel targeted in the Channels panel, the
 * selected layer's pixels, only the colour channels targeted when only
 * some are, or its mask when that's the target), puts the paint in the
 * target's terms, and commits what comes back as one named step.
 */
import { addPattern, insertNode, removePattern, renamePattern, setChannelTiles, setFillPaint, setTiles } from '../doc/edit'
import { makeNode } from '../doc/nodes'
import { freshName } from '../doc/tree'
import { channelKind, type BlendModeId, type Doc, type DocNode, type NodeId } from '../doc/types'
import { gradientPaint, solid, type Paint } from '../doc/vector'
import { engine } from '../engine/EngineHost'
import type { TileFormat } from '../tiles/format'
import { MAX_PATTERN } from '../vector/paint'
import { colourEngineNow, swatchIn } from './colour'
import { colourSettings } from './colourSettings'
import { documents, newId, type OpenDoc } from './documents'
import { placeForNew } from './effects'
import { notify } from './notices'
import { formatOf, hold } from './pixels'
import { fillTarget, pixelTarget } from './selection'
import { channelTarget, planesTarget } from './channels'
import { isCancelled, runJob } from './jobs'

const store = () => documents()
const active = () => store().active()

/** What Edit → Fill fills with. */
export type FillContents = 'fg' | 'bg' | 'colour' | 'pattern' | 'content-aware' | 'black' | 'gray' | 'white'

export interface Blending {
  blend: BlendModeId
  /** 0..1. */
  opacity: number
  preserve: boolean
}

export interface FillOptions extends Blending {
  contents: FillContents
  /** For 'colour': in the document's own terms. */
  colour?: number[]
  /** For 'pattern': a pattern's id, and its scale (1 is its own size). */
  pattern?: string
  scale?: number
}

const CONTENT_LABEL: Record<FillContents, string> = {
  fg: 'Fill with Foreground',
  bg: 'Fill with Background',
  colour: 'Fill with Colour',
  pattern: 'Fill with Pattern',
  'content-aware': 'Content-Aware Fill',
  black: 'Fill with Black',
  gray: 'Fill with 50% Gray',
  white: 'Fill with White',
}

/** Why the target can't be filled, or null when it can. */
function refusal(node: DocNode): string | null {
  if (node.locked.all || node.locked.pixels) return `“${node.name}” is locked against painting. Unlock it in the Properties panel.`
  return null
}

/** A colour in the document's terms as a mask's gray, 0..1. */
function grayOfColour(doc: Doc, c: number[]): number {
  const cms = colourEngineNow()
  if (doc.mode === 'gray') return c[0]
  if (!cms) return doc.mode === 'cmyk' ? 1 - Math.min(1, c[3] + (c[0] + c[1] + c[2]) / 3) : (c[0] + c[1] + c[2]) / 3
  const { intent, blackPointCompensation } = colourSettings.get()
  return cms.converter.convert({ space: doc.mode, profile: doc.profile, c }, { space: 'gray', profile: { builtin: 'gray-gamma-2.2' } }, intent, blackPointCompensation).c[0]
}

/** A paint in the document's terms made a mask's: its colours as grays. */
function paintForMask(doc: Doc, p: Paint): Paint {
  if (p.kind === 'solid') return { kind: 'solid', colour: [grayOfColour(doc, p.colour)] }
  if (p.kind === 'gradient') return { ...p, stops: p.stops.map((s) => ({ ...s, colour: [grayOfColour(doc, s.colour)] })) }
  return { ...p, colour: [grayOfColour(doc, p.colour)], background: [grayOfColour(doc, p.background)] }
}

/** A gray paint as a spot channel's: black (0) is full ink (1). */
function paintAsInk(p: Paint): Paint {
  const ink = (c: number[]) => c.map((v) => 1 - v)
  if (p.kind === 'solid') return { ...p, colour: ink(p.colour) }
  if (p.kind === 'gradient') return { ...p, stops: p.stops.map((s) => ({ ...s, colour: ink(s.colour) })) }
  return { ...p, colour: ink(p.colour), background: ink(p.background) }
}

/** The target's tiles to fill into: a mask with none yet is its outside value everywhere, so that's made first. */
async function startTiles(doc: Doc, node: DocNode, format: TileFormat): Promise<string | null> {
  if (node.kind === 'mask' && !node.props.tiles && node.props.outside > 0) {
    return engine().call('select.fill', { layer: null, format, transform: node.transform, cover: null, width: doc.width, height: doc.height, value: [Math.round(node.props.outside * 255), 255] })
  }
  return node.kind === 'pixel' || node.kind === 'mask' ? node.props.tiles : null
}

/** Commits a target's new tiles as one step. */
function commitTiles(d: OpenDoc, node: DocNode, set: string | null, label: string) {
  if (node.kind !== 'pixel' && node.kind !== 'mask') return
  if (set === node.props.tiles) return
  const release = set ? hold([set]) : () => {}
  store().commit((x) => setTiles(x, node.id, set), { key: d.key, label })
  release()
}

/**
 * Lays a paint (its colours in the document's terms, laid out in document
 * pixels) on the selected layer's pixels or its mask, through `cover`
 * (the selection, by default), as one step called `label`.
 */
export async function paintTarget(paint: Paint, o: Blending, label: string, cover?: string | null): Promise<boolean> {
  const d = active()
  if (!d) return false
  const ch = channelTarget(d)
  if (ch) {
    const doc = d.history.present
    try {
      const gray = paintForMask(doc, paint)
      const set = await engine().call('fill.paint', {
        key: d.key,
        layer: ch.tiles,
        format: { mode: 'gray', depth: 8 },
        transform: ch.transform,
        cover: cover === undefined ? (doc.selection?.tiles ?? null) : cover,
        width: doc.width,
        height: doc.height,
        blend: o.blend,
        opacity: o.opacity,
        preserve: false,
        paint: channelKind(ch) === 'spot' ? paintAsInk(gray) : gray,
      })
      if (set !== ch.tiles && store().get(d.key)) {
        const release = set ? hold([set]) : () => {}
        store().commit((x) => setChannelTiles(x, ch.id, set, true), { key: d.key, label })
        release()
      }
      return true
    } catch (e) {
      notify('error', `${label} didn’t work.`, [e instanceof Error ? e.message : String(e)])
      return false
    }
  }
  const t = pixelTarget(d)
  if (!t) {
    notify('info', `${label} works on a pixel layer or a layer mask. Select one, or add a layer.`)
    return false
  }
  const target = t.mask ?? t.node
  const why = refusal(t.node)
  if (why) {
    notify('info', why)
    return false
  }
  const doc = d.history.present
  const format: TileFormat = t.mask ? { mode: 'gray', depth: 8 } : formatOf(doc)
  const planes = t.mask ? null : planesTarget(d)
  try {
    const layer = await startTiles(doc, target, format)
    let set = await engine().call('fill.paint', {
      key: d.key,
      layer,
      format,
      transform: target.transform,
      cover: cover === undefined ? (doc.selection?.tiles ?? null) : cover,
      width: doc.width,
      height: doc.height,
      blend: o.blend,
      opacity: o.opacity,
      preserve: o.preserve && !t.mask,
      paint: t.mask ? paintForMask(doc, paint) : paint,
    })
    // Only the colour channels targeted: the rest put back.
    if (planes) set = await engine().call('fill.keepPlanes', { before: layer, after: set, planes })
    if (store().get(d.key)) commitTiles(store().get(d.key)!, target, set, label)
    return true
  } catch (e) {
    notify('error', `${label} didn’t work.`, [e instanceof Error ? e.message : String(e)])
    return false
  }
}

/** Edit → Fill. */
export async function fillWith(o: FillOptions) {
  const d = active()
  if (!d) return
  const doc = d.history.present
  const label = CONTENT_LABEL[o.contents]
  // The quick way for a plain fill with a colour, which keeps working on the largest documents.
  if ((o.contents === 'fg' || o.contents === 'bg') && o.blend === 'normal' && o.opacity >= 1 && !o.preserve) return fillTarget(o.contents)
  if (o.contents === 'content-aware') return contentAware(o)
  const white = doc.mode === 'cmyk' ? [0, 0, 0, 0] : doc.mode === 'gray' ? [1] : [1, 1, 1]
  const black = doc.mode === 'cmyk' ? [0.75, 0.68, 0.67, 0.9] : doc.mode === 'gray' ? [0] : [0, 0, 0]
  const gray = doc.mode === 'cmyk' ? [0.5, 0.4, 0.4, 0.1] : doc.mode === 'gray' ? [0.5] : [0.5, 0.5, 0.5]
  let paint: Paint
  switch (o.contents) {
    case 'fg':
    case 'bg': {
      const c = swatchIn(doc, o.contents)
      if (!c) return notify('info', 'The colour engine is still starting; try again in a moment.')
      paint = solid(c)
      break
    }
    case 'colour':
      paint = solid(o.colour ?? black)
      break
    case 'black':
      paint = solid(black)
      break
    case 'white':
      paint = solid(white)
      break
    case 'gray':
      paint = solid(gray)
      break
    case 'pattern': {
      const p = doc.patterns?.find((x) => x.id === o.pattern)
      if (!p && !o.pattern) return notify('info', 'There’s no pattern to fill with. Define one first (Edit → Define Pattern).')
      paint = { kind: 'pattern', pattern: o.pattern ?? 'checker', colour: black, background: white, backgroundAlpha: 1, size: (p?.width ?? 16) * (o.scale ?? 1), angle: 0 }
      break
    }
  }
  await paintTarget(paint, o, label)
}

/** Content-aware fill: what the selection covers made again from the layer round it. */
async function contentAware(o: Blending) {
  const d = active()
  if (!d) return
  const doc = d.history.present
  if (!doc.selection) return notify('info', 'Content-aware fill fills a selection from what’s round it. Select what to replace first.')
  if (channelTarget(d)) return notify('info', 'Content-aware fill works on a layer’s pixels, not on an alpha or spot channel. Pick a layer in the Layers panel.')
  const t = pixelTarget(d)
  if (!t || t.mask) return notify('info', 'Content-aware fill works on a pixel layer’s own pixels.')
  const why = refusal(t.node)
  if (why) return notify('info', why)
  const cover = doc.selection.tiles
  try {
    const planes = planesTarget(d)
    let set = await runJob('Content-Aware Fill', (job) => engine().call('fill.contentAware', {
      job,
      key: d.key,
      layer: t.node.kind === 'pixel' ? t.node.props.tiles : null,
      format: formatOf(doc),
      transform: t.node.transform,
      cover,
      width: doc.width,
      height: doc.height,
      blend: o.blend,
      opacity: o.opacity,
      preserve: o.preserve,
      seed: (Math.random() * 2 ** 31) | 0,
    }))
    if (planes) set = await engine().call('fill.keepPlanes', { before: t.node.kind === 'pixel' ? t.node.props.tiles : null, after: set, planes })
    if (store().get(d.key)) commitTiles(store().get(d.key)!, t.node, set, 'Content-Aware Fill')
  } catch (e) {
    if (isCancelled(e)) return
    notify('error', 'Content-aware fill didn’t work.', [e instanceof Error ? e.message : String(e)])
  }
}

// --- patterns ---------------------------------------------------------------------------------------

/**
 * Edit → Define Pattern: what's visible under the selection's bounds (or
 * the whole canvas) as a pattern of the document's, one repeat across.
 * With `whole` and no selection, the repeat is the canvas itself, edges
 * and all, transparent or not: one tile of a tiled document, so the
 * pattern repeats as the document does.
 */
export async function definePattern(name: string, whole = false): Promise<string | null> {
  const d = active()
  if (!d) return null
  const doc = d.history.present
  try {
    const px = await engine().call('clip.pixels', { key: d.key, source: { kind: 'merged' }, selection: doc.selection?.tiles ?? null })
    if (!px.set || !px.bounds) {
      notify('info', 'There’s nothing visible there to make a pattern of.')
      return null
    }
    if (whole && !doc.selection) px.bounds = [0, 0, doc.width, doc.height]
    const [x0, y0, x1, y1] = px.bounds
    if (x1 - x0 > MAX_PATTERN || y1 - y0 > MAX_PATTERN) {
      notify('info', `A pattern can be at most ${MAX_PATTERN.toLocaleString()} pixels a side; this would be ${x1 - x0} × ${y1 - y0}. ${whole && !doc.selection ? 'Make the canvas smaller, or select part of it.' : 'Select a smaller area.'}`)
      return null
    }
    const tiles = await engine().call('fill.crop', { set: px.set, rect: px.bounds })
    if (!tiles) return null
    const id = newId('pat')
    const release = hold([tiles])
    store().commit((x) => addPattern(x, { id, name: name.trim() || freshPatternName(x), tiles, width: x1 - x0, height: y1 - y0 }), { key: d.key, label: 'Define Pattern' })
    release()
    return id
  } catch (e) {
    notify('error', 'Define Pattern didn’t work.', [e instanceof Error ? e.message : String(e)])
    return null
  }
}

/** "Pattern 1", "Pattern 2"... */
export function freshPatternName(doc: Doc): string {
  const used = new Set((doc.patterns ?? []).map((p) => p.name))
  for (let i = 1; ; i++) if (!used.has(`Pattern ${i}`)) return `Pattern ${i}`
}

export function deletePattern(id: string) {
  const d = active()
  if (d) store().commit((x) => removePattern(x, id), { key: d.key, label: 'Delete Pattern' })
}

export function renameDocPattern(id: string, name: string) {
  const d = active()
  if (d) store().commit((x) => renamePattern(x, id, name), { key: d.key, label: 'Rename Pattern' })
}

// --- fill layers ------------------------------------------------------------------------------------

/**
 * Layer → New Fill Layer: a colour (the foreground), a gradient (foreground
 * to background across the canvas) or a pattern, above the selected layer;
 * with a selection, masked by it, as Photoshop does. Its paint is then set
 * in Properties.
 */
export async function newFillLayer(kind: 'solid' | 'gradient' | 'pattern', paint?: Paint): Promise<NodeId | null> {
  const d = active()
  if (!d) return null
  const doc = d.history.present
  const fg = swatchIn(doc, 'fg') ?? (doc.mode === 'cmyk' ? [0, 0, 0, 1] : doc.mode === 'gray' ? [0] : [0, 0, 0])
  const bg = swatchIn(doc, 'bg') ?? (doc.mode === 'cmyk' ? [0, 0, 0, 0] : doc.mode === 'gray' ? [1] : [1, 1, 1])
  const p = doc.patterns?.[0]
  const made: Paint =
    paint ??
    (kind === 'solid'
      ? solid(fg)
      : kind === 'gradient'
        ? ({ ...(gradientPaint(fg, bg) as Paint & { kind: 'gradient' }), angle: 0 } as Paint)
        : { kind: 'pattern', pattern: p?.id ?? 'checker', colour: fg, background: bg, backgroundAlpha: 1, size: p?.width ?? 16, angle: 0 })
  const label = kind === 'solid' ? 'Colour Fill' : kind === 'gradient' ? 'Gradient Fill' : 'Pattern Fill'
  const id = newId('n')
  const { parent, index } = placeForNew(d)
  const sel = doc.selection?.tiles ?? null
  const release = sel ? hold([sel]) : () => {}
  store().commit(
    (x) => {
      const node = makeNode('fill', id, freshName(x, label), { paint: made })
      let out = insertNode(x, node, parent, index)
      if (sel) {
        // Masked by the selection, as Photoshop's new fill layers are.
        const m = makeNode('mask', newId('m'), 'Mask', { source: 'pixel', tiles: sel, outside: 0 })
        out = { ...out, nodes: { ...out.nodes, [m.id]: m, [id]: { ...out.nodes[id], masks: [m.id] } as DocNode } }
      }
      return out
    },
    { key: d.key, label: `New ${label} Layer` },
  )
  release()
  store().select(id, d.key)
  return id
}

/** A fill layer's paint, from Properties; a drag of one control is one step. */
export function setFillLayerPaint(id: NodeId, paint: Paint, coalesce?: string) {
  const d = active()
  if (d) store().commit((x) => setFillPaint(x, id, paint), { key: d.key, label: 'Fill Layer', coalesce })
}
