/**
 * Your own keyboard shortcuts: Edit → Keyboard Shortcuts.
 *
 * The registry (commands/index.ts) gives every command its keys; what you
 * change is kept apart from it, as a command's whole list of keys replacing
 * the registry's (an empty list takes its keys away). So a command that
 * gains a key in a later version still gets it, unless you've set that
 * command's keys yourself, and Reset is just forgetting the change.
 *
 * A key is one command's at a time. Giving it to another takes it from the
 * one that had it, as Photoshop does, and the editor says so before it
 * happens. Some keys can't be anyone's: the browser keeps a few for itself
 * (they never reach the page), the developer tools theirs, and the
 * clipboard's are left to the browser so its clipboard events fire
 * (input/guard.ts); Tab moves between controls, so only Tab's own commands
 * have it.
 *
 * Kept per browser, under its own versioned key, read defensively; and
 * carried in an exported workspace (ui/workspaceFile.ts), so a setup moves
 * between browsers with its keys. Everything but the little store at the
 * foot is pure, so check-commands runs it in Node.
 */
import { formatShortcut, isMac, keyAt, parseShortcut, shortcutKey, type Shortcut } from './shortcuts'
import { Listeners } from '../lib/listeners'

/** Commands whose keys you've set, by id: each list replaces the registry's. */
export type KeyChanges = Record<string, string[]>

/** What the keymap needs of a command; CommandDef is one. */
export interface Keyed {
  id: string
  label: string
  shortcut?: string | string[]
  clipboard?: 'copy' | 'cut' | 'paste'
  focusKey?: boolean
}

/** A command's keys as the registry has them. */
export const defaultKeys = (c: Keyed): string[] => (c.shortcut === undefined ? [] : Array.isArray(c.shortcut) ? c.shortcut : [c.shortcut])

/** A command's keys now: yours when you've set them, else the registry's. */
export const keysOf = (c: Keyed, changes: KeyChanges): string[] => changes[c.id] ?? defaultKeys(c)

/**
 * Keys the browser keeps: a page can't preventDefault them, so a command
 * on one would close the tab or open a window instead of running.
 */
export const RESERVED = ['Mod+Shift+I', 'Mod+Shift+C', 'Mod+Shift+J', 'Mod+W', 'Mod+T', 'Mod+N', 'Mod+Shift+N', 'Mod+Shift+T', 'Mod+Shift+W', 'Mod+Q', 'Mod+Tab', 'F11']
const RESERVED_KEYS = new Set(RESERVED.map((s) => shortcutKey(parseShortcut(s)!)))

const norm = (text: string) => {
  const s = parseShortcut(text)
  return s ? shortcutKey(s) : null
}
const sameKey = (a: string, b: string) => norm(a) !== null && norm(a) === norm(b)

/** Why a key can't be this command's, in a few words; null when it can. */
export function keyProblem(c: Keyed, text: string, mac = isMac()): string | null {
  const s = parseShortcut(text)
  if (!s) return 'That isn’t a key Plexel can use'
  const shown = formatShortcut(s, mac)
  if (RESERVED_KEYS.has(shortcutKey(s))) return `The browser keeps ${shown} for itself: it never reaches the page`
  if (s.key === 'f12' || (s.mod && s.shift && !s.alt && ['i', 'j', 'c'].includes(s.key))) return `${shown} is the developer tools’`
  const clipKey = s.mod && !s.alt && ['c', 'x', 'v'].includes(s.key)
  if (c.clipboard && !clipKey) return 'Cut, Copy and Paste stay on Ctrl with C, X or V, so the browser’s clipboard works'
  if (!c.clipboard && clipKey) return `${shown} is left to the browser’s clipboard`
  if (s.key === 'tab' && !s.mod && !s.alt && !c.focusKey) return 'Tab moves between controls; only hiding the panels shares it'
  return null
}

/** The command a key belongs to now, other than `except`. */
export function ownerOf(defs: readonly Keyed[], changes: KeyChanges, text: string, except?: string): Keyed | null {
  return defs.find((d) => d.id !== except && keysOf(d, changes).some((k) => sameKey(k, text))) ?? null
}

/** Sets a command's keys, forgetting the change when they're the registry's again. */
function setKeys(changes: KeyChanges, c: Keyed, keys: string[]): KeyChanges {
  const out = { ...changes }
  const def = defaultKeys(c)
  if (keys.length === def.length && keys.every((k, i) => sameKey(k, def[i]))) delete out[c.id]
  else out[c.id] = keys
  return out
}

/**
 * Gives a command a key, in place of `replacing` when that's given or as
 * another key when not. Whatever had the key loses it. A key with a
 * problem (keyProblem) is refused, leaving the changes as they were.
 */
export function assignKey(defs: readonly Keyed[], changes: KeyChanges, id: string, text: string, replacing?: string): KeyChanges {
  const c = defs.find((d) => d.id === id)
  const s = parseShortcut(text)
  if (!c || !s || keyProblem(c, text)) return changes
  const key = shortcutText(s)
  let out = changes
  for (const d of defs) if (d.id !== id && keysOf(d, out).some((k) => sameKey(k, key))) out = setKeys(out, d, keysOf(d, out).filter((k) => !sameKey(k, key)))
  const mine = keysOf(c, out).filter((k) => !sameKey(k, key))
  const at = replacing ? mine.findIndex((k) => sameKey(k, replacing)) : -1
  if (at >= 0) mine.splice(at, 1, key)
  else mine.push(key)
  return setKeys(out, c, mine)
}

