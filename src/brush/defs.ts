/**
 * Brushes, declared once: what a brush is (its tip, size, spacing and the
 * rest of Photoshop's Brush Settings), how its properties respond to the
 * pen (dynamics), and the presets the Brushes panel offers.
 *
 * A dynamic maps one input (pressure, tilt, twist, speed, distance along the
 * stroke, a fade over a number of dabs, the direction of travel, or a seeded
 * random number) through a curve onto one property. Photoshop's "Control"
 * menus are dynamics: Shape Dynamics' size control with its minimum
 * diameter is a size dynamic with a minimum. Jitter is separate, a random
 * share taken off (or added) per dab.
 *
 * Tips are named by id: 'round' is computed; the built-in sampled ones
 * are made from fixed seeds (tips.ts); any other is an image, from Define
 * Brush Preset or an ABR file, kept by its content hash ('tip:…').
 *
 * Settings come back from storage through `readBrush`, field by field with
 * a default, like everything else that's read (doc/read.ts). Settings saved
 * before a field existed read it as its default.
 */
import { BLEND_MODES, type BlendModeId } from '../doc/types'
import { isObject, readBool, readNumber, readOneOf, type Warn } from '../doc/read'

export type BuiltinTip = 'round' | 'chalk' | 'spatter' | 'bristle'
export const BUILTIN_TIPS: BuiltinTip[] = ['round', 'chalk', 'spatter', 'bristle']
/** A built-in tip, or an image tip by its content hash ('tip:…'). */
export type TipId = string
export const isImageTip = (t: TipId) => t.startsWith('tip:')

export type DynInput = 'pressure' | 'tilt' | 'twist' | 'speed' | 'distance' | 'random' | 'fade' | 'direction' | 'initial-direction'
export type DynTarget =
  | 'size'
  | 'opacity'
  | 'flow'
  | 'hardness'
  | 'angle'
  | 'roundness'
  | 'scatter'
  | 'count'
  | 'colour'
  | 'hue'
  | 'saturation'
  | 'brightness'
  | 'texture-depth'
  | 'wetness'
  | 'mix'
export const DYN_INPUTS: DynInput[] = ['pressure', 'tilt', 'twist', 'speed', 'distance', 'random', 'fade', 'direction', 'initial-direction']
export const DYN_TARGETS: DynTarget[] = ['size', 'opacity', 'flow', 'hardness', 'angle', 'roundness', 'scatter', 'count', 'colour', 'hue', 'saturation', 'brightness', 'texture-depth', 'wetness', 'mix']

/** Inputs as Photoshop's Control menus name them. */
export const DYN_INPUT_LABELS: Record<DynInput, string> = {
  pressure: 'Pen Pressure',
  tilt: 'Pen Tilt',
  twist: 'Rotation',
  speed: 'Speed',
  distance: 'Distance',
  random: 'Random',
  fade: 'Fade',
  direction: 'Direction',
  'initial-direction': 'Initial Direction',
}

export interface Dynamic {
  input: DynInput
  target: DynTarget
  /**
   * The curve, as evenly spaced values from input 0 to input 1, joined by
   * straight lines. [0, 1] is linear.
   */
  curve: number[]
  /** For the properties that scale (size, opacity, flow and the like): what the property is at the curve's 0, as a share of its setting. */
  min: number
  /** For Fade: how many dabs it takes to fade. */
  steps?: number
}

export type TextureMode = 'multiply' | 'subtract' | 'darken' | 'overlay' | 'color-dodge' | 'color-burn' | 'linear-burn' | 'hard-mix' | 'linear-height' | 'height'
export const TEXTURE_MODES: TextureMode[] = ['multiply', 'subtract', 'darken', 'overlay', 'color-dodge', 'color-burn', 'linear-burn', 'hard-mix', 'linear-height', 'height']
export type DualMode = 'multiply' | 'darken' | 'overlay' | 'color-dodge' | 'color-burn' | 'linear-burn' | 'hard-mix' | 'linear-height'
export const DUAL_MODES: DualMode[] = ['multiply', 'darken', 'overlay', 'color-dodge', 'color-burn', 'linear-burn', 'hard-mix', 'linear-height']

