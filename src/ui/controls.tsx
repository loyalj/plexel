/**
 * The interface's shared controls, so a number, a choice or a note behaves
 * and looks the same in every panel, bar and dialog:
 *
 * - `Hint`: an ⓘ beside a label whose tooltip says what the setting does,
 *   in place of a sentence under it.
 * - `NumberInput`: a typed number, kept as typed until Enter or a click
 *   away, Esc putting it back; the arrow keys step it (Shift ten steps, Alt
 *   a tenth of one).
 * - `ScrubLabel` and `scrub`: drag a number's label sideways to change it,
 *   as in Photoshop (Shift faster, Alt slower). Labels of plain number
 *   fields in dialogs scrub too (`installLabelScrub`).
 * - `SliderField`: a slider and its number as one bar: the label at its
 *   left (a scrub handle), the number at its right (typed), and the bar
 *   filled to the value; a press anywhere else sets it there. It keeps a
 *   real range input, so the keyboard and assistive tools work as before.
 * - `Segmented`: two to four choices as buttons side by side, in place of a
 *   menu or a pair of checkboxes.
 *
 * A control given its default (`defaultValue`) marks its label with a dot
 * while it's set to something else, and a double-click on the label puts
 * the default back.
 */
import { useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Icon } from './Icon'

// --- notes ------------------------------------------------------------------------

/** An ⓘ whose tooltip explains the setting beside it. */
export function Hint({ text }: { text: string | undefined }) {
  if (!text) return null
  return (
    <span className="hint" role="img" aria-label={text} data-tip={text} data-hint="">
      <Icon name="ui.info" />
    </span>
  )
}

/** A field's label with its hint. */
export function Label({ htmlFor, id, children, hint }: { htmlFor?: string; id?: string; children: ReactNode; hint?: string }) {
  return (
    <label htmlFor={htmlFor} id={id} className="field-label">
      {children}
      <Hint text={hint} />
    </label>
  )
}

// --- numbers ----------------------------------------------------------------------

const clampTo = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
/** How many decimals a step has: 0.5 one, 0.01 two. */
const decimalsOf = (step: number) => {
  const s = String(step)
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}
/** A value rounded to the precision it's edited at, without float dust. */
export const roundTo = (v: number, step: number, extra = 0) => {
  const d = Math.min(6, decimalsOf(step) + extra)
  return Number(v.toFixed(d))
}
/** What's shown for a number: rounded as its step is, never "-0". */
export const formatNumber = (v: number, step: number) => String(roundTo(v, step) || 0)

/** What an arrow key does to a number: a step, ten with Shift, a tenth with Alt; null for other keys. */
export function arrowStep(e: { key: string; shiftKey: boolean; altKey: boolean }, value: number, step: number): number | null {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return null
  const by = (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * step
  return roundTo(value + (e.key === 'ArrowUp' ? by : -by), step, e.altKey ? 1 : 0)
}

export interface ScrubOptions {
  value: number
  min: number
  max: number
  step: number
  onChange(v: number): void
  /** Once, when the drag ends (not after a click that didn't move). */
  onEnd?(): void
}

/** How far a pointer goes before a press on a label is a scrub, not a click. */
const SCRUB_START = 3

/**
 * Turns a press on a label into a scrub: past a few pixels sideways, each
 * pixel is a step (more for long ranges), Shift ten times as fast and Alt a
 * tenth as fast. A press that doesn't move is a click, as before.
 */
export function scrub(e: ReactPointerEvent<Element> | PointerEvent, o: ScrubOptions, el = e.currentTarget as Element) {
  if (e.button !== 0) return
  const x0 = e.clientX
  const id = e.pointerId
  // Long ranges go faster, so the whole range is a sweep of a few hundred pixels.
  const span = Number.isFinite(o.max - o.min) ? (o.max - o.min) / o.step : 0
  const perPixel = span > 400 ? Math.max(1, Math.round(span / 400)) * o.step : o.step
  let travel = 0
  let lastX = x0
  let started = false
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return
    if (!started) {
      if (Math.abs(ev.clientX - x0) < SCRUB_START) return
      started = true
      lastX = ev.clientX
      el.setPointerCapture?.(id)
      document.documentElement.dataset.scrubbing = ''
      ;(document.activeElement as HTMLElement | null)?.blur?.()
    }
    travel += (ev.clientX - lastX) * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1)
    lastX = ev.clientX
    o.onChange(clampTo(roundTo(o.value + travel * perPixel, o.step), o.min, o.max))
  }
  const end = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return
    removeEventListener('pointermove', move, true)
    removeEventListener('pointerup', end, true)
    removeEventListener('pointercancel', end, true)
    if (!started) return
    delete document.documentElement.dataset.scrubbing
    // The click a scrub ends with isn't a click on the label.
    const stop = (c: MouseEvent) => {
      c.preventDefault()
      c.stopPropagation()
    }
    addEventListener('click', stop, { capture: true, once: true })
    setTimeout(() => removeEventListener('click', stop, { capture: true }), 0)
    o.onEnd?.()
  }
  addEventListener('pointermove', move, true)
  addEventListener('pointerup', end, true)
  addEventListener('pointercancel', end, true)
}

