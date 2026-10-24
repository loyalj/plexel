/**
 * The document, as plain immutable data.
 *
 * One tree of nodes, where raster and vector are equals (ARCHITECTURE.md,
 * "The document model"). Nodes live flat in `nodes`, keyed by id, and refer
 * to each other by id: a group's `children`, any node's `masks` and
 * `effects`. That keeps every edit a shallow copy of the few objects it
 * touches, so history can hold a hundred versions of a document for the
 * price of what changed between them.
 *
 * Pixel data is never in here. A pixel node holds a tile-set id, and the
 * tiles live in the engine's tile store (phase 3).
 *
 * Nothing in this folder imports from the DOM, so Node runs all of it.
 */

import type { GraphicStyle } from './graphicStyles'
import type { VectorBrush } from './vectorBrush'
import type { DocSwatch } from './swatches'
import type { AppearanceItem, Geometry, Paint } from './vector'
import type { TextContent, TextStyles } from './text'
import type { GlyphSet } from '../geom/glyphs'
import type { ColourValue } from '../color/value'
import type { ParamColour } from './params'

/** A text layer's pixels as another app drew them (KindProps['text'].stand). */
export interface TextStand {
  tiles: string
  m: [number, number, number, number, number, number]
}

export type NodeId = string

export type ColourMode = 'rgb' | 'gray' | 'cmyk'
export type Depth = 8 | 16

/**
 * An ICC profile, by reference. `builtin` names one of the profiles the app
 * ships; `asset` is the hash of a profile embedded in the file. The profile
 * data arrives with the colour engine in phase 3; until then a document
 * records which profile it means, and nothing converts.
 */
export type ProfileRef = { builtin: string } | { asset: string }

/** A 2D affine transform, `[a, b, c, d, e, f]` as in canvas and SVG: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = [number, number, number, number, number, number]
export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

export interface LockFlags {
  /** No painting or pixel edits. */
  pixels: boolean
  /** No moving or transforming. */
  position: boolean
  /** Nothing at all. */
  all: boolean
}

/** A layer effect: its kind (an FX_DEFS entry), whether it's on, and its settings as plain JSON. */
export interface LayerFx {
  kind: string
  enabled: boolean
  params: Record<string, unknown>
}

export type ColourTag = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet' | 'gray'

/**
 * Every node carries this. The kind's own properties are in `props`, whose
 * shape NODE_DEFS declares and whose loading each def normalises.
 */
export interface NodeBase<K extends NodeKind = NodeKind> {
  id: NodeId
  kind: K
  name: string
  visible: boolean
  locked: LockFlags
  opacity: number
  /** Opacity of the content only, leaving layer effects at full strength, as in Photoshop. */
  fillOpacity: number
  blend: BlendModeId
  /** Reserved for Photoshop's Blend If ranges; built later. */
  blendIf: null
  transform: Affine
  /** Mask nodes, multiplied together. */
  masks: NodeId[]
  /** Adjustment and filter nodes that apply to this node alone. */
  effects: NodeId[]
  /** Layer effects (shadow, glow, stroke...), from FX_DEFS (fx/defs.ts), drawn in Photoshop's order whatever order they're listed in. */
  fx: LayerFx[]
  /** Containers only. Children are clipped to their parent. */
  children?: NodeId[]
  tag: ColourTag | null
  props: PropsOf<K>
}

export type NodeKind =
  | 'group'
  | 'pixel'
  | 'vector'
  | 'boolean'
  | 'text'
  | 'adjustment'
  | 'filter'
  | 'embedded'
  | 'linked'
  | 'mask'
  | 'fill'
  | 'symbol'

