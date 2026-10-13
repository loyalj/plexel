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
 * where the fill is (inside) or isn't (outside): its `clip`.
 */
import type { ColourMode } from '../doc/types'
import { appearanceIn, strokeStyleOf, type AppearanceItem } from '../doc/vector'
import { maxScale, type Box, type FillRule, type Mat, type Pt } from '../geom/path'
import { warpLines } from '../geom/warp'
import { flattenOutline, glyphsToPath, isGlyphs, outlineBounds, outlineClosed, outlineEmpty, outlineFillRule, type Outline } from '../geom/glyphs'
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
  for (const item of appearanceIn(appearance, mode)) {
    if (!item.enabled || item.opacity <= 0) continue
    const g = hasPathEffects(item.effects) ? geometryOf(itemPath(isGlyphs(path) ? glyphsToPath(path) : path, item.effects, mode, tolNode)) : own
    if (item.kind === 'fill') {
      const segs = g.fillSegs()
      items.push({ item, segs, rule: g.rule, box: segmentsBounds(segs), clip: null })
      continue
    }
    if (item.width <= 0) continue
    const aligned = g.closed && item.align !== 'centre'
    const loops = strokeOutline(g.nodeLines(), strokeStyleOf(item, aligned ? item.width * 2 : item.width), tolNode)
    const segs = loopsToSegments(bent(loops), m)
    items.push({
      item,
      segs,
      rule: 'nonzero',
      box: segmentsBounds(segs),
      clip: aligned ? { segs: g.fillSegs(), rule: g.rule, mode: item.align === 'inside' ? 'inside' : 'outside' } : null,
    })
  }
  return { items, pathBox }
}

/** How far past its path a node's strokes reach, in its own units. */
export function appearanceReach(appearance: AppearanceItem[]): number {
  let r = 0
  for (const it of appearance) {
    if (it.kind !== 'stroke' || !it.enabled) continue
    const style = strokeStyleOf(it, it.align === 'centre' ? it.width : it.width * 2)
    r = Math.max(r, strokeReach(style))
  }
  return r
}
