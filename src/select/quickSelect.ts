/**
 * Quick Selection: a brush stroke grown out to the edges of what it touches.
 *
 * The selection is a graph cut over a window of the document round the
 * stroke. Every pixel is a node, tied to its 8 neighbours by links that are
 * cheap to cut where the colour changes sharply and dear where it doesn't,
 * and to two terminals by how much its colour looks like what was painted
 * (from a histogram of the stroke) or like what wasn't (from a histogram of
 * the unselected pixels away from it). The stroke and the selection there
 * already are are tied to the first terminal for good, unselected pixels on
 * the window's edge to the second, and the cheapest cut between the two is
 * the new edge: along the object's outline, where the links are cheap.
 * Boykov and Kolmogorov's max-flow finds it.
 *
 * Subtracting is the same thing turned inside out: what isn't selected
 * grows from the stroke, and the selection loses what it gains.
 *
 * A big window is cut at a smaller size first, then again at full size in a
 * band round the edge that gives, so the cost stays near a 512 × 512 cut.
 * Nothing here touches the DOM: it runs in the engine worker, and in the
 * checks, in Node.
 */

export interface QuickSelectInput {
  image: Uint8Array
  channels: number
  width: number
  height: number
  /** The selection as it is, over the window. */
  current: Float32Array
  /** 1 where the brush has painted in this drag so far, over the window. */
  stroke: Uint8Array
  mode: 'add' | 'subtract'
  /** Photoshop's Auto-Enhance: a smoother, less blocky edge. */
  autoEnhance: boolean
}

/** The most pixels cut in one go; a bigger window is cut smaller first. */
const MAX_PIXELS = 400 * 400

/** How dear a link between two pixels of the same colour is, against the colour models' say. */
const SMOOTH = 5

/**
 * The new selection over the window: for add, a superset of current ∪ stroke;
 * for subtract, a subset of current minus the stroke. Pixels on the window's
 * outermost ring keep their current values, so the caller can paste the
 * window back seamlessly.
 */
export function quickSelect(i: QuickSelectInput): Float32Array {
  const { width: w, height: h, current, stroke } = i
  const n = w * h
  const out = new Float32Array(n)
  const add = i.mode === 'add'
  let any = false
  for (let p = 0; p < n; p++) if (stroke[p]) any = true
  if (!any || w < 3 || h < 3) {
    out.set(current)
    return out
  }
  // What grows: the selection when adding, what isn't selected when taking away.
  const had = new Float32Array(n)
  for (let p = 0; p < n; p++) had[p] = add ? current[p] : 1 - current[p]
  const label = grow(labFeatures(i.image, i.channels, n), had, stroke, w, h)
  const v = i.autoEnhance ? enhance(label, w, h) : Float32Array.from(label)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        out[p] = current[p]
        continue
      }
      const g = Math.max(had[p], stroke[p] ? 1 : 0, v[p])
      out[p] = add ? g : 1 - g
    }
  }
  return out
}

// --- colour ---------------------------------------------------------------------

const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})

/** L*a*b*'s f(t) for t in 0..1.1, looked up: plenty fine enough for colour models. */
const LAB_F = Float32Array.from({ length: 4097 }, (_, i) => {
  const t = (i / 4096) * 1.1
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116
})
const labF = (t: number) => LAB_F[Math.min(4096, Math.max(0, Math.round((t / 1.1) * 4096)))]

/**
 * Each pixel as CIE L*a*b* (3 values), so distances are roughly what the eye
 * sees. Gray is gray, CMYK ink is turned to RGB the simple way, and a see-through
 * pixel is seen over mid-gray.
 */
