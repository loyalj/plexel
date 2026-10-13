/**
 * A PSD to write, as the page plans it (fromDoc.ts) and the engine fills
 * it in (engine/psdWrite.ts): every layer record with its tagged blocks
 * made, and where its pixels and mask come from rather than the pixels
 * themselves, which stay in the engine.
 */
import type { NodeId } from '../../doc/types'
import type { PsdBlock, PsdMask, PsdResource } from './format'

/** Pixels from a tile set (its own grid, moved by whole pixels), or a node rendered onto the document's grid. */
export type PixelSource = { kind: 'set'; set: string; dx: number; dy: number } | { kind: 'node'; node: NodeId } | null

export interface PlanLayer {
  name: string
  blend: string
  opacity: number
  clipping: number
  flags: number
  blocks: PsdBlock[]
  content: PixelSource
  /** The pixel mask: its record's settings (the rectangle is worked out), and its coverage tiles (moved by whole pixels). */
  mask: (Omit<PsdMask, 'top' | 'left' | 'bottom' | 'right'> & { set: string | null; dx: number; dy: number }) | null
}

export interface PsdPlan {
  /** The engine's document to read pixels from. */
  key: string
  psb: boolean
  width: number
  height: number
  mode: number
  depth: 8 | 16
  resources: PsdResource[]
  /** Bottom first. */
  layers: PlanLayer[]
  blocks: PsdBlock[]
}
