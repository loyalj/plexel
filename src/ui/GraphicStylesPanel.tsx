/**
 * The Graphic Styles panel: the document's named appearance stacks. Click
 * one to give it to the selected shapes and text (linked); New makes one
 * from the selected shape; Redefine makes a style the selected shape's look,
 * changing every shape linked to it; double-click a name to rename it.
 */
import { useState, useSyncExternalStore } from 'react'
import { documents } from '../app/documents'
import { applyStyle, deleteStyle, newGraphicStyle, redefineStyle, renameStyle, unlinkSelected } from '../app/graphicStyles'
import { linkOf } from '../doc/graphicStyles'
import { appearanceIn, type AppearanceItem } from '../doc/vector'
import type { Doc } from '../doc/types'
import { paintCss } from './VectorProps'
import { Icon } from './Icon'

/** A style drawn small: its top fill, inside its top stroke. */
function Preview({ items, doc }: { items: AppearanceItem[]; doc: Doc }) {
  const shown = appearanceIn(items, doc.mode).filter((it) => it.enabled)
  const fill = [...shown].reverse().find((it) => it.kind === 'fill')
  const stroke = [...shown].reverse().find((it) => it.kind === 'stroke')
  const fx = shown.some((it) => it.effects?.some((e) => e.enabled))
  return (
    <span
      className="style-preview"
      style={{ background: fill ? paintCss(fill.paint, doc.mode) : 'transparent', borderColor: stroke ? paintCss(stroke.paint, doc.mode) : 'transparent', borderWidth: stroke ? 3 : 1 }}
      data-fx={fx || undefined}
    >
      {fx && <span className="style-fx">fx</span>}
    </span>
  )
}

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

export function GraphicStylesPanel() {
  const d = useSyncExternalStore(documents().subscribe, () => documents().active())
  const doc = d?.history.present
  if (!d || !doc) return <p className="panel-empty">Named looks for shapes and text: fills, strokes and their effects, kept with the document.</p>
  const list = doc.graphicStyles ?? []
  const linked = linkOf(d.selected ? doc.nodes[d.selected] : undefined)
  return (
    <div className="graphic-styles" data-panel="graphic-styles">
      {list.length === 0 ? (
        <p className="panel-empty">No graphic styles yet. Select a shape and make one from its fills and strokes.</p>
      ) : (
        <ul className="channel-list">
          {list.map((g) => (
            <li key={g.id} className={`channel-row${linked === g.id ? ' current' : ''}`} data-graphic-style={g.id} aria-current={linked === g.id || undefined}>
              <button type="button" className="style-apply" title={`Give ${g.name} to the selected shapes and text`} onClick={() => applyStyle(g.id)}>
                <Preview items={g.appearance} doc={doc} />
              </button>
              <Name name={g.name} onRename={(n) => renameStyle(g.id, n)} />
              <button type="button" className="icon-button" aria-label={`Redefine ${g.name} from the selected shape`} title="Redefine from the selected shape: every shape linked to it changes" data-style-redefine onClick={() => redefineStyle(g.id)}>
                <Icon name="ui.up" />
              </button>
              <button type="button" className="icon-button" aria-label={`Delete ${g.name}`} onClick={() => deleteStyle(g.id)}>
                <Icon name="ui.close" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="panel-tools">
        <button type="button" className="button small" data-graphic-styles="new" onClick={() => newGraphicStyle()}>
          New from Selection
        </button>
        <button type="button" className="button small" disabled={!linked} onClick={() => unlinkSelected()}>
          Break Link
        </button>
      </div>
    </div>
  )
}
