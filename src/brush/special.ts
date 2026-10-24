/**
 * Bristle, erodible and airbrush tips (defs.ts `SpecialTip`). Each dab of
 * one is an ordinary dab of an image tip, so the GPU's stamp kernel and its
 * CPU reference paint it as they paint any other; what changes from dab to
 * dab is which image. The images are made here from their settings and a
 * level (how deep the bristles are pressed, how worn the tip is, which of
 * the spray's variants), named by all of them (`gen:…`), and made the same
 * wherever they're asked for: the page, the engine worker, the checks.
 * Nothing is sent between them.
 *
 * - A bristle tip is hairs, each a point of its own strength, laid out by
 *   its shape. Pressed to a depth, a hair touches once the depth reaches
 *   its length (a pointed brush's middle hairs are longest, so they touch
 *   first), and splays outward the further it's pressed, by its length
 *   and less the stiffer it is. Dabs close together draw each hair as a
 *   line, so the stroke streaks.
 * - An erodible tip's point, round and flat shapes are the round tip at a
 *   size, roundness and hardness its wear sets; its square and triangle are
 *   images whose corners round off as it wears. Wear grows with distance
 *   drawn, pressure and softness (`Wear`), and carries on from stroke to
 *   stroke until Sharpen Tip.
 * - An airbrush tip is a cone of paint (its hardness the cone's shoulder),
 *   grain in it, and drops round it: eight variants, one picked per dab.
 *   Tilted, it stretches and leans the way the pen leans.
 */
import { BRISTLE_SHAPES, ERODIBLE_SHAPES, type AirbrushTip, type BristleTip, type ErodibleTip, type SpecialTip, type TipId } from './defs'
import { rng } from './rng'

/** How many depths a bristle tip's footprint is made at. */
export const BRISTLE_LEVELS = 12
/** How many stages of wear a square or triangle erodible tip is made at. */
export const WEAR_LEVELS = 8
/** How many variants an airbrush's spray has. */
export const SPRAY_VARIANTS = 8
/** The generated images' size, a side. */
const N = 256

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
const pct = (v: number) => Math.round(v * 100)

// --- naming ------------------------------------------------------------------------------------------

export const bristleTipId = (t: BristleTip, level: number): TipId => `gen:b:${BRISTLE_SHAPES.indexOf(t.shape)}:${pct(t.bristles)}:${pct(t.length)}:${pct(t.thickness)}:${pct(t.stiffness)}:${level}`
export const erodibleTipId = (t: ErodibleTip, level: number): TipId => `gen:e:${ERODIBLE_SHAPES.indexOf(t.shape)}:${level}`
export const airbrushTipId = (t: AirbrushTip, variant: number): TipId => `gen:a:${pct(t.hardness)}:${pct(t.granularity)}:${pct(t.spatterSize)}:${pct(t.spatterAmount)}:${variant}`

export const isGeneratedTip = (id: TipId) => id.startsWith('gen:')

/** Whether an erodible shape is drawn by the round tip (its size, roundness and hardness worn) rather than an image. */
export const erodesRound = (t: ErodibleTip) => t.shape === 'point' || t.shape === 'round' || t.shape === 'flat'

/** The tip that stands for a special one where one picture is shown: the cursor, a thumbnail. */
export function representativeTip(t: SpecialTip, wear = 0): TipId {
  if (t.kind === 'bristle') return bristleTipId(t, BRISTLE_LEVELS - 1)
  if (t.kind === 'airbrush') return airbrushTipId(t, 0)
  return erodesRound(t) ? 'round' : erodibleTipId(t, Math.round(Math.min(1, wear) * (WEAR_LEVELS - 1)))
}

/** The tip the brush cursor outlines: the round tip's ring, except a square or triangle erodible tip as worn as it is. */
export const cursorTip = (t: SpecialTip, wear: number): TipId => (t.kind === 'erodible' && !erodesRound(t) ? representativeTip(t, wear) : 'round')

