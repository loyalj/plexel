/**
 * The freehand vector tools (N), as Illustrator's: the Pencil draws a path
 * as the hand goes, stroked; the Paintbrush the same, stroked with the
 * chosen vector brush; the Blob Brush paints filled shapes that join the
 * shapes of the same colour they touch. Each stroke is one step.
 *
 * The Pencil and the Paintbrush redraw the selected path when a stroke
 * starts (and ends) near it, as Illustrator's "Edit selected paths": the
 * part between is replaced, or an open path is carried on from its end.
 * A stroke that ends near where it started closes (the Pencil's "close
 * paths when ends are near"). Fidelity is how smooth the curve is, in
 * screen pixels, so it feels the same at any zoom.
 */
import { addVector, invertAffine, removeNode, setGeometry, setTransform } from '../doc/edit'
import { freshName } from '../doc/tree'
import type { Affine, Doc, DocNode, NodeId } from '../doc/types'
import { fillItem, geometryPath, solid, strokeItem, type AppearanceItem } from '../doc/vector'
import { booleanPaths } from '../geom/boolean'
import { extendSubpath, fitFreehand, nearestOnSubpath, spliceSubpath } from '../geom/freehand'
import { anchor, applyMat, pathBounds, transformPath, type PathData, type Pt } from '../geom/path'
import { simplifyPath } from '../geom/regions'
import { strokeOutline } from '../geom/stroke'
import { engine } from '../engine/EngineHost'
import { viewMatrix } from '../render/view'
import { Listeners } from '../lib/listeners'
import { tools, type ToolId } from '../tools'
import { CLICK, clearToolOverlay, registerTool, setToolOverlay, type Gesture, type Pointer } from './canvasTools'
import { swatchIn } from './colour'
import { documents, newId, selectedIds, type OpenDoc } from './documents'
import { views } from './views'
import { brushById } from './vectorBrushes'
import { whereNew } from '../doc/tree'

// --- settings ------------------------------------------------------------------------------------

export interface FreehandSettings {
  /** How smooth: the most a curve strays from the hand, in screen pixels (1 accurate, 10 smooth). */
  fidelity: number
  /** The Pencil's and Paintbrush's stroke width, px. */
  width: number
  /** New Pencil and Paintbrush paths filled (with the background colour) too. */
  fillNew: boolean
  /** A stroke ending near its start closes. */
  close: boolean
  /** A stroke starting near the selected path redraws it. */
  editSelected: boolean
  /** The new path stays selected (and so the next stroke near it redraws it). */
  keepSelected: boolean
  /** The Paintbrush's brush, by id; null for a plain stroke. */
  brush: string | null
  /** The Blob Brush's diameter, px. */
  blobSize: number
  /** The Blob Brush joins only selected shapes. */
  mergeSelected: boolean
}

const KEY = 'plexel.freehand.v1'
const DEFAULTS: FreehandSettings = { fidelity: 4, width: 4, fillNew: false, close: true, editSelected: true, keepSelected: false, brush: 'builtin:taper', blobSize: 20, mergeSelected: false }

function read(raw: unknown): FreehandSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS }
  const r = raw as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  return {
    fidelity: num(r.fidelity, 0.5, 20, DEFAULTS.fidelity),
    width: num(r.width, 0.1, 1000, DEFAULTS.width),
    fillNew: bool(r.fillNew, DEFAULTS.fillNew),
    close: bool(r.close, DEFAULTS.close),
    editSelected: bool(r.editSelected, DEFAULTS.editSelected),
    keepSelected: bool(r.keepSelected, DEFAULTS.keepSelected),
    brush: typeof r.brush === 'string' ? r.brush : r.brush === null ? null : DEFAULTS.brush,
    blobSize: num(r.blobSize, 1, 2000, DEFAULTS.blobSize),
    mergeSelected: bool(r.mergeSelected, DEFAULTS.mergeSelected),
  }
}

class FreehandStore {
  private s: FreehandSettings
  private changes = new Listeners()
  constructor() {
    let raw: unknown = null
    try {
      raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    } catch {
      raw = null
    }
    this.s = read(raw)
  }
  get = () => this.s
  subscribe = (fn: () => void) => this.changes.subscribe(fn)
  update(patch: Partial<FreehandSettings>) {
    this.s = read({ ...this.s, ...patch })
    try {
      localStorage.setItem(KEY, JSON.stringify(this.s))
    } catch {
      // Kept for this visit only.
    }
    this.changes.emit()
  }
}
let store: FreehandStore | null = null
export const freehand = () => (store ??= new FreehandStore())

// --- helpers -------------------------------------------------------------------------------------

/** Document pixels per screen pixel at the front view's zoom. */
function perScreenPx(): number {
  const v = views().front()
  if (!v) return 1
  const m = viewMatrix(v, engine().canvasSize())
  return 1 / (Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1)
}

const colourIn = (doc: Doc, which: 'fg' | 'bg') => swatchIn(doc, which) ?? (doc.mode === 'cmyk' ? (which === 'fg' ? [0, 0, 0, 1] : [0, 0, 0, 0]) : doc.mode === 'gray' ? [which === 'fg' ? 0 : 1] : which === 'fg' ? [0, 0, 0] : [1, 1, 1])

