/**
 * Each open document's view: where it sits in the canvas, how far it's
 * zoomed and how it's turned. View state, not document state: changing it
 * is never an undo step and never makes a document unsaved.
 *
 * The page owns the view (ARCHITECTURE.md, "The threads"); gestures and
 * commands change it here, and every change goes to the engine, which draws
 * through it. A document is fitted to the canvas the first time it's shown,
 * no larger than 100%.
 *
 * Split view (View → Split View) gives a document a second view, side by
 * side with the first on the same canvas: say a fitted overview beside a
 * close-up. The pane the pointer is over is the active one: `get` and
 * `set` (and so every gesture, the status bar's zoom and the rulers) are
 * about it, and the engine's canvas size is its size.
 */
import { engine } from '../engine/EngineHost'
import { fitView, paneCanvas, panBy, paneRects, rotateTo, sameView, stepZoom, zoomAt, type View } from '../render/view'
import { documents } from './documents'

type Listener = () => void

class ViewStore {
  private views = new Map<string, View>()
  /** Split views: the second pane's view, where the canvas is cut, and which pane is active. */
  private splits = new Map<string, { second: View; split: number; active: 0 | 1 }>()
  private listeners = new Set<Listener>()

  subscribe = (fn: Listener) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** A document's view: in a split view, the active pane's. */
  get = (key: string | null): View | null => {
    if (!key) return null
    const sp = this.splits.get(key)
    return sp?.active === 1 ? sp.second : (this.views.get(key) ?? null)
  }

  /** A split view's panes, for the rulers: each pane's view, and which is active; null for one pane. */
  panes(key: string | null): { views: [View, View]; split: number; active: 0 | 1 } | null {
    const sp = key ? this.splits.get(key) : undefined
    const first = key ? this.views.get(key) : undefined
    return sp && first ? { views: [first, sp.second], split: sp.split, active: sp.active } : null
  }

  /** Whether the front document is split. */
  isSplit = () => this.splits.has(documents().getState().active ?? '')

  /** View → Split View: a second pane beside the first, fitted to the whole document; again, back to one (the active pane's view). */
  toggleSplit() {
    const key = documents().getState().active
    const d = key ? documents().get(key) : null
    if (!key || !d) return
    const sp = this.splits.get(key)
    if (sp) {
      const keep = this.get(key)!
      this.splits.delete(key)
      engine().setSplit(key, null)
      this.views.delete(key)
      this.set(key, keep)
      this.emit()
      return
    }
    this.ensure(key)
    const first = this.views.get(key)
    if (!first) return
    const doc = d.history.present
    const half = paneCanvas(engine().fullCanvasSize(), paneRects(engine().fullCanvasSize(), 0.5)[1])
    const second = fitView(doc.width, doc.height, half, 24, false)
    this.splits.set(key, { second, split: 0.5, active: 0 })
    engine().setSplit(key, this.splits.get(key)!)
    this.emit()
  }

  /** The pane the pointer is over becomes the one gestures, commands and the readouts act on. */
  setActivePane(i: 0 | 1) {
    const key = documents().getState().active
    const sp = key ? this.splits.get(key) : undefined
    if (!key || !sp || sp.active === i) return
    sp.active = i
    engine().setSplit(key, sp)
    this.emit()
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  /** The front document's view, for the status bar and the commands. */
  front = () => this.get(documents().getState().active)

  set(key: string, v: View) {
    const sp = this.splits.get(key)
    if (sp?.active === 1) {
      if (sameView(sp.second, v)) return
      sp.second = v
      engine().setSplit(key, sp)
    } else {
      if (sameView(this.views.get(key) ?? null, v)) return
      this.views.set(key, v)
      engine().setView(key, v)
    }
    this.emit()
  }

  /** Makes sure a document has a view, fitting it if it's new. Needs the canvas's size. */
  ensure(key: string) {
    if (this.views.has(key)) return
    const d = documents().get(key)
    const c = engine().canvasSize()
    if (!d || !c.width) return
    const doc = d.history.present
    this.set(key, fitView(doc.width, doc.height, c))
  }

  forget(key: string) {
    this.views.delete(key)
    this.splits.delete(key)
  }

  private change(fn: (v: View, key: string) => View) {
    const key = documents().getState().active
    if (!key) return
    this.ensure(key)
    const v = this.get(key)
    if (v) this.set(key, fn(v, key))
  }

  /** Fit on Screen: the whole document in view, unrotated, as large as fits, past 100% if need be. */
  fit() {
    this.change((_v, key) => {
      const doc = documents().get(key)!.history.present
      return fitView(doc.width, doc.height, engine().canvasSize(), 32, false)
    })
  }

  /** 100%: one document pixel to one CSS pixel, about the centre of the view. */
  actualSize() {
    this.zoomTo(1)
  }

  /** Zoomed to `zoom` about a device pixel, or the canvas's centre. */
  zoomTo(zoom: number, at?: [number, number]) {
    const c = engine().canvasSize()
    this.change((v) => zoomAt(v, c, zoom, at?.[0] ?? c.width / 2, at?.[1] ?? c.height / 2))
  }

  zoomStep(dir: 1 | -1, at?: [number, number]) {
    const v = this.front()
    if (v) this.zoomTo(stepZoom(v.zoom, dir), at)
  }

  /** Zoomed by a factor (a wheel or a pinch), about a device pixel. */
  zoomBy(factor: number, at: [number, number]) {
    const v = this.front()
    if (v) this.zoomTo(v.zoom * factor, at)
  }

  pan(dx: number, dy: number) {
    const c = engine().canvasSize()
    this.change((v) => panBy(v, c, dx, dy))
  }

  rotate(deg: number) {
    this.change((v) => rotateTo(v, deg))
  }

  rotateBy(deg: number) {
    this.change((v) => rotateTo(v, v.rotation + deg))
  }

  /** Centred on a document point. */
  centreOn(x: number, y: number) {
    this.change((v) => ({ ...v, cx: x, cy: y }))
  }
}

let store: ViewStore | null = null
export const views = () => (store ??= new ViewStore())
