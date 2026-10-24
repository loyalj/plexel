/**
 * The canvas gestures of the Gradient tool, the Paint Bucket, Quick
 * Selection and the Magnetic Lasso, registered with the canvas's press
 * handling (canvasTools.ts) when this loads.
 *
 * - The Gradient tool drags a line. On a gradient fill layer, or a shape
 *   with a gradient (app/gradientEdit.ts says which of its fills and
 *   strokes), a press on its handles edits them there, and a drag anywhere
 *   else gives it a new line, live; otherwise it makes a gradient fill layer (masked by the selection) or,
 *   set to pixels, lays the gradient into the target through the selection.
 * - The Paint Bucket fills what the Magic Wand would select at the click,
 *   inside the selection.
 * - Quick Selection paints; each stretch of the stroke grows the selection
 *   (the engine's graph cut), shown as it goes and committed as one step.
 * - The Magnetic Lasso is a session, as the Polygonal Lasso is: a wire
 *   follows the strongest edges from the last anchor to the pointer, anchors
 *   drop by themselves where the wire has held still, a click drops one,
 *   and a click on the start, a double-click or Enter closes it.
 */
import { insertNode, invertAffine } from '../doc/edit'
import { makeNode } from '../doc/nodes'
import { freshName } from '../doc/tree'
import type { Affine, Doc, DocNode } from '../doc/types'
import type { Paint } from '../doc/vector'
import { engine } from '../engine/EngineHost'
import { stableAnchor } from '../select/liveWire'
import { ellipsePoints } from '../tiles/coverage'
import { CLICK, GRAB, dist, registerHover, registerMagnetic, registerTool, sessions, setToolOverlay, clearToolOverlay, snapped, toDevice, type Gesture, type Pointer, type Session } from './canvasTools'
import { startSnap } from './snapping'
import { swatchIn } from './colour'
import { documents, type OpenDoc } from './documents'
import { placeForNew } from './effects'
import { fillTools, presetStops } from './fillTools'
import { channelTarget, planesTarget } from './channels'
import { newFillLayer, paintTarget } from './fills'
import { notify } from './notices'
import { hold } from './pixels'
import { commitSelectionFrom, previewSelection, quickSelectStroke, selectShape } from './selection'
import { opFor, selectTools } from './selectTools'
import { views } from './views'
import { nearestCopy } from './tiling'
import { gradientEditPress, gradientTarget, withPaint, type GTarget } from './gradientEdit'

const store = () => documents()

// --- the Gradient tool -------------------------------------------------------------------------------

/** A layer with its gradient's line set (in the gradient's own coordinates). */
function withLine(doc: Doc, t: GTarget, line: [number, number, number, number]): Doc {
  return t.paint.kind === 'gradient' ? withPaint(doc, t, { ...t.paint, line }) : doc
}

/** The gradient the tool lays: its preset made from the colours, in the document's terms. */
function toolGradient(doc: Doc, line: [number, number, number, number]): Paint {
  const g = fillTools().get().gradient
  const black = doc.mode === 'cmyk' ? [0.75, 0.68, 0.67, 0.9] : doc.mode === 'gray' ? [0] : [0, 0, 0]
  const white = doc.mode === 'cmyk' ? [0, 0, 0, 0] : doc.mode === 'gray' ? [1] : [1, 1, 1]
  const fg = swatchIn(doc, 'fg') ?? black
  const bg = swatchIn(doc, 'bg') ?? white
  return { kind: 'gradient', type: g.type, stops: presetStops(g.preset, fg, bg, black, white), angle: 0, scale: 100, reverse: g.reverse, line }
}

