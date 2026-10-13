/**
 * Text's geometry: laid-out glyphs as outlines placed many times over, the
 * way text is, rather than one big path. Each glyph used is kept once, in
 * its font's units (y up), and each place it's set is a transform into the
 * text node's coordinates. Long text then costs a transform per character,
 * not a copy of every curve, both in memory and on its way to the engine.
 *
 * The renderer flattens and bounds a glyph set as it does a path
 * (geom/path.ts, flattenOutline and outlineBounds); Create Outlines turns
 * one into a path with every contour placed.
 */
import { cubicBounds, evalCubic, flattenPath, linesFor, pathBounds, subpathFromCubics, unionBox, type Box, type Cubic, type FillRule, type Mat, type PathData, type Polyline, type Subpath } from './path'

export interface GlyphSet {
  kind: 'glyphs'
  /**
   * The glyphs' outlines, each a command list in font units, y up: 0 x y
   * (move), 1 x y (line), 3 c1x c1y c2x c2y x y (cubic), 4 (close).
   */
  outlines: number[][]
  /** Where each is set: outline index, then the affine a b c d e f into the node's coordinates; seven numbers each. */
  placements: number[]
}

export const EMPTY_GLYPHS: GlyphSet = { kind: 'glyphs', outlines: [], placements: [] }

export const isGlyphs = (p: unknown): p is GlyphSet => !!p && (p as GlyphSet).kind === 'glyphs'

const compose = (a: Mat, b: Mat): number[] => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
]

/** A placement's transform, then `m` (when given). */
function placementMatrix(g: GlyphSet, i: number, m?: Mat): number[] {
  const p = g.placements
  const own = [p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5], p[i + 6]]
  return m ? compose(m, own) : own
}

/** Each contour of an outline through `t`, as cubics (lines raised to cubics), for whoever needs curves. */
export function outlineCubics(outline: number[], t: Mat): Cubic[][] {
  const contours: Cubic[][] = []
  let cur: Cubic[] | null = null
  let sx = 0
  let sy = 0
  let x = 0
  let y = 0
  const tx = (a: number, b: number): [number, number] => [t[0] * a + t[2] * b + t[4], t[1] * a + t[3] * b + t[5]]
  const close = () => {
    if (cur && (Math.abs(x - sx) > 1e-9 || Math.abs(y - sy) > 1e-9)) cur.push([x, y, x, y, sx, sy, sx, sy])
    if (cur && cur.length) contours.push(cur)
    cur = null
  }
  for (let i = 0; i < outline.length; ) {
    const op = outline[i]
    if (op === 0) {
      close()
      ;[x, y] = tx(outline[i + 1], outline[i + 2])
      sx = x
      sy = y
      cur = []
      i += 3
    } else if (op === 1) {
      const [nx, ny] = tx(outline[i + 1], outline[i + 2])
      cur?.push([x, y, x, y, nx, ny, nx, ny])
      x = nx
      y = ny
      i += 3
    } else if (op === 3) {
      const [c1x, c1y] = tx(outline[i + 1], outline[i + 2])
      const [c2x, c2y] = tx(outline[i + 3], outline[i + 4])
      const [nx, ny] = tx(outline[i + 5], outline[i + 6])
      cur?.push([x, y, c1x, c1y, c2x, c2y, nx, ny])
      x = nx
      y = ny
      i += 7
    } else {
      close()
      i += 1
    }
  }
  close()
  return contours
}

/** A glyph set flattened into closed polylines within `tol` (after `m`). */
export function flattenGlyphs(g: GlyphSet, tol: number, m?: Mat): Polyline[] {
  const out: Polyline[] = []
  for (let i = 0; i < g.placements.length; i += 7) {
    const outline = g.outlines[g.placements[i]]
    if (!outline) continue
    const t = placementMatrix(g, i, m)
    for (const contour of outlineCubics(outline, t)) {
      const pts = [contour[0][0], contour[0][1]]
      for (const c of contour) {
        const straight = c[2] === c[0] && c[3] === c[1] && c[4] === c[6] && c[5] === c[7]
        if (straight) {
          pts.push(c[6], c[7])
          continue
        }
        const n = linesFor(c, tol)
        for (let k = 1; k <= n; k++) {
          const [px, py] = evalCubic(c, k / n)
          pts.push(px, py)
        }
      }
      if (pts.length >= 4 && Math.abs(pts[pts.length - 2] - pts[0]) < 1e-9 && Math.abs(pts[pts.length - 1] - pts[1]) < 1e-9) pts.length -= 2
      if (pts.length >= 6) out.push({ pts, closed: true })
    }
  }
  return out
}

