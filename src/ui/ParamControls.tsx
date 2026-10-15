/**
 * Controls for parameters (doc/params.ts), generated from a registry
 * entry's list: what Properties shows for an adjustment or a live filter,
 * and what the Filter and Layer Style dialogs show. Numbers get a slider
 * bar (ui/controls.tsx), switches a checkbox, a few short choices buttons
 * side by side and longer lists a dropdown, colours a chip; Curves, Levels
 * and gradients get editors of their own. A parameter's hint is an ⓘ by its
 * label.
 *
 * `onChange` gets the whole set of values and the key of the control
 * that changed, so the caller can fold a drag of one control into one
 * history step.
 */
import { useEffect, useRef, useState } from 'react'
import { curveFn, gradientAt, levelsFn } from '../adjust/defs'
import { CHANNELS, type CurvePoints, type GradientStop, type LevelsValue, type ParamColour, type ParamDef } from '../doc/params'
import type { Doc } from '../doc/types'
import { engine } from '../engine/EngineHost'
import { DocColourChip } from './ColourChip'
import { Icon } from './Icon'
import { notify } from '../app/notices'
import { Hint, Label, Segmented, SliderField } from './controls'

type Mode = 'rgb' | 'gray' | 'cmyk'

interface Props {
  defs: readonly ParamDef[]
  values: Record<string, unknown>
  doc: Doc
  /** The document's key, for its histogram. */
  docKey: string
  onChange(values: Record<string, unknown>, key: string): void
  /** Prefix for element ids, so two sets of controls can share a page. */
  idPrefix: string
}

export function ParamControls({ defs, values, doc, docKey, onChange, idPrefix }: Props) {
  const set = (key: string, v: unknown) => onChange({ ...values, [key]: v }, key)
  return (
    <div className="param-controls">
      {defs.map((d) => {
        const id = `${idPrefix}-${d.key}`
        if (d.when && !d.when(values)) return null
        switch (d.kind) {
          case 'number':
            return <NumberParam key={d.key} id={id} def={d} value={values[d.key] as number} onChange={(v) => set(d.key, v)} />
          case 'bool':
            return (
              <label key={d.key} className="check">
                <input id={id} type="checkbox" checked={!!values[d.key]} onChange={(e) => set(d.key, e.target.checked)} />
                {d.label}
                <Hint text={d.hint} />
              </label>
            )
          case 'choice':
            // A few short ones side by side; a longer list in a menu.
            if (d.options.length <= 3 && d.options.every(([, l]) => l.length <= 12)) return <Segmented key={d.key} id={id} label={d.label} hint={d.hint} value={values[d.key] as string} options={d.options} onChange={(v) => set(d.key, v)} defaultValue={d.default} />
            return (
              <div key={d.key} className="field">
                <Label htmlFor={id} hint={d.hint}>
                  {d.label}
                </Label>
                <select id={id} value={values[d.key] as string} onChange={(e) => set(d.key, e.target.value)}>
                  {d.options.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            )
          case 'colour':
            return <ColourParam key={d.key} id={id} label={d.label} value={values[d.key] as ParamColour} doc={doc} onChange={(v) => set(d.key, v)} />
          case 'curves':
            return <CurvesEditor key={d.key} id={id} mode={doc.mode} value={values[d.key] as Record<string, CurvePoints>} onChange={(v) => set(d.key, v)} />
          case 'levels':
            return <LevelsEditor key={d.key} id={id} mode={doc.mode} docKey={docKey} value={values[d.key] as Record<string, LevelsValue>} onChange={(v) => set(d.key, v)} />
          case 'gradient':
            return <GradientEditor key={d.key} id={id} doc={doc} value={values[d.key] as GradientStop[]} onChange={(v) => set(d.key, v)} />
          case 'pattern':
            return (
              <div key={d.key} className="field">
                <Label htmlFor={id} hint={d.hint}>
                  {d.label}
                </Label>
                {doc.patterns?.length ? (
                  <select id={id} value={(values[d.key] as string | null) ?? ''} onChange={(e) => set(d.key, e.target.value || null)}>
                    <option value="">None</option>
                    {doc.patterns.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="field-empty">
                    No patterns yet <Hint text="Edit → Define Pattern makes one from a selection." />
                  </span>
                )}
              </div>
            )
          case 'file':
            return <FileParam key={d.key} id={id} def={d} value={values[d.key]} onChange={(v) => set(d.key, v)} />
          case 'wheel':
            return <WheelParam key={d.key} id={id} label={d.label} hint={d.hint} value={values[d.key] as [number, number]} onChange={(v) => set(d.key, v)} />
        }
      })}
    </div>
  )
}

/** Data from a file: a button to load one, and its name. */
function FileParam({ id, def, value, onChange }: { id: string; def: Extract<ParamDef, { kind: 'file' }>; value: unknown; onChange(v: unknown): void }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="field" data-tip={def.hint}>
      <label htmlFor={id}>{def.label}</label>
      <div className="slider-row">
        <span className="field-meta" data-file-name>
          {def.describe(value)}
        </span>
        <button type="button" className="button small" id={id} onClick={() => input.current?.click()}>
          Load…
        </button>
        <input
          ref={input}
          type="file"
          accept={def.accept}
          hidden
          data-file-input
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            const v = def.load(await f.text(), f.name) as { error?: string }
            if (v && typeof v === 'object' && 'error' in v && v.error) return notify('error', `“${f.name}” couldn’t be used.`, [v.error])
            onChange(v)
          }}
        />
      </div>
    </div>
  )
}

