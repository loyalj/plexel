/**
 * Edit → Keyboard Shortcuts: every command and its keys, to change.
 *
 * Changes are made on a draft and kept with Save, as Photoshop's are;
 * Cancel (or Esc, or a click outside) forgets them. A key is added to a
 * command, or one of its keys replaced, by clicking and pressing the new
 * key: the dialog listens for one press. A key with a problem (one the
 * browser keeps, the clipboard's) says so and waits for another; a key
 * another command has says whose it is and asks before taking it. The rules
 * are input/keymap.ts's; this only asks.
 *
 * The set menu starts the draft from Photoshop's, Affinity's or
 * Illustrator's keys (input/keySets.ts), and says which set the draft is,
 * or that it's one changed further.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { defaultShortcutsOf, type CommandDef } from '../commands'
import { matchText } from '../commands/search'
import { assignKey, clashes, isChanged, keyProblem, keysOf, ownerOf, removeKey, resetKeys, shortcutFromEvent, shortcutText, type KeyChanges } from '../input/keymap'
import { formatShortcut, parseShortcut } from '../input/shortcuts'
import { Dialog } from './Dialog'
import { KEY_SETS, isKeySet, keySetById, keySetChanges, keySetOf, type KeySet } from '../input/keySets'
import { Icon } from './Icon'

const shown = (text: string) => {
  const s = parseShortcut(text)
  return s ? formatShortcut(s) : text
}
const label = (c: CommandDef) => c.label.replace(/…$/, '')

/** Which command is listening for a key, and in place of which of its keys. */
interface Recording {
  id: string
  replacing: string | null
  problem: string | null
  /** A key another command has, waiting for a yes. */
  taking: { text: string; from: CommandDef } | null
}