function labFeatures(image: Uint8Array, channels: number, n: number): Float32Array {
  const out = new Float32Array(n * 3)
  const colours = channels - 1
  for (let p = 0; p < n; p++) {
    const o = p * channels
    const a = image[o + colours] / 255
    let r: number
    let g: number
    let b: number
    if (colours === 4) {
      const k = 1 - image[o + 3] / 255
      r = 255 * (1 - image[o] / 255) * k
      g = 255 * (1 - image[o + 1] / 255) * k
      b = 255 * (1 - image[o + 2] / 255) * k
    } else if (colours >= 3) {
      r = image[o]
      g = image[o + 1]
      b = image[o + 2]
    } else r = g = b = image[o]
    const lr = LINEAR[Math.round(r * a + 128 * (1 - a))]
    const lg = LINEAR[Math.round(g * a + 128 * (1 - a))]
    const lb = LINEAR[Math.round(b * a + 128 * (1 - a))]
    const fx = labF((0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047)
    const fy = labF(0.2126 * lr + 0.7152 * lg + 0.0722 * lb)
    const fz = labF((0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883)
    out[p * 3] = 116 * fy - 16
    out[p * 3 + 1] = 500 * (fx - fy)
    out[p * 3 + 2] = 200 * (fy - fz)
  }
  return out
}

/** Histogram bins along each of L*, a* and b*. */
const BINS = 16
const BIN_COUNT = BINS * BINS * BINS

function binOf(f: Float32Array, p: number): number {
  const q = (v: number, lo: number, hi: number) => Math.min(BINS - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * BINS)))
  return (q(f[p * 3], 0, 100) * BINS + q(f[p * 3 + 1], -64, 64)) * BINS + q(f[p * 3 + 2], -64, 64)
}

/** A colour model: a weighted histogram of L*a*b*, turned into a cost per bin (−ln of its probability). */
class ColourModel {
  private h = new Float64Array(BIN_COUNT)
  private total = 0

  add(bin: number, weight: number) {
    this.h[bin] += weight
    this.total += weight
  }

  /** Costs per bin: the histogram blurred a bin each way, so near colours count, and a little uniform mixed in, so no colour is impossible. */
  costs(): Float32Array {
    let h = this.h
    for (const stride of [1, BINS, BINS * BINS]) {
      const t = new Float64Array(BIN_COUNT)
      for (let i = 0; i < BIN_COUNT; i++) {
        const k = Math.floor(i / stride) % BINS
        t[i] = 2 * h[i] + (k > 0 ? h[i - stride] : h[i]) + (k < BINS - 1 ? h[i + stride] : h[i])
      }
      h = t
    }
    const out = new Float32Array(BIN_COUNT)
    const sum = this.total * 64
    for (let i = 0; i < BIN_COUNT; i++) out[i] = -Math.log((sum > 0 ? (0.97 * h[i]) / sum : 0) + 0.03 / BIN_COUNT)
    return out
  }
}

// --- growing a set from the stroke ---------------------------------------------------

/** Hard labels: free for the cut to decide, or tied to a side. */
const FREE = 0
const IN = 1
const OUT = 2

/** Distances (in pixels, a chamfer's estimate) from each pixel to the nearest one set in `mask`. */
function distanceTo(mask: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h)
  const far = 1e9
  for (let p = 0; p < w * h; p++) d[p] = mask[p] ? 0 : far
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      let v = d[p]
      if (x > 0) v = Math.min(v, d[p - 1] + 3)
      if (y > 0) {
        v = Math.min(v, d[p - w] + 3)
        if (x > 0) v = Math.min(v, d[p - w - 1] + 4)
        if (x < w - 1) v = Math.min(v, d[p - w + 1] + 4)
      }
      d[p] = v
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x
      let v = d[p]
      if (x < w - 1) v = Math.min(v, d[p + 1] + 3)
      if (y < h - 1) {
        v = Math.min(v, d[p + w] + 3)
        if (x < w - 1) v = Math.min(v, d[p + w + 1] + 4)
        if (x > 0) v = Math.min(v, d[p + w - 1] + 4)
      }
      d[p] = v
    }
  }
  for (let p = 0; p < w * h; p++) d[p] /= 3
  return d
}

/**
 * The set `had` grown from the stroke to the edges round it, hard 0/1: the
 * stroke and `had` itself (where at least half in) always, and only what
 * joins up with the stroke.
 */
