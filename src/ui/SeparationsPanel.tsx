/**
 * The Separations panel, for CMYK documents: each ink switched on and off
 * on the canvas (a plate on its own, or any mix), what each ink and their
 * total come to under the pointer, and the total ink limit, with the
 * pixels over it marked on the canvas if asked. As Acrobat's Output
 * Preview and Illustrator's Separations Preview have it.
 *
 * The readings are the composite's own values (render.sample), on white
 * paper: a half-transparent pixel prints half its ink. Spot channels are
 * inks too, listed after the process ones: shown and hidden with the
 * Channels panel's eyes, read from their own coverage, and counted in the
 * total.
 */
import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { documents } from '../app/documents'
import { pointer } from '../app/pointer'
import { proofing } from '../app/proofing'
import { engine } from '../engine/EngineHost'
import { channels, channelSrgb, extraShown } from '../app/channels'
import { apply, invert } from '../geom/affine'
import type { DocChannel } from '../doc/types'
import { Hint, Label } from './controls'

const INKS = ['Cyan', 'Magenta', 'Yellow', 'Black'] as const

export const SeparationsPanel = memo(function SeparationsPanel() {
  const active = useSyncExternalStore(documents().subscribe, () => documents().active())
  const look = useSyncExternalStore(proofing.subscribe, proofing.active)
  const at = useSyncExternalStore(pointer.subscribe, pointer.get)
  const [reading, setReading] = useState<number[] | null>(null)
  const [spotReading, setSpotReading] = useState<number[] | null>(null)
  const view = useSyncExternalStore(channels.subscribe, () => channels.active())
  const busy = useRef(false)
  const wanted = useRef(at)
  wanted.current = at
  const doc = active?.history.present
  const cmyk = doc?.mode === 'cmyk'
  const spotChannels = (doc?.channels ?? []).filter((c) => c.kind === 'spot')
  const spotsRef = useRef<DocChannel[]>(spotChannels)
  spotsRef.current = spotChannels

  // One sample at a time; the newest place is read when the last answer comes.
  useEffect(() => {
    if (!cmyk || !at || at.key !== active?.key || busy.current) return
    busy.current = true
    // A spot channel's ink under the pointer: its coverage at the point in its own pixels.
    const spotsAt = (p: NonNullable<typeof at>) => {
      const list = spotsRef.current.filter((c) => c.tiles)
      if (!list.length) return Promise.resolve([] as number[])
      return engine().call('tiles.valuesAt', { points: list.map((c) => {
        const [x, y] = apply(invert(c.transform), p.x, p.y)
        return { set: c.tiles!, x: Math.floor(x), y: Math.floor(y), kind: 'cover' as const }
      }) }).then((v) => spotsRef.current.map((c) => (c.tiles ? (v[list.indexOf(c)] ?? 0) : 0)))
    }
    const ask = (p: NonNullable<typeof at>) =>
      Promise.all([engine().call('render.sample', { key: p.key, x: p.x, y: p.y, size: 1 }), spotsAt(p)])
        .then(([v, s]) => {
          setSpotReading(v ? s : null)
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

  if (!active || !doc) return <p className="panel-empty">No document open</p>
  if (!cmyk)
    return (
      <p className="panel-empty">
        For CMYK documents <Hint text="Document → Mode → CMYK Colour converts this one." />
      </p>
    )
  const pct = (v: number) => `${Math.round(v * 100)}%`
  const total = reading ? reading.reduce((a, b) => a + b, 0) + (spotReading ?? []).reduce((a, b) => a + b, 0) : null
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
          {view &&
            spotChannels.map((c, j) => {
              const [r, g, b] = channelSrgb(c).map((v) => Math.round(v * 255))
              return (
                <tr key={c.id} data-spot-ink={c.id}>
                  <td>
                    <label className="check">
                      <input type="checkbox" data-spot-toggle={c.id} checked={extraShown(view, c)} onChange={() => channels.toggleExtra(active.key, c.id)} />
                      <span className="ink-chip" style={{ background: `rgb(${r}, ${g}, ${b})` }} aria-hidden="true" />
                      {c.name}
                    </label>
                  </td>
                  <td className="num" data-spot-reading={c.id}>
                    {spotReading ? pct(spotReading[j] ?? 0) : '–'}
                  </td>
                </tr>
              )
            })}
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
        <Label htmlFor="ink-limit" hint="Most coated papers take 300–340%, uncoated 260–300%, newsprint about 240%. Ask the printer.">
          Total ink limit
        </Label>
        <div className="input-row">
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
      </div>
      <label className="check">
        <input type="checkbox" data-ink-warning checked={look.inkWarning} onChange={(e) => set({ inkWarning: e.target.checked })} />
        Mark over the limit
        <Hint text="Coverage over the limit is marked on the canvas" />
      </label>
      {spots.length > 0 && (
        <p className="field-meta">
          Spot colours: {spots.map((s) => s.name).join(', ')} <Hint text="Shapes in spot colours are shown through their process equivalents here; in a PDF they print on plates of their own. Spot channels (the Channels panel) are plates of their own on screen too." />
        </p>
      )}
    </div>
  )
})