const outlineBoxes = new WeakMap<number[], Box | null>()

/**
 * An outline's box in its own units, tight round its curves (not their
 * handles), as a path's is, so a gradient sits the same on text and on its
 * Create Outlines shape: made once.
 */
function outlineBox(o: number[]): Box | null {
  if (outlineBoxes.has(o)) return outlineBoxes.get(o)!
  let box: Box | null = null
  let x = 0
  let y = 0
  for (let i = 0; i < o.length; ) {
    const op = o[i]
    if (op === 0 || op === 1) {
      x = o[i + 1]
      y = o[i + 2]
      box = unionBox(box, [x, y, x, y])
      i += 3
    } else if (op === 3) {
      box = unionBox(box, cubicBounds([x, y, o[i + 1], o[i + 2], o[i + 3], o[i + 4], o[i + 5], o[i + 6]]))
      x = o[i + 5]
      y = o[i + 6]
      i += 7
    } else i += 1
  }
  outlineBoxes.set(o, box)
  return box
}

/**
 * The box round a glyph set, as tight as a path's: each glyph's box through
 * its placement and `m` where that only scales and flips (most text), its
 * placed curves' where it turns (text on a path, a turned box).
 */
export function glyphsBounds(g: GlyphSet, m?: Mat): Box | null {
  let box: Box | null = null
  for (let i = 0; i < g.placements.length; i += 7) {
    const outline = g.outlines[g.placements[i]] ?? []
    const b = outlineBox(outline)
    if (!b) continue
    const t = placementMatrix(g, i, m)
    if (Math.abs(t[1]) > 1e-12 || Math.abs(t[2]) > 1e-12) {
      for (const contour of outlineCubics(outline, t)) for (const c of contour) box = unionBox(box, cubicBounds(c))
      continue
    }
    for (const [x, y] of [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[0], b[3]],
      [b[2], b[3]],
    ]) {
      const px = t[0] * x + t[2] * y + t[4]
      const py = t[1] * x + t[3] * y + t[5]
      box = unionBox(box, [px, py, px, py])
    }
  }
  return box
}

/** Create Outlines: every glyph's contours placed, as one path, filled non-zero as fonts are. */
export function glyphsToPath(g: GlyphSet, m?: Mat): PathData {
  const subpaths: Subpath[] = []
  for (let i = 0; i < g.placements.length; i += 7) {
    const outline = g.outlines[g.placements[i]]
    if (!outline) continue
    for (const contour of outlineCubics(outline, placementMatrix(g, i, m))) subpaths.push(subpathFromCubics(contour, true))
  }
  return { subpaths, fillRule: 'nonzero' }
}

// --- either kind --------------------------------------------------------------------------------

/** What a shape is drawn from: a path, or text's glyphs. */
export type Outline = PathData | GlyphSet

export const flattenOutline = (o: Outline, tol: number, m?: Mat): Polyline[] => (isGlyphs(o) ? flattenGlyphs(o, tol, m) : flattenPath(o, tol, m))
export const outlineBounds = (o: Outline, m?: Mat): Box | null => (isGlyphs(o) ? glyphsBounds(o, m) : pathBounds(o, m))
export const outlineFillRule = (o: Outline): FillRule => (isGlyphs(o) ? 'nonzero' : o.fillRule)
export const outlineEmpty = (o: Outline): boolean => (isGlyphs(o) ? !o.placements.length : !o.subpaths.length)
/** Whether every contour closes: glyphs' always do. */
export const outlineClosed = (o: Outline): boolean => isGlyphs(o) || o.subpaths.every((s) => s.closed)
