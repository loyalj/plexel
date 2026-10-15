/**
 * Coverage: selections and masks as tiles, and everything done to them.
 *
 * A coverage set is gray 8-bit tiles where the gray value is how much a
 * pixel is covered (selected, or shown through a mask). No tile means
 * nothing covered there, and a uniform tile is a whole tile at one value, so
 * selecting most of a huge canvas costs a few bytes: only tiles along an
 * edge hold pixels.
 *
 * Everything here works tile by tile with what it needs around each tile,
 * never on the whole image at once, and none of it touches the GPU or the
 * DOM: the engine worker runs it, and so do the checks, in Node.
 */
import { TILE, TILE_PIXELS, newSamples, type Samples, type TileFormat } from './format'
import type { SetId, TileId, TileStore } from './store'

export const COVER: TileFormat = { mode: 'gray', depth: 8 }

export type CombineOp = 'replace' | 'add' | 'subtract' | 'intersect'

/** A tile's coverage: a number for one value throughout (0 where there's no tile), or 256 × 256 values. */
type TileCover = number | Float32Array

/**
 * A tiled document's repeat (Document → Tiled): the canvas is a torus
 * across (`x`) and down (`y`), so what's past one edge is at the other. An
 * ordinary document's is null, or neither.
 */
export interface Torus {
  x: boolean
  y: boolean
}

const wraps = (t: Torus | null | undefined): t is Torus => !!t && (t.x || t.y)
const mod = (v: number, n: number) => ((v % n) + n) % n

/** Reads coverage tiles, keeping each it reads for the length of one operation. */
export class CoverReader {
  private cache = new Map<string, TileCover>()
  constructor(
    private store: TileStore,
    private set: SetId | null,
    /** What there is where the set has no tile. */
    private outside = 0,
    /** A tiled document: reads past an edge come from the other side of a canvas this size. */
    private torus: (Torus & { width: number; height: number }) | null = null,
  ) {}

  async tile(tx: number, ty: number): Promise<TileCover> {
    const k = `${tx},${ty}`
    const have = this.cache.get(k)
    if (have !== undefined) return have
    let v: TileCover = this.outside
    const t = this.set ? this.store.tileAt(this.set, tx, ty) : undefined
    if (t !== undefined) {
      const u = this.store.isUniform(t)
      const max = this.store.formatOf(t).depth === 16 ? 65535 : 255
      // A pixel that's partly transparent (a mask painted where it had no
      // tiles) is that much the outside value.
      const o = this.outside
      if (u) {
        const a = u[u.length - 1] / max
        v = (u[0] / max) * a + (1 - a) * o
      } else {
        const s = await this.store.samples(t)
        const out = new Float32Array(TILE_PIXELS)
        for (let i = 0; i < TILE_PIXELS; i++) {
          const a = s[TILE_PIXELS + i] / max
          out[i] = (s[i] / max) * a + (1 - a) * o
        }
        v = out
      }
    }
    this.cache.set(k, v)
    return v
  }

  /**
   * The tile's coverage if it's one value, worked out from the store's
   * bookkeeping without reading pixels: a number, or null for a tile of
   * pixels.
   */
  uniformAt(tx: number, ty: number): number | null {
    const have = this.cache.get(`${tx},${ty}`)
    if (have !== undefined) return typeof have === 'number' ? have : null
    const t = this.set ? this.store.tileAt(this.set, tx, ty) : undefined
    if (t === undefined) return this.outside
    const u = this.store.isUniform(t)
    if (!u) return null
    const max = this.store.formatOf(t).depth === 16 ? 65535 : 255
    const a = u[u.length - 1] / max
    return (u[0] / max) * a + (1 - a) * this.outside
  }

  /**
   * The value of a rectangle if every tile under it is that one value, or
   * null; never on a torus, whose windows wrap. Lets a filter skip a tile
   * deep inside (or outside) a selection without building its window.
   */
  uniformOver(x0: number, y0: number, w: number, h: number): number | null {
    if (this.torus && wraps(this.torus)) return null
    let value: number | null = null
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + h - 1) / TILE); ty++) {
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + w - 1) / TILE); tx++) {
        const u = this.uniformAt(tx, ty)
        if (u === null || (value !== null && u !== value)) return null
        value = u
      }
    }
    return value
  }

  /** Lets go of decoded tiles above row `ty`: a pass that goes down the canvas row by row won't read them again. */
  forgetAbove(ty: number) {
    for (const k of [...this.cache.keys()]) if (Number(k.slice(k.indexOf(',') + 1)) < ty) this.cache.delete(k)
  }

  /** A rectangle of coverage, in document pixels, row by row; on a torus, wrapped round its edges. */
  async window(x0: number, y0: number, w: number, h: number): Promise<Float32Array> {
    const t = this.torus
    if (!t || !wraps(t)) return this.plainWindow(x0, y0, w, h)
    // Cut where the rectangle crosses a period, each piece read from where it is in the canvas.
    const cuts = (start: number, len: number, size: number, on: boolean): [number, number, number][] => {
      if (!on) return [[start, start, len]]
      const out: [number, number, number][] = []
      for (let at = start; at < start + len; ) {
        const end = Math.min(start + len, (Math.floor(at / size) + 1) * size)
        out.push([at, mod(at, size), end - at])
        at = end
      }
      return out
    }
    const out = new Float32Array(w * h)
    for (const [ay, sy, ph] of cuts(y0, h, t.height, t.y))
      for (const [ax, sx, pw] of cuts(x0, w, t.width, t.x)) {
        const piece = await this.plainWindow(sx, sy, pw, ph)
        for (let y = 0; y < ph; y++) out.set(piece.subarray(y * pw, (y + 1) * pw), (ay - y0 + y) * w + (ax - x0))
      }
    return out
  }

  private async plainWindow(x0: number, y0: number, w: number, h: number): Promise<Float32Array> {
    const out = new Float32Array(w * h)
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + h - 1) / TILE); ty++) {
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + w - 1) / TILE); tx++) {
        const t = await this.tile(tx, ty)
        const ys = Math.max(y0, ty * TILE)
        const ye = Math.min(y0 + h, (ty + 1) * TILE)
        const xs = Math.max(x0, tx * TILE)
        const xe = Math.min(x0 + w, (tx + 1) * TILE)
        for (let y = ys; y < ye; y++) {
          const o = (y - y0) * w
          if (typeof t === 'number') {
            if (t) out.fill(t, o + xs - x0, o + xe - x0)
            continue
          }
          const ti = (y - ty * TILE) * TILE - tx * TILE
          for (let x = xs; x < xe; x++) out[o + x - x0] = t[ti + x]
        }
      }
    }
    return out
  }

  /** The value at one document pixel. */
  async at(px: number, py: number): Promise<number> {
    const w = this.torus
    const x = w?.x ? mod(px, w.width) : px
    const y = w?.y ? mod(py, w.height) : py
    const t = await this.tile(Math.floor(x / TILE), Math.floor(y / TILE))
    if (typeof t === 'number') return t
    return t[(((y % TILE) + TILE) % TILE) * TILE + (((x % TILE) + TILE) % TILE)]
  }
}

/** A tile from 256 × 256 coverage values; null when there's nothing in it. */
export function coverTile(store: TileStore, v: Float32Array): TileId | null {
  const s = newSamples(COVER)
  let any = false
  for (let i = 0; i < TILE_PIXELS; i++) {
    const q = Math.round(Math.min(1, Math.max(0, v[i])) * 255)
    s[i] = q
    if (q) any = true
  }
  if (!any) return null
  s.fill(255, TILE_PIXELS)
  return store.data(COVER, s)
}

export const uniformCover = (store: TileStore, v: number) => store.uniform(COVER, [Math.round(v * 255), 255])

/** The tiles that cover the canvas, as [x0, y0, x1, y1] inclusive. */
const canvasTiles = (w: number, h: number) => [0, 0, Math.ceil(w / TILE) - 1, Math.ceil(h / TILE) - 1]

// --- shapes ---------------------------------------------------------------------

