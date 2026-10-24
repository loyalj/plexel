/**
 * Gradients edited on the canvas, as Illustrator's gradient annotator and
 * Mesh tool do: what the Gradient tool (G) and the Mesh tool show on the
 * selected layer's gradient, and what a press on them does.
 *
 * The gradient edited is a fill layer's, or a shape's: the fill or stroke
 * opened in Properties (`paintFocus`) when its paint can be edited here,
 * else its top fill that can, else its top stroke that can.
 *
 * - A linear, radial, angular, reflected or diamond gradient shows its line
 *   (one across the box until it's moved, then its own) with its ends as
 *   squares and its stops as round points along it. Dragging an end moves
 *   it (Shift: 45° about the other end); dragging a stop slides it along
 *   the line (Alt: a copy of it), and off the line, far, takes it away;
 *   a click on the line adds a stop there in the colour the gradient has.
 * - A freeform gradient shows its colour points: drag one to move it, click
 *   anywhere else in the shape to add one in the foreground colour.
 * - A mesh shows its grid and points: drag a point to move it. With the
 *   Mesh tool, a click in a patch adds a row and a column through it (on a
 *   line, only the line across it), the new point in the foreground
 *   colour; a click on a shape that isn't a mesh makes it one; Alt-click a
 *   point takes away its row and column.
 *
 * A click on a stop, point or mesh point selects it, and Properties edits
 * its colour; Delete takes it away. Each drag is one step in the history.
 */
import { invertAffine, setAppearance, setFillPaint } from '../doc/edit'
import type { Affine, Doc, NodeId } from '../doc/types'
import { mainColour, type AppearanceItem, type FreeformPoint, type MeshNode, type Paint, type PaintStop } from '../doc/vector'
import { engine } from '../engine/EngineHost'
import { applyMat, type Box, type Pt } from '../geom/path'
import { outlineBounds } from '../geom/glyphs'
import type { OverlayShape } from '../render/overlay'
import { viewMatrix } from '../render/view'
import { tools } from '../tools'
import { meshLocate, meshNode, nearestLines, newMesh, splitMesh, type Mesh } from '../vector/mesh'
import { paintColourAt } from '../vector/paint'
import { shapeOf } from '../vector/shape'
import { layerRows, placeOf } from '../doc/tree'
import { shapeHit } from './pick'
import { Listeners } from '../lib/listeners'
import { CLICK, GRAB, registerTool, sessions, type Gesture, type Pointer } from './canvasTools'
import { swatchIn } from './colour'
import { clearToolOverlay, setToolOverlay, toolOverlayVersion } from './overlay'
import { documents, type OpenDoc } from './documents'
import { readout } from './readout'
import { views } from './views'

// --- which paint ------------------------------------------------------------------------------

/** The fill or stroke opened in Properties, by layer: the one the canvas edits when it can. */
let focus: { id: NodeId; item: number } | null = null
const focusChanges = new Listeners()
export const paintFocus = {
  get: () => focus,
  set(id: NodeId, item: number | null) {
    const next = item === null ? null : { id, item }
    if (focus?.id === next?.id && focus?.item === next?.item) return
    focus = next
    focusChanges.emit()
  },
  subscribe: (fn: () => void) => focusChanges.subscribe(fn),
}

/** A paint the canvas can edit: a gradient laid like a fill's (not along or across a stroke), a freeform gradient, a mesh. */
export const editablePaint = (p: Paint) => (p.kind === 'gradient' && !p.stroke) || p.kind === 'freeform' || p.kind === 'mesh'

/** The paint edited, on what. `item` is its place in a shape's appearance, −1 on a fill layer. */
export interface GTarget {
  key: string
  id: NodeId
  item: number
  paint: Paint
  /** The paint's coordinates to the document's, and back. */
  transform: Affine
  inv: Affine
  /** The box a gradient without a line of its own lies across, in the paint's coordinates. */
  box: Box
}

/** Which item of an appearance the canvas edits (see above); −1 for none. */
function itemFor(id: NodeId, items: AppearanceItem[], ok: (p: Paint) => boolean): number {
  const usable = (i: number) => items[i]?.enabled && ok(items[i].paint)
  if (focus?.id === id && usable(focus.item)) return focus.item
  for (const kind of ['fill', 'stroke'] as const) for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === kind && usable(i)) return i
  return -1
}

