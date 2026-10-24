/**
 * From pen samples to dabs: the brush engine's placement, in document
 * pixels, as plain TypeScript (it runs in the engine worker, and in Node
 * for the checks).
 *
 * Samples are smoothed first: by default each new point moves only part of
 * the way to the pen (`smoothing` lags the stroke behind it, which steadies
 * a shaky hand); with a pulled string, the stroke stays put until the pen
 * is further away than the string, then follows at that distance. Then
 * dabs are laid along the smoothed path a set distance apart: `spacing`
 * times the diameter at that point, so a stroke that thins under light
 * pressure keeps its dabs as close as its size needs. Every attribute is
 * interpolated between samples, and every random choice comes from one
 * seeded generator, so the same samples and seed always make the same dabs.
 *
 * Photoshop's sections each add to a dab: Shape Dynamics its size, angle,
 * roundness and flips; Scattering where it lands and how many land;
 * Texture its depth; Colour Dynamics its colour; Transfer its opacity and
 * flow (and the Mixer Brush's wetness and mix). A Dual Brush lays its own
 * dabs along the same path, marked `dual`. Build-up adds dabs where the
 * pen rests, as time passes (`tick`).
 */
import { curveAt, type BrushSettings, type DynInput, type DynTarget } from './defs'
import type { Dab } from './dab'
import { rng } from './rng'
import { BRISTLE_LEVELS, SPRAY_VARIANTS, WEAR_LEVELS, Wear, airbrushTipId, bristleTipId, erodibleTipId } from './special'

export interface PenSample {
  /** Document pixels. */
  x: number
  y: number
  /** 0..1, after the pressure curve. A mouse is 0.5 while a button is down. */
  pressure: number
  /** Degrees, −90..90 each. */
  tiltX: number
  tiltY: number
  /** Degrees, 0..359. */
  twist: number
  /** An airbrush pen's finger wheel, 0..1; absent (a pen without one) is 1. */
  wheel?: number
  /** Milliseconds. */
  t: number
}

/** Pen speed that counts as full speed, in document pixels per millisecond. */
const FULL_SPEED = 4
/** How often Build-up adds a dab where the pen rests, in milliseconds. */
export const BUILD_UP_MS = 25
/** A pulled string's length, at full smoothing, as a share of the brush's diameter. */
const STRING = 3

interface Point {
  x: number
  y: number
  pressure: number
  tilt: number
  /** Which way the pen leans, radians in the document (0 is to the right). */
  azimuth: number
  twist: number
  wheel: number
  speed: number
  /** Direction of travel, radians; NaN until the stroke has moved. */
  dir: number
}

export interface StrokeOptions {
  /** How worn an erodible tip is when the stroke begins, 0..1. */
  wear?: number
}

export class StrokeBuilder {
  private random: () => number
  private smoothed: Point | null = null
  private last: PenSample | null = null
  /** The path point dabs are measured from, and how far along it the next dab goes. */
  private from: Point | null = null
  private carry = 0
  private distance = 0
  /** Dabs so far, for Fade. */
  private count = 0
  private initialDir = NaN
  /** The dual brush's own walk along the same path. */
  private dualFrom: Point | null = null
  private dualCarry = 0
  /** Colour jitter picked once for the stroke, when it isn't per tip. */
  private strokeColour: Pick<Dab, 'colour' | 'hsb'> | null = null
  /** When the last dab went down, for Build-up. */
  private lastDabAt = 0
  /** The pen's rotation when the stroke began, for Initial Rotation. */
  private initialTwist = NaN
  /** An erodible tip's wear, growing as the stroke goes. */
  private wear: Wear

  constructor(
    private b: BrushSettings,
    seed: number,
    o: StrokeOptions = {},
  ) {
    this.random = rng(seed)
    this.wear = new Wear(b.special?.kind === 'erodible' ? b.special : null, b.size, o.wear ?? 0)
  }

  /** How worn an erodible tip is now. */
  get wearNow() {
    return this.wear.value
  }

