/**
 * Image Trace (as Illustrator's): pixels traced into filled vector shapes.
 *
 *   1. Colours: the image cut to black and white (a threshold), a number of
 *      grays, or a palette of colours (median cut, io/quantize.ts); a blur
 *      first, for photos. Pixels less than half opaque are left out.
 *   2. Regions: pixels of one colour joined side to side are a region;
 *      regions smaller than the noise size join the neighbour they share
 *      the most edge with, smallest first.
 *   3. Boundaries: the edges between regions, on the pixel grid, cut at
 *      the points where three or more regions meet (junctions). Each piece
 *      is fitted once (corners kept, the staircase smoothed, cubics within
 *      the paths' tolerance) and used by the regions either side of it, one
 *      forwards and one backwards, so neighbouring shapes meet exactly:
 *      Illustrator's "abutting" method, with no gaps and no overlaps.
 *   4. Shapes: each region's outline and holes from its pieces; one shape
 *      per colour, all its regions in one path.
 *
 * Coordinates are the image's pixels, (0, 0) its top left corner. Pure and
 * DOM-free; check-geom runs it in Node, and it runs in a worker of its own
 * in the app (trace/worker.ts).
 */
import { type Anchor, type PathData, type Pt } from '../geom/path'
import { fitPoints } from '../geom/freehand'
import { quantize } from '../io/quantize'

export type TraceMode = 'bw' | 'gray' | 'colour'

export interface TraceOptions {
  mode: TraceMode
  /** Black and white: pixels darker than this (0..255) are black. */
  threshold: number
  /** Grays or colours: how many. */
  colours: number
  /** How closely curves follow the pixels' edges, in pixels: small for detail, large for smooth. */
  paths: number
  /** A turn sharper than this many degrees is a corner. */
  corners: number
  /** Regions smaller than this many pixels are noise, joined to their neighbour. */
  noise: number
  /** A blur first, radius in pixels (0 for none): for photos. */
  blur: number
  /** White regions left out, as Illustrator's Ignore White. */
  ignoreWhite: boolean
}

export interface TracePreset {
  id: string
  name: string
  options: TraceOptions
}

const base: TraceOptions = { mode: 'bw', threshold: 128, colours: 6, paths: 1, corners: 75, noise: 25, blur: 0, ignoreWhite: false }

/** Illustrator's presets, as far as filled shapes go. */
export const TRACE_PRESETS: TracePreset[] = [
  { id: 'default', name: 'Default', options: { ...base } },
  { id: 'high-photo', name: 'High Fidelity Photo', options: { ...base, mode: 'colour', colours: 64, paths: 0.6, noise: 4, blur: 0.5 } },
  { id: 'low-photo', name: 'Low Fidelity Photo', options: { ...base, mode: 'colour', colours: 16, paths: 1.5, noise: 30, blur: 1.5 } },
  { id: '3-colours', name: '3 Colours', options: { ...base, mode: 'colour', colours: 3, paths: 1.2, noise: 30, blur: 1 } },
  { id: '6-colours', name: '6 Colours', options: { ...base, mode: 'colour', colours: 6, paths: 1.2, noise: 25, blur: 1 } },
  { id: '16-colours', name: '16 Colours', options: { ...base, mode: 'colour', colours: 16, paths: 1, noise: 16, blur: 0.5 } },
  { id: 'grays', name: 'Shades of Gray', options: { ...base, mode: 'gray', colours: 8, paths: 1, noise: 16, blur: 0.5 } },
  { id: 'bw-logo', name: 'Black and White Logo', options: { ...base, paths: 0.75, corners: 60, noise: 12 } },
  { id: 'sketch', name: 'Sketched Art', options: { ...base, threshold: 150, paths: 1.5, noise: 60, blur: 1, ignoreWhite: true } },
  { id: 'silhouettes', name: 'Silhouettes', options: { ...base, threshold: 200, paths: 1.5, noise: 80, blur: 1, ignoreWhite: true } },
]

