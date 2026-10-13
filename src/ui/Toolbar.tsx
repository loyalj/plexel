/**
 * The toolbar down the left of the canvas, built from TOOL_DEFS: one button
 * per tool, the chosen one pressed. Its keys work from anywhere through
 * the command registry; the buttons are for the mouse. Hovering one shows
 * its card (ui/Tooltips.tsx): what it does and every key it answers to.
 */
import { useSyncExternalStore } from 'react'
import { TOOL_DEFS, tools } from '../tools'
import { Icon } from './Icon'
import { springTools } from '../app/springTools'
import type { IconName } from './icons'
import { toolKeys } from '../commands'
import { keyChanges, subscribeKeys } from '../input/keymap'
import { formatShortcut, parseShortcut } from '../input/shortcuts'

export function Toolbar() {
  const current = useSyncExternalStore(tools().subscribe, tools().get)
  // Drawn again when the keys change, so the labels name yours.
  useSyncExternalStore(subscribeKeys, keyChanges)
  return (
    <nav className="toolbar" aria-label="Tools">
      {TOOL_DEFS.map((t) => {
        const key = toolKeys(t).pick
        return (
          <button
            key={t.id}
            type="button"
            className="tool"
            data-tool={t.id}
            aria-pressed={current === t.id}
            data-tip-tool={t.id}
            data-tip-side="right"
            aria-label={key ? `${t.name} (${formatShortcut(parseShortcut(key)!)})` : t.name}
            onClick={() => {
              springTools().forget()
              tools().set(t.id)
            }}
          >
            <Icon name={`tool.${t.id}` as IconName} filled={current === t.id} />
          </button>
        )
      })}
    </nav>
  )
}
