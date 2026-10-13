/**
 * The clipboard, as the engine worker does its part: reading pixels under
 * the selection into a set of their own (Copy, Cut, Copy Merged, Layer via
 * Copy), and drawing what was copied as an sRGB PNG for other apps.
 *
 * Copied pixels keep their layer's own grid where they can: a pixel
 * layer's are its tiles with their alpha taken down by the selection, so a
 * scaled or turned layer copies exactly and pastes still live. Anything
 * that has to be drawn first (a shape, text, a smart object, a group, the
 * composite) is drawn on the document's grid, as Rasterize draws it.
 */
import type { Affine, ColourMode, Depth, DocNode, NodeId, ProfileRef } from '../doc/types'
import { invertAffine } from '../doc/edit'
import { makeNode } from '../doc/nodes'
import { encodePng } from '../io/png'
import { readTiles, tileRange } from '../render/readback'
import type { Renderer } from '../render/renderer'
import type { Rect } from '../render/scene'
import { CoverReader, alphaBounds, coverForTile, exactBounds } from '../tiles/coverage'
import { TILE, TILE_PIXELS, newSamples, planesOf, type Samples, type TileFormat } from '../tiles/format'
import type { TileId } from '../tiles/store'
import { colour } from './colourHost'
import { pinSet, store, unpinSet } from './tileHost'

/** Where copied pixels come from. */
export type ClipSource =
  /** Everything visible: Copy Merged. */
  | { kind: 'merged' }
  /** A layer: a pixel layer's own pixels, or anything else drawn as Rasterize draws it. */
  | { kind: 'node'; node: NodeId }
  /** A mask's gray, as it applies (density and invert, not feather). */
  | { kind: 'mask'; node: NodeId }

export interface ClipPixels {
  /** The copied pixels; null when nothing was under the selection. */
  set: string | null
  format: TileFormat
  /** Where the set sits in the document. */
  transform: Affine
  /** What it covers in the document, [x0, y0, x1, y1). */
  bounds: [number, number, number, number] | null
}

/** A document's colours, for drawing a clip. */
export interface ClipSpace {
  mode: ColourMode
  depth: Depth
  profile: ProfileRef
}

export interface ClipCalls {
  /** Pixels under the selection (none: the whole canvas) from a layer, a mask or the composite. */
  'clip.pixels': { args: { key: string; source: ClipSource; selection: string | null }; result: ClipPixels }
  /** A set drawn through its transform, cropped to `bounds`, as an sRGB PNG; null when it's too big for the clipboard or empty. */
  'clip.png': { args: { space: ClipSpace; set: string; transform: Affine; bounds: [number, number, number, number] }; result: Uint8Array | null }
  /** A layer (with its masks and effects) as an sRGB PNG, cropped to what it covers on the canvas; null when nothing shows or it's too big. */
  'clip.nodePng': { args: { key: string; node: NodeId }; result: { png: Uint8Array; bounds: [number, number, number, number] } | null }
  /** What a layer covers in the document, with its effects' reach, [x0, y0, x1, y1); null for nothing. */
  'clip.bounds': { args: { key: string; node: NodeId }; result: [number, number, number, number] | null }
}

/** The largest image put on the system clipboard: past this, other apps get nothing and Plexel keeps its own copy. */
export const PNG_MAX_PIXELS = 64 * 1024 * 1024
/** New sets are held this long for the page, as selection results are. */
const HOLD_MS = 60_000

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

function held(set: string | null): string | null {
  if (!set) return null
  pinSet(set)
  setTimeout(() => unpinSet(set), HOLD_MS)
  return set
}

