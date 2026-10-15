/**
 * Keyboard shortcuts as data: written as text in the command registry
 * (`Mod+Shift+K`), parsed once, matched against key events, and printed the
 * way the platform prints them.
 *
 * `Mod` is Ctrl on Windows and Linux and ⌘ on a Mac, so one registry entry
 * serves both. Keys are matched by `event.key`, lowercased, so Shift+K
 * matches whether the browser reports `K` or `k`, and a layout that puts a
 * letter elsewhere still finds it by its letter. Digits and punctuation are
 * found by the key they're on too (`event.code`), so Shift+1 and Shift+[
 * match where Shift turns them into ! and {, and so is a letter that ⌥ on
 * a Mac turns into something else.
 *
 * The registry's keys are the defaults: what you've changed is
 * input/keymap.ts's, and `shortcutsOf` (commands) gives a command's keys now.
 */

export interface Shortcut {
  mod: boolean
  shift: boolean
  alt: boolean
  /** Lowercased `KeyboardEvent.key`: `k`, `f11`, `escape`, `,`. */
  key: string
}

const MODIFIERS = new Set(['mod', 'shift', 'alt'])

/** Keys written as words, since they can't be written as themselves: `Mod+Space`, `Mod+Plus`. */
const WORD_KEYS: Record<string, string> = { space: ' ', plus: '+' }

/** Parses `Mod+Shift+K`; null for anything malformed, which check-commands refuses. */
export function parseShortcut(text: string): Shortcut | null {
  const parts = text.split('+').map((p) => p.trim().toLowerCase())
  const word = parts.pop()
  const key = word ? (WORD_KEYS[word] ?? word) : word
  if (!key || MODIFIERS.has(key)) return null
  if (parts.some((p) => !MODIFIERS.has(p))) return null
  if (new Set(parts).size !== parts.length) return null
  return { mod: parts.includes('mod'), shift: parts.includes('shift'), alt: parts.includes('alt'), key }
}

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** Keys matched by where they are as well as what they type, so Shift or Alt (which change what they type) still find them. */
const KEY_AT: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
}

/**
 * The key an event's place says, where that's worth trying as well as what
 * it typed. A letter is taken by its place only on a Mac, where ⌥ types
 * something else with it; elsewhere Ctrl+Alt is AltGr, which types a
 * layout's own letters (ń, @), and those must stay typing.
 */
export function keyAt(e: Pick<KeyboardEvent, 'code' | 'key'>, mac: boolean): string | null {
  const code = e.code ?? ''
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (KEY_AT[code]) return KEY_AT[code]
  if (mac && /^Key[A-Z]$/.test(code) && !/^[a-z]$/i.test(e.key)) return code.slice(3).toLowerCase()
  return null
}

export function matches(s: Shortcut, e: KeyboardEvent, mac = isMac()): boolean {
  const mod = mac ? e.metaKey : e.ctrlKey
  // The other platform's modifier must be up, so Ctrl+K on a Mac isn't ⌘K.
  const stray = mac ? e.ctrlKey : e.metaKey
  const code = keyAt(e, mac)
  return (s.key === e.key.toLowerCase() || (code !== null && s.key === code)) && s.mod === mod && !stray && s.shift === e.shiftKey && s.alt === e.altKey
}

const KEY_NAMES: Record<string, string> = {
  escape: 'Esc',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  ' ': 'Space',
  delete: 'Del',
  backspace: 'Backspace',
  enter: 'Enter',
  tab: 'Tab',
  '+': 'Plus',
}

/** `Ctrl+Shift+K` on Windows, `⇧⌘K` on a Mac. */
export function formatShortcut(s: Shortcut, mac = isMac()): string {
  const key = KEY_NAMES[s.key] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key[0].toUpperCase() + s.key.slice(1))
  if (mac) return `${s.alt ? '⌥' : ''}${s.shift ? '⇧' : ''}${s.mod ? '⌘' : ''}${key}`
  return [s.mod && 'Ctrl', s.alt && 'Alt', s.shift && 'Shift', key].filter(Boolean).join('+')
}

/** A stable string for comparing shortcuts, whatever order they were written in. */
export const shortcutKey = (s: Shortcut) => `${s.mod ? 'mod+' : ''}${s.alt ? 'alt+' : ''}${s.shift ? 'shift+' : ''}${s.key}`