function grow(feat: Float32Array, had: Float32Array, stroke: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h
  const hard = new Uint8Array(n)
  const notStroke = new Uint8Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      notStroke[p] = stroke[p] ? 0 : 1
      if (stroke[p] || had[p] >= 0.5) hard[p] = IN
      else if (x === 0 || y === 0 || x === w - 1 || y === h - 1) hard[p] = OUT
    }
  }
  const dist = distanceTo(stroke, w, h)
  // The brush's radius, near enough: how deep the stroke is at its deepest.
  const inner = distanceTo(notStroke, w, h)
  let radius = 1
  for (let p = 0; p < n; p++) if (inner[p] > radius) radius = inner[p]

  // What was painted, and the set as it is near it, against what isn't in the
  // set away from the stroke (all the more so on the window's edge).
  const bins = new Uint16Array(n)
  const fg = new ColourModel()
  const bg = new ColourModel()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const b = (bins[p] = binOf(feat, p))
      if (stroke[p]) fg.add(b, 1)
      else if (had[p] >= 0.5) fg.add(b, 0.3 * Math.exp(-dist[p] / (4 * radius)))
      else {
        const ring = x === 0 || y === 0 || x === w - 1 || y === h - 1 ? 1 : 0
        const wt = Math.min(1, Math.max(0, (dist[p] - 2 * radius) / (2 * radius))) + ring
        if (wt > 0) bg.add(b, wt)
      }
    }
  }
  const cin = fg.costs()
  const cout = bg.costs()

  let label: Uint8Array
  const f = Math.ceil(Math.sqrt(n / MAX_PIXELS))
  if (f <= 1) label = cut(feat, bins, w, h, hard, cin, cout, 1)
  else {
    // Cut a box-averaged copy, then cut again at full size in a band a cell
    // either side of the edge it found, everything else held to its side.
    const cw = Math.ceil(w / f)
    const ch = Math.ceil(h / f)
    const cfeat = new Float32Array(cw * ch * 3)
    const count = new Float32Array(cw * ch)
    const chard = new Uint8Array(cw * ch)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        const c = ((y / f) | 0) * cw + ((x / f) | 0)
        cfeat[c * 3] += feat[p * 3]
        cfeat[c * 3 + 1] += feat[p * 3 + 1]
        cfeat[c * 3 + 2] += feat[p * 3 + 2]
        count[c]++
        if (hard[p] === IN) chard[c] = IN
        else if (hard[p] === OUT && chard[c] !== IN) chard[c] = OUT
      }
    }
    const cbins = new Uint16Array(cw * ch)
    for (let c = 0; c < cw * ch; c++) {
      for (let k = 0; k < 3; k++) cfeat[c * 3 + k] /= count[c]
      cbins[c] = binOf(cfeat, c)
    }
    const coarse = cut(cfeat, cbins, cw, ch, chard, cin, cout, f)
    const band = new Uint8Array(cw * ch)
    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        const v = coarse[cy * cw + cx]
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = cx + dx
            const y = cy + dy
            if (x >= 0 && y >= 0 && x < cw && y < ch && coarse[y * cw + x] !== v) band[cy * cw + cx] = 1
          }
        }
      }
    }
    const fine = new Uint8Array(n)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        const c = ((y / f) | 0) * cw + ((x / f) | 0)
        fine[p] = hard[p] !== FREE ? hard[p] : band[c] ? FREE : coarse[c] ? IN : OUT
      }
    }
    label = cut(feat, bins, w, h, fine, cin, cout, 1)
  }
  return joined(label, stroke, w, h)
}

