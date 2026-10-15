/**
 * A colour chip: a swatch showing a colour, which opens a small picker
 * when clicked, the one way to set a colour anywhere in the app (a fill's,
 * a gradient stop's, a filter's colour, a swatch's, an ink's).
 *
 * The picker: a square of saturation and brightness at the hue, a hue
 * strip, the Colour panel's models as sliders with numbers (RGB, HSB, Lab,
 * CMYK, Gray), the hex code, and chips to take the foreground, the
 * background, a document swatch or one of your swatches. It changes the
 * colour as you go (a drag of one control is one step for whoever keeps
 * the history); Esc, Enter or a click outside closes it.
 *
 * Colours are ColourValues (doc/types' space, profile and numbers); a chip
 * for a document's own colour (`DocColourChip`) hands back the document's
 * terms, CMYK as ink, as parameters and paints hold them. `HexColourChip`
 * is for the app's own sRGB colours (guides, inks shown on screen).
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { colourEngine, colourEngineNow } from '../app/colour'
import { PICKER_MODELS, colours } from '../app/colours'
import { colourSettings } from '../app/colourSettings'
import { swatches } from '../app/swatches'
import { formatHex, hsbToRgb, parseHex, rgbToHsb } from '../color/models'
import type { ColourValue, Converter, Target } from '../color/value'
import type { ParamColour } from '../doc/params'
import type { Doc } from '../doc/types'
import { CHANNELS_OF, colourOf, cssOf, targetOf, trackOf, valuesOf } from './colourView'
import { Icon } from './Icon'

const SRGB: Target = { space: 'rgb', profile: { builtin: 'srgb' } }

/** The converter once the colour engine is up (it starts with the app). */
function useConverter(): Converter | null {
  const [conv, setConv] = useState(() => colourEngineNow()?.converter ?? null)
  useEffect(() => {
    if (!conv) void colourEngine().then((e) => setConv(e.converter))
  }, [conv])
  return conv
}

interface ChipProps {
  value: ColourValue
  onChange(c: ColourValue): void
  /** The document the colour is for: its gamut warned of, its swatches offered; null for the app's own colours. */
  doc: Doc | null
  /** For the button: what colour this is ("Fill colour", "Stop 2 colour"). */
  label: string
  id?: string
  /** Extra attributes for checks and styling. */
  data?: Record<string, string>
}