/** The selected layer's paint the canvas edits, if it has one (`ok` says which paints count). */
export function gradientTarget(d: OpenDoc, ok: (p: Paint) => boolean = editablePaint, doc: Doc = d.history.present): GTarget | null {
  const n = d.selected ? doc.nodes[d.selected] : null
  if (!n || n.locked.all) return null
  if (n.kind === 'fill') {
    if (!ok(n.props.paint)) return null
    return { key: d.key, id: n.id, item: -1, paint: n.props.paint, transform: n.transform, inv: invertAffine(n.transform), box: [0, 0, doc.width, doc.height] }
  }
  if (n.kind !== 'vector' && n.kind !== 'boolean' && n.kind !== 'text') return null
  const item = itemFor(n.id, n.props.appearance, ok)
  if (item < 0) return null
  const shape = shapeOf((id) => doc.nodes[id], n)
  if (!shape) return null
  const t = [...shape.transform] as Affine
  return { key: d.key, id: n.id, item, paint: n.props.appearance[item].paint, transform: t, inv: invertAffine(t), box: outlineBounds(shape.path) ?? [0, 0, 1, 1] }
}

/** The box a layer's gradients lie across, in their own coordinates: a shape's path's, a fill layer's canvas. */
export function paintBox(doc: Doc, id: NodeId): Box {
  const n = doc.nodes[id]
  if (!n || n.kind === 'fill') return [0, 0, doc.width, doc.height]
  const shape = shapeOf((x) => doc.nodes[x], n)
  return (shape && outlineBounds(shape.path)) ?? [0, 0, doc.width, doc.height]
}

/** The document with the target's paint replaced. */
export function withPaint(doc: Doc, t: GTarget, paint: Paint): Doc {
  if (t.item < 0) return setFillPaint(doc, t.id, paint)
  const n = doc.nodes[t.id]
  if (n?.kind !== 'vector' && n?.kind !== 'boolean' && n?.kind !== 'text') return doc
  return setAppearance(
    doc,
    t.id,
    n.props.appearance.map((it, i) => (i === t.item ? ({ ...it, paint } as AppearanceItem) : it)),
  )
}

// --- the selected stop or point ----------------------------------------------------------------

/** The stop, freeform point or mesh point selected on the canvas: on which layer's which paint, by index. */
class GradientSelection {
  key: string | null = null
  id: NodeId | null = null
  item = 0
  index: number | null = null
  private changes = new Listeners()
  subscribe = (fn: () => void) => this.changes.subscribe(fn)
  /** The index selected on this target's paint, if any. */
  of(t: { key: string; id: NodeId; item: number } | null): number | null {
    return t && t.key === this.key && t.id === this.id && t.item === this.item ? this.index : null
  }
  /** What's selected as one value, for React. */
  snapshot = () => `${this.key}|${this.id}|${this.item}|${this.index}`
  set(t: { key: string; id: NodeId; item: number } | null, index: number | null) {
    this.key = t?.key ?? null
    this.id = t?.id ?? null
    this.item = t?.item ?? 0
    this.index = t ? index : null
    this.changes.emit()
  }
}
export const gradientSelection = new GradientSelection()

// --- where things are --------------------------------------------------------------------------

type Line = [number, number, number, number]

/**
 * A gradient's line in its own coordinates: its own, or the one across the
 * box it lies along (vector/paint.ts's sums): a linear gradient's from its
 * 0 to its 1, the others' from their centre out to their 1.
 */
export function gradientLine(p: Extract<Paint, { kind: 'gradient' }>, box: Box): Line {
  if (p.line) return p.line
  const cx = (box[0] + box[2]) / 2
  const cy = (box[1] + box[3]) / 2
  const w = Math.max(1e-6, box[2] - box[0])
  const h = Math.max(1e-6, box[3] - box[1])
  const a = (p.angle * Math.PI) / 180
  const dx = Math.cos(a)
  const dy = -Math.sin(a)
  const scale = p.scale / 100
  if (p.type === 'linear') {
    const half = ((Math.abs(w * dx) + Math.abs(h * dy)) / 2) * scale
    return [cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half]
  }
  const r = p.type === 'reflected' ? ((Math.abs(w * dx) + Math.abs(h * dy)) / 2) * scale : (Math.max(w, h) / 2) * scale
  return [cx, cy, cx + dx * r, cy + dy * r]
}