/** Rows sampled per pixel row, for vertical anti-aliasing; across a row, coverage is exact. */
const SUB = 4

/** An ellipse as a polygon, fine enough that its edge is smooth at any size. */
export function ellipsePoints(cx: number, cy: number, rx: number, ry: number): [number, number][] {
  const n = Math.min(4096, Math.max(32, Math.ceil(Math.PI * (Math.abs(rx) + Math.abs(ry)) / 2)))
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as [number, number]
  })
}

/**
 * A polygon filled into a new coverage set, clipped to the canvas, with
 * anti-aliased edges (or hard ones). Even-odd: where a lasso crosses itself,
 * the loop it makes is left out, as in Photoshop. On a torus (a tiled
 * document) what's past an edge is folded back in at the other: each row's
 * spans are worked out where the polygon is, and laid on the canvas row
 * and columns they wrap to.
 */
export function rasterizePolygon(store: TileStore, points: [number, number][], width: number, height: number, antialias = true, torus: Torus | null = null): SetId {
  const entries: [number, number, TileId][] = []
  if (points.length < 3) return store.createSet(COVER, entries)
  // Bounds by loop: a long lasso spread into Math.min would overflow the stack.
  let xmin = Infinity
  let xmax = -Infinity
  let ymin = Infinity
  let ymax = -Infinity
  for (const [x, y] of points) {
    if (x < xmin) xmin = x
    if (x > xmax) xmax = x
    if (y < ymin) ymin = y
    if (y > ymax) ymax = y
  }
  const [, , cx1, cy1] = canvasTiles(width, height)
  const wx = !!torus?.x
  const wy = !!torus?.y
  const ty0 = wy ? 0 : Math.max(0, Math.floor(ymin / TILE))
  const ty1 = wy ? cy1 : Math.min(cy1, Math.floor(ymax / TILE))
  const edges = points.map((p, i) => [p, points[(i + 1) % points.length]] as const).filter(([a, b]) => a[1] !== b[1])
  // Each band of TILE rows, in the polygon's own space, with the edges that
  // cross it: a sub-row tries only those, not every edge (an ellipse has up
  // to 4,096).
  const bands = new Map<number, (typeof edges)[number][]>()
  for (const e of edges) {
    const lo = Math.min(e[0][1], e[1][1])
    const hi = Math.max(e[0][1], e[1][1])
    for (let k = Math.floor(lo / TILE); k <= Math.floor(hi / TILE); k++) {
      let list = bands.get(k)
      if (!list) bands.set(k, (list = []))
      list.push(e)
    }
  }
  // The polygon's rows a canvas row stands for: itself, or on a torus each copy of it the polygon reaches.
  const rowsFor = (y: number) => {
    if (!wy) return [y]
    const out: number[] = []
    for (let k = Math.floor((ymin - y) / height); y + k * height <= ymax; k++) if (y + k * height >= ymin) out.push(y + k * height)
    return out
  }
  let txLo = Infinity
  let txHi = -Infinity
  for (let ty = ty0; ty <= ty1; ty++) {
    // Each sub-row's spans, clipped (or folded) to the canvas.
    const spans: [number, number][][] = []
    for (let r = 0; r < TILE * SUB; r++) {
      const y = ty * TILE + (r + 0.5) / SUB
      if (y >= height) {
        spans.push([])
        continue
      }
      const row: [number, number][] = []
      for (const yy of rowsFor(y)) {
        const cross: number[] = []
        for (const [a, b] of bands.get(Math.floor(yy / TILE)) ?? []) {
          if ((yy >= a[1] && yy < b[1]) || (yy >= b[1] && yy < a[1])) cross.push(a[0] + ((yy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]))
        }
        cross.sort((p, q) => p - q)
        for (let i = 0; i + 1 < cross.length; i += 2) {
          if (!wx) {
            const xa = Math.max(0, cross[i])
            const xb = Math.min(width, cross[i + 1])
            if (xb > xa) row.push([xa, xb])
            continue
          }
          // Folded in: a span a period long or more is the whole row; otherwise in one or two pieces.
          if (cross[i + 1] - cross[i] >= width) {
            row.push([0, width])
            continue
          }
          const a = mod(cross[i], width)
          const b = a + (cross[i + 1] - cross[i])
          if (b <= width) row.push([a, b])
          else row.push([a, width], [0, b - width])
        }
      }
      for (const [a, b] of row) {
        txLo = Math.min(txLo, Math.floor(a / TILE))
        txHi = Math.max(txHi, Math.floor((b - 1e-9) / TILE))
      }
      spans.push(row)
    }
    const tx0 = wx ? Math.max(0, txLo) : Math.max(0, Math.floor(xmin / TILE))
    const tx1 = wx ? Math.min(cx1, txHi) : Math.min(cx1, Math.floor(xmax / TILE))
    for (let tx = tx0; tx <= tx1; tx++) {
      const left = tx * TILE
      const right = Math.min(width, left + TILE)
      let empty = true
      let full = true
      for (const row of spans) {
        if (row.some(([a, b]) => b > left && a < right)) empty = false
        if (!row.some(([a, b]) => a <= left && b >= right)) full = false
      }
      if (empty) continue
      if (full && right === left + TILE && (ty + 1) * TILE <= height) {
        entries.push([tx, ty, uniformCover(store, 1)])
        continue
      }
      const v = new Float32Array(TILE_PIXELS)
      spans.forEach((row, r) => {
        const y = r / SUB | 0
        const o = y * TILE
        for (const [a0, b0] of row) {
          const a = Math.max(a0, left) - left
          const b = Math.min(b0, right) - left
          if (b <= a) continue
          const ia = Math.floor(a)
          const ib = Math.floor(b)
          if (ia === ib) {
            v[o + ia] += (b - a) / SUB
            continue
          }
          v[o + ia] += (ia + 1 - a) / SUB
          for (let x = ia + 1; x < ib; x++) v[o + x] += 1 / SUB
          if (ib < TILE) v[o + ib] += (b - ib) / SUB
        }
      })
      if (!antialias) for (let i = 0; i < TILE_PIXELS; i++) v[i] = v[i] >= 0.5 ? 1 : 0
      const t = coverTile(store, v)
      if (t !== null) entries.push([tx, ty, t])
    }
  }
  return store.createSet(COVER, entries)
}

// --- whole selections -------------------------------------------------------------

/** Every pixel of the canvas: Select All. */
export function selectAll(store: TileStore, width: number, height: number): SetId {
  const [, , x1, y1] = canvasTiles(width, height)
  const entries: [number, number, TileId][] = []
  for (let y = 0; y <= y1; y++) {
    for (let x = 0; x <= x1; x++) {
      // A tile hanging over the canvas's edge is covered only on the canvas.
      const w = Math.min(TILE, width - x * TILE)
      const h = Math.min(TILE, height - y * TILE)
      if (w === TILE && h === TILE) entries.push([x, y, uniformCover(store, 1)])
      else {
        const v = new Float32Array(TILE_PIXELS)
        for (let r = 0; r < h; r++) v.fill(1, r * TILE, r * TILE + w)
        entries.push([x, y, coverTile(store, v)!])
      }
    }
  }
  return store.createSet(COVER, entries)
}

/**
 * What `fn` makes of any x against one side's value u: x itself, the same
 * number whatever x is, or neither (null). The functions here are mins and
 * maxes of x with constants (and 1 − x), so agreeing at these points is
 * agreeing everywhere.
 */
function against(fn: (x: number, y: number) => number, u: number, uOnRight: boolean): 'x' | number | null {
  const at = (x: number) => (uOnRight ? fn(x, u) : fn(u, x))
  const xs = [0, 0.25, 0.5, 0.75, 1]
  if (xs.every((x) => at(x) === x)) return 'x'
  const c = at(0)
  return xs.every((x) => at(x) === c) ? c : null
}