/** Whether a value is off its default, and how to put it back: none when there's no default. */
export interface Resettable {
  /** The value when untouched; without one, nothing is marked or reset. */
  defaultValue?: number
}

/** A value differs from its default by more than its step's rounding. */
const offDefault = (value: number, def: number | undefined, step: number) => def !== undefined && Number.isFinite(def) && Math.abs(value - def) > step / 2

/** A label that scrubs its number; with a default, marked when off it, and a double-click puts it back. */
export function ScrubLabel({ htmlFor, className, children, hint, title, defaultValue, ...o }: ScrubOptions & Resettable & { htmlFor: string; className?: string; children: ReactNode; hint?: string; title?: string }) {
  const changed = offDefault(o.value, defaultValue, o.step)
  return (
    <label
      htmlFor={htmlFor}
      className={`scrub ${className ?? ''}`}
      data-scrub="own"
      data-changed={changed ? '' : undefined}
      data-tip={title ?? (changed ? 'Double-click for the default' : undefined)}
      onPointerDown={(e) => scrub(e, o)}
      onDoubleClick={(e) => {
        if (!changed || defaultValue === undefined) return
        e.preventDefault()
        o.onChange(defaultValue)
        // The label's click focused its field; leave it showing the default, not typing.
        ;(document.activeElement as HTMLElement | null)?.blur?.()
      }}
    >
      {children}
      <Hint text={hint} />
    </label>
  )
}

interface NumberInputProps {
  id?: string
  value: number
  min?: number
  max?: number
  step?: number
  onChange(v: number): void
  className?: string
  'aria-label'?: string
  title?: string
  disabled?: boolean
  /** How the number is shown; the step's rounding by default. */
  format?(v: number): string
  placeholder?: string
  autoFocus?: boolean
}

/**
 * A typed number. What's typed stays as typed until Enter or a click
 * away commits it (clamped), and Esc puts the value back; the arrow keys
 * step it at once.
 */
export function NumberInput({ id, value, min = -Infinity, max = Infinity, step = 1, onChange, className, format, disabled, placeholder, autoFocus, title, ...rest }: NumberInputProps) {
  const [typed, setTyped] = useState<string | null>(null)
  const shown = format ? format(value) : formatNumber(value, step)
  const commit = () => {
    if (typed !== null && typed.trim() !== '') {
      const n = Number(typed.trim().replace(',', '.'))
      if (Number.isFinite(n)) onChange(clampTo(n, min, max))
    }
    setTyped(null)
  }
  return (
    <input
      id={id}
      className={className}
      inputMode="decimal"
      data-scrub="own"
      aria-label={rest['aria-label']}
      data-tip={title}
      disabled={disabled}
      placeholder={placeholder}
      autoFocus={autoFocus}
      value={typed ?? shown}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setTyped(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        else if (e.key === 'Escape' && typed !== null) {
          // Esc here puts the number back rather than closing what it's in.
          e.stopPropagation()
          setTyped(null)
        } else {
          const typedNow = typed !== null ? Number(typed) : value
          const next = arrowStep(e, Number.isFinite(typedNow) ? typedNow : value, step)
          if (next === null) return
          e.preventDefault()
          setTyped(null)
          onChange(clampTo(next, min, max))
        }
      }}
    />
  )
}

/** A number with a scrubbing label beside it and its unit after: the compact field. */
export function NumberField({
  id,
  label,
  value,
  min = -Infinity,
  max = Infinity,
  step = 1,
  unit,
  hint,
  onChange,
  className,
  defaultValue,
}: {
  id: string
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  unit?: string
  hint?: string
  onChange(v: number): void
  className?: string
} & Resettable) {
  return (
    <div className={`number-field ${className ?? ''}`}>
      <ScrubLabel htmlFor={id} value={value} min={min} max={max} step={step} onChange={onChange} hint={hint} defaultValue={defaultValue}>
        {label}
      </ScrubLabel>
      <NumberInput id={id} value={value} min={min} max={max} step={step} onChange={onChange} />
      {unit && <span className="unit">{unit}</span>}
    </div>
  )
}

/**
 * A slider and its number as one bar. The range input underneath takes a
 * press (the value jumps there and follows the pointer) and the keys; the
 * label at its left scrubs; the number at its right is typed.
 */