/** Photoshop's Texture section: a paper (or pattern) the stroke's paint sits in. */
export interface BrushTexture {
  /** A built-in paper, or an image pattern by its content hash ('pat:…'). */
  id: string
  /** 1 is 100%. */
  scale: number
  /** −150..150. */
  brightness: number
  /** −50..100. */
  contrast: number
  invert: boolean
  mode: TextureMode
  /** How strongly the texture shows, 0..1. */
  depth: number
  /** Each tip's depth at least this, when depth varies (jitter or a control). */
  minDepth: number
  depthJitter: number
  /** The texture laid into each dab (its depth can vary), rather than into the stroke as a whole. */
  eachTip: boolean
}

/** Photoshop's Dual Brush: a second tip whose stroke masks the first's. */
export interface DualBrush {
  tip: TipId
  size: number
  /** Round tips only. */
  hardness: number
  spacing: number
  scatter: number
  bothAxes: boolean
  count: number
  mode: DualMode
  flip: boolean
}

/** Brush Pose: fixed values in place of the pen's, where one is set. */
export interface BrushPose {
  tiltX: number | null
  tiltY: number | null
  rotation: number | null
  pressure: number | null
}

export interface BrushSettings {
  // --- Brush Tip Shape
  tip: TipId
  /** Diameter in document pixels. */
  size: number
  /** 0 soft to 1 hard; round tips only. */
  hardness: number
  /** 1 is a circle; less squashes it along its angle. */
  roundness: number
  /** Degrees. */
  angle: number
  flipX: boolean
  flipY: boolean
  /** Distance between dabs, as a share of the diameter. */
  spacing: number
  // --- Shape Dynamics
  sizeJitter: number
  angleJitter: number
  roundnessJitter: number
  /** The least a jittered or controlled roundness goes to. */
  minRoundness: number
  flipXJitter: boolean
  flipYJitter: boolean
  // --- Scattering
  /** Dabs scattered sideways (or both ways), as a share of the diameter. */
  scatter: number
  scatterBothAxes: boolean
  /** Dabs at each spacing step. */
  count: number
  countJitter: number
  // --- Texture and Dual Brush
  texture: BrushTexture | null
  dual: DualBrush | null
  // --- Colour Dynamics
  /** Foreground to background colour, at random per dab. */
  colourJitter: number
  /** Hue, saturation and brightness jitter, 0..1. */
  hueJitter: number
  saturationJitter: number
  brightnessJitter: number
  /** −1 takes all saturation away, 1 doubles it. */
  purity: number
  /** Jitter picked anew for each dab (Photoshop's Apply Per Tip), or once for the stroke. */
  colourPerTip: boolean
  // --- Transfer
  /** The most a stroke covers, however many dabs overlap. */
  opacity: number
  /** How much each dab adds. */
  flow: number
  opacityJitter: number
  flowJitter: number
  wetnessJitter: number
  mixJitter: number
  // --- the rest
  pose: BrushPose | null
  /** Grain in the soft part of each tip. */
  noise: boolean
  /** Paint pooling at each dab's edge, lighter inside: watercolour. */
  wetEdges: boolean
  /** Paint keeps building while the pen is held still: an airbrush. */
  buildUp: boolean
  /** How much the stroke lags behind the pen to smooth it, 0..1. */
  smoothing: number
  /** Pulled-string smoothing: the stroke moves only once the pen is further away than a string's length. */
  pulledString: boolean
  /** How the stroke blends with the layer. */
  mode: BlendModeId
  dynamics: Dynamic[]
}

