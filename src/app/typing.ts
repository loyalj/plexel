/**
 * The Type tool (T) and editing text on the canvas.
 *
 * A click starts point text there; a drag, area text in the box dragged; a
 * click on a shape's outline, text along its path; a click in existing text
 * edits it. Editing is a session (app/canvasTools.ts): the text takes the
 * keyboard through a hidden text field kept at the caret, so typing, IME
 * composition (and its candidate window, in the right place) and the
 * clipboard all go through the browser's own text input. Each change is
 * committed as it's made, a run of typing as one step; the session lives on
 * through its own edits, and through Undo and Redo, which it does itself.
 *
 * New text isn't in the document until something is typed: a click that
 * types nothing leaves no step and no empty layer behind.
 */
import { addVector, invertAffine, setTextContent } from '../doc/edit'
import { freshName, layerRows, placeOf } from '../doc/tree'
import { makeNode } from '../doc/nodes'
import {
  contentFrom,
  deleteRange,
  locate,
  paragraphStart,
  paragraphText,
  plainText,
  replaceRange,
  resolveChar,
  resolvePara,
  runAtPos,
  styleParagraphs,
  styleRange,
  textLength,
  type CharProps,
  type ParaProps,
  type TextContent,
} from '../doc/text'
import type { Affine, Doc, DocNode, NodeId } from '../doc/types'
import { fillItem, geometryPath, solid, type Geometry } from '../doc/vector'
import { applyMat, flattenPath, transformPath, type Pt } from '../geom/path'
import { hitSegment } from '../geom/edit'
import { caretAt, caretX, hitPosition, lineOf, selectionBoxes, stepChar, stepLine, stepWord, wordAt } from '../text/caret'
import { distanceAlong, type TextLayout } from '../text/layout'
import { engine } from '../engine/EngineHost'
import type { OverlayShape } from '../render/overlay'
import { viewMatrix } from '../render/view'
import { tools } from '../tools'
import { swatchIn } from './colour'
import { clearToolOverlay, registerTool, sessions, setToolOverlay, snapped, type Gesture, type Pointer, type Session } from './canvasTools'
import { startSnap } from './snapping'
import { documents, newId, type OpenDoc } from './documents'
import { layoutOf, startFonts } from './text'
import { typeSettings } from './typeSettings'
import { views } from './views'

type TextNode = DocNode & { kind: 'text' }

/** How near text a press must be to edit it, in device pixels. */
const NEAR = 6
/** Below this many device pixels a press is a click. */
const CLICK = 3

function docRadius(devicePx: number): number {
  const v = views().front()
  if (!v) return devicePx
  const m = viewMatrix(v, engine().canvasSize())
  return devicePx / (Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1)
}

// --- path text's geometry ------------------------------------------------------------------------

/** Path text's path as a polyline with distances along it, for carets and highlights. */
function pathOf(node: TextNode): { pts: number[]; cum: number[] } | null {
  if (node.props.mode !== 'path' || !node.props.frame) return null
  const line = flattenPath(geometryPath(node.props.frame), 0.25)[0]
  if (!line) return null
  const pts = line.pts
  const cum = [0]
  for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]))
  return { pts, cum }
}

/** A point of a line's coordinates (x along, y below the baseline) in the node's: on a path, bent onto it. */
function lineToNode(path: ReturnType<typeof pathOf>, x: number, y: number): Pt {
  if (!path) return [x, y]
  const { pts, cum } = path
  const total = cum[cum.length - 1]
  const s = Math.min(total, Math.max(0, x))
  let k = 1
  while (k < cum.length - 1 && cum[k] < s) k++
  const seg = cum[k] - cum[k - 1] || 1
  const t = (s - cum[k - 1]) / seg
  const ax = pts[(k - 1) * 2]
  const ay = pts[(k - 1) * 2 + 1]
  const bx = pts[k * 2]
  const by = pts[k * 2 + 1]
  const a = Math.atan2(by - ay, bx - ax)
  return [ax + (bx - ax) * t - Math.sin(a) * y, ay + (by - ay) * t + Math.cos(a) * y]
}

// --- the session -------------------------------------------------------------------------------

interface Pending {
  node: TextNode
  parent: NodeId
  index: number
}

