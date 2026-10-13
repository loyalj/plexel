/**
 * Every change to a document, as a pure function: a document in, a
 * document out, nothing else touched.
 *
 * An edit that changes nothing returns the document it was given, the same
 * object, and the app relies on that: history doesn't record a step,
 * autosave doesn't write, and the canvas doesn't redraw. An edit that can't
 * be done (moving a group into itself, a name that's empty) also returns
 * the document unchanged rather than throwing, because a refused drag is
 * not an error.
 *
 * Ids are the caller's to make, so edits stay repeatable in the checks.
 */
import { blendAllowed, isEffectKind, isLayerKind, makeNode, nodeDef } from './nodes'
import { freshName, isWithin, placeOf, subtree } from './tree'
import { mapGuides } from './guides'
import type { AppearanceItem, Geometry, Paint } from './vector'
import type { TextContent, TextStyles } from './text'
import type { PathData } from '../geom/path'
import { FILTER_BY_ID, moveWarpParams } from '../filters/defs'
import {
  IDENTITY,
  MAX_RESOLUTION,
  MAX_SIDE,
  MIN_RESOLUTION,
  type Affine,
  type BlendModeId,
  type BoolOp,
  type ColourMode,
  type Depth,
  type Doc,
  type DocChannel,
  type DocNode,
  type DocPattern,
  type KindProps,
  type LayerFx,
  type LockFlags,
  type NodeId,
  type ProfileRef,
  type Tiling,
  tilingOf,
} from './types'

/** The document's current format; serialize.ts writes it and migrates older ones up to it. */
export const DOC_FORMAT = 1

export interface NewDocOptions {
  name: string
  width: number
  height: number
  resolution: number
  mode: ColourMode
  depth: Depth
  profile: ProfileRef
}

/** The profile a new document gets in each mode, until the user picks another. */
export const DEFAULT_PROFILES: Record<ColourMode, ProfileRef> = {
  rgb: { builtin: 'srgb' },
  gray: { builtin: 'gray-gamma-2.2' },
  cmyk: { builtin: 'generic-cmyk' },
}

const clampSide = (n: number) => Math.min(MAX_SIDE, Math.max(1, Math.round(n)))
const clampPpi = (n: number) => Math.min(MAX_RESOLUTION, Math.max(MIN_RESOLUTION, n))

export function createDoc(o: NewDocOptions, rootId: NodeId): Doc {
  const root = makeNode('group', rootId, 'Root')
  return {
    name: o.name.trim() || 'Untitled',
    width: clampSide(o.width),
    height: clampSide(o.height),
    resolution: clampPpi(o.resolution),
    mode: o.mode,
    depth: o.depth,
    profile: o.profile,
    root: rootId,
    nodes: { [rootId]: root },
    guides: [],
    selection: null,
  }
}

// --- the document --------------------------------------------------------

export function renameDoc(doc: Doc, name: string): Doc {
  const n = name.trim()
  return !n || n === doc.name ? doc : { ...doc, name: n }
}

/** Where the old canvas sits in the new one: 0 is the left (or top) edge, 0.5 the middle, 1 the right (or bottom). */
export interface Anchor {
  x: 0 | 0.5 | 1
  y: 0 | 0.5 | 1
}

/**
 * Canvas Size: the canvas grows or shrinks around the anchor. Content keeps
 * its place relative to the anchor, which, with live transforms, means
 * moving the top-level layers by the change in offset. Nothing is cropped:
 * what falls outside the canvas is still there, as in Photoshop when "Delete
 * cropped pixels" is off, and comes back if the canvas grows again.
 */
export function resizeCanvas(doc: Doc, width: number, height: number, anchor: Anchor): Doc {
  const w = clampSide(width)
  const h = clampSide(height)
  if (w === doc.width && h === doc.height) return doc
  const dx = (w - doc.width) * anchor.x
  const dy = (h - doc.height) * anchor.y
  // Every node's transform is in document pixels, nested ones too, so all
  // of them move; and so does the selection, by being cleared.
  const shift = (t: Affine): Affine => [t[0], t[1], t[2], t[3], t[4] + dx, t[5] + dy]
  const moved = dx || dy ? mapGuides(mapChannels(mapTransforms(doc, shift), shift), (g) => ({ axis: g.axis, at: g.at + (g.axis === 'x' ? dx : dy) })) : doc
  return { ...moved, width: w, height: h, selection: dx || dy ? null : doc.selection }
}

/** Every alpha channel's transform through `fn`: they move with the canvas, as layers do. */
function mapChannels(doc: Doc, fn: (t: Affine) => Affine): Doc {
  return doc.channels?.length ? { ...doc, channels: doc.channels.map((c) => ({ ...c, transform: fn(c.transform) })) } : doc
}

/** Every node but the root through `fn`, transform by transform. */
function mapTransforms(doc: Doc, fn: (t: Affine) => Affine, only?: ReadonlySet<NodeId>): Doc {
  const nodes = { ...doc.nodes }
  for (const [id, n] of Object.entries(doc.nodes)) {
    if (id === doc.root || (only && !only.has(id))) continue
    nodes[id] = { ...n, transform: fn(n.transform) } as DocNode
  }
  return { ...doc, nodes }
}

