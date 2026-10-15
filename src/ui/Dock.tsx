/**
 * The docks and the floating panels: what layout.ts says, drawn, and the
 * pointer turned into its moves.
 *
 * A dock is on either side of the canvas, as a row of columns; a column is
 * groups of panels stacked; a group shows one panel at a time, with a tab
 * for each. A group's tab bar drags it (a tab drags just that panel): onto
 * another group's tabs to join it, above or below a group to stack, against
 * a column's side or the window's to make a new column, or anywhere else to
 * float it in a window of its own. Ctrl held while dragging always floats,
 * as in Photoshop. A floating window of one group moves by its tab bar, and
 * docks when let go over a dock; one of several groups stacked moves by the
 * grip along its top, and each group's bar pulls that group out (or, near
 * the foot of a group in a window, stacks under it). The ⋯ menu does the
 * same moves from the keyboard.
 *
 * A column never scrolls as well as the panels in it: its groups share its
 * height. Each takes the height of what's in it while there's room (the
 * last of them the room left), and when there isn't, the tallest give it
 * up first: every group is held to one height, the most that lets them all
 * fit, so a short panel (Layers with a few layers, Colour) stays whole while
 * a long one (Properties with a shape's appearance) scrolls what's in it.
 * None goes below its tab bar and a strip of what's in it. Dragging the divider between two groups trades
 * height between them; from then on the column's groups keep those
 * proportions as the window changes size. Double-clicking a divider fits
 * the column's groups to what's in them again.
 *
 * Tabs that don't fit a group's bar go into a » menu at its end; the front
 * tab always stays on the bar.
 *
 * Each column has a strip along its top whose button folds it to icons, as
 * Photoshop's do: a button a panel, grouped as the tabs are. Clicking one
 * shows its group beside the column, over the canvas, until it's clicked
 * again, Esc is pressed or something else is clicked. The icons drag as
 * tabs do.
 *
 * While a drag is on, only the drop indicator and the dragged window
 * change, from a little store of their own, so a move of the pointer never
 * redraws the app or the panels in it.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { PANELS, type PanelId } from './panels'
import {
  closeGroup,
  closePanel,
  activate,
  find,
  floatOnScreen,
  inIcons,
  move,
  moveWindow,
  setIcons,
  raiseFloat,
  resizeFloat,
  setColumnWidth,
  setColumnHeights,
  fitColumn,
  toggleCollapsed,
  COLUMN_DEFAULT,
  type Column,
  type FloatWindow,
  type Layout,
  type PanelGroup,
  type Side,
  type Target,
} from './layout'
import { Icon } from './Icon'
import type { IconName } from './icons'
import { Listeners } from '../lib/listeners'

const TITLE = new Map(PANELS.map((p) => [p.id, p.title]))
const PANEL_ICON = new Map(PANELS.map((p) => [p.id, `panel.${p.id}` as IconName]))
const EMPTY = new Map(PANELS.map((p) => [p.id, p.empty]))

/** How far the pointer goes before a press on a tab bar is a drag. */
const DRAG_START = 5
/** How near a column's side, in screen pixels, makes a new column there. */
const EDGE = 14

type Change = (f: (l: Layout) => Layout) => void

interface Common {
  content: Partial<Record<PanelId, ReactNode>>
  /** The interface's scale: sizes are in its pixels, the pointer in the screen's. */
  scale: number
  onLayout: Change
}

// --- the drag ---------------------------------------------------------------------

interface DragSource {
  panel: PanelId
  /** The whole group, or just the panel. */
  whole: boolean
  /** The floating window it's in, when it's in one. */
  float: number | null
  /** Whether the window it's in moves with the pointer: the whole window is being dragged. */
  win: boolean
  /** Every group in the window: dragged by the window's grip. */
  wholeWindow: boolean
  /** The source's width, in the interface's pixels, for a new window. */
  width: number
  /** Where in the source the pointer took hold, in the interface's pixels. */
  dx: number
  dy: number
}

interface DragState {
  source: DragSource
  target: Target | null
  /** What the indicator outlines, in screen pixels. */
  box: { left: number; top: number; width: number; height: number; kind: Target['kind'] } | null
}

let drag: DragState | null = null
const changes = new Listeners()
const setDrag = (d: DragState | null) => {
  drag = d
  changes.emit()
}
const subscribe = (l: () => void) => {
  return changes.subscribe(l)
}

/** The panel at the front of the group shown by a `[data-group]` element. */
const groupPanel = (el: Element) => el.getAttribute('data-panel') as PanelId