/** Takes a key from a command. */
export function removeKey(defs: readonly Keyed[], changes: KeyChanges, id: string, text: string): KeyChanges {
  const c = defs.find((d) => d.id === id)
  if (!c) return changes
  return setKeys(changes, c, keysOf(c, changes).filter((k) => !sameKey(k, text)))
}

/** Puts a command's keys back as the registry has them, taking them from whatever has them now. */
export function resetKeys(defs: readonly Keyed[], changes: KeyChanges, id: string): KeyChanges {
  const c = defs.find((d) => d.id === id)
  if (!c) return changes
  let { [id]: _, ...out } = changes
  for (const k of defaultKeys(c))
    for (const d of defs) if (d.id !== id && keysOf(d, out).some((x) => sameKey(x, k))) out = setKeys(out, d, keysOf(d, out).filter((x) => !sameKey(x, k)))
  return out
}

/** Whether a command's keys are yours rather than the registry's. */
export const isChanged = (changes: KeyChanges, id: string) => id in changes

/** Keys that more than one command has: none, unless a change was read from elsewhere. */
export function clashes(defs: readonly Keyed[], changes: KeyChanges): Map<string, Keyed[]> {
  const by = new Map<string, Keyed[]>()
  for (const d of defs)
    for (const k of keysOf(d, changes)) {
      const n = norm(k)
      if (n) by.set(n, [...(by.get(n) ?? []), d])
    }
  return new Map([...by].filter(([, ds]) => ds.length > 1))
}

const MAX_KEYS = 4

/**
 * Changes from saved data, field by field: a key that doesn't parse is
 * dropped, one listed twice is kept once, and a command keeps at most a
 * few. Commands no longer in the app are kept, harmlessly, in case they're
 * a workspace of yours that comes back with an import.
 */
export function readKeyChanges(raw: unknown): KeyChanges {
  const out: KeyChanges = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, keys] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || id.length > 200 || !Array.isArray(keys)) continue
    const list: string[] = []
    for (const k of keys) {
      if (typeof k !== 'string') continue
      const s = parseShortcut(k)
      if (s && !list.some((x) => sameKey(x, k)) && list.length < MAX_KEYS) list.push(shortcutText(s))
    }
    out[id] = list
  }
  return out
}

// --- keys as text and from the keyboard ----------------------------------------------

const TEXT_NAMES: Record<string, string> = { ' ': 'Space', '+': 'Plus' }

/** `Mod+Alt+Shift+K`: how the registry writes a key, whatever the platform. */
export function shortcutText(s: Shortcut): string {
  const key = TEXT_NAMES[s.key] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key[0].toUpperCase() + s.key.slice(1))
  return [s.mod && 'Mod', s.alt && 'Alt', s.shift && 'Shift', key].filter(Boolean).join('+')
}

/** Keys that are only modifiers, or that don't say which key was pressed. */
const NOT_KEYS = new Set(['shift', 'control', 'alt', 'meta', 'altgraph', 'capslock', 'numlock', 'scrolllock', 'fn', 'os', 'dead', 'unidentified', 'process', 'compose'])

/**
 * The shortcut a key press is, for recording one: null for a modifier on
 * its own. Digits and punctuation are taken by the key they're on, so
 * Shift+1 records as Shift+1 rather than !, and a letter typed with ⌥ on a
 * Mac (which types something else) as its letter. Elsewhere a letter is
 * what it typed, as matching reads it.
 */
export function shortcutFromEvent(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, mac = isMac()): Shortcut | null {
  const k = e.key.toLowerCase()
  if (NOT_KEYS.has(k)) return null
  // As matching finds it (input/shortcuts.ts), so what's recorded is what's matched.
  const key = keyAt(e, mac) ?? k
  if (!key) return null
  return { mod: mac ? e.metaKey : e.ctrlKey, shift: e.shiftKey, alt: e.altKey, key }
}

// --- the store --------------------------------------------------------------------------

const KEY = 'plexel.keys.v1'
let current: KeyChanges = {}
let loaded = false
const changes = new Listeners()

function load(): KeyChanges {
  try {
    const text = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY)
    const raw = text ? (JSON.parse(text) as { changes?: unknown }) : null
    return readKeyChanges(raw?.changes)
  } catch {
    return {}
  }
}

/** Your changes now. */
export function keyChanges(): KeyChanges {
  if (!loaded) {
    loaded = true
    current = load()
  }
  return current
}

/** Replaces your changes, saves them and tells whoever is listening. */
export function setKeyChanges(next: KeyChanges) {
  current = next
  loaded = true
  try {
    localStorage.setItem(KEY, JSON.stringify({ changes: next }))
  } catch {
    // Not worth troubling anyone over: the keys just won't be remembered.
  }
  changes.emit()
}

export function subscribeKeys(l: () => void) {
  return changes.subscribe(l)
}
