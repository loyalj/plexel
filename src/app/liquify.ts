/**
 * Filter → Liquify (Ctrl+Alt+X): a session on the canvas, brushing a
 * Liquify field on the selected layer. Forward Warp pushes what's under
 * the brush along with it; Reconstruct takes the warp back; Smooth evens
 * it out; Twirl turns it (Alt the other way); Pucker draws it in to the
 * brush's middle, Bloat pushes it out; Push Left moves it left of the way
 * the brush goes.
 *
 * The field is a Liquify effect in the layer's effects (filters/defs.ts):
 * live, so the layer's pixels are never changed and Liquify can be opened
 * on it again to carry on. It goes after a Warp from Free Transform and
 * before any other filter. What's previewed is the document with the field
 * as it is, sent to the engine a frame at a time; Commit makes it one step.
 */
import { addEffect, invertAffine, moveEffect, removeNode, setParams } from '../doc/edit'
import { makeNode } from '../doc/nodes'
import type { Affine, Doc, DocNode, NodeId } from '../doc/types'
import { engine } from '../engine/EngineHost'
import { filterValues } from '../filters/defs'
import { decodeField, encodeField, isEmptyField, liquifyDab, newField, type Field, type LiquifyTool } from '../geom/warp'
import { apply } from '../render/view'
import { cantMove, sessions, transformBox, type Gesture, type Pointer, type Session } from './canvasTools'
import { filterTarget } from './effects'
import { documents, newId, type OpenDoc } from './documents'
import { notify } from './notices'
import { setToolOverlay } from './overlay'

export interface LiquifySettings {
  tool: LiquifyTool
  /** The brush's diameter, in document pixels. */
  size: number
  /** How strongly it acts, 1..100. */
  pressure: number
}

type Listener = () => void
class LiquifyStore {
  private state: LiquifySettings = { tool: 'warp', size: 100, pressure: 50 }
  private listeners = new Set<Listener>()
  /** The open session's Restore All. */
  restore: (() => void) | null = null
  get = () => this.state
  subscribe = (fn: Listener) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  set(patch: Partial<LiquifySettings>) {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn()
  }
}
let store: LiquifyStore | null = null
export const liquifySettings = () => (store ??= new LiquifyStore())

export const LIQUIFY_TOOLS: [LiquifyTool, string, string][] = [
  ['warp', 'Forward Warp', 'Pushes what’s under the brush along the way it moves.'],
  ['reconstruct', 'Reconstruct', 'Takes the warp back towards none, where it’s brushed.'],
  ['smooth', 'Smooth', 'Evens out the warp where it’s brushed.'],
  ['twirl-cw', 'Twirl', 'Turns what’s under the brush clockwise while it’s held; Alt turns it the other way.'],
  ['pucker', 'Pucker', 'Draws what’s under the brush in towards its middle while it’s held.'],
  ['bloat', 'Bloat', 'Pushes what’s under the brush out from its middle while it’s held.'],
  ['push-left', 'Push Left', 'Moves what’s under the brush to the left of the way it goes (right, going up).'],
]

/** The first Liquify effect on a node, if it has one. */
function liquifyOf(doc: Doc, id: NodeId): DocNode | null {
  for (const e of doc.nodes[id]?.effects ?? []) {
    const n = doc.nodes[e]
    if (n?.kind === 'filter' && n.props.filter === 'liquify') return n
  }
  return null
}

/**
 * A document with a node's Liquify field set: in the effect `reuse` (the
 * one the session carried on), or a new one after a leading Warp; taken
 * off when the field is empty.
 */
function withField(doc: Doc, id: NodeId, f: Field, effectId: NodeId, reuse: NodeId | null): Doc {
  const have = reuse ? doc.nodes[reuse] : null
  if (isEmptyField(f)) return have ? removeNode(doc, have.id) : doc
  const params = { field: encodeField(f), frame: [1, 0, 0, 1, 0, 0] }
  if (have) return setParams(doc, have.id, params)
  const n = doc.nodes[id]
  const first = n?.effects[0] ? doc.nodes[n.effects[0]] : null
  const at = first?.kind === 'filter' && first.props.filter === 'warp' ? 1 : 0
  return moveEffect(addEffect(doc, id, makeNode('filter', effectId, 'Liquify', { filter: 'liquify', params })), effectId, at)
}