/** a after b, as affines. */
export function compose(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

export function invertAffine(t: Affine): Affine {
  const det = t[0] * t[3] - t[1] * t[2] || 1e-12
  return [t[3] / det, -t[1] / det, -t[2] / det, t[0] / det, (t[2] * t[5] - t[3] * t[4]) / det, (t[1] * t[4] - t[0] * t[5]) / det]
}

/**
 * The nodes a move or transform of `id` carries with it: the node, its
 * masks, and for a group (or a compound shape) everything inside it with
 * their masks. Layers clipped to a non-group stay put, as Photoshop's
 * clipped layers do.
 */
export function carried(doc: Doc, id: NodeId): Set<NodeId> {
  const out = new Set<NodeId>()
  const visit = (n: NodeId, deep: boolean) => {
    const node = doc.nodes[n]
    if (!node) return
    out.add(n)
    for (const m of node.masks) out.add(m)
    if (deep && node.children) for (const c of node.children) visit(c, doc.nodes[c]?.kind === 'group' || doc.nodes[c]?.kind === 'boolean')
  }
  const node = doc.nodes[id]
  // A group carries what's in it; a compound shape, what it's made of.
  const deep = node?.kind === 'group' || node?.kind === 'boolean'
  visit(id, deep)
  if (deep) for (const c of node!.children ?? []) visit(c, true)
  return out
}

/**
 * Transforms a node (with its masks, and a group's whole contents) by `m`,
 * in document pixels: each transform becomes m · transform. Live: the
 * pixels stay as they are until Rasterize.
 */
export function transformNode(doc: Doc, id: NodeId, m: Affine): Doc {
  if (!doc.nodes[id] || id === doc.root) return doc
  if (m.every((v, i) => v === IDENTITY[i])) return doc
  return mapTransforms(doc, (t) => compose(m, t), carried(doc, id))
}

/**
 * A node's geometric effects (Warp, Liquify) carried by `m` of its own
 * coordinates, so they stay where they were when its coordinates change
 * under them: Rasterize, which makes its transform the identity.
 */
export function rebaseWarps(doc: Doc, id: NodeId, m: Affine): Doc {
  const n = doc.nodes[id]
  if (!n) return doc
  let nodes: Record<NodeId, DocNode> | null = null
  for (const e of n.effects) {
    const x = doc.nodes[e]
    if (x?.kind !== 'filter' || !FILTER_BY_ID.get(x.props.filter)?.warp) continue
    nodes ??= { ...doc.nodes }
    nodes[e] = { ...x, props: { ...x.props, params: moveWarpParams(x.props.filter, (x.props.params ?? {}) as Record<string, unknown>, m) } } as DocNode
  }
  return nodes ? { ...doc, nodes } : doc
}

/** Moves a node, with what it carries, by (dx, dy) document pixels. */
export const moveBy = (doc: Doc, id: NodeId, dx: number, dy: number) => transformNode(doc, id, [1, 0, 0, 1, dx, dy])

/**
 * Crop: the canvas becomes the rectangle (x, y, width, height), turned by
 * `angle` degrees about its corner (Straighten). Nothing is cut away: every
 * node keeps its pixels and is moved into the new canvas's coordinates, as
 * Canvas Size does, so cropping again wider brings them back.
 */
export function crop(doc: Doc, r: { x: number; y: number; width: number; height: number; angle: number }): Doc {
  const w = clampSide(r.width)
  const h = clampSide(r.height)
  const a = (r.angle * Math.PI) / 180
  // New canvas → old document: turn, then move to the crop's corner.
  const toOld: Affine = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), r.x, r.y]
  const toNew = invertAffine(toOld)
  const moved = mapChannels(
    mapTransforms(doc, (t) => compose(toNew, t)),
    (t) => compose(toNew, t),
  )
  // Guides go with the canvas; straightened, one no longer straight across or down goes.
  const at = (x: number, y: number) => [toNew[0] * x + toNew[2] * y + toNew[4], toNew[1] * x + toNew[3] * y + toNew[5]]
  const guided = mapGuides(moved, (g) => {
    const [ax, ay] = at(g.axis === 'x' ? g.at : 0, g.axis === 'y' ? g.at : 0)
    const [bx, by] = at(g.axis === 'x' ? g.at : 1, g.axis === 'y' ? g.at : 1)
    if (Math.abs(bx - ax) < 1e-9) return { axis: 'x', at: ax }
    if (Math.abs(by - ay) < 1e-9) return { axis: 'y', at: ay }
    return null
  })
  return { ...guided, width: w, height: h, selection: null }
}

/** The selection, as a coverage tile set, or none. */
export function setSelection(doc: Doc, tiles: string | null): Doc {
  if ((doc.selection?.tiles ?? null) === tiles) return doc
  return { ...doc, selection: tiles ? { tiles, path: null } : null }
}