class TypeSession implements Session {
  readonly kind = 'type' as const
  /** [anchor, focus]: where the selection began and where its caret is. */
  sel: [number, number] = [0, 0]
  /** Settings for what's typed next at a caret, from the Character panel. */
  nextStyle: Partial<CharProps> | null = null
  private goalX: number | null = null
  private composing: string | null = null
  private input: HTMLTextAreaElement | null = null
  private lastClick = { at: 0, pos: -1, count: 0 }

  constructor(
    readonly key: string,
    readonly id: NodeId,
    /** A new text node not in the document yet: it goes in with the first character typed. */
    private pending: Pending | null,
  ) {}

  // The document and node as they are, with a pending node put in.
  doc(): Doc {
    const d = documents().get(this.key)!.history.present
    if (!this.pending) return d
    const p = this.pending
    const parent = d.nodes[p.parent] ?? d.nodes[d.root]
    const kids = [...(parent.children ?? [])]
    kids.splice(Math.min(p.index, kids.length), 0, p.node.id)
    return { ...d, nodes: { ...d.nodes, [p.node.id]: p.node, [parent.id]: { ...parent, children: kids } as DocNode } }
  }
  node(): TextNode | null {
    const n = this.doc().nodes[this.id]
    return n?.kind === 'text' ? n : null
  }
  layout(): TextLayout | null {
    const n = this.node()
    return n ? layoutOf(n, this.doc()) : null
  }
  content(): TextContent {
    return this.node()?.props.content ?? contentFrom('')
  }

  accepts(doc: Doc): boolean {
    return doc.nodes[this.id]?.kind === 'text'
  }

  // --- changes ---

  /** Replaces the content (and the selection): committed, a run of typing folding into one step. */
  private change(content: TextContent, sel: [number, number], label = 'Typing') {
    const d = documents().get(this.key)
    if (!d) return
    if (this.pending) {
      const p = this.pending
      const node = { ...p.node, props: { ...p.node.props, content } } as DocNode
      this.pending = null
      documents().commit((x) => {
        const parent = x.nodes[p.parent] ? p.parent : x.root
        const kids = [...(x.nodes[parent].children ?? [])]
        kids.splice(Math.min(p.index, kids.length), 0, node.id)
        return { ...x, nodes: { ...x.nodes, [node.id]: node, [parent]: { ...x.nodes[parent], children: kids } as DocNode } }
      }, { key: this.key, label: 'New Text', coalesce: this.burstKey() })
      documents().select(this.id, this.key)
    } else documents().commit((x) => setTextContent(x, this.id, content), { key: this.key, label, coalesce: this.burstKey() })
    this.sel = sel
    this.goalX = null
    this.refresh()
  }

  /** Text in at the selection, replacing what's selected. */
  insert(text: string) {
    if (!text) return
    const [a, b] = this.range()
    const c = this.content()
    const as = this.nextStyle ? { style: runAtPos(c, a).run.style, props: { ...runAtPos(c, a).run.props, ...this.nextStyle } } : undefined
    const next = replaceRange(c, a, b, text, as)
    const at = a + text.replace(/\r\n?/g, '\n').length
    this.nextStyle = null
    this.change(next, [at, at])
  }

  /** Delete or Backspace: the selection, or a character (a word with Ctrl) either side of the caret. */
  remove(dir: 1 | -1, word: boolean) {
    const [a, b] = this.range()
    const text = plainText(this.content())
    let from = a
    let to = b
    if (a === b) {
      if (dir < 0) from = word ? stepWord(text, a, -1) : stepChar(text, a, -1)
      else to = word ? stepWord(text, a, 1) : stepChar(text, a, 1)
    }
    if (from === to) return
    this.change(deleteRange(this.content(), from, to), [from, from], 'Typing')
  }

  range(): [number, number] {
    return this.sel[0] <= this.sel[1] ? [this.sel[0], this.sel[1]] : [this.sel[1], this.sel[0]]
  }

  /**
   * Typing folds into one step until the caret is moved some other way (a
   * click, the arrows, a selection, Undo): then a new run of typing starts
   * a new step, so each undoes on its own.
   */
  private burst = 0
  private burstKey() {
    return `type:${this.id}:${this.burst}`
  }

  select(anchor: number, focus: number) {
    this.burst++
    const len = textLength(this.content())
    this.sel = [Math.max(0, Math.min(len, anchor)), Math.max(0, Math.min(len, focus))]
    this.refresh()
  }

