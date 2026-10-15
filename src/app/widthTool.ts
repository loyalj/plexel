/**
 * The Width tool (Shift+W), as Illustrator's: a stroke's width points
 * edited on the canvas. They're the stroke's profile (geom/stroke.ts),
 * which Properties' presets set too; this tool moves, widens, adds and
 * deletes them one by one (geom/width.ts does the arithmetic).
 *
 * It works on the topmost stroke of the selected shapes, or of any stroked
 * shape the pointer is over, which a press then selects. Hovering the
 * stroke shows where a point would go; each point shows as a line across
 * the stroke, its centre a round point, its edges diamonds. Dragging the
 * stroke adds a point there and widens it; dragging an edge widens both
 * sides in proportion (Alt: that side only), every selected point with it;
 * dragging a centre slides the point along the path (Alt: a copy of it).
 * Shift-click selects several, Delete removes them, double-click opens
 * Width Point Edit. Each drag is one step in the history.
 */
import { invertAffine, setAppearance } from '../doc/edit'
import { placeOf, layerRows } from '../doc/tree'
import type { Affine, Doc, NodeId } from '../doc/types'
import { geometryPath, type AppearanceItem, type StrokeItem } from '../doc/vector'
import { applyMat, type PathData, type Pt } from '../geom/path'
import { profileAt, type WidthPoint } from '../geom/stroke'
import { addWidthPoint, deleteWidthPoints, measurePath, moveWidthPoint, nearestPlace, placeAt, setWidthPoint, shownPoints, sideOf, tidyProfile, type MeasuredSub, type PathPlace } from '../geom/width'
import { engine } from '../engine/EngineHost'
import type { OverlayShape } from '../render/overlay'
import { viewMatrix } from '../render/view'
import { tools } from '../tools'
import { CLICK, GRAB, registerHover, registerTool, sessions, type Gesture, type Pointer } from './canvasTools'
import { clearToolOverlay, setToolOverlay, toolOverlayVersion } from './overlay'
import { documents, selectedIds, type OpenDoc } from './documents'
import { lengthText, readout } from './readout'
import { views } from './views'
import { Listeners } from '../lib/listeners'

// --- what's being edited -----------------------------------------------------------------------

/** A shape's topmost stroke, ready to edit: its path measured in the shape's own units. */
interface WTarget {
  key: string
  id: NodeId
  path: PathData
  transform: Affine
  inv: Affine
  /** The stroke and where it is in the shape's appearance. */
  item: StrokeItem
  index: number
  /** Every subpath closed: a point at the start is the one at the end. */
  closed: boolean
  /** A full-width side, in the shape's units: half the stroke, or all of it when it's inside or outside a closed path. */
  hw: number
  ms: MeasuredSub[]
}

/** Paths measured, kept while the path is the same object (documents don't change in place). */
const measured = new WeakMap<PathData, { tol: number; ms: MeasuredSub[] }>()

function measureOf(path: PathData, tol: number): MeasuredSub[] {
  const had = measured.get(path)
  // Fine enough already: within a factor of two of what's wanted now.
  if (had && had.tol <= tol * 2 && had.tol >= tol / 4) return had.ms
  const ms = measurePath(path, tol)
  measured.set(path, { tol, ms })
  return ms
}

const scaleOf = (m: Affine) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1

/** How many document pixels a few device pixels are, at the front view's zoom. */
function docRadius(devicePx: number): number {
  const v = views().front()
  if (!v) return devicePx
  const m = viewMatrix(v, engine().canvasSize())
  return devicePx / (Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1)
}

/** The stroke the tool edits on a node: its topmost one that's on. */
function topStroke(items: AppearanceItem[] | undefined): number {
  if (!items) return -1
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'stroke' && items[i].enabled && (items[i] as StrokeItem).width > 0) return i
  return -1
}