/** What a drop at a screen point would do, and what to outline. */
function targetAt(x: number, y: number, src: DragSource, ctrl: boolean, scale: number): Pick<DragState, 'target' | 'box'> {
  const floatHere = (): Pick<DragState, 'target' | 'box'> => {
    const fx = x / scale - src.dx
    const fy = y / scale - src.dy
    return {
      target: { kind: 'float', x: fx, y: fy, width: src.width, height: null },
      box: !src.win ? { left: fx * scale, top: fy * scale, width: src.width * scale, height: 160 * scale, kind: 'float' } : null,
    }
  }
  if (ctrl) return floatHere()
  // The window being dragged is under the pointer: look through it.
  const inSource = (el: Element) => src.win && el.closest('[data-float-index]')?.getAttribute('data-float-index') === String(src.float)
  const main = document.querySelector('.main')?.getBoundingClientRect()
  if (!main || y < main.top || y > main.bottom) return floatHere()

  // Against a column's side: a new column there.
  for (const el of document.querySelectorAll<HTMLElement>('[data-dock-col]')) {
    const r = el.getBoundingClientRect()
    if (y < r.top || y > r.bottom) continue
    const side = el.dataset.side as Side
    const near = el.querySelector('[data-group]')
    if (!near) continue
    const at = Math.abs(x - r.left) <= EDGE ? 'before' : Math.abs(x - r.right) <= EDGE ? 'after' : null
    if (at) {
      const edge = at === 'before' ? r.left : r.right
      return { target: { kind: 'column', side, near: groupPanel(near), where: at }, box: { left: edge - 3, top: r.top, width: 6, height: r.height, kind: 'column' } }
    }
  }
  // Against the window's side where there's no dock yet.
  for (const side of ['left', 'right'] as const) {
    if (document.querySelector(`[data-dock-col][data-side="${side}"]`)) continue
    // A new left dock goes just past the toolbar, which keeps the window's left edge.
    const toolbar = document.querySelector('.main > .toolbar')?.getBoundingClientRect()
    const edge = side === 'left' ? (toolbar ? toolbar.right : main.left) : main.right
    // Anywhere over the toolbar counts as the left edge too.
    const near = side === 'left' ? x >= main.left - EDGE * 2 && x <= edge + EDGE * 2 : Math.abs(x - edge) <= EDGE * 2
    if (near) return { target: { kind: 'column', side, near: null, where: 'after' }, box: { left: side === 'left' ? edge : edge - 6, top: main.top, width: 6, height: main.height, kind: 'column' } }
  }

  for (const el of document.elementsFromPoint(x, y)) {
    if (inSource(el)) continue
    const g = el.closest('[data-group]')
    if (g) {
      const r = g.getBoundingClientRect()
      const anchor = groupPanel(g)
      // A group folded to icons: onto its tabs.
      if (g.hasAttribute('data-icon-group')) return { target: { kind: 'tab', group: anchor, index: Infinity }, box: { left: r.left, top: r.top, width: r.width, height: r.height, kind: 'tab' } }
      const head = g.querySelector('.panel-head')!.getBoundingClientRect()
      const floating = g.closest('[data-float-index]') !== null
      // In a window, the foot of a group stacks under it; the rest joins its tabs.
      const foot = floating && y >= r.bottom - Math.max(18 * scale, r.height * 0.22)
      if (foot) return { target: { kind: 'stack', near: anchor, where: 'after' }, box: { left: r.left, top: r.bottom - 2, width: r.width, height: 4, kind: 'stack' } }
      if (y <= head.bottom || floating) {
        // Before the first tab shown past the pointer, as the group orders its tabs (some may be in the » menu).
        const order = g.getAttribute('data-group')!.split(' ')
        const past = y <= head.bottom ? [...g.querySelectorAll<HTMLElement>('.panel-tabs:not(.panel-tabs-measure) [data-panel-tab]')].find((t) => { const b = t.getBoundingClientRect(); return b.left + b.width / 2 >= x }) : undefined
        const index = past ? order.indexOf(past.dataset.panelTab!) : order.length
        return { target: { kind: 'tab', group: anchor, index }, box: { left: r.left, top: r.top, width: r.width, height: r.height, kind: 'tab' } }
      }
      const where = y < r.top + r.height / 2 ? 'before' : 'after'
      return { target: { kind: 'stack', near: anchor, where }, box: { left: r.left, top: (where === 'before' ? r.top : r.bottom) - 2, width: r.width, height: 4, kind: 'stack' } }
    }
    const col = el.closest('[data-dock-col]')
    if (col) {
      // Below the last group: a new one at the foot.
      const last = [...col.querySelectorAll('[data-group]')].pop()
      if (!last) break
      const r = last.getBoundingClientRect()
      return { target: { kind: 'stack', near: groupPanel(last), where: 'after' }, box: { left: r.left, top: r.bottom - 2, width: r.width, height: 4, kind: 'stack' } }
    }
  }
  return floatHere()
}

/** A click that ends a drag isn't a click on the tab under it. */
function swallowNextClick() {
  const stop = (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
  }
  window.addEventListener('click', stop, { capture: true, once: true })
  // A drag that ends off the element fires no click: don't eat the next real one.
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0)
}

/**
 * Starts watching a press on a tab bar or a tab. Past DRAG_START it's a
 * drag: the indicator follows, and letting go makes the move. A floating
 * window being dragged by its bar moves with the pointer.
 */
