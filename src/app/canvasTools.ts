/**
 * The tools that work on the canvas beyond painting and the view: Move,
 * the Marquee, the Lasso, the Magic Wand, Crop, and Free Transform.
 *
 * The canvas (ui/Viewport.tsx) hands each pointer press here as a gesture,
 * with the point in document and device pixels. A gesture shows what it's
 * doing as it goes, through the engine's overlay and, for a move or a
 * transform, through a preview of the document sent straight to the engine,
 * so the canvas follows the pointer without a history step per frame. When
 * it's done it commits once, as one named step.
 *
 * Free Transform, Crop and the Polygonal Lasso outlast a drag: they're
 * sessions, open until Enter commits or Esc cancels (or the document moves
 * on underneath them), and the options bar shows what they're doing.
 */
import { carried, crop, moveBy, rebaseWarps, setTiles, setTransform, transformNode } from '../doc/edit'
import type { Affine, Doc, DocNode, NodeId } from '../doc/types'
import { engine } from '../engine/EngineHost'
import type { SelectShape } from '../engine/selectHost'
import { clearToolOverlay, setToolOverlay } from './overlay'
import { apply, viewMatrix } from '../render/view'
import { ellipsePoints } from '../tiles/coverage'
import { geometryPath } from '../doc/vector'
import { subtree } from '../doc/tree'
import { pathBounds } from '../geom/path'
import { docPathOf } from '../vector/shape'
import { layoutOf } from './text'
import { tools, type ToolId } from '../tools'
import { documents, selectedIds, type OpenDoc } from './documents'
import { addGuides, moveGuide, removeGuide } from '../doc/guides'
import { layersBox } from './bounds'
import { guidePrefs } from './guidePrefs'
import { lengthText, readout } from './readout'
import { startSnap, type Snapper } from './snapping'
import { holdGuide, origins } from './viewAids'
import { sendOverlay } from './overlay'
import { boxOf, type Box } from '../geom/snap'
import { layersAt, topGroupOf } from './pick'
import { moveTool } from './moveTool'
import { docPx } from './snapping'
import { notify } from './notices'
import { hold } from './pixels'
import { deselect, modifySelection, selectShape, wandAt } from './selection'
import { opFor, selectTools } from './selectTools'
import { views } from './views'
import { nearestCopy } from './tiling'
import { patchPress } from './retouch'
import { rotateAbout } from './freeTransform'
export { beginFreeTransform, beginTransformSelection } from './freeTransform'

/** A pointer, in document pixels and the canvas's device pixels, with its keys. */
export interface Pointer {
  x: number
  y: number
  dx: number
  dy: number
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
}

export interface Gesture {
  move(p: Pointer): void
  up(p: Pointer): void
  cancel(): void
}

/** How near a handle a press must be to take it, in device pixels. */
export const GRAB = 9
/** Below this many device pixels a press is a click, not a drag. */
export const CLICK = 3

// The overlay's channels moved to app/overlay.ts; the tools still reach them here.
export { clearToolOverlay, setToolOverlay } from './overlay'

// --- previews ------------------------------------------------------------------------

/** Shows a document that isn't committed (a move or transform in progress) on the canvas. */
const preview = (key: string, doc: Doc) => engine().setScene(key, doc)
/** Puts the committed document back on the canvas. */
const unpreview = (key: string) => {
  const d = documents().get(key)
  if (d) engine().setScene(key, d.history.present)
}

/** Document pixels to the canvas's device pixels, for the front document. */
export function toDevice(): (x: number, y: number) => [number, number] {
  const v = views().front()
  if (!v) return (x, y) => [x, y]
  const m = viewMatrix(v, engine().canvasSize())
  return (x, y) => apply(m, x, y)
}

export const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** Why a node can't be moved, or null. */
export function cantMove(n: DocNode): string | null {
  if (n.locked.all || n.locked.position) return `“${n.name}” is locked in position. Unlock it in the Properties panel.`
  return null
}

// --- sessions ---------------------------------------------------------------------------

export interface Session {
  kind: 'transform' | 'crop' | 'polygon' | 'pen' | 'type' | 'liquify'
  key: string
  /** A press while the session is open: a gesture, or null to leave it to the tool. */
  down(p: Pointer): Gesture | null
  /** The pointer moving with no button down. */
  hover?(p: Pointer): void
  commit(): void
  cancel(): void
  /** For the options bar. */
  readout(): string
  /**
   * Whether a change to the document leaves the session open: the Type
   * tool's edits are its own, committed as it goes. Without this, any
   * change ends the session.
   */
  accepts?(doc: Doc): boolean
}

class Sessions {
  current: Session | null = null
  private listeners = new Set<() => void>()
  /** The document a session started from: if it changes underneath, the session ends. */
  private base: Doc | null = null

