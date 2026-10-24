/**
 * Layer effects, worked out on the CPU: the reference the GPU kernels
 * (render/shaders/fx.ts) are held to, step for step.
 *
 * Everything starts from the layer's body: its content after its own
 * effects and masks, as a region of premultiplied working-space pixels
 * (filters/defs.ts's Region). From the body's alpha come planes (one number
 * a pixel): hardened by spread or choke, blurred by three box passes, or
 * turned into distances to the shape's edge by jump flooding. Each effect
 * makes a layer of colour and coverage from those; `composeFx` says where
 * each goes.
 */
import { gradientAt } from '../adjust/defs'
import { boxesFor, type Region } from '../filters/defs'
import type { GradientStop } from '../doc/params'
import { FX_BY_KIND, type FxKind } from './defs'
import { PATTERN_BY_ID, patternValue } from '../vector/patterns'
import { patternSample, type PatternImage } from '../vector/paint'
import { clamp01 as clamp } from '../lib/num'

export type Plane = Float64Array

export interface FxContext {
  /** 2^level: document pixels per pixel here. */
  scale: number
  mode: 'rgb' | 'gray' | 'cmyk'
  /** The layer's own bounds, in this region's pixels: what a gradient overlay spans. */
  bounds: [number, number, number, number]
  /** Where the region's top left is in the document, in document pixels: patterns are laid in the document's space. */
  origin?: [number, number]
  /** The document's patterns made from pixels, for Pattern Overlay. */
  pattern?: (id: string) => PatternImage | undefined
}

/** One effect's contribution: colour times coverage and coverage (premultiplied), where it goes, how it blends. */
export interface FxLayer {
  kind: FxKind
  place: 'below' | 'on' | 'over'
  px: Region
  blend: string
  /** Its opacity, 0..1. */
  k: number
}


// --- planes ------------------------------------------------------------------------------

/** The body's alpha, hardened: a / (1 − spread), clamped. Spread (or choke) is 0..1. */
function shapePlane(body: Region, spread: number): Plane {
  const { size, stride, data } = body
  const k = 1 / Math.max(1e-4, 1 - Math.min(0.99, spread))
  const out = new Float64Array(size * size)
  for (let i = 0; i < size * size; i++) out[i] = clamp(data[i * stride + stride - 1] * k)
  return out
}

/** One box pass over a plane, as filters/defs.ts boxPass, transparent outside. */
function boxPlane(p: Plane, size: number, r: number, horizontal: boolean): Plane {
  if (r <= 0) return p
  const out = new Float64Array(p.length)
  const n = 2 * r + 1
  for (let line = 0; line < size; line++) {
    const at = (i: number) => (horizontal ? line * size + i : i * size + line)
    let sum = 0
    for (let i = 0; i <= Math.min(r, size - 1); i++) sum += p[at(i)]
    for (let i = 0; i < size; i++) {
      out[at(i)] = sum / n
      if (i + r + 1 < size) sum += p[at(i + r + 1)]
      if (i - r >= 0) sum -= p[at(i - r)]
    }
  }
  return out
}

function gaussPlane(p: Plane, size: number, sigma: number): Plane {
  let r = p
  for (const b of boxesFor(sigma)) r = boxPlane(boxPlane(r, size, b, true), size, b, false)
  return r
}

/** A plane read between pixels, bilinear, transparent outside. */
function samplePlane(p: Plane, size: number, x: number, y: number): number {
  const at = (ix: number, iy: number) => (ix < 0 || iy < 0 || ix >= size || iy >= size ? 0 : p[iy * size + ix])
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
}

/**
 * Distance from each pixel to the nearest seed (a pixel inside the shape,
 * alpha ≥ ½, or with `inside`, outside it), by jump flooding: each pass
 * looks at nine pixels `step` apart and keeps the nearest seed any of them
 * knows, the steps halving, then one more pass of 1. Integer work, so the
 * GPU's answer is this one exactly. 1e9 where there's no seed at all.
 */
export function jumpFlood(body: Region, inside: boolean): Plane {
  const { size, stride, data } = body
  let seeds = new Int32Array(size * size)
  for (let i = 0; i < size * size; i++) {
    const isIn = data[i * stride + stride - 1] >= 0.5
    seeds[i] = isIn !== inside ? i : -1
  }
  let n = 1
  while (n < size) n *= 2
  const steps: number[] = []
  for (let k = n >> 1; k >= 1; k >>= 1) steps.push(k)
  steps.push(1)
  for (const k of steps) {
    const next = new Int32Array(size * size)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let best = -1
        let bestD = 0x7fffffff
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const qx = x + dx * k
            const qy = y + dy * k
            if (qx < 0 || qy < 0 || qx >= size || qy >= size) continue
            const s = seeds[qy * size + qx]
            if (s < 0) continue
            const sx = s % size
            const sy = (s - sx) / size
            const d = (sx - x) * (sx - x) + (sy - y) * (sy - y)
            if (d < bestD) {
              bestD = d
              best = s
            }
          }
        }
        next[y * size + x] = best
      }
    }
    seeds = next
  }
  const out = new Float64Array(size * size)
  for (let i = 0; i < size * size; i++) {
    const s = seeds[i]
    if (s < 0) {
      out[i] = 1e9
      continue
    }
    const x = i % size
    const y = (i - x) / size
    const sx = s % size
    const sy = (s - sx) / size
    out[i] = Math.sqrt((sx - x) * (sx - x) + (sy - y) * (sy - y))
  }
  return out
}