  /** Character settings on the selection, or (a caret) on what's typed next. */
  styleChars(patch: Partial<CharProps>, style?: string | null, coalesce?: string) {
    const [a, b] = this.range()
    if (a === b) {
      this.nextStyle = { ...(this.nextStyle ?? {}), ...patch }
      // An empty text's only run takes it now, so its line shows the size.
      if (textLength(this.content()) === 0) this.change(styleRange(this.content(), 0, 1, patch, style), this.sel, 'Character')
      this.refresh()
      return
    }
    const d = documents().get(this.key)
    if (!d || this.pending) return
    documents().commit((x) => setTextContent(x, this.id, styleRange(this.content(), a, b, patch, style)), { key: this.key, label: 'Character', coalesce })
    this.refresh()
  }

  styleParas(patch: Partial<ParaProps>, style?: string | null, coalesce?: string) {
    const [a, b] = this.range()
    const next = styleParagraphs(this.content(), a, b, patch, style)
    if (this.pending) {
      this.pending = { ...this.pending, node: { ...this.pending.node, props: { ...this.pending.node.props, content: next } } }
      engine().setScene(this.key, this.doc())
      this.refresh()
      return
    }
    documents().commit((x) => setTextContent(x, this.id, next), { key: this.key, label: 'Paragraph', coalesce })
    this.refresh()
  }

  // --- keys ---

