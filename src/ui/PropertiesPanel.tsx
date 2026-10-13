/**
 * The Properties panel: the selected layer's settings, or, with no layer
 * selected, the document's. With the layer's mask chosen (its thumbnail
 * clicked in the Layers panel), the mask's: density, feather, invert. An
 * adjustment layer and a live filter show their settings, generated from
 * their registry entries; a layer with a style lists its effects.
 *
 * A drag on the opacity slider is one history step however many values it
 * passes through: each change is committed under the same coalescing key.
 */
import { useState } from 'react'
import type { OpenDoc } from '../app/documents'
import { blendAllowed, nodeDef } from '../doc/nodes'
import { profileLabel } from '../color/profiles'
import type { BlendModeId, DocNode, KindProps } from '../doc/types'
import { formatLength } from '../doc/units'
import { BLEND_DEFS } from '../render/blendModes'
import { applyLayerMask, deleteLayerMask, maskOf, setMask, toggleMaskEnabled } from '../app/selection'
import { editContents, setNodeParams } from '../app/effects'
import { beginFreeTransform } from '../app/freeTransform'
import { beginLiquify } from '../app/liquify'
import { ADJUSTMENT_BY_ID } from '../adjust/defs'
import { FILTER_BY_ID } from '../filters/defs'
import { FX_BY_KIND, activeFx, type FxKind } from '../fx/defs'
import { readParamValues } from '../doc/params'
import { ParamControls } from './ParamControls'
import { PaintEditor, VectorProps } from './VectorProps'
import { setFillLayerPaint } from '../app/fills'
import { paintIn } from '../doc/vector'
import type { Doc } from '../doc/types'

const MODE_NAMES = { rgb: 'RGB', gray: 'Gray', cmyk: 'CMYK' }

interface Props {
  doc: OpenDoc
  onOpacity(id: string, opacity: number): void
  onFill(id: string, fill: number): void
  onBlend(id: string, blend: BlendModeId): void
  onVisible(id: string, visible: boolean): void
  onLockAll(id: string, all: boolean): void
  onLockPosition(id: string, position: boolean): void
  onResample(id: string, resample: KindProps['pixel']['resample']): void
  onKnockout(id: string, knockout: KindProps['group']['knockout']): void
  /** Opens the Layer Style dialog for the selected layer. */
  onStyle(): void
}

export function PropertiesPanel({ doc, ...on }: Props) {
  const d = doc.history.present
  const node = doc.selected ? d.nodes[doc.selected] : null
  const mask = node && doc.maskTarget ? maskOf(doc) : null
  if (node && mask) return <MaskProps layer={node} mask={mask} />
  if (node?.kind === 'filter') return <FilterProps node={node} doc={d} docKey={doc.key} onOpacity={on.onOpacity} onBlend={on.onBlend} />
  if (node) return <LayerProps node={node} doc={d} docKey={doc.key} {...on} />
  const ppi = d.resolution
  const profile = profileLabel(d.profile)
  return (
    <dl className="facts props-doc" data-props="document">
      <dt>Document</dt>
      <dd>{d.name}</dd>
      <dt>Size</dt>
      <dd>
        {d.width.toLocaleString()} × {d.height.toLocaleString()} px
      </dd>
      <dt>Print size</dt>
      <dd>
        {formatLength(d.width, 'mm', ppi)} × {formatLength(d.height, 'mm', ppi)} mm
      </dd>
      <dt>Resolution</dt>
      <dd>{ppi} ppi</dd>
      <dt>Colour</dt>
      <dd>
        {MODE_NAMES[d.mode]}, {d.depth}-bit
      </dd>
      <dt>Profile</dt>
      <dd>{profile}</dd>
    </dl>
  )
}

/** An adjustment's or a live filter's own settings, from its registry entry. */
function NodeParams({ node, doc, docKey }: { node: DocNode; doc: Doc; docKey: string }) {
  if (node.kind !== 'adjustment' && node.kind !== 'filter') return null
  const def = node.kind === 'adjustment' ? ADJUSTMENT_BY_ID.get(node.props.adjustment) : FILTER_BY_ID.get(node.props.filter)
  if (!def) return <p className="field-note">This kind of {node.kind === 'adjustment' ? 'adjustment' : 'filter'} isn’t known to this version of Plexel, so it does nothing here; its settings are kept.</p>
  const values = readParamValues(def.params, node.props.params, doc.mode)
  if (!def.params.length) return null
  return <ParamControls defs={def.params} values={values} doc={doc} docKey={docKey} idPrefix={`props-${node.id}`} onChange={(v, key) => setNodeParams(node.id, v, `params:${node.id}:${key}`)} />
}