function pressToDrag(
  e: ReactPointerEvent<HTMLElement>,
  src: Omit<DragSource, 'dx' | 'dy' | 'width' | 'win' | 'wholeWindow'> & { wholeWindow?: boolean; width?: number },
  scale: number,
  onLayout: Change,
) {
  if (e.button !== 0) return
  const el = e.currentTarget
  const groupEl = el.closest('[data-group]') as HTMLElement | null
  const win = src.float !== null ? (el.closest('[data-float-index]') as HTMLElement | null) : null
  const box = (win ?? groupEl)?.getBoundingClientRect()
  if (!box) return
  const x0 = e.clientX
  const y0 = e.clientY
  const wholeWindow = !!src.wholeWindow
  // A whole window dragged moves: by its grip, or by the bar of the one group in it. A tab or a group dragged out of one leaves it where it is.
  const alone = !!win && win.querySelectorAll('[data-group]').length === 1
  const moves = !!win && (wholeWindow || (alone && (src.whole || groupEl?.querySelectorAll('[data-panel-tab]').length === 1)))
  const width = src.width ?? (moves || !groupEl ? box.width : groupEl.getBoundingClientRect().width) / scale
  const from = moves || !groupEl ? box : groupEl.getBoundingClientRect()
  const source: DragSource = { ...src, wholeWindow, win: moves, width, dx: Math.min((x0 - from.left) / scale, width - 20), dy: (y0 - from.top) / scale }
  const winStart = win ? { left: parseFloat(win.style.left) || 0, top: parseFloat(win.style.top) || 0 } : null
  let started = false
  const id = e.pointerId
  el.setPointerCapture(id)
  const moveWin = (ev: PointerEvent) => {
    if (!win || !winStart) return
    win.style.left = `${winStart.left + (ev.clientX - x0) / scale}px`
    win.style.top = `${winStart.top + (ev.clientY - y0) / scale}px`
  }
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return
    if (!started) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START) return
      started = true
      document.documentElement.dataset.panelDrag = ''
    }
    if (moves) moveWin(ev)
    setDrag({ source, ...targetAt(ev.clientX, ev.clientY, source, ev.ctrlKey || ev.metaKey, scale) })
  }
  const end = (ev: PointerEvent, cancelled: boolean) => {
    if (ev.pointerId !== id) return
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', onUp)
    el.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
    delete document.documentElement.dataset.panelDrag
    const t = drag?.target ?? null
    setDrag(null)
    if (!started) return
    swallowNextClick()
    if (cancelled || !t) {
      if (win && winStart) {
        win.style.left = `${winStart.left}px`
        win.style.top = `${winStart.top}px`
      }
      return
    }
    onLayout((l) => (wholeWindow && src.float !== null ? moveWindow(l, src.float, t) : move(l, src.panel, t, src.whole)))
  }
  const onUp = (ev: PointerEvent) => end(ev, false)
  const onCancel = (ev: PointerEvent) => end(ev, true)
  // Esc puts it back.
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || !started) return
    ev.preventDefault()
    ev.stopPropagation()
    el.releasePointerCapture(id)
    end(new PointerEvent('pointercancel', { pointerId: id }), true)
  }
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointercancel', onCancel)
  window.addEventListener('keydown', onKey, true)
}

/** Where a drop would go, outlined over everything while a panel is dragged. */
export function DropIndicator() {
  const d = useSyncExternalStore(subscribe, () => drag)
  if (!d?.box) return null
  const b = d.box
  return <div className={`dock-drop dock-drop-${b.kind}`} data-drop={b.kind} style={{ left: b.left, top: b.top, width: b.width, height: b.height }} aria-hidden />
}

// --- a group ---------------------------------------------------------------------------

interface GroupProps extends Common {
  group: PanelGroup
  /** The floating window it's in, or null when docked. */
  float: number | null
  /** Docked groups share their column's height; a window sets its own. */
  resizable: boolean
  /** How it takes its share of the column (docked only). */
  flex?: string
  /** Where it is, for the divider under it: none for the last group open in its column. */
  divider?: { side: Side; col: number } | null
  onMenu(panel: PanelId, at: DOMRect): void
  /** What folding does, when not the group's own folding: a group shown from icons goes back to them. */
  onFold?(): void
}

