/**
 * Photoshop's Distort filters as warps (ARCHITECTURE.md, "Warps"): Twirl,
 * Pinch, Spherize, Wave, Ripple, ZigZag, Polar Coordinates and Displace.
 * Each is a backward map in the node's own coordinates over a frame (the
 * unit square to the box of the layer's content when the filter was
 * added), so they turn and scale with the layer and follow it about.
 * Pure; check-geom runs them.
 */
import type { Box, Pt } from './path'

/** A frame's middle, half-sizes and its inverse, for the maps below. */
export interface Framed {
  cx: number
  cy: number
  rx: number
  ry: number
  /** The frame (unit square to node) and back. */
  f: number[]
  fi: number[]
}

export function framed(f: number[]): Framed {
  const d = f[0] * f[3] - f[1] * f[2] || 1e-12
  const fi = [f[3] / d, -f[1] / d, -f[2] / d, f[0] / d, (f[2] * f[5] - f[3] * f[4]) / d, (f[1] * f[4] - f[0] * f[5]) / d]
  return { cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, f, fi }
}

/** A map on the unit square (u, v) as one on the node: in through the frame's inverse, out through it. */
export function onFrame(fr: Framed, g: (u: number, v: number) => Pt | null): (x: number, y: number) => [number, number, number] | null {
  const { f, fi } = fr
  return (x, y) => {
    const u = fi[0] * x + fi[2] * y + fi[4]
    const v = fi[1] * x + fi[3] * y + fi[5]
    const s = g(u, v)
    if (!s) return null
    return [f[0] * s[0] + f[2] * s[1] + f[4], f[1] * s[0] + f[3] * s[1] + f[5], 1]
  }
}

/** The frame's pixel aspect: how many node units a unit of u is, over a unit of v (so circles stay round). */
export const aspectOf = (f: number[]) => Math.hypot(f[0], f[1]) / Math.max(1e-12, Math.hypot(f[2], f[3]))

/** Twirl: turned most at the middle, by `angle` degrees, not at all at the edge of the circle in the box. */
export function twirl(angle: number, aspect: number) {
  const a = (angle * Math.PI) / 180
  return (u: number, v: number): Pt => {
    // In a circle: u scaled by the aspect, so the twirl is round on the layer.
    const x = (u - 0.5) * aspect
    const y = v - 0.5
    const R = 0.5 * Math.min(aspect, 1)
    const r = Math.hypot(x, y)
    if (r >= R) return [u, v]
    const t = -a * (1 - r / R)
    const c = Math.cos(t)
    const s = Math.sin(t)
    return [0.5 + (x * c - y * s) / aspect, 0.5 + x * s + y * c]
  }
}

/** Pinch (amount −100..100): in towards the middle (positive) or out; nothing past the circle. */
export function pinch(amount: number, aspect: number) {
  const k = amount / 100
  return (u: number, v: number): Pt => {
    const x = (u - 0.5) * aspect
    const y = v - 0.5
    const R = 0.5 * Math.min(aspect, 1)
    const r = Math.hypot(x, y)
    if (r >= R || r <= 1e-12) return [u, v]
    const s = r / R
    // Read from further out to pinch (the middle shrinks), from nearer in to push out.
    const s2 = k >= 0 ? Math.pow(s, 1 - 0.5 * k) : Math.pow(s, 1 - 0.75 * k)
    const g = s2 / s
    return [0.5 + (x * g) / aspect, 0.5 + y * g]
  }
}

/** Spherize (amount −100..100): as if on a ball (positive) or in a bowl, across the ellipse in the box, or one way only. */
export function spherize(amount: number, mode: 'normal' | 'horizontal' | 'vertical') {
  const k = amount / 100
  const bend = (s: number) => (k >= 0 ? s + (s * s - s) * k : s + (Math.sqrt(s) - s) * -k)
  return (u: number, v: number): Pt => {
    const x = (u - 0.5) * 2
    const y = (v - 0.5) * 2
    if (mode === 'horizontal') return Math.abs(x) >= 1 ? [u, v] : [0.5 + (Math.sign(x) * bend(Math.abs(x))) / 2, v]
    if (mode === 'vertical') return Math.abs(y) >= 1 ? [u, v] : [u, 0.5 + (Math.sign(y) * bend(Math.abs(y))) / 2]
    const r = Math.hypot(x, y)
    if (r >= 1 || r <= 1e-12) return [u, v]
    const g = bend(r) / r
    return [0.5 + (x * g) / 2, 0.5 + (y * g) / 2]
  }
}

/** A wave's shape, −1..1, at a phase in turns. */
const shape = (kind: string, t: number) => {
  const p = t - Math.floor(t)
  if (kind === 'triangle') return p < 0.5 ? 4 * p - 1 : 3 - 4 * p
  if (kind === 'square') return p < 0.5 ? 1 : -1
  return Math.sin(2 * Math.PI * p)
}

/** A seeded random number generator: the same waves each time for a seed. */
function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