/** Only the part of `label` that joins up with the stroke (4-connected). */
function joined(label: Uint8Array, stroke: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  const stack: number[] = []
  for (let p = 0; p < w * h; p++) {
    if (stroke[p]) {
      out[p] = 1
      stack.push(p)
    }
  }
  while (stack.length) {
    const p = stack.pop()!
    const x = p % w
    const visit = (q: number) => {
      if (label[q] && !out[q]) {
        out[q] = 1
        stack.push(q)
      }
    }
    if (x > 0) visit(p - 1)
    if (x < w - 1) visit(p + 1)
    if (p >= w) visit(p - w)
    if (p < w * (h - 1)) visit(p + w)
  }
  return out
}

/** The 4 forward neighbours of a pixel among the 8 (right, down-left, down, down-right), and how near each is. */
const NX = [1, -1, 0, 1]
const NY = [0, 1, 1, 1]
const NEAR = [1, Math.SQRT1_2, 1, Math.SQRT1_2]

/**
 * The cut itself, over a grid of `w` × `h` cells with colours `feat`: 1 for
 * cells on the stroke's side. Cells tied by `hard` aren't nodes at all; a link
 * to one is folded into its neighbour's terminal link. `scale` is how many
 * pixels across a cell is (a cell stands for that many pixels' colour cost
 * along each link).
 */
function cut(feat: Float32Array, bins: Uint16Array, w: number, h: number, hard: Uint8Array, cin: Float32Array, cout: Float32Array, scale: number): Uint8Array {
  const n = w * h
  const label = new Uint8Array(n)
  const node = new Int32Array(n).fill(-1)
  let nodes = 0
  for (let p = 0; p < n; p++) {
    if (hard[p] === FREE) node[p] = nodes++
    else label[p] = hard[p] === IN ? 1 : 0
  }
  if (!nodes) return label

  // β from the mean squared colour step between neighbours, so the links suit the image's own contrast.
  let sum = 0
  let pairs = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (x < w - 1) {
        sum += step(feat, p, p + 1)
        pairs++
      }
      if (y < h - 1) {
        sum += step(feat, p, p + w)
        pairs++
      }
    }
  }
  const beta = pairs && sum > 0 ? pairs / (2 * sum) : 0

  const g = new Graph(nodes, nodes * 8)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const a = node[p]
      if (a >= 0) {
        const b = bins[p]
        const ci = cin[b] * scale
        const co = cout[b] * scale
        const m = Math.min(ci, co)
        g.terminal(a, co - m, ci - m)
      }
      for (let k = 0; k < 4; k++) {
        const qx = x + NX[k]
        const qy = y + NY[k]
        if (qx < 0 || qx >= w || qy >= h) continue
        const q = qy * w + qx
        const b = node[q]
        if (a < 0 && b < 0) continue
        const wt = SMOOTH * NEAR[k] * Math.exp(-beta * step(feat, p, q))
        if (a >= 0 && b >= 0) g.edge(a, b, wt)
        else if (a >= 0) g.terminal(a, hard[q] === IN ? wt : 0, hard[q] === OUT ? wt : 0)
        else g.terminal(b, hard[p] === IN ? wt : 0, hard[p] === OUT ? wt : 0)
      }
    }
  }
  const side = g.solve()
  for (let p = 0; p < n; p++) if (node[p] >= 0) label[p] = side[node[p]]
  return label
}

function step(f: Float32Array, p: number, q: number): number {
  const a = f[p * 3] - f[q * 3]
  const b = f[p * 3 + 1] - f[q * 3 + 1]
  const c = f[p * 3 + 2] - f[q * 3 + 2]
  return a * a + b * b + c * c
}

/** Auto-Enhance: the hard edge blurred about a pixel and sharpened back, so stair-steps round off into a soft, smooth edge. */
function enhance(label: Uint8Array, w: number, h: number): Float32Array {
  const v = Float32Array.from(label)
  const t = new Float32Array(w * h)
  const k = [0.06, 0.24, 0.4, 0.24, 0.06]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let i = -2; i <= 2; i++) s += k[i + 2] * v[y * w + Math.min(w - 1, Math.max(0, x + i))]
      t[y * w + x] = s
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let i = -2; i <= 2; i++) s += k[i + 2] * t[Math.min(h - 1, Math.max(0, y + i)) * w + x]
      v[y * w + x] = Math.min(1, Math.max(0, (s - 0.5) * 1.6 + 0.5))
    }
  }
  return v
}

