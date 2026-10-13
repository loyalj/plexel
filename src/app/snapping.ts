/**
 * Snapping for the tools: a Snapper is made when a gesture starts, with
 * what's being dragged, and gathers what it can snap to once (geom/snap.ts
 * does the maths). Guides, the grid, the canvas and anchor points are
 * there at once; other layers' boxes arrive a moment later, since
 * measuring pixels asks the engine.
 *
 * View → Snap turns it all off, and View → Snap To each kind of target.
 * Holding Ctrl while dragging lets go of snapping for as long as it's held,
 * as in Photoshop. Smart guides (View → Show → Smart Guides) draw what a
 * snap lined up with; with them off, snapping still works, unseen.
 *
 * The tolerance is a few CSS pixels on screen, so snapping feels the same
 * at any zoom.
 */
import type { Doc, NodeId } from '../doc/types'
import { carried } from '../doc/edit'
import { geometryPath } from '../doc/vector'
import { applyMat } from '../geom/path'
import { NO_TARGETS, boxLines, snapBox, snapPoint, type Box, type Snap, type SnapLine, type SnapTargets } from '../geom/snap'
import type { OverlayShape } from '../render/overlay'
import { layerBox } from './bounds'
import type { OpenDoc } from './documents'
import { guidePrefs } from './guidePrefs'
import { setSnapOverlay } from './overlay'
import { gridStep, origins } from './viewAids'
import { views } from './views'

/** How near, in CSS pixels on screen, something must come to snap. */
export const SNAP_PX = 8

export interface Snapper {
  /** A point dragged to (x, y): where it lands. */
  point(x: number, y: number, keys: { ctrlKey: boolean }): [number, number]
  /** One coordinate (a guide being dragged): where it lands. */
  along(axis: 'x' | 'y', at: number, keys: { ctrlKey: boolean }, whole?: boolean): number
  /**
   * A box dragged to `b`: how much further to move it. `settle` turns the
   * snap's offset into the one used (the Move tool keeps its whole move to
   * whole pixels), and the smart guides show where it ends.
   */
  box(b: Box, keys: { ctrlKey: boolean }, settle?: (dx: number, dy: number) => [number, number]): [number, number]
  /** The gesture's over: the smart guides go. */
  end(): void
}

interface Options {
  /** Layers being moved: they, and what they carry, aren't targets. */
  moving?: NodeId[]
  /** An anchor being dragged, in document pixels: it isn't a target for itself. */
  skip?: [number, number][]
}

/** CSS pixels on screen to document pixels, at the front view's zoom. */
export function docPx(css: number): number {
  const v = views().front()
  return css / (v?.zoom || 1)
}

/** The layers a snap can line up with: everything shown, but what's moving. */
function targetLayers(doc: Doc, moving: Set<NodeId>): NodeId[] {
  const out: NodeId[] = []
  const visit = (id: NodeId) => {
    const n = doc.nodes[id]
    if (!n || !n.visible || moving.has(id)) return
    if (n.kind === 'group') {
      for (const c of n.children ?? []) visit(c)
      return
    }
    if (n.kind === 'pixel' || n.kind === 'vector' || n.kind === 'boolean' || n.kind === 'text' || n.kind === 'embedded') out.push(id)
    // Layers clipped to this one are layers of their own; a compound's shapes aren't.
    if (n.kind !== 'boolean') for (const c of n.children ?? []) visit(c)
  }
  for (const c of doc.nodes[doc.root]?.children ?? []) visit(c)
  return out
}

/** Every shape's anchors in document pixels, but those of what's moving. */
function anchorPoints(doc: Doc, moving: Set<NodeId>): [number, number][] {
  const out: [number, number][] = []
  for (const n of Object.values(doc.nodes)) {
    if (n.kind !== 'vector' || !n.visible || moving.has(n.id) || !n.props.geometry) continue
    const path = geometryPath(n.props.geometry)
    for (const s of path.subpaths) for (const a of s.anchors) out.push(applyMat(n.transform, a.p[0], a.p[1]))
    if (out.length > 5000) break
  }
  return out
}

