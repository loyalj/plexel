/**
 * A PSD written from the page's plan (io/psd/plan.ts): each layer's pixels
 * read here, exactly from its tile set where it is one (moved only by
 * whole pixels), rendered onto the document's grid where it isn't
 * (shapes, text, smart objects, transformed layers); masks from their
 * coverage tiles; the composite rendered, over white as Photoshop's merged
 * image is, with its transparency as an extra channel when it has any.
 */
import { writePsd, type PsdFile, type PsdLayer, type PsdSamples } from '../io/psd/format'
import type { PlanLayer, PsdPlan } from '../io/psd/plan'
import { compositeBands, rasterizeNode } from '../render/readback'
import type { Renderer } from '../render/renderer'
import { alphaBounds } from '../tiles/coverage'
import { COLOUR_CHANNELS, TILE, TILE_PIXELS } from '../tiles/format'
import { pinSet, store, unpinSet } from './tileHost'

interface Region {
  left: number
  top: number
  w: number
  h: number
  /** Colour channels, then alpha, at the set's depth. */
  planes: PsdSamples[]
}

/**
 * A set's pixels over `bounds` (its own pixel grid), plane by plane, a row
 * of a tile at a time; uniform tiles are filled. `invert` takes the colour
 * planes (not alpha) to max − v, as PSD keeps CMYK.
 */
async function readRegion(set: string, b: [number, number, number, number], invert = 0): Promise<Region> {
  const { format } = store.getSet(set)
  const [x0, y0, x1, y1] = b
  const w = x1 - x0
  const h = y1 - y0
  const n = COLOUR_CHANNELS[format.mode] + 1
  const planes: PsdSamples[] = Array.from({ length: n }, () => (format.depth === 16 ? new Uint16Array(w * h) : new Uint8Array(w * h)))
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y1 - 1) / TILE); ty++)
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x1 - 1) / TILE); tx++) {
      const sx0 = Math.max(x0, tx * TILE)
      const sy0 = Math.max(y0, ty * TILE)
      const sx1 = Math.min(x1, (tx + 1) * TILE)
      const sy1 = Math.min(y1, (ty + 1) * TILE)
      const t = store.tileAt(set, tx, ty)
      // An empty tile is transparent: the planes start at zero, which is what PSD wants under it.
      if (t === undefined) {
        if (invert) for (let c = 0; c < n - 1; c++) for (let y = sy0; y < sy1; y++) planes[c].fill(invert, (y - y0) * w + (sx0 - x0), (y - y0) * w + (sx1 - x0))
        continue
      }
      const u = store.isUniform(t)
      if (u) {
        for (let c = 0; c < n; c++) {
          const v = invert && c < n - 1 ? invert - u[c] : u[c]
          if (v) for (let y = sy0; y < sy1; y++) planes[c].fill(v, (y - y0) * w + (sx0 - x0), (y - y0) * w + (sx1 - x0))
        }
        continue
      }
      const s = await store.samples(t)
      const len = sx1 - sx0
      for (let c = 0; c < n; c++) {
        const plane = planes[c]
        const flip = invert && c < n - 1
        for (let y = sy0; y < sy1; y++) {
          const from = c * TILE_PIXELS + (y - ty * TILE) * TILE + (sx0 - tx * TILE)
          const to = (y - y0) * w + (sx0 - x0)
          if (!flip) plane.set(s.subarray(from, from + len), to)
          else for (let i = 0; i < len; i++) plane[to + i] = invert - s[from + i]
        }
      }
    }
  return { left: x0, top: y0, w, h, planes }
}

/** Tile-aligned bounds of everything in a set (a mask's tiles, whatever their values). */
function tileBounds(set: string): [number, number, number, number] | null {
  const e = store.extent(set)
  return e ? [e.x0 * TILE, e.y0 * TILE, (e.x1 + 1) * TILE, (e.y1 + 1) * TILE] : null
}

/** How many layers are read or rasterized at once. */
const LAYERS_AT_ONCE = 4

