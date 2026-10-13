/**
 * The page is an editor, not a web page: the browser's own responses to the
 * keyboard and mouse (find, print, reload, page zoom, back and forward,
 * scrolling, its context menu, autoscroll, dragging images and links, a link
 * dropped on the page opening it) are kept from it, everywhere. The app's
 * handlers still see every event; this only cancels what the browser would
 * do with it afterwards.
 *
 * What's left to the browser is what the page's own controls do: a text
 * field types, edits, moves its caret and uses the clipboard; a dropdown, a
 * slider or a checkbox takes its keys; Tab moves the focus, and Enter or Space
 * presses the focused button. The developer tools keep their keys, and Ctrl+C,
 * Ctrl+X and Ctrl+V keep theirs everywhere, so clipboard events still fire.
 *
 * Some keys never reach a page: Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab and the
 * like close or open tabs and windows before the page hears of them. In full
 * screen, Chromium's Keyboard Lock hands those to the page too (Esc then
 * leaves full screen by being held), so they're locked whenever the app goes
 * full screen. Elsewhere they stay the browser's.
 */

import { isMac } from './shortcuts'

/** Input types that take typing. A slider or a checkbox doesn't, so it doesn't keep the keys from the app. */
const TEXT_INPUTS = new Set(['text', 'search', 'number', 'email', 'url', 'password', 'tel'])

export const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || t.tagName === 'TEXTAREA' || (t instanceof HTMLInputElement && TEXT_INPUTS.has(t.type)))

/** Whether text is selected on the page (in a notice, a dialog): Ctrl+C copies that, not the canvas. */
export const hasPageSelection = () => {
  const s = typeof getSelection === 'function' ? getSelection() : null
  return !!s && !s.isCollapsed && s.toString().trim().length > 0
}

/** Ctrl (⌘ on a Mac) with these is a text field's own: select all, clipboard, undo, moving by words. */
const FIELD_MOD_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'y', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'backspace', 'delete'])
/** Keys a slider, a radio group or a dropdown moves by. */
const STEP_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'pageup', 'pagedown'])
const STEPPED_INPUTS = new Set(['range', 'radio'])

const isFunctionKey = (key: string) => /^f\d+$/.test(key)

/** The developer tools' keys: F12, Ctrl+Shift+I/J/C, and ⌥⌘I/J/C on a Mac. */
function isDevtools(e: KeyboardEvent, mac: boolean): boolean {
  if (e.key === 'F12') return true
  const letter = e.code === 'KeyI' || e.code === 'KeyJ' || e.code === 'KeyC'
  return letter && (mac ? e.metaKey && e.altKey : e.ctrlKey && e.shiftKey && !e.altKey)
}

/**
 * Whether the browser may do what it does with this key: true only for the
 * page's own controls (see above). Exported for the checks.
 */
export function keepsDefault(e: KeyboardEvent, mac = isMac()): boolean {
  const key = e.key.toLowerCase()
  const mod = mac ? e.metaKey : e.ctrlKey
  if (isDevtools(e, mac)) return true
  if (mod && !e.altKey && (key === 'c' || key === 'x' || key === 'v')) return true

  const t = e.target
  if (isTyping(t)) {
    if (isFunctionKey(key)) return false
    if (!mod && !e.altKey) return true
    // AltGr (Ctrl+Alt on Windows) and ⌥ on a Mac type characters.
    if (e.altKey && e.key.length === 1 && (mac || e.ctrlKey)) return true
    // ⌥ moves and deletes by words in a Mac's fields.
    if (mac && e.altKey && !mod && FIELD_MOD_KEYS.has(key)) return true
    return mod && !e.altKey && FIELD_MOD_KEYS.has(key)
  }
  if (mod) return false
  if (key === 'tab' && !e.altKey) return true
  if (t instanceof HTMLSelectElement) return !isFunctionKey(key)
  if (STEP_KEYS.has(key) && !e.altKey && t instanceof HTMLInputElement && STEPPED_INPUTS.has(t.type)) return true
  // Enter and Space press the focused control; on the page itself, nothing.
  if ((key === 'enter' || key === ' ') && !e.altKey && t instanceof HTMLElement && t !== document.body && t.matches('button, input, summary, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"]'))
    return true
  return false
}

let installed = false

/** Installs the guard on the window, once. */
export function installInputGuard(): void {
  if (installed) return
  installed = true
  // Bubbling, on the window: last, after every handler in the page has
  // seen the event (cancelling doesn't stop it travelling).
  addEventListener('keydown', (e) => {
    if (!keepsDefault(e)) e.preventDefault()
  })
  // Alt or F10 on its own, let go, takes the focus to the browser's menu.
  addEventListener('keyup', (e) => {
    if (e.key === 'Alt' || e.key === 'F10') e.preventDefault()
  })

  addEventListener('contextmenu', (e) => {
    if (!isTyping(e.target)) e.preventDefault()
  })
  // The middle button scrolls the page by itself (autoscroll) or pastes on
  // Linux; the side buttons go back and forward. The app still sees all of
  // them as pointer events.
  const buttons = (e: MouseEvent) => {
    if (e.button === 1 || e.button === 3 || e.button === 4) e.preventDefault()
  }
  addEventListener('mousedown', buttons, true)
  addEventListener('mouseup', buttons, true)
  addEventListener('auxclick', (e) => e.preventDefault(), true)
  // Ctrl+wheel, and a trackpad's pinch (which arrives as one), zoom the
  // page. The canvas zooms itself on its own listener.
  addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault()
    },
    { passive: false, capture: true },
  )
  // Safari's own pinch.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) addEventListener(type, (e) => e.preventDefault())

  // Nothing is dragged out of the page but text from a field.
  addEventListener('dragstart', (e) => {
    if (!isTyping(e.target) && !(e.target instanceof Element && e.target.closest('[draggable="true"]'))) e.preventDefault()
  })
  // Dropped on the page, a link or an image would open in its place. Files
  // are the app's (App opens them); text may still go into a field.
  const files = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
  addEventListener('dragover', (e) => {
    if (files(e) || isTyping(e.target)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
  })
  addEventListener('drop', (e) => {
    if (!isTyping(e.target) || files(e)) e.preventDefault()
  })

  // Full screen locks the keyboard, so Ctrl+W and the rest come to the page
  // (and the keydown guard keeps them from the browser).
  const kb = (navigator as Navigator & { keyboard?: { lock?(): Promise<void>; unlock?(): void } }).keyboard
  if (kb?.lock) {
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) void kb.lock!().catch(() => {})
      else kb.unlock?.()
    })
  }
}
