/**
 * Vectors on the canvas: the Pen, Direct Selection and Shape tools, the
 * outline, anchors and handles they show, and the Layer menu's shape
 * commands (combining shapes, compound shapes, vector masks).
 *
 * What the Pen and Direct Selection edit is the target: the selected
 * shape's path, or the selected layer's vector mask when that's chosen in
 * the Layers panel. Editing a live shape's anchors turns it into a path,
 * as Illustrator does; its parameters are gone from then on.
 *
 * Gestures preview their result straight on the canvas (the document as
 * it would be, sent to the engine without a step) and commit once, named.
 */
import { addVector, addVectorMask, combineWithBelow, compose, expandCompound, insertNode, invertAffine, releaseCompound, removeNode, setAppearance, setBoolOp, setGeometry } from '../doc/edit'
import { joinPath } from '../geom/regions'
import { freshName, placeOf, layerRows } from '../doc/tree'
import type { Affine, BoolOp, Doc, DocNode, NodeId } from '../doc/types'
import { fillItem, geometryPath, solid, strokeItem, type AppearanceItem, type Geometry } from '../doc/vector'
import { breakAt, closeSubpath, joinSubpaths, separate, curvatureAnchor, recurvePath, convertAnchor, deleteAnchors, hitAnchor, hitHandle, hitSegment, insertAnchor, isEndpoint, moveAnchors, moveHandle, parseRef, refKey, type AnchorRef } from '../geom/edit'
import { applyMat, evalCubic, flattenPath, isLine, linesFor, reverseSubpath, segmentsOf, transformPath, type Anchor, type PathData, type Pt, type Subpath } from '../geom/path'
import { shapeBox, shapeInBox, shapePath, type CornerStyle, type ShapeType } from '../geom/shapes'
import { engine } from '../engine/EngineHost'
import type { OverlayShape } from '../render/overlay'
import { viewMatrix } from '../render/view'
import { tools } from '../tools'
import { docPathOf } from '../vector/shape'
import { swatchIn } from './colour'
import { clearToolOverlay, registerTool, sessions, setToolOverlay, snapped, type Gesture, type Pointer, type Session } from './canvasTools'
import { startSnap } from './snapping'
import { documents, newId, selectedIds, type OpenDoc } from './documents'
import { notify } from './notices'
import { setPathSink, setPathSource } from './clipboard'
import { vectorMaskOf } from './selection'
import { shapeHit } from './pick'
import { views } from './views'
import { Listeners } from '../lib/listeners'
import { whereNew } from '../doc/tree'

// --- settings ----------------------------------------------------------------------------------

export interface ShapeToolState {
  type: ShapeType
  radius: number
  corner: CornerStyle
  sides: number
  points: number
  inner: number
  /** New shapes are filled with the foreground colour. */
  fill: boolean
  /** New shapes are stroked with the background colour, this wide. */
  stroke: boolean
  strokeWidth: number
  /** The Pen's Smart mode (Affinity's): a click places a smooth point, its curve worked out from its neighbours. */
  smart: boolean
}

const KEY = 'plexel.shapeTools.v1'
const TYPES: ShapeType[] = ['rect', 'ellipse', 'polygon', 'star', 'line']
const CORNERS: CornerStyle[] = ['round', 'chamfer', 'inset']

const defaultShapeTools = (): ShapeToolState => ({ type: 'rect', radius: 0, corner: 'round', sides: 6, points: 5, inner: 0.5, fill: true, stroke: false, strokeWidth: 4, smart: false })

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

function readShapeTools(raw: unknown): ShapeToolState {
  const d = defaultShapeTools()
  if (!raw || typeof raw !== 'object') return d
  const r = raw as Record<string, unknown>
  return {
    type: TYPES.includes(r.type as ShapeType) ? (r.type as ShapeType) : d.type,
    radius: num(r.radius, 0, 10000, d.radius),
    corner: CORNERS.includes(r.corner as CornerStyle) ? (r.corner as CornerStyle) : d.corner,
    sides: Math.round(num(r.sides, 3, 100, d.sides)),
    points: Math.round(num(r.points, 3, 100, d.points)),
    inner: num(r.inner, 0.01, 1, d.inner),
    fill: typeof r.fill === 'boolean' ? r.fill : d.fill,
    stroke: typeof r.stroke === 'boolean' ? r.stroke : d.stroke,
    strokeWidth: num(r.strokeWidth, 0.1, 1000, d.strokeWidth),
    smart: typeof r.smart === 'boolean' ? r.smart : d.smart,
  }
}

class ShapeToolStore {
  private state: ShapeToolState
  private changes = new Listeners()
  constructor() {
    let raw: unknown = null
    try {
      raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    } catch {
      raw = null
    }
    this.state = readShapeTools(raw)
  }
  get = () => this.state
  subscribe = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }
  update(patch: Partial<ShapeToolState>) {
    this.state = readShapeTools({ ...this.state, ...patch })
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state))
    } catch {
      // Not remembered; still used.
    }
    this.changes.emit()
  }
}

let shapeStore: ShapeToolStore | null = null
export const shapeTools = () => (shapeStore ??= new ShapeToolStore())

/** A new shape's fills and strokes, from the tool settings and the colours. A line is always stroked. */
function newAppearance(doc: Doc, line: boolean): AppearanceItem[] {
  const s = shapeTools().get()
  const fg = swatchIn(doc, 'fg') ?? (doc.mode === 'cmyk' ? [0, 0, 0, 1] : doc.mode === 'gray' ? [0] : [0, 0, 0])
  const bg = swatchIn(doc, 'bg') ?? (doc.mode === 'cmyk' ? [0, 0, 0, 0] : doc.mode === 'gray' ? [1] : [1, 1, 1])
  if (line) return [strokeItem(solid(fg), s.strokeWidth)]
  const out: AppearanceItem[] = []
  if (s.fill || !s.stroke) out.push(fillItem(solid(fg)))
  if (s.stroke) out.push(strokeItem(solid(s.fill ? bg : fg), s.strokeWidth))
  return out
}

// --- what's being edited --------------------------------------------------------------------

/** The path the Pen and Direct Selection edit: a shape's, or a vector mask's. */
export interface Target {
  key: string
  /** The node whose geometry it is: the shape, or the mask. */
  id: NodeId
  mask: boolean
  /** Its path in its own coordinates, and the transform placing them in the document. */
  path: PathData
  transform: Affine
  /** A live shape: editing its anchors turns it into a path. */
  live: boolean
}

function targetOf(d: OpenDoc): Target | null {
  const doc = d.history.present
  const node = d.selected ? doc.nodes[d.selected] : null
  if (!node) return null
  if (d.maskTarget === 'vector') {
    const m = vectorMaskOf(doc, node)
    if (!m) return null
    return { key: d.key, id: m.id, mask: true, path: geometryPath(m.props.geometry), transform: m.transform, live: m.props.geometry?.kind === 'shape' }
  }
  return targetFor(d, node.id)
}

/** A shape's path as a target, or null when the node isn't a shape. */
function targetFor(d: OpenDoc, id: NodeId): Target | null {
  const node = d.history.present.nodes[id]
  if (node?.kind !== 'vector') return null
  return { key: d.key, id: node.id, mask: false, path: geometryPath(node.props.geometry), transform: node.transform, live: node.props.geometry?.kind === 'shape' }
}

