/**
 * What a vector node fills, item by item, at one mip level: the line
 * segments (in that level's pixels) the coverage kernel sums, for each fill
 * and stroke of its appearance stack. Worked out once per node, level and
 * version (the render graph caches them), then cut per tile by
 * regionSegments.
 *
 * Fills are the path flattened straight into level pixels, to a tenth of a
 * pixel. Strokes are outlined in the shape's own coordinates (so a stroke
 * turns and scales with it) and the outline taken into level pixels. A
 * stroke inside or outside a closed path is a stroke twice as wide, kept
 * where the fill is (inside) or isn't (outside): its `clip`. A stroke
 * with a vector brush is its artwork's parts, each in its own paint
 * (`parts`), laid together as the one stroke.
 *
 * Text whose characters have paints of their own (colour per character,
 * geom/glyphs.ts) is split: the text's bottom fill draws its own glyphs
 * in its paint and the others in theirs, and likewise its bottom stroke
 * (one is added for characters with a stroke when the text has none; a
 * fill, too, for characters with a fill when it has none). Every other
 * fill and stroke goes over all of it.
 */
import type { ColourMode } from '../doc/types'
import { appearanceIn, fillItem, paintIn, strokeItem, strokeStyleOf, type AppearanceItem, type Paint, type StrokeItem } from '../doc/vector'
import { brushPieces, brushReach } from './brush'
import { strokeCentre, type StrokeCentre } from './paint'
import { flattenPath, maxScale, type Box, type FillRule, type Mat, type PathData, type Pt } from '../geom/path'
import { warpLines } from '../geom/warp'
import { flattenOutline, glyphSubset, glyphsToPath, isGlyphs, outlineBounds, outlineClosed, outlineEmpty, outlineFillRule, type GlyphSet, type Outline } from '../geom/glyphs'
import { hasPathEffects, itemPath } from './itemEffects'
import { fillSegments, loopsToSegments, segmentsBounds } from '../geom/raster'
import { strokeOutline, strokeReach } from '../geom/stroke'

/** How far a flattened curve may stray from the true one, in pixels of the level drawn. */
export const FLATTEN_TOL = 0.1

export interface ItemOutline {
  item: AppearanceItem
  /** Where its gradients and patterns are laid, when not the shape's path box (a Live Paint region's own). */
  pathBox?: Box | null
  segs: number[]
  rule: FillRule
  /** Its segments' box in level pixels, for skipping tiles it doesn't touch. */
  box: Box | null
  clip: { segs: number[]; rule: FillRule; mode: 'inside' | 'outside' } | null
  /**
   * A brush stroke's parts, each its own segments and paint, painted in
   * order over one another and then laid on as one item (its opacity, blend
   * and effects). `segs` is then all of them together, for its box.
   */
  parts?: { segs: number[]; rule: FillRule; paint: Paint; box: Box | null }[]
  /** A stroke whose gradient runs along or across it: its centre line (vector/paint.ts). */
  centre?: StrokeCentre
}

export interface VectorOutline {
  items: ItemOutline[]
  /** The path's box in the shape's own coordinates: where gradients are laid. */
  pathBox: Box | null
}

/** Shape coordinates to level-`level` pixels. */
export function levelMatrix(transform: Mat, level: number): number[] {
  const s = 1 / 2 ** level
  return transform.map((v) => v * s)
}

/**
 * `bend`, when given, is a warp in the shape's own coordinates (a
 * geometric effect that maps forwards): the fills' lines and the strokes'
 * outlines are carried through it, cut finely enough to follow it, so a
 * warped shape keeps its exact edges.
 */
