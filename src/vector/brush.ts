/**
 * A stroke drawn with a vector brush (doc/vectorBrush.ts): the brush's
 * artwork laid along each of the path's lines, as filled loops in the
 * art's paints. The stroke's width is the art's height on the path (times
 * the brush's scale) and its profile varies it; what the stroke's dashes,
 * corners, ends and arrowheads would do doesn't apply.
 *
 * The path is a rail: each point of a line knows how far along it is and
 * the direction across it there, smoothed between segments so artwork
 * bends round a flattened curve rather than kinking at every point. Art at
 * (x, y) goes to the place x along the rail, y across it; each loop is
 * carried through that map by `warpLines`, cut until it follows the bend.
 * Scatter copies and corner tiles are only moved, turned and scaled.
 *
 * Pure and DOM-free; check-geom runs it in Node.
 */
import type { ColourMode } from '../doc/types'
import { mainColour, mapPaintColours, type Paint } from '../doc/vector'
import type { ParamColour } from '../doc/params'
import type { ArtBrush, BrushArt, Colorize, PatternBrush, ScatterBrush, VectorBrush } from '../doc/vectorBrush'
import { brushArts } from '../doc/vectorBrush'
import { flattenPath, type FillRule, type Polyline, type Pt } from '../geom/path'
import { profileAt, profileMax, type WidthPoint } from '../geom/stroke'
import { warpLines } from '../geom/warp'

/** One part of the artwork as drawn: its loops (in the path's units), its fill rule and its paint, colorized. */
export interface BrushPiece {
  loops: number[][]
  rule: FillRule
  paint: Paint
}

/** What a brush stroke needs of its stroke: how wide, its profile, its paint (for colorization). */
export interface BrushStroke {
  width: number
  profile?: WidthPoint[]
  paint: Paint
}

// --- the rail ---------------------------------------------------------------------------------

/** A line ready to lay art along: its points, each one's distance, its length, and the direction across it at each point. */
interface Rail {
  pts: number[]
  d: number[]
  total: number
  closed: boolean
  /** Across the line at each point: the segments' normals averaged, lengthened so art keeps its width round a turn (at most twice). */
  nx: number[]
  ny: number[]
  /** Which points are corners (flattenPath's marks), by index. */
  corners: number[]
}

function railOf(line: Polyline): Rail | null {
  const pts: number[] = []
  const corners: number[] = []
  const marks = new Set(line.corners ?? [])
  for (let i = 0; i < line.pts.length; i += 2) {
    const n = pts.length
    if (n && Math.abs(pts[n - 2] - line.pts[i]) < 1e-9 && Math.abs(pts[n - 1] - line.pts[i + 1]) < 1e-9) {
      if (marks.has(i / 2)) corners.push(n / 2 - 1)
      continue
    }
    if (marks.has(i / 2)) corners.push(n / 2)
    pts.push(line.pts[i], line.pts[i + 1])
  }
  if (line.closed && pts.length >= 4 && Math.abs(pts[0] - pts[pts.length - 2]) < 1e-9 && Math.abs(pts[1] - pts[pts.length - 1]) < 1e-9) pts.length -= 2
  const n = pts.length / 2
  if (n < 2) return null
  const closed = line.closed && n >= 3
  const d = [0]
  for (let i = 1; i < n; i++) d.push(d[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]))
  const total = d[n - 1] + (closed ? Math.hypot(pts[0] - pts[2 * n - 2], pts[1] - pts[2 * n - 1]) : 0)
  if (!(total > 1e-9)) return null
  const segN = (i: number): Pt => {
    const j = (i + 1) % n
    const dx = pts[2 * j] - pts[2 * i]
    const dy = pts[2 * j + 1] - pts[2 * i + 1]
    const l = Math.hypot(dx, dy) || 1
    return [-dy / l, dx / l]
  }
  const nx: number[] = []
  const ny: number[] = []
  for (let i = 0; i < n; i++) {
    const before = i > 0 ? segN(i - 1) : closed ? segN(n - 1) : null
    const after = i < n - 1 || closed ? segN(i) : null
    const a = before ?? after!
    const b = after ?? before!
    let mx = a[0] + b[0]
    let my = a[1] + b[1]
    const ml = Math.hypot(mx, my)
    if (ml < 1e-9) {
      // Doubling straight back: across the way it arrived.
      nx.push(a[0])
      ny.push(a[1])
      continue
    }
    mx /= ml
    my /= ml
    // Lengthened by 1 / cos of half the turn, so the art's edges stay parallel to both sides, up to twice.
    const k = Math.min(2, 1 / Math.max(1e-6, mx * b[0] + my * b[1]))
    nx.push(mx * k)
    ny.push(my * k)
  }
  // An open line's ends aren't corners.
  return { pts, d, total, closed, nx, ny, corners: corners.filter((c) => closed || (c > 0 && c < n - 1)) }
}

