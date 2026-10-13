/**
 * The engine's copy of a document: what the render graph reads.
 *
 * The page sends only the nodes that changed (EngineHost compares node
 * objects, which every edit replaces rather than mutates), each with a
 * version number. From those this works out what each node covers
 * (`bounds`), a content version for each subtree (what a cached render of
 * it depends on), and, for each update, the regions of the document that
 * changed, so the renderer redraws those and nothing else.
 *
 * Nothing here touches the GPU, so the checks can run it in Node.
 */
import type { ColourMode, Depth, Doc, DocNode, NodeId, ProfileRef, Tiling } from '../doc/types'
import { TILE } from '../tiles/format'
import { FILTER_BY_ID, MAX_REACH, filterValues, warpOf, type Warp } from '../filters/defs'
import { FX_BY_KIND, activeFx, fxValues, type FxKind } from '../fx/defs'
import { vectorBounds } from '../vector/shape'

/** What an adjustment layer covers: everything under it. */
const EVERYWHERE: Rect = [-1e9, -1e9, 1e9, 1e9]

/** [left, top, right, bottom] in document pixels. */
export type Rect = [number, number, number, number]

/**
 * Where a document rectangle of a node goes under a warp in the node's own
 * coordinates: back through the node's transform, warped, and out again.
 */
export function warpedRect(t: readonly number[], w: Warp, r: Rect): Rect | null {
  const det = t[0] * t[3] - t[1] * t[2] || 1e-12
  const inv = [t[3] / det, -t[1] / det, -t[2] / det, t[0] / det, (t[2] * t[5] - t[3] * t[4]) / det, (t[1] * t[4] - t[0] * t[5]) / det]
  const pts = [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[0], r[3]],
    [r[2], r[3]],
  ].map(([x, y]) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]])
  const local: Rect = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]
  const b = w.bounds(local)
  if (!b) return null
  const out = [
    [b[0], b[1]],
    [b[2], b[1]],
    [b[0], b[3]],
    [b[2], b[3]],
  ].map(([x, y]) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]])
  return [Math.min(...out.map((p) => p[0])), Math.min(...out.map((p) => p[1])), Math.max(...out.map((p) => p[0])), Math.max(...out.map((p) => p[1]))]
}

export interface SceneDoc {
  width: number
  height: number
  mode: ColourMode
  depth: Depth
  profile: ProfileRef
  root: NodeId
  /** The selection's coverage set, or none: for its overlay, for confining strokes, and for Quick Mask. */
  selection: string | null
  /** The document's patterns made from pixels, which pattern paints name. */
  patterns?: { id: string; tiles: string; width: number; height: number }[]
  /** Whether the document is a seamless tile; absent is off. */
  tiled?: Tiling
}

export interface SceneUpdate {
  doc: SceneDoc
  /** Nodes added or changed, with their versions. */
  nodes: { node: DocNode; version: number }[]
  removed: NodeId[]
  /** Everything is in `nodes`: what isn't there is gone. */
  reset: boolean
}

/** Where a tile set's tiles reach, in its own tile coordinates, inclusive; null for an empty or unknown set. */
export type Extent = { x0: number; y0: number; x1: number; y1: number } | null

export const union = (a: Rect | null, b: Rect | null): Rect | null =>
  !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]

export const intersects = (a: Rect | null, b: Rect | null) => !!a && !!b && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]

/** A layer-space rectangle through an affine, as the rectangle around the result. */
export function transformRect(t: number[], r: Rect): Rect {
  const pts = [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[2], r[3]],
    [r[0], r[3]],
  ].map(([x, y]) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]])
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** The node's fields that change what it draws, apart from its children list. */
const ownKey = (n: DocNode) => {
  const { children: _c, name: _n, tag: _t, locked: _l, ...rest } = n
  return JSON.stringify(rest)
}

/** A document's patterns as the engine needs them: without their names. */
export const scenePatterns = (doc: Doc): SceneDoc['patterns'] => (doc.patterns ?? []).map((p) => ({ id: p.id, tiles: p.tiles, width: p.width, height: p.height }))

/** What it is about the document itself that changed, if anything. */
export function docChange(a: SceneDoc | null, b: SceneDoc): 'none' | 'colour' | 'all' {
  if (!a) return 'all'
  if (a.width !== b.width || a.height !== b.height || a.root !== b.root) return 'all'
  // Tiling changes what's read across the edges, and what the view shows round the canvas.
  if ((a.tiled ?? 'off') !== (b.tiled ?? 'off')) return 'all'
  // A pattern changing is rare (Define Pattern, a conversion); everything that might use it is drawn again.
  if (JSON.stringify(a.patterns ?? []) !== JSON.stringify(b.patterns ?? [])) return 'all'
  if (a.mode !== b.mode || a.depth !== b.depth || JSON.stringify(a.profile) !== JSON.stringify(b.profile)) return 'colour'
  return 'none'
}