  private input(p: Point, i: DynInput, steps = 25): number {
    switch (i) {
      case 'pressure':
        return p.pressure
      case 'tilt':
        return Math.min(1, p.tilt / 90)
      case 'twist':
        return p.twist / 360
      case 'wheel':
        return p.wheel
      case 'initial-twist':
        return (Number.isNaN(this.initialTwist) ? p.twist : this.initialTwist) / 360
      case 'speed':
        return Math.min(1, p.speed / FULL_SPEED)
      case 'distance':
        return Math.min(1, this.distance / 2000)
      case 'random':
        return this.random()
      case 'fade':
        // From full to nothing over its steps, as Photoshop's Fade.
        return Math.max(0, 1 - this.count / Math.max(1, steps))
      case 'direction':
        return Number.isNaN(p.dir) ? 0 : (((p.dir * 180) / Math.PI + 360) % 360) / 360
      case 'initial-direction':
        return Number.isNaN(this.initialDir) ? 0 : (((this.initialDir * 180) / Math.PI + 360) % 360) / 360
    }
  }

  /** The multiplier dynamics give a property at a point; for angle and hue, an added amount (degrees, turns). */
  private dyn(p: Point, target: DynTarget): number {
    const adds = target === 'angle' || target === 'hue'
    let k = adds ? 0 : 1
    for (const d of this.b.dynamics) {
      if (d.target !== target) continue
      const v = curveAt(d.curve, this.input(p, d.input, d.steps))
      if (target === 'angle') k += v * 360
      else if (target === 'hue') k += v
      else if (target === 'scatter' || target === 'colour' || target === 'count') k *= v
      else k *= d.min + (1 - d.min) * v
    }
    return k
  }

  private has(target: DynTarget) {
    return this.b.dynamics.some((d) => d.target === target)
  }

  private sizeAt(p: Point) {
    return Math.max(0.5, this.b.size * this.dyn(p, 'size'))
  }

  /** The dab, or dabs (Scattering's count), at a point on the path heading (dirX, dirY). */
  private dabs(p: Point, dirX: number, dirY: number): Dab[] {
    const b = this.b
    const r = this.random
    let n = b.count
    if (this.has('count')) n = Math.max(1, Math.round(n * this.dyn(p, 'count')))
    if (b.countJitter > 0) n = Math.max(1, Math.round(n * (1 - b.countJitter * r())))
    const out: Dab[] = []
    for (let i = 0; i < n; i++) out.push(this.dab(p, dirX, dirY))
    this.count++
    return out
  }

