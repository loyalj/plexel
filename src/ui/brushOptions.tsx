/**
 * Brush Options, as Illustrator's: a vector brush's name, how it's
 * colorized, and its kind's settings, with a preview as it will draw.
 * An art brush: how it fits the path (stretched, in proportion, or between
 * guides), its scale and flips. A scatter brush: each copy's size,
 * spacing, scatter and rotation, each a range. A pattern brush: how tiles
 * fit, its scale and flips, and its start, end and corner tiles, taken
 * from the selected shapes. OK keeps it in the document and, if asked,
 * changes the strokes drawn with it.
 */
import { useState, useSyncExternalStore } from 'react'
import { documents } from '../app/documents'
import { artFromSelection, brushById, brushOptions, updateBrush } from '../app/vectorBrushes'
import { COLORIZE, strokesWith, type ArtFit, type Colorize, type Range, type VectorBrush } from '../doc/vectorBrush'
import type { Doc } from '../doc/types'
import { BrushPreview } from './BrushPreview'
import { Dialog } from './Dialog'
import { Field } from './docDialogs'

/** The dialog while a brush is being edited (App.tsx shows it then). */
export function BrushOptionsDialog() {
  const e = useSyncExternalStore(brushOptions.subscribe, brushOptions.get)
  const d = e ? documents().get(e.key) : null
  const brush = e && d ? brushById(d.history.present, e.id) : null
  if (!e || !d || !brush) return null
  return <BrushForm key={`${e.key}:${e.id}`} doc={d.history.present} start={brush} />
}

/** A number field shown in some unit (×100 for a percentage), kept as typed while it's being typed. */
function Num({ id, label, value, onChange, scale = 100, min, max, step = 1 }: { id: string; label: string; value: number; onChange(v: number): void; scale?: number; min: number; max: number; step?: number }) {
  return (
    <Field id={id} label={label}>
      <input id={id} type="number" min={min} max={max} step={step} value={Math.round(value * scale * 100) / 100} onChange={(ev) => {
        const v = Number(ev.target.value)
        if (ev.target.value !== '' && Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)) / scale)
      }} />
    </Field>
  )
}

/** A range as two number fields, low and high. */
function RangeField({ id, label, value, onChange, scale = 100, min, max, unit }: { id: string; label: string; value: Range; onChange(r: Range): void; scale?: number; min: number; max: number; unit: string }) {
  const set = (i: 0 | 1, v: number) => {
    const r: Range = [...value] as Range
    r[i] = v
    onChange([Math.min(r[0], r[1]), Math.max(r[0], r[1])])
  }
  return (
    <div className="field">
      <label htmlFor={`${id}-lo`}>{label} ({unit})</label>
      <div className="field-row">
        {[0, 1].map((i) => (
          <input key={i} id={`${id}-${i ? 'hi' : 'lo'}`} aria-label={`${label}, ${i ? 'highest' : 'lowest'}`} type="number" min={min} max={max} value={Math.round(value[i] * scale * 100) / 100} onChange={(ev) => {
            const v = Number(ev.target.value)
            if (ev.target.value !== '' && Number.isFinite(v)) set(i as 0 | 1, Math.min(max, Math.max(min, v)) / scale)
          }} />
        ))}
      </div>
    </div>
  )
}