export function SliderField({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  hint,
  onChange,
  title,
  className,
  disabled,
  defaultValue,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  hint?: string
  onChange(v: number): void
  /** A tooltip for the whole bar, when the label alone doesn't say enough. */
  title?: string
  className?: string
  disabled?: boolean
} & Resettable) {
  const fill = max > min ? clampTo((value - min) / (max - min), 0, 1) : 0
  const set = (v: number) => onChange(clampTo(v, min, max))
  return (
    <div className={`field slider-field ${className ?? ''}`} data-tip={title}>
      <div className="slider-row" style={{ '--fill': `${(fill * 100).toFixed(2)}%` } as CSSProperties}>
        <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => set(Number(e.target.value))} />
        <NumberInput className="slider-number" aria-label={`${label}${unit ? `, ${unit}` : ''}`} value={value} min={min} max={max} step={step} onChange={set} disabled={disabled} />
        <span className="unit">{unit}</span>
        <ScrubLabel htmlFor={id} className="slider-label" value={value} min={min} max={max} step={step} onChange={set} hint={hint} defaultValue={defaultValue}>
          {label}
        </ScrubLabel>
      </div>
    </div>
  )
}

// --- choices ------------------------------------------------------------------------

export type SegmentOption<T extends string> = readonly [value: T, label: string, hint?: string]

/**
 * A few choices side by side, one pressed. The arrow keys move between
 * them, as in a radio group. With `label`, it's a field with its label
 * above; without, just the buttons (name them with `aria-label`).
 */
export function Segmented<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  hint,
  'aria-label': ariaLabel,
  disabled,
  className,
  defaultValue,
}: {
  id: string
  label?: string
  value: T
  options: readonly SegmentOption<T>[]
  onChange(v: T): void
  hint?: string
  'aria-label'?: string
  disabled?: boolean
  className?: string
  /** The choice when untouched: the label is marked while another is chosen, and a double-click on it goes back. */
  defaultValue?: T
}) {
  const pick = (i: number) => {
    const o = options[(i + options.length) % options.length]
    if (o[0] !== value) onChange(o[0])
    document.getElementById(`${id}-${o[0]}`)?.focus()
  }
  const at = options.findIndex((o) => o[0] === value)
  const group = (
    <div
      id={id}
      className={`segmented ${className ?? ''}`}
      role="radiogroup"
      aria-labelledby={label ? `${id}-label` : undefined}
      aria-label={label ? undefined : ariaLabel}
      data-value={value}
      onKeyDown={(e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
        if (!d) return
        e.preventDefault()
        pick(at + d)
      }}
    >
      {options.map(([v, l, tip]) => (
        <button
          key={v}
          id={`${id}-${v}`}
          type="button"
          role="radio"
          aria-checked={v === value}
          tabIndex={v === value || (at < 0 && v === options[0][0]) ? 0 : -1}
          data-value={v}
          data-tip={tip}
          disabled={disabled}
          onClick={() => v !== value && onChange(v)}
        >
          {l}
        </button>
      ))}
    </div>
  )
  if (!label) return group
  const changed = defaultValue !== undefined && value !== defaultValue
  return (
    <div className="field">
      <span
        className="field-label"
        id={`${id}-label`}
        data-changed={changed ? '' : undefined}
        data-tip={changed ? 'Double-click for the default' : undefined}
        onDoubleClick={() => changed && onChange(defaultValue!)}
      >
        {label}
        <Hint text={hint} />
      </span>
      {group}
    </div>
  )
}

// --- labels of plain number fields ---------------------------------------------------------

const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!

/**
 * Lets the label of any plain number field scrub it (a dialog's Width, a
 * radius), not just the shared controls': the field gets each value as if
 * typed, so the dialog's own handling (its checks, its preview) runs as it
 * would. Below zero only where the field says so (`data-min`).
 */
export function installLabelScrub() {
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || e.pointerType === 'touch') return
    const label = e.target instanceof Element ? e.target.closest('label') : null
    if (!label || label.dataset.scrub === 'own') return
    const input = label.control
    if (!(input instanceof HTMLInputElement) || input.disabled || input.readOnly || input.dataset.scrub === 'own') return
    if (input.inputMode !== 'decimal' && input.inputMode !== 'numeric') return
    // The label wraps the field: a press in the field itself is for typing.
    if (e.target instanceof Element && input.contains(e.target)) return
    const start = Number(input.value.trim().replace(',', '.'))
    if (!Number.isFinite(start)) return
    const decimals = input.inputMode === 'numeric' ? 0 : Math.min(2, (input.value.split('.')[1] ?? '').length)
    const step = Number(input.dataset.step) || 10 ** -decimals
    const min = input.dataset.min !== undefined ? Number(input.dataset.min) : 0
    const max = input.dataset.max !== undefined ? Number(input.dataset.max) : Infinity
    scrub(e, {
      value: start,
      min,
      max,
      step,
      onChange: (v) => {
        setNativeValue.call(input, String(v))
        input.dispatchEvent(new Event('input', { bubbles: true }))
      },
    }, label)
  }
  document.addEventListener('pointerdown', down, true)
  return () => document.removeEventListener('pointerdown', down, true)
}
