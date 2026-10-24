/**
 * Geometry, headless: paths and their bounds, flattening within its
 * tolerance, live shapes against their areas, stroke outlines (joins,
 * caps, dashes) against what they should cover, the coverage rasterizer
 * against exact areas, booleans against analytic areas and a sampled fuzz,
 * path editing, width points (the Width tool's arithmetic), and vector
 * brushes along paths.
 *
 * The GPU rasterizer is held to this file's reference in check:gpu.
 *
 * Run with: npm run check:geom
 */
import {
  cubicBounds,
  evalCubic,
  anchor,
  flattenPath,
  linesFor,
  pathBounds,
  polyArea,
  segmentsOf,
  splitCubic,
  subpathFromCubics,
  transformPath,
  type Cubic,
  type PathData,
  type Polyline,
  type Subpath,
} from '../src/geom/path'
import { KAPPA, readShape, shapeInBox, shapePath, withBox, type ShapeParams } from '../src/geom/shapes'
import { ARROW_SHAPES, WIDTH_PRESETS, dashLines, presetOf, profileAt, strokeOutline, strokeReach, type StrokeStyle } from '../src/geom/stroke'
import { contribution, coverageOf, fillSegments, inside, loopsToSegments, gridColumn, rasterRegion, regionSegments, sampledCoverage, segmentGrid, segmentsBounds, stripSegments, windingAt } from '../src/geom/raster'
import { booleanPaths, type BoolOp } from '../src/geom/boolean'
import { extendSubpath, fitFreehand, nearestOnSubpath, spliceSubpath } from '../src/geom/freehand'
import { TRACE_PRESETS, shrinkForTrace, traceImage } from '../src/trace/trace'
import { brushPieces, brushReach, colorizeColour } from '../src/vector/brush'
import { builtinBrushes } from '../src/vector/brushLibrary'
import { readBrush, type ArtBrush, type PatternBrush, type ScatterBrush } from '../src/doc/vectorBrush'
import { appearanceReach } from '../src/vector/outline'
import { deepEqual } from '../src/lib/equal'
import { freeformAt, gridSpline, invBilinear, meshLocate, meshPointAt, newMesh, resizeMesh, splitMesh } from '../src/vector/mesh'
import { MAX_SHARE, addWidthPoint, deleteWidthPoints, flipAcross, flipAlong, measurePath, moveWidthPoint, nearestPlace, placeAt, sameProfile, setWidthPoint, shownPoints, sideOf, slideRange, tidyProfile } from '../src/geom/width'
import { anchorsIn, breakAt, closeSubpath, convertAnchor, curvatureAnchor, deleteAnchors, hitAnchor, hitSegment, insertAnchor, joinSubpaths, moveAnchors, moveHandle, recurve, separate } from '../src/geom/edit'
import { readAppearance, readGeometry, readPaint, appearanceIn, geometryPath } from '../src/doc/vector'
import { patternValue } from '../src/vector/patterns'
import { addVector, addVectorMask, combineWithBelow, createDoc, expandCompound, releaseCompound, setAppearance, setBoolOp, setGeometry, transformNode } from '../src/doc/edit'
import { docToJson, readDocJson } from '../src/doc/serialize'
import { describeEdit } from '../src/doc/describe'
import { fillItem, solid, strokeItem, type Geometry } from '../src/doc/vector'
import type { Doc, DocNode } from '../src/doc/types'
import type { Pt } from '../src/geom/path'
import { Scene } from '../src/render/scene'
import { docPathOf, operandsOf } from '../src/vector/shape'
import {
  WarpMap,
  applyH,
  boxCorners,
  boxFrame,
  coonsInner,
  decodeField,
  dragMeshPoint,
  encodeField,
  fieldAt,
  identityMesh,
  invertH,
  isIdentityMesh,
  liquifyDab,
  mapH,
  meshEval,
  meshInverse,
  meshPoint,
  newField,
  regridMesh,
  squareToQuad,
  styleMesh,
  warpLines,
  WARP_STYLES,
} from '../src/geom/warp'
import { FILTER_BY_ID, filterValues, moveWarpParams, warpOf, warpRegion } from '../src/filters/defs'
import { makeNode } from '../src/doc/nodes'
import { PATH_EFFECTS, itemBounds, itemPath, offsetPath, pixelReach, readItemEffects } from '../src/vector/itemEffects'
import { addGraphicStyle, applyGraphicStyle, linkOf, redefineGraphicStyle, removeGraphicStyle, unlinkGraphicStyle } from '../src/doc/graphicStyles'
import { fragmentOf, pasteFragment } from '../src/doc/fragment'
import { area as regionArea, contains, divide, joinPath, pieces, regionAt, simplifyPath, smoothPath, unite } from '../src/geom/regions'
import { livePaintParts } from '../src/vector/shape'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b))
const fmt = (x: number) => (x === 0 ? '0' : Math.abs(x) < 1e-3 ? x.toExponential(1) : x.toFixed(4))

let seed = 7
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)

/** Area covered by filled loops (nonzero unless said), by the exact rasterizer over the region round them. */
function coveredArea(segs: number[], rule: 'nonzero' | 'evenodd' = 'nonzero'): number {
  const b = segmentsBounds(segs)
  if (!b) return 0
  const x0 = Math.floor(b[0]) - 1
  const y0 = Math.floor(b[1]) - 1
  const w = Math.ceil(b[2]) - x0 + 1
  const h = Math.ceil(b[3]) - y0 + 1
  const local: number[] = []
  regionSegments(segs, x0, y0, w, h, local)
  return rasterRegion(local, w, h, rule).reduce((a, v) => a + v, 0)
}
const pathArea = (p: PathData, tol = 0.01) => coveredArea(fillSegments(flattenPath(p, tol)), p.fillRule)
const strokeArea = (lines: Polyline[], s: StrokeStyle, tol = 0.01) => coveredArea(loopsToSegments(strokeOutline(lines, s, tol)))
const style = (o: Partial<StrokeStyle>): StrokeStyle => ({ width: 4, join: 'miter', cap: 'butt', miter: 4, dash: [], dashOffset: 0, ...o })

// --- paths ------------------------------------------------------------------------------------
console.log('\npaths')
const randomCubic = (s = 100): Cubic => Array.from({ length: 8 }, () => rand() * s) as Cubic
{
  let worst = 0
  for (let k = 0; k < 200; k++) {
    const c = randomCubic()
    const b = cubicBounds(c)
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let i = 0; i <= 4000; i++) {
      const [x, y] = evalCubic(c, i / 4000)
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
    worst = Math.max(worst, Math.abs(b[0] - x0), Math.abs(b[1] - y0), Math.abs(b[2] - x1), Math.abs(b[3] - y1))
  }
  check('a cubic’s exact box matches dense sampling', worst < 1e-3, `worst ${fmt(worst)}`)
}
{
  let worst = 0
  for (let k = 0; k < 100; k++) {
    const c = randomCubic()
    const tol = 0.05 + rand() * 0.5
    const n = linesFor(c, tol)
    const pts = Array.from({ length: n + 1 }, (_, i) => evalCubic(c, i / n))
    // Every point of the curve is within tol of the polyline.
    for (let i = 0; i <= 600; i++) {
      const p = evalCubic(c, i / 600)
      let best = Infinity
      for (let j = 0; j < n; j++) {
        const a = pts[j]
        const b = pts[j + 1]
        const dx = b[0] - a[0]
        const dy = b[1] - a[1]
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
        best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy))
      }
      worst = Math.max(worst, best / tol)
    }
  }
  check('flattening stays within its tolerance (Wang’s formula)', worst <= 1.0001, `worst ${fmt(worst)} of the tolerance`)
}
{
  const c = randomCubic()
  const [l, r] = splitCubic(c, 0.3)
  const ok = [0, 0.25, 0.5, 1].every((t) => {
    const a = evalCubic(l, t)
    const b = evalCubic(c, 0.3 * t)
    const d = evalCubic(r, t)
    const e = evalCubic(c, 0.3 + 0.7 * t)
    return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9 && Math.hypot(d[0] - e[0], d[1] - e[1]) < 1e-9
  })
  check('splitting a cubic keeps every point of it', ok)
}
{
  const p = shapePath({ type: 'rect', x: 0, y: 0, w: 10, h: 20, radii: [3, 3, 3, 3], corner: 'round' })
  const s = p.subpaths[0]
  const back = subpathFromCubics(segmentsOf(s), true)
  const same = JSON.stringify(segmentsOf(back)) === JSON.stringify(segmentsOf(s))
  check('a subpath made from its own segments is the same path', same)
  check('a closed subpath has a closing segment; an open one doesn’t', segmentsOf(s).length === 8 && segmentsOf({ ...s, closed: false }).length === 7)
  const m = [2, 0.5, -0.3, 1.5, 7, -4]
  const b1 = pathBounds(transformPath(p, m))!
  const b2 = pathBounds(p, m)!
  check('bounds through a transform are the transformed path’s', b1.every((v, i) => Math.abs(v - b2[i]) < 1e-9))
}

// --- shapes -----------------------------------------------------------------------------------
console.log('\nlive shapes')
const shapeCases: [string, ShapeParams, number][] = [
  ['a rectangle', { type: 'rect', x: 10, y: 20, w: 60, h: 40, radii: [0, 0, 0, 0], corner: 'round' }, 60 * 40],
  ['a rounded rectangle', { type: 'rect', x: 10, y: 20, w: 60, h: 40, radii: [8, 8, 8, 8], corner: 'round' }, 60 * 40 - (4 - Math.PI) * 64],
  ['a chamfered rectangle', { type: 'rect', x: 10, y: 20, w: 60, h: 40, radii: [8, 8, 8, 8], corner: 'chamfer' }, 60 * 40 - 2 * 64],
  ['a rectangle with set-in corners', { type: 'rect', x: 10, y: 20, w: 60, h: 40, radii: [8, 8, 8, 8], corner: 'inset' }, 60 * 40 - Math.PI * 64],
  ['an ellipse', { type: 'ellipse', x: 5, y: 5, w: 80, h: 50 }, Math.PI * 40 * 25],
  ['a hexagon', { type: 'polygon', x: 0, y: 0, w: 60, h: 60, sides: 6 }, 3 * 30 * 30 * Math.sin(Math.PI / 3)],
  ['a five-pointed star', { type: 'star', x: 0, y: 0, w: 80, h: 80, points: 5, inner: 0.4 }, 5 * 40 * 16 * Math.sin(Math.PI / 5)],
]
for (const [name, s, want] of shapeCases) {
  const got = pathArea(shapePath(s))
  // The ellipse's cubics are within 0.03% of the true curve.
  check(`${name} covers its area`, rel(got, want) < (s.type === 'ellipse' || (s.type === 'rect' && s.corner !== 'chamfer' && s.radii[0] > 0) ? 2e-3 : 1e-6), `${fmt(got)} against ${fmt(want)}`)
}
check('rounded corners are capped at half the shorter side', pathArea(shapePath({ type: 'rect', x: 0, y: 0, w: 40, h: 40, radii: [99, 99, 99, 99], corner: 'round' })) / (Math.PI * 400) - 1 < 2e-3)
{
  const line = shapePath({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 5 })
  check('a line is one open segment', line.subpaths.length === 1 && !line.subpaths[0].closed && line.subpaths[0].anchors.length === 2)
  const r = readShape({ type: 'star', x: 1, y: 2, w: -5, h: 'tall', points: 1000, inner: 7 })
  check('a shape read from a file is brought into range', !!r && r.type === 'star' && r.w === 0 && r.h === 100 && r.points === 100 && r.inner === 1)
  check('an unknown shape type is refused', readShape({ type: 'blob' }) === null)
  const b = shapeInBox('rect', 50, 40, 10, 0, { radius: 3 })
  check('a shape dragged backwards still fills its box', b.type === 'rect' && b.x === 10 && b.y === 0 && b.w === 40 && b.h === 40 && b.radii[2] === 3)
  const moved = withBox({ type: 'line', x1: 0, y1: 10, x2: 10, y2: 0 }, 100, 100, 20, 40)
  check('a line sized to a new box keeps its direction', moved.type === 'line' && moved.x1 === 100 && moved.y1 === 140 && moved.x2 === 120 && moved.y2 === 100)
  check('the ellipse uses the best quarter-circle handle length', Math.abs(KAPPA - (4 / 3) * (Math.SQRT2 - 1)) < 1e-6)
}

