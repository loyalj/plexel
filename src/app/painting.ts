/**
 * Painting, from the page's side: starting a stroke on the selected layer,
 * passing its pen samples to the engine, and committing the result.
 *
 * The page decides whether a stroke may start (a pixel layer, shown and
 * not locked) and what colours it paints in, converted into the document's
 * own space here, where the colour engine already is. The engine does
 * everything else, and hands back a new tile set when the pen lifts, which
 * is committed like any edit: one step in the history, named for the tool.
 *
 * What's painted: in Quick Mask, the selection itself; with the layer's
 * mask as the target, the mask; otherwise the layer's pixels. On a mask or
 * the selection the colours are gray levels (white shows or selects, black
 * hides or deselects), and the Eraser paints the background colour, as in
 * Photoshop. Anything but the selection itself is confined to the
 * selection when there is one.
 */
import type { PenSample } from '../brush/stroke'
import { setSelection, setTiles } from '../doc/edit'
import { SELECTION_NODE, type StrokeSampling } from '../render/strokes'
import { brushAssets } from './brushAssets'
import { pixelTarget } from './selection'
import { engine } from '../engine/EngineHost'
import { brushes, type PaintTool } from './brushes'
import { colourEngineNow } from './colour'
import { colours } from './colours'
import { colourSettings } from './colourSettings'
import { documents } from './documents'
import { notify } from './notices'
import { retouch } from './retouch'

interface Active {
  id: number
  key: string
  /** The node painted, or SELECTION_NODE in Quick Mask. */
  node: string
  tool: PaintTool
  last: PenSample
  /** Whether the target is gray coverage (a mask, or the selection) rather than a layer's pixels. */
  gray: boolean
}

/** Stroke ids are unique for the page's life; the engine pairs samples with them. */
let nextId = Math.floor(Math.random() * 1e6) * 1000

class Painter {
  private active: Active | null = null
  /** Where the last stroke ended, per document, for Shift-click straight lines. */
  private lastEnd = new Map<string, PenSample>()
  private listeners = new Set<() => void>()

  constructor() {
    engine().onStrokeRefused((id, reason) => {
      if (this.active?.id !== id) return
      this.active = null
      notify('warning', reason)
      this.emit()
    })
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  get painting() {
    return !!this.active
  }

  /**
   * Starts a stroke at `p` with `tool`, or says why it can't. With `line`,
   * the stroke runs straight from where the last one ended (Shift-click).
   */
  begin(tool: PaintTool, p: PenSample, line = false): boolean {
    const d = documents().active()
    if (!d) return false
    const doc = d.history.present
    const cms = colourEngineNow()
    if (!cms) {
      notify('info', 'The colour engine is still starting. Try again in a moment.')
      return false
    }
    let nodeId: string
    let gray = false
    if (d.quickMask) {
      nodeId = SELECTION_NODE
      gray = true
    } else {
      const node = d.selected ? doc.nodes[d.selected] : null
      const t = pixelTarget(d)
      if (!node || !t) {
        notify('info', node ? `“${node.name}” isn’t a pixel layer. Select a pixel layer to paint on, or add one with Layer → New Pixel Layer.` : 'Select a pixel layer to paint on, or add one with Layer → New Pixel Layer.')
        return false
      }
      if (node.locked.all || node.locked.pixels) {
        notify('info', `“${node.name}” is locked against painting. Unlock it in the Properties panel.`)
        return false
      }
      if (!node.visible) {
        notify('info', `“${node.name}” is hidden. Show it to paint on it.`)
        return false
      }
      nodeId = t.mask ? t.mask.id : node.id
      gray = !!t.mask
    }
    let fg: number[]
    let bg: number[]
    let eraser = tool === 'eraser'
    if (gray) {
      // Gray levels, converted as the colour engine converts to gray; the
      // eraser paints the background, as Photoshop's does on a mask.
      const { intent, blackPointCompensation } = colourSettings.get()
      const target = { space: 'gray' as const, profile: { builtin: 'gray-gamma-2.2' } }
      const g = (c: 'fg' | 'bg') => cms.converter.convert(colours().get()[c], target, intent, blackPointCompensation).c
      fg = eraser ? g('bg') : g('fg')
      bg = g('bg')
      eraser = false
    } else {
      const { intent, blackPointCompensation } = colourSettings.get()
      const target = { space: doc.mode, profile: doc.profile }
      fg = cms.converter.convert(colours().get().fg, target, intent, blackPointCompensation).c
      bg = cms.converter.convert(colours().get().bg, target, intent, blackPointCompensation).c
    }
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]
    const id = ++nextId
    const from = line ? this.lastEnd.get(d.key) : undefined
    this.active = { id, key: d.key, node: nodeId, tool, last: p, gray }
    const selection = nodeId === SELECTION_NODE ? null : (doc.selection?.tiles ?? null)
    const state = brushes().get()
    const settings = state[tool]
    // The Clone Stamp and the Healing Brush copy from their source; they need one first.
    let clone: { offset: [number, number]; sampleAll: boolean } | undefined
    if (tool === 'clone' || tool === 'heal') {
      const offset = retouch().strokeOffset(tool, d.key, p.x, p.y)
      if (!offset) {
        this.active = null
        notify('info', `Alt-click where to ${tool === 'clone' ? 'copy' : 'take the repair'} from first.`)
        return false
      }
      clone = { offset, sampleAll: retouch().get()[tool].sampleAll }
    }
    const retouching = tool === 'heal' ? 'heal' : tool === 'spot' ? 'spot' : undefined
    if (tool === 'spot') {
      // What's painted shows as a gray wash until it's filled in.
      const { intent, blackPointCompensation } = colourSettings.get()
      const grey = { space: 'rgb' as const, profile: { builtin: 'srgb' }, c: [0.35, 0.35, 0.35] }
      fg = gray ? [0.35] : cms.converter.convert(grey, { space: doc.mode, profile: doc.profile }, intent, blackPointCompensation).c
    }
    // Smudge and the Mixer pick paint up from the canvas (render/ref/sample.ts).
    let sampling: StrokeSampling | undefined
    if (tool === 'mixer') {
      const m = state.mixerSettings
      const r = brushes().takeReservoir()
      sampling = { tool: 'mixer', strength: 0, fingerPainting: false, wet: m.wet, load: m.load, mix: m.mix, reservoir: r === 'load' ? fg : r === 'clean' ? null : 'keep', sampleAll: m.sampleAll }
    } else if (tool === 'smudge') {
      const m = state.smudgeSettings
      sampling = { tool: 'smudge', strength: m.strength, fingerPainting: m.fingerPainting, wet: 0, load: 1, mix: 0, reservoir: null, sampleAll: m.sampleAll }
    }
    // Image tips and patterns go to the engine before the stroke that needs them.
    brushAssets().sendFor(settings)
    engine().beginStroke({ id, key: d.key, node: nodeId, settings: tool === 'spot' ? { ...settings, opacity: 0.6 } : settings, eraser, seed, fg, bg, selection, sampling, clone, retouch: retouching })
    engine().strokeSamples(id, from ? [{ ...from, t: p.t - 1 }, p] : [p])
    this.emit()
    return true
  }