/**
 * Every path Direct Selection works on: the key layer's (or its vector
 * mask, which is then the only one), then each other selected shape's.
 */
function targetsOf(d: OpenDoc): Target[] {
  const key = targetOf(d)
  if (key?.mask) return [key]
  const out = key ? [key] : []
  for (const id of selectedIds(d)) {
    if (id === key?.id) continue
    const t = targetFor(d, id)
    if (t) out.push(t)
  }
  return out
}

/** The shapes shown on the canvas that Direct Selection's box can reach: visible all the way up, not locked, not a compound's operand. */
function reachableShapes(doc: Doc): NodeId[] {
  const out: NodeId[] = []
  const walk = (id: NodeId) => {
    const n = doc.nodes[id]
    if (!n || !n.visible) return
    if (n.kind === 'vector' && !n.locked.all && !n.locked.position) out.push(id)
    if (n.kind === 'boolean') return
    for (const c of n.children ?? []) walk(c)
  }
  for (const c of doc.nodes[doc.root].children ?? []) walk(c)
  return out
}

const toNode = (t: Target, p: { x: number; y: number }): Pt => applyMat(invertAffine(t.transform), p.x, p.y)

/** How many document pixels a few device pixels are, at the front view's zoom. */
function docRadius(devicePx: number): number {
  const v = views().front()
  if (!v) return devicePx
  const m = viewMatrix(v, engine().canvasSize())
  return devicePx / (Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1)
}
const nodeRadius = (t: Target, devicePx: number) => docRadius(devicePx) / (Math.sqrt(Math.abs(t.transform[0] * t.transform[3] - t.transform[1] * t.transform[2])) || 1)

/** How near an anchor or handle a press must be to take it, in device pixels. */
const GRAB = 8
/** Below this many device pixels a press is a click, not a drag. */
const CLICK = 3

// --- the selected anchors ---------------------------------------------------------------------

/**
 * The selected anchors, per path (by node id), in one document: Direct
 * Selection can hold points of several shapes at once.
 */
class AnchorSelection {
  key: string | null = null
  byId = new Map<NodeId, Set<string>>()
  /** Counts changes, for what follows the selection on the page. */
  version = 0
  private changes = new Listeners()
  subscribe = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }
  of(t: Target | null): AnchorRef[] {
    if (!t || t.key !== this.key) return []
    return [...(this.byId.get(t.id) ?? [])].map(parseRef).filter((r) => !!t.path.subpaths[r.sub]?.anchors[r.i])
  }
  /** The paths with points selected. */
  ids(): NodeId[] {
    return [...this.byId].filter(([, s]) => s.size).map(([id]) => id)
  }
  /** One path's points, and no other path's. */
  set(t: Target | null, refs: AnchorRef[]) {
    this.setMany(t?.key ?? null, t ? new Map([[t.id, refs]]) : new Map())
  }
  /** Points on several paths at once, replacing all there were. */
  setMany(key: string | null, refs: Map<NodeId, AnchorRef[]>) {
    this.key = key
    this.byId = new Map([...refs].filter(([, r]) => r.length).map(([id, r]) => [id, new Set(r.map(refKey))]))
    this.version++
    this.changes.emit()
  }
  /** Every path's selected points, keyed by id. */
  all(): Map<NodeId, AnchorRef[]> {
    return new Map([...this.byId].map(([id, s]) => [id, [...s].map(parseRef)]))
  }
  /** Drops the paths not in `keep`. */
  keepOnly(keep: Set<NodeId>) {
    if (![...this.byId.keys()].some((id) => !keep.has(id))) return
    for (const id of [...this.byId.keys()]) if (!keep.has(id)) this.byId.delete(id)
    this.version++
    this.changes.emit()
  }
}
export const anchorSelection = new AnchorSelection()

// --- previews and commits -----------------------------------------------------------------------

const preview = (key: string, doc: Doc) => engine().setScene(key, doc)
const unpreview = (key: string) => {
  const d = documents().get(key)
  if (d) engine().setScene(key, d.history.present)
}

/** A target's geometry replaced by a path (a live shape becomes one). */
const withPath = (doc: Doc, t: Target, path: PathData) => setGeometry(doc, t.id, { kind: 'path', path })

function commitPath(t: Target, path: PathData, label: string) {
  documents().commit((x) => withPath(x, t, path), { key: t.key, label: t.mask ? 'Edit Vector Mask' : label })
}

/** Where a new layer goes (doc/tree.ts): above the selected one, or into the artboard it's drawn on. */
const newLayerPlace = (doc: Doc, selected: NodeId | null, at?: [number, number] | null) => whereNew(doc, selected, at)

// --- the overlay -------------------------------------------------------------------------------

/** The Pen's path being drawn, for the overlay. */
let penDraft: { key: string; t: Target | null; anchors: Anchor[]; transform: Affine; hover: Pt | null; closing: boolean; ghost?: Anchor[] | null } | null = null
/** Direct Selection's box being dragged out, in document pixels. */
let marquee: { key: string; a: Pt; b: Pt } | null = null

/** A path's outline, flattened in document pixels, finely enough for the screen. */
function outlineOf(path: PathData, m: Affine): OverlayShape[] {
  const tol = docRadius(0.25)
  return flattenPath(path, tol, m).map((l) => ({ kind: 'path' as const, points: pairs(l.pts), closed: l.closed, style: 'thin' as const }))
}
const pairs = (pts: number[]): [number, number][] => {
  const out: [number, number][] = []
  for (let i = 0; i < pts.length; i += 2) out.push([pts[i], pts[i + 1]])
  return out
}

/** Anchors (filled when selected) and the handles of the selected ones, in document pixels. */
function anchorShapes(path: PathData, m: Affine, selected: Set<string>): OverlayShape[] {
  const out: OverlayShape[] = []
  const pts: [number, number][] = []
  const sel: boolean[] = []
  const smooth: boolean[] = []
  const dots: [number, number][] = []
  path.subpaths.forEach((s, sub) =>
    s.anchors.forEach((a, i) => {
      const p = applyMat(m, ...a.p)
      pts.push(p)
      smooth.push(a.smooth)
      const on = selected.has(refKey({ sub, i }))
      sel.push(on)
      if (!on) return
      for (const h of [a.in, a.out]) {
        if (!h) continue
        const q = applyMat(m, ...h)
        out.push({ kind: 'path', points: [p, q], closed: false, style: 'thin' })
        dots.push(q)
      }
    }),
  )
  out.push({ kind: 'dots', points: dots })
  out.push({ kind: 'anchors', points: pts, selected: sel, smooth })
  return out
}

/** The tools that show and edit paths' points. */
const VECTOR_TOOLS = new Set(['pen', 'curvature', 'direct'])

/** Paths shown while a drag changes them, not committed yet, by id. */
let overlayPaths: Map<NodeId, PathData> | null = null

