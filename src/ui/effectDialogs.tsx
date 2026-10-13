/**
 * The Filter dialog and the Layer Style dialog. Both show their result on
 * the canvas as the settings change (the document with the filter or the
 * style added, sent to the engine without a step), and commit once on OK.
 */
import { useEffect, useMemo, useState } from 'react'
import { applyAdjustment, applyFilter, commitFx, endPreview, filterNode, filterTarget, frameFor, previewDoc, withEffect } from '../app/effects'
import { ADJUSTMENT_BY_ID } from '../adjust/defs'
import { makeNode } from '../doc/nodes'
import type { OpenDoc } from '../app/documents'
import { defaultParams, readParamValues } from '../doc/params'
import { setFx } from '../doc/edit'
import type { LayerFx } from '../doc/types'
import { FILTER_BY_ID } from '../filters/defs'
import { FX_DEFS, FX_BY_KIND, type FxKind } from '../fx/defs'
import { Dialog } from './Dialog'
import { ParamControls } from './ParamControls'

/** Runs `fn` a moment after the last change, so a drag previews at the rate the engine keeps up with. */
function useSoon(fn: () => void, deps: unknown[]) {
  useEffect(() => {
    const t = setTimeout(fn, 60)
    return () => clearTimeout(t)
    // The caller lists what the preview depends on.
  }, deps)
}

export function FilterDialog({ doc: d, filter, onClose }: { doc: OpenDoc; filter: string; onClose(): void }) {
  const def = FILTER_BY_ID.get(filter)!
  const present = d.history.present
  const target = filterTarget(d)
  const selected = !!present.selection
  const canBake = target?.kind === 'pixel'
  const [values, setValues] = useState(() => defaultParams(def.params, present.mode))
  const [live, setLive] = useState(!selected || !canBake)
  // A framed filter (Twirl and the like) is kept on the box of the layer's content.
  const [frame, setFrame] = useState<number[] | null>(null)
  useEffect(() => {
    if (def.framed && target) void frameFor(present, target).then(setFrame)
    // Once, for the layer the dialog opened on.
  }, [])
  const settings = def.framed ? { ...values, frame } : values
  useSoon(() => {
    if (target) previewDoc(d.key, withEffect(present, target.id, filterNode(filter, settings)))
  }, [values, frame])
  const close = (ok: boolean) => {
    endPreview(d.key)
    onClose()
    if (ok) void applyFilter(filter, settings, live)
  }
  return (
    <Dialog
      id="filter"
      title={def.label}
      onClose={() => close(false)}
      footer={
        <>
          <button type="button" className="button" onClick={() => close(false)}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={() => close(true)} disabled={!target}>
            OK
          </button>
        </>
      }
    >
      <div className="form" data-filter={filter}>
        {!target && <p>Select a layer to filter.</p>}
        <ParamControls defs={def.params} values={values} doc={present} docKey={d.key} idPrefix={`filter-${filter}`} onChange={(v) => setValues(v)} />
        <label className="check" title="A live filter stays in the layer’s effects, where its settings can be changed later; otherwise the layer’s pixels are changed for good.">
          <input id="filter-live" type="checkbox" checked={live} disabled={!canBake} onChange={(e) => setLive(e.target.checked)} />
          Live (editable later)
        </label>
        {selected && live && canBake && <p className="field-note">A live filter works on the whole layer. Untick Live to filter only what’s selected.</p>}
        {selected && !live && <p className="field-note">Only what’s selected is filtered.</p>}
      </div>
    </Dialog>
  )
}