function targetFor(d: OpenDoc, id: NodeId, doc: Doc = d.history.present): WTarget | null {
  const n = doc.nodes[id]
  if (n?.kind !== 'vector' || n.locked.all) return null
  const index = topStroke(n.props.appearance)
  if (index < 0) return null
  const item = n.props.appearance[index] as StrokeItem
  const path = geometryPath(n.props.geometry)
  if (!path.subpaths.length) return null
  const closed = path.subpaths.every((s) => s.closed)
  const aligned = closed && item.align !== 'centre'
  const tol = Math.max(1e-3, docRadius(0.25) / scaleOf(n.transform))
  return { key: d.key, id, path, transform: n.transform, inv: invertAffine(n.transform), item, index, closed, hw: aligned ? item.width : item.width / 2, ms: measureOf(path, tol) }
}

/** The selected shapes the tool works on, the key layer first. */
function selectedTargets(d: OpenDoc): WTarget[] {
  const ids = selectedIds(d)
  const order = d.selected ? [d.selected, ...ids.filter((id) => id !== d.selected)] : ids
  return order.map((id) => targetFor(d, id)).filter((t): t is WTarget => !!t)
}

/** The stroked shapes on the canvas, top first: visible, not locked, not a compound's operand. */
function strokedShapes(d: OpenDoc): NodeId[] {
  const doc = d.history.present
  const out: NodeId[] = []
  for (const { node } of layerRows(doc)) {
    if (node.kind !== 'vector' || !node.visible || node.locked.all) continue
    const place = placeOf(doc, node.id)
    if (place && doc.nodes[place.parent]?.kind === 'boolean') continue
    if (topStroke(node.props.appearance) >= 0) out.push(node.id)
  }
  return out
}

const profileOf = (t: WTarget) => t.item.profile ?? []

/** Each side's width at `t` along the path, in the shape's units. */
const widthsAt = (t: WTarget, at: number): [number, number] => {
  const p = profileOf(t)
  return [t.hw * profileAt(p, at, 'left'), t.hw * profileAt(p, at, 'right')]
}

/** The doc with the target's stroke given a new profile. */
function withProfile(doc: Doc, t: WTarget, profile: WidthPoint[] | undefined): Doc {
  const n = doc.nodes[t.id]
  if (n?.kind !== 'vector') return doc
  const items = n.props.appearance.map((it, i) => {
    if (i !== t.index || it.kind !== 'stroke') return it
    const { profile: _old, ...rest } = it
    const tidy = tidyProfile(profile)
    return tidy ? { ...rest, profile: tidy } : rest
  })
  return setAppearance(doc, t.id, items)
}

// --- the selected width points -------------------------------------------------------------

/** The width points selected, on one shape's stroke, by index into its profile. */
class WidthSelection {
  key: string | null = null
  id: NodeId | null = null
  points: number[] = []
  version = 0
  private changes = new Listeners()
  subscribe = (fn: () => void) => this.changes.subscribe(fn)
  of(t: WTarget | null): number[] {
    if (!t || t.key !== this.key || t.id !== this.id) return []
    const n = profileOf(t).length
    return this.points.filter((i) => i < n)
  }
  set(t: WTarget | null, points: number[]) {
    this.key = t?.key ?? null
    this.id = t?.id ?? null
    this.points = [...new Set(points)].sort((a, b) => a - b)
    this.version++
    this.changes.emit()
  }
}
export const widthSelection = new WidthSelection()

/** Width Point Edit, opened by a double-click on a point: which one. The dialog (ui/widthDialog.tsx) follows this. */
export interface WidthEditing {
  key: string
  id: NodeId
  index: number
  point: number
}
let editing: WidthEditing | null = null
const editingChanges = new Listeners()
export const widthEditing = {
  get: () => editing,
  set(e: WidthEditing | null) {
    editing = e
    editingChanges.emit()
  },
  subscribe: (fn: () => void) => editingChanges.subscribe(fn),
}

/** What Width Point Edit shows: the point's two sides and the stroke it's on, in document pixels. */
export function editingPoint(e: WidthEditing): { left: number; right: number; scale: number } | null {
  const d = documents().get(e.key)
  const t = d ? targetFor(d, e.id) : null
  const p = t && t.index === e.index ? profileOf(t)[e.point] : null
  if (!t || !p) return null
  const s = scaleOf(t.transform)
  return { left: p.left * t.hw * s, right: p.right * t.hw * s, scale: s }
}

