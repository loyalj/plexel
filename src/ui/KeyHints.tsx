/**
 * The status bar's key hints: what each key would do right now, with the
 * tool in use. Before a press, the tool's keys (Shift adds, Alt
 * subtracts); during a drag, the ones that change the drag (Shift for a
 * square); while a transform, crop, polygon, path or text is open, that
 * session's (Enter commits, Esc cancels). A modifier being held lights up
 * its hints, so it's plain what letting go would change. While a tool's key
 * is held (app/springTools.ts), the first hint says which tool letting go
 * brings back.
 *
 * Hidden with Edit → Interface → Key hints off.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { canvasGesture } from '../app/gesture'
import { springTools } from '../app/springTools'
import { sessions } from '../app/canvasTools'
import { documents } from '../app/documents'
import { GLOBAL_KEYS, SESSION_KEYS, TOOL_BY_ID, tools, type ToolKey } from '../tools'
import { interfacePrefs } from './interface'
import { Chord, chordModifiers, type Modifier } from './Keys'

/** The hints for a tool at a moment: pure, so the checks can ask it too. */
function hintsFor(tool: string, session: keyof typeof SESSION_KEYS | null, dragging: boolean): ToolKey[] {
  if (session) return SESSION_KEYS[session]
  const keys = TOOL_BY_ID.get(tool as never)?.keys ?? []
  if (dragging) return keys.filter((k) => k.during === 'drag')
  const own = keys.filter((k) => k.during !== 'drag')
  // The Hand's own Space hint says it already.
  return [...own, ...GLOBAL_KEYS.filter((g) => !own.some((k) => k.keys === g.keys))]
}

export function KeyHints() {
  const prefs = useSyncExternalStore(interfacePrefs().subscribe, interfacePrefs().get)
  const tool = useSyncExternalStore(tools().subscribe, tools().get)
  const session = useSyncExternalStore(sessions().subscribe, sessions().get)
  const gesture = useSyncExternalStore(canvasGesture.subscribe, canvasGesture.get)
  const front = useSyncExternalStore(documents().subscribe, () => documents().getState().active)
  // The spring's state is mutated in place, so the hint follows its emits through a counter.
  const [, setSpringTick] = useState(0)
  useEffect(() => springTools().subscribe(() => setSpringTick((n) => n + 1)), [])
  const spring = springTools().get()
  const [held, setHeld] = useState<Set<Modifier>>(new Set())

  useEffect(() => {
    const read = (e: KeyboardEvent | PointerEvent) => {
      const now = new Set<Modifier>()
      if (e.shiftKey) now.add('Shift')
      if (e.altKey) now.add('Alt')
      if (e.ctrlKey || e.metaKey) now.add('Ctrl')
      setHeld((h) => (h.size === now.size && [...now].every((m) => h.has(m)) ? h : now))
    }
    const clear = () => setHeld(new Set())
    addEventListener('keydown', read, true)
    addEventListener('keyup', read, true)
    addEventListener('pointermove', read, true)
    addEventListener('blur', clear)
    return () => {
      removeEventListener('keydown', read, true)
      removeEventListener('keyup', read, true)
      removeEventListener('pointermove', read, true)
      removeEventListener('blur', clear)
    }
  }, [])

  if (!prefs.keyHints || !front) return null
  const s = session && session.key === front ? session.kind : null
  const dragging = gesture !== null && gesture !== 'pan'
  const base =
    gesture === 'size'
      ? [{ keys: 'Drag', does: 'left and right for size, up and down for hardness' }]
      : gesture === 'hue'
        ? [
            { keys: 'Drag', does: 'in the square for the shade, onto the strip for the hue' },
            { keys: 'Esc', does: 'the colour back' },
          ]
        : hintsFor(tool, s, dragging)
  const back = spring ? TOOL_BY_ID.get(spring.from) : null
  const list = back ? [{ keys: spring!.code.replace(/^Key/, ''), does: `held: let go for the ${back.name} again` }, ...base] : base
  if (!list.length) return null
  return (
    <span className="key-hints" data-status="hints" aria-live="off">
      {list.map((k, i) => {
        const mods = chordModifiers(k.keys)
        const lit = mods.length > 0 && mods.length === held.size && mods.every((m) => held.has(m))
        return (
          <span key={i} className={`key-hint${lit ? ' held' : ''}`} data-hint={k.keys}>
            <Chord keys={k.keys} /> {k.does}
          </span>
        )
      })}
    </span>
  )
}