export function ShortcutsDialog({ defs, changes, onSave, onClose }: { defs: CommandDef[]; changes: KeyChanges; onSave(changes: KeyChanges): void; onClose(): void }) {
  const [draft, setDraft] = useState(changes)
  const [query, setQuery] = useState('')
  const [rec, setRec] = useState<Recording | null>(null)
  const listener = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const q = query.trim()
    if (!q) return defs
    return defs.filter((c) => matchText(q, label(c)) || matchText(q, c.category) || keysOf(c, draft).some((k) => shown(k).toLowerCase().includes(q.toLowerCase())))
  }, [defs, draft, query])
  const categories = [...new Set(rows.map((c) => c.category))]
  const clashed = useMemo(() => new Set([...clashes(defs, draft).values()].flat().map((c) => c.id)), [defs, draft])
  const changedCount = defs.filter((c) => isChanged(draft, c.id)).length
  // The set chosen, while the draft is still its keys; else whichever set the draft is, if any.
  const [picked, setPicked] = useState<KeySet | null>(null)
  const setNow = picked && isKeySet(defs, draft, picked) ? picked.id : keySetOf(defs, draft)

  useEffect(() => {
    if (rec && !rec.taking) listener.current?.focus()
  }, [rec])

  const listen = (id: string, replacing: string | null) => setRec({ id, replacing, problem: null, taking: null })
  const give = (id: string, text: string, replacing: string | null) => {
    setDraft((d) => assignKey(defs, d, id, text, replacing ?? undefined))
    setRec(null)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (!rec) return
    // Asking whether to take a key: its buttons keep Enter, Space and Tab.
    if (rec.taking && e.target instanceof HTMLButtonElement && ['Enter', ' ', 'Tab'].includes(e.key)) return
    e.preventDefault()
    e.stopPropagation()
    // Esc stops listening, rather than closing the dialog.
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return setRec(null)
    const s = shortcutFromEvent(e.nativeEvent)
    if (!s) return
    const text = shortcutText(s)
    const c = defs.find((d) => d.id === rec.id)!
    const problem = keyProblem(c, text)
    if (problem) return setRec({ ...rec, problem, taking: null })
    if (keysOf(c, draft).some((k) => shown(k) === shown(text))) return setRec(null)
    const from = ownerOf(defs, draft, text, c.id) as CommandDef | null
    if (from) return setRec({ ...rec, problem: null, taking: { text, from } })
    give(rec.id, text, rec.replacing)
  }

  return (
    <Dialog
      id="shortcuts"
      title="Keyboard Shortcuts"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" data-keys-reset-all disabled={changedCount === 0} onClick={() => setDraft({})}>
            Reset All
          </button>
          <span className="dialog-foot-gap" />
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            data-keys-save
            onClick={() => {
              onSave(draft)
              onClose()
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="keys-top">
        <input type="search" className="keys-search" placeholder="Find a command or a key" aria-label="Find a command or a key" value={query} onChange={(e) => setQuery(e.target.value)} data-keys-search />
        <label className="keys-set" data-tip={KEY_SETS.map((s) => `${s.name}: ${s.about}`).join('. ')}>
          <span>Set</span>
          <select
            data-keys-set
            value={setNow ?? 'mine'}
            onChange={(e) => {
              const s = keySetById(e.target.value)
              if (!s) return
              setPicked(s)
              setDraft(keySetChanges(defs, s))
            }}
          >
            {KEY_SETS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            {setNow === null && <option value="mine">Your own</option>}
          </select>
        </label>
        <span className="keys-count" data-keys-changed={changedCount}>
          {changedCount ? `${changedCount} changed` : 'As Plexel ships them'}
        </span>
      </div>
      <div className="keys-list" data-keys-list>
        {categories.map((cat) => (
          <div key={cat} className="shortcut-group">
            <h3>{cat}</h3>
            {rows
              .filter((c) => c.category === cat)
              .map((c) => {
                const keys = keysOf(c, draft)
                const changed = isChanged(draft, c.id)
                const here = rec?.id === c.id ? rec : null
                return (
                  <div key={c.id} className={`shortcut-row${changed ? ' changed' : ''}${clashed.has(c.id) ? ' clash' : ''}`} data-keys-row={c.id}>
                    <span className="keys-label">
                      {label(c)}
                      {changed && <span className="keys-dot" data-tip={`Changed from ${defaultShortcutsOf(c).map(shown).join(' or ') || 'no key'}`} aria-label="changed" />}
                    </span>
                    <span className="keys-keys">
                      {keys.map((k) =>
                        here && here.replacing === k ? null : (
                          <span key={k} className="keys-chip">
                            <button type="button" className="keys-chip-key" data-key={k} data-tip="Click, then press the key to use instead" onClick={() => listen(c.id, k)}>
                              <kbd>{shown(k)}</kbd>
                            </button>
                            <button type="button" className="keys-chip-remove" aria-label={`Remove ${shown(k)}`} data-key-remove={k} onClick={() => setDraft((d) => removeKey(defs, d, c.id, k))}>
                              <Icon name="ui.close" />
                            </button>
                          </span>
                        ),
                      )}
                      {here ? (
                        <div ref={listener} tabIndex={0} className="keys-listen" data-keys-listen role="textbox" aria-label={`Press a key for ${label(c)}`} onKeyDown={onKey} onBlur={() => !here.taking && setRec(null)}>
                          {here.taking ? (
                            <span className="keys-taking" data-keys-taking>
                              <kbd>{shown(here.taking.text)}</kbd> is {label(here.taking.from)}’s.{' '}
                              <button type="button" className="button small primary" data-keys-take onClick={() => give(c.id, here.taking!.text, here.replacing)}>
                                Use it here
                              </button>{' '}
                              <button type="button" className="button small" onClick={() => setRec(null)}>
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <span>{here.problem ?? 'Press a key… (Esc to stop)'}</span>
                          )}
                        </div>
                      ) : (
                        <button type="button" className="keys-add" data-keys-add={c.id} aria-label={`Add a key for ${label(c)}`} data-tip="Add a key" onClick={() => listen(c.id, null)}>
                          +
                        </button>
                      )}
                      <button type="button" className="keys-reset" data-keys-reset={c.id} disabled={!changed} aria-label={`Reset ${label(c)}`} data-tip="Back to Plexel’s key" onClick={() => setDraft((d) => resetKeys(defs, d, c.id))}>
                        <Icon name="ui.reset" />
                      </button>
                    </span>
                  </div>
                )
              })}
          </div>
        ))}
        {rows.length === 0 && <p>No command or key matches “{query}”.</p>}
      </div>
    </Dialog>
  )
}
