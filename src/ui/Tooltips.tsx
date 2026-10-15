/**
 * The interface's tooltips, one layer for the whole app.
 *
 * Anything can ask for one with an attribute, so no component has to own
 * a tooltip of its own:
 *
 * - `data-tip`: a line of text; `data-tip-keys` adds its shortcut as chips.
 * - `data-tip-tool`: a tool's card: its name and key, what it does, and
 *   every key and gesture it answers to (TOOL_DEFS).
 * - `data-why`: why a disabled control is disabled. It shows only while the
 *   control is disabled; the attribute is set only then.
 * - `data-tip-side="right"` puts it beside the control (the toolbar, the
 *   menus) rather than below.
 *
 * A tooltip waits half a second, and while one is showing the next shows at
 * once, as desktop tooltips do. Any press, key or scroll puts it away, and
 * the control stays quiet until the pointer leaves it; touch never shows one. With Edit → Interface's rich tooltips off, tools
 * give their name and key alone, and disabled controls say nothing.
 *
 * Disabled buttons still get pointer events in Chrome and Firefox, which
 * is what lets a disabled menu item say why.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { TOOL_BY_ID, toolsInGroup, type ToolId } from '../tools'
import { formatShortcut, parseShortcut } from '../input/shortcuts'
import { toolKeys } from '../commands'
import { interfacePrefs } from './interface'
import { KeyList } from './Keys'

const SELECTOR = '[data-tip],[data-tip-tool],[data-why]'
const DELAY = 500
/** How long after one tooltip goes the next still shows at once. */
const WARM = 400

interface Tip {
  el: HTMLElement
  rect: DOMRect
}

export function Tooltips() {
  const prefs = useSyncExternalStore(interfacePrefs().subscribe, interfacePrefs().get)
  const [tip, setTip] = useState<Tip | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    let timer = 0
    let current: HTMLElement | null = null
    let shown = false
    let warmUntil = 0
    const show = (el: HTMLElement) => {
      shown = true
      setTip({ el, rect: el.getBoundingClientRect() })
    }
    const hide = () => {
      clearTimeout(timer)
      if (shown) warmUntil = performance.now() + WARM
      shown = false
      setTip(null)
    }
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>(SELECTOR) : null
      if (el === current) return
      current = el
      clearTimeout(timer)
      const warm = shown || performance.now() < warmUntil
      hide()
      if (!el) return
      if (warm) show(el)
      else timer = window.setTimeout(() => show(el), DELAY)
    }
    // Put away on purpose: no quick follow-on, and nothing more from this control
    // until the pointer leaves it (a click re-renders its icon, which Chrome
    // answers with a fresh pointerover).
    const away = (e: Event) => {
      current = e.target instanceof Element ? e.target.closest<HTMLElement>(SELECTOR) : null
      clearTimeout(timer)
      shown = false
      warmUntil = 0
      setTip(null)
    }
    // A key or a scroll puts it away too, and the control under the pointer stays quiet until it's left.
    const quiet = () => {
      clearTimeout(timer)
      shown = false
      warmUntil = 0
      setTip(null)
    }
    const blur = () => {
      current = null
      hide()
    }
    document.addEventListener('pointerover', over, true)
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', quiet, true)
    document.addEventListener('scroll', quiet, true)
    addEventListener('blur', blur)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerover', over, true)
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', quiet, true)
      document.removeEventListener('scroll', quiet, true)
      removeEventListener('blur', blur)
    }
  }, [])

  // Beside or below its control, kept on screen. The layer is zoomed with
  // the interface, so screen positions are divided by the scale.
  useLayoutEffect(() => {
    if (!tip || !box.current) {
      setAt(null)
      return
    }
    const s = prefs.scale
    const w = box.current.offsetWidth * s
    const h = box.current.offsetHeight * s
    const side = tip.el.dataset.tipSide === 'right'
    let left = side ? tip.rect.right + 8 : tip.rect.left
    let top = side ? tip.rect.top : tip.rect.bottom + 6
    if (left + w > innerWidth - 4) left = side ? tip.rect.left - w - 8 : innerWidth - 4 - w
    if (top + h > innerHeight - 4) top = side ? innerHeight - 4 - h : tip.rect.top - h - 6
    setAt({ left: Math.max(4, left) / s, top: Math.max(4, top) / s })
  }, [tip, prefs.scale])

  if (!tip || !tip.el.isConnected) return null
  const content = tipContent(tip.el, prefs.richTips)
  if (!content) return null
  return (
    <div className="tooltip" role="tooltip" data-tooltip ref={box} style={at ? { left: at.left, top: at.top } : { visibility: 'hidden', left: 0, top: 0 }}>
      {content}
    </div>
  )
}

function tipContent(el: HTMLElement, rich: boolean) {
  const toolId = el.dataset.tipTool as ToolId | undefined
  const tool = toolId ? TOOL_BY_ID.get(toolId) : undefined
  const disabled = el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true'
  const why = rich && disabled ? el.dataset.why : undefined
  if (tool) {
    const { pick, next } = toolKeys(tool)
    const fmt = (k: string) => formatShortcut(parseShortcut(k)!)
    const keys = pick ? (next ? `${fmt(pick)}, ${fmt(next)} for the next` : fmt(pick)) : null
    return (
      <div className="tip-tool">
        <div className="tip-title">
          <strong>{tool.name}</strong>
          {keys && <kbd>{keys}</kbd>}
        </div>
        {rich && <p>{tool.hint}</p>}
        {rich && tool.keys.length > 0 && <KeyList keys={tool.keys} />}
        {rich && tool.group && el.hasAttribute('data-tool-slot') && (
          <p className="tip-group">
            Also here: {toolsInGroup(tool.group).filter((t) => t.id !== tool.id).map((t) => t.name).join(', ')}. Right-click or hold for them.
          </p>
        )}
      </div>
    )
  }
  const text = el.dataset.tip
  const shortcut = el.dataset.tipKeys ? parseShortcut(el.dataset.tipKeys) : null
  if (!text && !why) return null
  return (
    <>
      {text && (
        <div className="tip-title">
          <span>{text}</span>
          {shortcut && <kbd>{formatShortcut(shortcut)}</kbd>}
        </div>
      )}
      {why && (
        <div className="tip-why" data-tip-why>
          {why}
        </div>
      )}
    </>
  )
}
