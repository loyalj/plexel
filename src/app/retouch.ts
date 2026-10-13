/**
 * Retouching on the page: the Clone Stamp's and the Healing Brush's source,
 * their settings, and the Patch tool.
 *
 * The source is a document point, set with Alt-click. With Aligned (on by
 * default, as in Photoshop) the offset from the first stroke after setting
 * it holds for every stroke after, so strokes anywhere carry on copying
 * the same picture; without it, every stroke starts again from the source.
 * The engine is told each stroke's offset (render/strokes.ts, `clone`).
 *
 * Patch: drawn round what to repair as a Lasso is, or with a selection
 * there already; dragged from inside it to the area to take the repair
 * from, and healed in when it's let go (engine/retouchHost.ts).
 */
import { setTiles } from '../doc/edit'
import { engine } from '../engine/EngineHost'
import { lassoGesture, type Gesture, type Pointer } from './canvasTools'
import { documents, type OpenDoc } from './documents'
import { notify } from './notices'
import { clearToolOverlay, setToolOverlay } from './overlay'
import { pixelTarget } from './selection'

export interface SourceSettings {
  /** The offset from the first stroke holds for the strokes after it. */
  aligned: boolean
  /** Copy what the whole image shows, not just the selected layer. */
  sampleAll: boolean
}

export interface RetouchState {
  clone: SourceSettings
  heal: SourceSettings
}

const KEY = 'plexel.retouch.v1'
const DEFAULTS: RetouchState = { clone: { aligned: true, sampleAll: false }, heal: { aligned: true, sampleAll: false } }

function load(): RetouchState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    const read = (r: unknown, d: SourceSettings): SourceSettings => {
      const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : {}
      return { aligned: typeof o.aligned === 'boolean' ? o.aligned : d.aligned, sampleAll: typeof o.sampleAll === 'boolean' ? o.sampleAll : d.sampleAll }
    }
    return { clone: read(raw?.clone, DEFAULTS.clone), heal: read(raw?.heal, DEFAULTS.heal) }
  } catch {
    return DEFAULTS
  }
}

class RetouchStore {
  private state = load()
  /** The source: a document and a point in it. */
  private source: { key: string; x: number; y: number } | null = null
  /** Aligned: the offset the first stroke after setting the source made. */
  private offset: [number, number] | null = null
  private listeners = new Set<() => void>()

  get = () => this.state
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  update(tool: 'clone' | 'heal', patch: Partial<SourceSettings>) {
    this.state = { ...this.state, [tool]: { ...this.state[tool], ...patch } }
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state))
    } catch {
      // Kept for this visit only.
    }
    for (const fn of this.listeners) fn()
  }

  /** Alt-click: where to copy from. */
  setSource(key: string, x: number, y: number) {
    this.source = { key, x, y }
    this.offset = null
    showSource(key, x, y)
  }

  sourceOf(key: string) {
    return this.source?.key === key ? this.source : null
  }

  /** A stroke starting at (x, y): the offset to its source, or null when there's no source in this document. */
  strokeOffset(tool: 'clone' | 'heal', key: string, x: number, y: number): [number, number] | null {
    const s = this.sourceOf(key)
    if (!s) return null
    if (!this.state[tool].aligned) return [s.x - x, s.y - y]
    this.offset ??= [s.x - x, s.y - y]
    return this.offset
  }
}

let store: RetouchStore | null = null
export const retouch = () => (store ??= new RetouchStore())

/** The source shown as a cross on the canvas, until something else draws there. */
export function showSource(key: string, x: number, y: number) {
  const r = 7
  setToolOverlay(key, {
    shapes: [
      { kind: 'path', points: [[x - r, y], [x + r, y]], closed: false, style: 'line' },
      { kind: 'path', points: [[x, y - r], [x, y + r]], closed: false, style: 'line' },
    ],
  })
}

// --- Patch --------------------------------------------------------------------------------

/**
 * A press with the Patch tool: inside the selection, a drag to where the
 * repair comes from; anywhere else, a Lasso round what to repair.
 */
export async function patchPress(d: OpenDoc, p0: Pointer): Promise<Gesture | null> {
  const sel = d.history.present.selection?.tiles
  if (sel && (await engine().call('select.at', { set: sel, x: p0.x, y: p0.y })) >= 0.5) {
    const b = await engine().call('select.bounds', { set: sel })
    if (b) return patchDrag(d, p0, sel, b)
  }
  return lassoGesture(d, p0)
}

function patchDrag(d: OpenDoc, p0: Pointer, sel: string, b: [number, number, number, number]): Gesture {
  let last = p0
  const box = (dx: number, dy: number): [number, number][] => [
    [b[0] + dx, b[1] + dy],
    [b[2] + dx, b[1] + dy],
    [b[2] + dx, b[3] + dy],
    [b[0] + dx, b[3] + dy],
  ]
  const show = () => setToolOverlay(d.key, { shapes: [{ kind: 'path', points: box(last.x - p0.x, last.y - p0.y), closed: true, style: 'ants' }], hideAnts: false })
  return {
    move(p) {
      last = p
      show()
    },
    up(p) {
      clearToolOverlay(d.key)
      const offset: [number, number] = [Math.round(p.x - p0.x), Math.round(p.y - p0.y)]
      if (!offset[0] && !offset[1]) return
      void patch(d, sel, offset)
    },
    cancel: () => clearToolOverlay(d.key),
  }
}

/** What the selection covers healed from the pixels `offset` away. */
async function patch(d: OpenDoc, selection: string, offset: [number, number]) {
  const doc = d.history.present
  const node = d.selected ? doc.nodes[d.selected] : null
  const t = pixelTarget(d)
  if (!node || node.kind !== 'pixel' || !t || t.mask) {
    notify('info', 'Patch works on a pixel layer’s pixels: select one.')
    return
  }
  if (node.locked.all || node.locked.pixels) {
    notify('info', `“${node.name}” is locked against painting. Unlock it in the Properties panel.`)
    return
  }
  try {
    const set = await engine().call('retouch.patch', { key: d.key, layer: node.props.tiles, format: { mode: doc.mode, depth: doc.depth }, transform: node.transform, selection, offset, sampleAll: false })
    if (set === node.props.tiles) return
    documents().commit((x) => setTiles(x, node.id, set), { key: d.key, label: 'Patch' })
  } catch (e) {
    notify('error', 'Patch didn’t work.', [e instanceof Error ? e.message : String(e)])
  }
}