/** Width Point Edit's OK: the point's sides in document pixels. */
export function setEditingPoint(e: WidthEditing, left: number, right: number) {
  const d = documents().get(e.key)
  const t = d ? targetFor(d, e.id) : null
  if (!t || t.index !== e.index || !profileOf(t)[e.point]) return
  const s = scaleOf(t.transform) * t.hw
  const next = setWidthPoint(profileOf(t), e.point, left / s, right / s, t.closed)
  documents().commit((x) => withProfile(x, t, next), { key: t.key, label: 'Edit Width Point' })
}

/** Width Point Edit's Delete, and the Delete key with points selected. */
function deletePoints(t: WTarget, points: number[]) {
  const p = profileOf(t)
  // A closed path's point at its start is the one at its end too: both go.
  const drop = new Set(points)
  if (t.closed && points.some((i) => p[i] && (p[i].at <= 1e-6 || p[i].at >= 1 - 1e-6))) p.forEach((x, i) => (x.at <= 1e-6 || x.at >= 1 - 1e-6) && drop.add(i))
  const next = deleteWidthPoints(p, drop)
  documents().commit((x) => withProfile(x, t, next), { key: t.key, label: drop.size > 1 ? 'Delete Width Points' : 'Delete Width Point' })
  widthSelection.set(t, [])
}

export function deleteEditingPoint(e: WidthEditing) {
  const d = documents().get(e.key)
  const t = d ? targetFor(d, e.id) : null
  if (t && t.index === e.index && profileOf(t)[e.point]) deletePoints(t, [e.point])
}

/** Delete with the Width tool and points selected: they go. Returns whether it did anything. */
export function deleteSelectedWidthPoints(): boolean {
  const d = documents().active()
  if (!d || tools().get() !== 'width' || widthSelection.key !== d.key || !widthSelection.id) return false
  const t = targetFor(d, widthSelection.id)
  const pts = widthSelection.of(t)
  if (!t || !pts.length) return false
  deletePoints(t, pts)
  return true
}

// --- hitting things --------------------------------------------------------------------------

/** A width point drawn on one subpath: its centre and edges, in the shape's units. */
interface Drawn {
  point: number
  sub: number
  place: PathPlace
  c: Pt
  l: Pt
  r: Pt
}

const normal = (pl: PathPlace): Pt => [-pl.dir[1], pl.dir[0]]

/** Where each shown width point is drawn, on every subpath (the profile goes along each). */
function drawnPoints(t: WTarget, profile: WidthPoint[] = profileOf(t)): Drawn[] {
  const out: Drawn[] = []
  for (const i of shownPoints(profile, t.closed)) {
    const w = profile[i]
    t.ms.forEach((_, sub) => {
      const pl = placeAt(t.ms, sub, w.at)
      if (!pl) return
      const n = normal(pl)
      const c = pl.p
      out.push({ point: i, sub, place: pl, c, l: [c[0] + n[0] * t.hw * w.left, c[1] + n[1] * t.hw * w.left], r: [c[0] - n[0] * t.hw * w.right, c[1] - n[1] * t.hw * w.right] })
    })
  }
  return out
}

type Hit =
  | { kind: 'edge'; t: WTarget; d: Drawn; side: 1 | -1 }
  | { kind: 'centre'; t: WTarget; d: Drawn }
  | { kind: 'stroke'; t: WTarget; place: PathPlace }

/** What the pointer is on, on one target: an edge or centre of a point first, then the stroke itself. */
function hitOn(t: WTarget, p: Pointer, pointsToo: boolean): Hit | null {
  const q = applyMat(t.inv, p.x, p.y)
  const r = docRadius(GRAB) / scaleOf(t.transform)
  if (pointsToo) {
    let best: { hit: Hit; dist: number } | null = null
    for (const d of drawnPoints(t)) {
      const cands: [Hit, Pt][] = [
        [{ kind: 'edge', t, d, side: 1 }, d.l],
        [{ kind: 'edge', t, d, side: -1 }, d.r],
        [{ kind: 'centre', t, d }, d.c],
      ]
      for (const [hit, at] of cands) {
        const dist = Math.hypot(q[0] - at[0], q[1] - at[1])
        if (dist < r && (!best || dist < best.dist - 1e-9)) best = { hit, dist }
      }
    }
    if (best) return best.hit
  }
  const pl = nearestPlace(t.ms, q[0], q[1])
  if (!pl) return null
  const [wl, wr] = widthsAt(t, pl.t)
  const wide = sideOf(pl, q[0], q[1]) > 0 ? wl : wr
  return pl.dist <= Math.max(r, wide) ? { kind: 'stroke', t, place: pl } : null
}