/** Applies `fn` to two sets' coverage, pixel by pixel, over the canvas. */
async function perPixel(store: TileStore, a: SetId | null, b: SetId | null, width: number, height: number, fn: (x: number, y: number) => number): Promise<SetId> {
  const ra = new CoverReader(store, a)
  const rb = new CoverReader(store, b)
  const [, , x1, y1] = canvasTiles(width, height)
  const entries: [number, number, TileId][] = []
  for (let ty = 0; ty <= y1; ty++) {
    ra.forgetAbove(ty)
    rb.forgetAbove(ty)
    for (let tx = 0; tx <= x1; tx++) {
      const onEdge = (tx + 1) * TILE > width || (ty + 1) * TILE > height
      // One side all one value: the result may be the other side's tile as
      // it is (adding nothing, intersecting with everything), kept rather
      // than made again, or one value.
      const ua = ra.uniformAt(tx, ty)
      const ub = rb.uniformAt(tx, ty)
      if (!onEdge && (ua === null) !== (ub === null)) {
        const r = ua === null ? against(fn, ub!, true) : against(fn, ua, false)
        const other = ua === null ? a : b
        const tile = other ? store.tileAt(other, tx, ty) : undefined
        const f = tile !== undefined ? store.formatOf(tile) : null
        if (r === 'x' && tile !== undefined && f!.mode === COVER.mode && f!.depth === COVER.depth) {
          entries.push([tx, ty, tile])
          continue
        }
        if (typeof r === 'number') {
          if (r > 0) entries.push([tx, ty, uniformCover(store, r)])
          continue
        }
      }
      const ta = await ra.tile(tx, ty)
      const tb = await rb.tile(tx, ty)
      if (typeof ta === 'number' && typeof tb === 'number' && !onEdge) {
        const v = fn(ta, tb)
        if (v > 0) entries.push([tx, ty, uniformCover(store, v)])
        continue
      }
      const v = new Float32Array(TILE_PIXELS)
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          if (tx * TILE + x >= width || ty * TILE + y >= height) continue
          const i = y * TILE + x
          v[i] = fn(typeof ta === 'number' ? ta : ta[i], typeof tb === 'number' ? tb : tb[i])
        }
      }
      const t = coverTile(store, v)
      if (t !== null) entries.push([tx, ty, t])
    }
  }
  return store.createSet(COVER, entries)
}

/** A new shape combined with the selection there was: replaced, added, subtracted or intersected. */
export function combine(store: TileStore, current: SetId | null, shape: SetId, op: CombineOp, width: number, height: number): Promise<SetId> {
  if (op === 'replace' || (!current && op === 'add')) return Promise.resolve(shape)
  const fns: Record<Exclude<CombineOp, 'replace'>, (a: number, b: number) => number> = {
    add: (a, b) => Math.max(a, b),
    subtract: (a, b) => Math.min(a, 1 - b),
    intersect: (a, b) => Math.min(a, b),
  }
  return perPixel(store, current, shape, width, height, fns[op])
}

/** Select → Inverse. */
export const invert = (store: TileStore, current: SetId | null, width: number, height: number) => perPixel(store, current, null, width, height, (a) => 1 - a)

/** Whether a set has anything in it at all. */
export function isEmpty(store: TileStore, set: SetId): boolean {
  return store.getSet(set).tiles.size === 0
}

// --- filters, tile by tile -----------------------------------------------------------

/**
 * Runs `fn` over every tile of the canvas, giving it the tile's coverage
 * with `margin` pixels of its neighbours around it, and writes what it
 * returns (the tile's own 256 × 256) to a new set.
 */
async function filterTiles(store: TileStore, set: SetId | null, width: number, height: number, margin: number, fn: (win: Float32Array, size: number) => Float32Array, outside = 0, torus: Torus | null = null): Promise<SetId> {
  // On a torus the neighbourhood of an edge is at the other side.
  const reader = new CoverReader(store, set, outside, wraps(torus) ? { ...torus, width, height } : null)
  const [, , x1, y1] = canvasTiles(width, height)
  const entries: [number, number, TileId][] = []
  const size = TILE + 2 * margin
  const reach = Math.ceil(margin / TILE)
  for (let ty = 0; ty <= y1; ty++) {
    reader.forgetAbove(ty - reach)
    for (let tx = 0; tx <= x1; tx++) {
      const onEdge = (tx + 1) * TILE > width || (ty + 1) * TILE > height
      // A neighbourhood all one value filters to that value: no work. Most
      // tiles of a big selection are, and the tiles' bookkeeping says so
      // without building the window.
      const u = onEdge ? null : reader.uniformOver(tx * TILE - margin, ty * TILE - margin, size, size)
      if (u !== null) {
        if (u > 0) entries.push([tx, ty, uniformCover(store, u)])
        continue
      }
      const win = await reader.window(tx * TILE - margin, ty * TILE - margin, size, size)
      let same = true
      for (let i = 1; i < win.length && same; i++) if (win[i] !== win[0]) same = false
      if (same && !onEdge) {
        if (win[0] > 0) entries.push([tx, ty, uniformCover(store, win[0])])
        continue
      }
      const out = fn(win, size)
      if (onEdge) for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) if (tx * TILE + x >= width || ty * TILE + y >= height) out[y * TILE + x] = 0
      const t = coverTile(store, out)
      if (t !== null) entries.push([tx, ty, t])
    }
  }
  return store.createSet(COVER, entries)
}

/** The centre TILE × TILE of a window `size` across. */
function centre(win: Float32Array, size: number, margin: number): Float32Array {
  const out = new Float32Array(TILE_PIXELS)
  for (let y = 0; y < TILE; y++) out.set(win.subarray((y + margin) * size + margin, (y + margin) * size + margin + TILE), y * TILE)
  return out
}

/**
 * One box blur of radius r along rows (horizontal) or columns, in place,
 * edges clamped. Columns are swept a row at a time with a running sum for
 * each, so memory is read in order; the sums are the same, in the same
 * order, as a column at a time.
 */
function boxPass(v: Float32Array, size: number, r: number, horizontal: boolean) {
  if (r <= 0) return
  const n = 2 * r + 1
  const last = size - 1
  if (horizontal) {
    const line = new Float32Array(size)
    for (let base = 0; base < size * size; base += size) {
      let sum = 0
      for (let i = -r; i <= r; i++) sum += v[base + (i < 0 ? 0 : i > last ? last : i)]
      for (let i = 0; i < size; i++) {
        line[i] = sum / n
        const add = i + r + 1
        const sub = i - r
        sum += v[base + (add > last ? last : add)] - v[base + (sub < 0 ? 0 : sub)]
      }
      v.set(line, base)
    }
    return
  }
  const sums = new Float64Array(size)
  for (let i = -r; i <= r; i++) {
    const row = (i < 0 ? 0 : i > last ? last : i) * size
    for (let x = 0; x < size; x++) sums[x] += v[row + x]
  }
  const out = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    const o = y * size
    for (let x = 0; x < size; x++) out[o + x] = sums[x] / n
    const add = (y + r + 1 > last ? last : y + r + 1) * size
    const sub = (y - r < 0 ? 0 : y - r) * size
    for (let x = 0; x < size; x++) sums[x] += v[add + x] - v[sub + x]
  }
  v.set(out)
}

/** Three box radii whose passes together approximate a Gaussian of sigma s. */
export function gaussBoxes(s: number): number[] {
  const n = 3
  const wIdeal = Math.sqrt((12 * s * s) / n + 1)
  let wl = Math.floor(wIdeal)
  if (wl % 2 === 0) wl--
  const wu = wl + 2
  const m = Math.round((12 * s * s - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4))
  return Array.from({ length: n }, (_, i) => ((i < m ? wl : wu) - 1) / 2)
}

/** A Gaussian blur of a window, in place. */
function gaussian(win: Float32Array, size: number, sigma: number) {
  for (const r of gaussBoxes(sigma)) {
    boxPass(win, size, r, true)
    boxPass(win, size, r, false)
  }
}