/** Where along the line (0..1) a stop is drawn: reversed, from the other end. */
const stopPos = (p: Extract<Paint, { kind: 'gradient' }>, at: number) => (p.reverse ? 1 - at : at)

const lerp = (l: Line, s: number): Pt => [l[0] + (l[2] - l[0]) * s, l[1] + (l[3] - l[1]) * s]

/** How many document pixels a few device pixels are, at the front view's zoom. */
function docRadius(devicePx: number): number {
  const v = views().front()
  if (!v) return devicePx
  const m = viewMatrix(v, engine().canvasSize())
  return devicePx / (Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1)
}

const toDoc = (t: GTarget, q: Pt): [number, number] => applyMat(t.transform, q[0], q[1])

/** How far beside the line its stops are drawn, in device pixels: clear of its ends, as Illustrator draws them under its line. */
const STOP_OFFSET = 12

/** Where a stop at s along the line is drawn, in document pixels: beside the line, on its right-hand side. */
function stopDoc(t: GTarget, l: Line, s: number): [number, number] {
  const a = toDoc(t, [l[0], l[1]])
  const b = toDoc(t, [l[2], l[3]])
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  const off = docRadius(STOP_OFFSET)
  return [a[0] + (b[0] - a[0]) * s - ((b[1] - a[1]) / len) * off, a[1] + (b[1] - a[1]) * s + ((b[0] - a[0]) / len) * off]
}
const docDist = (t: GTarget, a: Pt, x: number, y: number) => {
  const p = toDoc(t, a)
  return Math.hypot(p[0] - x, p[1] - y)
}

/** A stop's colour and alpha at s along a gradient (as stored), for a stop added there. */
function stopAt(stops: PaintStop[], at: number): PaintStop {
  const s = [...stops].sort((a, b) => a.at - b.at)
  if (at <= s[0].at) return { ...s[0], at }
  if (at >= s[s.length - 1].at) return { ...s[s.length - 1], at }
  let i = 0
  while (i < s.length - 2 && at > s[i + 1].at) i++
  const f = (at - s[i].at) / Math.max(1e-9, s[i + 1].at - s[i].at)
  return { at, colour: s[i].colour.map((c, k) => c + ((s[i + 1].colour[k] ?? c) - c) * f), alpha: s[i].alpha + (s[i + 1].alpha - s[i].alpha) * f }
}

type Hit =
  | { kind: 'end'; end: 0 | 1 }
  | { kind: 'stop'; index: number }
  | { kind: 'line'; s: number }
  | { kind: 'point'; index: number }
  | { kind: 'node'; index: number }
  | { kind: 'inside'; q: Pt }