function Group({ group: g, float, resizable, flex, divider, content, scale, onLayout, onMenu, onFold }: GroupProps) {
  const fold = (p: PanelId) => (onFold ? onFold() : onLayout((l) => toggleCollapsed(l, p)))
  const active = g.active
  const title = TITLE.get(active) ?? active
  const body = content[active]
  const section = useRef<HTMLElement>(null)
  const single = g.panels.length === 1
  const tabs = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLDivElement>(null)
  const over = useOverflow(tabs, measure, g.panels, active)
  const [more, setMore] = useState<DOMRect | null>(null)
  return (
    <section
      ref={section}
      className={`panel${g.collapsed ? ' collapsed' : ''}${g.height !== null && !g.collapsed && resizable ? ' sized' : ''}`}
      data-panel={active}
      data-group={g.panels.join(' ')}
      aria-label={title}
      style={resizable && flex ? { flex } : undefined}
    >
      <header
        className="panel-head"
        onPointerDown={(e) => {
          if ((e.target as Element).closest('button')) return
          pressToDrag(e, { panel: active, whole: true, float }, scale, onLayout)
        }}
      >
        <button type="button" className="panel-fold" aria-expanded={!g.collapsed} aria-label={g.collapsed ? `Unfold ${title}` : `Fold ${title}`} onClick={() => fold(active)}>
          <span className="panel-fold-arrow">
            <Icon name="ui.fold" />
          </span>
        </button>
        <div ref={tabs} className={`panel-tabs${single ? ' single' : ''}`} role="tablist" aria-label={`${title} group`}>
          {g.panels.filter((p) => !over.includes(p)).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              className="panel-tab"
              data-panel-tab={p}
              aria-selected={p === active}
              data-tip={`${EMPTY.get(p)}${single ? ' Drag to move the panel; click to fold it.' : ''}`}
              onPointerDown={(e) => pressToDrag(e, { panel: p, whole: single, float }, scale, onLayout)}
              // The front tab folds the group, as the title did; another comes to the front.
              onClick={() => (p === active ? fold(p) : onLayout((l) => activate(l, p)))}
            >
              {TITLE.get(p) ?? p}
            </button>
          ))}
        </div>
        {!single && (
          // The tabs at their natural widths, unseen, to work out which fit.
          <div ref={measure} className="panel-tabs panel-tabs-measure" aria-hidden>
            {g.panels.map((p) => (
              <span key={p} className="panel-tab">
                {TITLE.get(p) ?? p}
              </span>
            ))}
          </div>
        )}
        {over.length > 0 && (
          <button type="button" className="panel-menu-button panel-tabs-more" aria-label={`${over.length} more ${over.length === 1 ? 'tab' : 'tabs'}`} aria-haspopup="menu" data-tip={over.map((p) => TITLE.get(p)).join(', ')} data-tabs-more="" onClick={(e) => setMore(e.currentTarget.getBoundingClientRect())}>
            »
          </button>
        )}
        {more && <TabsMenu panels={over} at={more} scale={scale} onPick={(p) => onLayout((l) => activate(l, p))} onClose={() => setMore(null)} />}
        <button type="button" className="panel-menu-button" aria-label={`${title} panel menu`} aria-haspopup="menu" onClick={(e) => onMenu(active, e.currentTarget.getBoundingClientRect())}>
          <Icon name="ui.more" />
        </button>
        <button type="button" className="panel-close" data-tip={`Close ${title}`} aria-label={`Close ${title}`} onClick={() => onLayout((l) => closePanel(l, active))}>
          <Icon name="ui.close" />
        </button>
      </header>
      <div className={`panel-body${body ? ' live' : ''}`} data-panel-body={active} role="tabpanel">
        {body ?? <p className="panel-empty">No document open</p>}
      </div>
      {resizable && !g.collapsed && divider && <GroupSizer side={divider.side} col={divider.col} section={section} scale={scale} onLayout={onLayout} />}
    </section>
  )
}

