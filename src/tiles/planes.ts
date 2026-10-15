/**
 * Edits confined to some colour channels (the Channels panel's target): a
 * layer's set after a fill, a Delete or a filter applied for good, with
 * each channel that wasn't targeted, and alpha, put back as it was before.
 * Tiles keep straight alpha, so a channel is its plane alone. Tiles the edit
 * didn't touch are shared, not copied.
 */
import { COLOUR_CHANNELS, TILE_PIXELS, newSamples, type Samples } from './format'
import type { SetId, TileId, TileStore } from './store'

async function samplesOf(store: TileStore, t: TileId): Promise<Samples> {
  const u = store.isUniform(t)
  if (!u) return store.samples(t)
  const f = store.formatOf(t)
  const s = newSamples(f)
  for (let p = 0; p < u.length; p++) s.fill(u[p], p * TILE_PIXELS, (p + 1) * TILE_PIXELS)
  return s
}

/**
 * `after` with the planes `planes` says weren't edited (false), and alpha,
 * taken from `before`. Where \`before\` had nothing, nothing stays: a
 * channel can't be painted where the layer is transparent.
 */
export async function keepPlanes(store: TileStore, before: SetId | null, after: SetId | null, planes: boolean[]): Promise<SetId | null> {
  if (!before) return null
  if (before === after) return before
  const b = store.getSet(before)
  const f = b.format
  const n = COLOUR_CHANNELS[f.mode]
  const a = after ? store.getSet(after) : null
  const changes: [number, number, TileId | null][] = []
  for (const [k, tb] of b.tiles) {
    const ta = a?.tiles.get(k)
    if (ta === tb) continue
    const [x, y] = k.split(',').map(Number)
    const sb = await samplesOf(store, tb)
    const out = sb.slice() as Samples
    if (ta !== undefined) {
      const sa = await samplesOf(store, ta)
      for (let c = 0; c < n; c++) if (planes[c] ?? true) out.set(sa.subarray(c * TILE_PIXELS, (c + 1) * TILE_PIXELS), c * TILE_PIXELS)
    } else {
      // Cleared: the edited planes are what a cleared pixel holds, nothing.
      for (let c = 0; c < n; c++) if (planes[c] ?? true) out.fill(0, c * TILE_PIXELS, (c + 1) * TILE_PIXELS)
    }
    changes.push([x, y, store.data(f, out)])
  }
  return changes.length ? store.derive(before, changes) : before
}