  onKey(e: KeyboardEvent): boolean {
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey
    const text = plainText(this.content())
    const [a, b] = this.range()
    const caret = this.sel[1]
    const move = (to: number, keepGoal = false) => {
      if (!keepGoal) this.goalX = null
      if (e.shiftKey) this.select(this.sel[0], to)
      else this.select(to, to)
    }
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = e.key === 'ArrowRight' ? 1 : -1
        // A selection collapses to its end the arrow points at.
        if (a !== b && !e.shiftKey) move(dir > 0 ? b : a)
        else move(mod ? stepWord(text, caret, dir) : stepChar(text, caret, dir))
        return true
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        const l = this.layout()
        if (!l) return true
        const c = caretAt(l, caret)
        this.goalX ??= c?.x ?? 0
        const to = stepLine(l, caret, e.key === 'ArrowDown' ? 1 : -1, this.goalX)
        move(to ?? (e.key === 'ArrowDown' ? text.length : 0), true)
        return true
      }
      case 'Home':
      case 'End': {
        const l = this.layout()
        if (mod || !l?.lines.length) move(e.key === 'Home' ? 0 : text.length)
        else {
          const line = l.lines[lineOf(l, caret)]
          move(e.key === 'Home' ? line.start : line.end)
        }
        return true
      }
      case 'Backspace':
      case 'Delete':
        this.remove(e.key === 'Delete' ? 1 : -1, mod)
        return true
      case 'Enter':
        if (mod) {
          sessions().commit()
          return true
        }
        // Shift+Enter breaks the line without starting a paragraph.
        this.insert(e.shiftKey ? '\u2028' : '\n')
        return true
      case 'Escape':
        sessions().commit()
        return true
      case 'Tab':
        this.insert('\t')
        return true
    }
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase()
      if (k === 'a') {
        this.select(0, text.length)
        return true
      }
      if (k === 'z' || k === 'y') {
        if (k === 'y' || e.shiftKey) documents().redo()
        else documents().undo()
        // Undone back past the text's making: nothing left to edit.
        if (!documents().get(this.key)?.history.present.nodes[this.id]) sessions().end(false)
        else this.select(this.sel[0], this.sel[1])
        return true
      }
    }
    return false
  }

  // --- the hidden field ---

  /** Puts the hidden text field at the caret (for an IME's window) and gives it the keys. */
  focus() {
    if (!this.input) {
      const ta = document.createElement('textarea')
      ta.setAttribute('data-type-input', '')
      ta.setAttribute('aria-label', 'Text')
      ta.autocapitalize = 'off'
      ta.spellcheck = false
      Object.assign(ta.style, { position: 'fixed', left: '0px', top: '0px', width: '2px', height: '1em', opacity: '0', padding: '0', border: '0', resize: 'none', overflow: 'hidden', zIndex: '0', pointerEvents: 'none' })
      ta.addEventListener('keydown', (e) => {
        if (this.composing !== null || e.isComposing) return
        if (this.onKey(e)) {
          e.preventDefault()
          e.stopPropagation()
        } else if (!e.ctrlKey && !e.metaKey) e.stopPropagation()
      })
      ta.addEventListener('input', () => {
        if (this.composing !== null) return
        const v = ta.value
        ta.value = ''
        this.insert(v)
      })
      ta.addEventListener('compositionstart', () => {
        this.composing = ''
      })
      ta.addEventListener('compositionupdate', (e) => {
        this.composing = (e as CompositionEvent).data ?? ''
        this.showComposition()
      })
      ta.addEventListener('compositionend', (e) => {
        const data = (e as CompositionEvent).data ?? ''
        this.composing = null
        ta.value = ''
        if (data) this.insert(data)
        else this.refresh()
      })
      ta.addEventListener('copy', (e) => this.clip(e as ClipboardEvent, false))
      ta.addEventListener('cut', (e) => this.clip(e as ClipboardEvent, true))
      ta.addEventListener('paste', (e) => {
        const t = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? ''
        e.preventDefault()
        this.insert(t)
      })
      document.body.append(ta)
      this.input = ta
    }
    this.placeInput()
    this.input.focus({ preventScroll: true })
  }

  private clip(e: ClipboardEvent, cut: boolean) {
    const [a, b] = this.range()
    if (a === b) return
    e.clipboardData?.setData('text/plain', plainText(this.content()).slice(a, b).replace(/\u2028/g, '\n'))
    e.preventDefault()
    if (cut) this.remove(1, false)
  }

  /** The field moved to the caret on screen, in CSS pixels. */
  private placeInput() {
    const ta = this.input
    const n = this.node()
    const l = this.layout()
    const v = views().front()
    const canvas = document.querySelector<HTMLCanvasElement>('[data-engine-canvas]')
    if (!ta || !n || !l || !v || !canvas) return
    const c = caretAt(l, this.sel[1])
    const line = c ? l.lines[c.line] : null
    const p = line ? applyMat(n.transform, ...lineToNode(pathOf(n), c!.x, line.baseline)) : applyMat(n.transform, 0, 0)
    const m = viewMatrix(v, engine().canvasSize())
    const [dx, dy] = applyMat(m, p[0], p[1])
    const r = canvas.getBoundingClientRect()
    const k = r.width / Math.max(1, engine().canvasSize().width)
    ta.style.left = `${r.left + dx * k}px`
    ta.style.top = `${r.top + dy * k}px`
  }

  /** An IME's text in progress, shown in place (not a step) until it's chosen. */
  private showComposition() {
    const [a, b] = this.range()
    const c = replaceRange(this.content(), a, b, this.composing ?? '')
    const d = this.doc()
    engine().setScene(this.key, { ...d, nodes: { ...d.nodes, [this.id]: { ...d.nodes[this.id], props: { ...(d.nodes[this.id] as TextNode).props, content: c } } as DocNode } })
    this.drawOverlay(c, a, a + (this.composing ?? '').length)
  }

  // --- pointer ---

  /** Whether a document point is on this text (its lines, or area text's frame). */
  hits(p: Pointer): number | null {
    const n = this.node()
    const l = this.layout()
    if (!n || !l) return null
    return hitText(n, l, p)
  }

  down(p: Pointer): Gesture | null {
    const pos = this.hits(p)
    if (pos === null) {
      // Pressed outside the text: done with it, and the press goes on to the tool.
      sessions().commit()
      return null
    }
    const now = performance.now()
    const same = now - this.lastClick.at < 450 && Math.abs(this.lastClick.pos - pos) <= 1
    this.lastClick = { at: now, pos, count: same ? this.lastClick.count + 1 : 1 }
    const text = plainText(this.content())
    if (this.lastClick.count === 2) {
      const [w0, w1] = wordAt(text, pos)
      this.select(w0, w1)
    } else if (this.lastClick.count >= 3) {
      const { para } = locate(this.content(), pos)
      const s = paragraphStart(this.content(), para)
      this.select(s, s + paragraphText(this.content().paragraphs[para]).length)
    } else this.select(p.shiftKey ? this.sel[0] : pos, pos)
    this.focus()
    return {
      move: (q) => {
        const at = this.hits(q) ?? this.nearest(q)
        if (at !== null && this.lastClick.count === 1) this.select(this.sel[0], at)
      },
      up: () => this.focus(),
      cancel: () => {},
    }
  }

  /** The position nearest a point anywhere: dragging past the text's edge still selects. */
  private nearest(p: Pointer): number | null {
    const n = this.node()
    const l = this.layout()
    if (!n || !l) return null
    const q = applyMat(invertAffine(n.transform), p.x, p.y)
    return hitPosition(l, q[0], q[1])
  }

  // --- drawing ---

  refresh() {
    if (this.pending) engine().setScene(this.key, this.doc())
    const [a, b] = this.range()
    this.drawOverlay(this.content(), a, b)
    this.placeInput()
    for (const fn of listeners) fn()
  }

  /** The caret, the selection's highlight, and the frame or path, over the canvas. */
  private drawOverlay(content: TextContent, a: number, b: number) {
    const n = this.node()
    if (!n) return
    const shown = content === n.props.content ? n : ({ ...n, props: { ...n.props, content } } as TextNode)
    const l = layoutOf(shown, this.doc())
    if (!l) return
    const path = pathOf(n)
    const toDoc = (x: number, y: number) => applyMat(n.transform, ...lineToNode(path, x, y))
    const shapes: OverlayShape[] = []
    const quads: [number, number][] = []
    for (const [x0, x1, t, bt] of selectionBoxes(l, a, b)) {
      if (path) {
        // Along a path, a box in steps, bent with it.
        const steps = Math.max(1, Math.ceil((x1 - x0) / 4))
        for (let i = 0; i < steps; i++) {
          const u = x0 + ((x1 - x0) * i) / steps
          const w = x0 + ((x1 - x0) * (i + 1)) / steps
          quads.push(toDoc(u, t), toDoc(w, t), toDoc(w, bt), toDoc(u, bt))
        }
      } else quads.push(toDoc(x0, t), toDoc(x1, t), toDoc(x1, bt), toDoc(x0, bt))
    }
    if (quads.length) shapes.push({ kind: 'quads', points: quads })
    if (a === b || this.composing) {
      const c = caretAt(l, this.composing ? a + this.composing.length : b)
      const line = c ? l.lines[c.line] : null
      if (c && line) shapes.push({ kind: 'path', points: [toDoc(c.x, line.top), toDoc(c.x, line.bottom)], closed: false, style: 'line' })
    }
    // An IME's text in progress is underlined.
    if (this.composing) for (const [x0, x1, , bt] of selectionBoxes(l, a, a + this.composing.length)) shapes.push({ kind: 'path', points: [toDoc(x0, bt), toDoc(x1, bt)], closed: false, style: 'thin' })
    if (n.props.frame) {
      for (const line of flattenPath(geometryPath(n.props.frame), docRadius(0.5))) {
        const pts: [number, number][] = []
        for (let i = 0; i < line.pts.length; i += 2) pts.push(applyMat(n.transform, line.pts[i], line.pts[i + 1]))
        shapes.push({ kind: 'path', points: pts, closed: line.closed, style: 'thin' })
      }
    }
    setToolOverlay(this.key, { shapes, hideAnts: false })
  }

  // --- ending ---

  commit() {
    this.tidy()
    this.drop()
  }

  cancel() {
    this.tidy()
    this.drop()
  }

  /** Names a new text layer after its text, as Photoshop does. */
  private tidy() {
    if (this.pending) {
      // Nothing was typed: the new layer was never made.
      const d = documents().get(this.key)
      if (d) engine().setScene(this.key, d.history.present)
      return
    }
    const n = documents().get(this.key)?.history.present.nodes[this.id]
    if (n?.kind !== 'text' || !autoNamed.has(this.id)) return
    const name = plainText(n.props.content).replace(/[\s\u2028]+/g, ' ').trim().slice(0, 40)
    if (name && name !== n.name) documents().commit((x) => ({ ...x, nodes: { ...x.nodes, [this.id]: { ...x.nodes[this.id], name } as DocNode } }), { key: this.key, label: 'Typing', coalesce: this.burstKey() })
  }

  private drop() {
    this.input?.remove()
    this.input = null
    clearToolOverlay(this.key)
    if (current === this) current = null
    for (const fn of listeners) fn()
  }

  readout(): string {
    const [a, b] = this.range()
    return a === b ? 'Typing: Esc or Ctrl+Enter to finish; Enter starts a paragraph, Shift+Enter a new line.' : `${b - a} character${b - a === 1 ? '' : 's'} selected.`
  }
}

