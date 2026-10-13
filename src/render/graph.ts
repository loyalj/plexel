/**
 * The render graph: one composite tile of a document, at one mip level,
 * built from the node tree.
 *
 * The rules, which are Photoshop's (ref/composite.ts has the sums):
 *
 * - Children are drawn in order, bottom first, each onto what's below it
 *   with its blend mode, at its opacity × fill opacity.
 * - A pass-through group (the default) adds nothing of its own: its
 *   children land on the layers below it. Below 100% opacity, the group's
 *   result is faded back towards what was there before it.
 * - Any other group is isolated: its children are composited onto
 *   transparency, and that result is laid on with the group's mode and
 *   opacity.
 * - A node that isn't a group clips its children to itself (clipping is
 *   nesting, ARCHITECTURE.md). Its content is drawn at its fill opacity,
 *   the children laid atop it, and the whole laid on with its own mode and
 *   opacity, as Photoshop's "blend clipped layers as group" does.
 * - A knockout group's children are laid over the knockout backdrop
 *   instead of over each other: shallow, the backdrop below the group (or
 *   transparency, if the group is isolated); deep, the document's bottom
 *   layer.
 *
 * Kinds that draw content register an evaluator in EVALUATORS. A kind
 * without one draws nothing yet (vectors, text and the rest arrive in
 * later phases), and nor do the children clipped to it.
 *
 * An isolated result depends only on what's under its node, so it's cached
 * per node, level and tile, keyed by the subtree's content version
 * (Scene.contentVersion). Editing a layer above a big group redraws that
 * layer over the group's cached result, not the group.
 */
import { tileWraps, type BlendModeId, type DocNode, type NodeKind, type ProfileRef } from '../doc/types'
import { TILE } from '../tiles/format'
import { blendIndex } from './blendModes'
import { type Atlas } from './gpu/atlas'
import type { BufferPool, Kernels, Ring } from './gpu/kernels'
import { AtlasFull, type Resolved, type Residency } from './residency'
import { intersects, warpedRect, type Rect, type Scene } from './scene'
import { strideOf, tileBufferBytes, type BufferFormat } from './shaders/common'
import { programFor, type Program } from '../adjust/defs'
import { ADJUST_PARAMS_BYTES, writeAdjustParams } from './shaders/adjust'
import { FILTER_BY_ID, MAX_REACH, MEDIAN_MAX, boxesFor, filterValues, lensTaps, lightOf, mosaicTaps, motionTaps, surfaceStep, warpOf, type Warp, type WarpEnv } from '../filters/defs'
import { WARP_PARAMS_BYTES, writeWarpParams } from './shaders/warp'
import { FILTER_PARAMS_BYTES, writeFilterParams, type FilterParams } from './shaders/filter'
import { tileRect } from './view'
import { FX_BY_KIND, activeFx, fxValues, type FxKind } from '../fx/defs'
import { shadowOffset } from '../fx/ref'
import { FX_INDEX, FX_PARAMS_BYTES, writeFxParams, type FxParams } from './shaders/fx'
import type { GradientStop } from '../doc/params'
import { geometryPath, paintIn } from '../doc/vector'
import { flattenPath, type Mat } from '../geom/path'
import { fillSegments, gridColumn, regionSegments, segmentGrid, stripSegments, type SegmentGrid } from '../geom/raster'
import { FLATTEN_TOL, levelMatrix, vectorOutline, type ItemOutline, type VectorOutline } from '../vector/outline'
import { pixelEffects, pixelReach, type ItemEffect } from '../vector/itemEffects'
import type { Box } from '../geom/path'
import { PAINT_KIND, gradientAnchor, paintParams, type PaintParams, type PatternImage } from '../vector/paint'
import { PATTERN_BY_ID } from '../vector/patterns'
import { livePaintParts, shapeOf, type BoolCache } from '../vector/shape'
import { PAINT_PARAMS_BYTES, RASTER_OP, RASTER_PARAMS_BYTES, writePaintParams, writeRasterParams } from './shaders/vector'

/** Photoshop's "special eight": with layer effects, Fill fades their blend as Opacity does. */
const SPECIAL_EIGHT = new Set<BlendModeId>(['color-burn', 'linear-burn', 'color-dodge', 'linear-dodge', 'vivid-light', 'linear-light', 'hard-mix', 'difference'])
import { FILTER_INDEX, FLAG_DISSOLVE, FLAG_MASK, OP_INDEX, PARAMS_BYTES, writeParams } from './shaders/composite'
import { MASK_INVERT, MASK_MULTIPLY, MASK_PARAMS_BYTES, writeMaskParams } from './shaders/mask'
import { foldedTiles, invert, multiply, type Matrix } from './view'
import type { Op } from './ref/composite'
import type { LiveStroke } from './strokes'

export interface TileJob {
  scene: Scene
  level: number
  tx: number
  ty: number
  /** The tile's rectangle in document pixels. */
  rect: Rect
  enc: GPUCommandEncoder
  format: BufferFormat
  residency: Residency
  /** Where masks' tiles are read from: gray 8-bit, whatever the document. */
  masks: Residency
  /**
   * In a tiled document, a copy of a layer: draw as if the tile were this
   * far along (document pixels, whole periods), so what's there in the
   * layer lands on this tile. Absent for the layer itself.
   */
  shift?: [number, number]
}

/** A job's tile corner in its level's pixels, moved by its shift: where a copy of a tiled document's layer is read. */
export const originX = (job: TileJob) => job.tx * TILE + (job.shift ? job.shift[0] / 2 ** job.level : 0)
export const originY = (job: TileJob) => job.ty * TILE + (job.shift ? job.shift[1] / 2 ** job.level : 0)
/** The rectangle a job reads, in document pixels: its tile's, moved by its shift. */
const rectOf = (job: TileJob): Rect => (job.shift ? [job.rect[0] + job.shift[0], job.rect[1] + job.shift[1], job.rect[2] + job.shift[0], job.rect[3] + job.shift[1]] : job.rect)
/** A cache key's part for a job's shift. */
const shiftKey = (job: TileJob) => (job.shift ? `@${job.shift[0]},${job.shift[1]}` : '')
/** Whether a job is a copy away from the layer itself. */
const isShifted = (job: TileJob) => !!job.shift && (job.shift[0] !== 0 || job.shift[1] !== 0)
/** Bounds as wide as an adjustment's or a fill layer's (scene.ts' everywhere), or many periods: never copied. */
const isEverywhere = (b: Rect, w: number, h: number) => b[2] - b[0] > 64 * w || b[3] - b[1] > 64 * h

/**
 * What a node's masks make of one tile: an alpha scale (0 when they hide
 * the whole tile), and a coverage buffer when they vary across it.
 */
export interface MaskCover {
  k: number
  buffer: GPUBuffer | null
}
const NO_MASK: MaskCover = { k: 1, buffer: null }

/** What a mask is read as: a mask node, or the selection standing in for one. */
export interface MaskLike {
  id: string
  transform: number[]
  props: { tiles: string | null; outside: number; invert: boolean; density: number; feather: number }
}
const COVER_BYTES = TILE * TILE * 4
/** The widest feather a mask is blurred by, in pixels at the level drawn: a tile either side. */
const MAX_MARGIN = TILE

/** A node kind that draws content of its own. */
export interface Evaluator {
  /**
   * Lays the node's own content onto `dst` with `op`, `blend` and the
   * alpha scale `k`. Returns false when it has nothing on this tile.
   */
  draw(g: Graph, job: TileJob, node: DocNode, dst: GPUBuffer, op: Op, blend: BlendModeId, k: number, kb?: GPUBuffer, mask?: GPUBuffer | null): boolean
}

/** A seed for Dissolve's pattern, from the node's id, so each layer dissolves its own way. */
export function seedOf(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return h >>> 0
}

const RADIUS = { nearest: 1, bilinear: 1, bicubic: 2, lanczos: 3 } as const
/** A window larger than this many tiles a side means the mip level was too fine for the transform's squeeze. */
const MAX_WINDOW = 24
/**
 * While a stroke is on a layer it's read at full resolution, where the
 * stroke tiles are, as long as that's no more than this many tiles a side;
 * zoomed out further, the stroke appears when it's committed.
 */
const MAX_STROKE_WINDOW = 32

type Extent = { x0: number; y0: number; x1: number; y1: number }
const unionExtent = (a: Extent | null, b: Extent | null): Extent | null =>
  !a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }

/** Where a sampled node's tiles come from: a pixel layer's set, or a smart object's contents rendered. */
interface Source {
  /** Its tiles at level 0, inclusive; null for none. */
  base: Extent | null
  resolve(m: number, x: number, y: number): Resolved
  filter: keyof typeof RADIUS
}

function sourceOf(g: Graph, job: TileJob, node: DocNode): Source | null {
  if (node.kind === 'pixel') {
    const set = node.props.tiles
    return { base: set ? job.scene.extentOf(set) : null, resolve: (m, x, y) => (set ? job.residency.resolve(job.enc, set, m, x, y) : { kind: 'empty' }), filter: node.props.resample }
  }
  if (node.kind === 'embedded') {
    const c = node.props.content
    if (!c) return null
    return {
      base: { x0: 0, y0: 0, x1: Math.ceil(c.width / TILE) - 1, y1: Math.ceil(c.height / TILE) - 1 },
      resolve: (m, x, y) => g.subTile(job, node, m, x, y),
      filter: 'bicubic',
    }
  }
  return null
}

/**
 * Pixel layers and smart objects: their tiles through their live
 * transform, from the mip level that suits the zoom, with a stroke being
 * painted laid on as they're read. A smart object's tiles are its contents
 * rendered at that level, so scaling it never loses detail.
 */
const pixelEvaluator: Evaluator = {
  draw(g, job, node, dst, op, blend, k, kb, mask) {
    const src = sourceOf(g, job, node)
    if (!src) return false
    const live = node.kind === 'pixel' ? g.liveStroke(job.scene.key, node.id) : undefined
    if (!src.base && !live) return false
    const ext = job.scene.contentBounds(node)
    if (!intersects(ext, rectOf(job))) return false
    const scale = 2 ** job.level
    // Output pixel (0..256 in the tile) to document pixels, then into the layer.
    const toDoc: Matrix = [scale, 0, 0, scale, originX(job) * scale, originY(job) * scale]
    const toLayer = multiply(invert(node.transform as Matrix), toDoc)
    const squeeze = Math.sqrt(Math.abs(toLayer[0] * toLayer[3] - toLayer[1] * toLayer[2]))
    let m = live ? 0 : squeeze > 1 ? Math.max(0, Math.floor(Math.log2(squeeze) + 1e-9)) : 0
    let withStroke = !!live
    const filterName = src.filter
    const r = RADIUS[filterName]
    const base = src.base
    for (;;) {
      const toMip = multiply([1 / 2 ** m, 0, 0, 1 / 2 ** m, 0, 0], toLayer)
      const pts = [
        [0, 0],
        [TILE, 0],
        [0, TILE],
        [TILE, TILE],
      ].map(([x, y]) => [toMip[0] * x + toMip[2] * y + toMip[4], toMip[1] * x + toMip[3] * y + toMip[5]])
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      const e = withStroke ? unionExtent(base, live!.extent) : base
      if (!e) return false
      const wx0 = Math.max(Math.floor((Math.min(...xs) - r) / TILE), e.x0 >> m)
      const wy0 = Math.max(Math.floor((Math.min(...ys) - r) / TILE), e.y0 >> m)
      const wx1 = Math.min(Math.floor((Math.max(...xs) + r) / TILE), e.x1 >> m)
      const wy1 = Math.min(Math.floor((Math.max(...ys) + r) / TILE), e.y1 >> m)
      if (wx1 < wx0 || wy1 < wy0) return false
      const w = wx1 - wx0 + 1
      const h = wy1 - wy0 + 1
      if (withStroke && (w > MAX_STROKE_WINDOW || h > MAX_STROKE_WINDOW)) {
        // Too far out to read at full size: the layer's mips, without the stroke.
        withStroke = false
        m = squeeze > 1 ? Math.max(0, Math.floor(Math.log2(squeeze) + 1e-9)) : 0
        if (!base) return false
        continue
      }
      if (!withStroke && (w > MAX_WINDOW || h > MAX_WINDOW)) {
        m++
        continue
      }
      const map = multiply([1, 0, 0, 1, -wx0 * TILE, -wy0 * TILE], toMip)
      // On whole pixels at 1:1 every filter is the source itself: take it as it is.
      const aligned = [map[0] - 1, map[1], map[2], map[3] - 1].every((v) => Math.abs(v) < 1e-9) && [map[4], map[5]].every((v) => Math.abs(v - Math.round(v)) < 1e-9)
      const filter = aligned ? 'nearest' : filterName
      const window = new Int32Array(w * h)
      const strokeWindow = withStroke ? new Int32Array(w * h) : null
      const uniforms: number[] = []
      const uniformAt = new Map<string, number>()
      let any = false
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const res: Resolved = base ? src.resolve(m, wx0 + x, wy0 + y) : { kind: 'empty' }
          let v = -1
          if (res.kind === 'slot') v = res.slot
          else if (res.kind === 'uniform') {
            const key = res.value.join()
            let u = uniformAt.get(key)
            if (u === undefined) {
              u = uniformAt.size
              uniformAt.set(key, u)
              const colour = res.value.slice(0, -1)
              uniforms.push(...colour, ...new Array(4 - colour.length).fill(0), res.value[res.value.length - 1], 0, 0, 0)
            }
            v = -2 - u
          }
          if (v !== -1) any = true
          window[y * w + x] = v
          if (strokeWindow) {
            const slot = live!.slotAt(wx0 + x, wy0 + y)
            strokeWindow[y * w + x] = slot
            if (slot >= 0) any = true
          }
        }
      }
      if (!any) return false
      // A copy of a pixel layer in a tiled document: only the layer's pixels in the canvas's rectangle in its own
      // pixels, where they were made. Past it are whole tiles' padding, not pixels to wrap round.
      const doc = job.scene.doc!
      const clip: [number, number, number, number] | undefined =
        isShifted(job) && node.kind === 'pixel' ? [-wx0 * TILE, -wy0 * TILE, doc.width / 2 ** m - wx0 * TILE, doc.height / 2 ** m - wy0 * TILE] : undefined
      g.dispatch(job, dst, {
        clip,
        pixel: { window, uniforms: new Float32Array(uniforms.length ? uniforms : [0, 0, 0, 0, 0, 0, 0, 0]) },
        stroke: strokeWindow ? { window: strokeWindow, live: live! } : undefined,
        m: map,
        filter: FILTER_INDEX[filter],
        win: [wx0, wy0, w, h],
        op,
        blend,
        k,
        kb,
        mask,
        dissolve: blend === 'dissolve' ? seedOf(node.id) : null,
      })
      return true
    }
  },
}

/**
 * Shapes and compound shapes: their appearance stack painted for the tile
 * (each fill and stroke's coverage times its paint, laid on in its blend
 * mode at its opacity), then laid on like any layer.
 */
const vectorEvaluator: Evaluator = {
  draw(g, job, node, dst, op, blend, k, kb, mask) {
    const t = g.vectorTile(job, node)
    if (!t) return false
    g.dispatch(job, dst, { buffer: t.buffer, op, blend, k: k * t.k, kb, mask, dissolve: blend === 'dissolve' ? seedOf(node.id) : null })
    g.release(t.buffer)
    return true
  },
}

/** Fill layers: their paint over the whole tile, which their masks then shape. */
const fillEvaluator: Evaluator = {
  draw(g, job, node, dst, op, blend, k, kb, mask) {
    const t = g.fillTile(job, node)
    if (!t) return false
    g.dispatch(job, dst, { buffer: t, op, blend, k, kb, mask, dissolve: blend === 'dissolve' ? seedOf(node.id) : null })
    g.release(t)
    return true
  },
}