/** The Mixer Brush's settings, beside its brush. */
export interface MixerSettings {
  /** How much paint the brush picks up from the canvas, 0..1. */
  wet: number
  /** How much paint the brush holds; low loads dry out quickly, 0..1. */
  load: number
  /** How much of the paint laid down is the canvas's rather than the brush's, 0..1. */
  mix: number
  /** Load the brush with the foreground colour after each stroke. */
  loadEach: boolean
  /** Clean the brush after each stroke. */
  cleanEach: boolean
  sampleAll: boolean
}

/** The Smudge tool's settings, beside its brush. */
export interface SmudgeSettings {
  /** How much of what the brush carries goes on with it, 0..1. */
  strength: number
  /** Start each stroke with the foreground colour on the brush. */
  fingerPainting: boolean
  sampleAll: boolean
}

export const DEFAULT_MIXER: MixerSettings = { wet: 0.5, load: 0.5, mix: 0.5, loadEach: true, cleanEach: true, sampleAll: false }
export const DEFAULT_SMUDGE: SmudgeSettings = { strength: 0.5, fingerPainting: false, sampleAll: false }

/** Photoshop's mixer combinations, in its menu's order. */
export const MIXER_PRESETS: { name: string; wet: number; load: number; mix: number }[] = [
  { name: 'Dry', wet: 0, load: 1, mix: 0 },
  { name: 'Dry, Light Load', wet: 0, load: 0.01, mix: 0 },
  { name: 'Dry, Heavy Load', wet: 0, load: 1, mix: 0 },
  { name: 'Moist', wet: 0.1, load: 0.05, mix: 0.5 },
  { name: 'Moist, Light Load', wet: 0.1, load: 0.01, mix: 0.5 },
  { name: 'Moist, Heavy Load', wet: 0.1, load: 0.5, mix: 0.5 },
  { name: 'Moist, Heavy Mix', wet: 0.1, load: 0.05, mix: 1 },
  { name: 'Wet', wet: 0.5, load: 0.5, mix: 0.5 },
  { name: 'Wet, Light Load', wet: 0.5, load: 0.01, mix: 0.5 },
  { name: 'Wet, Heavy Load', wet: 0.5, load: 0.5, mix: 0.5 },
  { name: 'Wet, Heavy Mix', wet: 0.5, load: 0.5, mix: 1 },
  { name: 'Very Wet', wet: 1, load: 0.5, mix: 0.5 },
  { name: 'Very Wet, Light Load', wet: 1, load: 0.01, mix: 0.5 },
  { name: 'Very Wet, Heavy Load', wet: 1, load: 0.5, mix: 0.5 },
  { name: 'Very Wet, Heavy Mix', wet: 1, load: 0.5, mix: 1 },
]

export const LINEAR = [0, 1]

export const DEFAULT_TEXTURE: BrushTexture = { id: 'paper', scale: 1, brightness: 0, contrast: 0, invert: false, mode: 'multiply', depth: 1, minDepth: 0, depthJitter: 0, eachTip: false }
export const DEFAULT_DUAL: DualBrush = { tip: 'spatter', size: 40, hardness: 1, spacing: 0.25, scatter: 0.5, bothAxes: true, count: 1, mode: 'multiply', flip: false }
export const DEFAULT_POSE: BrushPose = { tiltX: 0, tiltY: 0, rotation: 0, pressure: 1 }

export const DEFAULT_BRUSH: BrushSettings = {
  tip: 'round',
  size: 30,
  hardness: 0.8,
  roundness: 1,
  angle: 0,
  flipX: false,
  flipY: false,
  spacing: 0.15,
  sizeJitter: 0,
  angleJitter: 0,
  roundnessJitter: 0,
  minRoundness: 0.25,
  flipXJitter: false,
  flipYJitter: false,
  scatter: 0,
  scatterBothAxes: false,
  count: 1,
  countJitter: 0,
  texture: null,
  dual: null,
  colourJitter: 0,
  hueJitter: 0,
  saturationJitter: 0,
  brightnessJitter: 0,
  purity: 0,
  colourPerTip: true,
  opacity: 1,
  flow: 1,
  opacityJitter: 0,
  flowJitter: 0,
  wetnessJitter: 0,
  mixJitter: 0,
  pose: null,
  noise: false,
  wetEdges: false,
  buildUp: false,
  smoothing: 0.1,
  pulledString: false,
  mode: 'normal',
  dynamics: [{ input: 'pressure', target: 'size', curve: LINEAR, min: 0.15 }],
}