/**
 * A pixel mask on a node: `maskId` is the new mask node's id. `tiles` is its
 * coverage (null for none yet) and `outside` how much shows where it has no
 * tiles (1 reveals, 0 hides).
 */
export function addMask(doc: Doc, id: NodeId, maskId: NodeId, tiles: string | null, outside: number, invert = false): Doc {
  const n = doc.nodes[id]
  if (!n || id === doc.root || doc.nodes[maskId] || !isLayerKind(n.kind)) return doc
  const mask = makeNode('mask', maskId, 'Mask', { tiles, outside, invert })
  return { ...doc, nodes: { ...doc.nodes, [maskId]: mask, [id]: { ...n, masks: [...n.masks, maskId] } as DocNode } }
}

/** Changes a mask's density, feather, invert or outside value. */
export function setMaskProps(doc: Doc, id: NodeId, patch: Partial<Pick<KindProps['mask'], 'density' | 'feather' | 'invert' | 'outside'>>) {
  return updateNode(doc, id, (n) => {
    if (n.kind !== 'mask') return n
    const next = { ...n.props, ...patch }
    const same = (Object.keys(patch) as (keyof typeof patch)[]).every((k) => next[k] === n.props[k])
    return same ? n : ({ ...n, props: next } as DocNode)
  })
}

/**
 * Create Clipping Mask: the layer goes inside the layer below it, as its
 * top child, and so is clipped to it. Refused where there's no layer below
 * that can hold it.
 */
export function clipToBelow(doc: Doc, id: NodeId): Doc {
  const place = placeOf(doc, id)
  if (!place || place.slot !== 'children' || place.index === 0) return doc
  const below = doc.nodes[place.parent].children![place.index - 1]
  const target = doc.nodes[below]
  if (!target.children || target.kind === 'group') return doc
  return moveNode(doc, id, below, target.children.length)
}

/** Release Clipping Mask: a clipped layer comes out, just above the layer it was clipped to. */
export function releaseClip(doc: Doc, id: NodeId): Doc {
  const place = placeOf(doc, id)
  if (!place || place.slot !== 'children') return doc
  const parent = doc.nodes[place.parent]
  if (parent.kind === 'group') return doc
  const outer = placeOf(doc, parent.id)
  if (!outer || outer.slot !== 'children') return doc
  return moveNode(doc, id, outer.parent, outer.index + 1)
}

/**
 * The resolution, as metadata only: the pixels stay as they are, and what
 * changes is how many inches or millimetres they come to. Resampling to a
 * new pixel size is Image Size, which needs pixels (phase 4).
 */
export function setResolution(doc: Doc, ppi: number): Doc {
  const r = clampPpi(ppi)
  return r === doc.resolution ? doc : { ...doc, resolution: r }
}

/** Makes the document a tile, in some directions, or not one; off is kept as no field. */
export function setTiling(doc: Doc, t: Tiling): Doc {
  if (tilingOf(doc) === t) return doc
  const out: Doc = { ...doc, tiled: t }
  if (t === 'off') delete out.tiled
  return out
}

// --- nodes -----------------------------------------------------------------

/**
 * Puts a new node into `parent`'s children at `index` (painting order: 0 is
 * the bottom). Refused if the id is taken, the parent can't hold this kind,
 * or the node isn't a layer.
 */
export function insertNode(doc: Doc, node: DocNode, parent: NodeId, index: number): Doc {
  const p = doc.nodes[parent]
  if (!p || doc.nodes[node.id] || !p.children) return doc
  const def = nodeDef(p.kind)
  if (!def.accepts?.(node.kind) || !isLayerKind(node.kind)) return doc
  const children = [...p.children]
  children.splice(Math.max(0, Math.min(index, children.length)), 0, node.id)
  return { ...doc, nodes: { ...doc.nodes, [node.id]: node, [parent]: { ...p, children } as DocNode } }
}

/** A new empty group, given its id and name, at `index` in `parent`. */
export const addGroup = (doc: Doc, id: NodeId, name: string, parent: NodeId, index: number) =>
  insertNode(doc, makeNode('group', id, name), parent, index)

/** Removes a node and everything under it. The root can't be removed. */
export function removeNode(doc: Doc, id: NodeId): Doc {
  if (id === doc.root || !doc.nodes[id]) return doc
  const place = placeOf(doc, id)
  if (!place) return doc
  const nodes = { ...doc.nodes }
  for (const n of subtree(doc, id)) delete nodes[n]
  const parent = nodes[place.parent]
  const list = place.slot === 'children' ? parent.children! : parent[place.slot]
  nodes[place.parent] = { ...parent, [place.slot]: list.filter((x) => x !== id) } as DocNode
  return { ...doc, nodes }
}

/**
 * Moves a layer to `index` among `parent`'s children, where the index is
 * counted after the node has left its old place. Refused if it would put a
 * node inside itself, or somewhere that can't hold it.
 */
