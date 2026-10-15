/**
 * Vector brushes (ARCHITECTURE.md, "Geometry"): artwork a stroke draws
 * along its path instead of its outline, as Illustrator's brushes do. An
 * **art** brush bends one piece of artwork along the whole path; a
 * **scatter** brush puts copies of it along the path; a **pattern** brush
 * repeats a side tile, bent, with start, end and corner tiles if it has
 * them. vector/brush.ts does the drawing.
 *
 * Artwork is filled regions, each in its own paint, in its own units: x
 * runs along the path, y across it. A stroke holds the brush itself (a
 * copy, as a graphic style's appearance is copied into a shape), so it
 * draws the same wherever it goes; the document keeps a library of them
 * (`Doc.vectorBrushes`), and the strokes using one carry its id.
 *
 * Colorization, as Illustrator's: the art's own colours, or tints of the
 * stroke's colour (lighter where the art is lighter), tints and shades
 * (darker too), or a hue shift (the art's key colour becomes the stroke's,
 * the rest turned with it).
 *
 * All plain JSON; `readBrush` brings one back from a file whole, every
 * field present and in range. Colours are the document's, as every paint's.
 */
import type { Doc } from './types'
import type { Paint } from './vector'
import type { ParamColour } from './params'
import type { Box, PathData } from '../geom/path'
import { isObject } from './read'

export type Colorize = 'none' | 'tints' | 'tints-shades' | 'hue-shift'

export const COLORIZE: [Colorize, string][] = [
  ['none', 'None'],
  ['tints', 'Tints'],
  ['tints-shades', 'Tints and Shades'],
  ['hue-shift', 'Hue Shift'],
]

/** One filled region of a brush's artwork, by its path's fill rule. */
export interface BrushPart {
  path: PathData
  paint: Paint
}

/** A brush's artwork: its parts, and the box it's laid out in (x along the path, y across). */
export interface BrushArt {
  parts: BrushPart[]
  box: Box
}

/** A low and high value, a copy taking one between them. */
export type Range = [number, number]

interface BrushBase {
  id: string
  name: string
  colorize: Colorize
  /** Hue Shift's key colour: the one that becomes the stroke's. Absent: the art's first. */
  key?: ParamColour
}

export type ArtFit = 'stretch' | 'proportional' | 'guides'

export interface ArtBrush extends BrushBase {
  kind: 'art'
  art: BrushArt
  /**
   * Stretched along the whole path; scaled in proportion to fit its length
   * (so a longer path is a wider stroke); or stretched only between the
   * guides, the art's start and end keeping their shape.
   */
  fit: ArtFit
  /** Where the guides are: how much of the art's length, from its start and from its end, keeps its shape. */
  guides: Range
  /** The art's height on the path as a share of the stroke's width. */
  scale: number
  flipAlong: boolean
  flipAcross: boolean
}

export interface ScatterBrush extends BrushBase {
  kind: 'scatter'
  art: BrushArt
  /** A copy's height as a share of the stroke's width. */
  size: Range
  /** From one copy to the next as a share of a copy's length: 1 touches. */
  spacing: Range
  /** How far off the path a copy goes, as a share of the stroke's width, either side. */
  scatter: Range
  /** Degrees. */
  rotation: Range
  /** Rotation from the path's direction where the copy is, or from the page's. */
  relative: 'path' | 'page'
  /** What the copies' variations come from: the same every time it's drawn. */
  seed: number
}

export interface PatternBrush extends BrushBase {
  kind: 'pattern'
  side: BrushArt
  /** At an open path's start and end; absent repeats the side tile there too. */
  start?: BrushArt
  end?: BrushArt
  /** At each corner (where the path turns sharply); absent bends the side tiles round it. */
  corner?: BrushArt
  /** Tiles stretched to fit a whole number along each run, or kept their length with space added. */
  fit: 'stretch' | 'space'
  scale: number
  flipAlong: boolean
  flipAcross: boolean
}

export type VectorBrush = ArtBrush | ScatterBrush | PatternBrush