  private dab(p: Point, dirX: number, dirY: number): Dab {
    const b = this.b
    const r = this.random
    let size = this.sizeAt(p) * (1 - b.sizeJitter * r())
    size = Math.max(0.5, size)
    const angleDeg = b.angle + this.dyn(p, 'angle') + b.angleJitter * (r() - 0.5) * 360
    // Roundness: its control and jitter take it down, but never below the minimum.
    let round = 1
    if (this.has('roundness')) round *= this.dyn(p, 'roundness')
    if (b.roundnessJitter > 0) round *= 1 - b.roundnessJitter * r()
    if (round < 1) round = Math.max(b.minRoundness, round)
    const roundness = Math.max(0.01, b.roundness * round)
    const flipX = b.flipX !== (b.flipXJitter && r() < 0.5)
    const flipY = b.flipY !== (b.flipYJitter && r() < 0.5)
    const scatterDyn = this.has('scatter') ? this.dyn(p, 'scatter') : 1
    const spread = b.scatter * scatterDyn * size
    // Sideways from the direction of travel; with both axes, along it too.
    const len = Math.hypot(dirX, dirY) || 1
    const tx = dirX / len
    const ty = dirY / len
    const side = spread * (r() * 2 - 1)
    const along = b.scatterBothAxes ? spread * (r() * 2 - 1) : 0
    // Colour: foreground to background, and hue, saturation and brightness, per tip or once for the stroke.
    let colour = this.strokeColour
    if (!colour || b.colourPerTip) {
      const fb = this.has('colour') ? this.dyn(p, 'colour') : 0
      const hue = (this.has('hue') ? this.dyn(p, 'hue') : 0) + (b.hueJitter > 0 ? (r() * 2 - 1) * b.hueJitter * 0.5 : 0)
      const sat = (b.saturationJitter > 0 ? (r() * 2 - 1) * b.saturationJitter : 0) + (this.has('saturation') ? this.dyn(p, 'saturation') - 1 : 0)
      const bri = (b.brightnessJitter > 0 ? (r() * 2 - 1) * b.brightnessJitter : 0) + (this.has('brightness') ? this.dyn(p, 'brightness') - 1 : 0)
      colour = { colour: Math.min(1, Math.max(fb, b.colourJitter * r())), hsb: [hue, sat + b.purity, bri] }
      if (!b.colourPerTip) this.strokeColour = colour
    }
    // Texture depth, for a texture laid into each tip.
    let texDepth = 1
    const tex = b.texture
    if (tex?.eachTip) {
      let k = this.has('texture-depth') ? this.dyn(p, 'texture-depth') : 1
      if (tex.depthJitter > 0) k *= 1 - tex.depthJitter * r()
      if (k < 1) k = Math.max(tex.minDepth, k)
      texDepth = tex.depth * k
    }
    const dab: Dab = {
      x: p.x - ty * side + tx * along,
      y: p.y + tx * side + ty * along,
      size,
      angle: (angleDeg * Math.PI) / 180,
      roundness,
      flipX,
      flipY,
      hardness: Math.min(1, b.hardness * this.dyn(p, 'hardness')),
      opacity: Math.min(1, b.opacity * this.dyn(p, 'opacity') * (1 - b.opacityJitter * r())),
      flow: Math.min(1, b.flow * this.dyn(p, 'flow') * (1 - b.flowJitter * r())),
      colour: colour.colour,
      hsb: colour.hsb,
      tip: b.tip,
      texDepth,
      wet: Math.min(1, this.dyn(p, 'wetness') * (1 - b.wetnessJitter * r())),
      mix: Math.min(1, this.dyn(p, 'mix') * (1 - b.mixJitter * r())),
      grain: Math.floor(r() * 0x7fffffff),
      dual: false,
    }
    return b.special ? this.special(dab, p) : dab
  }

  /**
   * A bristle, erodible or airbrush tip: the footprint the pen's pressure,
   * tilt and the tip's wear call for (special.ts), and how it's stretched.
   */
  private special(d: Dab, p: Point): Dab {
    const s = this.b.special!
    const tilt = Math.min(1, p.tilt / 90)
    if (s.kind === 'bristle') {
      // Pressed and tilted, the hairs go deeper and splay; tilted, the footprint flattens too.
      const depth = Math.min(1, p.pressure * 0.8 + tilt * 0.35)
      const level = Math.round(depth * (BRISTLE_LEVELS - 1))
      return { ...d, tip: bristleTipId(s, level), roundness: d.roundness * (1 - 0.35 * tilt) }
    }
    if (s.kind === 'airbrush') {
      // Tilted, the spray stretches the way the pen leans and its middle moves that way.
      const k = s.distortion * tilt
      const lean = k * d.size * 0.3
      const variant = Math.floor(this.random() * SPRAY_VARIANTS)
      return {
        ...d,
        tip: airbrushTipId(s, variant),
        x: d.x + Math.cos(p.azimuth) * lean,
        y: d.y + Math.sin(p.azimuth) * lean,
        size: d.size * (1 + k * 0.6),
        roundness: d.roundness / (1 + k * 1.5),
        angle: tilt > 0 ? p.azimuth : d.angle,
      }
    }
    // Erodible: worn, it draws wider; pressed, deeper into the cone; tilted, with its side.
    const w = this.wear.value
    const side = tilt > 0 && (s.shape === 'point' || s.shape === 'round')
    let size = d.size
    let roundness = d.roundness
    let hardness = 0.9
    let tip = 'round'
    switch (s.shape) {
      case 'point':
        size *= 0.15 + 0.85 * Math.min(1, w + 0.35 * p.pressure)
        hardness = 0.95 - 0.35 * w
        break
      case 'round':
        size *= 0.5 + 0.5 * Math.min(1, w * 2 + 0.5 * p.pressure)
        hardness = 0.85
        break
      case 'flat':
        roundness *= 0.15 + 0.45 * Math.min(1, w)
        size *= 0.7 + 0.3 * p.pressure
        hardness = 0.95
        break
      default:
        size *= 0.6 + 0.4 * Math.min(1, w + 0.4 * p.pressure)
        tip = erodibleTipId(s, Math.round(w * (WEAR_LEVELS - 1)))
    }
    if (side) {
      size *= 1 + 0.8 * tilt
      roundness /= 1 + 1.5 * tilt
    }
    return { ...d, tip, size: Math.max(0.5, size), roundness: Math.max(0.01, roundness), hardness, angle: side ? p.azimuth : d.angle }
  }

