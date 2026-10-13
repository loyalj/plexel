/**
 * The History panel: every step of the front document, oldest first.
 * Clicking a step goes straight to it, undoing or redoing as many steps as
 * that takes. Steps after the current one stay listed, dimmed, until the
 * next edit replaces them.
 */
import { useEffect, useRef } from 'react'
import type { OpenDoc } from '../app/documents'
import { steps } from '../doc/history'

export function HistoryPanel({ doc, onJump }: { doc: OpenDoc; onJump(index: number): void }) {
  const { labels, current } = steps(doc.history)
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    list.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest' })
  }, [current, labels.length])
  return (
    <ol className="history-list" ref={list} aria-label="History">
      {labels.map((label, i) => (
        <li key={i}>
          <button
            type="button"
            className={`history-step${i === current ? ' current' : ''}${i > current ? ' undone' : ''}`}
            aria-current={i === current ? 'step' : undefined}
            onClick={() => onJump(i)}
          >
            {label}
          </button>
        </li>
      ))}
    </ol>
  )
}