/** A group's tab bar is only so wide: the tabs that don't fit it, the front one always kept. */
function useOverflow(tabs: RefObject<HTMLDivElement | null>, measure: RefObject<HTMLDivElement | null>, panels: PanelId[], active: PanelId): PanelId[] {
  const [over, setOver] = useState<PanelId[]>([])
  const key = panels.join(' ')
  useLayoutEffect(() => {
    const bar = tabs.current
    const m = measure.current
    if (!bar || !m || panels.length < 2) {
      setOver((o) => (o.length ? [] : o))
      return
    }
    const fit = () => {
      // The room the bar has: its own, plus the » button's when that's showing.
      const head = bar.parentElement!
      const moreW = 26
      const shownMore = head.querySelector('.panel-tabs-more')
      const room = bar.clientWidth + (shownMore ? moreW + 4 : 0)
      const widths = [...m.children].map((c) => (c as HTMLElement).offsetWidth + 1)
      const all = widths.reduce((a, b) => a + b, 0)
      let next: PanelId[] = []
      if (all > room) {
        const left = room - moreW - 4
        const keep = new Set<PanelId>()
        let used = widths[panels.indexOf(active)]
        keep.add(active)
        panels.forEach((p, i) => {
          if (p === active || used + widths[i] > left) return
          used += widths[i]
          keep.add(p)
        })
        next = panels.filter((p) => !keep.has(p))
      }
      setOver((o) => (o.join() === next.join() ? o : next))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(bar.parentElement!)
    return () => ro.disconnect()
  }, [key, active])
  return over
}

/** The tabs that didn't fit, as a menu under the » button. */
function TabsMenu({ panels, at, scale, onPick, onClose }: { panels: PanelId[]; at: DOMRect; scale: number; onPick(p: PanelId): void; onClose(): void }) {
  const list = useRef<HTMLUListElement>(null)
  useLayoutEffect(() => list.current?.querySelector<HTMLButtonElement>('.menu-button')?.focus(), [])
  useEffect(() => {
    const outside = (e: PointerEvent) => !list.current?.contains(e.target as Node) && onClose()
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [onClose])
  const left = Math.max(4, Math.min(at.right - 180 * scale, innerWidth - 184 * scale)) / scale
  return (
    <ul
      ref={list}
      className="menu context-menu"
      role="menu"
      aria-label="More tabs"
      data-tabs-menu=""
      style={{ left, top: at.bottom / scale }}
      onKeyDown={(e) => {
        const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('.menu-button') ?? [])]
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
        e.stopPropagation()
      }}
    >
      {panels.map((p) => (
        <li key={p} className="menu-item">
          <button
            type="button"
            className="menu-button"
            role="menuitem"
            data-tab-pick={p}
            onClick={() => {
              onClose()
              onPick(p)
            }}
          >
            <span className="menu-check" />
            <span>{TITLE.get(p) ?? p}</span>
            <span className="menu-shortcut" />
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The least a group open in a column keeps: its tab bar and a strip of what's in it, in the interface's pixels. */
const GROUP_FLOOR = 72

/**
 * The divider under a docked group: drag to trade height with the next
 * group open below it (each keeping at least a strip), which from then on
 * gives every group in the column its share; double-click to fit them all
 * to what's in them again.
 */
function GroupSizer({ side, col, section, scale, onLayout }: { side: Side; col: number; section: RefObject<HTMLElement | null>; scale: number; onLayout: Change }) {
  const start = useRef<{ y: number; heights: (number | null)[]; a: number; b: number } | null>(null)
  return (
    <div
      className="panel-sizer"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the panels"
      onPointerDown={(e) => {
        const me = section.current
        const column = me?.closest('[data-dock-col]')
        if (!me || !column) return
        // Every group's height as drawn now, the folded ones left as they are.
        const groups = [...column.querySelectorAll<HTMLElement>(':scope > [data-group]')]
        const a = groups.indexOf(me)
        const b = groups.findIndex((g, i) => i > a && !g.classList.contains('collapsed'))
        if (a < 0 || b < 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { y: e.clientY, heights: groups.map((g) => (g.classList.contains('collapsed') ? null : g.getBoundingClientRect().height / scale)), a, b }
      }}
      onPointerMove={(e) => {
        const s = start.current
        if (!s) return
        // Worked out now: React runs the update later, by which time the drag may have ended.
        const ha = s.heights[s.a]!
        const hb = s.heights[s.b]!
        const na = Math.min(ha + hb - GROUP_FLOOR, Math.max(GROUP_FLOOR, ha + (e.clientY - s.y) / scale))
        const heights = s.heights.map((h, i) => (i === s.a ? na : i === s.b ? ha + hb - na : h))
        onLayout((l) => setColumnHeights(l, side, col, heights.map((h, i) => (h === null ? l[side][col]?.groups[i]?.height ?? null : h))))
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
      onDoubleClick={() => onLayout((l) => fitColumn(l, side, col))}
    />
  )
}

// --- the panel menu -------------------------------------------------------------------

interface MenuAt {
  panel: PanelId
  at: DOMRect
}

/** What the ⋯ menu offers for a group: the moves a drag makes, and closing. */
function PanelMenu({ menu, layout, scale, onLayout, onClose }: { menu: MenuAt; layout: Layout; scale: number; onLayout: Change; onClose(): void }) {
  const list = useRef<HTMLUListElement>(null)
  const p = menu.panel
  const title = TITLE.get(p) ?? p
  const place = find(layout, p)
  const where = place?.where === 'dock' ? place.side : ('float' as const)
  const group = place?.group
  const column = place?.where === 'dock' ? layout[place.side][place.col] : null
  const toDock = (side: Side): Target => {
    // At the foot of the column by the canvas, or a dock of its own when that side has none.
    const col = side === 'right' ? layout.right[0] : layout.left[layout.left.length - 1]
    const last = col?.groups[col.groups.length - 1]
    return last && !last.panels.includes(p) ? { kind: 'stack', near: last.active, where: 'after' } : { kind: 'column', side, near: null, where: 'after' }
  }
  const items: { id: string; label: string; run(): void }[] = [
    ...(where !== 'float'
      ? [
          {
            id: 'float',
            label: 'Float in a Window',
            run: () => onLayout((l) => move(l, p, { kind: 'float', x: menu.at.left / scale - 240, y: menu.at.top / scale + 24, width: COLUMN_DEFAULT, height: null }, true)),
          },
        ]
      : []),
    ...(where !== 'left' ? [{ id: 'dock-left', label: 'Dock on the Left', run: () => onLayout((l) => move(l, p, toDock('left'), true)) }] : []),
    ...(where !== 'right' ? [{ id: 'dock-right', label: 'Dock on the Right', run: () => onLayout((l) => move(l, p, toDock('right'), true)) }] : []),
    ...(column
      ? [
          column.icons
            ? { id: 'expand', label: 'Expand Panels', run: () => onLayout((l) => setIcons(l, p, false)) }
            : { id: 'icons', label: 'Collapse to Icons', run: () => onLayout((l) => setIcons(l, p, true)) },
        ]
      : []),
    { id: 'close', label: `Close ${title}`, run: () => onLayout((l) => closePanel(l, p)) },
    ...(group && group.panels.length > 1 ? [{ id: 'close-group', label: 'Close Tab Group', run: () => onLayout((l) => closeGroup(l, p)) }] : []),
  ]
  useLayoutEffect(() => list.current?.querySelector<HTMLButtonElement>('.menu-button')?.focus(), [])
  useEffect(() => {
    const outside = (e: PointerEvent) => !list.current?.contains(e.target as Node) && onClose()
    document.addEventListener('pointerdown', outside, true)
    addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      removeEventListener('blur', onClose)
    }
  }, [onClose])
  const left = Math.max(4, Math.min(menu.at.right - 210 * scale, innerWidth - 214 * scale)) / scale
  return (
    <ul
      ref={list}
      className="menu context-menu"
      role="menu"
      aria-label={`${title} panel`}
      data-panel-menu={p}
      style={{ left, top: menu.at.bottom / scale }}
      onKeyDown={(e) => {
        const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('.menu-button') ?? [])]
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
        e.stopPropagation()
      }}
    >
      {items.map((it) => (
        <li key={it.id} className="menu-item">
          <button
            type="button"
            className="menu-button"
            role="menuitem"
            data-panel-action={it.id}
            onClick={() => {
              onClose()
              it.run()
            }}
          >
            <span className="menu-check" />
            <span>{it.label}</span>
            <span className="menu-shortcut" />
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The panel menu's state, for a dock or the floating layer. */
function usePanelMenu() {
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const close = useRef(() => setMenu(null)).current
  return { menu, open: (panel: PanelId, at: DOMRect) => setMenu({ panel, at }), close }
}

// --- a dock --------------------------------------------------------------------------

interface DockProps extends Common {
  side: Side
  layout: Layout
}

// --- panels folded to icons ---------------------------------------------------------

/** The panel shown beside its column of icons, if one is: view state, not the layout's. */
let flyout: PanelId | null = null
const flyoutChanges = new Listeners()
/** The panel shown from icons now. */
export const iconPanel = () => flyout
/** Shows a panel folded to icons beside its column, or with null puts it back. */
export function showIconPanel(id: PanelId | null) {
  if (flyout === id) return
  flyout = id
  flyoutChanges.emit()
}
const subscribeFlyout = (l: () => void) => {
  return flyoutChanges.subscribe(l)
}

/** One side's dock: its columns, each with the splitter on its canvas side (a column of icons has none). */
export function Dock({ side, layout, content, scale, onLayout }: DockProps) {
  const cols = layout[side]
  const menu = usePanelMenu()
  const shown = useSyncExternalStore(subscribeFlyout, () => flyout)
  // A panel shown from icons that's since been dragged out of them (or closed) isn't shown from them any more.
  useEffect(() => {
    if (shown && !inIcons(layout, shown)) showIconPanel(null)
  }, [shown, layout])
  if (!cols.length) return null
  const place = shown ? find(layout, shown) : null
  const flyGroup = place?.where === 'dock' && place.side === side && cols[place.col].icons ? place : null
  return (
    <div className={`dock-side dock-side-${side}`} data-dock-side={side}>
      {cols.map((c, i) => {
        const col = c.icons ? (
          <IconColumn key={`c${i}`} side={side} index={i} column={c} shown={flyGroup && flyGroup.col === i ? shown : null} scale={scale} onLayout={onLayout} />
        ) : (
          <DockColumn key={`c${i}`} side={side} index={i} column={c} content={content} scale={scale} onLayout={onLayout} onMenu={menu.open} />
        )
        const splitter = c.icons ? <div key={`s${i}`} className="dock-gap" /> : <ColumnSplitter key={`s${i}`} side={side} width={c.width} scale={scale} onWidth={(w) => onLayout((l) => setColumnWidth(l, side, i, w))} />
        return side === 'right' ? [splitter, col] : [col, splitter]
      })}
      {flyGroup && shown && <Flyout panel={shown} side={side} col={flyGroup.col} group={flyGroup.group} width={cols[flyGroup.col].width} content={content} scale={scale} onLayout={onLayout} onMenu={menu.open} />}
      {menu.menu && <PanelMenu menu={menu.menu} layout={layout} scale={scale} onLayout={onLayout} onClose={menu.close} />}
    </div>
  )
}

/** The strip along a column's top, whose button folds it to icons or opens it out. */
function ColumnHead({ side, icons, anchor, onLayout }: { side: Side; icons: boolean; anchor: PanelId; onLayout: Change }) {
  // The arrows point the way the column will go: out towards the canvas, or in towards the edge.
  const out = side === 'right' ? 'ui.expand-left' : 'ui.expand-right'
  const inward = side === 'right' ? 'ui.expand-right' : 'ui.expand-left'
  const label = icons ? 'Expand Panels' : 'Collapse to Icons'
  return (
    <div className="dock-col-head" onDoubleClick={(e) => e.target === e.currentTarget && onLayout((l) => setIcons(l, anchor, !icons))}>
      <button type="button" className="dock-col-fold" data-col-fold={icons ? 'expand' : 'icons'} aria-label={label} data-tip={label} onClick={() => onLayout((l) => setIcons(l, anchor, !icons))}>
        <Icon name={icons ? out : inward} />
      </button>
    </div>
  )
}

function DockColumn({ side, index, column, content, scale, onLayout, onMenu }: Common & { side: Side; index: number; column: Column; onMenu(p: PanelId, at: DOMRect): void }) {
  const open = column.groups.map((g, i) => (g.collapsed ? -1 : i)).filter((i) => i >= 0)
  const lastOpen = open[open.length - 1] ?? -1
  const shared = column.groups.some((g) => !g.collapsed && g.height !== null)
  const ref = useRef<HTMLElement>(null)
  const level = useLevel(ref, !shared)
  // A group with a share grows from nothing by it; one without takes what's in it, shrinking in proportion when the column's short; the last of those takes the room left.
  const flexOf = (g: PanelGroup, i: number) => (g.collapsed ? 'none' : g.height !== null ? `${g.height} 1 0px` : !shared && i === lastOpen ? '1 1 auto' : '0 1 auto')
  return (
    <aside
      ref={ref}
      className="dock"
      aria-label={`Panels, ${side}${index ? ` ${index + 1}` : ''}`}
      data-dock-col={index}
      data-side={side}
      data-level={level ?? undefined}
      style={{ width: column.width, ...(level !== null ? ({ '--level': `${level}px` } as CSSProperties) : {}) }}
    >
      <ColumnHead side={side} icons={false} anchor={column.groups[0].active} onLayout={onLayout} />
      {column.groups.map((g, i) => (
        <Group key={g.panels[0]} group={g} float={null} resizable flex={flexOf(g, i)} divider={i !== lastOpen ? { side, col: index } : null} content={content} scale={scale} onLayout={onLayout} onMenu={onMenu} />
      ))}
    </aside>
  )
}

/**
 * The one height a column's open groups are held to so they all fit, the
 * tallest giving up room first ("water-filling"); null while they fit as
 * they are, or when the column's groups have shares of their own. Worked out
 * again as the column or what's in its groups changes size.
 */
function useLevel(col: RefObject<HTMLElement | null>, on: boolean): number | null {
  const [level, setLevel] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = col.current
    if (!el || !on) {
      setLevel(null)
      return
    }
    const work = () => {
      const groups = [...el.querySelectorAll<HTMLElement>(':scope > [data-group]')]
      const top = el.querySelector<HTMLElement>(':scope > .dock-col-head')?.offsetHeight ?? 0
      let room = el.clientHeight - top - Math.max(0, groups.length - 1)
      const wants: number[] = []
      for (const g of groups) {
        const head = g.querySelector<HTMLElement>(':scope > .panel-head')?.offsetHeight ?? 0
        if (g.classList.contains('collapsed')) {
          room -= g.offsetHeight
          continue
        }
        const body = g.querySelector<HTMLElement>(':scope > .panel-body')
        wants.push(Math.max(GROUP_FLOOR, head + (body?.scrollHeight ?? 0)))
      }
      const total = wants.reduce((a, b) => a + b, 0)
      if (!wants.length || total <= room) return setLevel((l) => (l === null ? l : null))
      // The smallest keep what they want; the rest share what's left equally.
      const sorted = [...wants].sort((a, b) => a - b)
      let left = room
      let next = GROUP_FLOOR
      for (let i = 0; i < sorted.length; i++) {
        const each = left / (sorted.length - i)
        if (sorted[i] > each) {
          next = Math.max(GROUP_FLOOR, Math.floor(each))
          break
        }
        left -= sorted[i]
      }
      setLevel((l) => (l === next ? l : next))
    }
    work()
    // The column's size, and the size of what's in each group, both change it.
    const ro = new ResizeObserver(work)
    const watch = () => {
      ro.disconnect()
      ro.observe(el)
      for (const b of el.querySelectorAll(':scope > [data-group] > .panel-body > *')) ro.observe(b)
    }
    watch()
    const mo = new MutationObserver(() => {
      watch()
      work()
    })
    mo.observe(el, { childList: true, subtree: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [col, on])
  return level
}

/** A column folded to icons: a button a panel, grouped as its tabs are. */
function IconColumn({ side, index, column, shown, scale, onLayout }: { side: Side; index: number; column: Column; shown: PanelId | null; scale: number; onLayout: Change }) {
  const tipSide = side === 'right' ? 'left' : 'right'
  return (
    <aside className="dock dock-icons" aria-label={`Panels as icons, ${side}${index ? ` ${index + 1}` : ''}`} data-dock-col={index} data-side={side} data-icons="">
      <ColumnHead side={side} icons anchor={column.groups[0].active} onLayout={onLayout} />
      {column.groups.map((g) => (
        <div key={g.panels[0]} className="icon-group" role="group" data-group={g.panels.join(' ')} data-panel={g.active} data-icon-group="">
          {g.panels.map((p) => (
            <button
              key={p}
              type="button"
              className="panel-icon"
              data-panel-icon={p}
              aria-pressed={shown === p}
              aria-label={TITLE.get(p) ?? p}
              data-tip={TITLE.get(p) ?? p}
              data-tip-side={tipSide}
              onPointerDown={(e) => pressToDrag(e, { panel: p, whole: g.panels.length === 1, float: null, width: column.width }, scale, onLayout)}
              onClick={() => {
                if (shown === p) return showIconPanel(null)
                onLayout((l) => activate(l, p))
                showIconPanel(p)
              }}
            >
              <Icon name={PANEL_ICON.get(p)!} />
            </button>
          ))}
        </div>
      ))}
    </aside>
  )
}

/** A group folded to icons, shown beside its column over the canvas, until something else is clicked. */
function Flyout({ panel, side, col, group: g, width, content, scale, onLayout, onMenu }: Common & { panel: PanelId; side: Side; col: number; group: PanelGroup; width: number; onMenu(p: PanelId, at: DOMRect): void }) {
  const box = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  useLayoutEffect(() => {
    const colEl = document.querySelector(`[data-dock-col="${col}"][data-side="${side}"]`)
    const icon = colEl?.querySelector(`[data-panel-icon="${panel}"]`)
    if (!colEl || !icon) return
    const c = colEl.getBoundingClientRect()
    const r = icon.getBoundingClientRect()
    const viewH = innerHeight / scale
    const top = Math.max(0, Math.min(r.top / scale - 4, viewH - 160))
    setAt({ left: side === 'right' ? c.left / scale - width - 2 : c.right / scale + 2, top, maxHeight: viewH - top - 8 })
  }, [panel, side, col, width, scale])
  useEffect(() => {
    // Anything clicked but the panel, its icons or a menu it opened puts it back; so does Esc.
    const outside = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (!t || box.current?.contains(t) || t.closest?.('[data-icon-group], [data-panel-menu], .tooltip')) return
      showIconPanel(null)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.documentElement.hasAttribute('data-panel-drag')) return
      showIconPanel(null)
    }
    document.addEventListener('pointerdown', outside, true)
    addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      removeEventListener('keydown', key)
    }
  }, [])
  return (
    <div ref={box} className="dock-flyout" data-flyout={panel} style={at ? { left: at.left, top: at.top, width, maxHeight: at.maxHeight } : { visibility: 'hidden', width }}>
      <Group group={{ ...g, collapsed: false, height: null }} float={null} resizable={false} content={content} scale={scale} onLayout={onLayout} onMenu={onMenu} onFold={() => showIconPanel(null)} />
    </div>
  )
}

interface SplitterProps {
  side: Side
  width: number
  /** The interface's scale: the column's width is in its pixels, the pointer in the screen's. */
  scale?: number
  onWidth(w: number): void
}

/**
 * Drag to resize a column. The width is set as the pointer moves and saved
 * by the workspace when the drag ends. Double-click goes back to the
 * default.
 */
function ColumnSplitter({ side, width, scale = 1, onWidth }: SplitterProps) {
  const start = useRef<{ x: number; w: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  return (
    <div
      className={`dock-splitter${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panels"
      aria-valuenow={width}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, w: width }
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        // The splitter is on the canvas's side of the column: towards the canvas widens it.
        const dx = (e.clientX - start.current.x) / scale
        onWidth(start.current.w + (side === 'right' ? -dx : dx))
      }}
      onPointerUp={() => {
        start.current = null
        setDragging(false)
      }}
      onPointerCancel={() => {
        start.current = null
        setDragging(false)
      }}
      onDoubleClick={() => onWidth(COLUMN_DEFAULT)}
    />
  )
}

// --- floating windows ------------------------------------------------------------------

/** The window's size in the interface's pixels, kept current, for keeping windows on screen. */
function useViewSize(scale: number) {
  const [size, setSize] = useState(() => ({ w: innerWidth / scale, h: innerHeight / scale }))
  useEffect(() => {
    const on = () => setSize({ w: innerWidth / scale, h: innerHeight / scale })
    on()
    addEventListener('resize', on)
    return () => removeEventListener('resize', on)
  }, [scale])
  return size
}

/** The floating windows, back to front, over the canvas. */
export function FloatingPanels({ layout, content, scale, onLayout }: Common & { layout: Layout }) {
  const view = useViewSize(scale)
  const menu = usePanelMenu()
  return (
    <>
      {layout.floats.map((f, i) => (
        <FloatingWindow key={f.groups[0].panels[0]} index={i} win={f} top={i === layout.floats.length - 1} view={view} content={content} scale={scale} onLayout={onLayout} onMenu={menu.open} />
      ))}
      {menu.menu && <PanelMenu menu={menu.menu} layout={layout} scale={scale} onLayout={onLayout} onClose={menu.close} />}
    </>
  )
}

function FloatingWindow({ index, win, top, view, content, scale, onLayout, onMenu }: Common & { index: number; win: FloatWindow; top: boolean; view: { w: number; h: number }; onMenu(p: PanelId, at: DOMRect): void }) {
  const at = floatOnScreen(win, view.w, view.h)
  const el = useRef<HTMLDivElement>(null)
  const sizing = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const folded = win.groups.every((g) => g.collapsed)
  const stacked = win.groups.length > 1
  return (
    <div
      ref={el}
      className={`float-panel${stacked ? ' stacked' : ''}`}
      data-float-index={index}
      role="dialog"
      aria-label={`${win.groups.map((g) => TITLE.get(g.active)).join(', ')} (floating)`}
      // Never past the foot of the window: what doesn't fit scrolls.
      style={{ left: at.x, top: at.y, width: win.width, height: win.height !== null && !folded ? win.height : undefined, maxHeight: Math.max(120, view.h - at.y - 8) }}
      onPointerDownCapture={() => !top && onLayout((l) => raiseFloat(l, index))}
    >
      {stacked && (
        <div
          className="float-grip"
          data-float-grip=""
          aria-hidden
          data-tip="Drag to move the window"
          onPointerDown={(e) => pressToDrag(e, { panel: win.groups[0].active, whole: true, float: index, wholeWindow: true }, scale, onLayout)}
        />
      )}
      {win.groups.map((g) => (
        <Group key={g.panels[0]} group={g} float={index} resizable={false} content={content} scale={scale} onLayout={onLayout} onMenu={onMenu} />
      ))}
      {!folded && (
        <div
          className="float-sizer"
          role="separator"
          aria-label="Resize the window"
          onPointerDown={(e) => {
            e.stopPropagation()
            e.currentTarget.setPointerCapture(e.pointerId)
            const r = el.current!.getBoundingClientRect()
            sizing.current = { x: e.clientX, y: e.clientY, w: r.width / scale, h: r.height / scale }
          }}
          onPointerMove={(e) => {
            const s = sizing.current
            if (!s) return
            onLayout((l) => resizeFloat(l, index, s.w + (e.clientX - s.x) / scale, s.h + (e.clientY - s.y) / scale))
          }}
          onPointerUp={() => (sizing.current = null)}
          onPointerCancel={() => (sizing.current = null)}
          // Back to the height of what's in it.
          onDoubleClick={() => onLayout((l) => resizeFloat(l, index, win.width, null))}
        />
      )}
    </div>
  )
}
