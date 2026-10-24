/**
 * What a vector node holds: its geometry (a path, or a live shape's
 * parameters) and its appearance stack, the fills and strokes it's painted
 * with, in order (ARCHITECTURE.md, "The appearance stack").
 *
 * All plain JSON. `readGeometry` and `readAppearance` bring them back from
 * a file whole, every field present and in range; colours are kept in the
 * document's own terms (CMYK as ink, like every colour parameter) and made
 * the right shape for the document's mode when they're used
 * (`appearanceIn`), so a change of mode never loses them.
 */
import type { BlendModeId, ColourMode } from './types'
import { BLEND_MODES } from './types'
import { defaultColour, readColour, type ParamColour } from './params'
import { isObject, type Warn } from './read'
import type { Anchor, FillRule, PathData, Pt, Subpath } from '../geom/path'
import { shapePath, readShape, type ShapeParams } from '../geom/shapes'
import { ARROW_SHAPES, type Arrowhead, type Cap, type Join, type StrokeStyle, type WidthPoint } from '../geom/stroke'
import { readItemEffects, type ItemEffect } from '../vector/itemEffects'
import { mapBrushPaints, readBrush, type VectorBrush } from './vectorBrush'

export type Geometry = { kind: 'path'; path: PathData } | { kind: 'shape'; shape: ShapeParams }

/** A gradient stop: where, what colour, how opaque. */
export interface PaintStop {
  at: number
  colour: ParamColour
  alpha: number
}

export type GradientType = 'linear' | 'radial' | 'angular' | 'reflected' | 'diamond'

export type Paint =
  /**
   * A colour; `swatch` links it to a global or spot swatch of the document
   * (doc/swatches.ts) at `tint`, and `colour` is then that swatch's colour.
   */
  | { kind: 'solid'; colour: ParamColour; swatch?: string; tint?: number }
  /**
   * Laid across the shape's box: angle in degrees, scale in %, as
   * Photoshop's Gradient Overlay. With `line` (start x, y, end x, y in the
   * node's own coordinates, as the Gradient tool drags it), along that line
   * instead: a linear or reflected gradient runs from start to end, the
   * others centre on the start with the end on their rim.
   */
  | { kind: 'gradient'; type: GradientType; stops: PaintStop[]; angle: number; scale: number; reverse: boolean; line?: GradientLine; stroke?: StrokeGradient }
  /**
   * Illustrator's freeform gradient: colour points anywhere in the shape (its
   * own coordinates), each spreading its colour by `spread` (1 is as far as
   * its neighbours'); between them the colours blend smoothly
   * (vector/mesh.ts, freeformAt).
   */
  | { kind: 'freeform'; points: FreeformPoint[] }
  /**
   * A gradient mesh: a grid of `cols` × `rows` patches, its (cols + 1) ×
   * (rows + 1) points in rows (the shape's own coordinates), each with a
   * colour; the colour runs smoothly across the patches (vector/mesh.ts).
   */
  | { kind: 'mesh'; cols: number; rows: number; nodes: MeshNode[] }
  /**
   * A pattern: one of vector/patterns.ts's formulas in two colours, or a
   * pattern of the document's made from pixels (Doc.patterns, by id), whose
   * colours are its own. `size` is one repeat across, in the shape's units.
   */
  | { kind: 'pattern'; pattern: string; colour: ParamColour; background: ParamColour; backgroundAlpha: number; size: number; angle: number }

/** A gradient's start and end, x0, y0, x1, y1. */
export type GradientLine = [number, number, number, number]

/**
 * A gradient on a stroke, as Illustrator's: along the stroke (start to end
 * of each subpath) or across it (one edge to the other); absent, within it,
 * laid like a fill's.
 */
export type StrokeGradient = 'along' | 'across'

/** A freeform gradient's colour point. */
export interface FreeformPoint {
  p: Pt
  colour: ParamColour
  alpha: number
  /** How far its colour reaches: 1 as far as any point's, more further. */
  spread: number
}

/** A point of a gradient mesh. */
export interface MeshNode {
  p: Pt
  colour: ParamColour
  alpha: number
}

/** The most colour points a freeform gradient has, and patches a mesh has a side. */
export const MAX_FREEFORM = 64
export const MAX_MESH = 24

export type StrokeAlign = 'centre' | 'inside' | 'outside'

interface ItemBase {
  enabled: boolean
  paint: Paint
  opacity: number
  blend: BlendModeId
  /** Effects on this fill or stroke alone, top first (vector/itemEffects.ts); absent is none. */
  effects?: ItemEffect[]
}