const autoNamed = new Set<NodeId>()
let current: TypeSession | null = null
const listeners = new Set<() => void>()

/** The text being edited, if any: the Character and Paragraph panels act on it. */
export const typing = () => (current && sessions().get() === current ? current : null)
export const subscribeTyping = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Where on a text node a document point is: a position, or null when it's not on the text. */
function hitText(n: TextNode, l: TextLayout, p: Pointer): number | null {
  const q = applyMat(invertAffine(n.transform), p.x, p.y)
  const r = docRadius(NEAR)
  const path = pathOf(n)
  if (path) {
    // Along a path: the caret nearest the point, if it's near enough.
    let best: number | null = null
    let bd = Infinity
    for (const line of l.lines) {
      for (let pos = line.start; pos <= line.end; pos++) {
        const x = caretX(line, pos)
        const c = lineToNode(path, x, (line.top + line.bottom) / 2)
        const d = Math.hypot(c[0] - q[0], c[1] - q[1])
        if (d < bd) {
          bd = d
          best = pos
        }
      }
    }
    return bd <= Math.max(r, (l.lines[0]?.bottom ?? 0) - (l.lines[0]?.top ?? 0)) ? best : null
  }
  if (n.props.mode === 'area' && n.props.frame) {
    const fb = flattenPath(geometryPath(n.props.frame), 1)[0]
    if (fb) {
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (let i = 0; i < fb.pts.length; i += 2) {
        x0 = Math.min(x0, fb.pts[i])
        x1 = Math.max(x1, fb.pts[i])
        y0 = Math.min(y0, fb.pts[i + 1])
        y1 = Math.max(y1, fb.pts[i + 1])
      }
      if (q[0] >= x0 - r && q[0] <= x1 + r && q[1] >= y0 - r && q[1] <= y1 + r) return hitPosition(l, q[0], q[1])
    }
    return null
  }
  for (const line of l.lines) {
    const x0 = Math.min(line.x0, ...line.boxes.map((b) => b[0]))
    const x1 = Math.max(line.x1, ...line.boxes.map((b) => b[1]))
    if (q[0] >= x0 - r && q[0] <= x1 + r && q[1] >= line.top - r && q[1] <= line.bottom + r) return hitPosition(l, q[0], q[1])
  }
  return null
}