/** The segment of a rail distance `s` falls on, and how far through it (beyond the ends of an open rail: past them, straight on). */
function segAt(r: Rail, s: number): { i: number; j: number; t: number; len: number } {
  const n = r.pts.length / 2
  if (r.closed) s = ((s % r.total) + r.total) % r.total
  if (r.closed && s >= r.d[n - 1]) {
    const len = r.total - r.d[n - 1]
    return { i: n - 1, j: 0, t: len > 0 ? (s - r.d[n - 1]) / len : 0, len }
  }
  // Binary search for the last point at or before s.
  let lo = 0
  let hi = n - 2
  if (s <= 0) hi = 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (r.d[mid] <= s) lo = mid
    else hi = mid - 1
  }
  const i = Math.min(lo, n - 2)
  const len = r.d[i + 1] - r.d[i]
  return { i, j: i + 1, t: len > 0 ? (s - r.d[i]) / len : 0, len }
}

/** The point `v` across the rail at distance `s` along it. */
function railAt(r: Rail, s: number, v: number): Pt {
  const { i, j, t } = segAt(r, s)
  const x = r.pts[2 * i] + (r.pts[2 * j] - r.pts[2 * i]) * t
  const y = r.pts[2 * i + 1] + (r.pts[2 * j + 1] - r.pts[2 * i + 1]) * t
  // Off the ends the normal stays the end's.
  const u = Math.min(1, Math.max(0, t))
  const nx = r.nx[i] + (r.nx[j] - r.nx[i]) * u
  const ny = r.ny[i] + (r.ny[j] - r.ny[i]) * u
  return [x + nx * v, y + ny * v]
}

/** The direction along the rail at distance `s`: its segment's. */
function railDir(r: Rail, s: number): Pt {
  const { i, j } = segAt(r, s)
  const dx = r.pts[2 * j] - r.pts[2 * i]
  const dy = r.pts[2 * j + 1] - r.pts[2 * i + 1]
  const l = Math.hypot(dx, dy) || 1
  return [dx / l, dy / l]
}

// --- artwork ----------------------------------------------------------------------------------

/** An artwork's parts flattened in its own units: each part's loops. */
function flatArt(art: BrushArt, tol: number): { loops: number[][]; rule: FillRule }[] {
  return art.parts.map((p) => ({ loops: flattenPath(p.path, tol).filter((l) => l.pts.length >= 6).map((l) => l.pts), rule: p.path.fillRule }))
}

const artH = (a: BrushArt) => a.box[3] - a.box[1]
const artL = (a: BrushArt) => a.box[2] - a.box[0]
const artCy = (a: BrushArt) => (a.box[1] + a.box[3]) / 2

/** The profile's share at distance `s` of a rail, on the side `v` is (the stroke's sense of left: towards (−dy, dx)). */
const shareAt = (profile: WidthPoint[] | undefined, r: Rail, s: number, v: number) => (profile?.length ? profileAt(profile, Math.min(1, Math.max(0, (r.closed ? ((s % r.total) + r.total) % r.total : s) / r.total)), v >= 0 ? 'left' : 'right') : 1)