export function moveNode(doc: Doc, id: NodeId, parent: NodeId, index: number): Doc {
  const node = doc.nodes[id]
  const target = doc.nodes[parent]
  const place = placeOf(doc, id)
  if (!node || !target?.children || !place || place.slot !== 'children' || id === doc.root) return doc
  if (isWithin(doc, parent, id)) return doc
  if (!nodeDef(target.kind).accepts?.(node.kind)) return doc

  const nodes = { ...doc.nodes }
  const from = nodes[place.parent]
  nodes[place.parent] = { ...from, children: from.children!.filter((x) => x !== id) } as DocNode
  const into = nodes[parent]
  const children = [...into.children!]
  const at = Math.max(0, Math.min(index, children.length))
  children.splice(at, 0, id)
  if (place.parent === parent && place.index === at) return doc
  nodes[parent] = { ...into, children } as DocNode
  return { ...doc, nodes }
}

/**
 * One step up or down in painting order (+1 is towards the top), within
 * the node's own parent. At either end it stays where it is.
 */
export function shiftNode(doc: Doc, id: NodeId, step: 1 | -1): Doc {
  const place = placeOf(doc, id)
  if (!place || place.slot !== 'children') return doc
  const count = doc.nodes[place.parent].children!.length
  const to = place.index + step
  if (to < 0 || to >= count) return doc
  return moveNode(doc, id, place.parent, to)
}

/**
 * Changes one node through `fn`. If `fn` returns the node it was given the
 * document comes back unchanged, so a no-op stays a no-op all the way up.
 */
export function updateNode(doc: Doc, id: NodeId, fn: (n: DocNode) => DocNode): Doc {
  const node = doc.nodes[id]
  if (!node) return doc
  const next = fn(node)
  return next === node ? doc : { ...doc, nodes: { ...doc.nodes, [id]: next } }
}

export const renameNode = (doc: Doc, id: NodeId, name: string) =>
  updateNode(doc, id, (n) => {
    const t = name.trim()
    return !t || t === n.name ? n : ({ ...n, name: t } as DocNode)
  })

export const setVisible = (doc: Doc, id: NodeId, visible: boolean) =>
  updateNode(doc, id, (n) => (n.visible === visible ? n : ({ ...n, visible } as DocNode)))

/** Several layers shown and hidden at once, as one edit (the Layers panel's Alt-click on an eye). Ids no longer there are skipped. */
export function setVisibleMany(doc: Doc, visible: ReadonlyMap<NodeId, boolean>): Doc {
  let out = doc
  for (const [id, v] of visible) if (out.nodes[id]) out = setVisible(out, id, v)
  return out
}

const unit = (v: number) => Math.min(1, Math.max(0, v))

export const setOpacity = (doc: Doc, id: NodeId, opacity: number) =>
  updateNode(doc, id, (n) => (n.opacity === unit(opacity) ? n : ({ ...n, opacity: unit(opacity) } as DocNode)))

export const setFillOpacity = (doc: Doc, id: NodeId, fillOpacity: number) =>
  updateNode(doc, id, (n) => (n.fillOpacity === unit(fillOpacity) ? n : ({ ...n, fillOpacity: unit(fillOpacity) } as DocNode)))

export const setBlend = (doc: Doc, id: NodeId, blend: BlendModeId) =>
  updateNode(doc, id, (n) => (n.blend === blend || !blendAllowed(n.kind, blend) ? n : ({ ...n, blend } as DocNode)))

export const setLocked = (doc: Doc, id: NodeId, locked: Partial<LockFlags>) =>
  updateNode(doc, id, (n) => {
    const next = { ...n.locked, ...locked }
    const same = next.pixels === n.locked.pixels && next.position === n.locked.position && next.all === n.locked.all
    return same ? n : ({ ...n, locked: next } as DocNode)
  })

export const setTransform = (doc: Doc, id: NodeId, transform: Affine) =>
  updateNode(doc, id, (n) => (n.transform.every((v, i) => v === transform[i]) ? n : ({ ...n, transform: [...transform] } as DocNode)))

/**
 * Points a pixel layer or a mask at a different tile set (or none). This
 * is the edit every pixel change ends in: the pixels themselves are in the
 * tile store, and the document only swaps one immutable set for another.
 */
export const setTiles = (doc: Doc, id: NodeId, tiles: string | null) =>
  updateNode(doc, id, (n) => {
    if ((n.kind !== 'pixel' && n.kind !== 'mask') || n.props.tiles === tiles) return n
    return { ...n, props: { ...n.props, tiles } } as DocNode
  })

/** How a pixel layer is resampled through its live transform. */
export const setResample = (doc: Doc, id: NodeId, resample: KindProps['pixel']['resample']) =>
  updateNode(doc, id, (n) => (n.kind !== 'pixel' || n.props.resample === resample ? n : ({ ...n, props: { ...n.props, resample } } as DocNode)))

/** A group's knockout: none, to the layer under the group, or to the document's bottom layer. */
export const setKnockout = (doc: Doc, id: NodeId, knockout: KindProps['group']['knockout']) =>
  updateNode(doc, id, (n) => (n.kind !== 'group' || n.props.knockout === knockout ? n : ({ ...n, props: { ...n.props, knockout } } as DocNode)))

