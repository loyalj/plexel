/**
 * Parameters, described once: what every adjustment, live filter and layer
 * effect can be set to. The registries list their parameters here; the
 * same list reads them back from a file (with defaults and limits), feeds
 * the CPU references, and generates the controls in Properties and the
 * dialogs, so a setting can't exist in one place and be missing from
 * another.
 *
 * A node keeps its parameters as plain JSON; `readParamValues` makes them
 * whole and in range whenever they're used, so an older file, or one from
 * a newer build with settings this one doesn't know, still works.
 */
import { isObject } from './read'

/** A colour as a parameter: in the document's own terms, 0..1 per channel (CMYK as ink), so it means the same on screen and in print. */
export type ParamColour = number[]

/** A curve: points (x, y) in 0..1, sorted by x, at least two. */
export type CurvePoints = [number, number][]

/** A gradient: stops at positions 0..1, each a colour in the document's terms. */
export interface GradientStop {
  at: number
  colour: ParamColour
}

/** Shown only while `when` holds for the other values (a warp's Bend, only with a style). */
type Shown = { when?: (values: Record<string, unknown>) => boolean }

export type ParamDef = Shown &
  (
    | { key: string; kind: 'number'; label: string; min: number; max: number; step: number; unit: string; default: number; hint?: string }
    | { key: string; kind: 'bool'; label: string; default: boolean; hint?: string }
    | { key: string; kind: 'choice'; label: string; options: [string, string][]; default: string; hint?: string }
    /** A colour; its default is white or black in whatever mode. */
    | { key: string; kind: 'colour'; label: string; default: 'black' | 'white' | number[]; hint?: string }
    /** A tone curve per channel: 'master' and one per colour channel, as Curves has. */
    | { key: string; kind: 'curves'; label: string; hint?: string }
    /** Levels per channel: input black, white and gamma, output black and white. */
    | { key: string; kind: 'levels'; label: string; hint?: string }
    | { key: string; kind: 'gradient'; label: string; hint?: string }
    /** Data with no control of its own (a warp's mesh, a Liquify field), made whole by `read` or else its default. */
    | { key: string; kind: 'data'; label: string; read(v: unknown): unknown; default: unknown; hint?: string }
    /** One of the document's patterns, by id, or none. */
    | { key: string; kind: 'pattern'; label: string; hint?: string }
    /** Data loaded from a file (a colour lookup table): `load` reads the file's text, `read` what's kept, `describe` names it. */
    | { key: string; kind: 'file'; label: string; accept: string; load(text: string, name: string): unknown; read(v: unknown): unknown; describe(v: unknown): string; hint?: string }
    /** A colour wheel's push: [hue in degrees, amount 0..100]. */
    | { key: string; kind: 'wheel'; label: string; hint?: string }
  )

export interface LevelsValue {
  inBlack: number
  inWhite: number
  gamma: number
  outBlack: number
  outWhite: number
}

export const LEVELS_IDENTITY: LevelsValue = { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 }
export const CURVE_IDENTITY: CurvePoints = [
  [0, 0],
  [1, 1],
]

/** Channel names for per-channel parameters, by colour mode: master first. */
export const CHANNELS: Record<'rgb' | 'gray' | 'cmyk', string[]> = {
  rgb: ['master', 'red', 'green', 'blue'],
  gray: ['master'],
  cmyk: ['master', 'cyan', 'magenta', 'yellow', 'black'],
}

const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

/** A curve made sane: points in range, sorted, no two at one x, the ends present. */
export function readCurve(v: unknown): CurvePoints {
  if (!Array.isArray(v)) return CURVE_IDENTITY.map((p) => [...p] as [number, number])
  const pts = v
    .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && Number.isFinite(x)))
    .map(([x, y]) => [num(x, 0, 0, 1), num(y, 0, 0, 1)] as [number, number])
    .sort((a, b) => a[0] - b[0])
    .filter((p, i, a) => i === 0 || p[0] - a[i - 1][0] > 1e-4)
  return pts.length >= 2 ? pts : CURVE_IDENTITY.map((p) => [...p] as [number, number])
}