/** Select → Modify → Feather: the edge softened over `radius` pixels (the Gaussian's sigma is half of it). */
export function feather(store: TileStore, set: SetId, radius: number, width: number, height: number, outside = 0, torus: Torus | null = null): Promise<SetId> {
  if (radius <= 0) return Promise.resolve(set)
  const sigma = radius / 2
  const margin = Math.min(TILE * 2, Math.ceil(sigma * 3))
  return filterTiles(
    store,
    set,
    width,
    height,
    margin,
    (win, size) => {
      gaussian(win, size, sigma)
      return centre(win, size, margin)
    },
    outside,
    torus,
  )
}

/** The selection moved by whole pixels (dragging it with a selection tool), clipped to the canvas; on a torus, round it. */
export async function offset(store: TileStore, set: SetId, dx: number, dy: number, width: number, height: number, torus: Torus | null = null): Promise<SetId> {
  const reader = new CoverReader(store, set, 0, wraps(torus) ? { ...torus, width, height } : null)
  const [, , x1, y1] = canvasTiles(width, height)
  const entries: [number, number, TileId][] = []
  for (let ty = 0; ty <= y1; ty++) {
    for (let tx = 0; tx <= x1; tx++) {
      // Only tiles the moved selection can reach.
      const sx = tx * TILE - dx
      const sy = ty * TILE - dy
      const v = await reader.window(sx, sy, TILE, TILE)
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) if (tx * TILE + x >= width || ty * TILE + y >= height) v[y * TILE + x] = 0
      let same = true
      for (let i = 1; i < v.length && same; i++) if (v[i] !== v[0]) same = false
      if (same) {
        if (v[0] > 0) entries.push([tx, ty, uniformCover(store, v[0])])
        continue
      }
      const t = coverTile(store, v)
      if (t !== null) entries.push([tx, ty, t])
    }
  }
  return store.createSet(COVER, entries)
}

/** The smallest rectangle holding every covered pixel, [x0, y0, x1, y1), or null for nothing. */
export async function exactBounds(store: TileStore, set: SetId): Promise<[number, number, number, number] | null> {
  const reader = new CoverReader(store, set)
  let b: [number, number, number, number] | null = null
  const grow = (x0: number, y0: number, x1: number, y1: number) => {
    b = b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1]
  }
  for (const k of store.getSet(set).tiles.keys()) {
    const [tx, ty] = k.split(',').map(Number)
    const t = await reader.tile(tx, ty)
    if (typeof t === 'number') {
      if (t > 0) grow(tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE)
      continue
    }
    let x0 = TILE
    let y0 = TILE
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        if (t[y * TILE + x] <= 0) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        y1 = y
      }
    }
    if (x1 >= 0) grow(tx * TILE + x0, ty * TILE + y0, tx * TILE + x1 + 1, ty * TILE + y1 + 1)
  }
  return b
}

/** Select → Modify → Expand or Contract by `radius` pixels: the most (or least) coverage within a square that far around. */
export function grow(store: TileStore, set: SetId, radius: number, width: number, height: number, torus: Torus | null = null): Promise<SetId> {
  const r = Math.min(TILE, Math.round(Math.abs(radius)))
  if (!r) return Promise.resolve(set)
  const most = radius > 0
  return filterTiles(store, set, width, height, r, (win, size) => {
    const tmp = new Float32Array(win.length)
    const g = new Float64Array(size + 2 * r)
    const h = new Float64Array(size + 2 * r)
    for (let y = 0; y < size; y++) slidingExtreme(win, y * size, 1, size, r, most, tmp, y * size, 1, g, h)
    // Columns r .. r + TILE - 1 of the window, rows r .. r + TILE - 1: each has its whole reach inside it.
    const out = new Float32Array(TILE_PIXELS)
    const col = new Float32Array(size)
    for (let x = 0; x < TILE; x++) {
      slidingExtreme(tmp, x + r, size, size, r, most, col, 0, 1, g, h)
      for (let y = 0; y < TILE; y++) out[y * TILE + x] = col[y + r]
    }
    return out
  }, 0, torus)
}

/**
 * The most (or least) of each window of 2r + 1 along a line of n values,
 * read from `src` at `at + i * step` and clipped at the line's ends, written
 * to `dst` at `to + i * dstep`: van Herk and Gil-Werman's three
 * comparisons a value, whatever r is (where trying the window costs 2r).
 * `g` and `h` are scratch, at least n + 2r long.
 */
function slidingExtreme(src: Float32Array, at: number, step: number, n: number, r: number, most: boolean, dst: Float32Array, to: number, dstep: number, g: Float64Array, h: Float64Array) {
  const w = 2 * r + 1
  const len = n + 2 * r
  const pad = most ? -Infinity : Infinity
  const pick = most ? Math.max : Math.min
  // The line padded by r each side: g runs forwards within blocks of w, h backwards.
  for (let i = 0; i < len; i++) {
    const j = i - r
    const v = j >= 0 && j < n ? src[at + j * step] : pad
    g[i] = i % w === 0 ? v : pick(g[i - 1], v)
  }
  for (let i = len - 1; i >= 0; i--) {
    const j = i - r
    const v = j >= 0 && j < n ? src[at + j * step] : pad
    h[i] = i === len - 1 || (i + 1) % w === 0 ? v : pick(h[i + 1], v)
  }
  // The window round j covers padded i = j .. j + 2r: from h's block and g's.
  for (let j = 0; j < n; j++) dst[to + j * dstep] = pick(h[j], g[j + 2 * r])
}

export interface Refine {
  /** Pixels: rounds off jagged edges. */
  smooth: number
  /** Pixels: softens the edge. */
  feather: number
  /** 0..1: sharpens a soft edge. */
  contrast: number
  /** −1..1: moves the edge outwards (positive) or inwards. */
  shift: number
}

/** The coverage a refinement gives a value, after smoothing and feathering. */
function refineValue(v: number, o: Pick<Refine, 'contrast' | 'shift'>): number {
  const shifted = v + o.shift * 0.5
  const k = 1 / Math.max(0.01, 1 - o.contrast)
  return Math.min(1, Math.max(0, (shifted - 0.5) * k + 0.5))
}

/** Select and Mask's global refinements: smooth, feather, contrast and shift edge, in that order. */
export function refine(store: TileStore, set: SetId, o: Refine, width: number, height: number, torus: Torus | null = null): Promise<SetId> {
  const sSmooth = o.smooth / 2
  const sFeather = o.feather / 2
  const margin = Math.min(TILE * 2, Math.ceil(3 * (sSmooth + sFeather)) + 1)
  return filterTiles(store, set, width, height, margin, (win, size) => {
    if (sSmooth > 0) {
      // Blur, then sharpen back to an edge about a pixel wide: corners and
      // stair-steps round off, but the edge stays crisp.
      gaussian(win, size, sSmooth)
      for (let i = 0; i < win.length; i++) win[i] = Math.min(1, Math.max(0, (win[i] - 0.5) * Math.max(1, 2 * sSmooth) + 0.5))
    }
    if (sFeather > 0) gaussian(win, size, sFeather)
    if (o.contrast || o.shift) for (let i = 0; i < win.length; i++) win[i] = refineValue(win[i], o)
    return centre(win, size, margin)
  }, 0, torus)
}

// --- the magic wand --------------------------------------------------------------------

/**
 * The magic wand: the pixels like the one at (x, y), within `tolerance`
 * (0..255, the most any channel may differ by), touching it or anywhere.
 * `image` is the document's pixels, `channels` 8-bit values each, alpha
 * last. With anti-aliasing, the edge is softened by a pixel.
 */
export function wand(
  store: TileStore,
  image: Uint8Array,
  channels: number,
  width: number,
  height: number,
  x: number,
  y: number,
  tolerance: number,
  contiguous: boolean,
  antialias: boolean,
  /** The image is the document shrunk by 2^shift (a huge one is read from a mip level); the selection is full size. */
  shift = 0,
  outWidth = width << shift,
  outHeight = height << shift,
  /** A tiled document: like pixels touch across the edges. */
  torus: Torus | null = null,
): SetId {
  const seed = (y * width + x) * channels
  const ref = image.subarray(seed, seed + channels)
  const like = (p: number) => {
    const o = p * channels
    for (let c = 0; c < channels; c++) if (Math.abs(image[o + c] - ref[c]) > tolerance) return false
    return true
  }
  const hit = new Uint8Array(width * height)
  if (!contiguous) {
    for (let p = 0; p < width * height; p++) if (like(p)) hit[p] = 1
  } else floodFill(hit, width, height, [x, y], like, torus)
  return hitsToSet(store, hit, width, height, antialias, shift, outWidth, outHeight, torus)
}