// --- strokes ----------------------------------------------------------------------------------
console.log('\nstrokes')
const L = 100
const w = 6
const segLine: Polyline[] = [{ pts: [10, 50, 110, 50], closed: false }]
const strokeCases: [string, StrokeStyle, number][] = [
  ['butt caps end at the ends', style({ width: w, cap: 'butt' }), L * w],
  ['square caps reach half the width past them', style({ width: w, cap: 'square' }), (L + w) * w],
  ['round caps add a circle', style({ width: w, cap: 'round' }), L * w + Math.PI * (w / 2) ** 2],
]
for (const [name, s, want] of strokeCases) {
  const got = strokeArea(segLine, s)
  check(`a straight stroke: ${name}`, rel(got, want) < 2e-3, `${fmt(got)} against ${fmt(want)}`)
}
const rectLine = flattenPath(shapePath({ type: 'rect', x: 20, y: 20, w: 80, h: 50, radii: [0, 0, 0, 0], corner: 'round' }), 0.01)
const ring = 2 * w * (80 + 50)
const joinCases: [string, StrokeStyle, number][] = [
  ['miter joins fill the corners square', style({ width: w, join: 'miter' }), ring],
  ['bevel joins cut them', style({ width: w, join: 'bevel' }), ring - 4 * (w * w) / 8],
  ['round joins round them', style({ width: w, join: 'round' }), ring - 4 * (w / 2) ** 2 * (1 - Math.PI / 4)],
]
for (const [name, s, want] of joinCases) {
  const got = strokeArea(rectLine, s)
  check(`a rectangle’s stroke: ${name}`, rel(got, want) < 2e-3, `${fmt(got)} against ${fmt(want)}`)
}
{
  // A sharp turn: the miter limit decides between a point and a bevel.
  const v: Polyline[] = [{ pts: [0, 0, 50, 10, 0, 20], closed: false }]
  const long = strokeArea(v, style({ width: 4, miter: 100 }))
  const cut = strokeArea(v, style({ width: 4, miter: 2 }))
  const bevel = strokeArea(v, style({ width: 4, join: 'bevel' }))
  check('past the miter limit a miter becomes a bevel', long > cut + 1 && Math.abs(cut - bevel) < 1e-6, `${fmt(long)}, ${fmt(cut)}, ${fmt(bevel)}`)
  const r = strokeReach(style({ width: 10, join: 'miter', miter: 4 }))
  check('a stroke’s reach allows for its miters', r === 20)
}
{
  const dashes = dashLines(segLine, [10, 10], 0)
  check('dashes of 10 with gaps of 10 cut a line of 100 into five', dashes.length === 5 && dashes.every((d) => Math.abs(Math.hypot(d.pts[2] - d.pts[0], d.pts[3] - d.pts[1]) - 10) < 1e-9))
  const got = strokeArea(segLine, style({ width: w, dash: [10, 10] }))
  check('and stroke half its length', rel(got, (L / 2) * w) < 2e-3, fmt(got))
  const shifted = dashLines(segLine, [10, 10], 5)
  check('an offset starts the pattern part-way through', Math.abs(shifted[0].pts[2] - shifted[0].pts[0] - 5) < 1e-9 && shifted.length === 6)
  const dots = dashLines(segLine, [0, 10], 0)
  check('zero-length dashes are dots, at both ends too', dots.length === 11 && dots.every((d) => d.pts.length === 2), `${dots.length}`)
  const dotArea = strokeArea(segLine, style({ width: 4, cap: 'round', dash: [0, 20] }))
  // Polygons within 0.01 of circles 2 across: inside them by up to 0.7%.
  check('round-capped dots each cover a circle', rel(dotArea, 6 * Math.PI * 4) < 1e-2, fmt(dotArea))
  const closed = dashLines(rectLine, [7, 3], 0)
  const total = closed.reduce((a, d) => {
    let len = 0
    for (let i = 0; i + 3 < d.pts.length; i += 2) len += Math.hypot(d.pts[i + 2] - d.pts[i], d.pts[i + 3] - d.pts[i + 1])
    return a + len
  }, 0)
  check('a closed path is dashed all the way round', Math.abs(total - (2 * (80 + 50) * 7) / 10) < 7.01, fmt(total))
}
{
  const circle = flattenPath(shapePath({ type: 'ellipse', x: 0, y: 0, w: 100, h: 100 }), 0.01)
  const got = strokeArea(circle, style({ width: 10 }))
  const want = Math.PI * (55 * 55 - 45 * 45)
  check('a circle’s stroke is the ring between its offsets', rel(got, want) < 3e-3, `${fmt(got)} against ${fmt(want)}`)
}

// --- coverage ---------------------------------------------------------------------------------
console.log('\ncoverage')
/** Area of a convex polygon inside the unit square at (px, py): the exact coverage. */
function clipArea(poly: number[], px: number, py: number): number {
  let pts: [number, number][] = []
  for (let i = 0; i < poly.length; i += 2) pts.push([poly[i], poly[i + 1]])
  const edges: [(p: [number, number]) => number][] = [[(p) => p[0] - px], [(p) => px + 1 - p[0]], [(p) => p[1] - py], [(p) => py + 1 - p[1]]]
  for (const [f] of edges) {
    const out: [number, number][] = []
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      const fa = f(a)
      const fb = f(b)
      if (fa >= 0) out.push(a)
      if (fa >= 0 !== fb >= 0) {
        const t = fa / (fa - fb)
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
      }
    }
    pts = out
    if (!pts.length) return 0
  }
  return Math.abs(polyArea(pts.flat()))
}
{
  let worst = 0
  for (let k = 0; k < 40; k++) {
    // A random convex polygon: points round a circle at random angles.
    const n = 3 + Math.floor(rand() * 8)
    const cx = 16 + rand() * 32
    const cy = 16 + rand() * 32
    const r = 4 + rand() * 20
    const angles = Array.from({ length: n }, () => rand() * Math.PI * 2).sort((a, b) => a - b)
    const poly = angles.flatMap((a) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r])
    const segs = loopsToSegments([poly])
    const local: number[] = []
    regionSegments(segs, 0, 0, 64, 64, local)
    const cov = rasterRegion(local, 64, 64, 'nonzero')
    for (let py = 0; py < 64; py++) for (let px = 0; px < 64; px++) worst = Math.max(worst, Math.abs(cov[py * 64 + px] - clipArea(poly, px, py)))
  }
  check('coverage of convex polygons is exact: the area inside each pixel', worst < 1e-6, `worst ${fmt(worst)}`)
}
{
  // The same shape in one region, and in four quarter regions put together.
  const star = fillSegments(flattenPath(shapePath({ type: 'star', x: -20, y: 3, w: 90, h: 70, points: 7, inner: 0.45 }), 0.05))
  const whole: number[] = []
  regionSegments(star, 0, 0, 64, 64, whole)
  const all = rasterRegion(whole, 64, 64, 'nonzero')
  let worst = 0
  for (const [ox, oy] of [
    [0, 0],
    [32, 0],
    [0, 32],
    [32, 32],
  ]) {
    const part: number[] = []
    regionSegments(star, ox, oy, 32, 32, part)
    const q = rasterRegion(part, 32, 32, 'nonzero')
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) worst = Math.max(worst, Math.abs(q[y * 32 + x] - all[(oy + y) * 64 + ox + x]))
  }
  check('a region cut out of a shape covers what the whole does there (edges off to the left included)', worst < 1e-9, `worst ${fmt(worst)}`)
  // The same, with what's left of each region summed into its rows' backdrop.
  let worstRows = 0
  let fewer = true
  for (const [ox, oy] of [
    [32, 0],
    [32, 32],
  ]) {
    const plain: number[] = []
    regionSegments(star, ox, oy, 32, 32, plain)
    const part: number[] = []
    const rows = new Float64Array(32)
    regionSegments(star, ox, oy, 32, 32, part, rows)
    if (part.length >= plain.length) fewer = false
    const q = rasterRegion(part, 32, 32, 'nonzero', rows)
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) worstRows = Math.max(worstRows, Math.abs(q[y * 32 + x] - all[(oy + y) * 64 + ox + x]))
  }
  check('and with what’s left of it summed into one backdrop a row, fewer segments to the same coverage', worstRows < 1e-9 && fewer, `worst ${fmt(worstRows)}`)
  // A band of regions sorted by column once: each region's own segments and the summed backdrop left of it, against the whole band.
  {
    const many: number[] = []
    for (let i = 0; i < 24; i++) many.push(...fillSegments(flattenPath(shapePath({ type: 'star', x: -30 + i * 9.3, y: -6 + (i % 5) * 9, w: 14, h: 15, points: 5, inner: 0.5 }), 0.05)))
    // A rectangle whose sides lie on column edges, and one off the left.
    many.push(...fillSegments(flattenPath(shapePath({ type: 'rect', x: 32, y: 4, w: 64, h: 20, radii: [0, 0, 0, 0], corner: 'round' }), 0.05)))
    many.push(...fillSegments(flattenPath(shapePath({ type: 'rect', x: -50, y: 10, w: 30, h: 30, radii: [0, 0, 0, 0], corner: 'round' }), 0.05)))
    const g = segmentGrid(many, 0, 32, 32)
    let worstGrid = 0
    let read = 0
    for (let c = 0; c < 9; c++) {
      const ref: number[] = []
      const refRows = new Float64Array(32)
      regionSegments(many, c * 32, 0, 32, 32, ref, refRows)
      const want = rasterRegion(ref, 32, 32, 'nonzero', refRows)
      const col = gridColumn(g, c)
      const rows = new Float64Array(32)
      if (col.left) rows.set(col.left)
      const got: number[] = []
      regionSegments(col.segs, c * 32, 0, 32, 32, got, rows)
      read += col.segs.length
      const q = rasterRegion(got, 32, 32, 'nonzero', rows)
      for (let i = 0; i < q.length; i++) worstGrid = Math.max(worstGrid, Math.abs(q[i] - want[i]))
    }
    check('a band sorted by column gives each region the same coverage, reading a fraction of the segments', worstGrid < 1e-9 && read < (many.length * 9) / 3, `worst ${fmt(worstGrid)}, ${read / 4} of ${(many.length / 4) * 9} read`)
  }
  // The per-pixel sum the kernel does, against the row sums.
  let k = 0
  for (let py = 0; py < 64; py += 7)
    for (let px = 0; px < 64; px += 5) {
      let a = 0
      for (let i = 0; i < whole.length; i += 4) a += contribution(whole[i], whole[i + 1], whole[i + 2], whole[i + 3], px, py)
      k = Math.max(k, Math.abs(coverageOf(a, 'nonzero') - all[py * 64 + px]))
    }
  check('the kernel’s per-pixel sum is the reference’s', k < 1e-6, `worst ${fmt(k)}`)
  // Sorted into the kernel's strips of 16 rows: every segment is in the strip of each row it crosses.
  const st = stripSegments(whole, 64)
  let missing = 0
  for (let i = 0; i < whole.length; i += 4) {
    const lo = Math.min(whole[i + 1], whole[i + 3])
    const hi = Math.max(whole[i + 1], whole[i + 3])
    for (let s = 0; s < 4; s++) {
      if (!(hi > s * 16 && lo < s * 16 + 16)) continue
      let found = false
      for (let j = st.offsets[s]; j < st.offsets[s + 1]; j++) if (st.segs[j * 4] === Math.fround(whole[i]) && st.segs[j * 4 + 1] === Math.fround(whole[i + 1])) found = true
      if (!found) missing++
    }
  }
  check('the kernel’s strips of rows hold every segment crossing them', missing === 0 && st.offsets[4] >= whole.length / 4, `${missing} missing`)
  let sampled = 0
  for (let py = 0; py < 64; py += 3) for (let px = 0; px < 64; px += 3) sampled = Math.max(sampled, Math.abs(sampledCoverage(whole, px, py, 'nonzero', 32) - all[py * 64 + px]))
  check('and agrees with sampling 32 × 32 points a pixel', sampled < 0.05, `worst ${fmt(sampled)}`)
}
{
  const ring = shapePath({ type: 'rect', x: 4, y: 4, w: 40, h: 40, radii: [0, 0, 0, 0], corner: 'round' })
  const hole = shapePath({ type: 'rect', x: 14, y: 14, w: 20, h: 20, radii: [0, 0, 0, 0], corner: 'round' })
  const both: PathData = { subpaths: [...ring.subpaths, ...hole.subpaths], fillRule: 'evenodd' }
  check('even-odd leaves a hole where outlines nest', Math.abs(pathArea(both) - (1600 - 400)) < 1e-6)
  check('nonzero fills it when they run the same way', Math.abs(pathArea({ ...both, fillRule: 'nonzero' }) - 1600) < 1e-6)
  const segs = fillSegments(flattenPath(both, 0.1))
  check('the winding number counts the outlines round a point', Math.abs(windingAt(segs, 20, 20)) === 2 && Math.abs(windingAt(segs, 8, 8)) === 1 && windingAt(segs, 0, 0) === 0)
  check('and the fill rules read it', inside(2, 'nonzero') && !inside(2, 'evenodd') && inside(1, 'evenodd'))
}

// --- booleans ---------------------------------------------------------------------------------
console.log('\nbooleans')
const rect = (x: number, y: number, w: number, h: number) => shapePath({ type: 'rect', x, y, w, h, radii: [0, 0, 0, 0], corner: 'round' })
const circle = (cx: number, cy: number, r: number) => shapePath({ type: 'ellipse', x: cx - r, y: cy - r, w: 2 * r, h: 2 * r })
const bool = (a: PathData, b: PathData, op: BoolOp) =>
  booleanPaths([
    { path: a, op: 'add' },
    { path: b, op },
  ])
