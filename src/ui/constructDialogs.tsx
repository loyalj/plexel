/**
 * Object → Path → Offset Path… and Simplify…: each previewed on the canvas
 * as its settings change, committed once on OK.
 */
import { useEffect, useState } from 'react'
import { offsetShape, simplified } from '../app/construct'
import { endPreview, previewDoc } from '../app/effects'
import type { OpenDoc } from '../app/documents'
import { Dialog } from './Dialog'
import { NumberParam } from './ParamControls'

const num = (key: string, label: string, min: number, max: number, step: number, unit: string, hint?: string) => ({ key, kind: 'number' as const, label, min, max, step, unit, default: min, hint })

function Foot({ onCancel, onOk }: { onCancel(): void; onOk(): void }) {
  return (
    <>
      <button type="button" className="button" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="button primary" onClick={onOk}>
        OK
      </button>
    </>
  )
}

export function OffsetPathDialog({ doc: d, onClose }: { doc: OpenDoc; onClose(): void }) {
  const [distance, setDistance] = useState(10)
  const [join, setJoin] = useState<'miter' | 'round' | 'bevel'>('miter')
  const [miter, setMiter] = useState(4)
  useEffect(() => {
    const t = setTimeout(() => {
      const next = offsetShape(distance, join, miter, false)
      if (next) previewDoc(d.key, next)
    }, 60)
    return () => clearTimeout(t)
  }, [distance, join, miter])
  const close = (ok: boolean) => {
    endPreview(d.key)
    onClose()
    if (ok) offsetShape(distance, join, miter, true)
  }
  return (
    <Dialog id="offsetPath" floating="preview" title="Offset Path" hint="A new shape just below the selected one, its outline moved out by the offset (in, when negative)." onClose={() => close(false)} footer={<Foot onCancel={() => close(false)} onOk={() => close(true)} />}>
      <div className="form" data-offset-path>
        <NumberParam id="offset-distance" def={{ ...num('distance', 'Offset', -500, 500, 0.5, 'px'), default: 10 }} value={distance} onChange={setDistance} />
        <div className="field">
          <label htmlFor="offset-join">Joins</label>
          <select id="offset-join" value={join} onChange={(e) => setJoin(e.target.value as 'miter' | 'round' | 'bevel')}>
            <option value="miter">Miter</option>
            <option value="round">Round</option>
            <option value="bevel">Bevel</option>
          </select>
        </div>
        {join === 'miter' && <NumberParam id="offset-miter" def={{ ...num('miter', 'Miter limit', 1, 20, 0.5, '×'), default: 4 }} value={miter} onChange={setMiter} />}
      </div>
    </Dialog>
  )
}

export function SimplifyDialog({ doc: d, onClose }: { doc: OpenDoc; onClose(): void }) {
  const [tolerance, setTolerance] = useState(2)
  const [corner, setCorner] = useState(60)
  const [counts, setCounts] = useState<[number, number] | null>(null)
  useEffect(() => {
    const t = setTimeout(() => {
      const s = simplified(tolerance, corner)
      if (!s) return
      setCounts([s.before, s.after])
      previewDoc(d.key, s.doc)
    }, 60)
    return () => clearTimeout(t)
  }, [tolerance, corner])
  const close = (ok: boolean) => {
    endPreview(d.key)
    onClose()
    if (ok) simplified(tolerance, corner)?.apply()
  }
  return (
    <Dialog id="simplify" floating="preview" title="Simplify" onClose={() => close(false)} footer={<Foot onCancel={() => close(false)} onOk={() => close(true)} />}>
      <div className="form" data-simplify>
        <NumberParam id="simplify-tolerance" def={{ ...num('tolerance', 'Precision', 0.1, 50, 0.1, 'px', 'How far the path may move: further for fewer anchors.'), default: 2 }} value={tolerance} onChange={setTolerance} />
        <NumberParam id="simplify-corner" def={{ ...num('corner', 'Corners sharper than', 10, 170, 1, '°', 'Kept as corners: turns sharper than this.'), default: 60 }} value={corner} onChange={setCorner} />
        {counts && (
          <p className="field-meta" data-simplify-counts>
            {counts[0]} anchors, then {counts[1]}.
          </p>
        )}
      </div>
    </Dialog>
  )
}
