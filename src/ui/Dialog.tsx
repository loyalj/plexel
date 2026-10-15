/**
 * A modal dialog. Esc or a click on the dimmed backdrop closes it, the
 * first button takes the focus, and focus goes back where it was on close,
 * so a keyboard user lands where they started.
 *
 * Every dialog moves by its title bar, and opens where it was last left
 * (per dialog, kept by the browser), always kept on screen; a double-click
 * on the bar puts it back. A previewing dialog (a filter, an adjustment)
 * dims nothing, so the preview is seen as it is, and while it's open the
 * canvas only pans and zooms (app/previewing.ts).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { Hint } from './controls'
import { previewing } from '../app/previewing'

const PLACES = 'plexel.dialogs.v1'

/** Where each dialog was moved to, from where it opens on its own, in the interface's pixels. */
function readPlaces(): Record<string, [number, number]> {
  try {
    const raw = JSON.parse(localStorage.getItem(PLACES) ?? '{}')
    if (!raw || typeof raw !== 'object') return {}
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n)))) as Record<string, [number, number]>
  } catch {
    return {}
  }
}

function keepPlace(id: string, at: [number, number] | null) {
  try {
    const all = readPlaces()
    if (at) all[id] = at
    else delete all[id]
    localStorage.setItem(PLACES, JSON.stringify(all))
  } catch {
    // Only where it opens next time is lost.
  }
}

interface Props {
  title: string
  id: string
  onClose(): void
  children: ReactNode
  footer?: ReactNode
  /**
   * A dialog that leaves the canvas usable (Colour Range's eyedropper,
   * Select and Mask's refine brush): no backdrop, set to the side.
   * 'preview': a dialog previewing its change on the canvas, likewise
   * undimmed, the canvas only panning and zooming while it's open.
   */
  floating?: boolean | 'preview'
  /** What the dialog does, as an ⓘ by its title rather than a paragraph in it. */
  hint?: string
}

export function Dialog({ title, id, onClose, children, footer, floating, hint }: Props) {
  const box = useRef<HTMLDivElement>(null)
  // Read during the first render, before a field inside autofocuses, so
  // it's where the focus was before the dialog opened.
  const opener = useRef(document.activeElement as HTMLElement | null)
  // Moved from where it opens on its own, kept on screen.
  const [shift, setShift] = useState<[number, number]>(() => readPlaces()[id] ?? [0, 0])
  const [fitted, setFitted] = useState<[number, number]>(shift)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    // Where it is with the shift, pulled back inside the window if that would leave it off.
    const zoom = parseFloat(getComputedStyle(el).zoom) || 1
    const r = el.getBoundingClientRect()
    const [sx, sy] = shift
    const baseLeft = r.left / zoom - fitted[0]
    const baseTop = r.top / zoom - fitted[1]
    const w = r.width / zoom
    const vw = innerWidth / zoom
    const vh = innerHeight / zoom
    const x = Math.min(vw - 60 - baseLeft, Math.max(-baseLeft - w + 120, sx))
    const y = Math.min(vh - 40 - baseTop, Math.max(-baseTop, sy))
    if (x !== fitted[0] || y !== fitted[1]) setFitted([x, y])
  }, [shift, fitted])
  useEffect(() => (floating === 'preview' ? previewing.begin() : undefined), [floating])
  // A floating dialog leaves the canvas usable, so the focus may be out of it: Esc still closes it, unless a menu, a picker or a field elsewhere is open.
  useEffect(() => {
    if (!floating) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || box.current?.contains(e.target as Node)) return
      // A menu, a picker or a field elsewhere has the Esc first.
      if (document.querySelector('[role=menu], [data-colour-picker], [data-context-menu]')) return
      if (e.target instanceof HTMLElement && e.target !== document.body && e.target.closest('input, textarea, select, [data-dialog]')) return
      e.preventDefault()
      onClose()
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [floating, onClose])
  const moveBy = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return
    // The focus stays in the dialog, so its keys (Esc, Enter) still work.
    e.preventDefault()
    const head = e.currentTarget
    head.setPointerCapture(e.pointerId)
    const zoom = parseFloat(getComputedStyle(head).zoom) || 1
    const x0 = e.clientX
    const y0 = e.clientY
    const from = fitted
    let last = from
    const move = (ev: PointerEvent) => {
      last = [from[0] + (ev.clientX - x0) / zoom, from[1] + (ev.clientY - y0) / zoom]
      setShift(last)
      setFitted(last)
    }
    const up = () => {
      head.removeEventListener('pointermove', move)
      head.removeEventListener('pointerup', up)
      head.removeEventListener('pointercancel', up)
      if (last !== from) keepPlace(id, last)
    }
    head.addEventListener('pointermove', move)
    head.addEventListener('pointerup', up)
    head.addEventListener('pointercancel', up)
  }

  useEffect(() => {
    const before = opener.current
    // A field that asked for the focus keeps it. Otherwise the primary
    // button gets it, never the × in the corner (first in the markup) and
    // never a destructive choice such as Don't Save.
    if (!box.current?.contains(document.activeElement)) {
      const q = (s: string) => box.current?.querySelector<HTMLElement>(s)
      ;(q('.dialog-foot .primary') ?? q('.dialog-foot button') ?? q('button'))?.focus()
    }
    return () => before?.focus?.()
  }, [])

  return (
    <div
      className={floating ? `scrim floating${floating === 'preview' ? ' preview' : ''}` : 'scrim'}
      onPointerDown={(e) => !floating && e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} data-dialog={id} ref={box} style={fitted[0] || fitted[1] ? { translate: `${fitted[0]}px ${fitted[1]}px` } : undefined}>
        <header
          className="dialog-head"
          data-dialog-grip=""
          onPointerDown={moveBy}
          onDoubleClick={(e) => {
            if ((e.target as Element).closest('button')) return
            setShift([0, 0])
            setFitted([0, 0])
            keepPlace(id, null)
          }}
        >
          <h2 id={`${id}-title`}>
            {title}
            <Hint text={hint} />
          </h2>
          <button type="button" className="panel-close" aria-label="Close" onClick={onClose}>
            <Icon name="ui.close" />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        <footer className="dialog-foot">
          {footer ?? (
            <button type="button" className="button primary" onClick={onClose}>
              Close
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