// --- max-flow ---------------------------------------------------------------------------

const NONE = -1
const TERMINAL = -2
const ORPHAN = -3
const INFINITE = 1e9

/**
 * Boykov and Kolmogorov's max-flow: two search trees, one from each
 * terminal, grown until they meet, the path where they meet saturated, and
 * the trees mended from what's left of them rather than started again. Arcs
 * come in pairs, an arc and its reverse at a ^ 1.
 */
class Graph {
  private first: Int32Array
  private next: Int32Array
  private head: Int32Array
  private cap: Float32Array
  /** Each node's spare terminal capacity: to the source if positive, to the sink if negative. */
  private tr: Float64Array
  private arcs = 0

  constructor(
    private nodes: number,
    maxArcs: number,
  ) {
    this.first = new Int32Array(nodes).fill(-1)
    this.next = new Int32Array(maxArcs)
    this.head = new Int32Array(maxArcs)
    this.cap = new Float32Array(maxArcs)
    this.tr = new Float64Array(nodes)
  }

  edge(p: number, q: number, w: number) {
    const a = this.arcs
    this.arcs += 2
    this.head[a] = q
    this.cap[a] = w
    this.next[a] = this.first[p]
    this.first[p] = a
    this.head[a + 1] = p
    this.cap[a + 1] = w
    this.next[a + 1] = this.first[q]
    this.first[q] = a + 1
  }

  /** Links a node to the source and the sink; only the difference matters to the cut. */
  terminal(p: number, source: number, sink: number) {
    this.tr[p] += source - sink
  }

