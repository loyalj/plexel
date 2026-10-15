/**
 * Edit → Pen Settings: how hard you have to press. One slider from soft
 * (light pressure already does a lot) to firm (it takes a firm hand),
 * with the curve drawn beside it, and a pad to try it on.
 */
import { useState, useSyncExternalStore, type FormEvent } from 'react'
import { applyResponse, penSettings } from '../app/brushes'
import { Dialog } from './Dialog'
import { Label } from './controls'

/** The slider runs −100..100; the response is 2 raised to it over 100 (½ to 2). */
const toResponse = (v: number) => 2 ** (v / 100)
const toSlider = (r: number) => Math.round(Math.log2(r) * 100)

export function PenDialog({ onClose }: { onClose(): void }) {
  const current = useSyncExternalStore(penSettings.subscribe, penSettings.get)
  const [v, setV] = useState(toSlider(current.response))
  const [felt, setFelt] = useState<{ raw: number; out: number } | null>(null)
  const response = toResponse(v)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    penSettings.set({ response })
    onClose()
  }
  const pts = Array.from({ length: 33 }, (_, i) => {
    const x = i / 32
    return `${(x * 100).toFixed(1)},${(100 - applyResponse(x, response) * 100).toFixed(1)}`
  }).join(' ')
  return (
    <Dialog
      id="pen"
      title="Pen Settings"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="pen-form" className="button primary">
            OK
          </button>
        </>
      }
    >
      <form id="pen-form" className="form" onSubmit={submit}>
        <div className="field">
          <Label htmlFor="pen-response" hint="Soft makes light pressure count for more; firm needs a heavier hand for the same stroke. Pressure only comes from a pen; a mouse always paints at full pressure.">
            Pressure response
          </Label>
          <div className="pen-row">
            <span className="field-meta">Soft</span>
            <input id="pen-response" type="range" min={-100} max={100} value={v} onChange={(e) => setV(Number(e.target.value))} />
            <span className="field-meta">Firm</span>
          </div>
        </div>
        <div className="pen-try">
          <svg className="pen-curve" viewBox="-8 -4 116 116" role="img" aria-label="Pressure from the pen, across, against pressure used, up">
            <rect x="0" y="0" width="100" height="100" className="pen-curve-box" />
            <line x1="0" y1="100" x2="100" y2="0" className="pen-curve-linear" />
            <polyline points={pts} className="pen-curve-line" />
            {felt && <circle cx={felt.raw * 100} cy={100 - felt.out * 100} r="3" className="pen-curve-dot" />}
          </svg>
          <div
            className="pen-pad"
            onPointerMove={(e) => e.pointerType === 'pen' && e.buttons && setFelt({ raw: e.pressure, out: applyResponse(e.pressure, response) })}
            onPointerUp={() => setFelt(null)}
          >
            {felt ? `${Math.round(felt.raw * 100)}% → ${Math.round(felt.out * 100)}%` : 'Press here with the pen to try it'}
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