  constructor() {
    documents().subscribe(() => {
      const s = this.current
      if (!s) return
      const d = documents().get(s.key)
      if (d && d.history.present !== this.base && documents().getState().active === s.key && s.accepts?.(d.history.present)) {
        this.base = d.history.present
        return
      }
      if (!d || d.history.present !== this.base || documents().getState().active !== s.key) this.end(true)
    })
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  get = () => this.current

  start(s: Session) {
    this.end(true)
    this.current = s
    this.base = documents().get(s.key)?.history.present ?? null
    this.emit()
  }

  /** Ends the session, cancelling it unless it has committed. */
  end(cancel: boolean) {
    const s = this.current
    if (!s) return
    this.current = null
    this.base = null
    if (cancel) s.cancel()
    clearToolOverlay(s.key)
    this.emit()
  }

  commit() {
    const s = this.current
    if (!s) return
    this.current = null
    this.base = null
    s.commit()
    clearToolOverlay(s.key)
    this.emit()
  }

  emit() {
    for (const fn of this.listeners) fn()
  }
}

let sessionStore: Sessions | null = null
export const sessions = () => (sessionStore ??= new Sessions())

// --- Move -----------------------------------------------------------------------------------

/**
 * The layers a move takes: those selected that can move, leaving out any
 * already carried by another (a layer in a selected group goes with the
 * group). Says why when none can.
 */
export function movable(d: OpenDoc, quiet = false): NodeId[] {
  const doc = d.history.present
  const ids = selectedIds(d).filter((id) => !!doc.nodes[id] && id !== doc.root)
  if (!ids.length) {
    if (!quiet) notify('info', 'Select a layer to move.')
    return []
  }
  const ok = ids.filter((id) => !cantMove(doc.nodes[id]))
  if (!ok.length) {
    if (!quiet) notify('info', cantMove(doc.nodes[ids[0]])!)
    return []
  }
  const inside = new Set<NodeId>()
  for (const id of ok) for (const c of carried(doc, id)) if (c !== id) inside.add(c)
  return ok.filter((id) => !inside.has(id))
}

/** `doc` with each of `ids` moved by (dx, dy). */
const moveAll = (doc: Doc, ids: NodeId[], dx: number, dy: number) => ids.reduce((x, id) => moveBy(x, id, dx, dy), doc)

/** The guide within reach of a press, by index: one shown, not locked, nearest first. */
export function guideAt(d: OpenDoc, p: Pointer): number {
  const prefs = guidePrefs().get()
  if (!prefs.guides || prefs.lockGuides) return -1
  const dev = toDevice()
  let best = -1
  let bestD = GRAB
  d.history.present.guides.forEach((g, i) => {
    // The distance on screen from the pointer to the guide's line.
    const a = dev(g.axis === 'x' ? g.at : 0, g.axis === 'y' ? g.at : 0)
    const b = dev(g.axis === 'x' ? g.at : 1, g.axis === 'y' ? g.at : 1)
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const dd = Math.abs((b[0] - a[0]) * (a[1] - p.dy) - (a[0] - p.dx) * (b[1] - a[1])) / len
    if (dd < bestD) {
      bestD = dd
      best = i
    }
  })
  return best
}

/**
 * Dragging a guide: one already there (`index`), or a new one out of a
 * ruler (`index` -1). It snaps to what the layers and the canvas offer;
 * Shift keeps it to whole ruler units. Let go off the canvas (back on a
 * ruler), it's taken away, or never made.
 */
export function guideGesture(d: OpenDoc, axis: 'x' | 'y', index: number, p0: Pointer, outside: (p: Pointer) => boolean): Gesture {
  const doc = d.history.present
  const snap = startSnap(d)
  let at = index >= 0 ? doc.guides[index].at : axis === 'x' ? p0.x : p0.y
  let off = false
  if (index >= 0) {
    holdGuide({ key: d.key, index })
    sendOverlay(d.key)
  }
  const show = () => {
    if (off) clearToolOverlay(d.key)
    else setToolOverlay(d.key, { shapes: [{ kind: 'guide', axis, at }] })
  }
  const done = () => {
    holdGuide(null)
    snap.end()
    readout().set(null)
    clearToolOverlay(d.key)
  }
  const place = (p: Pointer) => {
    off = outside(p)
    const [ox, oy] = origins().get(d.key)
    const raw = axis === 'x' ? p.x : p.y
    const origin = axis === 'x' ? ox : oy
    if (p.shiftKey) {
      // Whole ruler units from the zero point.
      const unit = guidePrefs().get().units
      const per = unit === 'px' ? 1 : doc.resolution / { in: 1, cm: 2.54, mm: 25.4, pt: 72 }[unit]
      at = origin + Math.round((raw - origin) / per) * per
    } else {
      // On whole pixels, as Photoshop's guides are, unless it snapped to something that isn't.
      at = Math.round(snap.along(axis, raw, p, true) * 1000) / 1000
    }
    show()
    readout().set(off ? { text: index >= 0 ? 'Remove guide' : 'No guide', x: p.dx, y: p.dy } : { text: `${axis === 'x' ? 'X' : 'Y'} ${lengthText(at - origin)}`, x: p.dx, y: p.dy })
  }
  place(p0)
  return {
    move: place,
    up(p) {
      place(p)
      done()
      if (off) {
        if (index >= 0) documents().commit((x) => removeGuide(x, index), { key: d.key, label: 'Delete Guide' })
        else sendOverlay(d.key)
        return
      }
      if (index >= 0) documents().commit((x) => moveGuide(x, index, at), { key: d.key, label: 'Move Guide' })
      else documents().commit((x) => addGuides(x, [{ axis, at }]), { key: d.key, label: 'New Guide' })
      if (index >= 0) sendOverlay(d.key)
    },
    cancel() {
      done()
      sendOverlay(d.key)
    },
  }
}

/** Whether a pointer is off the canvas, where letting go of a guide takes it away. */
export const offCanvas = (p: Pointer) => {
  const c = engine().canvasSize()
  return p.dx < 0 || p.dy < 0 || p.dx > c.width || p.dy > c.height
}

/**
 * A press with the Move tool. On a guide, it drags the guide. With
 * Auto-Select on (or Ctrl held with it off, as Photoshop's Ctrl-click), the
 * layer under the pointer is selected first: the topmost, or with Alt the
 * next one down from the layer selected there now (pressing again goes
 * deeper), or with Shift added to what's selected. Then the selected
 * layers move. With nothing under the pointer, the selection stays as it
 * was.
 */
async function movePress(d: OpenDoc, p0: Pointer): Promise<Gesture | null> {
  const doc = d.history.present
  const g = guideAt(d, p0)
  if (g >= 0) return guideGesture(d, doc.guides[g].axis, g, p0, offCanvas)
  const o = moveTool().get()
  if (o.autoSelect !== p0.ctrlKey) {
    let hits = await layersAt(doc, p0.x, p0.y, docPx(GRAB))
    if (o.target === 'group') hits = hits.map((h) => topGroupOf(doc, h)).filter((h, i, a) => a.indexOf(h) === i)
    if (hits.length) {
      const at = d.selected ? hits.indexOf(d.selected) : -1
      const pick = p0.altKey && at >= 0 ? hits[(at + 1) % hits.length] : hits[0]
      const now = documents().get(d.key)
      if (p0.shiftKey && now) documents().toggleSelected(pick, d.key)
      else if (!now || !selectedIds(now).includes(pick) || p0.altKey) documents().select(pick, d.key)
    }
  }
  const now = documents().get(d.key)
  return now ? moveGesture(now, p0) : null
}

function moveGesture(d: OpenDoc, p0: Pointer): Gesture | null {
  const doc = d.history.present
  const ids = movable(d)
  if (!ids.length) return null
  // Whether a whole-pixel move is wanted: anything with pixels in it stays on the pixel grid.
  const whole = ids.some((id) => ['pixel', 'embedded', 'group', 'fill'].includes(doc.nodes[id].kind))
  const snap = startSnap(d, { moving: ids })
  let box0: Box | null = null
  void layersBox(doc, ids).then((b) => (box0 = b))
  let dx = 0
  let dy = 0
  return {
    move(p) {
      let rx = p.x - p0.x
      let ry = p.y - p0.y
      // Shift keeps the move straight across or straight down.
      const lock = p.shiftKey ? (Math.abs(rx) > Math.abs(ry) ? 'y' : 'x') : null
      if (lock === 'y') ry = 0
      if (lock === 'x') rx = 0
      const settle = (ox: number, oy: number): [number, number] => {
        let x = lock === 'x' ? 0 : rx + ox
        let y = lock === 'y' ? 0 : ry + oy
        if (whole) {
          x = Math.round(x)
          y = Math.round(y)
        }
        return [x - rx, y - ry]
      }
      const [sx, sy] = box0 ? snap.box([box0[0] + rx, box0[1] + ry, box0[2] + rx, box0[3] + ry], p, settle) : settle(0, 0)
      dx = rx + sx
      dy = ry + sy
      readout().set({ text: `ΔX ${lengthText(dx)}  ΔY ${lengthText(dy)}`, x: p.dx, y: p.dy })
      preview(d.key, moveAll(doc, ids, dx, dy))
    },
    up() {
      snap.end()
      readout().set(null)
      if (!dx && !dy) return unpreview(d.key)
      documents().commit((x) => moveAll(x, ids, dx, dy), { key: d.key, label: 'Move' })
    },
    cancel() {
      snap.end()
      readout().set(null)
      unpreview(d.key)
    },
  }
}

/** The arrow keys: the selected layer, or with a selection tool the selection, a pixel (Shift: ten) at a time. */
export function nudge(dx: number, dy: number, tool: ToolId) {
  const d = documents().active()
  if (!d) return
  const doc = d.history.present
  if ((tool === 'marquee' || tool === 'lasso' || tool === 'wand' || tool === 'quick') && doc.selection) {
    modifySelection({ kind: 'offset', dx, dy }, 'Nudge Selection')
    return
  }
  if (!d.selected) return
  const ids = movable(d)
  if (!ids.length) return
  documents().commit((x) => moveAll(x, ids, dx, dy), { key: d.key, label: 'Nudge', coalesce: `nudge:${ids.join(',')}` })
}

// --- selections -------------------------------------------------------------------------------

/** Dragging the selection's outline with a selection tool: it moves by whole pixels when let go. */
function moveSelectionGesture(d: OpenDoc, p0: Pointer, bounds: [number, number, number, number]): Gesture {
  let dx = 0
  let dy = 0
  const show = () => {
    const [x0, y0, x1, y1] = bounds
    const box: [number, number][] = [
      [x0 + dx, y0 + dy],
      [x1 + dx, y0 + dy],
      [x1 + dx, y1 + dy],
      [x0 + dx, y1 + dy],
    ]
    setToolOverlay(d.key, { shapes: [{ kind: 'path', points: box, closed: true, style: 'ants' }], hideAnts: true })
  }
  show()
  return {
    move(p) {
      dx = Math.round(p.x - p0.x)
      dy = Math.round(p.y - p0.y)
      show()
    },
    up() {
      clearToolOverlay(d.key)
      if (dx || dy) modifySelection({ kind: 'offset', dx, dy }, 'Move Selection')
    },
    cancel: () => clearToolOverlay(d.key),
  }
}

function marqueeShape(p0: Pointer, p: Pointer, from: { shift: boolean; alt: boolean }): { shape: SelectShape; points: [number, number][] } {
  const o = selectTools().get().marquee
  let w = p.x - p0.x
  let h = p.y - p0.y
  // Shift held after the press makes a square or circle; Alt draws from the centre.
  if (p.shiftKey && !from.shift) {
    const s = Math.max(Math.abs(w), Math.abs(h))
    w = Math.sign(w || 1) * s
    h = Math.sign(h || 1) * s
  }
  let x0 = p0.x
  let y0 = p0.y
  if (p.altKey && !from.alt) {
    x0 -= w
    y0 -= h
    w *= 2
    h *= 2
  }
  // On whole pixels, as Photoshop's marquee is: a rectangle's edges are crisp.
  const r = { x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x0 + w), y1: Math.round(y0 + h) }
  const shape: SelectShape = { kind: o.shape, ...r }
  const points: [number, number][] =
    o.shape === 'rect'
      ? [
          [r.x0, r.y0],
          [r.x1, r.y0],
          [r.x1, r.y1],
          [r.x0, r.y1],
        ]
      : ellipsePoints((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, Math.abs(r.x1 - r.x0) / 2, Math.abs(r.y1 - r.y0) / 2)
  return { shape, points }
}

/**
 * A press with a selection tool, over the selection with no keys held,
 * drags the outline; otherwise it starts the tool's own gesture.
 */
export async function selectionPress(d: OpenDoc, p0: Pointer, make: () => Gesture | null): Promise<Gesture | null> {
  const sel = d.history.present.selection?.tiles
  if (sel && !p0.shiftKey && !p0.altKey && selectTools().get().op === 'replace') {
    const inside = (await engine().call('select.at', { set: sel, x: p0.x, y: p0.y })) >= 0.5
    if (inside) {
      const b = await engine().call('select.bounds', { set: sel })
      if (b) return moveSelectionGesture(d, p0, b)
    }
  }
  return make()
}

function marqueeGesture(d: OpenDoc, raw0: Pointer): Gesture {
  const from = { shift: raw0.shiftKey, alt: raw0.altKey }
  const op = opFor(raw0, selectTools().get().op)
  const snap = startSnap(d)
  const p0 = snapped(snap, raw0)
  snap.end()
  let last = p0
  const show = () => setToolOverlay(d.key, { shapes: [{ kind: 'path', points: marqueeShape(p0, last, from).points, closed: true, style: 'ants' }] })
  return {
    move(p) {
      last = snapped(snap, p)
      show()
    },
    up(raw) {
      const p = snapped(snap, raw)
      snap.end()
      clearToolOverlay(d.key)
      const o = selectTools().get().marquee
      if (Math.hypot(p.dx - p0.dx, p.dy - p0.dy) < CLICK) {
        // A click with nothing held lets the selection go, as in Photoshop.
        if (op === 'replace' && d.history.present.selection) modifyNone(d)
        return
      }
      selectShape(marqueeShape(p0, p, from).shape, op, o, o.shape === 'rect' ? 'Rectangular Marquee' : 'Elliptical Marquee')
    },
    cancel() {
      snap.end()
      clearToolOverlay(d.key)
    },
  }
}

/** A pointer moved to where `snap` puts it, its device position with it. */
export function snapped(snap: Snapper, p: Pointer): Pointer {
  const [x, y] = snap.point(p.x, p.y, p)
  if (x === p.x && y === p.y) return p
  const [dx, dy] = toDevice()(x, y)
  return { ...p, x, y, dx, dy }
}

/** A click with a selection tool and nothing held: Deselect, through the Select menu's path so Reselect remembers. */
function modifyNone(d: OpenDoc) {
  if (documents().getState().active === d.key) deselect()
}

export function lassoGesture(d: OpenDoc, p0: Pointer): Gesture {
  const op = opFor(p0, selectTools().get().op)
  const pts: [number, number][] = [[p0.x, p0.y]]
  let lastDevice: [number, number] = [p0.dx, p0.dy]
  return {
    move(p) {
      // A point a device pixel or more from the last: enough for any curve.
      if (dist([p.dx, p.dy], lastDevice) < 1) return
      lastDevice = [p.dx, p.dy]
      pts.push([p.x, p.y])
      setToolOverlay(d.key, { shapes: [{ kind: 'path', points: pts, closed: false, style: 'ants' }] })
    },
    up() {
      clearToolOverlay(d.key)
      const o = selectTools().get().lasso
      if (pts.length < 3) {
        if (op === 'replace' && d.history.present.selection) modifyNone(d)
        return
      }
      selectShape({ kind: 'polygon', points: pts }, op, o, 'Lasso')
    },
    cancel: () => clearToolOverlay(d.key),
  }
}

/** The Polygonal Lasso: a click for each corner; a click on the first, a double-click or Enter closes it. */
function polygonSession(d: OpenDoc, p0: Pointer): Session {
  const op = opFor(p0, selectTools().get().op)
  const pts: [number, number][] = [[p0.x, p0.y]]
  let hover: [number, number] = [p0.x, p0.y]
  let lastClick = 0
  const show = () => setToolOverlay(d.key, { shapes: [{ kind: 'path', points: [...pts, hover], closed: false, style: 'ants' }] })
  const close = () => sessions().commit()
  show()
  const s: Session = {
    kind: 'polygon',
    key: d.key,
    down(p) {
      const dev = toDevice()
      const now = performance.now()
      const onFirst = pts.length > 2 && dist(dev(...pts[0]), [p.dx, p.dy]) < GRAB
      if (onFirst || (now - lastClick < 350 && pts.length > 2)) {
        close()
        return null
      }
      lastClick = now
      const snap = startSnap(d)
      const q = snapped(snap, p)
      snap.end()
      // In a tiled document, the copy nearest the last corner: the shape stays whole over a seam.
      pts.push(nearestCopy(d.history.present, [q.x, q.y], pts[pts.length - 1]))
      show()
      return { move: (q) => s.hover!(q), up: () => {}, cancel: () => {} }
    },
    hover(p) {
      hover = nearestCopy(d.history.present, [p.x, p.y], pts[pts.length - 1])
      show()
    },
    commit() {
      if (pts.length > 2) selectShape({ kind: 'polygon', points: pts }, op, selectTools().get().lasso, 'Polygonal Lasso')
    },
    cancel() {},
    readout: () => `${pts.length} ${pts.length === 1 ? 'corner' : 'corners'}. Click the first corner, double-click or press Enter to close; Esc cancels.`,
  }
  return s
}

// --- Free Transform ---------------------------------------------------------------------------

/**
 * The box a node is transformed by: for a pixel layer its pixels' bounds in
 * its own pixels, with its transform as the frame; for anything else the
 * document rectangle around the pixel layers in it.
 */
export async function transformBox(doc: Doc, node: DocNode): Promise<{ frame: Affine; box: [number, number, number, number] } | null> {
  if (node.kind === 'pixel') {
    if (!node.props.tiles) return null
    const box = await engine().call('tiles.alphaBounds', { set: node.props.tiles })
    return box ? { frame: [...node.transform] as Affine, box } : null
  }
  // A smart object's box is its contents' canvas, in its own frame.
  if (node.kind === 'embedded') return node.props.content ? { frame: [...node.transform] as Affine, box: [0, 0, node.props.content.width, node.props.content.height] } : null
  // A shape's is its path's, in its own frame; a compound's, its outline's.
  if (node.kind === 'vector') {
    const b = node.props.geometry ? pathBounds(geometryPath(node.props.geometry)) : null
    return b ? { frame: [...node.transform] as Affine, box: b } : null
  }
  // A fill layer's is the canvas, in its own frame: it has no edge of its own.
  if (node.kind === 'fill') return { frame: [...node.transform] as Affine, box: [0, 0, doc.width, doc.height] }
  // Text's box is its glyphs' (or its frame's, for area text), in its own frame.
  if (node.kind === 'text') {
    const l = layoutOf(node, doc)
    const b = node.props.mode === 'area' && node.props.frame ? pathBounds(geometryPath(node.props.frame)) : (l?.bounds ?? null)
    return b ? { frame: [...node.transform] as Affine, box: b } : null
  }
  if (node.kind === 'boolean') {
    const path = docPathOf((id) => doc.nodes[id], node)
    const b = path ? pathBounds(path) : null
    return b ? { frame: [1, 0, 0, 1, 0, 0], box: b } : null
  }
  let r: [number, number, number, number] | null = null
  const visit = async (id: NodeId) => {
    const n = doc.nodes[id]
    if (!n) return
    if (n.kind === 'pixel' && n.props.tiles) {
      const b = await engine().call('tiles.alphaBounds', { set: n.props.tiles })
      if (b) {
        const t = n.transform
        for (const [x, y] of [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]]) {
          const px = t[0] * x + t[2] * y + t[4]
          const py = t[1] * x + t[3] * y + t[5]
          r = r ? [Math.min(r[0], px), Math.min(r[1], py), Math.max(r[2], px), Math.max(r[3], py)] : [px, py, px, py]
        }
      }
    }
    for (const c of n.children ?? []) await visit(c)
  }
  await visit(node.id)
  return r ? { frame: [1, 0, 0, 1, 0, 0], box: r } : null
}

