/**
 * Dragging a swatch onto the canvas: dropped on a shape (or a compound, or
 * text), it fills it with that colour; with Shift held at the drop, it
 * strokes it instead. A document's global or spot swatch stays linked to
 * the fill or stroke it's given to, as choosing it in Properties does.
 *
 * A press on a swatch that moves a few pixels becomes a drag, with a chip of
 * the colour following the pointer; one that doesn't is still a click.
 */
import type { ColourValue } from '../color/value'
import type { NodeId } from '../doc/types'
import { setAppearance } from '../doc/edit'
import { swatchPaint } from '../doc/swatches'
import { fillItem, solid, strokeItem, type AppearanceItem, type Paint } from '../doc/vector'
import { colourEngineNow } from './colour'
import { colourSettings } from './colourSettings'
import { swatchColourIn } from './docSwatches'
import { documents } from './documents'
import { notify } from './notices'
import { layersAt } from './pick'
import { docPx } from './snapping'

/** What's dragged: a colour, or one of the front document's swatches by id. */
export type Dragged = { kind: 'colour'; value: ColourValue } | { kind: 'swatch'; id: string }

/** The canvas's answer to "which document point is under this screen point?", set by the canvas (ui/Viewport.tsx). */
let canvasPointAt: ((clientX: number, clientY: number) => [number, number] | null) | null = null
export function registerCanvasPoint(fn: typeof canvasPointAt) {
  canvasPointAt = fn
}

/** How far a press moves, in CSS pixels, before it's a drag. */
const DRAG = 4

/** Starts watching a press on a swatch; `css` is the colour to show on the chip. */
export function pressSwatch(e: { clientX: number; clientY: number; pointerId: number; button: number }, what: Dragged, css: string) {
  if (e.button !== 0) return
  const x0 = e.clientX
  const y0 = e.clientY
  let chip: HTMLDivElement | null = null
  const move = (m: PointerEvent) => {
    if (m.pointerId !== e.pointerId) return
    if (!chip && Math.hypot(m.clientX - x0, m.clientY - y0) < DRAG) return
    if (!chip) {
      chip = document.createElement('div')
      chip.className = 'colour-drag'
      chip.dataset.colourDrag = ''
      chip.style.background = css
      document.body.appendChild(chip)
    }
    chip.style.left = `${m.clientX}px`
    chip.style.top = `${m.clientY}px`
  }
  const end = (u: PointerEvent) => {
    if (u.pointerId !== e.pointerId) return
    removeEventListener('pointermove', move)
    removeEventListener('pointerup', end)
    removeEventListener('pointercancel', end)
    if (!chip) return
    chip.remove()
    // The click a drag ends in isn't a click on anything.
    const swallow = (c: Event) => c.stopPropagation()
    addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0)
    if (u.type === 'pointerup') void drop(u.clientX, u.clientY, what, u.shiftKey)
  }
  addEventListener('pointermove', move)
  addEventListener('pointerup', end)
  addEventListener('pointercancel', end)
}

/** The colour as a paint in the document's terms: linked to its swatch when that's a global or spot one. */
function paintOf(what: Dragged): Paint | null {
  const d = documents().active()
  if (!d) return null
  const doc = d.history.present
  if (what.kind === 'swatch') {
    const s = doc.swatches?.find((x) => x.id === what.id)
    const colourOf = swatchColourIn(doc)
    return s && colourOf ? swatchPaint(s, 1, colourOf) : null
  }
  const cms = colourEngineNow()
  if (!cms) return null
  const { intent, blackPointCompensation } = colourSettings.get()
  return solid(cms.converter.convert(what.value, { space: doc.mode, profile: doc.profile }, intent, blackPointCompensation).c)
}

/** A shape's appearance with its first fill (or stroke) given `paint`; one is added when it has none. */
export function withPaint(items: AppearanceItem[], paint: Paint, stroke: boolean): AppearanceItem[] {
  const i = items.findIndex((it) => it.kind === (stroke ? 'stroke' : 'fill'))
  if (i < 0) return stroke ? [...items, strokeItem(paint, 4)] : [fillItem(paint), ...items]
  return items.map((it, j) => (j === i ? ({ ...it, paint, enabled: true } as AppearanceItem) : it))
}

async function drop(clientX: number, clientY: number, what: Dragged, stroke: boolean) {
  const d = documents().active()
  const at = canvasPointAt?.(clientX, clientY)
  if (!d || !at) return
  const doc = d.history.present
  const hits = await layersAt(doc, at[0], at[1], docPx(4))
  const target: NodeId | undefined = hits.find((id) => ['vector', 'boolean', 'text'].includes(doc.nodes[id]?.kind ?? ''))
  if (!target) return notify('info', 'Drop a swatch on a shape or text to fill it; Shift to stroke it.')
  const paint = paintOf(what)
  const n = doc.nodes[target]
  if (!paint || !n || (n.kind !== 'vector' && n.kind !== 'boolean' && n.kind !== 'text')) return
  documents().commit((x) => setAppearance(x, target, withPaint(n.props.appearance, paint, stroke)), { key: d.key, label: stroke ? 'Stroke with Swatch' : 'Fill with Swatch' })
}
