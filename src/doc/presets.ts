/**
 * The New Document dialog's presets: common sizes for screen and print,
 * each with the unit, resolution and colour mode it's normally made in.
 */
import type { ColourMode, Depth } from './types'
import type { Unit } from './units'

export interface Preset {
  id: string
  name: string
  group: 'Screen' | 'Print' | 'Photo'
  width: number
  height: number
  unit: Unit
  resolution: number
  mode: ColourMode
  depth: Depth
}

export const PRESETS: Preset[] = [
  { id: 'hd', name: 'Full HD, 1920 × 1080', group: 'Screen', width: 1920, height: 1080, unit: 'px', resolution: 72, mode: 'rgb', depth: 8 },
  { id: 'uhd', name: '4K UHD, 3840 × 2160', group: 'Screen', width: 3840, height: 2160, unit: 'px', resolution: 72, mode: 'rgb', depth: 8 },
  { id: 'square', name: 'Square, 2048 × 2048', group: 'Screen', width: 2048, height: 2048, unit: 'px', resolution: 72, mode: 'rgb', depth: 8 },
  { id: 'icon', name: 'Icon, 1024 × 1024', group: 'Screen', width: 1024, height: 1024, unit: 'px', resolution: 72, mode: 'rgb', depth: 8 },
  { id: 'a4', name: 'A4, 210 × 297 mm', group: 'Print', width: 210, height: 297, unit: 'mm', resolution: 300, mode: 'cmyk', depth: 8 },
  { id: 'a3', name: 'A3, 297 × 420 mm', group: 'Print', width: 297, height: 420, unit: 'mm', resolution: 300, mode: 'cmyk', depth: 8 },
  { id: 'letter', name: 'US Letter, 8.5 × 11 in', group: 'Print', width: 8.5, height: 11, unit: 'in', resolution: 300, mode: 'cmyk', depth: 8 },
  { id: 'poster', name: 'Poster, 18 × 24 in', group: 'Print', width: 18, height: 24, unit: 'in', resolution: 150, mode: 'cmyk', depth: 8 },
  { id: 'photo-4x6', name: 'Photo, 6 × 4 in', group: 'Photo', width: 6, height: 4, unit: 'in', resolution: 300, mode: 'rgb', depth: 16 },
  { id: 'photo-24mp', name: '24 MP camera, 6000 × 4000', group: 'Photo', width: 6000, height: 4000, unit: 'px', resolution: 300, mode: 'rgb', depth: 16 },
]

export const DEFAULT_PRESET = PRESETS[0]
