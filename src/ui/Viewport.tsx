/**
 * The canvas area. The engine worker draws into the <canvas> here; this
 * component hands the canvas over, turns pointer and wheel input into view
 * changes, and lays things on top: the start screen when no document is
 * open, and the engine's notices.
 *
 * The tools work here: Brush and Eraser paint (app/painting.ts), the
 * Colour Picker picks, Hand drags the document, Zoom clicks in (Alt out) or
 * drags to zoom smoothly, Rotate View turns it. Move, the selection tools,
 * Crop and Free Transform are gestures from app/canvasTools.ts. Holding Space gives the
 * Hand whatever tool is chosen, the middle button always pans, and Alt with
 * a brush picks a colour.
 * The wheel pans (Shift for sideways); with Ctrl, or a trackpad pinch,
 * it zooms about the pointer.
 *
 * Alt with a right-drag sizes the brush on the canvas, as in Photoshop
 * (Ctrl+Option with a drag on a Mac): left and right for the size, up and
 * down for the hardness, with the tip drawn where the drag began. A plain
 * right-click asks the app for its context menu.
 *
 * Hold H and press on the canvas for a bird's-eye view, as in Photoshop:
 * zoomed in, the view fits the whole document while the button is down,
 * with a frame the size of the view it came from; let go, and it zooms
 * back in where the frame is. Esc puts it back as it was.
 *
 * With View → Rulers on, the rulers (ui/Rulers.tsx) take the top and left
 * edges and the canvas starts past them. A drag's readout (a guide's
 * place, how far a move has gone) shows beside the pointer, and the Move
 * tool over a guide shows which way it drags.
 */
import { cursorLoops } from '../brush/outline'
import { pointer } from '../app/pointer'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { engine, type EngineState } from '../engine/EngineHost'
import { formatShortcut, parseShortcut } from '../input/shortcuts'
import { keyOf } from '../commands'
import type { RecentFile } from '../io/handles'
import { views } from '../app/views'
import { tools, TOOL_BY_ID } from '../tools'
import { documents } from '../app/documents'
import { applyResponse, brushes, penSettings } from '../app/brushes'
import { painting, pickColour } from '../app/painting'
import { canvasCaptured, guideAt, hoverTool, pressTool, sessions, type Gesture, type Pointer } from '../app/canvasTools'
import { guidePrefs } from '../app/guidePrefs'
import { readout } from '../app/readout'
import { Rulers } from './Rulers'
import { registerCanvasPoint } from '../app/colourDrag'
import { canvasGesture } from '../app/gesture'
import { springTools } from '../app/springTools'
import { selectTools } from '../app/selectTools'
import { formatZoom } from './StatusBar'
import { isMac } from '../input/shortcuts'
import { docPoint, fitView, paneAt, type View } from '../render/view'
import { copyShift } from '../app/tiling'
import { retouch } from '../app/retouch'
import { clearToolOverlay, setToolOverlay } from '../app/overlay'
import type { PenSample } from '../brush/stroke'
import { RecentList } from './docDialogs'

interface Props {
  state: EngineState
  hasDoc: boolean
  /** A document is open and in front, so gestures have something to move. */
  active: boolean
  canRecent: boolean
  onNew(): void
  onOpen(): void
  onOpenRecent(r: RecentFile): void
  /** A right-click on the canvas, at a point on the screen. */
  onContextMenu?(x: number, y: number): void
  /** A right-click on a ruler: its units. */
  onRulerMenu?(x: number, y: number): void
  children?: ReactNode
}

