/**
 * A tile set converted to another colour mode, profile or depth, tile by
 * tile, into a new set (the old one stays, for Undo). Each tile's colours
 * go through `convert` (a colour engine transform, float in and out in the
 * set's own terms: RGB and Gray light, CMYK ink, all 0..1) and are
 * quantised to the new depth; alpha keeps its value. A uniform tile stays
 * one value, converted once. Without `convert` (a depth change alone) the
 * samples are only rescaled.
 */
import { COLOUR_CHANNELS, TILE_PIXELS, maxSample, newSamples, type TileFormat } from './format'
import type { SetId, TileId, TileStore } from './store'

export type ConvertFn = (colours: Float32Array, count: number) => Float32Array

export async function convertSet(store: TileStore, id: SetId, to: TileFormat, convert: ConvertFn | null): Promise<SetId> {
  const { format: from, tiles } = store.getSet(id)
  const inCh = COLOUR_CHANNELS[from.mode]
  const outCh = COLOUR_CHANNELS[to.mode]
  if (!convert && inCh !== outCh) throw new Error('A change of colour mode needs a conversion')
  const inMax = maxSample(from)
  const outMax = maxSample(to)
  const q = (v: number) => Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * outMax)
  const done = new Map<TileId, TileId>()
  const entries: [number, number, TileId][] = []
  const colours = new Float32Array(TILE_PIXELS * inCh)
  for (const [k, tile] of tiles) {
    const [x, y] = k.split(',').map(Number)
    let out = done.get(tile)
    if (out === undefined) {
      const u = store.isUniform(tile)
      if (u) {
        const c = u.slice(0, inCh).map((v) => v / inMax)
        const conv = convert ? [...convert(Float32Array.from(c), 1)] : c
        out = store.uniform(to, [...conv.map(q), Math.round((u[inCh] / inMax) * outMax)])
      } else {
        const s = await store.samples(tile)
        for (let p = 0; p < TILE_PIXELS; p++) for (let c = 0; c < inCh; c++) colours[p * inCh + c] = s[c * TILE_PIXELS + p] / inMax
        const conv = convert ? convert(colours, TILE_PIXELS) : colours
        const o = newSamples(to)
        for (let p = 0; p < TILE_PIXELS; p++) {
          for (let c = 0; c < outCh; c++) o[c * TILE_PIXELS + p] = q(conv[p * outCh + c])
          o[outCh * TILE_PIXELS + p] = inMax === outMax ? s[inCh * TILE_PIXELS + p] : Math.round((s[inCh * TILE_PIXELS + p] / inMax) * outMax)
        }
        out = store.data(to, o)
      }
      done.set(tile, out)
    }
    entries.push([x, y, out])
  }
  return store.createSet(to, entries)
}
