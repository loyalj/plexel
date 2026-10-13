/**
 * The menu bar, built from MENUS and the command registry.
 *
 * It behaves like a desktop menu bar rather than a row of dropdowns: once
 * one menu is open, moving across the bar opens the others without a click,
 * and a click anywhere else, or Esc, closes it. The keys are the usual ones:
 * arrows up and down the items, right into a submenu or on to the next menu,
 * left back out, Enter or Space to run.
 *
 * A disabled item says why when hovered (ui/Tooltips.tsx), from the
 * command's own reason.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { commandById, disabledReason, expandMenu, shortcutsOf, type CommandContext, type MenuDef, type MenuItem } from '../commands'
import { formatShortcut, parseShortcut } from '../input/shortcuts'
import { Logo } from './Logo'
import { Icon } from './Icon'

interface Props {
  menus: MenuDef[]
  ctx: CommandContext
  onRun(id: string): void
  /** At the right-hand end: the workspace switcher. */
  extra?: ReactNode
}

export function MenuBar({ menus, ctx, onRun, extra }: Props) {
  const [open, setOpen] = useState<string | null>(null)
  /** Labels of the open submenus, outermost first. */
  const [subs, setSubs] = useState<string[]>([])
  const bar = useRef<HTMLDivElement>(null)
  /** Set when a menu was opened from the keyboard, so its first item takes the focus. */
  const focusFirst = useRef(false)

  const close = () => {
    setOpen(null)
    setSubs([])
  }

  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!bar.current?.contains(e.target as Node)) close()
    }
    const blur = () => close()
    // Esc closes a menu opened with the mouse too, where the focus isn't in
    // its list (the list's own keys handle it there, a level at a time). It
    // goes no further: the app's Esc (cancelling a transform) waits for the
    // next press.
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (document.activeElement instanceof HTMLElement && document.activeElement.closest('.menu'))) return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', blur)
    window.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', blur)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])

  useEffect(() => {
    if (!open || !focusFirst.current) return
    focusFirst.current = false
    bar.current?.querySelector<HTMLButtonElement>(`[data-menu="${open}"] > .menu > .menu-item > .menu-button`)?.focus()
  }, [open])

  const step = (dir: 1 | -1) => {
    const i = menus.findIndex((m) => m.id === open)
    const next = menus[(i + dir + menus.length) % menus.length]
    focusFirst.current = true
    setSubs([])
    setOpen(next.id)
  }

  const run = (id: string) => {
    close()
    onRun(id)
  }

  /** Arrow keys inside an open menu. Works on whichever list holds the focus. */
  const onMenuKey = (e: ReactKeyboardEvent) => {
    const target = e.target as HTMLElement
    const list = target.closest('.menu')
    if (!list) return
    const buttons = [...list.querySelectorAll<HTMLButtonElement>(':scope > .menu-item > .menu-button:not(:disabled)')]
    const at = buttons.indexOf(target as HTMLButtonElement)
    const depth = Number(list.getAttribute('data-depth') ?? 0)
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        buttons[(at + 1) % buttons.length]?.focus()
        break
      case 'ArrowUp':
        e.preventDefault()
        buttons[(at - 1 + buttons.length) % buttons.length]?.focus()
        break
      case 'ArrowRight': {
        e.preventDefault()
        const sub = target.getAttribute('data-submenu')
        if (sub) {
          setSubs((s) => [...s.slice(0, depth), sub])
          requestAnimationFrame(() =>
            target.parentElement?.querySelector<HTMLButtonElement>(':scope > .menu > .menu-item > .menu-button')?.focus(),
          )
        } else step(1)
        break
      }
      case 'ArrowLeft':
        e.preventDefault()
        if (depth > 0) {
          setSubs((s) => s.slice(0, depth - 1))
          list.parentElement?.querySelector<HTMLButtonElement>(':scope > .menu-button')?.focus()
        } else step(-1)
        break
      case 'Escape':
        e.preventDefault()
        if (depth > 0) {
          setSubs((s) => s.slice(0, depth - 1))
          list.parentElement?.querySelector<HTMLButtonElement>(':scope > .menu-button')?.focus()
        } else {
          const id = open
          close()
          bar.current?.querySelector<HTMLButtonElement>(`[data-menu="${id}"] > .menu-title`)?.focus()
        }
        break
    }
  }

  const renderItems = (items: MenuItem[], depth: number) => (
    <ul className="menu" role="menu" data-depth={depth} onKeyDown={onMenuKey}>
      {expandMenu(items, ctx).map((item, i) => {
        if ('separator' in item) return <li key={`sep-${i}`} className="menu-separator" role="separator" />
        if ('submenu' in item) {
          const isOpen = subs[depth] === item.submenu
          return (
            <li
              key={item.submenu}
              className={`menu-item${isOpen ? ' open' : ''}`}
              onPointerEnter={() => setSubs((s) => [...s.slice(0, depth), item.submenu])}
            >
              <button
                type="button"
                className="menu-button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                data-submenu={item.submenu}
                onClick={() => setSubs((s) => [...s.slice(0, depth), item.submenu])}
              >
                <span />
                <span>{item.submenu}</span>
                <span className="menu-arrow"><Icon name="ui.submenu" /></span>
              </button>
              {isOpen && renderItems(item.items, depth + 1)}
            </li>
          )
        }
        if (!('command' in item)) return null
        const def = commandById(item.command, ctx)
        if (!def) return null
        const enabled = def.enabled ? def.enabled(ctx) : true
        const checked = def.checked?.(ctx)
        const first = shortcutsOf(def)[0]
        const shortcut = first ? parseShortcut(first) : null
        return (
          <li key={def.id} className="menu-item" onPointerEnter={() => setSubs((s) => s.slice(0, depth))}>
            <button
              type="button"
              className="menu-button"
              role={def.checked ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={def.checked ? !!checked : undefined}
              data-command={def.id}
              disabled={!enabled}
              data-why={enabled ? undefined : (disabledReason(def, ctx) ?? undefined)}
              data-tip-side="right"
              onClick={() => run(def.id)}
            >
              <span className="menu-check">{checked ? <Icon name="ui.check" /> : ''}</span>
              <span>{def.menuLabel ? def.menuLabel(ctx) : def.label}</span>
              <span className="menu-shortcut">{shortcut ? formatShortcut(shortcut) : ''}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )

  return (
    <div className="menubar" ref={bar} role="menubar">
      <div className="menubar-brand">
        <Logo />
        Plexel
      </div>
      {menus.map((m) => (
        <div key={m.id} className="menu-root" data-menu={m.id}>
          <button
            type="button"
            className="menu-title"
            aria-haspopup="menu"
            aria-expanded={open === m.id}
            onPointerDown={(e) => {
              // On press rather than release, as desktop menus open. The
              // default is prevented so the title doesn't keep the focus
              // ring after a mouse click.
              e.preventDefault()
              setSubs([])
              setOpen(open === m.id ? null : m.id)
            }}
            onPointerEnter={() => {
              if (open && open !== m.id) {
                setSubs([])
                setOpen(m.id)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                e.preventDefault()
                focusFirst.current = true
                setOpen(m.id)
              }
            }}
          >
            {m.label}
          </button>
          {open === m.id && renderItems(m.items, 0)}
        </div>
      ))}
      {extra && <div className="menubar-extra">{extra}</div>}
    </div>
  )
}