/** What a drag on the canvas is doing. */
type Drag =
  | { kind: 'paint'; id: number }
  | { kind: 'pick'; id: number; background: boolean; busy: boolean }
  | { kind: 'pan'; x: number; y: number; id: number }
  | { kind: 'zoom'; x: number; y: number; start: number; at: [number, number]; moved: boolean; out: boolean; id: number }
  | { kind: 'rotate'; angle: number; start: number; id: number }
  /** A tool's gesture, which may still be on its way (it asks the engine first). */
  | { kind: 'tool'; id: number; gesture: Gesture | null; ready: boolean; last: Pointer | null; ended: Pointer | null }
  /** H held and a press: the whole document, with a frame for where to zoom back in. */
  | { kind: 'bird'; id: number; key: string; from: View; corners: [number, number][] }
  /** Alt and a right-drag: the brush's size and hardness, from where the drag began. */
  | { kind: 'size'; id: number; x: number; y: number; size: number; hardness: number | null; at: { clientX: number; clientY: number } }

/** What the sizing drag shows: the tip, at its size on screen, and its numbers. */
interface SizeHud {
  /** Its centre, in CSS pixels from the viewport's corner. */
  x: number
  y: number
  /** The tip's diameter on screen, in CSS pixels. */
  diameter: number
  size: number
  hardness: number | null
}

/** CSS pixels on screen per document pixel, in the front view. */
function screenScale(canvas: HTMLCanvasElement): number {
  const v = views().front()
  if (!v) return 1
  const c = engine().canvasSize()
  const a = docPoint(v, c, 0, 0)
  const b = docPoint(v, c, 100, 0)
  const docPerDevice = Math.hypot(b[0] - a[0], b[1] - a[1]) / 100
  const devicePerCss = engine().fullCanvasSize().width / Math.max(1, canvas.getBoundingClientRect().width)
  return devicePerCss / Math.max(1e-9, docPerDevice)
}

/** Where the drag readout goes: beside its point, in CSS pixels from the viewport's corner. */
function readoutAt(el: HTMLCanvasElement, r: { x: number; y: number }): { left: number; top: number } {
  const k = engine().fullCanvasSize().width / Math.max(1, el.clientWidth)
  // A readout's point is in the active pane; the pane starts this far in.
  const px = engine().panes()[engine().activePane()]?.x ?? 0
  return { left: el.offsetLeft + (r.x + px) / k + 14, top: el.offsetTop + r.y / k + 18 }
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t instanceof HTMLInputElement && t.type !== 'checkbox' && t.type !== 'range'))

