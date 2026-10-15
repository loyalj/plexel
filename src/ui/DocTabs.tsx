/**
 * One tab per open document, above the canvas. A dot marks unsaved
 * changes. Click brings a document to the front; × or a middle click
 * closes it, asking first if it has unsaved changes.
 */
import { isDirty, type OpenDoc } from '../app/documents'
import { Icon } from './Icon'

interface Props {
  docs: OpenDoc[]
  active: string | null
  onActivate(key: string): void
  onClose(key: string): void
}

export function DocTabs({ docs, active, onActivate, onClose }: Props) {
  if (!docs.length) return null
  return (
    <div className="tabs" role="tablist" aria-label="Open documents">
      {docs.map((d) => {
        const dirty = isDirty(d)
        const name = d.file?.name ?? d.history.present.name
        return (
          <div
            key={d.key}
            className={`tab${d.key === active ? ' active' : ''}`}
            role="tab"
            aria-selected={d.key === active}
            data-doc={d.key}
            data-dirty={dirty}
            data-tip={d.file ? d.file.name : `${d.history.present.name} (not saved yet)`}
            onPointerDown={(e) => {
              if (e.button === 0) onActivate(d.key)
            }}
            onAuxClick={(e) => {
              if (e.button === 1) onClose(d.key)
            }}
          >
            <span className="tab-name">{name}</span>
            {dirty && <span className="tab-dirty" aria-label="unsaved changes" />}
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${name}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onClose(d.key)}
            >
              <Icon name="ui.close" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