/** A rectangle through an affine transform: the box around its corners. */
function transformRect(t: Affine, r: Rect): Rect {
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y] of [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[0], r[3]],
    [r[2], r[3]],
  ]) {
    xs.push(t[0] * x + t[2] * y + t[4])
    ys.push(t[1] * x + t[3] * y + t[5])
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

const outward = (r: Rect): [number, number, number, number] => [Math.floor(r[0] + 1e-6), Math.floor(r[1] + 1e-6), Math.ceil(r[2] - 1e-6), Math.ceil(r[3] - 1e-6)]

/** A set's pixels with each alpha taken down by how much `cover` covers it (through `t`, set pixels to document pixels). */
async function keepThrough(set: string, t: Affine, cover: CoverReader, coverRect: Rect): Promise<string | null> {
  const { format: f, tiles } = store.getSet(set)
  const planes = planesOf(f)
  const A = (planes - 1) * TILE_PIXELS
  const out: [number, number, TileId][] = []
  const made: [number, number, Samples][] = []
  for (const [key, id] of tiles) {
    const [tx, ty] = key.split(',').map(Number)
    const r = transformRect(t, [tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE])
    if (r[2] <= coverRect[0] || r[0] >= coverRect[2] || r[3] <= coverRect[1] || r[1] >= coverRect[3]) continue
    const ks = await coverForTile(cover, t, tx, ty)
    if (ks.every((k) => k >= 1)) {
      out.push([tx, ty, id])
      continue
    }
    if (ks.every((k) => k <= 0)) continue
    const src = await store.samples(id)
    const s = newSamples(f)
    s.set(src)
    let any = false
    for (let i = 0; i < TILE_PIXELS; i++) {
      const k = Math.min(1, Math.max(0, ks[i]))
      const a = Math.round(src[A + i] * k)
      s[A + i] = a
      if (a) any = true
    }
    if (any) made.push([tx, ty, s])
  }
  if (!out.length && !made.length) return null
  // Tiles made and the set made in one go, with no await between, so a collection can't take them.
  return store.createSet(f, [...out, ...made.map(([tx, ty, s]): [number, number, TileId] => [tx, ty, store.data(f, s)])])
}

export function clipHandlers(renderer: () => Promise<Renderer>): { [M in keyof ClipCalls]: (args: ClipCalls[M]['args']) => Promise<ClipCalls[M]['result']> } {
  return {
    'clip.pixels': async ({ key, source, selection }) => {
      const r = await renderer()
      const s = r.docState(key)
      const doc = s?.scene.doc
      if (!s || !doc) throw new Error('That document isn’t in the engine')
      const f: TileFormat = { mode: doc.mode, depth: doc.depth }
      const canvas: Rect = [0, 0, doc.width, doc.height]
      const selRect: Rect | null = selection && store.hasSet(selection) ? await exactBounds(store, selection) : null
      if (selection && !selRect) return { set: null, format: f, transform: IDENTITY, bounds: null }
      const area = selRect ?? canvas
      const cover = selection ? new CoverReader(store, selection) : new CoverReader(store, null, 1)
      const finish = async (set: string | null, fmt: TileFormat, t: Affine): Promise<ClipPixels> => {
        // Held before anything else is awaited, so a collection meanwhile can't take it.
        held(set)
        const b = set ? await alphaBounds(store, set) : null
        const bounds = b ? outward(transformRect(t, b)) : null
        return { set: bounds ? set : null, format: fmt, transform: t, bounds }
      }
      const node = source.kind === 'merged' ? null : s.scene.node(source.node)
      if (source.kind !== 'merged' && !node) throw new Error('That layer isn’t in the engine')

      // A pixel layer: its own tiles, kept where the selection is.
      if (node?.kind === 'pixel' && source.kind === 'node') {
        if (!node.props.tiles || !store.hasSet(node.props.tiles)) return { set: null, format: f, transform: IDENTITY, bounds: null }
        const t = node.transform as Affine
        return finish(await keepThrough(node.props.tiles, t, cover, area), f, t)
      }

      // A mask: its gray where the selection is, on the document's grid.
      if (node?.kind === 'mask' && source.kind === 'mask') {
        const gray: TileFormat = { mode: 'gray', depth: 8 }
        const reader = new CoverReader(store, node.props.tiles, node.props.outside)
        const toMask = invertAffine(node.transform as Affine)
        const [tx0, ty0, tx1, ty1] = tileRange(area)
        const made: [number, number, Samples][] = []
        for (let ty = ty0; ty <= ty1; ty++)
          for (let tx = tx0; tx <= tx1; tx++) {
            const ks = await coverForTile(cover, IDENTITY, tx, ty)
            if (ks.every((k) => k <= 0)) continue
            const ms = await coverForTile(reader, toMask, tx, ty)
            const out = newSamples(gray)
            let any = false
            for (let i = 0; i < TILE_PIXELS; i++) {
              const px = tx * TILE + (i % TILE)
              const py = ty * TILE + Math.floor(i / TILE)
              // Within the canvas only: past its edge there's nothing to copy.
              const k = px < doc.width && py < doc.height ? Math.min(1, Math.max(0, ks[i])) : 0
              if (!k) continue
              const v = node.props.invert ? 1 - ms[i] : ms[i]
              out[i] = Math.round((1 - node.props.density * (1 - v)) * 255)
              out[TILE_PIXELS + i] = Math.round(k * 255)
              any = true
            }
            if (any) made.push([tx, ty, out])
          }
        const set = made.length ? store.createSet(gray, made.map(([tx, ty, x]): [number, number, TileId] => [tx, ty, store.data(gray, x)])) : null
        return finish(set, gray, IDENTITY)
      }

      // Anything drawn: the composite, a group as it looks, or a layer's own content as Rasterize draws it.
      const id = node?.id ?? null
      const renderOne = (job: Parameters<Renderer['renderTile']>[0]) =>
        id === null ? r.renderTile(job) : node!.kind === 'group' ? r.renderNodeTile(job, id) : r.renderContentTile(job, id)
      const read: [number, number, Samples][] = []
      const planes = planesOf(f)
      const A = (planes - 1) * TILE_PIXELS
      const range = tileRange([Math.max(0, area[0]), Math.max(0, area[1]), Math.min(doc.width, area[2]), Math.min(doc.height, area[3])])
      if (range[2] < range[0] || range[3] < range[1]) return { set: null, format: f, transform: IDENTITY, bounds: null }
      const covers = new Map<string, Float32Array>()
      for (let ty = range[1]; ty <= range[3]; ty++) for (let tx = range[0]; tx <= range[2]; tx++) covers.set(`${tx},${ty}`, await coverForTile(cover, IDENTITY, tx, ty))
      await readTiles(r, s, range, renderOne, (tx, ty, samples) => {
        const ks = covers.get(`${tx},${ty}`)!
        let any = false
        for (let i = 0; i < TILE_PIXELS; i++) {
          const px = tx * TILE + (i % TILE)
          const py = ty * TILE + Math.floor(i / TILE)
          const k = px < doc.width && py < doc.height ? Math.min(1, Math.max(0, ks[i])) : 0
          const a = Math.round(samples[A + i] * k)
          samples[A + i] = a
          if (a) any = true
        }
        if (any) read.push([tx, ty, samples])
      })
      const set = read.length ? store.createSet(f, read.map(([tx, ty, x]): [number, number, TileId] => [tx, ty, store.data(f, x)])) : null
      return finish(set, f, IDENTITY)
    },

    'clip.png': async ({ space, set, transform, bounds }) => {
      const [x0, y0, x1, y1] = bounds
      const w = x1 - x0
      const h = y1 - y0
      if (w <= 0 || h <= 0 || w * h > PNG_MAX_PIXELS || !store.hasSet(set)) return null
      const r = await renderer()
      // A scene of its own holding just the pixels, its corner at the clip's.
      const key = `clip-${++clips}`
      const layer = makeNode('pixel', `${key}-layer`, 'Clip', { tiles: set })
      layer.transform = [transform[0], transform[1], transform[2], transform[3], transform[4] - x0, transform[5] - y0]
      const root = makeNode('group', `${key}-root`, 'Root')
      root.children = [layer.id]
      r.updateScene(key, {
        doc: { width: w, height: h, mode: space.mode, depth: space.depth, profile: space.profile, root: root.id, selection: null },
        nodes: [root, layer].map((node, i) => ({ node: node as DocNode, version: i + 1 })),
        removed: [],
        reset: true,
      })
      try {
        return await pngOf(r, key, [0, 0, w, h], (job) => r.renderTile(job))
      } finally {
        r.close(key)
      }
    },

    'clip.nodePng': async ({ key, node }) => {
      const r = await renderer()
      const s = r.docState(key)
      const doc = s?.scene.doc
      if (!s || !doc) throw new Error('That document isn’t in the engine')
      const n = s.scene.node(node)
      const b = n ? s.scene.bounds(node) ?? (n.visible ? null : visibleBounds(s.scene, n)) : null
      if (!b) return null
      const rect = outward([Math.max(0, b[0]), Math.max(0, b[1]), Math.min(doc.width, b[2]), Math.min(doc.height, b[3])])
      if (rect[2] <= rect[0] || rect[3] <= rect[1]) return null
      const png = await pngOf(r, key, rect, (job) => r.renderNodeTile(job, node))
      return png ? { png, bounds: rect } : null
    },

    'clip.bounds': async ({ key, node }) => {
      const r = await renderer()
      const s = r.docState(key)
      const n = s?.scene.node(node)
      if (!s || !n) return null
      const b = n.kind === 'fill' ? visibleBounds(s.scene, n) : (s.scene.bounds(node) ?? visibleBounds(s.scene, n))
      return b ? outward(b) : null
    },
  }
}

let clips = 0

/** A hidden layer's bounds as if it were shown: what it would cover. */
function visibleBounds(scene: NonNullable<ReturnType<Renderer['docState']>>['scene'], n: DocNode): Rect | null {
  // A fill layer has no edge of its own: what shows of it is the canvas.
  if (n.kind === 'fill') return scene.canvas
  if (n.kind !== 'group') return scene.contentBounds(n)
  let r: Rect | null = null
  for (const c of n.children ?? []) {
    const k = scene.node(c)
    const b = k ? visibleBounds(scene, k) : null
    if (b) r = r ? [Math.min(r[0], b[0]), Math.min(r[1], b[1]), Math.max(r[2], b[2]), Math.max(r[3], b[3])] : b
  }
  return r
}

/**
 * A document rectangle drawn by `renderOne`, converted from the document's
 * profile to sRGB, as an 8-bit PNG with transparency, a tile at a time;
 * null when nothing in it shows or it's too big for the clipboard.
 */
async function pngOf(r: Renderer, key: string, rect: [number, number, number, number], renderOne: (job: Parameters<Renderer['renderTile']>[0]) => GPUBuffer | null): Promise<Uint8Array | null> {
  const s = r.docState(key)
  const doc = s?.scene.doc
  if (!s || !doc) return null
  const [x0, y0, x1, y1] = rect
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0 || w * h > PNG_MAX_PIXELS) return null
  const { cms, registry } = await colour()
  const n = doc.mode === 'rgb' ? 3 : doc.mode === 'gray' ? 1 : 4
  const max = doc.depth === 16 ? 65535 : 255
  const t = cms.transform(registry.resolve(doc.profile, doc.mode).profile, registry.builtin('srgb'), 'relative', 0x2000)
  const rgba = new Uint8Array(w * h * 4)
  let any = false
  try {
    const px = new Float32Array(TILE_PIXELS * n)
    await readTiles(r, s, tileRange(rect), renderOne, (tx, ty, samples) => {
      for (let i = 0; i < TILE_PIXELS; i++) for (let c = 0; c < n; c++) px[i * n + c] = samples[c * TILE_PIXELS + i] / max
      const out = t.run(px, TILE_PIXELS)
      for (let y = Math.max(y0, ty * TILE); y < Math.min(y1, (ty + 1) * TILE); y++)
        for (let x = Math.max(x0, tx * TILE); x < Math.min(x1, (tx + 1) * TILE); x++) {
          const i = (y - ty * TILE) * TILE + (x - tx * TILE)
          const a = samples[n * TILE_PIXELS + i]
          if (!a) continue
          const o = ((y - y0) * w + (x - x0)) * 4
          for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(Math.min(1, Math.max(0, out[i * 3 + c])) * 255)
          rgba[o + 3] = Math.round((a / max) * 255)
          any = true
        }
    })
  } finally {
    t.close()
  }
  if (!any) return null
  async function* rows() {
    for (let y = 0; y < h; y++) yield rgba.subarray(y * w * 4, (y + 1) * w * 4)
  }
  const blob = await encodePng({ width: w, height: h, mode: 'rgb', depth: 8, alpha: true, icc: registry.builtin('srgb').bytes(), iccName: 'sRGB IEC61966-2.1' }, rows())
  return new Uint8Array(await blob.arrayBuffer())
}