/** Where a new layer goes (doc/tree.ts): above the selected one, or into the artboard it's drawn on. */
const newLayerPlace = (doc: Doc, selected: NodeId | null, at?: [number, number] | null) => whereNew(doc, selected, at)

/** How near (screen pixels) a stroke must start to the selected path to redraw it, or to its start to close. */
const NEAR = 12

/** A stroke drawn on the canvas: its points, shown as a line as it goes. */
function strokeGesture(d: OpenDoc, p0: Pointer, done: (pts: Pt[], p: Pointer) => void, show?: (pts: Pt[]) => void): Gesture {
  const pts: Pt[] = [[p0.x, p0.y]]
  let last: [number, number] = [p0.dx, p0.dy]
  let moved = false
  const draw = () => (show ? show(pts) : setToolOverlay(d.key, { shapes: [{ kind: 'path', points: pts as [number, number][], closed: false, style: 'thin' }] }))
  return {
    move(p) {
      if (Math.hypot(p.dx - last[0], p.dy - last[1]) < 1.5) return
      if (!moved && Math.hypot(p.dx - p0.dx, p.dy - p0.dy) < CLICK) return
      moved = true
      last = [p.dx, p.dy]
      pts.push([p.x, p.y])
      draw()
    },
    up(p) {
      clearToolOverlay(d.key)
      if (moved) {
        pts.push([p.x, p.y])
        done(pts, p)
      }
    },
    cancel() {
      clearToolOverlay(d.key)
      const now = documents().get(d.key)
      if (now) engine().setScene(d.key, now.history.present)
    },
  }
}

// --- the Pencil and the Paintbrush -------------------------------------------------------------------

/** The selected path a stroke redraws (in the path's own coordinates), or null to draw a new one. */
function redrawn(d: OpenDoc, pts: Pt[], tol: number): { node: DocNode & { kind: 'vector' }; path: PathData } | null {
  const s = freehand().get()
  if (!s.editSelected || !d.selected) return null
  const n = d.history.present.nodes[d.selected]
  if (n?.kind !== 'vector' || !n.props.geometry || n.locked.all) return null
  const path = geometryPath(n.props.geometry)
  const inv = invertAffine(n.transform)
  const local = pts.map((p) => applyMat(inv, p[0], p[1]))
  const k = Math.sqrt(Math.abs(n.transform[0] * n.transform[3] - n.transform[1] * n.transform[2])) || 1
  const near = (NEAR * perScreenPx()) / k
  const a = local[0]
  const b = local[local.length - 1]
  for (let si = 0; si < path.subpaths.length; si++) {
    const sub = path.subpaths[si]
    const from = nearestOnSubpath(sub, a[0], a[1])
    if (!from || from.dist > near) continue
    const to = nearestOnSubpath(sub, b[0], b[1])
    const drawn = fitFreehand(local, tol / k, false).anchors
    let next = sub
    if (to && to.dist <= near && Math.hypot(a[0] - b[0], a[1] - b[1]) > near) next = spliceSubpath(sub, from, to, drawn)
    else if (!sub.closed) {
      // Drawn on from an end.
      const segCount = sub.anchors.length - 1
      const atStart = from.seg === 0 && from.t < 0.05
      const atEnd = from.seg === segCount - 1 && from.t > 0.95
      if (!atStart && !atEnd) continue
      next = extendSubpath(sub, atEnd, drawn)
    } else continue
    return { node: n, path: { ...path, subpaths: path.subpaths.map((x, i) => (i === si ? next : x)) } }
  }
  return null
}

function linePress(tool: 'pencil' | 'vbrush') {
  return (d: OpenDoc, p0: Pointer): Gesture =>
    strokeGesture(d, p0, (pts) => {
      const s = freehand().get()
      const tol = s.fidelity * perScreenPx()
      const re = redrawn(d, pts, tol)
      if (re) {
        documents().commit((x) => setGeometry(x, re.node.id, { kind: 'path', path: re.path }), { key: d.key, label: 'Reshape Path' })
        return
      }
      const doc = d.history.present
      const a = pts[0]
      const b = pts[pts.length - 1]
      const closed = s.close && pts.length > 8 && Math.hypot(a[0] - b[0], a[1] - b[1]) < NEAR * perScreenPx()
      const sub = fitFreehand(pts, tol, closed)
      if (sub.anchors.length < 2) return
      const stroke = { ...strokeItem(solid(colourIn(doc, 'fg')), s.width), join: 'round' as const, cap: 'round' as const }
      const brush = tool === 'vbrush' && s.brush ? brushById(doc, s.brush) : null
      const items: AppearanceItem[] = []
      if (s.fillNew) items.push(fillItem(solid(colourIn(doc, 'bg'))))
      items.push(brush ? { ...stroke, brush } : stroke)
      const id = newId('n')
      const { parent, index } = newLayerPlace(doc, d.selected, sub.anchors[0]?.p ?? null)
      const name = tool === 'vbrush' ? (brush?.name ?? 'Brush Stroke') : 'Pencil'
      documents().commit((x) => addVector(x, id, freshName(x, name), { kind: 'path', path: { fillRule: 'nonzero', subpaths: [sub] } }, items, parent, index), { key: d.key, label: tool === 'vbrush' ? 'Paintbrush' : 'Pencil' })
      if (s.keepSelected) documents().select(id, d.key)
    })
}