/**
 * Wave: `generators` waves of wavelengths and amplitudes between their
 * least and most (in node units), each its own phase from `seed`, moving
 * things across (by the vertical position) and down (by the horizontal),
 * scaled per axis.
 */
export function wave(o: { generators: number; wavelength: [number, number]; amplitude: [number, number]; scale: [number, number]; kind: string; seed: number }) {
  const r = rng(o.seed * 7919 + 13)
  const waves = Array.from({ length: Math.max(1, Math.round(o.generators)) }, () => ({
    l: Math.max(1, o.wavelength[0] + (o.wavelength[1] - o.wavelength[0]) * r()),
    a: o.amplitude[0] + (o.amplitude[1] - o.amplitude[0]) * r(),
    px: r(),
    py: r(),
  }))
  return (x: number, y: number): [number, number, number] => {
    let dx = 0
    let dy = 0
    for (const w of waves) {
      dx += w.a * shape(o.kind, y / w.l + w.px)
      dy += w.a * shape(o.kind, x / w.l + w.py)
    }
    return [x + (dx * o.scale[0]) / Math.max(1, waves.length), y + (dy * o.scale[1]) / Math.max(1, waves.length), 1]
  }
}

/** Ripple: small waves both ways, `amount` (−999..999) strong, of a size's wavelength (node units). */
export function ripple(amount: number, wavelength: number) {
  const a = (amount / 100) * wavelength * 0.15
  return (x: number, y: number): [number, number, number] => [x + a * Math.sin((2 * Math.PI * y) / wavelength), y + a * Math.sin((2 * Math.PI * x) / wavelength), 1]
}

/** ZigZag: ripples out from the middle, `ridges` of them, `amount` (−100..100) strong, out from it, round it, or as a pond's. */
export function zigzag(amount: number, ridges: number, style: string, aspect: number) {
  const k = amount / 100
  return (u: number, v: number): Pt => {
    const x = (u - 0.5) * aspect
    const y = v - 0.5
    const R = 0.5 * Math.min(aspect, 1)
    const r = Math.hypot(x, y)
    if (r >= R || r <= 1e-12) return [u, v]
    const s = r / R
    const w = Math.sin(2 * Math.PI * ridges * s) * (1 - s)
    let nx = x
    let ny = y
    if (style === 'around') {
      // Turned back and forth about the middle.
      const t = k * w * 0.6
      nx = x * Math.cos(t) - y * Math.sin(t)
      ny = x * Math.sin(t) + y * Math.cos(t)
    } else {
      const g = (s + k * w * 0.15) / s
      nx = x * g
      ny = y * g
      if (style === 'pond') {
        const t = k * w * 0.3
        ;[nx, ny] = [nx * Math.cos(t) - ny * Math.sin(t), nx * Math.sin(t) + ny * Math.cos(t)]
      }
    }
    return [0.5 + nx / aspect, 0.5 + ny]
  }
}

/** Polar Coordinates: the box wrapped round its middle (rectangular to polar), or unwrapped (polar to rectangular). */
export function polar(toPolar: boolean) {
  return (u: number, v: number): Pt => {
    if (toPolar) {
      // The top row at the middle, the bottom round the edge; the left edge straight up, going clockwise.
      const x = u - 0.5
      const y = v - 0.5
      const r = Math.hypot(x, y) / 0.5
      let t = Math.atan2(x, -y) / (2 * Math.PI)
      if (t < 0) t += 1
      return [t, r]
    }
    // Back: a column is a direction from the middle, a row a distance from it.
    const a = u * 2 * Math.PI
    const r = v * 0.5
    return [0.5 + r * Math.sin(a), 0.5 - r * Math.cos(a)]
  }
}

/** A displacement map: its colour at a point of the unit square, 0..1 per channel, from a pattern tiled or stretched over the box. */
export type MapSampler = (u: number, v: number) => number[]

/** Displace: each point read from as far as the map says, its first channel across, its second (or the first, for gray) down, by up to `scale` node units. */
export function displace(map: MapSampler, scale: [number, number], frame: number[]) {
  const fr = framed(frame)
  return (x: number, y: number): [number, number, number] => {
    const u = fr.fi[0] * x + fr.fi[2] * y + fr.fi[4]
    const v = fr.fi[1] * x + fr.fi[3] * y + fr.fi[5]
    const c = map(u, v)
    const h = c[0] ?? 0.5
    const vv = c.length > 2 ? c[1] : h
    return [x + (h - 0.5) * 2 * scale[0], y + (vv - 0.5) * 2 * scale[1], 1]
  }
}

/** Bounds for a map that keeps things in the frame's box (the radial ones): the box, or the rectangle given, whichever's bigger. */
export function frameBox(f: number[]): Box {
  const xs = [f[4], f[4] + f[0], f[4] + f[2], f[4] + f[0] + f[2]]
  const ys = [f[5], f[5] + f[1], f[5] + f[3], f[5] + f[1] + f[3]]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}