/**
 * The document with every reference to the tile sets in `lost` cleared: a
 * layer or mask that lost its pixels comes back empty, and a lost selection
 * is deselected. For a file or a journal that's missing some of its tiles.
 */
export function dropLostSets(doc: Doc, lost: ReadonlySet<string>): Doc {
  let out = doc
  for (const n of Object.values(doc.nodes)) {
    if ((n.kind === 'pixel' || n.kind === 'mask') && n.props.tiles && lost.has(n.props.tiles)) out = setTiles(out, n.id, null)
    if (n.kind === 'embedded' && n.props.content) {
      const inner = dropLostSets(n.props.content, lost)
      if (inner !== n.props.content) out = updateNode(out, n.id, (x) => ({ ...x, props: { ...(x as typeof n).props, content: inner } }) as DocNode)
    }
  }
  if (out.selection && lost.has(out.selection.tiles)) out = { ...out, selection: null }
  if (out.patterns?.some((p) => lost.has(p.tiles))) out = { ...out, patterns: out.patterns.filter((p) => !lost.has(p.tiles)) }
  if (out.channels?.some((c) => c.tiles && lost.has(c.tiles))) out = { ...out, channels: out.channels.map((c) => (c.tiles && lost.has(c.tiles) ? { ...c, tiles: null } : c)) }
  return out
}

/** Every tile set a document holds: in pixel layers, masks, smart objects' contents, and the selection. */
export function tileSetsOf(doc: Doc): string[] {
  let out = setsCache.get(doc.nodes)
  if (!out) {
    out = []
    for (const n of Object.values(doc.nodes)) {
      if ((n.kind === 'pixel' || n.kind === 'mask') && n.props.tiles) out.push(n.props.tiles)
      if (n.kind === 'embedded' && n.props.content) out.push(...tileSetsOf(n.props.content))
    }
    setsCache.set(doc.nodes, out)
  }
  const extra = [...(doc.patterns ?? []).map((p) => p.tiles), ...(doc.channels ?? []).flatMap((c) => (c.tiles ? [c.tiles] : [])), ...(doc.selection ? [doc.selection.tiles] : [])]
  return extra.length ? [...out, ...extra] : out
}

// --- patterns, alpha channels and fill layers ---------------------------------------------------

/** A pattern made from pixels added to the document (or, with an id it has, put in place of that one). */
export function addPattern(doc: Doc, p: DocPattern): Doc {
  const list = doc.patterns ?? []
  const at = list.findIndex((x) => x.id === p.id)
  return { ...doc, patterns: at >= 0 ? list.map((x, i) => (i === at ? p : x)) : [...list, p] }
}

export function renamePattern(doc: Doc, id: string, name: string): Doc {
  const n = name.trim()
  if (!n || !doc.patterns?.some((p) => p.id === id && p.name !== n)) return doc
  return { ...doc, patterns: doc.patterns.map((p) => (p.id === id ? { ...p, name: n } : p)) }
}

/** A pattern taken out of the document; paints that named it draw nothing until another of that id comes. */
export function removePattern(doc: Doc, id: string): Doc {
  if (!doc.patterns?.some((p) => p.id === id)) return doc
  const patterns = doc.patterns.filter((p) => p.id !== id)
  const out: Doc = { ...doc, patterns }
  if (!patterns.length) delete out.patterns
  return out
}

/** An alpha channel added after the others (Save Selection as a new channel). */
export function addChannel(doc: Doc, c: DocChannel): Doc {
  if (doc.channels?.some((x) => x.id === c.id)) return doc
  return { ...doc, channels: [...(doc.channels ?? []), c] }
}

/** An alpha channel's coverage replaced (Save Selection into an existing channel), in document pixels. */
export function setChannelTiles(doc: Doc, id: string, tiles: string | null): Doc {
  if (!doc.channels?.some((c) => c.id === id)) return doc
  return { ...doc, channels: doc.channels.map((c) => (c.id === id ? { ...c, tiles, transform: [...IDENTITY] as Affine } : c)) }
}

export function renameChannel(doc: Doc, id: string, name: string): Doc {
  const n = name.trim()
  if (!n || !doc.channels?.some((c) => c.id === id && c.name !== n)) return doc
  return { ...doc, channels: doc.channels.map((c) => (c.id === id ? { ...c, name: n } : c)) }
}

export function removeChannel(doc: Doc, id: string): Doc {
  if (!doc.channels?.some((c) => c.id === id)) return doc
  const channels = doc.channels.filter((c) => c.id !== id)
  const out: Doc = { ...doc, channels }
  if (!channels.length) delete out.channels
  return out
}

/** Moves an alpha channel to `index` in the list. */
export function moveChannel(doc: Doc, id: string, index: number): Doc {
  const list = [...(doc.channels ?? [])]
  const at = list.findIndex((c) => c.id === id)
  if (at < 0) return doc
  const [c] = list.splice(at, 1)
  list.splice(Math.max(0, Math.min(index, list.length)), 0, c)
  return { ...doc, channels: list }
}

