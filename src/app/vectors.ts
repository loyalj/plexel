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
import { addVector, addVectorMask, combineWithBelow, expandCompound, invertAffine, releaseCompound, setAppearance, setBoolOp, setGeometry } from '../doc/edit'
import { freshName, placeOf, layerRows } from '../doc/tree'
import type { Affine, BoolOp, Doc, DocNode, NodeId } from '../doc/types'
import { fillItem, geometryPath, solid, strokeItem, type AppearanceItem, type Geometry } from '../doc/vector'
import { anchorsIn, convertAnchor, deleteAnchors, hitAnchor, hitHandle, hitSegment, insertAnchor, isEndpoint, moveAnchors, moveHandle, parseRef, refKey, type AnchorRef } from '../geom/edit'
import { applyMat, evalCubic, flattenPath, isLine, linesFor, reverseSubpath, segmentsOf, transformPath, type Anchor, type PathData, type Pt } from '../geom/path'
import { shapeInBox, shapePath, type CornerStyle, type ShapeType } from '../geom/shapes'
import { engine } from '../engine/EngineHost'
import type { OverlayShape } from '../render/overlay'
import { viewMatrix } from '../render/view'
import { tools } from '../tools'
import { docPathOf } from '../vector/shape'
import { swatchIn } from './colour'
import { clearToolOverlay, registerTool, sessions, setToolOverlay, snapped, type Gesture, type Pointer, type Session } from './canvasTools'
import { startSnap } from './snapping'
import { documents, newId, type OpenDoc } from './documents'
import { notify } from './notices'
import { setPathSink, setPathSource } from './clipboard'
import { vectorMaskOf } from './selection'
import { shapeHit } from './pick'
import { views } from './views'

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
}

const KEY = 'plexel.shapeTools.v1'
const TYPES: ShapeType[] = ['rect', 'ellipse', 'polygon', 'star', 'line']
const CORNERS: CornerStyle[] = ['round', 'chamfer', 'inset']

export const defaultShapeTools = (): ShapeToolState => ({ type: 'rect', radius: 0, corner: 'round', sides: 6, points: 5, inner: 0.5, fill: true, stroke: false, strokeWidth: 4 })

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

export function readShapeTools(raw: unknown): ShapeToolState {
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
  }
}

class ShapeToolStore {
  private state: ShapeToolState
  private listeners = new Set<() => void>()
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
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  update(patch: Partial<ShapeToolState>) {
    this.state = readShapeTools({ ...this.state, ...patch })
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state))
    } catch {
      // Not remembered; still used.
    }
    for (const fn of this.listeners) fn()
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

