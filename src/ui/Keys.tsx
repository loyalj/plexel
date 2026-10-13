/**
 * Keys and gestures as chips: `Shift+Alt` as two, `Click` as a word in the
 * same style. On a Mac, Shift, Alt and Ctrl print as ⇧, ⌥ and ⌘, and the
 * right-drag that sizes a brush is Ctrl+Option with a drag, as in Photoshop.
 */
import type { ToolKey } from '../tools'
import { isMac } from '../input/shortcuts'

const MAC: Record<string, string> = { Shift: '⇧', Alt: '⌥', Ctrl: '⌘' }
/** The modifiers a chord holds, as the hints light them. */
export const MODIFIERS = ['Shift', 'Alt', 'Ctrl'] as const
export type Modifier = (typeof MODIFIERS)[number]

export function chordParts(keys: string, mac = isMac()): string[] {
  if (mac && keys === 'Alt+Right-drag') return ['⌃', '⌥', 'Drag']
  return keys.split('+').map((k) => (mac ? (MAC[k] ?? k) : k))
}

/** The modifiers a chord needs held. */
export const chordModifiers = (keys: string): Modifier[] => keys.split('+').filter((k): k is Modifier => (MODIFIERS as readonly string[]).includes(k))

export function Chord({ keys }: { keys: string }) {
  return (
    <span className="chord">
      {chordParts(keys).map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  )
}

/** A tool's keys as a list: chord, then what it does. */
export function KeyList({ keys }: { keys: ToolKey[] }) {
  return (
    <dl className="key-list">
      {keys.map((k, i) => (
        <div key={i}>
          <dt>
            <Chord keys={k.keys} />
          </dt>
          <dd>
            {k.does}
            {k.during === 'drag' ? <span className="key-during"> while dragging</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  )
}