export function readLevels(v: unknown): LevelsValue {
  const r = isObject(v) ? v : {}
  const inBlack = num(r.inBlack, 0, 0, 0.996)
  const inWhite = num(r.inWhite, 1, inBlack + 0.004, 1)
  return { inBlack, inWhite, gamma: num(r.gamma, 1, 0.1, 9.99), outBlack: num(r.outBlack, 0, 0, 1), outWhite: num(r.outWhite, 1, 0, 1) }
}

export function readColour(v: unknown, channels: number, d: 'black' | 'white' | number[], cmyk: boolean): ParamColour {
  if (Array.isArray(v) && v.length === channels && v.every((x) => typeof x === 'number' && Number.isFinite(x))) return v.map((x) => num(x, 0, 0, 1))
  return defaultColour(d, channels, cmyk)
}

/** White or black (or a given colour) in a mode's own terms: CMYK white is no ink, black is all K. */
export function defaultColour(d: 'black' | 'white' | number[], channels: number, cmyk: boolean): ParamColour {
  if (Array.isArray(d)) return Array.from({ length: channels }, (_, i) => d[Math.min(i, d.length - 1)])
  if (cmyk) return d === 'white' ? [0, 0, 0, 0] : [0, 0, 0, 1]
  return new Array(channels).fill(d === 'white' ? 1 : 0)
}

function readGradient(v: unknown, channels: number, cmyk: boolean): GradientStop[] {
  const black = defaultColour('black', channels, cmyk)
  const white = defaultColour('white', channels, cmyk)
  if (!Array.isArray(v))
    return [
      { at: 0, colour: black },
      { at: 1, colour: white },
    ]
  const stops = v
    .filter((s): s is { at: number; colour: unknown } => isObject(s) && typeof s.at === 'number')
    .map((s) => ({ at: num(s.at, 0, 0, 1), colour: readColour(s.colour, channels, 'black', cmyk) }))
    .sort((a, b) => a.at - b.at)
  return stops.length >= 2
    ? stops
    : [
        { at: 0, colour: black },
        { at: 1, colour: white },
      ]
}

/**
 * Parameters as a registry entry wants them: every one present, in range,
 * the right shape for the document's colour mode. Unknown ones are dropped.
 */
export function readParamValues(defs: ParamDef[], raw: unknown, mode: 'rgb' | 'gray' | 'cmyk'): Record<string, unknown> {
  const r = isObject(raw) ? raw : {}
  const channels = mode === 'rgb' ? 3 : mode === 'gray' ? 1 : 4
  const cmyk = mode === 'cmyk'
  const out: Record<string, unknown> = {}
  for (const d of defs) {
    const v = r[d.key]
    switch (d.kind) {
      case 'number':
        out[d.key] = num(v, d.default, d.min, d.max)
        break
      case 'bool':
        out[d.key] = typeof v === 'boolean' ? v : d.default
        break
      case 'choice':
        out[d.key] = d.options.some(([o]) => o === v) ? v : d.default
        break
      case 'colour':
        out[d.key] = readColour(v, channels, d.default, cmyk)
        break
      case 'curves': {
        const src = isObject(v) ? v : {}
        out[d.key] = Object.fromEntries(CHANNELS[mode].map((c) => [c, readCurve(src[c])]))
        break
      }
      case 'levels': {
        const src = isObject(v) ? v : {}
        out[d.key] = Object.fromEntries(CHANNELS[mode].map((c) => [c, readLevels(src[c])]))
        break
      }
      case 'gradient':
        out[d.key] = readGradient(v, channels, cmyk)
        break
      case 'data':
        out[d.key] = v === undefined ? d.default : (d.read(v) ?? d.default)
        break
      case 'pattern':
        out[d.key] = typeof v === 'string' && v ? v : null
        break
      case 'file':
        out[d.key] = v === undefined ? null : (d.read(v) ?? null)
        break
      case 'wheel':
        out[d.key] = Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [((v[0] % 360) + 360) % 360, num(v[1], 0, 0, 100)] : [0, 0]
        break
    }
  }
  return out
}

/** A registry entry's defaults, for a new node. */
export const defaultParams = (defs: ParamDef[], mode: 'rgb' | 'gray' | 'cmyk') => readParamValues(defs, {}, mode)