/** The smart guides for a snap: its lines, and its equal gaps with ticks at their ends. */
function shapesOf(s: Snap): OverlayShape[] {
  const out: OverlayShape[] = []
  for (const l of s.lines) {
    const pts: [number, number][] = l.axis === 'x' ? [[l.at, l.from], [l.at, l.to]] : [[l.from, l.at], [l.to, l.at]]
    out.push({ kind: 'path', points: pts, closed: false, style: 'smart' })
  }
  const tick = docPx(4)
  for (const g of s.gaps) {
    const line: [number, number][] = g.axis === 'x' ? [[g.from, g.at], [g.to, g.at]] : [[g.at, g.from], [g.at, g.to]]
    out.push({ kind: 'path', points: line, closed: false, style: 'smart' })
    for (const end of [g.from, g.to]) {
      const t: [number, number][] = g.axis === 'x' ? [[end, g.at - tick], [end, g.at + tick]] : [[g.at - tick, end], [g.at + tick, end]]
      out.push({ kind: 'path', points: t, closed: false, style: 'smart' })
    }
  }
  return out
}

/** Starts snapping for a gesture on `d`. */
export function startSnap(d: OpenDoc, o: Options = {}): Snapper {
  const p = guidePrefs().get()
  const doc = d.history.present
  const key = d.key
  const on = p.snap
  const to = p.snapTo
  const moving = new Set<NodeId>()
  for (const id of o.moving ?? []) for (const c of carried(doc, id)) moving.add(c)
  const t: SnapTargets = on ? { x: [], y: [], grid: null, boxes: [] } : NO_TARGETS
  if (on) {
    if (to.guides && p.guides) {
      for (const g of doc.guides) (g.axis === 'x' ? t.x : t.y).push({ at: g.at, span: null, kind: 'guide' })
    }
    if (to.grid && p.grid) {
      const step = gridStep(doc.resolution) / Math.max(1, p.gridSub)
      const [ox, oy] = origins().get(key)
      if (step > 0) t.grid = { x: { step, origin: ox }, y: { step, origin: oy } }
    }
    if (to.document) {
      const b = boxLines([0, 0, doc.width, doc.height], 'document')
      t.x.push(...b.x)
      t.y.push(...b.y)
    }
    if (to.points) {
      const skip = o.skip ?? []
      for (const [x, y] of anchorPoints(doc, moving)) {
        if (skip.some((s) => Math.abs(s[0] - x) < 1e-6 && Math.abs(s[1] - y) < 1e-6)) continue
        t.x.push({ at: x, span: [y, y], kind: 'point' })
        t.y.push({ at: y, span: [x, x], kind: 'point' })
      }
    }
    if (to.layers) {
      // Measured as they come: snapping uses whatever has arrived.
      for (const id of targetLayers(doc, moving)) {
        void layerBox(doc, id).then((b) => {
          if (!b) return
          const l = boxLines(b, 'layer')
          t.x.push(...l.x)
          t.y.push(...l.y)
          t.boxes.push(b)
        })
      }
    }
  }
  let showing = false
  const show = (s: Snap | null) => {
    const shapes = s && p.smartGuides ? shapesOf(s) : []
    if (!shapes.length && !showing) return
    showing = shapes.length > 0
    setSnapOverlay(key, shapes)
  }
  const tol = () => docPx(SNAP_PX)
  const pixels = on && to.pixels
  return {
    point(x, y, keys) {
      if (!on || keys.ctrlKey) {
        show(null)
        return [x, y]
      }
      const s = snapPoint(x, y, t, tol())
      show(s)
      return [s.x || !pixels ? x + s.dx : Math.round(x), s.y || !pixels ? y + s.dy : Math.round(y)]
    },
    along(axis, at, keys, whole = pixels) {
      if (!on || keys.ctrlKey) return whole ? Math.round(at) : at
      const lines: SnapLine[] = (axis === 'x' ? t.x : t.y).filter((l) => l.kind !== 'guide')
      const s = snapPoint(axis === 'x' ? at : 0, axis === 'y' ? at : 0, { ...t, x: axis === 'x' ? lines : [], y: axis === 'y' ? lines : [], boxes: [] }, tol())
      const off = axis === 'x' ? s.dx : s.dy
      const hit = axis === 'x' ? s.x : s.y
      return hit ? at + off : whole ? Math.round(at) : at
    },
    box(b, keys, settle = (dx, dy) => [dx, dy]) {
      if (!on || keys.ctrlKey) {
        show(null)
        return settle(0, 0)
      }
      const s = snapBox(b, t, tol())
      const [dx, dy] = settle(s.dx, s.dy)
      // Settled (kept to whole pixels, say): what lines up where it ends is drawn.
      show(dx === s.dx && dy === s.dy ? s : snapBox([b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy], t, 0.5))
      return [dx, dy]
    },
    end() {
      show(null)
    },
  }
}