export const BRUSH_KINDS: [VectorBrush['kind'], string][] = [
  ['art', 'Art'],
  ['scatter', 'Scatter'],
  ['pattern', 'Pattern'],
]

// --- reading -----------------------------------------------------------------------------------

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const num = (v: unknown, d: number, lo: number, hi: number) => (finite(v) ? Math.min(hi, Math.max(lo, v)) : d)
const LIMIT = 1e6

function readRange(v: unknown, d: Range, lo: number, hi: number): Range {
  if (!Array.isArray(v) || v.length !== 2) return d
  const a = num(v[0], d[0], lo, hi)
  const b = num(v[1], d[1], lo, hi)
  return [Math.min(a, b), Math.max(a, b)]
}

/** How a path and a paint are read back: doc/vector.ts's, handed in (it reads brushes in turn). */
export interface BrushReaders {
  path(v: unknown): PathData
  paint(v: unknown): Paint
}

function readArt(v: unknown, r: BrushReaders): BrushArt | null {
  if (!isObject(v) || !Array.isArray(v.parts)) return null
  const parts: BrushPart[] = []
  for (const p of v.parts.slice(0, 256)) {
    if (!isObject(p)) continue
    const path = r.path(p.path)
    if (path.subpaths.length) parts.push({ path, paint: r.paint(p.paint) })
  }
  const b = Array.isArray(v.box) && v.box.length === 4 && v.box.every(finite) ? (v.box.map((x) => num(x, 0, -LIMIT, LIMIT)) as Box) : null
  if (!parts.length || !b || !(b[2] > b[0]) || !(b[3] > b[1])) return null
  return { parts, box: b }
}

/** A brush read back from a file: every field present and in range; null when it can't draw. */
export function readBrush(v: unknown, r: BrushReaders): VectorBrush | null {
  if (!isObject(v)) return null
  const base: BrushBase = {
    id: typeof v.id === 'string' && v.id ? v.id.slice(0, 64) : 'brush',
    name: typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 80) : 'Brush',
    colorize: COLORIZE.some(([c]) => c === v.colorize) ? (v.colorize as Colorize) : 'none',
    ...(Array.isArray(v.key) && v.key.length >= 1 && v.key.length <= 5 && v.key.every(finite) ? { key: v.key.map((x: number) => num(x, 0, 0, 1)) } : {}),
  }
  const flips = { flipAlong: v.flipAlong === true, flipAcross: v.flipAcross === true }
  if (v.kind === 'art') {
    const art = readArt(v.art, r)
    if (!art) return null
    return { ...base, kind: 'art', art, fit: v.fit === 'proportional' || v.fit === 'guides' ? v.fit : 'stretch', guides: readRange(v.guides, [0.25, 0.25], 0, 0.5), scale: num(v.scale, 1, 0.01, 100), ...flips }
  }
  if (v.kind === 'scatter') {
    const art = readArt(v.art, r)
    if (!art) return null
    return {
      ...base,
      kind: 'scatter',
      art,
      size: readRange(v.size, [1, 1], 0.01, 100),
      spacing: readRange(v.spacing, [1, 1], 0.05, 100),
      scatter: readRange(v.scatter, [0, 0], -100, 100),
      rotation: readRange(v.rotation, [0, 0], -360, 360),
      relative: v.relative === 'page' ? 'page' : 'path',
      seed: Math.round(num(v.seed, 1, 0, 2 ** 31)),
    }
  }
  if (v.kind === 'pattern') {
    const side = readArt(v.side, r)
    if (!side) return null
    const opt = (k: 'start' | 'end' | 'corner') => {
      const a = readArt(v[k], r)
      return a ? { [k]: a } : {}
    }
    return { ...base, kind: 'pattern', side, ...opt('start'), ...opt('end'), ...opt('corner'), fit: v.fit === 'space' ? 'space' : 'stretch', scale: num(v.scale, 1, 0.01, 100), ...flips }
  }
  return null
}