/** Pieces kept per artwork part across the whole stroke, so each part is one paint. */
class Collector {
  parts = new Map<string, { loops: number[][]; rule: FillRule; paint: Paint }>()
  add(key: string, rule: FillRule, paint: Paint, loop: number[]) {
    if (loop.length < 6) return
    let p = this.parts.get(key)
    if (!p) this.parts.set(key, (p = { loops: [], rule, paint }))
    p.loops.push(loop)
  }
}

/**
 * Art (or a tile) laid along a rail: the art's x onto a rail distance
 * through `along` (stretched, or kept between guides), y across at `k`
 * path units per art unit. Flipped along, it runs the other way over the
 * same stretch `span` of the rail, so guides stay with the art's ends.
 */
function layBent(c: Collector, tag: string, art: BrushArt, flat: { loops: number[][]; rule: FillRule }[], paints: Paint[], r: Rail, along: (x: number) => number, span: [number, number], k: number, flips: { flipAlong: boolean; flipAcross: boolean }, profile: WidthPoint[] | undefined, tol: number) {
  const cy = artCy(art)
  const f = (x: number, y: number): Pt => {
    const ay = flips.flipAcross ? 2 * cy - y : y
    const s = flips.flipAlong ? span[0] + span[1] - along(x) : along(x)
    // Art's y grows down the page; the stroke's left is (−dy, dx), which for a line going right is down too.
    const v = (ay - cy) * k
    return railAt(r, s, v * shareAt(profile, r, s, v))
  }
  flat.forEach((part, pi) => {
    for (const loop of part.loops) c.add(`${tag}${pi}`, part.rule, paints[pi], warpLines(loop, f, tol, true))
  })
}

/** Art moved, turned and scaled: its centre to (px, py), its x along `dir`, `k` path units per art unit. */
function layRigid(c: Collector, tag: string, art: BrushArt, flat: { loops: number[][]; rule: FillRule }[], paints: Paint[], px: number, py: number, dir: Pt, k: number, flips: { flipAlong: boolean; flipAcross: boolean }) {
  const cx = (art.box[0] + art.box[2]) / 2
  const cy = artCy(art)
  const fa = flips.flipAlong ? -1 : 1
  const fc = flips.flipAcross ? -1 : 1
  // Across is (−dy, dx), as on the rail.
  const ax = dir[0] * k * fa
  const ay = dir[1] * k * fa
  const bx = -dir[1] * k * fc
  const by = dir[0] * k * fc
  flat.forEach((part, pi) => {
    for (const loop of part.loops) {
      const out = new Array<number>(loop.length)
      for (let i = 0; i < loop.length; i += 2) {
        const x = loop[i] - cx
        const y = loop[i + 1] - cy
        out[i] = px + ax * x + bx * y
        out[i + 1] = py + ay * x + by * y
      }
      c.add(`${tag}${pi}`, part.rule, paints[pi], out)
    }
  })
}

// --- the three kinds -----------------------------------------------------------------------------

function artStroke(c: Collector, b: ArtBrush, rails: Rail[], s: BrushStroke, paints: Paint[], tol: number) {
  const L = artL(b.art)
  const H = artH(b.art)
  const flatCache = new Map<number, ReturnType<typeof flatArt>>()
  for (const r of rails) {
    // Proportional: the art's whole length onto the path, its height in proportion.
    const k = b.fit === 'proportional' ? (r.total / L) * b.scale : (s.width * b.scale) / H
    const ft = Math.max(1e-4, tol / Math.max(k, 1e-9))
    const key = Math.round(Math.log2(ft) * 4)
    let flat = flatCache.get(key)
    if (!flat) flatCache.set(key, (flat = flatArt(b.art, ft)))
    let along: (x: number) => number
    if (b.fit === 'guides') {
      // The art's start and end keep their shape (at k); the middle stretches over what's left.
      let g0 = b.guides[0] * L * k
      let g1 = b.guides[1] * L * k
      if (g0 + g1 > r.total) {
        const f = r.total / (g0 + g1)
        g0 *= f
        g1 *= f
      }
      const x0 = b.art.box[0]
      const xa = x0 + b.guides[0] * L
      const xb = b.art.box[2] - b.guides[1] * L
      const mid = Math.max(0, r.total - g0 - g1)
      along = (x) => (x <= xa ? ((x - x0) / Math.max(1e-9, xa - x0)) * g0 : x >= xb ? r.total - g1 + ((x - xb) / Math.max(1e-9, b.art.box[2] - xb)) * g1 : g0 + ((x - xa) / Math.max(1e-9, xb - xa)) * mid)
    } else along = (x) => ((x - b.art.box[0]) / L) * r.total
    layBent(c, 'a', b.art, flat, paints, r, along, [0, r.total], k, b, s.profile, tol)
  }
}

