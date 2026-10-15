/**
 * The Colour panel: foreground and background, and sliders to change
 * whichever is selected, in RGB, HSB, Lab, CMYK or Gray.
 *
 * Click a swatch to edit that colour; ⇄ swaps them (X) and the small pair
 * resets them to black on white (D). When the colour can't be reproduced
 * in the front document's colour space, a warning says so, and clicking it
 * moves the colour to the nearest one that can.
 */
import { memo, useEffect, useState, useSyncExternalStore } from 'react'
import { colourEngine, colourEngineNow } from '../app/colour'
import { PICKER_MODELS, colours } from '../app/colours'
import { colourSettings } from '../app/colourSettings'
import { formatHex, parseHex } from '../color/models'
import { sameValue, type ColourValue } from '../color/value'
import type { Doc } from '../doc/types'
import { CHANNELS_OF, colourOf, cssOf, targetOf, trackOf, valuesOf } from './colourView'
import { Icon } from './Icon'

export const ColourPanel = memo(function ColourPanel({ doc }: { doc: Doc | null }) {
  const state = useSyncExternalStore(colours().subscribe, colours().get)
  const settings = useSyncExternalStore(colourSettings.subscribe, colourSettings.get)
  const [engine, setEngine] = useState(colourEngineNow)
  const [editing, setEditing] = useState<'fg' | 'bg'>('fg')
  const [typed, setTyped] = useState<Record<string, string>>({})
  // HSB numbers as last set here. A grey has no hue, so read back from the
  // colour its hue would be lost and dragging Hue on a grey would do
  // nothing: while the colour is still the one these numbers made, they're
  // shown as they were set.
  const [hsb, setHsb] = useState<{ colour: ColourValue; values: number[] } | null>(null)

  useEffect(() => {
    if (!engine) void colourEngine().then(setEngine)
  }, [engine])

  if (!engine) return <p className="panel-empty">Starting the colour engine…</p>
  const conv = engine.converter
  const colour = state[editing]
  const set = (c: ColourValue) => (editing === 'fg' ? colours().setFg(c) : colours().setBg(c))
  const kept = state.model === 'hsb' && hsb && sameValue(hsb.colour, colour) ? hsb.values : null
  const values = kept ?? valuesOf(state.model, colour, conv, doc)
  const channels = CHANNELS_OF[state.model]
  const docTarget = doc ? { space: doc.mode, profile: doc.profile } : null
  const gamut = docTarget ? conv.convert(colour, docTarget) : null
  const rgbHex = formatHex(conv.convert(colour, targetOf('rgb', doc)).c)

  const setChannel = (i: number, v: number) => {
    const next = [...values]
    next[i] = Math.min(channels[i].max, Math.max(channels[i].min, v))
    const c = colourOf(state.model, next, doc)
    if (state.model === 'hsb') setHsb({ colour: c, values: next })
    set(c)
  }

  return (
    <div className="colour" data-colour-panel>
      <div className="colour-top">
        <div className="swatches">
          <button
            type="button"
            className={`swatch bg${editing === 'bg' ? ' editing' : ''}`}
            style={{ background: cssOf(state.bg, conv, settings.display) }}
            aria-label="Background colour"
            aria-pressed={editing === 'bg'}
            data-swatch="bg"
            onClick={() => setEditing('bg')}
          />
          <button
            type="button"
            className={`swatch fg${editing === 'fg' ? ' editing' : ''}`}
            style={{ background: cssOf(state.fg, conv, settings.display) }}
            aria-label="Foreground colour"
            aria-pressed={editing === 'fg'}
            data-swatch="fg"
            onClick={() => setEditing('fg')}
          />
          <button type="button" className="swatch-swap" data-tip="Swap foreground and background (X)" aria-label="Swap colours" onClick={() => colours().swap()}>
            <Icon name="ui.swap" />
          </button>
          <button type="button" className="swatch-reset" data-tip="Black on white (D)" aria-label="Reset colours" onClick={() => colours().reset()}>
            <span />
            <span />
          </button>
        </div>
        <div className="colour-models" role="tablist" aria-label="Colour model">
          {PICKER_MODELS.map((m) => (
            <button key={m.id} type="button" role="tab" aria-selected={state.model === m.id} className="colour-model" data-model={m.id} onClick={() => colours().setModel(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {channels.map((ch, i) => {
        const id = `colour-${state.model}-${i}`
        const shown = state.model === 'lab' ? values[i].toFixed(0) : Math.round(values[i]).toString()
        return (
          <div key={id} className="colour-row">
            <label htmlFor={id} className="colour-label">
              {ch.label}
            </label>
            <input
              id={id}
              type="range"
              className="colour-slider"
              min={ch.min}
              max={ch.max}
              step={1}
              value={Math.round(values[i])}
              style={{ background: trackOf(state.model, values, i, conv, doc, settings.display) }}
              onChange={(e) => setChannel(i, Number(e.target.value))}
            />
            <input
              className="colour-number"
              aria-label={`${ch.label} value`}
              data-channel={ch.label}
              inputMode="decimal"
              value={typed[id] ?? shown}
              onChange={(e) => setTyped({ ...typed, [id]: e.target.value })}
              onBlur={() => {
                const n = Number(typed[id])
                if (typed[id] !== undefined && Number.isFinite(n)) setChannel(i, n)
                setTyped({})
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <span className="unit">{ch.unit}</span>
          </div>
        )
      })}
      {(state.model === 'rgb' || state.model === 'hsb') && (
        <div className="colour-row">
          <label htmlFor="colour-hex" className="colour-label">
            #
          </label>
          <input
            id="colour-hex"
            className="colour-hex"
            value={typed.hex ?? rgbHex.slice(1)}
            onChange={(e) => setTyped({ ...typed, hex: e.target.value })}
            onBlur={() => {
              const rgb = typed.hex !== undefined ? parseHex(typed.hex) : null
              if (rgb) set({ ...targetOf('rgb', doc), c: rgb })
              setTyped({})
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </div>
      )}
      {gamut?.clipped && doc && (
        <button type="button" className="gamut-warning" data-gamut-warning onClick={() => set({ space: doc.mode, profile: doc.profile, c: gamut.c })}>
          <Icon name="ui.warning" /> Outside this document’s {doc.mode.toUpperCase()} gamut. Click to use the nearest colour it has.
        </button>
      )}
    </div>
  )
})