/** Document → Adjustments → (one): an adjustment previewed on the layer, then applied to its pixels or kept live. */
export function AdjustDialog({ doc: d, adjustment, onClose }: { doc: OpenDoc; adjustment: string; onClose(): void }) {
  const def = ADJUSTMENT_BY_ID.get(adjustment)!
  const present = d.history.present
  const target = filterTarget(d)
  const selected = !!present.selection
  const canBake = target?.kind === 'pixel'
  const [values, setValues] = useState(() => defaultParams(def.params, present.mode))
  const [live, setLive] = useState(!canBake)
  useSoon(() => {
    if (target) previewDoc(d.key, withEffect(present, target.id, makeNode('adjustment', 'adjust-preview', def.label, { adjustment, params: values })))
  }, [values])
  const close = (ok: boolean) => {
    endPreview(d.key)
    onClose()
    if (ok) void applyAdjustment(adjustment, values, live)
  }
  return (
    <Dialog
      id="adjust"
      title={def.label}
      onClose={() => close(false)}
      footer={
        <>
          <button type="button" className="button" onClick={() => close(false)}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={() => close(true)} disabled={!target}>
            OK
          </button>
        </>
      }
    >
      <div className="form" data-adjust={adjustment}>
        {!target && <p>Select a layer to adjust.</p>}
        <ParamControls defs={def.params} values={values} doc={present} docKey={d.key} idPrefix={`adjust-${adjustment}`} onChange={(v) => setValues(v)} />
        <label className="check" title="A live adjustment stays in the layer’s effects, where its settings can be changed later; otherwise the layer’s pixels are changed for good.">
          <input id="adjust-live" type="checkbox" checked={live} disabled={!canBake} onChange={(e) => setLive(e.target.checked)} />
          Live (editable later)
        </label>
        {selected && !live && <p className="field-note">Only what’s selected is changed.</p>}
      </div>
    </Dialog>
  )
}

/** Every effect kind, with the node's settings where it has them and defaults where it hasn't. */
function allFx(fx: LayerFx[], mode: 'rgb' | 'gray' | 'cmyk'): LayerFx[] {
  return FX_DEFS.map((def) => {
    const have = fx.find((f) => f.kind === def.kind)
    return { kind: def.kind, enabled: have?.enabled ?? false, params: readParamValues(def.params, have?.params ?? {}, mode) }
  })
}

export function LayerStyleDialog({ doc: d, node: id, start, onClose }: { doc: OpenDoc; node: string; start?: FxKind; onClose(): void }) {
  const present = d.history.present
  const node = present.nodes[id]
  const [list, setList] = useState(() => allFx(node?.fx ?? [], present.mode))
  const [current, setCurrent] = useState<FxKind>(start ?? (list.find((f) => f.enabled)?.kind as FxKind) ?? 'drop-shadow')
  // Kept: the ones switched on, and any the layer had before (so their settings aren't lost).
  const result = useMemo(() => list.filter((f) => f.enabled || node?.fx.some((x) => x.kind === f.kind)), [list, node])
  useSoon(() => {
    if (node) previewDoc(d.key, setFx(present, id, result))
  }, [result])
  if (!node) return null
  const entry = list.find((f) => f.kind === current)!
  const def = FX_BY_KIND.get(current)!
  const update = (kind: string, patch: Partial<LayerFx>) => setList((l) => l.map((f) => (f.kind === kind ? { ...f, ...patch } : f)))
  const close = (ok: boolean) => {
    endPreview(d.key)
    onClose()
    if (ok) commitFx(id, result)
  }
  return (
    <Dialog
      id="layerStyle"
      title={`Layer Style: ${node.name}`}
      onClose={() => close(false)}
      footer={
        <>
          <button type="button" className="button" onClick={() => close(false)}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={() => close(true)}>
            OK
          </button>
        </>
      }
    >
      <div className="layer-style">
        <ul className="fx-list" role="listbox" aria-label="Effects">
          {list.map((f) => (
            <li key={f.kind} className={`fx-item${f.kind === current ? ' current' : ''}`} role="option" aria-selected={f.kind === current} data-fx={f.kind}>
              <input type="checkbox" aria-label={`${FX_BY_KIND.get(f.kind as FxKind)!.label} on`} checked={f.enabled} onChange={(e) => {
                update(f.kind, { enabled: e.target.checked })
                setCurrent(f.kind as FxKind)
              }} />
              <button type="button" className="fx-name" onClick={() => setCurrent(f.kind as FxKind)}>
                {FX_BY_KIND.get(f.kind as FxKind)!.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="fx-settings form" data-fx-settings={current}>
          <h3>{def.label}</h3>
          <ParamControls defs={def.params} values={entry.params} doc={present} docKey={d.key} idPrefix={`fx-${current}`} onChange={(v) => update(current, { params: v, enabled: true })} />
        </div>
      </div>
    </Dialog>
  )
}