/**
 * Scanline flood fill from each seed (x, y pairs) through pixels `like` says
 * belong, marking them in `hit`. On a torus the edges touch: a run that
 * reaches one side carries on at the other, and the rows above the top and
 * below the bottom are the bottom and top.
 */
function floodFill(hit: Uint8Array, width: number, height: number, seeds: number[], like: (p: number) => boolean, torus: Torus | null = null) {
  const wx = !!torus?.x
  const wy = !!torus?.y
  const stack: number[] = seeds.slice()
  while (stack.length) {
    const sy = stack.pop()!
    let sx = stack.pop()!
    let p = sy * width + sx
    if (hit[p] || !like(p)) continue
    while (sx > 0 && !hit[p - 1] && like(p - 1)) {
      sx--
      p--
    }
    // Round the left edge: the run carries on from the right end of the row.
    if (wx && sx === 0) {
      const q = sy * width + width - 1
      if (!hit[q] && like(q)) stack.push(width - 1, sy)
    }
    let up = false
    let down = false
    const above = sy > 0 ? sy - 1 : wy ? height - 1 : -1
    const below = sy < height - 1 ? sy + 1 : wy ? 0 : -1
    for (; sx < width && !hit[p] && like(p); sx++, p++) {
      hit[p] = 1
      if (above >= 0) {
        const q = above * width + sx
        const ok = !hit[q] && like(q)
        if (ok && !up) stack.push(sx, above)
        up = ok
      }
      if (below >= 0) {
        const q = below * width + sx
        const ok = !hit[q] && like(q)
        if (ok && !down) stack.push(sx, below)
        down = ok
      }
    }
    // And round the right edge, from the left end.
    if (wx && sx === width) {
      const q = sy * width
      if (!hit[q] && like(q)) stack.push(0, sy)
    }
  }
}

/**
 * Pixels marked in `hit` (an image 2^shift smaller than the canvas) as a
 * coverage set at full size, its edge softened by a pixel with anti-aliasing:
 * tiles with nothing near them skipped, full ones written as one value.
 */
export function hitsToSet(store: TileStore, hit: Uint8Array, width: number, height: number, antialias: boolean, shift = 0, outWidth = width << shift, outHeight = height << shift, torus: Torus | null = null): SetId {
  const wx = !!torus?.x
  const wy = !!torus?.y
  const entries: [number, number, TileId][] = []
  const [, , x1, y1] = canvasTiles(outWidth, outHeight)
  // Each output tile's hits and its size, in image pixels, counted in one
  // pass: a tile with none near it is skipped, and one full of them (with
  // full tiles all round, so no edge reaches in) is one uniform tile.
  const cols = x1 + 1
  const rows = y1 + 1
  const counts = new Uint32Array(cols * rows)
  const area = new Uint32Array(cols * rows)
  const span = TILE >> shift || 1
  for (let gy = 0; gy < height; gy++) {
    const ty = Math.min(rows - 1, Math.floor(gy / span))
    for (let gx = 0; gx < width; gx++) {
      const t = ty * cols + Math.min(cols - 1, Math.floor(gx / span))
      area[t]++
      counts[t] += hit[gy * width + gx]
    }
  }
  const full = (tx: number, ty: number) => tx < 0 || ty < 0 || tx >= cols || ty >= rows || counts[ty * cols + tx] === area[ty * cols + tx]
  const near = (tx: number, ty: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = tx + dx
      const y = ty + dy
      if (x >= 0 && y >= 0 && x < cols && y < rows && counts[y * cols + x]) return true
    }
    return false
  }
  for (let ty = 0; ty <= y1; ty++) {
    for (let tx = 0; tx <= x1; tx++) {
      if (!near(tx, ty) && !(antialias && ((wx && (tx === 0 || tx === x1)) || (wy && (ty === 0 || ty === y1))))) continue
      // On a torus a tile at the canvas's edge has neighbours at the other side: worked out pixel by pixel.
      const onEdge = (tx + 1) * TILE > outWidth || (ty + 1) * TILE > outHeight || (wx && (tx === 0 || tx === x1)) || (wy && (ty === 0 || ty === y1))
      let whole = !onEdge && full(tx, ty)
      if (whole && antialias) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!full(tx + dx, ty + dy)) whole = false
      if (whole) {
        entries.push([tx, ty, uniformCover(store, 1)])
        continue
      }
      const v = new Float32Array(TILE_PIXELS)
      let any = false
      for (let yy = 0; yy < TILE; yy++) {
        const oy = ty * TILE + yy
        if (oy >= outHeight) break
        const gy = Math.min(height - 1, oy >> shift)
        for (let xx = 0; xx < TILE; xx++) {
          const ox = tx * TILE + xx
          if (ox >= outWidth) break
          const gx = Math.min(width - 1, ox >> shift)
          let c = hit[gy * width + gx]
          if (antialias) {
            // A pixel on the edge is covered by the share of its 3 × 3 that is.
            let n = 0
            let s = 0
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const qx = wx ? mod(gx + dx, width) : gx + dx
              const qy = wy ? mod(gy + dy, height) : gy + dy
              if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue
              n++
              s += hit[qy * width + qx]
            }
            c = c ? Math.max(0.5, s / n) : s / n / 2
          }
          v[yy * TILE + xx] = c
          if (c) any = true
        }
      }
      if (!any) continue
      const t = coverTile(store, v)
      if (t !== null) entries.push([tx, ty, t])
    }
  }
  return store.createSet(COVER, entries)
}

/**
 * Grow and Similar: the pixels whose colours are within `tolerance` of the
 * range of colours the selection holds (each channel's lowest and highest
 * over the pixels at least half selected), touching the selection (Grow) or
 * anywhere (Similar), added to it. `cover` is the selection at the image's
 * size. Returns the new pixels as hits, or null when nothing is selected.
 */
export function similarHits(image: Uint8Array, channels: number, width: number, height: number, cover: Float32Array, tolerance: number, contiguous: boolean, torus: Torus | null = null): Uint8Array | null {
  const lo = new Array(channels).fill(255)
  const hi = new Array(channels).fill(0)
  let any = false
  for (let p = 0; p < width * height; p++) {
    if (cover[p] < 0.5) continue
    any = true
    for (let c = 0; c < channels; c++) {
      const v = image[p * channels + c]
      if (v < lo[c]) lo[c] = v
      if (v > hi[c]) hi[c] = v
    }
  }
  if (!any) return null
  const like = (p: number) => {
    for (let c = 0; c < channels; c++) {
      const v = image[p * channels + c]
      if (v < lo[c] - tolerance || v > hi[c] + tolerance) return false
    }
    return true
  }
  const hit = new Uint8Array(width * height)
  if (!contiguous) {
    for (let p = 0; p < width * height; p++) if (cover[p] >= 0.5 || like(p)) hit[p] = 1
    return hit
  }
  const seeds: number[] = []
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (cover[y * width + x] >= 0.5) seeds.push(x, y)
  // The selected pixels are in, whatever their colour; the fill grows out from them.
  floodFill(hit, width, height, seeds, (p) => cover[p] >= 0.5 || like(p), torus)
  return hit
}

/** Colour Range's built-in ranges, as Photoshop's Select menu lists them. */
export type ColourRangePreset = 'sampled' | 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas' | 'highlights' | 'midtones' | 'shadows' | 'skin'

/**
 * Select → Colour Range: how much each pixel is selected, 0..1. Sampled
 * colours select what's within `fuzziness` (0..200, on a 0..255 scale of
 * distance) of any of them, fully within half of it and fading to nothing
 * at it; the presets pick hues (by the hue's distance from the range's
 * centre) or tones (by luminance). Pixels are 8-bit in the document's
 * terms, alpha last; CMYK is read as light for hue and tone.
 */