/**
 * The document with each fill layer as a shape: a rectangle over the
 * canvas (in the layer's own coordinates) with the fill layer's paint, its
 * masks, effects, style and clipped layers kept. For the file formats that
 * know shapes but not Plexel's fill layers (PSD, SVG, PDF): the paint is
 * laid across the same box, so it looks the same.
 */
export function fillsAsShapes(doc: Doc): Doc {
  let nodes: Record<NodeId, DocNode> | null = null
  for (const n of Object.values(doc.nodes)) {
    if (n.kind !== 'fill') continue
    const inv = invertAffine(n.transform)
    const pts = [
      [0, 0],
      [doc.width, 0],
      [0, doc.height],
      [doc.width, doc.height],
    ].map(([x, y]) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]])
    const x0 = Math.min(...pts.map((p) => p[0]))
    const y0 = Math.min(...pts.map((p) => p[1]))
    const x1 = Math.max(...pts.map((p) => p[0]))
    const y1 = Math.max(...pts.map((p) => p[1]))
    const { props: _p, kind: _k, ...base } = n
    const shape: DocNode = {
      ...base,
      kind: 'vector',
      props: {
        geometry: { kind: 'shape', shape: { type: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0, radii: [0, 0, 0, 0], corner: 'round' } },
        appearance: [{ kind: 'fill', enabled: true, paint: n.props.paint, opacity: 1, blend: 'normal' }],
        graphicStyle: null,
      },
    }
    nodes ??= { ...doc.nodes }
    nodes[n.id] = shape
  }
  return nodes ? { ...doc, nodes } : doc
}

/** A fill layer's paint. */
export const setFillPaint = (doc: Doc, id: NodeId, paint: Paint) =>
  updateNode(doc, id, (n) => (n.kind !== 'fill' || n.props.paint === paint ? n : ({ ...n, props: { ...n.props, paint } } as DocNode)))

// --- adjustments, live filters, layer effects, smart objects ---------------------------------

/** A new adjustment layer (an ADJUSTMENT_DEFS entry and its settings) at `index` in `parent`. */
export const addAdjustment = (doc: Doc, id: NodeId, name: string, adjustment: string, params: Record<string, unknown>, parent: NodeId, index: number) =>
  insertNode(doc, makeNode('adjustment', id, name, { adjustment, params }), parent, index)

/** An adjustment's or a live filter's settings. */
export function setParams(doc: Doc, id: NodeId, params: Record<string, unknown>): Doc {
  return updateNode(doc, id, (n) => {
    if (n.kind !== 'adjustment' && n.kind !== 'filter') return n
    return JSON.stringify(n.props.params) === JSON.stringify(params) ? n : ({ ...n, props: { ...n.props, params } } as DocNode)
  })
}

/**
 * Adds an effect node (a live filter, or an adjustment for this node
 * alone) to the end of a node's effects, which apply in order to its own
 * content, as Photoshop's smart filters do.
 */
export function addEffect(doc: Doc, id: NodeId, effect: DocNode): Doc {
  const n = doc.nodes[id]
  if (!n || id === doc.root || doc.nodes[effect.id] || !isEffectKind(effect.kind) || !isLayerKind(n.kind) || n.kind === 'adjustment') return doc
  return { ...doc, nodes: { ...doc.nodes, [effect.id]: effect, [id]: { ...n, effects: [...n.effects, effect.id] } as DocNode } }
}

/** Moves an effect to `index` in its node's list. */
export function moveEffect(doc: Doc, effect: NodeId, index: number): Doc {
  const place = placeOf(doc, effect)
  if (!place || place.slot !== 'effects') return doc
  const n = doc.nodes[place.parent]
  const list = n.effects.filter((e) => e !== effect)
  const at = Math.max(0, Math.min(index, list.length))
  if (at === place.index) return doc
  list.splice(at, 0, effect)
  return { ...doc, nodes: { ...doc.nodes, [n.id]: { ...n, effects: list } as DocNode } }
}

/** A node's layer effects, replaced: the Layer Style dialog's result. */
export function setFx(doc: Doc, id: NodeId, fx: LayerFx[]): Doc {
  return updateNode(doc, id, (n) => (JSON.stringify(n.fx) === JSON.stringify(fx) ? n : ({ ...n, fx } as DocNode)))
}

/**
 * Convert to Smart Object: the layers `ids` (siblings, in painting order)
 * become the contents of a new embedded document, `rect` in this one's
 * pixels big, and an embedded node `smartId` takes their place, laid in
 * where they were. Their pixels, masks and effects go with them unchanged.
 */