/** Redraws the vector tools' overlay for the front document. */
function refreshVectorOverlay() {
  const d = documents().active()
  const tool = tools().get()
  const s = sessions().get()
  if (!d) return
  // Another tool's session (Free Transform, Crop) owns the overlay meanwhile.
  if (s && s.key === d.key && s.kind !== 'pen') return
  if (!VECTOR_TOOLS.has(tool)) {
    if (owned.has(d.key)) {
      owned.delete(d.key)
      clearToolOverlay(d.key)
    }
    return
  }
  const shapes: OverlayShape[] = []
  const doc = d.history.present
  const ts = targetsOf(d)
  const node = d.selected ? doc.nodes[d.selected] : null
  if (ts.length) {
    for (const t of ts) {
      const path = overlayPaths?.get(t.id) ?? t.path
      shapes.push(...outlineOf(path, t.transform))
      shapes.push(...anchorShapes(path, t.transform, new Set(anchorSelection.of({ ...t, path }).map(refKey))))
    }
  } else if (node?.kind === 'boolean') {
    const path = docPathOf((id) => doc.nodes[id], node)
    if (path) shapes.push(...outlineOf(path, [1, 0, 0, 1, 0, 0]))
  }
  if (penDraft && penDraft.key === d.key) {
    const draft: PathData = { fillRule: 'nonzero', subpaths: [{ closed: penDraft.closing, anchors: penDraft.anchors }] }
    shapes.push(...outlineOf(draft, penDraft.transform))
    const last = penDraft.anchors[penDraft.anchors.length - 1]
    if (penDraft.ghost) {
      // Smart and the Curvature tool: the curve as it will be with a point where the pointer is.
      const ghost: PathData = { fillRule: 'nonzero', subpaths: [{ closed: false, anchors: penDraft.ghost.slice(-3) }] }
      shapes.push(...outlineOf(ghost, penDraft.transform))
    } else if (last && penDraft.hover && !penDraft.closing) {
      // The rubber band: the next segment as it would be.
      const c1 = last.out ?? last.p
      const q = penDraft.hover
      const seg = [last.p[0], last.p[1], c1[0], c1[1], q[0], q[1], q[0], q[1]] as [number, number, number, number, number, number, number, number]
      const n = isLine(seg) ? 1 : linesFor(seg, docRadius(0.5))
      shapes.push({ kind: 'path', points: Array.from({ length: n + 1 }, (_, i) => applyMat(penDraft!.transform, ...evalCubic(seg, i / n))), closed: false, style: 'thin' })
    }
    const sel = new Set(penDraft.anchors.length ? [refKey({ sub: 0, i: penDraft.anchors.length - 1 })] : [])
    shapes.push(...anchorShapes(draft, penDraft.transform, sel))
  }
  if (marquee && marquee.key === d.key) {
    const [ax, ay] = marquee.a
    const [bx, by] = marquee.b
    shapes.push({ kind: 'path', points: [[ax, ay], [bx, ay], [bx, by], [ax, by]], closed: true, style: 'ants' })
  }
  owned.add(d.key)
  setToolOverlay(d.key, { shapes })
}
const owned = new Set<string>()

documents().subscribe(refreshVectorOverlay)
tools().subscribe(refreshVectorOverlay)
anchorSelection.subscribe(refreshVectorOverlay)
sessions().subscribe(refreshVectorOverlay)

// Leaving the Pen (or the Curvature tool) finishes the path it was drawing.
let drawingWith = tools().get()
tools().subscribe(() => {
  const s = sessions().get()
  const now = tools().get()
  if (s?.kind === 'pen' && now !== drawingWith) sessions().commit()
  drawingWith = now
})

// --- the Pen ------------------------------------------------------------------------------------

/**
 * A press with the Pen. On the target path: a press on a segment adds an
 * anchor there, on an anchor deletes it (Alt converts it), on an open
 * path's end carries the path on. Anywhere else it starts a new path: a
 * new shape, or a new outline in the vector mask being edited.
 */
function penPress(d: OpenDoc, p: Pointer): Gesture | null {
  const t = targetOf(d)
  if (t) {
    const q = toNode(t, p)
    const r = nodeRadius(t, GRAB)
    const a = hitAnchor(t.path, q[0], q[1], r)
    if (a) {
      const end = isEndpoint(t.path, a)
      if (end) {
        sessions().start(penSession(d, t, a.sub, end, shapeTools().get().smart ? 'smart' : 'pen'))
        return null
      }
      if (p.altKey) commitPath(t, convertAnchor(t.path, a), 'Convert Point')
      else {
        commitPath(t, deleteAnchors(t.path, [a]), 'Delete Anchor Point')
        anchorSelection.set(t, [])
      }
      return null
    }
    const seg = hitSegment(t.path, q[0], q[1], r)
    if (seg) {
      const next = insertAnchor(t.path, seg.sub, seg.seg, seg.t)
      commitPath(t, next, 'Add Anchor Point')
      anchorSelection.set(t, [{ sub: seg.sub, i: seg.seg + 1 }])
      return null
    }
  }
  const s = penSession(d, t?.mask ? t : null, -1, null, shapeTools().get().smart ? 'smart' : 'pen')
  sessions().start(s)
  return s.down(p)
}

/** How a drawing session places points: the Pen's by hand, the Pen's Smart mode, or the Curvature tool's. */
type DrawMode = 'pen' | 'smart' | 'curvature'

/**
 * Drawing a path. The Pen: each press adds an anchor, a drag pulls its
 * handles out (smooth, the one behind mirroring the one ahead; Alt breaks
 * them). Smart (Affinity's) and the Curvature tool: a click adds a smooth
 * point whose handles are worked out from its neighbours (geom/edit.ts
 * curvatureAnchor), Alt-click a corner; with Smart a drag still pulls the
 * handles out by hand, with the Curvature tool it moves the point. A press
 * on the first anchor closes the path and finishes it; Enter finishes an
 * open one; Esc throws it away.
 */