export function colourRange(image: Uint8Array, channels: number, width: number, height: number, mode: 'rgb' | 'gray' | 'cmyk', preset: ColourRangePreset, samples: number[][], fuzziness: number): Float32Array {
  const n = channels - 1
  const out = new Float32Array(width * height)
  const rgbOf = (o: number): [number, number, number] => {
    if (mode === 'gray') return [image[o], image[o], image[o]]
    if (mode === 'rgb') return [image[o], image[o + 1], image[o + 2]]
    const k = image[o + 3] / 255
    return [0, 1, 2].map((c) => 255 * (1 - image[o + c] / 255) * (1 - k)) as [number, number, number]
  }
  const HUES: Partial<Record<ColourRangePreset, number>> = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 }
  for (let p = 0; p < width * height; p++) {
    const o = p * channels
    const alpha = image[o + n] / 255
    let v = 0
    if (preset === 'sampled') {
      let best = Infinity
      for (const s of samples) {
        let d = 0
        for (let c = 0; c < n; c++) d += (image[o + c] - s[c]) ** 2
        if (d < best) best = d
      }
      const d = Math.sqrt(best)
      const f = Math.max(fuzziness, 1e-6)
      v = d <= f / 2 ? 1 : d >= f ? 0 : 2 - (2 * d) / f
      if (fuzziness <= 0) v = best === 0 ? 1 : 0
    } else {
      const [r, g, b] = rgbOf(o)
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      const lum = (0.3 * r + 0.59 * g + 0.11 * b) / 255
      if (preset === 'highlights') v = smooth(0.6, 0.8, lum)
      else if (preset === 'shadows') v = 1 - smooth(0.2, 0.4, lum)
      else if (preset === 'midtones') v = Math.min(smooth(0.15, 0.35, lum), 1 - smooth(0.65, 0.85, lum))
      else if (mx - mn > 0) {
        let h: number
        if (mx === r) h = ((g - b) / (mx - mn)) * 60
        else if (mx === g) h = ((b - r) / (mx - mn)) * 60 + 120
        else h = ((r - g) / (mx - mn)) * 60 + 240
        if (h < 0) h += 360
        const sat = (mx - mn) / mx
        if (preset === 'skin') {
          // Warm, moderately saturated, not too dark: the usual skin-tone box.
          const dh = Math.abs(((h - 22 + 540) % 360) - 180)
          v = (1 - smooth(18, 35, dh)) * smooth(0.12, 0.2, sat) * (1 - smooth(0.7, 0.85, sat)) * smooth(0.2, 0.35, lum)
        } else {
          const dh = Math.abs(((h - HUES[preset]! + 540) % 360) - 180)
          // Full within 30° of the hue, gone by 60°, scaled by how coloured the pixel is.
          v = (1 - smooth(30, 60, dh)) * Math.min(1, sat * 4)
        }
      }
    }
    out[p] = v * alpha
  }
  return out
}

/** 0 below a, 1 above b, a smooth step between. */
function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Coverage values over an image 2^shift smaller than the canvas, as a
 * coverage set at full size (each canvas pixel bilinearly from the image).
 */
export function valuesToSet(store: TileStore, values: Float32Array, width: number, height: number, shift: number, outWidth: number, outHeight: number): SetId {
  const entries: [number, number, TileId][] = []
  const [, , x1, y1] = canvasTiles(outWidth, outHeight)
  const s = 2 ** shift
  for (let ty = 0; ty <= y1; ty++) {
    for (let tx = 0; tx <= x1; tx++) {
      const v = new Float32Array(TILE_PIXELS)
      for (let yy = 0; yy < TILE; yy++) {
        const oy = ty * TILE + yy
        if (oy >= outHeight) break
        for (let xx = 0; xx < TILE; xx++) {
          const ox = tx * TILE + xx
          if (ox >= outWidth) break
          v[yy * TILE + xx] = shift ? bilinear(values, width, height, (ox + 0.5) / s - 0.5, (oy + 0.5) / s - 0.5) : values[oy * width + ox]
        }
      }
      let same = true
      for (let i = 1; i < TILE_PIXELS && same; i++) if (v[i] !== v[0]) same = false
      const onEdge = (tx + 1) * TILE > outWidth || (ty + 1) * TILE > outHeight
      if (same && !onEdge) {
        if (v[0] > 0) entries.push([tx, ty, uniformCover(store, v[0])])
        continue
      }
      const t = coverTile(store, v)
      if (t !== null) entries.push([tx, ty, t])
    }
  }
  return store.createSet(COVER, entries)
}

/** A value from a w × h grid at (x, y) in its pixels (centres at whole numbers), edges clamped. */
function bilinear(v: Float32Array, w: number, h: number, x: number, y: number): number {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x)))
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)))
  const x1 = Math.min(w - 1, x0 + 1)
  const y1 = Math.min(h - 1, y0 + 1)
  const fx = Math.min(1, Math.max(0, x - x0))
  const fy = Math.min(1, Math.max(0, y - y0))
  return (v[y0 * w + x0] * (1 - fx) + v[y0 * w + x1] * fx) * (1 - fy) + (v[y1 * w + x0] * (1 - fx) + v[y1 * w + x1] * fx) * fy
}

/**
 * Transform Selection, and an alpha channel loaded through its transform:
 * the coverage `set` (in its own pixels) placed in the document by `m`,
 * each document pixel sampled bilinearly back through it, clipped to the
 * canvas. Tiles far from the moved outline are filled without sampling.
 */
export async function transformCover(store: TileStore, set: SetId | null, m: Affine, width: number, height: number, outside = 0, torus: Torus | null = null): Promise<SetId> {
  // On a torus, what's moved past an edge comes back at the other: each copy the moved set reaches, folded in by the most of them.
  if (wraps(torus) && set && outside === 0) {
    const e = store.extent(set)
    if (e) {
      const c = [
        [e.x0 * TILE, e.y0 * TILE],
        [(e.x1 + 1) * TILE, e.y0 * TILE],
        [e.x0 * TILE, (e.y1 + 1) * TILE],
        [(e.x1 + 1) * TILE, (e.y1 + 1) * TILE],
      ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
      const periods = (lo: number, hi: number, size: number, on: boolean) => {
        if (!on) return [0]
        const out: number[] = []
        for (let k = Math.floor(lo / size); k * size < hi; k++) out.push(k * size)
        return out
      }
      const kxs = periods(Math.min(...c.map((p) => p[0])), Math.max(...c.map((p) => p[0])), width, torus.x)
      const kys = periods(Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[1])), height, torus.y)
      if (kxs.length * kys.length > 1) {
        let out: SetId | null = null
        for (const ky of kys)
          for (const kx of kxs) {
            // The copy k periods along, moved back onto the canvas.
            const part = await transformCover(store, set, [m[0], m[1], m[2], m[3], m[4] - kx, m[5] - ky], width, height)
            out = out ? await combine(store, out, part, 'add', width, height) : part
          }
        return out!
      }
      if (kxs[0] || kys[0]) return transformCover(store, set, [m[0], m[1], m[2], m[3], m[4] - kxs[0], m[5] - kys[0]], width, height)
    }
  }
  const reader = new CoverReader(store, set, outside)
  const inv = invertAffine(m)
  const [, , x1, y1] = canvasTiles(width, height)
  const entries: [number, number, TileId][] = []
  for (let ty = 0; ty <= y1; ty++) {
    for (let tx = 0; tx <= x1; tx++) {
      // The tile's corners in the set's pixels: the window to read.
      const pts = [
        [tx * TILE, ty * TILE],
        [(tx + 1) * TILE, ty * TILE],
        [tx * TILE, (ty + 1) * TILE],
        [(tx + 1) * TILE, (ty + 1) * TILE],
      ].map(([x, y]) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]])
      const sx0 = Math.floor(Math.min(...pts.map((p) => p[0]))) - 1
      const sy0 = Math.floor(Math.min(...pts.map((p) => p[1]))) - 1
      const sw = Math.floor(Math.max(...pts.map((p) => p[0]))) + 2 - sx0
      const sh = Math.floor(Math.max(...pts.map((p) => p[1]))) + 2 - sy0
      let win: Float32Array | null = null
      const v = new Float32Array(TILE_PIXELS)
      if (sw * sh <= 16 * TILE_PIXELS) {
        win = await reader.window(sx0, sy0, sw, sh)
        let same = true
        for (let i = 1; i < win.length && same; i++) if (win[i] !== win[0]) same = false
        const onEdge = (tx + 1) * TILE > width || (ty + 1) * TILE > height
        if (same && !onEdge) {
          if (win[0] > 0) entries.push([tx, ty, uniformCover(store, win[0])])
          continue
        }
      }
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          if (tx * TILE + x >= width || ty * TILE + y >= height) continue
          const dx = tx * TILE + x + 0.5
          const dy = ty * TILE + y + 0.5
          const px = inv[0] * dx + inv[2] * dy + inv[4] - 0.5
          const py = inv[1] * dx + inv[3] * dy + inv[5] - 0.5
          if (win) v[y * TILE + x] = bilinear(win, sw, sh, px - sx0, py - sy0)
          else {
            const ix = Math.floor(px)
            const iy = Math.floor(py)
            const fx = px - ix
            const fy = py - iy
            const a = await reader.at(ix, iy)
            const b = await reader.at(ix + 1, iy)
            const c = await reader.at(ix, iy + 1)
            const d = await reader.at(ix + 1, iy + 1)
            v[y * TILE + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
          }
        }
      }
      const t = coverTile(store, v)
      if (t !== null) entries.push([tx, ty, t])
    }
  }
  return store.createSet(COVER, entries)
}