function gradientGesture(d: OpenDoc, raw0: Pointer): Gesture {
  // Both ends snap.
  const snap = startSnap(d)
  const p0 = snapped(snap, raw0)
  const doc = d.history.present
  // A channel targeted (or some colour channels) is painted on: no fill layer, no live gradient.
  const onPixels = !!channelTarget(d) || !!planesTarget(d)
  // The selected layer's gradient (app/gradientEdit.ts says which), whose line the drag sets.
  const live = onPixels ? null : gradientTarget(d, (x) => x.kind === 'gradient' && !x.stroke)
  const g = { ...fillTools().get().gradient, ...(onPixels ? { makes: 'pixels' as const } : {}) }
  let end: [number, number] = [p0.x, p0.y]
  let moved = false
  const lineIn = (t: Affine): [number, number, number, number] => {
    const inv = invertAffine(t)
    const a = [inv[0] * p0.x + inv[2] * p0.y + inv[4], inv[1] * p0.x + inv[3] * p0.y + inv[5]]
    const b = [inv[0] * end[0] + inv[2] * end[1] + inv[4], inv[1] * end[0] + inv[3] * end[1] + inv[5]]
    return [a[0], a[1], b[0], b[1]]
  }
  // What a new fill layer would be, for the preview.
  const fresh = () => {
    const id = '__gradient_preview'
    const { parent, index } = placeForNew(d)
    return insertNode(doc, makeNode('fill', id, freshName(doc, 'Gradient Fill'), { paint: toolGradient(doc, [p0.x, p0.y, end[0], end[1]]) }), parent, index)
  }
  const show = () => {
    setToolOverlay(d.key, {
      shapes: [
        { kind: 'path', points: [[p0.x, p0.y], end], closed: false, style: 'line' },
        { kind: 'handles', points: [[p0.x, p0.y], end] },
      ],
    })
    if (live) engine().setScene(d.key, withLine(doc, live, lineIn(live.transform)))
    else if (g.makes === 'layer' && !doc.selection) engine().setScene(d.key, fresh())
  }
  const unpreview = () => {
    snap.end()
    clearToolOverlay(d.key)
    const now = store().get(d.key)
    if (now) engine().setScene(d.key, now.history.present)
  }
  return {
    move(raw) {
      moved ||= Math.hypot(raw.dx - raw0.dx, raw.dy - raw0.dy) >= CLICK
      if (!moved) return
      const p = raw.shiftKey ? raw : snapped(snap, raw)
      let x = p.x
      let y = p.y
      // Shift keeps the line to 45° steps.
      if (p.shiftKey) {
        const a = Math.round(Math.atan2(y - p0.y, x - p0.x) / (Math.PI / 4)) * (Math.PI / 4)
        const r = Math.hypot(x - p0.x, y - p0.y)
        x = p0.x + Math.cos(a) * r
        y = p0.y + Math.sin(a) * r
      }
      end = [x, y]
      show()
    },
    up() {
      unpreview()
      if (!moved || dist([p0.x, p0.y], end) < 1) return
      if (live) {
        const line = lineIn(live.transform)
        store().commit((x) => withLine(x, live, line), { key: d.key, label: 'Gradient' })
        return
      }
      const paint = toolGradient(doc, [p0.x, p0.y, end[0], end[1]])
      if (g.makes === 'layer') {
        void newFillLayer('gradient', paint).then((id) => {
          if (!id || (g.blend === 'normal' && g.opacity >= 1)) return
          store().commit((x) => ({ ...x, nodes: { ...x.nodes, [id]: { ...x.nodes[id], blend: g.blend, opacity: g.opacity } as DocNode } }), { key: d.key, label: 'Gradient Fill', coalesce: `new-gradient:${id}` })
        })
        return
      }
      void paintTarget(paint, { blend: g.blend, opacity: g.opacity, preserve: false }, 'Gradient')
    },
    cancel: unpreview,
  }
}

// A press on the selected gradient's handles edits them (app/gradientEdit.ts); anywhere else, a drag lays a line.
registerTool('gradient', (d, p) => {
  const g = onPixelsTarget(d) ? undefined : gradientEditPress(d, p)
  return g === undefined ? gradientGesture(d, p) : g
})

const onPixelsTarget = (d: OpenDoc) => !!channelTarget(d) || !!planesTarget(d)

// --- the Paint Bucket ----------------------------------------------------------------------------------

