/**
 * The Gradient tool's and the Paint Bucket's settings: which gradient, its
 * style, what a drag makes, the blend mode and opacity, and the bucket's
 * fill, tolerance and switches. App-wide and remembered by the browser,
 * like the selection tools'.
 *
 * Gradients are presets made from the foreground and background colours
 * when they're used (so they follow the colours, as Photoshop's first
 * presets do), or a document's own gradient picked up from a layer.
 */
import type { BlendModeId } from '../doc/types'
import { BLEND_MODES } from '../doc/types'
import type { GradientType, PaintStop } from '../doc/vector'
import { GRADIENT_TYPES } from '../doc/vector'

export type GradientPreset = 'fg-bg' | 'fg-clear' | 'bg-fg' | 'black-white' | 'white-black' | 'fg-bg-fg'

export const GRADIENT_PRESETS: [GradientPreset, string][] = [
  ['fg-bg', 'Foreground to Background'],
  ['fg-clear', 'Foreground to Transparent'],
  ['bg-fg', 'Background to Foreground'],
  ['black-white', 'Black, White'],
  ['white-black', 'White, Black'],
  ['fg-bg-fg', 'Foreground, Background, Foreground'],
]

export interface FillToolState {
  gradient: {
    preset: GradientPreset
    type: GradientType
    /** A drag makes a gradient fill layer (live), or paints the gradient into pixels. */
    makes: 'layer' | 'pixels'
    blend: BlendModeId
    /** 0..1. */
    opacity: number
    reverse: boolean
  }
  bucket: {
    source: 'fg' | 'pattern'
    pattern: string | null
    blend: BlendModeId
    opacity: number
    tolerance: number
    contiguous: boolean
    antialias: boolean
    sampleAll: boolean
  }
}

const KEY = 'plexel.fillTools.v1'

export const defaultFillTools = (): FillToolState => ({
  gradient: { preset: 'fg-bg', type: 'linear', makes: 'layer', blend: 'normal', opacity: 1, reverse: false },
  bucket: { source: 'fg', pattern: null, blend: 'normal', opacity: 1, tolerance: 32, contiguous: true, antialias: true, sampleAll: false },
})

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const blendOf = (v: unknown): BlendModeId => (BLEND_MODES.includes(v as BlendModeId) && v !== 'pass-through' ? (v as BlendModeId) : 'normal')

/** Settings as saved, repaired where they're missing or wrong. */
export function readFillTools(raw: unknown): FillToolState {
  const d = defaultFillTools()
  if (!raw || typeof raw !== 'object') return d
  const r = raw as Record<string, Record<string, unknown> | undefined>
  const g = r.gradient ?? {}
  const b = r.bucket ?? {}
  return {
    gradient: {
      preset: GRADIENT_PRESETS.some(([p]) => p === g.preset) ? (g.preset as GradientPreset) : 'fg-bg',
      type: GRADIENT_TYPES.some(([t]) => t === g.type) ? (g.type as GradientType) : 'linear',
      makes: g.makes === 'pixels' ? 'pixels' : 'layer',
      blend: blendOf(g.blend),
      opacity: num(g.opacity, 0, 1, 1),
      reverse: bool(g.reverse, false),
    },
    bucket: {
      source: b.source === 'pattern' ? 'pattern' : 'fg',
      pattern: typeof b.pattern === 'string' ? b.pattern : null,
      blend: blendOf(b.blend),
      opacity: num(b.opacity, 0, 1, 1),
      tolerance: num(b.tolerance, 0, 255, 32),
      contiguous: bool(b.contiguous, true),
      antialias: bool(b.antialias, true),
      sampleAll: bool(b.sampleAll, false),
    },
  }
}

/** A preset's stops from the two colours (in the document's terms) and transparency. */
export function presetStops(preset: GradientPreset, fg: number[], bg: number[], black: number[], white: number[]): PaintStop[] {
  const s = (at: number, colour: number[], alpha = 1): PaintStop => ({ at, colour, alpha })
  switch (preset) {
    case 'fg-bg':
      return [s(0, fg), s(1, bg)]
    case 'fg-clear':
      return [s(0, fg), s(1, fg, 0)]
    case 'bg-fg':
      return [s(0, bg), s(1, fg)]
    case 'black-white':
      return [s(0, black), s(1, white)]
    case 'white-black':
      return [s(0, white), s(1, black)]
    case 'fg-bg-fg':
      return [s(0, fg), s(0.5, bg), s(1, fg)]
  }
}

class FillToolStore {
  private state: FillToolState
  private listeners = new Set<() => void>()

  constructor() {
    let raw: unknown = null
    try {
      raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    } catch {
      raw = null
    }
    this.state = readFillTools(raw)
  }

  get = () => this.state

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  update<K extends keyof FillToolState>(key: K, patch: Partial<FillToolState[K]>) {
    this.state = { ...this.state, [key]: { ...this.state[key], ...patch } }
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state))
    } catch {
      // Not remembered; still used.
    }
    for (const fn of this.listeners) fn()
  }
}

let store: FillToolStore | null = null
export const fillTools = () => (store ??= new FillToolStore())