// --- the Blob Brush ------------------------------------------------------------------------------

/** A stroke's outline at the Blob Brush's size: round ends and corners. */
function blobOutline(pts: Pt[], size: number, tol: number): PathData {
  const flat: number[] = []
  for (const p of pts) flat.push(p[0], p[1])
  const loops = strokeOutline([{ pts: flat, closed: false }], { width: size, join: 'round', cap: 'round', miter: 4, dash: [], dashOffset: 0 }, Math.max(0.05, tol / 4))
  return { fillRule: 'nonzero', subpaths: loops.filter((l) => l.length >= 6).map((l) => ({ closed: true, anchors: Array.from({ length: l.length / 2 }, (_, i) => anchor(l[2 * i], l[2 * i + 1])) })) }
}

const sameColour = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-3)

/** Whether a node is a blob the Blob Brush joins: a plain shape with one fill of this colour and no stroke. */
function joinable(n: DocNode | undefined, colour: number[]): n is DocNode & { kind: 'vector' } {
  if (n?.kind !== 'vector' || !n.visible || n.locked.all || !n.props.geometry) return false
  const on = n.props.appearance.filter((it) => it.enabled)
  return on.length === 1 && on[0].kind === 'fill' && on[0].paint.kind === 'solid' && !on[0].effects?.length && sameColour(on[0].paint.colour, colour) && n.masks.length === 0 && n.fx.length === 0
}

function overlaps(a: [number, number, number, number] | null, b: [number, number, number, number] | null) {
  return !!a && !!b && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}

function blobPress(d: OpenDoc, p0: Pointer): Gesture {
  const s = freehand().get()
  const doc0 = d.history.present
  const colour = colourIn(doc0, 'fg')
  const tol = s.fidelity * perScreenPx()
  const previewId = newId('blob')
  const { parent, index } = newLayerPlace(doc0, d.selected, [p0.x, p0.y])
  return strokeGesture(
    d,
    p0,
    (pts) => {
      const blob = blobOutline(pts, s.blobSize, tol)
      if (!blob.subpaths.length) {
        engine().setScene(d.key, d.history.present)
        return
      }
      const doc = d.history.present
      const box = pathBounds(blob)
      // The blobs it touches: shapes of its colour beside it, in the same group (only the selected ones, if asked).
      const chosen = new Set(selectedIds(d))
      const siblings = (doc.nodes[parent].children ?? []).map((c) => doc.nodes[c]).filter((n): n is DocNode & { kind: 'vector' } => joinable(n, colour) && (!s.mergeSelected || chosen.has(n.id)))
      const touching = siblings.filter((n) => overlaps(pathBounds(geometryPath(n.props.geometry), n.transform), box))
      const operands = [...touching.map((n) => ({ path: transformPath(geometryPath(n.props.geometry), n.transform), op: 'add' as const })), { path: blob, op: 'add' as const }]
      const united = booleanPaths(operands)
      const smooth = simplifyPath(united, Math.max(0.1, tol / 2), 70)
      if (!touching.length) {
        const id = newId('n')
        documents().commit((x) => addVector(x, id, freshName(x, 'Blob'), { kind: 'path', path: smooth }, [fillItem(solid(colour))], parent, index), { key: d.key, label: 'Blob Brush' })
        return
      }
      // Joined into the topmost it touches; the rest go.
      const kids = doc.nodes[parent].children ?? []
      const top = touching.reduce((a, b) => (kids.indexOf(b.id) > kids.indexOf(a.id) ? b : a))
      documents().commit(
        (x) => {
          let y = setTransform(x, top.id, [1, 0, 0, 1, 0, 0] as Affine)
          y = setGeometry(y, top.id, { kind: 'path', path: smooth })
          for (const n of touching) if (n.id !== top.id) y = removeNode(y, n.id)
          return y
        },
        { key: d.key, label: 'Blob Brush' },
      )
    },
    // Shown as it's painted: the stroke's outline as a shape of its own, not committed.
    (pts) => {
      const blob = blobOutline(pts, s.blobSize, tol)
      const now = documents().get(d.key)
      if (now) engine().setScene(d.key, addVector(now.history.present, previewId, 'Blob', { kind: 'path', path: blob }, [fillItem(solid(colour))], parent, Math.min(index, now.history.present.nodes[parent].children?.length ?? 0)))
    },
  )
}

registerTool('pencil', linePress('pencil'))
registerTool('vbrush', linePress('vbrush'))
registerTool('blob', blobPress)

/** For the options bar: whether a tool is one of these. */
export const FREEHAND_TOOLS = new Set<ToolId>(['pencil', 'vbrush', 'blob'])
export const isFreehand = () => FREEHAND_TOOLS.has(tools().get())