  /** A dual brush's dab: its own tip, size and scatter; it only marks where the main stroke may show. */
  private dualDab(p: Point, dirX: number, dirY: number): Dab[] {
    const d = this.b.dual!
    const r = this.random
    const len = Math.hypot(dirX, dirY) || 1
    const tx = dirX / len
    const ty = dirY / len
    const out: Dab[] = []
    for (let i = 0; i < d.count; i++) {
      const spread = d.scatter * d.size
      const side = spread * (r() * 2 - 1)
      const along = d.bothAxes ? spread * (r() * 2 - 1) : 0
      out.push({
        x: p.x - ty * side + tx * along,
        y: p.y + tx * side + ty * along,
        size: d.size,
        angle: d.flip ? r() * Math.PI * 2 : 0,
        roundness: 1,
        flipX: d.flip && r() < 0.5,
        flipY: false,
        hardness: d.hardness,
        opacity: 1,
        flow: 1,
        colour: 0,
        hsb: [0, 0, 0],
        tip: d.tip,
        texDepth: 1,
        wet: 1,
        mix: 1,
        grain: 0,
        dual: true,
      })
    }
    return out
  }

  private point(s: PenSample, speed: number): Point {
    const pose = this.b.pose
    const tiltX = pose?.tiltX ?? s.tiltX
    const tiltY = pose?.tiltY ?? s.tiltY
    // The pen leans the way its tilts point: tiltX right, tiltY towards the user (down the page).
    return { x: s.x, y: s.y, pressure: pose?.pressure ?? s.pressure, tilt: Math.hypot(tiltX, tiltY), azimuth: Math.atan2(tiltY, tiltX), twist: pose?.rotation ?? s.twist, wheel: s.wheel ?? 1, speed, dir: NaN }
  }

  /** Adds a sample; returns the dabs it completes. */
  add(s: PenSample): Dab[] {
    const speed = this.last ? Math.hypot(s.x - this.last.x, s.y - this.last.y) / Math.max(1, s.t - this.last.t) : 0
    this.last = s
    const raw = this.point(s, speed)
    if (Number.isNaN(this.initialTwist)) this.initialTwist = raw.twist
    this.wear.add(raw.x, raw.y, raw.pressure)
    let p: Point
    if (!this.smoothed) p = raw
    else if (this.b.pulledString && this.b.smoothing > 0) {
      // The string: the stroke follows only what's past its length.
      const L = this.b.smoothing * STRING * this.b.size
      const dx = raw.x - this.smoothed.x
      const dy = raw.y - this.smoothed.y
      const d = Math.hypot(dx, dy)
      const k = d > L ? (d - L) / d : 0
      p = { ...raw, x: this.smoothed.x + dx * k, y: this.smoothed.y + dy * k }
    } else {
      // Lag: each new point moves only part of the way towards the pen.
      const k = 1 - this.b.smoothing
      p = {
        ...raw,
        x: this.smoothed.x + (raw.x - this.smoothed.x) * k,
        y: this.smoothed.y + (raw.y - this.smoothed.y) * k,
        pressure: this.smoothed.pressure + (raw.pressure - this.smoothed.pressure) * k,
      }
    }
    this.smoothed = p
    return this.walk(p, s.t)
  }