/** A result's area two ways: filled (as drawn) and from its loops' signed areas, which agree only if holes run the other way. */
function areas(p: PathData): [number, number] {
  const filled = pathArea(p)
  const signed = flattenPath(p, 0.01).reduce((a, l) => a + polyArea(l.pts), 0)
  return [filled, Math.abs(signed)]
}
{
  const A = rect(10, 10, 40, 30)
  const B = rect(30, 20, 40, 30)
  const overlap = 20 * 20
  const want: Record<BoolOp, number> = { add: 1200 + 1200 - overlap, subtract: 1200 - overlap, intersect: overlap, exclude: 2400 - 2 * overlap }
  for (const op of ['add', 'subtract', 'intersect', 'exclude'] as BoolOp[]) {
    const r = bool(A, B, op)
    const [filled, signed] = areas(r)
    check(`two rectangles, ${op}: the area it should be, holes the other way round`, Math.abs(filled - want[op]) < 1e-6 && Math.abs(signed - want[op]) < 1e-6, `${fmt(filled)} / ${fmt(signed)} against ${want[op]}`)
  }
  check('their union is one outline of eight corners', (() => {
    const r = bool(A, B, 'add')
    return r.subpaths.length === 1 && r.subpaths[0].anchors.length === 8
  })())
}
{
  const r = 30
  const d = 30
  const lens = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d)
  const disc = Math.PI * r * r
  const A = circle(50, 50, r)
  const B = circle(50 + d, 50, r)
  const want: Record<BoolOp, number> = { add: 2 * disc - lens, subtract: disc - lens, intersect: lens, exclude: 2 * disc - 2 * lens }
  for (const op of ['add', 'subtract', 'intersect', 'exclude'] as BoolOp[]) {
    const res = bool(A, B, op)
    const [filled, signed] = areas(res)
    check(`two circles, ${op}: the lens sums`, rel(filled, want[op]) < 3e-3 && rel(signed, want[op]) < 3e-3, `${fmt(filled)} / ${fmt(signed)} against ${fmt(want[op])}`)
  }
  const u = bool(A, B, 'add')
  const curves = u.subpaths.flatMap((s) => segmentsOf(s)).filter((c) => !(c[2] === c[0] && c[3] === c[1] && c[4] === c[6] && c[5] === c[7]))
  check('their union keeps its curves: a few cubics, not a polygon', u.subpaths.length === 1 && u.subpaths[0].anchors.length <= 10 && curves.length >= 6, `${u.subpaths[0]?.anchors.length} anchors, ${curves.length} curves`)
}
{
  const A = rect(0, 0, 40, 40)
  const B = rect(40, 0, 40, 40)
  const u = bool(A, B, 'add')
  check('squares side by side unite into one rectangle', u.subpaths.length === 1 && Math.abs(pathArea(u) - 3200) < 1e-6, `${u.subpaths.length} outlines, area ${fmt(pathArea(u))}`)
  const same = rect(5, 5, 30, 30)
  check('a shape with itself: union is it, subtract and exclude are nothing, intersect is it', [
    Math.abs(pathArea(bool(same, same, 'add')) - 900) < 1e-6,
    pathArea(bool(same, same, 'subtract')) < 1e-6,
    pathArea(bool(same, same, 'exclude')) < 1e-6,
    Math.abs(pathArea(bool(same, same, 'intersect')) - 900) < 1e-6,
  ].every(Boolean))
  const holed = bool(rect(0, 0, 50, 50), rect(10, 10, 20, 20), 'subtract')
  check('subtracting from the middle leaves a hole', holed.subpaths.length === 2 && Math.abs(pathArea(holed) - 2100) < 1e-6)
  const bow: PathData = { fillRule: 'nonzero', subpaths: [{ closed: true, anchors: [[0, 0], [40, 40], [40, 0], [0, 40]].map(([x, y]) => ({ p: [x, y] as [number, number], in: null, out: null, smooth: false })) }] }
  const tidy = booleanPaths([{ path: bow, op: 'add' }])
  check('one crossed outline alone comes back as plain outlines', tidy.subpaths.length === 2 && Math.abs(pathArea(tidy) - 800) < 1e-6, `${tidy.subpaths.length} outlines`)
  check('nothing combined with nothing is nothing', booleanPaths([]).subpaths.length === 0)
}
{
  // Fuzz: random shapes, through random transforms, against the same
  // combination sampled point by point.
  const kinds: ShapeParams['type'][] = ['rect', 'ellipse', 'star', 'polygon']
  const randomShape = (): PathData => {
    const t = kinds[Math.floor(rand() * kinds.length)]
    const s = shapeInBox(t === 'line' ? 'rect' : t, 0, 0, 20 + rand() * 30, 20 + rand() * 30, { radius: rand() * 8, sides: 3 + Math.floor(rand() * 6), points: 3 + Math.floor(rand() * 6), inner: 0.3 + rand() * 0.5 })
    const a = rand() * Math.PI
    const m = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 6 + rand() * 30, 6 + rand() * 30]
    return transformPath(shapePath(s), m)
  }
  let worstArea = 0
  let worstPts = 0
  const ops: BoolOp[] = ['add', 'subtract', 'intersect', 'exclude']
  for (let k = 0; k < 60; k++) {
    const n = 2 + Math.floor(rand() * 2)
    const operands = Array.from({ length: n }, (_, i) => ({ path: randomShape(), op: i ? ops[Math.floor(rand() * 4)] : ('add' as BoolOp) }))
    const result = booleanPaths(operands)
    const segsOf = operands.map((o) => fillSegments(flattenPath(o.path, 0.002)))
    const res = fillSegments(flattenPath(result, 0.002))
    const want = (x: number, y: number) => {
      let r = inside(windingAt(segsOf[0], x, y), 'nonzero')
      for (let i = 1; i < n; i++) {
        const v = inside(windingAt(segsOf[i], x, y), 'nonzero')
        r = operands[i].op === 'add' ? r || v : operands[i].op === 'subtract' ? r && !v : operands[i].op === 'intersect' ? r && v : r !== v
      }
      return r
    }
    let wrong = 0
    let sampledArea = 0
    const N = 120
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = (i + 0.5) * (80 / N)
        const y = (j + 0.5) * (80 / N)
        const a = want(x, y)
        if (a) sampledArea += (80 / N) ** 2
        if (a !== inside(windingAt(res, x, y), 'nonzero')) wrong++
      }
    const local: number[] = []
    regionSegments(res, 0, 0, 80, 80, local)
    const got = rasterRegion(local, 80, 80, 'nonzero').reduce((a, v) => a + v, 0)
    worstArea = Math.max(worstArea, Math.abs(got - sampledArea) / Math.max(200, sampledArea))
    worstPts = Math.max(worstPts, wrong / (N * N))
  }
  check('random shapes combined match the combination sampled point by point', worstPts < 0.004, `worst ${(worstPts * 100).toFixed(2)}% of points differ`)
  check('and their areas agree', worstArea < 0.02, `worst ${(worstArea * 100).toFixed(2)}%`)
}

// --- editing ----------------------------------------------------------------------------------
console.log('\nediting')
{
  const p = shapePath({ type: 'ellipse', x: 0, y: 0, w: 100, h: 60 })
  check('a press near an anchor finds it', JSON.stringify(hitAnchor(p, 101, 31, 4)) === JSON.stringify({ sub: 0, i: 1 }))
  const hit = hitSegment(p, 85, 6, 6)!
  check('a press near the outline finds the point on it', !!hit && hit.d < 6 && hit.seg === 0)
  const q = insertAnchor(p, 0, 0, 0.4)
  const before = segmentsOf(p.subpaths[0])[0]
  const parts = segmentsOf(q.subpaths[0])
  const same = [0, 0.2, 0.4, 0.7, 1].every((t) => {
    const a = evalCubic(before, t)
    const b = t <= 0.4 ? evalCubic(parts[0], t / 0.4) : evalCubic(parts[1], (t - 0.4) / 0.6)
    return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9
  })
  check('an anchor added on a curve leaves the curve as it was', q.subpaths[0].anchors.length === 5 && same)
  const r = deleteAnchors(q, [{ sub: 0, i: 1 }])
  check('and deleted again leaves four', r.subpaths[0].anchors.length === 4)
  check('a subpath left with one anchor goes', deleteAnchors(shapePath({ type: 'line', x1: 0, y1: 0, x2: 9, y2: 9 }), [{ sub: 0, i: 0 }]).subpaths.length === 0)
  const m = moveAnchors(p, [{ sub: 0, i: 0 }], 5, -2)
  const a0 = m.subpaths[0].anchors[0]
  check('moving an anchor moves its handles with it', a0.p[0] === 55 && a0.p[1] === -2 && a0.in![0] === p.subpaths[0].anchors[0].in![0] + 5)
  const h = moveHandle(p, { sub: 0, i: 1 }, 'out', 110, 50, false).subpaths[0].anchors[1]
  const ix = h.in![0] - h.p[0]
  const iy = h.in![1] - h.p[1]
  const ox = h.out![0] - h.p[0]
  const oy = h.out![1] - h.p[1]
  check('a smooth point’s other handle turns to stay in line', Math.abs(ix * oy - iy * ox) < 1e-9 && ix * ox + iy * oy < 0)
  check('with Alt it becomes a corner instead', moveHandle(p, { sub: 0, i: 1 }, 'out', 110, 50, true).subpaths[0].anchors[1].smooth === false)
  const c = convertAnchor(p, { sub: 0, i: 0 }).subpaths[0].anchors[0]
  check('converting a smooth point makes a corner without handles', !c.in && !c.out && !c.smooth)
  const s = convertAnchor(rect(0, 0, 10, 10), { sub: 0, i: 1 }).subpaths[0].anchors[1]
  check('converting a corner makes it smooth, its handles along its neighbours', s.smooth && !!s.in && !!s.out)
  check('a box takes the anchors in it', anchorsIn(rect(0, 0, 10, 10), -1, -1, 5, 11).length === 2)
}

// --- the model --------------------------------------------------------------------------------
console.log('\nthe model')
{
  const warns: string[] = []
  const g = readGeometry({ kind: 'path', path: { fillRule: 'evenodd', subpaths: [{ closed: true, anchors: [{ p: [0, 0] }, { p: [10, 'x'] }, { p: [10, 10], in: [5, 5], out: null }] }] } }, (w) => warns.push(w))
  check('a path read from a file drops what’s damaged and says so', g?.kind === 'path' && g.path.subpaths[0].anchors.length === 2 && g.path.fillRule === 'evenodd' && warns.length === 1)
  check('a live shape comes back as one', readGeometry({ kind: 'shape', shape: { type: 'ellipse', x: 0, y: 0, w: 5, h: 5 } }, () => {})?.kind === 'shape')
  check('geometry of an unknown kind is cleared', readGeometry({ kind: 'spiral' }, () => {}) === null)
  check('no geometry draws nothing', geometryPath(null).subpaths.length === 0)
  const items = readAppearance(
    [
      { kind: 'fill', paint: { kind: 'solid', colour: [1, 0, 0] }, opacity: 7 },
      { kind: 'stroke', paint: { kind: 'gradient', type: 'radial', stops: [] }, width: -3, join: 'odd', dash: [4, 'x', 2] },
      { kind: 'glow' },
    ],
    () => {},
  )
  check('fills and strokes read back whole, in range; unknown kinds dropped', items.length === 2 && items[0].opacity === 1 && items[1].kind === 'stroke' && items[1].width === 0 && items[1].join === 'miter' && items[1].dash.join() === '4,2')
  const g2 = items[1].paint
  check('a gradient without stops gets two', g2.kind === 'gradient' && g2.stops.length === 2 && g2.type === 'radial')
  const cmyk = appearanceIn(items, 'cmyk')
  check('colours are made the document’s shape when used', cmyk[0].paint.kind === 'solid' && cmyk[0].paint.colour.length === 4)
}
{
  // Patterns are box-filtered: from far away they average to their share of ink.
  const mean = (idx: number) => {
    let a = 0
    for (let i = 0; i < 400; i++) a += patternValue(idx, rand() * 50, rand() * 50, 8)
    return a / 400
  }
  check('a checkerboard seen from far off is half and half', Math.abs(mean(0) - 0.5) < 0.02)
  check('up close it is one colour or the other', patternValue(0, 0.25, 0.25, 0) === 0 && patternValue(0, 1.25, 0.25, 0) === 1)
}

