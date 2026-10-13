/**
 * Selections and masks, as the engine worker runs them: the calls the
 * selection tools, the Select menu and the Layer Mask commands make. The
 * work is in tiles/coverage.ts; this is the part that knows about calls,
 * documents and the GPU (the magic wand reads the canvas).
 *
 * Every set these make is pinned for a while, so a collection the page
 * asked for before it had committed the result can't take it, and a
 * collection waits for any of this work still running, whose sets in the
 * making aren't in anybody's list yet.
 */
import { TILE, type TileFormat } from '../tiles/format'
import {
  CoverReader,
  coverForTile,
  applyMask,
  combine,
  ellipsePoints,
  exactBounds,
  feather,
  grow,
  invert,
  isEmpty,
  offset,
  rasterizePolygon,
  refine,
  selectAll,
  throughCover,
  transformCover,
  COVER,
  wand,
  type CombineOp,
  type MaskSpec,
  type Refine,
  type Torus,
} from '../tiles/coverage'
import { tileWraps, type Tiling } from '../doc/types'
import { pinSet, store, unpinSet } from './tileHost'
import type { Renderer } from '../render/renderer'
import { readPixels8 } from '../render/readback'

export type SelectShape =
  | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'ellipse'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'polygon'; points: [number, number][] }

export type SelectModify =
  | { kind: 'feather'; radius: number }
  | { kind: 'grow'; radius: number }
  | { kind: 'refine'; refine: Refine }
  | { kind: 'offset'; dx: number; dy: number }
  /** Select → Modify → Border: a band `width` pixels wide along the edge. */
  | { kind: 'border'; width: number }
  /** Select → Modify → Smooth: corners and stair-steps rounded off over `radius` pixels. */
  | { kind: 'smooth'; radius: number }
  /** Transform Selection: the outline through an affine, in document pixels. */
  | { kind: 'transform'; m: number[] }

/** The most pixels the wand reads at once; past this it reads a mip level. */
const WAND_PIXELS = 64 * 1024 * 1024
/** How long a new set is kept from collection, waiting for the page to commit it. */
const HOLD_MS = 60_000

let running = 0
let settled: (() => void)[] = []

/** Resolves once no selection work is running. tiles.gc waits on it. */
export function selectionIdle(): Promise<void> {
  if (!running) return Promise.resolve()
  return new Promise((resolve) => settled.push(resolve))
}

export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  running++
  try {
    return await fn()
  } finally {
    running--
    if (!running) for (const r of settled.splice(0)) r()
  }
}

/** A new set held for the page to commit (a layer's: an empty one is null already). */
export function held(set: string | null): string | null {
  if (!set) return null
  pinSet(set)
  setTimeout(() => unpinSet(set), HOLD_MS)
  return set
}

/** A new set, held for the page; null for an empty selection, which is no selection. */
function result(set: string | null): string | null {
  if (!set || isEmpty(store, set)) return null
  pinSet(set)
  setTimeout(() => unpinSet(set), HOLD_MS)
  return set
}

/** A tiled document's torus, from its tiling: null for an ordinary one. */
function torusOf(tiled: Tiling | undefined): Torus | null {
  const w = tileWraps(tiled)
  return w.x || w.y ? w : null
}

