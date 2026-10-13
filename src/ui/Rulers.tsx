/**
 * The rulers along the canvas's top and left (View → Rulers, Ctrl+R), in
 * the units chosen for them, measured from the zero point.
 *
 * Each is drawn on a canvas of its own whenever the view, the document,
 * the units or the zero point change, with a mark following the pointer.
 * With the view turned, a ruler measures whichever document axis runs
 * along it; turned to an angle where neither does, it's left blank.
 *
 * Dragging out of a ruler makes a guide parallel to it (Alt makes the
 * other kind); dragging out of the corner moves the zero point, and
 * double-clicking the corner puts it back. A right-click picks the units.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { documents } from '../app/documents'
import { engine } from '../engine/EngineHost'
import { guidePrefs } from '../app/guidePrefs'
import { origins } from '../app/viewAids'
import { pointer } from '../app/pointer'
import { views } from '../app/views'
import { docPoint, paneCanvas, paneRects, type Canvas, type View } from '../render/view'
import { fromPixels } from '../doc/units'
import { guideGesture, offCanvas, setToolOverlay, clearToolOverlay, type Gesture, type Pointer } from '../app/canvasTools'
import { startSnap } from '../app/snapping'
import { readout, lengthText } from '../app/readout'

/** The rulers' thickness, in CSS pixels. */
export const RULER = 20

interface Props {
  /** A pointer event as a canvas pointer, wherever it is on the page. */
  pointerOf(e: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): Pointer | null
  /** A right-click on a ruler, at a point on the screen. */
  onMenu(x: number, y: number): void
}

/** Where along a ruler measures what: doc = start + slope · (CSS pixels along it), on `axis`; or nothing. */
interface Scale {
  axis: 'x' | 'y'
  start: number
  slope: number
}

/** What a ruler along the top (`side` 'top') or left of a view measures, on canvas `c`. */
function scaleOf(side: 'top' | 'left', v: View | null, c: Canvas): Scale | null {
  if (!v || !c.width) return null
  const k = c.dpr
  const a = docPoint(v, c, 0, 0)
  const b = side === 'top' ? docPoint(v, c, k, 0) : docPoint(v, c, 0, k)
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  if (Math.abs(dy) < 1e-9 * Math.abs(dx || 1)) return { axis: 'x', start: a[0], slope: dx }
  if (Math.abs(dx) < 1e-9 * Math.abs(dy || 1)) return { axis: 'y', start: a[1], slope: dy }
  return null
}

/**
 * The stretches of a ruler and what each measures, in CSS pixels along it:
 * the whole ruler through the active view, or along the top in a split
 * view, each pane's stretch through its own view. `active` marks the one
 * the pointer's mark goes on.
 */
function segmentsOf(side: 'top' | 'left', len: number): { from: number; len: number; scale: Scale | null; active: boolean }[] {
  const key = documents().getState().active
  const split = views().panes(key)
  if (side === 'top' && split) {
    const full = engine().fullCanvasSize()
    return paneRects(full, split.split).map((pane, i) => ({
      from: pane.x / full.dpr,
      len: pane.width / full.dpr,
      scale: scaleOf(side, split.views[i], paneCanvas(full, pane)),
      active: split.active === i,
    }))
  }
  return [{ from: 0, len, scale: scaleOf(side, views().front(), engine().canvasSize()), active: true }]
}

/** A step of 1, 2 or 5 times a power of ten, no smaller than `min`. */
function niceStep(min: number): number {
  const p = 10 ** Math.floor(Math.log10(min))
  for (const m of [1, 2, 5, 10]) if (m * p >= min) return m * p
  return 10 * p
}

const label = (v: number, step: number) => {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9))
  const s = (Math.round(v / step) * step).toFixed(decimals)
  return s === '-0' ? '0' : s
}