// --- edits and the scene ------------------------------------------------------------------------
console.log('\nshape edits and the scene')
{
  const rectG = (x: number): Geometry => ({ kind: 'shape', shape: { type: 'rect', x, y: 0, w: 50, h: 50, radii: [0, 0, 0, 0], corner: 'round' } })
  const red = [fillItem(solid([1, 0, 0]))]
  let d = createDoc({ name: 'v', width: 200, height: 200, resolution: 72, mode: 'rgb', depth: 8, profile: { builtin: 'srgb' } }, 'root')
  d = addVector(d, 'a', 'A', rectG(0), red, 'root', 0)
  d = addVector(d, 'b', 'B', rectG(30), [fillItem(solid([0, 0, 1]))], 'root', 1)
  d = addVector(d, 'c', 'C', rectG(60), [], 'root', 2)
  const json = readDocJson(docToJson(d))
  check('shapes save and read back exactly', json.ok && JSON.stringify(json.doc) === JSON.stringify(d) && json.warnings.length === 0)
  const one = combineWithBelow(d, 'b', 'subtract', 'k')
  const k = one.nodes.k
  check('combining a shape with the one below makes a compound of the two, in their place', k?.kind === 'boolean' && k.children!.join() === 'a,b' && one.nodes.root.children!.join() === 'k,c' && k.props.ops.b === 'subtract')
  check('painted as the bottom shape was', k.kind === 'boolean' && JSON.stringify(k.props.appearance) === JSON.stringify(red))
  const two = combineWithBelow(one, 'c', 'intersect', 'unused')
  check('a shape combined with a compound below joins it', two.nodes.k.children!.join() === 'a,b,c' && !two.nodes.unused && (two.nodes.k as { props: { ops: Record<string, string> } }).props.ops.c === 'intersect')
  check('a shape with nothing to combine with is refused', combineWithBelow(d, 'a', 'add', 'z') === d)
  check('a compound can’t take what isn’t a shape', combineWithBelow({ ...one, nodes: { ...one.nodes, c: { ...one.nodes.c, kind: 'pixel', props: { tiles: null, resample: 'bicubic' } } as never } }, 'c', 'add', 'z').nodes.k.children!.length === 2)
  const released = releaseCompound(two, 'k')
  check('Release puts its shapes back where it was, in order', released.nodes.root.children!.join() === 'a,b,c' && !released.nodes.k)
  const path = booleanPaths(operandsOf((id) => two.nodes[id], two.nodes.k))
  const expanded = expandCompound(two, 'k', path)
  check('Expand turns it into one shape with its outline and its appearance', expanded.nodes.k.kind === 'vector' && !expanded.nodes.a && !expanded.nodes.c && JSON.stringify((expanded.nodes.k as { props: { appearance: unknown } }).props.appearance) === JSON.stringify(red))
  const moved = transformNode(one, 'k', [1, 0, 0, 1, 10, 5])
  check('moving a compound moves its shapes', moved.nodes.a.transform[4] === 10 && moved.nodes.b.transform[5] === 5)
  check('so its outline moves with them', pathBounds(docPathOf((id) => moved.nodes[id], moved.nodes.k)!)![0] === 10)
  check('changing an operand’s operation', (setBoolOp(one, 'k', 'b', 'exclude').nodes.k as { props: { ops: Record<string, string> } }).props.ops.b === 'exclude')
  const masked = addVectorMask(d, 'a', 'vm', 0)
  check('a vector mask goes on a layer, empty, hiding everything', masked.nodes.vm?.kind === 'mask' && (masked.nodes.vm as { props: { source: string; outside: number } }).props.source === 'vector' && (masked.nodes.vm as { props: { outside: number } }).props.outside === 0 && masked.nodes.a.masks.join() === 'vm')
  check('one per layer', addVectorMask(masked, 'a', 'vm2', 1) === masked)
  const shaped = setGeometry(masked, 'vm', rectG(5))
  check('a vector mask takes an outline', (shaped.nodes.vm as { props: { geometry: unknown } }).props.geometry !== null)
  check('named in the history as what they are', describeEdit(masked, shaped) === 'Edit Vector Mask' && describeEdit(d, masked) === 'Add Vector Mask' && describeEdit(d, setAppearance(d, 'a', [])) === 'Appearance' && describeEdit(d, setGeometry(d, 'a', rectG(9))) === 'Edit Shape')

  // The scene: bounds that allow for strokes, and compounds that follow their shapes.
  const stroked = setAppearance(d, 'a', [strokeItem(solid([0, 0, 0]), 10)])
  const scene = new Scene('s', () => null)
  const up = (doc: Doc, reset = true) => scene.apply({ doc: { width: 200, height: 200, mode: 'rgb', depth: 8, profile: { builtin: 'srgb' }, root: doc.root, selection: null }, nodes: Object.values(doc.nodes).map((node, i) => ({ node, version: i + 1 + (reset ? 0 : 100) })), removed: [], reset })
  up(stroked)
  const b = scene.contentBounds(stroked.nodes.a)!
  check('a stroked shape’s bounds reach past its path by its miters', b[0] === -20 && b[2] === 70, JSON.stringify(b))
  up(one)
  const before = scene.ownVersion('k')
  const kb = scene.contentBounds(one.nodes.k)!
  check('a compound covers its shapes together', kb[0] === 0 && kb[2] === 80)
  const nudged = transformNode(one, 'b', [1, 0, 0, 1, 40, 0])
  const r = scene.apply({ doc: scene.doc!, nodes: [{ node: nudged.nodes.b, version: 999 }], removed: [], reset: false })
  check('moving one of its shapes changes the compound’s own version', scene.ownVersion('k') !== before)
  check('and redraws where the compound was and is', r.dirty !== 'all' && r.dirty.some((x) => x[0] <= 0 && x[2] >= 120), JSON.stringify(r.dirty))
}

console.log('\nwarps')
{
  const near = (a: number[] | null, b: number[], tol = 1e-6) => !!a && a.every((v, i) => Math.abs(v - b[i]) <= tol)
  // Homographies.
  const q: [number, number][] = [
    [10, 20],
    [110, 0],
    [130, 140],
    [-5, 100],
  ]
  const h = squareToQuad(q)!
  check('the square’s corners go to the quad’s', [[0, 0], [1, 0], [1, 1], [0, 1]].every(([u, v], i) => near(mapH(h, u, v), q[i])))
  const hi = invertH(h)!
  const back = mapH(hi, ...mapH(h, 0.3, 0.7)!)
  check('and its inverse brings them back', near(back, [0.3, 0.7]))
  check('a flat quad’s homography is an affine', Math.abs(squareToQuad([[0, 0], [2, 0], [2, 3], [0, 3]])![6]) < 1e-12)

  // The transform warp: nothing moves with flat corners and no mesh; a perspective and a style round trip.
  const box: [number, number, number, number] = [20, 10, 220, 110]
  const flat = new WarpMap({ frame: boxFrame(box), corners: boxCorners(box), mesh: null })
  check('a flat warp moves nothing', near(flat.forward(50, 60), [50, 60]) && near(flat.inverse(50, 60)!.slice(0, 2), [50, 60]))
  const persp = new WarpMap({ frame: boxFrame(box), corners: [40, 10, 200, 10, 240, 110, 0, 110], mesh: null })
  const fp = persp.forward(100, 40)!
  const ip = persp.inverse(fp[0], fp[1])!
  check('a perspective maps forward and back', near([ip[0] / ip[2], ip[1] / ip[2]], [100, 40], 1e-6), JSON.stringify(ip))
  check('its top corners are where they were dragged', near(persp.forward(20, 10), [40, 10]) && near(persp.forward(220, 10), [200, 10]))
  for (const [style] of WARP_STYLES.filter(([s]) => s !== 'none' && s !== 'custom')) {
    const mesh = styleMesh(style, 0.5, 0.2, -0.1, style === 'flag')
    const w = new WarpMap({ frame: boxFrame(box), corners: boxCorners(box), mesh })
    let worst = 0
    for (const [x, y] of [
      [30, 20],
      [120, 60],
      [210, 100],
      [60, 90],
    ]) {
      const f = w.forward(x, y)!
      const r = w.inverse(f[0], f[1])
      worst = Math.max(worst, r ? Math.hypot(r[0] / r[2] - x, r[1] / r[2] - y) : Infinity)
    }
    check(`${style}: forward and back`, worst < 1e-4, String(worst))
  }
  check('Arc bends: the middle of the top edge rises', styleMesh('arc', 0.5, 0, 0, false) && meshEval(styleMesh('arc', 0.5, 0, 0, false), 0.5, 0)[1] < meshEval(styleMesh('arc', 0.5, 0, 0, false), 0, 0)[1])
  check('no bend is no warp', isIdentityMesh(styleMesh('flag', 0, 0, 0, false)) || meshEval(styleMesh('flag', 0, 0, 0, false), 0.3, 0.6).every((v, i) => i > 1 || Math.abs(v - [0.3, 0.6][i]) < 1e-9))
  const id = identityMesh(2, 3)
  check('the identity mesh maps the square to itself', near(meshEval(id, 0.37, 0.81).slice(0, 2), [0.37, 0.81]))
  check('a point past the mesh carries on its edge patch', near(meshEval(id, 1.2, -0.1).slice(0, 2), [1.2, -0.1]))
  check('and the inverse finds it with no guess', near(meshInverse(id, 1.2, -0.1), [1.2, -0.1], 1e-6))
  const arc = styleMesh('arc', 0.6, 0, 0, false)
  const fine = regridMesh(arc, 3, 2)
  check('a mesh on more patches keeps its shape', [[0.1, 0.2], [0.5, 0.5], [0.93, 0.71]].every(([u, v]) => near(meshEval(fine, u, v).slice(0, 2), meshEval(arc, u, v).slice(0, 2), 1e-9)))
  const m1 = identityMesh(1, 1)
  coonsInner(m1, 0, 0)
  check('a flat patch’s inner points from its edges are flat', isIdentityMesh(m1))
  const m2 = identityMesh(2, 2)
  const before = meshPoint(m2, 4, 3)
  dragMeshPoint(m2, 3, 3, 0.1, 0.05)
  const after = meshPoint(m2, 4, 3)
  check('dragging an anchor takes its handles', near(meshPoint(m2, 3, 3), [0.6, 0.55]) && near(after, [before[0] + 0.1, before[1] + 0.05]))
  dragMeshPoint(m2, 4, 3, 0, 0.1)
  const a = meshPoint(m2, 3, 3)
  const hh = meshPoint(m2, 4, 3)
  const o = meshPoint(m2, 2, 3)
  check('a handle turns the one across its anchor, in line', Math.abs((hh[0] - a[0]) * (o[1] - a[1]) - (hh[1] - a[1]) * (o[0] - a[0])) < 1e-9 && (hh[0] - a[0]) * (o[0] - a[0]) < 0)

  // Outlines through a warp: cut finely enough to follow it.
  const bend = (x: number, y: number): [number, number] => [x, y + 0.002 * (x - 50) ** 2]
  const line = warpLines([0, 0, 100, 0, 100, 10, 0, 10], bend, 0.1, true)
  let worst = 0
  for (let i = 0; i + 3 < line.length; i += 2) {
    // Along the top and bottom only (not the sides, which the warp keeps straight up and down).
    if (Math.abs(line[i] - line[i + 2]) < 1e-9) continue
    const mx = (line[i] + line[i + 2]) / 2
    const my = (line[i + 1] + line[i + 3]) / 2
    const c = 0.002 * (mx - 50) ** 2
    worst = Math.max(worst, Math.min(Math.abs(my - c), Math.abs(my - 10 - c)))
  }
  check('a warped outline stays within its tolerance', worst <= 0.1 + 1e-9, String(worst))

  // Liquify's field.
  const f = newField([0, 0, 200, 100])
  check('a new field reaches past the content', f.area[0] < 0 && f.area[2] > 200 && f.cols <= 320)
  liquifyDab(f, 'warp', 100, 50, 10, 0, 40, 1)
  const d0 = fieldAt(f, 100, 50)
  check('Forward Warp reads the middle from behind the drag', d0[0] < -5 && Math.abs(d0[1]) < 1e-6, JSON.stringify(d0))
  check('and nothing outside the brush', fieldAt(f, 100, 0)[0] === 0 && fieldAt(f, 170, 50)[0] === 0)
  const st = encodeField(f)
  const g = decodeField(st)!
  check('a field kept in a document reads back to an eighth of a pixel', g.d.every((v, i) => Math.abs(v - f.d[i]) <= 1 / 16))
  check('a broken one reads as none', decodeField({ ...st, data: '!!' }) === null && decodeField({ ...st, cols: 2 }) === null)
  for (let k = 0; k < 40; k++) liquifyDab(f, 'reconstruct', 100, 50, 0, 0, 60, 1)
  check('Reconstruct takes it back', Math.abs(fieldAt(f, 100, 50)[0]) < 0.05)

  // The filter registry's view: warps from their settings, and their reference.
  const mode = 'rgb'
  const node = makeNode('filter', 'w1', 'Warp', { filter: 'warp', params: { frame: boxFrame(box), corners: [40, 10, 200, 10, 240, 110, 0, 110] } })
  const w = warpOf(node, mode)!
  check('a Warp effect’s warp is its settings’', !!w && near(w.forward!(20, 10), [40, 10]))
  check('one with nothing set warps nothing', warpOf(makeNode('filter', 'w2', 'Warp', { filter: 'warp', params: {} }), mode) === null)
  check('Warp and Liquify are left out of the Filter menu', !!FILTER_BY_ID.get('warp')!.hidden && !!FILTER_BY_ID.get('liquify')!.hidden)
  const moved = moveWarpParams('warp', node.props.params as Record<string, unknown>, [2, 0, 0, 2, 5, 5])
  const w3 = FILTER_BY_ID.get('warp')!.warp!(filterValues('warp', moved, mode))!
  check('a warp carried by an affine draws where it did through it', near(w3.forward!(45, 25), [85, 25]))
  const img = { size: 8, stride: 4, data: new Float64Array(8 * 8 * 4).map((_, i) => (i % 4 === 3 ? 1 : (i % 7) / 7)) }
  const none = warpRegion(img, { inverse: (x, y) => [x, y, 1], bounds: (r) => r }, { origin: [0, 0], scale: 1, seed: 0 })
  check('the reference with no warp is the region as it was', none.data.every((v, i) => Math.abs(v - img.data[i]) < 1e-12))
  const shifted = warpRegion(img, { inverse: (x, y) => [x - 1, y, 1], bounds: (r) => r }, { origin: [0, 0], scale: 1, seed: 0 })
  check('and one moved a pixel right reads a pixel left', Math.abs(shifted.data[(2 * 8 + 3) * 4] - img.data[(2 * 8 + 2) * 4]) < 1e-12)
  void applyH
}