export function Viewport({ state, hasDoc, active, canRecent, onNew, onOpen, onOpenRecent, onContextMenu, onRulerMenu, children }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<Drag | null>(null)
  /**
   * In a tiled document's view, the whole periods between the copy a press
   * landed in and the document, kept for the rest of its drag: a tool works
   * on the document from any copy, and a drag over a seam stays in one piece.
   */
  const shift = useRef<[number, number] | null>(null)
  /** A device point in document pixels, moved from a copy into the document. */
  const toolPoint = (dx: number, dy: number): [number, number] => {
    const [x, y] = docPoint(views().front()!, engine().canvasSize(), dx, dy)
    const [sx, sy] = shift.current ?? copyShift(documents().active()?.history.present ?? null, x, y)
    return [x - sx, y - sy]
  }
  const [dragging, setDraggingState] = useState<Drag['kind'] | null>(null)
  const setDragging = (k: Drag['kind'] | null) => {
    setDraggingState(k)
    canvasGesture.set(k)
  }
  const [hud, setHud] = useState<SizeHud | null>(null)
  /** Set by a sizing drag, so the right button's context menu doesn't follow it. */
  const noContextMenu = useRef(false)
  const [space, setSpace] = useState(false)
  /** H held down, for the bird's-eye view. */
  const hHeld = useRef(false)
  const [alt, setAlt] = useState(false)
  const tool = useSyncExternalStore(tools().subscribe, tools().get)
  const rulers = useSyncExternalStore(guidePrefs().subscribe, () => guidePrefs().get().rulers)
  const shownReadout = useSyncExternalStore(readout().subscribe, readout().get)
  /** The Move tool over a guide: which way it can be dragged. */
  const [overGuide, setOverGuide] = useState<'x' | 'y' | null>(null)

  useEffect(() => {
    if (canvas.current) engine().attach(canvas.current)
  }, [])

  // Where a swatch dropped on the canvas lands, in document pixels (app/colourDrag.ts).
  useEffect(() => {
    registerCanvasPoint((clientX, clientY) => {
      const el = canvas.current
      const v = views().front()
      if (!el || !v) return null
      const r = el.getBoundingClientRect()
      if (clientX < r.left || clientY < r.top || clientX > r.right || clientY > r.bottom) return null
      choosePane({ clientX, clientY })
      return docPoint(views().front()!, engine().canvasSize(), ...devicePoint({ clientX, clientY }))
    })
    return () => registerCanvasPoint(null)
  }, [])

  // Space held gives the Hand; Alt turns the Zoom tool round.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAlt(true)
      if (e.key === 'Escape' && painting().painting) {
        painting().cancel()
        drag.current = null
        setDragging(null)
      }
      if (e.code === 'KeyH' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) hHeld.current = true
      if (e.key === 'Escape' && drag.current?.kind === 'bird') {
        const b = drag.current
        views().set(b.key, b.from)
        clearToolOverlay(b.key)
        drag.current = null
        setDragging(null)
      }
      if (e.key === 'Escape' && drag.current?.kind === 'tool') {
        drag.current.gesture?.cancel()
        drag.current = null
        setDragging(null)
      }
      if (e.code !== 'Space' || isTyping(e.target)) return
      // A focused button would take Space as a click; on the canvas it's the Hand.
      if (!(e.target instanceof HTMLElement) || e.target === document.body || e.target.closest('.viewport')) e.preventDefault()
      setSpace(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAlt(false)
      if (e.code === 'Space') setSpace(false)
      if (e.code === 'KeyH') hHeld.current = false
    }
    const blur = () => {
      hHeld.current = false
      setSpace(false)
      setAlt(false)
    }
    addEventListener('keydown', down)
    addEventListener('keyup', up)
    addEventListener('blur', blur)
    return () => {
      removeEventListener('keydown', down)
      removeEventListener('keyup', up)
      removeEventListener('blur', blur)
    }
  }, [])

  /** A pointer event's position in the whole canvas's device pixels. */
  const fullPoint = (e: { clientX: number; clientY: number }): [number, number] => {
    const el = canvas.current!
    const r = el.getBoundingClientRect()
    const k = engine().fullCanvasSize().width / Math.max(1, r.width)
    return [(e.clientX - r.left) * k, (e.clientY - r.top) * k]
  }
  /** A pointer event's position in the device pixels of the pane the tools work in (the whole canvas but in a split view). */
  const devicePoint = (e: { clientX: number; clientY: number }): [number, number] => {
    const [x, y] = fullPoint(e)
    return [x - (engine().panes()[engine().activePane()]?.x ?? 0), y]
  }
  /** In a split view, the pane under the pointer becomes the active one. */
  const choosePane = (e: { clientX: number; clientY: number }) => {
    const panes = engine().panes()
    if (panes.length > 1) views().setActivePane(paneAt(panes, fullPoint(e)[0]) as 0 | 1)
  }
  const centre = (): [number, number] => {
    const c = engine().canvasSize()
    return [c.width / 2, c.height / 2]
  }
  const angleOf = (p: [number, number]) => {
    const [cx, cy] = centre()
    return (Math.atan2(p[1] - cy, p[0] - cx) * 180) / Math.PI
  }

  // The wheel listener can't be passive: Ctrl+wheel must not zoom the page.
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      if (!active) return
      e.preventDefault()
      if (painting().painting) return
      if (!drag.current) choosePane(e)
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
      const dpr = engine().canvasSize().dpr
      if (e.ctrlKey || e.metaKey) {
        views().zoomBy(Math.exp((-e.deltaY * scale) / 300), devicePoint(e))
      } else {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY
        views().pan(-dx * scale * dpr, -dy * scale * dpr)
      }
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [active])

  /** A pointer event as a pen sample, in document pixels. A mouse presses fully. */
  const sampleOf = (e: PointerEvent): PenSample => {
    const [x, y] = toolPoint(...devicePoint(e))
    const pressure = e.pointerType === 'pen' ? applyResponse(e.pressure, penSettings.get().response) : e.pointerType === 'touch' ? e.pressure || 0.5 : 1
    return { x, y, pressure, tiltX: e.tiltX ?? 0, tiltY: e.tiltY ?? 0, twist: e.twist ?? 0, t: e.timeStamp }
  }
  const paints = TOOL_BY_ID.get(tool)?.paints

  /** Where the brush cursor goes, or nowhere. */
  const showCursor = (e: { clientX: number; clientY: number } | null) => {
    const key = documents().getState().active
    const v = views().front()
    if (!e || !paints || space || !key || !v) {
      engine().setCursor(null)
      return
    }
    const [x, y] = docPoint(v, engine().canvasSize(), ...devicePoint(e))
    const b = brushes().get()[paints]
    // A round tip at full roundness is a ring; anything else shows its own shape, turned as it paints.
    const plain = b.tip === 'round' && b.roundness >= 0.999
    engine().setCursor({ key, x, y, size: b.size, loops: plain ? null : cursorLoops(b.tip, x, y, b.size, b.angle, b.roundness, b.flipX, b.flipY) })
  }
  useEffect(() => {
    if (!paints || space) engine().setCursor(null)
  }, [paints, space])

  /** A pointer event for a tool's gesture: document and device pixels, and its keys. */
  const pointerOf = (e: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): Pointer => {
    const [dx, dy] = devicePoint(e)
    const [x, y] = toolPoint(dx, dy)
    return { x, y, dx, dy, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey || e.metaKey }
  }

  const pick = (d: Extract<Drag, { kind: 'pick' }>, e: PointerEvent) => {
    if (d.busy) return
    d.busy = true
    const s = sampleOf(e)
    void pickColour(s.x, s.y, d.background).finally(() => (d.busy = false))
  }

  /** The tip's size on the canvas, for the sizing drag. */
  const sizeHud = (d: Extract<Drag, { kind: 'size' }>): SizeHud => {
    const r = canvas.current!.getBoundingClientRect()
    return { x: d.at.clientX - r.left, y: d.at.clientY - r.top, diameter: d.size * screenScale(canvas.current!), size: d.size, hardness: d.hardness }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!active || drag.current) return
    choosePane(e)
    const p = devicePoint(e)
    if (views().front()) {
      const [x, y] = docPoint(views().front()!, engine().canvasSize(), ...p)
      shift.current = copyShift(documents().active()?.history.present ?? null, x, y)
    }
    const pan = e.button === 1 || space || tool === 'hand'
    // Alt and the right button (Ctrl+Option and a drag on a Mac): size the brush.
    const sizing = (e.button === 2 && e.altKey) || (isMac() && e.button === 0 && e.ctrlKey && e.altKey)
    if (sizing && (paints || tool === 'quick') && !space) {
      e.preventDefault()
      noContextMenu.current = true
      try {
        ;(e.target as Element).setPointerCapture(e.pointerId)
      } catch {
        // As below: the drag still works over the canvas.
      }
      const b = paints ? brushes().get()[paints] : null
      const d: Drag = { kind: 'size', id: e.pointerId, x: e.clientX, y: e.clientY, size: b ? b.size : selectTools().get().quick.size, hardness: b ? b.hardness : null, at: { clientX: e.clientX, clientY: e.clientY } }
      drag.current = d
      setDragging('size')
      setHud(sizeHud(d))
      return
    }
    if (e.button !== 0 && e.button !== 1) return
    // H held: the bird's-eye view, when zoomed in past fitting.
    const birdDoc = documents().active()
    const v0 = views().front()
    if (e.button === 0 && hHeld.current && birdDoc && v0) {
      const c = engine().canvasSize()
      const doc = birdDoc.history.present
      const fit = fitView(doc.width, doc.height, c, 32, false)
      if (v0.zoom > fit.zoom * 1.05) {
        e.preventDefault()
        try {
          ;(e.target as Element).setPointerCapture(e.pointerId)
        } catch {
          // As below.
        }
        // The view's corners, from its centre, in document pixels: the frame.
        const corners = [
          [0, 0],
          [c.width, 0],
          [c.width, c.height],
          [0, c.height],
        ].map(([x, y]) => {
          const [dx, dy] = docPoint(v0, c, x, y)
          return [dx - v0.cx, dy - v0.cy] as [number, number]
        })
        const d: Drag = { kind: 'bird', id: e.pointerId, key: birdDoc.key, from: v0, corners }
        drag.current = d
        setDragging('bird')
        views().set(birdDoc.key, { ...fit, rotation: v0.rotation })
        birdFrame(d, e)
        return
      }
    }
    // A tool held on its key and used here stays a hold, however short the press (app/springTools.ts).
    if (e.button === 0 && !space) springTools().use()
    e.preventDefault()
    // preventDefault keeps the browser from moving focus, so a field typed in
    // last would keep the keys and the tool shortcuts would type into it.
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur()
    try {
      ;(e.target as Element).setPointerCapture(e.pointerId)
    } catch {
      // A pointer the browser didn't start (a synthetic event, some tablet
      // drivers) can't be captured; the drag still works over the canvas.
    }
    const front = documents().getState().active
    const session = sessions().get()
    const toolGesture = !pan && (canvasCaptured() || (session && session.key === front) || ['move', 'marquee', 'lasso', 'quick', 'wand', 'crop', 'pen', 'direct', 'shape', 'builder', 'livepaint', 'type', 'gradient', 'bucket', 'patch'].includes(tool))
    // The Clone Stamp and the Healing Brush: Alt-click sets where they copy from, rather than picking a colour.
    if (!pan && !toolGesture && (paints === 'clone' || paints === 'heal') && e.altKey && front) {
      const [x, y] = toolPoint(...p)
      retouch().setSource(front, x, y)
      return
    }
    if (toolGesture) {
      const d: Drag = { kind: 'tool', id: e.pointerId, gesture: null, ready: false, last: null, ended: null }
      drag.current = d
      void pressTool(tool, pointerOf(e)).then((g) => {
        d.gesture = g
        d.ready = true
        // What happened while the engine was asked, in order.
        if (g && d.last) g.move(d.last)
        if (g && d.ended) g.up(d.ended)
      })
    } else if (!pan && (tool === 'picker' || (paints && e.altKey))) {
      const d: Drag = { kind: 'pick', id: e.pointerId, background: tool === 'picker' && e.altKey, busy: false }
      drag.current = d
      pick(d, e.nativeEvent)
    } else if (!pan && paints) {
      if (painting().begin(paints, sampleOf(e.nativeEvent), e.shiftKey)) drag.current = { kind: 'paint', id: e.pointerId }
    } else if (pan) drag.current = { kind: 'pan', x: p[0], y: p[1], id: e.pointerId }
    else if (tool === 'zoom') drag.current = { kind: 'zoom', x: p[0], y: p[1], start: views().front()?.zoom ?? 1, at: p, moved: false, out: e.altKey, id: e.pointerId }
    else if (tool === 'rotate') drag.current = { kind: 'rotate', angle: angleOf(p), start: views().front()?.rotation ?? 0, id: e.pointerId }
    setDragging(drag.current?.kind ?? null)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const sizing = drag.current?.kind === 'size' ? drag.current : null
    if (sizing && sizing.id === e.pointerId) {
      // The tip's edge follows the pointer: its radius on screen grows by what the drag moved.
      const k = screenScale(canvas.current!)
      const size = Math.round(Math.min(2000, Math.max(1, sizing.size + (2 * (e.clientX - sizing.x)) / k)))
      const hardness = sizing.hardness === null ? null : Math.min(1, Math.max(0, sizing.hardness - (e.clientY - sizing.y) / 200))
      if (paints) brushes().update(paints, hardness === null ? { size } : { size, hardness })
      else selectTools().update('quick', { size })
      setHud(sizeHud({ ...sizing, size, hardness }))
      showCursor(sizing.at)
      return
    }
    if (!drag.current) choosePane(e)
    showCursor(e)
    const front = documents().getState().active
    if (front && views().front()) {
      const q = pointerOf(e)
      pointer.set({ key: front, x: Math.floor(q.x), y: Math.floor(q.y) })
    }
    const d = drag.current
    if (!d && active && views().front()) hoverTool(pointerOf(e))
    if (!d && active && views().front()) {
      const doc = documents().active()
      const g = tool === 'move' && !space && doc ? guideAt(doc, pointerOf(e)) : -1
      setOverGuide(g >= 0 ? doc!.history.present.guides[g].axis : null)
    }
    if (!d || d.id !== e.pointerId) return
    const p = devicePoint(e)
    if (d.kind === 'bird') {
      birdFrame(d, e)
      return
    }
    if (d.kind === 'tool') {
      const q = pointerOf(e)
      if (d.ready) d.gesture?.move(q)
      else d.last = q
    } else if (d.kind === 'paint') {
      // Every sample the browser has, not just one a frame: a pen sends many.
      const all = e.nativeEvent.getCoalescedEvents?.() ?? []
      painting().move((all.length ? all : [e.nativeEvent]).map(sampleOf))
    } else if (d.kind === 'pick') {
      pick(d, e.nativeEvent)
    } else if (d.kind === 'pan') {
      views().pan(p[0] - d.x, p[1] - d.y)
      d.x = p[0]
      d.y = p[1]
    } else if (d.kind === 'zoom') {
      const dx = p[0] - d.x
      if (Math.abs(dx) > 3) d.moved = true
      // Dragging right zooms in, left out: twice as big for every 200 CSS pixels.
      if (d.moved) views().zoomTo(d.start * 2 ** (dx / (200 * engine().canvasSize().dpr)), d.at)
    } else if (d.kind === 'rotate') {
      let deg = d.start + angleOf(p) - d.angle
      if (e.shiftKey) deg = Math.round(deg / 15) * 15
      views().rotate(deg)
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    if (d.kind === 'size') setHud(null)
    if (d.kind === 'bird') {
      // Back to the zoom it came from, centred where the frame is.
      const v = views().get(d.key)
      const [cx, cy] = v ? docPoint(v, engine().canvasSize(), ...devicePoint(e)) : [d.from.cx, d.from.cy]
      clearToolOverlay(d.key)
      views().set(d.key, { ...d.from, cx, cy })
    }
    if (d.kind === 'zoom' && !d.moved) views().zoomStep(d.out || e.altKey ? -1 : 1, d.at)
    if (d.kind === 'paint') void painting().end()
    if (d.kind === 'tool') {
      const q = pointerOf(e)
      if (d.ready) d.gesture?.up(q)
      else d.ended = q
    }
    drag.current = null
    shift.current = null
    setDragging(null)
  }

  /** The bird's-eye frame, centred on the pointer: the size of the view it will zoom back to. */
  const birdFrame = (d: Extract<Drag, { kind: 'bird' }>, e: { clientX: number; clientY: number }) => {
    const v = views().get(d.key)
    if (!v) return
    const [x, y] = docPoint(v, engine().canvasSize(), ...devicePoint(e))
    setToolOverlay(d.key, { shapes: [{ kind: 'path', points: d.corners.map(([dx, dy]) => [x + dx, y + dy] as [number, number]), closed: true, style: 'line' }] })
  }

  const onDoubleClick = () => {
    if (active && tool === 'rotate' && !space) views().rotate(0)
  }

  const cursor = !active
    ? undefined
    : dragging === 'pan'
      ? 'grabbing'
      : space
        ? 'grab'
        : tool === 'zoom'
          ? alt
            ? 'zoom-out'
            : 'zoom-in'
          : paints && alt
            ? 'crosshair'
            : overGuide
              ? overGuide === 'x'
                ? 'col-resize'
                : 'row-resize'
              : TOOL_BY_ID.get(tool)?.cursor

  // The keys as they are now: yours, if you've changed them.
  const k = (id: string) => {
    const s = keyOf(id)
    return s ? formatShortcut(parseShortcut(s)!) : ''
  }
  return (
    <main className="viewport" aria-label="Canvas" data-tool={tool} data-rulers={rulers && hasDoc ? '' : undefined} style={{ cursor }}>
      {rulers && hasDoc && <Rulers
          pointerOf={(e) => {
            if (!views().front() || !canvas.current) return null
            if (!drag.current) choosePane(e)
            return pointerOf(e)
          }} onMenu={(x, y) => onRulerMenu?.(x, y)} />}
      <canvas
        ref={canvas}
        data-engine-canvas
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          showCursor(null)
          pointer.set(null)
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => {
          e.preventDefault()
          if (noContextMenu.current) {
            noContextMenu.current = false
            return
          }
          if (drag.current || !onContextMenu) return
          onContextMenu(e.clientX, e.clientY)
        }}
      />
      {shownReadout && canvas.current && (
        <div className="drag-readout" data-readout style={readoutAt(canvas.current, shownReadout)}>
          {shownReadout.text}
        </div>
      )}
      {hud && (
        <div className="brush-hud" data-brush-hud style={{ left: hud.x, top: hud.y }}>
          <span
            className="brush-hud-tip"
            style={{
              width: hud.diameter,
              height: hud.diameter,
              // Solid to the hardness, then fading to nothing at the edge.
              background: hud.hardness === null ? undefined : `radial-gradient(closest-side, var(--hud-tip) ${Math.round(hud.hardness * 100)}%, transparent 100%)`,
            }}
          />
          <span className="brush-hud-label">
            {hud.size} px{hud.hardness !== null ? ` · ${Math.round(hud.hardness * 100)}% hard` : ''}
            {views().front() ? <span className="brush-hud-zoom"> at {formatZoom(views().front()!.zoom)}</span> : null}
          </span>
        </div>
      )}
      {!hasDoc && (
        <div className="start" data-screen="start">
          <div className="start-card">
            <h2>Start</h2>
            <div className="start-actions">
              <button type="button" className="button primary" onClick={onNew}>
                New Document… <kbd>{k('file.new')}</kbd>
              </button>
              <button type="button" className="button" onClick={onOpen}>
                Open… <kbd>{k('file.open')}</kbd>
              </button>
            </div>
            {canRecent && (
              <>
                <h3>Recent</h3>
                <RecentList onOpen={onOpenRecent} />
              </>
            )}
            <p className="start-hint">
              Or drop a .pxll file or an image (PNG, JPEG, TIFF) here. <kbd>{k('palette.open')}</kbd> lists every command.
            </p>
          </div>
        </div>
      )}
      {children}
      {state.status === 'starting' && state.reason && (
        <div className="viewport-notice" role="status">
          The graphics device was lost ({state.reason}). Getting a new one.
        </div>
      )}
      {state.status === 'lost' && (
        <div className="viewport-notice" role="alert">
          The graphics device was lost and couldn’t be restarted: {state.reason}. Reload the page to try again.
        </div>
      )}
      {state.error && state.status === 'ready' && (
        <div className="viewport-notice" role="alert">
          {state.error}
        </div>
      )}
    </main>
  )
}
