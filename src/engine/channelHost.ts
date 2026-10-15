/**
 * The Channels panel's work in the engine: thumbnails of the composite,
 * each colour channel and each alpha and spot channel; a colour channel
 * (or the composite's luminosity) loaded as the selection; and a channel
 * as one full-size plane, for files.
 *
 * Colour channels are read from the composite as it renders, over white
 * where it's transparent (paper, as Photoshop shows a channel): RGB and
 * Gray by their value, CMYK by how little ink (white is none). Alpha and
 * spot channels are read through their transforms, as the canvas shows
 * them (render/readback.ts readCover8); a spot's thumbnail is black where
 * its ink is.
 */
import { channelKind, type DocChannel } from '../doc/types'
import { compositeBands, readCover8, readPixels8, renderSmall, shrink, type Image8 } from '../render/readback'
import type { Renderer } from '../render/renderer'
import { COVER, combine, coverTile, uniformCover, type CombineOp } from '../tiles/coverage'
import { TILE, TILE_PIXELS } from '../tiles/format'
import type { TileId } from '../tiles/store'
import type { DisplayProfileId } from '../color/profiles'
import type { Thumbnail } from './protocol'
import { held, store } from './tileHost'
import { guarded } from './work'

export interface ChannelCalls {
  /**
   * The Channels panel's thumbnails, each fitting \`size\`: the composite (display RGBA), each colour
   * channel and each alpha or spot channel named (gray RGBA).
   */
  'channel.thumbs': {
    args: { key: string; size: number; channels: Pick<DocChannel, 'id' | 'kind'>[] }
    result: { composite: Thumbnail | null; colour: Thumbnail[]; extras: Record<string, Thumbnail | null> }
  }
  /**
   * A colour channel (by index) loaded as the selection, by its brightness (CMYK: white where
   * there's no ink), or with \`channel\` null, the composite by its luminosity; combined with
   * \`current\` as \`op\` says.
   */
  'select.fromComposite': { args: { key: string; channel: number | null; op: CombineOp; current: string | null }; result: string | null }
  /** An alpha or spot channel over the whole canvas as one plane, a byte a pixel (0 nothing, 255 full). */
  'channel.plane': { args: { key: string; channel: string }; result: { width: number; height: number; data: Uint8Array } }
}

/** A gray plane as RGBA for a canvas. */
function grayRgba(width: number, height: number, gray: (i: number) => number): Image8 {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const g = gray(i)
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = g
    data[i * 4 + 3] = 255
  }
  return { width, height, data }
}

/** The coarsest mip level that's still at least \`size\` pixels across the longer side. */
const levelFor = (width: number, height: number, size: number) => Math.max(0, Math.floor(Math.log2(Math.max(width, height) / size)))

/** A colour channel's value at one pixel of a straight 8-bit read with alpha last, over white: 0..255. */
function channelGray(data: Uint8Array, o: number, c: number, n: number, cmyk: boolean): number {
  const a = data[o + n] / 255
  const v = cmyk ? 255 - data[o + c] : data[o + c]
  return Math.round(v * a + 255 * (1 - a))
}

export function channelHandlers(renderer: () => Promise<Renderer>, display: () => DisplayProfileId): { [M in keyof ChannelCalls]: (args: ChannelCalls[M]['args']) => Promise<ChannelCalls[M]['result']> } {
  return {
    'channel.thumbs': async ({ key, size, channels }) => {
      const r = await renderer()
      const doc = r.docState(key)?.scene.doc
      if (!doc) return { composite: null, colour: [], extras: {} }
      const small = await renderSmall(r, key, null, size, display())
      const composite = small ? (small.data.length ? shrink(small, size) : small) : null
      const level = levelFor(doc.width, doc.height, size)
      const img = await readPixels8(r, key, null, level)
      const n = img.channels - 1
      const cmyk = doc.mode === 'cmyk'
      const colour: Thumbnail[] = []
      for (let c = 0; c < n; c++) colour.push(shrink(grayRgba(img.width, img.height, (i) => channelGray(img.data, i * img.channels, c, n, cmyk)), size))
      const extras: Record<string, Thumbnail | null> = {}
      for (const want of channels) {
        const ch = doc.channels?.find((x) => x.id === want.id)
        if (!ch) {
          extras[want.id] = null
          continue
        }
        const cover = await readCover8(r, key, ch, level)
        // A spot's ink shows black, as Photoshop shows a spot channel.
        const spot = channelKind(want as DocChannel) === 'spot'
        extras[want.id] = shrink(grayRgba(cover.width, cover.height, (i) => (spot ? 255 - cover.data[i] : cover.data[i])), size)
      }
      return { composite, colour, extras }
    },
    'select.fromComposite': ({ key, channel, op, current }) =>
      guarded(async () => {
        const r = await renderer()
        const doc = r.docState(key)?.scene.doc
        if (!doc) throw new Error('That document isn’t in the engine')
        const n = doc.mode === 'rgb' ? 3 : doc.mode === 'gray' ? 1 : 4
        if (channel !== null && (channel < 0 || channel >= n)) throw new Error('There’s no such colour channel')
        const entries: [number, number, TileId][] = []
        const cols = Math.ceil(doc.width / TILE)
        const v = new Float32Array(TILE_PIXELS)
        for await (const band of compositeBands(r, key)) {
          const ty = Math.floor(band.y / TILE)
          for (let tx = 0; tx < cols; tx++) {
            v.fill(0)
            const w = Math.min(TILE, band.width - tx * TILE)
            let first = -1
            let same = w === TILE && band.rows === TILE
            for (let y = 0; y < band.rows; y++)
              for (let x = 0; x < w; x++) {
                const i = (y * band.width + tx * TILE + x) * band.stride
                // Premultiplied light (CMYK's inks as their absence), over white.
                const a = band.data[i + n]
                const light = (c: number) => band.data[i + c] + (1 - a)
                let k: number
                if (channel !== null) k = light(channel)
                else if (n === 1) k = light(0)
                else if (n === 3) k = 0.3 * light(0) + 0.59 * light(1) + 0.11 * light(2)
                else k = (0.3 * light(0) + 0.59 * light(1) + 0.11 * light(2)) * light(3)
                k = Math.min(1, Math.max(0, k))
                v[y * TILE + x] = k
                if (first < 0) first = k
                else if (same && Math.abs(k - first) > 1 / 512) same = false
              }
            const t = same ? (first > 0 ? uniformCover(store, first) : null) : coverTile(store, v)
            if (t !== null) entries.push([tx, ty, t])
          }
        }
        const set = store.createSet(COVER, entries)
        return held(await combine(store, current, set, op, doc.width, doc.height))
      }),
    'channel.plane': async ({ key, channel }) => {
      const r = await renderer()
      const ch = r.docState(key)?.scene.doc?.channels?.find((c) => c.id === channel)
      if (!ch) throw new Error('That channel isn’t in the document')
      return readCover8(r, key, ch, 0)
    },
  }
}