export interface TracedLayer {
  /** sRGB, 0..255. */
  colour: [number, number, number]
  path: PathData
}

export interface TraceResult {
  layers: TracedLayer[]
  /** Regions (one path each), anchors over all of them, colours used. */
  stats: { paths: number; anchors: number; colours: number }
}

// --- colours -------------------------------------------------------------------------------------

/** A box blur of the colour channels, `r` pixels, twice (near enough Gaussian); alpha kept. */
function blurred(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba)
  const k = Math.max(1, Math.round(r))
  const tmp = new Float32Array(w * h * 3)
  for (let pass = 0; pass < 2; pass++) {
    // Across.
    for (let y = 0; y < h; y++)
      for (let c = 0; c < 3; c++) {
        let acc = 0
        let n = 0
        for (let x = -k; x <= k; x++) if (x >= 0 && x < w) (acc += out[(y * w + x) * 4 + c]), n++
        for (let x = 0; x < w; x++) {
          tmp[(y * w + x) * 3 + c] = acc / n
          const add = x + k + 1
          const drop = x - k
          if (add < w) (acc += out[(y * w + add) * 4 + c]), n++
          if (drop >= 0) (acc -= out[(y * w + drop) * 4 + c]), n--
        }
      }
    // Down.
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let acc = 0
        let n = 0
        for (let y = -k; y <= k; y++) if (y >= 0 && y < h) (acc += tmp[(y * w + x) * 3 + c]), n++
        for (let y = 0; y < h; y++) {
          out[(y * w + x) * 4 + c] = Math.round(acc / n)
          const add = y + k + 1
          const drop = y - k
          if (add < h) (acc += tmp[(add * w + x) * 3 + c]), n++
          if (drop >= 0) (acc -= tmp[(drop * w + x) * 3 + c]), n--
        }
      }
  }
  return out
}

const lumOf = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** Each pixel's colour index (−1 for left out) and the palette, sRGB 0..255. */
export function traceColours(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, o: TraceOptions): { index: Int32Array; palette: [number, number, number][] } {
  const px = o.blur > 0 ? blurred(rgba, w, h, o.blur) : rgba
  const n = w * h
  const index = new Int32Array(n)
  if (o.mode === 'colour') {
    // The palette's clear entry, when there are see-through pixels, is one of its colours: one more asked for then.
    let clearPx = false
    for (let i = 0; i < n && !clearPx; i++) if (rgba[i * 4 + 3] < 128) clearPx = true
    const q = quantize(px, w, h, { colours: Math.max(2, Math.min(256, o.colours + (clearPx ? 1 : 0))), dither: false, transparency: true, matte: null })
    const clear = q.alpha.findIndex((a) => a === 0)
    const palette: [number, number, number][] = []
    const remap = new Int32Array(q.alpha.length).fill(-1)
    for (let e = 0; e < q.alpha.length; e++) {
      if (e === clear) continue
      remap[e] = palette.length
      palette.push([q.palette[e * 3], q.palette[e * 3 + 1], q.palette[e * 3 + 2]])
    }
    for (let i = 0; i < n; i++) index[i] = rgba[i * 4 + 3] < 128 ? -1 : remap[q.indices[i]]
    return { index, palette }
  }
  const levels = o.mode === 'bw' ? 2 : Math.max(2, Math.min(256, Math.round(o.colours)))
  const palette: [number, number, number][] = []
  for (let k = 0; k < levels; k++) {
    const v = o.mode === 'bw' ? k * 255 : Math.round((k * 255) / (levels - 1))
    palette.push([v, v, v])
  }
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] < 128) {
      index[i] = -1
      continue
    }
    const l = lumOf(px[i * 4], px[i * 4 + 1], px[i * 4 + 2])
    index[i] = o.mode === 'bw' ? (l < o.threshold ? 0 : 1) : Math.min(levels - 1, Math.round((l / 255) * (levels - 1)))
  }
  return { index, palette }
}

// --- regions -------------------------------------------------------------------------------------

