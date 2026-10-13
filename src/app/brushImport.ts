/**
 * Brushes from elsewhere: Photoshop's ABR files (io/abr.ts), imported into
 * the Brushes panel, their tips and patterns kept in the brush library
 * (brushAssets.ts); and Define Brush Preset, a tip from the image.
 *
 * A defined tip is what the image shows under the selection (or the whole
 * canvas), as Photoshop makes one: darkness is paint, white is nothing, and
 * transparency is nothing too. It's trimmed to what's painted.
 */
import { DEFAULT_BRUSH } from '../brush/defs'
import { tipId } from '../brush/tips'
import { engine } from '../engine/EngineHost'
import { AbrError, readAbr, renamePatterns } from '../io/abr'
import { brushAssets } from './brushAssets'
import { brushes } from './brushes'
import { documents } from './documents'
import { notify } from './notices'

/** Asks for ABR files and imports them (Edit → Import Brushes, the Brushes panel's Import). */
export function pickBrushFiles(): Promise<number> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.abr'
    input.multiple = true
    input.onchange = () => {
      const files = [...(input.files ?? [])]
      if (!files.length) return resolve(0)
      void importBrushes(files).then(resolve)
    }
    input.click()
  })
}

/** Imports ABR files: their presets join the user's, grouped by file. */
export async function importBrushes(files: File[]): Promise<number> {
  let added = 0
  for (const file of files) {
    try {
      const raw = readAbr(new Uint8Array(await file.arrayBuffer()))
      // Patterns are named by their pixels, as tips are.
      const f = renamePatterns(raw, (p) => `pat:${tipId(p.width, p.height, p.data).slice(4)}`)
      for (const t of f.tips) await brushAssets().add({ id: t.id, kind: 'tip', name: t.name, width: t.width, height: t.height, data: t.data })
      for (const p of f.patterns) await brushAssets().add({ id: p.id, kind: 'pattern', name: p.name, width: p.width, height: p.height, data: p.data })
      const group = file.name.replace(/\.abr$/i, '')
      brushes().addPresets(f.presets.map((p) => ({ name: p.name, settings: p.settings })), group)
      added += f.presets.length
      if (!f.presets.length) notify('warning', `“${file.name}” has no brushes in it.`)
      else if (f.warnings.length) notify('warning', `${f.presets.length} brushes came in from “${file.name}”, with a few things that couldn’t.`, f.warnings)
      else notify('info', `${f.presets.length} brushes came in from “${file.name}”.`)
    } catch (e) {
      notify('error', `“${file.name}” couldn’t be read as Photoshop brushes.`, [e instanceof AbrError || e instanceof Error ? e.message : String(e)])
    }
  }
  return added
}

export interface DefinedTip {
  width: number
  height: number
  /** Coverage, 0..255. */
  data: Uint8Array
}

/** The tip the image under the selection (or the whole canvas) makes; a message when there's nothing to make one from. */
export async function defineTip(): Promise<DefinedTip | string> {
  const d = documents().active()
  if (!d) return 'Open a document first.'
  const doc = d.history.present
  const img = await engine().call('render.nodeImage', { key: d.key, node: null, srgb: true })
  if (!img) return 'There’s nothing in the document to make a brush from.'
  let rect: [number, number, number, number] = [img.x, img.y, img.x + img.w, img.y + img.h]
  let cover: Uint8Array | null = null
  const sel = doc.selection?.tiles ?? null
  if (sel) {
    const b = await engine().call('select.bounds', { set: sel })
    if (!b) return 'The selection is empty.'
    rect = [Math.max(rect[0], b[0]), Math.max(rect[1], b[1]), Math.min(rect[2], b[2]), Math.min(rect[3], b[3])]
    if (rect[2] <= rect[0] || rect[3] <= rect[1]) return 'There’s nothing in the selection to make a brush from.'
    cover = await engine().call('select.region', { set: sel, rect })
  }
  const w = rect[2] - rect[0]
  const h = rect[3] - rect[1]
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = ((y + rect[1] - img.y) * img.w + (x + rect[0] - img.x)) * 4
      const lum = (0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]) / 255
      const a = img.data[o + 3] / 255
      const k = cover ? cover[y * w + x] / 255 : 1
      out[y * w + x] = Math.round((1 - lum) * a * k * 255)
    }
  // Trimmed to what's painted.
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (out[y * w + x] > 0) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
  if (x1 < 0) return 'What’s selected is all white or empty: a brush is made from the darker parts of the image.'
  const tw = x1 - x0 + 1
  const th = y1 - y0 + 1
  const data = new Uint8Array(tw * th)
  for (let y = 0; y < th; y++) data.set(out.subarray((y + y0) * w + x0, (y + y0) * w + x0 + tw), y * tw)
  return { width: tw, height: th, data }
}

/** Keeps a defined tip and a preset that uses it, and gives it to the Brush. */
export async function addDefinedBrush(name: string, tip: DefinedTip) {
  const id = tipId(tip.width, tip.height, tip.data)
  await brushAssets().add({ id, kind: 'tip', name, width: tip.width, height: tip.height, data: tip.data })
  brushes().addPresets([{ name, settings: { ...DEFAULT_BRUSH, tip: id, size: Math.max(tip.width, tip.height), spacing: 0.25, dynamics: [] } }], 'Defined')
  const added = brushes().get().user[brushes().get().user.length - 1]
  if (added) brushes().choose('brush', added.id)
}
