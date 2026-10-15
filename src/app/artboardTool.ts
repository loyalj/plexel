/**
 * The Artboard tool (V, with Move, as in Photoshop): draw an artboard on
 * the pasteboard, drag one to move it with its layers (Shift keeps it
 * straight), drag a handle of the selected one to size it (its layers stay
 * put), click one to select it. Its options (the size, presets, Add
 * Artboard) are in the options bar (ui/OptionsBar.tsx); the artboards'
 * names over the canvas (ui/ArtboardLabels.tsx) move them with any tool.
 */
import { artboardAt, artboardRect, artboardsOf, isArtboard, makeArtboard, nextArtboardName, addArtboard, setArtboardRect, type ArtboardNode } from '../doc/artboards'
import type { Doc, NodeId } from '../doc/types'
import { engine } from '../engine/EngineHost'
import { tools } from '../tools'
import { commitArtboards, moveArtboardBy } from './artboards'
import { CLICK, GRAB, clearToolOverlay, registerTool, setToolOverlay, type Gesture, type Pointer } from './canvasTools'
import { documents, newId, type OpenDoc } from './documents'
import { setOverlayDoc } from './overlay'
import { lengthText, readout } from './readout'
import { docPx } from './snapping'

const preview = (key: string, doc: Doc) => {
  engine().setScene(key, doc)
  setOverlayDoc(key, doc)
}
const unpreview = (key: string) => {
  const d = documents().get(key)
  if (d) engine().setScene(key, d.history.present)
  setOverlayDoc(key, null)
}

/** The selected artboard, or the one the selected layer is on. */
function selectedArtboard(d: OpenDoc): ArtboardNode | null {
  const doc = d.history.present
  const n = d.selected ? doc.nodes[d.selected] : null
  return isArtboard(n) ? n : null
}

/** An artboard's eight handles, corners first, in document pixels. */
function handlesOf(r: [number, number, number, number]): [number, number][] {
  const [x0, y0, x1, y1] = r
  const mx = (x0 + x1) / 2
  const my = (y0 + y1) / 2
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [mx, y0],
    [x1, my],
    [mx, y1],
    [x0, my],
  ]
}

/** Which sides a handle moves: left, top, right, bottom. */
const SIDES: [boolean, boolean, boolean, boolean][] = [
  [true, true, false, false],
  [false, true, true, false],
  [false, false, true, true],
  [true, false, false, true],
  [false, true, false, false],
  [false, false, true, false],
  [false, false, false, true],
  [true, false, false, false],
]

/** Shows the selected artboard's outline and handles while the tool is in use. */
export function refreshArtboardOverlay() {
  const d = documents().active()
  if (!d) return
  if (tools().get() !== 'artboard') return
  const a = selectedArtboard(d)
  if (!a) return clearToolOverlay(d.key)
  const r = artboardRect(a)
  const [x0, y0, x1, y1] = r
  setToolOverlay(d.key, {
    shapes: [
      {
        kind: 'path',
        closed: true,
        style: 'thin',
        points: [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ],
      },
      { kind: 'handles', points: handlesOf(r) },
    ],
  })
}

function press(d: OpenDoc, p0: Pointer): Gesture | null {
  const doc = d.history.present
  const grab = docPx(GRAB)
  // A handle of the selected artboard: size it.
  const sel = selectedArtboard(d)
  if (sel) {
    const r = artboardRect(sel)
    const i = handlesOf(r).findIndex(([x, y]) => Math.abs(x - p0.x) <= grab && Math.abs(y - p0.y) <= grab)
    if (i >= 0) return resizeGesture(d, sel, r, i, p0)
  }
  // On an artboard: select it, and a drag moves it.
  const on = artboardAt(doc, p0.x, p0.y)
  if (on) {
    documents().select(on.id, d.key)
    return moveGesture(d, on.id, p0)
  }
  return drawGesture(d, p0)
}