/** A live filter on a layer (or a filter layer): its strength, how it's laid on, its settings, and for a warp the way back to editing it. */
function FilterProps({ node, doc, docKey, onOpacity, onBlend }: { node: DocNode; doc: Doc; docKey: string; onOpacity(id: string, o: number): void; onBlend(id: string, b: BlendModeId): void }) {
  const id = node.kind === 'filter' ? node.props.filter : ''
  const layer = !Object.values(doc.nodes).some((n) => n.effects.includes(node.id))
  return (
    <div className="form props-layer" data-props="filter">
      <div className="props-title">
        <strong>{node.name}</strong>
        <span className="layer-kind">{layer ? 'Filter Layer' : 'Live Filter'}</span>
      </div>
      <PercentField id="props-opacity" label="Opacity" title="How much of the filter is mixed in" value={node.opacity} onChange={(v) => onOpacity(node.id, v)} />
      {!layer && (
        <div className="field" title="How the filtered result is laid over what the filter was given, as Photoshop's smart filters' blending options">
          <label htmlFor="props-filter-blend">Blend mode</label>
          <select id="props-filter-blend" value={node.blend === 'pass-through' ? 'normal' : node.blend} onChange={(e) => onBlend(node.id, e.target.value as BlendModeId)}>
            {BLEND_DEFS.filter((b) => b.id !== 'pass-through').map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {(id === 'warp' || id === 'liquify') && (
        <div className="panel-tools">
          <button type="button" className="button small" data-edit-warp onClick={() => void (id === 'warp' ? beginFreeTransform('warp') : beginLiquify())}>
            {id === 'warp' ? 'Edit in Free Transform' : 'Edit in Liquify'}
          </button>
        </div>
      )}
      <NodeParams node={node} doc={doc} docKey={docKey} />
    </div>
  )
}

/** A layer mask's settings. Each slider drag is one step. */
function MaskProps({ layer, mask }: { layer: DocNode; mask: DocNode & { kind: 'mask' } }) {
  return (
    <div className="form props-layer" data-props="mask">
      <div className="props-title">
        <strong>{layer.name}</strong>
        <span className="layer-kind">{mask.props.source === 'vector' ? 'Vector Mask' : 'Layer Mask'}</span>
      </div>
      <PercentField id="props-density" label="Density" title="How much the mask hides: at 50% its black hides half" value={mask.props.density} onChange={(v) => setMask({ density: v }, `density:${mask.id}`)} />
      <div className="field" title="Softens the mask’s edges, live: the mask itself is unchanged">
        <label htmlFor="props-feather">Feather</label>
        <div className="slider-row">
          <input id="props-feather" type="range" min={0} max={250} step={0.5} value={mask.props.feather} onChange={(e) => setMask({ feather: Number(e.target.value) }, `feather:${mask.id}`)} />
          <span className="slider-number">{mask.props.feather}</span>
          <span className="unit">px</span>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={mask.props.invert} onChange={(e) => setMask({ invert: e.target.checked })} />
        Invert
      </label>
      <label className="check">
        <input type="checkbox" checked={mask.visible} onChange={() => toggleMaskEnabled()} />
        Enabled
      </label>
      <div className="panel-tools">
        <button type="button" className="button small" disabled={layer.kind !== 'pixel' || mask.props.source !== 'pixel'} onClick={() => void applyLayerMask()}>
          Apply
        </button>
        <button type="button" className="button small" onClick={() => deleteLayerMask()}>
          Delete
        </button>
      </div>
    </div>
  )
}

function LayerProps({ node, doc, docKey, onOpacity, onFill, onBlend, onVisible, onLockAll, onLockPosition, onResample, onKnockout, onStyle }: { node: DocNode; doc: Doc; docKey: string } & Omit<Props, 'doc'>) {
  const groups = BLEND_DEFS.filter((b) => blendAllowed(node.kind, b.id)).reduce<{ group: (typeof BLEND_DEFS)[number]['group']; defs: typeof BLEND_DEFS }[]>((out, b) => {
    const last = out[out.length - 1]
    if (last && last.group === b.group) last.defs.push(b)
    else out.push({ group: b.group, defs: [b] })
    return out
  }, [])
  return (
    <div className="form props-layer" data-props="layer">
      <div className="props-title">
        <strong>{node.name}</strong>
        <span className="layer-kind">{nodeDef(node.kind).label}</span>
      </div>
      <PercentField id="props-opacity" label="Opacity" value={node.opacity} onChange={(v) => onOpacity(node.id, v)} />
      <PercentField id="props-fill" label="Fill" title="Opacity of the layer’s own content, leaving layer effects at full strength" value={node.fillOpacity} onChange={(v) => onFill(node.id, v)} />
      <div className="field">
        <label htmlFor="props-blend">Blend mode</label>
        <select id="props-blend" value={node.blend} onChange={(e) => onBlend(node.id, e.target.value as BlendModeId)}>
          {groups.map((g) => (
            // Photoshop's sections, named for what the modes in each do.
            <optgroup key={g.group} label={GROUP_NAMES[g.group]}>
              {g.defs.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {node.kind === 'pixel' && (
        <div className="field">
          <label htmlFor="props-resample">Resampling</label>
          <select id="props-resample" value={node.props.resample} onChange={(e) => onResample(node.id, e.target.value as KindProps['pixel']['resample'])}>
            {RESAMPLE.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}
      {node.kind === 'group' && (
        <div className="field">
          <label htmlFor="props-knockout">Knockout</label>
          <select id="props-knockout" value={node.props.knockout} onChange={(e) => onKnockout(node.id, e.target.value as KindProps['group']['knockout'])}>
            {KNOCKOUT.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={node.visible} onChange={(e) => onVisible(node.id, e.target.checked)} />
        Visible
      </label>
      <label className="check">
        <input type="checkbox" checked={node.locked.all} onChange={(e) => onLockAll(node.id, e.target.checked)} />
        Locked
      </label>
      <label className="check" title="Can’t be moved or transformed, but can still be painted">
        <input type="checkbox" checked={node.locked.position} disabled={node.locked.all} onChange={(e) => onLockPosition(node.id, e.target.checked)} />
        Lock position
      </label>
      {node.kind === 'adjustment' && <NodeParams node={node} doc={doc} docKey={docKey} />}
      {(node.kind === 'vector' || node.kind === 'boolean' || node.kind === 'text') && <VectorProps node={node} doc={doc} />}
      {node.kind === 'fill' && (
        <div className="props-fill" data-props="fill">
          <PaintEditor id="props-fill" doc={doc} paint={paintIn(node.props.paint, doc.mode)} onChange={(paint, key) => setFillLayerPaint(node.id, paint, `fill-paint:${node.id}:${key}`)} />
          <p className="field-note">A fill layer covers the whole canvas; paint its mask, or add one from a selection, to shape it.</p>
        </div>
      )}
      {node.kind === 'embedded' && (
        <button type="button" className="button small" onClick={editContents} title="Open the smart object’s contents in a tab of their own; Save there puts them back">
          Edit Contents
        </button>
      )}
      {node.kind !== 'adjustment' && (
        <div className="field props-style" data-props-style>
          <span className="field-label">Layer style</span>
          {activeFx(node.fx).length ? (
            <ul className="props-fx">
              {activeFx(node.fx).map((f) => (
                <li key={f.kind}>{FX_BY_KIND.get(f.kind as FxKind)?.label ?? f.kind}</li>
              ))}
            </ul>
          ) : (
            <span className="field-note">None</span>
          )}
          <button type="button" className="button small" onClick={onStyle}>
            Layer Style…
          </button>
        </div>
      )}
    </div>
  )
}

const GROUP_NAMES: Record<(typeof BLEND_DEFS)[number]['group'], string> = {
  group: 'Group',
  normal: 'Normal',
  darken: 'Darken',
  lighten: 'Lighten',
  contrast: 'Contrast',
  inversion: 'Difference',
  component: 'Colour',
}

const RESAMPLE: [KindProps['pixel']['resample'], string][] = [
  ['nearest', 'Nearest Neighbour (hard edges)'],
  ['bilinear', 'Bilinear'],
  ['bicubic', 'Bicubic (smooth)'],
  ['lanczos', 'Lanczos (sharpest)'],
]

const KNOCKOUT: [KindProps['group']['knockout'], string][] = [
  ['none', 'None'],
  ['shallow', 'Shallow: to the layers below the group'],
  ['deep', 'Deep: to the bottom layer'],
]

/** A 0..1 value as a percentage: a slider and a typed number side by side. */
function PercentField({ id, label, title, value, onChange }: { id: string; label: string; title?: string; value: number; onChange(v: number): void }) {
  const pct = Math.round(value * 100)
  const [typed, setTyped] = useState<string | null>(null)
  return (
    <div className="field" title={title}>
      <label htmlFor={id}>{label}</label>
      <div className="slider-row">
        <input id={id} type="range" min={0} max={100} value={pct} onChange={(e) => onChange(Number(e.target.value) / 100)} />
        <input
          className="slider-number"
          aria-label={`${label}, percent`}
          inputMode="numeric"
          value={typed ?? String(pct)}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => {
            const n = Number(typed)
            if (typed !== null && Number.isFinite(n)) onChange(Math.min(100, Math.max(0, n)) / 100)
            setTyped(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="unit">%</span>
      </div>
    </div>
  )
}
