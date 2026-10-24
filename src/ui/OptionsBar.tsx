/**
 * The options bar above the canvas: the chosen tool's settings, generated
 * from its `options` schema in TOOL_DEFS. A tool with none shows its name
 * and what it does.
 *
 * Number fields take typing, and their labels scrub: drag a label left or
 * right to change the value, as in Photoshop.
 */
import { FontPicker } from './FontPicker'
import { freehand } from '../app/freehand'
import { brushChoices } from '../app/vectorBrushes'
import { useSyncExternalStore } from 'react'
import { brushes, type PaintTool } from '../app/brushes'
import { sessions } from '../app/canvasTools'
import { selectTools } from '../app/selectTools'
import { GRADIENT_PRESETS, fillTools, type GradientPreset } from '../app/fillTools'
import { documents } from '../app/documents'
import { GRADIENT_TYPES } from '../doc/vector'
import type { CombineOp } from '../tiles/coverage'
import { BRUSH_PRESETS, MIXER_PRESETS, hasDynamic, withPressure } from '../brush/defs'
import type { BlendModeId } from '../doc/types'
import { BLEND_DEFS } from '../render/blendModes'
import { TOOL_BY_ID, tools, type ToolOption } from '../tools'
import { anchorSelection, selectedAnchorCount, shapeTools } from '../app/vectors'
import { SHAPE_TYPES } from '../geom/shapes'
import { applyChar, shownChar, subscribeTyping } from '../app/typing'
import { fontLibraryNow } from '../app/fonts'
import { typeSettings } from '../app/typeSettings'
import { alignLayers, alignWhy, distributeLayers, distributeWhy } from '../app/align'
import { ALIGN_TO, guidePrefs, type AlignTo } from '../app/guidePrefs'
import { ALIGN_OPS, type DistributeOp } from '../geom/align'
import { Icon } from './Icon'
import { moveTool } from '../app/moveTool'
import { retouch } from '../app/retouch'
import { NO_WARP, transformUi, type TransformMode } from '../app/freeTransform'
import { LIQUIFY_TOOLS, liquifySettings } from '../app/liquify'
import { subscribeToolOverlay, toolOverlayVersion } from '../app/overlay'
import { WARP_STYLES } from '../geom/warp'
import { NumberInput, ScrubLabel } from './controls'
import { ARTBOARD_PRESETS, artboardRect, isArtboard, setArtboardRect, type ArtboardNode } from '../doc/artboards'
import { commitArtboards, newArtboard } from '../app/artboards'