/** A generated tip's coverage, `N` × `N`, from its id; null when the id isn't one. */
export function generateTip(id: TipId): { size: number; data: Float32Array } | null {
  const f = id.split(':')
  const num = (i: number) => Number(f[i])
  if (f[0] !== 'gen' || f.slice(2).some((x) => !/^-?\d+$/.test(x))) return null
  if (f[1] === 'b' && f.length === 8) {
    const shape = BRISTLE_SHAPES[num(2)]
    if (!shape) return null
    return { size: N, data: bristleImage({ kind: 'bristle', shape, bristles: num(3) / 100, length: num(4) / 100, thickness: num(5) / 100, stiffness: num(6) / 100 }, Math.min(BRISTLE_LEVELS - 1, Math.max(0, num(7))) / (BRISTLE_LEVELS - 1)) }
  }
  if (f[1] === 'e' && f.length === 4) {
    const shape = ERODIBLE_SHAPES[num(2)]
    if (!shape) return null
    return { size: N, data: erodedImage(shape, Math.min(WEAR_LEVELS - 1, Math.max(0, num(3))) / (WEAR_LEVELS - 1)) }
  }
  if (f[1] === 'a' && f.length === 7) {
    return { size: N, data: sprayImage({ kind: 'airbrush', hardness: num(2) / 100, distortion: 0, granularity: num(3) / 100, spatterSize: num(4) / 100, spatterAmount: num(5) / 100 }, num(6)) }
  }
  return null
}

// --- bristles ------------------------------------------------------------------------------------------

interface Hair {
  /** Where it rests, in the footprint (−1..1 is the image). */
  x: number
  y: number
  /** 0..1: how far down it reaches; it touches once the depth is past 1 − this. */
  reach: number
  /** How much paint it lays, 0..1. */
  strength: number
}

/** Every hair's spread: the most a hair moves outward, as a share of where it rests. */
const splayOf = (t: BristleTip) => t.length * (1.15 - t.stiffness) * 0.45

function hairs(t: BristleTip): Hair[] {
  const n = Math.round(6 + t.bristles * 194)
  const shape = BRISTLE_SHAPES.indexOf(t.shape)
  const r = rng(9100 + shape * 977 + n)
  const flat = t.shape.startsWith('flat')
  const kind = t.shape.split('-')[1]
  // At rest the brush sits in the middle; fully splayed its outermost hairs reach the image's edge.
  const rest = 0.94 / (1 + splayOf(t))
  const out: Hair[] = []
  for (let i = 0; i < n; i++) {
    let x: number
    let y: number
    if (kind === 'fan') {
      // An arc of hairs, a little ragged.
      const a = ((i + 0.5) / n - 0.5) * 2.2 + (r() - 0.5) * 0.04
      x = Math.sin(a)
      y = (1 - Math.cos(a)) * 0.8 - 0.35 + (r() - 0.5) * 0.12
      if (flat) y *= 0.5
    } else {
      // Spread evenly over a disc (Vogel's spiral), a little jittered, then squashed for a flat brush.
      const rad = Math.sqrt((i + 0.5) / n)
      const a = i * 2.399963 + (r() - 0.5) * 0.5
      x = Math.cos(a) * rad
      y = Math.sin(a) * rad * (flat ? 0.28 : 1)
    }
    const rho = Math.min(1, Math.hypot(x, flat ? y / 0.28 : y))
    const jitter = r()
    const reach =
      kind === 'point' ? 1 - 0.65 * rho * rho : kind === 'curve' ? 1 - 0.3 * rho * rho : kind === 'angle' ? 1 - 0.55 * ((x + 1) / 2) : 1 - 0.06 * jitter
    out.push({ x: x * rest, y: y * rest, reach, strength: 0.5 + 0.5 * r() })
  }
  return out
}

/** A bristle tip pressed to `depth` (0..1). */
function bristleImage(t: BristleTip, depth: number): Float32Array {
  const out = new Float32Array(N * N)
  const list = hairs(t)
  const n = list.length
  const spread = splayOf(t)
  const rest = 0.94 / (1 + spread)
  // A hair's radius: thick hairs touch their neighbours at rest.
  const hairR = Math.max(0.006, (t.thickness * 1.6 * rest) / Math.sqrt(n))
  const d = 0.08 + 0.92 * depth
  for (const h of list) {
    const e = d - (1 - h.reach)
    if (e <= 0) continue
    // Pressed past touching, a hair splays outward, more as it's pressed further.
    const k = 1 + spread * Math.min(1, e / 0.7)
    const cx = h.x * k
    const cy = h.y * k
    const rad = hairR * (0.65 + 0.7 * Math.min(1, e * 3))
    const v = h.strength * Math.min(1, 0.35 + e * 3)
    const px = (cx + 1) * 0.5 * N
    const py = (cy + 1) * 0.5 * N
    const pr = Math.max(0.9, rad * 0.5 * N)
    for (let y = Math.max(0, Math.floor(py - pr - 1)); y < Math.min(N, Math.ceil(py + pr + 1)); y++)
      for (let x = Math.max(0, Math.floor(px - pr - 1)); x < Math.min(N, Math.ceil(px + pr + 1)); x++) {
        const dd = Math.hypot(x + 0.5 - px, y + 0.5 - py)
        const m = v * (1 - smooth(pr - 0.9, pr + 0.4, dd))
        const i = y * N + x
        if (m > out[i]) out[i] = m
      }
  }
  return out
}

