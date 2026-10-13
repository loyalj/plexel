/**
 * The Channels panel's alpha channels and the Patterns panel: what a
 * document keeps besides its layers.
 *
 * Alpha channels are saved selections: a click loads one as the selection
 * (Shift adds, Alt subtracts, both intersect, as Photoshop's Ctrl-click
 * does), and the buttons save the selection as a new one, duplicate and
 * delete. Patterns are the document's patterns made from pixels, for
 * fills, fill layers, the Paint Bucket and shapes.
 */
import { useState, useSyncExternalStore } from 'react'
import { documents } from '../app/documents'
import { deletePattern, renameDocPattern } from '../app/fills'
import { deleteChannel, duplicateChannel, loadSelection, renameDocChannel, saveSelection } from '../app/selection'
import { opFor } from '../app/selectTools'
import type { DialogId } from '../commands'
import { Icon } from './Icon'

/** A name that becomes a field on double-click; Enter keeps it, Esc puts it back. */
function Name({ name, onRename }: { name: string; onRename(n: string): void }) {
  const [editing, setEditing] = useState<string | null>(null)
  if (editing === null)
    return (
      <span className="channel-name" onDoubleClick={() => setEditing(name)} title="Double-click to rename">
        {name}
      </span>
    )
  return (
    <input
      className="channel-name"
      value={editing}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setEditing(e.target.value)}
      onBlur={() => {
        if (editing.trim() && editing !== name) onRename(editing)
        setEditing(null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setEditing(null)
      }}
    />
  )
}

export function ChannelsPanel() {
  const d = useSyncExternalStore(documents().subscribe, () => documents().active())
  const [picked, setPicked] = useState<string | null>(null)
  const doc = d?.history.present
  if (!doc) return <p className="panel-empty">Alpha channels: selections saved with the document, to load again.</p>
  const list = doc.channels ?? []
  const chosen = list.find((c) => c.id === picked) ?? null
  return (
    <div className="channels" data-panel="channels">
      {list.length === 0 ? (
        <p className="panel-empty">No alpha channels yet. Select something, then save it here (or Select → Save Selection) to keep it.</p>
      ) : (
        <ul className="channel-list">
          {list.map((c) => (
            <li key={c.id} className={`channel-row${c.id === picked ? ' selected' : ''}`} data-channel={c.id}>
              <button
                type="button"
                className="channel-load"
                title="Load as the selection (Shift adds, Alt subtracts, both intersect)"
                aria-label={`Load ${c.name} as the selection`}
                onClick={(e) => {
                  setPicked(c.id)
                  loadSelection(c.id, { invert: false, op: opFor(e, 'replace') })
                }}
              >
                <Icon name="channel.load" />
              </button>
              <Name name={c.name} onRename={(n) => renameDocChannel(c.id, n)} />
              <button type="button" className="icon-button" aria-label={`Pick ${c.name}`} onClick={() => setPicked(c.id === picked ? null : c.id)}>
                <Icon name={c.id === picked ? 'channel.picked' : 'channel.unpicked'} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="panel-tools">
        <button type="button" className="button small" disabled={!doc.selection} data-channels="save" title="Save the selection as a new alpha channel" onClick={() => void saveSelection({ channel: null, name: '', op: 'replace' })}>
          Save Selection
        </button>
        <button type="button" className="button small" disabled={!chosen || !doc.selection} title="Replace the picked channel with the selection" onClick={() => chosen && void saveSelection({ channel: chosen.id, name: '', op: 'replace' })}>
          Save Into
        </button>
        <button type="button" className="button small" disabled={!chosen} onClick={() => chosen && duplicateChannel(chosen.id)}>
          Duplicate
        </button>
        <button
          type="button"
          className="button small"
          disabled={!chosen}
          onClick={() => {
            if (!chosen) return
            deleteChannel(chosen.id)
            setPicked(null)
          }}
        >
          Delete
        </button>
      </div>
    </div>
  )
}

export function PatternsPanel({ openDialog }: { openDialog(id: DialogId): void }) {
  const d = useSyncExternalStore(documents().subscribe, () => documents().active())
  const doc = d?.history.present
  if (!doc) return <p className="panel-empty">Patterns made from pixels, kept in the document for fills, fill layers and shapes.</p>
  const list = doc.patterns ?? []
  return (
    <div className="patterns" data-panel="patterns">
      {list.length === 0 ? (
        <p className="panel-empty">No patterns yet. Select an area and define one, or define the whole canvas as one.</p>
      ) : (
        <ul className="channel-list">
          {list.map((p) => (
            <li key={p.id} className="channel-row" data-pattern={p.id}>
              <Name name={p.name} onRename={(n) => renameDocPattern(p.id, n)} />
              <span className="field-note">
                {p.width} × {p.height}
              </span>
              <button type="button" className="icon-button" aria-label={`Delete ${p.name}`} onClick={() => deletePattern(p.id)}>
                <Icon name="ui.close" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="panel-tools">
        <button type="button" className="button small" data-patterns="define" onClick={() => openDialog('definePattern')}>
          Define Pattern…
        </button>
      </div>
    </div>
  )
}
