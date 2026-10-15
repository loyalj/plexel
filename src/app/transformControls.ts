/**
 * The Move tool's transform controls: with shape layers selected (one or
 * several), Free Transform's box and handles show round them without
 * Ctrl+Alt+T, as Illustrator's bounding box does and Photoshop's Show
 * Transform Controls. A drag on a handle scales (Shift freely, Alt from the
 * centre, Ctrl on an edge skews), a drag just outside a corner turns, and
 * each drag is one step in the history; anywhere else the Move tool does
 * what it always does, the box hidden while the layers move.
 *
 * The drag itself is Free Transform's (app/freeTransform.ts), opened for
 * that one drag. The box is drawn on the tool overlay, and only cleared
 * when what's there is still its own.
 */
import type { Affine, NodeId } from '../doc/types'
import type { Pt } from '../geom/path'
import { boxFrame } from '../geom/warp'
import { apply, compose } from '../geom/affine'
import { GRAB, cantMove, moveCursor, movable, registerHover, registerMoveControls, sessions, toDevice, transformBox, type Gesture, type Pointer } from './canvasTools'
import { documents, type OpenDoc } from './documents'
import { beginFreeTransform, boxOfLayers } from './freeTransform'
import { clearToolOverlay, setToolOverlay, toolOverlayVersion } from './overlay'
import { tools } from '../tools'

/** Layers that show the controls when every layer selected is one. */
const SHAPES = new Set(['vector', 'boolean'])

/** How far outside a corner (device pixels) a press turns the box rather than missing it. */
const TURN = GRAB * 2.5

interface Shown {
  key: string
  ids: NodeId[]
  /** The box's corners in the document: top left, top right, bottom right, bottom left. */
  corners: Pt[]
  /** The overlay's version when the box was drawn: still the box if nothing's drawn since. */
  version: number
}

let shown: Shown | null = null
let hidden = false
let token = 0

/** The selected layers that get the controls, or null when the selection isn't all shapes the Move tool can move. */
function wanted(d: OpenDoc): NodeId[] | null {
  if (tools().get() !== 'move' || sessions().get()) return null
  const doc = d.history.present
  const ids = movable(d, true)
  if (!ids.length) return null
  return ids.every((id) => {
    const n = doc.nodes[id]
    return !!n && SHAPES.has(n.kind) && n.visible && !cantMove(n)
  })
    ? ids
    : null
}

function clear() {
  if (shown && toolOverlayVersion() === shown.version) clearToolOverlay(shown.key)
  shown = null
}

function draw(s: Omit<Shown, 'version'>) {
  const c = s.corners
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  setToolOverlay(s.key, {
    shapes: [
      { kind: 'path', points: c, closed: true, style: 'line' },
      { kind: 'handles', points: [...c, mid(c[0], c[1]), mid(c[1], c[2]), mid(c[2], c[3]), mid(c[3], c[0])] },
    ],
  })
  shown = { ...s, version: toolOverlayVersion() }
}

/** Shows, moves or hides the box for the document in front. */
async function refresh() {
  const mine = ++token
  const d = documents().active()
  const ids = d && !hidden ? wanted(d) : null
  if (!d || !ids) {
    clear()
    moveCursor.set(null)
    return
  }
  const doc = d.history.present
  let frame: Affine | null = null
  if (ids.length === 1) {
    const fb = await transformBox(doc, doc.nodes[ids[0]])
    if (fb) frame = compose(fb.frame, boxFrame(fb.box) as Affine)
  } else {
    const box = await boxOfLayers(doc, ids)
    if (box) frame = boxFrame(box) as Affine
  }
  // Something changed meanwhile: the newer refresh draws.
  if (mine !== token) return
  if (!frame) return clear()
  const corners: Pt[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map(([x, y]) => apply(frame, x, y) as Pt)
  draw({ key: d.key, ids, corners })
}

/** What a device point is over: a handle (0–3 corners, 4–7 edges), the turning zone outside a corner, or neither. */
function hitAt(p: Pointer): { handle: number } | { turn: true } | null {
  if (!shown) return null
  const dev = toDevice()
  const c = shown.corners.map(([x, y]) => dev(x, y))
  const mids = [0, 1, 2, 3].map((i) => {
    const a = c[i]
    const b = c[(i + 1) % 4]
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Pt
  })
  const hs = [...c, ...mids]
  const d2 = (q: Pt) => Math.hypot(q[0] - p.dx, q[1] - p.dy)
  const handle = hs.findIndex((q) => d2(q) < GRAB)
  if (handle >= 0) return { handle }
  if (inside(c, [p.dx, p.dy])) return null
  return c.some((q) => d2(q) < TURN) ? { turn: true } : null
}

/** Whether a point is inside a convex quadrilateral (either winding). */
function inside(q: Pt[], p: Pt): boolean {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = q[i]
    const b = q[(i + 1) % 4]
    const k = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    if (k === 0) continue
    if (sign === 0) sign = Math.sign(k)
    else if (Math.sign(k) !== sign) return false
  }
  return true
}

/** A resize cursor along the direction from the box's centre to a handle, on screen. */
function resizeCursor(handle: number): string {
  if (!shown) return 'default'
  const dev = toDevice()
  const c = shown.corners.map(([x, y]) => dev(x, y))
  const centre: Pt = [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2]
  const at: Pt = handle < 4 ? c[handle] : [(c[handle - 4][0] + c[(handle - 3) % 4][0]) / 2, (c[handle - 4][1] + c[(handle - 3) % 4][1]) / 2]
  const a = ((Math.atan2(at[1] - centre[1], at[0] - centre[0]) * 180) / Math.PI + 180) % 180
  return a < 22.5 || a >= 157.5 ? 'ew-resize' : a < 67.5 ? 'nwse-resize' : a < 112.5 ? 'ns-resize' : 'nesw-resize'
}

/** A curved arrow, for turning. */
const TURN_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M5 14a7 7 0 0 1 12-6" fill="none" stroke="white" stroke-width="4"/><path d="M5 14a7 7 0 0 1 12-6" fill="none" stroke="black" stroke-width="1.6"/><path d="M19 4v6h-6z" fill="black" stroke="white" stroke-width="1"/></svg>')}") 12 12, alias`

registerMoveControls({
  press(d, p) {
    if (!shown || shown.key !== d.key) return null
    const hit = hitAt(p)
    if (!hit) return null
    return beginFreeTransform('free', { press: p })
  },
  during(g: Gesture): Gesture {
    // The box hides while the layers move, and comes back where they end up.
    hidden = true
    clear()
    const back = () => {
      hidden = false
      void refresh()
    }
    return {
      move: (p) => g.move(p),
      up(p) {
        g.up(p)
        back()
      },
      cancel() {
        g.cancel()
        back()
      },
    }
  },
})

registerHover('move', (p) => {
  const hit = hitAt(p)
  moveCursor.set(!hit ? null : 'turn' in hit ? TURN_CURSOR : resizeCursor(hit.handle))
})

documents().subscribe(() => void refresh())
tools().subscribe(() => void refresh())
sessions().subscribe(() => void refresh())