export class Scene {
  doc: SceneDoc | null = null
  nodes = new Map<NodeId, DocNode>()
  versions = new Map<NodeId, number>()
  parent = new Map<NodeId, NodeId>()
  /** Each mask's and effect's node: they aren't children, so they have no parent. */
  owner = new Map<NodeId, NodeId>()
  /** Bumped by every update. */
  revision = 0
  /**
   * Strokes being painted, by node: where each reaches in the document, and
   * a count that moves with every frame of dabs, so cached renders of the
   * node and its ancestors know they're out of date.
   */
  private live = new Map<NodeId, { rect: Rect | null; n: number }>()
  private boundsCache = new Map<NodeId, { rev: number; rect: Rect | null }>()
  private vectorBoxes = new WeakMap<DocNode, Rect | null>()
  private contentCache = new Map<NodeId, { rev: number; v: string }>()

  constructor(
    readonly key: string,
    /** Where a tile set's tiles reach. The engine's tile store answers. */
    readonly extentOf: (setId: string) => Extent,
  ) {}

  get canvas(): Rect {
    return [0, 0, this.doc?.width ?? 0, this.doc?.height ?? 0]
  }

  node(id: NodeId) {
    return this.nodes.get(id)
  }

  /**
   * What a node draws on, in document pixels: its own content, and for a
   * group its children's. A non-group's children are clipped to it, so
   * they never reach past it. Hidden nodes draw nothing.
   */
  bounds(id: NodeId): Rect | null {
    const c = this.boundsCache.get(id)
    if (c && c.rev === this.revision) return c.rect
    const n = this.nodes.get(id)
    let rect: Rect | null = null
    if (n && n.visible) {
      if (n.kind === 'group') for (const k of n.children ?? []) rect = union(rect, this.bounds(k))
      else rect = this.contentBounds(n)
    }
    this.boundsCache.set(id, { rev: this.revision, rect })
    return rect
  }

  /**
   * What a node's own content covers, before its children: grown by as far
   * as its live filters and layer effects reach, unless `reach` is false.
   * Kinds with nothing to draw yet cover nothing; an adjustment covers
   * everything under it.
   */
  contentBounds(n: DocNode, reach = true): Rect | null {
    // A filter layer (a filter among layers, not in one's effects) changes what's below it, everywhere.
    if (n.kind === 'adjustment' || n.kind === 'fill' || (n.kind === 'filter' && this.parent.has(n.id))) return EVERYWHERE
    let r: Rect | null
    if (n.kind === 'embedded') r = n.props.content ? transformRect(n.transform, [0, 0, n.props.content.width, n.props.content.height]) : null
    else if (n.kind === 'vector' || n.kind === 'text') {
      // Worked out once per node object: edits replace it.
      let b = this.vectorBoxes.get(n)
      if (b === undefined) {
        b = vectorBounds((id) => this.nodes.get(id), n)
        this.vectorBoxes.set(n, b)
      }
      r = b
    } else if (n.kind === 'boolean') r = vectorBounds((id) => this.nodes.get(id), n)
    else if (n.kind === 'pixel') {
      const live = this.live.get(n.id)?.rect ?? null
      const e = n.props.tiles ? this.extentOf(n.props.tiles) : null
      r = e ? union(transformRect(n.transform, [e.x0 * TILE, e.y0 * TILE, (e.x1 + 1) * TILE, (e.y1 + 1) * TILE]), live) : live
    } else return null
    // A filter that remaps (Offset) gives the canvas, whatever the layer covered.
    if (r && this.doc && n.effects.some((id) => this.remaps(id))) r = [0, 0, this.doc.width, this.doc.height]
    if (!r || !reach) return r
    if (!this.warped(n)) {
      const m = this.reachOf(n)
      return m ? [r[0] - m, r[1] - m, r[2] + m, r[3] + m] : r
    }
    // A geometric effect (Warp, Liquify) carries what's before it where it goes: in order, reach then warp.
    const mode = this.doc?.mode ?? 'rgb'
    let b: Rect = r
    let m = 0
    for (const id of n.effects) {
      const e = this.nodes.get(id)
      if (e?.kind !== 'filter' || !e.visible) continue
      const def = FILTER_BY_ID.get(e.props.filter)
      if (!def) continue
      if (def.warp) {
        const w = warpOf(e, mode)
        if (!w) continue
        b = warpedRect(n.transform, w, [b[0] - m, b[1] - m, b[2] + m, b[3] + m]) ?? b
        m = 0
      } else if (def.remap) m += Math.max(this.doc?.width ?? 0, this.doc?.height ?? 0)
      else m += Math.ceil(def.reach(filterValues(e.props.filter, e.props.params, mode), 1))
    }
    m += this.fxReach(n)
    return m ? [b[0] - m, b[1] - m, b[2] + m, b[3] + m] : b
  }