/** What a press at (x, y) in document pixels is on, on the target. */
function hitOn(t: GTarget, x: number, y: number): Hit | null {
  const r = docRadius(GRAB)
  const p = t.paint
  const q = applyMat(t.inv, x, y)
  if (p.kind === 'gradient') {
    const l = gradientLine(p, t.box)
    let best: { hit: Hit; d: number } | null = null
    const consider = (hit: Hit, at: Pt) => {
      const d = docDist(t, at, x, y)
      if (d < r && (!best || d < best.d)) best = { hit, d }
    }
    p.stops.forEach((s, i) => {
      const at = stopDoc(t, l, stopPos(p, s.at))
      const d = Math.hypot(at[0] - x, at[1] - y)
      if (d < r && (!best || d < best.d)) best = { hit: { kind: 'stop', index: i }, d }
    })
    consider({ kind: 'end', end: 0 }, [l[0], l[1]])
    consider({ kind: 'end', end: 1 }, [l[2], l[3]])
    if (best) return (best as { hit: Hit }).hit
    // On the line between its ends.
    const a = toDoc(t, [l[0], l[1]])
    const b = toDoc(t, [l[2], l[3]])
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l2 = dx * dx + dy * dy
    if (l2 > 0) {
      const s = ((x - a[0]) * dx + (y - a[1]) * dy) / l2
      if (s > 0 && s < 1 && Math.abs((x - a[0]) * dy - (y - a[1]) * dx) / Math.sqrt(l2) < r) return { kind: 'line', s }
    }
    return null
  }
  if (p.kind === 'freeform') {
    let best = -1
    let bd = r
    p.points.forEach((pt, i) => {
      const d = docDist(t, pt.p, x, y)
      if (d < bd) {
        bd = d
        best = i
      }
    })
    if (best >= 0) return { kind: 'point', index: best }
    const pad = r
    const b = t.box
    return q[0] >= b[0] - pad && q[0] <= b[2] + pad && q[1] >= b[1] - pad && q[1] <= b[3] + pad ? { kind: 'inside', q } : null
  }
  if (p.kind === 'mesh') {
    let best = -1
    let bd = r
    p.nodes.forEach((n, i) => {
      const d = docDist(t, n.p, x, y)
      if (d < bd) {
        bd = d
        best = i
      }
    })
    if (best >= 0) return { kind: 'node', index: best }
    const at = meshLocate(p, q[0], q[1])
    return at.out <= 0 ? { kind: 'inside', q } : null
  }
  return null
}

// --- the overlay -------------------------------------------------------------------------------

/** A paint being dragged, not committed yet, for the overlay; and the index a stop being dragged off would leave. */
let draft: { id: NodeId; paint: Paint; removing?: number } | null = null
/** The overlay this module last drew, by document, with the overlay's version then. */
const owned = new Map<string, number>()
const editing = () => tools().get() === 'gradient' || tools().get() === 'mesh'

function shapesFor(t: GTarget): OverlayShape[] {
  const p = draft?.id === t.id ? draft.paint : t.paint
  const sel = gradientSelection.of(t)
  const shapes: OverlayShape[] = []
  if (p.kind === 'gradient') {
    const l = gradientLine(p, t.box)
    shapes.push({ kind: 'path', points: [toDoc(t, [l[0], l[1]]), toDoc(t, [l[2], l[3]])], closed: false, style: 'line' })
    shapes.push({ kind: 'handles', points: [toDoc(t, [l[0], l[1]]), toDoc(t, [l[2], l[3]])] })
    const stops = p.stops.map((s, i) => ({ s, i })).filter(({ i }) => draft?.removing !== i)
    for (const { s } of stops) shapes.push({ kind: 'path', points: [toDoc(t, lerp(l, stopPos(p, s.at))), stopDoc(t, l, stopPos(p, s.at))], closed: false, style: 'thin' })
    shapes.push({ kind: 'anchors', points: stops.map(({ s }) => stopDoc(t, l, stopPos(p, s.at))), selected: stops.map(({ i }) => i === sel), smooth: stops.map(() => true) })
  } else if (p.kind === 'freeform') {
    shapes.push({ kind: 'anchors', points: p.points.map((q) => toDoc(t, q.p)), selected: p.points.map((_, i) => i === sel), smooth: p.points.map(() => true) })
  } else if (p.kind === 'mesh') {
    for (let j = 0; j <= p.rows; j++) shapes.push({ kind: 'path', points: [...Array(p.cols + 1).keys()].map((i) => toDoc(t, meshNode(p, i, j).p)), closed: false, style: 'thin' })
    for (let i = 0; i <= p.cols; i++) shapes.push({ kind: 'path', points: [...Array(p.rows + 1).keys()].map((j) => toDoc(t, meshNode(p, i, j).p)), closed: false, style: 'thin' })
    shapes.push({ kind: 'anchors', points: p.nodes.map((n) => toDoc(t, n.p)), selected: p.nodes.map((_, i) => i === sel) })
  }
  return shapes
}

function refresh() {
  const d = documents().active()
  if (!d) return
  const s = sessions().get()
  if (s && s.key === d.key) return
  const t = editing() ? gradientTarget(d) : null
  if (!t) {
    const v = owned.get(d.key)
    if (v !== undefined) {
      owned.delete(d.key)
      if (toolOverlayVersion() === v) clearToolOverlay(d.key)
    }
    return
  }
  setToolOverlay(d.key, { shapes: shapesFor(t) })
  owned.set(d.key, toolOverlayVersion())
}

