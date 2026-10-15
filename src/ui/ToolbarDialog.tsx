/**
 * Edit → Toolbar…: which slots the toolbar shows, their order, and its
 * columns, as Photoshop's Edit Toolbar. Changes show on the bar at once;
 * Restore Defaults puts it back as shipped. A slot is dragged by its grip
 * (or moved with its arrows), and switched off and on with its checkbox;
 * one switched off is under the bar's "…" slot, and its keys still work.
 */
import { useRef, useState, useSyncExternalStore } from 'react'
import { Dialog } from './Dialog'
import { Icon } from './Icon'
import type { IconName } from './icons'
import { Segmented } from './controls'
import { DEFAULT_TOOLBAR, moveSlot, setShown, toolbarPrefs, type ToolbarPrefs } from './toolbarPrefs'
import { TOOL_DEFS } from '../tools'

const COLUMNS: [ToolbarPrefs['columns'], string, string][] = [
  ['auto', 'Auto', 'Two when the window is too short for one'],
  ['one', 'One', 'Always one; it scrolls when the window is short'],
  ['two', 'Two', 'Always two'],
]

/** A slot's tools, by its id. */
const toolsOf = (id: string) => TOOL_DEFS.filter((t) => (t.group ?? t.id) === id)

export function ToolbarDialog({ onClose }: { onClose(): void }) {
  const p = useSyncExternalStore(toolbarPrefs().subscribe, toolbarPrefs().get)
  const set = (next: ToolbarPrefs) => toolbarPrefs().set(next)
  const list = useRef<HTMLOListElement>(null)
  // Where a dragged slot would go: before this slot, or at the end (null).
  const [drag, setDrag] = useState<{ id: string; before: string | null } | null>(null)

  const grab = (e: React.PointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const target = (y: number): string | null => {
      const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-toolbar-slot]') ?? [])]
      const past = rows.find((r) => {
        const b = r.getBoundingClientRect()
        return y < b.top + b.height / 2
      })
      return past ? past.dataset.toolbarSlot! : null
    }
    let at: { id: string; before: string | null } = { id, before: target(e.clientY) }
    setDrag(at)
    const move = (ev: PointerEvent) => {
      at = { id, before: target(ev.clientY) }
      setDrag(at)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setDrag(null)
      set(moveSlot(toolbarPrefs().get(), at.id, at.before))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const changed = JSON.stringify(p) !== JSON.stringify(DEFAULT_TOOLBAR)
  return (
    <Dialog
      id="toolbar"
      title="Edit Toolbar"
      hint="Drag a slot by its grip to move it; untick one to take it off the bar. Tools taken off are under the bar’s “…” slot, and their keys still work."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" disabled={!changed} data-why="The toolbar is as Plexel ships it" data-toolbar-reset onClick={() => toolbarPrefs().reset()}>
            Restore Defaults
          </button>
          <span className="dialog-foot-gap" />
          <button type="button" className="button primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="form">
        <Segmented id="toolbar-columns" label="Columns" value={p.columns} defaultValue="auto" options={COLUMNS} onChange={(columns) => set({ ...p, columns })} />
        <ol ref={list} className={`toolbar-edit${drag ? ' dragging' : ''}`} aria-label="Toolbar slots">
          {p.order.map((id, i) => {
            const tools = toolsOf(id)
            if (!tools.length) return null
            const shown = !p.hidden.includes(id)
            const names = tools.map((t) => t.name).join(', ')
            return (
              <li key={id} className={`toolbar-edit-row${shown ? '' : ' off'}${drag?.before === id ? ' drop-before' : ''}${drag?.id === id ? ' moving' : ''}`} data-toolbar-slot={id}>
                <span className="toolbar-edit-grip" data-tip="Drag to move" aria-hidden onPointerDown={(e) => grab(e, id)}>
                  <Icon name="ui.grip" />
                </span>
                <label className="check toolbar-edit-check">
                  <input type="checkbox" checked={shown} aria-label={`Show ${names}`} data-toolbar-shown={id} onChange={(e) => set(setShown(p, id, e.target.checked))} />
                  <span className="toolbar-edit-icon">
                    <Icon name={`tool.${tools[tools.length - 1].id}` as IconName} />
                  </span>
                  <span className="toolbar-edit-name">{names}</span>
                </label>
                <button type="button" className="icon-button" aria-label={`Move ${names} up`} disabled={i === 0} onClick={() => set(moveSlot(p, id, p.order[i - 1]))}>
                  <Icon name="ui.up" />
                </button>
                <button type="button" className="icon-button" aria-label={`Move ${names} down`} disabled={i === p.order.length - 1} onClick={() => set(moveSlot(p, id, p.order[i + 2] ?? null))}>
                  <Icon name="ui.down" />
                </button>
              </li>
            )
          })}
          {drag?.before === null && <li className="toolbar-edit-end drop-before" aria-hidden />}
        </ol>
      </div>
    </Dialog>
  )
}