function shapePoints(shape: SelectShape): [number, number][] {
  if (shape.kind === 'polygon') return shape.points
  const x0 = Math.min(shape.x0, shape.x1)
  const x1 = Math.max(shape.x0, shape.x1)
  const y0 = Math.min(shape.y0, shape.y1)
  const y1 = Math.max(shape.y0, shape.y1)
  if (shape.kind === 'rect') {
    return [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ]
  }
  return ellipsePoints((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2)
}

export interface SelectCalls {
  /** A marquee or lasso shape, feathered, combined with the selection there was. Null: nothing selected. */
  'select.shape': {
    args: { width: number; height: number; shape: SelectShape; antialias: boolean; feather: number; op: CombineOp; current: string | null; tiled?: Tiling }
    result: string | null
  }
  'select.all': { args: { width: number; height: number }; result: string }
  /** An alpha channel's coverage, placed by its transform, as a selection combined with the one there is (Load Selection). */
  'select.channel': { args: { width: number; height: number; tiles: string | null; transform: number[]; invert: boolean; op: CombineOp; current: string | null; tiled?: Tiling }; result: string | null }
  'select.invert': { args: { width: number; height: number; current: string | null }; result: string | null }
  /** Feather, Expand or Contract, Select and Mask's refinements, or a move by whole pixels. */
  'select.modify': { args: { width: number; height: number; current: string; modify: SelectModify; tiled?: Tiling }; result: string | null }
  /** The magic wand at a document point: of the composite, or of one node on its own. */
  'select.wand': {
    args: { key: string; x: number; y: number; tolerance: number; contiguous: boolean; node: string | null; antialias: boolean; op: CombineOp; current: string | null }
    result: string | null
  }
  /** How much the selection covers a document pixel: whether a drag starts inside it. */
  'select.at': { args: { set: string; x: number; y: number }; result: number }
  /** The smallest document rectangle holding the selection, [x0, y0, x1, y1). */
  'select.bounds': { args: { set: string }; result: [number, number, number, number] | null }
  /** How much the selection covers each pixel of a document rectangle [x0, y0, x1, y1), 0..255: Define Brush Preset. */
  'select.region': { args: { set: string; rect: [number, number, number, number] }; result: Uint8Array }
  /**
   * A pixel layer with a colour laid on as much as `cover` covers each
   * pixel, or (with `value` null) cleared that much. `cover` null is the
   * whole canvas. Returns the layer's new set; null when it's left empty.
   */
  'select.fill': {
    args: { layer: string | null; format: TileFormat; transform: number[]; cover: string | null; width: number; height: number; value: number[] | null }
    result: string | null
  }
  /** Apply Layer Mask: the layer's alpha times the mask, as the canvas shows it. */
  'mask.apply': { args: { layer: string; format: TileFormat; transform: number[]; mask: MaskSpec; width: number; height: number }; result: string | null }
}

type SelectCall = keyof SelectCalls
type SelectHandler<M extends SelectCall> = (args: SelectCalls[M]['args']) => Promise<SelectCalls[M]['result']>

export function selectHandlers(renderer: () => Promise<Renderer>): { [M in SelectCall]: SelectHandler<M> } {
  return {
    'select.shape': (a) =>
      guarded(async () => {
        const t = torusOf(a.tiled)
        let set = rasterizePolygon(store, shapePoints(a.shape), a.width, a.height, a.antialias, t)
        if (a.feather > 0) set = await feather(store, set, a.feather, a.width, a.height, 0, t)
        return result(await combine(store, a.current, set, a.op, a.width, a.height))
      }),
    'select.all': async (a) => result(selectAll(store, a.width, a.height))!,
    'select.channel': (a) =>
      guarded(async () => {
        const plain = a.transform.every((v, i) => v === [1, 0, 0, 1, 0, 0][i])
        let set = !a.tiles ? store.createSet(COVER, []) : plain ? a.tiles : await transformCover(store, a.tiles, a.transform, a.width, a.height, 0, torusOf(a.tiled))
        if (a.invert) set = await invert(store, set, a.width, a.height)
        return result(await combine(store, a.current, set, a.op, a.width, a.height))
      }),
    'select.invert': (a) => guarded(async () => result(await invert(store, a.current, a.width, a.height))),
    'select.modify': (a) =>
      guarded(async () => {
        const m = a.modify
        // A tiled document's selection is on a torus: its edges touch.
        const t = torusOf(a.tiled)
        if (m.kind === 'border') {
          const r = Math.max(1, m.width / 2)
          const out = await grow(store, a.current, r, a.width, a.height, t)
          const inner = await grow(store, a.current, -r, a.width, a.height, t)
          return result(await combine(store, out, inner, 'subtract', a.width, a.height))
        }
        if (m.kind === 'smooth') return result(await refine(store, a.current, { smooth: m.radius, feather: 0, contrast: 0, shift: 0 }, a.width, a.height, t))
        if (m.kind === 'transform') return result(await transformCover(store, a.current, m.m, a.width, a.height, 0, t))
        const set =
          m.kind === 'feather'
            ? await feather(store, a.current, m.radius, a.width, a.height, 0, t)
            : m.kind === 'grow'
              ? await grow(store, a.current, m.radius, a.width, a.height, t)
              : m.kind === 'refine'
                ? await refine(store, a.current, m.refine, a.width, a.height, t)
                : await offset(store, a.current, Math.round(m.dx), Math.round(m.dy), a.width, a.height, t)
        return result(set)
      }),
    'select.wand': (a) =>
      guarded(async () => {
        const r = await renderer()
        const doc = r.docState(a.key)?.scene.doc
        if (!doc) throw new Error('That document isn’t in the engine')
        // A tiled document: a point in a copy is the same point on the canvas, and like pixels touch across the edges.
        const t = torusOf(doc.tiled)
        const x = t?.x ? ((a.x % doc.width) + doc.width) % doc.width : a.x
        const y = t?.y ? ((a.y % doc.height) + doc.height) % doc.height : a.y
        if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return result(a.op === 'replace' ? null : a.current)
        let level = 0
        while ((doc.width / 2 ** level) * (doc.height / 2 ** level) > WAND_PIXELS) level++
        const img = await readPixels8(r, a.key, a.node, level)
        const sx = Math.min(img.width - 1, Math.floor(x / 2 ** level))
        const sy = Math.min(img.height - 1, Math.floor(y / 2 ** level))
        const set = wand(store, img.data, img.channels, img.width, img.height, sx, sy, a.tolerance, a.contiguous, a.antialias, level, doc.width, doc.height, t)
        return result(await combine(store, a.current, set, a.op, doc.width, doc.height))
      }),
    'select.bounds': (a) => exactBounds(store, a.set),
    'select.region': async ({ set, rect }) => {
      const [x0, y0, x1, y1] = rect
      const w = Math.max(0, x1 - x0)
      const h = Math.max(0, y1 - y0)
      const out = new Uint8Array(w * h)
      if (!store.hasSet(set)) return out
      const reader = new CoverReader(store, set)
      for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y1 - 1) / TILE); ty++)
        for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x1 - 1) / TILE); tx++) {
          const cov = await coverForTile(reader, [1, 0, 0, 1, 0, 0], tx, ty)
          for (let y = Math.max(y0, ty * TILE); y < Math.min(y1, (ty + 1) * TILE); y++)
            for (let x = Math.max(x0, tx * TILE); x < Math.min(x1, (tx + 1) * TILE); x++) out[(y - y0) * w + (x - x0)] = Math.round(cov[(y - ty * TILE) * TILE + (x - tx * TILE)] * 255)
        }
      return out
    },
    'select.at': async (a) => (store.hasSet(a.set) ? new CoverReader(store, a.set).at(Math.floor(a.x), Math.floor(a.y)) : 0),
    'select.fill': (a) =>
      guarded(async () => {
        const cover = a.cover ?? selectAll(store, a.width, a.height)
        const bounds: [number, number, number, number] = [0, 0, Math.ceil(a.width / TILE) * TILE, Math.ceil(a.height / TILE) * TILE]
        const set = await throughCover(store, a.layer, a.format, a.transform, new CoverReader(store, cover), bounds, a.value, a.value ? 'fill' : 'clear')
        if (set === a.layer) return set
        return result(set)
      }),
    'mask.apply': (a) =>
      guarded(async () => {
        const set = await applyMask(store, a.layer, a.format, a.transform, a.mask, a.width, a.height)
        if (set === a.layer) return set
        return result(set)
      }),
  }
}
