/**
 * Each artboard's name over the canvas, at its top left, as Photoshop and
 * Illustrator show them: a click selects the artboard, a drag moves it with
 * its layers (with any tool), a double-click renames it. The selected
 * artboard's name is in the accent.
 */
import { useState, useSyncExternalStore } from 'react'
import { artboardRect, artboardsOf, type ArtboardNode } from '../doc/artboards'
import { renameNode } from '../doc/edit'
import { documents } from '../app/documents'
import { views } from '../app/views'
import { canvasPointOf } from '../app/colourDrag'
import { commitArtboards, moveArtboardBy } from '../app/artboards'
import { setOverlayDoc } from '../app/overlay'
import { engine } from '../engine/EngineHost'
import { apply, viewMatrix } from '../render/view'

/** Where a document point is on the page, in CSS pixels from the viewport's corner. */
function onPage(x: number, y: number): [number, number] | null {
  const v = views().front()
  const canvas = document.querySelector<HTMLCanvasElement>('[data-engine-canvas]')
  const vp = canvas?.closest('.viewport')
  if (!v || !canvas || !vp) return null
  const c = engine().canvasSize()
  const pane = engine().panes()[0]
  const [dx, dy] = apply(viewMatrix(v, c), x, y)
  const r = canvas.getBoundingClientRect()
  const k = r.width / Math.max(1, engine().fullCanvasSize().width)
  const vr = vp.getBoundingClientRect()
  return [r.left - vr.left + (dx + (pane?.x ?? 0)) * k, r.top - vr.top + dy * k]
}

function Label({ a, selected, docKey }: { a: ArtboardNode; selected: boolean; docKey: string }) {
  const [naming, setNaming] = useState<string | null>(null)
  const [x0, y0] = artboardRect(a)
  const at = onPage(x0, y0)
  if (!at) return null
  const press = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || naming !== null) return
    e.preventDefault()
    e.stopPropagation()
    const d = documents().get(docKey)
    if (!d) return
    documents().select(a.id, docKey)
    const start = canvasPointOf(e.clientX, e.clientY)
    if (!start) return
    const doc = d.history.present
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    let delta: [number, number] = [0, 0]
    const move = (m: PointerEvent) => {
      const p = canvasPointOf(m.clientX, m.clientY)
      if (!p) return
      delta = [Math.round(p[0] - start[0]), Math.round(p[1] - start[1])]
      if (m.shiftKey) Math.abs(delta[0]) > Math.abs(delta[1]) ? (delta[1] = 0) : (delta[0] = 0)
      const moved = moveArtboardBy(doc, a.id, delta[0], delta[1])
      engine().setScene(docKey, moved)
      setOverlayDoc(docKey, moved)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setOverlayDoc(docKey, null)
      const now = documents().get(docKey)
      if (!now) return
      if (delta[0] || delta[1]) commitArtboards(now, (x) => moveArtboardBy(x, a.id, delta[0], delta[1]), 'Move Artboard')
      else engine().setScene(docKey, now.history.present)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  return (
    <div className={`artboard-label${selected ? ' selected' : ''}`} style={{ left: at[0], top: at[1] }} data-artboard-label={a.id}>
      {naming === null ? (
        <span onPointerDown={press} onDoubleClick={() => setNaming(a.name)} data-tip="Click to select the artboard, drag to move it, double-click to rename it">
          {a.name}
        </span>
      ) : (
        <input
          value={naming}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setNaming(e.target.value)}
          onBlur={() => {
            if (naming.trim() && naming !== a.name) documents().commit((x) => renameNode(x, a.id, naming), { key: docKey, label: 'Rename Artboard' })
            setNaming(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setNaming(null)
            e.stopPropagation()
          }}
        />
      )}
    </div>
  )
}

export function ArtboardLabels() {
  useSyncExternalStore(views().subscribe, views().front)
  const d = useSyncExternalStore(documents().subscribe, () => documents().active())
  // Drawn again as the canvas changes size, so the names stay on their artboards.
  useSyncExternalStore(engine().onCanvasSize, () => engine().fullCanvasSize().width * 100000 + engine().fullCanvasSize().height)
  const doc = d?.history.present
  if (!d || !doc) return null
  const boards = artboardsOf(doc)
  if (!boards.length) return null
  return (
    <>
      {boards.map((a) => (
        <Label key={a.id} a={a} selected={d.selected === a.id} docKey={d.key} />
      ))}
    </>
  )
}