/** Opens Liquify on the selected layer. */
export async function beginLiquify() {
  const d = documents().active()
  if (!d) return
  const doc = d.history.present
  const node = filterTarget(d)
  if (!node) return notify('info', 'Select a layer to liquify.')
  if (node.kind === 'group' || node.kind === 'adjustment' || node.kind === 'fill' || node.kind === 'mask') return notify('info', 'Liquify works on a pixel layer, a smart object, a shape or text: a group can be converted to a smart object first.')
  const why = cantMove(node)
  if (why) return notify('info', why)
  // The field: the one there is, carried on; or a new one round the layer's content, in its own coordinates.
  const have = liquifyOf(doc, node.id)
  let field: Field | null = null
  let reuse: NodeId | null = null
  if (have?.kind === 'filter') {
    const v = filterValues('liquify', have.props.params, doc.mode)
    const f = v.field ? decodeField(v.field) : null
    const frame = v.frame as number[]
    // A field rasterized from under (its frame moved) is left as it is, and a new one made over it.
    if (f && frame.every((x, i) => x === [1, 0, 0, 1, 0, 0][i])) {
      field = { ...f, d: f.d.slice() }
      reuse = have.id
    }
  }
  if (!field) {
    const fb = await transformBox(doc, node)
    if (!fb) return notify('info', `“${node.name}” has nothing in it to liquify.`)
    // The box in the node's own coordinates (a compound's comes in the document's).
    const toLocal = invertAffine(node.transform)
    const m = node.kind === 'boolean' ? toLocal : ([1, 0, 0, 1, 0, 0] as Affine)
    const [x0, y0, x1, y1] = fb.box
    const pts = [
      [x0, y0],
      [x1, y0],
      [x0, y1],
      [x1, y1],
    ].map(([x, y]) => apply(m, x, y))
    field = newField([Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))])
  }
  sessions().start(liquifySession(d, doc, node, field, reuse))
}

function liquifySession(d: OpenDoc, doc: Doc, node: DocNode, field: Field, reuse: NodeId | null): Session {
  const effectId = newId('f')
  const t = node.transform
  const toLocal = invertAffine(t)
  // Document pixels to the node's own: how far a brush of a size reaches there.
  const unit = Math.sqrt(Math.abs(toLocal[0] * toLocal[3] - toLocal[1] * toLocal[2])) || 1
  let pending = false
  let cursor: [number, number] | null = null
  const send = () => {
    if (pending) return
    pending = true
    requestAnimationFrame(() => {
      pending = false
      if (sessions().get() !== s) return
      engine().setScene(d.key, withField(doc, node.id, field, effectId, reuse))
    })
  }
  const show = () => {
    if (!cursor) return setToolOverlay(d.key, { shapes: [] })
    const r = liquifySettings().get().size / 2
    const pts: [number, number][] = Array.from({ length: 48 }, (_, i) => [cursor![0] + r * Math.cos((i / 48) * 2 * Math.PI), cursor![1] + r * Math.sin((i / 48) * 2 * Math.PI)])
    setToolOverlay(d.key, { shapes: [{ kind: 'path', points: pts, closed: true, style: 'line' }] })
  }
  const dab = (p: Pointer, dx: number, dy: number) => {
    const set = liquifySettings().get()
    const [x, y] = apply(toLocal, p.x, p.y)
    // The drag in the node's own coordinates.
    const lx = toLocal[0] * dx + toLocal[2] * dy
    const ly = toLocal[1] * dx + toLocal[3] * dy
    const tool: LiquifyTool = set.tool === 'twirl-cw' && p.altKey ? 'twirl-ccw' : set.tool === 'bloat' && p.altKey ? 'pucker' : set.tool === 'pucker' && p.altKey ? 'bloat' : set.tool
    liquifyDab(field, tool, x, y, lx, ly, (set.size / 2) * unit, set.pressure / 100)
  }
  liquifySettings().restore = () => {
    field.d.fill(0)
    send()
  }
  const s: Session = {
    kind: 'liquify',
    key: d.key,
    down(p0) {
      let last = p0
      let at = p0
      dab(p0, 0, 0)
      send()
      // Tools that act while held, not only as the brush moves: a dab every frame.
      const held = ['twirl-cw', 'pucker', 'bloat', 'reconstruct', 'smooth'].includes(liquifySettings().get().tool)
      const timer = held
        ? setInterval(() => {
            dab(at, 0, 0)
            send()
          }, 33)
        : null
      const stop = () => {
        if (timer) clearInterval(timer)
      }
      const g: Gesture = {
        move(p) {
          at = p
          cursor = [p.x, p.y]
          show()
          // Dabs a quarter of the brush apart along the way, each pushing by its share.
          const step = Math.max(1, liquifySettings().get().size / 8)
          const len = Math.hypot(p.x - last.x, p.y - last.y)
          const n = Math.max(1, Math.ceil(len / step))
          for (let i = 1; i <= n; i++) {
            const q = { ...p, x: last.x + ((p.x - last.x) * i) / n, y: last.y + ((p.y - last.y) * i) / n }
            dab(q, (p.x - last.x) / n, (p.y - last.y) / n)
          }
          last = p
          send()
        },
        up: stop,
        cancel: stop,
      }
      return g
    },
    hover(p) {
      cursor = [p.x, p.y]
      show()
    },
    commit() {
      liquifySettings().restore = null
      const next = withField(doc, node.id, field, effectId, reuse)
      if (next === doc) return void engine().setScene(d.key, doc)
      documents().commit((x) => withField(x, node.id, field, effectId, reuse), { key: d.key, label: 'Liquify' })
    },
    cancel() {
      liquifySettings().restore = null
      engine().setScene(d.key, doc)
    },
    readout: () => 'Liquify: brush the layer to push it about. Enter commits; Esc cancels.',
  }
  return s
}