function draw(el: HTMLCanvasElement, side: 'top' | 'left') {
  const w = el.clientWidth
  const h = el.clientHeight
  const dpr = devicePixelRatio || 1
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
    el.width = Math.round(w * dpr)
    el.height = Math.round(h * dpr)
  }
  const g = el.getContext('2d')
  if (!g) return
  const css = getComputedStyle(el)
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)
  const len = side === 'top' ? w : h
  const d = documents().active()
  if (!d) return
  g.strokeStyle = css.getPropertyValue('--ruler-tick') || '#888'
  g.fillStyle = css.getPropertyValue('--ruler-ink') || '#ccc'
  g.font = '10px system-ui, sans-serif'
  g.lineWidth = 1
  for (const seg of segmentsOf(side, len)) {
    g.save()
    // Each stretch drawn only within itself.
    g.beginPath()
    if (side === 'top') g.rect(seg.from, 0, seg.len, RULER)
    else g.rect(0, seg.from, RULER, seg.len)
    g.clip()
    drawStretch(g, side, d.key, d.history.present.resolution, seg.scale, seg.from, seg.len, seg.active, css)
    g.restore()
  }
}

/** One stretch of a ruler: its ticks and numbers, and the pointer's mark on the active one. */
function drawStretch(g: CanvasRenderingContext2D, side: 'top' | 'left', key: string, resolution: number, s: Scale | null, from: number, len: number, active: boolean, css: CSSStyleDeclaration) {
  if (!s) return
  const p = guidePrefs().get()
  const origin = origins().get(key)[s.axis === 'x' ? 0 : 1]
  // Units along the ruler per CSS pixel, and where it starts in them.
  const per = fromPixels(s.slope, p.units, resolution)
  const u0 = fromPixels(s.start - origin, p.units, resolution)
  if (!per) return
  const major = niceStep(Math.abs(per) * 64)
  const minorCount = major / 10 / Math.abs(per) >= 4 ? 10 : major / 5 / Math.abs(per) >= 4 ? 5 : 2
  const minor = major / minorCount
  const uEnd = u0 + per * len
  const lo = Math.min(u0, uEnd)
  const hi = Math.max(u0, uEnd)
  g.beginPath()
  for (let i = Math.ceil(lo / minor); i * minor <= hi && i - Math.ceil(lo / minor) < 2000; i++) {
    const u = i * minor
    const at = from + Math.round((u - u0) / per) + 0.5
    const isMajor = i % minorCount === 0
    const half = minorCount % 2 === 0 && i % (minorCount / 2) === 0
    const tick = isMajor ? RULER : half ? RULER * 0.45 : RULER * 0.25
    if (side === 'top') {
      g.moveTo(at, RULER)
      g.lineTo(at, RULER - tick)
    } else {
      g.moveTo(RULER, at)
      g.lineTo(RULER - tick, at)
    }
    if (isMajor) {
      const t = label(u, major)
      if (side === 'top') g.fillText(t, at + 3, 9)
      else {
        g.save()
        g.translate(9, at + 3)
        g.rotate(-Math.PI / 2)
        g.textAlign = 'right'
        g.fillText(t, 0, 0)
        g.restore()
      }
    }
  }
  g.stroke()
  // The pointer's place, on the stretch of the pane it's in.
  const at = pointer.get()
  if (active && at && at.key === key) {
    // Where the pointer's document point is along this ruler, from its own coordinate.
    const pos = ((s.axis === 'x' ? at.x + 0.5 : at.y + 0.5) - s.start) / s.slope
    if (pos >= 0 && pos <= len) {
      g.strokeStyle = css.getPropertyValue('--accent') || '#1a85ff'
      g.beginPath()
      const x = from + Math.round(pos) + 0.5
      if (side === 'top') {
        g.moveTo(x, 0)
        g.lineTo(x, RULER)
      } else {
        g.moveTo(0, x)
        g.lineTo(RULER, x)
      }
      g.stroke()
    }
  }
}

