/**
 * The toolbar down the left of the canvas, built from TOOL_DEFS, as
 * Photoshop's is: one slot per tool, or per group of tools that share a key
 * (the Pen's, the Shape tools', the Brushes'...), showing the group's last
 * tool with a small triangle in its corner. Click a slot for its tool;
 * right-click it, hold the button down or click the triangle for the rest
 * of its group, in a flyout with their names and keys; Alt-click goes on to
 * the group's next tool. Its keys work from anywhere through the command
 * registry; the buttons are for the mouse. Hovering one shows its card
 * (ui/Tooltips.tsx): what it does and every key it answers to.
 *
 * When the window is too short for one column, the slots go into two; too
 * short for two, the bar scrolls.
 *
 * Which slots show, their order and the columns are yours (Edit →
 * Toolbar…, ui/toolbarPrefs.ts). The "…" slot at the foot holds the tools
 * taken off the bar, and Edit Toolbar.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { TOOL_BY_ID, TOOL_DEFS, tools, toolsInGroup, type ToolDef, type ToolId } from '../tools'
import { Icon } from './Icon'
import { springTools } from '../app/springTools'
import type { IconName } from './icons'
import { toolKeys } from '../commands'
import { keyChanges, subscribeKeys } from '../input/keymap'
import { formatShortcut, parseShortcut } from '../input/shortcuts'
import { toolbarPrefs } from './toolbarPrefs'

/** The toolbar's slots, in order: a tool on its own, or a group at its first tool's place. */
interface Slot {
  group: string | null
  tools: ToolDef[]
}

/** A slot's id: its group's, or its tool's. */
export const slotId = (s: Slot) => s.group ?? s.tools[0].id

export const TOOL_SLOTS: Slot[] = (() => {
  const out: Slot[] = []
  const seen = new Set<string>()
  for (const t of TOOL_DEFS) {
    if (!t.group) out.push({ group: null, tools: [t] })
    else if (!seen.has(t.group)) {
      seen.add(t.group)
      out.push({ group: t.group, tools: toolsInGroup(t.group) })
    }
  }
  return out
})()

/** How long the button must be held for the group's flyout. */
const HOLD_MS = 450

const keyLabel = (t: ToolDef) => {
  const key = toolKeys(t).pick
  return key ? formatShortcut(parseShortcut(key)!) : ''
}

const choose = (id: ToolId) => {
  springTools().forget()
  tools().set(id)
}