export function convertToSmartObject(doc: Doc, ids: NodeId[], smartId: NodeId, innerRoot: NodeId, name: string, rect: { x: number; y: number; width: number; height: number }): Doc {
  const places = ids.map((id) => placeOf(doc, id))
  if (!ids.length || doc.nodes[smartId] || places.some((p) => !p || p.slot !== 'children' || p.parent !== places[0]!.parent)) return doc
  const parent = places[0]!.parent
  const order = doc.nodes[parent].children!.filter((c) => ids.includes(c))
  const inside = new Set(order.flatMap((id) => subtree(doc, id)))
  const w = clampSide(rect.width)
  const h = clampSide(rect.height)
  // Inside, everything is moved so the rectangle's corner is the new canvas's.
  const shift: Affine = [1, 0, 0, 1, -rect.x, -rect.y]
  const innerNodes: Record<NodeId, DocNode> = {}
  for (const id of inside) innerNodes[id] = { ...doc.nodes[id], transform: compose(shift, doc.nodes[id].transform) } as DocNode
  const root = makeNode('group', innerRoot, 'Root')
  root.children = order
  innerNodes[innerRoot] = root
  const content: Doc = { ...doc, name, width: w, height: h, root: innerRoot, nodes: innerNodes, selection: null, guides: [] }
  // A smart object's contents are a picture placed in the tile, not a tile of their own.
  delete content.tiled
  const smart = makeNode('embedded', smartId, name, { content })
  smart.transform = [1, 0, 0, 1, rect.x, rect.y]
  const nodes = { ...doc.nodes }
  for (const id of inside) delete nodes[id]
  const at = Math.max(...order.map((id) => doc.nodes[parent].children!.indexOf(id)))
  const kids = doc.nodes[parent].children!.slice()
  kids.splice(at + 1, 0, smartId)
  nodes[parent] = { ...nodes[parent], children: kids.filter((c) => !ids.includes(c)) } as DocNode
  nodes[smartId] = smart
  return { ...doc, nodes }
}

/** A smart object's contents replaced (Edit Contents, saved back). */
export function setSmartContent(doc: Doc, id: NodeId, content: Doc): Doc {
  return updateNode(doc, id, (n) => (n.kind !== 'embedded' || n.props.content === content ? n : ({ ...n, props: { ...n.props, content: { ...content, selection: null } } } as DocNode)))
}
const setsCache = new WeakMap<Doc['nodes'], string[]>()

/**
 * Assign Profile: the document's numbers stay as they are, and are read in
 * another profile from now on. (Convert to Profile, which changes the
 * numbers to keep the colours, arrives with print colour in phase 10.)
 */
export function setProfile(doc: Doc, profile: ProfileRef): Doc {
  return JSON.stringify(profile) === JSON.stringify(doc.profile) ? doc : { ...doc, profile }
}

// --- vectors -----------------------------------------------------------------------------------

/** A new shape: its geometry (in its own coordinates, placed by `transform`) and appearance. */
export function addVector(doc: Doc, id: NodeId, name: string, geometry: Geometry, appearance: AppearanceItem[], parent: NodeId, index: number, transform: Affine = [...IDENTITY]): Doc {
  const n = makeNode('vector', id, name, { geometry, appearance })
  n.transform = transform
  return insertNode(doc, n, parent, index)
}

/** A shape's geometry replaced: a vector's, or a vector mask's. */
export function setGeometry(doc: Doc, id: NodeId, geometry: Geometry | null): Doc {
  return updateNode(doc, id, (n) => {
    if (n.kind === 'vector') return n.props.geometry === geometry ? n : ({ ...n, props: { ...n.props, geometry } } as DocNode)
    if (n.kind === 'mask' && n.props.source === 'vector') return n.props.geometry === geometry ? n : ({ ...n, props: { ...n.props, geometry } } as DocNode)
    return n
  })
}

/** A shape's or compound's appearance stack replaced. */
export function setAppearance(doc: Doc, id: NodeId, appearance: AppearanceItem[]): Doc {
  return updateNode(doc, id, (n) => {
    if (n.kind !== 'vector' && n.kind !== 'boolean' && n.kind !== 'text') return n
    // A change of its own unlinks it from its graphic style, as Illustrator does.
    return n.props.appearance === appearance ? n : ({ ...n, props: { ...n.props, appearance, graphicStyle: null } } as DocNode)
  })
}

/** A compound shape operand's operation. */
export function setBoolOp(doc: Doc, compound: NodeId, child: NodeId, op: BoolOp): Doc {
  return updateNode(doc, compound, (n) => (n.kind === 'boolean' && n.props.ops[child] !== op ? ({ ...n, props: { ...n.props, ops: { ...n.props.ops, [child]: op } } } as DocNode) : n))
}

const isShape = (n: DocNode | undefined) => n?.kind === 'vector' || n?.kind === 'boolean'

/**
 * Combines a shape with the shape below it (Layer → Combine Shapes): the
 * two become a compound shape in their place, the top one combining with
 * the bottom by `op`. Below a compound, the shape joins it instead. The
 * compound is painted with the bottom shape's appearance (or keeps its
 * own), as Illustrator's compound shapes take one appearance. Refused when
 * there's no shape directly below.
 */