  /** Runs the flow to its maximum; 1 for each node left on the source's side of the cut. */
  solve(): Uint8Array {
    const { nodes: n, first, next, head, cap, tr } = this
    const parent = new Int32Array(n).fill(NONE)
    const sink = new Uint8Array(n)
    const ts = new Int32Array(n)
    const dist = new Int32Array(n)
    const queued = new Uint8Array(n)
    const qnext = new Int32Array(n)
    let qhead = -1
    let qtail = -1
    const activate = (i: number) => {
      if (queued[i]) return
      queued[i] = 1
      qnext[i] = -1
      if (qtail < 0) qhead = i
      else qnext[qtail] = i
      qtail = i
    }
    const orphans = new Int32Array(n + 1)
    let ohead = 0
    let otail = 0
    const orphan = (i: number) => {
      parent[i] = ORPHAN
      orphans[otail] = i
      otail = otail === n ? 0 : otail + 1
    }
    for (let i = 0; i < n; i++) {
      if (tr[i] === 0) continue
      sink[i] = tr[i] < 0 ? 1 : 0
      parent[i] = TERMINAL
      dist[i] = 1
      activate(i)
    }

    let time = 0
    let current = -1
    for (;;) {
      let i = current
      if (i >= 0) {
        queued[i] = 0
        if (parent[i] === NONE) i = -1
      }
      if (i < 0) {
        while (qhead >= 0) {
          const j = qhead
          qhead = qnext[j]
          if (qhead < 0) qtail = -1
          queued[j] = 0
          if (parent[j] !== NONE) {
            i = j
            break
          }
        }
        if (i < 0) break
      }

      // Grow i's tree by a step, or find where it meets the other.
      let meet = -1
      if (!sink[i]) {
        for (let e = first[i]; e >= 0; e = next[e]) {
          if (!(cap[e] > 0)) continue
          const j = head[e]
          if (parent[j] === NONE) {
            sink[j] = 0
            parent[j] = e ^ 1
            ts[j] = ts[i]
            dist[j] = dist[i] + 1
            activate(j)
          } else if (sink[j]) {
            meet = e
            break
          } else if (ts[j] <= ts[i] && dist[j] > dist[i]) {
            parent[j] = e ^ 1
            ts[j] = ts[i]
            dist[j] = dist[i] + 1
          }
        }
      } else {
        for (let e = first[i]; e >= 0; e = next[e]) {
          if (!(cap[e ^ 1] > 0)) continue
          const j = head[e]
          if (parent[j] === NONE) {
            sink[j] = 1
            parent[j] = e ^ 1
            ts[j] = ts[i]
            dist[j] = dist[i] + 1
            activate(j)
          } else if (!sink[j]) {
            meet = e ^ 1
            break
          } else if (ts[j] <= ts[i] && dist[j] > dist[i]) {
            parent[j] = e ^ 1
            ts[j] = ts[i]
            dist[j] = dist[i] + 1
          }
        }
      }
      time++
      if (meet < 0) {
        current = -1
        continue
      }
      // Keep growing from i next time round: it may have more to give.
      queued[i] = 1
      current = i

      // Push the path's bottleneck through it.
      let b = cap[meet]
      for (let j = head[meet ^ 1]; ; ) {
        const e = parent[j]
        if (e === TERMINAL) {
          b = Math.min(b, tr[j])
          break
        }
        b = Math.min(b, cap[e ^ 1])
        j = head[e]
      }
      for (let j = head[meet]; ; ) {
        const e = parent[j]
        if (e === TERMINAL) {
          b = Math.min(b, -tr[j])
          break
        }
        b = Math.min(b, cap[e])
        j = head[e]
      }
      cap[meet ^ 1] += b
      cap[meet] -= b
      for (let j = head[meet ^ 1]; ; ) {
        const e = parent[j]
        if (e === TERMINAL) {
          tr[j] -= b
          if (!(tr[j] > 0)) orphan(j)
          break
        }
        cap[e] += b
        cap[e ^ 1] -= b
        if (!(cap[e ^ 1] > 0)) orphan(j)
        j = head[e]
      }
      for (let j = head[meet]; ; ) {
        const e = parent[j]
        if (e === TERMINAL) {
          tr[j] += b
          if (!(tr[j] < 0)) orphan(j)
          break
        }
        cap[e ^ 1] += b
        cap[e] -= b
        if (!(cap[e] > 0)) orphan(j)
        j = head[e]
      }

      // Find each orphan a new parent in its own tree, or let it go.
      while (ohead !== otail) {
        const o = orphans[ohead]
        ohead = ohead === n ? 0 : ohead + 1
        const s = sink[o]
        let best = NONE
        let dmin = INFINITE
        for (let e0 = first[o]; e0 >= 0; e0 = next[e0]) {
          if (!((s ? cap[e0] : cap[e0 ^ 1]) > 0)) continue
          let j = head[e0]
          if (sink[j] !== s || parent[j] === NONE) continue
          let d = 0
          for (;;) {
            if (ts[j] === time) {
              d += dist[j]
              break
            }
            const e = parent[j]
            d++
            if (e === TERMINAL) {
              ts[j] = time
              dist[j] = 1
              break
            }
            if (e === ORPHAN) {
              d = INFINITE
              break
            }
            j = head[e]
          }
          if (d < INFINITE) {
            if (d < dmin) {
              best = e0
              dmin = d
            }
            for (j = head[e0]; ts[j] !== time; j = head[parent[j]]) {
              ts[j] = time
              dist[j] = d--
            }
          }
        }
        parent[o] = best
        if (best !== NONE) {
          ts[o] = time
          dist[o] = dmin + 1
          continue
        }
        for (let e0 = first[o]; e0 >= 0; e0 = next[e0]) {
          const j = head[e0]
          const e = parent[j]
          if (sink[j] !== s || e === NONE) continue
          if ((s ? cap[e0] : cap[e0 ^ 1]) > 0) activate(j)
          if (e !== TERMINAL && e !== ORPHAN && head[e] === o) orphan(j)
        }
      }
    }
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) out[i] = parent[i] !== NONE && !sink[i] ? 1 : 0
    return out
  }
}