/** Flips or turns the selected layer about its middle: in Free Transform, its box's. */
export async function transformBy(kind: 'flip-h' | 'flip-v' | 'cw' | 'ccw' | '180') {
  const d = documents().active()
  if (!d) return
  const doc = d.history.present
  const node = d.selected ? doc.nodes[d.selected] : null
  if (!node) return
  const why = cantMove(node)
  if (why) return notify('info', why)
  const fb = await transformBox(doc, node)
  if (!fb) return
  const [x0, y0, x1, y1] = fb.box
  const [cx, cy] = apply(fb.frame, (x0 + x1) / 2, (y0 + y1) / 2)
  const op: Record<typeof kind, Affine> = {
    'flip-h': [-1, 0, 0, 1, 2 * cx, 0],
    'flip-v': [1, 0, 0, -1, 0, 2 * cy],
    cw: rotateAbout(cx, cy, Math.PI / 2),
    ccw: rotateAbout(cx, cy, -Math.PI / 2),
    '180': rotateAbout(cx, cy, Math.PI),
  }
  const labels = { 'flip-h': 'Flip Horizontal', 'flip-v': 'Flip Vertical', cw: 'Rotate 90° Clockwise', ccw: 'Rotate 90° Counter Clockwise', '180': 'Rotate 180°' }
  documents().commit((x) => transformNode(x, node.id, op[kind]), { key: d.key, label: labels[kind] })
}

