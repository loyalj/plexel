/**
 * Layer → Move to Group… and Rename Layers…: for many layers at once.
 *
 * Move to Group lists the document's groups, narrowed as you type; the
 * arrows choose and Enter moves the selected layers into the chosen one, at
 * its top. Rename Layers numbers the selected layers from a pattern, or
 * finds and replaces in their names, showing the new names as you type.
 */
import { useMemo, useState } from 'react'
import type { OpenDoc } from '../app/documents'
import { groupChoices, moveSelectedTo, renameSelected, renamesFor, type RenameRule } from '../app/layerActions'
import { Segmented, type SegmentOption } from './controls'
import { Dialog } from './Dialog'
import { Field } from './docDialogs'

/** How many of the new names Rename Layers shows before "and N more". */
const SHOWN = 8

export function MoveToGroupDialog({ doc: d, onClose }: { doc: OpenDoc; onClose(): void }) {
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const all = useMemo(() => [{ id: d.history.present.root, name: 'Top level', path: '' }, ...groupChoices(d)], [d])
  const q = query.trim().toLowerCase()
  const shown = q ? all.filter((g) => `${g.path} ${g.name}`.toLowerCase().includes(q)) : all
  const pick = Math.min(at, shown.length - 1)
  const choose = (i: number) => {
    const g = shown[i]
    if (!g) return
    onClose()
    moveSelectedTo(g.id)
  }
  return (
    <Dialog id="moveToGroup" title="Move to Group" hint="The selected layers go into the group you choose, at its top." onClose={onClose}>
      <div className="form" data-move-to-group>
        <input
          id="move-group-search"
          className="move-group-search"
          aria-label="Find a group"
          placeholder="Find a group"
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setAt(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setAt(Math.max(0, Math.min(shown.length - 1, pick + (e.key === 'ArrowDown' ? 1 : -1))))
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              choose(pick)
            }
          }}
        />
        <ul className="move-group-list" role="listbox" aria-label="Groups">
          {shown.length === 0 && <li className="move-group-none">No group by that name</li>}
          {shown.map((g, i) => (
            <li key={g.id} role="option" aria-selected={i === pick} className={i === pick ? 'chosen' : ''} data-group-choice={g.id} onPointerEnter={() => setAt(i)} onClick={() => choose(i)}>
              <span className="move-group-name">{g.name}</span>
              {g.path && <span className="move-group-path">{g.path}</span>}
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  )
}

const MODES: SegmentOption<'number' | 'replace'>[] = [
  ['number', 'Name and number'],
  ['replace', 'Find and replace'],
]
const FROM: SegmentOption<'bottom' | 'top'>[] = [
  ['bottom', 'From the bottom'],
  ['top', 'From the top'],
]

export function RenameLayersDialog({ doc: d, onClose }: { doc: OpenDoc; onClose(): void }) {
  const [mode, setMode] = useState<'number' | 'replace'>('number')
  const [pattern, setPattern] = useState('Layer ##')
  const [start, setStart] = useState(1)
  const [from, setFrom] = useState<'bottom' | 'top'>('bottom')
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const rule: RenameRule = mode === 'number' ? { kind: 'number', pattern, start, fromTop: from === 'top' } : { kind: 'replace', find, replace, matchCase }
  const renames = renamesFor(d, rule)
  const changed = renames.filter((r) => r.to.trim() && r.to !== r.from).length
  const ok = () => {
    onClose()
    renameSelected(rule)
  }
  return (
    <Dialog
      id="renameLayers"
      title="Rename Layers"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" disabled={!changed} data-why="No name would change" onClick={ok}>
            Rename {changed === 1 ? '1 Layer' : `${changed} Layers`}
          </button>
        </>
      }
    >
      <form
        className="form"
        data-rename-layers
        onSubmit={(e) => {
          e.preventDefault()
          if (changed) ok()
        }}
      >
        <Segmented<'number' | 'replace'> id="rename-mode" label="Rename by" value={mode} options={MODES} onChange={setMode} />
        {mode === 'number' ? (
          <>
            <Field id="rename-pattern" label="Name" hint="Each run of # is the number, in at least that many digits: “Window ##” gives Window 01, Window 02… Without #, the number goes after the name.">
              <input id="rename-pattern" value={pattern} autoFocus onChange={(e) => setPattern(e.target.value)} />
            </Field>
            <Field id="rename-start" label="Start at">
              <input id="rename-start" type="number" min={0} step={1} value={start} onChange={(e) => setStart(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
            </Field>
            <Segmented<'bottom' | 'top'> id="rename-from" label="Count" value={from} options={FROM} onChange={setFrom} />
          </>
        ) : (
          <>
            <Field id="rename-find" label="Find">
              <input id="rename-find" value={find} autoFocus onChange={(e) => setFind(e.target.value)} />
            </Field>
            <Field id="rename-replace" label="Replace with">
              <input id="rename-replace" value={replace} onChange={(e) => setReplace(e.target.value)} />
            </Field>
            <label className="check">
              <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
              Match case
            </label>
          </>
        )}
        <ul className="rename-preview" aria-label="New names">
          {renames.slice(0, SHOWN).map((r) => (
            <li key={r.id} className={r.to !== r.from ? 'renamed' : ''}>
              <span className="rename-from">{r.from}</span>
              <span className="rename-to">{r.to}</span>
            </li>
          ))}
          {renames.length > SHOWN && <li className="rename-more">and {renames.length - SHOWN} more</li>}
        </ul>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