  move(samples: PenSample[]) {
    if (!this.active || !samples.length) return
    this.active.last = samples[samples.length - 1]
    engine().strokeSamples(this.active.id, samples)
  }

  /** The pen lifted: the stroke is baked and committed as one step. */
  async end() {
    const a = this.active
    if (!a) return
    this.active = null
    this.lastEnd.set(a.key, a.last)
    this.emit()
    try {
      const { set, overflow } = await engine().call('stroke.end', { id: a.id })
      const d = documents().get(a.key)
      const label = { eraser: 'Eraser', mixer: 'Mixer Brush', smudge: 'Smudge', clone: 'Clone Stamp', heal: 'Healing Brush', spot: 'Spot Healing Brush', brush: 'Brush Stroke' }[a.tool]
      if (a.node === SELECTION_NODE) {
        if (!d || set === (d.history.present.selection?.tiles ?? null)) {
          engine().cancelStroke(a.id)
          return
        }
        documents().commit((x) => setSelection(x, set), { key: a.key, label })
      } else {
        const node = d?.history.present.nodes[a.node]
        if (!d || !node || (node.kind !== 'pixel' && node.kind !== 'mask') || set === node.props.tiles) {
          engine().cancelStroke(a.id)
          return
        }
        documents().commit((x) => setTiles(x, a.node, set), { key: a.key, label })
      }
      if (overflow) notify('warning', 'That stroke reached further than one stroke can hold, so its far end wasn’t painted. Paint it in shorter strokes.')
    } catch (e) {
      engine().cancelStroke(a.id)
      notify('error', 'The stroke couldn’t be finished.', [e instanceof Error ? e.message : String(e)])
    }
  }

  /** Abandons the stroke in progress (Esc while painting). */
  cancel() {
    if (!this.active) return
    engine().cancelStroke(this.active.id)
    this.active = null
    this.emit()
  }
}

let painter: Painter | null = null
export const painting = () => (painter ??= new Painter())

/**
 * The colour of the composite under a document point, as the foreground (or,
 * with `background`, the background): the Colour Picker.
 */
export async function pickColour(x: number, y: number, background = false) {
  const d = documents().active()
  if (!d) return
  const doc = d.history.present
  const v = await engine().call('render.sample', { key: d.key, x, y, size: brushes().get().sample })
  if (!v || v[v.length - 1] <= 0) return
  const colour = { space: doc.mode, profile: doc.profile, c: v.slice(0, -1) }
  if (background) colours().setBg(colour)
  else colours().setFg(colour)
}