export function vectorOutline(path: Outline, appearance: AppearanceItem[], transform: Mat, level: number, mode: ColourMode, bend?: (x: number, y: number) => Pt | null): VectorOutline {
  const m = levelMatrix(transform, level)
  const items: ItemOutline[] = []
  const pathBox = outlineBounds(path)
  if (outlineEmpty(path)) return { items, pathBox }
  const stretch = maxScale(m) || 1
  const tolNode = FLATTEN_TOL / stretch
  const bent = (loops: ArrayLike<number>[]) => (bend ? loops.map((l) => warpLines(l, bend, tolNode, true)) : loops)
  // What an outline fills and strokes from, worked out when first wanted: the shape's, or an item's through its path effects.
  const geometryOf = (p: Outline) => {
    let fill: number[] | null = null
    let lines: ReturnType<typeof flattenOutline> | null = null
    return {
      fillSegs: () => (fill ??= bend ? loopsToSegments(bent(flattenOutline(p, tolNode).map((l) => l.pts)), m) : fillSegments(flattenOutline(p, FLATTEN_TOL, m))),
      nodeLines: () => (lines ??= flattenOutline(p, tolNode)),
      closed: outlineClosed(p),
      rule: outlineFillRule(p),
    }
  }
  const own = geometryOf(path)
  const pairs: { item: AppearanceItem; outline: Outline }[] = isGlyphs(path) && path.paints?.length ? perCharacter(path, appearanceIn(appearance, mode), mode) : appearanceIn(appearance, mode).map((item) => ({ item, outline: path }))
  const geometries = new Map<Outline, ReturnType<typeof geometryOf>>([[path, own]])
  for (const { item, outline } of pairs) {
    if (!item.enabled || item.opacity <= 0) continue
    let base = geometries.get(outline)
    if (!base) geometries.set(outline, (base = geometryOf(outline)))
    const g = hasPathEffects(item.effects) ? geometryOf(itemPath(isGlyphs(outline) ? glyphsToPath(outline) : outline, item.effects, mode, tolNode)) : base
    if (item.kind === 'fill') {
      const segs = g.fillSegs()
      items.push({ item, segs, rule: g.rule, box: segmentsBounds(segs), clip: null })
      continue
    }
    if (item.width <= 0) continue
    if (item.brush) {
      // The brush's artwork along the path, each part in its paint; laid on as one stroke.
      const parts = brushPieces(g.nodeLines(), item, item.brush, mode, tolNode).map((p) => {
        const segs = loopsToSegments(bent(p.loops), m)
        return { segs, rule: p.rule, paint: p.paint, box: segmentsBounds(segs) }
      })
      const segs = parts.flatMap((p) => p.segs)
      items.push({ item, segs, rule: 'nonzero', box: segmentsBounds(segs), clip: null, parts })
      continue
    }
    const aligned = g.closed && item.align !== 'centre'
    const loops = strokeOutline(g.nodeLines(), strokeStyleOf(item, aligned ? item.width * 2 : item.width), tolNode)
    const segs = loopsToSegments(bent(loops), m)
    items.push({
      item,
      segs,
      rule: 'nonzero',
      box: segmentsBounds(segs),
      clip: aligned ? { segs: g.fillSegs(), rule: g.rule, mode: item.align === 'inside' ? 'inside' : 'outside' } : null,
      ...(item.paint.kind === 'gradient' && item.paint.stroke ? { centre: strokeCentre(g.nodeLines(), item, g.rule) } : {}),
    })
  }
  return { items, pathBox }
}

/**
 * Text with colour per character as (item, glyphs) pairs, in drawing
 * order: the bottom fill split into the glyphs that keep its paint and,
 * for each paint characters have, theirs in that paint; the bottom stroke
 * the same; one added where characters have a paint and the text has no
 * item to split. Glyphs empty of a pair are left out.
 */
function perCharacter(g: GlyphSet, items: AppearanceItem[], mode: ColourMode): { item: AppearanceItem; outline: Outline }[] {
  const paints = g.paints ?? []
  const anyFill = paints.some((p) => p.fill)
  const anyStroke = paints.some((p) => p.stroke)
  let list = items
  const firstFill = () => list.findIndex((it) => it.kind === 'fill' && it.enabled)
  const firstStroke = () => list.findIndex((it) => it.kind === 'stroke' && it.enabled)
  // Added items paint only characters with their own paint: their own glyphs have nothing from them.
  const added = new Set<AppearanceItem>()
  if (anyFill && firstFill() < 0) {
    const f = fillItem({ kind: 'solid', colour: [0, 0, 0] })
    added.add(f)
    list = [f, ...list]
  }
  if (anyStroke && firstStroke() < 0) {
    const st: StrokeItem = { ...strokeItem({ kind: 'solid', colour: [0, 0, 0] }, 1), join: 'round' }
    added.add(st)
    const at = firstFill()
    list = [...list.slice(0, at + 1), st, ...list.slice(at + 1)]
  }
  const fi = firstFill()
  const si = firstStroke()
  const out: { item: AppearanceItem; outline: Outline }[] = []
  const subset = (keep: (k: number) => boolean) => {
    const sub = glyphSubset(g, keep)
    return sub.placements.length ? sub : null
  }
  list.forEach((item, i) => {
    if (i !== fi && i !== si) {
      out.push({ item, outline: g })
      return
    }
    const own = (k: number) => (i === fi ? !!paints[k]?.fill : !!paints[k]?.stroke)
    if (!added.has(item)) {
      const plain = subset((k) => k < 0 || !own(k))
      if (plain) out.push({ item, outline: plain })
    }
    paints.forEach((p, k) => {
      if (!own(k)) return
      const sub = subset((x) => x === k)
      if (!sub) return
      if (i === fi) out.push({ item: { ...item, paint: paintIn(p.fill!, mode) } as AppearanceItem, outline: sub })
      else out.push({ item: { ...(item as StrokeItem), paint: paintIn(p.stroke!, mode), width: p.strokeWidth } as AppearanceItem, outline: sub })
    })
  })
  return out
}

/**
 * Text with colour per character as groups of glyphs, each with the
 * appearance it's drawn with: the text's own for glyphs without a paint,
 * and for each paint characters have, the text's with its bottom fill and
 * stroke (added if it has none) in that paint. For files and Create
 * Outlines, which draw a path per group. Text without colour per character
 * is one group.
 */