export function combineWithBelow(doc: Doc, id: NodeId, op: BoolOp, compoundId: NodeId): Doc {
  const place = placeOf(doc, id)
  if (!place || place.slot !== 'children' || place.index === 0) return doc
  const top = doc.nodes[id]
  const siblings = doc.nodes[place.parent].children ?? []
  const below = doc.nodes[siblings[place.index - 1]]
  if (!isShape(top) || !isShape(below) || doc.nodes[place.parent].kind === 'boolean') return doc
  let next = removeNode(doc, id)
  if (below.kind === 'boolean') {
    // Taken out without its own subtree going: removeNode drops descendants, so put it back whole.
    next = { ...next, nodes: { ...next.nodes, ...nodesUnder(doc, id) } }
    const c = next.nodes[below.id] as DocNode & { kind: 'boolean' }
    return { ...next, nodes: { ...next.nodes, [below.id]: { ...c, children: [...(c.children ?? []), id], props: { ...c.props, ops: { ...c.props.ops, [id]: op } } } as DocNode } }
  }
  next = { ...next, nodes: { ...next.nodes, ...nodesUnder(doc, id) } }
  const appearance = below.kind === 'vector' ? below.props.appearance : []
  const compound = makeNode('boolean', compoundId, freshName(doc, 'Compound'), { ops: { [id]: op }, appearance })
  compound.children = [below.id, id]
  const parent = next.nodes[place.parent]
  const kids = (parent.children ?? []).map((k) => (k === below.id ? compoundId : k))
  return { ...next, nodes: { ...next.nodes, [compoundId]: compound, [place.parent]: { ...parent, children: kids } as DocNode } }
}

/** A node and everything under it (children, masks, effects), as they are in `doc`. */
const nodesUnder = (doc: Doc, id: NodeId): Record<NodeId, DocNode> => Object.fromEntries(subtree(doc, id).map((k) => [k, doc.nodes[k]]))

/**
 * Releases a compound shape: its shapes go back among the layers where it
 * was, each as it was before, and the compound goes.
 */
export function releaseCompound(doc: Doc, id: NodeId): Doc {
  const c = doc.nodes[id]
  const place = placeOf(doc, id)
  if (c?.kind !== 'boolean' || !place || place.slot !== 'children') return doc
  const kids = c.children ?? []
  const parent = doc.nodes[place.parent]
  const list = [...(parent.children ?? [])]
  list.splice(place.index, 1, ...kids)
  const nodes = { ...doc.nodes, [place.parent]: { ...parent, children: list } as DocNode }
  // The compound's own masks and effects go with it.
  for (const k of [...c.masks, ...c.effects]) for (const d of subtree(doc, k)) delete nodes[d]
  delete nodes[id]
  return { ...doc, nodes }
}

/**
 * Expands a compound shape into one path, its outline worked out (the
 * caller gives it, in document pixels), keeping the compound's appearance,
 * place, masks and effects.
 */
export function expandCompound(doc: Doc, id: NodeId, path: PathData): Doc {
  const c = doc.nodes[id]
  if (c?.kind !== 'boolean') return doc
  const nodes = { ...doc.nodes }
  for (const k of c.children ?? []) for (const d of subtree(doc, k)) delete nodes[d]
  const v = makeNode('vector', id, c.name, { geometry: { kind: 'path', path }, appearance: c.props.appearance })
  nodes[id] = { ...v, visible: c.visible, locked: c.locked, opacity: c.opacity, fillOpacity: c.fillOpacity, blend: c.blend, masks: c.masks, effects: c.effects, fx: c.fx, tag: c.tag, children: [] } as DocNode
  return { ...doc, nodes }
}

/** A vector mask on a node, empty: `outside` 1 shows everything until it has an outline (Reveal All), 0 hides it (Hide All). */
export function addVectorMask(doc: Doc, id: NodeId, maskId: NodeId, outside: number, geometry: Geometry | null = null): Doc {
  const n = doc.nodes[id]
  if (!n || id === doc.root || doc.nodes[maskId] || !isLayerKind(n.kind)) return doc
  if (n.masks.some((m) => doc.nodes[m]?.kind === 'mask' && (doc.nodes[m] as DocNode & { kind: 'mask' }).props.source === 'vector')) return doc
  const mask = makeNode('mask', maskId, 'Vector Mask', { source: 'vector', geometry, outside })
  return { ...doc, nodes: { ...doc.nodes, [maskId]: mask, [id]: { ...n, masks: [...n.masks, maskId] } as DocNode } }
}

// --- text --------------------------------------------------------------------------------------

/** A text node's content replaced. */
export function setTextContent(doc: Doc, id: NodeId, content: TextContent): Doc {
  return updateNode(doc, id, (n) => (n.kind === 'text' && n.props.content !== content ? ({ ...n, props: { ...n.props, content } } as DocNode) : n))
}

/** A text node's kind of text, frame or start along its path. */
export function setTextProps(doc: Doc, id: NodeId, patch: Partial<Pick<KindProps['text'], 'mode' | 'frame' | 'pathOffset'>>): Doc {
  return updateNode(doc, id, (n) => (n.kind === 'text' ? ({ ...n, props: { ...n.props, ...patch } } as DocNode) : n))
}

/** The document's character and paragraph styles replaced. */
export const setTextStyles = (doc: Doc, textStyles: TextStyles): Doc => (doc.textStyles === textStyles ? doc : { ...doc, textStyles })