export function Rulers({ pointerOf, onMenu }: Props) {
  const top = useRef<HTMLCanvasElement>(null)
  const left = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ id: number; g: Gesture } | null>(null)

  // Drawn again whenever anything they show changes, at most once a frame.
  useEffect(() => {
    let raf = 0
    const redraw = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (top.current) draw(top.current, 'top')
        if (left.current) draw(left.current, 'left')
      })
    }
    const offs = [views().subscribe(redraw), documents().subscribe(redraw), guidePrefs().subscribe(redraw), origins().subscribe(redraw), pointer.subscribe(redraw)]
    const ro = new ResizeObserver(redraw)
    if (top.current) ro.observe(top.current)
    if (left.current) ro.observe(left.current)
    redraw()
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      for (const off of offs) off()
    }
  }, [])

  /** A press on a ruler: a new guide, parallel to it on screen (Alt: across it). */
  const pressRuler = (e: React.PointerEvent, side: 'top' | 'left') => {
    if (e.button !== 0 || drag.current) return
    const d = documents().active()
    const p = pointerOf(e)
    if (!d || !p) return
    e.preventDefault()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    // The document direction the ruler runs in: a guide along it is constant in the other axis.
    const v = views().front()!
    const c = engine().canvasSize()
    const a = docPoint(v, c, 0, 0)
    const b = side === 'top' ? docPoint(v, c, 1, 0) : docPoint(v, c, 0, 1)
    let axis: 'x' | 'y' = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 'y' : 'x'
    if (e.altKey) axis = axis === 'x' ? 'y' : 'x'
    drag.current = { id: e.pointerId, g: guideGesture(d, axis, -1, p, offCanvas) }
  }

  /** A press in the corner: the zero point, dragged to where it should be. */
  const pressCorner = (e: React.PointerEvent) => {
    if (e.button !== 0 || drag.current) return
    const d = documents().active()
    if (!d || !pointerOf(e)) return
    e.preventDefault()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    const snap = startSnap(d)
    let at: [number, number] | null = null
    const place = (p: Pointer) => {
      at = snap.point(p.x, p.y, p)
      setToolOverlay(d.key, {
        shapes: [
          { kind: 'guide', axis: 'x', at: at[0] },
          { kind: 'guide', axis: 'y', at: at[1] },
        ],
      })
      readout().set({ text: `X ${lengthText(at[0])}  Y ${lengthText(at[1])}`, x: p.dx, y: p.dy })
    }
    const end = () => {
      snap.end()
      readout().set(null)
      clearToolOverlay(d.key)
    }
    drag.current = {
      id: e.pointerId,
      g: {
        move: place,
        up(p) {
          end()
          if (!offCanvas(p) && at) origins().set(d.key, [Math.round(at[0] * 1000) / 1000, Math.round(at[1] * 1000) / 1000])
        },
        cancel: end,
      },
    }
  }

  const move = (e: React.PointerEvent) => {
    const g = drag.current
    if (!g || g.id !== e.pointerId) return
    const p = pointerOf(e)
    if (p) g.g.move(p)
  }
  const up = (e: React.PointerEvent) => {
    const g = drag.current
    if (!g || g.id !== e.pointerId) return
    drag.current = null
    const p = pointerOf(e)
    if (p && e.type === 'pointerup') g.g.up(p)
    else g.g.cancel()
  }
  const menu = (e: React.MouseEvent) => {
    e.preventDefault()
    onMenu(e.clientX, e.clientY)
  }
  const handlers = { onPointerMove: move, onPointerUp: up, onPointerCancel: up, onContextMenu: menu }
  const units = useSyncExternalStore(guidePrefs().subscribe, () => guidePrefs().get().units)

  return (
    <>
      <div
        className="ruler-corner"
        data-ruler="corner"
        data-tip="Drag to move the rulers’ zero point; double-click to put it back"
        onPointerDown={pressCorner}
        onDoubleClick={() => {
          const k = documents().getState().active
          if (k) origins().set(k, null)
        }}
        {...handlers}
      >
        {units}
      </div>
      <canvas ref={top} className="ruler ruler-top" data-ruler="top" onPointerDown={(e) => pressRuler(e, 'top')} {...handlers} />
      <canvas ref={left} className="ruler ruler-left" data-ruler="left" onPointerDown={(e) => pressRuler(e, 'left')} {...handlers} />
    </>
  )
}