export function characterGroups(g: GlyphSet, items: AppearanceItem[]): { glyphs: GlyphSet; appearance: AppearanceItem[] }[] {
  const paints = g.paints ?? []
  if (!paints.length) return [{ glyphs: g, appearance: items }]
  const out: { glyphs: GlyphSet; appearance: AppearanceItem[] }[] = []
  const plain = glyphSubset(g, (k) => k < 0)
  if (plain.placements.length) out.push({ glyphs: plain, appearance: items })
  paints.forEach((p, k) => {
    const glyphs = glyphSubset(g, (x) => x === k)
    if (!glyphs.placements.length) return
    let list = items
    let fi = list.findIndex((it) => it.kind === 'fill' && it.enabled)
    if (p.fill && fi < 0) {
      list = [fillItem(p.fill), ...list]
      fi = 0
    }
    let si = list.findIndex((it) => it.kind === 'stroke' && it.enabled)
    if (p.stroke && si < 0) {
      list = [...list.slice(0, fi + 1), { ...strokeItem(p.stroke, p.strokeWidth), join: 'round' as const }, ...list.slice(fi + 1)]
      si = fi + 1
    }
    const appearance = list.map((it, i) => (i === fi && p.fill ? ({ ...it, paint: p.fill } as AppearanceItem) : i === si && p.stroke ? ({ ...(it as StrokeItem), paint: p.stroke, width: p.strokeWidth } as AppearanceItem) : it))
    out.push({ glyphs, appearance })
  })
  return out
}

/**
 * A stroke as the outline it paints, a path to fill (nonzero), in the
 * path's own units: for files that can't hold a width profile, arrowheads
 * or dashes fitted to corners (SVG, PDF). An inside or outside stroke is
 * the outline of one twice as wide; the file clips it as it does a plain
 * one.
 */
export function strokeAsPath(path: PathData, item: StrokeItem): PathData {
  const closed = path.subpaths.length > 0 && path.subpaths.every((s) => s.closed)
  const aligned = closed && item.align !== 'centre'
  const tol = Math.max(0.01, item.width / 400)
  const loops = strokeOutline(flattenPath(path, tol), strokeStyleOf(item, aligned ? item.width * 2 : item.width), tol)
  return {
    fillRule: 'nonzero',
    subpaths: loops.filter((l) => l.length >= 6).map((l) => {
      const anchors = []
      for (let i = 0; i < l.length; i += 2) anchors.push({ p: [l[i], l[i + 1]] as Pt, in: null, out: null, smooth: false })
      return { closed: true, anchors }
    }),
  }
}

/**
 * A brush stroke as paths to fill, one per part of its artwork with its
 * paint (colorized), in the path's own units: for SVG and PDF, and Outline
 * Stroke. Paints are in `mode`.
 */
export function brushAsPaths(path: PathData, item: StrokeItem, mode: ColourMode): { path: PathData; paint: Paint }[] {
  if (!item.brush) return []
  const tol = Math.max(0.01, item.width / 400)
  return brushPieces(flattenPath(path, tol), item, item.brush, mode, tol).map((p) => ({
    paint: p.paint,
    path: {
      fillRule: p.rule,
      subpaths: p.loops.map((l) => {
        const anchors = []
        for (let i = 0; i < l.length; i += 2) anchors.push({ p: [l[i], l[i + 1]] as Pt, in: null, out: null, smooth: false })
        return { closed: true, anchors }
      }),
    },
  }))
}

/** The longest line of a path (flattened coarsely): how wide a proportional art brush gets. */
export function longestLine(path: PathData): number {
  let best = 0
  for (const l of flattenPath(path, 0.5)) {
    let d = 0
    for (let i = 2; i < l.pts.length; i += 2) d += Math.hypot(l.pts[i] - l.pts[i - 2], l.pts[i + 1] - l.pts[i - 1])
    if (l.closed && l.pts.length >= 4) d += Math.hypot(l.pts[0] - l.pts[l.pts.length - 2], l.pts[1] - l.pts[l.pts.length - 1])
    best = Math.max(best, d)
  }
  return best
}

/** Whether any of a node's strokes is a proportional art brush, whose reach needs its path's length. */
export const needsLength = (appearance: AppearanceItem[]) => appearance.some((it) => it.kind === 'stroke' && it.enabled && it.brush?.kind === 'art' && it.brush.fit === 'proportional')

/** How far past its path a node's strokes reach, in its own units; `longest` is its longest line, for a proportional art brush. */
export function appearanceReach(appearance: AppearanceItem[], longest = 0): number {
  let r = 0
  for (const it of appearance) {
    if (it.kind !== 'stroke' || !it.enabled) continue
    if (it.brush) {
      r = Math.max(r, brushReach(it.brush, it.width, it.profile, longest))
      continue
    }
    const style = strokeStyleOf(it, it.align === 'centre' ? it.width : it.width * 2)
    r = Math.max(r, strokeReach(style))
  }
  return r
}