function penSession(d: OpenDoc, target: Target | null, sub: number, end: 'start' | 'end' | null, mode: DrawMode = 'pen'): Session {
  const key = d.key
  const base = d.history.present
  const transform: Affine = target ? target.transform : [1, 0, 0, 1, 0, 0]
  const inv = invertAffine(transform)
  // Carrying on from an end: its anchors, turned round when it was the start.
  let anchors: Anchor[] = []
  if (target && sub >= 0) {
    const s = end === 'start' ? reverseSubpath(target.path.subpaths[sub]) : target.path.subpaths[sub]
    anchors = s.anchors.map((a) => ({ ...a }))
  }
  // Which anchors get their handles from the curvature rule: the ones this session placed by a click.
  let auto: boolean[] = anchors.map(() => mode === 'curvature')
  const newId_ = target ? null : newId('n')
  let closed = false
  let hover: Pt | null = null

  /** The anchors with the auto ones' handles worked out, a point added at the end when given (the rubber band's). */
  const settled = (extra?: Pt): Anchor[] => {
    const list = extra ? [...anchors, { p: extra, in: null, out: null, smooth: true }] : anchors
    const marks = extra ? [...auto, true] : auto
    if (mode === 'pen') return list
    const s: Subpath = { closed: closed && !extra, anchors: list }
    return list.map((a, i) => (marks[i] ? curvatureAnchor(s, i) : a))
  }
  const pathNow = (): PathData => {
    const s = { closed, anchors: settled() }
    if (!target) return { fillRule: 'nonzero', subpaths: [s] }
    const subs = [...target.path.subpaths]
    if (sub >= 0) subs[sub] = s
    else subs.push(s)
    return { ...target.path, subpaths: subs }
  }
  const docNow = (): Doc => {
    if (anchors.length < 2 && !target) return base
    if (target) return withPath(base, target, pathNow())
    const { parent, index } = newLayerPlace(base, d.selected, anchors[0]?.p ?? null)
    return addVector(base, newId_!, freshName(base, 'Shape'), { kind: 'path', path: pathNow() }, newAppearance(base, false), parent, index)
  }
  const draft = () => {
    penDraft = { key, t: target, anchors: settled(), transform, hover, closing: closed, ghost: mode !== 'pen' && hover && !closed && anchors.length ? settled(hover) : null }
  }
  const show = () => {
    draft()
    preview(key, docNow())
    refreshVectorOverlay()
  }
  draft()

  const session: Session = {
    kind: 'pen',
    key,
    down(p) {
      const q = applyMat(inv, p.x, p.y)
      const r = docRadius(GRAB) / (Math.sqrt(Math.abs(transform[0] * transform[3] - transform[1] * transform[2])) || 1)
      const first = anchors[0]
      if (first && anchors.length >= 2 && Math.hypot(q[0] - first.p[0], q[1] - first.p[1]) <= r) {
        closed = true
        show()
        // A drag while closing pulls the first anchor's handles out (with the Pen and Smart).
        return {
          move(p2) {
            if (mode === 'curvature' || Math.hypot(p2.dx - p.dx, p2.dy - p.dy) < CLICK) return
            const h = applyMat(inv, p2.x, p2.y)
            anchors[0] = { ...first, out: [first.p[0] - (h[0] - first.p[0]), first.p[1] - (h[1] - first.p[1])], in: h, smooth: !p2.altKey }
            auto[0] = false
            show()
          },
          up() {
            sessions().commit()
          },
          cancel() {},
        }
      }
      // A new anchor snaps; its handles, pulled out by the drag, don't.
      const snap = startSnap(d)
      const sp = snapped(snap, p)
      snap.end()
      const smooth = mode !== 'pen' && !p.altKey
      anchors.push({ p: applyMat(inv, sp.x, sp.y), in: null, out: null, smooth })
      auto.push(mode !== 'pen')
      show()
      const i = anchors.length - 1
      return {
        move(p2) {
          if (Math.hypot(p2.dx - p.dx, p2.dy - p.dy) < CLICK) return
          const h = applyMat(inv, p2.x, p2.y)
          const a = anchors[i]
          if (mode === 'curvature') anchors[i] = { ...a, p: h }
          else {
            anchors[i] = { ...a, out: h, in: p2.altKey ? a.in : [a.p[0] - (h[0] - a.p[0]), a.p[1] - (h[1] - a.p[1])], smooth: !p2.altKey }
            auto[i] = false
          }
          show()
        },
        up() {},
        cancel() {},
      }
    },
    hover(p) {
      hover = applyMat(inv, p.x, p.y)
      draft()
      refreshVectorOverlay()
    },
    commit() {
      penDraft = null
      if (anchors.length < 2) {
        unpreview(key)
        refreshVectorOverlay()
        return
      }
      const next = docNow()
      documents().commit(() => next, { key, label: target ? (target.mask ? 'Edit Vector Mask' : 'Edit Path') : 'New Shape' })
      if (newId_) documents().select(newId_, key)
      refreshVectorOverlay()
    },
    cancel() {
      penDraft = null
      unpreview(key)
      refreshVectorOverlay()
    },
    readout() {
      if (!anchors.length) return mode === 'pen' ? 'Click to place the first point; drag to pull out its handles.' : 'Click to place smooth points, the curve running through them; Alt-click for a corner.'
      return `${anchors.length} point${anchors.length === 1 ? '' : 's'}: click the first point to close the path, Enter to finish it open, Esc to throw it away.`
    },
  }
  return session
}

// --- the Curvature tool ---------------------------------------------------------------------------

/** The last click on a point with the Curvature tool, for a double-click. */
let lastCurveClick: { id: NodeId; ref: string; at: number } | null = null
const DOUBLE_MS = 450

/**
 * A press with the Curvature tool. On the selected path: drag a point to
 * move it, the curve through its neighbours following; double-click a
 * point to make it a corner or smooth again; click a segment to add a
 * smooth point there (and drag it at once); click an open end to carry the
 * path on. Anywhere else it draws a new path of smooth points.
 */
function curvaturePress(d: OpenDoc, p: Pointer): Gesture | null {
  const t = targetOf(d)
  if (t) {
    const q = toNode(t, p)
    const r = nodeRadius(t, GRAB)
    const a = hitAnchor(t.path, q[0], q[1], r)
    if (a) {
      const k = refKey(a)
      const now = performance.now()
      if (lastCurveClick && lastCurveClick.id === t.id && lastCurveClick.ref === k && now - lastCurveClick.at < DOUBLE_MS) {
        lastCurveClick = null
        const s = t.path.subpaths[a.sub]
        const flipped: PathData = { ...t.path, subpaths: t.path.subpaths.map((x, i) => (i === a.sub ? { closed: s.closed, anchors: s.anchors.map((b, j) => (j === a.i ? { ...b, smooth: !b.smooth } : b)) } : x)) }
        commitPath(t, recurvePath(flipped, a.sub, [a.i]), 'Convert Point')
        anchorSelection.set(t, [a])
        return null
      }
      anchorSelection.set(t, [a])
      return pointDrag(d, t, t.path, a, p, () => {
        lastCurveClick = { id: t.id, ref: k, at: performance.now() }
        const end = isEndpoint(t.path, a)
        if (end) sessions().start(penSession(d, t, a.sub, end, 'curvature'))
      })
    }
    const seg = hitSegment(t.path, q[0], q[1], r)
    if (seg) {
      // A smooth point there, the curve through it worked out again, and it can be dragged at once.
      const added = insertAnchor(t.path, seg.sub, seg.seg, seg.t)
      const ref = { sub: seg.sub, i: seg.seg + 1 }
      const s = added.subpaths[seg.sub]
      const smooth: PathData = { ...added, subpaths: added.subpaths.map((x, i) => (i === seg.sub ? { closed: s.closed, anchors: s.anchors.map((b, j) => (j === ref.i ? { ...b, smooth: true } : b)) } : x)) }
      const path = recurvePath(smooth, ref.sub, [ref.i])
      anchorSelection.set(t, [ref])
      return pointDrag(d, t, path, ref, p, null, 'Add Anchor Point')
    }
  }
  const s = penSession(d, t?.mask ? t : null, -1, null, 'curvature')
  sessions().start(s)
  return s.down(p)
}

/**
 * The Curvature tool dragging one point of \`path\` (the target's, or one
 * with a point just added): the curve through its neighbours follows.
 * Committed on release as one step; a click that doesn't move commits
 * \`path\` if it's new and calls \`clicked\`.
 */