documents().subscribe(refresh)
tools().subscribe(() => queueMicrotask(refresh))
sessions().subscribe(refresh)
gradientSelection.subscribe(refresh)
paintFocus.subscribe(refresh)

// --- the drags --------------------------------------------------------------------------------

const preview = (t: GTarget, doc: Doc, paint: Paint, removing?: number) => {
  draft = { id: t.id, paint, removing }
  engine().setScene(t.key, withPaint(doc, t, paint))
  refresh()
}
const unpreview = (key: string) => {
  draft = null
  readout().set(null)
  const d = documents().get(key)
  if (d) engine().setScene(key, d.history.present)
  refresh()
}

/**
 * A drag that changes the target's paint: `next` gives the paint for the
 * pointer (null for no change yet); `label` names the step, and `select`
 * which index is selected after. `added` commits even without a move (a
 * click that added something).
 */
function paintDrag(d: OpenDoc, t: GTarget, p0: Pointer, next: (p: Pointer) => { paint: Paint; removing?: number; select: number | null; text?: string } | null, label: (removed: boolean) => string, added?: { paint: Paint; select: number | null }): Gesture {
  const doc = d.history.present
  let last: { paint: Paint; removing?: number; select: number | null } | null = added ?? null
  let moved = false
  if (added) preview(t, doc, added.paint)
  return {
    move(p) {
      if (!moved && Math.hypot(p.dx - p0.dx, p.dy - p0.dy) < CLICK) return
      moved = true
      const r = next(p)
      if (!r) return
      last = r
      if (r.text) readout().set({ text: r.text, x: p.dx, y: p.dy })
      preview(t, doc, r.paint, r.removing)
    },
    up() {
      const out = last
      draft = null
      readout().set(null)
      if (!out || (!moved && !added)) {
        unpreview(d.key)
        return
      }
      const removed = out.removing !== undefined
      documents().commit((x) => withPaint(x, t, out.paint), { key: d.key, label: label(removed) })
      gradientSelection.set(t, removed ? null : out.select)
    },
    cancel: () => unpreview(d.key),
  }
}

/** A gradient's line with one end moved to the pointer (Shift: 45° about the other end). */
function endDrag(d: OpenDoc, t: GTarget & { paint: Extract<Paint, { kind: 'gradient' }> }, end: 0 | 1, p0: Pointer): Gesture {
  const l0 = gradientLine(t.paint, t.box)
  return paintDrag(
    d,
    t,
    p0,
    (p) => {
      const other = toDoc(t, end ? [l0[0], l0[1]] : [l0[2], l0[3]])
      let x = p.x
      let y = p.y
      if (p.shiftKey) {
        const a = Math.round(Math.atan2(y - other[1], x - other[0]) / (Math.PI / 4)) * (Math.PI / 4)
        const len = Math.hypot(x - other[0], y - other[1])
        x = other[0] + Math.cos(a) * len
        y = other[1] + Math.sin(a) * len
      }
      const q = applyMat(t.inv, x, y)
      const line: Line = end ? [l0[0], l0[1], q[0], q[1]] : [q[0], q[1], l0[2], l0[3]]
      if (Math.hypot(line[2] - line[0], line[3] - line[1]) < 1e-6) return null
      return { paint: { ...t.paint, line }, select: gradientSelection.of(t) }
    },
    () => 'Move Gradient',
  )
}

/** Stops in order, and where the one at `i` went. */
function sortStops(stops: PaintStop[], i: number): { stops: PaintStop[]; index: number } {
  const moved = stops[i]
  const sorted = [...stops].sort((a, b) => a.at - b.at)
  return { stops: sorted, index: sorted.indexOf(moved) }
}