/** A number from 0 to 1 for copy `k`'s variation `which`, the same every time. */
function rand(seed: number, line: number, k: number, which: number): number {
  let h = (seed * 374761393 + line * 668265263 + k * 2246822519 + which * 3266489917) >>> 0
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const between = (r: [number, number], u: number) => r[0] + (r[1] - r[0]) * u

/** The most copies one line gets. */
const MAX_COPIES = 4000

function scatterStroke(c: Collector, b: ScatterBrush, rails: Rail[], s: BrushStroke, paints: Paint[], tol: number) {
  const L = artL(b.art)
  const H = artH(b.art)
  const flat = flatArt(b.art, Math.max(1e-4, tol / Math.max(1e-9, (s.width * b.size[1]) / H)))
  rails.forEach((r, li) => {
    let at = 0
    for (let k = 0; k < MAX_COPIES; k++) {
      const size = between(b.size, rand(b.seed, li, k, 0))
      const kk = (s.width * size) / H
      const len = L * kk
      if (k === 0) at = len / 2
      if (r.closed ? at >= r.total - 1e-9 : at > r.total + 1e-9) break
      const prof = s.profile?.length ? Math.max(profileAt(s.profile, at / r.total, 'left'), profileAt(s.profile, at / r.total, 'right')) : 1
      const off = between(b.scatter, rand(b.seed, li, k, 1)) * s.width
      const turn = (between(b.rotation, rand(b.seed, li, k, 2)) * Math.PI) / 180
      const p = railAt(r, at, off)
      const dir0 = b.relative === 'path' ? railDir(r, at) : ([1, 0] as Pt)
      const dir: Pt = [dir0[0] * Math.cos(turn) - dir0[1] * Math.sin(turn), dir0[0] * Math.sin(turn) + dir0[1] * Math.cos(turn)]
      if (prof > 1e-6) layRigid(c, 's', b.art, flat, paints, p[0], p[1], dir, kk * prof, { flipAlong: false, flipAcross: false })
      at += Math.max(len * between(b.spacing, rand(b.seed, li, k, 3)), 1e-3 * Math.max(1, r.total))
    }
  })
}

function patternStroke(c: Collector, b: PatternBrush, rails: Rail[], s: BrushStroke, paints: Map<BrushArt, Paint[]>, tol: number) {
  const k = (s.width * b.scale) / artH(b.side)
  const ft = Math.max(1e-4, tol / Math.max(k, 1e-9))
  const flats = new Map<BrushArt, ReturnType<typeof flatArt>>()
  const flatOf = (a: BrushArt) => {
    let f = flats.get(a)
    if (!f) flats.set(a, (f = flatArt(a, ft)))
    return f
  }
  const tile = (tag: string, a: BrushArt, r: Rail, s0: number, len: number) => layBent(c, tag, a, flatOf(a), paints.get(a)!, r, (x) => s0 + ((x - a.box[0]) / artL(a)) * len, [s0, s0 + len], k, b, s.profile, tol)
  /** Side tiles over [s0, s1] of a rail: a whole number of them, stretched or spaced. */
  const run = (r: Rail, s0: number, s1: number) => {
    const R = s1 - s0
    if (R <= 1e-9) return
    const lt = artL(b.side) * k
    if (b.fit === 'space') {
      const n = Math.max(1, Math.floor(R / lt + 1e-9))
      const len = Math.min(lt, R / n)
      const gap = (R - n * len) / n
      for (let i = 0; i < n; i++) tile('p', b.side, r, s0 + gap / 2 + i * (len + gap), len)
    } else {
      const n = Math.max(1, Math.round(R / lt))
      for (let i = 0; i < n; i++) tile('p', b.side, r, s0 + (i * R) / n, R / n)
    }
  }
  for (const r of rails) {
    const corners = b.corner ? r.corners.map((i) => r.d[i]) : []
    const half = b.corner ? (artL(b.corner) * k) / 2 : 0
    // Start and end tiles on an open line, their own length each (shrunk if the line is short).
    let a = 0
    let z = r.total
    if (!r.closed) {
      const ls = b.start ? artL(b.start) * k : 0
      const le = b.end ? artL(b.end) * k : 0
      const f = ls + le > r.total ? r.total / (ls + le) : 1
      if (b.start) tile('s', b.start, r, 0, ls * f)
      if (b.end) tile('e', b.end, r, r.total - le * f, le * f)
      a = ls * f
      z = r.total - le * f
    }
    if (!corners.length) {
      run(r, a, z)
      continue
    }
    // Corner tiles stand at the corners, turned half way between the sides; the side tiles fill between, short of them by half a corner tile.
    for (const cd of corners) {
      const p = railAt(r, cd, 0)
      const din = railDir(r, cd - 1e-6)
      const dout = railDir(r, cd + 1e-6)
      const bx = din[0] + dout[0]
      const by = din[1] + dout[1]
      const bl = Math.hypot(bx, by) || 1
      layRigid(c, 'c', b.corner!, flatOf(b.corner!), paints.get(b.corner!)!, p[0], p[1], [bx / bl, by / bl], k, b)
    }
    if (r.closed) {
      for (let i = 0; i < corners.length; i++) {
        const s0 = corners[i] + half
        let s1 = corners[(i + 1) % corners.length] - half
        if (i + 1 >= corners.length) s1 += r.total
        run(r, s0, s1)
      }
    } else {
      const stops = [a - half, ...corners, z + half]
      for (let i = 0; i + 1 < stops.length; i++) run(r, stops[i] + half, stops[i + 1] - half)
    }
  }
}

// --- colorization ------------------------------------------------------------------------------

const toRgb = (c: ParamColour, mode: ColourMode): [number, number, number] =>
  mode === 'rgb' ? [c[0], c[1], c[2]] : mode === 'gray' ? [c[0], c[0], c[0]] : [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])]