/** Regions: each pixel's region (−1 outside any), each region's colour, after noise joins its neighbours. */
export function traceRegions(index: Int32Array, w: number, h: number, noise: number): { label: Int32Array; colourOf: number[] } {
  const n = w * h
  const label = new Int32Array(n).fill(-1)
  const colourOf: number[] = []
  const area: number[] = []
  const stack: number[] = []
  for (let i = 0; i < n; i++) {
    if (label[i] >= 0 || index[i] < 0) continue
    const id = colourOf.length
    colourOf.push(index[i])
    let a = 0
    label[i] = id
    stack.push(i)
    while (stack.length) {
      const p = stack.pop()!
      a++
      const x = p % w
      const y = (p - x) / w
      const c = index[p]
      if (x > 0 && label[p - 1] < 0 && index[p - 1] === c) (label[p - 1] = id), stack.push(p - 1)
      if (x < w - 1 && label[p + 1] < 0 && index[p + 1] === c) (label[p + 1] = id), stack.push(p + 1)
      if (y > 0 && label[p - w] < 0 && index[p - w] === c) (label[p - w] = id), stack.push(p - w)
      if (y < h - 1 && label[p + w] < 0 && index[p + w] === c) (label[p + w] = id), stack.push(p + w)
    }
    area.push(a)
  }
  if (noise <= 1 || colourOf.length < 2) return { label, colourOf }
  // Noise: smallest first, each small region into the neighbour it shares most edge with.
  const parent = colourOf.map((_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]]
    return x
  }
  const pixelsOf: number[][] = colourOf.map(() => [])
  for (let i = 0; i < n; i++) if (label[i] >= 0) pixelsOf[label[i]].push(i)
  const order = colourOf.map((_, i) => i).sort((a, b) => area[a] - area[b])
  const size = [...area]
  for (const r0 of order) {
    const r = find(r0)
    if (size[r] >= noise) continue
    const shared = new Map<number, number>()
    const look = (q: number) => {
      if (label[q] < 0) return
      const s = find(label[q])
      if (s !== r) shared.set(s, (shared.get(s) ?? 0) + 1)
    }
    for (const p of pixelsOf[r]) {
      const x = p % w
      if (x > 0) look(p - 1)
      if (x < w - 1) look(p + 1)
      if (p >= w) look(p - w)
      if (p < n - w) look(p + w)
    }
    let best = -1
    let most = 0
    for (const [s, k] of shared) if (k > most) (most = k), (best = s)
    if (best < 0) continue
    parent[r] = best
    size[best] += size[r]
    for (const p of pixelsOf[r]) pixelsOf[best].push(p)
    pixelsOf[r] = []
  }
  // Labels again, numbered from 0.
  const renumber = new Map<number, number>()
  const colours: number[] = []
  for (let i = 0; i < n; i++) {
    if (label[i] < 0) continue
    const root = find(label[i])
    let id = renumber.get(root)
    if (id === undefined) {
      id = colours.length
      renumber.set(root, id)
      colours.push(colourOf[root])
    }
    label[i] = id
  }
  return { label, colourOf: colours }
}

// --- boundaries ----------------------------------------------------------------------------------

/**
 * Every region's boundary loops, as lattice points (x, y corners of
 * pixels), the region on the left as they run (anticlockwise on screen
 * for an outline, clockwise for a hole).
 */