console.log('\neffects per fill and stroke, and graphic styles')
{
  const sq = geometryPath({ kind: 'shape', shape: { type: 'rect', x: 0, y: 0, w: 100, h: 100, radii: [0, 0, 0, 0], corner: 'round' } })
  const area = (p: PathData) => flattenPath(p, 0.01).reduce((a, l) => a + Math.abs(polyArea(l.pts)), 0)
  const net = (p: PathData) => Math.abs(flattenPath(p, 0.01).reduce((a, l) => a + polyArea(l.pts), 0))
  const grown = offsetPath(sq, 10, 'miter', 4, 0.05)
  check('Offset Path out by 10 with mitred corners is a square 20 bigger', Math.abs(net(grown) - 120 * 120) < 30, String(net(grown)))
  const shrunk = offsetPath(sq, -10, 'miter', 4, 0.05)
  check('and in by 10, a square 20 smaller', Math.abs(net(shrunk) - 80 * 80) < 30, String(net(shrunk)))
  const round = offsetPath(sq, 10, 'round', 4, 0.05)
  check('round corners add a quarter circle at each', Math.abs(net(round) - (100 * 100 + 4 * 100 * 10 + Math.PI * 100)) < 40, String(net(round)))
  check('nothing to offset is the path as it was', offsetPath(sq, 0, 'miter', 4, 0.05) === sq)
  const fx = (kind: string, params: Record<string, unknown>) => [{ kind, enabled: true, params }]
  const moved = itemPath(sq, fx('transform', { moveX: 30, moveY: 0, copies: 0 }), 'rgb', 0.1)
  check('Transform moves an item’s path', pathBounds(moved)![0] === 30 && pathBounds(moved)![2] === 130)
  const copies = itemPath(sq, fx('transform', { moveX: 30, moveY: 0, copies: 3 }), 'rgb', 0.1)
  check('with copies, each from the last, the original kept', copies.subpaths.length === 4 && pathBounds(copies)![2] === 190)
  const rough = itemPath(sq, fx('roughen', { size: 4, detail: 20, seed: 3 }), 'rgb', 0.1)
  check('Roughen strays within its size, the same each time for a seed', pathBounds(rough)![0] >= -4 - 1e-9 && pathBounds(rough)![0] < 0 && JSON.stringify(itemPath(sq, fx('roughen', { size: 4, detail: 20, seed: 3 }), 'rgb', 0.1)) === JSON.stringify(rough))
  const zz = itemPath(sq, fx('zigzag', { size: 5, ridges: 10 }), 'rgb', 0.1)
  check('Zig Zag goes out and in by its size', Math.abs(pathBounds(zz)![0] + 5) < 1e-6, JSON.stringify(pathBounds(zz)))
  const bulge = itemPath(sq, fx('pucker', { amount: 50 }), 'rgb', 0.1)
  check('Bloat pulls the corners in and pushes the sides out', pathBounds(bulge)![0] < 0 && Math.abs(bulge.subpaths[0].anchors[0].p[0] - 25) < 1e-9, JSON.stringify(bulge.subpaths[0].anchors[0].p))
  const arc = itemPath(sq, fx('warp', { style: 'arc', bend: 50 }), 'rgb', 0.1)
  check('Warp bends an item’s path', area(arc) > 0 && JSON.stringify(pathBounds(arc)) !== JSON.stringify(pathBounds(sq)))
  check('a switched-off effect does nothing', itemPath(sq, [{ kind: 'transform', enabled: false, params: { moveX: 30 } }], 'rgb', 0.1) === sq)
  check('every path effect has a label and settings', PATH_EFFECTS.every((d) => d.label && d.params.length))
  check('bounds take the effects in', itemBounds(sq, fx('offset', { distance: 10 }), 'rgb', 0.1)![0] < -9)
  check('pixel effects reach as far as their filters', pixelReach(fx('gaussian-blur', { radius: 10 }), 'rgb') > 10 && pixelReach(fx('offset', { distance: 10 }), 'rgb') === 0)
  check('effects read back from a file, unknown kinds kept, junk left out', readItemEffects([{ kind: 'future-thing', params: { a: 1 } }, 7, { kind: 'roughen', enabled: false }]).length === 2)

  // Graphic styles.
  let d = createDoc({ name: 'S', width: 200, height: 200, resolution: 72, mode: 'rgb', depth: 8, profile: { builtin: 'srgb' } }, 'root')
  const shape = (id: string) => makeNode('vector', id, id, { geometry: { kind: 'shape', shape: { type: 'rect', x: 0, y: 0, w: 50, h: 50, radii: [0, 0, 0, 0], corner: 'round' } }, appearance: [fillItem(solid([1, 0, 0]))], graphicStyle: null })
  d = addVector(addVector(d, 'a', 'A', shape('a').props.geometry!, [fillItem(solid([1, 0, 0]))], 'root', 0), 'b', 'B', shape('b').props.geometry!, [fillItem(solid([0, 0, 1]))], 'root', 1)
  const look = [fillItem(solid([0, 1, 0])), { ...strokeItem(solid([0, 0, 0]), 4), effects: [{ kind: 'drop-shadow', enabled: true, params: {} }] }]
  d = addGraphicStyle(d, { id: 'g1', name: 'Green', appearance: look })
  d = applyGraphicStyle(d, ['a', 'b'], 'g1')
  const ap = (id: string) => (d.nodes[id].props as { appearance: unknown[] }).appearance
  check('a style gives shapes its look, linked', linkOf(d.nodes.a) === 'g1' && linkOf(d.nodes.b) === 'g1' && JSON.stringify(ap('a')) === JSON.stringify(look))
  check('a copy: the shape and the style don’t share one', ap('a') !== d.graphicStyles![0].appearance)
  d = redefineGraphicStyle(d, 'g1', [fillItem(solid([1, 1, 0]))])
  check('redefining the style changes every linked shape', JSON.stringify(ap('b')) === JSON.stringify([fillItem(solid([1, 1, 0]))]))
  const changed = setAppearance(d, 'a', [fillItem(solid([0, 0, 0]))])
  check('a change of a shape’s own breaks its link', linkOf(changed.nodes.a) === null && linkOf(changed.nodes.b) === 'g1')
  check('Break Link keeps the look', JSON.stringify(ap('a')) === JSON.stringify((unlinkGraphicStyle(d, 'a').nodes.a.props as { appearance: unknown[] }).appearance) && linkOf(unlinkGraphicStyle(d, 'a').nodes.a) === null)
  const gone = removeGraphicStyle(d, 'g1')
  check('deleting a style unlinks its shapes and keeps their looks', !gone.graphicStyles!.length && linkOf(gone.nodes.b) === null && JSON.stringify((gone.nodes.b.props as { appearance: unknown[] }).appearance) === JSON.stringify(ap('b')))
  const back = readDocJson(docToJson(d))
  check('styles and item effects are saved and read back', back.ok && back.doc.graphicStyles?.[0]?.name === 'Green' && linkOf(back.doc.nodes.a) === 'g1')
  const withFx = setAppearance(d, 'a', look)
  const back2 = readDocJson(docToJson(withFx))
  check('an item’s effects come back from a file', back2.ok && JSON.stringify((back2.doc.nodes.a.props as { appearance: { effects?: unknown }[] }).appearance[1].effects) === JSON.stringify(look[1].effects))
  const frag = fragmentOf(d, ['a'], 'fr')
  const target = createDoc({ name: 'T', width: 200, height: 200, resolution: 72, mode: 'rgb', depth: 8, profile: { builtin: 'srgb' } }, 'root')
  let k = 0
  const pasted = pasteFragment(target, frag, { parent: 'root', index: 0, newId: (p) => `${p}${k++}` })
  check('a copied shape brings its style along', pasted.doc.graphicStyles?.some((g) => g.id === 'g1') === true, JSON.stringify(pasted.doc.graphicStyles?.map((g) => g.id)))
}

console.log('\nregions, and the path commands')
{
  const rect = (x: number, y: number, w: number, h: number) => geometryPath({ kind: 'shape', shape: { type: 'rect', x, y, w, h, radii: [0, 0, 0, 0], corner: 'round' } })
  const a = rect(0, 0, 100, 100)
  const b = rect(50, 50, 100, 100)
  const rs = divide([a, b])
  const areas = rs.map((r) => Math.round(regionArea(r.path))).sort((x, y) => x - y)
  check('two overlapping squares make three regions', rs.length === 3 && JSON.stringify(areas) === JSON.stringify([2500, 7500, 7500]), JSON.stringify(areas))
  check('each knows the shapes it’s in', rs.some((r) => r.inside.join() === '0,1') && rs.some((r) => r.inside.join() === '0') && rs.some((r) => r.inside.join() === '1'))
  check('a point finds its region', rs[regionAt(rs, [75, 75])]?.inside.join() === '0,1' && regionAt(rs, [300, 300]) === -1)
  const ring = divide([rect(0, 0, 100, 100), rect(25, 25, 50, 50)])
  check('a square inside another makes a ring and a hole’s fill', ring.length === 2 && ring.some((r) => r.inside.join() === '0' && r.path.subpaths.length === 2))
  const apart = divide([rect(0, 0, 40, 40), rect(100, 0, 40, 40)])
  check('shapes apart stay apart', apart.length === 2)
  const two = booleanPaths([
    { path: rect(0, 0, 40, 40), op: 'add' },
    { path: rect(100, 0, 40, 40), op: 'add' },
  ])
  check('a path’s separate pieces come apart', pieces(two).length === 2)
  check('contains: inside and out', contains(a, [10, 10]) && !contains(a, [110, 10]))
  check('unite makes one region of many', Math.round(regionArea(unite(rs.map((r) => r.path)))) === 17500)
  // Join and Smooth.
  const open1: PathData = { fillRule: 'nonzero', subpaths: [{ closed: false, anchors: [{ p: [0, 0], in: null, out: null, smooth: false }, { p: [50, 0], in: null, out: null, smooth: false }] }] }
  check('Join closes a lone open path', joinPath(open1).subpaths[0].closed)
  const open2: PathData = { fillRule: 'nonzero', subpaths: [...open1.subpaths, { closed: false, anchors: [{ p: [52, 0], in: null, out: null, smooth: false }, { p: [100, 10], in: null, out: null, smooth: false }] }] }
  const j = joinPath(open2)
  check('and two open paths into one, by their nearest ends', j.subpaths.length === 1 && j.subpaths[0].anchors.length === 4 && !j.subpaths[0].closed)
  check('a closed path has nothing to join', joinPath(a) === a)
  check('Smooth gives every anchor handles', smoothPath(a).subpaths[0].anchors.every((x) => x.in && x.out))
  // Simplify: a circle sampled into many anchors comes back to a few, within the tolerance.
  const many: PathData = { fillRule: 'nonzero', subpaths: [{ closed: true, anchors: Array.from({ length: 120 }, (_, i) => ({ p: [100 + 50 * Math.cos((i / 120) * 2 * Math.PI), 100 + 50 * Math.sin((i / 120) * 2 * Math.PI)] as Pt, in: null, out: null, smooth: false })) }] }
  const simple = simplifyPath(many, 0.5)
  const n = simple.subpaths[0].anchors.length
  let worst = 0
  for (const l of flattenPath(simple, 0.05)) for (let i = 0; i < l.pts.length; i += 2) worst = Math.max(worst, Math.abs(Math.hypot(l.pts[i] - 100, l.pts[i + 1] - 100) - 50))
  check('Simplify: a circle of 120 anchors to a handful', n <= 12 && n >= 3, String(n))
  check('within its tolerance (and the polygon’s own error)', worst < 0.6, String(worst))
  check('a square keeps its corners', simplifyPath(a, 1).subpaths[0].anchors.length === 4)
  // Live Paint: a group's fills paint the regions holding their points; the paths' strokes go on top.
  const nodes: Record<string, DocNode> = {}
  const v1 = makeNode('vector', 'v1', 'v1', { geometry: { kind: 'path', path: a }, appearance: [fillItem(solid([1, 0, 0])), strokeItem(solid([0, 0, 0]), 2)], graphicStyle: null })
  const v2 = makeNode('vector', 'v2', 'v2', { geometry: { kind: 'path', path: b }, appearance: [fillItem(solid([0, 0, 1]))], graphicStyle: null })
  const g = makeNode('boolean', 'g', 'g', { ops: {}, appearance: [], live: { fills: [{ at: [75, 75], paint: solid([0, 1, 0]) }, { at: [10, 10], paint: solid([1, 1, 0]) }] } })
  g.children = ['v1', 'v2']
  Object.assign(nodes, { v1, v2, g })
  const parts = livePaintParts((id) => nodes[id], g)
  check('Live Paint: a part for each filled region, then the strokes', parts.length === 3 && Math.round(regionArea(parts[0].path)) === 2500 && Math.round(regionArea(parts[1].path)) === 7500 && parts[2].appearance[0].kind === 'stroke')
}