/** Starts editing a text node, the caret at `pos`. */
export function editText(d: OpenDoc, id: NodeId, pos: number | null, pending: Pending | null = null) {
  const s = new TypeSession(d.key, id, pending)
  current = s
  sessions().start(s)
  const len = textLength(s.content())
  const at = pos ?? len
  s.select(at, at)
  s.focus()
  return s
}

/** Where a new layer goes: above the selected one, in its group. */
function newLayerPlace(doc: Doc, selected: NodeId | null): { parent: NodeId; index: number } {
  const place = selected ? placeOf(doc, selected) : null
  if (place?.slot === 'children' && doc.nodes[place.parent].kind !== 'boolean') return { parent: place.parent, index: place.index + 1 }
  return { parent: doc.root, index: doc.nodes[doc.root].children?.length ?? 0 }
}

/** New text: point text at a point, area text in a frame, or path text along a path. */
function newText(d: OpenDoc, mode: 'point' | 'area' | 'path', transform: Affine, frame: Geometry | null, pathOffset = 0) {
  const doc = d.history.present
  const settings = typeSettings().get()
  const fg = swatchIn(doc, 'fg') ?? (doc.mode === 'cmyk' ? [0, 0, 0, 1] : doc.mode === 'gray' ? [0] : [0, 0, 0])
  const id = newId('n')
  const content = contentFrom('', settings.char)
  content.paragraphs[0] = { ...content.paragraphs[0], props: { ...settings.para } }
  const node = makeNode('text', id, freshName(doc, 'Text'), { mode, content, frame, pathOffset, appearance: [fillItem(solid(fg))] }) as TextNode
  node.transform = transform
  autoNamed.add(id)
  const { parent, index } = newLayerPlace(doc, d.selected)
  editText(d, id, 0, { node, parent, index })
}