/** What the pointer is on: the selected shapes' points and strokes, then any stroked shape's stroke. */
function hitAt(d: OpenDoc, p: Pointer): Hit | null {
  const sel = selectedTargets(d)
  for (const t of sel) {
    const h = hitOn(t, p, true)
    if (h) return h
  }
  const skip = new Set(sel.map((t) => t.id))
  for (const id of strokedShapes(d)) {
    if (skip.has(id)) continue
    const t = targetFor(d, id)
    const h = t && hitOn(t, p, false)
    if (h) return h
  }
  return null
}

// --- the overlay -------------------------------------------------------------------------------

/** The point the pointer would add, shown across the stroke while hovering. */
let hover: { key: string; id: NodeId; place: PathPlace } | null = null
/** A profile being dragged, not committed yet, for the overlay. */
let dragging: { id: NodeId; profile: WidthPoint[] } | null = null
/** The overlay this tool last drew, by document, with the overlay's version then: cleared only while it's still this tool's. */
const owned = new Map<string, number>()

const docPt = (t: WTarget, q: Pt): [number, number] => applyMat(t.transform, q[0], q[1])

/** The centre line, flattened as measured, in document pixels. */
function centreLines(t: WTarget): OverlayShape[] {
  return t.ms
    .filter((m) => m.pts.length >= 4)
    .map((m) => {
      const points: [number, number][] = []
      for (let i = 0; i < m.pts.length; i += 2) points.push(docPt(t, [m.pts[i], m.pts[i + 1]]))
      return { kind: 'path' as const, points, closed: m.closed, style: 'thin' as const }
    })
}

function refresh() {
  const d = documents().active()
  if (!d) return
  const s = sessions().get()
  if (s && s.key === d.key) return
  if (tools().get() !== 'width') {
    const v = owned.get(d.key)
    if (v !== undefined) {
      owned.delete(d.key)
      if (toolOverlayVersion() === v) clearToolOverlay(d.key)
    }
    return
  }
  const shapes: OverlayShape[] = []
  const ts = selectedTargets(d)
  const hoverT = hover && hover.key === d.key && !ts.some((t) => t.id === hover!.id) ? targetFor(d, hover.id) : null
  for (const t of hoverT ? [...ts, hoverT] : ts) {
    shapes.push(...centreLines(t))
    const profile = dragging?.id === t.id ? dragging.profile : profileOf(t)
    const sel = new Set(widthSelection.of(t))
    const centres: [number, number][] = []
    const picked: boolean[] = []
    const edges: [number, number][] = []
    for (const dp of drawnPoints(t, profile)) {
      shapes.push({ kind: 'path', points: [docPt(t, dp.l), docPt(t, dp.r)], closed: false, style: 'thin' })
      centres.push(docPt(t, dp.c))
      picked.push(sel.has(dp.point))
      edges.push(docPt(t, dp.l), docPt(t, dp.r))
    }
    shapes.push({ kind: 'dots', points: edges })
    shapes.push({ kind: 'anchors', points: centres, selected: picked, smooth: centres.map(() => true) })
  }
  if (hover && hover.key === d.key && !dragging) {
    const t = ts.find((x) => x.id === hover!.id) ?? hoverT
    if (t) {
      const pl = hover.place
      const [wl, wr] = widthsAt(t, pl.t)
      const n = normal(pl)
      const a: Pt = [pl.p[0] + n[0] * wl, pl.p[1] + n[1] * wl]
      const b: Pt = [pl.p[0] - n[0] * wr, pl.p[1] - n[1] * wr]
      shapes.push({ kind: 'path', points: [docPt(t, a), docPt(t, b)], closed: false, style: 'smart' })
    }
  }
  setToolOverlay(d.key, { shapes })
  owned.set(d.key, toolOverlayVersion())
}

