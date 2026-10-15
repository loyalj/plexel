/**
 * The guides' dialogs: View → New Guide and New Guide Layout, and Edit →
 * Guides, Grid & Snapping.
 *
 * Positions are typed in the rulers' units (or another, chosen beside
 * them) and measured from the rulers' zero point. New Guide Layout shows
 * its guides on the canvas as its settings change, and adds them as one
 * step on OK. The settings dialog changes things at once, as Edit →
 * Interface does.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { clearToolOverlay, setToolOverlay } from '../app/canvasTools'
import { documents } from '../app/documents'
import { DEFAULT_GUIDE_PREFS, SNAP_TARGETS, guidePrefs, type GuidePrefs } from '../app/guidePrefs'
import { origins } from '../app/viewAids'
import { addGuides, clearGuides, layoutGuides, type GuideLayout } from '../doc/guides'
import type { Doc } from '../doc/types'
import { fromPixels, type Unit } from '../doc/units'
import { Dialog } from './Dialog'
import { HexColourChip } from './ColourChip'
import { Field, Footer, UnitSelect, parseNumber } from './docDialogs'
import { Hint } from './controls'

/** A length typed in `unit` as document pixels, unrounded. */
const toPx = (v: number, unit: Unit, ppi: number) => (unit === 'px' ? v : v / fromPixels(1, unit, ppi))

const numberError = (text: string, min: number, max: number): string | null => {
  const n = parseNumber(text)
  if (n === null) return 'Enter a number.'
  if (n < min || n > max) return `Between ${min.toLocaleString()} and ${max.toLocaleString()}.`
  return null
}

