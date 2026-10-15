/**
 * Image Trace, as Illustrator's panel: a preset, or the settings one by
 * one (black and white with a threshold, grays or colours with how many;
 * how closely paths follow the pixels, where corners are, how small a
 * speck is noise, a blur for photos, white left out), the result shown on
 * the canvas as it will be, and counted. Trace commits it: a group of
 * shapes above the layer, the layer hidden if asked. The settings are
 * remembered.
 */
import { useEffect, useRef, useState } from 'react'
import { startTrace, type TraceSession } from '../app/imageTrace'
import { TRACE_PRESETS, type TraceMode, type TraceOptions, type TraceResult } from '../trace/trace'
import { Dialog } from './Dialog'
import { Segmented, SliderField } from './controls'

const KEY = 'plexel.imageTrace.v1'

function remembered(): { preset: string; options: TraceOptions; hide: boolean } {
  const d = { preset: 'default', options: TRACE_PRESETS[0].options, hide: true }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (!raw || typeof raw !== 'object') return d
    const o = { ...d.options, ...(raw.options ?? {}) } as TraceOptions
    return { preset: typeof raw.preset === 'string' ? raw.preset : 'custom', options: o, hide: raw.hide !== false }
  } catch {
    return d
  }
}

/** A setting as a slider with its number. */
function Slider({ id, label, value, min, max, step = 1, unit = '', onChange, hint }: { id: string; label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange(v: number): void; hint?: string }) {
  return <SliderField id={id} label={label} hint={hint} min={min} max={max} step={step} unit={unit} value={value} onChange={onChange} />
}

const TRACE_MODES: [TraceMode, string, string][] = [
  ['bw', 'B & W', 'Black and white'],
  ['gray', 'Grays', 'Shades of gray'],
  ['colour', 'Colour', 'Colours'],
]

export function ImageTraceDialog({ onClose }: { onClose(): void }) {
  const start = useState(remembered)[0]
  const [preset, setPreset] = useState(start.preset)
  const [o, setO] = useState<TraceOptions>(start.options)
  const [hide, setHide] = useState(start.hide)
  const [session, setSession] = useState<TraceSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TraceResult | null>(null)
  const [busy, setBusy] = useState(true)
  const sessionRef = useRef<TraceSession | null>(null)
  const committed = useRef(false)

  // The layer read once; let go (and the canvas put back) when the dialog closes without tracing.
  useEffect(() => {
    let live = true
    void startTrace().then((s) => {
      if (!live) {
        if ('trace' in s) s.close()
        return
      }
      if ('error' in s) setError(s.error)
      else {
        sessionRef.current = s
        setSession(s)
      }
    })
    return () => {
      live = false
      if (!committed.current) sessionRef.current?.close()
    }
  }, [])

  // Traced again a moment after the settings stop changing; shown on the canvas.
  useEffect(() => {
    if (!session) return
    setBusy(true)
    let live = true
    const t = setTimeout(() => {
      void session.trace(o).then((r) => {
        if (!live || !r) return
        setResult(r)
        setBusy(false)
        session.preview(r, hide)
      })
    }, 200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [session, o, hide])

  const set = (patch: Partial<TraceOptions>) => {
    setPreset('custom')
    setO((x) => ({ ...x, ...patch }))
  }
  const remember = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ preset, options: o, hide }))
    } catch {
      // Remembered for this time only.
    }
  }
  return (
    <Dialog
      id="imageTrace"
      title="Image Trace"
      floating
      onClose={onClose}
      footer={
        <>
          <span className="sfw-busy" aria-live="polite" data-trace-stats>
            {error ?? (busy || !result ? 'Tracing…' : `${result.stats.paths.toLocaleString()} paths · ${result.stats.anchors.toLocaleString()} anchors · ${result.stats.colours} colours`)}
          </span>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            data-trace-ok
            disabled={!result || busy || !session}
            onClick={() => {
              if (!session || !result) return
              remember()
              committed.current = true
              session.close()
              session.commit(result, hide)
              onClose()
            }}
          >
            Trace
          </button>
        </>
      }
    >
      <div className="form">
        <div className="field">
          <label htmlFor="trace-preset">Preset</label>
          <select
            id="trace-preset"
            value={preset}
            onChange={(e) => {
              const p = TRACE_PRESETS.find((x) => x.id === e.target.value)
              setPreset(e.target.value)
              if (p) setO({ ...p.options })
            }}
          >
            {TRACE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {preset === 'custom' && <option value="custom">Custom</option>}
          </select>
        </div>
        <Segmented id="trace-mode" label="Mode" value={o.mode} options={TRACE_MODES} onChange={(mode) => set({ mode, colours: mode === 'gray' ? 8 : o.colours })} />
        {o.mode === 'bw' ? (
          <Slider id="trace-threshold" label="Threshold" value={o.threshold} min={1} max={255} onChange={(threshold) => set({ threshold })} hint="Pixels darker than this are black" />
        ) : (
          <Slider id="trace-colours" label={o.mode === 'gray' ? 'Grays' : 'Colours'} value={o.colours} min={2} max={o.mode === 'gray' ? 32 : 64} onChange={(colours) => set({ colours })} />
        )}
        <Slider id="trace-paths" label="Paths" value={o.paths} min={0.2} max={5} step={0.1} unit="px" onChange={(paths) => set({ paths })} hint="How far a curve may stray from the pixels' edges: small for detail, large for smooth, simple shapes" />
        <Slider id="trace-corners" label="Corners" value={o.corners} min={20} max={150} unit="°" onChange={(corners) => set({ corners })} hint="A turn sharper than this is a corner, kept sharp" />
        <Slider id="trace-noise" label="Noise" value={o.noise} min={1} max={500} unit="px" onChange={(noise) => set({ noise })} hint="Specks smaller than this many pixels join what's round them" />
        <Slider id="trace-blur" label="Blur first" value={o.blur} min={0} max={4} step={0.5} unit="px" onChange={(blur) => set({ blur })} hint="Softens a photo's grain before its colours are counted" />
        <label className="check">
          <input type="checkbox" id="trace-ignore-white" checked={o.ignoreWhite} onChange={(e) => set({ ignoreWhite: e.target.checked })} />
          Ignore white
        </label>
        <label className="check">
          <input type="checkbox" id="trace-hide" checked={hide} onChange={(e) => setHide(e.target.checked)} />
          Hide the image once traced
        </label>
        {session && session.width > 0 && (
          <p className="field-meta">
            Tracing {session.width.toLocaleString()} × {session.height.toLocaleString()} px
          </p>
        )}
      </div>
    </Dialog>
  )
}