  /** Whether a node has a geometric effect showing that moves anything: what it draws isn't where its pixels are. */
  warped(n: DocNode | NodeId): boolean {
    const node = typeof n === 'string' ? this.nodes.get(n) : n
    if (!node?.effects.length) return false
    const mode = this.doc?.mode ?? 'rgb'
    return node.effects.some((id) => {
      const e = this.nodes.get(id)
      return !!e && e.visible && e.opacity > 0 && !!warpOf(e, mode)
    })
  }

  /** Whether an effect is a shown filter that remaps (Offset), reading from anywhere on the canvas. */
  private remaps(id: NodeId): boolean {
    const e = this.nodes.get(id)
    return e?.kind === 'filter' && e.visible && !!FILTER_BY_ID.get(e.props.filter)?.remap
  }

  /** How far past its pixels a node's live filters and layer effects draw, in document pixels. */
  reachOf(n: DocNode): number {
    const mode = this.doc?.mode ?? 'rgb'
    let m = 0
    for (const id of n.effects) {
      const e = this.nodes.get(id)
      if (e?.kind === 'filter' && e.visible) {
        const def = FILTER_BY_ID.get(e.props.filter)
        // A change anywhere can land anywhere on the canvas.
        if (def?.remap) m += Math.max(this.doc?.width ?? 0, this.doc?.height ?? 0)
        else if (def) m += Math.ceil(def.reach(filterValues(e.props.filter, e.props.params, mode), 1))
      }
    }
    return Math.min(MAX_REACH * 64, m + this.fxReach(n))
  }

  /** How far past its body a node's layer effects draw, in document pixels. */
  private fxReach(n: DocNode): number {
    const mode = this.doc?.mode ?? 'rgb'
    let fx = 0
    for (const f of activeFx(n.fx)) {
      const def = FX_BY_KIND.get(f.kind as FxKind)
      if (def) fx = Math.max(fx, Math.ceil(def.reach(fxValues(f, mode))))
    }
    return fx
  }

  /**
   * The version of a node's own content: itself and a stroke on it, not its
   * children, masks or effects. A compound shape's content is its operands,
   * so theirs count.
   */
  ownVersion(id: NodeId): string {
    if (this.nodes.get(id)?.kind === 'boolean') return this.contentVersion(id)
    const live = this.live.get(id)
    return `${this.versions.get(id) ?? 0}${live ? `~${live.n}` : ''}`
  }

  /** A stroke on `id` has reached `rect` (in document pixels), or ended (null). */
  setLive(id: NodeId, rect: Rect | null) {
    const was = this.live.get(id)
    if (rect) this.live.set(id, { rect, n: (was?.n ?? 0) + 1 })
    else this.live.delete(id)
    this.revision++
  }

  /**
   * A version for the node and everything under it: equal versions draw
   * the same. Cached renders of a group are keyed by this.
   */
  contentVersion(id: NodeId): string {
    const c = this.contentCache.get(id)
    if (c && c.rev === this.revision) return c.v
    const n = this.nodes.get(id)
    const kids = n?.children?.map((k) => this.contentVersion(k)).join(',') ?? ''
    const live = this.live.get(id)
    // A node's masks are part of what it draws.
    const masks = [...(n?.masks ?? []), ...(n?.effects ?? [])].map((m) => `${this.versions.get(m) ?? 0}${this.live.has(m) ? `~${this.live.get(m)!.n}` : ''}`).join(',')
    const v = `${this.versions.get(id) ?? 0}${live ? `~${live.n}` : ''}${masks ? `[${masks}]` : ''}${kids ? `(${kids})` : ''}`
    this.contentCache.set(id, { rev: this.revision, v })
    return v
  }

  /** Every node's ancestors, nearest first. */
  ancestors(id: NodeId): NodeId[] {
    const out: NodeId[] = []
    for (let p = this.parent.get(id); p; p = this.parent.get(p)) out.push(p)
    return out
  }