export function NewGuideDialog({ doc, onClose }: { doc: Doc; onClose(): void }) {
  const [axis, setAxis] = useState<'x' | 'y'>('x')
  const [unit, setUnit] = useState<Unit>(() => guidePrefs().get().units)
  const [at, setAt] = useState('0')
  const error = numberError(at, -1e6, 1e6)
  const key = documents().getState().active
  const origin = origins().get(key)
  const px = error ? null : origin[axis === 'x' ? 0 : 1] + toPx(parseNumber(at)!, unit, doc.resolution)
  // Shown on the canvas as it's typed.
  useEffect(() => {
    if (!key) return
    if (px === null) clearToolOverlay(key)
    else setToolOverlay(key, { shapes: [{ kind: 'guide', axis, at: px }] })
    return () => clearToolOverlay(key)
  }, [key, axis, px])
  return (
    <Dialog id="newGuide" title="New Guide" onClose={onClose} footer={<Footer form="new-guide-form" primary="Add Guide" onCancel={onClose} disabled={!!error} />}>
      <form
        id="new-guide-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (px === null) return
          onClose()
          documents().commit((x) => addGuides(x, [{ axis, at: px }]), { label: 'New Guide' })
        }}
      >
        <Field id="guide-axis" label="Orientation">
          <select id="guide-axis" value={axis} onChange={(e) => setAxis(e.target.value as 'x' | 'y')}>
            <option value="x">Vertical</option>
            <option value="y">Horizontal</option>
          </select>
        </Field>
        <Field id="guide-at" label="Position" error={error}>
          <div className="field-row">
            <input id="guide-at" inputMode="decimal" value={at} onChange={(e) => setAt(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
            <UnitSelect id="guide-unit" value={unit} onChange={setUnit} />
          </div>
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

/** New Guide Layout's settings, as typed. */
interface LayoutForm {
  columns: boolean
  cols: string
  colWidth: string
  colGutter: string
  rows: boolean
  rowCount: string
  rowHeight: string
  rowGutter: string
  margins: boolean
  top: string
  left: string
  bottom: string
  right: string
  clear: boolean
}

const START: LayoutForm = { columns: true, cols: '8', colWidth: '', colGutter: '20', rows: false, rowCount: '4', rowHeight: '', rowGutter: '20', margins: false, top: '0', left: '0', bottom: '0', right: '0', clear: true }

export function GuideLayoutDialog({ doc, onClose }: { doc: Doc; onClose(): void }) {
  const [f, setF] = useState<LayoutForm>(START)
  const [unit, setUnit] = useState<Unit>(() => guidePrefs().get().units)
  const set = (patch: Partial<LayoutForm>) => setF((x) => ({ ...x, ...patch }))
  const key = documents().getState().active
  const len = (s: string) => (s.trim() === '' ? 0 : toPx(parseNumber(s) ?? NaN, unit, doc.resolution))
  const count = (s: string) => {
    const n = parseNumber(s)
    return n !== null && Number.isInteger(n) && n >= 0 && n <= 200 ? n : NaN
  }
  const layout: GuideLayout = {
    columns: { count: f.columns ? count(f.cols) : 0, width: f.columns ? len(f.colWidth) : 0, gutter: f.columns ? len(f.colGutter) : 0 },
    rows: { count: f.rows ? count(f.rowCount) : 0, height: f.rows ? len(f.rowHeight) : 0, gutter: f.rows ? len(f.rowGutter) : 0 },
    margin: f.margins ? { top: len(f.top), left: len(f.left), bottom: len(f.bottom), right: len(f.right) } : { top: 0, left: 0, bottom: 0, right: 0 },
  }
  const bad = [layout.columns.count, layout.columns.width, layout.columns.gutter, layout.rows.count, layout.rows.height, layout.rows.gutter, ...Object.values(layout.margin)].some((v) => !Number.isFinite(v) || v < 0)
  const guides = bad ? [] : layoutGuides(layout, doc.width, doc.height)
  const error = bad ? 'Each value is a number, zero or more; counts are whole numbers up to 200.' : null
  useEffect(() => {
    if (!key) return
    setToolOverlay(key, { shapes: guides.map((g) => ({ kind: 'guide', axis: g.axis, at: g.at })) })
    return () => clearToolOverlay(key)
  }, [key, JSON.stringify(guides)])
  const lenField = (id: string, label: string, k: keyof LayoutForm, placeholder = '') => (
    <Field id={id} label={label}>
      <input id={id} inputMode="decimal" value={f[k] as string} placeholder={placeholder} onChange={(e) => set({ [k]: e.target.value })} onFocus={(e) => e.target.select()} />
    </Field>
  )
  return (
    <Dialog id="guideLayout" title="New Guide Layout" onClose={onClose} footer={<Footer form="guide-layout-form" primary="Add Guides" onCancel={onClose} disabled={!!error || !guides.length} />}>
      <form
        id="guide-layout-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (error || !guides.length) return
          onClose()
          documents().commit((x) => addGuides(f.clear ? clearGuides(x) : x, guides), { label: 'New Guide Layout' })
        }}
      >
        <Field id="layout-unit" label="Units">
          <UnitSelect id="layout-unit" value={unit} onChange={setUnit} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={f.columns} data-layout="columns" onChange={(e) => set({ columns: e.target.checked })} />
          Columns
        </label>
        {f.columns && (
          <div className="field-grid">
            {lenField('layout-cols', 'Number', 'cols')}
            {lenField('layout-col-width', 'Width', 'colWidth', 'fill')}
            {lenField('layout-col-gutter', 'Gutter', 'colGutter')}
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={f.rows} data-layout="rows" onChange={(e) => set({ rows: e.target.checked })} />
          Rows
        </label>
        {f.rows && (
          <div className="field-grid">
            {lenField('layout-rows', 'Number', 'rowCount')}
            {lenField('layout-row-height', 'Height', 'rowHeight', 'fill')}
            {lenField('layout-row-gutter', 'Gutter', 'rowGutter')}
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={f.margins} data-layout="margins" onChange={(e) => set({ margins: e.target.checked })} />
          Margins
        </label>
        {f.margins && (
          <div className="field-grid">
            {lenField('layout-top', 'Top', 'top')}
            {lenField('layout-left', 'Left', 'left')}
            {lenField('layout-bottom', 'Bottom', 'bottom')}
            {lenField('layout-right', 'Right', 'right')}
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={f.clear} onChange={(e) => set({ clear: e.target.checked })} />
          Clear existing guides
        </label>
        {error ? (
          <span className="field-error" role="alert">
            {error}
          </span>
        ) : (
          <p className="field-meta">
            {guides.length} guide{guides.length === 1 ? '' : 's'} <Hint text="A width or height left empty shares the space out; one given is used as it is, and the columns are centred." />
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

export function GuideSettingsDialog({ onClose }: { onClose(): void }) {
  const p = useSyncExternalStore(guidePrefs().subscribe, guidePrefs().get)
  const set = (change: Partial<GuidePrefs>) => guidePrefs().update(change)
  const [every, setEvery] = useState(String(p.gridEvery))
  const everyError = numberError(every, 0.001, 100000)
  const colour = (id: string, label: string, k: 'guideColour' | 'gridColour' | 'smartColour') => (
    <Field id={id} label={label}>
      <HexColourChip id={id} value={p[k]} label={label} onChange={(v) => set({ [k]: v })} />
    </Field>
  )
  return (
    <Dialog
      id="guideSettings"
      title="Guides, Grid & Snapping"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" disabled={JSON.stringify(p) === JSON.stringify(DEFAULT_GUIDE_PREFS)} data-why="Every setting is already its default" onClick={() => {
            guidePrefs().update(DEFAULT_GUIDE_PREFS)
            setEvery(String(DEFAULT_GUIDE_PREFS.gridEvery))
          }}>
            Restore Defaults
          </button>
          <button type="button" className="button primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="form">
        <Field id="pref-units" label="Ruler units">
          <UnitSelect id="pref-units" value={p.units} onChange={(u) => set({ units: u })} />
        </Field>
        {colour('pref-guide-colour', 'Guide colour', 'guideColour')}
        {colour('pref-smart-colour', 'Smart guide colour', 'smartColour')}
        {colour('pref-grid-colour', 'Grid colour', 'gridColour')}
        <Field id="pref-grid-every" label="Gridline every" error={everyError}>
          <div className="field-row">
            <input
              id="pref-grid-every"
              inputMode="decimal"
              value={every}
              onChange={(e) => {
                setEvery(e.target.value)
                const n = parseNumber(e.target.value)
                if (n !== null && n >= 0.001 && n <= 100000) set({ gridEvery: n })
              }}
            />
            <UnitSelect id="pref-grid-unit" value={p.gridUnit} onChange={(u) => set({ gridUnit: u })} />
          </div>
        </Field>
        <Field id="pref-grid-sub" label="Subdivisions">
          <select id="pref-grid-sub" value={p.gridSub} onChange={(e) => set({ gridSub: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5, 6, 8, 10, 12, 16].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <fieldset className="pref-group">
          <legend>
            <label className="check">
              <input type="checkbox" checked={p.snap} data-pref="snap" onChange={(e) => set({ snap: e.target.checked })} />
              Snap to
            </label>
            <Hint text="Guides and the grid snap only while they’re shown. Hold Ctrl while dragging to let go of snapping." />
          </legend>
          {SNAP_TARGETS.map((t) => (
            <label key={t.id} className="check pref-check">
              <input type="checkbox" checked={p.snapTo[t.id]} disabled={!p.snap} data-snap={t.id} onChange={() => guidePrefs().toggleSnapTo(t.id)} />
              {t.label}
            </label>
          ))}
        </fieldset>
      </div>
    </Dialog>
  )
}
