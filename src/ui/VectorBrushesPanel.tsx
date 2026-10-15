/**
 * The Vector Brushes panel: the document's brushes, then the built-in ones,
 * each drawn along a curve. Click one to stroke the selected shapes and
 * text with it; double-click (or Options) for Brush Options; New from
 * Selection makes an art, scatter or pattern brush of the selected shapes.
 */
import { memo, useState, useSyncExternalStore } from 'react'
import { documents } from '../app/documents'
import { applyBrush, brushChoices, brushOptions, deleteBrush, duplicateBrush, hasBrushStroke, newBrushFromSelection, removeBrushStroke, renameBrush, selectedBrushId } from '../app/vectorBrushes'
import { BRUSH_KINDS, type VectorBrush } from '../doc/vectorBrush'
import { BrushPreview } from './BrushPreview'
import { Icon } from './Icon'

function Name({ name, onRename }: { name: string; onRename(n: string): void }) {
  const [editing, setEditing] = useState<string | null>(null)
  if (editing === null)
    return (
      <span className="channel-name" onDoubleClick={() => setEditing(name)} data-tip="Double-click to rename">
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

export const VectorBrushesPanel = memo(function VectorBrushesPanel() {
  const d = useSyncExternalStore(documents().subscribe, () => documents().active())
  const [kind, setKind] = useState<VectorBrush['kind']>('art')
  const doc = d?.history.present
  if (!d || !doc) return <p className="panel-empty">No document open</p>
  const choices = brushChoices(doc)
  const current = selectedBrushId()
  const row = ({ brush, builtin }: { brush: VectorBrush; builtin: boolean }) => (
    <li key={brush.id} className={`channel-row brush-row${current === brush.id ? ' current' : ''}`} data-vector-brush={brush.id} aria-current={current === brush.id || undefined}>
      <button type="button" className="brush-apply" data-tip={`Stroke the selected shapes with ${brush.name}`} onClick={() => applyBrush(brush.id)} onDoubleClick={() => brushOptions.set({ key: d.key, id: brush.id })}>
        <BrushPreview brush={brush} mode={doc.mode} width={90} height={27} />
      </button>
      {builtin ? <span className="channel-name">{brush.name}</span> : <Name name={brush.name} onRename={(n) => renameBrush(brush.id, n)} />}
      <span className="brush-kind">{BRUSH_KINDS.find(([k]) => k === brush.kind)?.[1]}</span>
      <button type="button" className="icon-button" aria-label={`${brush.name} options`} data-tip="Brush Options" data-brush-options={brush.id} onClick={() => brushOptions.set({ key: d.key, id: brush.id })}>
        <Icon name="ui.settings" />
      </button>
      <button type="button" className="icon-button" aria-label={`Duplicate ${brush.name}`} data-tip="Duplicate" onClick={() => duplicateBrush(brush.id)}>
        <Icon name="ui.duplicate" />
      </button>
      {!builtin && (
        <button type="button" className="icon-button" aria-label={`Delete ${brush.name}`} data-tip="Delete (strokes keep their copy)" onClick={() => deleteBrush(brush.id)}>
          <Icon name="ui.close" />
        </button>
      )}
    </li>
  )
  const own = choices.filter((c) => !c.builtin)
  const builtins = choices.filter((c) => c.builtin)
  return (
    <div className="vector-brushes" data-panel="vector-brushes">
      {own.length > 0 && <ul className="channel-list">{own.map(row)}</ul>}
      <h4 className="panel-subhead">Built-in</h4>
      <ul className="channel-list">{builtins.map(row)}</ul>
      <div className="panel-tools">
        <select aria-label="Kind of brush to make" value={kind} onChange={(e) => setKind(e.target.value as VectorBrush['kind'])} data-vector-brushes="kind">
          {BRUSH_KINDS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <button type="button" className="button small" data-vector-brushes="new" data-tip="The selected shapes become the brush’s artwork" onClick={() => newBrushFromSelection(kind)}>
          New from Selection
        </button>
        <button type="button" className="button small" disabled={!hasBrushStroke()} data-vector-brushes="remove" onClick={() => removeBrushStroke()}>
          Remove Brush
        </button>
      </div>
    </div>
  )
})