/** An artboard dragged, its layers with it. */
export function moveGesture(d: OpenDoc, id: NodeId, p0: Pointer): Gesture {
  const doc = d.history.present
  let dx = 0
  let dy = 0
  return {
    move(p) {
      dx = Math.round(p.x - p0.x)
      dy = Math.round(p.y - p0.y)
      if (p.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0)
      readout().set({ text: `ΔX ${lengthText(dx)}  ΔY ${lengthText(dy)}`, x: p.dx, y: p.dy })
      preview(d.key, moveArtboardBy(doc, id, dx, dy))
    },
    up() {
      readout().set(null)
      if (!dx && !dy) return unpreview(d.key)
      commitArtboards(d, (x) => moveArtboardBy(x, id, dx, dy), 'Move Artboard')
      setOverlayDoc(d.key, null)
      refreshArtboardOverlay()
    },
    cancel() {
      readout().set(null)
      unpreview(d.key)
    },
  }
}

function resizeGesture(d: OpenDoc, a: ArtboardNode, r0: [number, number, number, number], handle: number, p0: Pointer): Gesture {
  const doc = d.history.present
  const [l, t, rr, b] = SIDES[handle]
  let rect = r0
  return {
    move(p) {
      const dx = Math.round(p.x - p0.x)
      const dy = Math.round(p.y - p0.y)
      let [x0, y0, x1, y1] = r0
      if (l) x0 = Math.min(x1 - 1, x0 + dx)
      if (rr) x1 = Math.max(x0 + 1, x1 + dx)
      if (t) y0 = Math.min(y1 - 1, y0 + dy)
      if (b) y1 = Math.max(y0 + 1, y1 + dy)
      rect = [x0, y0, x1, y1]
      readout().set({ text: `W ${lengthText(x1 - x0)}  H ${lengthText(y1 - y0)}`, x: p.dx, y: p.dy })
      preview(d.key, setArtboardRect(doc, a.id, rect, false))
    },
    up() {
      readout().set(null)
      if (rect === r0) return unpreview(d.key)
      commitArtboards(d, (x) => setArtboardRect(x, a.id, rect, false), 'Resize Artboard')
      setOverlayDoc(d.key, null)
      refreshArtboardOverlay()
    },
    cancel() {
      readout().set(null)
      unpreview(d.key)
    },
  }
}

/** A new artboard drawn on the pasteboard. */
function drawGesture(d: OpenDoc, p0: Pointer): Gesture {
  const doc = d.history.present
  const id = newId('ab')
  let rect: [number, number, number, number] | null = null
  return {
    move(p) {
      if (Math.hypot(p.dx - p0.dx, p.dy - p0.dy) < CLICK) return
      const x0 = Math.round(Math.min(p0.x, p.x))
      const y0 = Math.round(Math.min(p0.y, p.y))
      const x1 = Math.round(Math.max(p0.x, p.x))
      const y1 = Math.round(Math.max(p0.y, p.y))
      rect = [x0, y0, Math.max(x0 + 1, x1), Math.max(y0 + 1, y1)]
      readout().set({ text: `W ${lengthText(rect[2] - rect[0])}  H ${lengthText(rect[3] - rect[1])}`, x: p.dx, y: p.dy })
      preview(d.key, addArtboard(doc, makeArtboard(id, nextArtboardName(doc), rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1], doc.mode)))
    },
    up() {
      readout().set(null)
      // A click on the pasteboard selects nothing.
      if (!rect) {
        unpreview(d.key)
        if (artboardsOf(doc).length) documents().select(null, d.key)
        return
      }
      const r = rect
      commitArtboards(d, (x) => addArtboard(x, makeArtboard(id, nextArtboardName(x), r[0], r[1], r[2] - r[0], r[3] - r[1], x.mode)), 'New Artboard')
      setOverlayDoc(d.key, null)
      documents().select(id, d.key)
      refreshArtboardOverlay()
    },
    cancel() {
      readout().set(null)
      unpreview(d.key)
    },
  }
}

registerTool('artboard', press)

// The handles follow the selection and the document; leaving the tool takes them away.
let wasArtboard = false
const follow = () => {
  const on = tools().get() === 'artboard'
  if (on) refreshArtboardOverlay()
  else if (wasArtboard) {
    const d = documents().active()
    if (d) clearToolOverlay(d.key)
  }
  wasArtboard = on
}
tools().subscribe(follow)
documents().subscribe(follow)
