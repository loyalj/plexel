/**
 * A shape's part of the Properties panel: its live shape's settings (or
 * its path's fill rule), how it combines in a compound shape, and its
 * appearance stack, the fills and strokes it's painted with, top first as
 * Illustrator's Appearance panel lists them.
 *
 * Every control commits as it changes; a drag of one control is one step.
 */
import { linkable, swatchPaint } from '../doc/swatches'
import { ARROW_SHAPES, WIDTH_PRESETS, presetOf, type ArrowShape, type Arrowhead, type WidthPoint } from '../geom/stroke'
import { swatchColourIn } from '../app/docSwatches'
import { useRef, useState, useSyncExternalStore } from 'react'
import { flipAcross, flipAlong, sameProfile } from '../geom/width'
import { widthProfiles } from '../app/widthProfiles'
import { brushById, brushChoices, brushOptions } from '../app/vectorBrushes'
import type { VectorBrush } from '../doc/vectorBrush'
import { setOperandOp, setShapeAppearance, setShapeGeometry, convertSelectedToPath, expandSelectedCompound, releaseSelectedCompound } from '../app/vectors'
import { swatchIn } from '../app/colour'
import { placeOf } from '../doc/tree'
import type { BlendModeId, BoolOp, Doc, DocNode } from '../doc/types'
import { ALIGNS, CAPS, GRADIENT_TYPES, JOINS, appearanceIn, fillItem, gradientPaint, solid, strokeItem, type AppearanceItem, type Paint, type PaintStop } from '../doc/vector'
import { anchorCount } from '../geom/path'
import { SHAPE_LABEL, shapeBox, withBox, type ShapeParams } from '../geom/shapes'
import { BLEND_DEFS } from '../render/blendModes'
import { PATTERNS, PATTERN_BY_ID } from '../vector/patterns'
import { ColourParam, NumberParam, ParamControls, swatchCss } from './ParamControls'
import { PATH_EFFECTS, effectLabel, effectValues, pixelEffectIds, stageOf, type ItemEffect } from '../vector/itemEffects'
import { FILTER_BY_ID } from '../filters/defs'
import { defaultParams } from '../doc/params'
import { linkOf } from '../doc/graphicStyles'
import { layoutOf } from '../app/text'
import { createOutlines } from '../app/typing'
import { documents } from '../app/documents'
import { setTextProps } from '../doc/edit'
import { Icon } from './Icon'
import { DocColourChip } from './ColourChip'
import { Hint, Label, NumberInput, ScrubLabel, Segmented } from './controls'

const OPS: [BoolOp, string][] = [
  ['add', 'Unite'],
  ['subtract', 'Subtract'],
  ['intersect', 'Intersect'],
  ['exclude', 'Exclude'],
]

const FILL_RULES = [
  ['nonzero', 'Non-zero'],
  ['evenodd', 'Even-odd'],
] as const
const CORNER_STYLES = [
  ['round', 'Round'],
  ['chamfer', 'Chamfer'],
  ['inset', 'Set in'],
] as const
const PAINT_KINDS: [Paint['kind'], string][] = [
  ['solid', 'Colour'],
  ['gradient', 'Gradient'],
  ['pattern', 'Pattern'],
]

/** A number setting; `def` is its default, marked when it's off it (none when it has none). */
const num = (key: string, label: string, min: number, max: number, step: number, unit: string, hint?: string, def = NaN) => ({
  key,
  kind: 'number' as const,
  label,
  min,
  max,
  step,
  unit,
  default: def,
  hint,
})

export function VectorProps({ node, doc }: { node: DocNode; doc: Doc }) {
  const place = placeOf(doc, node.id)
  const compound = place?.slot === 'children' && doc.nodes[place.parent]?.kind === 'boolean' ? doc.nodes[place.parent] : null
  return (
    <div className="props-vector" data-props="vector">
      {compound && <OperandOp compound={compound} node={node} />}
      {node.kind === 'vector' && node.props.geometry?.kind === 'shape' && <ShapeFields node={node} shape={node.props.geometry.shape} />}
      {node.kind === 'vector' && node.props.geometry?.kind === 'path' && (
        <>
          <Segmented
            id="props-fill-rule"
            label="Fill rule"
            hint="Where the outline crosses itself: Non-zero fills it all, Even-odd leaves holes where outlines overlap"
            value={node.props.geometry.path.fillRule}
            options={FILL_RULES}
            onChange={(v) =>
              node.kind === 'vector' &&
              node.props.geometry?.kind === 'path' &&
              setShapeGeometry(node.id, {
                kind: 'path',
                path: { ...node.props.geometry.path, fillRule: v },
              })
            }
          />
          <span className="field-meta" data-anchor-count={anchorCount(node.props.geometry.path)}>
            {anchorCount(node.props.geometry.path)} points · {node.props.geometry.path.subpaths.length} outline{node.props.geometry.path.subpaths.length === 1 ? '' : 's'}
            <Hint text="Direct Selection (A) edits them." />
          </span>
        </>
      )}
      {node.kind === 'text' && <TextFacts node={node} doc={doc} />}
      {node.kind === 'boolean' && (
        <div className="panel-tools">
          <button type="button" className="button small" onClick={expandSelectedCompound} data-tip="One path with the combined outline">
            Expand
          </button>
          <button type="button" className="button small" onClick={releaseSelectedCompound} data-tip="The shapes back as they were">
            Release
          </button>
        </div>
      )}
      {compound ? (
        <p className="field-empty">
          Painted by “{compound.name}” <Hint text="Part of a compound shape, which is painted with its own fills and strokes." />
        </p>
      ) : (node.kind === 'vector' || node.kind === 'boolean' || node.kind === 'text') && <Appearance node={node} doc={doc} />}
    </div>
  )
}