console.log('\nthe curvature rule, breaking and joining')
{
  const pt = (x: number, y: number, smooth = true) => ({ p: [x, y] as Pt, in: null, out: null, smooth })
  const near2 = (a: Pt | null, b: Pt, tol = 1e-9) => !!a && Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol
  // Three points in an arch: the middle one's handles level, a third of the way to each neighbour.
  const arch = { closed: false, anchors: [pt(0, 100), pt(100, 0), pt(200, 100)] }
  const mid = curvatureAnchor(arch, 1)
  check('a smooth point’s handles lie along the line between its neighbours', near2(mid.in, [100 - Math.hypot(100, 100) / 3, 0]) && near2(mid.out, [100 + Math.hypot(100, 100) / 3, 0]))
  const start = curvatureAnchor(arch, 0)
  check('an open end has one handle, towards its neighbour', start.in === null && !!start.out)
  // Mirrored across the chord from (0,100) to (100,0): the neighbour's tangent (1,0) seen from the end becomes (0,-1).
  const dir = start.out ? [start.out[0] - 0, start.out[1] - 100] : [0, 0]
  check('and bent as the curve through its neighbour goes: up, not along the chord', Math.abs(dir[0]) < 1e-9 && dir[1] < 0, JSON.stringify(dir))
  const corner = curvatureAnchor({ closed: false, anchors: [pt(0, 0), pt(50, 50, false), pt(100, 0)] }, 1)
  check('a corner keeps no handles', corner.in === null && corner.out === null)
  const two = curvatureAnchor({ closed: false, anchors: [pt(0, 0), pt(100, 0)] }, 0)
  check('two points make a straight line', !!two.out && Math.abs(two.out[1]) < 1e-9)
  // A closed square of smooth points is close to a circle.
  const ring = recurve({ closed: true, anchors: [pt(100, 0), pt(200, 100), pt(100, 200), pt(0, 100)] }, [0, 1, 2, 3])
  const r = Math.hypot(...(evalCubic(segmentsOf(ring)[0], 0.5).map((v) => v - 100) as [number, number]))
  check('four smooth points in a closed path make something near a circle', Math.abs(r - 100) < 6, r.toFixed(2))
  const moved = recurve({ closed: false, anchors: [pt(0, 0), pt(100, 0), pt(200, 0), pt(300, 0), pt(400, 0)] }, [0])
  check('recurve touches only the points round the one changed', !!moved.anchors[1].out && moved.anchors[3].in === null && moved.anchors[4].in === null)

  // Breaking.
  const sq = { fillRule: 'nonzero' as const, subpaths: [{ closed: true, anchors: [pt(0, 0, false), pt(100, 0, false), pt(100, 100, false), pt(0, 100, false)] }] }
  const opened = breakAt(sq, [{ sub: 0, i: 2 }])
  check('breaking a closed path at a point opens it there, the point at both ends', opened.subpaths.length === 1 && !opened.subpaths[0].closed && opened.subpaths[0].anchors.length === 5 && near2(opened.subpaths[0].anchors[0].p, [100, 100]) && near2(opened.subpaths[0].anchors[4].p, [100, 100]))
  const two2 = breakAt(sq, [{ sub: 0, i: 0 }, { sub: 0, i: 2 }])
  check('at two points, it falls in two', two2.subpaths.length === 2 && two2.subpaths.every((s) => s.anchors.length === 3 && !s.closed))
  const line = { fillRule: 'nonzero' as const, subpaths: [{ closed: false, anchors: [pt(0, 0, false), pt(50, 0, false), pt(100, 0, false)] }] }
  check('an open path at a middle point splits in two', breakAt(line, [{ sub: 0, i: 1 }]).subpaths.length === 2)
  check('at its end, nothing changes', breakAt(line, [{ sub: 0, i: 2 }]).subpaths[0] === line.subpaths[0])

  // Joining.
  const a = { closed: false, anchors: [pt(0, 0, false), pt(100, 0, false)] }
  const b = { closed: false, anchors: [pt(200, 0, false), pt(300, 0, false)] }
  const ab = joinSubpaths(a, 'end', b, 'start', false)
  check('two ends joined by a segment: one path, every point kept, in order', ab.anchors.map((x) => x.p[0]).join() === '0,100,200,300')
  const ba = joinSubpaths(a, 'start', b, 'end', false)
  check('from the other ends, turned round to meet', ba.anchors.map((x) => x.p[0]).join() === '100,0,300,200')
  const touching = joinSubpaths(a, 'end', { closed: false, anchors: [pt(100, 0, false), pt(200, 50, false)] }, 'start', true)
  check('ends that meet become one point', touching.anchors.length === 3 && touching.anchors.map((x) => x.p[0]).join() === '0,100,200')
  const tri = closeSubpath({ closed: false, anchors: [pt(0, 0), pt(100, 0), pt(50, 80), pt(0, 0)] }, true)
  check('a path whose ends meet closes into one point', tri.closed && tri.anchors.length === 3)
  check('Separate: each subpath a path of its own', separate({ fillRule: 'evenodd', subpaths: [a, b] }).every((p) => p.subpaths.length === 1 && p.fillRule === 'evenodd'))
}

console.log('\nstroke features: profiles, arrowheads, dashes aligned to corners')
{
  const base: StrokeStyle = { width: 10, join: 'miter', cap: 'butt', miter: 4, dash: [], dashOffset: 0 }
  const line = [{ pts: [0, 0, 100, 0], closed: false }]
  const ptsOf = (loops: number[][]) => loops.flatMap((l) => Array.from({ length: l.length / 2 }, (_, i) => [l[i * 2], l[i * 2 + 1]] as [number, number]))
  const widthAt = (loops: number[][], x: number) => {
    const near = ptsOf(loops).filter((p) => Math.abs(p[0] - x) < 1.2)
    return near.length ? Math.max(...near.map((p) => p[1])) - Math.min(...near.map((p) => p[1])) : 0
  }
  const taper = strokeOutline(line, { ...base, profile: WIDTH_PRESETS.find((p) => p.id === 'taper-both')!.points }, 0.05)
  check('Taper Both: full width in the middle, none at the ends', Math.abs(widthAt(taper, 50) - 10) < 0.3 && widthAt(taper, 0.5) < 0.6 && widthAt(taper, 99.5) < 0.6, `${widthAt(taper, 50).toFixed(2)} ${widthAt(taper, 0.5).toFixed(2)}`)
  check('eased between its points: a quarter of the way along, half the width', Math.abs(widthAt(taper, 25) - 5) < 0.4, widthAt(taper, 25).toFixed(2))
  check('profileAt eases from one point to the next', Math.abs(profileAt([{ at: 0, left: 0, right: 0 }, { at: 1, left: 1, right: 1 }], 0.5, 'left') - 0.5) < 1e-12 && profileAt([{ at: 0.2, left: 0.3, right: 0.3 }], 0.9, 'right') === 0.3)
  const oneSided = strokeOutline(line, { ...base, profile: [{ at: 0, left: 1, right: 0 }, { at: 1, left: 1, right: 0 }] }, 0.05)
  check('a profile with no right side strokes the left only', ptsOf(oneSided).every((p) => p[1] >= -1e-6) && ptsOf(oneSided).some((p) => p[1] > 4.9))
  check('a preset is known by its points, Custom when it isn’t one', presetOf(WIDTH_PRESETS[3].points) === WIDTH_PRESETS[3].id && presetOf([{ at: 0.3, left: 2, right: 1 }]) === null && presetOf(undefined) === 'uniform')

  // Arrowheads.
  const arrow = strokeOutline(line, { ...base, end: { shape: 'triangle', scale: 1 } }, 0.05)
  const head = arrow.find((l) => l.length === 6)
  check('a triangle head at the end: its tip on the path’s end, four widths long', !!head && Math.abs(head[0] - 100) < 1e-9 && Math.abs(head[1]) < 1e-9 && Math.abs(head[2] - 60) < 1e-9 && Math.abs(Math.abs(head[3]) - 20) < 1e-9, JSON.stringify(head))
  const body = arrow.find((l) => l !== head)!
  check('the line stops short under it', Math.max(...ptsOf([body]).map((p) => p[0])) < 100 - 20)
  check('none on a closed path', strokeOutline([{ pts: [0, 0, 100, 0, 100, 100], closed: true }], { ...base, start: { shape: 'triangle', scale: 1 }, end: { shape: 'circle', scale: 1 } }, 0.05).length === 2)
  check('every shape makes a head', ARROW_SHAPES.every(([shape]) => strokeOutline(line, { ...base, start: { shape, scale: 1.5 } }, 0.05).length >= 2))
  check('a head reaches further than the stroke, and strokeReach says so', strokeReach({ ...base, end: { shape: 'triangle', scale: 1 } }) > strokeReach(base))
  check('so does a profile wider than the stroke', strokeReach({ ...base, join: 'round', profile: [{ at: 0, left: 2, right: 2 }] }) === 10)

  // Corners.
  const square = flattenPath({ fillRule: 'nonzero', subpaths: [{ closed: true, anchors: [anchor(0, 0), anchor(100, 0), anchor(100, 100), anchor(0, 100)] }] }, 0.1)[0]
  check('flattening marks a square’s four corners', JSON.stringify(square.corners) === '[0,1,2,3]', JSON.stringify(square.corners))
  const k = 0.5523
  const circle = flattenPath({ fillRule: 'nonzero', subpaths: [{ closed: true, anchors: [anchor(0, -50, [-50 * k, -50], [50 * k, -50], true), anchor(50, 0, [50, -50 * k], [50, 50 * k], true), anchor(0, 50, [50 * k, 50], [-50 * k, 50], true), anchor(-50, 0, [-50, 50 * k], [-50, -50 * k], true)] }] }, 0.1)[0]
  check('and a circle’s none', !circle.corners?.length)
  const dashed = strokeOutline([square], { ...base, width: 2, dash: [12, 8], dashAlign: true }, 0.05)
  const covered = (x: number, y: number) => ptsOf(dashed).some((p) => Math.abs(p[0] - x) < 1.5 && Math.abs(p[1] - y) < 1.5)
  check('aligned dashes: a dash at every corner of a square', covered(0, 0) && covered(100, 0) && covered(100, 100) && covered(0, 100))
  // Each side is 100: five repeats of 20 fit exactly, so each side has four whole dashes and two halves at its corners.
  check('a whole number of repeats on each side, a half dash either side of each corner', dashed.length === 4 * 6, String(dashed.length))
}

// --- width points (the Width tool) -----------------------------------------------------------------
{
  console.log('\nwidth points')
  const ptsOf = (loops: number[][]) => loops.flatMap((l) => Array.from({ length: l.length / 2 }, (_, i) => [l[i * 2], l[i * 2 + 1]] as [number, number]))
  const added = addWidthPoint(undefined, 0.3)
  check('a point added to a uniform stroke brings full-width ends with it', added.profile.length === 3 && added.index === 1 && added.profile.every((p) => p.left === 1 && p.right === 1), JSON.stringify(added.profile))
  const taper = WIDTH_PRESETS.find((p) => p.id === 'taper-start')!.points
  const mid = addWidthPoint(taper, 0.5)
  check('added where the stroke already is: as wide as it is there', Math.abs(mid.profile[mid.index].left - profileAt(taper, 0.5, 'left')) < 1e-9 && mid.profile.length === 3)
  check('on a point already: that one, nothing added', addWidthPoint(taper, 1).profile.length === 2 && addWidthPoint(taper, 1).index === 1)
  const set = setWidthPoint(added.profile, 1, 2, 0.5, false)
  check('setting a point’s sides', set[1].left === 2 && set[1].right === 0.5 && set[0].left === 1)
  check('a side can’t go below nothing or past the limit', setWidthPoint(added.profile, 1, -3, 999, false)[1].left === 0 && setWidthPoint(added.profile, 1, -3, 999, false)[1].right === MAX_SHARE)
  const ring = [{ at: 0, left: 1, right: 1 }, { at: 0.5, left: 2, right: 2 }, { at: 1, left: 1, right: 1 }]
  const seam = setWidthPoint(ring, 0, 3, 3, true)
  check('on a closed path, the start’s point is the end’s too', seam[0].left === 3 && seam[2].left === 3 && seam[1].left === 2)
  check('and only one of them shows', JSON.stringify(shownPoints(ring, true)) === '[0,1]' && JSON.stringify(shownPoints(ring, false)) === '[0,1,2]')
  check('a point slides between its neighbours, never past them', moveWidthPoint(ring, 1, 0.8)[1].at === 0.8 && moveWidthPoint(ring, 1, 2)[1].at < 1 && moveWidthPoint(ring, 1, -1)[1].at > 0)
  check('the ends stay where they are', moveWidthPoint(ring, 0, 0.4)[0].at === 0 && slideRange(ring, 2) === null)
  check('deleting a point', deleteWidthPoints(ring, [1]) === undefined && deleteWidthPoints(set, [0])?.length === 2)
  check('a profile left all full width is uniform: none', tidyProfile([{ at: 0, left: 1, right: 1 }, { at: 1, left: 1, right: 1 }]) === undefined && tidyProfile(taper)?.length === 2)
  const lop = [{ at: 0, left: 0, right: 2 }, { at: 0.25, left: 1, right: 1 }, { at: 1, left: 1, right: 1 }]
  const along = flipAlong(lop)!
  check('Flip Along: end to end', along[0].at === 0 && along[2].at === 1 && along[2].right === 2 && Math.abs(along[1].at - 0.75) < 1e-12)
  const across = flipAcross(lop)!
  check('Flip Across: side to side', across[0].left === 2 && across[0].right === 0)
  check('flipping twice is where it started', sameProfile(flipAlong(flipAlong(lop)), lop) && sameProfile(flipAcross(flipAcross(lop)), lop))

  // Measuring along a path: a 100-long line and a 400-long square.
  const lineP: PathData = { fillRule: 'nonzero', subpaths: [{ closed: false, anchors: [anchor(0, 0), anchor(100, 0)] }] }
  const ms = measurePath(lineP, 0.1)
  check('a line measured', Math.abs(ms[0].total - 100) < 1e-9)
  const near = nearestPlace(ms, 30, 7)!
  check('the nearest place to a point beside it', Math.abs(near.t - 0.3) < 1e-9 && Math.abs(near.dist - 7) < 1e-9 && near.dir[0] === 1)
  check('which side of the path it is on, by the stroke’s left (towards (−dy, dx))', sideOf(near, 30, 7) === 1 && sideOf(near, 30, -7) === -1)
  const at = placeAt(ms, 0, 0.75)!
  check('the place a share of the way along', Math.abs(at.p[0] - 75) < 1e-9 && at.p[1] === 0)
  const sq: PathData = { fillRule: 'nonzero', subpaths: [{ closed: true, anchors: [anchor(0, 0), anchor(100, 0), anchor(100, 100), anchor(0, 100)] }] }
  const msq = measurePath(sq, 0.1)
  check('a closed path measured with its closing side', Math.abs(msq[0].total - 400) < 1e-9)
  const back = placeAt(msq, 0, 0.875)!
  check('a place on the closing side', Math.abs(back.p[0] - 0) < 1e-9 && Math.abs(back.p[1] - 50) < 1e-9 && back.dir[1] === -1)
  check('the nearest place on the closing side too', Math.abs(nearestPlace(msq, -5, 50)!.t - 0.875) < 1e-9)
  // The stroke's own sense of where a share of the way is: a point there in the profile widens the outline there.
  const bump = strokeOutline(flattenPath(lineP, 0.1), { width: 4, join: 'miter', cap: 'butt', miter: 4, dash: [], dashOffset: 0, profile: [{ at: 0, left: 1, right: 1 }, { at: 0.3, left: 3, right: 1 }, { at: 1, left: 1, right: 1 }] }, 0.05)
  const ys = ptsOf(bump).filter((p) => Math.abs(p[0] - 30) < 1.1).map((p) => p[1])
  check('the outline is widest on the left where the tool puts the point', Math.max(...ys) > 5.5 && Math.min(...ys) > -2.5, JSON.stringify(ys))
}