export function traceLoops(label: Int32Array, w: number, h: number, regions: number): number[][][] {
  const W = w + 1
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : label[y * w + x])
  // Outgoing edges by region: from vertex → to vertices (at most two, at a saddle).
  const out: Map<number, number[]>[] = Array.from({ length: regions }, () => new Map())
  const add = (r: number, a: number, b: number) => {
    const m = out[r]
    const l = m.get(a)
    if (l) l.push(b)
    else m.set(a, [b])
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r = label[y * w + x]
      if (r < 0) continue
      if (at(x, y - 1) !== r) add(r, y * W + x + 1, y * W + x)
      if (at(x - 1, y) !== r) add(r, y * W + x, (y + 1) * W + x)
      if (at(x, y + 1) !== r) add(r, (y + 1) * W + x, (y + 1) * W + x + 1)
      if (at(x + 1, y) !== r) add(r, (y + 1) * W + x + 1, y * W + x + 1)
    }
  const loops: number[][][] = Array.from({ length: regions }, () => [])
  for (let r = 0; r < regions; r++) {
    const m = out[r]
    for (const start of [...m.keys()]) {
      while (m.get(start)?.length) {
        const loop: number[] = [start]
        let prev = start
        let cur = m.get(start)!.shift()!
        let guard = 0
        while (cur !== start && guard++ < 4 * (w + 1) * (h + 1)) {
          loop.push(cur)
          const nexts = m.get(cur)
          if (!nexts?.length) break
          let k = 0
          if (nexts.length > 1) {
            // A saddle: turn left, keeping to the pixels joined side to side.
            const dx = (cur % W) - (prev % W)
            const dy = Math.floor(cur / W) - Math.floor(prev / W)
            k = nexts.findIndex((v) => {
              const ex = (v % W) - (cur % W)
              const ey = Math.floor(v / W) - Math.floor(cur / W)
              // Left of (dx, dy) on screen (y down) is (dy, −dx).
              return ex === dy && ey === -dx
            })
            if (k < 0) k = 0
          }
          prev = cur
          cur = nexts.splice(k, 1)[0]
        }
        if (loop.length >= 4) loops[r].push(loop)
      }
    }
  }
  return loops
}

/** Lattice points where three or more regions (or the outside) meet, or two meet corner to corner: where boundary pieces end. */
function junctions(label: Int32Array, w: number, h: number): Uint8Array {
  const W = w + 1
  const j = new Uint8Array(W * (h + 1))
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : label[y * w + x])
  for (let y = 0; y <= h; y++)
    for (let x = 0; x <= w; x++) {
      const a = at(x - 1, y - 1)
      const b = at(x, y - 1)
      const c = at(x - 1, y)
      const d = at(x, y)
      const set = new Set([a, b, c, d])
      if (set.size >= 3 || (set.size === 2 && a === d && b === c && a !== b)) j[y * W + x] = 1
    }
  return j
}

// --- fitting -------------------------------------------------------------------------------------


/** A piece's anchors the other way round. */
const reversedAnchors = (a: Anchor[]): Anchor[] => [...a].reverse().map((x) => ({ ...x, in: x.out, out: x.in }))

// --- the whole trace -------------------------------------------------------------------------------

