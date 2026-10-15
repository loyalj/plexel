/**
 * Carets and selections in laid-out text (text/layout.ts), in the text
 * node's own coordinates: where a position is on screen, which position a
 * point is nearest, moving by character, word and line, and the boxes a
 * selection covers. Pure; the Type tool (app/typing.ts) draws and drives it.
 *
 * Moves go in reading order (logical), as Photoshop's do; across a
 * right-to-left word the caret's screen position follows each character's
 * own direction.
 */
import type { Line, TextLayout } from './layout'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const words = new Intl.Segmenter(undefined, { granularity: 'word' })

/** The line a position is on: the first holding it, or (at a line's end) the one it ends. */
export function lineOf(layout: TextLayout, pos: number): number {
  const ls = layout.lines
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]
    const next = ls[i + 1]
    if (pos >= l.start && (pos < l.end || (pos === l.end && (!next || next.start > pos || next.para !== l.para)))) return i
  }
  // Past the end, or in text not set (overflow): the last line.
  return Math.max(0, ls.length - 1)
}

/** The x a caret at `pos` stands at on its line. */
export function caretX(line: Line, pos: number): number {
  const k = pos - line.start
  if (!line.boxes.length) return line.rtl ? line.x1 : line.x0
  if (k < line.boxes.length) {
    const [a, b] = line.boxes[Math.max(0, k)]
    return line.charRtl[Math.max(0, k)] ? b : a
  }
  const [a, b] = line.boxes[line.boxes.length - 1]
  return line.charRtl[line.boxes.length - 1] ? a : b
}

/** A caret: its line, and its x. */
export function caretAt(layout: TextLayout, pos: number): { line: number; x: number } | null {
  if (!layout.lines.length) return null
  const i = lineOf(layout, pos)
  return { line: i, x: caretX(layout.lines[i], Math.min(Math.max(pos, layout.lines[i].start), layout.lines[i].end)) }
}

/** The position nearest a point: the line it's on (or nearest), then the nearest caret on it. */
export function hitPosition(layout: TextLayout, x: number, y: number): number {
  const ls = layout.lines
  if (!ls.length) return 0
  let best = 0
  let bd = Infinity
  ls.forEach((l, i) => {
    const d = y < l.top ? l.top - y : y > l.bottom ? y - l.bottom : 0
    if (d < bd) {
      bd = d
      best = i
    }
  })
  return nearestOnLine(ls[best], x)
}

/** The position on a line whose caret is nearest x. */
function nearestOnLine(l: Line, x: number): number {
  let pos = l.start
  let bd = Infinity
  for (let p = l.start; p <= l.end; p++) {
    const d = Math.abs(caretX(l, p) - x)
    if (d < bd) {
      bd = d
      pos = p
    }
  }
  return pos
}

/** The next or previous grapheme boundary in the text (a position never splits a character). */
export function stepChar(text: string, pos: number, dir: 1 | -1): number {
  const bounds = [0]
  for (const g of graphemes.segment(text)) bounds.push(g.index + g.segment.length)
  if (dir > 0) return bounds.find((b) => b > pos) ?? text.length
  for (let k = bounds.length - 1; k >= 0; k--) if (bounds[k] < pos) return bounds[k]
  return 0
}

/** The start of the word before, or the end of the word after: Ctrl with the arrows, and Ctrl+Backspace. */
export function stepWord(text: string, pos: number, dir: 1 | -1): number {
  const segs = [...words.segment(text)].filter((s) => s.isWordLike)
  if (dir > 0) {
    for (const s of segs) if (s.index + s.segment.length > pos) return Math.max(pos + 1, s.index + s.segment.length)
    return text.length
  }
  for (let i = segs.length - 1; i >= 0; i--) if (segs[i].index < pos) return segs[i].index
  return 0
}

/** The word round a position: a double-click's selection. */
export function wordAt(text: string, pos: number): [number, number] {
  for (const s of words.segment(text)) {
    const end = s.index + s.segment.length
    if (pos >= s.index && pos < end) return [s.index, end]
  }
  return [pos, pos]
}

/** The position on the line above or below with its caret nearest x; null past the first or last line. */
export function stepLine(layout: TextLayout, pos: number, dir: 1 | -1, x: number): number | null {
  const i = lineOf(layout, pos) + dir
  if (i < 0 || i >= layout.lines.length) return null
  return nearestOnLine(layout.lines[i], x)
}

/** The boxes a selection [a, b) covers, one or more a line: x from, x to, top, bottom. */
export function selectionBoxes(layout: TextLayout, a: number, b: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = []
  if (b <= a) return out
  for (const l of layout.lines) {
    const s = Math.max(a, l.start)
    const e = Math.min(b, l.end)
    if (e <= s) {
      // A selected paragraph break: a sliver at the line's end, as other editors show.
      if (a <= l.end && b > l.end && l.end >= l.start) {
        const x = l.rtl ? caretX(l, l.end) - 4 : caretX(l, l.end)
        out.push([x, x + 4, l.top, l.bottom])
      }
      continue
    }
    // Characters next to each other on screen merge into one box.
    const spans = []
    for (let p = s; p < e; p++) spans.push(l.boxes[p - l.start])
    spans.sort((u, v) => u[0] - v[0])
    let cur: [number, number] | null = null
    for (const [u, v] of spans) {
      if (cur && u <= cur[1] + 0.5) cur[1] = Math.max(cur[1], v)
      else {
        if (cur) out.push([cur[0], cur[1], l.top, l.bottom])
        cur = [u, v]
      }
    }
    if (cur) out.push([cur[0], cur[1], l.top, l.bottom])
    if (b > l.end && l.end === e && layout.lines[layout.lines.indexOf(l) + 1]?.para !== l.para) {
      const x = caretX(l, l.end)
      out.push(l.rtl ? [x - 4, x, l.top, l.bottom] : [x, x + 4, l.top, l.bottom])
    }
  }
  return out
}
