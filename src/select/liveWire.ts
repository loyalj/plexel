/**
 * The Magnetic Lasso's live wire: Mortensen and Barrett's intelligent scissors.
 *
 * Every step from a pixel to a neighbour has a cost, low along a strong
 * edge, and the wire is the cheapest path from the last anchor to the
 * pointer, found by Dijkstra's search in a corridor round the straight line
 * between them (Photoshop's Width). It runs on every pointer move, so the
 * edge costs are worked out lazily, block by block, as searches reach them:
 * a huge image costs only the parts the lasso goes near.
 *
 * Nothing here touches the DOM: it runs in the engine worker, and in the
 * checks, in Node.
 */

/** Pixels across a block of edge costs. */
const BLOCK = 64

/** A Sobel response to a full-scale step (4 × 255), so a step of contrast c (0..1) has strength c. */
const FULL = 4 * 255

interface Block {
  /** Edge strength, 0..1. */
  s: Float32Array
  /** The gradient's direction, a unit vector. */
  ux: Float32Array
  uy: Float32Array
  /** 1 where the strength is a peak across the edge (Canny's non-maximum suppression). */
  peak: Uint8Array
}

/** Edge costs over an image, worked out lazily in blocks, so a huge image costs only what's searched. */
export class EdgeMap {
  private blocks = new Map<number, Block>()
  private cols: number

  constructor(
    private image: Uint8Array,
    private channels: number,
    readonly width: number,
    readonly height: number,
  ) {
    this.cols = Math.ceil(width / BLOCK)
  }

  /** Edge strength 0..1 at a pixel (for the caller to snap a click to the strongest edge nearby). */
  strength(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0
    const b = this.block((x / BLOCK) | 0, (y / BLOCK) | 0)
    return b.s[(y % BLOCK) * BLOCK + (x % BLOCK)]
  }

  /** A rectangle's strengths, directions and peaks, copied out row by row for a search. */
  read(x0: number, y0: number, w: number, h: number, s: Float32Array, ux: Float32Array, uy: Float32Array, peak: Uint8Array) {
    for (let by = Math.floor(y0 / BLOCK); by <= Math.floor((y0 + h - 1) / BLOCK); by++) {
      for (let bx = Math.floor(x0 / BLOCK); bx <= Math.floor((x0 + w - 1) / BLOCK); bx++) {
        const b = this.block(bx, by)
        const ys = Math.max(y0, by * BLOCK)
        const ye = Math.min(y0 + h, (by + 1) * BLOCK)
        const xs = Math.max(x0, bx * BLOCK)
        const xe = Math.min(x0 + w, (bx + 1) * BLOCK)
        for (let y = ys; y < ye; y++) {
          const from = (y - by * BLOCK) * BLOCK + xs - bx * BLOCK
          const to = (y - y0) * w + xs - x0
          const len = xe - xs
          s.set(b.s.subarray(from, from + len), to)
          ux.set(b.ux.subarray(from, from + len), to)
          uy.set(b.uy.subarray(from, from + len), to)
          peak.set(b.peak.subarray(from, from + len), to)
        }
      }
    }
  }

  private block(bx: number, by: number): Block {
    const key = by * this.cols + bx
    const have = this.blocks.get(key)
    if (have) return have
    const b = this.compute(bx * BLOCK, by * BLOCK)
    this.blocks.set(key, b)
    return b
  }

  /**
   * Sobel gradients over the block and a pixel round it, each pixel taking the
   * colour channel (or alpha) that changes most; colour is weighed by alpha, so
   * what's under a see-through pixel doesn't count.
   */
  private compute(x0: number, y0: number): Block {
    const { image, channels: ch, width: W, height: H } = this
    const M = BLOCK + 2
    const g = new Float32Array(M * M)
    const gx = new Float32Array(M * M)
    const gy = new Float32Array(M * M)
    // The pixels the block's Sobel reads (two round it), a plane per channel, edges clamped.
    const N = M + 2
    const v = new Float32Array(N * N * ch)
    for (let j = 0; j < N; j++) {
      const y = Math.min(H - 1, Math.max(0, y0 + j - 2))
      for (let i = 0; i < N; i++) {
        const o = (y * W + Math.min(W - 1, Math.max(0, x0 + i - 2))) * ch
        const a = image[o + ch - 1]
        const q = j * N + i
        for (let c = 0; c < ch - 1; c++) v[c * N * N + q] = (image[o + c] * a) / 255
        v[(ch - 1) * N * N + q] = a
      }
    }
    for (let j = 0; j < M; j++) {
      if (y0 + j - 1 < 0 || y0 + j - 1 >= H) continue
      for (let i = 0; i < M; i++) {
        if (x0 + i - 1 < 0 || x0 + i - 1 >= W) continue
        let best = -1
        let bx = 0
        let by = 0
        for (let c = 0; c < ch; c++) {
          const t = c * N * N + j * N + i
          const a = v[t]
          const b = v[t + 1]
          const d = v[t + 2]
          const l = v[t + N]
          const r = v[t + N + 2]
          const e = v[t + 2 * N]
          const f = v[t + 2 * N + 1]
          const k = v[t + 2 * N + 2]
          const dx = d + 2 * r + k - a - 2 * l - e
          const dy = e + 2 * f + k - a - 2 * b - d
          const m = dx * dx + dy * dy
          if (m > best) {
            best = m
            bx = dx
            by = dy
          }
        }
        const m = Math.sqrt(best)
        const p = j * M + i
        g[p] = m
        if (m > 0) {
          gx[p] = bx / m
          gy[p] = by / m
        }
      }
    }
    const s = new Float32Array(BLOCK * BLOCK)
    const ux = new Float32Array(BLOCK * BLOCK)
    const uy = new Float32Array(BLOCK * BLOCK)
    const peak = new Uint8Array(BLOCK * BLOCK)
    for (let j = 0; j < BLOCK; j++) {
      if (y0 + j >= H) break
      for (let i = 0; i < BLOCK; i++) {
        if (x0 + i >= W) break
        const p = (j + 1) * M + i + 1
        const q = j * BLOCK + i
        s[q] = Math.min(1, g[p] / FULL)
        ux[q] = gx[p]
        uy[q] = gy[p]
        // A peak if no stronger than neither neighbour across the edge.
        const dx = Math.round(gx[p])
        const dy = Math.round(gy[p])
        const fwd = y0 + j + dy < 0 || y0 + j + dy >= H || x0 + i + dx < 0 || x0 + i + dx >= W ? 0 : g[p + dy * M + dx]
        const back = y0 + j - dy < 0 || y0 + j - dy >= H || x0 + i - dx < 0 || x0 + i - dx >= W ? 0 : g[p - dy * M - dx]
        peak[q] = g[p] > 0 && g[p] >= fwd && g[p] >= back ? 1 : 0
      }
    }
    return { s, ux, uy, peak }
  }
}