/** Pixels traced into shapes, one per colour. */
export function traceImage(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, o: TraceOptions): TraceResult {
  const { index, palette } = traceColours(rgba, w, h, o)
  const { label, colourOf } = traceRegions(index, w, h, Math.max(0, o.noise))
  const loops = traceLoops(label, w, h, colourOf.length)
  const joint = junctions(label, w, h)
  const W = w + 1
  const ptOf = (v: number): Pt => [v % W, Math.floor(v / W)]
  const tol = Math.max(0.1, o.paths)
  /** Pieces fitted, by their run (first point, second point, last point): each once, used both ways. */
  const fitted = new Map<string, Anchor[]>()
  const piece = (vs: number[], closed: boolean): Anchor[] => {
    if (closed) {
      // A loop with no ends: keyed by its lowest point and which way it runs from there.
      const m = vs.indexOf(Math.min(...vs))
      const rot = [...vs.slice(m), ...vs.slice(0, m)]
      const key = `L${rot[0]},${rot[1]},${rot[rot.length - 1]}`
      const back = `L${rot[0]},${rot[rot.length - 1]},${rot[1]}`
      const had = fitted.get(key)
      if (had) return had
      const other = fitted.get(back)
      if (other) return reversedAnchors(other)
      const a = fitPoints(rot.map(ptOf), true, tol, o.corners)
      fitted.set(key, a)
      return a
    }
    const key = `${vs[0]},${vs[1]},${vs[vs.length - 1]}`
    const back = `${vs[vs.length - 1]},${vs[vs.length - 2]},${vs[0]}`
    const had = fitted.get(key)
    if (had) return had
    const other = fitted.get(back)
    if (other) return reversedAnchors(other)
    const a = fitPoints(vs.map(ptOf), false, tol, o.corners)
    fitted.set(key, a)
    return a
  }
  // Each loop as anchors: cut at its junctions into pieces, the pieces' shared ends joined.
  const loopAnchors = (loop: number[]): Anchor[] => {
    const cuts = loop.map((v, i) => (joint[v] ? i : -1)).filter((i) => i >= 0)
    if (!cuts.length) {
      const a = piece(loop, true)
      return a
    }
    const out: Anchor[] = []
    for (let c = 0; c < cuts.length; c++) {
      const a = cuts[c]
      const b = cuts[(c + 1) % cuts.length]
      const vs: number[] = []
      for (let i = a; ; i = (i + 1) % loop.length) {
        vs.push(loop[i])
        if (i === b && vs.length > 1) break
      }
      const p = piece(vs, false)
      if (!out.length) out.push(...p)
      else {
        // The previous piece's end is this one's start: one anchor, its handle in from the one, out to the other.
        const last = out[out.length - 1]
        out[out.length - 1] = { ...last, out: p[0].out }
        out.push(...p.slice(1))
      }
    }
    // Round to the start: the last anchor is the first.
    const last = out.pop()!
    out[0] = { ...out[0], in: last.in }
    return out
  }
  // One shape per colour: every region of it.
  const byColour = new Map<number, PathData>()
  let anchors = 0
  let paths = 0
  for (let r = 0; r < colourOf.length; r++) {
    const ci = colourOf[r]
    const [cr, cg, cb] = palette[ci]
    if (o.ignoreWhite && cr > 240 && cg > 240 && cb > 240) continue
    let p = byColour.get(ci)
    if (!p) byColour.set(ci, (p = { fillRule: 'evenodd', subpaths: [] }))
    paths++
    for (const loop of loops[r]) {
      const a = loopAnchors(loop)
      anchors += a.length
      if (a.length >= 2) p.subpaths.push({ closed: true, anchors: a })
    }
  }
  // Darker colours over lighter ones in the stack (they abut, so the order only matters to the eye in Layers).
  const layers = [...byColour]
    .map(([ci, path]) => ({ colour: palette[ci], path }))
    .sort((a, b) => lumOf(...b.colour) - lumOf(...a.colour))
  return { layers, stats: { paths, anchors, colours: layers.length } }
}

/** An image made smaller by whole-pixel averaging, so its longer side is no more than `max`. */
export function shrinkForTrace(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, max: number): { rgba: Uint8ClampedArray; w: number; h: number; scale: number } {
  const f = Math.max(1, Math.ceil(Math.max(w, h) / max))
  if (f === 1) return { rgba: new Uint8ClampedArray(rgba), w, h, scale: 1 }
  const sw = Math.ceil(w / f)
  const sh = Math.ceil(h / f)
  const out = new Uint8ClampedArray(sw * sh * 4)
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      const acc = [0, 0, 0, 0]
      let n = 0
      for (let yy = y * f; yy < Math.min(h, (y + 1) * f); yy++)
        for (let xx = x * f; xx < Math.min(w, (x + 1) * f); xx++) {
          const i = (yy * w + xx) * 4
          const a = rgba[i + 3]
          acc[0] += rgba[i] * a
          acc[1] += rgba[i + 1] * a
          acc[2] += rgba[i + 2] * a
          acc[3] += a
          n++
        }
      const o = (y * sw + x) * 4
      for (let c = 0; c < 3; c++) out[o + c] = acc[3] ? Math.round(acc[c] / acc[3]) : 0
      out[o + 3] = Math.round(acc[3] / n)
    }
  return { rgba: out, w: sw, h: sh, scale: f }
}
