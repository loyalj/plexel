/**
 * The Swatches panel. On top, the front document's own swatches
 * (doc/swatches.ts): process, global and spot colours, which fills and
 * strokes can link to (in Properties), with libraries loaded from and saved
 * as Adobe Swatch Exchange files. Below, the colours kept in the browser
 * for any document.
 *
 * Click a swatch to make it the foreground, Alt-click for the background.
 * A document swatch's name opens its options; a kept one goes with Delete
 * (or Backspace) when focused, or its context menu.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { colourEngine, colourEngineNow } from '../app/colour'
import { colours } from '../app/colours'
import { colourSettings } from '../app/colourSettings'
import { deleteDocSwatch, editDocSwatch, libraryBytes, loadLibrary, newDocSwatch } from '../app/docSwatches'
import { documents } from '../app/documents'
import { swatches } from '../app/swatches'
import { pressSwatch } from '../app/colourDrag'
import { SWATCH_KINDS, swatchUses, type DocSwatch, type SwatchKind } from '../doc/swatches'
import { downloadAs, pickExportFile, writeToHandle } from '../io/files'
import { cssOf } from './colourView'

const KIND_MARK: Record<SwatchKind, string> = { process: '', global: '◢', spot: '●' }

export function SwatchesPanel() {
  const list = useSyncExternalStore(swatches().subscribe, swatches().get)
  const display = useSyncExternalStore(colourSettings.subscribe, colourSettings.get).display
  const active = useSyncExternalStore(documents().subscribe, () => documents().active())
  const [engine, setEngine] = useState(colourEngineNow)
  const [editing, setEditing] = useState<string | null>(null)
  const libraryInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!engine) void colourEngine().then(setEngine)
  }, [engine])
  if (!engine) return <p className="panel-empty">Starting the colour engine…</p>
  const doc = active?.history.present ?? null
  const docSwatches = doc?.swatches ?? []
  const uses = doc ? swatchUses(doc) : new Map<string, number>()
  const open = docSwatches.find((s) => s.id === editing) ?? null
  return (
    <div className="swatches-panel">
      {doc && (
        <section className="doc-swatches" aria-label="Document swatches">
          <span className="field-label">Document</span>
          {docSwatches.length ? (
            <ul className="doc-swatch-list">
              {docSwatches.map((s) => (
                <li key={s.id} className={`doc-swatch${editing === s.id ? ' open' : ''}`} data-doc-swatch={s.id}>
                  <button
                    type="button"
                    className="swatch-chip"
                    style={{ background: cssOf(s.colour, engine.converter, display) }}
                    title="Click for the foreground, Alt-click for the background. Drag onto a shape to fill it, Shift to stroke it."
                    aria-label={`${s.name} as the foreground`}
                    onPointerDown={(e) => pressSwatch(e, { kind: 'swatch', id: s.id }, cssOf(s.colour, engine.converter, display))}
                    onClick={(e) => (e.altKey ? colours().setBg(s.colour) : colours().setFg(s.colour))}
                  />
                  <button type="button" className="doc-swatch-name" onClick={() => setEditing(editing === s.id ? null : s.id)} title="Swatch options">
                    {s.name}
                  </button>
                  <span className={`doc-swatch-kind ${s.kind}`} title={SWATCH_KINDS.find(([k]) => k === s.kind)![1] + (uses.get(s.id) ? `, used by ${uses.get(s.id)}` : '')}>
                    {KIND_MARK[s.kind]}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="field-note">None yet. Global and spot swatches stay linked to the fills and strokes they’re given to.</p>
          )}
          {open && <SwatchOptions key={open.id} s={open} uses={uses.get(open.id) ?? 0} onClose={() => setEditing(null)} />}
          <div className="panel-tools">
            <button type="button" className="button small" data-new-swatch="process" onClick={() => setEditing(newDocSwatch('process'))} title="A swatch of the foreground colour">
              New Swatch
            </button>
            <button type="button" className="button small" data-new-swatch="spot" onClick={() => setEditing(newDocSwatch('spot'))} title="A named ink, defined by the foreground colour">
              New Spot
            </button>
            <button type="button" className="button small" onClick={() => libraryInput.current?.click()} title="Adds an Adobe Swatch Exchange file’s colours (.ase)">
              Load Library…
            </button>
            <button type="button" className="button small" disabled={!docSwatches.length} onClick={() => void saveLibrary(active?.history.present.name ?? 'Swatches')}>
              Save Library…
            </button>
            <input
              ref={libraryInput}
              type="file"
              hidden
              accept=".ase"
              data-load-library
              onChange={async (e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) await loadLibrary(f)
              }}
            />
          </div>
        </section>
      )}
      <span className="field-label">Kept</span>
      <div className="swatch-grid" role="list" aria-label="Swatches">
        {list.map((c, i) => (
          <button
            key={i}
            type="button"
            role="listitem"
            className="swatch-chip"
            data-swatch-index={i}
            style={{ background: cssOf(c, engine.converter, display) }}
            title="Click for the foreground, Alt-click for the background. Drag onto a shape to fill it, Shift to stroke it. Delete removes it."
            aria-label={`Swatch ${i + 1}`}
            onPointerDown={(e) => pressSwatch(e, { kind: 'colour', value: c }, cssOf(c, engine.converter, display))}
            onClick={(e) => (e.altKey ? colours().setBg(c) : colours().setFg(c))}
            onContextMenu={(e) => {
              e.preventDefault()
              swatches().remove(i)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault()
                e.stopPropagation()
                swatches().remove(i)
              }
            }}
          />
        ))}
      </div>
      <div className="panel-tools">
        <button type="button" className="button small" onClick={() => swatches().add(colours().get().fg)}>
          Add Foreground
        </button>
        <button type="button" className="button small" onClick={() => swatches().reset()}>
          Reset
        </button>
      </div>
    </div>
  )
}

/** A document swatch's name, kind and colour, changed in place; each change one step. */
function SwatchOptions({ s, uses, onClose }: { s: DocSwatch; uses: number; onClose(): void }) {
  return (
    <div className="doc-swatch-options" data-swatch-options={s.id}>
      <div className="field">
        <label htmlFor="swatch-name">Name</label>
        <input
          id="swatch-name"
          defaultValue={s.name}
          onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && editDocSwatch(s.id, { name: e.target.value.trim() }, 'Rename Swatch')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            e.stopPropagation()
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="swatch-kind">Kind</label>
        <select id="swatch-kind" value={s.kind} onChange={(e) => editDocSwatch(s.id, { kind: e.target.value as SwatchKind })}>
          {SWATCH_KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <span className="field-note">
          {s.kind === 'spot'
            ? 'A named ink, shown through this colour. Fills and strokes given it stay linked, at a tint.'
            : s.kind === 'global'
              ? 'Fills and strokes given it stay linked: change it and they all change.'
              : 'Just a colour to pick; nothing stays linked to it.'}
          {uses ? ` Used by ${uses} fill${uses === 1 ? '' : 's'} or stroke${uses === 1 ? '' : 's'}.` : ''}
        </span>
      </div>
      <div className="panel-tools">
        <button type="button" className="button small" data-swatch-set-fg onClick={() => editDocSwatch(s.id, { colour: colours().get().fg }, 'Swatch Colour')} title="Makes the swatch the foreground colour; linked fills and strokes follow">
          Use Foreground
        </button>
        <button
          type="button"
          className="button small"
          onClick={() => {
            deleteDocSwatch(s.id)
            onClose()
          }}
          title="Linked fills and strokes keep their colour"
        >
          Delete
        </button>
      </div>
    </div>
  )
}

async function saveLibrary(name: string) {
  const bytes = libraryBytes()
  if (!bytes) return
  const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' })
  const file = `${name.replace(/\.pxll$/i, '')} swatches.ase`
  const handle = await pickExportFile(file, { description: 'Adobe Swatch Exchange', mime: 'application/octet-stream', extensions: ['.ase'] })
  if (handle === 'cancelled') return
  if (handle) await writeToHandle(handle, blob)
  else downloadAs(blob, file)
}
