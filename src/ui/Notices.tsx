/** The messages from notices.ts, stacked at the bottom of the canvas. */
import { useSyncExternalStore } from 'react'
import { dismiss, noticeStore } from '../app/notices'
import { Icon } from './Icon'

export function Notices() {
  const list = useSyncExternalStore(noticeStore.subscribe, noticeStore.get)
  if (!list.length) return null
  return (
    <div className="notices" aria-live="polite">
      {list.map((n) => (
        <div key={n.id} className={`notice ${n.tone}`} role={n.tone === 'error' ? 'alert' : 'status'} data-notice={n.tone}>
          <div className="notice-text">
            {n.text}
            {n.details && (
              <ul className="notice-details">
                {n.details.slice(0, 8).map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
                {n.details.length > 8 && <li>and {n.details.length - 8} more</li>}
              </ul>
            )}
          </div>
          <button type="button" className="panel-close" aria-label="Dismiss" onClick={() => dismiss(n.id)}>
            <Icon name="ui.close" />
          </button>
        </div>
      ))}
    </div>
  )
}