/** Rasterize: the selected pixel layer's transform baked into its pixels, or a smart object made a pixel layer of what it shows. */
export async function rasterize() {
  const d = documents().active()
  if (!d) return
  const node = d.selected ? d.history.present.nodes[d.selected] : null
  if (!node || !['pixel', 'embedded', 'vector', 'boolean', 'text', 'fill'].includes(node.kind)) return notify('info', 'Rasterize works on a pixel layer, a smart object, a shape, text or a fill layer.')
  if (node.kind === 'pixel' && node.transform.every((v, i) => v === [1, 0, 0, 1, 0, 0][i])) return notify('info', `“${node.name}” has no transform to bake in.`)
  try {
    const set = await engine().call('render.rasterize', { key: d.key, node: node.id })
    const release = set ? hold([set]) : () => {}
    if (node.kind === 'embedded' || node.kind === 'vector' || node.kind === 'boolean' || node.kind === 'text' || node.kind === 'fill') {
      // The same layer, its kind changed: its masks, effects, style and clipped layers stay. A compound's shapes go.
      const operands = node.kind === 'boolean' ? (node.children ?? []).flatMap((c) => subtree(d.history.present, c)) : []
      const pixel = { ...node, kind: 'pixel', transform: [1, 0, 0, 1, 0, 0], props: { tiles: set, resample: 'bicubic' }, ...(operands.length ? { children: [] } : {}) } as unknown as DocNode
      documents().commit(
        (x) => {
          const nodes = { ...x.nodes, [node.id]: pixel }
          for (const id of operands) delete nodes[id]
          // Its warps stay where they were: their coordinates were the node's, now the document's.
          return rebaseWarps({ ...x, nodes }, node.id, node.transform)
        },
        { key: d.key, label: 'Rasterize' },
      )
    } else documents().commit((x) => rebaseWarps(setTransform(setTiles(x, node.id, set), node.id, [1, 0, 0, 1, 0, 0]), node.id, node.transform), { key: d.key, label: 'Rasterize' })
    release()
  } catch (e) {
    notify('error', 'Rasterize didn’t work.', [e instanceof Error ? e.message : String(e)])
  }
}