/** A colour wheel: drag the dot from the middle towards a hue, further for more. */
function WheelParam({ id, label, hint, value, onChange }: { id: string; label: string; hint?: string; value: [number, number]; onChange(v: [number, number]): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [hue, amount] = value
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width - 0.5
    const y = (e.clientY - r.top) / r.height - 0.5
    const h = ((Math.atan2(-y, x) * 180) / Math.PI + 360) % 360
    onChange([Math.round(h), Math.round(Math.min(1, Math.hypot(x, y) * 2) * 100)])
  }
  const a = (hue * Math.PI) / 180
  const d = (amount / 100) * 50
  return (
    <div className="field wheel-field">
      <Label htmlFor={id} hint={hint}>
        {label}
      </Label>
      <div className="slider-row">
        <div
          ref={ref}
          id={id}
          className="colour-wheel"
          role="slider"
          tabIndex={0}
          aria-label={`${label}: hue ${hue}°, ${amount}%`}
          aria-valuenow={amount}
          data-wheel
          onPointerDown={(e) => {
            ;(e.target as Element).setPointerCapture(e.pointerId)
            at(e)
          }}
          onPointerMove={(e) => e.buttons && at(e)}
          onDoubleClick={() => onChange([0, 0])}
        >
          <span className="colour-wheel-dot" style={{ left: `${50 + d * Math.cos(a)}%`, top: `${50 - d * Math.sin(a)}%` }} />
        </div>
        <span className="slider-number">
          {hue}° {amount}%
        </span>
      </div>
    </div>
  )
}

export function NumberParam({ id, def, value, onChange }: { id: string; def: Extract<ParamDef, { kind: 'number' }>; value: number; onChange(v: number): void }) {
  return <SliderField id={id} label={def.label} hint={def.hint} min={def.min} max={def.max} step={def.step} unit={def.unit} value={value} onChange={onChange} defaultValue={Number.isFinite(def.default) ? def.default : undefined} />
}

/** A colour in a document's terms, roughly as the screen shows it, for a swatch. */
export function swatchCss(c: ParamColour, mode: Mode): string {
  const to = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255)
  if (mode === 'gray') return `rgb(${to(c[0])}, ${to(c[0])}, ${to(c[0])})`
  if (mode === 'cmyk') return `rgb(${to((1 - c[0]) * (1 - c[3]))}, ${to((1 - c[1]) * (1 - c[3]))}, ${to((1 - c[2]) * (1 - c[3]))})`
  return `rgb(${to(c[0])}, ${to(c[1])}, ${to(c[2])})`
}

/** A colour setting: its chip, which opens the colour picker (ui/ColourChip.tsx). */
export function ColourParam({ id, label, value, doc, onChange }: { id: string; label: string; value: ParamColour; doc: Doc; onChange(v: ParamColour): void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="slider-row">
        <DocColourChip id={id} value={value} doc={doc} label={label} onChange={onChange} data={{ 'param-colour': id }} />
      </div>
    </div>
  )
}

const channelLabel = (c: string) => (c === 'master' ? 'All channels' : c[0].toUpperCase() + c.slice(1))

const CURVE_SIZE = 220