export interface BrushPreset {
  id: string
  name: string
  settings: Partial<BrushSettings>
}

const pressureSize: Dynamic = { input: 'pressure', target: 'size', curve: LINEAR, min: 0.15 }
const pressureFlow: Dynamic = { input: 'pressure', target: 'flow', curve: LINEAR, min: 0 }
const pressureOpacity: Dynamic = { input: 'pressure', target: 'opacity', curve: LINEAR, min: 0.1 }

/** The built-in presets, in the Brushes panel's order. */
export const BRUSH_PRESETS: BrushPreset[] = [
  { id: 'hard-round', name: 'Hard Round', settings: { tip: 'round', size: 30, hardness: 1, spacing: 0.1, dynamics: [pressureSize] } },
  { id: 'soft-round', name: 'Soft Round', settings: { tip: 'round', size: 80, hardness: 0, spacing: 0.1, dynamics: [pressureFlow] } },
  { id: 'inking', name: 'Inking Pen', settings: { tip: 'round', size: 8, hardness: 1, spacing: 0.05, smoothing: 0.5, dynamics: [{ ...pressureSize, curve: [0, 0.35, 1], min: 0.05 }] } },
  { id: 'airbrush', name: 'Airbrush', settings: { tip: 'round', size: 120, hardness: 0, flow: 0.08, spacing: 0.05, buildUp: true, dynamics: [pressureFlow] } },
  { id: 'pencil', name: 'Pencil', settings: { tip: 'round', size: 4, hardness: 1, spacing: 0.08, dynamics: [pressureOpacity] } },
  { id: 'calligraphy', name: 'Calligraphy', settings: { tip: 'round', size: 24, hardness: 0.95, roundness: 0.25, angle: 45, spacing: 0.04, dynamics: [pressureSize] } },
  { id: 'chalk', name: 'Chalk', settings: { tip: 'chalk', size: 60, spacing: 0.2, angleJitter: 1, texture: { ...DEFAULT_TEXTURE, id: 'rough', scale: 0.8, depth: 0.6 }, dynamics: [pressureSize, pressureOpacity] } },
  { id: 'spatter', name: 'Spatter', settings: { tip: 'spatter', size: 70, spacing: 0.4, scatter: 0.8, scatterBothAxes: true, count: 2, sizeJitter: 0.5, angleJitter: 1, dynamics: [] } },
  { id: 'bristle', name: 'Dry Bristle', settings: { tip: 'bristle', size: 50, spacing: 0.06, flow: 0.6, angle: 0, dynamics: [{ input: 'pressure', target: 'flow', curve: LINEAR, min: 0.3 }, { input: 'direction', target: 'angle', curve: LINEAR, min: 0 }] } },
  { id: 'watercolour', name: 'Watercolour', settings: { tip: 'round', size: 70, hardness: 0.4, spacing: 0.08, flow: 0.5, opacity: 0.8, wetEdges: true, texture: { ...DEFAULT_TEXTURE, id: 'paper', scale: 1.5, depth: 0.35 }, dynamics: [pressureFlow] } },
  { id: 'pastel', name: 'Pastel on Canvas', settings: { tip: 'chalk', size: 50, spacing: 0.15, angleJitter: 0.3, noise: true, texture: { ...DEFAULT_TEXTURE, id: 'canvas', scale: 1, depth: 0.8, mode: 'height', eachTip: true, depthJitter: 0.3 }, dynamics: [pressureSize] } },
  { id: 'foliage', name: 'Scattered Leaves', settings: { tip: 'spatter', size: 45, spacing: 0.5, scatter: 1.5, scatterBothAxes: true, count: 3, countJitter: 0.5, sizeJitter: 0.6, angleJitter: 1, roundnessJitter: 0.4, colourJitter: 0.5, hueJitter: 0.08, brightnessJitter: 0.2, dynamics: [] } },
  { id: 'dual-spatter', name: 'Rough Dual', settings: { tip: 'round', size: 60, hardness: 0.6, spacing: 0.12, dual: { ...DEFAULT_DUAL }, dynamics: [pressureSize] } },
]