export interface FillItem extends ItemBase {
  kind: 'fill'
}

export interface StrokeItem extends ItemBase {
  kind: 'stroke'
  width: number
  join: Join
  cap: Cap
  miter: number
  dash: number[]
  dashOffset: number
  /** Where the stroke sits on a closed path's edge; open paths stroke on the centre. */
  align: StrokeAlign
  /** Its width along each subpath: width points (geom/stroke.ts); absent is the same all the way. */
  profile?: WidthPoint[]
  /** Dashes fitted between corners, as Illustrator's "aligns dashes to corners"; absent is off. */
  dashAlign?: boolean
  /** Arrowheads at an open path's start and end; absent is none. */
  start?: Arrowhead
  end?: Arrowhead
  /**
   * A vector brush the stroke draws instead of its outline (doc/vectorBrush.ts),
   * a copy of the library's; its width, profile, opacity, blend and effects
   * still apply. Absent is a plain stroke.
   */
  brush?: VectorBrush
}

export type AppearanceItem = FillItem | StrokeItem

export const GRADIENT_TYPES: [GradientType, string][] = [
  ['linear', 'Linear'],
  ['radial', 'Radial'],
  ['angular', 'Angular'],
  ['reflected', 'Reflected'],
  ['diamond', 'Diamond'],
]
export const JOINS: [Join, string][] = [
  ['miter', 'Miter'],
  ['round', 'Round'],
  ['bevel', 'Bevel'],
]
export const CAPS: [Cap, string][] = [
  ['butt', 'Butt'],
  ['round', 'Round'],
  ['square', 'Square'],
]
export const ALIGNS: [StrokeAlign, string][] = [
  ['centre', 'Centre'],
  ['inside', 'Inside'],
  ['outside', 'Outside'],
]

/** The path a node's geometry makes, in its own coordinates; empty for none. */
export function geometryPath(g: Geometry | null): PathData {
  if (!g) return { subpaths: [], fillRule: 'nonzero' }
  return g.kind === 'path' ? g.path : shapePath(g.shape)
}

export const solid = (colour: ParamColour): Paint => ({ kind: 'solid', colour })

export const fillItem = (paint: Paint): FillItem => ({ kind: 'fill', enabled: true, paint, opacity: 1, blend: 'normal' })

export const strokeItem = (paint: Paint, width: number): StrokeItem => ({
  kind: 'stroke',
  enabled: true,
  paint,
  opacity: 1,
  blend: 'normal',
  width,
  join: 'miter',
  cap: 'butt',
  miter: 4,
  dash: [],
  dashOffset: 0,
  align: 'centre',
})

/** A stroke's geometry settings. */
export const strokeStyleOf = (s: StrokeItem, width = s.width): StrokeStyle => ({
  width,
  join: s.join,
  cap: s.cap,
  miter: s.miter,
  dash: s.dash,
  dashOffset: s.dashOffset,
  ...(s.profile?.length ? { profile: s.profile } : {}),
  ...(s.dashAlign ? { dashAlign: true } : {}),
  // A stroke twice as wide (inside or outside) keeps its heads the size the stroke's own width makes them.
  ...(s.start ? { start: { ...s.start, scale: (s.start.scale * s.width) / (width || 1) } } : {}),
  ...(s.end ? { end: { ...s.end, scale: (s.end.scale * s.width) / (width || 1) } } : {}),
})

/** Whether a stroke has what only an outline can show in a file: a width profile, arrowheads, dashes fitted to corners. (A brush is its own case.) */
export const strokeNeedsOutline = (s: StrokeItem) => !s.brush && (!!s.profile?.length || !!s.start || !!s.end || (!!s.dashAlign && s.dash.length > 0))

/** Width points read back: within range, in order, at most 64. */
function readProfile(v: unknown): WidthPoint[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: WidthPoint[] = []
  for (const p of v.slice(0, 64)) {
    if (!isObject(p)) continue
    const at = num(p.at, NaN, 0, 1)
    if (!Number.isFinite(at)) continue
    out.push({ at, left: num(p.left, 1, 0, 50), right: num(p.right, num(p.left, 1, 0, 50), 0, 50) })
  }
  out.sort((a, b) => a.at - b.at)
  return out.length ? out : undefined
}

function readArrow(v: unknown): Arrowhead | undefined {
  if (!isObject(v) || !ARROW_SHAPES.some(([s]) => s === v.shape)) return undefined
  return { shape: v.shape as Arrowhead['shape'], scale: num(v.scale, 1, 0.1, 10) }
}