documents().subscribe(refresh)
// After the other tools' overlays have let go of the canvas.
tools().subscribe(() => {
  hover = null
  queueMicrotask(refresh)
})
sessions().subscribe(refresh)
widthSelection.subscribe(refresh)

registerHover('width', (p) => {
  const d = documents().active()
  if (!d) return
  const h = hitAt(d, p)
  const next = h?.kind === 'stroke' ? { key: d.key, id: h.t.id, place: h.place } : null
  if (!next && !hover) return
  hover = next
  refresh()
})

// --- the drags --------------------------------------------------------------------------------

const preview = (key: string, doc: Doc) => engine().setScene(key, doc)
const unpreview = (key: string) => {
  const d = documents().get(key)
  if (d) engine().setScene(key, d.history.present)
}

const DOUBLE_MS = 450
let lastClick: { id: NodeId; point: number; at: number } | null = null

/**
 * Widening point `i` of `base` by dragging one edge (`side`, from the
 * centre `place`): both sides in proportion, or with Alt that side only;
 * the other selected points by as much. `added` is a point just put there
 * by the press, which a click without a drag leaves out.
 */
function widenGesture(d: OpenDoc, t: WTarget, base: WidthPoint[], i: number, place: PathPlace, side: 1 | -1, p0: Pointer, added: boolean): Gesture {
  const doc = d.history.present
  const q0 = applyMat(t.inv, p0.x, p0.y)
  const n = normal(place)
  const sel = widthSelection.of(t)
  const group = !added && sel.includes(i) && sel.length > 1 ? sel : [i]
  const s0 = side > 0 ? base[i].left : base[i].right
  let next: WidthPoint[] | null = null
  const end = () => {
    dragging = null
    hover = null
    readout().set(null)
  }
  return {
    move(p) {
      if (!next && Math.hypot(p.dx - p0.dx, p.dy - p0.dy) < CLICK) return
      const q = applyMat(t.inv, p.x, p.y)
      const along = ((q[0] - q0[0]) * n[0] + (q[1] - q0[1]) * n[1]) * side
      const s = Math.max(0, s0 + along / t.hw)
      const k = s0 > 1e-9 ? s / s0 : null
      // Each side that changes, by the same factor as the edge dragged (or to its width, from nothing).
      const by = (v: number) => (k === null ? s : v * k)
      let out = base
      for (const j of group) {
        const w = base[j]
        out = setWidthPoint(out, j, !p.altKey || side > 0 ? by(w.left) : w.left, !p.altKey || side < 0 ? by(w.right) : w.right, t.closed)
      }
      next = out
      dragging = { id: t.id, profile: out }
      const w = out[i]
      const px = t.hw * scaleOf(t.transform)
      readout().set({ text: `W ${lengthText((w.left + w.right) * px)}  (${lengthText(w.left * px)} | ${lengthText(w.right * px)})`, x: p.dx, y: p.dy })
      preview(d.key, withProfile(doc, t, out))
      refresh()
    },
    up() {
      end()
      const out = next
      if (out) {
        documents().commit((x) => withProfile(x, t, out), { key: d.key, label: added ? 'Add Width Point' : 'Edit Width Point' })
        widthSelection.set(t, added ? [i] : group)
      } else unpreview(d.key)
      refresh()
    },
    cancel() {
      end()
      unpreview(d.key)
      refresh()
    },
  }
}