export async function writePsdPlan(r: Renderer, plan: PsdPlan): Promise<Uint8Array> {
  const cmyk = plan.mode === 4
  const max = plan.depth === 16 ? 65535 : 255
  const layers: PsdLayer[] = []
  const temporary: string[] = []

  async function layerOf(L: PlanLayer): Promise<PsdLayer> {
    let region: Region | null = null
    let dx = 0
    let dy = 0
    let set: string | null = null
    if (L.content?.kind === 'set') {
      set = L.content.set
      dx = L.content.dx
      dy = L.content.dy
    } else if (L.content?.kind === 'node') {
      set = await rasterizeNode(r, store, plan.key, L.content.node)
      if (set) {
        // Held while it's read: nothing else does.
        pinSet(set)
        temporary.push(set)
      }
    }
    if (set && store.hasSet(set)) {
      const b = await alphaBounds(store, set)
      if (b) region = await readRegion(set, b, cmyk ? max : 0)
    }
    const top = region ? region.top + dy : 0
    const left = region ? region.left + dx : 0
    const channels: PsdLayer['channels'] = []
    if (region) {
      const nc = region.planes.length - 1
      channels.push({ id: -1, data: region.planes[nc] })
      for (let c = 0; c < nc; c++) {
        // PSD keeps CMYK inverted (0 is all ink): readRegion has done it.
        channels.push({ id: c, data: region.planes[c] })
      }
    } else {
      channels.push({ id: -1, data: null })
      for (let c = 0; c < (plan.mode === 4 ? 4 : plan.mode === 3 ? 3 : 1); c++) channels.push({ id: c, data: null })
    }
    let mask: PsdLayer['mask'] = null
    if (L.mask) {
      const m = L.mask
      const b = m.set && store.hasSet(m.set) ? tileBounds(m.set) : null
      const reg = b && m.set ? await readRegion(m.set, b) : null
      mask = {
        flags: m.flags,
        defaultColor: m.defaultColor,
        userDensity: m.userDensity,
        userFeather: m.userFeather,
        vectorDensity: m.vectorDensity,
        vectorFeather: m.vectorFeather,
        top: reg ? reg.top + m.dy : 0,
        left: reg ? reg.left + m.dx : 0,
        bottom: reg ? reg.top + m.dy + reg.h : 0,
        right: reg ? reg.left + m.dx + reg.w : 0,
      }
      // Mask tiles are gray 8-bit; a 16-bit document's mask channel is 16-bit.
      const plane = reg ? reg.planes[0] : null
      channels.push({ id: -2, data: plane && plan.depth === 16 ? Uint16Array.from(plane, (v) => v * 257) : plane })
    }
    return {
      top,
      left,
      bottom: region ? top + region.h : 0,
      right: region ? left + region.w : 0,
      channels,
      blend: L.blend,
      opacity: L.opacity,
      clipping: L.clipping,
      flags: L.flags,
      mask,
      ranges: new Uint8Array(0),
      name: L.name,
      blocks: L.blocks,
    }
  }

  try {
    // A few layers at a time, so each one's wait on the GPU overlaps the others' work; in order in the file.
    const out: PsdLayer[] = new Array(plan.layers.length)
    let next = 0
    const worker = async () => {
      for (let i = next++; i < plan.layers.length; i = next++) out[i] = await layerOf(plan.layers[i])
    }
    await Promise.all(Array.from({ length: Math.min(LAYERS_AT_ONCE, plan.layers.length) }, worker))
    layers.push(...out)
  } catch (e) {
    for (const t of temporary) unpinSet(t)
    throw e
  }

  // The composite, over white, with an alpha channel only when something's transparent.
  const n = COLOUR_CHANNELS[cmyk ? 'cmyk' : plan.mode === 3 ? 'rgb' : 'gray']
  const size = plan.width * plan.height
  const planes: PsdSamples[] = Array.from({ length: n + 1 }, () => (plan.depth === 16 ? new Uint16Array(size) : new Uint8Array(size)))
  let transparent = false
  for await (const band of compositeBands(r, plan.key)) {
    for (let y = 0; y < band.rows; y++)
      for (let x = 0; x < band.width; x++) {
        const i = (y * band.width + x) * band.stride
        const o = (band.y + y) * plan.width + x
        const a = Math.min(1, Math.max(0, band.data[i + n]))
        if (a < 1) transparent = true
        for (let c = 0; c < n; c++) planes[c][o] = Math.round(Math.min(1, Math.max(0, band.data[i + c] + (1 - a))) * max)
        planes[n][o] = Math.round(a * max)
      }
  }
  const file: PsdFile = {
    psb: plan.psb,
    width: plan.width,
    height: plan.height,
    channels: transparent ? n + 1 : n,
    depth: plan.depth,
    mode: plan.mode,
    colorModeData: new Uint8Array(0),
    resources: plan.resources,
    layers,
    mergedAlpha: transparent && layers.length > 0,
    globalMask: new Uint8Array(0),
    blocks: plan.blocks,
    composite: transparent ? planes : planes.slice(0, n),
  }
  try {
    return await writePsd(file)
  } finally {
    for (const t of temporary) unpinSet(t)
  }
}