function pointDrag(d: OpenDoc, t: Target, path: PathData, ref: AnchorRef, p0: Pointer, clicked: (() => void) | null, label = 'Edit Path'): Gesture {
  const base = d.history.present
  const at = path.subpaths[ref.sub].anchors[ref.i].p
  const snap = startSnap(d, { skip: [applyMat(t.transform, ...at)] })
  let moved: PathData | null = null
  const changed = path !== t.path
  if (changed) {
    preview(d.key, withPath(base, t, path))
    refreshVectorOverlayWith(t, path)
  }
  const done = () => {
    snap.end()
    overlayPaths = null
  }
  return {
    move(raw) {
      if (!moved && Math.hypot(raw.dx - p0.dx, raw.dy - p0.dy) < CLICK) return
      const g = applyMat(t.transform, ...at)
      const [sx, sy] = snap.point(g[0] + raw.x - p0.x, g[1] + raw.y - p0.y, raw)
      const q = toNode(t, { x: sx, y: sy })
      moved = recurvePath(moveAnchors(path, [ref], q[0] - at[0], q[1] - at[1]), ref.sub, [ref.i])
      preview(d.key, withPath(base, t, moved))
      refreshVectorOverlayWith(t, moved)
    },
    up() {
      done()
      if (moved) commitPath(t, moved, label)
      else if (changed) commitPath(t, path, label)
      else unpreview(d.key)
      refreshVectorOverlay()
      if (!moved && clicked) clicked()
    },
    cancel() {
      done()
      unpreview(d.key)
      refreshVectorOverlay()
    },
  }
}

// --- Direct Selection ---------------------------------------------------------------------------

/**
 * A press with Direct Selection: on a handle of a selected anchor, drags
 * it; on an anchor, selects it (Shift adds, Alt converts it) and drags the
 * selected anchors; on a segment, selects its ends and drags them; on
 * another shape, selects that shape; anywhere else, drags out a box that
 * selects the anchors in it.
 */
function directPress(d: OpenDoc, p: Pointer): Gesture | null {
  const ts = targetsOf(d)
  const all = anchorSelection.key === d.key ? anchorSelection.all() : new Map<NodeId, AnchorRef[]>()
  const same = (x: AnchorRef, a: AnchorRef) => x.sub === a.sub && x.i === a.i
  // A handle of a selected point, on any path being edited (the key layer's first).
  for (const t of ts) {
    const q = toNode(t, p)
    const h = hitHandle(t.path, anchorSelection.of(t), q[0], q[1], nodeRadius(t, GRAB))
    if (h) return dragGesture(t, p, (path, dq, p2) => moveHandle(path, h.ref, h.which, q[0] + dq[0], q[1] + dq[1], p2.altKey))
  }
  for (const t of ts) {
    const q = toNode(t, p)
    const a = hitAnchor(t.path, q[0], q[1], nodeRadius(t, GRAB))
    if (!a) continue
    if (p.altKey) {
      commitPath(t, convertAnchor(t.path, a), 'Convert Point')
      anchorSelection.set(t, [a])
      return null
    }
    const sel = all.get(t.id) ?? []
    const on = sel.some((x) => same(x, a))
    const next = new Map(p.shiftKey || on ? all : [])
    if (p.shiftKey) next.set(t.id, on ? sel.filter((x) => !same(x, a)) : [...sel, a])
    else if (!on) next.set(t.id, [a])
    anchorSelection.setMany(d.key, next)
    if (p.shiftKey && on) return null
    return anchorsGesture(d, ts, p, applyMat(t.transform, ...t.path.subpaths[a.sub].anchors[a.i].p))
  }
  for (const t of ts) {
    const q = toNode(t, p)
    const seg = hitSegment(t.path, q[0], q[1], nodeRadius(t, GRAB))
    if (!seg) continue
    const s = t.path.subpaths[seg.sub]
    const ends = [{ sub: seg.sub, i: seg.seg }, { sub: seg.sub, i: (seg.seg + 1) % s.anchors.length }]
    const next = new Map(p.shiftKey ? all : [])
    next.set(t.id, [...(p.shiftKey ? (all.get(t.id) ?? []) : []), ...ends])
    anchorSelection.setMany(d.key, next)
    return anchorsGesture(d, ts, p, null)
  }
  // Another shape under the pointer: it becomes the selected layer (Shift: one more of them).
  const hit = shapeAt(d, p)
  if (hit && !ts.some((t) => t.id === hit)) {
    if (p.shiftKey) documents().toggleSelected(hit, d.key)
    else {
      documents().select(hit, d.key)
      anchorSelection.set(null, [])
    }
    return null
  }
  // A box that selects the points in it, on every shape it reaches (or only the vector mask being edited).
  const start: Pt = [p.x, p.y]
  const keep = p.shiftKey ? all : new Map<NodeId, AnchorRef[]>()
  if (!p.shiftKey) anchorSelection.setMany(d.key, new Map())
  const maskOnly = ts.length === 1 && ts[0].mask ? ts[0] : null
  return {
    move(p2) {
      marquee = { key: d.key, a: start, b: [p2.x, p2.y] }
      refreshVectorOverlay()
    },
    up(p2) {
      marquee = null
      if (Math.hypot(p2.x - start[0], p2.y - start[1]) > docRadius(CLICK)) {
        const box = [Math.min(start[0], p2.x), Math.min(start[1], p2.y), Math.max(start[0], p2.x), Math.max(start[1], p2.y)]
        const now = documents().get(d.key)!
        const candidates = maskOnly ? [maskOnly] : reachableShapes(now.history.present).map((id) => targetFor(now, id)!)
        const next = new Map(keep)
        for (const t of candidates) {
          const found: AnchorRef[] = []
          t.path.subpaths.forEach((s, sub) =>
            s.anchors.forEach((a, i) => {
              const [x, y] = applyMat(t.transform, ...a.p)
              if (x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]) found.push({ sub, i })
            }),
          )
          if (!found.length) continue
          const had = next.get(t.id) ?? []
          next.set(t.id, [...new Map([...had, ...found].map((r) => [refKey(r), r])).values()])
        }
        // The shapes with points in the box become the selected layers, the key layer kept when it's one of them.
        if (!maskOnly) {
          const ids = [...next.keys()]
          if (ids.length) documents().selectMany(ids, ids.includes(now.selected ?? '') ? now.selected! : ids[0], d.key)
        }
        anchorSelection.setMany(d.key, next)
      }
      refreshVectorOverlay()
    },
    cancel() {
      marquee = null
      refreshVectorOverlay()
    },
  }
}

/**
 * A drag of every selected point, on every path being edited, by how far
 * the pointer goes (into each path's own coordinates): one step. `grab`,
 * the point pressed on, snaps, and the others go with it.
 */
function anchorsGesture(d: OpenDoc, ts: Target[], p0: Pointer, grab: Pt | null): Gesture {
  const base = d.history.present
  const moving = ts.map((t) => ({ t, refs: anchorSelection.of(t) })).filter((m) => m.refs.length)
  const skip = moving.flatMap(({ t, refs }) => refs.map((r) => applyMat(t.transform, ...t.path.subpaths[r.sub].anchors[r.i].p)))
  const snap = grab ? startSnap(d, { skip }) : null
  let paths: Map<NodeId, PathData> | null = null
  const end = () => {
    snap?.end()
    overlayPaths = null
  }
  const docWith = (x: Doc, ps: Map<NodeId, PathData>) => moving.reduce((y, { t }) => withPath(y, t, ps.get(t.id)!), x)
  return {
    move(raw) {
      if (!paths && Math.hypot(raw.dx - p0.dx, raw.dy - p0.dy) < CLICK) return
      let dx = raw.x - p0.x
      let dy = raw.y - p0.y
      if (snap && grab) {
        const [sx, sy] = snap.point(grab[0] + dx, grab[1] + dy, raw)
        dx = sx - grab[0]
        dy = sy - grab[1]
      }
      paths = new Map(
        moving.map(({ t, refs }) => {
          // The move in the path's own coordinates: the document's, through its transform's inverse (no translation).
          const m = invertAffine(t.transform)
          return [t.id, moveAnchors(t.path, refs, m[0] * dx + m[2] * dy, m[1] * dx + m[3] * dy)]
        }),
      )
      preview(d.key, docWith(base, paths))
      overlayPaths = paths
      refreshVectorOverlay()
    },
    up() {
      end()
      const ps = paths
      if (ps) {
        const label = moving.some(({ t }) => t.mask) ? 'Edit Vector Mask' : moving.length > 1 ? 'Edit Paths' : 'Edit Path'
        documents().commit((x) => docWith(x, ps), { key: d.key, label })
      } else unpreview(d.key)
      refreshVectorOverlay()
    },
    cancel() {
      end()
      unpreview(d.key)
      refreshVectorOverlay()
    },
  }
}