async function bucketAt(d: OpenDoc, x: number, y: number) {
  const doc = d.history.present
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return
  const b = fillTools().get().bucket
  try {
    const node = b.sampleAll ? null : (d.selected ?? null)
    // On an alpha or spot channel, the channel's own values decide what's filled.
    const ch = channelTarget(d)
    const area = await engine().call('select.wand', { key: d.key, x, y, tolerance: b.tolerance, contiguous: b.contiguous, node, antialias: b.antialias, op: 'replace', current: null, ...(ch ? { channel: ch.id } : {}) })
    if (!area) return
    const release = hold([area])
    // Only inside the selection, when there is one.
    const cover = doc.selection ? await engine().call('select.channel', { width: doc.width, height: doc.height, tiled: doc.tiled, tiles: area, transform: [1, 0, 0, 1, 0, 0], invert: false, op: 'intersect', current: doc.selection.tiles }) : area
    release()
    if (!cover) return
    let paint: Paint
    if (b.source === 'pattern') {
      const p = doc.patterns?.find((x) => x.id === b.pattern) ?? doc.patterns?.[0]
      if (!p) return notify('info', 'This document has no patterns yet. Define one (Edit → Define Pattern), or fill with the foreground colour.')
      paint = { kind: 'pattern', pattern: p.id, colour: [0, 0, 0], background: [1, 1, 1], backgroundAlpha: 1, size: p.width, angle: 0 }
    } else {
      const c = swatchIn(doc, 'fg')
      if (!c) return
      paint = { kind: 'solid', colour: c }
    }
    const keep = hold([cover])
    await paintTarget(paint, { blend: b.blend, opacity: b.opacity, preserve: false }, 'Paint Bucket', cover)
    keep()
  } catch (e) {
    notify('error', 'The Paint Bucket didn’t work.', [e instanceof Error ? e.message : String(e)])
  }
}

registerTool('bucket', (d, p) => {
  void bucketAt(d, Math.floor(p.x), Math.floor(p.y))
  return null
})

// --- Quick Selection ------------------------------------------------------------------------------------

/** The brush's outline at a point, for the overlay. */
const brushRing = (x: number, y: number, r: number) => ellipsePoints(x, y, r, r)

/** The selection Quick Selection last made, so the next stroke in New mode carries on with it. */
let lastQuick: { key: string; tiles: string | null } | null = null

function quickGesture(d: OpenDoc, p0: Pointer): Gesture {
  const q = selectTools().get().quick
  const op = opFor(p0, selectTools().get().op)
  const mode = op === 'subtract' ? 'subtract' : 'add'
  const doc = d.history.present
  // In New mode a stroke starts a new selection, unless the selection is still the one Quick
  // Selection made: then it adds, as Photoshop's does after its first stroke.
  const sel = doc.selection?.tiles ?? null
  const carryOn = op === 'replace' && !!sel && lastQuick?.key === d.key && lastQuick.tiles === sel
  let current: string | null = op === 'replace' && !carryOn ? null : sel
  const radius = q.size / 2
  const pts: [number, number][] = [[p0.x, p0.y]]
  let sent = 0
  let busy = false
  let done = false
  let release = () => {}
  let failed = false
  const ring = (x: number, y: number) => setToolOverlay(d.key, { shapes: [{ kind: 'path', points: brushRing(x, y, radius), closed: true, style: 'thin' }] })
  const finish = () => {
    clearToolOverlay(d.key)
    if (!failed && store().get(d.key)) {
      commitSelectionFrom(current, 'Quick Selection')
      lastQuick = { key: d.key, tiles: current }
    }
    release()
  }
  const step = async () => {
    if (busy) return
    if (sent >= pts.length) {
      if (done) finish()
      return
    }
    busy = true
    // From the last point sent, so the stroke runs on unbroken.
    const batch = pts.slice(Math.max(0, sent - 1))
    sent = pts.length
    try {
      const set = await quickSelectStroke(batch, radius, mode, q, current)
      const was = release
      release = set ? hold([set]) : () => {}
      was()
      current = set
      previewSelection(set)
    } catch (e) {
      failed = true
      notify('error', 'Quick Selection didn’t work.', [e instanceof Error ? e.message : String(e)])
    }
    busy = false
    void step()
  }
  ring(p0.x, p0.y)
  void step()
  return {
    move(p) {
      ring(p.x, p.y)
      const last = pts[pts.length - 1]
      if (Math.hypot(p.x - last[0], p.y - last[1]) < Math.max(1, radius / 4)) return
      pts.push([p.x, p.y])
      void step()
    },
    up() {
      done = true
      if (!busy) void step()
    },
    cancel() {
      done = true
      failed = true
      clearToolOverlay(d.key)
      const now = store().get(d.key)
      if (now) engine().setScene(d.key, now.history.present)
    },
  }
}

registerTool('quick', (d, p) => quickGesture(d, p))
registerHover('quick', (p) => {
  const d = store().active()
  if (d && views().front()) setToolOverlay(d.key, { shapes: [{ kind: 'path', points: brushRing(p.x, p.y, selectTools().get().quick.size / 2), closed: true, style: 'thin' }] })
})

