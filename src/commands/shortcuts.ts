/** Commands' keys: yours where you've changed them, the registry's otherwise. */
import { defaultKeys, keyChanges, keysOf } from '../input/keymap'
import type { CommandDef } from './context'
import { COMMANDS_BY_ID } from './registry'

/** A command's shortcuts now, as a list: yours where you've changed them (Edit → Keyboard Shortcuts), the registry's otherwise. */
export const shortcutsOf = (c: CommandDef): string[] => keysOf(c, keyChanges())
/** A command's shortcuts as the registry has them. */
export const defaultShortcutsOf = (c: CommandDef): string[] => defaultKeys(c)

/** A command's first key now, written as the registry writes keys; null when it has none. */
export const keyOf = (id: string): string | null => {
  const c = COMMANDS_BY_ID.get(id)
  return (c && shortcutsOf(c)[0]) ?? null
}

/**
 * A tool's keys now: the one that picks it (its own, else its group's) and
 * the one that steps to the next tool in its group, for the toolbar and the
 * tool's card.
 */
export function toolKeys(t: { id: string; group?: string }): { pick: string | null; next: string | null } {
  return { pick: keyOf(`tool.${t.id}`) ?? (t.group ? keyOf(`tool.group-${t.group}`) : null), next: t.group ? keyOf(`tool.next-${t.group}`) : null }
}