/** What kind of text a layer is, whether it all fits, and turning it into shapes. */
function TextFacts({ node, doc }: { node: DocNode; doc: Doc }) {
  if (node.kind !== 'text') return null
  const l = layoutOf(node, doc)
  const kind = node.props.mode === 'area' ? 'Area text' : node.props.mode === 'path' ? 'Text on a path' : 'Point text'
  return (
    <div className="field" data-text-facts>
      <span className="field-label">{kind}</span>
      {l?.overflow && (
        <span className="field-warning" data-text-overflow>
          Overset text <Hint text={node.props.mode === 'path' ? 'Some of the text runs past the path’s end and isn’t shown.' : 'Some of the text doesn’t fit the frame and isn’t shown.'} />
        </span>
      )}
      {!!l?.missing.length && (
        <span className="field-warning">
          Missing: {l.missing.join(', ')} <Hint text="Shown in Inter until the font is added." />
        </span>
      )}
      {node.props.mode === 'path' && (
        <NumberParam
          id="text-path-start"
          def={num('pathOffset', 'Start along the path', 0, 1000000, 1, 'px', 'How far along its path the text starts (from the path’s start; for centred and right-aligned text, from the middle and the end)')}
          value={node.props.pathOffset}
          onChange={(v) => documents().commit((x) => setTextProps(x, node.id, { pathOffset: v }), { label: 'Path Text', coalesce: `text-start:${node.id}` })}
        />
      )}
      <button type="button" className="button small" onClick={createOutlines} data-tip="The text as a shape with the same fills and strokes; it can’t be edited as text after">
        Create Outlines
      </button>
    </div>
  )
}