/** The chip and, while it's open, its picker. */
export function ColourChip({ value, onChange, doc, label, id, data }: ChipProps) {
  const conv = useConverter()
  const settings = useSyncExternalStore(colourSettings.subscribe, colourSettings.get)
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const css = conv ? cssOf(value, conv, settings.display) : 'transparent'
  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        className="colour-chip"
        style={{ background: css }}
        aria-label={`${label}: choose a colour`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip={label}
        onClick={() => setOpen((o) => !o)}
        {...Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]))}
      />
      {open && conv && createPortal(<Picker anchor={button.current} value={value} onChange={onChange} doc={doc} conv={conv} label={label} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

/** A chip for a colour in a document's own terms (CMYK as ink), as parameters and paints keep them. */
export function DocColourChip({ value, onChange, doc, label, id, data }: { value: ParamColour; onChange(c: ParamColour): void; doc: Doc; label: string; id?: string; data?: Record<string, string> }) {
  const conv = useConverter()
  const target: Target = { space: doc.mode, profile: doc.profile }
  const toDoc = (c: ColourValue): ParamColour => {
    if (!conv) return c.c
    const { intent, blackPointCompensation } = colourSettings.get()
    return conv.convert(c, target, intent, blackPointCompensation).c
  }
  return <ColourChip value={{ ...target, c: value }} onChange={(c) => onChange(toDoc(c))} doc={doc} label={label} id={id} data={data} />
}

/** A chip for one of the app's own sRGB colours, kept as "#rrggbb". */
export function HexColourChip({ value, onChange, label, id, data }: { value: string; onChange(hex: string): void; label: string; id?: string; data?: Record<string, string> }) {
  const conv = useConverter()
  const rgb = parseHex(value.replace(/^#/, '')) ?? [0, 0, 0]
  return <ColourChip value={{ ...SRGB, c: rgb }} onChange={(c) => onChange(formatHex(conv ? conv.convert(c, SRGB).c : c.c))} doc={null} label={label} id={id} data={data} />
}

// --- the picker ----------------------------------------------------------------------------------

const SQUARE_W = 220
const SQUARE_H = 132

function Picker({ anchor, value, onChange, doc, conv, label, onClose }: { anchor: HTMLElement | null; value: ColourValue; onChange(c: ColourValue): void; doc: Doc | null; conv: Converter; label: string; onClose(): void }) {
  const state = useSyncExternalStore(colours().subscribe, colours().get)
  const settings = useSyncExternalStore(colourSettings.subscribe, colourSettings.get)
  const library = useSyncExternalStore(swatches().subscribe, swatches().get)
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [typed, setTyped] = useState<Record<string, string>>({})
  // Hue and saturation as last set here: a grey has neither, so they're kept while the colour is the one they made.
  const [hsb, setHsb] = useState<{ c: number[]; hsb: number[] } | null>(null)
  const rgbTarget = targetOf('hsb', doc)
  const rgb = conv.convert(value, rgbTarget).c
  const same = hsb && hsb.c.every((v, i) => Math.abs(v - value.c[i]) < 1e-6)
  const [h, s, b] = same ? hsb!.hsb : rgbToHsb(rgb)
  const setHsbColour = (next: number[]) => {
    const c: ColourValue = { ...rgbTarget, c: hsbToRgb([next[0], next[1], next[2]]) }
    setHsb({ c: c.c, hsb: next })
    onChange(c)
  }

  // Placed under the chip (above it when there's no room), inside the window.
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !anchor) return
    const a = anchor.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, a.left))
    const below = a.bottom + 6
    const top = below + r.height > window.innerHeight - 8 ? Math.max(8, a.top - 6 - r.height) : below
    setPos({ left, top })
  }, [anchor])

  // Esc or Enter closes it; so does a press anywhere else.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && !(e.target instanceof HTMLInputElement))) {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (box.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('pointerdown', down, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('pointerdown', down, true)
    }
  }, [anchor, onClose])

  /** A drag on the square or the strip: `at` gets the pointer's place in it, 0..1 each way. */
  const dragOn = (e: ReactPointerEvent<HTMLElement>, at: (x: number, y: number) => void) => {
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const go = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      at(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)))
    }
    go(e)
    const move = (ev: PointerEvent) => go(ev)
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const model = state.model
  const channels = CHANNELS_OF[model]
  const values = model === 'hsb' ? [h, s * 100, b * 100] : valuesOf(model, value, conv, doc)
  const setChannel = (i: number, v: number) => {
    const next = [...values]
    next[i] = Math.min(channels[i].max, Math.max(channels[i].min, v))
    if (model === 'hsb') return setHsbColour([next[0], next[1] / 100, next[2] / 100])
    onChange(colourOf(model, next, doc))
  }
  const hex = formatHex(conv.convert(value, targetOf('rgb', doc)).c)
  const gamut = doc ? conv.convert(value, { space: doc.mode, profile: doc.profile }) : null
  const hueCss = cssOf({ ...rgbTarget, c: hsbToRgb([h, 1, 1]) }, conv, settings.display)
  const chip = (c: ColourValue, name: string, key: string) => (
    <button key={key} type="button" className="colour-chip small" style={{ background: cssOf(c, conv, settings.display) }} data-tip={name} aria-label={name} data-pick={key} onClick={() => onChange(c)} />
  )

  return (
    <div
      ref={box}
      className="colour-picker"
      role="dialog"
      aria-label={label}
      data-colour-picker
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
    >
      <div
        className="picker-square"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueCss})`, width: SQUARE_W, height: SQUARE_H }}
        onPointerDown={(e) => dragOn(e, (x, y) => setHsbColour([h, x, 1 - y]))}
        data-picker-square
      >
        <span className="picker-dot" style={{ left: `${s * 100}%`, top: `${(1 - b) * 100}%` }} />
      </div>
      <div className="picker-hue" onPointerDown={(e) => dragOn(e, (x) => setHsbColour([x * 360, s, b]))} data-picker-hue>
        <span className="picker-hue-mark" style={{ left: `${(h / 360) * 100}%` }} />
      </div>
      <div className="colour-models" role="tablist" aria-label="Colour model">
        {PICKER_MODELS.map((m) => (
          <button key={m.id} type="button" role="tab" aria-selected={model === m.id} className="colour-model" onClick={() => colours().setModel(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      {channels.map((ch, i) => {
        const key = `${model}-${i}`
        const shown = model === 'lab' ? values[i].toFixed(0) : Math.round(values[i]).toString()
        return (
          <div key={key} className="colour-row">
            <span className="colour-label">{ch.label}</span>
            <input type="range" className="colour-slider" aria-label={ch.label} min={ch.min} max={ch.max} step={1} value={Math.round(values[i])} style={{ background: trackOf(model, values, i, conv, doc, settings.display) }} onChange={(e) => setChannel(i, Number(e.target.value))} />
            <input
              className="colour-number"
              aria-label={`${ch.label} value`}
              data-picker-channel={ch.label}
              inputMode="decimal"
              value={typed[key] ?? shown}
              onChange={(e) => setTyped({ ...typed, [key]: e.target.value })}
              onBlur={() => {
                const n = Number(typed[key])
                if (typed[key] !== undefined && Number.isFinite(n)) setChannel(i, n)
                setTyped({})
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <span className="unit">{ch.unit}</span>
          </div>
        )
      })}
      <div className="colour-row">
        <span className="colour-label">#</span>
        <input
          className="colour-hex"
          aria-label="Hex"
          data-picker-hex
          value={typed.hex ?? hex.slice(1)}
          onChange={(e) => setTyped({ ...typed, hex: e.target.value })}
          onBlur={() => {
            const c = typed.hex !== undefined ? parseHex(typed.hex) : null
            if (c) onChange({ ...targetOf('rgb', doc), c })
            setTyped({})
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </div>
      {gamut?.clipped && doc && (
        <button type="button" className="gamut-warning" onClick={() => onChange({ space: doc.mode, profile: doc.profile, c: gamut.c })}>
          <Icon name="ui.warning" /> Outside this document’s {doc.mode.toUpperCase()} gamut. Click for the nearest it has.
        </button>
      )}
      <div className="picker-chips">
        {chip(state.fg, 'Foreground colour', 'fg')}
        {chip(state.bg, 'Background colour', 'bg')}
        <span className="picker-sep" />
        {(doc?.swatches ?? []).map((sw) => chip(sw.colour, sw.name, `swatch:${sw.id}`))}
        {library.map((c, i) => chip(c, `Swatch ${i + 1}`, `lib:${i}`))}
      </div>
    </div>
  )
}
