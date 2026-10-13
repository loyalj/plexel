/**
 * Edit → Fill and Edit → Define Pattern.
 *
 * Fill takes Photoshop's contents (the two colours, a colour of your own,
 * a pattern, content-aware, black, 50% gray, white) and blending (mode,
 * opacity, Preserve Transparency), and fills the selected layer (or its
 * mask) through the selection as one step.
 */
import { useState } from 'react'
import { definePattern, fillWith, freshPatternName, type FillContents } from '../app/fills'
import { tilingOf, type BlendModeId, type Doc } from '../doc/types'
import { BLEND_DEFS } from '../render/blendModes'
import { Dialog } from './Dialog'
import { Field, Footer } from './docDialogs'
import { ColourParam } from './ParamControls'

const CONTENTS: [FillContents, string][] = [
  ['fg', 'Foreground Colour'],
  ['bg', 'Background Colour'],
  ['colour', 'Colour…'],
  ['pattern', 'Pattern'],
  ['content-aware', 'Content-Aware'],
  ['black', 'Black'],
  ['gray', '50% Gray'],
  ['white', 'White'],
]

/** What the dialog was last used to fill with, for the next time this session. */
let lastContents: FillContents = 'fg'

export function FillDialog({ doc, onClose }: { doc: Doc; onClose(): void }) {
  const [contents, setContents] = useState<FillContents>(lastContents)
  const [colour, setColour] = useState<number[]>(doc.mode === 'cmyk' ? [0, 0, 0, 1] : doc.mode === 'gray' ? [0] : [0, 0, 0])
  const patterns = doc.patterns ?? []
  const [pattern, setPattern] = useState(patterns[0]?.id ?? '')
  const [scale, setScale] = useState('100')
  const [blend, setBlend] = useState<BlendModeId>('normal')
  const [opacity, setOpacity] = useState('100')
  const [preserve, setPreserve] = useState(false)
  const op = Number(opacity)
  const sc = Number(scale)
  const error =
    !Number.isFinite(op) || op < 0 || op > 100
      ? 'Opacity is from 0 to 100.'
      : contents === 'pattern' && !patterns.length
        ? 'This document has no patterns yet: Edit → Define Pattern makes one.'
        : contents === 'pattern' && (!Number.isFinite(sc) || sc < 1 || sc > 1000)
          ? 'Scale is from 1 to 1000%.'
          : contents === 'content-aware' && !doc.selection
            ? 'Content-aware fill fills a selection: select what to replace first.'
            : null
  return (
    <Dialog id="fill" title="Fill" onClose={onClose} footer={<Footer form="fill-form" primary="Fill" onCancel={onClose} disabled={!!error} />}>
      <form
        id="fill-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (error) return
          lastContents = contents
          onClose()
          void fillWith({ contents, colour, pattern, scale: sc / 100, blend, opacity: op / 100, preserve })
        }}
      >
        <Field id="fill-contents" label="Contents" error={error}>
          <select id="fill-contents" value={contents} onChange={(e) => setContents(e.target.value as FillContents)} autoFocus>
            {CONTENTS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        {contents === 'colour' && <ColourParam id="fill-colour" label="Colour" value={colour} doc={doc} onChange={setColour} />}
        {contents === 'pattern' && patterns.length > 0 && (
          <>
            <Field id="fill-pattern" label="Pattern">
              <select id="fill-pattern" value={pattern} onChange={(e) => setPattern(e.target.value)}>
                {patterns.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.width} × {p.height})
                  </option>
                ))}
              </select>
            </Field>
            <Field id="fill-scale" label="Scale (%)">
              <input id="fill-scale" inputMode="decimal" value={scale} onChange={(e) => setScale(e.target.value)} />
            </Field>
          </>
        )}
        {contents === 'content-aware' && <p>Makes what’s selected again from the layer round it, as if it had never been there. Works on the selected pixel layer; it can take a few seconds.</p>}
        <fieldset className="form-group">
          <legend>Blending</legend>
          <Field id="fill-blend" label="Mode">
            <select id="fill-blend" value={blend} onChange={(e) => setBlend(e.target.value as BlendModeId)}>
              {BLEND_DEFS.filter((b) => b.id !== 'pass-through').map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </Field>
          <Field id="fill-opacity" label="Opacity (%)">
            <input id="fill-opacity" inputMode="decimal" value={opacity} onChange={(e) => setOpacity(e.target.value)} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={preserve} onChange={(e) => setPreserve(e.target.checked)} />
            Preserve Transparency
          </label>
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

export function DefinePatternDialog({ doc, onClose }: { doc: Doc; onClose(): void }) {
  const [name, setName] = useState(() => freshPatternName(doc))
  // A tiled document's canvas is already one repeat: kept whole to start with, edges and all.
  const [whole, setWhole] = useState(() => tilingOf(doc) !== 'off')
  return (
    <Dialog id="definePattern" title="Define Pattern" onClose={onClose} footer={<Footer form="pattern-form" primary="OK" onCancel={onClose} disabled={!name.trim()} />}>
      <form
        id="pattern-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim()) return
          onClose()
          void definePattern(name, whole)
        }}
      >
        <Field id="pattern-name" label="Name">
          <input id="pattern-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
        </Field>
        {!doc.selection && (
          <label className="check">
            <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} data-pattern-whole />
            <span>The whole canvas, transparent edges kept, so it repeats as the document does</span>
          </label>
        )}
        <p>{doc.selection ? 'What’s visible inside the selection’s bounds' : 'The whole canvas as it looks'} becomes one repeat of a pattern kept in this document, for fills, fill layers, the Paint Bucket and shapes.</p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
