/**
 * The Separations panel, for CMYK documents: each ink switched on and off
 * on the canvas (a plate on its own, or any mix), what each ink and their
 * total come to under the pointer, and the total ink limit, with the
 * pixels over it marked on the canvas if asked. As Acrobat's Output
 * Preview and Illustrator's Separations Preview have it.
 *
 * The readings are the composite's own values (render.sample), on white
 * paper: a half-transparent pixel prints half its ink.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { documents } from '../app/documents'
import { pointer } from '../app/pointer'
import { proofing } from '../app/proofing'
import { engine } from '../engine/EngineHost'

const INKS = ['Cyan', 'Magenta', 'Yellow', 'Black'] as const

export function SeparationsPanel() {
  const active = useSyncExternalStore(documents().subscribe, () => documents().active())
  const look = useSyncExternalStore(proofing.subscribe, proofing.active)
  const at = useSyncExternalStore(pointer.subscribe, pointer.get)
  const [reading, setReading] = useState<number[] | null>(null)
  const busy = useRef(false)
  const wanted = useRef(at)
  wanted.current = at
  const doc = active?.history.present
  const cmyk = doc?.mode === 'cmyk'

  // One sample at a time; the newest place is read when the last answer comes.
  useEffect(() => {
    if (!cmyk || !at || at.key !== active?.key || busy.current) return
    busy.current = true
    const ask = (p: NonNullable<typeof at>) =>
      engine()
        .call('render.sample', { key: p.key, x: p.x, y: p.y, size: 1 })
        .then((v) => {
          if (!v) return setReading(null)
          const a = v[v.length - 1]
          setReading(v.slice(0, 4).map((x) => x * a))
        })
        .catch(() => setReading(null))
        .finally(() => {
          const next = wanted.current
          if (next && next !== p && next.key === p.key) void ask(next)
          else busy.current = false
        })
    void ask(at)
  }, [at, cmyk, active?.key])

  if (!active || !doc) return <p className="panel-empty">The inks of a CMYK document, one at a time or together, and how much ink is under the pointer.</p>
  if (!cmyk) return <p className="panel-empty">Separations are for CMYK documents. Document → Mode → CMYK Colour converts this one.</p>
  const pct = (v: number) => `${Math.round(v * 100)}%`
  const total = reading ? reading.reduce((a, b) => a + b, 0) : null
  const over = total !== null && total * 100 > look.inkLimit + 0.5
  const spots = (doc.swatches ?? []).filter((s) => s.kind === 'spot')
  const set = (patch: Partial<typeof look>) => proofing.update(active.key, patch)
  return (
    <div className="separations-panel" data-panel-body="separations">
      <table className="separations">
        <tbody>
          {INKS.map((name, i) => (
            <tr key={name} data-ink={i}>
              <td>
                <label className="check">
                  <input
                    type="checkbox"
                    data-ink-toggle={i}
                    checked={look.inks[i]}
                    onChange={(e) => {
                      const inks = [...look.inks] as typeof look.inks
                      inks[i] = e.target.checked
                      set({ inks })
                    }}
                  />
                  <span className={`ink-chip ink-${i}`} aria-hidden="true" />
                  {name}
                </label>
              </td>
              <td className="num" data-ink-reading={i}>
                {reading ? pct(reading[i]) : '–'}
              </td>
            </tr>
          ))}
          <tr className={over ? 'over' : undefined}>
            <td>Total</td>
            <td className="num" data-ink-total>
              {total === null ? '–' : pct(total)}
            </td>
          </tr>
        </tbody>
      </table>
      <div className="panel-tools">
        <button type="button" className="button small" onClick={() => set({ inks: [true, true, true, true] })} disabled={look.inks.every(Boolean)}>
          All Inks
        </button>
      </div>
      <div className="field">
        <label htmlFor="ink-limit">Total ink limit</label>
        <div className="slider-row">
          <input
            id="ink-limit"
            type="number"
            min={100}
            max={400}
            step={5}
            value={look.inkLimit}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) set({ inkLimit: Math.min(400, Math.max(100, v)) })
            }}
          />
          <span className="unit">%</span>
        </div>
        <span className="field-note">Most coated papers take 300–340%, uncoated 260–300%, newsprint about 240%. Ask the printer.</span>
      </div>
      <label className="check">
        <input type="checkbox" data-ink-warning checked={look.inkWarning} onChange={(e) => set({ inkWarning: e.target.checked })} />
        Mark coverage over the limit on the canvas
      </label>
      {spots.length > 0 && (
        <p className="field-note">
          Spot colours ({spots.map((s) => s.name).join(', ')}) are shown through their process equivalents; a raster document has no separate plates for them.
        </p>
      )}
    </div>
  )
}