export const presetSettings = (p: BrushPreset): BrushSettings => ({ ...DEFAULT_BRUSH, ...p.settings })

const readCurve = (v: unknown): number[] => (Array.isArray(v) && v.length >= 2 && v.length <= 16 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? v.map((x) => Math.min(1, Math.max(0, x))) : [...LINEAR])

/** A tip id from storage: a built-in, or an image tip's hash. */
function readTip(v: unknown, d: TipId, what: string, warn: Warn): TipId {
  if (typeof v === 'string' && ((BUILTIN_TIPS as string[]).includes(v) || /^tip:[0-9a-z]{4,64}$/.test(v))) return v
  if (v !== undefined) warn(`${what} wasn’t understood; it’s the default`)
  return d
}

function readTexture(raw: unknown, warn: Warn): BrushTexture | null {
  if (!isObject(raw)) return null
  const d = DEFAULT_TEXTURE
  return {
    id: typeof raw.id === 'string' && /^(paper|canvas|rough|burlap|pat:[0-9a-z]{4,64})$/.test(raw.id) ? raw.id : d.id,
    scale: readNumber(raw.scale, d.scale, 0.01, 10, 'a texture’s scale', warn),
    brightness: readNumber(raw.brightness, d.brightness, -150, 150, 'a texture’s brightness', warn),
    contrast: readNumber(raw.contrast, d.contrast, -50, 100, 'a texture’s contrast', warn),
    invert: readBool(raw.invert, d.invert, 'a brush setting', warn),
    mode: readOneOf(raw.mode, TEXTURE_MODES, d.mode, 'a texture’s mode', warn),
    depth: readNumber(raw.depth, d.depth, 0, 1, 'a texture’s depth', warn),
    minDepth: readNumber(raw.minDepth, d.minDepth, 0, 1, 'a texture’s minimum depth', warn),
    depthJitter: readNumber(raw.depthJitter, d.depthJitter, 0, 1, 'a texture’s depth jitter', warn),
    eachTip: readBool(raw.eachTip, d.eachTip, 'a brush setting', warn),
  }
}

function readDual(raw: unknown, warn: Warn): DualBrush | null {
  if (!isObject(raw)) return null
  const d = DEFAULT_DUAL
  return {
    tip: readTip(raw.tip, d.tip, 'a dual brush’s tip', warn),
    size: readNumber(raw.size, d.size, 1, 5000, 'a dual brush’s size', warn),
    hardness: readNumber(raw.hardness, d.hardness, 0, 1, 'a dual brush’s hardness', warn),
    spacing: readNumber(raw.spacing, d.spacing, 0.01, 10, 'a dual brush’s spacing', warn),
    scatter: readNumber(raw.scatter, d.scatter, 0, 10, 'a dual brush’s scatter', warn),
    bothAxes: readBool(raw.bothAxes, d.bothAxes, 'a brush setting', warn),
    count: Math.round(readNumber(raw.count, d.count, 1, 16, 'a dual brush’s count', warn)),
    mode: readOneOf(raw.mode, DUAL_MODES, d.mode, 'a dual brush’s mode', warn),
    flip: readBool(raw.flip, d.flip, 'a brush setting', warn),
  }
}

function readPose(raw: unknown, warn: Warn): BrushPose | null {
  if (!isObject(raw)) return null
  const opt = (v: unknown, lo: number, hi: number, what: string) => (v === null || v === undefined ? null : readNumber(v, 0, lo, hi, what, warn))
  return { tiltX: opt(raw.tiltX, -90, 90, 'a pose’s tilt'), tiltY: opt(raw.tiltY, -90, 90, 'a pose’s tilt'), rotation: opt(raw.rotation, 0, 360, 'a pose’s rotation'), pressure: opt(raw.pressure, 0, 1, 'a pose’s pressure') }
}