/**
 * Curves: drag a point, click the curve to add one, drag a point off the
 * square (or double-click it) to take it away. Each channel has its own.
 */
function CurvesEditor({ id, mode, value, onChange }: { id: string; mode: Mode; value: Record<string, CurvePoints>; onChange(v: Record<string, CurvePoints>): void }) {
  const [channel, setChannel] = useState('master')
  const [dragging, setDragging] = useState<number | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const pts = value[channel] ?? [
    [0, 0],
    [1, 1],
  ]
  const fn = curveFn(pts)
  const path = Array.from({ length: 65 }, (_, i) => {
    const x = i / 64
    return `${i ? 'L' : 'M'}${x * CURVE_SIZE},${(1 - fn(x)) * CURVE_SIZE}`
  }).join(' ')
  const pointAt = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svg.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height]
  }
  const setPts = (next: CurvePoints) => onChange({ ...value, [channel]: next })
  return (
    <div className="field curves" data-editor="curves">
      <label htmlFor={`${id}-channel`}>Curves</label>
      {CHANNELS[mode].length > 1 && (
        <select id={`${id}-channel`} value={channel} onChange={(e) => setChannel(e.target.value)}>
          {CHANNELS[mode].map((c) => (
            <option key={c} value={c}>
              {channelLabel(c)}
            </option>
          ))}
        </select>
      )}
      <svg
        ref={svg}
        className="curve-box"
        viewBox={`0 0 ${CURVE_SIZE} ${CURVE_SIZE}`}
        data-curve={id}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget && !(e.target as Element).classList.contains('curve-line')) return
          const [x, y] = pointAt(e)
          const next = [...pts, [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))] as [number, number]].sort((a, b) => a[0] - b[0])
          setPts(next)
          setDragging(next.findIndex((p) => p[0] === Math.min(1, Math.max(0, x))))
          ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (dragging === null) return
          const [x, y] = pointAt(e)
          const off = x < -0.08 || x > 1.08 || y < -0.08 || y > 1.08
          if (off && pts.length > 2 && dragging > 0 && dragging < pts.length - 1) {
            setPts(pts.filter((_, i) => i !== dragging))
            setDragging(null)
            return
          }
          // A point stays between its neighbours.
          const lo = dragging > 0 ? pts[dragging - 1][0] + 0.01 : 0
          const hi = dragging < pts.length - 1 ? pts[dragging + 1][0] - 0.01 : 1
          const next = pts.map((p, i) => (i === dragging ? ([Math.min(hi, Math.max(lo, x)), Math.min(1, Math.max(0, y))] as [number, number]) : p))
          setPts(next)
        }}
        onPointerUp={() => setDragging(null)}
      >
        {[1, 2, 3].map((k) => (
          <g key={k} className="curve-grid">
            <line x1={(k * CURVE_SIZE) / 4} y1={0} x2={(k * CURVE_SIZE) / 4} y2={CURVE_SIZE} />
            <line x1={0} y1={(k * CURVE_SIZE) / 4} x2={CURVE_SIZE} y2={(k * CURVE_SIZE) / 4} />
          </g>
        ))}
        <line className="curve-diagonal" x1={0} y1={CURVE_SIZE} x2={CURVE_SIZE} y2={0} />
        <path className="curve-line" d={path} />
        {pts.map(([x, y], i) => (
          <circle
            key={i}
            className="curve-point"
            cx={x * CURVE_SIZE}
            cy={(1 - y) * CURVE_SIZE}
            r={5}
            data-point={i}
            onPointerDown={(e) => {
              e.stopPropagation()
              setDragging(i)
              ;(svg.current as Element).setPointerCapture(e.pointerId)
            }}
            onDoubleClick={() => pts.length > 2 && i > 0 && i < pts.length - 1 && setPts(pts.filter((_, j) => j !== i))}
          />
        ))}
      </svg>
      <button type="button" className="button small" onClick={() => setPts([[0, 0], [1, 1]])}>
        Reset {channelLabel(channel)}
      </button>
    </div>
  )
}