/** The text layer under a point, topmost first, and where on it. */
function textAt(d: OpenDoc, p: Pointer): { id: NodeId; pos: number } | null {
  const doc = d.history.present
  for (const { node } of layerRows(doc)) {
    if (node.kind !== 'text' || !node.visible) continue
    const l = layoutOf(node, doc)
    if (!l) continue
    const pos = hitText(node, l, p)
    if (pos !== null) return { id: node.id, pos }
  }
  return null
}

/** A shape whose outline is under a point: path text goes along it. */
function outlineAt(d: OpenDoc, p: Pointer): Geometry | null {
  const doc = d.history.present
  for (const { node } of layerRows(doc)) {
    if (node.kind !== 'vector' || !node.visible || !node.props.geometry) continue
    const path = geometryPath(node.props.geometry)
    const q = applyMat(invertAffine(node.transform), p.x, p.y)
    const scale = Math.sqrt(Math.abs(node.transform[0] * node.transform[3] - node.transform[1] * node.transform[2])) || 1
    if (hitSegment(path, q[0], q[1], docRadius(NEAR) / scale)) return { kind: 'path', path: transformPath(path, node.transform) }
  }
  return null
}

/** A press with the Type tool. */
async function typePress(d: OpenDoc, p0: Pointer): Promise<Gesture | null> {
  await startFonts()
  const hit = textAt(d, p0)
  if (hit) {
    documents().select(hit.id, d.key)
    const s = editText(d, hit.id, hit.pos)
    return s.down(p0)
  }
  const path = outlineAt(d, p0)
  if (path && path.kind === 'path') {
    // As in Illustrator: a closed shape's outline takes area text inside it;
    // an open path, or a closed one with Alt, text along it from the click.
    const closed = path.path.subpaths.length > 0 && path.path.subpaths.every((s) => s.closed)
    if (closed && !p0.altKey) newText(d, 'area', [1, 0, 0, 1, 0, 0], path)
    else newText(d, 'path', [1, 0, 0, 1, 0, 0], path, distanceAlong(path.path, p0.x, p0.y))
    return null
  }
  let moved = false
  // A new text's point, or its frame's corners, snap.
  const snap = startSnap(d)
  const raw0 = p0
  p0 = snapped(snap, raw0)
  return {
    move(raw) {
      const p = snapped(snap, raw)
      if (Math.hypot(raw.dx - raw0.dx, raw.dy - raw0.dy) >= CLICK) moved = true
      if (moved) setToolOverlay(d.key, { shapes: [{ kind: 'path', points: [[p0.x, p0.y], [p.x, p0.y], [p.x, p.y], [p0.x, p.y]], closed: true, style: 'thin' }] })
    },
    up(raw) {
      const p = snapped(snap, raw)
      snap.end()
      clearToolOverlay(d.key)
      if (moved && Math.abs(p.x - p0.x) > 2 && Math.abs(p.y - p0.y) > 2) {
        const x = Math.min(p0.x, p.x)
        const y = Math.min(p0.y, p.y)
        const frame: Geometry = { kind: 'shape', shape: { type: 'rect', x: 0, y: 0, w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y), radii: [0, 0, 0, 0], corner: 'round' } }
        newText(d, 'area', [1, 0, 0, 1, x, y], frame)
      } else newText(d, 'point', [1, 0, 0, 1, p0.x, p0.y], null)
    },
    cancel() {
      snap.end()
      clearToolOverlay(d.key)
    },
  }
}

registerTool('type', (d, p) => {
  // The press is answered once the fonts are in; a gesture that arrives late still gets the pointer's later events.
  let g: Gesture | null = null
  let ended: Pointer | null = null
  let last: Pointer | null = null
  void typePress(d, p).then((r) => {
    g = r
    if (g && last) g.move(last)
    if (g && ended) g.up(ended)
  })
  return {
    move: (q) => (g ? g.move(q) : (last = q)),
    up: (q) => (g ? g.up(q) : (ended = q)),
    cancel: () => g?.cancel(),
  }
})

// Leaving the Type tool finishes the text being edited.
tools().subscribe(() => {
  const s = sessions().get()
  if (s?.kind === 'type' && tools().get() !== 'type') sessions().commit()
})

// --- what the panels act on --------------------------------------------------------------------

/** The text the Character and Paragraph panels act on: being edited, or a selected text layer, or none (new text's settings). */
export function typeTarget(): { kind: 'editing'; s: TypeSession } | { kind: 'layer'; d: OpenDoc; node: TextNode } | { kind: 'defaults' } {
  const s = typing()
  if (s) return { kind: 'editing', s }
  const d = documents().active()
  const n = d?.selected ? d.history.present.nodes[d.selected] : null
  if (d && n?.kind === 'text') return { kind: 'layer', d, node: n }
  return { kind: 'defaults' }
}