// --- Crop ---------------------------------------------------------------------------------------

interface CropBox {
  /** Its centre, size and turn (radians), in document pixels. */
  cx: number
  cy: number
  w: number
  h: number
  a: number
}

const cropCorners = (c: CropBox): [number, number][] => {
  const cos = Math.cos(c.a)
  const sin = Math.sin(c.a)
  return [
    [-c.w / 2, -c.h / 2],
    [c.w / 2, -c.h / 2],
    [c.w / 2, c.h / 2],
    [-c.w / 2, c.h / 2],
  ].map(([x, y]) => [c.cx + x * cos - y * sin, c.cy + x * sin + y * cos])
}

/** Crop's session: the box, shaded outside, with handles; Enter crops. */
function cropSession(d: OpenDoc, start: CropBox): Session {
  const c = { ...start }
  const show = () => {
    const q = cropCorners(c)
    const mids = q.map((p, i) => {
      const n = q[(i + 1) % 4]
      return [(p[0] + n[0]) / 2, (p[1] + n[1]) / 2] as [number, number]
    })
    setToolOverlay(d.key, { shade: q, shapes: [{ kind: 'path', points: q, closed: true, style: 'line' }, { kind: 'handles', points: [...q, ...mids] }], hideAnts: true })
  }
  show()
  const local = (x: number, y: number, b: CropBox) => {
    const cos = Math.cos(-b.a)
    const sin = Math.sin(-b.a)
    const dx = x - b.cx
    const dy = y - b.cy
    return [dx * cos - dy * sin, dx * sin + dy * cos]
  }
  const s: Session = {
    kind: 'crop',
    key: d.key,
    down(p0) {
      const dev = toDevice()
      const b0 = { ...c }
      const q = cropCorners(b0)
      const pts = [...q, ...q.map((p, i) => [(p[0] + q[(i + 1) % 4][0]) / 2, (p[1] + q[(i + 1) % 4][1]) / 2] as [number, number])]
      const hit = pts.findIndex((p) => dist(dev(...p), [p0.dx, p0.dy]) < GRAB)
      const [lx, ly] = local(p0.x, p0.y, b0)
      const inside = Math.abs(lx) <= b0.w / 2 && Math.abs(ly) <= b0.h / 2
      const snap = startSnap(d)
      if (hit >= 0) {
        // Which edges the handle moves: −1 the left (or top), 1 the right (or bottom), 0 neither.
        const ex = [-1, 1, 1, -1, 0, 1, 0, -1][hit]
        const ey = [-1, -1, 1, 1, -1, 0, 1, 0][hit]
        return {
          up: () => snap.end(),
          cancel: () => snap.end(),
          move(raw) {
            const p = snapped(snap, raw)
            const [qx, qy] = local(p.x, p.y, b0)
            let left = -b0.w / 2
            let right = b0.w / 2
            let top = -b0.h / 2
            let bottom = b0.h / 2
            if (ex < 0) left = Math.min(qx, right - 1)
            if (ex > 0) right = Math.max(qx, left + 1)
            if (ey < 0) top = Math.min(qy, bottom - 1)
            if (ey > 0) bottom = Math.max(qy, top + 1)
            const mx = (left + right) / 2
            const my = (top + bottom) / 2
            const cos = Math.cos(b0.a)
            const sin = Math.sin(b0.a)
            Object.assign(c, { cx: b0.cx + mx * cos - my * sin, cy: b0.cy + mx * sin + my * cos, w: right - left, h: bottom - top })
            show()
          },
        }
      }
      if (inside) {
        const box0 = boxOf(q)!
        return {
          up: () => snap.end(),
          cancel: () => snap.end(),
          move(p) {
            const dx = p.x - p0.x
            const dy = p.y - p0.y
            const [sx, sy] = snap.box([box0[0] + dx, box0[1] + dy, box0[2] + dx, box0[3] + dy], p)
            c.cx = b0.cx + dx + sx
            c.cy = b0.cy + dy + sy
            show()
          },
        }
      }
      snap.end()
      // Outside: turn the box (straighten); Shift in 15° steps.
      const a0 = Math.atan2(p0.y - b0.cy, p0.x - b0.cx)
      return {
        move(p) {
          let a = b0.a + Math.atan2(p.y - b0.cy, p.x - b0.cx) - a0
          if (p.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12)
          c.a = a
          show()
        },
        up() {},
        cancel() {},
      }
    },
    commit() {
      const [x, y] = cropCorners(c)[0]
      const w = Math.max(1, Math.round(c.w))
      const h = Math.max(1, Math.round(c.h))
      documents().commit((doc) => crop(doc, { x, y, width: w, height: h, angle: (c.a * 180) / Math.PI }), { key: d.key, label: 'Crop' })
    },
    cancel() {},
    readout: () => `${Math.round(c.w)} × ${Math.round(c.h)} px${c.a ? `, turned ${((c.a * 180) / Math.PI).toFixed(1)}°` : ''}. Drag a handle to resize, inside to move, outside to straighten. Enter crops; Esc cancels.`,
  }
  return s
}