// --- erodible -------------------------------------------------------------------------------------------

/** A square or a triangle, its corners rounded as it wears (0 sharp, 1 worn). */
function erodedImage(shape: string, wear: number): Float32Array {
  const out = new Float32Array(N * N)
  // A rounded polygon: the shape shrunk by the corner radius, then grown by it again, through a distance.
  const round = 0.04 + 0.5 * wear
  const edge = 1.5 / N
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = ((x + 0.5) / N) * 2 - 1
      const v = ((y + 0.5) / N) * 2 - 1
      let dist: number
      if (shape === 'square') {
        const h = 0.92 - round
        const qx = Math.abs(u) - h
        const qy = Math.abs(v) - h
        dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - round
      } else {
        // An equilateral triangle pointing up, its centre at the middle.
        const k = Math.sqrt(3)
        const s = 0.8 - round * 1.1
        let px = Math.abs(u) - s
        let py = -v + s / k
        if (px + k * py > 0) {
          const nx = (px - k * py) / 2
          const ny = (-k * px - py) / 2
          px = nx
          py = ny
        }
        px -= Math.min(Math.max(px, -2 * s), 0)
        dist = -Math.hypot(px, py) * Math.sign(py) - round
      }
      out[y * N + x] = 1 - smooth(-edge, edge, dist)
    }
  return out
}

/**
 * How worn an erodible tip gets: by distance drawn (in diameters), the
 * pressure it's drawn with and its softness. The engine's strokes and the
 * page (which keeps the wear between strokes) count it the same way.
 */
export class Wear {
  private last: { x: number; y: number } | null = null
  constructor(
    private tip: ErodibleTip | null,
    private size: number,
    public value: number,
  ) {}

  add(x: number, y: number, pressure: number) {
    if (this.tip && this.last) this.value = Math.min(1, this.value + (Math.hypot(x - this.last.x, y - this.last.y) / Math.max(1, this.size)) * pressure * this.tip.softness * 0.02)
    this.last = { x, y }
  }
}

// --- airbrush --------------------------------------------------------------------------------------------

/** One of a spray's variants: a soft cone, grain, and drops. */
function sprayImage(t: AirbrushTip, variant: number): Float32Array {
  const out = new Float32Array(N * N)
  const r = rng(7300 + variant * 131 + pct(t.spatterAmount) * 7 + pct(t.spatterSize))
  // Grain: value noise at about a hundredth of the spray, smoothed.
  const g = 96
  const grain = Array.from({ length: g * g }, r)
  const at = (x: number, y: number) => grain[(((y % g) + g) % g) * g + (((x % g) + g) % g)]
  const power = 1.7 - 1.5 * t.hardness
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = ((x + 0.5) / N) * 2 - 1
      const v = ((y + 0.5) / N) * 2 - 1
      const rad = Math.hypot(u, v)
      if (rad >= 1) continue
      let m = Math.pow(1 - smooth(0, 1, rad), power)
      if (t.granularity > 0) {
        const gx = ((x + 0.5) / N) * g
        const gy = ((y + 0.5) / N) * g
        const x0 = Math.floor(gx)
        const y0 = Math.floor(gy)
        const tx = gx - x0
        const ty = gy - y0
        const n = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
        m *= Math.min(1, Math.max(0, 1 - t.granularity + t.granularity * 2.2 * smooth(0.25, 0.85, n)))
      }
      out[y * N + x] = m
    }
  // Drops, thickest near the middle, a few far out.
  const drops = Math.round(t.spatterAmount * 70)
  for (let i = 0; i < drops; i++) {
    const a = r() * Math.PI * 2
    const gauss = Math.sqrt(-2 * Math.log(Math.max(1e-6, r()))) * 0.38
    const dist = Math.min(0.94, gauss)
    const dr = (0.004 + (0.006 + 0.03 * t.spatterSize) * r()) * N
    const px = (Math.cos(a) * dist + 1) * 0.5 * N
    const py = (Math.sin(a) * dist + 1) * 0.5 * N
    const val = 0.55 + 0.45 * r()
    for (let y = Math.max(0, Math.floor(py - dr - 1)); y < Math.min(N, Math.ceil(py + dr + 1)); y++)
      for (let x = Math.max(0, Math.floor(px - dr - 1)); x < Math.min(N, Math.ceil(px + dr + 1)); x++) {
        const m = val * (1 - smooth(dr - 0.8, dr + 0.4, Math.hypot(x + 0.5 - px, y + 0.5 - py)))
        const k = y * N + x
        if (m > out[k]) out[k] = m
      }
  }
  return out
}