// --- vector brushes -----------------------------------------------------------------------------
{
  console.log('\nvector brushes')
  const lib = builtinBrushes('rgb')
  const B = (id: string) => lib.find((b) => b.id === `builtin:${id}`)!
  const red = solid([1, 0, 0])
  const lineOf = (x0: number, x1: number): Polyline[] => [{ pts: [x0, 0, x1, 0], closed: false }]
  const boxOfPieces = (ps: { loops: number[][] }[]) => {
    let b = [Infinity, Infinity, -Infinity, -Infinity]
    for (const p of ps) for (const l of p.loops) for (let i = 0; i < l.length; i += 2) b = [Math.min(b[0], l[i]), Math.min(b[1], l[i + 1]), Math.max(b[2], l[i]), Math.max(b[3], l[i + 1])]
    return b
  }
  const near = (a: number, b: number, t = 0.05) => Math.abs(a - b) <= t
  const lp = (ps: { loops: number[][] }[]) => ps.reduce((n, p) => n + p.loops.length, 0)

  // Art: the lens is 100 long and 18 high (its curves reach 9 either side).
  const ink = brushPieces(lineOf(0, 200), { width: 10, paint: red }, B('taper'), 'rgb', 0.05)
  let bx = boxOfPieces(ink)
  check('an art brush stretches its art along the whole path', ink.length === 1 && near(bx[0], 0, 0.1) && near(bx[2], 200, 0.1), JSON.stringify(bx))
  check('its height on the path is the stroke’s width', near(bx[3] - bx[1], 10, 0.15), String(bx[3] - bx[1]))
  check('Tints of black art in a red stroke: red', ink[0].paint.kind === 'solid' && JSON.stringify(ink[0].paint.colour) === '[1,0,0]')
  bx = boxOfPieces(brushPieces(lineOf(0, 50), { width: 10, paint: red }, B('taper'), 'rgb', 0.05))
  check('on a shorter path, squeezed to its length', near(bx[2], 50, 0.1) && near(bx[3] - bx[1], 10, 0.15))
  const prop = brushPieces(lineOf(0, 200), { width: 10, paint: red }, { ...(B('taper') as ArtBrush), fit: 'proportional' }, 'rgb', 0.05)
  bx = boxOfPieces(prop)
  check('scaled in proportion: twice the art’s length, twice its height', near(bx[3] - bx[1], 36, 0.3), String(bx[3] - bx[1]))
  // The arrow: its head is the last 22 of 100, 20 high; with guides it keeps its shape at any length.
  const arrow = brushPieces(lineOf(0, 300), { width: 20, paint: red }, B('arrow'), 'rgb', 0.05)
  const head = arrow[1].loops[0]
  const xs = Array.from({ length: head.length / 2 }, (_, i) => head[2 * i])
  check('stretched between guides: the head keeps its length at the end', near(Math.max(...xs), 300, 0.2) && near(Math.min(...xs), 278, 0.3), `${Math.min(...xs)} ${Math.max(...xs)}`)
  const flipped = brushPieces(lineOf(0, 300), { width: 20, paint: red }, { ...(B('arrow') as ArtBrush), flipAlong: true }, 'rgb', 0.05)
  const fxs = flipped[1].loops[0].filter((_, i) => i % 2 === 0)
  check('Flip Along puts the head at the start', near(Math.min(...fxs), 0, 0.2) && near(Math.max(...fxs), 22, 0.3), `${Math.min(...fxs)} ${Math.max(...fxs)}`)
  // A profile narrows it: Taper Start is nothing at the start.
  const tap = brushPieces(lineOf(0, 200), { width: 20, paint: red, profile: [{ at: 0, left: 0, right: 0 }, { at: 1, left: 1, right: 1 }] }, B('ribbon'), 'rgb', 0.05)
  const nearStart = tap.flatMap((p) => p.loops.flatMap((l) => Array.from({ length: l.length / 2 }, (_, i) => [l[2 * i], l[2 * i + 1]]))).filter(([x]) => x < 1)
  check('a width profile shapes the art too', nearStart.every(([, y]) => Math.abs(y) < 0.2))
  // Along a curve: the art bends; a quarter circle of radius 100.
  const arc: Polyline[] = [{ pts: Array.from({ length: 65 }, (_, i) => [Math.cos((i / 64) * (Math.PI / 2)) * 100, Math.sin((i / 64) * (Math.PI / 2)) * 100]).flat(), closed: false }]
  const bent = brushPieces(arc, { width: 10, paint: red }, B('ribbon'), 'rgb', 0.05)
  const radii = bent.flatMap((p) => p.loops.flatMap((l) => Array.from({ length: l.length / 2 }, (_, i) => Math.hypot(l[2 * i], l[2 * i + 1]))))
  check('along a curve the art bends with it, as wide all the way', Math.min(...radii) > 94.9 && Math.max(...radii) < 105.1, `${Math.min(...radii)} ${Math.max(...radii)}`)
  // Hue shift: the ribbon's key colour (its first, red) becomes the stroke's; blue turns the rest with it.
  const blue = brushPieces(lineOf(0, 100), { width: 10, paint: solid([0, 0, 1]) }, B('ribbon'), 'rgb', 0.05)
  const c0 = (blue[0].paint as { colour: number[] }).colour
  check('Hue Shift: the key colour turns to the stroke’s hue', c0[2] > c0[0] && c0[2] > c0[1], JSON.stringify(c0))
  check('Tints: white art stays white, mid grey half way', JSON.stringify(colorizeColour([1, 1, 1], 'tints', [1, 0, 0], [0, 0, 0], 'rgb')) === '[1,1,1]' && near(colorizeColour([0.5, 0.5, 0.5], 'tints', [1, 0, 0], [0, 0, 0], 'rgb')[1], 0.5, 0.01))
  check('Tints and Shades: black art makes black, mid grey the stroke’s colour', colorizeColour([0, 0, 0], 'tints-shades', [1, 0, 0], [0, 0, 0], 'rgb').every((v) => v < 1e-9) && JSON.stringify(colorizeColour([0.5, 0.5, 0.5], 'tints-shades', [1, 0, 0], [0, 0, 0], 'rgb').map((v) => Math.round(v * 100) / 100)) === '[1,0,0]')
  check('in CMYK, tints thin the ink', near(colorizeColour([0, 0, 0, 0], 'tints', [0, 1, 1, 0], [0, 0, 0, 1], 'cmyk').reduce((a, b) => a + b, 0), 0, 1e-9))

  // Scatter: copies along the path, the same every time.
  const dots = brushPieces(lineOf(0, 400), { width: 10, paint: red }, B('dots'), 'rgb', 0.05)
  const again = brushPieces(lineOf(0, 400), { width: 10, paint: red }, B('dots'), 'rgb', 0.05)
  check('a scatter brush puts copies along the path', lp(dots) >= 15 && lp(dots) <= 40, String(lp(dots)))
  check('varied the same way every time', JSON.stringify(dots) === JSON.stringify(again))
  bx = boxOfPieces(dots)
  check('scattered off the path no further than it says, nor past the reach', Math.max(Math.abs(bx[1]), Math.abs(bx[3])) <= brushReach(B('dots'), 10, undefined) && bx[3] - bx[1] > 8, JSON.stringify(bx))
  const tight = brushPieces(lineOf(0, 400), { width: 10, paint: red }, { ...(B('dots') as ScatterBrush), spacing: [1, 1], size: [1, 1], scatter: [0, 0] }, 'rgb', 0.05)
  check('spacing 1 at size 1: copies touching, one per copy length', lp(tight) === 41 || lp(tight) === 40, String(lp(tight)))

  // Pattern: beads are 12 long, 8 high; at width 8 a 120-long line takes ten.
  const beads = brushPieces(lineOf(0, 120), { width: 8, paint: red }, B('beads'), 'rgb', 0.05)
  check('a pattern brush repeats its tile a whole number of times', beads.length === 2 && beads[1].loops.length === 10, String(beads[1]?.loops.length))
  const beads2 = brushPieces(lineOf(0, 125), { width: 8, paint: red }, B('beads'), 'rgb', 0.05)
  check('stretched to fit a length that isn’t a whole number of tiles', beads2[1].loops.length === 10 && near(boxOfPieces(beads2)[2], 125, 0.1))
  const spaced = brushPieces(lineOf(0, 125), { width: 8, paint: red }, { ...(B('beads') as PatternBrush), fit: 'space' }, 'rgb', 0.05)
  const sb = boxOfPieces([spaced[1]])
  check('or kept their length, space added', spaced[1].loops.length === 10 && near(sb[3] - sb[1], 8, 0.1) && sb[0] > 0.2)
  const square = flattenPath({ fillRule: 'nonzero', subpaths: [{ closed: true, anchors: [anchor(0, 0), anchor(200, 0), anchor(200, 200), anchor(0, 200)] }] }, 0.1)
  const rail = brushPieces(square, { width: 20, paint: red }, B('railroad'), 'rgb', 0.05)
  const cornerPiece = rail.find((p) => p.loops.length === 4 && p.loops.every((l) => l.length === 8))
  check('corner tiles stand at a square’s four corners', !!cornerPiece && cornerPiece.loops.every((l) => [[0, 0], [200, 0], [200, 200], [0, 200]].some(([x, y]) => near((l[0] + l[4]) / 2, x, 0.5) && near((l[1] + l[5]) / 2, y, 0.5))))
  const arrowStart = brushPieces(lineOf(0, 200), { width: 8, paint: red }, { ...(B('beads') as PatternBrush), start: B('taper').kind === 'art' ? (B('taper') as ArtBrush).art : undefined }, 'rgb', 0.05)
  check('a start tile at an open path’s start', arrowStart.length === 3)

  // Every built-in stays within its reach, and reads back from a file whole.
  const curve = flattenPath({ fillRule: 'nonzero', subpaths: [{ closed: false, anchors: [anchor(0, 0, null, [80, -120]), anchor(300, 0, [220, 120], null)] }] }, 0.1)
  const box = [0, -90, 300, 90]
  const within = lib.every((b) => {
    const r = brushReach(b, 12, undefined, 400)
    const pb = boxOfPieces(brushPieces(curve, { width: 12, paint: red }, b, 'rgb', 0.05))
    return pb[0] >= box[0] - r && pb[2] <= box[2] + r && pb[1] >= box[1] - r && pb[3] <= box[3] + r
  })
  check('every built-in brush draws within its reach', within)
  const readers = { path: (v: unknown) => (readGeometry({ kind: 'path', path: v }, () => {}) as { path: PathData }).path, paint: readPaint }
  check('every built-in brush reads back from a file as it was', lib.every((b) => deepEqual(readBrush(JSON.parse(JSON.stringify(b)), readers as never), b)))
  check('a brush without artwork can’t be read', readBrush({ kind: 'art', id: 'x', art: { parts: [], box: [0, 0, 1, 1] } }, readers as never) === null)
  const stroke = { ...strokeItem(red, 6), brush: B('stars') }
  const back = readAppearance(JSON.parse(JSON.stringify([stroke])), () => {})
  check('a stroke keeps its brush through a file', (back[0] as { brush?: { id: string } }).brush?.id === 'builtin:stars')
  check('in another mode, the brush’s colours go with it', (appearanceIn([{ ...stroke, brush: B('confetti') }], 'gray')[0] as { brush: ScatterBrush }).brush.art.parts[0].paint.kind === 'solid' && ((appearanceIn([{ ...stroke, brush: B('confetti') }], 'gray')[0] as { brush: ScatterBrush }).brush.art.parts[0].paint as { colour: number[] }).colour.length === 1)
  check('its reach is the brush’s, not a plain stroke’s', appearanceReach([stroke]) > 6)
}

