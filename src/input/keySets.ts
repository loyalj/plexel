/**
 * Shortcut sets: Edit → Keyboard Shortcuts starts from Photoshop's keys,
 * Affinity's or Illustrator's, then lets you change them as ever.
 *
 * Plexel's own keys are Photoshop's, and Affinity Photo's follow
 * Photoshop's for the tools and commands Plexel has, so those two sets are
 * the same keys. Illustrator's differ: its tools (the Selection tool on V,
 * Direct Selection on A, the Paintbrush on B, the Blob Brush on Shift+B,
 * the Pencil on N, the Shape Builder on Shift+M, the Live Paint Bucket on
 * K, the Artboard tool on Shift+O, the Width tool on Shift+W, Rotate View on Shift+H, the Eraser on
 * Shift+E, Free Transform on E) and some commands (Create Outlines on
 * Ctrl+Shift+O, Hide on Ctrl+3, Swap Fill and Stroke on Shift+X; Smart
 * Guides are on Ctrl+U in Plexel already).
 *
 * A set is the keys that differ from the registry's, given command by
 * command; applying one gives each key to its command as Edit → Keyboard
 * Shortcuts would, taking it from whatever had it, so a set never leaves
 * a key on two commands. Pure, so check-commands runs it in Node.
 */
import { assignKey, removeKey, keysOf, type KeyChanges, type Keyed } from './keymap'

export interface KeySet {
  id: 'photoshop' | 'affinity' | 'illustrator'
  name: string
  /** What it is, for the menu's tooltip. */
  about: string
  /** Each command's whole list of keys, where it differs from the registry's. */
  keys: Record<string, string[]>
}

export const KEY_SETS: KeySet[] = [
  { id: 'photoshop', name: 'Photoshop', about: 'Plexel’s own keys, which are Photoshop’s', keys: {} },
  { id: 'affinity', name: 'Affinity', about: 'Affinity Photo’s keys, which follow Photoshop’s for the tools and commands Plexel has', keys: {} },
  {
    id: 'illustrator',
    name: 'Illustrator',
    about: 'Illustrator’s tool keys, and its keys for outlines, hiding and swapping fill and stroke',
    keys: {
      // Tools.
      'tool.group-pencil': ['N'],
      'tool.next-pencil': [],
      'tool.vbrush': ['B'],
      'tool.blob': ['Shift+B'],
      'tool.group-brush': [],
      'tool.next-brush': [],
      'tool.builder': ['Shift+M'],
      'tool.shape': ['M'],
      'tool.marquee': [],
      'tool.livepaint': ['K'],
      'tool.artboard': ['Shift+O'],
      'tool.lasso': ['Q'],
      'tool.group-wand': ['Y'],
      'tool.next-wand': [],
      'tool.width': ['Shift+W'],
      'tool.curvature': ['Shift+`'],
      'tool.eraser': ['Shift+E'],
      'tool.rotate': ['Shift+H'],
      'tool.gradient': ['G'],
      'tool.mesh': ['U'],
      'tool.group-fill': [],
      'tool.next-fill': [],
      'tool.group-shape': [],
      'tool.next-shape': [],
      'edit.free-transform': ['E'],
      // Commands.
      'type.create-outlines': ['Mod+Shift+O'],
      'layer.toggle-visible': ['Mod+3'],
      'colour.swap': ['X', 'Shift+X'],
    },
  },
]

export const keySetById = (id: string) => KEY_SETS.find((s) => s.id === id)

/** Your changes for a set: its keys given to their commands, nothing else changed. */
export function keySetChanges(defs: readonly Keyed[], set: KeySet): KeyChanges {
  let out: KeyChanges = {}
  for (const [id, keys] of Object.entries(set.keys)) {
    const c = defs.find((d) => d.id === id)
    if (!c) continue
    // The command's own keys first go, then the set's are given, each taken from whatever had it.
    for (const k of keysOf(c, out)) out = removeKey(defs, out, id, k)
    for (const k of keys) out = assignKey(defs, out, id, k)
  }
  return out
}

/** Whether some changes are exactly a set's keys. */
export function isKeySet(defs: readonly Keyed[], changes: KeyChanges, set: KeySet): boolean {
  return sameKeys(defs, changes, keySetChanges(defs, set))
}

function sameKeys(defs: readonly Keyed[], a: KeyChanges, b: KeyChanges): boolean {
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const c = defs.find((d) => d.id === id)
    if (c && keysOf(c, a).join('|') !== keysOf(c, b).join('|')) return false
  }
  return true
}

/** Which set some changes are, exactly: null when they're a set changed further, or none. Photoshop's and Affinity's are the same keys: the first that matches. */
export function keySetOf(defs: readonly Keyed[], changes: KeyChanges): KeySet['id'] | null {
  return KEY_SETS.find((s) => isKeySet(defs, changes, s))?.id ?? null
}