function OperandOp({ compound, node }: { compound: DocNode; node: DocNode }) {
  if (compound.kind !== 'boolean') return null
  const base = compound.children?.[0] === node.id
  return (
    <div className="field">
      <label htmlFor="props-bool-op">In “{compound.name}”</label>
      {base ? (
        <span className="field-empty">
          Base shape <Hint text="The shapes above it combine with it." />
        </span>
      ) : (
        <select id="props-bool-op" value={compound.props.ops[node.id] ?? 'add'} onChange={(e) => setOperandOp(compound.id, node.id, e.target.value as BoolOp)}>
          {OPS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

/** A live shape's own settings: its box, and what it has (corners, sides, points). */
function ShapeFields({ node, shape }: { node: DocNode; shape: ShapeParams }) {
  const set = (next: ShapeParams, key: string) => setShapeGeometry(node.id, { kind: 'shape', shape: next }, `shape:${node.id}:${key}`)
  const [x, y, w, h] = shapeBox(shape)
  const box = (key: 'x' | 'y' | 'w' | 'h', v: number) => set(withBox(shape, key === 'x' ? v : x, key === 'y' ? v : y, key === 'w' ? v : w, key === 'h' ? v : h), key)
  return (
    <div className="shape-fields" data-shape={shape.type}>
      <div className="field">
        <span className="field-label">{SHAPE_LABEL[shape.type]}</span>
        <div className="box-fields">
          {(['x', 'y', 'w', 'h'] as const).map((k) => (
            <BoxField key={k} id={`props-shape-${k}`} label={k.toUpperCase()} value={{ x, y, w, h }[k]} onChange={(v) => box(k, v)} />
          ))}
        </div>
      </div>
      {shape.type === 'rect' && (
        <>
          <NumberParam id="props-shape-radius" def={num('radius', 'Corners', 0, Math.max(1, Math.min(w, h) / 2), 0.5, 'px', 'How far round all four corners are', 0)} value={Math.max(...shape.radii)} onChange={(v) => set({ ...shape, radii: [v, v, v, v] }, 'radius')} />
          <Segmented id="props-shape-corner" label="Corner style" defaultValue="round" value={shape.corner} options={CORNER_STYLES} onChange={(v) => set({ ...shape, corner: v }, 'corner')} />
        </>
      )}
      {shape.type === 'polygon' && <NumberParam id="props-shape-sides" def={num('sides', 'Sides', 3, 40, 1, '')} value={shape.sides} onChange={(v) => set({ ...shape, sides: Math.round(v) }, 'sides')} />}
      {shape.type === 'star' && (
        <>
          <NumberParam id="props-shape-points" def={num('points', 'Points', 3, 40, 1, '')} value={shape.points} onChange={(v) => set({ ...shape, points: Math.round(v) }, 'points')} />
          <NumberParam id="props-shape-inner" def={num('inner', 'Inner radius', 1, 100, 1, '%', 'How far in the inner corners are')} value={Math.round(shape.inner * 100)} onChange={(v) => set({ ...shape, inner: v / 100 }, 'inner')} />
        </>
      )}
      <button type="button" className="button small" onClick={convertSelectedToPath} data-tip="Its outline as a path, whose points can then be edited; its settings here go">
        Convert to Path
      </button>
    </div>
  )
}

/** One of a box's numbers: its letter scrubs it. */
function BoxField({ id, label, value, onChange }: { id: string; label: string; value: number; onChange(v: number): void }) {
  return (
    <div className="box-field">
      <ScrubLabel htmlFor={id} value={value} min={-Infinity} max={Infinity} step={1} onChange={onChange}>
        {label}
      </ScrubLabel>
      <NumberInput id={id} value={value} step={0.01} format={(v) => String(Math.round(v * 10) / 10)} onChange={onChange} />
    </div>
  )
}

/** A paint as a little picture: its colour, or its gradient, or its pattern's two colours. */
export function paintCss(p: Paint, mode: Doc['mode']): string {
  if (p.kind === 'solid') return swatchCss(p.colour, mode)
  if (p.kind === 'pattern' && !PATTERN_BY_ID.has(p.pattern)) return 'repeating-conic-gradient(#888 0 25%, #ccc 0 50%) 0 0 / 8px 8px'
  if (p.kind === 'pattern') return `repeating-linear-gradient(45deg, ${swatchCss(p.colour, mode)} 0 3px, ${swatchCss(p.background, mode)} 3px 6px)`
  return `linear-gradient(to right, ${p.stops.map((s) => `${swatchCss(s.colour, mode)} ${Math.round(s.at * 100)}%`).join(', ')})`
}

const itemLabel = (it: AppearanceItem) => (it.kind === 'fill' ? 'Fill' : `Stroke ${Math.round(it.width * 100) / 100} px`)

function Appearance({ node, doc }: { node: DocNode; doc: Doc }) {
  const items = node.kind === 'vector' || node.kind === 'boolean' || node.kind === 'text' ? appearanceIn(node.props.appearance, doc.mode) : []
  const [open, setOpen] = useState<number | null>(items.length ? items.length - 1 : null)
  const commit = (next: AppearanceItem[], key?: string) => setShapeAppearance(node.id, next, key ? `appearance:${node.id}:${key}` : undefined)
  const colourOf = (): number[] => {
    const c = swatchIn(doc, 'fg')
    return c ?? (doc.mode === 'cmyk' ? [0, 0, 0, 1] : doc.mode === 'gray' ? [0] : [0, 0, 0])
  }
  const add = (kind: 'fill' | 'stroke') => {
    const item = kind === 'fill' ? fillItem(solid(colourOf())) : strokeItem(solid(colourOf()), 2)
    commit([...items, item])
    setOpen(items.length)
  }
  const at = open !== null && open < items.length ? open : null
  return (
    <div className="field appearance" data-appearance>
      <div className="appearance-head">
        <span className="field-label">Appearance</span>
        <button type="button" className="button small" data-appearance-add="fill" onClick={() => add('fill')}>
          + Fill
        </button>
        <button type="button" className="button small" data-appearance-add="stroke" onClick={() => add('stroke')}>
          + Stroke
        </button>
      </div>
      {linkOf(node) && (
        <p className="field-meta" data-graphic-style-link>
          Style: {doc.graphicStyles?.find((g) => g.id === linkOf(node))?.name ?? 'missing'} <Hint text="A graphic style. A change here breaks the link to it." />
        </p>
      )}
      {items.length === 0 && <p className="field-empty">No fills or strokes</p>}
      <ul className="appearance-list">
        {items
          .map((it, i) => ({ it, i }))
          .reverse()
          .map(({ it, i }) => (
            <li key={i} className={`appearance-item${at === i ? ' open' : ''}${it.enabled ? '' : ' off'}`} data-appearance-item={i} data-kind={it.kind}>
              <input type="checkbox" aria-label={`Show ${itemLabel(it)}`} checked={it.enabled} onChange={(e) => commit(items.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))} />
              <button type="button" className="appearance-pick" onClick={() => setOpen(at === i ? null : i)} aria-expanded={at === i}>
                <span className="param-swatch" style={{ background: paintCss(it.paint, doc.mode) }} />
                <span>{itemLabel(it)}</span>
                {it.opacity < 1 && <span className="item-meta">{Math.round(it.opacity * 100)}%</span>}
              </button>
              <button type="button" className="icon-button" aria-label={`Move ${itemLabel(it)} up`} disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                <Icon name="ui.up" />
              </button>
              <button type="button" className="icon-button" aria-label={`Move ${itemLabel(it)} down`} disabled={i === 0} onClick={() => move(i, -1)}>
                <Icon name="ui.down" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${itemLabel(it)}`}
                onClick={() => {
                  commit(items.filter((_, j) => j !== i))
                  setOpen(null)
                }}
              >
                <Icon name="ui.close" />
              </button>
            </li>
          ))}
      </ul>
      {at !== null && (
        <ItemEditor
          key={`${node.id}:${at}`}
          doc={doc}
          item={items[at]}
          index={at}
          onChange={(next, key) =>
            commit(
              items.map((x, j) => (j === at ? next : x)),
              `${at}:${key}`,
            )
          }
        />
      )}
    </div>
  )

  function move(i: number, dir: 1 | -1) {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[i], next[j]] = [next[j], next[i]]
    commit(next)
    setOpen(j)
  }
}

const BLENDS = BLEND_DEFS.filter((b) => b.id !== 'pass-through')

function ItemEditor({ doc, item, index, onChange }: { doc: Doc; item: AppearanceItem; index: number; onChange(next: AppearanceItem, key: string): void }) {
  const id = `props-item-${index}`
  return (
    <div className="appearance-editor" data-appearance-editor={index}>
      <PaintEditor id={id} doc={doc} paint={item.paint} onChange={(paint, key) => onChange({ ...item, paint }, key)} />
      <NumberParam id={`${id}-opacity`} def={num('opacity', 'Opacity', 0, 100, 1, '%', undefined, 100)} value={Math.round(item.opacity * 100)} onChange={(v) => onChange({ ...item, opacity: v / 100 }, 'opacity')} />
      <div className="field">
        <label htmlFor={`${id}-blend`}>Blend mode</label>
        <select id={`${id}-blend`} value={item.blend} onChange={(e) => onChange({ ...item, blend: e.target.value as BlendModeId }, 'blend')}>
          {BLENDS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </div>
      {item.kind === 'stroke' && (
        <>
          <NumberParam id={`${id}-width`} def={num('width', 'Width', 0, 200, 0.5, 'px')} value={item.width} onChange={(v) => onChange({ ...item, width: v }, 'width')} />
          <BrushField id={`${id}-brush`} doc={doc} brush={item.brush} onChange={(brush) => onChange(withoutUndefined({ ...item, brush }), 'brush')} />
          {item.brush ? (
            <ProfileField id={`${id}-profile`} profile={item.profile} onChange={(profile) => onChange(withoutUndefined({ ...item, profile }), 'profile')} />
          ) : (
            <>
              <Choice id={`${id}-align`} label="Align" value={item.align} options={ALIGNS} onChange={(v) => onChange({ ...item, align: v }, 'align')} hint="Inside and outside apply to closed paths; open ones stroke on the centre" />
              <Choice id={`${id}-join`} label="Corners" value={item.join} options={JOINS} onChange={(v) => onChange({ ...item, join: v }, 'join')} />
              <Choice id={`${id}-cap`} label="Ends" value={item.cap} options={CAPS} onChange={(v) => onChange({ ...item, cap: v }, 'cap')} />
              {item.join === 'miter' && <NumberParam id={`${id}-miter`} def={num('miter', 'Miter limit', 1, 20, 0.5, '×', 'A corner sharper than this many widths is bevelled', 4)} value={item.miter} onChange={(v) => onChange({ ...item, miter: v }, 'miter')} />}
              <DashField id={`${id}-dash`} dash={item.dash} onChange={(dash) => onChange({ ...item, dash }, 'dash')} />
              {item.dash.length > 0 && (
                <label className="check">
                  <input
                    type="checkbox"
                    id={`${id}-dash-align`}
                    checked={!!item.dashAlign}
                    onChange={(e) =>
                      onChange(
                        withoutUndefined({
                          ...item,
                          dashAlign: e.target.checked || undefined,
                        }),
                        'dashAlign',
                      )
                    }
                  />
                  Align dashes to corners
                  <Hint text="Dashes stretched a little so every corner and end has one, half either side of the corner" />
                </label>
              )}
              {item.dash.length > 0 && !item.dashAlign && <NumberParam id={`${id}-dash-offset`} def={num('dashOffset', 'Dash offset', -100, 100, 0.5, 'px', undefined, 0)} value={item.dashOffset} onChange={(v) => onChange({ ...item, dashOffset: v }, 'dashOffset')} />}
              <ProfileField id={`${id}-profile`} profile={item.profile} onChange={(profile) => onChange(withoutUndefined({ ...item, profile }), 'profile')} />
              <ArrowField id={`${id}-start`} label="Start" head={item.start} onChange={(start) => onChange(withoutUndefined({ ...item, start }), 'start')} />
              <ArrowField id={`${id}-end`} label="End" head={item.end} onChange={(end) => onChange(withoutUndefined({ ...item, end }), 'end')} />
            </>
          )}
        </>
      )}
      <ItemEffects id={id} doc={doc} item={item} onChange={onChange} />
    </div>
  )
}

/**
 * A fill's or stroke's own effects, top first: path effects that change
 * the outline it's drawn from, and pixel effects (live filters, shadows,
 * glows) on what it paints. Each switched off and on, reordered, removed,
 * and set here.
 */
function ItemEffects({ id, doc, item, onChange }: { id: string; doc: Doc; item: AppearanceItem; onChange(next: AppearanceItem, key: string): void }) {
  const list = item.effects ?? []
  const [open, setOpen] = useState<number | null>(null)
  const set = (next: ItemEffect[], key: string) => onChange({ ...item, effects: next.length ? next : undefined }, key)
  const add = (kind: string) => {
    const defs = stageOf(kind) === 'path' ? PATH_EFFECTS.find((d) => d.id === kind)!.params : FILTER_BY_ID.get(kind)!.params
    set([...list, { kind, enabled: true, params: defaultParams(defs, doc.mode) }], 'effects')
    setOpen(list.length)
  }
  const move = (i: number, dir: 1 | -1) => {
    const j = i + dir
    if (j < 0 || j >= list.length) return
    const next = [...list]
    ;[next[i], next[j]] = [next[j], next[i]]
    set(next, 'effects')
    setOpen(j)
  }
  const at = open !== null && open < list.length ? open : null
  const e = at !== null ? list[at] : null
  const defs = e ? (stageOf(e.kind) === 'path' ? PATH_EFFECTS.find((d) => d.id === e.kind)!.params : (FILTER_BY_ID.get(e.kind)?.params ?? [])) : []
  return (
    <div className="field item-effects" data-item-effects>
      <div className="appearance-head">
        <span className="field-label">Effects</span>
        <select
          id={`${id}-fx-add`}
          aria-label="Add an effect to this fill or stroke"
          data-item-effect-add
          value=""
          onChange={(ev) => {
            if (ev.target.value) add(ev.target.value)
          }}
        >
          <option value="">Add…</option>
          <optgroup label="Path">
            {PATH_EFFECTS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Pixels">
            {pixelEffectIds().map((k) => (
              <option key={k} value={k}>
                {effectLabel(k)}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      {list.length > 0 && (
        <ul className="appearance-list">
          {list.map((x, i) => (
            <li key={i} className={`appearance-item${at === i ? ' open' : ''}${x.enabled ? '' : ' off'}`} data-item-effect={x.kind}>
              <input
                type="checkbox"
                aria-label={`Show ${effectLabel(x.kind)}`}
                checked={x.enabled}
                onChange={(ev) =>
                  set(
                    list.map((y, j) => (j === i ? { ...y, enabled: ev.target.checked } : y)),
                    'effects',
                  )
                }
              />
              <button type="button" className="appearance-pick" onClick={() => setOpen(at === i ? null : i)} aria-expanded={at === i}>
                <span>{effectLabel(x.kind)}</span>
                {!stageOf(x.kind) && <span className="item-meta">not known here</span>}
              </button>
              <button type="button" className="icon-button" aria-label={`Move ${effectLabel(x.kind)} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                <Icon name="ui.up" />
              </button>
              <button type="button" className="icon-button" aria-label={`Move ${effectLabel(x.kind)} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}>
                <Icon name="ui.down" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${effectLabel(x.kind)}`}
                onClick={() => {
                  set(
                    list.filter((_, j) => j !== i),
                    'effects',
                  )
                  setOpen(null)
                }}
              >
                <Icon name="ui.close" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {e && at !== null && defs.length > 0 && (
        <ParamControls
          defs={defs}
          values={effectValues(e, doc.mode)}
          doc={doc}
          docKey=""
          idPrefix={`${id}-fx-${at}`}
          onChange={(v, key) =>
            set(
              list.map((y, j) => (j === at ? { ...y, params: v } : y)),
              `fx:${at}:${key}`,
            )
          }
        />
      )}
    </div>
  )
}

/**
 * One paint: a colour (or a swatch at a tint), a gradient with its stops,
 * or a pattern, built in or made from pixels. Shapes' fills and strokes,
 * fill layers and the Gradient tool all edit their paints with this.
 */
export function PaintEditor({ id, doc, paint: p, onChange: setPaint, kinds = ['solid', 'gradient', 'pattern'], hint }: { id: string; doc: Doc; paint: Paint; onChange(next: Paint, key: string): void; kinds?: Paint['kind'][]; hint?: string }) {
  const white = doc.mode === 'cmyk' ? [0, 0, 0, 0] : doc.mode === 'gray' ? [1] : [1, 1, 1]
  const changeKind = (kind: Paint['kind']) => {
    const main = p.kind === 'solid' ? p.colour : p.kind === 'pattern' ? p.colour : p.stops[0].colour
    if (kind === 'solid') setPaint(solid(main), 'kind')
    else if (kind === 'gradient') setPaint(gradientPaint(main, white), 'kind')
    else
      setPaint(
        {
          kind: 'pattern',
          pattern: doc.patterns?.[0]?.id ?? 'checker',
          colour: main,
          background: white,
          backgroundAlpha: 1,
          size: doc.patterns?.[0]?.width ?? 16,
          angle: 0,
        },
        'kind',
      )
  }
  const image = p.kind === 'pattern' ? doc.patterns?.find((x) => x.id === p.pattern) : undefined
  return (
    <>
      <Segmented id={`${id}-paint`} label="Paint" hint={hint} value={p.kind} options={PAINT_KINDS.filter(([k]) => kinds.includes(k))} onChange={changeKind} />
      {p.kind === 'solid' && <SolidPaint id={id} doc={doc} paint={p} onChange={setPaint} />}
      {p.kind === 'gradient' && (
        <>
          <div className="field">
            <label htmlFor={`${id}-gtype`}>Style</label>
            <select id={`${id}-gtype`} value={p.type} onChange={(e) => setPaint({ ...p, type: e.target.value as typeof p.type }, 'gtype')}>
              {GRADIENT_TYPES.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <StopsEditor id={`${id}-stops`} doc={doc} stops={p.stops} onChange={(stops, key) => setPaint({ ...p, stops }, key)} />
          {p.line ? (
            <div className="field" data-gradient-line>
              <span className="field-meta">
                Along a drawn line <Hint text="The line the Gradient tool drew: drag with it (G) on the canvas to move its ends." />
              </span>
              <button
                type="button"
                className="button small"
                onClick={() => {
                  const { line: _l, ...rest } = p
                  setPaint(rest, 'line')
                }}
              >
                Fit to the Box
              </button>
            </div>
          ) : (
            <>
              <NumberParam id={`${id}-angle`} def={num('angle', 'Angle', -180, 180, 1, '°', undefined, 0)} value={p.angle} onChange={(v) => setPaint({ ...p, angle: v }, 'angle')} />
              <NumberParam id={`${id}-scale`} def={num('scale', 'Scale', 10, 400, 1, '%', undefined, 100)} value={p.scale} onChange={(v) => setPaint({ ...p, scale: v }, 'scale')} />
            </>
          )}
          <label className="check">
            <input type="checkbox" checked={p.reverse} onChange={(e) => setPaint({ ...p, reverse: e.target.checked }, 'reverse')} />
            Reverse
          </label>
        </>
      )}
      {p.kind === 'pattern' && (
        <>
          <div className="field">
            <label htmlFor={`${id}-pattern`}>Pattern</label>
            <select
              id={`${id}-pattern`}
              value={p.pattern}
              onChange={(e) => {
                const img = doc.patterns?.find((x) => x.id === e.target.value)
                // A pattern from pixels starts at its own size; a formula keeps the cell size it had.
                setPaint(
                  {
                    ...p,
                    pattern: e.target.value,
                    size: img ? img.width : image ? 16 : p.size,
                  },
                  'pattern',
                )
              }}
            >
              {PATTERNS.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
              {(doc.patterns ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} ({x.width} × {x.height})
                </option>
              ))}
              {!PATTERN_BY_ID.has(p.pattern) && !image && <option value={p.pattern}>Missing pattern</option>}
            </select>
          </div>
          {image ? (
            <NumberParam id={`${id}-pscale`} def={num('pscale', 'Scale', 1, 1000, 1, '%', 'The pattern’s size: 100% is one of its pixels to one of the document’s', 100)} value={Math.round((p.size / image.width) * 1000) / 10} onChange={(v) => setPaint({ ...p, size: (image.width * v) / 100 }, 'psize')} />
          ) : (
            <>
              <ColourParam id={`${id}-pcolour`} label="Colour" value={p.colour} doc={doc} onChange={(c) => setPaint({ ...p, colour: c }, 'pcolour')} />
              <ColourParam id={`${id}-pback`} label="Background" value={p.background} doc={doc} onChange={(c) => setPaint({ ...p, background: c }, 'pback')} />
              <NumberParam id={`${id}-palpha`} def={num('balpha', 'Background opacity', 0, 100, 1, '%', undefined, 100)} value={Math.round(p.backgroundAlpha * 100)} onChange={(v) => setPaint({ ...p, backgroundAlpha: v / 100 }, 'palpha')} />
              <NumberParam id={`${id}-psize`} def={num('size', 'Size', 1, 500, 0.5, 'px', 'One cell of the pattern')} value={p.size} onChange={(v) => setPaint({ ...p, size: v }, 'psize')} />
            </>
          )}
          <NumberParam id={`${id}-pangle`} def={num('pangle', 'Angle', -180, 180, 1, '°', undefined, 0)} value={p.angle} onChange={(v) => setPaint({ ...p, angle: v }, 'pangle')} />
        </>
      )}
    </>
  )
}

function Choice<T extends string>({ id, label, value, options, onChange, hint }: { id: string; label: string; value: T; options: [T, string][]; onChange(v: T): void; hint?: string }) {
  if (options.length <= 3) return <Segmented id={id} label={label} hint={hint} value={value} options={options} onChange={onChange} defaultValue={options[0][0]} />
  return (
    <div className="field">
      <Label htmlFor={id} hint={hint}>
        {label}
      </Label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  )
}

/** An item with its absent settings left out rather than undefined, as files keep them. */
function withoutUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/**
 * A stroke's width profile: one of the presets, one saved under a name of
 * your own, or the points as they are (the Width tool's) shown as Custom.
 * Flip Along and Flip Across turn it end to end and side to side; Save
 * keeps it by a name; a saved one chosen can be forgotten.
 */
function ProfileField({ id, profile, onChange }: { id: string; profile: WidthPoint[] | undefined; onChange(p: WidthPoint[] | undefined): void }) {
  const saved = useSyncExternalStore(widthProfiles().subscribe, widthProfiles().get)
  const [naming, setNaming] = useState<string | null>(null)
  // Esc lets the name go; the blur that follows mustn't save it.
  const dropped = useRef(false)
  const preset = presetOf(profile)
  const mine = preset ? -1 : saved.findIndex((s) => sameProfile(s.points, profile))
  const value = preset ?? (mine >= 0 ? `saved:${mine}` : 'custom')
  const shaped = !!profile?.length
  const save = () => {
    if (dropped.current) {
      dropped.current = false
      return
    }
    if (naming?.trim() && profile?.length) widthProfiles().add(naming, profile)
    setNaming(null)
  }
  return (
    <>
      <div className="field">
        <Label htmlFor={id} hint="How wide the stroke is along the path: tapered, bulging, pinched, or the same all the way. The Width tool, in the Pen's group, edits it on the canvas.">
          Profile
        </Label>
        <select
          id={id}
          value={value}
          onChange={(e) => {
            const v = e.target.value
            if (v.startsWith('saved:')) {
              const s = saved[Number(v.slice(6))]
              if (s) onChange(s.points.map((x) => ({ ...x })))
              return
            }
            const p = WIDTH_PRESETS.find((x) => x.id === v)
            if (p) onChange(p.points.length ? p.points.map((x) => ({ ...x })) : undefined)
          }}
        >
          {WIDTH_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          {saved.map((s, i) => (
            <option key={`saved:${s.name}`} value={`saved:${i}`}>
              {s.name}
            </option>
          ))}
          {value === 'custom' && <option value="custom">Custom</option>}
        </select>
      </div>
      {shaped && (
        <div className="field-row profile-actions">
          <button type="button" className="button small" id={`${id}-flip-along`} data-tip="End to end: what was at the start is at the end" onClick={() => onChange(flipAlong(profile))}>
            Flip Along
          </button>
          <button type="button" className="button small" id={`${id}-flip-across`} data-tip="Side to side: each side's width on the other" onClick={() => onChange(flipAcross(profile))}>
            Flip Across
          </button>
          {mine >= 0 ? (
            <button type="button" className="button small" id={`${id}-forget`} data-tip="Takes this profile out of the list; strokes keep it" onClick={() => widthProfiles().remove(saved[mine].name)}>
              Forget
            </button>
          ) : (
            !preset &&
            naming === null && (
              <button type="button" className="button small" id={`${id}-save`} data-tip="Keeps this profile in the list by a name, for other strokes" onClick={() => setNaming(`Profile ${saved.length + 1}`)}>
                Save…
              </button>
            )
          )}
        </div>
      )}
      {naming !== null && (
        <div className="field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input
            id={`${id}-name`}
            value={naming}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') {
                dropped.current = true
                setNaming(null)
              }
            }}
            onBlur={save}
          />
        </div>
      )}
    </>
  )
}

/**
 * The vector brush a stroke draws with (Window → Vector Brushes has them
 * all): none for a plain stroke, the document's brushes, then the built-in
 * ones. With one chosen, Options opens Brush Options for it.
 */
function BrushField({ id, doc, brush, onChange }: { id: string; doc: Doc; brush: VectorBrush | undefined; onChange(b: VectorBrush | undefined): void }) {
  const choices = brushChoices(doc)
  // A stroke's copy of a brush no longer in the list is still its own.
  const listed = !brush || choices.some((c) => c.brush.id === brush.id)
  return (
    <div className="field">
      <Label htmlFor={id} hint="Artwork drawn along the path instead of a plain stroke: bent along it, scattered, or repeated as tiles. Its width is the stroke's.">
        Brush
      </Label>
      <div className="field-row">
        <select
          id={id}
          value={brush?.id ?? 'none'}
          onChange={(e) => {
            if (e.target.value === 'none') return onChange(undefined)
            const b = brushById(doc, e.target.value)
            if (b) onChange(b)
          }}
        >
          <option value="none">None</option>
          {!listed && brush && <option value={brush.id}>{brush.name}</option>}
          {choices.map((c) => (
            <option key={c.brush.id} value={c.brush.id}>
              {c.brush.name}
            </option>
          ))}
        </select>
        {brush && listed && (
          <button
            type="button"
            className="button small"
            id={`${id}-options`}
            onClick={() => {
              const d = documents().active()
              if (d) brushOptions.set({ key: d.key, id: brush.id })
            }}
          >
            Options…
          </button>
        )}
      </div>
    </div>
  )
}

/** An arrowhead at one end of an open path: its shape (or none) and its size. */
function ArrowField({ id, label, head, onChange }: { id: string; label: string; head: Arrowhead | undefined; onChange(h: Arrowhead | undefined): void }) {
  return (
    <>
      <div className="field">
        <Label htmlFor={id} hint="An arrowhead at this end of an open path, filled with the stroke’s paint">
          {label}
        </Label>
        <select
          id={id}
          value={head?.shape ?? 'none'}
          onChange={(e) =>
            onChange(
              e.target.value === 'none'
                ? undefined
                : {
                    shape: e.target.value as ArrowShape,
                    scale: head?.scale ?? 1,
                  },
            )
          }
        >
          <option value="none">None</option>
          {ARROW_SHAPES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      {head && <NumberParam id={`${id}-scale`} def={num('scale', `${label} size`, 10, 1000, 5, '%', undefined, 100)} value={Math.round(head.scale * 100)} onChange={(v) => onChange({ ...head, scale: v / 100 })} />}
    </>
  )
}

/** Dashes typed as lengths: "8 4" is dashes of 8 with gaps of 4; empty is a solid line. */
function DashField({ id, dash, onChange }: { id: string; dash: number[]; onChange(d: number[]): void }) {
  const [typed, setTyped] = useState<string | null>(null)
  return (
    <div className="field">
      <Label htmlFor={id} hint="Dash and gap lengths in pixels, alternating: 8 4 is dashes of 8 with gaps of 4. Empty for a solid line; 0 4 with round ends makes dots.">
        Dashes
      </Label>
      <input
        id={id}
        placeholder="Solid"
        value={typed ?? dash.join(' ')}
        onChange={(e) => setTyped(e.target.value)}
        onBlur={() => {
          if (typed !== null) {
            const v = typed
              .split(/[\s,]+/)
              .filter(Boolean)
              .map(Number)
              .filter((n) => Number.isFinite(n) && n >= 0)
              .slice(0, 16)
            onChange(v.some((n) => n > 0) ? v : [])
          }
          setTyped(null)
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </div>
  )
}

/** A gradient's stops: where each is, its colour (its chip) and how opaque. */
function StopsEditor({ id, doc, stops, onChange }: { id: string; doc: Doc; stops: PaintStop[]; onChange(s: PaintStop[], key: string): void }) {
  const css = `linear-gradient(to right, ${stops.map((s) => `${swatchCss(s.colour, doc.mode)} ${Math.round(s.at * 100)}%`).join(', ')})`
  const sorted = (s: PaintStop[]) => [...s].sort((a, b) => a.at - b.at)
  return (
    <div className="field gradient" data-editor="gradient">
      <span className="field-label">Stops</span>
      <div className="gradient-bar" style={{ background: css }} />
      {stops.map((s, i) => (
        <div className="gradient-stop" key={i}>
          <DocColourChip value={s.colour} doc={doc} label={`Stop ${i + 1} colour`} onChange={(c) => onChange(stops.map((x, j) => (j === i ? { ...x, colour: c } : x)), `colour${i}`)} data={{ 'stop-colour': String(i) }} />
          <input
            id={`${id}-${i}`}
            type="number"
            aria-label={`Stop ${i + 1} position, percent`}
            min={0}
            max={100}
            value={Math.round(s.at * 100)}
            onChange={(e) =>
              Number.isFinite(Number(e.target.value)) &&
              onChange(
                sorted(
                  stops.map((x, j) =>
                    j === i
                      ? {
                          ...x,
                          at: Math.min(100, Math.max(0, Number(e.target.value))) / 100,
                        }
                      : x,
                  ),
                ),
                `at${i}`,
              )
            }
          />
          <input
            type="number"
            aria-label={`Stop ${i + 1} opacity, percent`}
            data-tip="Opacity"
            min={0}
            max={100}
            value={Math.round(s.alpha * 100)}
            onChange={(e) =>
              Number.isFinite(Number(e.target.value)) &&
              onChange(
                stops.map((x, j) =>
                  j === i
                    ? {
                        ...x,
                        alpha: Math.min(100, Math.max(0, Number(e.target.value))) / 100,
                      }
                    : x,
                ),
                `alpha${i}`,
              )
            }
          />
          <button
            type="button"
            className="button small"
            disabled={stops.length <= 2}
            aria-label={`Remove stop ${i + 1}`}
            onClick={() =>
              onChange(
                stops.filter((_, j) => j !== i),
                'remove',
              )
            }
          >
            <Icon name="ui.close" />
          </button>
        </div>
      ))}
      <button type="button" className="button small" onClick={() => onChange(sorted([...stops, { at: 0.5, colour: stops[0].colour, alpha: 1 }]), 'add')}>
        Add Stop
      </button>
    </div>
  )
}

/**
 * A colour paint: its colour, or linked to one of the document's global or
 * spot swatches at a tint (doc/swatches.ts), as Illustrator links them.
 */
function SolidPaint({ id, doc, paint, onChange }: { id: string; doc: Doc; paint: Extract<Paint, { kind: 'solid' }>; onChange(p: Paint, key: string): void }) {
  const linkables = (doc.swatches ?? []).filter(linkable)
  const linked = paint.swatch ? linkables.find((s) => s.id === paint.swatch) : undefined
  const colourOf = swatchColourIn(doc)
  return (
    <>
      {linkables.length > 0 && (
        <div className="field">
          <label htmlFor={`${id}-swatch`}>Swatch</label>
          <select
            id={`${id}-swatch`}
            value={linked?.id ?? ''}
            onChange={(e) => {
              const s = linkables.find((x) => x.id === e.target.value)
              if (!s) {
                const { swatch: _s, tint: _t, ...rest } = paint
                return onChange(rest, 'swatch')
              }
              if (colourOf) onChange(swatchPaint(s, paint.tint ?? 1, colourOf), 'swatch')
            }}
          >
            <option value="">None</option>
            {linkables.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.kind === 'spot' ? ' (spot)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      {linked && colourOf ? (
        <NumberParam
          id={`${id}-tint`}
          def={num('tint', 'Tint', 0, 100, 1, '%', linked.kind === 'spot' ? 'How much of the ink: 100% is solid.' : 'How much of the colour: 100% is all of it.', 100)}
          value={Math.round((paint.tint ?? 1) * 100)}
          onChange={(v) => onChange(swatchPaint(linked, v / 100, colourOf), 'tint')}
        />
      ) : (
        <ColourParam id={`${id}-colour`} label="Colour" value={paint.colour} doc={doc} onChange={(c) => onChange({ kind: 'solid', colour: c }, 'colour')} />
      )}
    </>
  )
}