/**
 * Warps in a node's own coordinates (transform `t`) as one map in a
 * shape's coordinates (transform `st`): into the document, back to the
 * node's own, through each warp, and back again.
 */
function bendOf(ws: Warp[], t: readonly number[], st: readonly number[]): (x: number, y: number) => [number, number] | null {
  const inv = (m: readonly number[]) => {
    const d = m[0] * m[3] - m[1] * m[2] || 1e-12
    return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]
  }
  const ap = (m: readonly number[], x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
  const same = t.every((v, i) => Math.abs(v - st[i]) < 1e-12)
  const ti = inv(t)
  const sti = inv(st)
  return (x, y) => {
    let p: [number, number] | null = same ? [x, y] : ap(ti, ...ap(st, x, y))
    for (const w of ws) {
      p = w.forward!(p[0], p[1])
      if (!p) return null
    }
    return same ? p : ap(sti, ...ap(t, p[0], p[1]))
  }
}

export const EVALUATORS: Partial<Record<NodeKind, Evaluator>> = {
  pixel: pixelEvaluator,
  embedded: pixelEvaluator,
  vector: vectorEvaluator,
  boolean: vectorEvaluator,
  text: vectorEvaluator,
  fill: fillEvaluator,
}

/** Outlines kept for this many node-and-level pairs. */
const OUTLINE_CACHE = 512

/**
 * An outline's segments for one tile: sorted into bands of tile rows, all
 * in one pass the first time any tile asks, then each band by tile column
 * (geom/raster.ts, segmentGrid) the first time a tile in it asks. A tile
 * reads only the segments crossing it, and starts from the summed backdrop
 * of all those left of it, so a tile of dense text or a long path costs
 * what's on it, not what's across its band or the whole outline.
 * `rows` is set to that backdrop; the tile's segments are returned.
 */
const bands = new WeakMap<number[], { segs: number[][]; grids: Map<number, SegmentGrid> }>()
const MAX_BANDS = 4096
function tileSegments(segs: number[], tx: number, ty: number, rows: Float64Array): number[] {
  let b = bands.get(segs)
  if (!b) {
    const by: number[][] = []
    for (let i = 0; i < segs.length; i += 4) {
      const lo = Math.min(segs[i + 1], segs[i + 3])
      const hi = Math.max(segs[i + 1], segs[i + 3])
      if (hi <= lo) continue
      const last = Math.min(MAX_BANDS, Math.ceil(hi / TILE))
      for (let r = Math.max(0, Math.floor(lo / TILE)); r < last; r++) (by[r] ??= []).push(segs[i], segs[i + 1], segs[i + 2], segs[i + 3])
    }
    bands.set(segs, (b = { segs: by, grids: new Map() }))
  }
  let g = b.grids.get(ty)
  if (!g) b.grids.set(ty, (g = segmentGrid(b.segs[ty] ?? [], ty * TILE, TILE, TILE)))
  const col = gridColumn(g, tx)
  if (col.left) rows.set(col.left)
  return col.segs
}

interface DispatchSource {
  pixel?: { window: Int32Array; uniforms: Float32Array }
  stroke?: { window: Int32Array; live: LiveStroke }
  buffer?: GPUBuffer
  m?: Matrix
  filter?: number
  win?: [number, number, number, number]
  op: Op
  blend: BlendModeId
  k: number
  kb?: GPUBuffer
  mask?: GPUBuffer | null
  dissolve?: number | null
  clip?: [number, number, number, number]
}

interface CacheEntry {
  buffer: GPUBuffer
  version: string
}

export class Graph {
  private cache = new Map<string, CacheEntry>()
  /** Vector outlines by scene, node and level, with the version they were made for. */
  private outlines = new Map<string, { version: string; outline: VectorOutline | null; transform: Mat }>()
  /** Mask outlines likewise: the segments a vector mask fills. */
  private maskOutlines = new Map<string, { version: string; segs: number[] }>()
  /** Compound shapes' results, by scene. */
  private bools = new Map<string, BoolCache>()
  private cacheBytes = 0
  /** Buffers taken for the tile being built, given back however it ends. */
  private taken: GPUBuffer[] = []
  dispatches = 0
  /** The stroke being painted on a node, if one is: the renderer answers. */
  liveStroke: (doc: string, node: string) => LiveStroke | undefined = () => undefined

  constructor(
    private device: GPUDevice,
    private kernels: Kernels,
    private pool: BufferPool,
    private params: Ring,
    private storage: Ring,
    /** How much GPU memory cached group results may use. */
    private cacheBudget: number,
  ) {}

  private take(job: TileJob, clear: boolean): GPUBuffer {
    const b = this.pool.acquire(job.format)
    this.taken.push(b)
    if (clear) job.enc.clearBuffer(b)
    return b
  }

  private give(b: GPUBuffer) {
    const i = this.taken.indexOf(b)
    if (i >= 0) this.taken.splice(i, 1)
    this.pool.release(b)
  }

  /**
   * The document's composite for one tile, as a buffer the caller gives
   * back to the pool, or null when nothing on it draws. Throws NotReady
   * (tiles coming back from disk) or AtlasFull; the caller tries again.
   */
  renderTile(job: TileJob): GPUBuffer | null {
    const root = job.scene.node(job.scene.doc!.root)
    if (!root) return null
    // A smart object's contents render while the tile they're in is being
    // built, so the buffers taken so far are set aside, not given back.
    const outer = this.taken
    this.taken = []
    const dst = this.take(job, true)
    try {
      const drew = this.drawChildren(job, root, dst)
      this.taken.splice(this.taken.indexOf(dst), 1)
      if (!drew) {
        this.pool.release(dst)
        return null
      }
      return dst
    } finally {
      for (const b of this.taken.splice(0)) this.pool.release(b)
      this.taken = outer
    }
  }

  /** A smart object's contents, as a scene of their own: the renderer keeps them. */
  subScene: (parent: Scene, node: DocNode) => Scene | null = () => null
  /** A CMYK document's profile tables for colour adjustments, on the GPU (null until they're made). */
  cmykTables: (profile: ProfileRef) => GPUBuffer | null = () => null
  /**
   * A pattern of a scene's document made from pixels, with its buffer on
   * the GPU: the renderer answers, building it the first time (and throwing
   * NotReady while it's being read). Undefined for none by that id.
   */
  patternOf: (scene: Scene, id: string) => { image: PatternImage; buffer: GPUBuffer } | undefined = () => undefined
  /** Each pattern image's GPU buffer, as patternOf gave it. */
  private patternBuffers = new WeakMap<PatternImage, GPUBuffer>()
  private patternImage(scene: Scene, id: string): PatternImage | undefined {
    const r = this.patternOf(scene, id)
    if (r) this.patternBuffers.set(r.image, r.buffer)
    return r?.image
  }
  /** Bound where a paint has no pattern image, as the kernel's layout needs a buffer there. */
  private noPattern: GPUBuffer | null = null
  /** Bound as a fill layer's coverage, which the kernel doesn't read. */
  private noCover: GPUBuffer | null = null