/** Sliding stop `i` along the line (Alt: a copy); far off the line it goes. `added` is a stop the press just put there. */
function stopDrag(d: OpenDoc, t: GTarget & { paint: Extract<Paint, { kind: 'gradient' }> }, base: Extract<Paint, { kind: 'gradient' }>, i: number, p0: Pointer, added: boolean): Gesture {
  const l = gradientLine(base, t.box)
  const a = toDoc(t, [l[0], l[1]])
  const b = toDoc(t, [l[2], l[3]])
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = Math.max(1e-9, dx * dx + dy * dy)
  const far = docRadius(40)
  return paintDrag(
    d,
    t,
    p0,
    (p) => {
      const s = Math.min(1, Math.max(0, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / l2))
      const off = Math.abs((p.x - a[0]) * dy - (p.y - a[1]) * dx) / Math.sqrt(l2)
      const at = base.reverse ? 1 - s : s
      const copy = p.altKey && !added
      const stops = copy ? [...base.stops, { ...base.stops[i], at }] : base.stops.map((x, j) => (j === i ? { ...x, at } : x))
      const index = copy ? stops.length - 1 : i
      if (off > far && stops.length > 2) {
        // Off the line: it goes when let go (shown gone now).
        return { paint: { ...base, stops: stops.filter((_, j) => j !== index) }, removing: index, select: null, text: 'Delete' }
      }
      const sorted = sortStops(stops, index)
      return { paint: { ...base, stops: sorted.stops }, select: sorted.index, text: `${Math.round(at * 1000) / 10}%` }
    },
    (removed) => (removed ? 'Delete Gradient Stop' : added ? 'Add Gradient Stop' : p0.altKey ? 'Copy Gradient Stop' : 'Move Gradient Stop'),
    added ? { paint: base, select: i } : undefined,
  )
}

/** Moving a freeform point or a mesh point to the pointer; `added` is a paint the press just made (a point added). */
function pointDrag(d: OpenDoc, t: GTarget, base: Paint, i: number, p0: Pointer, label: string): Gesture {
  const start = base.kind === 'freeform' ? base.points[i].p : base.kind === 'mesh' ? base.nodes[i].p : ([0, 0] as Pt)
  const q0 = applyMat(t.inv, p0.x, p0.y)
  return paintDrag(
    d,
    t,
    p0,
    (p) => {
      const q = applyMat(t.inv, p.x, p.y)
      const at: Pt = [start[0] + q[0] - q0[0], start[1] + q[1] - q0[1]]
      if (base.kind === 'freeform') return { paint: { ...base, points: base.points.map((x, j) => (j === i ? { ...x, p: at } : x)) }, select: i }
      if (base.kind === 'mesh') return { paint: { ...base, nodes: base.nodes.map((x, j) => (j === i ? { ...x, p: at } : x)) }, select: i }
      return null
    },
    () => label,
    base !== t.paint ? { paint: base, select: i } : undefined,
  )
}

const fgOf = (doc: Doc, fallback: Paint) => swatchIn(doc, 'fg') ?? mainColour(fallback)

/** A press with the Gradient tool on the selected layer's gradient: what it starts, or undefined when it isn't on it (the tool's own drag then). */
export function gradientEditPress(d: OpenDoc, p: Pointer): Gesture | null | undefined {
  const t = gradientTarget(d)
  if (!t) return undefined
  const h = hitOn(t, p.x, p.y)
  if (!h) {
    if (t.paint.kind === 'gradient') return undefined
    gradientSelection.set(null, null)
    return null
  }
  const doc = d.history.present
  const pt = t.paint
  if (pt.kind === 'gradient') {
    const g = t as GTarget & { paint: Extract<Paint, { kind: 'gradient' }> }
    if (h.kind === 'end') return endDrag(d, g, h.end, p)
    if (h.kind === 'stop') {
      gradientSelection.set(t, h.index)
      return stopDrag(d, g, pt, h.index, p, false)
    }
    if (h.kind === 'line') {
      // A new stop where the press is, in the colour the gradient has there.
      const at = pt.reverse ? 1 - h.s : h.s
      const sorted = sortStops([...pt.stops, stopAt(pt.stops, at)], pt.stops.length)
      return stopDrag(d, g, { ...pt, stops: sorted.stops }, sorted.index, p, true)
    }
    return undefined
  }
  if (pt.kind === 'freeform') {
    if (h.kind === 'point') {
      gradientSelection.set(t, h.index)
      return pointDrag(d, t, pt, h.index, p, 'Move Colour Point')
    }
    if (h.kind === 'inside') {
      const point: FreeformPoint = { p: h.q, colour: fgOf(doc, pt), alpha: 1, spread: 1 }
      if (pt.points.length >= 64) return null
      const next: Paint = { ...pt, points: [...pt.points, point] }
      return pointDrag(d, t, next, next.points.length - 1, p, 'Add Colour Point')
    }
  }
  if (pt.kind === 'mesh' && h.kind === 'node') {
    gradientSelection.set(t, h.index)
    return pointDrag(d, t, pt, h.index, p, 'Move Mesh Point')
  }
  return null
}