/** The Crop tool chosen: a box round the whole canvas to start from. */
export function startCrop() {
  const d = documents().active()
  if (!d) return
  const s = sessions().get()
  if (s?.kind === 'crop' && s.key === d.key) return
  const doc = d.history.present
  sessions().start(cropSession(d, { cx: doc.width / 2, cy: doc.height / 2, w: doc.width, h: doc.height, a: 0 }))
}

/** Document → Crop: to the selection's bounds. */
export async function cropToSelection() {
  const d = documents().active()
  const sel = d?.history.present.selection?.tiles
  if (!d || !sel) return
  const b = await engine().call('select.bounds', { set: sel })
  if (!b) return
  documents().commit((doc) => crop(doc, { x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1], angle: 0 }), { key: d.key, label: 'Crop' })
}

// --- the press -------------------------------------------------------------------------------------

/**
 * A press on the canvas with `tool` (not painting, the picker or the view
 * tools): the gesture it starts, or null. Async where it has to ask the
 * engine first (whether the press is inside the selection).
 */
export async function pressTool(tool: ToolId, p: Pointer): Promise<Gesture | null> {
  const d = documents().active()
  if (!d) return null
  if (capture) return capture(p)
  const s = sessions().get()
  if (s && s.key === d.key) {
    const g = s.down(p)
    if (g) return g
    // The Polygonal Lasso's session takes its own clicks; the Type tool's lets a press outside its text go on to the tool.
    if (s.kind === 'type' ? sessions().get() === s : s.kind !== 'polygon' || sessions().get() !== s) return null
  }
  switch (tool) {
    case 'move':
      return movePress(d, p)
    case 'marquee':
      return selectionPress(d, p, () => marqueeGesture(d, p))
    case 'lasso':
      if (selectTools().get().lasso.mode === 'magnetic' && magnetic) {
        const start = magnetic
        return selectionPress(d, p, () => {
          start(d, p)
          return null
        })
      }
      if (selectTools().get().lasso.mode === 'polygonal') {
        return selectionPress(d, p, () => {
          sessions().start(polygonSession(d, p))
          return null
        })
      }
      return selectionPress(d, p, () => lassoGesture(d, p))
    case 'wand':
      return selectionPress(d, p, () => {
        wandAt(p.x, p.y, opFor(p, selectTools().get().op))
        return null
      })
    case 'crop':
      startCrop()
      return sessions().get()?.down(p) ?? null
    case 'patch':
      return patchPress(d, p)
    default:
      return PRESSES.get(tool)?.(d, p) ?? null
  }
}