/** The pixel at most `radius` away from (x, y) with the strongest edge (the nearest of equals). */
export function snapToEdge(map: EdgeMap, x: number, y: number, radius: number): [number, number] {
  x = Math.min(map.width - 1, Math.max(0, Math.round(x)))
  y = Math.min(map.height - 1, Math.max(0, Math.round(y)))
  const r = Math.max(0, Math.round(radius))
  let best: [number, number] = [x, y]
  let bs = map.strength(x, y)
  let bd = 0
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = dx * dx + dy * dy
      if (d > r * r) continue
      const s = map.strength(x + dx, y + dy)
      if (s > bs || (s === bs && d < bd)) {
        best = [x + dx, y + dy]
        bs = s
        bd = d
      }
    }
  }
  return best
}

/** Mortensen and Barrett's weights for the zero-crossing (here, peak), gradient and direction terms. */
const WZ = 0.43
const WG = 0.43
const WD = 0.14
/** The most a step costs for being off the straight line, at the corridor's edge. */
const STRAIGHT = 0.05

/** The 8 steps to a neighbour. */
const SX = [1, -1, 0, 0, 1, -1, 1, -1]
const SY = [0, 0, 1, -1, 1, 1, -1, -1]

/**
 * The path from `from` to `to` (both inclusive, whole pixels) that follows the strongest edges,
 * searched within `width` pixels of the straight line between them (Photoshop's Width), ignoring edges
 * weaker than `contrast` (0..1, Photoshop's Edge Contrast).
 *
 * A step onto pixel q costs, per pixel of its length: WG × (1 − strength(q)), WZ unless q is a peak of an
 * edge (Canny's non-maximum suppression, which works on colour, in place of the Laplacian zero crossing),
 * WD × how far the step runs across the edge directions at both ends (a cheap stand-in for the
 * paper's arccosines), and a little for straying from the straight line. Edges under `contrast` count as no edge at all.
 */