/** Brush settings from storage: every field read with its default. */
export function readBrush(raw: unknown, warn: Warn = () => {}): BrushSettings {
  const r = isObject(raw) ? raw : {}
  const d = DEFAULT_BRUSH
  const unit = (k: keyof BrushSettings, what: string) => readNumber(r[k], d[k] as number, 0, 1, what, warn)
  const bool = (k: keyof BrushSettings) => readBool(r[k], d[k] as boolean, 'a brush setting', warn)
  const dynamics: Dynamic[] = Array.isArray(r.dynamics)
    ? r.dynamics.filter(isObject).map((x) => {
        const dyn: Dynamic = {
          input: readOneOf(x.input, DYN_INPUTS, 'pressure', 'a dynamic’s input', warn),
          target: readOneOf(x.target, DYN_TARGETS, 'size', 'a dynamic’s property', warn),
          curve: readCurve(x.curve),
          min: readNumber(x.min, 0, 0, 1, 'a dynamic’s minimum', warn),
        }
        if (dyn.input === 'fade') dyn.steps = Math.round(readNumber(x.steps, 25, 1, 9999, 'a fade’s steps', warn))
        return dyn
      })
    : d.dynamics.map((x) => ({ ...x }))
  return {
    tip: readTip(r.tip, d.tip, 'a brush’s tip', warn),
    size: readNumber(r.size, d.size, 1, 5000, 'a brush’s size', warn),
    hardness: unit('hardness', 'a brush’s hardness'),
    roundness: readNumber(r.roundness, d.roundness, 0.01, 1, 'a brush’s roundness', warn),
    angle: readNumber(r.angle, d.angle, -360, 360, 'a brush’s angle', warn),
    flipX: bool('flipX'),
    flipY: bool('flipY'),
    spacing: readNumber(r.spacing, d.spacing, 0.01, 10, 'a brush’s spacing', warn),
    sizeJitter: unit('sizeJitter', 'a brush’s size jitter'),
    angleJitter: unit('angleJitter', 'a brush’s angle jitter'),
    roundnessJitter: unit('roundnessJitter', 'a brush’s roundness jitter'),
    minRoundness: readNumber(r.minRoundness, d.minRoundness, 0.01, 1, 'a brush’s minimum roundness', warn),
    flipXJitter: bool('flipXJitter'),
    flipYJitter: bool('flipYJitter'),
    scatter: readNumber(r.scatter, d.scatter, 0, 10, 'a brush’s scatter', warn),
    scatterBothAxes: bool('scatterBothAxes'),
    count: Math.round(readNumber(r.count, d.count, 1, 16, 'a brush’s count', warn)),
    countJitter: unit('countJitter', 'a brush’s count jitter'),
    texture: readTexture(r.texture, warn),
    dual: readDual(r.dual, warn),
    colourJitter: unit('colourJitter', 'a brush’s colour jitter'),
    hueJitter: unit('hueJitter', 'a brush’s hue jitter'),
    saturationJitter: unit('saturationJitter', 'a brush’s saturation jitter'),
    brightnessJitter: unit('brightnessJitter', 'a brush’s brightness jitter'),
    purity: readNumber(r.purity, d.purity, -1, 1, 'a brush’s purity', warn),
    colourPerTip: bool('colourPerTip'),
    opacity: unit('opacity', 'a brush’s opacity'),
    flow: unit('flow', 'a brush’s flow'),
    opacityJitter: unit('opacityJitter', 'a brush’s opacity jitter'),
    flowJitter: unit('flowJitter', 'a brush’s flow jitter'),
    wetnessJitter: unit('wetnessJitter', 'a brush’s wetness jitter'),
    mixJitter: unit('mixJitter', 'a brush’s mix jitter'),
    pose: readPose(r.pose, warn),
    noise: bool('noise'),
    wetEdges: bool('wetEdges'),
    buildUp: bool('buildUp'),
    smoothing: readNumber(r.smoothing, d.smoothing, 0, 0.95, 'a brush’s smoothing', warn),
    pulledString: bool('pulledString'),
    mode: readOneOf(r.mode, BLEND_MODES.filter((m) => m !== 'pass-through'), d.mode, 'a brush’s mode', warn),
    dynamics,
  }
}

