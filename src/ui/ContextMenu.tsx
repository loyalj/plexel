/**
 * The canvas's right-click menu: what can be done now, from contextMenu()
 * in the command registry, at the pointer. It looks and works like the
 * menu bar's menus (up and down, Enter, Esc) and closes on any press
 * outside it, a scroll or the window losing focus.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { COMMANDS_BY_ID, contextLabel, shortcutsOf, type CommandContext, type MenuItem } from '../commands'
import { formatShortcut, parseShortcut } from '../input/shortcuts'
import { interfacePrefs } from './interface'
import { Icon } from './Icon'

interface Props {
  items: MenuItem[]
  ctx: CommandContext
  /** Where it was asked for, in screen (client) pixels. */
  x: number
  y: number
  /** Opens upward from (x, y), its foot there: for a button along the foot of a panel. */
  up?: boolean
  onRun(id: string): void
  onClose(): void
}

export function ContextMenu({ items, ctx, x, y, up = false, onRun, onClose }: Props) {
  const list = useRef<HTMLUListElement>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  // On screen whatever the corner: flipped left or up where it would run off.
  // The menu is zoomed with the interface, so its position is divided by the scale.
  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    const s = interfacePrefs().get().scale
    const w = el.offsetWidth * s
    const h = el.offsetHeight * s
    const left = x + w > innerWidth - 4 ? Math.max(4, x - w) : x
    const top = up ? Math.max(4, y - h) : y + h > innerHeight - 4 ? Math.max(4, innerHeight - 4 - h) : y
    setAt({ left: left / s, top: top / s })
  }, [x, y, up])

  // The first item takes the focus once the menu is placed (a hidden one can't), so the keys work at once.
  useEffect(() => {
    if (at) list.current?.querySelector<HTMLButtonElement>('.menu-button')?.focus()
  }, [at])

  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node)) onClose()
    }
    const close = () => onClose()
    // Esc closes it wherever the focus is, and goes no further.
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', key, true)
    document.addEventListener('pointerdown', outside, true)
    addEventListener('blur', close)
    addEventListener('resize', close)
    document.addEventListener('wheel', close, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      document.removeEventListener('pointerdown', outside, true)
      removeEventListener('blur', close)
      removeEventListener('resize', close)
      document.removeEventListener('wheel', close, true)
    }
  }, [onClose])

  const onKey = (e: ReactKeyboardEvent) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('.menu-button') ?? [])]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    // Keys stay in the menu: Enter runs the item, nothing reaches the app's shortcuts.
    e.stopPropagation()
  }

  return (
    <ul
      className="menu context-menu"
      role="menu"
      aria-label="Actions"
      data-context-menu
      ref={list}
      style={at ? { left: at.left, top: at.top } : { visibility: 'hidden', left: 0, top: 0 }}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if ('separator' in item) return <li key={`sep-${i}`} className="menu-separator" role="separator" />
        if ('submenu' in item || 'runtime' in item) return null
        const def = COMMANDS_BY_ID.get(item.command)
        if (!def) return null
        const first = shortcutsOf(def)[0]
        const shortcut = first ? parseShortcut(first) : null
        const checked = def.checked?.(ctx)
        return (
          <li key={def.id} className="menu-item">
            <button
              type="button"
              className="menu-button"
              role="menuitem"
              data-command={def.id}
              onClick={() => {
                onClose()
                onRun(def.id)
              }}
            >
              <span className="menu-check">{checked ? <Icon name="ui.check" /> : ''}</span>
              <span>{contextLabel(def, ctx)}</span>
              <span className="menu-shortcut">{shortcut ? formatShortcut(shortcut) : ''}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