/** An sRGB-ish colour (0..1 each) in a mode's terms: CMYK by plain black generation. */
export const rgbIn = (rgb: [number, number, number], mode: ColourMode): ParamColour => fromRgb(rgb, mode)

function fromRgb(rgb: [number, number, number], mode: ColourMode): ParamColour {
  const [r, g, b] = rgb.map((v) => Math.min(1, Math.max(0, v)))
  if (mode === 'rgb') return [r, g, b]
  if (mode === 'gray') return [0.2126 * r + 0.7152 * g + 0.0722 * b]
  const k = 1 - Math.max(r, g, b)
  return k >= 1 - 1e-9 ? [0, 0, 0, 1] : [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k]
}

const lum = (c: ParamColour, mode: ColourMode) => {
  const [r, g, b] = toRgb(c, mode)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function hsl([r, g, b]: [number, number, number]): [number, number, number] {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  if (mx - mn < 1e-9) return [0, 0, l]
  const d = mx - mn
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}

function fromHsl([h, s, l]: [number, number, number]): [number, number, number] {
  if (s < 1e-9) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p
  }
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)]
}

/** The stroke's colour, for tints and the hue shift: its paint's, or its gradient's first. */
const strokeColour = (p: Paint): ParamColour => mainColour(p)

/** One colour of the art recoloured as the brush says, in the document's mode. */
export function colorizeColour(c: ParamColour, how: Colorize, stroke: ParamColour, key: ParamColour, mode: ColourMode): ParamColour {
  if (how === 'none') return c
  const white = mode === 'cmyk' ? [0, 0, 0, 0] : stroke.map(() => 1)
  const black = mode === 'cmyk' ? [0, 0, 0, 1] : stroke.map(() => 0)
  const mix = (a: ParamColour, b: ParamColour, t: number) => a.map((v, i) => v + ((b[i] ?? 0) - v) * t)
  const l = lum(c, mode)
  if (how === 'tints') return mix(stroke, white, l)
  if (how === 'tints-shades') return l >= 0.5 ? mix(stroke, white, (l - 0.5) * 2) : mix(stroke, black, (0.5 - l) * 2)
  // Hue shift: turned by as much as takes the key colour's hue to the stroke's.
  const turn = hsl(toRgb(stroke, mode))[0] - hsl(toRgb(key, mode))[0]
  const [h, s, ll] = hsl(toRgb(c, mode))
  return fromRgb(fromHsl([h + turn, s, ll]), mode)
}