// --- reading -------------------------------------------------------------------------------------

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const num = (v: unknown, d: number, lo: number, hi: number) => (finite(v) ? Math.min(hi, Math.max(lo, v)) : d)
const LIMIT = 1e7

function readPt(v: unknown): Pt | null {
  return Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) ? [num(v[0], 0, -LIMIT, LIMIT), num(v[1], 0, -LIMIT, LIMIT)] : null
}

function readPath(raw: unknown, warn: Warn): PathData {
  const r = isObject(raw) ? raw : {}
  const fillRule: FillRule = r.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'
  const subpaths: Subpath[] = []
  let dropped = 0
  for (const s of Array.isArray(r.subpaths) ? r.subpaths : []) {
    if (!isObject(s) || !Array.isArray(s.anchors)) {
      dropped++
      continue
    }
    const anchors: Anchor[] = []
    for (const a of s.anchors) {
      const p = isObject(a) ? readPt(a.p) : null
      if (!p) {
        dropped++
        continue
      }
      anchors.push({ p, in: readPt((a as Record<string, unknown>).in), out: readPt((a as Record<string, unknown>).out), smooth: (a as Record<string, unknown>).smooth === true })
    }
    if (anchors.length) subpaths.push({ closed: s.closed === true, anchors })
  }
  if (dropped) warn(`a path had ${dropped} damaged part${dropped === 1 ? '' : 's'}; left them out`)
  return { subpaths, fillRule }
}

export function readGeometry(raw: unknown, warn: Warn): Geometry | null {
  if (raw === null || raw === undefined) return null
  if (!isObject(raw)) {
    warn('a shape’s geometry was not readable; cleared it')
    return null
  }
  if (raw.kind === 'shape') {
    const shape = readShape(raw.shape)
    if (shape) return { kind: 'shape', shape }
    warn('a live shape’s settings were not readable; cleared them')
    return null
  }
  if (raw.kind === 'path') return { kind: 'path', path: readPath(raw.path, warn) }
  warn(`a shape’s geometry “${String(raw.kind)}” is not known here; cleared it`)
  return null
}

/** A colour as stored: numbers 0..1, however many; made the mode's shape when used. */
const rawColour = (v: unknown, d: ParamColour): ParamColour => (Array.isArray(v) && v.length >= 1 && v.length <= 5 && v.every(finite) ? v.map((x) => num(x, 0, 0, 1)) : d)

function readStops(v: unknown): PaintStop[] {
  const stops = (Array.isArray(v) ? v : [])
    .filter(isObject)
    .map((s) => ({ at: num(s.at, 0, 0, 1), colour: rawColour(s.colour, [0, 0, 0]), alpha: num(s.alpha, 1, 0, 1) }))
    .sort((a, b) => a.at - b.at)
  return stops.length >= 2
    ? stops
    : [
        { at: 0, colour: [0, 0, 0], alpha: 1 },
        { at: 1, colour: [1, 1, 1], alpha: 1 },
      ]
}