export function readMixer(raw: unknown, warn: Warn = () => {}): MixerSettings {
  const r = isObject(raw) ? raw : {}
  const d = DEFAULT_MIXER
  return {
    wet: readNumber(r.wet, d.wet, 0, 1, 'the mixer’s wetness', warn),
    load: readNumber(r.load, d.load, 0.01, 1, 'the mixer’s load', warn),
    mix: readNumber(r.mix, d.mix, 0, 1, 'the mixer’s mix', warn),
    loadEach: readBool(r.loadEach, d.loadEach, 'a brush setting', warn),
    cleanEach: readBool(r.cleanEach, d.cleanEach, 'a brush setting', warn),
    sampleAll: readBool(r.sampleAll, d.sampleAll, 'a brush setting', warn),
  }
}

export function readSmudge(raw: unknown, warn: Warn = () => {}): SmudgeSettings {
  const r = isObject(raw) ? raw : {}
  const d = DEFAULT_SMUDGE
  return { strength: readNumber(r.strength, d.strength, 0, 1, 'the smudge’s strength', warn), fingerPainting: readBool(r.fingerPainting, d.fingerPainting, 'a brush setting', warn), sampleAll: readBool(r.sampleAll, d.sampleAll, 'a brush setting', warn) }
}

/** A brush's name for messages, by preset. */
export const presetName = (id: string) => BRUSH_PRESETS.find((p) => p.id === id)?.name ?? 'Custom'

/** The value of a curve at x in 0..1. */
export function curveAt(curve: number[], x: number): number {
  const t = Math.min(1, Math.max(0, x)) * (curve.length - 1)
  const i = Math.min(curve.length - 2, Math.floor(t))
  return curve[i] + (curve[i + 1] - curve[i]) * (t - i)
}

/** Whether a dynamic of this kind is on: the switches in the options bar. */
export const hasDynamic = (b: BrushSettings, input: DynInput, target: DynTarget) => b.dynamics.some((d) => d.input === input && d.target === target)

/** The settings with a pressure dynamic switched on or off. */
export function withPressure(b: BrushSettings, target: DynTarget, on: boolean): BrushSettings {
  const rest = b.dynamics.filter((d) => !(d.input === 'pressure' && d.target === target))
  if (!on) return { ...b, dynamics: rest }
  const min = target === 'size' ? 0.15 : target === 'opacity' ? 0.1 : 0
  return { ...b, dynamics: [...rest, { input: 'pressure', target, curve: [...LINEAR], min }] }
}

/** The one control a property has (Photoshop's sections have one each), or null. */
export const controlOf = (b: BrushSettings, target: DynTarget): Dynamic | null => b.dynamics.find((d) => d.target === target) ?? null

/** The settings with a property's control replaced (null: Off). */
export function withControl(b: BrushSettings, target: DynTarget, control: Omit<Dynamic, 'target'> | null): BrushSettings {
  const rest = b.dynamics.filter((d) => d.target !== target)
  return { ...b, dynamics: control ? [...rest, { ...control, target }] : rest }
}

/** Whether a stroke with these settings keeps a colour per pixel (its colour varies from dab to dab). */
export const colourVaries = (b: BrushSettings) =>
  b.colourJitter > 0 || b.hueJitter > 0 || b.saturationJitter > 0 || b.brightnessJitter > 0 || b.purity !== 0 || b.dynamics.some((d) => d.target === 'colour' || d.target === 'hue' || d.target === 'saturation' || d.target === 'brightness')