/**
 * A selection with a window of it replaced: `values` is w × h coverage at
 * (x0, y0), at the canvas's size or (with `shift`) 2^shift smaller, read
 * bilinearly. Tiles the window doesn't touch are shared.
 */
export async function pasteWindow(store: TileStore, set: SetId | null, x0: number, y0: number, w: number, h: number, values: Float32Array, width: number, height: number, shift = 0, torus: Torus | null = null): Promise<SetId> {
  const s = 2 ** shift
  // On a torus, a window past an edge is pasted in pieces, each where it wraps to.
  if (wraps(torus) && !shift && (x0 < 0 || y0 < 0 || x0 + w > width || y0 + h > height)) {
    let out = set
    const pieces = (start: number, len: number, size: number, on: boolean): [number, number, number][] => {
      if (!on) return [[start, start, len]]
      const r: [number, number, number][] = []
      for (let at = start; at < start + len; ) {
        const end = Math.min(start + len, (Math.floor(at / size) + 1) * size)
        r.push([at, mod(at, size), end - at])
        at = end
      }
      return r
    }
    for (const [ay, sy, ph] of pieces(y0, h, height, torus.y))
      for (const [ax, sx, pw] of pieces(x0, w, width, torus.x)) {
        const piece = new Float32Array(pw * ph)
        for (let y = 0; y < ph; y++) piece.set(values.subarray((ay - y0 + y) * w + (ax - x0), (ay - y0 + y) * w + (ax - x0) + pw), y * pw)
        out = await pasteWindow(store, out, sx, sy, pw, ph, piece, width, height)
      }
    return out ?? store.createSet(COVER, [])
  }
  // The window in canvas pixels.
  const cx0 = Math.max(0, x0 * s)
  const cy0 = Math.max(0, y0 * s)
  const cx1 = Math.min(width, (x0 + w) * s)
  const cy1 = Math.min(height, (y0 + h) * s)
  const reader = new CoverReader(store, set)
  const changes: [number, number, TileId | null][] = []
  for (let ty = Math.floor(cy0 / TILE); ty <= Math.floor((cy1 - 1) / TILE); ty++) {
    for (let tx = Math.floor(cx0 / TILE); tx <= Math.floor((cx1 - 1) / TILE); tx++) {
      const v = await reader.window(tx * TILE, ty * TILE, TILE, TILE)
      for (let y = Math.max(cy0, ty * TILE); y < Math.min(cy1, (ty + 1) * TILE); y++) {
        for (let x = Math.max(cx0, tx * TILE); x < Math.min(cx1, (tx + 1) * TILE); x++) {
          const i = (y - ty * TILE) * TILE + (x - tx * TILE)
          v[i] = shift ? bilinear(values, w, h, (x + 0.5) / s - 0.5 - x0, (y + 0.5) / s - 0.5 - y0) : values[(y - y0) * w + (x - x0)]
        }
      }
      changes.push([tx, ty, coverTile(store, v)])
    }
  }
  if (set) return store.derive(set, changes)
  return store.createSet(COVER, changes.filter((c): c is [number, number, TileId] => c[2] !== null))
}

// --- pixels through coverage ---------------------------------------------------------------

/** A layer pixel to document pixels: where a layer's pixel (x, y) is in the document. */
type Affine = number[]

/**
 * The coverage each pixel of layer tile (tx, ty) sees: the value at the
 * coverage pixel its centre lands on through `m` (layer pixels to coverage
 * pixels). Read as one window, so a tile costs one pass, not 65,536 reads.
 */
export async function coverForTile(reader: CoverReader, m: number[], tx: number, ty: number): Promise<Float32Array> {
  const pts = [
    [0, 0],
    [TILE, 0],
    [0, TILE],
    [TILE, TILE],
  ].map(([x, y]) => [m[0] * (tx * TILE + x) + m[2] * (ty * TILE + y) + m[4], m[1] * (tx * TILE + x) + m[3] * (ty * TILE + y) + m[5]])
  const x0 = Math.floor(Math.min(...pts.map((p) => p[0]))) - 1
  const y0 = Math.floor(Math.min(...pts.map((p) => p[1]))) - 1
  const w = Math.floor(Math.max(...pts.map((p) => p[0]))) + 2 - x0
  const h = Math.floor(Math.max(...pts.map((p) => p[1]))) + 2 - y0
  const out = new Float32Array(TILE_PIXELS)
  const big = w * h > 16 * TILE_PIXELS
  const win = big ? null : await reader.window(x0, y0, w, h)
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const px = tx * TILE + x + 0.5
      const py = ty * TILE + y + 0.5
      const cx = Math.floor(m[0] * px + m[2] * py + m[4])
      const cy = Math.floor(m[1] * px + m[3] * py + m[5])
      out[y * TILE + x] = win ? win[(cy - y0) * w + (cx - x0)] : await reader.at(cx, cy)
    }
  }
  return out
}

/**
 * A pixel layer's tiles with `value` laid on (or, with `value` null, its
 * pixels cleared) as much as `cover` covers each pixel, in document pixels
 * through the layer's transform `t`. Fill and Delete with a selection, and
 * Apply Layer Mask (clearing by the mask's uncovered part). Returns the new
 * set; untouched tiles are shared.
 */
