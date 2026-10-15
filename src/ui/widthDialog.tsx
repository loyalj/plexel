/**
 * Width Point Edit, as Illustrator's: a double-click on a width point
 * with the Width tool opens it. Each side's width and the whole width, in
 * document pixels; changing the whole width keeps the sides' proportion.
 * Delete takes the point out.
 */
import { useState, useSyncExternalStore } from 'react'
import { deleteEditingPoint, editingPoint, setEditingPoint, widthEditing, type WidthEditing } from '../app/widthTool'
import { Dialog } from './Dialog'
import { Field, parseNumber } from './docDialogs'

const round = (v: number) => String(Math.round(v * 100) / 100)

function widthError(text: string): string | null {
  const n = parseNumber(text)
  if (n === null) return 'Enter a number.'
  if (n < 0) return 'Not less than 0.'
  if (n > 10000) return 'Not more than 10000.'
  return null
}

/** The dialog while a point is being edited (App.tsx shows it then); nothing otherwise. */
export function WidthPointDialog() {
  const e = useSyncExternalStore(widthEditing.subscribe, widthEditing.get)
  if (!e) return null
  return <WidthPointForm key={`${e.key}:${e.id}:${e.point}`} e={e} />
}

function WidthPointForm({ e }: { e: WidthEditing }) {
  const close = () => widthEditing.set(null)
  const [start] = useState(() => editingPoint(e))
  const [left, setLeft] = useState(() => round(start?.left ?? 0))
  const [right, setRight] = useState(() => round(start?.right ?? 0))
  const [total, setTotal] = useState(() => round((start?.left ?? 0) + (start?.right ?? 0)))
  if (!start) {
    queueMicrotask(close)
    return null
  }
  const errors = [widthError(left), widthError(right), widthError(total)]
  const sides = (l: string, r: string) => {
    setLeft(l)
    setRight(r)
    const a = parseNumber(l)
    const b = parseNumber(r)
    if (a !== null && b !== null) setTotal(round(a + b))
  }
  return (
    <Dialog
      id="widthPoint"
      title="Width Point Edit"
      onClose={close}
      footer={
        <>
          <button
            type="button"
            className="button"
            onClick={() => {
              close()
              deleteEditingPoint(e)
            }}
          >
            Delete
          </button>
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="width-form" className="button primary" disabled={errors.some(Boolean)}>
            OK
          </button>
        </>
      }
    >
      <form
        id="width-form"
        className="form"
        onSubmit={(ev) => {
          ev.preventDefault()
          close()
          setEditingPoint(e, parseNumber(left) ?? 0, parseNumber(right) ?? 0)
        }}
      >
        <Field id="width-side-1" label="Side 1 (px)" error={errors[0]}>
          <input id="width-side-1" inputMode="decimal" value={left} autoFocus onFocus={(ev) => ev.target.select()} onChange={(ev) => sides(ev.target.value, right)} />
        </Field>
        <Field id="width-side-2" label="Side 2 (px)" error={errors[1]}>
          <input id="width-side-2" inputMode="decimal" value={right} onChange={(ev) => sides(left, ev.target.value)} />
        </Field>
        <Field id="width-total" label="Total width (px)" error={errors[2]}>
          <input
            id="width-total"
            inputMode="decimal"
            value={total}
            onChange={(ev) => {
              setTotal(ev.target.value)
              const t = parseNumber(ev.target.value)
              const a = parseNumber(left) ?? 0
              const b = parseNumber(right) ?? 0
              if (t === null || t < 0) return
              // The sides in the same proportion as they were (halves when both are nothing).
              const k = a + b > 1e-9 ? a / (a + b) : 0.5
              setLeft(round(t * k))
              setRight(round(t * (1 - k)))
            }}
          />
        </Field>
        <p>Side 1 and side 2 are the stroke’s two sides, either side of the path.</p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
