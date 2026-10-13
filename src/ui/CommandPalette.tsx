/**
 * Ctrl+K: every command, found by typing a few of its letters.
 *
 * The list is the registry itself, so anything with a menu entry is here
 * too, along with commands that have no menu at all. Up and down move,
 * Enter runs, Esc closes. The palette closes before the command runs, so a
 * command that opens a dialog opens it on a clean screen.
 *
 * A command that can't run now is left out of the full list, but one that
 * matches what's typed is shown, greyed, with the reason, so a search for
 * "feather" with nothing selected says what's missing rather than nothing.
 */
import { useMemo, useRef, useState, useEffect, type ReactNode } from 'react'
import { COMMANDS, disabledReason, runtimeCommands, shortcutsOf, type CommandContext, type CommandDef } from '../commands'
import { matchCommand } from '../commands/search'
import { formatShortcut, parseShortcut } from '../input/shortcuts'
import { Icon } from './Icon'

interface Props {
  ctx: CommandContext
  onRun(id: string): void
  onClose(): void
}

interface Row {
  def: CommandDef
  hits: number[]
  /** Why it can't run now; null when it can. */
  why: string | null
}

export function CommandPalette({ ctx, onRun, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLUListElement>(null)

  const rows = useMemo<Row[]>(() => {
    const all = [...COMMANDS, ...runtimeCommands(ctx)].filter((c) => c.id !== 'palette.open').map((def) => ({ def, why: disabledReason(def, ctx) }))
    if (!query.trim()) return all.filter((r) => !r.why).map((r) => ({ ...r, hits: [] }))
    // What can run comes first, then what can't, each by how well it matches.
    return all
      .map((r, order) => ({ ...r, order, m: matchCommand(query, r.def.label, r.def.category) }))
      .filter((r) => r.m)
      .sort((a, b) => Number(!!a.why) - Number(!!b.why) || b.m!.score - a.m!.score || a.order - b.order)
      .map((r) => ({ def: r.def, why: r.why, hits: r.m!.hits }))
  }, [query, ctx])

  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const choose = (row: Row | undefined) => {
    if (!row || row.why) return
    onClose()
    onRun(row.def.id)
  }

  return (
    <div className="scrim palette-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          className="palette-input"
          id="palette-input"
          autoFocus
          placeholder="Type a command"
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={rows[index] ? `palette-${rows[index].def.id}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(rows.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(rows[index])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        {rows.length ? (
          <ul className="palette-list" id="palette-list" role="listbox" ref={list}>
            {rows.map((row, i) => {
              const first = shortcutsOf(row.def)[0]
              const shortcut = first ? parseShortcut(first) : null
              const checked = row.def.checked?.(ctx)
              return (
                <li
                  key={row.def.id}
                  id={`palette-${row.def.id}`}
                  className={`palette-item${row.why ? ' unavailable' : ''}`}
                  role="option"
                  aria-selected={i === index}
                  aria-disabled={row.why ? true : undefined}
                  data-command={row.def.id}
                  onPointerMove={() => setIndex(i)}
                  onClick={() => choose(row)}
                >
                  <span>
                    <span className="palette-category">{row.def.category}</span>
                    {highlight(row.def.label, row.hits)}
                    {checked ? <> <Icon name="ui.check" /></> : ''}
                    {row.why && <span className="palette-why">{row.why}</span>}
                  </span>
                  <span className="palette-shortcut">{shortcut ? formatShortcut(shortcut) : ''}</span>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="palette-none">No command matches “{query}”.</div>
        )}
      </div>
    </div>
  )
}

function highlight(label: string, hits: number[]): ReactNode {
  if (!hits.length) return label
  const marked = new Set(hits)
  const out: ReactNode[] = []
  let run = ''
  let inHit = false
  const flush = (key: number) => {
    if (!run) return
    out.push(inHit ? <span key={key} className="palette-match">{run}</span> : run)
    run = ''
  }
  for (let i = 0; i < label.length; i++) {
    const hit = marked.has(i)
    if (hit !== inHit) {
      flush(i)
      inHit = hit
    }
    run += label[i]
  }
  flush(label.length)
  return out
}