/** The colour a new mesh starts with at (u, v) across a box: the paint it had there, or a solid colour with a highlight in the middle. */
function meshFrom(t: GTarget, mode: Doc['mode']): Mesh {
  const p = t.paint
  if (p.kind === 'mesh') return p
  const box = t.box
  return newMesh(box, 1, 1, (u, v) => (p.kind === 'solid' ? { colour: p.colour, alpha: 1 } : paintColourAt(p, mode, box, box[0] + (box[2] - box[0]) * u, box[1] + (box[3] - box[1]) * v)))
}

/** A mesh's row and column through point `index` taken away (not its edges); null when there's nothing to take. */
export function withoutLines(m: Mesh, index: number): Mesh | null {
  const i = index % (m.cols + 1)
  const j = Math.floor(index / (m.cols + 1))
  const dropCol = i > 0 && i < m.cols
  const dropRow = j > 0 && j < m.rows
  if (!dropCol && !dropRow) return null
  const nodes: MeshNode[] = []
  for (let r = 0; r <= m.rows; r++) {
    if (dropRow && r === j) continue
    for (let c = 0; c <= m.cols; c++) if (!(dropCol && c === i)) nodes.push(meshNode(m, c, r))
  }
  return { kind: 'mesh', cols: m.cols - (dropCol ? 1 : 0), rows: m.rows - (dropRow ? 1 : 0), nodes }
}

/** A press with the Mesh tool: on a mesh point, select and move it (Alt: take its lines away); in a patch, add lines; on a shape that isn't a mesh, make it one. */
function meshPress(d: OpenDoc, p: Pointer): Gesture | null {
  const doc = d.history.present
  let any = gradientTarget(d, (x) => x.kind !== 'gradient' || !x.stroke)
  if (!any || !hitOn(any, p.x, p.y)) {
    // A shape under the pointer that isn't the one selected: it's selected, and goes on from there.
    const under = shapeUnder(d, p)
    if (under && under !== d.selected) {
      documents().select(under, d.key)
      const now = documents().get(d.key)
      any = now ? gradientTarget(now, (x) => x.kind !== 'gradient' || !x.stroke) : null
    }
  }
  if (!any) return null
  const t = any.paint.kind === 'mesh' ? any : (gradientTarget(d, (x) => x.kind === 'mesh') ?? any)
  const q = applyMat(t.inv, p.x, p.y)
  const m = meshFrom(t, doc.mode)
  if (t.paint.kind === 'mesh') {
    const h = hitOn(t, p.x, p.y)
    if (h?.kind === 'node') {
      if (p.altKey) {
        const next = withoutLines(t.paint, h.index)
        if (next) {
          documents().commit((x) => withPaint(x, t, next), { key: d.key, label: 'Delete Mesh Lines' })
          gradientSelection.set(t, null)
        }
        return null
      }
      gradientSelection.set(t, h.index)
      return pointDrag(d, t, t.paint, h.index, p, 'Move Mesh Point')
    }
  } else {
    // Only inside the shape's box: a mesh is made over it.
    const b = t.box
    if (q[0] < b[0] || q[0] > b[2] || q[1] < b[1] || q[1] > b[3]) return null
  }
  const at = meshLocate(m, q[0], q[1])
  if (at.out > 0) return null
  const gu = at.i + at.u
  const gv = at.j + at.v
  // Near a line already: only the line across it.
  const near = nearestLines(m, gu, gv)
  const tol = docRadius(GRAB)
  const cellW = Math.hypot(...([0, 1].map((k) => meshNode(m, Math.min(m.cols, at.i + 1), at.j).p[k] - meshNode(m, at.i, at.j).p[k]) as [number, number])) || 1
  const cellH = Math.hypot(...([0, 1].map((k) => meshNode(m, at.i, Math.min(m.rows, at.j + 1)).p[k] - meshNode(m, at.i, at.j).p[k]) as [number, number])) || 1
  const scale = Math.sqrt(Math.abs(t.transform[0] * t.transform[3] - t.transform[1] * t.transform[2])) || 1
  const onRow = near.dv * cellH * scale < tol
  const onCol = near.du * cellW * scale < tol
  const split = splitMesh(m, gu, gv, !onCol, !onRow)
  if (split === m && t.paint.kind === 'mesh') return null
  // The new point at the press, in the foreground colour.
  const fg = fgOf(doc, t.paint)
  let index = -1
  let best = Infinity
  split.nodes.forEach((n, k) => {
    const dd = Math.hypot(n.p[0] - q[0], n.p[1] - q[1])
    if (dd < best) {
      best = dd
      index = k
    }
  })
  const nodes = split.nodes.map((n, k) => (k === index ? { ...n, colour: fg, alpha: 1 } : n))
  const next: Mesh = { ...split, nodes }
  documents().commit((x) => withPaint(x, t, next), { key: d.key, label: t.paint.kind === 'mesh' ? 'Add Mesh Lines' : 'Make Gradient Mesh' })
  gradientSelection.set(t, index)
  return null
}