/** The character settings shown: at the caret (or the selection's start), the layer's first, or new text's. */
export function shownChar(): CharProps {
  const t = typeTarget()
  if (t.kind === 'editing') {
    const c = t.s.content()
    const [a, b] = t.s.range()
    const { run, para } = runAtPos(c, a === b ? a : a + 1)
    return { ...resolveChar(run, para, t.s.doc().textStyles), ...(t.s.nextStyle ?? {}) }
  }
  if (t.kind === 'layer') {
    const p = t.node.props.content.paragraphs[0]
    return resolveChar(p.runs[0], p, t.d.history.present.textStyles)
  }
  return resolveChar({ style: null, props: typeSettings().get().char }, { style: null })
}

export function shownPara(): ParaProps {
  const t = typeTarget()
  if (t.kind === 'editing') {
    const c = t.s.content()
    return resolvePara(c.paragraphs[locate(c, t.s.range()[0]).para], t.s.doc().textStyles)
  }
  if (t.kind === 'layer') return resolvePara(t.node.props.content.paragraphs[0], t.d.history.present.textStyles)
  return resolvePara({ runs: [], style: null, props: typeSettings().get().para })
}

/** The Character panel's change: on the selection, the whole layer, or new text. */
export function applyChar(patch: Partial<CharProps>, coalesce?: string, style?: string | null) {
  const t = typeTarget()
  if (t.kind === 'editing') t.s.styleChars(patch, style, coalesce)
  else if (t.kind === 'layer') {
    const c = t.node.props.content
    documents().commit((x) => setTextContent(x, t.node.id, styleRange(c, 0, Math.max(1, textLength(c)), patch, style)), { key: t.d.key, label: 'Character', coalesce })
  } else typeSettings().update({ char: patch })
}

/** The Paragraph panel's change: on the paragraphs selected, the whole layer, or new text. */
export function applyPara(patch: Partial<ParaProps>, coalesce?: string, style?: string | null) {
  const t = typeTarget()
  if (t.kind === 'editing') t.s.styleParas(patch, style, coalesce)
  else if (t.kind === 'layer') {
    const c = t.node.props.content
    documents().commit((x) => setTextContent(x, t.node.id, styleParagraphs(c, 0, textLength(c), patch, style)), { key: t.d.key, label: 'Paragraph', coalesce })
  } else typeSettings().update({ para: patch })
}

/** Create Outlines: the selected text as a shape with the same fills and strokes, in its place. */
export function createOutlines() {
  const d = documents().active()
  const n = d?.selected ? d.history.present.nodes[d.selected] : null
  if (!d || n?.kind !== 'text') return
  const doc = d.history.present
  const l = layoutOf(n, doc)
  if (!l) return
  if (sessions().get()?.kind === 'type') sessions().commit()
  const path = glyphsPath(l)
  const id = newId('n')
  documents().commit(
    (x) => {
      const place = placeOf(x, n.id)
      if (!place || place.slot !== 'children') return x
      let next = addVector(x, id, n.name, { kind: 'path', path }, n.props.appearance, place.parent, place.index + 1, [...n.transform] as Affine)
      const v = next.nodes[id]
      // The shape takes the text's place: its masks, effects, style and layer settings come too.
      next = { ...next, nodes: { ...next.nodes, [id]: { ...v, visible: n.visible, opacity: n.opacity, fillOpacity: n.fillOpacity, blend: n.blend, masks: n.masks, effects: n.effects, fx: n.fx, children: n.children ?? [] } as DocNode } }
      const parent = next.nodes[place.parent]
      const nodes = { ...next.nodes, [place.parent]: { ...parent, children: (parent.children ?? []).filter((c) => c !== n.id) } as DocNode }
      delete nodes[n.id]
      return { ...next, nodes }
    },
    { key: d.key, label: 'Create Outlines' },
  )
  if (documents().get(d.key)?.history.present.nodes[id]) documents().select(id, d.key)
}

import { glyphsToPath } from '../geom/glyphs'
const glyphsPath = (l: TextLayout) => glyphsToPath(l.glyphs)