// --- the Magnetic Lasso --------------------------------------------------------------------------------

/**
 * The Magnetic Lasso's session: the wire follows the strongest edge from
 * the last anchor to the pointer, anchors dropping as it holds still. As
 * in Photoshop, a click drops one, Alt-click a straight side to the point
 * clicked, and Backspace or Delete takes the last anchor back.
 */
function magneticSession(d: OpenDoc, p0: Pointer): Session {
  const o = selectTools().get().lasso
  const op = opFor(p0, selectTools().get().op)
  const node = d.selected ?? null
  const fixed: [number, number][] = [[p0.x, p0.y]]
  /** How long `fixed` was at each anchor dropped after the first, for Backspace. */
  const anchors: number[] = []
  /** Counts anchors placed and taken back: a wire worked out from an anchor since changed is thrown away. */
  let epoch = 0
  let anchor: [number, number] = [p0.x, p0.y]
  let wire: [number, number][] = []
  let prev: [number, number][] | undefined
  let want: [number, number] | null = null
  let busy = false
  let lastClick = 0
  let over = false
  const show = () => setToolOverlay(d.key, { shapes: [{ kind: 'path', points: [...fixed, ...wire.slice(1)], closed: false, style: 'ants' }] })
  // The first click lands on the strongest edge near it.
  void engine()
    .call('select.snap', { key: d.key, node, x: p0.x, y: p0.y, radius: o.width })
    .then((p) => {
      if (fixed.length === 1) {
        fixed[0] = p
        anchor = p
        show()
      }
    })
    .catch(() => {})
  const pull = async () => {
    if (busy || !want || over) return
    busy = true
    const to = want
    const from = epoch
    want = null
    try {
      const path = await engine().call('select.wire', { key: d.key, node, from: anchor, to, width: o.width, contrast: o.contrast })
      if (over || from !== epoch) return
      wire = path
      // An anchor drops where the wire has held still long enough.
      const k = stableAnchor(path, o.frequency, prev)
      if (k > 0) {
        anchors.push(fixed.length)
        fixed.push(...path.slice(1, k + 1))
        anchor = path[k]
        wire = path.slice(k)
        prev = undefined
      } else prev = path
      show()
    } catch {
      // A wire that can't be found leaves the last one showing.
    } finally {
      busy = false
      if (want) void pull()
    }
  }
  const close = () => sessions().commit()
  show()
  const s: Session = {
    kind: 'polygon',
    key: d.key,
    down(p) {
      const dev = toDevice()
      const now = performance.now()
      const onFirst = fixed.length + wire.length > 3 && dist(dev(...fixed[0]), [p.dx, p.dy]) < GRAB
      if (onFirst || (now - lastClick < 350 && fixed.length > 2)) {
        close()
        return null
      }
      lastClick = now
      anchors.push(fixed.length)
      // Alt: a straight side to the point clicked; otherwise the wire fixed as it is, an anchor at its end.
      if (p.altKey) fixed.push(nearestCopy(d.history.present, [p.x, p.y], anchor))
      else if (wire.length > 1) fixed.push(...wire.slice(1))
      anchor = fixed[fixed.length - 1]
      epoch++
      wire = []
      prev = undefined
      show()
      return { move: (q) => s.hover!(q), up: () => {}, cancel: () => {} }
    },
    hover(p) {
      // In a tiled document, the copy nearest the last anchor: the wire stays whole over a seam.
      want = nearestCopy(d.history.present, [p.x, p.y], anchor)
      void pull()
    },
    takeKey(e, down) {
      if (!down || (e.key !== 'Backspace' && e.key !== 'Delete')) return false
      const at = anchors.pop()
      if (at === undefined) {
        sessions().end(true)
        return true
      }
      fixed.length = at
      anchor = fixed[fixed.length - 1]
      epoch++
      wire = []
      prev = undefined
      show()
      return true
    },
    commit() {
      over = true
      const pts = [...fixed, ...wire.slice(1)]
      if (pts.length > 2) selectShape({ kind: 'polygon', points: pts }, op, o, 'Magnetic Lasso')
    },
    cancel() {
      over = true
    },
    readout: () => 'Trace the edge; click to drop a point, Alt-click for a straight side, Backspace to take one back. Click the start, double-click or press Enter to close; Esc cancels.',
  }
  return s
}

registerMagnetic((d, p) => sessions().start(magneticSession(d, p)))