function colorizePaint(p: Paint, how: Colorize, stroke: Paint, key: ParamColour, mode: ColourMode): Paint {
  if (how === 'none') return p
  // A stroke painted with a gradient or a pattern: tints of it aren't one colour, so the art takes the stroke's paint whole.
  if (stroke.kind !== 'solid' && how !== 'hue-shift') return stroke
  const sc = strokeColour(stroke)
  const f = (c: ParamColour) => colorizeColour(c, how, sc, key, mode)
  switch (p.kind) {
    case 'solid':
      return { kind: 'solid', colour: f(p.colour) }
    case 'gradient':
      return { ...p, stops: p.stops.map((st) => ({ ...st, colour: f(st.colour) })) }
    default:
      return mapPaintColours(p, f)
  }
}

/** The colour Hue Shift turns from: the brush's key, or its first part's. */
export const keyColour = (b: VectorBrush): ParamColour => b.key ?? strokeColour(brushArts(b)[0].parts[0].paint)

// --- the whole stroke ----------------------------------------------------------------------------

/**
 * A brush stroke along `lines` (the path flattened, in its own units), as
 * pieces to fill: one per part of the artwork, colorized. `tol` is how
 * closely bent art follows the path.
 */
export function brushPieces(lines: Polyline[], s: BrushStroke, b: VectorBrush, mode: ColourMode, tol: number): BrushPiece[] {
  if (!(s.width > 0)) return []
  const rails = lines.map(railOf).filter((r): r is Rail => !!r)
  if (!rails.length) return []
  const key = keyColour(b)
  const paintsOf = (a: BrushArt) => a.parts.map((p) => colorizePaint(p.paint, b.colorize, s.paint, key, mode))
  const c = new Collector()
  if (b.kind === 'art') artStroke(c, b, rails, s, paintsOf(b.art), tol)
  else if (b.kind === 'scatter') scatterStroke(c, b, rails, s, paintsOf(b.art), tol)
  else patternStroke(c, b, rails, s, new Map(brushArts(b).map((a) => [a, paintsOf(a)])), tol)
  return [...c.parts.values()].map((p) => ({ loops: p.loops, rule: p.rule, paint: p.paint }))
}

/**
 * How far past its path a brush stroke can reach, in the path's units.
 * A proportional art brush is as wide as the path is long, so `longest`
 * (its longest line) is wanted for that one.
 */
export function brushReach(b: VectorBrush, width: number, profile: WidthPoint[] | undefined, longest = 0): number {
  const pm = profileMax(profile)
  // Art round a turn is lengthened up to twice across.
  if (b.kind === 'art') {
    const half = artH(b.art) / 2
    const k = b.fit === 'proportional' ? (longest / artL(b.art)) * b.scale : (width * b.scale) / artH(b.art)
    return 2 * half * k * pm + 1
  }
  if (b.kind === 'scatter') {
    const r = Math.hypot(artL(b.art), artH(b.art)) / 2
    const kk = (width * b.size[1]) / artH(b.art)
    return r * kk * pm + Math.max(Math.abs(b.scatter[0]), Math.abs(b.scatter[1])) * width * 2 + 1
  }
  const k = (width * b.scale) / artH(b.side)
  const corner = b.corner ? (Math.hypot(artL(b.corner), artH(b.corner)) / 2) * k : 0
  return Math.max(artH(b.side) * k * pm, corner) + 1
}