  /**
   * Tile (x, y) of a smart object's contents at mip level m, rendered into
   * the tile atlas the first time it's wanted, keyed by the node's version
   * so new contents are new tiles.
   */
  subTile(job: TileJob, node: DocNode, m: number, x: number, y: number): Resolved {
    const content = node.kind === 'embedded' ? node.props.content : null
    const scene = content ? this.subScene(job.scene, node) : null
    if (!content || !scene) return { kind: 'empty' }
    const w = Math.ceil(content.width / 2 ** m) - x * TILE
    const h = Math.ceil(content.height / 2 ** m) - y * TILE
    if (w <= 0 || h <= 0) return { kind: 'empty' }
    const key = `sub:${scene.key}:${job.scene.versions.get(node.id) ?? 0}:${m}:${x},${y}`
    const atlas = job.residency.atlas
    const have = atlas.get(key)
    if (have !== undefined) return { kind: 'slot', slot: have }
    const buf = this.renderTile({ ...job, scene, level: m, tx: x, ty: y, rect: tileRect(m, x, y) as Rect })
    if (!buf) return { kind: 'empty' }
    const slot = atlas.alloc(key)
    if (slot === null) {
      this.pool.release(buf)
      throw new AtlasFull()
    }
    const pipeline = this.kernels.storePipeline(job.format, job.residency.depth)
    const p = this.params.put(new Uint32Array([Math.min(TILE, w), Math.min(TILE, h), 0, 0]))
    const pass = job.enc.beginRenderPass({
      label: 'smart object tile',
      colorAttachments: atlas.textures.map((t) => ({ view: t.createView({ dimension: '2d', baseArrayLayer: slot, arrayLayerCount: 1 }), loadOp: 'clear' as const, storeOp: 'store' as const })),
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: p.buffer, offset: p.offset, size: 16 } },
          { binding: 1, resource: { buffer: buf } },
        ],
      }),
    )
    pass.draw(3)
    pass.end()
    this.pool.release(buf)
    return { kind: 'slot', slot }
  }

  /**
   * One node on its own over transparency, at full strength and in Normal
   * mode, whether it's shown or not: what its thumbnail shows.
   */
  renderNode(job: TileJob, id: string): GPUBuffer | null {
    const n = job.scene.node(id)
    if (!n) return null
    const dst = this.take(job, true)
    try {
      let drew: boolean
      if (n.kind === 'mask') drew = this.showMask(job, n, dst)
      else if (n.kind === 'group') drew = this.drawChildren(job, n, dst)
      else {
        drew = this.drawOwn(job, n, dst, 1)
        if (drew) for (const c of this.visibleChildren(job, n)) this.drawClipped(job, c, dst)
      }
      this.taken.splice(this.taken.indexOf(dst), 1)
      if (!drew) {
        this.pool.release(dst)
        return null
      }
      return dst
    } finally {
      for (const b of this.taken.splice(0)) this.pool.release(b)
    }
  }

  /**
   * A node's own content alone, at full strength, in Normal, through its
   * transform: no masks, nothing clipped to it. What Rasterize bakes.
   */
  renderContent(job: TileJob, id: string): GPUBuffer | null {
    const n = job.scene.node(id)
    if (!n) return null
    const dst = this.take(job, true)
    try {
      const drew = EVALUATORS[n.kind]?.draw(this, job, n, dst, 'over', 'normal', 1) ?? false
      this.taken.splice(this.taken.indexOf(dst), 1)
      if (!drew) {
        this.pool.release(dst)
        return null
      }
      return dst
    } finally {
      for (const b of this.taken.splice(0)) this.pool.release(b)
    }
  }

  private visibleChildren(job: TileJob, n: DocNode): DocNode[] {
    // A compound shape's children are what it's made of, not layers on it.
    if (n.kind === 'boolean') return []
    const out: DocNode[] = []
    for (const id of n.children ?? []) {
      const c = job.scene.node(id)
      if (c && c.visible && this.copies(job, job.scene.bounds(id)).length) out.push(c)
    }
    return out
  }

  /**
   * The jobs a node with these bounds is drawn through on this tile: the
   * tile itself where they meet it; in a tiled document (and a job not
   * already a copy) also each copy a whole period along that reaches it,
   * as the tile shifted that far. Bounds as wide as everywhere (an
   * adjustment, a fill layer) aren't copied.
   */
  /** Whether a job's document is tiled. */
  private tiled(job: TileJob): boolean {
    const w = tileWraps(job.scene.doc?.tiled)
    return w.x || w.y
  }

  copies(job: TileJob, b: Rect | null): TileJob[] {
    if (!b) return []
    const w = tileWraps(job.scene.doc?.tiled)
    const doc = job.scene.doc
    if (job.shift || !doc || (!w.x && !w.y) || isEverywhere(b, doc.width, doc.height)) return intersects(b, rectOf(job)) ? [job] : []
    const r = job.rect
    // Shifts s along an axis where the bounds meet the tile moved by s: b0 < r1 + s and b1 > r0 + s.
    const ks = (b0: number, b1: number, r0: number, r1: number, size: number, on: boolean) => {
      if (!on) return b0 < r1 && b1 > r0 ? [0] : []
      const out: number[] = []
      for (let k = Math.floor((b0 - r1) / size); k * size < b1 - r0; k++) if (b0 < r1 + k * size && b1 > r0 + k * size) out.push(k * size)
      return out
    }
    const out: TileJob[] = []
    // Each a copy, the one in place too: a copy is drawn as itself, and doesn't wrap again.
    for (const sy of ks(b[1], b[3], r[1], r[3], doc.height, w.y)) for (const sx of ks(b[0], b[2], r[0], r[2], doc.width, w.x)) out.push({ ...job, shift: [sx, sy] })
    return out
  }

  /**
   * A node drawn through `draw`, once for each copy of it this tile meets
   * when it's plain (content with nothing that reads round it: no live
   * filters or layer effects, not a group), each copy as itself in every
   * way, mask and all. Anything else is drawn once: what it reads round
   * itself is gathered with its copies (contentTile, drawOwn), so a blur
   * or a shadow over a seam is one, not two halves.
   */
  private eachCopy(job: TileJob, n: DocNode, draw: (j: TileJob) => boolean): boolean {
    const plain = n.kind !== 'group' && n.kind !== 'adjustment' && n.kind !== 'filter' && !this.effectsOf(job, n).length && !(this.fxOf(job, n).length)
    if (!plain || job.shift) return draw(job)
    let drew = false
    for (const j of this.copies(job, job.scene.bounds(n.id))) if (draw(j)) drew = true
    return drew
  }

  private drawChildren(job: TileJob, parent: DocNode, dst: GPUBuffer): boolean {
    let drew = false
    for (const c of this.visibleChildren(job, parent)) {
      // Drawing what's below a filter layer: everything before it, and nothing after.
      if (this.stop && c.id === this.stop.id) {
        this.stop.hit = true
        break
      }
      if (this.eachCopy(job, c, (j) => this.drawNode(j, c, dst))) drew = true
      if (this.stop?.hit) break
    }
    return drew
  }

  /** While what's below a filter layer is drawn: the layer, and whether it's been reached. */
  private stop: { id: string; hit: boolean } | null = null

  /**
   * A filter layer (Affinity's live filter layers): its filter run on
   * everything below it in its context (the nearest isolated group, or the
   * document), gathered round the tile, and laid back over what's there at
   * its opacity and through its masks.
   */
  private drawFilterLayer(job: TileJob, n: DocNode, dst: GPUBuffer): boolean {
    if (n.kind !== 'filter') return false
    const def = FILTER_BY_ID.get(n.props.filter)
    // Filters that move pixels about the canvas work on a layer's own content, not as layers.
    if (!def || def.warp || def.remap) return false
    const mk = this.maskCover(job, n)
    try {
      const k = n.opacity * mk.k
      if (k <= 0) return false
      const ctx = this.isolationOf(job, n)
      if (!ctx) return false
      const effect = { ...n, opacity: 1, blend: 'normal' } as DocNode
      const out = this.runEffects(job, [effect], (j) => ({ buffer: this.belowTile(j, ctx, n), owned: false }))
      if (!out) return false
      this.dispatch(job, dst, { buffer: out, op: 'lerp', blend: 'normal', k, mask: mk.buffer })
      this.give(out)
      return true
    } finally {
      if (mk.buffer) this.give(mk.buffer)
    }
  }

  /** What a filter layer filters is drawn in: the nearest group above it that isn't pass-through, or the document. */
  private isolationOf(job: TileJob, n: DocNode): DocNode | null {
    for (const id of job.scene.ancestors(n.id)) {
      const a = job.scene.node(id)
      if (!a) return null
      // A layer clipped to another isn't a filter layer's place.
      if (a.kind !== 'group') return null
      if (id === job.scene.doc!.root || a.blend !== 'pass-through' || a.props.knockout !== 'none') return a
    }
    return null
  }

  /** Everything below filter layer `n` in its context `ctx`, on one tile, cached by what's in the context. */
  private belowTile(job: TileJob, ctx: DocNode, n: DocNode): GPUBuffer | null {
    const key = `${job.scene.key}:${n.id}:below${job.level}:${job.tx},${job.ty}${shiftKey(job)}:${job.format.store}`
    const version = job.scene.contentVersion(ctx.id)
    const hit = this.cache.get(key)
    if (hit && hit.version === version) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit.buffer
    }
    const buf = this.take(job, true)
    const outer = this.stop
    this.stop = { id: n.id, hit: false }
    let drew: boolean
    try {
      drew = this.drawChildren(job, ctx, buf)
    } finally {
      this.stop = outer
    }
    if (!drew) {
      this.give(buf)
      return null
    }
    this.taken.splice(this.taken.indexOf(buf), 1)
    if (hit) this.evict(key)
    this.cache.set(key, { buffer: buf, version })
    this.cacheBytes += buf.size
    this.trimCache(buf)
    return buf
  }

  /** Whether a node is drawn straight onto the backdrop: content with nothing clipped to it. */
  private isLeaf(job: TileJob, n: DocNode) {
    return n.kind !== 'group' && n.kind !== 'adjustment' && !this.visibleChildren(job, n).length && !this.effectsOf(job, n).length
  }

  /** A node's effects that draw: shown, and of a kind this build knows. */
  effectsOf(job: TileJob, n: DocNode): DocNode[] {
    if (!n.effects.length) return []
    const mode = job.scene.doc!.mode
    const crisp = this.crispWarps(job, n)
    return n.effects
      .map((id) => job.scene.node(id))
      .filter(
        (e): e is DocNode =>
          !!e &&
          e.visible &&
          e.opacity > 0 &&
          !crisp.includes(e) &&
          ((e.kind === 'adjustment' && !!this.program(e, job)) || (e.kind === 'filter' && FILTER_BY_ID.has(e.props.filter) && (!FILTER_BY_ID.get(e.props.filter)!.warp || !!warpOf(e, mode)))),
      )
  }

  /**
   * The warps a shape or text is bent by as outlines rather than as pixels,
   * keeping its edges exact at any zoom: its first effects, while each is a
   * warp that maps forwards, at full opacity, and its paints are all flat
   * colours (a gradient or pattern would stay unbent).
   */
  crispWarps(job: TileJob, n: DocNode): DocNode[] {
    if ((n.kind !== 'vector' && n.kind !== 'text' && n.kind !== 'boolean') || !n.effects.length) return []
    if (n.props.appearance.some((it) => it.enabled && it.paint.kind !== 'solid')) return []
    const mode = job.scene.doc!.mode
    const out: DocNode[] = []
    for (const id of n.effects) {
      const e = job.scene.node(id)
      if (!e || !e.visible || e.opacity <= 0) continue
      if (e.kind !== 'filter' || !FILTER_BY_ID.get(e.props.filter)?.warp) break
      const w = warpOf(e, mode)
      if (!w) continue
      if (!w.forward || e.opacity < 1) break
      out.push(e)
    }
    return out
  }

  private programs = new WeakMap<DocNode, { mode: string; p: Program | null }>()
  /** An adjustment node's program, compiled once per node object. */
  private program(n: DocNode, job: TileJob): Program | null {
    if (n.kind !== 'adjustment') return null
    const mode = job.scene.doc!.mode
    const hit = this.programs.get(n)
    if (hit && hit.mode === mode) return hit.p
    const p = programFor(n.props.adjustment, n.props.params, mode)
    this.programs.set(n, { mode, p })
    return p
  }

  /**
   * A node's own content (with its effects run on it) onto `dst`, over,
   * Normal, at `k`. What a node is before masks, clipped layers and
   * opacity.
   */
  private drawOwn(job: TileJob, n: DocNode, dst: GPUBuffer, k: number): boolean {
    const effects = this.effectsOf(job, n)
    if (!effects.length) {
      // Drawn once in a tiled document (it has layer effects), it's drawn with its copies, for the effects to read round.
      let drew = false
      for (const j of job.shift ? [job] : this.copies(job, job.scene.contentBounds(n, false) ?? rectOf(job))) if (EVALUATORS[n.kind]?.draw(this, j, n, dst, 'over', 'normal', k)) drew = true
      return drew
    }
    const out = this.withEffects(job, n, effects)
    if (!out) return false
    this.dispatch(job, dst, { buffer: out, op: 'over', blend: 'normal', k })
    this.give(out)
    return true
  }

  /**
   * An adjustment layer laid on `dst`: an adjusted copy of what's there,
   * through the layer's blend mode, at its opacity and mask; alpha as it was.
   */
  private drawAdjustment(job: TileJob, n: DocNode, dst: GPUBuffer, k: number, mask: GPUBuffer | null): boolean {
    const p = this.program(n, job)
    if (!p || k <= 0) return false
    const tmp = this.take(job, false)
    job.enc.copyBufferToBuffer(dst, 0, tmp, 0, dst.size)
    this.adjust(job, p, tmp, job.format, 65536)
    this.dispatch(job, dst, { buffer: tmp, op: 'tint', blend: n.blend === 'pass-through' ? 'normal' : n.blend, k, mask })
    this.give(tmp)
    return true
  }

  /** Runs a program on `count` pixels of `buf`, in place. */
  private adjust(job: TileJob, p: Program, buf: GPUBuffer, fmt: BufferFormat, count: number) {
    const mode = job.scene.doc!.mode
    const params = new ArrayBuffer(ADJUST_PARAMS_BYTES)
    const ct = mode === 'cmyk' ? this.cmykTables(job.scene.doc!.profile) : null
    writeAdjustParams(params, p, mode, count, !!ct)
    const pu = this.params.put(params)
    const table = p.table ? this.tableBuffer(p.table) : null
    const pipeline = this.kernels.adjustPipeline(fmt)
    const pass = job.enc.beginComputePass({ label: 'adjust' })
    pass.setPipeline(pipeline)
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: pu.buffer, offset: pu.offset, size: ADJUST_PARAMS_BYTES } },
          { binding: 1, resource: { buffer: buf } },
          { binding: 2, resource: table ? { buffer: table.buffer, offset: table.offset, size: table.size } : { buffer: this.kernels.dummy } },
          ...(mode === 'cmyk' ? [{ binding: 3, resource: { buffer: ct ?? this.kernels.dummy } }] : []),
        ],
      }),
    )
    pass.dispatchWorkgroups(Math.ceil(count / 256))
    pass.end()
    this.dispatches++
  }

  /** Big tables (colour cubes) kept on the GPU, made once each; small ones go through the ring. */
  private tables = new WeakMap<Float32Array, GPUBuffer>()
  private tableBuffer(t: Float32Array): { buffer: GPUBuffer; offset: number; size: number } {
    if (t.length < 16384) return this.storage.put(t)
    let b = this.tables.get(t)
    if (!b) {
      b = this.device.createBuffer({ label: 'adjustment table', size: t.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
      this.device.queue.writeBuffer(b, 0, t as Float32Array<ArrayBuffer>)
      this.tables.set(t, b)
    }
    return { buffer: b, offset: 0, size: t.byteLength }
  }

  /** A job for a neighbouring tile at the same level, in the same encoder. */
  private neighbour(job: TileJob, tx: number, ty: number): TileJob {
    return { ...job, tx, ty, rect: tileRect(job.level, tx, ty) as Rect }
  }

  /**
   * A node's content alone, at full strength, cached per tile: what a live
   * filter gathers from round the tile it's drawing. Kept apart from its
   * effects, so changing a filter's settings doesn't draw the layer again.
   */
  private contentTile(job: TileJob, n: DocNode): GPUBuffer | null {
    const key = `${job.scene.key}:${n.id}:c${job.level}:${job.tx},${job.ty}${shiftKey(job)}:${job.format.store}`
    const version = job.scene.ownVersion(n.id)
    const hit = this.cache.get(key)
    if (hit && hit.version === version) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit.buffer
    }
    // In a tiled document, with the copies of it this tile meets: what's gathered round an edge is what's at the other side.
    const copies = this.copies(job, job.scene.contentBounds(n, false))
    if (!copies.length) return null
    const buf = this.take(job, true)
    let drew = false
    for (const j of copies) if (EVALUATORS[n.kind]?.draw(this, j, n, buf, 'over', 'normal', 1)) drew = true
    if (!drew) {
      this.give(buf)
      return null
    }
    this.taken.splice(this.taken.indexOf(buf), 1)
    if (hit) this.evict(key)
    this.cache.set(key, { buffer: buf, version })
    this.cacheBytes += buf.size
    this.trimCache(buf)
    return buf
  }

  /** A region buffer of `size`² pixels in f32, for the tile being built. */
  private regionBuffer(job: TileJob, size: number): GPUBuffer {
    return this.takeBytes(size * size * strideOf(job.format.mode) * 4)
  }

  /** One filter-kernel dispatch. */
  private filterPass(job: TileJob, entry: 'gather' | 'gather_clip' | 'clamp_read' | 'keep_rect' | 'add_region' | 'crop' | 'box' | 'sharpen' | 'noise' | 'median' | 'motion' | 'mix' | 'lens' | 'surface' | 'stylize' | 'mosaic' | 'despeckle' | 'morph' | 'clouds' | 'shadow', p: FilterParams, bufs: { a?: GPUBuffer; b?: GPUBuffer; src?: GPUBuffer; dst?: GPUBuffer }, groups: [number, number]) {
    const pipeline = this.kernels.filterPipeline(job.format, entry)
    const params = new ArrayBuffer(FILTER_PARAMS_BYTES)
    writeFilterParams(params, p)
    const pu = this.params.put(params)
    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: pu.buffer, offset: pu.offset, size: FILTER_PARAMS_BYTES } }]
    if (bufs.a) entries.push({ binding: 1, resource: { buffer: bufs.a } })
    if (bufs.b) entries.push({ binding: 2, resource: { buffer: bufs.b } })
    if (bufs.src) entries.push({ binding: 3, resource: { buffer: bufs.src } })
    if (bufs.dst) entries.push({ binding: 4, resource: { buffer: bufs.dst } })
    const pass = job.enc.beginComputePass({ label: `filter ${entry}` })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }))
    pass.dispatchWorkgroups(groups[0], groups[1])
    pass.end()
    this.dispatches++
  }

  /** A node's layer effects that draw, with their settings whole, in Photoshop's order. */
  fxOf(job: TileJob, n: DocNode): { kind: FxKind; v: Record<string, unknown> }[] {
    if (!n.fx.length) return []
    const mode = job.scene.doc!.mode
    return activeFx(n.fx)
      .filter((f) => FX_BY_KIND.has(f.kind as FxKind))
      .map((f) => ({ kind: f.kind as FxKind, v: fxValues(f, mode) }))
  }

  /**
   * A node's body for its layer effects, cached per tile: its content (a
   * group's children) with its own effects, at full strength, times its
   * masks.
   */
  private bodyTile(job: TileJob, n: DocNode): GPUBuffer | null {
    const key = `${job.scene.key}:${n.id}:b${job.level}:${job.tx},${job.ty}${shiftKey(job)}:${job.format.store}`
    const version = job.scene.contentVersion(n.id)
    const hit = this.cache.get(key)
    if (hit && hit.version === version) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit.buffer
    }
    let buf = this.take(job, true)
    let drew = n.kind === 'group' ? this.drawChildren(job, n, buf) : this.drawOwn(job, n, buf, 1)
    if (drew && n.masks.length) {
      const mk = this.maskCover(job, n)
      if (mk.k <= 0) drew = false
      else if (mk.k < 1 || mk.buffer) {
        const masked = this.take(job, true)
        this.dispatch(job, masked, { buffer: buf, op: 'lerp', blend: 'normal', k: mk.k, mask: mk.buffer })
        this.give(buf)
        buf = masked
      }
      if (mk.buffer) this.give(mk.buffer)
    }
    if (!drew) {
      this.give(buf)
      return null
    }
    this.taken.splice(this.taken.indexOf(buf), 1)
    if (hit) this.evict(key)
    this.cache.set(key, { buffer: buf, version })
    this.cacheBytes += buf.size
    this.trimCache(buf)
    return buf
  }

  /** One effects-kernel dispatch. */
  private fxPass(job: TileJob, entry: 'shape' | 'pbox' | 'jfa_init' | 'jfa_step' | 'layer' | 'over', p: FxParams, b: { body?: GPUBuffer; plane?: GPUBuffer; seedsOut?: GPUBuffer; seedsIn?: GPUBuffer; out?: GPUBuffer; stops?: Float32Array; next?: GPUBuffer }, groups: number) {
    const pipeline = this.kernels.fxPipeline(job.format, entry)
    const params = new ArrayBuffer(FX_PARAMS_BYTES)
    writeFxParams(params, p)
    const pu = this.params.put(params)
    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: pu.buffer, offset: pu.offset, size: FX_PARAMS_BYTES } }]
    if (b.body) entries.push({ binding: 1, resource: { buffer: b.body } })
    if (b.plane) entries.push({ binding: 2, resource: { buffer: b.plane } })
    if (b.seedsOut) entries.push({ binding: 3, resource: { buffer: b.seedsOut } })
    if (b.seedsIn) entries.push({ binding: 4, resource: { buffer: b.seedsIn } })
    if (b.out) entries.push({ binding: 5, resource: { buffer: b.out } })
    if (b.stops) {
      const st = this.storage.put(b.stops)
      entries.push({ binding: 6, resource: { buffer: st.buffer, offset: st.offset, size: st.size } })
    }
    if (b.next) entries.push({ binding: 7, resource: { buffer: b.next } })
    const pass = job.enc.beginComputePass({ label: `fx ${entry}` })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }))
    pass.dispatchWorkgroups(groups)
    pass.end()
    this.dispatches++
  }

  /**
   * A node with layer effects laid on `dst` (`atop` when it's clipped):
   * shadows and glows onto what's below, each in its own blend mode; then
   * the content at its fill, the effects that sit on it, the layers clipped
   * to it and its stroke, laid on in the node's blend mode at its opacity.
   * Worked out on the node's body gathered round the tile, as fx/ref.ts.
   */
  private drawWithFx(job: TileJob, n: DocNode, dst: GPUBuffer, op: 'over' | 'atop'): boolean {
    const opacity = n.opacity
    if (opacity <= 0) return false
    const list = this.fxOf(job, n)
    const scale = 2 ** job.level
    const mode = job.scene.doc!.mode
    const reach = Math.max(0, ...list.map((f) => FX_BY_KIND.get(f.kind)!.reach(f.v)))
    const M = Math.min(MAX_REACH, Math.ceil(reach / scale) + 2)
    const size = TILE + 2 * M
    const span = Math.ceil(M / TILE)
    const R = this.regionBuffer(job, size)
    job.enc.clearBuffer(R)
    let any = false
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        const t = this.bodyTile(this.neighbour(job, job.tx + dx, job.ty + dy), n)
        if (!t) continue
        any = true
        this.filterPass(job, 'gather', { size, offset: [dx * TILE + M, dy * TILE + M] }, { b: R, src: t }, [TILE / 16, TILE / 16])
      }
    }
    if (!any) return false
    const px = Math.ceil((size * size) / 256)
    const plane = () => this.takeBytes(size * size * 4)
    const shape = (spread: number) => {
      const p = plane()
      this.fxPass(job, 'shape', { size, f0: [0, 0, spread, 0] }, { body: R, out: p }, px)
      return p
    }
    const gauss = (p0: GPUBuffer, sigma: number) => {
      let p = p0
      for (const r of boxesFor(sigma)) {
        const h = plane()
        this.fxPass(job, 'pbox', { size, flags: 1, n: r }, { plane: p, out: h }, Math.ceil(size / 64))
        const w = plane()
        this.fxPass(job, 'pbox', { size, flags: 0, n: r }, { plane: h, out: w }, Math.ceil(size / 64))
        p = w
      }
      return p
    }
    const flood = (inside: boolean) => {
      let a = this.takeBytes(size * size * 4)
      this.fxPass(job, 'jfa_init', { size, flags: inside ? 1 : 0 }, { body: R, next: a }, px)
      let pow = 1
      while (pow < size) pow *= 2
      const steps: number[] = []
      for (let k = pow >> 1; k >= 1; k >>= 1) steps.push(k)
      steps.push(1)
      for (const k of steps) {
        const b = this.takeBytes(size * size * 4)
        this.fxPass(job, 'jfa_step', { size, n: k }, { seedsOut: a, next: b }, px)
        a = b
      }
      return a
    }
    const working = (c: number[]) => (mode === 'cmyk' ? c.map((v) => 1 - v) : c)
    const dummyPlane = this.kernels.dummy
    type Made = { place: 'below' | 'on' | 'over'; buf: GPUBuffer; blend: BlendModeId; k: number }
    const made: Made[] = []
    const layer = (kind: number, p: Omit<FxParams, 'size'>, b: { plane?: GPUBuffer; seedsOut?: GPUBuffer; seedsIn?: GPUBuffer; stops?: Float32Array }) => {
      const out = this.regionBuffer(job, size)
      this.fxPass(job, 'layer', { ...p, size, kind }, { body: R, plane: b.plane ?? dummyPlane, seedsOut: b.seedsOut ?? dummyPlane, seedsIn: b.seedsIn ?? dummyPlane, out, stops: b.stops ?? new Float32Array(8) }, px)
      return out
    }
    const bounds = job.scene.contentBounds(n, false)
    for (const { kind, v } of list) {
      const def = FX_BY_KIND.get(kind)!
      const blend = v.blend as BlendModeId
      const k = (v.opacity as number) / 100
      const colour = v.colour ? working(v.colour as number[]) : [0, 0, 0, 0]
      switch (kind) {
        case 'drop-shadow': {
          const p = gauss(shape((v.spread as number) / 100), (v.size as number) / scale / 2)
          const [ox, oy] = shadowOffset(v.angle as number, (v.distance as number) / scale)
          made.push({ place: def.place, buf: layer(FX_INDEX['drop-shadow'], { f0: [ox, oy, 0, 0], colour }, { plane: p }), blend, k })
          break
        }
        case 'outer-glow': {
          const p = gauss(shape((v.spread as number) / 100), (v.size as number) / scale / 3)
          made.push({ place: def.place, buf: layer(FX_INDEX['outer-glow'], { colour }, { plane: p }), blend, k })
          break
        }
        case 'inner-shadow': {
          const p = gauss(shape((v.choke as number) / 100), (v.size as number) / scale / 2)
          const [ox, oy] = shadowOffset(v.angle as number, (v.distance as number) / scale)
          made.push({ place: def.place, buf: layer(FX_INDEX['inner-shadow'], { f0: [ox, oy, 0, 0], colour }, { plane: p }), blend, k })
          break
        }
        case 'inner-glow': {
          const p = gauss(shape((v.choke as number) / 100), (v.size as number) / scale / 3)
          made.push({ place: def.place, buf: layer(FX_INDEX['inner-glow'], { flags: v.source === 'centre' ? 1 : 0, colour }, { plane: p }), blend, k })
          break
        }
        case 'satin': {
          const p = gauss(shape(0), (v.size as number) / scale / 2)
          const [ox, oy] = shadowOffset(v.angle as number, (v.distance as number) / scale / 2)
          made.push({ place: def.place, buf: layer(FX_INDEX.satin, { f0: [ox, oy, 0, 0], flags: v.invert ? 2 : 0, colour }, { plane: p }), blend, k })
          break
        }
        case 'colour-overlay':
          made.push({ place: def.place, buf: layer(FX_INDEX['colour-overlay'], { colour }, {}), blend, k })
          break
        case 'gradient-overlay': {
          const a = ((v.angle as number) * Math.PI) / 180
          const dir = [Math.cos(a), -Math.sin(a)]
          // The layer's bounds in this region's pixels.
          const ox = originX(job) - M
          const oy = originY(job) - M
          const b = bounds ?? [0, 0, 1, 1]
          const bx0 = b[0] / scale - ox
          const by0 = b[1] / scale - oy
          const bx1 = b[2] / scale - ox
          const by1 = b[3] / scale - oy
          const half = Math.max(1e-6, ((Math.abs((bx1 - bx0) * dir[0]) + Math.abs((by1 - by0) * dir[1])) / 2) * ((v.scale as number) / 100))
          const stops = v.gradient as GradientStop[]
          const data = new Float32Array(stops.length * 5)
          stops.forEach((st, i) => {
            const c = working(st.colour)
            data.set([st.at, c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 0], i * 5)
          })
          made.push({
            place: def.place,
            buf: layer(FX_INDEX['gradient-overlay'], { n: stops.length, f1: [(bx0 + bx1) / 2, (by0 + by1) / 2, dir[0], dir[1]], f2: [half, v.reverse ? 1 : 0, 0, 0] }, { stops: data }),
            blend,
            k,
          })
          break
        }
        case 'pattern-overlay': {
          const a = ((v.angle as number) * Math.PI) / 180
          const cs = Math.cos(a) / (v.scale as number)
          const sn = Math.sin(a) / (v.scale as number)
          // A region pixel's centre in the document: (x + ½) · scale + where the region starts.
          const ox = (originX(job) - M) * scale
          const oy = (originY(job) - M) * scale
          const f1: [number, number, number, number] = [cs * scale, -sn * scale, sn * scale, cs * scale]
          const f2: [number, number, number, number] = [cs * ox + sn * oy, -sn * ox + cs * oy, scale / (v.scale as number), (v.backgroundOpacity as number) / 100]
          const bg = working(v.background as number[])
          made.push({
            place: def.place,
            buf: layer(FX_INDEX['pattern-overlay'], { flags: PATTERN_BY_ID.get(v.pattern as string)?.index ?? 0, f0: [bg[0] ?? 0, bg[1] ?? 0, bg[2] ?? 0, bg[3] ?? 0], f1, f2, colour }, {}),
            blend,
            k,
          })
          break
        }
        case 'bevel': {
          const h = gauss(shape(0), ((v.size as number) + (v.soften as number)) / scale / 2)
          const depth = ((v.depth as number) / 100) * ((v.size as number) / scale) * (v.direction === 'down' ? -1 : 1)
          const a = ((v.angle as number) * Math.PI) / 180
          const alt = ((v.altitude as number) * Math.PI) / 180
          const L: [number, number, number, number] = [Math.cos(alt) * Math.cos(a), -Math.cos(alt) * Math.sin(a), Math.sin(alt), depth]
          const flags = v.style === 'outer' ? 4 : v.style === 'emboss' ? 8 : 0
          made.push({ place: 'on', buf: layer(FX_INDEX['bevel-highlight'], { flags, f1: L, colour: working(v.highlightColour as number[]) }, { plane: h }), blend: v.highlightBlend as BlendModeId, k: (v.highlightOpacity as number) / 100 })
          made.push({ place: 'on', buf: layer(FX_INDEX['bevel-shadow'], { flags, f1: L, colour: working(v.shadowColour as number[]) }, { plane: h }), blend: v.shadowBlend as BlendModeId, k: (v.shadowOpacity as number) / 100 })
          break
        }
        case 'stroke': {
          const w = (v.size as number) / scale
          const pos = v.position as string
          const seedsOut = pos === 'inside' ? undefined : flood(false)
          const seedsIn = pos === 'outside' ? undefined : flood(true)
          const flags = (seedsOut ? 16 : 0) | (seedsIn ? 32 : 0)
          made.push({ place: def.place, buf: layer(FX_INDEX.stroke, { flags, f2: [0, 0, pos === 'centre' ? w / 2 : w, 0], colour }, { seedsOut, seedsIn }), blend, k })
          break
        }
      }
    }
    const crop = (region: GPUBuffer) => {
      const t = this.take(job, false)
      this.filterPass(job, 'crop', { size, offset: [M, M] }, { a: region, dst: t }, [TILE / 16, TILE / 16])
      return t
    }
    const special = SPECIAL_EIGHT.has(n.blend)
    // Below the content: straight onto what's there, each in its own blend mode.
    for (const m of made.filter((x) => x.place === 'below')) {
      const t = crop(m.buf)
      this.dispatch(job, dst, { buffer: t, op, blend: m.blend, k: m.k * opacity })
      this.give(t)
    }
    // The content at its fill, and the effects on it, within its shape.
    const inner = this.regionBuffer(job, size)
    job.enc.clearBuffer(inner)
    this.fxPass(job, 'over', { size, n: blendIndex('normal'), f0: [0, 0, 0, special ? 1 : n.fillOpacity] }, { body: R, out: inner }, px)
    for (const m of made.filter((x) => x.place === 'on')) this.fxPass(job, 'over', { size, n: blendIndex(m.blend), f0: [0, 0, 0, m.k] }, { body: m.buf, out: inner }, px)
    const top = crop(inner)
    if (n.kind !== 'group') for (const c of this.visibleChildren(job, n)) this.drawClipped(job, c, top)
    for (const m of made.filter((x) => x.place === 'over')) {
      const t = crop(m.buf)
      this.dispatch(job, top, { buffer: t, op: 'over', blend: m.blend, k: m.k })
      this.give(t)
    }
    const blend = n.blend === 'pass-through' ? 'normal' : n.blend
    this.dispatch(job, dst, { buffer: top, op, blend, k: opacity * (special ? n.fillOpacity : 1), dissolve: blend === 'dissolve' ? seedOf(n.id) : null })
    this.give(top)
    return true
  }

  /** How far a node's effects read past a pixel, at this level. */
  effectReach(job: TileJob, effects: DocNode[]): number {
    const scale = 2 ** job.level
    const mode = job.scene.doc!.mode
    let m = 0
    for (const e of effects) if (e.kind === 'filter') m += Math.ceil(FILTER_BY_ID.get(e.props.filter)!.reach(filterValues(e.props.filter, e.props.params, mode), scale))
    return Math.min(MAX_REACH, m)
  }

  /**
   * A node's content with its effects run on it, in order: its content
   * tiles round this one gathered into a region as wide as the effects
   * read, each effect run on the region (blended back by its opacity), and
   * the middle cropped out. A buffer for the tile being built, or null.
   */
  private withEffects(job: TileJob, n: DocNode, effects: DocNode[]): GPUBuffer | null {
    // A filter that remaps (Offset) reads from anywhere on the canvas: what comes before it is worked out at the
    // tiles it reads, and what comes after runs on what it gives, as on content.
    // So does a geometric effect (Warp, Liquify), from wherever its warp says.
    let at = -1
    effects.forEach((e, i) => {
      if (e.kind === 'filter' && (FILTER_BY_ID.get(e.props.filter)?.remap || FILTER_BY_ID.get(e.props.filter)?.warp)) at = i
    })
    if (at >= 0) {
      const before = effects.slice(0, at)
      const split = effects[at]
      const warps = split.kind === 'filter' && !!FILTER_BY_ID.get(split.props.filter)?.warp
      return this.runEffects(job, effects.slice(at + 1), (j) => ({ buffer: warps ? this.warpTile(j, n, before, split) : this.remapTile(j, n, before, split), owned: true }))
    }
    return this.runEffects(job, effects, (j) => ({ buffer: this.contentTile(j, n), owned: false }))
  }

  /**
   * A geometric effect's result for one tile (Warp, Liquify): each pixel
   * read from where the warp says, out of what's under the effect (the
   * node's content with the effects before it).
   *
   * Where to read is worked out in doubles at a grid over the tile, through
   * the node's transform (the warp is in its own coordinates), and the
   * kernel interpolates between grid points. What the grid reads from is
   * gathered into a region; where the warp squeezes, from a coarser level
   * of the content, as a mip would be, which also keeps the region small.
   * In a tiled document each copy of the warped node is drawn: the layer
   * itself is warped, and the result repeats.
   */
  private warpTile(job: TileJob, n: DocNode, before: DocNode[], e: DocNode): GPUBuffer | null {
    const doc = job.scene.doc!
    const w = warpOf(e, doc.mode, this.warpEnv(job))
    if (!w) return null
    const L = job.level
    const s = 2 ** L
    const t = n.transform
    const det = t[0] * t[3] - t[1] * t[2] || 1e-12
    const ti = [t[3] / det, -t[1] / det, -t[2] / det, t[0] / det, (t[2] * t[5] - t[3] * t[4]) / det, (t[1] * t[4] - t[0] * t[5]) / det]
    // What's under the effect, in document pixels: the content grown by the effects before it.
    const content = job.scene.contentBounds(n, false)
    if (!content) return null
    const reach = this.effectReach({ ...job, level: 0 }, before)
    const under: Rect = [content[0] - reach, content[1] - reach, content[2] + reach, content[3] + reach]
    const drawn = warpedRect(t, w, under)
    if (!drawn) return null
    const tiled = this.tiled(job)
    const jobs = job.shift ? [job] : this.copies(job, drawn)
    if (!jobs.length) return null
    // Grid points every 8 pixels, or as finely as the warp's detail needs (a Liquify field's spacing, a ripple), to 1.
    const detail = w.detail ? (w.detail * Math.sqrt(Math.abs(det))) / s : Infinity
    const G = Math.min(256, Math.max(32, 2 ** Math.ceil(Math.log2(TILE / Math.max(1e-9, detail)))))
    const cell = TILE / G
    const N = (G + 1) * (G + 1)
    const out = this.regionBuffer(job, TILE)
    job.enc.clearBuffer(out)
    let any = false
    for (const j of jobs) {
      const ox = originX(j)
      const oy = originY(j)
      // Where each grid point reads from, homogeneous, in the level's pixels.
      const H = new Float64Array(N * 3)
      const ok = new Uint8Array(N)
      for (let gy = 0; gy <= G; gy++)
        for (let gx = 0; gx <= G; gx++) {
          const dx = (ox + gx * cell) * s
          const dy = (oy + gy * cell) * s
          const r = w.inverse(ti[0] * dx + ti[2] * dy + ti[4], ti[1] * dx + ti[3] * dy + ti[5])
          if (!r || r[2] <= 1e-12) continue
          const k = gy * (G + 1) + gx
          H[3 * k] = (t[0] * r[0] + t[2] * r[1] + t[4] * r[2]) / s
          H[3 * k + 1] = (t[1] * r[0] + t[3] * r[1] + t[5] * r[2]) / s
          H[3 * k + 2] = r[2]
          ok[k] = 1
        }
      // Points with nothing to read (past a fold, past the content's reach) carried on in a line from their
      // neighbours, a few cells out: a cell along the content's edge is drawn, edge and all, not dropped whole.
      for (let pass = 0; pass < 3; pass++) {
        const add: [number, number, number][] = []
        for (let gy = 0; gy <= G; gy++)
          for (let gx = 0; gx <= G; gx++) {
            const k = gy * (G + 1) + gx
            if (ok[k]) continue
            let sx = 0
            let sy = 0
            let n = 0
            for (const [ddx, ddy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]) {
              const ax = gx + ddx
              const ay = gy + ddy
              const bx = gx + 2 * ddx
              const by = gy + 2 * ddy
              if (bx < 0 || by < 0 || bx > G || by > G) continue
              const a = ay * (G + 1) + ax
              const b = by * (G + 1) + bx
              if (ok[a] !== 1 || ok[b] !== 1) continue
              sx += 2 * (H[3 * a] / H[3 * a + 2]) - H[3 * b] / H[3 * b + 2]
              sy += 2 * (H[3 * a + 1] / H[3 * a + 2]) - H[3 * b + 1] / H[3 * b + 2]
              n++
            }
            if (n) add.push([k, sx / n, sy / n])
          }
        if (!add.length) break
        for (const [k, x, y] of add) {
          H.set([x, y, 1], 3 * k)
          ok[k] = 2
        }
        for (const [k] of add) ok[k] = 1
      }
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (let k = 0; k < N; k++) {
        if (!ok[k]) continue
        const px = H[3 * k] / H[3 * k + 2]
        const py = H[3 * k + 1] / H[3 * k + 2]
        x0 = Math.min(x0, px)
        y0 = Math.min(y0, py)
        x1 = Math.max(x1, px)
        y1 = Math.max(y1, py)
      }
      if (x1 < x0) continue
      // How much the warp squeezes here: how much cells' areas grow, where they read the content (a perspective's
      // far side, past it, doesn't count). Most of them, not the worst, choose the level.
      const ux0 = under[0] / s - cell
      const uy0 = under[1] / s - cell
      const ux1 = under[2] / s + cell
      const uy1 = under[3] / s + cell
      const sides: number[] = []
      const at = (k: number) => [H[3 * k] / H[3 * k + 2], H[3 * k + 1] / H[3 * k + 2]]
      const reads = (p: number[]) => p[0] >= ux0 && p[0] <= ux1 && p[1] >= uy0 && p[1] <= uy1
      for (let gy = 0; gy <= G; gy++)
        for (let gx = 0; gx <= G; gx++) {
          const k = gy * (G + 1) + gx
          if (!ok[k]) continue
          const p = at(k)
          if (!reads(p)) continue
          // How much a cell's area shrinks (a shear or a ripple moves things without squeezing them).
          if (gx < G && gy < G && ok[k + 1] && ok[k + G + 1]) {
            const q1 = at(k + 1)
            const q2 = at(k + G + 1)
            if (reads(q1) && reads(q2)) sides.push(Math.sqrt(Math.abs((q1[0] - p[0]) * (q2[1] - p[1]) - (q1[1] - p[1]) * (q2[0] - p[0]))) / cell)
          }
        }
      sides.sort((a, b) => a - b)
      const squeeze = Math.max(1, sides.length ? sides[Math.floor(sides.length * 0.75)] : 1)
      // Only where there's something to read: the content under the effect, at this level.
      const fx0 = Math.max(x0, under[0] / s) - 2
      const fy0 = Math.max(y0, under[1] / s) - 2
      const fx1 = Math.min(x1, under[2] / s) + 2
      const fy1 = Math.min(y1, under[3] / s) + 2
      if (fx1 <= fx0 || fy1 <= fy0) continue
      let Ls = L + Math.max(0, Math.min(12, Math.floor(Math.log2(squeeze) + 1e-9)))
      let side = 0
      for (;;) {
        side = Math.ceil(Math.max(fx1 - fx0, fy1 - fy0) * 2 ** (L - Ls)) + 4
        if (side <= 1024 || Ls >= L + 16) break
        Ls++
      }
      const k = 2 ** (L - Ls)
      side = Math.min(1024, side)
      const rx = Math.floor(fx0 * k) - 1
      const ry = Math.floor(fy0 * k) - 1
      const region = this.regionBuffer(job, side)
      job.enc.clearBuffer(region)
      let got = false
      for (let ty = Math.floor(ry / TILE); ty * TILE < ry + side; ty++)
        for (let tx = Math.floor(rx / TILE); tx * TILE < rx + side; tx++) {
          // The layer itself, never a copy: in a tiled document it's the warped result that repeats.
          const rj: TileJob = { ...job, level: Ls, tx, ty, rect: tileRect(Ls, tx, ty) as Rect, shift: tiled ? [0, 0] : undefined }
          const src = before.length ? { buffer: this.withEffects(rj, n, before), owned: true } : { buffer: this.contentTile(rj, n), owned: false }
          if (!src.buffer) continue
          got = true
          this.filterPass(job, 'gather', { size: side, offset: [tx * TILE - rx, ty * TILE - ry] }, { b: region, src: src.buffer }, [TILE / 16, TILE / 16])
          if (src.owned) this.give(src.buffer)
        }
      if (!got) continue
      // The grid relative to the region's corner (in the tile's level): still linear, so still exact to interpolate.
      const grid = new Float32Array(N * 4)
      const cx = rx / k
      const cy = ry / k
      for (let i = 0; i < N; i++) {
        if (!ok[i]) continue
        const W = H[3 * i + 2]
        grid.set([H[3 * i] - cx * W, H[3 * i + 1] - cy * W, W, 1], i * 4)
      }
      const params = new ArrayBuffer(WARP_PARAMS_BYTES)
      // Where the warp jumps (a seam), a pixel reads as its nearest grid point does: past a cell's sides stretched 4 times over.
      writeWarpParams(params, { size: side, cells: G, k, seam: w.seams ? cell * k * 4 * Math.max(1, squeeze) : 0 })
      const pu = this.params.put(params)
      const pg = this.storage.put(grid)
      const pipeline = this.kernels.warpPipeline(job.format.mode)
      const pass = job.enc.beginComputePass({ label: 'warp' })
      pass.setPipeline(pipeline)
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: pu.buffer, offset: pu.offset, size: WARP_PARAMS_BYTES } },
            { binding: 1, resource: { buffer: pg.buffer, offset: pg.offset, size: pg.size } },
            { binding: 2, resource: { buffer: region } },
            { binding: 3, resource: { buffer: out } },
          ],
        }),
      )
      pass.dispatchWorkgroups(TILE / 16, TILE / 16)
      pass.end()
      this.dispatches++
      any = true
    }
    if (!any) return null
    const result = this.take(job, false)
    this.filterPass(job, 'crop', { size: TILE, offset: [0, 0] }, { a: out, dst: result }, [TILE / 16, TILE / 16])
    return result
  }

  /** What a warp may read from the document: its patterns (Displace's map), which may still be coming (NotReady). */
  private warpEnv(job: TileJob): WarpEnv {
    const mode = job.scene.doc!.mode
    return { mode, pattern: (id) => this.patternImage(job.scene, id) }
  }

  /**
   * A remapping filter's result for one tile (Offset): each pixel from where
   * the filter says on the canvas, read from what's under the filter there
   * (the node's content with the effects before it), the tiles it needs
   * gathered whole and clipped to the canvas. In a level's pixels; a
   * coarser level rounds the canvas and the shift to its pixels.
   */
  private remapTile(job: TileJob, n: DocNode, before: DocNode[], e: DocNode): GPUBuffer | null {
    if (e.kind !== 'filter') return null
    const doc = job.scene.doc!
    const s = 2 ** job.level
    const v = filterValues(e.props.filter, e.props.params, doc.mode)
    const W = Math.max(1, Math.round(doc.width / s))
    const H = Math.max(1, Math.round(doc.height / s))
    const dx = Math.round((v.horizontal as number) / s)
    const dy = Math.round((v.vertical as number) / s)
    const ox = originX(job)
    const oy = originY(job)
    // In a tiled document Offset's result repeats, as the document does: effects after it gather it round the
    // edges. Otherwise only the canvas has a result.
    const w = tileWraps(doc.tiled)
    const tiled = w.x || w.y
    const periodic = v.edge === 'wrap' && tiled
    if (!tiled && (ox >= W || oy >= H || ox + TILE <= 0 || oy + TILE <= 0)) return null
    const read = (tx: number, ty: number): { buffer: GPUBuffer | null; owned: boolean } => {
      const j = this.neighbour(job, tx, ty)
      return before.length ? { buffer: this.withEffects(j, n, before), owned: true } : { buffer: this.contentTile(j, n), owned: false }
    }
    // A rectangle of source pixels (on the canvas) into region b, its corner landing at (px, py).
    const place = (b: GPUBuffer, size: number, r: [number, number, number, number], px: number, py: number) => {
      let any = false
      for (let ty = Math.floor(r[1] / TILE); ty * TILE < r[3]; ty++)
        for (let tx = Math.floor(r[0] / TILE); tx * TILE < r[2]; tx++) {
          const t = read(tx, ty)
          if (!t.buffer) continue
          any = true
          const clip: [number, number, number, number] = [r[0] - tx * TILE, r[1] - ty * TILE, r[2] - tx * TILE, r[3] - ty * TILE]
          this.filterPass(job, 'gather_clip', { size, offset: [tx * TILE - r[0] + px, ty * TILE - r[1] + py], f: clip }, { b, src: t.buffer }, [TILE / 16, TILE / 16])
          if (t.owned) this.give(t.buffer)
        }
      return any
    }
    const cut = (r: [number, number, number, number]): [number, number, number, number] | null => {
      const c: [number, number, number, number] = [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(W, r[2]), Math.min(H, r[3])]
      return c[2] > c[0] && c[3] > c[1] ? c : null
    }
    // The result for a tile whose corner is at (ox, oy), into a cleared region; whether anything's there.
    const at = (ox: number, oy: number, out: GPUBuffer): boolean => {
      let any = false
      const src: [number, number, number, number] = [ox - dx, oy - dy, ox - dx + TILE, oy - dy + TILE]
      if (v.edge === 'repeat') {
        // The pixels the tile reads, held inside the canvas: a window no bigger than a tile.
        const cx0 = Math.min(W - 1, Math.max(0, src[0]))
        const cy0 = Math.min(H - 1, Math.max(0, src[1]))
        const cx1 = Math.min(W - 1, Math.max(0, src[2] - 1)) + 1
        const cy1 = Math.min(H - 1, Math.max(0, src[3] - 1)) + 1
        const win = this.regionBuffer(job, TILE)
        job.enc.clearBuffer(win)
        any = place(win, TILE, [cx0, cy0, cx1, cy1], 0, 0)
        if (any) this.filterPass(job, 'clamp_read', { size: TILE, offset: [src[0] - cx0, src[1] - cy0], f: [0, 0, cx1 - cx0 - 1, cy1 - cy0 - 1] }, { a: win, b: out }, [TILE / 16, TILE / 16])
      } else {
        // Wrap Around: the source a period away too, wherever it lands on the canvas; transparent: just where it is.
        const wrap = v.edge === 'wrap'
        const ks = (lo: number, hi: number, period: number) => (wrap ? Array.from({ length: Math.floor(hi / period) - Math.floor(lo / period) + 1 }, (_, i) => (Math.floor(lo / period) + i) * period) : [0])
        for (const ky of ks(src[1], src[3] - 1, H))
          for (const kx of ks(src[0], src[2] - 1, W)) {
            const r = cut([src[0] - kx, src[1] - ky, src[2] - kx, src[3] - ky])
            if (r && place(out, TILE, r, r[0] - (src[0] - kx), r[1] - (src[1] - ky))) any = true
          }
      }
      // Only the canvas has a result: pixels of the tile past its edge are cleared.
      if (any && (ox + TILE > W || oy + TILE > H || ox < 0 || oy < 0)) {
        // Past the canvas: kept where Wrap Around repeats, cleared otherwise.
        const keep: [number, number, number, number] = [periodic && w.x ? -1e9 : -ox, periodic && w.y ? -1e9 : -oy, periodic && w.x ? 1e9 : W - ox, periodic && w.y ? 1e9 : H - oy]
        this.filterPass(job, 'keep_rect', { size: TILE, f: keep }, { b: out }, [TILE / 16, TILE / 16])
      }
      return any
    }
    const out = this.regionBuffer(job, TILE)
    job.enc.clearBuffer(out)
    let any = false
    const inside = ox >= 0 && oy >= 0 && ox + TILE <= W && oy + TILE <= H
    if (!tiled || periodic || inside) any = at(ox, oy, out)
    else {
      // Repeat Edge Pixels or Set to Transparent in a tiled document: each part of the tile as at its place on the
      // canvas, a whole number of periods away, those parts added together.
      const pieces = (o: number, size: number, on: boolean): [number, number, number][] => {
        if (!on) return [[0, TILE, 0]]
        const r: [number, number, number][] = []
        for (let a = 0; a < TILE; ) {
          const k = Math.floor((o + a) / size)
          const b = Math.min(TILE, (k + 1) * size - o)
          r.push([a, b, k * size])
          a = b
        }
        return r
      }
      const part = this.regionBuffer(job, TILE)
      for (const [y0, y1, ky] of pieces(oy, H, w.y))
        for (const [x0, x1, kx] of pieces(ox, W, w.x)) {
          job.enc.clearBuffer(part)
          if (!at(ox - kx, oy - ky, part)) continue
          any = true
          this.filterPass(job, 'keep_rect', { size: TILE, f: [x0, y0, x1, y1] }, { b: part }, [TILE / 16, TILE / 16])
          this.filterPass(job, 'add_region', { size: TILE }, { a: part, b: out }, [Math.ceil((TILE * TILE * strideOf(job.format.mode)) / 256), 1])
        }
    }
    if (!any) return null
    const result = this.take(job, false)
    this.filterPass(job, 'crop', { size: TILE, offset: [0, 0] }, { a: out, dst: result }, [TILE / 16, TILE / 16])
    return result
  }

  /**
   * Effects run on a node's tiles, in order: the tiles round this one, from
   * `source`, gathered into a region as wide as the effects read, each
   * effect run on the region (blended back by its opacity), and the middle
   * cropped out. A buffer for the tile being built, or null.
   */
  private runEffects(job: TileJob, effects: DocNode[], source: (j: TileJob) => { buffer: GPUBuffer | null; owned: boolean }): GPUBuffer | null {
    const M = this.effectReach(job, effects)
    const size = TILE + 2 * M
    const span = Math.ceil(M / TILE)
    const S = strideOf(job.format.mode)
    let cur = this.regionBuffer(job, size)
    job.enc.clearBuffer(cur)
    let any = false
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        const t = source(this.neighbour(job, job.tx + dx, job.ty + dy))
        if (!t.buffer) continue
        any = true
        this.filterPass(job, 'gather', { size, offset: [dx * TILE + M, dy * TILE + M] }, { b: cur, src: t.buffer }, [TILE / 16, TILE / 16])
        if (t.owned) this.give(t.buffer)
      }
    }
    if (!any) return null
    const mode = job.scene.doc!.mode
    const scale = 2 ** job.level
    const lines = Math.ceil(size / 64)
    const pixels = Math.ceil((size * size) / 256)
    const f32: BufferFormat = { mode: job.format.mode, store: 'f32' }
    const working = (c: number[]) => (mode === 'cmyk' ? c.map((x) => 1 - x) : c)
    for (const e of effects) {
      const input = cur
      let out: GPUBuffer
      if (e.kind === 'adjustment') {
        out = this.regionBuffer(job, size)
        job.enc.copyBufferToBuffer(input, 0, out, 0, input.size)
        this.adjust(job, this.program(e, job)!, out, f32, size * size)
      } else {
        const id = (e as DocNode & { kind: 'filter' }).props.filter
        const v = filterValues(id, (e as DocNode & { kind: 'filter' }).props.params, mode)
        const blur = (from: GPUBuffer, sigma: number | null, box?: number): GPUBuffer => {
          const radii = box !== undefined ? (box > 0 ? [box] : []) : boxesFor(sigma!)
          let x = from
          for (const r of radii) {
            const h = this.regionBuffer(job, size)
            this.filterPass(job, 'box', { size, r, flags: 1 }, { a: x, b: h }, [lines, 1])
            const w = this.regionBuffer(job, size)
            this.filterPass(job, 'box', { size, r, flags: 0 }, { a: h, b: w }, [lines, 1])
            x = w
          }
          if (x === from) {
            // Nothing to blur: a copy, so the input stays the input.
            x = this.regionBuffer(job, size)
            job.enc.copyBufferToBuffer(from, 0, x, 0, from.size)
          }
          return x
        }
        switch (id) {
          case 'gaussian-blur':
            out = blur(input, (v.radius as number) / scale)
            break
          case 'box-blur':
            out = blur(input, null, Math.round((v.radius as number) / scale))
            break
          case 'unsharp-mask':
          case 'high-pass': {
            out = blur(input, (v.radius as number) / scale)
            this.filterPass(job, 'sharpen', { size, flags: id === 'high-pass' ? 1 : 0, f: [(v.amount as number) / 100, (v.threshold as number) / 255, 0, 0] }, { a: input, b: out }, [pixels, 1])
            break
          }
          case 'add-noise': {
            out = this.regionBuffer(job, size)
            const flags = (v.distribution === 'gaussian' ? 2 : 0) | (v.monochromatic ? 4 : 0)
            this.filterPass(job, 'noise', { size, flags, origin: [originX(job) - M, originY(job) - M], f: [(v.amount as number) / 100, 0, 0, 0], seed: seedOf(e.id) }, { a: input, b: out }, [pixels, 1])
            break
          }
          case 'median': {
            out = this.regionBuffer(job, size)
            const r = Math.min(MEDIAN_MAX, Math.round((v.radius as number) / scale))
            if (r <= 0) job.enc.copyBufferToBuffer(input, 0, out, 0, input.size)
            else this.filterPass(job, 'median', { size, r }, { a: input, b: out }, [pixels, 1])
            break
          }
          case 'motion-blur': {
            out = this.regionBuffer(job, size)
            const d = (v.distance as number) / scale
            const n = motionTaps(v.angle as number, d).length
            this.filterPass(job, 'motion', { size, n, f: [0, v.angle as number, d, 0] }, { a: input, b: out }, [pixels, 1])
            break
          }
          case 'lens-blur': {
            out = this.regionBuffer(job, size)
            const r = (v.radius as number) / scale
            this.filterPass(job, 'lens', { size, n: lensTaps(r), f: [r, ((v.brightness as number) / 100) * 4, (v.threshold as number) / 255, 0] }, { a: input, b: out }, [pixels, 1])
            break
          }
          case 'surface-blur': {
            out = this.regionBuffer(job, size)
            const r = Math.max(0, Math.round((v.radius as number) / scale))
            this.filterPass(job, 'surface', { size, r, flags: surfaceStep(r), f: [(v.threshold as number) / 255, 0, 0, 0] }, { a: input, b: out }, [pixels, 1])
            break
          }
          case 'smart-sharpen': {
            const r = (v.radius as number) / scale
            if (v.remove === 'gaussian') out = blur(input, r)
            else {
              out = this.regionBuffer(job, size)
              if (v.remove === 'lens') this.filterPass(job, 'lens', { size, n: lensTaps(r), f: [r, 0, 1, 0] }, { a: input, b: out }, [pixels, 1])
              else {
                const d = (2 * (v.radius as number)) / scale
                this.filterPass(job, 'motion', { size, n: motionTaps(v.angle as number, d).length, f: [0, v.angle as number, d, 0] }, { a: input, b: out }, [pixels, 1])
              }
            }
            this.filterPass(job, 'sharpen', { size, flags: 0, f: [(v.amount as number) / 100, (((v.noise as number) / 100) * 16) / 255, 0, 0] }, { a: input, b: out }, [pixels, 1])
            break
          }
          case 'emboss':
          case 'find-edges':
          case 'solarize':
          case 'lighting': {
            out = this.regionBuffer(job, size)
            const flags = { emboss: 0, 'find-edges': 1, solarize: 2, lighting: 3 }[id]
            let f: [number, number, number, number] = [0, 0, 0, 0]
            let f2: [number, number, number, number] = [0, 0, 0, 0]
            let f3: [number, number, number, number] = [0, 0, 0, 0]
            if (id === 'emboss') {
              const a = ((v.angle as number) * Math.PI) / 180
              const h = (v.height as number) / scale
              f = [Math.cos(a) * h, -Math.sin(a) * h, (v.amount as number) / 100, 0]
            } else if (id === 'lighting') {
              const L = lightOf(v)
              f = [v.height as number, (v.ambience as number) / 100, (v.gloss as number) / 100, 0]
              f2 = [L[0], L[1], L[2], (v.intensity as number) / 100]
              const c = working(v.colour as number[])
              f3 = [c[0] ?? 1, c[1] ?? 1, c[2] ?? 1, c[3] ?? 1]
            }
            this.filterPass(job, 'stylize', { size, flags, f, f2, f3 }, { a: input, b: out }, [pixels, 1])
            break
          }
          case 'clouds': {
            out = this.regionBuffer(job, size)
            const a = working(v.from as number[])
            const b = working(v.to as number[])
            this.filterPass(
              job,
              'clouds',
              { size, origin: [originX(job) - M, originY(job) - M], f: [(v.scale as number) / scale, 0, 0, 0], seed: (v.seed as number) >>> 0, f2: [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0], f3: [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0] },
              { a: input, b: out },
              [pixels, 1],
            )
            break
          }
          case 'mosaic': {
            out = this.regionBuffer(job, size)
            const cell = Math.max(1, (v.cell as number) / scale)
            this.filterPass(job, 'mosaic', { size, origin: [originX(job) - M, originY(job) - M], f: [cell, 0, 0, 0], n: mosaicTaps(cell) }, { a: input, b: out }, [pixels, 1])
            break
          }
          case 'dust-scratches': {
            out = this.regionBuffer(job, size)
            const r = Math.min(MEDIAN_MAX, Math.round((v.radius as number) / scale))
            if (r <= 0) job.enc.copyBufferToBuffer(input, 0, out, 0, input.size)
            else {
              this.filterPass(job, 'median', { size, r }, { a: input, b: out }, [pixels, 1])
              this.filterPass(job, 'despeckle', { size, f: [(v.threshold as number) / 255, 0, 0, 0] }, { a: input, b: out }, [pixels, 1])
            }
            break
          }
          case 'drop-shadow':
          case 'outer-glow': {
            const glow = id === 'outer-glow'
            const blurred = blur(input, (v.size as number) / scale / (glow ? 3 : 2))
            out = this.regionBuffer(job, size)
            job.enc.copyBufferToBuffer(input, 0, out, 0, input.size)
            const a = ((glow ? 0 : (v.angle as number)) * Math.PI) / 180
            const d = glow ? 0 : (v.distance as number) / scale
            const c = working(v.colour as number[])
            this.filterPass(job, 'shadow', { size, f: [(v.opacity as number) / 100, -Math.cos(a) * d, Math.sin(a) * d, 0], f2: [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 0] }, { a: blurred, b: out }, [pixels, 1])
            break
          }
          case 'minimum':
          case 'maximum': {
            const r = Math.max(1, Math.round((v.radius as number) / scale))
            const big = id === 'maximum' ? 2 : 0
            const h = this.regionBuffer(job, size)
            this.filterPass(job, 'morph', { size, r, flags: 1 | big }, { a: input, b: h }, [lines, 1])
            out = this.regionBuffer(job, size)
            this.filterPass(job, 'morph', { size, r, flags: big }, { a: h, b: out }, [lines, 1])
            break
          }
          default:
            out = input
        }
      }
      // An effect in a blend mode of its own is laid over what it was given in that mode, at its opacity, as
      // Photoshop's smart filters' blending options are; otherwise one below full opacity is mixed back with it.
      const mode2 = e.blend === 'pass-through' ? 'normal' : e.blend
      if (mode2 !== 'normal' && out !== input) {
        const laid = this.regionBuffer(job, size)
        job.enc.copyBufferToBuffer(input, 0, laid, 0, input.size)
        this.fxPass(job, 'over', { size, n: blendIndex(mode2), f0: [0, 0, 0, e.opacity] }, { body: out, out: laid }, pixels)
        out = laid
      } else if (e.opacity < 1 && out !== input) this.filterPass(job, 'mix', { size, f: [0, 0, 0, e.opacity] }, { a: input, b: out }, [Math.ceil((size * size * S) / 256), 1])
      cur = out
    }
    const result = this.take(job, false)
    this.filterPass(job, 'crop', { size, offset: [M, M] }, { a: cur, dst: result }, [TILE / 16, TILE / 16])
    return result
  }

  private drawNode(job: TileJob, n: DocNode, dst: GPUBuffer): boolean {
    if (n.kind === 'filter') return this.drawFilterLayer(job, n, dst)
    // Layer effects work from the layer's masked shape, so masks go in first there.
    if (n.kind !== 'adjustment' && this.fxOf(job, n).length) return this.drawWithFx(job, n, dst, 'over')
    const mk = this.maskCover(job, n)
    if (mk.k <= 0) return false
    try {
      if (n.kind === 'adjustment') return this.drawAdjustment(job, n, dst, n.opacity * n.fillOpacity * mk.k, mk.buffer)
      if (n.kind === 'group' && n.props.knockout !== 'none') return this.drawKnockout(job, n, dst, mk)
      if (n.kind === 'group' && n.blend === 'pass-through') {
        const k = n.opacity * n.fillOpacity * mk.k
        if (k >= 1 && !mk.buffer) return this.drawChildren(job, n, dst)
        if (k <= 0) return false
        const tmp = this.take(job, false)
        job.enc.copyBufferToBuffer(dst, 0, tmp, 0, dst.size)
        const drew = this.drawChildren(job, n, tmp)
        if (drew) this.dispatch(job, dst, { buffer: tmp, op: 'lerp', blend: 'normal', k, mask: mk.buffer })
        this.give(tmp)
        return drew
      }
      if (n.kind !== 'group' && this.isLeaf(job, n)) {
        return EVALUATORS[n.kind]?.draw(this, job, n, dst, 'over', n.blend, n.opacity * n.fillOpacity * mk.k, undefined, mk.buffer) ?? false
      }
      const iso = this.isolated(job, n)
      if (!iso) return false
      const blend = n.blend === 'pass-through' ? 'normal' : n.blend
      this.dispatch(job, dst, { buffer: iso.buffer, op: 'over', blend, k: iso.k * mk.k, mask: mk.buffer, dissolve: blend === 'dissolve' ? seedOf(n.id) : null })
      iso.done()
      return true
    } finally {
      if (mk.buffer) this.give(mk.buffer)
    }
  }

  /** A child of a non-group node: laid atop its parent's content. */
  private drawClipped(job: TileJob, c: DocNode, base: GPUBuffer): boolean {
    if (c.kind === 'filter') return false
    const blend = c.blend === 'pass-through' ? 'normal' : c.blend
    if (c.kind !== 'adjustment' && this.fxOf(job, c).length) return this.drawWithFx(job, c, base, 'atop')
    const mk = this.maskCover(job, c)
    if (mk.k <= 0) return false
    try {
      // Clipped, an adjustment adjusts only the layer it's clipped to: tint keeps alpha.
      if (c.kind === 'adjustment') return this.drawAdjustment(job, c, base, c.opacity * c.fillOpacity * mk.k, mk.buffer)
      if (this.isLeaf(job, c)) return EVALUATORS[c.kind]?.draw(this, job, c, base, 'atop', blend, c.opacity * c.fillOpacity * mk.k, undefined, mk.buffer) ?? false
      const iso = this.isolated(job, c)
      if (!iso) return false
      this.dispatch(job, base, { buffer: iso.buffer, op: 'atop', blend, k: iso.k * mk.k, mask: mk.buffer, dissolve: blend === 'dissolve' ? seedOf(c.id) : null })
      iso.done()
      return true
    } finally {
      if (mk.buffer) this.give(mk.buffer)
    }
  }

  /**
   * A node's result over transparency, with the alpha scale to lay it on
   * with: its opacity, and for a group its fill too. From the cache when
   * nothing under the node has changed.
   */
  private isolated(job: TileJob, n: DocNode): { buffer: GPUBuffer; k: number; done(): void } | null {
    const k = n.kind === 'group' ? n.opacity * n.fillOpacity : n.opacity
    if (k <= 0) return null
    const key = `${job.scene.key}:${n.id}:${job.level}:${job.tx},${job.ty}${shiftKey(job)}:${job.format.store}`
    const version = job.scene.contentVersion(n.id)
    const hit = this.cache.get(key)
    if (hit && hit.version === version) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return { buffer: hit.buffer, k, done: () => {} }
    }
    const buf = this.take(job, true)
    let drew: boolean
    if (n.kind === 'group') drew = this.drawChildren(job, n, buf)
    else {
      drew = this.drawOwn(job, n, buf, n.fillOpacity)
      if (drew) for (const c of this.visibleChildren(job, n)) this.eachCopy(job, c, (j) => this.drawClipped(j, c, buf))
    }
    if (!drew) {
      this.give(buf)
      return null
    }
    // Kept: it now belongs to the cache, not to this tile.
    this.taken.splice(this.taken.indexOf(buf), 1)
    if (hit) this.evict(key)
    this.cache.set(key, { buffer: buf, version })
    this.cacheBytes += buf.size
    this.trimCache(buf)
    return { buffer: buf, k, done: () => {} }
  }

  private drawKnockout(job: TileJob, n: DocNode, dst: GPUBuffer, mk: MaskCover): boolean {
    if (n.kind !== 'group') return false
    const k = n.opacity * n.fillOpacity * mk.k
    if (k <= 0) return false
    const pass = n.blend === 'pass-through'
    const acc = this.take(job, !pass)
    if (pass) job.enc.copyBufferToBuffer(dst, 0, acc, 0, dst.size)
    let kb: GPUBuffer
    if (n.props.knockout === 'shallow') {
      kb = this.take(job, !pass)
      if (pass) job.enc.copyBufferToBuffer(dst, 0, kb, 0, dst.size)
    } else {
      kb = this.take(job, true)
      const bottom = job.scene.node(job.scene.node(job.scene.doc!.root)?.children?.[0] ?? '')
      if (bottom && bottom.id !== n.id && !job.scene.ancestors(n.id).includes(bottom.id) && bottom.visible) this.eachCopy(job, bottom, (j) => this.drawNode(j, bottom, kb))
    }
    let drew = false
    for (const c of this.visibleChildren(job, n)) {
      const blend = c.blend === 'pass-through' ? 'normal' : c.blend
      // In a tiled document, each copy of a child knocks out on its own.
      const one = (j: TileJob): boolean => {
        const cm = this.maskCover(j, c)
        if (cm.k <= 0) return false
        let did = false
        if (c.kind === 'adjustment') did = this.drawAdjustment(j, c, acc, c.opacity * c.fillOpacity * cm.k, cm.buffer)
        else if (this.isLeaf(j, c)) did = EVALUATORS[c.kind]?.draw(this, j, c, acc, 'knock', blend, c.opacity * c.fillOpacity * cm.k, kb, cm.buffer) ?? false
        else {
          const iso = this.isolated(j, c)
          if (iso) {
            this.dispatch(j, acc, { buffer: iso.buffer, op: 'knock', blend, k: iso.k * cm.k, kb, mask: cm.buffer, dissolve: blend === 'dissolve' ? seedOf(c.id) : null })
            iso.done()
            did = true
          }
        }
        if (cm.buffer) this.give(cm.buffer)
        return did
      }
      if (this.eachCopy(job, c, one)) drew = true
    }
    if (drew) this.dispatch(job, dst, pass ? { buffer: acc, op: 'lerp', blend: 'normal', k, mask: mk.buffer } : { buffer: acc, op: 'over', blend: n.blend, k, mask: mk.buffer })
    this.give(acc)
    this.give(kb)
    return drew
  }

  private evict(key: string) {
    const e = this.cache.get(key)
    if (!e) return
    this.cache.delete(key)
    this.cacheBytes -= e.buffer.size
    this.pool.release(e.buffer)
  }

  private trimCache(keep: GPUBuffer) {
    for (const [key, e] of this.cache) {
      if (this.cacheBytes <= this.cacheBudget) break
      if (e.buffer === keep) continue
      this.evict(key)
    }
  }

  /** Forgets cached results of a document, or of nodes no longer in it. */
  forget(sceneKey: string, keepNodes?: ReadonlySet<string>) {
    for (const key of [...this.cache.keys()]) {
      const [s, id] = key.split(':')
      if (s === sceneKey && (!keepNodes || !keepNodes.has(id))) this.evict(key)
    }
    for (const map of [this.outlines, this.maskOutlines] as Map<string, unknown>[]) {
      for (const key of [...map.keys()]) {
        const [s, id] = key.split('|')
        if (s === sceneKey && (!keepNodes || !keepNodes.has(id))) map.delete(key)
      }
    }
    if (!keepNodes) this.bools.delete(sceneKey)
  }

  // --- vectors -------------------------------------------------------------------------------

  /** A shape's outline at the job's level, made when its version changes. */
  private outlineOf(job: TileJob, n: DocNode): { outline: VectorOutline | null; transform: Mat } {
    const scene = job.scene
    const mode = scene.doc!.mode
    const key = `${scene.key}|${n.id}|${job.level}`
    const crisp = this.crispWarps(job, n)
    const version = `${scene.ownVersion(n.id)}|${mode}${crisp.length ? `|${crisp.map((e) => `${e.id}:${scene.versions.get(e.id) ?? 0}`).join(',')}` : ''}`
    const hit = this.outlines.get(key)
    if (hit && hit.version === version) {
      this.outlines.delete(key)
      this.outlines.set(key, hit)
      return hit
    }
    let bools = this.bools.get(scene.key)
    if (!bools) this.bools.set(scene.key, (bools = new Map()))
    let entry: { version: string; outline: VectorOutline | null; transform: Mat }
    try {
      // A Live Paint group: its regions' fills and its paths' strokes, each part outlined on its own.
      if (n.kind === 'boolean' && n.props.live) {
        const parts = livePaintParts((id) => scene.node(id), n, bools, (id) => scene.contentVersion(id))
        const outs = parts.map((p) => vectorOutline(p.path, p.appearance, [1, 0, 0, 1, 0, 0], job.level, mode))
        const live = { version, outline: { items: outs.flatMap((o) => o.items.map((it) => ({ ...it, pathBox: o.pathBox }))), pathBox: null }, transform: [1, 0, 0, 1, 0, 0] as Mat }
        this.outlines.set(key, live)
        return live
      }
      const shape = shapeOf((id) => scene.node(id), n, bools, (id) => scene.contentVersion(id))
      const bend = crisp.length ? bendOf(crisp.map((e) => warpOf(e, mode)!), n.transform, shape?.transform ?? n.transform) : undefined
      entry = { version, outline: shape ? vectorOutline(shape.path, shape.appearance, shape.transform, job.level, mode, bend) : null, transform: shape?.transform ?? [1, 0, 0, 1, 0, 0] }
    } catch (e) {
      // A shape that can't be worked out draws nothing, once said, rather
      // than stopping every frame of the document with it.
      console.error(`“${n.name}” couldn’t be drawn:`, e)
      entry = { version, outline: null, transform: [1, 0, 0, 1, 0, 0] }
    }
    this.outlines.set(key, entry)
    if (this.outlines.size > OUTLINE_CACHE) this.outlines.delete(this.outlines.keys().next().value!)
    return entry
  }

  /**
   * A shape's appearance painted for one tile, over transparency: each fill
   * and stroke's coverage times its paint, laid on in order. With a single
   * item in Normal, that item's own buffer, its opacity left for the caller
   * to lay it on with (k). Null when nothing of it is on the tile.
   */
  vectorTile(job: TileJob, n: DocNode): { buffer: GPUBuffer; k: number } | null {
    const { outline, transform } = this.outlineOf(job, n)
    if (!outline || !outline.items.length) return null
    const x0 = originX(job)
    const y0 = originY(job)
    const mode = job.scene.doc!.mode
    // A tile pixel to the shape's own coordinates, for gradients and patterns.
    const toNode = multiply(invert(levelMatrix(transform, job.level) as Matrix), [1, 0, 0, 1, x0, y0])
    let first: { buffer: GPUBuffer; k: number; blend: BlendModeId } | null = null
    let acc: GPUBuffer | null = null
    for (const [idx, it] of outline.items.entries()) {
      const fx = pixelEffects(it.item.effects)
      // An item with pixel effects reaches past its outline by as far as they read.
      const grow = fx.length ? pixelReach(fx, mode) / 2 ** job.level + 2 : 0
      const b = it.box
      if (!b || b[2] + grow <= x0 || b[0] - grow >= x0 + TILE || b[3] + grow <= y0 || b[1] - grow >= y0 + TILE) continue
      const buf = fx.length ? this.itemWithEffects(job, n, idx, fx) : this.paintItem(job, it, it.pathBox ?? outline.pathBox, toNode, x0, y0)
      if (!buf) continue
      if (!first && !acc) {
        first = { buffer: buf, k: it.item.opacity, blend: it.item.blend }
        continue
      }
      if (!acc) {
        acc = this.take(job, true)
        this.dispatch(job, acc, { buffer: first!.buffer, op: 'over', blend: first!.blend, k: first!.k })
        this.give(first!.buffer)
        first = null
      }
      this.dispatch(job, acc, { buffer: buf, op: 'over', blend: it.item.blend, k: it.item.opacity })
      this.give(buf)
    }
    if (acc) return { buffer: acc, k: 1 }
    if (!first) return null
    if (first.blend === 'normal') return { buffer: first.buffer, k: first.k }
    // One item in a blend mode of its own, over nothing: laid on by the rule all the same.
    const one = this.take(job, true)
    this.dispatch(job, one, { buffer: first.buffer, op: 'over', blend: first.blend, k: first.k })
    this.give(first.buffer)
    return { buffer: one, k: 1 }
  }

  /**
   * One fill or stroke of a shape painted for one tile, over transparency:
   * its coverage from its segments (clipped, for a stroke inside or outside
   * the shape) times its paint. Null when none of it is on the tile.
   */
  private paintItem(job: TileJob, it: ItemOutline, pathBox: Box | null, toNode: Matrix, x0: number, y0: number): GPUBuffer | null {
    const mode = job.scene.doc!.mode
    const local: number[] = []
    const rows = new Float64Array(TILE)
    // The bands are for tiles where they are: a copy (or a tile left of or above the canvas) reads every segment.
    const banded = !job.shift && job.tx >= 0 && job.ty >= 0
    if (!regionSegments(banded ? tileSegments(it.segs, job.tx, job.ty, rows) : it.segs, x0, y0, TILE, TILE, local, rows) && !rows.some((v) => v !== 0)) return null
    const cover = this.takeBytes(COVER_BYTES)
    this.raster(job, cover, local, rows, TILE, TILE, it.rule === 'evenodd', RASTER_OP.write)
    if (it.clip) {
      const clip: number[] = []
      const clipRows = new Float64Array(TILE)
      if (regionSegments(banded ? tileSegments(it.clip.segs, job.tx, job.ty, clipRows) : it.clip.segs, x0, y0, TILE, TILE, clip, clipRows) || clipRows.some((v) => v !== 0)) this.raster(job, cover, clip, clipRows, TILE, TILE, it.clip.rule === 'evenodd', it.clip.mode === 'inside' ? RASTER_OP.inside : RASTER_OP.outside)
      else if (it.clip.mode === 'inside') {
        // No fill here: nothing of an inside stroke either.
        this.give(cover)
        return null
      }
    }
    const buf = this.take(job, false)
    this.paint(job, buf, cover, paintParams(it.item.paint, mode, toNode, pathBox, (id) => this.patternImage(job.scene, id)))
    this.give(cover)
    return buf
  }

  /**
   * One fill or stroke painted for a tile on its own, cached: what its pixel
   * effects gather from round the tile they're for.
   */
  private itemTile(job: TileJob, n: DocNode, idx: number): GPUBuffer | null {
    const key = `${job.scene.key}:${n.id}:i${idx}:${job.level}:${job.tx},${job.ty}${shiftKey(job)}:${job.format.store}`
    const version = job.scene.contentVersion(n.id)
    const hit = this.cache.get(key)
    if (hit && hit.version === version) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit.buffer
    }
    const { outline, transform } = this.outlineOf(job, n)
    const it = outline?.items[idx]
    if (!it) return null
    const x0 = originX(job)
    const y0 = originY(job)
    const toNode = multiply(invert(levelMatrix(transform, job.level) as Matrix), [1, 0, 0, 1, x0, y0])
    const buf = this.paintItem(job, it, it.pathBox ?? outline!.pathBox, toNode, x0, y0)
    if (!buf) return null
    this.taken.splice(this.taken.indexOf(buf), 1)
    if (hit) this.evict(key)
    this.cache.set(key, { buffer: buf, version })
    this.cacheBytes += buf.size
    this.trimCache(buf)
    return buf
  }

  /** A fill or stroke with its pixel effects run on it (live filters, shadows and glows), gathered round the tile. */
  private itemWithEffects(job: TileJob, n: DocNode, idx: number, fx: ItemEffect[]): GPUBuffer | null {
    // As filter nodes, for runEffects: the effect's kind is a filter's id.
    const effects = fx.map((e, k) => ({ id: `${n.id}~${idx}~${k}`, kind: 'filter', name: e.kind, visible: true, opacity: 1, blend: 'normal', props: { filter: e.kind, params: e.params } }) as unknown as DocNode)
    return this.runEffects(job, effects, (j) => ({ buffer: this.itemTile(j, n, idx), owned: false }))
  }

  /**
   * A fill layer's paint for one tile, premultiplied, over the whole tile.
   * A gradient without a line of its own lies across the canvas, in the
   * layer's own coordinates, so it moves with the layer.
   */
  fillTile(job: TileJob, n: DocNode): GPUBuffer | null {
    if (n.kind !== 'fill') return null
    const doc = job.scene.doc!
    const toNode = multiply(invert(levelMatrix(n.transform as Mat, job.level) as Matrix), [1, 0, 0, 1, originX(job), originY(job)])
    const p = paintParams(paintIn(n.props.paint, doc.mode), doc.mode, toNode, [0, 0, doc.width, doc.height], (id) => this.patternImage(job.scene, id))
    if (p.kind === PAINT_KIND.image && !p.image) return null
    // In a tiled document a gradient along a line runs on over the seam it was dragged across: each pixel from its
    // copy nearest the line's anchor (in the level's pixels, relative to this tile).
    const w = tileWraps(doc.tiled)
    const anchor = gradientAnchor(n.props.paint)
    if (anchor && (w.x || w.y)) {
      const t = n.transform
      const s = 2 ** job.level
      const ax = (t[0] * anchor[0] + t[2] * anchor[1] + t[4]) / s - originX(job)
      const ay = (t[1] * anchor[0] + t[3] * anchor[1] + t[5]) / s - originY(job)
      p.wrap = [w.x ? doc.width / s : 0, w.y ? doc.height / s : 0, ax, ay]
    }
    const buf = this.take(job, false)
    this.noCover ??= this.device.createBuffer({ label: 'no cover', size: COVER_BYTES, usage: GPUBufferUsage.STORAGE })
    this.paint(job, buf, this.noCover, { ...p, full: true })
    return buf
  }

  /** Coverage of a w x h region from its segments (regionSegments's), written into `cover` or combined with it. */
  private raster(job: TileJob, cover: GPUBuffer, segs: number[], rows: Float64Array, w: number, h: number, evenodd: boolean, op: number) {
    const params = new ArrayBuffer(RASTER_PARAMS_BYTES)
    writeRasterParams(params, { w, h, n: segs.length / 4, evenodd, op })
    const pu = this.params.put(params)
    const strips = stripSegments(segs, h)
    const ps = this.storage.put(strips.segs)
    const pr = this.storage.put(new Float32Array(rows))
    const po = this.storage.put(strips.offsets)
    const pipeline = this.kernels.rasterPipeline()
    const pass = job.enc.beginComputePass({ label: 'vector raster' })
    pass.setPipeline(pipeline)
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: pu.buffer, offset: pu.offset, size: RASTER_PARAMS_BYTES } },
          { binding: 1, resource: { buffer: ps.buffer, offset: ps.offset, size: Math.floor(ps.size / 16) * 16 } },
          { binding: 2, resource: { buffer: cover } },
          { binding: 3, resource: { buffer: pr.buffer, offset: pr.offset, size: pr.size } },
          { binding: 4, resource: { buffer: po.buffer, offset: po.offset, size: po.size } },
        ],
      }),
    )
    pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16))
    pass.end()
    this.dispatches++
  }

  /** Coverage times a paint into a composite tile buffer. */
  private paint(job: TileJob, out: GPUBuffer, cover: GPUBuffer, p: PaintParams) {
    const params = new ArrayBuffer(PAINT_PARAMS_BYTES)
    writePaintParams(params, p)
    const pu = this.params.put(params)
    const st = this.storage.put(p.stops)
    const pipeline = this.kernels.paintPipeline(job.format)
    this.noPattern ??= this.device.createBuffer({ label: 'no pattern', size: 16, usage: GPUBufferUsage.STORAGE })
    const pat = (p.image && this.patternBuffers.get(p.image)) || this.noPattern
    const pass = job.enc.beginComputePass({ label: 'vector paint' })
    pass.setPipeline(pipeline)
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: pu.buffer, offset: pu.offset, size: PAINT_PARAMS_BYTES } },
          { binding: 1, resource: { buffer: cover, offset: 0, size: COVER_BYTES } },
          { binding: 2, resource: { buffer: st.buffer, offset: st.offset, size: st.size } },
          { binding: 3, resource: { buffer: out } },
          { binding: 4, resource: { buffer: pat } },
        ],
      }),
    )
    pass.dispatchWorkgroups(TILE / 16, TILE / 16)
    pass.end()
    this.dispatches++
  }

  /** The segments a vector mask fills at the job's level, made when the mask changes. */
  private maskSegments(job: TileJob, m: DocNode & { kind: 'mask' }): number[] {
    const key = `${job.scene.key}|${m.id}|${job.level}`
    const version = job.scene.ownVersion(m.id)
    const hit = this.maskOutlines.get(key)
    if (hit && hit.version === version) return hit.segs
    const segs = fillSegments(flattenPath(geometryPath(m.props.geometry), FLATTEN_TOL, levelMatrix(m.transform, job.level)))
    this.maskOutlines.set(key, { version, segs })
    if (this.maskOutlines.size > OUTLINE_CACHE) this.maskOutlines.delete(this.maskOutlines.keys().next().value!)
    return segs
  }

  /**
   * A vector mask over this tile: what its outline covers (inside shows),
   * feathered, inverted and thinned by density as a pixel mask is, through
   * the same blur and finish. A constant where its outline doesn't reach.
   */
  private vectorCoverOf(job: TileJob, m: DocNode & { kind: 'mask' }, into: GPUBuffer | null, wrapAll = false): number | GPUBuffer {
    const path = geometryPath(m.props.geometry)
    if (!path.subpaths.length) return Graph.constantOf(m)
    const scale = 2 ** job.level
    const sigma = m.props.feather / 2 / scale
    const margin = sigma >= 0.25 ? Math.min(MAX_MARGIN, Math.ceil(sigma * 3)) : 0
    const size = TILE + 2 * margin
    const local: number[] = []
    const rows = new Float64Array(size)
    // Wrapping, with the outline's copies a period either side.
    let segs = this.maskSegments(job, m)
    const w = tileWraps(job.scene.doc?.tiled)
    if (wrapAll && (w.x || w.y)) {
      const doc = job.scene.doc!
      const px = doc.width / 2 ** job.level
      const py = doc.height / 2 ** job.level
      const all: number[] = []
      for (const ky of w.y ? [-1, 0, 1] : [0])
        for (const kx of w.x ? [-1, 0, 1] : [0]) for (let i = 0; i < segs.length; i += 4) all.push(segs[i] + kx * px, segs[i + 1] + ky * py, segs[i + 2] + kx * px, segs[i + 3] + ky * py)
      segs = all
    }
    const n = regionSegments(segs, originX(job) - margin, originY(job) - margin, size, size, local, rows)
    if (!n && !rows.some((v) => v !== 0)) {
      // Wholly outside the outline here: hidden, unless inverted.
      const v = m.props.invert ? 1 : 0
      return 1 - m.props.density * (1 - v)
    }
    const out = into ?? this.takeBytes(COVER_BYTES)
    const wide = this.pool.acquireBytes(size * size * 4)
    const across = margin ? this.pool.acquireBytes(TILE * size * 4) : wide
    this.raster(job, wide, local, rows, size, size, path.fillRule === 'evenodd', RASTER_OP.write)
    this.finishMask(job, { wide, across, out, size, margin, invert: m.props.invert, multiply: !!into, density: m.props.density, sigma })
    this.pool.release(wide)
    if (across !== wide) this.pool.release(across)
    return out
  }

  /** A mask's coverage in `wide` (size x size pixels, the tile and its margin) blurred, inverted and thinned into `out`. */
  private finishMask(job: TileJob, o: { wide: GPUBuffer; across: GPUBuffer; out: GPUBuffer; size: number; margin: number; invert: boolean; multiply: boolean; density: number; sigma: number }) {
    const params = new ArrayBuffer(MASK_PARAMS_BYTES)
    writeMaskParams(params, {
      m: [1, 0, 0, 1, 0, 0],
      win: [0, 0, 0, 0],
      resample: 0,
      size: o.size,
      margin: o.margin,
      flags: (o.invert ? MASK_INVERT : 0) | (o.multiply ? MASK_MULTIPLY : 0),
      outside: 0,
      density: o.density,
      sigma: Math.max(o.sigma, 1e-3),
    })
    const p = this.params.put(params)
    const pipes = this.kernels.maskPipelines(false)
    const uniform = { binding: 0, resource: { buffer: p.buffer, offset: p.offset, size: MASK_PARAMS_BYTES } }
    const run = (pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[], x: number, y: number, label: string) => {
      const pass = job.enc.beginComputePass({ label })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [uniform, ...entries] }))
      pass.dispatchWorkgroups(Math.ceil(x / 16), Math.ceil(y / 16))
      pass.end()
      this.dispatches++
    }
    if (o.margin) run(pipes.blurH, [{ binding: 2, resource: { buffer: o.wide } }, { binding: 3, resource: { buffer: o.across } }], TILE, o.size, 'mask blur')
    run(pipes.finish, [{ binding: 1, resource: { buffer: o.out } }, { binding: 3, resource: { buffer: o.across } }], TILE, TILE, 'mask finish')
  }

  get cachedBytes() {
    return this.cacheBytes
  }

  /**
   * A node's masks over this tile, multiplied together. Masks that are one
   * value across the whole tile (no tiles of theirs here) come back as a
   * plain scale, costing no buffer; 0 hides the node here altogether. A
   * buffer returned is the caller's to give back.
   */
  maskCover(job: TileJob, n: DocNode): MaskCover {
    if (!n.masks.length) return NO_MASK
    let k = 1
    let buffer: GPUBuffer | null = null
    for (const id of n.masks) {
      const m = job.scene.node(id)
      if (!m || m.kind !== 'mask' || !m.visible) continue
      // Drawn once in a tiled document (a group, an adjustment, a layer that reads round itself), its masks repeat too.
      const wrap = !job.shift && this.tiled(job)
      const r: number | GPUBuffer = m.props.source === 'vector' ? this.vectorCoverOf(job, m, buffer, wrap) : this.coverOf(job, m, buffer, wrap)
      if (typeof r === 'number') {
        k *= r
        if (k <= 0) break
      } else buffer = r
    }
    if (k <= 0) {
      if (buffer) this.give(buffer)
      return { k: 0, buffer: null }
    }
    return k >= 1 && !buffer ? NO_MASK : { k, buffer }
  }

  /** What a mask is where it has no tiles: its outside value, inverted and thinned by its density. */
  private static constantOf(m: MaskLike): number {
    let v = m.props.outside
    if (m.props.invert) v = 1 - v
    return 1 - m.props.density * (1 - v)
  }

  /**
   * One mask over this tile: a constant when it's one value throughout,
   * or its coverage written (or multiplied, when `into` already holds an
   * earlier mask's) into a coverage buffer. A stroke being painted on it
   * is laid on as it's read. Also how the selection is read for its
   * overlay, as a mask that hides where nothing is selected.
   */
  coverOf(job: TileJob, m: MaskLike, into: GPUBuffer | null, wrapAll = false): number | GPUBuffer {
    const constant = Graph.constantOf(m)
    // Wrapping, a mask moved only (not turned or scaled) repeats in its own pixels, as a pixel layer's copies do.
    const t = m.transform
    const wraps = tileWraps(job.scene.doc?.tiled)
    const wrapOn = wrapAll && t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1
    const set = m.props.tiles
    const live = this.liveStroke(job.scene.key, m.id)
    const base = set ? job.scene.extentOf(set) : null
    if (!base && !live?.extent) return constant
    const scale = 2 ** job.level
    const sigma = m.props.feather / 2 / scale
    const margin = sigma >= 0.25 ? Math.min(MAX_MARGIN, Math.ceil(sigma * 3)) : 0
    const size = TILE + 2 * margin
    const toDoc: Matrix = [scale, 0, 0, scale, originX(job) * scale, originY(job) * scale]
    const toMask = multiply(invert(m.transform as Matrix), toDoc)
    const squeeze = Math.sqrt(Math.abs(toMask[0] * toMask[3] - toMask[1] * toMask[2]))
    const mipFor = () => (squeeze > 1 ? Math.max(0, Math.floor(Math.log2(squeeze) + 1e-9)) : 0)
    let withStroke = !!live?.extent
    let lv = withStroke ? 0 : mipFor()
    for (;;) {
      const e = withStroke ? unionExtent(base, live!.extent) : base
      if (!e) return constant
      const toMip = multiply([1 / 2 ** lv, 0, 0, 1 / 2 ** lv, 0, 0], toMask)
      const pts = [
        [-margin, -margin],
        [TILE + margin, -margin],
        [-margin, TILE + margin],
        [TILE + margin, TILE + margin],
      ].map(([x, y]) => [toMip[0] * x + toMip[2] * y + toMip[4], toMip[1] * x + toMip[3] * y + toMip[5]])
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      const doc = job.scene.doc!
      const period: [number, number] = [wrapOn && wraps.x ? Math.round(doc.width / 2 ** lv) : 0, wrapOn && wraps.y ? Math.round(doc.height / 2 ** lv) : 0]
      // The tiles read: round the samples, folded into one period where the mask wraps.
      const span = (lo: number, hi: number, size: number): [number, number] => {
        if (!size) return [Math.floor(lo / TILE), Math.floor(hi / TILE)]
        const t = foldedTiles(lo, hi, size, TILE, true)
        return t.length ? [Math.min(...t), Math.max(...t)] : [0, -1]
      }
      const [sx0, sx1] = span(Math.min(...xs) - 1, Math.max(...xs) + 1, period[0])
      const [sy0, sy1] = span(Math.min(...ys) - 1, Math.max(...ys) + 1, period[1])
      const wx0 = Math.max(sx0, e.x0 >> lv)
      const wy0 = Math.max(sy0, e.y0 >> lv)
      const wx1 = Math.min(sx1, e.x1 >> lv)
      const wy1 = Math.min(sy1, e.y1 >> lv)
      if (wx1 < wx0 || wy1 < wy0) return constant
      const w = wx1 - wx0 + 1
      const h = wy1 - wy0 + 1
      if (withStroke && (w > MAX_STROKE_WINDOW || h > MAX_STROKE_WINDOW)) {
        withStroke = false
        lv = mipFor()
        continue
      }
      if (!withStroke && (w > MAX_WINDOW || h > MAX_WINDOW)) {
        lv++
        continue
      }
      const window = new Int32Array(w * h)
      const strokeWindow = withStroke ? new Int32Array(w * h) : null
      const uniforms: number[] = []
      const uniformAt = new Map<string, number>()
      let any = false
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const res: Resolved = set ? job.masks.resolve(job.enc, set, lv, wx0 + x, wy0 + y) : { kind: 'empty' }
          let v = -1
          if (res.kind === 'slot') v = res.slot
          else if (res.kind === 'uniform') {
            const key = res.value.join()
            let u = uniformAt.get(key)
            if (u === undefined) {
              u = uniformAt.size
              uniformAt.set(key, u)
              uniforms.push(res.value[0], 0, 0, 0, res.value[res.value.length - 1], 0, 0, 0)
            }
            v = -2 - u
          }
          if (v !== -1) any = true
          window[y * w + x] = v
          if (strokeWindow) {
            const slot = live!.slotAt(wx0 + x, wy0 + y)
            strokeWindow[y * w + x] = slot
            if (slot >= 0) any = true
          }
        }
      }
      if (!any) return constant
      const map = multiply([1, 0, 0, 1, -wx0 * TILE, -wy0 * TILE], toMip)
      const out = into ?? this.takeBytes(COVER_BYTES)
      const wide = this.pool.acquireBytes(size * size * 4)
      const across = margin ? this.pool.acquireBytes(TILE * size * 4) : wide
      const params = new ArrayBuffer(MASK_PARAMS_BYTES)
      writeMaskParams(params, {
        m: map,
        win: [wx0, wy0, w, h],
        resample: FILTER_INDEX.bilinear,
        size,
        margin,
        flags: (m.props.invert ? MASK_INVERT : 0) | (into ? MASK_MULTIPLY : 0),
        outside: m.props.outside,
        density: m.props.density,
        sigma: Math.max(sigma, 1e-3),
        stroke: strokeWindow ? live!.kernelStroke() : undefined,
        wrap: period,
      })
      const p = this.params.put(params)
      const pw = this.storage.put(window)
      const pu = this.storage.put(new Float32Array(uniforms.length ? uniforms : [0, 0, 0, 0, 0, 0, 0, 0]))
      const pipes = this.kernels.maskPipelines(!!strokeWindow)
      const uniform = { binding: 0, resource: { buffer: p.buffer, offset: p.offset, size: MASK_PARAMS_BYTES } }
      const run = (pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[], x: number, y: number, label: string) => {
        const pass = job.enc.beginComputePass({ label })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [uniform, ...entries] }))
        pass.dispatchWorkgroups(Math.ceil(x / 16), Math.ceil(y / 16))
        pass.end()
        this.dispatches++
      }
      const sampleEntries: GPUBindGroupEntry[] = [
        { binding: 2, resource: { buffer: wide } },
        { binding: 4, resource: job.masks.atlas.textures[0].createView({ dimension: '2d-array' }) },
        { binding: 6, resource: { buffer: pw.buffer, offset: pw.offset, size: pw.size } },
        { binding: 7, resource: { buffer: pu.buffer, offset: pu.offset, size: Math.floor(pu.size / 16) * 16 || 16 } },
      ]
      if (strokeWindow) {
        const sw = this.storage.put(strokeWindow)
        sampleEntries.push({ binding: 8, resource: { buffer: sw.buffer, offset: sw.offset, size: sw.size } })
        sampleEntries.push({ binding: 9, resource: { buffer: live!.buffer } })
        sampleEntries.push({ binding: 11, resource: { buffer: live!.selBuffer ?? this.kernels.dummy } })
      }
      run(pipes.sample, sampleEntries, size, size, 'mask sample')
      if (margin) run(pipes.blurH, [{ binding: 2, resource: { buffer: wide } }, { binding: 3, resource: { buffer: across } }], TILE, size, 'mask blur')
      run(pipes.finish, [{ binding: 1, resource: { buffer: out } }, { binding: 3, resource: { buffer: across } }], TILE, TILE, 'mask finish')
      this.pool.release(wide)
      if (across !== wide) this.pool.release(across)
      return out
    }
  }

  /** Gives back a coverage buffer coverOf made, outside a tile's render. */
  release(b: GPUBuffer) {
    this.give(b)
  }

  /** A buffer of `bytes` for the tile being built, given back with the rest. */
  private takeBytes(bytes: number): GPUBuffer {
    const b = this.pool.acquireBytes(bytes)
    this.taken.push(b)
    return b
  }

  /** A mask on its own, as an opaque gray image: its thumbnail. */
  private showMask(job: TileJob, m: DocNode & { kind: 'mask' }, dst: GPUBuffer): boolean {
    const plain = { ...m, props: { ...m.props, density: 1, invert: false, feather: 0 } }
    const r = m.props.source === 'vector' ? this.vectorCoverOf(job, plain, null) : this.coverOf(job, plain, null)
    // A constant goes in through the ring: a fresh slice, safe to write mid-frame.
    const cover = typeof r === 'number' ? this.storage.put(new Float32Array(TILE * TILE).fill(r)) : { buffer: r, offset: 0, size: COVER_BYTES }
    const pipeline = this.kernels.maskShowPipeline(job.format)
    const pass = job.enc.beginComputePass({ label: 'mask show' })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: cover.buffer, offset: cover.offset, size: COVER_BYTES } }, { binding: 1, resource: { buffer: dst } }] }))
    pass.dispatchWorkgroups(TILE / 16, TILE / 16)
    pass.end()
    if (typeof r !== 'number') this.give(r)
    return true
  }

  /** Encodes one compositing dispatch onto `dst`. */
  dispatch(job: TileJob, dst: GPUBuffer, s: DispatchSource) {
    const source = s.pixel ? 'pixel' : 'buffer'
    const pipeline = this.kernels.compositePipeline({ ...job.format, source, depth: job.residency.depth, stroke: !!s.stroke })
    const params = new ArrayBuffer(PARAMS_BYTES)
    writeParams(params, {
      m: s.m ?? [1, 0, 0, 1, 0, 0],
      op: OP_INDEX[s.op],
      blend: blendIndex(s.blend),
      filter: s.filter ?? 0,
      flags: (s.dissolve != null ? FLAG_DISSOLVE : 0) | (s.mask ? FLAG_MASK : 0),
      k: s.k,
      seed: s.dissolve ?? 0,
      origin: [originX(job), originY(job)],
      win: s.win ?? [0, 0, 0, 0],
      stroke: s.stroke?.live.kernelStroke(),
      clip: s.clip,
    })
    const p = this.params.put(params)
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: p.buffer, offset: p.offset, size: PARAMS_BYTES } },
      { binding: 1, resource: { buffer: dst } },
      { binding: 2, resource: { buffer: s.kb ?? this.kernels.dummy } },
      { binding: 3, resource: { buffer: s.mask ?? this.kernels.dummy } },
    ]
    if (s.pixel) {
      const atlas: Atlas<string> = job.residency.atlas
      entries.push({ binding: 4, resource: atlas.textures[0].createView({ dimension: '2d-array' }) })
      if (job.format.mode === 'cmyk') entries.push({ binding: 5, resource: atlas.textures[1].createView({ dimension: '2d-array' }) })
      const w = this.storage.put(s.pixel.window)
      const u = this.storage.put(s.pixel.uniforms)
      entries.push({ binding: 6, resource: { buffer: w.buffer, offset: w.offset, size: w.size } })
      entries.push({ binding: 7, resource: { buffer: u.buffer, offset: u.offset, size: Math.floor(u.size / 16) * 16 || 16 } })
      if (s.stroke) {
        const sw = this.storage.put(s.stroke.window)
        entries.push({ binding: 8, resource: { buffer: sw.buffer, offset: sw.offset, size: sw.size } })
        entries.push({ binding: 9, resource: { buffer: s.stroke.live.buffer } })
        entries.push({ binding: 11, resource: { buffer: s.stroke.live.selBuffer ?? this.kernels.dummy } })
      }
    } else {
      entries.push({ binding: 4, resource: { buffer: s.buffer! } })
    }
    const pass = job.enc.beginComputePass({ label: `${s.op} ${s.blend}` })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }))
    pass.dispatchWorkgroups(TILE / 16, TILE / 16)
    pass.end()
    this.dispatches++
  }
}

export { AtlasFull }
export const bufferBytes = tileBufferBytes