export function Toolbar({ onEdit }: { onEdit(): void }) {
  const current = useSyncExternalStore(tools().subscribe, tools().get)
  const prefs = useSyncExternalStore(toolbarPrefs().subscribe, toolbarPrefs().get)
  const byId = new Map(TOOL_SLOTS.map((s) => [slotId(s), s]))
  const shownSlots = prefs.order.filter((id) => !prefs.hidden.includes(id)).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
  const offBar = prefs.order.filter((id) => prefs.hidden.includes(id)).flatMap((id) => byId.get(id)?.tools ?? [])
  // Drawn again when the keys change, so the labels name yours.
  useSyncExternalStore(subscribeKeys, keyChanges)
  const bar = useRef<HTMLElement>(null)
  const [columns, setColumns] = useState(1)
  const [flyout, setFlyout] = useState<{ group: string; anchor: HTMLElement } | null>(null)
  const [more, setMore] = useState<HTMLElement | null>(null)
  const hold = useRef<number | null>(null)

  // One column while they fit; two when they don't.
  useLayoutEffect(() => {
    const el = bar.current
    if (!el) return
    const fit = () => {
      const tool = el.querySelector('.tool') as HTMLElement | null
      if (!tool) return
      const style = getComputedStyle(el)
      const gap = parseFloat(style.rowGap || style.gap || '0') || 0
      const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      // Every slot shown, and the "…" one.
      const need = (shownSlots.length + 1) * (tool.offsetHeight + gap) - gap + pad
      setColumns(prefs.columns === 'one' ? 1 : prefs.columns === 'two' ? 2 : need > el.clientHeight + 0.5 ? 2 : 1)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el.parentElement ?? el)
    return () => ro.disconnect()
  }, [shownSlots.length, prefs.columns])

  useEffect(() => () => {
    if (hold.current !== null) clearTimeout(hold.current)
  }, [])

  return (
    <nav
      ref={bar}
      className={`toolbar${columns === 2 ? ' two-columns' : ''}`}
      aria-label="Tools"
      onContextMenu={(e) => {
        // The bar itself (not a slot): Edit Toolbar.
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        onEdit()
      }}
    >
      {shownSlots.map((slot) => {
        const shown = slot.group ? (slot.tools.some((t) => t.id === current) ? current : tools().shownIn(slot.group)) : slot.tools[0].id
        const t = TOOL_BY_ID.get(shown)!
        const pressed = slot.tools.some((x) => x.id === current)
        const key = keyLabel(t)
        const open = (anchor: HTMLElement) => slot.group && setFlyout({ group: slot.group, anchor })
        return (
          <button
            key={slot.group ?? t.id}
            type="button"
            className={`tool${slot.group ? ' grouped' : ''}`}
            data-tool={t.id}
            data-tool-slot={slot.group ?? t.id}
            aria-pressed={pressed}
            aria-haspopup={slot.group ? 'menu' : undefined}
            data-tip-tool={t.id}
            data-tip-side="right"
            aria-label={key ? `${t.name} (${key})` : t.name}
            onPointerDown={(e: ReactPointerEvent<HTMLButtonElement>) => {
              if (!slot.group || e.button !== 0) return
              const el = e.currentTarget
              // The corner triangle opens the group at once; a held press, after a moment.
              const r = el.getBoundingClientRect()
              if (e.clientX > r.right - 9 && e.clientY > r.bottom - 9) {
                e.preventDefault()
                open(el)
                return
              }
              hold.current = window.setTimeout(() => {
                hold.current = null
                open(el)
              }, HOLD_MS)
            }}
            onPointerUp={() => {
              if (hold.current !== null) clearTimeout(hold.current)
              hold.current = null
            }}
            onPointerLeave={() => {
              if (hold.current !== null) clearTimeout(hold.current)
              hold.current = null
            }}
            onClick={(e) => {
              if (flyout) return
              // Alt-click: the group's next tool, as Photoshop has it.
              if (e.altKey && slot.group) {
                const list = slot.tools
                const at = list.findIndex((x) => x.id === shown)
                return choose(list[(at + 1) % list.length].id)
              }
              choose(t.id)
            }}
            onContextMenu={(e) => {
              if (!slot.group) return
              e.preventDefault()
              open(e.currentTarget)
            }}
          >
            <Icon name={`tool.${t.id}` as IconName} filled={pressed} />
          </button>
        )
      })}
      <button type="button" className="tool tool-more" data-tool-slot="more" aria-haspopup="menu" aria-label={offBar.length ? `${offBar.length} more tools, and Edit Toolbar` : 'Edit Toolbar'} data-tip={offBar.length ? 'More tools, and Edit Toolbar' : 'Edit Toolbar'} data-tip-side="right" onClick={(e) => setMore(e.currentTarget)}>
        <Icon name="ui.more" />
      </button>
      {flyout && createPortal(<Flyout list={toolsInGroup(flyout.group)} label={`${TOOL_BY_ID.get(toolsInGroup(flyout.group)[0].id)!.name} tools`} id={flyout.group} anchor={flyout.anchor} current={current} onClose={() => setFlyout(null)} />, document.body)}
      {more &&
        createPortal(
          <Flyout
            list={offBar}
            label="More tools"
            id="more"
            anchor={more}
            current={current}
            onClose={() => setMore(null)}
            extra={{
              label: 'Edit Toolbar…',
              run: () => {
                setMore(null)
                onEdit()
              },
            }}
          />,
          document.body,
        )}
    </nav>
  )
}

/** A group's tools (or the ones off the bar), beside its slot: each with its icon, name and key. */
function Flyout({ list, label, id, anchor, current, onClose, extra }: { list: ToolDef[]; label: string; id: string; anchor: HTMLElement; current: ToolId; onClose(): void; extra?: { label: string; run(): void } }) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect()
    const r = box.current?.getBoundingClientRect()
    const h = r?.height ?? 0
    setPos({ left: a.right + 4, top: Math.max(4, Math.min(window.innerHeight - h - 4, a.top)) })
  }, [anchor])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (box.current?.contains(t)) return
      // A press on the slot that opened it: closing here, so the click that follows doesn't reopen it.
      onClose()
      if (anchor.contains(t)) e.stopPropagation()
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('pointerdown', down, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('pointerdown', down, true)
    }
  }, [anchor, onClose])
  // The first item focused, for the keyboard.
  useEffect(() => {
    ;(box.current?.querySelector('[aria-checked="true"], [role="menuitemradio"], [role="menuitem"]') as HTMLElement | null)?.focus()
  }, [])
  return (
    <div
      ref={box}
      className="tool-flyout"
      role="menu"
      aria-label={label}
      data-tool-flyout={id}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onKeyDown={(e) => {
        const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]') ?? [])]
        const at = items.indexOf(document.activeElement as HTMLElement)
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
        }
      }}
    >
      {list.map((t) => (
        <button
          key={t.id}
          type="button"
          role="menuitemradio"
          aria-checked={current === t.id}
          className="tool-flyout-item"
          data-tool-option={t.id}
          onClick={() => {
            choose(t.id)
            onClose()
          }}
        >
          <Icon name={`tool.${t.id}` as IconName} filled={current === t.id} />
          <span className="tool-flyout-name">{t.name}</span>
          <span className="tool-flyout-key">{keyLabel(t)}</span>
        </button>
      ))}
      {extra && (
        <button type="button" role="menuitem" className="tool-flyout-item tool-flyout-extra" data-tool-edit="" onClick={extra.run}>
          <Icon name="ui.settings" />
          <span className="tool-flyout-name">{extra.label}</span>
          <span className="tool-flyout-key" />
        </button>
      )}
    </div>
  )
}