/** The blend modes, Photoshop's set and order. `pass-through` is for groups only. */
export const BLEND_MODES = [
  'pass-through',
  'normal',
  'dissolve',
  'darken',
  'multiply',
  'color-burn',
  'linear-burn',
  'darker-color',
  'lighten',
  'screen',
  'color-dodge',
  'linear-dodge',
  'lighter-color',
  'overlay',
  'soft-light',
  'hard-light',
  'vivid-light',
  'linear-light',
  'pin-light',
  'hard-mix',
  'difference',
  'exclusion',
  'subtract',
  'divide',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const
export type BlendModeId = (typeof BLEND_MODES)[number]

export type BoolOp = 'add' | 'subtract' | 'intersect' | 'exclude'

/**
 * Each kind's own properties. These are the fields the model commits to
 * now. Later phases add fields with defaults in NODE_DEFS, and the loader
 * fills them in for older files, so a field added later needs no format
 * change.
 */
export interface KindProps {
  group: {
    /**
     * Photoshop's knockout: `shallow` lets the group's layers cut through
     * to the layer under the group, `deep` through to the background.
     * Whether a group is folded in the layers panel is view state, kept
     * apart from the document so folding a group is never an undo step.
     */
    knockout: 'none' | 'shallow' | 'deep'
    /**
     * Present on an artboard: a group at the document's top level that is
     * a page of its own (doc/artboards.ts), its corner at the group's
     * transform's translation. Its layers are its children.
     */
    artboard?: Artboard
  }
  pixel: {
    /** The tile set holding this layer's pixels; null while it has none. */
    tiles: string | null
    resample: 'nearest' | 'bilinear' | 'bicubic' | 'lanczos'
  }
  vector: {
    /** A path, or a live shape's parameters, in the node's own coordinates (its transform places them); null for none yet. */
    geometry: Geometry | null
    /** The appearance stack: fills and strokes, drawn in order, the first at the bottom. */
    appearance: AppearanceItem[]
    graphicStyle: string | null
  }
  boolean: {
    /** Each child's operation, by child id. A child missing here adds. The bottom child's is ignored. */
    ops: Record<NodeId, BoolOp>
    /** How the result is painted; its shapes' own appearances aren't drawn. */
    appearance: AppearanceItem[]
    /** The graphic style it's linked to, if any. */
    graphicStyle?: string | null
    /**
     * A Live Paint group, when present: its children are paths whose
     * outlines cut the plane into regions, and each fill paints the region
     * holding its point (in the group's own coordinates). Its children's
     * strokes are drawn over the regions; their fills aren't.
     */
    live?: { fills: LiveFill[] }
  }
  text: {
    /**
     * Point text starts at the node's origin, on its baseline; area text
     * flows into `frame`; path text runs along `frame` from `pathOffset`.
     */
    mode: 'point' | 'area' | 'path'
    content: TextContent
    /** Area text's frame, or path text's path, in the node's own coordinates; null for point text. */
    frame: Geometry | null
    pathOffset: number
    /** How the glyphs are painted, as a shape's appearance stack. */
    appearance: AppearanceItem[]
    /** The graphic style it's linked to, if any. */
    graphicStyle?: string | null
    /**
     * The glyphs laid out, attached by the page to what it sends the engine
     * (which has no fonts). Never saved, never in the history.
     */
    layout?: GlyphSet
    /**
     * How another app drew the text (a Photoshop file's layer pixels): shown
     * instead of the glyphs while a font it asks for is missing or still
     * loading, and let go when the text is edited. `m` places the pixels in
     * the node's own coordinates.
     */
    stand?: TextStand
  }
  adjustment: {
    adjustment: string
    params: Record<string, unknown>
  }
  filter: {
    filter: string
    params: Record<string, unknown>
  }
  embedded: {
    /** Reserved for a sub-document kept as an asset of its own; null while it's held in `content`. */
    asset: string | null
    /**
     * The smart object's contents: a whole document, rendered and laid in
     * through this node's transform at whatever resolution the view needs,
     * so scaling it never loses pixels. In the same mode and depth as the
     * document holding it.
     */
    content: Doc | null
  }
  linked: {
    asset: string | null
    /** The file's name when it was linked, for relinking and for messages. */
    fileName: string
  }
  mask: {
    source: 'pixel' | 'vector'
    /** Coverage tiles (gray: the value is how much shows), in the mask's own pixel grid. */
    tiles: string | null
    /** A vector mask's outline, in the mask's own coordinates: it shows what's inside. Null shows `outside` everywhere. */
    geometry: Geometry | null
    density: number
    feather: number
    invert: boolean
    /**
     * How much shows where the mask has no tiles: 1 for a mask that starts
     * by revealing everything, 0 for one that starts hiding it. Sparse tiles
     * then cost nothing over the parts never painted.
     */
    outside: number
  }
  fill: {
    /**
     * Photoshop's fill layers (Solid Colour, Gradient, Pattern): a paint
     * over the whole plane, without end, which its masks shape. A gradient
     * without a line of its own lies across the canvas.
     */
    paint: Paint
  }
  symbol: {
    /**
     * An instance of one of the document's symbols (doc/symbols.ts), by id:
     * the symbol's contents, placed by the node's transform (from the
     * symbol's own coordinates). Every instance shows the symbol as it is
     * now; edit the symbol and they all change.
     */
    symbol: string
  }
}

/**
 * An artboard: a page of the document with its own size, as Photoshop's,
 * Illustrator's and Affinity's are. Its corner is its group's translation.
 */
export interface Artboard {
  width: number
  height: number
  /** What's under its layers: a colour in the document's mode, or null for transparent. */
  background: ParamColour | null
  /** Whether what's in it shows only inside it (Photoshop's way) or runs over its edge too. */
  clip: boolean
}

/**
 * A symbol: artwork kept once in the document and placed as instances
 * (kind `symbol`). Its contents are a document of their own, as a smart
 * object's are, at the origin.
 */
export interface DocSymbol {
  id: string
  name: string
  content: Doc
}

export type PropsOf<K extends NodeKind> = KindProps[K]
export type DocNode = { [K in NodeKind]: NodeBase<K> }[NodeKind]

/**
 * How a document repeats when it's a tile: not at all, in both directions,
 * or only across (a frieze) or only down. A tiled document is a torus: what
 * leaves one edge comes back at the other, for painting, drawing and the
 * live layers, and its view can show the copies around it.
 */
export type Tiling = 'off' | 'both' | 'x' | 'y'
export const TILINGS: readonly Tiling[] = ['off', 'both', 'x', 'y']

export interface Guide {
  axis: 'x' | 'y'
  /** In document pixels. */
  at: number
}

export interface Doc {
  name: string
  width: number
  height: number
  /** Pixels per inch, for physical units. */
  resolution: number
  mode: ColourMode
  depth: Depth
  profile: ProfileRef
  root: NodeId
  nodes: Record<NodeId, DocNode>
  guides: Guide[]
  /**
   * What's selected: a coverage tile set in document pixels (gray 8-bit, the
   * value is how much a pixel is selected; no tile is nothing selected), or
   * null for no selection. In the history, as in Photoshop.
   */
  selection: Selection | null
  /** Character and paragraph styles, named, for text to refer to; absent is none. */
  textStyles?: TextStyles
  /** Swatches kept in the document: process, global and spot colours (doc/swatches.ts); absent is none. */
  swatches?: DocSwatch[]
  /** Patterns made from pixels, which pattern paints name by id; absent is none. */
  patterns?: DocPattern[]
  /** Alpha and spot channels, in the Channels panel's order; absent is none. */
  channels?: DocChannel[]
  /** Whether the document is a seamless tile, and in which directions; absent is off. */
  tiled?: Tiling
  /** Graphic styles: named appearance stacks shapes and text can be linked to (doc/graphicStyles.ts); absent is none. */
  graphicStyles?: GraphicStyle[]
  /** The vector brushes kept in the document, the Brushes panel's (doc/vectorBrush.ts); absent is none. */
  vectorBrushes?: VectorBrush[]
  /** Symbols: artwork placed as instances that all follow it (doc/symbols.ts); absent is none. */
  symbols?: DocSymbol[]
  /**
   * The highest number each name has been given ("Home" → 7 once "Home 7"
   * was made), so a number freed by deleting its layer isn't given again
   * (doc/tree.ts' freshName); absent is none yet.
   */
  numbered?: Record<string, number>
}

/** A Live Paint group's fill: a point of the region it paints, and the paint. */
export interface LiveFill {
  at: [number, number]
  paint: Paint
}

/** A document's tiling, absent read as off. */
export const tilingOf = (doc: { tiled?: Tiling }): Tiling => doc.tiled ?? 'off'

/** Whether a tiling repeats across and down. */
export function tileWraps(t: Tiling | undefined): { x: boolean; y: boolean } {
  return { x: t === 'both' || t === 'x', y: t === 'both' || t === 'y' }
}

/**
 * A pattern made from pixels (Define Pattern): one repeat, in the
 * document's mode and depth, its pixels a tile set at the origin. Converted
 * with the document, like a pixel layer.
 */
export interface DocPattern {
  id: string
  name: string
  tiles: string
  width: number
  height: number
  /**
   * The artwork the repeat is made from, for a pattern made from artwork or
   * edited in pattern editing mode (doc/patterns.ts): its tile is a document
   * of its own (its canvas the tile), laid out by `tile`; `tiles` is then
   * what that makes, worked out again whenever the artwork changes. Absent
   * for a pattern that is just its pixels.
   */
  art?: PatternArt
}

/** How a pattern's tiles are laid: in a grid, as bricks (rows or columns offset), or as hexagons. */
export type PatternTileType = 'grid' | 'brick-row' | 'brick-column' | 'hex-column' | 'hex-row'
export const PATTERN_TILE_TYPES: PatternTileType[] = ['grid', 'brick-row', 'brick-column', 'hex-column', 'hex-row']

export interface PatternTile {
  type: PatternTileType
  /** For bricks: how far each row (or column) is moved along, as a share of a tile: ½, ⅓, ¼ or ⅕. */
  offset: number
  /** Pixels between tiles across and down; less than 0 overlaps them. */
  spacing: [number, number]
}

export interface PatternArt {
  content: Doc
  tile: PatternTile
}

/**
 * An alpha or spot channel: coverage tiles, as a selection is, placed in
 * the document by `transform` (Crop and Canvas Size move it with the
 * layers, without touching its pixels).
 *
 * An alpha channel is a saved selection, shown as a tint. A spot channel
 * is an ink printed on a plate of its own: its tiles are how much ink (1
 * is full), its name is the ink's, and `ink` is the colour it shows and
 * proofs as, kept in its own space as a swatch's is.
 */
export interface DocChannel {
  id: string
  name: string
  tiles: string | null
  transform: Affine
  /** Absent is alpha. */
  kind?: 'alpha' | 'spot'
  /** An alpha channel's tint on the canvas (sRGB, 0..1); absent is red. */
  tint?: [number, number, number]
  /** An alpha channel's tint opacity, or a spot ink's solidity, 0..1; absent is 0.5 for an alpha, 0 for a spot. */
  opacity?: number
  /** Whether an alpha channel's tint marks what's masked (absent) or what's selected. */
  marks?: 'masked' | 'selected'
  /** A spot channel's ink colour. */
  ink?: ColourValue
}

/** An alpha channel's tint, opacity and what it marks, with the defaults filled in. */
export const ALPHA_TINT: [number, number, number] = [1, 0, 0]
export const channelKind = (c: DocChannel): 'alpha' | 'spot' => c.kind ?? 'alpha'
export const channelOpacity = (c: DocChannel): number => c.opacity ?? (channelKind(c) === 'spot' ? 0 : 0.5)

export interface Selection {
  tiles: string
  /** The path it came from, kept for vector selections (phase 8); null for now. */
  path: unknown
}

/** The limits a document is held to. PSB's maximum is 300,000 pixels a side. */
export const MAX_SIDE = 300_000
export const MIN_RESOLUTION = 1
export const MAX_RESOLUTION = 10_000