/** A drag that changes the target's path from where it was by how far the pointer has gone (in the path's coordinates). */
function dragGesture(t: Target, p0: Pointer, change: (path: PathData, dq: Pt, p: Pointer) => PathData, o: { grab?: Pt; skip?: Pt[] } = {}): Gesture {
  const d = documents().get(t.key)!
  const base = d.history.present
  const inv = invertAffine(t.transform)
  const q0 = applyMat(inv, p0.x, p0.y)
  let path: PathData | null = null
  // Dragging anchors, the one grabbed snaps (and the others go with it); the selected ones aren't targets.
  const snap = o.grab ? startSnap(d, { skip: o.skip }) : null
  const end = () => snap?.end()
  return {
    move(raw) {
      if (!path && Math.hypot(raw.dx - p0.dx, raw.dy - p0.dy) < CLICK) return
      let p = raw
      if (snap && o.grab) {
        const gx = o.grab[0] + raw.x - p0.x
        const gy = o.grab[1] + raw.y - p0.y
        const [sx, sy] = snap.point(gx, gy, raw)
        p = { ...raw, x: raw.x + sx - gx, y: raw.y + sy - gy }
      }
      const q = applyMat(inv, p.x, p.y)
      path = change(t.path, [q[0] - q0[0], q[1] - q0[1]], p)
      preview(t.key, withPath(base, t, path))
      refreshVectorOverlayWith(t, path)
    },
    up() {
      end()
      overlayPaths = null
      if (path) commitPath(t, path, 'Edit Path')
      else unpreview(t.key)
      refreshVectorOverlay()
    },
    cancel() {
      end()
      overlayPaths = null
      unpreview(t.key)
      refreshVectorOverlay()
    },
  }
}

/** The overlay while a drag shows a path that isn't committed yet. */
function refreshVectorOverlayWith(t: Target, path: PathData) {
  overlayPaths = new Map([[t.id, path]])
  refreshVectorOverlay()
}

/** The topmost shape under a point: inside a filled one, or on a stroked one's outline. */
function shapeAt(d: OpenDoc, p: Pointer): NodeId | null {
  const doc = d.history.present
  for (const { node } of layerRows(doc)) {
    if (!node.visible || (node.kind !== 'vector' && node.kind !== 'boolean')) continue
    const place = placeOf(doc, node.id)
    if (place && doc.nodes[place.parent]?.kind === 'boolean') continue
    if (shapeHit(doc, node, p.x, p.y, docRadius(GRAB))) return node.id
  }
  return null
}

/** Delete with anchors selected: they go. Returns whether it did anything. */
export function deleteSelectedAnchors(): boolean {
  const d = documents().active()
  const tool = tools().get()
  if (!d || !VECTOR_TOOLS.has(tool)) return false
  const moving = targetsOf(d).map((t) => ({ t, refs: anchorSelection.of(t) })).filter((m) => m.refs.length)
  if (!moving.length) return false
  const n = moving.reduce((k, m) => k + m.refs.length, 0)
  documents().commit((x) => moving.reduce((y, { t, refs }) => withPath(y, t, deleteAnchors(t.path, refs)), x), { key: d.key, label: moving.some((m) => m.t.mask) ? 'Edit Vector Mask' : n === 1 ? 'Delete Anchor Point' : 'Delete Anchor Points' })
  anchorSelection.setMany(d.key, new Map())
  return true
}

// --- the Shape tool -----------------------------------------------------------------------------

/**
 * A drag with the Shape tool: a live shape from corner to corner. Shift
 * keeps it square (a line at 45° steps); Alt draws it from the middle out.
 * With a vector mask being edited, the shape's outline goes into the mask.
 */
function shapePress(d: OpenDoc, raw0: Pointer): Gesture {
  // Both corners snap (Ctrl lets go).
  const snap = startSnap(d)
  const p0 = snapped(snap, raw0)
  const key = d.key
  const base = d.history.present
  const s = shapeTools().get()
  const t = targetOf(d)
  const intoMask = t?.mask ? t : null
  const id = newId('n')
  let geometry: Geometry | null = null
  const build = (p: Pointer): Geometry => {
    let x0 = p0.x
    let y0 = p0.y
    let x1 = p.x
    let y1 = p.y
    if (s.type === 'line') {
      if (p.shiftKey) {
        const a = Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 4)) * (Math.PI / 4)
        const l = Math.hypot(x1 - x0, y1 - y0)
        x1 = x0 + Math.cos(a) * l
        y1 = y0 + Math.sin(a) * l
      }
      if (p.altKey) {
        x0 = 2 * p0.x - x1
        y0 = 2 * p0.y - y1
      }
    } else {
      if (p.shiftKey) {
        const side = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
        x1 = x0 + Math.sign(x1 - x0 || 1) * side
        y1 = y0 + Math.sign(y1 - y0 || 1) * side
      }
      if (p.altKey) {
        x0 = 2 * p0.x - x1
        y0 = 2 * p0.y - y1
      }
    }
    return { kind: 'shape', shape: shapeInBox(s.type, x0, y0, x1, y1, { radius: s.radius, corner: s.corner, sides: s.sides, points: s.points, inner: s.inner }) }
  }
  const docWith = (g: Geometry): Doc => {
    if (intoMask) {
      // Into the mask: the shape's outline, in the mask's coordinates, added to its path.
      const add = transformPath(shapePath(g.kind === 'shape' ? g.shape : shapeInBox('rect', 0, 0, 0, 0)), invertAffine(intoMask.transform))
      return withPath(base, intoMask, { ...intoMask.path, subpaths: [...intoMask.path.subpaths, ...add.subpaths] })
    }
    const box = g.kind === 'shape' ? shapeBox(g.shape) : null
    const { parent, index } = newLayerPlace(base, d.selected, box ? [box[0] + box[2] / 2, box[1] + box[3] / 2] : null)
    const label = s.type === 'rect' ? 'Rectangle' : s.type === 'ellipse' ? 'Ellipse' : s.type === 'polygon' ? 'Polygon' : s.type === 'star' ? 'Star' : 'Line'
    return addVector(base, id, freshName(base, label), g, newAppearance(base, s.type === 'line'), parent, index)
  }
  return {
    move(raw) {
      if (!geometry && Math.hypot(raw.dx - raw0.dx, raw.dy - raw0.dy) < CLICK) return
      geometry = build(snapped(snap, raw))
      preview(key, docWith(geometry))
    },
    up() {
      snap.end()
      if (!geometry) {
        unpreview(key)
        return
      }
      const next = docWith(geometry)
      documents().commit(() => next, { key, label: intoMask ? 'Edit Vector Mask' : 'New Shape' })
      if (!intoMask) documents().select(id, key)
    },
    cancel() {
      snap.end()
      unpreview(key)
    },
  }
}