export async function throughCover(
  store: TileStore,
  layer: SetId | null,
  f: TileFormat,
  t: Affine,
  cover: CoverReader,
  coverBounds: [number, number, number, number],
  value: number[] | null,
  mode: 'fill' | 'clear',
): Promise<SetId> {
  const planes = value ? value.length : f.mode === 'rgb' ? 4 : f.mode === 'gray' ? 2 : 5
  const max = f.depth === 16 ? 65535 : 255
  const det = t[0] * t[3] - t[1] * t[2] || 1e-12
  const inv = [t[3] / det, -t[1] / det, -t[2] / det, t[0] / det, (t[2] * t[5] - t[3] * t[4]) / det, (t[1] * t[4] - t[0] * t[5]) / det]
  // The cover's rectangle in layer pixels: the tiles to visit.
  const corners = [
    [coverBounds[0], coverBounds[1]],
    [coverBounds[2], coverBounds[1]],
    [coverBounds[0], coverBounds[3]],
    [coverBounds[2], coverBounds[3]],
  ].map(([x, y]) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]])
  const lx0 = Math.floor(Math.min(...corners.map((c) => c[0])) / TILE)
  const ly0 = Math.floor(Math.min(...corners.map((c) => c[1])) / TILE)
  const lx1 = Math.floor(Math.max(...corners.map((c) => c[0])) / TILE)
  const ly1 = Math.floor(Math.max(...corners.map((c) => c[1])) / TILE)
  const changes: [number, number, TileId | null][] = []
  for (let ty = ly0; ty <= ly1; ty++) {
    for (let tx = lx0; tx <= lx1; tx++) {
      const old = layer ? store.tileAt(layer, tx, ty) : undefined
      const src: Samples = old !== undefined ? await store.samples(old) : newSamples(f)
      const out = newSamples(f)
      out.set(src)
      let changed = false
      const ks = await coverForTile(cover, t, tx, ty)
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const i = y * TILE + x
          const k = ks[i]
          if (k <= 0) continue
          const a = src[(planes - 1) * TILE_PIXELS + i] / max
          if (mode === 'clear') {
            out[(planes - 1) * TILE_PIXELS + i] = Math.round(a * (1 - k) * max)
          } else {
            const a2 = a + (1 - a) * k
            for (let c = 0; c < planes - 1; c++) {
              const sv = src[c * TILE_PIXELS + i] / max
              out[c * TILE_PIXELS + i] = Math.round(((sv * a * (1 - k) + (value![c] / max) * k) / a2) * max)
            }
            out[(planes - 1) * TILE_PIXELS + i] = Math.round(a2 * max)
          }
          changed = true
        }
      }
      if (!changed) continue
      const alpha = out.subarray((planes - 1) * TILE_PIXELS)
      changes.push([tx, ty, alpha.every((v) => v === 0) ? null : store.data(f, out)])
    }
  }
  if (layer) return changes.length ? store.derive(layer, changes) : layer
  return store.createSet(f, changes.filter((c): c is [number, number, TileId] => c[2] !== null))
}

export interface MaskSpec {
  tiles: SetId | null
  /** Mask pixels to document pixels. */
  transform: Affine
  outside: number
  invert: boolean
  density: number
  feather: number
}

/**
 * Apply Layer Mask: a pixel layer's alpha multiplied by its mask, as the
 * canvas shows it (feather, invert and density included), the layer's
 * pixels looked up in the mask through both transforms. Returns the new
 * set: tiles the mask leaves whole are shared, and tiles it hides go.
 */
export async function applyMask(store: TileStore, layer: SetId, f: TileFormat, t: Affine, mask: MaskSpec, width: number, height: number): Promise<SetId> {
  const planes = f.mode === 'rgb' ? 4 : f.mode === 'gray' ? 2 : 5
  let set = mask.tiles
  if (set && mask.feather > 0) {
    const e = store.extent(set)
    if (e) set = await feather(store, set, mask.feather, Math.max(width, (e.x1 + 1) * TILE), Math.max(height, (e.y1 + 1) * TILE), mask.outside)
  }
  const reader = new CoverReader(store, set, mask.outside)
  const mi = invertAffine(mask.transform)
  // Layer pixel to mask pixel.
  const m = [
    mi[0] * t[0] + mi[2] * t[1],
    mi[1] * t[0] + mi[3] * t[1],
    mi[0] * t[2] + mi[2] * t[3],
    mi[1] * t[2] + mi[3] * t[3],
    mi[0] * t[4] + mi[2] * t[5] + mi[4],
    mi[1] * t[4] + mi[3] * t[5] + mi[5],
  ]
  const finish = (v: number) => {
    const c = mask.invert ? 1 - v : v
    return 1 - mask.density * (1 - c)
  }
  const changes: [number, number, TileId | null][] = []
  for (const [key, id] of store.getSet(layer).tiles) {
    const [tx, ty] = key.split(',').map(Number)
    const src = await store.samples(id)
    const out = newSamples(f)
    out.set(src)
    let changed = false
    const ks = await coverForTile(reader, m, tx, ty)
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const i = y * TILE + x
        const a = src[(planes - 1) * TILE_PIXELS + i]
        if (!a) continue
        const k = finish(ks[i])
        if (k >= 1) continue
        out[(planes - 1) * TILE_PIXELS + i] = Math.round(a * Math.max(0, k))
        changed = true
      }
    }
    if (!changed) continue
    const alpha = out.subarray((planes - 1) * TILE_PIXELS)
    changes.push([tx, ty, alpha.every((v) => v === 0) ? null : store.data(f, out)])
  }
  return changes.length ? store.derive(layer, changes) : layer
}

function invertAffine(t: Affine): Affine {
  const det = t[0] * t[3] - t[1] * t[2] || 1e-12
  return [t[3] / det, -t[1] / det, -t[2] / det, t[0] / det, (t[2] * t[5] - t[3] * t[4]) / det, (t[1] * t[4] - t[0] * t[5]) / det]
}

/** Where a coverage set has anything, as a document rectangle [x0, y0, x1, y1), or null. */
export function coverBounds(store: TileStore, set: SetId): [number, number, number, number] | null {
  const e = store.extent(set)
  return e ? [e.x0 * TILE, e.y0 * TILE, (e.x1 + 1) * TILE, (e.y1 + 1) * TILE] : null
}

/**
 * The smallest rectangle holding every pixel of a set that isn't fully
 * transparent, in the set's own pixels, [x0, y0, x1, y1), or null: the box
 * Free Transform shows around a layer.
 */
export async function alphaBounds(store: TileStore, set: SetId): Promise<[number, number, number, number] | null> {
  const { format, tiles } = store.getSet(set)
  const planes = format.mode === 'rgb' ? 4 : format.mode === 'gray' ? 2 : 5
  let b: [number, number, number, number] | null = null
  const grow = (x0: number, y0: number, x1: number, y1: number) => {
    b = b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1]
  }
  for (const [key, id] of tiles) {
    const [tx, ty] = key.split(',').map(Number)
    const u = store.isUniform(id)
    if (u) {
      if (u[u.length - 1] > 0) grow(tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE)
      continue
    }
    // Only a tile that could widen the box needs reading.
    if (b && tx * TILE >= b[0] && ty * TILE >= b[1] && (tx + 1) * TILE <= b[2] && (ty + 1) * TILE <= b[3]) continue
    const s = await store.samples(id)
    const a = s.subarray((planes - 1) * TILE_PIXELS)
    let x0 = TILE
    let y0 = TILE
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        if (!a[y * TILE + x]) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        y1 = y
      }
    }
    if (x1 >= 0) grow(tx * TILE + x0, ty * TILE + y0, tx * TILE + x1 + 1, ty * TILE + y1 + 1)
  }
  return b
}

/**
 * What there is at pixel (x, y) of a set, in its own grid, from 0 to 1:
 * `alpha`, a layer's opacity there; `cover`, a mask's or a selection's gray
 * times its alpha, with `outside` where the set has no tile. For picking the
 * layer under the pointer (app/pick.ts).
 */
export async function valueAt(store: TileStore, set: SetId, x: number, y: number, kind: 'alpha' | 'cover', outside = 0): Promise<number> {
  const px = Math.floor(x)
  const py = Math.floor(y)
  const tx = Math.floor(px / TILE)
  const ty = Math.floor(py / TILE)
  const id = store.hasSet(set) ? store.tileAt(set, tx, ty) : undefined
  if (id === undefined) return kind === 'alpha' ? 0 : outside
  const f = store.formatOf(id)
  const max = f.depth === 16 ? 65535 : 255
  const planes = f.mode === 'rgb' ? 4 : f.mode === 'gray' ? 2 : 5
  const u = store.isUniform(id)
  const i = (py - ty * TILE) * TILE + (px - tx * TILE)
  const a = (u ? u[u.length - 1] : (await store.samples(id))[(planes - 1) * TILE_PIXELS + i]) / max
  if (kind === 'alpha') return a
  const g = (u ? u[0] : (await store.samples(id))[i]) / max
  return g * a + (1 - a) * outside
}
