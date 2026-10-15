/**
 * The Select menu's dialogs: Feather, Expand and Contract, Border and
 * Smooth, Colour Range, Save and Load Selection, and Select and Mask.
 *
 * Colour Range and Select and Mask show their result on the canvas as
 * their settings change (a selection in place of the document's, not yet a
 * step) and commit it as one step on OK. Both float beside the canvas
 * rather than covering it, and while they're open a press on the canvas is
 * theirs: Colour Range's eyedropper, Select and Mask's refine brush.
 */
import { useEffect, useRef, useState } from 'react'
import {
  addLayerMask,
  colourRangeSet,
  commitCombined,
  commitPreviewed,
  deselect,
  endPreview,
  freshChannelName,
  loadSelection,
  modifySelection,
  previewSelection,
  refineAll,
  saveSelection,
} from '../app/selection'
import { setCanvasCapture, setToolOverlay, clearToolOverlay } from '../app/canvasTools'
import { documents } from '../app/documents'
import { layerVia } from '../app/clipboard'
import { hold } from '../app/pixels'
import type { Doc } from '../doc/types'
import type { ColourRangePreset, CombineOp, Refine } from '../tiles/coverage'
import { ellipsePoints } from '../tiles/coverage'
import { Dialog } from './Dialog'
import { Field, Footer, parseNumber } from './docDialogs'
import { Hint, SliderField } from './controls'

/** A pixel radius typed in a field: a number from 0 to `max`. */
function radiusError(text: string, max: number): string | null {
  const n = parseNumber(text)
  if (n === null) return 'Enter a number.'
  if (n < 0 || n > max) return `Between 0 and ${max}.`
  return null
}

