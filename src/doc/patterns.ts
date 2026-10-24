/**
 * Patterns made from artwork, and pattern editing mode's arithmetic.
 *
 * A pattern with artwork (`DocPattern.art`) keeps its tile as a document of
 * its own, as a symbol does: its canvas is the tile, and anything on it
 * (shapes, text, pixels) is what one tile shows. `tile` lays tiles out: in
 * a grid, as bricks with every row (or column) moved along by a share of a
 * tile, or as hexagons, with spacing between them (overlapping when it's
 * less than nothing). The pattern's pixels (`tiles`) are one repeat of
 * that layout, worked out from the tile's pixels whenever the artwork
 * changes (`repeatOf` says where each copy of the tile goes in it); every
 * paint, fill and Pattern Overlay draws those, so nothing else needs to
 * know about artwork.
 *
 * Editing a pattern opens its tile in a tab of its own (app/patternEdit.ts)
 * that repeats as a tiled document does where the layout repeats exactly,
 * so artwork drawn across an edge comes back in at the other side.
 *
 * Pure, so the checks run it in Node.
 */
import { compose } from './edit'
import { fragmentOf, pixelFragment } from './fragment'
import { MAX_PATTERN } from '../vector/paint'
import type { Affine, Doc, DocNode, DocPattern, NodeId, PatternTile, PatternTileType, Tiling } from './types'

export const DEFAULT_PATTERN_TILE: PatternTile = { type: 'grid', offset: 0.5, spacing: [0, 0] }

/** The brick offsets offered, as Illustrator's: ½, ⅓, ¼ and ⅕ of a tile. */
export const BRICK_OFFSETS = [1 / 2, 1 / 3, 1 / 4, 1 / 5]

export const TILE_TYPE_LABELS: Record<PatternTileType, string> = { grid: 'Grid', 'brick-row': 'Brick by Row', 'brick-column': 'Brick by Column', 'hex-column': 'Hex by Column', 'hex-row': 'Hex by Row' }

/** A pattern tile from storage: every field read with its default. */
export function readPatternTile(v: unknown): PatternTile {
  const d = DEFAULT_PATTERN_TILE
  if (!v || typeof v !== 'object') return { ...d, spacing: [...d.spacing] }
  const r = v as Record<string, unknown>
  const type = (['grid', 'brick-row', 'brick-column', 'hex-column', 'hex-row'] as const).find((t) => t === r.type) ?? d.type
  const offset = typeof r.offset === 'number' && Number.isFinite(r.offset) ? BRICK_OFFSETS.reduce((a, b) => (Math.abs(b - (r.offset as number)) < Math.abs(a - (r.offset as number)) ? b : a)) : d.offset
  const sp = Array.isArray(r.spacing) ? r.spacing : []
  const s = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(Math.min(MAX_PATTERN, Math.max(-MAX_PATTERN, x))) : 0)
  return { type, offset, spacing: [s(sp[0]), s(sp[1])] }
}

export interface Repeat {
  /** One repeat's size, in pixels. */
  width: number
  height: number
  /** Where each copy of the tile's top left goes in it (copies wrap round its edges), in the order they're laid, later over earlier. */
  at: [number, number][]
}

/** One repeat of a `w` × `h` tile laid out by `t`. */
export function repeatOf(w: number, h: number, t: PatternTile): Repeat {
  const px = Math.max(1, w + t.spacing[0])
  const py = Math.max(1, h + t.spacing[1])
  const n = Math.min(5, Math.max(2, Math.round(1 / t.offset)))
  switch (t.type) {
    case 'brick-row':
      return { width: px, height: n * py, at: Array.from({ length: n }, (_, k): [number, number] => [Math.round((k * px) / n) % px, k * py]) }
    case 'brick-column':
      return { width: n * px, height: py, at: Array.from({ length: n }, (_, k): [number, number] => [k * px, Math.round((k * py) / n) % py]) }
    case 'hex-column': {
      // Columns three quarters of a tile apart, every other one half a tile down.
      const c = Math.max(1, Math.round(px * 0.75))
      return { width: 2 * c, height: py, at: [[0, 0], [c, Math.round(py / 2)]] }
    }
    case 'hex-row': {
      const r = Math.max(1, Math.round(py * 0.75))
      return { width: px, height: 2 * r, at: [[0, 0], [Math.round(px / 2), r]] }
    }
    default:
      return { width: px, height: py, at: [[0, 0]] }
  }
}

/**
 * How the tile repeats while it's edited: across and down where the layout
 * repeats a tile exactly (no spacing that way, no offset across it), so
 * what's drawn over that edge shows at the other.
 */
export function editTiling(t: PatternTile): Tiling {
  const x = t.spacing[0] === 0 && (t.type === 'grid' || t.type === 'brick-row' || t.type === 'hex-row')
  const y = t.spacing[1] === 0 && (t.type === 'grid' || t.type === 'brick-column' || t.type === 'hex-column')
  return x && y ? 'both' : x ? 'x' : y ? 'y' : 'off'
}

/** Whether a repeat is small enough to be a pattern. */
export const repeatFits = (r: Repeat) => r.width <= MAX_PATTERN && r.height <= MAX_PATTERN

/** A tile's contents kept in the pattern: the document's settings, without what a pattern's tile doesn't carry. */
function tileDoc(d: Doc, name: string, width: number, height: number): Doc {
  const out: Doc = { ...d, name, width, height, selection: null, guides: [] }
  delete out.tiled
  delete out.channels
  return out
}

/**
 * Make Pattern: copies of the layers `ids` as a tile's contents, moved so the
 * box round them (`box`, document pixels) is the tile. The layers stay where
 * they are.
 */
export function patternContent(doc: Doc, ids: NodeId[], box: [number, number, number, number], rootId: NodeId, name: string): Doc {
  const [x0, y0, x1, y1] = [Math.floor(box[0]), Math.floor(box[1]), Math.ceil(box[2]), Math.ceil(box[3])]
  const frag = fragmentOf(doc, ids, rootId)
  const to: Affine = [1, 0, 0, 1, -x0, -y0]
  const nodes: Record<NodeId, DocNode> = {}
  for (const [id, n] of Object.entries(frag.nodes)) nodes[id] = id === rootId ? n : ({ ...n, transform: compose(to, n.transform) } as DocNode)
  return tileDoc({ ...frag, nodes }, name, Math.max(1, x1 - x0), Math.max(1, y1 - y0))
}

/** A pattern made from pixels as a tile's contents: one pixel layer of its repeat. */
export function pixelContent(owner: Doc, p: DocPattern, rootId: NodeId, layerId: NodeId): Doc {
  return tileDoc(pixelFragment(owner, rootId, layerId, p.name, p.tiles, [1, 0, 0, 1, 0, 0]), p.name, p.width, p.height)
}

/** A tile's contents as they come back from editing: the edit tab's document, without its tiling. */
export const contentOf = (tab: Doc, name: string): Doc => tileDoc(tab, name, tab.width, tab.height)