function BrushForm({ doc, start }: { doc: Doc; start: VectorBrush }) {
  const [b, setB] = useState<VectorBrush>(start)
  const using = strokesWith(doc, start.id)
  const [restroke, setRestroke] = useState(true)
  const close = () => brushOptions.set(null)
  const put = (patch: Partial<VectorBrush>) => setB((x) => ({ ...x, ...patch }) as VectorBrush)
  const flips = b.kind !== 'scatter' && (
    <>
      <label className="check">
        <input type="checkbox" id="brush-flip-along" checked={b.flipAlong} onChange={(ev) => put({ flipAlong: ev.target.checked })} />
        Flip along
      </label>
      <label className="check">
        <input type="checkbox" id="brush-flip-across" checked={b.flipAcross} onChange={(ev) => put({ flipAcross: ev.target.checked })} />
        Flip across
      </label>
    </>
  )
  return (
    <Dialog
      id="brushOptions"
      title={`${b.kind === 'art' ? 'Art' : b.kind === 'scatter' ? 'Scatter' : 'Pattern'} Brush Options`}
      onClose={close}
      footer={
        <>
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="brush-form" className="button primary" disabled={!b.name.trim()}>
            OK
          </button>
        </>
      }
    >
      <form
        id="brush-form"
        className="form"
        onSubmit={(ev) => {
          ev.preventDefault()
          close()
          updateBrush({ ...b, name: b.name.trim() }, using > 0 && restroke)
        }}
      >
        <div className="brush-options-preview">
          <BrushPreview brush={b} mode={doc.mode} width={360} height={108} />
        </div>
        <Field id="brush-name" label="Name">
          <input id="brush-name" value={b.name} autoFocus onFocus={(ev) => ev.target.select()} onChange={(ev) => put({ name: ev.target.value })} />
        </Field>
        <Field id="brush-colorize" label="Colorization">
          <select id="brush-colorize" value={b.colorize} onChange={(ev) => put({ colorize: ev.target.value as Colorize })}>
            {COLORIZE.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {b.kind === 'art' && (
          <>
            <Field id="brush-fit" label="Fit">
              <select id="brush-fit" value={b.fit} onChange={(ev) => put({ fit: ev.target.value as ArtFit })}>
                <option value="stretch">Stretch to fit the path</option>
                <option value="proportional">Scale in proportion</option>
                <option value="guides">Stretch between guides</option>
              </select>
            </Field>
            {b.fit === 'guides' && <RangeGuides value={b.guides} onChange={(guides) => put({ guides })} />}
            <Num id="brush-scale" label={b.fit === 'proportional' ? 'Scale (%)' : 'Width (% of the stroke’s)'} value={b.scale} min={1} max={10000} onChange={(scale) => put({ scale })} />
            {flips}
          </>
        )}
        {b.kind === 'scatter' && (
          <>
            <RangeField id="brush-size" label="Size" unit="% of the stroke’s width" value={b.size} min={1} max={10000} onChange={(size) => put({ size })} />
            <RangeField id="brush-spacing" label="Spacing" unit="% of a copy" value={b.spacing} min={5} max={10000} onChange={(spacing) => put({ spacing })} />
            <RangeField id="brush-scatter" label="Scatter" unit="% of the stroke’s width" value={b.scatter} min={-10000} max={10000} onChange={(scatter) => put({ scatter })} />
            <RangeField id="brush-rotation" label="Rotation" unit="°" scale={1} value={b.rotation} min={-360} max={360} onChange={(rotation) => put({ rotation })} />
            <Field id="brush-relative" label="Rotation relative to">
              <select id="brush-relative" value={b.relative} onChange={(ev) => put({ relative: ev.target.value as 'path' | 'page' })}>
                <option value="path">The path</option>
                <option value="page">The page</option>
              </select>
            </Field>
            <button type="button" className="button small" onClick={() => put({ seed: Math.floor(Math.random() * 1e6) })}>
              Vary Again
            </button>
          </>
        )}
        {b.kind === 'pattern' && (
          <>
            <Field id="brush-fit" label="Fit">
              <select id="brush-fit" value={b.fit} onChange={(ev) => put({ fit: ev.target.value as 'stretch' | 'space' })}>
                <option value="stretch">Stretch tiles to fit</option>
                <option value="space">Add space to fit</option>
              </select>
            </Field>
            <Num id="brush-scale" label="Width (% of the stroke’s)" value={b.scale} min={1} max={10000} onChange={(scale) => put({ scale })} />
            {flips}
            <div className="brush-tiles">
              {(['side', 'start', 'end', 'corner'] as const).map((slot) => (
                <TileRow key={slot} slot={slot} has={!!b[slot]} onSet={() => {
                  const art = artFromSelection()
                  if (art) put({ [slot]: art } as Partial<VectorBrush>)
                }} onClear={slot === 'side' ? null : () => setB((x) => {
                  const y = { ...x } as Record<string, unknown>
                  delete y[slot]
                  return y as unknown as VectorBrush
                })} />
              ))}
            </div>
          </>
        )}
        {using > 0 && (
          <label className="check">
            <input type="checkbox" id="brush-restroke" checked={restroke} onChange={(ev) => setRestroke(ev.target.checked)} />
            Change the {using === 1 ? 'stroke' : `${using} strokes`} drawn with it
          </label>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

const SLOT_LABEL = { side: 'Side tile', start: 'Start tile', end: 'End tile', corner: 'Corner tile' }

function TileRow({ slot, has, onSet, onClear }: { slot: 'side' | 'start' | 'end' | 'corner'; has: boolean; onSet(): void; onClear: (() => void) | null }) {
  return (
    <>
      <span>{SLOT_LABEL[slot]}</span>
      <span className="brush-kind">{has ? 'Set' : 'None'}</span>
      <button type="button" className="button small" id={`brush-tile-${slot}`} data-tip="The selected shapes become this tile" onClick={onSet}>
        From Selection
      </button>
      {onClear ? (
        <button type="button" className="button small" id={`brush-tile-${slot}-clear`} disabled={!has} onClick={onClear}>
          Clear
        </button>
      ) : (
        <span />
      )}
    </>
  )
}

/** Where an art brush's guides are: how much of its length from each end keeps its shape. */
function RangeGuides({ value, onChange }: { value: Range; onChange(r: Range): void }) {
  return (
    <div className="field-row">
      <Num id="brush-guide-start" label="Start keeps (%)" value={value[0]} min={0} max={50} onChange={(v) => onChange([v, value[1]])} />
      <Num id="brush-guide-end" label="End keeps (%)" value={value[1]} min={0} max={50} onChange={(v) => onChange([value[0], v])} />
    </div>
  )
}