export function FeatherDialog({ onClose }: { onClose(): void }) {
  const [radius, setRadius] = useState('8')
  const error = radiusError(radius, 1000)
  return (
    <Dialog id="feather" title="Feather Selection" onClose={onClose} footer={<Footer form="feather-form" primary="Feather" onCancel={onClose} disabled={!!error} />}>
      <form
        id="feather-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (error) return
          onClose()
          modifySelection({ kind: 'feather', radius: parseNumber(radius)! }, 'Feather')
        }}
      >
        <Field id="feather-radius" label="Feather radius (px)" error={error} hint="Softens the selection’s edge over this many pixels, so what’s done through it fades out rather than stopping.">
          <input id="feather-radius" inputMode="decimal" value={radius} onChange={(e) => setRadius(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

export function GrowDialog({ kind, onClose }: { kind: 'expand' | 'contract'; onClose(): void }) {
  const [by, setBy] = useState('4')
  const error = radiusError(by, 256)
  const title = kind === 'expand' ? 'Expand Selection' : 'Contract Selection'
  return (
    <Dialog id={kind} title={title} hint={`Moves the selection’s edge ${kind === 'expand' ? 'outwards' : 'inwards'} by up to 256 pixels.`} onClose={onClose} footer={<Footer form="grow-form" primary={kind === 'expand' ? 'Expand' : 'Contract'} onCancel={onClose} disabled={!!error} />}>
      <form
        id="grow-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (error) return
          onClose()
          const n = parseNumber(by)!
          modifySelection({ kind: 'grow', radius: kind === 'expand' ? n : -n }, kind === 'expand' ? 'Expand' : 'Contract')
        }}
      >
        <Field id="grow-by" label={`${kind === 'expand' ? 'Expand' : 'Contract'} by (px)`} error={error}>
          <input id="grow-by" inputMode="decimal" value={by} onChange={(e) => setBy(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

/** Select → Modify → Border and Smooth: a width or a radius in pixels. */
export function BorderDialog({ kind, onClose }: { kind: 'border' | 'smooth'; onClose(): void }) {
  const [by, setBy] = useState(kind === 'border' ? '8' : '4')
  const error = radiusError(by, kind === 'border' ? 200 : 100)
  const title = kind === 'border' ? 'Border Selection' : 'Smooth Selection'
  return (
    <Dialog id={kind} title={title} onClose={onClose} footer={<Footer form="border-form" primary="OK" onCancel={onClose} disabled={!!error} />}>
      <form
        id="border-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (error) return
          onClose()
          const n = parseNumber(by)!
          modifySelection(kind === 'border' ? { kind: 'border', width: n } : { kind: 'smooth', radius: n }, kind === 'border' ? 'Border' : 'Smooth')
        }}
      >
        <Field id="border-by" label={kind === 'border' ? 'Width (px)' : 'Sample radius (px)'} error={error}>
          <input id="border-by" inputMode="decimal" value={by} onChange={(e) => setBy(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
        </Field>
        <p>{kind === 'border' ? 'Selects a band this wide along the selection’s edge, soft on both sides, and nothing inside it.' : 'Rounds off corners and stair-steps in the selection’s edge over this many pixels, keeping it crisp.'}</p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

const RANGE_PRESETS: [ColourRangePreset, string][] = [
  ['sampled', 'Sampled Colours'],
  ['reds', 'Reds'],
  ['yellows', 'Yellows'],
  ['greens', 'Greens'],
  ['cyans', 'Cyans'],
  ['blues', 'Blues'],
  ['magentas', 'Magentas'],
  ['highlights', 'Highlights'],
  ['midtones', 'Midtones'],
  ['shadows', 'Shadows'],
  ['skin', 'Skin Tones'],
]

const OPS: [CombineOp, string][] = [
  ['replace', 'New selection'],
  ['add', 'Add to selection'],
  ['subtract', 'Subtract from selection'],
  ['intersect', 'Intersect with selection'],
]

/** Asks for a preview whenever `key` changes, keeping only the latest; returns the latest set and whether one is being made. */
function usePreview(key: string, make: () => Promise<string | null>, skip = false) {
  const latest = useRef<{ set: string | null; release(): void } | null>(null)
  const asked = useRef(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (skip) {
      latest.current?.release()
      latest.current = null
      endPreview()
      return
    }
    const n = ++asked.current
    const t = setTimeout(() => {
      setBusy(true)
      void make()
        .then((set) => {
          const release = set ? hold([set]) : () => {}
          if (n !== asked.current) return release()
          latest.current?.release()
          latest.current = { set, release }
          previewSelection(set)
        })
        .finally(() => n === asked.current && setBusy(false))
    }, 120)
    return () => clearTimeout(t)
    // The settings' key and skip are what it depends on; the rest are read when it runs.
  }, [key, skip])
  const done = () => {
    asked.current++
    const r = latest.current
    latest.current = null
    return r
  }
  return { latest, busy, done }
}

/**
 * Select → Colour Range: sampled colours (click the canvas; Shift-click
 * adds another) with fuzziness, or a range of hues or tones, shown on the
 * canvas as it's set and combined with the selection on OK.
 */
export function ColourRangeDialog({ onClose }: { onClose(): void }) {
  const [preset, setPreset] = useState<ColourRangePreset>('sampled')
  const [samples, setSamples] = useState<[number, number][]>([])
  const [fuzziness, setFuzziness] = useState(40)
  const [inverted, setInverted] = useState(false)
  const [sampleAll, setSampleAll] = useState(true)
  const [op, setOp] = useState<CombineOp>('replace')
  const o = { preset, samples, fuzziness, invert: inverted, sampleAll }
  const skip = preset === 'sampled' && !samples.length
  const p = usePreview(JSON.stringify(o), () => colourRangeSet(o), skip)

  // The canvas is the eyedropper while the dialog is open.
  useEffect(() => {
    setCanvasCapture((pt) => {
      setPreset('sampled')
      setSamples((s) => (pt.shiftKey ? [...s, [pt.x, pt.y]] : [[pt.x, pt.y]]))
      return null
    })
    return () => setCanvasCapture(null)
  }, [])

  const close = (commit: boolean) => {
    const r = p.done()
    if (commit && r) void commitCombined(r.set, op, 'Colour Range')
    else endPreview()
    r?.release()
    setCanvasCapture(null)
    onClose()
  }
  return (
    <Dialog id="colourRange" title="Colour Range" floating onClose={() => close(false)} footer={<Footer form="range-form" primary="OK" onCancel={() => close(false)} disabled={p.busy || skip} />}>
      <form
        id="range-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          close(true)
        }}
      >
        <Field id="range-preset" label="Select">
          <select id="range-preset" value={preset} onChange={(e) => setPreset(e.target.value as ColourRangePreset)}>
            {RANGE_PRESETS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        {preset === 'sampled' && (
          <>
            <p data-range-samples={samples.length}>{samples.length ? `${samples.length} colour${samples.length === 1 ? '' : 's'} sampled. Click the canvas for another, Shift-click to add one.` : 'Click the canvas to sample a colour; Shift-click adds more.'}</p>
            <SliderField id="range-fuzz" label="Fuzziness" hint="How far from the sampled colours a colour may be and still be selected, fading out towards the limit" min={0} max={200} value={fuzziness} onChange={setFuzziness} />
          </>
        )}
        <label className="check">
          <input type="checkbox" checked={inverted} onChange={(e) => setInverted(e.target.checked)} />
          Invert
        </label>
        <label className="check">
          <input type="checkbox" checked={sampleAll} onChange={(e) => setSampleAll(e.target.checked)} />
          Sample all layers
        </label>
        <Field id="range-op" label="Selection">
          <select id="range-op" value={op} onChange={(e) => setOp(e.target.value as CombineOp)}>
            {OPS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

/** Select → Save Selection: into a new alpha channel, or into one there is. */
export function SaveSelectionDialog({ doc, onClose }: { doc: Doc; onClose(): void }) {
  const channels = doc.channels ?? []
  const [channel, setChannel] = useState('')
  const [name, setName] = useState(() => freshChannelName(doc))
  const [op, setOp] = useState<CombineOp>('replace')
  return (
    <Dialog id="saveSelection" title="Save Selection" hint="Alpha channels keep selections with the document, in the Channels panel, to load again whenever they’re wanted." onClose={onClose} footer={<Footer form="save-sel-form" primary="OK" onCancel={onClose} disabled={!channel && !name.trim()} />}>
      <form
        id="save-sel-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          onClose()
          void saveSelection({ channel: channel || null, name, op: channel ? op : 'replace' })
        }}
      >
        <Field id="save-sel-channel" label="Channel">
          <select id="save-sel-channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">New</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        {!channel ? (
          <Field id="save-sel-name" label="Name">
            <input id="save-sel-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
          </Field>
        ) : (
          <Field id="save-sel-op" label="Operation">
            <select id="save-sel-op" value={op} onChange={(e) => setOp(e.target.value as CombineOp)}>
              <option value="replace">Replace channel</option>
              <option value="add">Add to channel</option>
              <option value="subtract">Subtract from channel</option>
              <option value="intersect">Intersect with channel</option>
            </select>
          </Field>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

/** Select → Load Selection: an alpha channel as the selection, or combined with it. */
export function LoadSelectionDialog({ doc, onClose }: { doc: Doc; onClose(): void }) {
  const channels = doc.channels ?? []
  const [channel, setChannel] = useState(channels[0]?.id ?? '')
  const [inverted, setInverted] = useState(false)
  const [op, setOp] = useState<CombineOp>('replace')
  return (
    <Dialog id="loadSelection" title="Load Selection" onClose={onClose} footer={<Footer form="load-sel-form" primary="OK" onCancel={onClose} disabled={!channel} />}>
      <form
        id="load-sel-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          onClose()
          loadSelection(channel, { invert: inverted, op: doc.selection ? op : 'replace' })
        }}
      >
        <Field id="load-sel-channel" label="Channel">
          <select id="load-sel-channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="check">
          <input type="checkbox" checked={inverted} onChange={(e) => setInverted(e.target.checked)} />
          Invert
        </label>
        {doc.selection && (
          <Field id="load-sel-op" label="Operation">
            <select id="load-sel-op" value={op} onChange={(e) => setOp(e.target.value as CombineOp)}>
              {OPS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

const SLIDERS: { key: keyof Refine; label: string; min: number; max: number; step: number; unit: string; scale: number; hint: string }[] = [
  { key: 'smooth', label: 'Smooth', min: 0, max: 100, step: 1, unit: 'px', scale: 1, hint: 'Rounds off jagged edges and small corners.' },
  { key: 'feather', label: 'Feather', min: 0, max: 250, step: 0.5, unit: 'px', scale: 1, hint: 'Softens the edge.' },
  { key: 'contrast', label: 'Contrast', min: 0, max: 100, step: 1, unit: '%', scale: 100, hint: 'Sharpens a soft edge.' },
  { key: 'shift', label: 'Shift Edge', min: -100, max: 100, step: 1, unit: '%', scale: 100, hint: 'Moves the edge in (negative) or out.' },
]

type Output = 'selection' | 'mask' | 'layer'

/**
 * Select and Mask: Edge Detection (a radius, and Smart Radius) and the
 * Refine Edge brush, which re-estimate the edge from the image, then the
 * global refinements, then where the result goes.
 */
export function SelectMaskDialog({ onClose }: { onClose(): void }) {
  const [o, setO] = useState<Refine>({ smooth: 0, feather: 0, contrast: 0, shift: 0 })
  const [radius, setRadius] = useState(0)
  const [smart, setSmart] = useState(false)
  const [brushing, setBrushing] = useState(false)
  const [brushSize, setBrushSize] = useState(30)
  const [strokes, setStrokes] = useState<{ points: [number, number][]; radius: number }[]>([])
  const [output, setOutput] = useState<Output>('selection')
  const zero = o.smooth === 0 && o.feather === 0 && o.contrast === 0 && o.shift === 0 && radius === 0 && !strokes.length
  const all = { ...o, radius, smart, strokes }
  const p = usePreview(JSON.stringify(all), () => refineAll(all), zero)

  // With the refine brush on, a drag on the canvas brushes the edge.
  useEffect(() => {
    if (!brushing) return setCanvasCapture(null)
    const key = documents().getState().active
    setCanvasCapture((p0) => {
      const pts: [number, number][] = [[p0.x, p0.y]]
      const r = brushSize / 2
      const show = () => key && setToolOverlay(key, { shapes: [{ kind: 'path', points: pts.length > 1 ? pts : ellipsePoints(p0.x, p0.y, r, r), closed: pts.length === 1, style: 'thin' }] })
      show()
      return {
        move(q) {
          pts.push([q.x, q.y])
          show()
        },
        up() {
          if (key) clearToolOverlay(key)
          setStrokes((s) => [...s, { points: pts, radius: r }])
        },
        cancel() {
          if (key) clearToolOverlay(key)
        },
      }
    })
    return () => setCanvasCapture(null)
  }, [brushing, brushSize])

  const close = (commit: boolean) => {
    const r = p.done()
    setCanvasCapture(null)
    if (commit && r && !zero) {
      commitPreviewed(r.set, 'Select and Mask')
      if (output === 'mask') void addLayerMask('reveal-selection').then(() => deselect())
      else if (output === 'layer') void layerVia(false).then(() => deselect())
    } else {
      endPreview()
      if (commit && output === 'mask') void addLayerMask('reveal-selection').then(() => deselect())
      else if (commit && output === 'layer') void layerVia(false).then(() => deselect())
    }
    r?.release()
    onClose()
  }

  return (
    <Dialog id="selectMask" title="Select and Mask" hint="The canvas shows the result as you go: the edge worked out again first, then smooth, feather, contrast and shift, as Photoshop does them." floating onClose={() => close(false)} footer={<Footer form="refine-form" primary="OK" onCancel={() => close(false)} disabled={p.busy && !zero} />}>
      <form
        id="refine-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          close(true)
        }}
      >
        <fieldset className="form-group">
          <legend>Edge Detection</legend>
          <SliderField id="refine-radius" label="Radius" hint="How far either side of the edge it's worked out again from the image's colours: wider for hair and fur." min={0} max={250} unit="px" value={radius} onChange={setRadius} />
          <label className="check">
            <input type="checkbox" checked={smart} onChange={(e) => setSmart(e.target.checked)} />
            Smart Radius
            <Hint text="Narrower where the edge is crisp, wider where it's soft or busy" />
          </label>
          <label className="check" data-tip="Brush on the canvas over hair or fur the edge should be worked out again for">
            <input type="checkbox" checked={brushing} data-refine-brush onChange={(e) => setBrushing(e.target.checked)} />
            Refine Edge brush
          </label>
          {brushing && (
            <SliderField id="refine-brush-size" label="Brush size" min={2} max={500} unit="px" value={brushSize} onChange={setBrushSize} />
          )}
          {strokes.length > 0 && (
            <button type="button" className="button small" onClick={() => setStrokes([])}>
              Clear {strokes.length} brushed {strokes.length === 1 ? 'stroke' : 'strokes'}
            </button>
          )}
        </fieldset>
        {SLIDERS.map((s) => (
          <SliderField key={s.key} id={`refine-${s.key}`} label={s.label} hint={s.hint} min={s.min} max={s.max} step={s.step} unit={s.unit} value={Math.round(o[s.key] * s.scale * 10) / 10} onChange={(v) => setO({ ...o, [s.key]: v / s.scale })} />
        ))}
        <Field id="refine-output" label="Output to">
          <select id="refine-output" value={output} onChange={(e) => setOutput(e.target.value as Output)}>
            <option value="selection">Selection</option>
            <option value="mask">Layer Mask</option>
            <option value="layer">New Layer</option>
          </select>
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