/** Tools whose presses are handled elsewhere (app/vectors.ts, app/toolGestures.ts), registered when those load. */
const PRESSES = new Map<ToolId, (d: OpenDoc, p: Pointer) => Gesture | null>()
export function registerTool(tool: ToolId, press: (d: OpenDoc, p: Pointer) => Gesture | null) {
  PRESSES.set(tool, press)
}

/**
 * A floating dialog's hold on the canvas (Colour Range's eyedropper, Select
 * and Mask's refine brush): while it's set, every press is the dialog's,
 * whatever the tool.
 */
let capture: ((p: Pointer) => Gesture | null) | null = null
export function setCanvasCapture(fn: ((p: Pointer) => Gesture | null) | null) {
  capture = fn
}
export const canvasCaptured = () => capture !== null

/** The Magnetic Lasso's first click, which starts its session (app/toolGestures.ts). */
let magnetic: ((d: OpenDoc, p: Pointer) => void) | null = null
export function registerMagnetic(start: (d: OpenDoc, p: Pointer) => void) {
  magnetic = start
}

/** The pointer moving with no button down: the Polygonal Lasso's rubber band. */
export function hoverTool(p: Pointer) {
  const s = sessions().get()
  if (s?.hover && s.key === documents().getState().active) return s.hover(p)
  HOVERS.get(tools().get())?.(p)
}

/** What a tool shows as the pointer moves with no button down (Quick Selection's brush), registered with its press. */
const HOVERS = new Map<ToolId, (p: Pointer) => void>()
export function registerHover(tool: ToolId, hover: (p: Pointer) => void) {
  HOVERS.set(tool, hover)
}

// Choosing Crop shows its box at once; leaving Crop or the Lasso lets their sessions go.
tools().subscribe(() => {
  const t = tools().get()
  const s = sessions().get()
  if (s && ((s.kind === 'crop' && t !== 'crop') || (s.kind === 'polygon' && t !== 'lasso'))) sessions().end(true)
  if (t === 'crop') startCrop()
})