export function readPaint(raw: unknown): Paint {
  const r = isObject(raw) ? raw : {}
  if (r.kind === 'gradient') {
    const g: Paint = {
      kind: 'gradient',
      type: GRADIENT_TYPES.some(([t]) => t === r.type) ? (r.type as GradientType) : 'linear',
      stops: readStops(r.stops),
      angle: num(r.angle, 90, -360, 360),
      scale: num(r.scale, 100, 1, 1000),
      reverse: r.reverse === true,
    }
    const line = Array.isArray(r.line) && r.line.length === 4 && r.line.every(finite) ? (r.line.map((v) => num(v, 0, -LIMIT, LIMIT)) as GradientLine) : null
    const stroke = r.stroke === 'along' || r.stroke === 'across' ? { stroke: r.stroke as StrokeGradient } : {}
    return line ? { ...g, line, ...stroke } : { ...g, ...stroke }
  }
  if (r.kind === 'freeform') {
    const points: FreeformPoint[] = []
    for (const q of Array.isArray(r.points) ? r.points.slice(0, MAX_FREEFORM) : []) {
      const p = isObject(q) ? readPt(q.p) : null
      if (p) points.push({ p, colour: rawColour((q as Record<string, unknown>).colour, [0, 0, 0]), alpha: num((q as Record<string, unknown>).alpha, 1, 0, 1), spread: num((q as Record<string, unknown>).spread, 1, 0.1, 10) })
    }
    return { kind: 'freeform', points }
  }
  if (r.kind === 'mesh') {
    const cols = Math.round(num(r.cols, 1, 1, MAX_MESH))
    const rows = Math.round(num(r.rows, 1, 1, MAX_MESH))
    const raw = Array.isArray(r.nodes) ? r.nodes : []
    const nodes: MeshNode[] = []
    for (const q of raw) {
      const p = isObject(q) ? readPt(q.p) : null
      if (!p) break
      nodes.push({ p, colour: rawColour((q as Record<string, unknown>).colour, [0, 0, 0]), alpha: num((q as Record<string, unknown>).alpha, 1, 0, 1) })
    }
    // A grid that doesn't add up can't be drawn: its first colour, flat.
    if (nodes.length !== (cols + 1) * (rows + 1)) return { kind: 'solid', colour: nodes[0]?.colour ?? [0, 0, 0] }
    return { kind: 'mesh', cols, rows, nodes }
  }
  if (r.kind === 'pattern') {
    return {
      kind: 'pattern',
      // A built-in formula, or a document pattern's id, which the document holds (or a missing one draws nothing).
      pattern: typeof r.pattern === 'string' && r.pattern && r.pattern.length <= 64 ? r.pattern : 'checker',
      colour: rawColour(r.colour, [0, 0, 0]),
      background: rawColour(r.background, [1, 1, 1]),
      backgroundAlpha: num(r.backgroundAlpha, 1, 0, 1),
      size: num(r.size, 16, 0.5, 10000),
      angle: num(r.angle, 0, -360, 360),
    }
  }
  const solid: Paint = { kind: 'solid', colour: rawColour(r.colour, [0, 0, 0]) }
  if (typeof r.swatch === 'string' && r.swatch) return { ...solid, swatch: r.swatch, tint: num(r.tint, 1, 0, 1) }
  return solid
}

const optional = <K extends string, V>(k: K, v: V | undefined) => (v === undefined ? {} : ({ [k]: v } as Record<K, V>))
const isBlend = (v: unknown): v is BlendModeId => BLEND_MODES.includes(v as BlendModeId) && v !== 'pass-through'

export function readAppearance(raw: unknown, warn: Warn): AppearanceItem[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    warn('a shape’s fills and strokes were not readable; cleared them')
    return []
  }
  const out: AppearanceItem[] = []
  for (const it of raw) {
    if (!isObject(it) || (it.kind !== 'fill' && it.kind !== 'stroke')) {
      warn('a shape had a fill or stroke of a kind not known here; left it out')
      continue
    }
    const effects = readItemEffects(it.effects)
    const base = { enabled: it.enabled !== false, paint: readPaint(it.paint), opacity: num(it.opacity, 1, 0, 1), blend: isBlend(it.blend) ? it.blend : 'normal', ...(effects.length ? { effects } : {}) }
    if (it.kind === 'fill') out.push({ kind: 'fill', ...base })
    else
      out.push({
        kind: 'stroke',
        ...base,
        width: num(it.width, 1, 0, 10000),
        join: JOINS.some(([j]) => j === it.join) ? (it.join as Join) : 'miter',
        cap: CAPS.some(([c]) => c === it.cap) ? (it.cap as Cap) : 'butt',
        miter: num(it.miter, 4, 1, 500),
        dash: Array.isArray(it.dash) ? it.dash.filter(finite).map((d) => num(d, 0, 0, 10000)).slice(0, 16) : [],
        dashOffset: num(it.dashOffset, 0, -10000, 10000),
        align: ALIGNS.some(([a]) => a === it.align) ? (it.align as StrokeAlign) : 'centre',
        ...optional('profile', readProfile(it.profile)),
        ...(it.dashAlign === true ? { dashAlign: true } : {}),
        ...optional('start', readArrow(it.start)),
        ...optional('end', readArrow(it.end)),
        ...optional('brush', readStrokeBrush(it.brush, warn)),
      })
  }
  return out
}

/** A stroke's brush read back; one that can't draw is left out (the stroke plain), and said. */
function readStrokeBrush(v: unknown, warn: Warn): VectorBrush | undefined {
  if (v === undefined || v === null) return undefined
  const b = readBrush(v, brushReaders(warn))
  if (!b) warn('a stroke’s brush was not readable; the stroke is plain')
  return b ?? undefined
}

/** How brushes' paths and paints are read: as a shape's. */
export const brushReaders = (warn: Warn) => ({ path: (v: unknown) => readPath(v, warn), paint: readPaint })

