/**
 * The dialogs that make and change documents: New, Canvas Size,
 * Resolution, Rename, Open Recent, and the question asked when a document
 * with unsaved changes is closed.
 *
 * Each is a form, so Enter does what the primary button does, and each
 * checks its own fields as they're typed: a value that can't be used says
 * why under the field, and the primary button waits until every field is
 * usable.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { Anchor, NewDocOptions } from '../doc/edit'
import type { Background } from '../app/files'
import { builtinsFor } from '../color/profiles'
import { DEFAULT_PRESET, PRESETS, type Preset } from '../doc/presets'
import { MAX_RESOLUTION, MAX_SIDE, MIN_RESOLUTION, type ColourMode, type Depth, type Doc } from '../doc/types'
import { UNITS, formatLength, toPixels, type Unit } from '../doc/units'
import { recentFiles, type RecentFile } from '../io/handles'
import { Dialog } from './Dialog'
import { Label } from './controls'
import { Hint } from './controls'

// --- fields ------------------------------------------------------------------

export function Field({ id, label, error, children, hint }: { id: string; label: string; error?: string | null; children: ReactNode; hint?: string }) {
  return (
    <div className="field">
      <Label htmlFor={id} hint={hint}>
        {label}
      </Label>
      {children}
      {error && (
        <span className="field-error" id={`${id}-error`} role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

export const parseNumber = (s: string) => {
  const n = Number(s.trim().replace(',', '.'))
  return s.trim() && Number.isFinite(n) ? n : null
}

/** A length in the chosen unit, checked as pixels against the document limits. */
function sideError(text: string, unit: Unit, ppi: number): string | null {
  const n = parseNumber(text)
  if (n === null) return 'Enter a number.'
  if (n <= 0) return 'Must be more than 0.'
  const px = toPixels(n, unit, ppi)
  if (px < 1) return 'Comes to less than one pixel.'
  if (px > MAX_SIDE) return `Comes to ${px.toLocaleString()} px; the most is ${MAX_SIDE.toLocaleString()}.`
  return null
}

function ppiError(text: string): string | null {
  const n = parseNumber(text)
  if (n === null) return 'Enter a number.'
  if (n < MIN_RESOLUTION || n > MAX_RESOLUTION) return `Between ${MIN_RESOLUTION} and ${MAX_RESOLUTION.toLocaleString()}.`
  return null
}

export function UnitSelect({ id, value, onChange }: { id: string; value: Unit; onChange(u: Unit): void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value as Unit)} aria-label="Units">
      {UNITS.map((u) => (
        <option key={u.id} value={u.id}>
          {u.label}
        </option>
      ))}
    </select>
  )
}

export function Footer({ form, primary, onCancel, disabled }: { form: string; primary: string; onCancel(): void; disabled?: boolean }) {
  return (
    <>
      <button type="button" className="button" onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" form={form} className="button primary" disabled={disabled}>
        {primary}
      </button>
    </>
  )
}

// --- New -----------------------------------------------------------------------

const MODE_NAMES: Record<ColourMode, string> = { rgb: 'RGB', gray: 'Gray', cmyk: 'CMYK' }

const BACKGROUNDS: { id: Background; name: string }[] = [
  { id: 'white', name: 'White' },
  { id: 'black', name: 'Black' },
  { id: 'background', name: 'Background colour' },
  { id: 'transparent', name: 'Transparent' },
]