  /**
   * Applies an update and returns what it changed: 'all', or the regions of
   * the document that now draw differently. The old and new bounds of a
   * changed node both count, since it has left one and arrived in the
   * other; a reordered list counts only the children that moved.
   */
  apply(u: SceneUpdate): { dirty: Rect[] | 'all'; colour: boolean } {
    const change = docChange(this.doc, u.doc)
    const before = new Map<NodeId, Rect | null>()
    const oldNodes = new Map(this.nodes)
    const touched = new Set<NodeId>([...u.nodes.map((x) => x.node.id), ...u.removed])
    if (u.reset) for (const id of this.nodes.keys()) if (!u.nodes.some((x) => x.node.id === id)) touched.add(id)
    // Old bounds of everything that might move: the touched nodes and
    // every child of a touched container.
    const consider = new Set<NodeId>(touched)
    for (const id of touched) for (const k of oldNodes.get(id)?.children ?? []) consider.add(k)
    // A compound shape's operands change it wherever its outline (and its
    // strokes) go, not just where they are: the compound counts too.
    const compounds = new Set<NodeId>()
    for (const id of touched) {
      const p = this.parent.get(id)
      if (p && oldNodes.get(p)?.kind === 'boolean') compounds.add(p)
    }
    for (const { node } of u.nodes) if (node.kind === 'boolean') for (const k of node.children ?? []) if (touched.has(k)) compounds.add(node.id)
    for (const id of compounds) consider.add(id)
    for (const { node } of u.nodes) for (const k of node.children ?? []) consider.add(k)
    for (const id of consider) before.set(id, this.effectiveBounds(id))

    this.doc = u.doc
    if (u.reset) {
      this.nodes.clear()
      this.versions.clear()
    }
    for (const id of u.removed) {
      this.nodes.delete(id)
      this.versions.delete(id)
    }
    for (const { node, version } of u.nodes) {
      this.nodes.set(node.id, node)
      this.versions.set(node.id, version)
    }
    this.parent.clear()
    this.owner.clear()
    for (const n of this.nodes.values()) {
      for (const k of n.children ?? []) this.parent.set(k, n.id)
      for (const m of n.masks) this.owner.set(m, n.id)
      for (const m of n.effects) this.owner.set(m, n.id)
    }
    this.revision++
    if (change === 'all') return { dirty: 'all', colour: true }

    const dirty: Rect[] = []
    const add = (r: Rect | null) => r && dirty.push(r)
    for (const id of compounds) {
      add(before.get(id) ?? null)
      add(this.effectiveBounds(id))
    }
    for (const id of touched) {
      const was = oldNodes.get(id)
      const now = this.nodes.get(id)
      if (!was || !now || ownKey(was) !== ownKey(now)) {
        add(before.get(id) ?? null)
        add(this.effectiveBounds(id))
        continue
      }
      // Only the children changed: the ones that came, went or moved.
      const a = was.children ?? []
      const b = now.children ?? []
      const moved = new Set<NodeId>()
      a.forEach((k, i) => b[i] !== k && moved.add(k))
      b.forEach((k, i) => a[i] !== k && moved.add(k))
      for (const k of moved) {
        add(before.get(k) ?? null)
        add(this.effectiveBounds(k))
      }
    }
    // A filter layer spreads a change below it as far as it reads.
    const g = this.filterLayerReach()
    return { dirty: g ? dirty.map((r) => [r[0] - g, r[1] - g, r[2] + g, r[3] + g] as Rect) : dirty, colour: change === 'colour' }
  }

  /** How far the document's filter layers read past a pixel, together, in document pixels: what a change below them spreads by. */
  filterLayerReach(): number {
    const mode = this.doc?.mode ?? 'rgb'
    let m = 0
    for (const n of this.nodes.values()) {
      if (n.kind !== 'filter' || !n.visible || !this.parent.has(n.id)) continue
      const def = FILTER_BY_ID.get(n.props.filter)
      if (def && !def.warp && !def.remap) m += Math.ceil(def.reach(filterValues(n.props.filter, n.props.params, mode), 1))
    }
    return Math.min(MAX_REACH * 64, m)
  }

  /**
   * Where a node shows, after its ancestors' clipping: a child of a pixel
   * layer can't draw outside it. Used for dirty regions, where reaching too
   * far only costs a redraw but not reaching far enough would leave stale
   * pixels.
   */
  private effectiveBounds(id: NodeId): Rect | null {
    // A mask changes what its node shows, wherever the node is.
    const own = this.owner.get(id)
    if (own) return this.effectiveBounds(own)
    let r = this.nodes.get(id)?.visible === false ? this.boundsIgnoringVisibility(id) : this.bounds(id)
    for (const a of this.ancestors(id)) {
      const n = this.nodes.get(a)
      if (n && n.kind !== 'group' && r) {
        const c = this.contentBounds(n)
        r = c && intersects(r, c) ? [Math.max(r[0], c[0]), Math.max(r[1], c[1]), Math.min(r[2], c[2]), Math.min(r[3], c[3])] : null
      }
    }
    return r
  }

  /** A hidden node's bounds as if it were shown: hiding it changes that region. */
  private boundsIgnoringVisibility(id: NodeId): Rect | null {
    const n = this.nodes.get(id)
    if (!n) return null
    if (n.kind === 'group') {
      let r: Rect | null = null
      for (const k of n.children ?? []) r = union(r, this.boundsIgnoringVisibility(k))
      return r
    }
    return this.contentBounds(n)
  }
}