/** The top shape with paint under the pointer, visible and not locked. */
function shapeUnder(d: OpenDoc, p: Pointer): NodeId | null {
  const doc = d.history.present
  for (const { node } of layerRows(doc)) {
    if ((node.kind !== 'vector' && node.kind !== 'boolean' && node.kind !== 'text') || !node.visible || node.locked.all) continue
    const place = placeOf(doc, node.id)
    if (place && doc.nodes[place.parent]?.kind === 'boolean') continue
    if (shapeHit(doc, node, p.x, p.y, docRadius(2))) return node.id
  }
  return null
}

registerTool('mesh', meshPress)

/** Delete with the Gradient or Mesh tool and a stop or point selected: it goes. Returns whether it did anything. */
export function deleteSelectedGradientPart(): boolean {
  const d = documents().active()
  if (!d || !editing()) return false
  const t = gradientTarget(d)
  const i = gradientSelection.of(t)
  if (!t || i === null) return false
  const p = t.paint
  let next: Paint | null = null
  let label = ''
  if (p.kind === 'gradient' && p.stops.length > 2 && p.stops[i]) {
    next = { ...p, stops: p.stops.filter((_, j) => j !== i) }
    label = 'Delete Gradient Stop'
  } else if (p.kind === 'freeform' && p.points[i]) {
    next = { ...p, points: p.points.filter((_, j) => j !== i) }
    label = 'Delete Colour Point'
  } else if (p.kind === 'mesh' && p.nodes[i]) {
    next = withoutLines(p, i)
    label = 'Delete Mesh Lines'
  }
  if (!next) return false
  const out = next
  documents().commit((x) => withPaint(x, t, out), { key: d.key, label })
  gradientSelection.set(t, null)
  return true
}

/** For the checks: where the selected layer's gradient handles are drawn, in document pixels. */
export function gradientHandlesOf(): { line?: [Pt, Pt]; stops?: Pt[]; points?: Pt[]; nodes?: Pt[] } | null {
  const d = documents().active()
  const t = d ? gradientTarget(d) : null
  if (!t) return null
  const p = t.paint
  if (p.kind === 'gradient') {
    const l = gradientLine(p, t.box)
    return { line: [toDoc(t, [l[0], l[1]]), toDoc(t, [l[2], l[3]])], stops: p.stops.map((s) => stopDoc(t, l, stopPos(p, s.at))) }
  }
  if (p.kind === 'freeform') return { points: p.points.map((q) => toDoc(t, q.p)) }
  if (p.kind === 'mesh') return { nodes: p.nodes.map((n) => toDoc(t, n.p)) }
  return null
}
