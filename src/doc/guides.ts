/**
 * Guides: lines across the canvas, at a document position, saved with the
 * document and in its history (adding, moving and clearing them are undo
 * steps, as in Photoshop). They move with the canvas when it's cropped or
 * resized (doc/edit.ts).
 *
 * A vertical guide is `axis: 'x'` (it marks an x), a horizontal one
 * `axis: 'y'`. The list keeps its order, so a guide is named by its index
 * while it's dragged.
 */
import type { Doc, Guide } from './types'

/** Two guides this close on the same axis are one. */
const SAME = 1e-6

const same = (a: Guide, b: Guide) => a.axis === b.axis && Math.abs(a.at - b.at) < SAME

/** Guides added, leaving out any already there. */
export function addGuides(doc: Doc, add: Guide[]): Doc {
  const out = [...doc.guides]
  for (const g of add) if (Number.isFinite(g.at) && !out.some((h) => same(g, h))) out.push({ axis: g.axis, at: g.at })
  return out.length === doc.guides.length ? doc : { ...doc, guides: out }
}

/** A guide moved to `at`; a guide moved onto another on the same axis merges with it. */
export function moveGuide(doc: Doc, index: number, at: number): Doc {
  const g = doc.guides[index]
  if (!g || !Number.isFinite(at) || g.at === at) return doc
  const moved = { axis: g.axis, at }
  const rest = doc.guides.filter((_, i) => i !== index)
  if (rest.some((h) => same(h, moved))) return { ...doc, guides: rest }
  return { ...doc, guides: doc.guides.map((h, i) => (i === index ? moved : h)) }
}

export function removeGuide(doc: Doc, index: number): Doc {
  if (!doc.guides[index]) return doc
  return { ...doc, guides: doc.guides.filter((_, i) => i !== index) }
}

export function clearGuides(doc: Doc): Doc {
  return doc.guides.length ? { ...doc, guides: [] } : doc
}

/** Every guide through `fn` (where the canvas moved them), dropping any it returns null for. */
export function mapGuides(doc: Doc, fn: (g: Guide) => Guide | null): Doc {
  if (!doc.guides.length) return doc
  const out: Guide[] = []
  for (const g of doc.guides) {
    const h = fn(g)
    if (h && Number.isFinite(h.at) && !out.some((x) => same(x, h))) out.push(h)
  }
  return { ...doc, guides: out }
}

/**
 * New Guide Layout: columns and rows with gutters inside margins, as
 * Photoshop's dialog makes them. A count of zero leaves that axis out. A
 * width (or height) of zero shares the space out; a given one is used as
 * it is, and the columns are centred in the space between the margins.
 */
export interface GuideLayout {
  columns: { count: number; width: number; gutter: number }
  rows: { count: number; height: number; gutter: number }
  margin: { top: number; left: number; bottom: number; right: number }
}

export const DEFAULT_LAYOUT: GuideLayout = {
  columns: { count: 8, width: 0, gutter: 20 },
  rows: { count: 0, height: 0, gutter: 20 },
  margin: { top: 0, left: 0, bottom: 0, right: 0 },
}

/** The guides a layout makes on a canvas `w` by `h`: the margins, then each column's and row's edges. */
export function layoutGuides(l: GuideLayout, w: number, h: number): Guide[] {
  const out: Guide[] = []
  const axis = (a: 'x' | 'y', start: number, end: number, count: number, each: number, gutter: number) => {
    if (start > 0) out.push({ axis: a, at: start })
    if (end < (a === 'x' ? w : h)) out.push({ axis: a, at: end })
    const n = Math.max(0, Math.floor(count))
    if (!n) return
    const g = Math.max(0, gutter)
    const space = end - start
    const cell = each > 0 ? each : (space - g * (n - 1)) / n
    if (!(cell > 0)) return
    const used = cell * n + g * (n - 1)
    let x = start + (each > 0 ? (space - used) / 2 : 0)
    for (let i = 0; i < n; i++) {
      out.push({ axis: a, at: x }, { axis: a, at: x + cell })
      x += cell + g
    }
  }
  const m = l.margin
  if (l.columns.count > 0 || m.left > 0 || m.right > 0) axis('x', m.left, w - m.right, l.columns.count, l.columns.width, l.columns.gutter)
  if (l.rows.count > 0 || m.top > 0 || m.bottom > 0) axis('y', m.top, h - m.bottom, l.rows.count, l.rows.height, l.rows.gutter)
  // In order along each axis, once each.
  const seen: Guide[] = []
  for (const g of out.sort((a, b) => (a.axis === b.axis ? a.at - b.at : a.axis < b.axis ? -1 : 1))) if (!seen.some((s) => same(s, g))) seen.push(g)
  return seen
}

/** New Guides from Shape: a box's edges and centre, both ways. */
export function boxGuides(b: [number, number, number, number]): Guide[] {
  return [
    { axis: 'x', at: b[0] },
    { axis: 'x', at: (b[0] + b[2]) / 2 },
    { axis: 'x', at: b[2] },
    { axis: 'y', at: b[1] },
    { axis: 'y', at: (b[1] + b[3]) / 2 },
    { axis: 'y', at: b[3] },
  ]
}
