/**
 * Define Brush Preset (Edit menu): the tip the image under the selection
 * makes (app/brushImport.ts), shown, and named before it's kept.
 */
import { useEffect, useRef, useState } from 'react'
import { addDefinedBrush, defineTip, type DefinedTip } from '../app/brushImport'
import { Dialog } from './Dialog'
import { Field, Footer } from './docDialogs'

const SIDE = 160

export function DefineBrushDialog({ onClose }: { onClose(): void }) {
  const [tip, setTip] = useState<DefinedTip | string | null>(null)
  const [name, setName] = useState('Sampled Brush')
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    void defineTip().then(setTip)
  }, [])
  useEffect(() => {
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx || !tip || typeof tip === 'string') return
    // The tip fitted into the square, darkness as paint, in the panel's ink colour.
    const k = Math.max(tip.width, tip.height) / SIDE
    const img = ctx.createImageData(SIDE, SIDE)
    const ink = getComputedStyle(c).color.match(/\d+/g)?.map(Number) ?? [220, 220, 220]
    for (let y = 0; y < SIDE; y++)
      for (let x = 0; x < SIDE; x++) {
        const sx = Math.floor((x - (SIDE - tip.width / k) / 2) * k)
        const sy = Math.floor((y - (SIDE - tip.height / k) / 2) * k)
        const v = sx >= 0 && sy >= 0 && sx < tip.width && sy < tip.height ? tip.data[sy * tip.width + sx] : 0
        img.data.set([ink[0], ink[1], ink[2], v], (y * SIDE + x) * 4)
      }
    ctx.putImageData(img, 0, 0)
  }, [tip])
  const ready = tip && typeof tip !== 'string'
  const blank = !name.trim()
  return (
    <Dialog id="defineBrush" title="Define Brush Preset" onClose={onClose} footer={<Footer form="define-brush-form" primary="Define" onCancel={onClose} disabled={!ready || blank} />}>
      <form
        id="define-brush-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!ready || blank) return
          void addDefinedBrush(name.trim(), tip).then(onClose)
        }}
      >
        {!tip && <p>Making the tip…</p>}
        {typeof tip === 'string' && <p data-define-brush-error>{tip}</p>}
        {ready && (
          <>
            <canvas ref={canvas} width={SIDE} height={SIDE} className="brush-settings-preview" data-define-brush-tip style={{ width: SIDE }} />
            <p className="field-note">
              {tip.width} × {tip.height} pixels{Math.max(tip.width, tip.height) > 1024 ? ', kept at 1,024 pixels across' : ''}. Darker parts of the image paint more; white and transparent parts paint nothing.
            </p>
            <Field id="define-brush-name" label="Name" error={blank ? 'A brush needs a name.' : null}>
              <input id="define-brush-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
            </Field>
          </>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