// --- the Layer menu's shape commands --------------------------------------------------------

const OP_LABEL: Record<BoolOp, string> = { add: 'Unite Shapes', subtract: 'Subtract Front Shape', intersect: 'Intersect Shapes', exclude: 'Exclude Overlapping Shapes' }

/** Whether the selected layer is a shape with a shape directly below it, so they can be combined. */
export function canCombine(d: OpenDoc | null): boolean {
  if (!d?.selected) return false
  const doc = d.history.present
  const n = doc.nodes[d.selected]
  const place = placeOf(doc, d.selected)
  if (!n || (n.kind !== 'vector' && n.kind !== 'boolean') || !place || place.slot !== 'children' || place.index === 0) return false
  if (doc.nodes[place.parent].kind === 'boolean') return false
  const below = doc.nodes[doc.nodes[place.parent].children![place.index - 1]]
  return below?.kind === 'vector' || below?.kind === 'boolean'
}

export function combineShapes(op: BoolOp) {
  const d = documents().active()
  if (!d?.selected || !canCombine(d)) return notify('info', 'Combining needs a shape selected with another shape (or compound shape) right below it in the Layers panel.')
  const doc = d.history.present
  const place = placeOf(doc, d.selected)!
  const below = doc.nodes[doc.nodes[place.parent].children![place.index - 1]]
  const cid = below.kind === 'boolean' ? below.id : newId('n')
  documents().commit((x) => combineWithBelow(x, d.selected!, op, cid), { key: d.key, label: OP_LABEL[op] })
  documents().select(cid, d.key)
}

const selectedNode = (d: OpenDoc | null): DocNode | null => (d?.selected ? (d.history.present.nodes[d.selected] ?? null) : null)

export const isCompound = (d: OpenDoc | null) => selectedNode(d)?.kind === 'boolean'
export const isLiveShape = (d: OpenDoc | null) => {
  const n = selectedNode(d)
  return n?.kind === 'vector' && n.props.geometry?.kind === 'shape'
}

/** Release Compound Shape: its shapes back among the layers, each as it was. */
export function releaseSelectedCompound() {
  const d = documents().active()
  const n = selectedNode(d)
  if (!d || n?.kind !== 'boolean') return
  const first = n.children?.[n.children.length - 1] ?? null
  documents().commit((x) => releaseCompound(x, n.id), { key: d.key, label: 'Release Compound Shape' })
  documents().select(first, d.key)
}

/** Expand Compound Shape: one path with the combined outline, the compound's appearance kept. */
export function expandSelectedCompound() {
  const d = documents().active()
  const n = selectedNode(d)
  if (!d || n?.kind !== 'boolean') return
  const doc = d.history.present
  const path = docPathOf((id) => doc.nodes[id], n)
  if (!path) return
  documents().commit((x) => expandCompound(x, n.id, path), { key: d.key, label: 'Expand Compound Shape' })
}

/** Convert to Path: a live shape's outline as a path, which its anchors can then edit. */
export function convertSelectedToPath() {
  const d = documents().active()
  const n = selectedNode(d)
  if (!d || n?.kind !== 'vector' || n.props.geometry?.kind !== 'shape') return
  const path = geometryPath(n.props.geometry)
  documents().commit((x) => setGeometry(x, n.id, { kind: 'path', path }), { key: d.key, label: 'Convert to Path' })
}

/** Layer → Vector Mask: an empty vector mask that shows everything (or hides it) until it has an outline. */
export function addVectorMaskTo(kind: 'reveal-all' | 'hide-all') {
  const d = documents().active()
  const n = selectedNode(d)
  if (!d || !n) return
  const doc = d.history.present
  if (vectorMaskOf(doc, n)) return notify('info', `“${n.name}” already has a vector mask.`)
  const id = newId('m')
  const next = addVectorMask(doc, n.id, id, kind === 'reveal-all' ? 1 : 0)
  if (next === doc) return notify('info', 'A vector mask goes on a layer.')
  documents().commit(() => next, { key: d.key, label: 'Add Vector Mask' })
  documents().select(n.id, d.key, 'vector')
  tools().set('pen')
}

/** The anchors of the target that are selected, for the options bar and the checks. */
export function selectedAnchorCount(): number {
  const d = documents().active()
  return d ? targetsOf(d).reduce((n, t) => n + anchorSelection.of(t).length, 0) : 0
}

// The selected points belong to the paths being edited: a layer no longer selected lets its points go.
documents().subscribe(() => {
  const d = documents().active()
  if (!anchorSelection.key) return
  if (!d || d.key !== anchorSelection.key) return anchorSelection.set(null, [])
  anchorSelection.keepOnly(new Set(targetsOf(d).map((t) => t.id)))
})

// --- joining and breaking ------------------------------------------------------------------

/** Within this many document pixels, two ends being joined are one point. */
const SAME_POINT = 0.5

/**
 * Path → Join. Two end points selected (of one shape or two): joined by a
 * straight segment, or made one point where they meet; the second shape's
 * path goes into the first's, and the second goes if nothing's left of it.
 * No points selected: with several shapes selected, their paths go into
 * the key layer's and its open ones are joined end to end, nearest first;
 * with one, its nearest open ends (Object → Path → Join as before).
 */
export function joinPaths(fallback: () => void) {
  const d = documents().active()
  if (!d) return
  const ts = targetsOf(d)
  const ends = ts.flatMap((t) => anchorSelection.of(t).map((r) => ({ t, r, end: isEndpoint(t.path, r) })))
  if (ends.length) {
    const open = ends.filter((e) => e.end)
    if (open.length !== 2 || ends.length !== 2) return notify('info', 'Join takes two end points of open paths. Select just those two with Direct Selection (Shift adds), or select whole shapes and no points.')
    const [a, b] = open
    const pa = applyMat(a.t.transform, ...a.t.path.subpaths[a.r.sub].anchors[a.r.i].p)
    const pb = applyMat(b.t.transform, ...b.t.path.subpaths[b.r.sub].anchors[b.r.i].p)
    const merge = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) <= SAME_POINT
    const label = a.t.mask ? 'Edit Vector Mask' : 'Join'
    if (a.t.id === b.t.id) {
      const path = a.t.path
      const next: PathData =
        a.r.sub === b.r.sub
          ? { ...path, subpaths: path.subpaths.map((s, i) => (i === a.r.sub ? closeSubpath(s, merge) : s)) }
          : { ...path, subpaths: [...path.subpaths.filter((_, i) => i !== a.r.sub && i !== b.r.sub), joinSubpaths(path.subpaths[a.r.sub], a.end!, path.subpaths[b.r.sub], b.end!, merge)] }
      commitPath(a.t, next, label)
    } else {
      // The second path in the first's coordinates.
      const into = transformPath({ fillRule: 'nonzero', subpaths: [b.t.path.subpaths[b.r.sub]] }, compose(invertAffine(a.t.transform), b.t.transform)).subpaths[0]
      const joined = joinSubpaths(a.t.path.subpaths[a.r.sub], a.end!, into, b.end!, merge)
      const next: PathData = { ...a.t.path, subpaths: [...a.t.path.subpaths.filter((_, i) => i !== a.r.sub), joined] }
      const rest = b.t.path.subpaths.filter((_, i) => i !== b.r.sub)
      documents().commit(
        (x) => {
          const y = withPath(x, a.t, next)
          return rest.length ? withPath(y, b.t, { ...b.t.path, subpaths: rest }) : removeNode(y, b.t.id)
        },
        { key: d.key, label },
      )
      documents().select(a.t.id, d.key)
    }
    anchorSelection.setMany(d.key, new Map())
    return
  }
  if (ts.length < 2) return fallback()
  // Several shapes: one path in the key layer's coordinates, its open subpaths joined end to end.
  const [key, ...others] = ts
  let path: PathData = { ...key.path, subpaths: [...key.path.subpaths, ...others.flatMap((t) => transformPath(t.path, compose(invertAffine(key.transform), t.transform)).subpaths)] }
  for (let open = path.subpaths.filter((s) => !s.closed).length; open > 1; open--) path = joinPath(path)
  documents().commit((x) => others.reduce((y, t) => removeNode(y, t.id), withPath(x, key, path)), { key: d.key, label: 'Join' })
  documents().select(key.id, d.key)
}