  /** Ends the stroke: the smoothed path catches up with where the pen lifted. */
  finish(): Dab[] {
    if (!this.last) return []
    const end: Point = { ...this.smoothed!, x: this.last.x, y: this.last.y }
    return this.smoothed && (this.smoothed.x !== end.x || this.smoothed.y !== end.y) ? this.walk(end, this.last.t) : []
  }

  /**
   * Time passing with the pen down (Build-up): a dab where the stroke is,
   * every BUILD_UP_MS since the last one, so paint keeps building where the
   * pen rests. `now` is in the samples' milliseconds.
   */
  tick(now: number): Dab[] {
    if (!this.b.buildUp || !this.from) return []
    const out: Dab[] = []
    while (now - this.lastDabAt >= BUILD_UP_MS) {
      this.lastDabAt += BUILD_UP_MS
      out.push(...this.dabs(this.from, Math.cos(this.from.dir || 0), Math.sin(this.from.dir || 0)))
    }
    return out
  }

  /** How far from one dab the next goes, given the size at the first. */
  private step(p: Point) {
    return Math.max(0.5, this.b.spacing * this.sizeAt(p))
  }

  /** Lays dabs from the last path point to `p`. `carry` is how far along the next dab is due. */
  private walk(p: Point, t: number): Dab[] {
    const out: Dab[] = []
    if (!this.from) {
      this.from = p
      out.push(...this.dabs(p, 1, 0))
      if (this.b.dual) {
        this.dualFrom = p
        out.push(...this.dualDab(p, 1, 0))
        this.dualCarry = Math.max(0.5, this.b.dual.spacing * this.b.dual.size)
      }
      this.carry = this.step(p)
      this.lastDabAt = t
      return out
    }
    const a = this.from
    const dx = p.x - a.x
    const dy = p.y - a.y
    const len = Math.hypot(dx, dy)
    if (len === 0) {
      this.from = { ...p, dir: a.dir }
      return out
    }
    const dir = Math.atan2(dy, dx)
    if (Number.isNaN(this.initialDir)) this.initialDir = dir
    const end: Point = { ...p, dir }
    this.from = end
    const start: Point = { ...a, dir }
    let at = this.carry
    while (at <= len) {
      const q = lerpPoint(start, end, at / len)
      out.push(...this.dabs(q, dx, dy))
      at += this.step(q)
      this.lastDabAt = t
    }
    this.carry = at - len
    if (this.b.dual && this.dualFrom) {
      const d = this.b.dual
      let at2 = this.dualCarry
      while (at2 <= len) {
        out.push(...this.dualDab(lerpPoint(start, end, at2 / len), dx, dy))
        at2 += Math.max(0.5, d.spacing * d.size)
      }
      this.dualCarry = at2 - len
    }
    this.distance += len
    return out
  }
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    pressure: a.pressure + (b.pressure - a.pressure) * t,
    tilt: a.tilt + (b.tilt - a.tilt) * t,
    azimuth: b.azimuth,
    twist: a.twist + (b.twist - a.twist) * t,
    wheel: a.wheel + (b.wheel - a.wheel) * t,
    speed: a.speed + (b.speed - a.speed) * t,
    dir: b.dir,
  }
}

/** Every dab a whole stroke makes: the samples in order, then the finish. */
export function strokeDabs(b: BrushSettings, seed: number, samples: PenSample[], o: StrokeOptions = {}): Dab[] {
  const s = new StrokeBuilder(b, seed, o)
  return [...samples.flatMap((x) => s.add(x)), ...s.finish()]
}