// --- Image Trace ---------------------------------------------------------------------------------
{
  console.log('\nImage Trace')
  const W = 64
  const H = 48
  /** An image W × H from a function of the pixel. */
  const img = (f: (x: number, y: number) => [number, number, number, number]) => {
    const out = new Uint8Array(W * H * 4)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out.set(f(x, y), (y * W + x) * 4)
    return out
  }
  const areaOf = (p: PathData) => flattenPath(p, 0.05).reduce((a, l) => a + polyArea(l.pts), 0)
  const opts = { ...TRACE_PRESETS[0].options, noise: 4 }
  // A black square on white.
  const sq = img((x, y) => (x >= 10 && x < 30 && y >= 8 && y < 28 ? [0, 0, 0, 255] : [255, 255, 255, 255]))
  const t1 = traceImage(sq, W, H, opts)
  const black = t1.layers.find((l) => l.colour[0] === 0)!
  const white = t1.layers.find((l) => l.colour[0] === 255)!
  check('black and white: two shapes, one per colour', t1.layers.length === 2 && !!black && !!white)
  const bb = pathBounds(black.path)!
  check('the square traced where it is, its corners square', Math.abs(bb[0] - 10) < 0.01 && Math.abs(bb[1] - 8) < 0.01 && Math.abs(bb[2] - 30) < 0.01 && Math.abs(bb[3] - 28) < 0.01 && black.path.subpaths[0].anchors.length === 4, `${bb} ${black.path.subpaths[0].anchors.length}`)
  check('its area exact', Math.abs(Math.abs(areaOf(black.path)) - 400) < 0.5, String(areaOf(black.path)))
  check('white round it, with the square as a hole', white.path.subpaths.length === 2)
  const whiteArea = flattenPath(white.path, 0.05).map((l) => polyArea(l.pts))
  check('the white’s outline less its hole is the rest of the image', Math.abs(Math.abs(whiteArea[0]) - Math.abs(whiteArea[1]) - (W * H - 400)) < 0.5 || Math.abs(Math.abs(whiteArea[1]) - Math.abs(whiteArea[0]) - (W * H - 400)) < 0.5, whiteArea.join())
  // A circle: smooth, few anchors, the right area.
  const cx = 32
  const cy = 24
  const R = 15
  const disc = img((x, y) => ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 < R * R ? [0, 0, 0, 255] : [255, 255, 255, 255]))
  const t2 = traceImage(disc, W, H, opts)
  const dp = t2.layers.find((l) => l.colour[0] === 0)!.path
  check('a circle comes out smooth, a handful of curves', dp.subpaths[0].anchors.length <= 12 && dp.subpaths[0].anchors.some((a) => a.in && a.out), String(dp.subpaths[0].anchors.length))
  check('and its area within a few percent of the circle’s', Math.abs(Math.abs(areaOf(dp)) - Math.PI * R * R) / (Math.PI * R * R) < 0.03, String(areaOf(dp)))
  // Where the black and white meet, the same curve on both: no gap between them.
  const ring = t2.layers.find((l) => l.colour[0] === 255)!.path
  const holeA = ring.subpaths.find((s) => s.anchors.every((a) => Math.hypot(a.p[0] - cx, a.p[1] - cy) < R + 2))!
  const outer = dp.subpaths[0]
  const sameCurve = holeA && holeA.anchors.length === outer.anchors.length && holeA.anchors.every((a) => outer.anchors.some((b) => Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]) < 1e-9))
  check('the circle and the hole in the white are one curve, abutting', !!sameCurve)
  // Specks: noise.
  const specks = img((x, y) => ((x * 7 + y * 13) % 97 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]))
  check('specks smaller than the noise size are dropped', traceImage(specks, W, H, { ...opts, noise: 4 }).layers.length === 1 && traceImage(specks, W, H, { ...opts, noise: 1 }).layers.length === 2)
  // Transparency: left out.
  const halfClear = img((x) => (x < 32 ? [0, 0, 0, 255] : [0, 0, 0, 0]))
  const t3 = traceImage(halfClear, W, H, opts)
  check('pixels that are see-through are left out', t3.layers.length === 1 && Math.abs(Math.abs(areaOf(t3.layers[0].path)) - 32 * H) < 0.5)
  check('Ignore White leaves out the white', traceImage(sq, W, H, { ...opts, ignoreWhite: true }).layers.length === 1)
  // Colours: three bands of colour, three shapes.
  const bands = img((x) => (x < 20 ? [220, 30, 40, 255] : x < 44 ? [30, 160, 60, 255] : [40, 60, 200, 255]))
  const t4 = traceImage(bands, W, H, { ...opts, mode: 'colour', colours: 3 })
  check('colour: three bands, three shapes in their colours', t4.layers.length === 3 && t4.layers.some((l) => l.colour[0] > 200 && l.colour[1] < 50), JSON.stringify(t4.layers.map((l) => l.colour)))
  const total = t4.layers.reduce((a, l) => a + Math.abs(areaOf(l.path)), 0)
  check('abutting: their areas add up to the image’s', Math.abs(total - W * H) < 1, String(total))
  check('stats count the regions, anchors and colours', t4.stats.paths === 3 && t4.stats.colours === 3 && t4.stats.anchors >= 12)
  // Gray levels.
  const ramp = img((x) => [x * 4, x * 4, x * 4, 255])
  check('shades of gray: as many as asked, at most', traceImage(ramp, W, H, { ...opts, mode: 'gray', colours: 4 }).layers.length === 4)
  const small = shrinkForTrace(sq, W, H, 32)
  check('a large image made smaller for tracing, by whole pixels', small.w === 32 && small.h === 24 && small.scale === 2)
}

// --- freehand paths --------------------------------------------------------------------------------
{
  console.log('\nfreehand paths')
  // A wobbly hand along a gentle arc.
  const hand: Pt[] = Array.from({ length: 120 }, (_, i) => [i * 2, 40 * Math.sin(i / 38) + (i % 2 ? 0.6 : -0.6)])
  const fit = fitFreehand(hand, 2, false)
  check('a freehand stroke becomes a few curves', fit.anchors.length >= 2 && fit.anchors.length <= 8 && !fit.closed, String(fit.anchors.length))
  const far = Math.max(...hand.map((p) => nearestOnSubpath(fit, p[0], p[1])!.dist))
  check('within the fidelity of every point the hand made', far <= 2.5, far.toFixed(2))
  const smoother = fitFreehand(hand, 8, false)
  check('a larger fidelity, fewer anchors', smoother.anchors.length <= fit.anchors.length)
  // A loop: closed.
  const loop: Pt[] = Array.from({ length: 80 }, (_, i) => [50 + 30 * Math.cos((i / 80) * Math.PI * 2), 50 + 30 * Math.sin((i / 80) * Math.PI * 2)])
  check('a closed stroke makes a closed path', fitFreehand(loop, 1, true).closed)
  // The nearest place on a line from (0, 0) to (100, 0).
  const line: Subpath = { closed: false, anchors: [anchor(0, 0), anchor(100, 0)] }
  const nl = nearestOnSubpath(line, 30, 5)!
  check('the nearest place on a path', nl.seg === 0 && Math.abs(nl.p[0] - 30) < 1e-6 && Math.abs(nl.dist - 5) < 1e-6)
  // Redrawing: a bump drawn from x = 30 to x = 70 over a straight path from 0 to 100.
  const bump = fitFreehand(Array.from({ length: 41 }, (_, i) => [30 + i, -20 * Math.sin((i / 40) * Math.PI)] as Pt), 0.5, false).anchors
  const re = spliceSubpath(line, nearestOnSubpath(line, 30, 0)!, nearestOnSubpath(line, 70, 0)!, bump)
  const xs = re.anchors.map((a) => a.p[0])
  check('redrawn between two places: kept before and after, the stroke between', re.anchors[0].p[0] === 0 && re.anchors[re.anchors.length - 1].p[0] === 100 && xs.some((x) => x > 30 && x < 70), JSON.stringify(xs))
  const peak = nearestOnSubpath(re, 50, -20)!
  check('the new part is where it was drawn', peak.dist < 1, String(peak.dist))
  const back = spliceSubpath(line, nearestOnSubpath(line, 70, 0)!, nearestOnSubpath(line, 30, 0)!, [...bump].reverse().map((a) => ({ ...a, in: a.out, out: a.in })))
  check('drawn the other way along the path, the same', back.anchors[0].p[0] === 0 && back.anchors[back.anchors.length - 1].p[0] === 100 && nearestOnSubpath(back, 50, -20)!.dist < 1)
  // Carried on from an end.
  const on = extendSubpath(line, true, [anchor(100, 0), anchor(150, 30)])
  check('carried on from its end', on.anchors.length === 3 && on.anchors[2].p[0] === 150)
  const onStart = extendSubpath(line, false, [anchor(0, 0), anchor(-40, 10)])
  check('or from its start', onStart.anchors.length === 3 && onStart.anchors[0].p[0] === -40 && onStart.anchors[2].p[0] === 100)
  // A closed square redrawn along one side: still closed, the other three sides kept.
  const sq: Subpath = { closed: true, anchors: [anchor(0, 0), anchor(100, 0), anchor(100, 100), anchor(0, 100)] }
  const dent = fitFreehand(Array.from({ length: 41 }, (_, i) => [30 + i, 15 * Math.sin((i / 40) * Math.PI)] as Pt), 0.5, false).anchors
  const sqRe = spliceSubpath(sq, nearestOnSubpath(sq, 30, 0)!, nearestOnSubpath(sq, 70, 0)!, dent)
  check('a closed path redrawn stays closed, its other sides kept', sqRe.closed && [[100, 100], [0, 100], [0, 0], [100, 0]].every(([x, y]) => sqRe.anchors.some((a) => Math.hypot(a.p[0] - x, a.p[1] - y) < 1e-6)) && nearestOnSubpath(sqRe, 50, 15)!.dist < 1, JSON.stringify(sqRe.anchors.map((a) => a.p)))
}

// --- gradient meshes and freeform gradients (vector/mesh.ts) ------------------------------------
console.log('\ngradient meshes and freeform gradients')
{
  // A skewed patch: a point placed by the bilinear map comes back to where it was.
  const a: Pt = [10, 10]
  const b: Pt = [110, 30]
  const c: Pt = [130, 140]
  const d: Pt = [0, 120]
  let worst = 0
  for (const [u, v] of [[0.1, 0.2], [0.5, 0.5], [0.9, 0.3], [0.25, 0.95], [0, 0], [1, 1]]) {
    const x = a[0] * (1 - u) * (1 - v) + b[0] * u * (1 - v) + c[0] * u * v + d[0] * (1 - u) * v
    const y = a[1] * (1 - u) * (1 - v) + b[1] * u * (1 - v) + c[1] * u * v + d[1] * (1 - u) * v
    const r = invBilinear(x, y, a, b, c, d)
    worst = Math.max(worst, Math.abs(r.u - u), Math.abs(r.v - v), r.out)
  }
  check('a patch’s bilinear map inverts: each point back to its u, v', worst < 1e-9, worst.toExponential(1))
  const par = invBilinear(60, 40, [0, 0], [100, 0], [120, 80], [20, 80])
  check('a parallelogram (no quadratic term) too', Math.abs(par.u - 0.5) < 1e-9 && Math.abs(par.v - 0.5) < 1e-9, JSON.stringify(par))
  check('a point outside says how far', invBilinear(200, 40, a, b, c, d).out > 0)
  const m = newMesh([0, 0, 300, 200], 3, 2, (u, v) => ({ colour: [u, v, 0], alpha: 1 }))
  const at = meshLocate(m, 150, 50)
  check('a mesh finds the patch a point is in', at.i === 1 && at.j === 0 && Math.abs(at.u - 0.5) < 1e-9 && Math.abs(at.v - 0.5) < 1e-9, JSON.stringify(at))
  // The spline through the points' colours: exact at each point, and a linear ramp stays linear.
  const col = (gu: number, gv: number) => gridSpline(m.cols, m.rows, (i, j) => m.nodes[j * (m.cols + 1) + i].colour, gu, gv, 3)
  check('the colour is the point’s at each point', Math.abs(col(2, 1)[0] - 2 / 3) < 1e-12 && Math.abs(col(2, 1)[1] - 0.5) < 1e-12)
  check('a ramp across the grid runs on linearly through the patches', Math.abs(col(1.5, 0.5)[0] - 0.5) < 1e-9 && Math.abs(col(0.75, 0)[0] - 0.25) < 0.02, JSON.stringify(col(0.75, 0)))
  // A row and a column added through a point: the old points kept, the new ones on the old patches' edges.
  const split = splitMesh(m, 1.5, 0.25, true, true)
  check('a split adds a column and a row', split.cols === 4 && split.rows === 3 && split.nodes.length === 20)
  const kept = [0, 1, 2, 3].every((i) => deepEqual(m.nodes[i], split.nodes[[0, 1, 3, 4][i]]))
  check('the old points stay as they were', kept)
  const mid = meshPointAt(m, 1.5, 0.25)
  check('the new crossing is where it was asked for', split.nodes.some((n) => Math.hypot(n.p[0] - mid[0], n.p[1] - mid[1]) < 1e-9), JSON.stringify(mid))
  check('split only one way on a line', splitMesh(m, 1.5, 1, true, false).cols === 4 && splitMesh(m, 1.5, 1, true, false).rows === 2)
  const bigger = resizeMesh(m, 6, 4)
  check('made again finer, the mesh keeps its corners and its colours there', bigger.nodes.length === 35 && deepEqual(bigger.nodes[0].p, [0, 0]) && Math.abs(bigger.nodes[34].colour[0] - 1) < 1e-9)
  // Freeform: exact at a point, between them a blend; spread reaches further.
  const pts = [
    { p: [0, 0] as Pt, colour: [1, 0, 0], alpha: 1, spread: 1 },
    { p: [100, 0] as Pt, colour: [0, 0, 1], alpha: 1, spread: 1 },
  ]
  const ff = (x: number, q = pts) => freeformAt(q, x, 0, (p) => p.colour).colour
  check('a freeform gradient is each point’s colour at it', ff(0)[0] > 0.999 && ff(100)[2] > 0.999)
  check('half way, half each', Math.abs(ff(50)[0] - 0.5) < 1e-9)
  check('a wider spread reaches further', ff(50, [pts[0], { ...pts[1], spread: 2 }])[2] > 0.8)
  // Files: a mesh whose points don't add up is read as its first colour, flat.
  const bad = readPaint({ kind: 'mesh', cols: 2, rows: 2, nodes: m.nodes.slice(0, 5) })
  check('a mesh that doesn’t add up is read as a colour', bad.kind === 'solid')
  check('a mesh and a freeform gradient read back whole', deepEqual(readPaint(JSON.parse(JSON.stringify(m))), m) && deepEqual(readPaint({ kind: 'freeform', points: pts }), { kind: 'freeform', points: pts }))
  check('a gradient along a stroke reads back', (readPaint({ kind: 'gradient', type: 'linear', stops: [], angle: 0, scale: 100, reverse: false, stroke: 'along' }) as { stroke?: string }).stroke === 'along')
}

console.log(`\n${failures === 0 ? 'all clear' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