/** Every paint in a brush, changed by `f` (to the document's mode, or across modes). */
export function mapBrushPaints(b: VectorBrush, f: (p: Paint) => Paint, colour?: (c: ParamColour) => ParamColour): VectorBrush {
  const art = (a: BrushArt): BrushArt => ({ ...a, parts: a.parts.map((p) => ({ ...p, paint: f(p.paint) })) })
  const key = b.key && colour ? { key: colour(b.key) } : {}
  if (b.kind === 'pattern') return { ...b, ...key, side: art(b.side), ...(b.start ? { start: art(b.start) } : {}), ...(b.end ? { end: art(b.end) } : {}), ...(b.corner ? { corner: art(b.corner) } : {}) }
  return { ...b, ...key, art: art(b.art) }
}

/** The brush's artworks: the art, or each tile. */
export const brushArts = (b: VectorBrush): BrushArt[] => (b.kind === 'pattern' ? [b.side, b.start, b.end, b.corner].filter((a): a is BrushArt => !!a) : [b.art])

// --- the library -----------------------------------------------------------------------------------

/** A brush added to the document's library (one with the same id replaced). */
export function addVectorBrush(doc: Doc, b: VectorBrush): Doc {
  const list = doc.vectorBrushes ?? []
  return { ...doc, vectorBrushes: list.some((x) => x.id === b.id) ? list.map((x) => (x.id === b.id ? b : x)) : [...list, b] }
}

export function removeVectorBrush(doc: Doc, id: string): Doc {
  const list = (doc.vectorBrushes ?? []).filter((x) => x.id !== id)
  const out = { ...doc }
  if (list.length) out.vectorBrushes = list
  else delete out.vectorBrushes
  return out
}

/** Every stroke drawn with brush `id` given `b` instead (Brush Options' "apply to strokes"). */
export function restrokeWith(doc: Doc, b: VectorBrush): Doc {
  let nodes = doc.nodes
  for (const [nid, n] of Object.entries(doc.nodes)) {
    if (n.kind !== 'vector' && n.kind !== 'boolean' && n.kind !== 'text') continue
    const items = (n.props as { appearance?: { kind: string; brush?: VectorBrush }[] }).appearance
    if (!items?.some((it) => it.kind === 'stroke' && it.brush?.id === b.id)) continue
    const appearance = items.map((it) => (it.kind === 'stroke' && it.brush?.id === b.id ? { ...it, brush: b } : it))
    if (nodes === doc.nodes) nodes = { ...doc.nodes }
    nodes[nid] = { ...n, props: { ...n.props, appearance } } as typeof n
  }
  return nodes === doc.nodes ? doc : { ...doc, nodes }
}

/** How many strokes in the document draw with brush `id`. */
export function strokesWith(doc: Doc, id: string): number {
  let k = 0
  for (const n of Object.values(doc.nodes)) {
    const items = (n.props as { appearance?: { kind: string; brush?: VectorBrush }[] }).appearance
    if (items) for (const it of items) if (it.kind === 'stroke' && it.brush?.id === id) k++
  }
  return k
}

// --- artwork from shapes, and the built-in brushes -------------------------------------------------------

/** Artwork from parts in any units: laid with its box's left edge at 0, centred across on 0. */
export function artFrom(parts: BrushPart[], bounds: (p: PathData) => Box | null): BrushArt | null {
  let box: Box | null = null
  for (const p of parts) {
    const b = bounds(p.path)
    if (b) box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b
  }
  if (!box || !(box[2] - box[0] > 1e-9) || !(box[3] - box[1] > 1e-9)) return null
  const dx = -box[0]
  const dy = -(box[1] + box[3]) / 2
  const move = (path: PathData): PathData => ({
    ...path,
    subpaths: path.subpaths.map((s) => ({ ...s, anchors: s.anchors.map((a) => ({ ...a, p: [a.p[0] + dx, a.p[1] + dy], in: a.in && [a.in[0] + dx, a.in[1] + dy], out: a.out && [a.out[0] + dx, a.out[1] + dy] })) })),
  })
  const h = (box[3] - box[1]) / 2
  return { parts: parts.map((p) => ({ ...p, path: move(p.path) })), box: [0, -h, box[2] - box[0], h] }
}