export function NewDocDialog({ onCreate, onClose }: { onCreate(o: NewDocOptions, background: Background, artboard: boolean): void; onClose(): void }) {
  const [background, setBackground] = useState<Background>('white')
  const [artboard, setArtboard] = useState(false)
  const [preset, setPreset] = useState<string>(DEFAULT_PRESET.id)
  const [name, setName] = useState('Untitled')
  const [unit, setUnit] = useState<Unit>(DEFAULT_PRESET.unit)
  const [width, setWidth] = useState(String(DEFAULT_PRESET.width))
  const [height, setHeight] = useState(String(DEFAULT_PRESET.height))
  const [ppi, setPpi] = useState(String(DEFAULT_PRESET.resolution))
  const [mode, setMode] = useState<ColourMode>(DEFAULT_PRESET.mode)
  const [depth, setDepth] = useState<Depth>(DEFAULT_PRESET.depth)
  const [profile, setProfile] = useState(builtinsFor(DEFAULT_PRESET.mode)[0].id)

  const apply = (p: Preset) => {
    setPreset(p.id)
    setUnit(p.unit)
    setWidth(String(p.width))
    setHeight(String(p.height))
    setPpi(String(p.resolution))
    setMode(p.mode)
    setDepth(p.depth)
    setProfile(builtinsFor(p.mode)[0].id)
  }
  // Any change by hand means the fields no longer match a preset.
  const custom = () => setPreset('custom')

  /** Changing units converts what's typed, rather than reinterpreting the number. */
  const changeUnit = (u: Unit) => {
    const r = parseNumber(ppi) ?? 72
    const w = parseNumber(width)
    const h = parseNumber(height)
    if (w !== null) setWidth(formatLength(toPixels(w, unit, r), u, r))
    if (h !== null) setHeight(formatLength(toPixels(h, unit, r), u, r))
    setUnit(u)
  }

  const r = parseNumber(ppi) ?? 72
  const errors = { width: sideError(width, unit, r), height: sideError(height, unit, r), ppi: ppiError(ppi) }
  const ok = !errors.width && !errors.height && !errors.ppi
  const px = ok ? { w: toPixels(parseNumber(width)!, unit, r), h: toPixels(parseNumber(height)!, unit, r) } : null

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!px) return
    onCreate({ name, width: px.w, height: px.h, resolution: r, mode, depth, profile: { builtin: profile } }, background, artboard)
  }

  return (
    <Dialog id="new" title="New Document" onClose={onClose} footer={<Footer form="new-form" primary="Create" onCancel={onClose} disabled={!ok} />}>
      <form id="new-form" className="form" onSubmit={submit}>
        <Field id="new-preset" label="Preset">
          <select
            id="new-preset"
            value={preset}
            onChange={(e) => {
              const p = PRESETS.find((x) => x.id === e.target.value)
              if (p) apply(p)
            }}
          >
            {(['Screen', 'Print', 'Photo'] as const).map((g) => (
              <optgroup key={g} label={g}>
                {PRESETS.filter((p) => p.group === g).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            ))}
            <option value="custom">Custom</option>
          </select>
        </Field>
        <Field id="new-name" label="Name">
          <input id="new-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
        </Field>
        <div className="field-row">
          <Field id="new-width" label="Width" error={errors.width}>
            <input id="new-width" inputMode="decimal" value={width} aria-invalid={!!errors.width} onChange={(e) => {
              setWidth(e.target.value)
              custom()
            }} />
          </Field>
          <Field id="new-height" label="Height" error={errors.height}>
            <input id="new-height" inputMode="decimal" value={height} aria-invalid={!!errors.height} onChange={(e) => {
              setHeight(e.target.value)
              custom()
            }} />
          </Field>
          <Field id="new-unit" label="Units">
            <UnitSelect id="new-unit" value={unit} onChange={changeUnit} />
          </Field>
        </div>
        <Field id="new-ppi" label="Resolution (pixels per inch)" error={errors.ppi}>
          <input id="new-ppi" inputMode="decimal" value={ppi} aria-invalid={!!errors.ppi} onChange={(e) => {
              setPpi(e.target.value)
              custom()
            }} />
        </Field>
        <div className="field-row">
          <Field id="new-mode" label="Colour mode">
            <select
              id="new-mode"
              value={mode}
              onChange={(e) => {
                const m = e.target.value as ColourMode
                setMode(m)
                setProfile(builtinsFor(m)[0].id)
                custom()
              }}
            >
              {(Object.keys(MODE_NAMES) as ColourMode[]).map((m) => (
                <option key={m} value={m}>
                  {MODE_NAMES[m]}
                </option>
              ))}
            </select>
          </Field>
          <Field id="new-depth" label="Bit depth">
            <select id="new-depth" value={depth} onChange={(e) => {
              setDepth(Number(e.target.value) as Depth)
              custom()
            }}>
              <option value={8}>8 bits per channel</option>
              <option value={16}>16 bits per channel</option>
            </select>
          </Field>
        </div>
        <Field id="new-profile" label="Colour profile">
          <select id="new-profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
            {builtinsFor(mode).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="new-background" label="Background contents">
          <select id="new-background" value={background} onChange={(e) => setBackground(e.target.value as Background)}>
            {BACKGROUNDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="check">
          <input type="checkbox" id="new-artboard" checked={artboard} onChange={(e) => setArtboard(e.target.checked)} />
          Artboard
          <Hint text="The document starts as an artboard this size on a pasteboard, as Photoshop’s Artboards option does: more can be added beside it (Layer → Artboards, or the Artboard tool, V)." />
        </label>
        <p className="form-summary" data-summary>
          {px ? `${px.w.toLocaleString()} × ${px.h.toLocaleString()} pixels, ${MODE_NAMES[mode]} ${depth}-bit` : 'Fix the fields above to see the size.'}
        </p>
        {/* So Enter in any field submits, though the visible button is in the footer. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

// --- Canvas Size ------------------------------------------------------------------

const ANCHORS: Anchor[] = [0, 0.5, 1].flatMap((y) => [0, 0.5, 1].map((x) => ({ x, y }) as Anchor))
const anchorName = (a: Anchor) =>
  `${a.y === 0 ? 'top' : a.y === 1 ? 'bottom' : 'middle'} ${a.x === 0 ? 'left' : a.x === 1 ? 'right' : 'centre'}`.replace('middle centre', 'centre')

export function CanvasSizeDialog({ doc, onApply, onClose }: { doc: Doc; onApply(w: number, h: number, a: Anchor): void; onClose(): void }) {
  const [unit, setUnit] = useState<Unit>('px')
  const [width, setWidth] = useState(String(doc.width))
  const [height, setHeight] = useState(String(doc.height))
  const [anchor, setAnchor] = useState<Anchor>({ x: 0.5, y: 0.5 })
  const ppi = doc.resolution
  const errors = { width: sideError(width, unit, ppi), height: sideError(height, unit, ppi) }
  const ok = !errors.width && !errors.height

  const changeUnit = (u: Unit) => {
    const w = parseNumber(width)
    const h = parseNumber(height)
    if (w !== null) setWidth(formatLength(toPixels(w, unit, ppi), u, ppi))
    if (h !== null) setHeight(formatLength(toPixels(h, unit, ppi), u, ppi))
    setUnit(u)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ok) onApply(toPixels(parseNumber(width)!, unit, ppi), toPixels(parseNumber(height)!, unit, ppi), anchor)
  }

  return (
    <Dialog id="canvasSize" title="Canvas Size" hint="Layers keep their place against the anchor, and nothing outside the new canvas is deleted." onClose={onClose} footer={<Footer form="canvas-form" primary="Resize Canvas" onCancel={onClose} disabled={!ok} />}>
      <form id="canvas-form" className="form" onSubmit={submit}>
        <p className="field-meta">
          Now {doc.width.toLocaleString()} × {doc.height.toLocaleString()} pixels
        </p>
        <div className="field-row">
          <Field id="canvas-width" label="Width" error={errors.width}>
            <input id="canvas-width" inputMode="decimal" value={width} aria-invalid={!!errors.width} onChange={(e) => setWidth(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
          </Field>
          <Field id="canvas-height" label="Height" error={errors.height}>
            <input id="canvas-height" inputMode="decimal" value={height} aria-invalid={!!errors.height} onChange={(e) => setHeight(e.target.value)} />
          </Field>
          <Field id="canvas-unit" label="Units">
            <UnitSelect id="canvas-unit" value={unit} onChange={changeUnit} />
          </Field>
        </div>
        <div className="field">
          <span id="anchor-label">Anchor</span>
          <div className="anchor-grid" role="radiogroup" aria-labelledby="anchor-label">
            {ANCHORS.map((a) => {
              const on = a.x === anchor.x && a.y === anchor.y
              return (
                <button
                  key={`${a.x}-${a.y}`}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={anchorName(a)}
                  data-anchor={`${a.x},${a.y}`}
                  className={`anchor${on ? ' on' : ''}`}
                  onClick={() => setAnchor(a)}
                />
              )
            })}
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

// --- Resolution -------------------------------------------------------------------

export function ResolutionDialog({ doc, onApply, onClose }: { doc: Doc; onApply(ppi: number): void; onClose(): void }) {
  const [ppi, setPpi] = useState(String(doc.resolution))
  const error = ppiError(ppi)
  const n = parseNumber(ppi)
  const inches = !error && n ? `${formatLength(doc.width, 'in', n)} × ${formatLength(doc.height, 'in', n)} in, ${formatLength(doc.width, 'mm', n)} × ${formatLength(doc.height, 'mm', n)} mm` : ''
  return (
    <Dialog id="resolution" title="Resolution" hint="The pixels stay as they are. The resolution says how big they print." onClose={onClose} footer={<Footer form="ppi-form" primary="Set Resolution" onCancel={onClose} disabled={!!error} />}>
      <form
        id="ppi-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!error) onApply(n!)
        }}
      >
        <Field id="ppi" label="Pixels per inch" error={error}>
          <input id="ppi" inputMode="decimal" value={ppi} aria-invalid={!!error} onChange={(e) => setPpi(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
        </Field>
        <p className="form-summary">{inches ? `Prints at ${inches}.` : ' '}</p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

// --- Rename -------------------------------------------------------------------------

export function RenameDocDialog({ doc, onApply, onClose }: { doc: Doc; onApply(name: string): void; onClose(): void }) {
  const [name, setName] = useState(doc.name)
  const blank = !name.trim()
  return (
    <Dialog id="renameDoc" title="Rename Document" hint="The name inside the document. Its file keeps its own name until you Save As." onClose={onClose} footer={<Footer form="rename-form" primary="Rename" onCancel={onClose} disabled={blank} />}>
      <form
        id="rename-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!blank) onApply(name)
        }}
      >
        <Field id="rename-name" label="Name" error={blank ? 'A document needs a name.' : null}>
          <input id="rename-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

// --- Recent -----------------------------------------------------------------------------

function useRecent(): RecentFile[] | null {
  const [list, setList] = useState<RecentFile[] | null>(null)
  useEffect(() => {
    let live = true
    void recentFiles().then((r) => live && setList(r))
    return () => {
      live = false
    }
  }, [])
  return list
}

const ago = (at: number) => {
  const s = (Date.now() - at) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(at).toLocaleDateString()
}

export function RecentList({ onOpen }: { onOpen(r: RecentFile): void }) {
  const list = useRecent()
  if (!list) return null
  if (!list.length) return <p className="recent-none">Files you open or save appear here.</p>
  return (
    <ul className="recent-list">
      {list.map((r) => (
        <li key={r.handleKey}>
          <button type="button" className="recent-item" data-recent={r.name} onClick={() => onOpen(r)}>
            <span>{r.name}</span>
            <span className="recent-when">{ago(r.at)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function RecentDialog({ onOpen, onClose }: { onOpen(r: RecentFile): void; onClose(): void }) {
  return (
    <Dialog id="recent" title="Open Recent" onClose={onClose}>
      <RecentList
        onOpen={(r) => {
          onClose()
          onOpen(r)
        }}
      />
    </Dialog>
  )
}

// --- unsaved changes ------------------------------------------------------------------------

export function CloseDocDialog({ name, onSave, onDiscard, onClose }: { name: string; onSave(): void; onDiscard(): void; onClose(): void }) {
  const footer = useMemo(
    () => (
      <>
        <button type="button" className="button danger" onClick={onDiscard}>
          Don’t Save
        </button>
        <span className="dialog-foot-gap" />
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="button primary" onClick={onSave}>
          Save
        </button>
      </>
    ),
    [onSave, onDiscard, onClose],
  )
  return (
    <Dialog id="closeDoc" title="Unsaved Changes" onClose={onClose} footer={footer}>
      <p>
        Save the changes to “{name}” before closing it? If you don’t, they are lost.
      </p>
    </Dialog>
  )
}