/** An effect's colour, in the working space (CMYK's inks as light). */
const working = (c: number[], mode: FxContext['mode']) => (mode === 'cmyk' ? c.map((v) => 1 - v) : c)

/** A layer of one colour at a coverage per pixel. */
function solid(size: number, stride: number, colour: number[], cov: (i: number) => number): Region {
  const data = new Float64Array(size * size * stride)
  for (let i = 0; i < size * size; i++) {
    const a = clamp(cov(i))
    for (let c = 0; c < stride - 1; c++) data[i * stride + c] = colour[c] * a
    data[i * stride + stride - 1] = a
  }
  return { size, stride, data }
}

/** Where light from `angle` degrees throws a shadow `distance` long: down and away from it. */
export const shadowOffset = (angle: number, distance: number): [number, number] => {
  const a = (angle * Math.PI) / 180
  return [-Math.cos(a) * distance, Math.sin(a) * distance]
}

/**
 * Each effect's layer, for a body region and effect settings (already
 * whole, from fxValues), in Photoshop's order.
 */
export function fxLayers(body: Region, list: { kind: string; v: Record<string, unknown> }[], ctx: FxContext): FxLayer[] {
  const { size, stride } = body
  const alpha = (i: number) => body.data[i * stride + stride - 1]
  const s = ctx.scale
  const out: FxLayer[] = []
  for (const { kind, v } of list) {
    const def = FX_BY_KIND.get(kind as FxKind)
    if (!def) continue
    const col = (key = 'colour') => working(v[key] as number[], ctx.mode)
    const opacity = (key = 'opacity') => (v[key] as number) / 100
    const at = (i: number): [number, number] => [i % size, Math.floor(i / size)]
    let px: Region
    let blend = v.blend as string
    let k = opacity()
    switch (kind as FxKind) {
      case 'drop-shadow': {
        const p = gaussPlane(shapePlane(body, (v.spread as number) / 100), size, (v.size as number) / s / 2)
        const [ox, oy] = shadowOffset(v.angle as number, (v.distance as number) / s)
        px = solid(size, stride, col(), (i) => {
          const [x, y] = at(i)
          return samplePlane(p, size, x - ox, y - oy)
        })
        break
      }
      case 'outer-glow': {
        const p = gaussPlane(shapePlane(body, (v.spread as number) / 100), size, (v.size as number) / s / 3)
        px = solid(size, stride, col(), (i) => p[i])
        break
      }
      case 'inner-shadow': {
        const p = gaussPlane(shapePlane(body, (v.choke as number) / 100), size, (v.size as number) / s / 2)
        const [ox, oy] = shadowOffset(v.angle as number, (v.distance as number) / s)
        px = solid(size, stride, col(), (i) => {
          const [x, y] = at(i)
          return alpha(i) * (1 - samplePlane(p, size, x - ox, y - oy))
        })
        break
      }
      case 'inner-glow': {
        const p = gaussPlane(shapePlane(body, (v.choke as number) / 100), size, (v.size as number) / s / 3)
        const centre = v.source === 'centre'
        px = solid(size, stride, col(), (i) => alpha(i) * (centre ? p[i] : 1 - p[i]))
        break
      }
      case 'satin': {
        const p = gaussPlane(shapePlane(body, 0), size, (v.size as number) / s / 2)
        const [ox, oy] = shadowOffset(v.angle as number, (v.distance as number) / s / 2)
        const inv = !!v.invert
        px = solid(size, stride, col(), (i) => {
          const [x, y] = at(i)
          const d = Math.abs(samplePlane(p, size, x + ox, y + oy) - samplePlane(p, size, x - ox, y - oy))
          return alpha(i) * (inv ? 1 - d : d)
        })
        break
      }
      case 'colour-overlay':
        px = solid(size, stride, col(), alpha)
        break
      case 'gradient-overlay': {
        const stops = v.gradient as GradientStop[]
        const a = ((v.angle as number) * Math.PI) / 180
        const dir = [Math.cos(a), -Math.sin(a)]
        const [bx0, by0, bx1, by1] = ctx.bounds
        const cx = (bx0 + bx1) / 2
        const cy = (by0 + by1) / 2
        const half = Math.max(1e-6, ((Math.abs((bx1 - bx0) * dir[0]) + Math.abs((by1 - by0) * dir[1])) / 2) * ((v.scale as number) / 100))
        const data = new Float64Array(size * size * stride)
        for (let i = 0; i < size * size; i++) {
          const [x, y] = at(i)
          let t = clamp(0.5 + ((x + 0.5 - cx) * dir[0] + (y + 0.5 - cy) * dir[1]) / (2 * half))
          if (v.reverse) t = 1 - t
          const c = working(gradientAt(stops, t), ctx.mode)
          const al = alpha(i)
          for (let k2 = 0; k2 < stride - 1; k2++) data[i * stride + k2] = c[k2] * al
          data[i * stride + stride - 1] = al
        }
        px = { size, stride, data }
        break
      }
      case 'pattern-overlay': {
        // A pattern of the document's: its own colours, premultiplied, at its size times the scale.
        const img = typeof v.image === 'string' && v.image ? ctx.pattern?.(v.image) : undefined
        if (img) {
          const a = ((v.angle as number) * Math.PI) / 180
          const kk = 100 / (v.imageScale as number)
          const cs = Math.cos(a) * kk
          const sn = Math.sin(a) * kk
          const [ox, oy] = ctx.origin ?? [0, 0]
          const data = new Float64Array(size * size * stride)
          for (let i = 0; i < size * size; i++) {
            const [x, y] = at(i)
            const dx = (x + 0.5) * s + ox
            const dy = (y + 0.5) * s + oy
            const p = patternSample(img, cs * dx + sn * dy, -sn * dx + cs * dy, s * kk)
            const al = alpha(i)
            for (let k2 = 0; k2 < stride - 1; k2++) data[i * stride + k2] = (p.c[k2] ?? 0) * al
            data[i * stride + stride - 1] = p.a * al
          }
          px = { size, stride, data }
          break
        }
        const fg = col()
        const bg = col('background')
        const ba = (v.backgroundOpacity as number) / 100
        const idx = PATTERN_BY_ID.get(v.pattern as string)?.index ?? 0
        const a = ((v.angle as number) * Math.PI) / 180
        const cs = Math.cos(a) / (v.scale as number)
        const sn = Math.sin(a) / (v.scale as number)
        const [ox, oy] = ctx.origin ?? [0, 0]
        const data = new Float64Array(size * size * stride)
        for (let i = 0; i < size * size; i++) {
          const [x, y] = at(i)
          // The pixel's centre in the document, into pattern cells turned by −angle.
          const dx = (x + 0.5) * s + ox
          const dy = (y + 0.5) * s + oy
          const pv = patternValue(idx, cs * dx + sn * dy, -sn * dx + cs * dy, s / (v.scale as number))
          const pa = ba * (1 - pv) + pv
          const al = alpha(i)
          for (let k2 = 0; k2 < stride - 1; k2++) data[i * stride + k2] = ((bg[k2] ?? 0) * ba * (1 - pv) + (fg[k2] ?? 0) * pv) * al
          data[i * stride + stride - 1] = pa * al
        }
        px = { size, stride, data }
        break
      }
      case 'bevel': {
        // A height from the blurred shape, lit from the angle and altitude.
        const h = gaussPlane(shapePlane(body, 0), size, ((v.size as number) + (v.soften as number)) / s / 2)
        const depth = ((v.depth as number) / 100) * ((v.size as number) / s) * (v.direction === 'down' ? -1 : 1)
        const a = ((v.angle as number) * Math.PI) / 180
        const alt = ((v.altitude as number) * Math.PI) / 180
        const L = [Math.cos(alt) * Math.cos(a), -Math.cos(alt) * Math.sin(a), Math.sin(alt)]
        const shade = new Float64Array(size * size)
        for (let i = 0; i < size * size; i++) {
          const [x, y] = at(i)
          const g = (ix: number, iy: number) => (ix < 0 || iy < 0 || ix >= size || iy >= size ? 0 : h[iy * size + ix])
          const gx = ((g(x + 1, y) - g(x - 1, y)) / 2) * depth
          const gy = ((g(x, y + 1) - g(x, y - 1)) / 2) * depth
          const len = Math.sqrt(gx * gx + gy * gy + 1)
          shade[i] = (-gx * L[0] - gy * L[1] + L[2]) / len - L[2]
        }
        const region = (i: number) => (v.style === 'inner' ? alpha(i) : v.style === 'outer' ? (1 - alpha(i)) * clamp(h[i] * 2) : clamp(h[i] * 2))
        out.push({ kind: 'bevel', place: 'on', px: solid(size, stride, col('highlightColour'), (i) => region(i) * clamp(shade[i] * 2)), blend: v.highlightBlend as string, k: opacity('highlightOpacity') })
        px = solid(size, stride, col('shadowColour'), (i) => region(i) * clamp(-shade[i] * 2))
        blend = v.shadowBlend as string
        k = opacity('shadowOpacity')
        break
      }
      case 'stroke': {
        const w = (v.size as number) / s
        const pos = v.position as string
        const dOut = pos === 'inside' ? null : jumpFlood(body, false)
        const dIn = pos === 'outside' ? null : jumpFlood(body, true)
        const reach = pos === 'centre' ? w / 2 : w
        px = solid(size, stride, col(), (i) => {
          const a = alpha(i)
          const outer = dOut ? (1 - a) * clamp(reach + 1 - dOut[i]) : 0
          const inner = dIn ? a * clamp(reach + 1 - dIn[i]) : 0
          return outer + inner
        })
        break
      }
      default:
        continue
    }
    out.push({ kind: kind as FxKind, place: def.place, px, blend, k })
  }
  return out
}