/** A blend mode, as the Gradient tool and the Paint Bucket take one. */
function BlendOption({ id, value, onChange }: { id: string; value: BlendModeId; onChange(v: BlendModeId): void }) {
  return (
    <label className="options-field">
      <span>Mode</span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as BlendModeId)}>
        {BLEND_DEFS.filter((b) => b.id !== 'pass-through').map((b) => (
          <option key={b.id} value={b.id}>
            {b.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** The Paint Bucket's pattern: one of the front document's. */
function BucketPattern({ value }: { value: string | null }) {
  const doc = useSyncExternalStore(documents().subscribe, () => documents().active()?.history.present ?? null)
  const list = doc?.patterns ?? []
  if (!list.length) return <span className="options-hint">No patterns yet: Edit → Define Pattern.</span>
  return (
    <label className="options-field">
      <span>Pattern</span>
      <select id="opt-bucket-pattern" value={list.some((p) => p.id === value) ? (value as string) : list[0].id} onChange={(e) => fillTools().update('bucket', { pattern: e.target.value })}>
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  )
}

export function OptionsBar() {
  const toolId = useSyncExternalStore(tools().subscribe, tools().get)
  useSyncExternalStore(fillTools().subscribe, fillTools().get)
  const state = useSyncExternalStore(brushes().subscribe, brushes().get)
  const session = useSyncExternalStore(sessions().subscribe, sessions().get)
  // Re-read while a session runs: its readout changes with every drag.
  useSyncExternalStore(selectTools().subscribe, selectTools().get)
  useSyncExternalStore(shapeTools().subscribe, shapeTools().get)
  useSyncExternalStore(freehand().subscribe, freehand().get)
  useSyncExternalStore(anchorSelection.subscribe, () => anchorSelection.version)
  useSyncExternalStore(typeSettings().subscribe, typeSettings().get)
  useSyncExternalStore(subscribeTyping, () => shownChar().font + shownChar().style + shownChar().size)
  const tool = TOOL_BY_ID.get(toolId)!
  const paints = tool.paints
  // A Free Transform in progress has the bar, whatever the tool.
  if (session?.kind === 'transform') {
    return (
      <div className="options-bar" data-options="transform" role="toolbar" aria-label="Free Transform">
        <strong className="options-tool">Free Transform</strong>
        <TransformOptions />
        <SessionReadout />
      </div>
    )
  }
  // So does Liquify.
  if (session?.kind === 'liquify') {
    return (
      <div className="options-bar" data-options="liquify" role="toolbar" aria-label="Liquify">
        <strong className="options-tool">Liquify</strong>
        <LiquifyOptions />
        <SessionReadout />
      </div>
    )
  }
  const onlySession = tool.options?.length === 1 && tool.options[0].kind === 'session'
  if (!tool.options?.length || (onlySession && !session)) {
    return (
      <div className="options-bar" data-options={tool.id}>
        <strong className="options-tool">{tool.name}</strong>
        <span className="options-hint">{tool.hint}</span>
      </div>
    )
  }
  return (
    <div className="options-bar" data-options={tool.id} role="toolbar" aria-label={`${tool.name} options`}>
      <strong className="options-tool">{tool.name}</strong>
      {tool.options.map((o, i) => (
        <Option key={i} o={o} paints={paints} state={state} />
      ))}
    </div>
  )
}

function Option({ o, paints, state }: { o: ToolOption; paints?: PaintTool; state: ReturnType<ReturnType<typeof brushes>['get']> }) {
  const b = paints ? state[paints] : null
  switch (o.kind) {
    case 'preset': {
      const current = paints ? state.preset[paints] : null
      return (
        <label className="options-field">
          <span>Brush</span>
          <select id={`opt-${paints}-preset`} value={current ?? ''} onChange={(e) => paints && e.target.value && brushes().choose(paints, e.target.value)}>
            {!current && <option value="">Custom</option>}
            {BRUSH_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {state.user.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )
    }
    case 'number':
      return b && paints ? <NumberOption o={o} value={b[o.key] * o.scale} onChange={(v) => brushes().update(paints, { [o.key]: v / o.scale })} id={`opt-${paints}-${o.key}`} /> : null
    case 'mode':
      return b && paints ? (
        <label className="options-field">
          <span>Mode</span>
          <select id={`opt-${paints}-mode`} value={b.mode} onChange={(e) => brushes().update(paints, { mode: e.target.value as BlendModeId })}>
            {BLEND_DEFS.filter((d) => d.id !== 'pass-through').map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      ) : null
    case 'pressure': {
      if (!b || !paints) return null
      const on = hasDynamic(b, 'pressure', o.target)
      return (
        <button
          type="button"
          className="options-toggle"
          aria-pressed={on}
          data-pressure={o.target}
          data-tip={`Let pen pressure set the ${o.target}`}
          onClick={() => brushes().update(paints, { dynamics: withPressure(b, o.target, !on).dynamics })}
        >
          {o.label}
        </button>
      )
    }
    case 'select-op':
      return <SelectOp />
    case 'feather':
      return <FeatherOption tool={o.tool} />
    case 'antialias':
      return <AntialiasOption tool={o.tool} />
    case 'marquee-shape': {
      const shape = selectTools().get().marquee.shape
      return (
        <span className="options-field" role="group" aria-label="Shape">
          {(['rect', 'ellipse'] as const).map((v) => (
            <button key={v} type="button" className="options-toggle" aria-pressed={shape === v} data-shape={v} onClick={() => selectTools().update('marquee', { shape: v })}>
              {v === 'rect' ? 'Rectangle' : 'Ellipse'}
            </button>
          ))}
        </span>
      )
    }
    case 'lasso-mode': {
      const mode = selectTools().get().lasso.mode
      return (
        <span className="options-field" role="group" aria-label="Lasso">
          {(['freehand', 'polygonal', 'magnetic'] as const).map((v) => (
            <button key={v} type="button" className="options-toggle" aria-pressed={mode === v} data-lasso={v} onClick={() => selectTools().update('lasso', { mode: v })}>
              {v === 'freehand' ? 'Freehand' : v === 'polygonal' ? 'Polygonal' : 'Magnetic'}
            </button>
          ))}
        </span>
      )
    }
    case 'magnetic': {
      const l = selectTools().get().lasso
      if (l.mode !== 'magnetic') return null
      return (
        <>
          <NumberOption o={{ label: 'Width', min: 1, max: 256, unit: 'px', hint: 'How far from the pointer an edge is looked for.' }} value={l.width} onChange={(v) => selectTools().update('lasso', { width: v })} id="opt-lasso-width" />
          <NumberOption o={{ label: 'Contrast', min: 1, max: 100, unit: '%', hint: 'How strong an edge must be to be followed: higher ignores faint ones.' }} value={Math.round(l.contrast * 100)} onChange={(v) => selectTools().update('lasso', { contrast: v / 100 })} id="opt-lasso-contrast" />
          <NumberOption o={{ label: 'Frequency', min: 0, max: 100, unit: '', hint: 'How often points drop by themselves along the edge.' }} value={l.frequency} onChange={(v) => selectTools().update('lasso', { frequency: v })} id="opt-lasso-frequency" />
        </>
      )
    }
    case 'quick': {
      const q = selectTools().get().quick
      return (
        <>
          <NumberOption o={{ label: 'Size', min: 1, max: 2000, unit: 'px', hint: 'The brush’s diameter in document pixels. [ and ] make it smaller and larger.' }} value={q.size} onChange={(v) => selectTools().update('quick', { size: v })} id="opt-quick-size" />
          <button type="button" className="options-toggle" aria-pressed={q.sampleAll} data-quick="sample-all" data-tip="Look at the whole image, not just the selected layer" onClick={() => selectTools().update('quick', { sampleAll: !q.sampleAll })}>
            Sample all layers
          </button>
          <button type="button" className="options-toggle" aria-pressed={q.autoEnhance} data-quick="auto-enhance" data-tip="A smoother, softer edge" onClick={() => selectTools().update('quick', { autoEnhance: !q.autoEnhance })}>
            Auto-Enhance
          </button>
        </>
      )
    }
    case 'gradient': {
      const g = fillTools().get().gradient
      return (
        <>
          <label className="options-field">
            <span>Gradient</span>
            <select id="opt-gradient-preset" value={g.preset} onChange={(e) => fillTools().update('gradient', { preset: e.target.value as GradientPreset })}>
              {GRADIENT_PRESETS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <span className="options-field" role="group" aria-label="Style">
            {GRADIENT_TYPES.map(([v, label]) => (
              <button key={v} type="button" className="options-toggle" aria-pressed={g.type === v} data-gradient-type={v} onClick={() => fillTools().update('gradient', { type: v })}>
                {label}
              </button>
            ))}
          </span>
          <button type="button" className="options-toggle" aria-pressed={g.reverse} data-gradient="reverse" onClick={() => fillTools().update('gradient', { reverse: !g.reverse })}>
            Reverse
          </button>
          <span className="options-field" role="group" aria-label="Makes">
            <button type="button" className="options-toggle" aria-pressed={g.makes === 'layer'} data-gradient-makes="layer" data-tip="A gradient fill layer, which stays editable" onClick={() => fillTools().update('gradient', { makes: 'layer' })}>
              Fill layer
            </button>
            <button type="button" className="options-toggle" aria-pressed={g.makes === 'pixels'} data-gradient-makes="pixels" data-tip="Laid into the selected layer’s pixels (or its mask)" onClick={() => fillTools().update('gradient', { makes: 'pixels' })}>
              Pixels
            </button>
          </span>
          <BlendOption id="opt-gradient-blend" value={g.blend} onChange={(v) => fillTools().update('gradient', { blend: v })} />
          <NumberOption o={{ label: 'Opacity', min: 0, max: 100, unit: '%', hint: 'How much of the gradient is laid on.' }} value={Math.round(g.opacity * 100)} onChange={(v) => fillTools().update('gradient', { opacity: v / 100 })} id="opt-gradient-opacity" />
        </>
      )
    }
    case 'bucket': {
      const b = fillTools().get().bucket
      return (
        <>
          <label className="options-field">
            <span>Fill</span>
            <select id="opt-bucket-source" value={b.source} onChange={(e) => fillTools().update('bucket', { source: e.target.value as 'fg' | 'pattern' })}>
              <option value="fg">Foreground</option>
              <option value="pattern">Pattern</option>
            </select>
          </label>
          {b.source === 'pattern' && <BucketPattern value={b.pattern} />}
          <BlendOption id="opt-bucket-blend" value={b.blend} onChange={(v) => fillTools().update('bucket', { blend: v })} />
          <NumberOption o={{ label: 'Opacity', min: 0, max: 100, unit: '%', hint: 'How much of the fill is laid on.' }} value={Math.round(b.opacity * 100)} onChange={(v) => fillTools().update('bucket', { opacity: v / 100 })} id="opt-bucket-opacity" />
          <NumberOption o={{ label: 'Tolerance', min: 0, max: 255, unit: '', hint: 'How far a colour may be from the one clicked and still be filled.' }} value={b.tolerance} onChange={(v) => fillTools().update('bucket', { tolerance: v })} id="opt-bucket-tolerance" />
          <button type="button" className="options-toggle" aria-pressed={b.antialias} onClick={() => fillTools().update('bucket', { antialias: !b.antialias })}>
            Anti-alias
          </button>
          <button type="button" className="options-toggle" aria-pressed={b.contiguous} data-bucket="contiguous" onClick={() => fillTools().update('bucket', { contiguous: !b.contiguous })}>
            Contiguous
          </button>
          <button type="button" className="options-toggle" aria-pressed={b.sampleAll} onClick={() => fillTools().update('bucket', { sampleAll: !b.sampleAll })}>
            All layers
          </button>
        </>
      )
    }
    case 'wand': {
      const w = selectTools().get().wand
      return (
        <>
          <NumberOption
            o={{ label: 'Tolerance', min: 0, max: 255, unit: '', hint: 'How far a colour may be from the one clicked, in levels of 0 to 255 on any channel, and still be selected.' }}
            value={w.tolerance}
            onChange={(v) => selectTools().update('wand', { tolerance: v })}
            id="opt-wand-tolerance"
          />
          <button type="button" className="options-toggle" aria-pressed={w.contiguous} data-wand="contiguous" data-tip="Only pixels joined to the one clicked" onClick={() => selectTools().update('wand', { contiguous: !w.contiguous })}>
            Contiguous
          </button>
          <button type="button" className="options-toggle" aria-pressed={w.sampleAll} data-wand="sample-all" data-tip="Compare the whole image, not just the selected layer" onClick={() => selectTools().update('wand', { sampleAll: !w.sampleAll })}>
            Sample all layers
          </button>
        </>
      )
    }
    case 'session':
      return <SessionReadout />
    case 'shape-type': {
      const t = shapeTools().get().type
      return (
        <span className="options-field" role="group" aria-label="Shape">
          {SHAPE_TYPES.map(([id, label]) => (
            <button key={id} type="button" className="options-toggle" aria-pressed={t === id} data-shape-type={id} onClick={() => shapeTools().update({ type: id })}>
              {label}
            </button>
          ))}
        </span>
      )
    }
    case 'shape-settings': {
      const s = shapeTools().get()
      if (s.type === 'rect')
        return (
          <>
            <NumberOption o={{ label: 'Radius', min: 0, max: 10000, unit: 'px', hint: 'How far round the corners are.' }} value={s.radius} onChange={(v) => shapeTools().update({ radius: v })} id="opt-shape-radius" />
            <label className="options-field">
              <span>Corners</span>
              <select id="opt-shape-corner" value={s.corner} onChange={(e) => shapeTools().update({ corner: e.target.value as typeof s.corner })}>
                <option value="round">Round</option>
                <option value="chamfer">Chamfer</option>
                <option value="inset">Set in</option>
              </select>
            </label>
          </>
        )
      if (s.type === 'polygon') return <NumberOption o={{ label: 'Sides', min: 3, max: 100, unit: '', hint: 'How many sides the polygon has.' }} value={s.sides} onChange={(v) => shapeTools().update({ sides: Math.round(v) })} id="opt-shape-sides" />
      if (s.type === 'star')
        return (
          <>
            <NumberOption o={{ label: 'Points', min: 3, max: 100, unit: '', hint: 'How many points the star has.' }} value={s.points} onChange={(v) => shapeTools().update({ points: Math.round(v) })} id="opt-shape-points" />
            <NumberOption o={{ label: 'Inner', min: 1, max: 100, unit: '%', hint: 'How far in its inner corners are, as a share of its outer ones.' }} value={Math.round(s.inner * 100)} onChange={(v) => shapeTools().update({ inner: v / 100 })} id="opt-shape-inner" />
          </>
        )
      return null
    }
    case 'pen-smart': {
      const s = shapeTools().get()
      return (
        <button type="button" className="options-toggle" aria-pressed={s.smart} data-pen-smart data-tip="Smart, as Affinity's Pen has it: a click places a smooth point, the curve through it worked out from its neighbours (Alt-click for a corner; a drag still pulls the handles out)" onClick={() => shapeTools().update({ smart: !s.smart })}>
          Smart
        </button>
      )
    }
    case 'shape-paint': {
      const s = shapeTools().get()
      return (
        <>
          <button type="button" className="options-toggle" aria-pressed={s.fill} data-shape-paint="fill" data-tip="Fill new shapes with the foreground colour" onClick={() => shapeTools().update({ fill: !s.fill })}>
            Fill
          </button>
          <button type="button" className="options-toggle" aria-pressed={s.stroke} data-shape-paint="stroke" data-tip="Stroke new shapes: with the background colour when they’re filled too, otherwise the foreground. Lines are always stroked." onClick={() => shapeTools().update({ stroke: !s.stroke })}>
            Stroke
          </button>
          <NumberOption o={{ label: 'Width', min: 0.1, max: 1000, unit: 'px', hint: 'How wide new shapes’ strokes (and lines) are.' }} value={s.strokeWidth} onChange={(v) => shapeTools().update({ strokeWidth: v })} id="opt-shape-width" />
        </>
      )
    }
    case 'mixer':
      return <MixerOptions />
    case 'align':
      return <AlignOptions />
    case 'auto-select':
      return <AutoSelectOption />
    case 'artboard':
      return <ArtboardOptions />
    case 'smudge':
      return <SmudgeOptions />
    case 'source':
      return <SourceOptions tool={o.tool} />
    case 'type-font': {
      const c = shownChar()
      const lib = fontLibraryNow()
      const fams = lib?.families() ?? []
      const found = lib?.resolve(c.font, c.style)
      const fam = fams.find((f) => f.family === (found?.family ?? c.font))
      const style = found && fam ? found.style : c.style
      return (
        <>
          <span className="options-field">
            <span>Font</span>
            <FontPicker
              id="opt-type-font"
              label="Font"
              className="compact"
              value={fam?.family ?? c.font}
              onPick={(name) => {
                const f = fams.find((x) => x.family === name)
                if (f) applyChar({ font: f.family, style: f.styles.find((s) => s.style === style)?.style ?? f.styles.find((s) => /^(regular|book|roman|normal)$/i.test(s.style))?.style ?? f.styles[0].style })
              }}
            />
          </span>
          <label className="options-field">
            <span>Style</span>
            <select id="opt-type-style" value={style} onChange={(e) => applyChar({ font: fam?.family ?? c.font, style: e.target.value })}>
              {!fam?.styles.some((s) => s.style === style) && <option value={style}>{style || '—'}</option>}
              {fam?.styles.map((s) => (
                <option key={s.style} value={s.style}>
                  {s.style}
                </option>
              ))}
            </select>
          </label>
          <NumberOption o={{ label: 'Size', min: 0.1, max: 10000, unit: 'px', hint: 'The type’s size in document pixels.' }} value={c.size} onChange={(v) => applyChar({ size: v }, 'char:size')} id="opt-type-size" />
        </>
      )
    }
    case 'freehand':
      return <FreehandOptions tool={o.tool} />
    case 'anchors': {
      const n = selectedAnchorCount()
      return (
        <span className="options-hint" data-anchors={n}>
          {n ? `${n} point${n === 1 ? '' : 's'} selected: drag to move, Delete to remove, Alt-click to convert.` : TOOL_BY_ID.get('direct')!.hint}
        </span>
      )
    }
    case 'sample':
      return (
        <label className="options-field">
          <span>Sample</span>
          <select id="opt-picker-sample" value={state.sample} onChange={(e) => brushes().setSample(Number(e.target.value) as 1 | 3 | 5)}>
            <option value={1}>Point</option>
            <option value={3}>3 × 3 average</option>
            <option value={5}>5 × 5 average</option>
          </select>
        </label>
      )
  }
}

const OPS: { op: CombineOp; label: string; key: string }[] = [
  { op: 'replace', label: 'New', key: '' },
  { op: 'add', label: 'Add', key: 'Shift' },
  { op: 'subtract', label: 'Subtract', key: 'Alt' },
  { op: 'intersect', label: 'Intersect', key: 'Shift+Alt' },
]

/** New, Add, Subtract, Intersect: what a selection tool does when no key is held. */
function SelectOp() {
  const op = selectTools().get().op
  return (
    <span className="options-field" role="group" aria-label="Selection">
      {OPS.map((o) => (
        <button key={o.op} type="button" className="options-toggle" aria-pressed={op === o.op} data-op={o.op} data-tip={o.key ? `${o.label} (hold ${o.key} for one drag)` : 'A new selection'} onClick={() => selectTools().update('op', o.op)}>
          {o.label}
        </button>
      ))}
    </span>
  )
}

function FeatherOption({ tool }: { tool: 'marquee' | 'lasso' }) {
  const v = selectTools().get()[tool].feather
  return (
    <NumberOption
      o={{ label: 'Feather', min: 0, max: 1000, unit: 'px', hint: 'Softens the new selection’s edge over this many pixels.' }}
      value={v}
      onChange={(x) => selectTools().update(tool, { feather: x })}
      id={`opt-${tool}-feather`}
    />
  )
}

function AntialiasOption({ tool }: { tool: 'marquee' | 'lasso' | 'wand' }) {
  const on = selectTools().get()[tool].antialias
  return (
    <button type="button" className="options-toggle" aria-pressed={on} data-antialias={tool} data-tip="Smooth the selection’s edge rather than leave it stepped" onClick={() => selectTools().update(tool, { antialias: !on })}>
      Anti-alias
    </button>
  )
}

const TRANSFORM_MODES: [TransformMode, string, string][] = [
  ['free', 'Free', 'Scale, skew, move and turn (Ctrl on a corner distorts it).'],
  ['distort', 'Distort', 'Drag a corner anywhere, or an edge to move both its corners.'],
  ['perspective', 'Perspective', 'Drag a corner to bring its edge in or out, symmetrically.'],
  ['warp', 'Warp', 'Bend the layer: drag the mesh, its anchors and handles, or choose a style.'],
]

/** Free Transform's modes, and in Warp its style, settings and grid. */
function TransformOptions() {
  const ui = useSyncExternalStore(transformUi().subscribe, transformUi().get)
  if (!ui.warps) return <ScaleStrokesOption />
  const w = ui.warp
  const styled = w.style !== 'none' && w.style !== 'custom'
  return (
    <>
      <ScaleStrokesOption />
      <span className="options-group" role="radiogroup" aria-label="Transform mode">
        {TRANSFORM_MODES.map(([m, label, hint]) => (
          <button key={m} type="button" role="radio" className="options-toggle" aria-checked={ui.mode === m} aria-pressed={ui.mode === m} data-transform-mode={m} data-tip={hint} onClick={() => transformUi().set({ mode: m })}>
            {label}
          </button>
        ))}
      </span>
      {ui.mode === 'warp' && (
        <>
          <label className="options-field">
            <span>Style</span>
            <select id="opt-warp-style" value={w.style} onChange={(e) => transformUi().setWarp({ style: e.target.value })}>
              {WARP_STYLES.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {styled && (
            <>
              <button type="button" className="options-toggle" aria-pressed={w.orient === 'vertical'} data-warp-vertical data-tip="Bend up and down the layer rather than across it." onClick={() => transformUi().setWarp({ orient: w.orient === 'vertical' ? 'horizontal' : 'vertical' })}>
                Vertical
              </button>
              <NumberOption o={{ label: 'Bend', min: -100, max: 100, unit: '%', hint: 'How far the style bends, either way.' }} value={w.bend} onChange={(v) => transformUi().setWarp({ bend: v })} id="opt-warp-bend" />
              <NumberOption o={{ label: 'H', min: -100, max: 100, unit: '%', hint: 'Horizontal distortion: one side taller than the other.' }} value={w.horizontal} onChange={(v) => transformUi().setWarp({ horizontal: v })} id="opt-warp-h" />
              <NumberOption o={{ label: 'V', min: -100, max: 100, unit: '%', hint: 'Vertical distortion: the top wider than the bottom.' }} value={w.vertical} onChange={(v) => transformUi().setWarp({ vertical: v })} id="opt-warp-v" />
            </>
          )}
          {!styled && (
            <label className="options-field" data-tip="How many patches the mesh has a side: more to bend parts of the layer on their own.">
              <span>Grid</span>
              <select id="opt-warp-grid" value={w.grid} onChange={(e) => transformUi().setWarp({ grid: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((g) => (
                  <option key={g} value={g}>
                    {g === 1 ? 'Default' : `${g} × ${g}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="options-toggle" data-warp-reset data-tip="Take the warp off: the mesh flat again." onClick={() => transformUi().setWarp({ ...NO_WARP, grid: w.grid })}>
            Reset
          </button>
        </>
      )}
    </>
  )
}

/** Liquify's brush: which tool, its size and pressure, and Restore All. */
function LiquifyOptions() {
  const s = useSyncExternalStore(liquifySettings().subscribe, liquifySettings().get)
  return (
    <>
      <label className="options-field">
        <span>Tool</span>
        <select id="opt-liquify-tool" value={s.tool} data-tip={LIQUIFY_TOOLS.find((t) => t[0] === s.tool)?.[2]} onChange={(e) => liquifySettings().set({ tool: e.target.value as typeof s.tool })}>
          {LIQUIFY_TOOLS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <NumberOption o={{ label: 'Size', min: 4, max: 2000, unit: 'px', hint: 'The brush’s diameter, in document pixels.' }} value={s.size} onChange={(v) => liquifySettings().set({ size: v })} id="opt-liquify-size" />
      <NumberOption o={{ label: 'Pressure', min: 1, max: 100, unit: '%', hint: 'How strongly the brush acts.' }} value={s.pressure} onChange={(v) => liquifySettings().set({ pressure: v })} id="opt-liquify-pressure" />
      <button type="button" className="options-toggle" data-liquify-restore data-tip="Takes the whole warp back off." onClick={() => liquifySettings().restore?.()}>
        Restore All
      </button>
    </>
  )
}

/** What a Free Transform, Crop or Polygonal Lasso in progress is doing, with Commit and Cancel. */
function SessionReadout() {
  const session = useSyncExternalStore(sessions().subscribe, sessions().get)
  // The readout follows the session's drawing: each change to the overlay draws it again.
  useSyncExternalStore(subscribeToolOverlay, toolOverlayVersion)
  if (!session) return null
  return (
    <>
      <span className="options-hint" data-session={session.kind}>
        {session.readout()}
      </span>
      <button type="button" className="options-toggle" data-session-commit onClick={() => sessions().commit()}>
        {session.kind === 'crop' ? 'Crop' : session.kind === 'polygon' ? 'Close' : session.kind === 'pen' ? 'Finish' : 'Commit'}
      </button>
      <button type="button" className="options-toggle" data-session-cancel onClick={() => sessions().end(true)}>
        Cancel
      </button>
    </>
  )
}

/** A share 0..1 shown as a percentage field. */
function Percent({ label, value, onChange, id, hint, min = 0 }: { label: string; value: number; onChange(v: number): void; id: string; hint: string; min?: number }) {
  return <NumberOption o={{ label, min, max: 100, unit: '%', hint }} value={value * 100} onChange={(v) => onChange(v / 100)} id={id} />
}

/** The Mixer Brush's paint: Photoshop's combinations, Wet, Load and Mix, Load and Clean, Sample All Layers. */
function MixerOptions() {
  const m = useSyncExternalStore(brushes().subscribe, () => brushes().get().mixerSettings)
  const preset = MIXER_PRESETS.find((p) => Math.abs(p.wet - m.wet) < 1e-6 && Math.abs(p.load - m.load) < 1e-6 && Math.abs(p.mix - m.mix) < 1e-6)
  return (
    <>
      <span className="options-field" role="group" aria-label="Brush paint">
        <button type="button" className="options-toggle" data-mixer-load data-tip="Load the brush with the foreground colour for the next stroke" onClick={() => brushes().setNextReservoir('load')}>
          Load
        </button>
        <button type="button" className="options-toggle" data-mixer-clean data-tip="Clean the brush: the next stroke starts with no paint of its own" onClick={() => brushes().setNextReservoir('clean')}>
          Clean
        </button>
        <button type="button" className="options-toggle" aria-pressed={m.loadEach} data-mixer-load-each data-tip="Load the brush after each stroke" onClick={() => brushes().updateMixer({ loadEach: !m.loadEach })}>
          Load each
        </button>
        <button type="button" className="options-toggle" aria-pressed={m.cleanEach} data-mixer-clean-each data-tip="Clean the brush after each stroke" onClick={() => brushes().updateMixer({ cleanEach: !m.cleanEach })}>
          Clean each
        </button>
      </span>
      <label className="options-field">
        <span>Mix</span>
        <select
          id="opt-mixer-combination"
          value={preset?.name ?? ''}
          onChange={(e) => {
            const p = MIXER_PRESETS.find((x) => x.name === e.target.value)
            if (p) brushes().updateMixer({ wet: p.wet, load: p.load, mix: p.mix })
          }}
        >
          {!preset && <option value="">Custom</option>}
          {MIXER_PRESETS.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <Percent label="Wet" value={m.wet} onChange={(v) => brushes().updateMixer({ wet: v })} id="opt-mixer-wet" hint="How much paint the brush picks up from the canvas." />
      <Percent label="Load" min={1} value={m.load} onChange={(v) => brushes().updateMixer({ load: Math.max(0.01, v) })} id="opt-mixer-load" hint="How much paint the brush holds: with a light load the stroke dries out quickly." />
      <Percent label="Mix" value={m.mix} onChange={(v) => brushes().updateMixer({ mix: v })} id="opt-mixer-mix" hint="How much of the paint put down is the canvas’s rather than the brush’s." />
      <button type="button" className="options-toggle" aria-pressed={m.sampleAll} id="opt-mixer-sample-all" data-tip="Pick paint up from the whole image, not just the selected layer" onClick={() => brushes().updateMixer({ sampleAll: !m.sampleAll })}>
        Sample all layers
      </button>
    </>
  )
}

/** The Clone Stamp's or the Healing Brush's Aligned and Sample All Layers. */
function SourceOptions({ tool }: { tool: 'clone' | 'heal' }) {
  const s = useSyncExternalStore(retouch().subscribe, () => retouch().get()[tool])
  return (
    <>
      <button type="button" className="options-toggle" aria-pressed={s.aligned} id={`opt-${tool}-aligned`} data-tip="Every stroke carries on copying the same picture, rather than starting from the source again" onClick={() => retouch().update(tool, { aligned: !s.aligned })}>
        Aligned
      </button>
      <button type="button" className="options-toggle" aria-pressed={s.sampleAll} id={`opt-${tool}-sample-all`} data-tip="Copy what the whole image shows, not just the selected layer" onClick={() => retouch().update(tool, { sampleAll: !s.sampleAll })}>
        Sample all layers
      </button>
    </>
  )
}

/** Smudge's Strength, Finger Painting and Sample All Layers. */
function SmudgeOptions() {
  const m = useSyncExternalStore(brushes().subscribe, () => brushes().get().smudgeSettings)
  return (
    <>
      <Percent label="Strength" value={m.strength} onChange={(v) => brushes().updateSmudge({ strength: v })} id="opt-smudge-strength" hint="How far the paint is pushed along before it runs out." />
      <button type="button" className="options-toggle" aria-pressed={m.sampleAll} id="opt-smudge-sample-all" data-tip="Smudge what the whole image shows, not just the selected layer" onClick={() => brushes().updateSmudge({ sampleAll: !m.sampleAll })}>
        Sample all layers
      </button>
      <button type="button" className="options-toggle" aria-pressed={m.fingerPainting} id="opt-smudge-finger" data-tip="Start each stroke with the foreground colour on the finger" onClick={() => brushes().updateSmudge({ fingerPainting: !m.fingerPainting })}>
        Finger painting
      </button>
    </>
  )
}

function NumberOption({ o, value, onChange, id }: { o: { label: string; min: number; max: number; unit: string; hint: string }; value: number; onChange(v: number): void; id: string }) {
  return (
    <span className="options-field" data-tip={o.hint}>
      <ScrubLabel htmlFor={id} className="options-scrub" value={Math.round(value)} min={o.min} max={o.max} step={1} onChange={onChange}>
        {o.label}
      </ScrubLabel>
      <NumberInput id={id} className="options-number" value={Math.round(value)} min={o.min} max={o.max} step={1} onChange={(v) => onChange(Math.round(v))} />
      <span className="unit">{o.unit}</span>
    </span>
  )
}

/**
 * The Artboard tool's options: the selected artboard's size, by preset or
 * by number, and Add Artboard, which puts a new one (the preset's size, or
 * the last one's) to the right of the others. With no artboards yet, Add
 * makes the canvas Artboard 1.
 */
function ArtboardOptions() {
  const d = useSyncExternalStore(documents().subscribe, () => documents().active())
  const doc = d?.history.present
  const sel = d && doc && d.selected && isArtboard(doc.nodes[d.selected]) ? (doc.nodes[d.selected] as ArtboardNode) : null
  const r = sel ? artboardRect(sel) : null
  const preset = sel ? ARTBOARD_PRESETS.find((p) => p.width === sel.props.artboard.width && p.height === sel.props.artboard.height) : null
  const resize = (w: number, h: number) => {
    if (!d || !sel || !r) return
    commitArtboards(d, (x) => setArtboardRect(x, sel.id, [r[0], r[1], r[0] + Math.max(1, Math.round(w)), r[1] + Math.max(1, Math.round(h))], false), 'Resize Artboard')
  }
  return (
    <>
      <span className="options-field">
        <label htmlFor="opt-artboard-preset" className="options-scrub">
          Size
        </label>
        <select
          id="opt-artboard-preset"
          value={preset?.id ?? 'custom'}
          disabled={!sel}
          data-why="Select an artboard (click it with this tool)"
          onChange={(e) => {
            const p = ARTBOARD_PRESETS.find((x) => x.id === e.target.value)
            if (p) resize(p.width, p.height)
          }}
        >
          <option value="custom">{sel ? 'Custom' : 'No artboard selected'}</option>
          {ARTBOARD_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.width} × {p.height})
            </option>
          ))}
        </select>
      </span>
      {sel && r && (
        <>
          <NumberOption o={{ label: 'W', min: 1, max: 30000, unit: 'px', hint: 'The artboard’s width; its layers stay where they are' }} value={r[2] - r[0]} onChange={(w) => resize(w, r[3] - r[1])} id="opt-artboard-w" />
          <NumberOption o={{ label: 'H', min: 1, max: 30000, unit: 'px', hint: 'The artboard’s height' }} value={r[3] - r[1]} onChange={(h) => resize(r[2] - r[0], h)} id="opt-artboard-h" />
        </>
      )}
      <button type="button" className="options-toggle" data-artboard-add data-tip="A new artboard to the right of the others, the size of the selected one" onClick={() => newArtboard(sel ? { width: sel.props.artboard.width, height: sel.props.artboard.height } : undefined)}>
        Add Artboard
      </button>
    </>
  )
}

/** The next brush size a step smaller or larger, in Photoshop's steps. */
export function stepSize(size: number, dir: 1 | -1): number {
  const step = size < 10 ? 1 : size < 50 ? 5 : size < 100 ? 10 : size < 200 ? 25 : size < 500 ? 50 : 100
  const next = dir > 0 ? Math.floor(size / step) * step + step : Math.ceil(size / step) * step - step
  return Math.min(2000, Math.max(1, next))
}

const DISTRIBUTE_BUTTONS: { id: DistributeOp; label: string }[] = [
  { id: 'hcentre', label: 'Distribute horizontal centres' },
  { id: 'hspace', label: 'Distribute horizontal spacing' },
  { id: 'vcentre', label: 'Distribute vertical centres' },
  { id: 'vspace', label: 'Distribute vertical spacing' },
]

/** The Move tool's Align To, and buttons for aligning and distributing the selected layers. */
function AlignOptions() {
  const d = useSyncExternalStore(documents().subscribe, () => documents().active())
  const to = useSyncExternalStore(guidePrefs().subscribe, () => guidePrefs().get().alignTo)
  const aWhy = alignWhy(d, to)
  const dWhy = distributeWhy(d, to)
  return (
    <>
      <label className="options-field">
        <span>Align To</span>
        <select id="opt-align-to" value={to} onChange={(e) => guidePrefs().update({ alignTo: e.target.value as AlignTo })}>
          {ALIGN_TO.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <span className="options-buttons" role="group" aria-label="Align">
        {ALIGN_OPS.map((o) => (
          <button key={o.id} type="button" className="icon-button" data-align={o.id} aria-label={`Align ${o.label.toLowerCase()}`} data-tip={`Align ${o.label.toLowerCase()}`} disabled={!!aWhy} data-why={aWhy ?? undefined} onClick={() => void alignLayers(o.id)}>
            <Icon name={`align.${o.id}`} />
          </button>
        ))}
      </span>
      <span className="options-buttons" role="group" aria-label="Distribute">
        {DISTRIBUTE_BUTTONS.map((o) => (
          <button key={o.id} type="button" className="icon-button" data-distribute={o.id} aria-label={o.label} data-tip={o.label} disabled={!!dWhy} data-why={dWhy ?? undefined} onClick={() => void distributeLayers(o.id)}>
            <Icon name={`distribute.${o.id}` as 'distribute.hspace'} />
          </button>
        ))}
      </span>
    </>
  )
}

/** The Move tool's Auto-Select: the layer (or its group) under the pointer is picked at each press. */
function AutoSelectOption() {
  const o = useSyncExternalStore(moveTool().subscribe, moveTool().get)
  return (
    <span className="options-field" data-tip="Picks the layer under the pointer when you press, as Ctrl-click does with it off. Alt-click picks the next one down.">
      <label className="check">
        <input type="checkbox" id="opt-auto-select" checked={o.autoSelect} onChange={(e) => moveTool().update({ autoSelect: e.target.checked })} />
        Auto-Select
      </label>
      <select id="opt-auto-target" aria-label="Auto-Select picks" value={o.target} onChange={(e) => moveTool().update({ target: e.target.value as 'layer' | 'group' })}>
        <option value="layer">Layer</option>
        <option value="group">Group</option>
      </select>
      <ScaleStrokesOption />
    </span>
  )
}

/** Scale Strokes, shown with the Move tool and while Free Transform is open. */
function ScaleStrokesOption() {
  const o = useSyncExternalStore(moveTool().subscribe, moveTool().get)
  return (
    <label className="check" data-tip="Whether scaling a shape scales its strokes with it, as Illustrator's Scale Strokes & Effects. Off, the strokes keep their widths.">
      <input type="checkbox" id="opt-scale-strokes" checked={o.scaleStrokes} onChange={(e) => moveTool().update({ scaleStrokes: e.target.checked })} />
      Scale Strokes
    </label>
  )
}

/**
 * The freehand tools' settings: how smooth (Fidelity), and for the Pencil
 * and Paintbrush the width, Fill, Close and the two selection switches;
 * the Paintbrush's brush; the Blob Brush's size and Merge only with
 * selection.
 */
function FreehandOptions({ tool }: { tool: 'pencil' | 'vbrush' | 'blob' }) {
  const s = useSyncExternalStore(freehand().subscribe, freehand().get)
  const doc = useSyncExternalStore(documents().subscribe, () => documents().active()?.history.present ?? null)
  const set = (p: Parameters<ReturnType<typeof freehand>['update']>[0]) => freehand().update(p)
  const toggle = (k: 'fillNew' | 'close' | 'editSelected' | 'keepSelected' | 'mergeSelected', label: string, hint: string) => (
    <button type="button" className="options-toggle" aria-pressed={s[k]} data-freehand={k} data-tip={hint} onClick={() => set({ [k]: !s[k] })}>
      {label}
    </button>
  )
  return (
    <>
      {tool === 'vbrush' && (
        <label className="options-field" data-tip="The vector brush the Paintbrush paints with">
          <span>Brush</span>
          <select id="opt-freehand-brush" value={s.brush ?? 'none'} onChange={(e) => set({ brush: e.target.value === 'none' ? null : e.target.value })}>
            <option value="none">Basic (no brush)</option>
            {doc &&
              brushChoices(doc).map((c) => (
                <option key={c.brush.id} value={c.brush.id}>
                  {c.brush.name}
                </option>
              ))}
          </select>
        </label>
      )}
      {tool === 'blob' ? (
        <NumberOption o={{ label: 'Size', min: 1, max: 2000, unit: 'px', hint: 'The Blob Brush’s diameter. [ and ] make it smaller and larger.' }} value={s.blobSize} onChange={(v) => set({ blobSize: v })} id="opt-freehand-size" />
      ) : (
        <NumberOption o={{ label: 'Width', min: 0.1, max: 1000, unit: 'px', hint: 'How wide new strokes are (with a brush: how tall its artwork is).' }} value={s.width} onChange={(v) => set({ width: v })} id="opt-freehand-width" />
      )}
      <NumberOption o={{ label: 'Fidelity', min: 0.5, max: 20, unit: 'px', hint: 'How smooth: how far the curve may stray from your hand, in screen pixels. Small follows every wobble; large is smooth.' }} value={s.fidelity} onChange={(v) => set({ fidelity: v })} id="opt-freehand-fidelity" />
      {tool === 'blob' ? (
        toggle('mergeSelected', 'Merge only with selection', 'Join only the selected shapes, not every shape of the colour it touches')
      ) : (
        <>
          {toggle('fillNew', 'Fill', 'Fill new paths with the background colour')}
          {tool === 'pencil' && toggle('close', 'Close when near', 'A stroke ending near where it began closes the path')}
          {toggle('editSelected', 'Edit selected', 'A stroke starting on the selected path redraws that part of it, or carries it on from an end')}
          {toggle('keepSelected', 'Keep selected', 'The new path stays selected, so the next stroke near it redraws it')}
        </>
      )}
    </>
  )
}