/** Sliding point `i` along the path (on the subpath pressed), or with Alt a copy of it; `clicked` when it's let go without moving. */
function slideGesture(d: OpenDoc, t: WTarget, i: number, sub: number, p0: Pointer, clicked: () => void): Gesture {
  const doc = d.history.present
  const base = profileOf(t)
  let next: { profile: WidthPoint[]; index: number } | null = null
  const end = () => {
    dragging = null
    readout().set(null)
  }
  return {
    move(p) {
      if (!next && Math.hypot(p.dx - p0.dx, p.dy - p0.dy) < CLICK) return
      const q = applyMat(t.inv, p.x, p.y)
      const pl = nearestPlace(t.ms, q[0], q[1], sub)
      if (!pl) return
      if (p.altKey) {
        // A copy, as wide as the point it came from, wherever it's dragged.
        const copy = { at: Math.min(1 - 1e-3, Math.max(1e-3, pl.t)), left: base[i].left, right: base[i].right }
        const out = [...base.filter((x) => Math.abs(x.at - copy.at) > 1e-6), copy].sort((a, b) => a.at - b.at)
        next = { profile: out, index: out.indexOf(copy) }
      } else next = { profile: moveWidthPoint(base, i, pl.t), index: i }
      dragging = { id: t.id, profile: next.profile }
      readout().set({ text: `${Math.round(next.profile[next.index].at * 1000) / 10}%`, x: p.dx, y: p.dy })
      preview(d.key, withProfile(doc, t, next.profile))
      refresh()
    },
    up() {
      end()
      const out = next
      if (out) {
        documents().commit((x) => withProfile(x, t, out.profile), { key: d.key, label: p0.altKey ? 'Copy Width Point' : 'Move Width Point' })
        widthSelection.set(t, [out.index])
      } else {
        unpreview(d.key)
        clicked()
      }
      refresh()
    },
    cancel() {
      end()
      unpreview(d.key)
      refresh()
    },
  }
}

/**
 * A press with the Width tool: on a point's edge, widen it; on its centre,
 * select it (Shift: one more, or one less) and slide it, a double-click
 * opening Width Point Edit; on a stroke anywhere else, add a point there
 * and widen it at once. A stroked shape that isn't selected becomes the
 * selected layer first.
 */
function widthPress(d: OpenDoc, p: Pointer): Gesture | null {
  const h = hitAt(d, p)
  if (!h) {
    widthSelection.set(null, [])
    return null
  }
  if (!selectedIds(d).includes(h.t.id)) {
    documents().select(h.t.id, d.key)
    widthSelection.set(null, [])
  }
  const t = targetFor(documents().get(d.key)!, h.t.id)
  if (!t) return null
  if (h.kind === 'edge') {
    if (!widthSelection.of(t).includes(h.d.point)) widthSelection.set(t, [h.d.point])
    return widenGesture(d, t, profileOf(t), h.d.point, h.d.place, h.side, p, false)
  }
  if (h.kind === 'centre') {
    const i = h.d.point
    const now = performance.now()
    if (lastClick && lastClick.id === t.id && lastClick.point === i && now - lastClick.at < DOUBLE_MS) {
      lastClick = null
      widthSelection.set(t, [i])
      widthEditing.set({ key: t.key, id: t.id, index: t.index, point: i })
      return null
    }
    lastClick = null
    const sel = widthSelection.of(t)
    if (p.shiftKey) {
      widthSelection.set(t, sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i])
      return null
    }
    if (!sel.includes(i)) widthSelection.set(t, [i])
    // A click (not a drag) selects that point alone, and may be a double-click's first.
    return slideGesture(d, t, i, h.d.sub, p, () => {
      widthSelection.set(t, [i])
      lastClick = { id: t.id, point: i, at: performance.now() }
    })
  }
  // On the stroke: a point there, widened by the drag.
  const q = applyMat(t.inv, p.x, p.y)
  const { profile, index } = addWidthPoint(t.item.profile, h.place.t)
  widthSelection.set(t, [])
  return widenGesture(d, t, profile, index, h.place, sideOf(h.place, q[0], q[1]), p, true)
}

registerTool('width', widthPress)

/** For the checks: where a shape's width points are drawn, in document pixels: each one's centre and its two edges. */
export function widthPointsOf(id: NodeId): { point: number; c: Pt; l: Pt; r: Pt }[] {
  const d = documents().active()
  const t = d ? targetFor(d, id) : null
  if (!t) return []
  return drawnPoints(t).map((x) => ({ point: x.point, c: docPt(t, x.c), l: docPt(t, x.l), r: docPt(t, x.r) }))
}