/** Path → Break at Points: the paths cut at the selected points; a closed one opens there. */
export function breakAtPoints() {
  const d = documents().active()
  if (!d) return
  const cuts = targetsOf(d)
    .map((t) => ({ t, refs: anchorSelection.of(t) }))
    .filter((c) => c.refs.length)
  if (!cuts.length) return notify('info', 'Select the points to break the paths at, with Direct Selection.')
  const changed = cuts.map(({ t, refs }) => ({ t, path: breakAt(t.path, refs) })).filter((c) => c.path.subpaths.length !== c.t.path.subpaths.length || c.path.subpaths.some((s, i) => s !== c.t.path.subpaths[i]))
  if (!changed.length) return notify('info', 'An open path’s end is already an end: select a point along a path, or any point of a closed one.')
  documents().commit((x) => changed.reduce((y, c) => withPath(y, c.t, c.path), x), { key: d.key, label: cuts.some((c) => c.t.mask) ? 'Edit Vector Mask' : 'Break at Points' })
  anchorSelection.setMany(d.key, new Map())
}

/** Path → Separate: each subpath of the selected shapes a shape of its own, with the same look, just above it. */
export function separatePaths() {
  const d = documents().active()
  if (!d) return
  const ts = targetsOf(d).filter((t) => !t.mask && t.path.subpaths.length > 1)
  if (!ts.length) return notify('info', 'Separate makes each part of a shape a shape of its own: select a shape with more than one part (a compound path).')
  const made: NodeId[] = []
  documents().commit(
    (x) => {
      let y = x
      for (const t of ts) {
        const node = y.nodes[t.id]
        const place = placeOf(y, t.id)
        if (node?.kind !== 'vector' || !place) continue
        const parts = separate(t.path)
        y = withPath(y, t, parts[0])
        parts.slice(1).forEach((part, k) => {
          const id = newId('n')
          made.push(id)
          // The look comes along; masks and effects stay with the first part.
          const copy = { ...node, id, name: `${node.name} ${k + 2}`, masks: [], effects: [], props: { ...node.props, geometry: { kind: 'path', path: part } } } as DocNode
          y = insertNode(y, copy, place.parent, place.index + 1 + k)
        })
      }
      return y
    },
    { key: d.key, label: 'Separate' },
  )
  documents().selectMany([...ts.map((t) => t.id), ...made], ts[0].id, d.key)
}

// --- edits from the Properties panel ------------------------------------------------------

/** A shape's or compound's fills and strokes changed; a drag of one control is one step (its `coalesce` key). */
export function setShapeAppearance(id: NodeId, appearance: AppearanceItem[], coalesce?: string) {
  const d = documents().active()
  if (d) documents().commit((x) => setAppearance(x, id, appearance), { key: d.key, label: 'Appearance', coalesce })
}

/** A live shape's settings or a path's fill rule changed. */
export function setShapeGeometry(id: NodeId, geometry: Geometry, coalesce?: string) {
  const d = documents().active()
  if (d) documents().commit((x) => setGeometry(x, id, geometry), { key: d.key, label: geometry.kind === 'shape' ? 'Edit Shape' : 'Edit Path', coalesce })
}

/** How an operand of a compound shape combines with the ones below it. */
export function setOperandOp(compound: NodeId, child: NodeId, op: BoolOp) {
  const d = documents().active()
  if (d) documents().commit((x) => setBoolOp(x, compound, child, op), { key: d.key, label: 'Combine Mode' })
}

registerTool('pen', penPress)
registerTool('curvature', curvaturePress)
registerTool('direct', directPress)
registerTool('shape', shapePress)

/** For the checks: the segments of a path, as the overlay draws them. */
export const segmentCount = (path: PathData) => path.subpaths.reduce((n, s) => n + segmentsOf(s).length, 0)

// --- the clipboard ----------------------------------------------------------------------------

/**
 * Copy with the Pen or Direct Selection and anchors selected: the paths
 * they're on, whole, in document pixels. Cut takes those paths out.
 */
setPathSource(() => {
  const d = documents().active()
  const tool = tools().get()
  if (!d || !VECTOR_TOOLS.has(tool)) return null
  const t = targetOf(d)
  const sel = anchorSelection.of(t)
  if (!t || !sel.length) return null
  const subs = [...new Set(sel.map((r) => r.sub))].sort((a, b) => a - b)
  const path = transformPath({ ...t.path, subpaths: subs.map((i) => t.path.subpaths[i]) }, t.transform)
  return {
    path,
    cut: () => {
      const all = subs.flatMap((sub) => t.path.subpaths[sub].anchors.map((_, i) => ({ sub, i })))
      commitPath(t, deleteAnchors(t.path, all), 'Cut Path')
      anchorSelection.set(t, [])
    },
  }
})

/**
 * Paste of a copied path: with the Pen or Direct Selection on a shape (or
 * a vector mask), into its path, in place, its anchors selected; otherwise
 * as a new shape in the shape tools' colours.
 */
setPathSink((path) => {
  const d = documents().active()
  if (!d) return
  const tool = tools().get()
  const t = VECTOR_TOOLS.has(tool) ? targetOf(d) : null
  if (t) {
    const add = transformPath(path, invertAffine(t.transform))
    const next: PathData = { ...t.path, subpaths: [...t.path.subpaths, ...add.subpaths] }
    commitPath(t, next, 'Paste Path')
    anchorSelection.set(
      targetOf(documents().get(d.key)!),
      add.subpaths.flatMap((s, k) => s.anchors.map((_, i) => ({ sub: t.path.subpaths.length + k, i }))),
    )
    refreshVectorOverlay()
    return
  }
  const doc = d.history.present
  const id = newId('n')
  const { parent, index } = newLayerPlace(doc, d.selected)
  documents().commit((x) => addVector(x, id, freshName(x, 'Shape'), { kind: 'path', path }, newAppearance(x, false), parent, index), { key: d.key, label: 'Paste Path' })
  documents().select(id, d.key)
})