export function targetOf(d: OpenDoc): Target | null {
  const doc = d.history.present
  const node = d.selected ? doc.nodes[d.selected] : null
  if (!node) return null
  if (d.maskTarget === 'vector') {
    const m = vectorMaskOf(doc, node)
    if (!m) return null
    return { key: d.key, id: m.id, mask: true, path: geometryPath(m.props.geometry), transform: m.transform, live: m.props.geometry?.kind === 'shape' }
  }
  if (node.kind !== 'vector') return null
  return { key: d.key, id: node.id, mask: false, path: geometryPath(node.props.geometry), transform: node.transform, live: node.props.geometry?.kind === 'shape' }
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

class AnchorSelection {
  key: string | null = null
  id: NodeId | null = null
  refs = new Set<string>()
  private listeners = new Set<() => void>()
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  of(t: Target | null): AnchorRef[] {
    if (!t || t.key !== this.key || t.id !== this.id) return []
    return [...this.refs].map(parseRef).filter((r) => !!t.path.subpaths[r.sub]?.anchors[r.i])
  }
  set(t: Target | null, refs: AnchorRef[]) {
    this.key = t?.key ?? null
    this.id = t?.id ?? null
    this.refs = new Set(refs.map(refKey))
    for (const fn of this.listeners) fn()
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

/** Where a new layer goes: above the selected one, in its group; otherwise at the top. */
function newLayerPlace(doc: Doc, selected: NodeId | null): { parent: NodeId; index: number } {
  const place = selected ? placeOf(doc, selected) : null
  if (place?.slot === 'children' && doc.nodes[place.parent].kind !== 'boolean') return { parent: place.parent, index: place.index + 1 }
  return { parent: doc.root, index: doc.nodes[doc.root].children?.length ?? 0 }
}

// --- the overlay -------------------------------------------------------------------------------

/** The Pen's path being drawn, for the overlay. */
let penDraft: { key: string; t: Target | null; anchors: Anchor[]; transform: Affine; hover: Pt | null; closing: boolean } | null = null
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
  const dots: [number, number][] = []
  path.subpaths.forEach((s, sub) =>
    s.anchors.forEach((a, i) => {
      const p = applyMat(m, ...a.p)
      pts.push(p)
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
  out.push({ kind: 'anchors', points: pts, selected: sel })
  return out
}

/** Redraws the vector tools' overlay for the front document. */
export function refreshVectorOverlay() {
  const d = documents().active()
  const tool = tools().get()
  const s = sessions().get()
  if (!d) return
  // Another tool's session (Free Transform, Crop) owns the overlay meanwhile.
  if (s && s.key === d.key && s.kind !== 'pen') return
  if (tool !== 'pen' && tool !== 'direct') {
    if (owned.has(d.key)) {
      owned.delete(d.key)
      clearToolOverlay(d.key)
    }
    return
  }
  const shapes: OverlayShape[] = []
  const doc = d.history.present
  const t = targetOf(d)
  const node = d.selected ? doc.nodes[d.selected] : null
  if (t) {
    shapes.push(...outlineOf(t.path, t.transform))
    if (tool === 'direct' || tool === 'pen') shapes.push(...anchorShapes(t.path, t.transform, new Set(anchorSelection.of(t).map(refKey))))
  } else if (node?.kind === 'boolean') {
    const path = docPathOf((id) => doc.nodes[id], node)
    if (path) shapes.push(...outlineOf(path, [1, 0, 0, 1, 0, 0]))
  }
  if (penDraft && penDraft.key === d.key) {
    const draft: PathData = { fillRule: 'nonzero', subpaths: [{ closed: penDraft.closing, anchors: penDraft.anchors }] }
    shapes.push(...outlineOf(draft, penDraft.transform))
    const last = penDraft.anchors[penDraft.anchors.length - 1]
    if (last && penDraft.hover && !penDraft.closing) {
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

// Leaving the Pen finishes the path it was drawing.
tools().subscribe(() => {
  const s = sessions().get()
  if (s?.kind === 'pen' && tools().get() !== 'pen') sessions().commit()
})

// --- the Pen ------------------------------------------------------------------------------------

/**
 * A press with the Pen. On the target path: a press on a segment adds an
 * anchor there, on an anchor deletes it (Alt converts it), on an open
 * path's end carries the path on. Anywhere else it starts a new path: a
 * new shape, or a new outline in the vector mask being edited.
 */
export function penPress(d: OpenDoc, p: Pointer): Gesture | null {
  const t = targetOf(d)
  if (t) {
    const q = toNode(t, p)
    const r = nodeRadius(t, GRAB)
    const a = hitAnchor(t.path, q[0], q[1], r)
    if (a) {
      const end = isEndpoint(t.path, a)
      if (end) {
        sessions().start(penSession(d, t, a.sub, end))
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
  const s = penSession(d, t?.mask ? t : null, -1, null)
  sessions().start(s)
  return s.down(p)
}

/**
 * The Pen drawing a path: each press adds an anchor, a drag pulls its
 * handles out (smooth, the one behind mirroring the one ahead; Alt breaks
 * them). A press on the first anchor closes the path and finishes it;
 * Enter finishes an open one; Esc throws it away.
 */
function penSession(d: OpenDoc, target: Target | null, sub: number, end: 'start' | 'end' | null): Session {
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
  const newId_ = target ? null : newId('n')
  let closed = false
  penDraft = { key, t: target, anchors, transform, hover: null, closing: false }

  const pathNow = (): PathData => {
    const s = { closed, anchors }
    if (!target) return { fillRule: 'nonzero', subpaths: [s] }
    const subs = [...target.path.subpaths]
    if (sub >= 0) subs[sub] = s
    else subs.push(s)
    return { ...target.path, subpaths: subs }
  }
  const docNow = (): Doc => {
    if (anchors.length < 2 && !target) return base
    if (target) return withPath(base, target, pathNow())
    const { parent, index } = newLayerPlace(base, d.selected)
    return addVector(base, newId_!, freshName(base, 'Shape'), { kind: 'path', path: pathNow() }, newAppearance(base, false), parent, index)
  }
  const show = () => {
    penDraft = { key, t: target, anchors, transform, hover: penDraft?.hover ?? null, closing: closed }
    preview(key, docNow())
    refreshVectorOverlay()
  }

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
        // A drag while closing pulls the first anchor's handles out.
        return {
          move(p2) {
            const h = applyMat(inv, p2.x, p2.y)
            if (Math.hypot(p2.dx - p.dx, p2.dy - p.dy) < CLICK) return
            anchors[0] = { ...first, out: [first.p[0] - (h[0] - first.p[0]), first.p[1] - (h[1] - first.p[1])], in: h, smooth: !p2.altKey }
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
      anchors.push({ p: applyMat(inv, sp.x, sp.y), in: null, out: null, smooth: false })
      show()
      const i = anchors.length - 1
      return {
        move(p2) {
          if (Math.hypot(p2.dx - p.dx, p2.dy - p.dy) < CLICK) return
          const h = applyMat(inv, p2.x, p2.y)
          const a = anchors[i]
          anchors[i] = { ...a, out: h, in: p2.altKey ? a.in : [a.p[0] - (h[0] - a.p[0]), a.p[1] - (h[1] - a.p[1])], smooth: !p2.altKey }
          show()
        },
        up() {},
        cancel() {},
      }
    },
    hover(p) {
      if (!penDraft) return
      penDraft.hover = applyMat(inv, p.x, p.y)
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
      if (!anchors.length) return 'Click to place the first point; drag to pull out its handles.'
      return `${anchors.length} point${anchors.length === 1 ? '' : 's'}: click the first point to close the path, Enter to finish it open, Esc to throw it away.`
    },
  }
  return session
}

// --- Direct Selection ---------------------------------------------------------------------------

/**
 * A press with Direct Selection: on a handle of a selected anchor, drags
 * it; on an anchor, selects it (Shift adds, Alt converts it) and drags the
 * selected anchors; on a segment, selects its ends and drags them; on
 * another shape, selects that shape; anywhere else, drags out a box that
 * selects the anchors in it.
 */
export function directPress(d: OpenDoc, p: Pointer): Gesture | null {
  const t = targetOf(d)
  if (t) {
    const q = toNode(t, p)
    const r = nodeRadius(t, GRAB)
    const sel = anchorSelection.of(t)
    const h = hitHandle(t.path, sel, q[0], q[1], r)
    if (h) return dragGesture(t, p, (path, dq, p2) => moveHandle(path, h.ref, h.which, q[0] + dq[0], q[1] + dq[1], p2.altKey))
    const a = hitAnchor(t.path, q[0], q[1], r)
    if (a) {
      if (p.altKey) {
        commitPath(t, convertAnchor(t.path, a), 'Convert Point')
        anchorSelection.set(t, [a])
        return null
      }
      const on = sel.some((x) => x.sub === a.sub && x.i === a.i)
      const next = p.shiftKey ? (on ? sel.filter((x) => !(x.sub === a.sub && x.i === a.i)) : [...sel, a]) : on ? sel : [a]
      anchorSelection.set(t, next)
      if (p.shiftKey && on) return null
      const at = (r: AnchorRef) => applyMat(t.transform, ...t.path.subpaths[r.sub].anchors[r.i].p)
      return dragGesture(t, p, (path, dq) => moveAnchors(path, next, dq[0], dq[1]), { grab: at(a), skip: next.map(at) })
    }
    const seg = hitSegment(t.path, q[0], q[1], r)
    if (seg) {
      const s = t.path.subpaths[seg.sub]
      const ends = [{ sub: seg.sub, i: seg.seg }, { sub: seg.sub, i: (seg.seg + 1) % s.anchors.length }]
      const next = p.shiftKey ? [...sel, ...ends] : ends
      anchorSelection.set(t, next)
      return dragGesture(t, p, (path, dq) => moveAnchors(path, next, dq[0], dq[1]))
    }
  }
  // Another shape under the pointer: it becomes the selected layer.
  const hit = shapeAt(d, p)
  if (hit && hit !== d.selected) {
    documents().select(hit, d.key)
    anchorSelection.set(null, [])
    return null
  }
  // A box that selects the anchors in it.
  const start: Pt = [p.x, p.y]
  const keep = p.shiftKey && t ? anchorSelection.of(t) : []
  if (!p.shiftKey) anchorSelection.set(t, [])
  return {
    move(p2) {
      marquee = { key: d.key, a: start, b: [p2.x, p2.y] }
      refreshVectorOverlay()
    },
    up(p2) {
      marquee = null
      if (t && Math.hypot(p2.x - start[0], p2.y - start[1]) > docRadius(CLICK)) {
        // The box's corners into the path's coordinates: its anchors inside the box.
        const inv = invertAffine(t.transform)
        const corners = [
          [start[0], start[1]],
          [p2.x, start[1]],
          [p2.x, p2.y],
          [start[0], p2.y],
        ].map(([x, y]) => applyMat(inv, x, y))
        const xs = corners.map((c) => c[0])
        const ys = corners.map((c) => c[1])
        const found = anchorsIn(t.path, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)).filter((r) => {
          const a = applyMat(t.transform, ...t.path.subpaths[r.sub].anchors[r.i].p)
          return a[0] >= Math.min(start[0], p2.x) && a[0] <= Math.max(start[0], p2.x) && a[1] >= Math.min(start[1], p2.y) && a[1] <= Math.max(start[1], p2.y)
        })
        const all = new Map([...keep, ...found].map((r) => [refKey(r), r]))
        anchorSelection.set(t, [...all.values()])
      }
      refreshVectorOverlay()
    },
    cancel() {
      marquee = null
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
      if (path) commitPath(t, path, 'Edit Path')
      else unpreview(t.key)
      refreshVectorOverlay()
    },
    cancel() {
      end()
      unpreview(t.key)
      refreshVectorOverlay()
    },
  }
}

/** The overlay while a drag shows a path that isn't committed yet. */
function refreshVectorOverlayWith(t: Target, path: PathData) {
  const shapes = [...outlineOf(path, t.transform), ...anchorShapes(path, t.transform, new Set(anchorSelection.of({ ...t, path }).map(refKey)))]
  setToolOverlay(t.key, { shapes })
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
  if (!d || (tool !== 'direct' && tool !== 'pen')) return false
  const t = targetOf(d)
  const sel = anchorSelection.of(t)
  if (!t || !sel.length) return false
  commitPath(t, deleteAnchors(t.path, sel), sel.length === 1 ? 'Delete Anchor Point' : 'Delete Anchor Points')
  anchorSelection.set(t, [])
  return true
}

// --- the Shape tool -----------------------------------------------------------------------------

/**
 * A drag with the Shape tool: a live shape from corner to corner. Shift
 * keeps it square (a line at 45° steps); Alt draws it from the middle out.
 * With a vector mask being edited, the shape's outline goes into the mask.
 */
export function shapePress(d: OpenDoc, raw0: Pointer): Gesture {
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
    const { parent, index } = newLayerPlace(base, d.selected)
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
  return d ? anchorSelection.of(targetOf(d)).length : 0
}

// The anchor selection belongs to one path: choosing another layer clears it.
documents().subscribe(() => {
  const d = documents().active()
  if (!anchorSelection.key) return
  if (!d || d.key !== anchorSelection.key) return anchorSelection.set(null, [])
  const t = targetOf(d)
  if (!t || t.id !== anchorSelection.id) anchorSelection.set(null, [])
})

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
  if (!d || (tool !== 'direct' && tool !== 'pen')) return null
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
  const t = tool === 'direct' || tool === 'pen' ? targetOf(d) : null
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