// --- in a document's mode ----------------------------------------------------------------------

const channelsOf = (mode: ColourMode) => (mode === 'rgb' ? 3 : mode === 'gray' ? 1 : 4)

/** A stored colour made the shape a mode wants: a wrong count falls back to black (or white). */
const colourIn = (c: ParamColour, mode: ColourMode, d: 'black' | 'white' = 'black') => readColour(c, channelsOf(mode), d, mode === 'cmyk')

export function paintIn(p: Paint, mode: ColourMode): Paint {
  switch (p.kind) {
    case 'solid':
      return { ...p, colour: colourIn(p.colour, mode) }
    case 'gradient':
      return { ...p, stops: p.stops.map((s, i) => ({ ...s, colour: colourIn(s.colour, mode, i ? 'white' : 'black') })) }
    case 'pattern':
      return { ...p, colour: colourIn(p.colour, mode), background: colourIn(p.background, mode, 'white') }
    case 'freeform':
      return { ...p, points: p.points.map((q) => ({ ...q, colour: colourIn(q.colour, mode) })) }
    case 'mesh':
      return { ...p, nodes: p.nodes.map((q) => ({ ...q, colour: colourIn(q.colour, mode) })) }
  }
}

/** Every colour a paint holds, in order: a colour, a pattern's two, a gradient's stops, a freeform's points, a mesh's points. */
export function paintColours(p: Paint): ParamColour[] {
  switch (p.kind) {
    case 'solid':
      return [p.colour]
    case 'gradient':
      return p.stops.map((s) => s.colour)
    case 'pattern':
      return [p.colour, p.background]
    case 'freeform':
      return p.points.map((q) => q.colour)
    case 'mesh':
      return p.nodes.map((q) => q.colour)
  }
}

/** A paint's colours each passed through `fn`, nothing else changed. */
export function mapPaintColours(p: Paint, fn: (c: ParamColour) => ParamColour): Paint {
  switch (p.kind) {
    case 'solid':
      return { ...p, colour: fn(p.colour) }
    case 'gradient':
      return { ...p, stops: p.stops.map((s) => ({ ...s, colour: fn(s.colour) })) }
    case 'pattern':
      return { ...p, colour: fn(p.colour), background: fn(p.background) }
    case 'freeform':
      return { ...p, points: p.points.map((q) => ({ ...q, colour: fn(q.colour) })) }
    case 'mesh':
      return { ...p, nodes: p.nodes.map((q) => ({ ...q, colour: fn(q.colour) })) }
  }
}

/** The colour a paint shows most: what a file that can't hold it draws it in, and its chip's colour. */
export const mainColour = (p: Paint): ParamColour => paintColours(p)[0] ?? [0, 0, 0]

/** Whether a paint is see-through anywhere (beyond its item's opacity). */
export function paintTranslucent(p: Paint): boolean {
  if (p.kind === 'gradient') return p.stops.some((s) => s.alpha < 1)
  if (p.kind === 'freeform') return p.points.some((q) => q.alpha < 1) || !p.points.length
  if (p.kind === 'mesh') return p.nodes.some((q) => q.alpha < 1)
  if (p.kind === 'pattern') return p.backgroundAlpha < 1
  return false
}

/** An appearance stack with every colour in the document's mode. */
export const appearanceIn = (items: AppearanceItem[], mode: ColourMode): AppearanceItem[] =>
  items.map((it) => (it.kind === 'stroke' && it.brush ? { ...it, paint: paintIn(it.paint, mode), brush: brushIn(it.brush, mode) } : { ...it, paint: paintIn(it.paint, mode) }))

/** A brush with every colour in the document's mode. */
export const brushIn = (b: VectorBrush, mode: ColourMode): VectorBrush => mapBrushPaints(b, (p) => paintIn(p, mode), (c) => colourIn(c, mode))

/** A default two-stop gradient between two colours. */
export function gradientPaint(a: ParamColour, b: ParamColour): Paint {
  return {
    kind: 'gradient',
    type: 'linear',
    stops: [
      { at: 0, colour: a, alpha: 1 },
      { at: 1, colour: b, alpha: 1 },
    ],
    angle: 90,
    scale: 100,
    reverse: false,
  }
}

export const blackIn = (mode: ColourMode) => defaultColour('black', channelsOf(mode), mode === 'cmyk')
export const whiteIn = (mode: ColourMode) => defaultColour('white', channelsOf(mode), mode === 'cmyk')
