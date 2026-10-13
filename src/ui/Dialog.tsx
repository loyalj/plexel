/**
 * A modal dialog. Esc or a click on the dimmed backdrop closes it, the
 * first button takes the focus, and focus goes back where it was on close,
 * so a keyboard user lands where they started.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './Icon'

interface Props {
  title: string
  id: string
  onClose(): void
  children: ReactNode
  footer?: ReactNode
  /**
   * A dialog that leaves the canvas usable (Colour Range's eyedropper,
   * Select and Mask's refine brush): no backdrop, set to the side.
   */
  floating?: boolean
}

export function Dialog({ title, id, onClose, children, footer, floating }: Props) {
  const box = useRef<HTMLDivElement>(null)
  // Read during the first render, before a field inside autofocuses, so
  // it's where the focus was before the dialog opened.
  const opener = useRef(document.activeElement as HTMLElement | null)

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
      className={floating ? 'scrim floating' : 'scrim'}
      onPointerDown={(e) => !floating && e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} data-dialog={id} ref={box}>
        <header className="dialog-head">
          <h2 id={`${id}-title`}>{title}</h2>
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