/** Levels: the histogram of the document, input black, gamma and white, and the output range, per channel. */
function LevelsEditor({ id, mode, docKey, value, onChange }: { id: string; mode: Mode; docKey: string; value: Record<string, LevelsValue>; onChange(v: Record<string, LevelsValue>): void }) {
  const [channel, setChannel] = useState('master')
  const [hist, setHist] = useState<number[][] | null>(null)
  useEffect(() => {
    let live = true
    void engine()
      .call('render.histogram', { key: docKey })
      .then((h) => live && setHist(h))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [docKey])
  const l = value[channel]
  const set = (patch: Partial<LevelsValue>) => onChange({ ...value, [channel]: { ...l, ...patch } })
  const chIndex = CHANNELS[mode].indexOf(channel) - 1
  const bins = hist && hist.length ? (chIndex >= 0 ? hist[chIndex] : hist[0].map((_, i) => hist.reduce((a, h) => a + h[i], 0) / hist.length)) : null
  const peak = bins ? Math.max(1, ...bins) : 1
  const curve = levelsFn(l)
  const pct = (v: number) => Math.round(v * 255)
  const field = (key: keyof LevelsValue, label: string, min: number, max: number, scale: number, step = 1) => (
    <label className="levels-field">
      <span>{label}</span>
      <input
        id={`${id}-${key}`}
        type="number"
        min={min}
        max={max}
        step={step}
        value={key === 'gamma' ? l.gamma.toFixed(2) : pct(l[key])}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) set({ [key]: Math.min(max, Math.max(min, n)) / scale })
        }}
      />
    </label>
  )
  return (
    <div className="field levels" data-editor="levels">
      <label htmlFor={`${id}-channel`}>Levels</label>
      {CHANNELS[mode].length > 1 && (
        <select id={`${id}-channel`} value={channel} onChange={(e) => setChannel(e.target.value)}>
          {CHANNELS[mode].map((c) => (
            <option key={c} value={c}>
              {channelLabel(c)}
            </option>
          ))}
        </select>
      )}
      <svg className="histogram" viewBox="0 0 256 80" preserveAspectRatio="none" data-histogram={bins ? 'ready' : 'pending'}>
        {bins && <path className="histogram-bars" d={bins.map((b, i) => `M${i + 0.5},80 V${80 - (b / peak) * 78}`).join(' ')} />}
        <path className="histogram-curve" d={Array.from({ length: 33 }, (_, i) => `${i ? 'L' : 'M'}${(i / 32) * 256},${80 - curve(i / 32) * 78}`).join(' ')} />
      </svg>
      <div className="levels-row">
        {field('inBlack', 'Black', 0, 253, 255)}
        {field('gamma', 'Gamma', 0.1, 9.99, 1, 0.01)}
        {field('inWhite', 'White', 2, 255, 255)}
      </div>
      <div className="levels-row">
        {field('outBlack', 'Output black', 0, 255, 255)}
        {field('outWhite', 'Output white', 0, 255, 255)}
      </div>
    </div>
  )
}

/** A gradient: its bar, and its stops, each given a colour (its chip), moved, or taken away. */
function GradientEditor({ id, doc, value, onChange }: { id: string; doc: Doc; value: GradientStop[]; onChange(v: GradientStop[]): void }) {
  const css = `linear-gradient(to right, ${Array.from({ length: 11 }, (_, i) => `${swatchCss(gradientAt(value, i / 10), doc.mode)} ${i * 10}%`).join(', ')})`
  return (
    <div className="field gradient" data-editor="gradient">
      <label htmlFor={`${id}-0`}>Gradient</label>
      <div className="gradient-bar" style={{ background: css }} />
      {value.map((s, i) => (
        <div className="gradient-stop" key={i}>
          <DocColourChip value={s.colour} doc={doc} label={`Stop ${i + 1} colour`} onChange={(c) => onChange(value.map((x, j) => (j === i ? { ...x, colour: c } : x)))} />
          <input
            id={`${id}-${i}`}
            type="number"
            aria-label={`Stop ${i + 1} position, percent`}
            min={0}
            max={100}
            value={Math.round(s.at * 100)}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (!Number.isFinite(n)) return
              onChange(value.map((x, j) => (j === i ? { ...x, at: Math.min(100, Math.max(0, n)) / 100 } : x)).sort((a, b) => a.at - b.at))
            }}
          />
          <button type="button" className="button small" disabled={value.length <= 2} aria-label={`Remove stop ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Icon name="ui.close" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button small"
        onClick={() => {
          const at = 0.5
          onChange([...value, { at, colour: gradientAt(value, at) }].sort((a, b) => a.at - b.at))
        }}
      >
        Add Stop
      </button>
    </div>
  )
}