export function liveWire(map: EdgeMap, from: [number, number], to: [number, number], o: { width: number; contrast: number }): [number, number][] {
  const W = map.width
  const H = map.height
  const clampX = (v: number) => Math.min(W - 1, Math.max(0, Math.round(v)))
  const clampY = (v: number) => Math.min(H - 1, Math.max(0, Math.round(v)))
  const fx = clampX(from[0])
  const fy = clampY(from[1])
  const tx = clampX(to[0])
  const ty = clampY(to[1])
  if (fx === tx && fy === ty) return [[fx, fy]]
  const hw = Math.max(1, o.width)
  const x0 = Math.max(0, Math.floor(Math.min(fx, tx) - hw))
  const y0 = Math.max(0, Math.floor(Math.min(fy, ty) - hw))
  const x1 = Math.min(W - 1, Math.ceil(Math.max(fx, tx) + hw))
  const y1 = Math.min(H - 1, Math.ceil(Math.max(fy, ty) + hw))
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  const n = w * h
  const s = new Float32Array(n)
  const ux = new Float32Array(n)
  const uy = new Float32Array(n)
  const peak = new Uint8Array(n)
  map.read(x0, y0, w, h, s, ux, uy, peak)

  // The corridor: pixels within the width of the segment, and how far off it each is.
  const inside = new Uint8Array(n)
  const away = new Float32Array(n)
  const sx = tx - fx
  const sy = ty - fy
  const len2 = sx * sx + sy * sy
  const hw2 = hw * hw
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + x0 - fx
      const py = y + y0 - fy
      const t = Math.min(1, Math.max(0, (px * sx + py * sy) / len2))
      const dx = px - t * sx
      const dy = py - t * sy
      const d2 = dx * dx + dy * dy
      if (d2 > hw2) continue
      inside[y * w + x] = 1
      away[y * w + x] = Math.sqrt(d2) / hw
    }
  }
  // What stepping onto each pixel costs, before direction. A touch more off
  // the straight line, so with no edge to follow the wire runs straight.
  const base = new Float32Array(n)
  for (let p = 0; p < n; p++) {
    const e = s[p] >= o.contrast && s[p] > 0
    base[p] = WG * (1 - (e ? s[p] : 0)) + (e && peak[p] ? 0 : WZ) + STRAIGHT * away[p]
    if (!e) {
      ux[p] = 0
      uy[p] = 0
    }
  }

  const dist = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const done = new Uint8Array(n)
  const heap = new Heap()
  const start = (fy - y0) * w + fx - x0
  const goal = (ty - y0) * w + tx - x0
  dist[start] = 0
  heap.push(start, 0)
  while (heap.size) {
    const p = heap.pop()
    if (done[p]) continue
    done[p] = 1
    if (p === goal) break
    const px = p % w
    const py = (p / w) | 0
    const dp = dist[p]
    // The edge's direction at p (along the edge, across the gradient).
    const ex = -uy[p]
    const ey = ux[p]
    for (let k = 0; k < 8; k++) {
      const dx = SX[k]
      const dy = SY[k]
      const qx = px + dx
      const qy = py + dy
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue
      const q = qy * w + qx
      if (done[q] || !inside[q]) continue
      const diag = dx !== 0 && dy !== 0
      const l = diag ? Math.SQRT2 : 1
      let lx = dx / l
      let ly = dy / l
      let a = ex * lx + ey * ly
      if (a < 0) {
        lx = -lx
        ly = -ly
        a = -a
      }
      const b = -uy[q] * lx + ux[q] * ly
      const fd = ex === 0 && ey === 0 ? 0.5 : (2 - a - b) / 3
      const c = dp + l * (base[q] + WD * fd)
      if (c < dist[q]) {
        dist[q] = c
        prev[q] = p
        heap.push(q, c)
      }
    }
  }
  const path: [number, number][] = []
  for (let p = goal; p >= 0; p = prev[p]) path.push([(p % w) + x0, ((p / w) | 0) + y0])
  if (path[path.length - 1][0] !== fx || path[path.length - 1][1] !== fy) return [[fx, fy], [tx, ty]]
  return path.reverse()
}

/** A binary min-heap of pixel indices by cost; stale entries are skipped by the caller. */
class Heap {
  private keys = new Float64Array(1024)
  private vals = new Int32Array(1024)
  size = 0

  push(v: number, k: number) {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2)
      const vals = new Int32Array(this.size * 2)
      keys.set(this.keys)
      vals.set(this.vals)
      this.keys = keys
      this.vals = vals
    }
    let i = this.size++
    while (i > 0) {
      const up = (i - 1) >> 1
      if (this.keys[up] <= k) break
      this.keys[i] = this.keys[up]
      this.vals[i] = this.vals[up]
      i = up
    }
    this.keys[i] = k
    this.vals[i] = v
  }

  pop(): number {
    const top = this.vals[0]
    const n = --this.size
    const k = this.keys[n]
    const v = this.vals[n]
    let i = 0
    for (;;) {
      let c = 2 * i + 1
      if (c >= n) break
      if (c + 1 < n && this.keys[c + 1] < this.keys[c]) c++
      if (this.keys[c] >= k) break
      this.keys[i] = this.keys[c]
      this.vals[i] = this.vals[c]
      i = c
    }
    this.keys[i] = k
    this.vals[i] = v
    return top
  }
}

/**
 * Where the Magnetic Lasso should fix an anchor of its own as the pointer moves: an index into `path`
 * (the live wire from the last anchor to the pointer), or -1 for none yet. `frequency` is Photoshop's
 * 0..100: higher puts anchors closer together, from about 200 pixels of path apart at 0 to 10 at 100.
 * With `previous` (the wire the last pointer move gave), only the stretch both share counts: a part of
 * the wire that held still while the pointer moved has settled, so an anchor there won't jump about.
 * The caller fixes an anchor at that index and starts the next wire from it.
 */
export function stableAnchor(path: [number, number][], frequency: number, previous?: [number, number][]): number {
  const spacing = 10 + (100 - Math.min(100, Math.max(0, frequency))) * 1.9
  let n = path.length
  if (previous) {
    let k = 0
    while (k < n && k < previous.length && previous[k][0] === path[k][0] && previous[k][1] === path[k][1]) k++
    n = k
  }
  let along = 0
  for (let i = 1; i < n; i++) {
    const dx = path[i][0] - path[i - 1][0]
    const dy = path[i][1] - path[i - 1][1]
    along += dx && dy ? Math.SQRT2 : 1
    if (along >= spacing) return i
  }
  return -1
}
