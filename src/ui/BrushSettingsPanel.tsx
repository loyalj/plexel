/**
 * The Brush Settings panel: Photoshop's, section by section, for the brush
 * of the painting tool in use (the Brush, the Eraser, the Mixer Brush or
 * Smudge; the Brush when another tool is chosen). Each section with a
 * switch can be turned off, which puts its settings back as they were;
 * each property with a control has its menu (Photoshop's inputs), a
 * minimum, Fade's steps, and a curve the input goes through. A stroke at
 * the bottom shows what the brush paints, drawn by the same code the GPU is
 * held to (brush/preview.ts).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { brushAssets } from '../app/brushAssets'
import { brushes, type PaintTool } from '../app/brushes'
import {
  BUILTIN_TIPS,
  DEFAULT_BRUSH,
  DEFAULT_DUAL,
  DEFAULT_POSE,
  DEFAULT_TEXTURE,
  DUAL_MODES,
  DYN_INPUTS,
  DYN_INPUT_LABELS,
  LINEAR,
  TEXTURE_MODES,
  controlOf,
  curveAt,
  withControl,
  type BrushSettings,
  type DynInput,
  type DynTarget,
  type TipId,
} from '../brush/defs'
import { strokePreview } from '../brush/preview'
import { BUILTIN_TEXTURES, TEXTURE_LABELS } from '../brush/textures'
import { sampleTip, tipImage } from '../brush/tips'
import { TOOL_BY_ID, tools } from '../tools'

const MODE_LABELS: Record<string, string> = {
  multiply: 'Multiply',
  subtract: 'Subtract',
  darken: 'Darken',
  overlay: 'Overlay',
  'color-dodge': 'Colour Dodge',
  'color-burn': 'Colour Burn',
  'linear-burn': 'Linear Burn',
  'hard-mix': 'Hard Mix',
  'linear-height': 'Linear Height',
  height: 'Height',
}

export function BrushSettingsPanel() {
  const state = useSyncExternalStore(brushes().subscribe, brushes().get)
  const toolId = useSyncExternalStore(tools().subscribe, tools().get)
  useSyncExternalStore(brushAssets().subscribe, () => brushAssets().list('tip').length + brushAssets().list('pattern').length)
  const tool: PaintTool = TOOL_BY_ID.get(toolId)?.paints ?? 'brush'
  const b = state[tool]
  const protectTexture = state.protectTexture
  const set = (patch: Partial<BrushSettings>) => brushes().update(tool, patch)
  const id = (k: string) => `bs-${k}`
  const round = b.tip === 'round'
  return (
    <div className="brush-settings" data-brush-settings={tool}>
      <p className="field-note">The {TOOL_BY_ID.get(tool)?.name ?? 'Brush'}’s brush.</p>

      <Section title="Brush Tip Shape" id="tip" open>
        <TipPicker value={b.tip} onChange={(tip) => set({ tip })} id={id('tip')} />
        <Slider id={id('size')} label="Size" min={1} max={2000} step={1} unit="px" value={b.size} onChange={(size) => set({ size })} />
        <div className="check-row">
          <Check id={id('flip-x')} label="Flip X" value={b.flipX} onChange={(flipX) => set({ flipX })} />
          <Check id={id('flip-y')} label="Flip Y" value={b.flipY} onChange={(flipY) => set({ flipY })} />
        </div>
        <Slider id={id('angle')} label="Angle" min={-180} max={180} step={1} unit="°" value={b.angle} onChange={(angle) => set({ angle })} />
        <Slider id={id('roundness')} label="Roundness" min={1} max={100} step={1} unit="%" value={b.roundness * 100} onChange={(v) => set({ roundness: v / 100 })} />
        {round && <Slider id={id('hardness')} label="Hardness" min={0} max={100} step={1} unit="%" value={b.hardness * 100} onChange={(v) => set({ hardness: v / 100 })} />}
        <Slider id={id('spacing')} label="Spacing" min={1} max={1000} step={1} unit="%" value={b.spacing * 100} onChange={(v) => set({ spacing: v / 100 })} />
      </Section>

      <Section
        title="Shape Dynamics"
        id="shape"
        on={b.sizeJitter > 0 || b.angleJitter > 0 || b.roundnessJitter > 0 || b.flipXJitter || b.flipYJitter || ['size', 'angle', 'roundness'].some((t) => controlOf(b, t as DynTarget))}
        onToggle={(on) =>
          set(
            on
              ? { dynamics: withControl(b, 'size', { input: 'pressure', curve: [...LINEAR], min: 0.15 }).dynamics }
              : { sizeJitter: 0, angleJitter: 0, roundnessJitter: 0, flipXJitter: false, flipYJitter: false, dynamics: b.dynamics.filter((d) => !['size', 'angle', 'roundness'].includes(d.target)) },
          )
        }
      >
        <Percent id={id('size-jitter')} label="Size Jitter" value={b.sizeJitter} onChange={(sizeJitter) => set({ sizeJitter })} />
        <Control b={b} target="size" minLabel="Minimum Diameter" set={set} id={id('size-control')} />
        <Percent id={id('angle-jitter')} label="Angle Jitter" value={b.angleJitter} onChange={(angleJitter) => set({ angleJitter })} />
        <Control b={b} target="angle" set={set} id={id('angle-control')} />
        <Percent id={id('roundness-jitter')} label="Roundness Jitter" value={b.roundnessJitter} onChange={(roundnessJitter) => set({ roundnessJitter })} />
        <Control b={b} target="roundness" set={set} id={id('roundness-control')} />
        <Percent id={id('min-roundness')} label="Minimum Roundness" min={1} value={b.minRoundness} onChange={(minRoundness) => set({ minRoundness: Math.max(0.01, minRoundness) })} />
        <div className="check-row">
          <Check id={id('flip-x-jitter')} label="Flip X Jitter" value={b.flipXJitter} onChange={(flipXJitter) => set({ flipXJitter })} />
          <Check id={id('flip-y-jitter')} label="Flip Y Jitter" value={b.flipYJitter} onChange={(flipYJitter) => set({ flipYJitter })} />
        </div>
      </Section>

      <Section
        title="Scattering"
        id="scatter"
        on={b.scatter > 0 || b.count > 1 || b.countJitter > 0}
        onToggle={(on) => set(on ? { scatter: 1 } : { scatter: 0, scatterBothAxes: false, count: 1, countJitter: 0, dynamics: b.dynamics.filter((d) => d.target !== 'scatter' && d.target !== 'count') })}
      >
        <Slider id={id('scatter')} label="Scatter" min={0} max={1000} step={1} unit="%" value={b.scatter * 100} onChange={(v) => set({ scatter: v / 100 })} />
        <Check id={id('both-axes')} label="Both Axes" value={b.scatterBothAxes} onChange={(scatterBothAxes) => set({ scatterBothAxes })} />
        <Control b={b} target="scatter" set={set} id={id('scatter-control')} noMin />
        <Slider id={id('count')} label="Count" min={1} max={16} step={1} unit="" value={b.count} onChange={(count) => set({ count })} />
        <Percent id={id('count-jitter')} label="Count Jitter" value={b.countJitter} onChange={(countJitter) => set({ countJitter })} />
        <Control b={b} target="count" set={set} id={id('count-control')} noMin />
      </Section>

      <Section title="Texture" id="texture" on={!!b.texture} onToggle={(on) => set({ texture: on ? { ...DEFAULT_TEXTURE } : null })}>
        {b.texture && <TextureSection b={b} set={set} id={id} />}
      </Section>

      <Section title="Dual Brush" id="dual" on={!!b.dual} onToggle={(on) => set({ dual: on ? { ...DEFAULT_DUAL } : null })}>
        {b.dual && (
          <>
            <label className="field">
              <span>Mode</span>
              <select id={id('dual-mode')} value={b.dual.mode} onChange={(e) => set({ dual: { ...b.dual!, mode: e.target.value as never } })}>
                {DUAL_MODES.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
            <Check id={id('dual-flip')} label="Flip" value={b.dual.flip} onChange={(flip) => set({ dual: { ...b.dual!, flip } })} />
            <TipPicker value={b.dual.tip} onChange={(tip) => set({ dual: { ...b.dual!, tip } })} id={id('dual-tip')} />
            <Slider id={id('dual-size')} label="Size" min={1} max={2000} step={1} unit="px" value={b.dual.size} onChange={(size) => set({ dual: { ...b.dual!, size } })} />
            {b.dual.tip === 'round' && <Percent id={id('dual-hardness')} label="Hardness" value={b.dual.hardness} onChange={(hardness) => set({ dual: { ...b.dual!, hardness } })} />}
            <Slider id={id('dual-spacing')} label="Spacing" min={1} max={1000} step={1} unit="%" value={b.dual.spacing * 100} onChange={(v) => set({ dual: { ...b.dual!, spacing: v / 100 } })} />
            <Slider id={id('dual-scatter')} label="Scatter" min={0} max={1000} step={1} unit="%" value={b.dual.scatter * 100} onChange={(v) => set({ dual: { ...b.dual!, scatter: v / 100 } })} />
            <Check id={id('dual-both')} label="Both Axes" value={b.dual.bothAxes} onChange={(bothAxes) => set({ dual: { ...b.dual!, bothAxes } })} />
            <Slider id={id('dual-count')} label="Count" min={1} max={16} step={1} unit="" value={b.dual.count} onChange={(count) => set({ dual: { ...b.dual!, count } })} />
          </>
        )}
      </Section>

      <Section
        title="Colour Dynamics"
        id="colour"
        on={b.colourJitter > 0 || b.hueJitter > 0 || b.saturationJitter > 0 || b.brightnessJitter > 0 || b.purity !== 0 || !!controlOf(b, 'colour')}
        onToggle={(on) => set(on ? { colourJitter: 0.2 } : { colourJitter: 0, hueJitter: 0, saturationJitter: 0, brightnessJitter: 0, purity: 0, dynamics: b.dynamics.filter((d) => d.target !== 'colour') })}
      >
        <Check id={id('per-tip')} label="Apply Per Tip" value={b.colourPerTip} onChange={(colourPerTip) => set({ colourPerTip })} />
        <Percent id={id('fgbg')} label="Foreground/Background Jitter" value={b.colourJitter} onChange={(colourJitter) => set({ colourJitter })} />
        <Control b={b} target="colour" set={set} id={id('fgbg-control')} noMin />
        <Percent id={id('hue')} label="Hue Jitter" value={b.hueJitter} onChange={(hueJitter) => set({ hueJitter })} />
        <Percent id={id('saturation')} label="Saturation Jitter" value={b.saturationJitter} onChange={(saturationJitter) => set({ saturationJitter })} />
        <Percent id={id('brightness')} label="Brightness Jitter" value={b.brightnessJitter} onChange={(brightnessJitter) => set({ brightnessJitter })} />
        <Slider id={id('purity')} label="Purity" min={-100} max={100} step={1} unit="%" value={b.purity * 100} onChange={(v) => set({ purity: v / 100 })} />
      </Section>

      <Section
        title="Transfer"
        id="transfer"
        on={b.opacityJitter > 0 || b.flowJitter > 0 || b.wetnessJitter > 0 || b.mixJitter > 0 || ['opacity', 'flow', 'wetness', 'mix'].some((t) => controlOf(b, t as DynTarget))}
        onToggle={(on) =>
          set(on ? { dynamics: withControl(b, 'flow', { input: 'pressure', curve: [...LINEAR], min: 0 }).dynamics } : { opacityJitter: 0, flowJitter: 0, wetnessJitter: 0, mixJitter: 0, dynamics: b.dynamics.filter((d) => !['opacity', 'flow', 'wetness', 'mix'].includes(d.target)) })
        }
      >
        <Percent id={id('opacity-jitter')} label="Opacity Jitter" value={b.opacityJitter} onChange={(opacityJitter) => set({ opacityJitter })} />
        <Control b={b} target="opacity" set={set} id={id('opacity-control')} />
        <Percent id={id('flow-jitter')} label="Flow Jitter" value={b.flowJitter} onChange={(flowJitter) => set({ flowJitter })} />
        <Control b={b} target="flow" set={set} id={id('flow-control')} />
        {tool === 'mixer' && (
          <>
            <Percent id={id('wet-jitter')} label="Wetness Jitter" value={b.wetnessJitter} onChange={(wetnessJitter) => set({ wetnessJitter })} />
            <Control b={b} target="wetness" set={set} id={id('wet-control')} />
            <Percent id={id('mix-jitter')} label="Mix Jitter" value={b.mixJitter} onChange={(mixJitter) => set({ mixJitter })} />
            <Control b={b} target="mix" set={set} id={id('mix-control')} />
          </>
        )}
      </Section>

      <Section title="Brush Pose" id="pose" on={!!b.pose} onToggle={(on) => set({ pose: on ? { ...DEFAULT_POSE } : null })}>
        {b.pose && (
          <>
            <PoseRow id={id('pose-tilt-x')} label="Tilt X" min={-90} max={90} unit="°" value={b.pose.tiltX} onChange={(tiltX) => set({ pose: { ...b.pose!, tiltX } })} />
            <PoseRow id={id('pose-tilt-y')} label="Tilt Y" min={-90} max={90} unit="°" value={b.pose.tiltY} onChange={(tiltY) => set({ pose: { ...b.pose!, tiltY } })} />
            <PoseRow id={id('pose-rotation')} label="Rotation" min={0} max={359} unit="°" value={b.pose.rotation} onChange={(rotation) => set({ pose: { ...b.pose!, rotation } })} />
            <PoseRow id={id('pose-pressure')} label="Pressure" min={0} max={100} unit="%" scale={100} value={b.pose.pressure} onChange={(pressure) => set({ pose: { ...b.pose!, pressure } })} />
          </>
        )}
      </Section>

      <div className="brush-switches">
        <Check id={id('noise')} label="Noise" value={b.noise} onChange={(noise) => set({ noise })} />
        <Check id={id('wet-edges')} label="Wet Edges" value={b.wetEdges} onChange={(wetEdges) => set({ wetEdges })} />
        <Check id={id('build-up')} label="Build-up" value={b.buildUp} onChange={(buildUp) => set({ buildUp })} />
        <Check id={id('pulled-string')} label="Pulled-string smoothing" value={b.pulledString} onChange={(pulledString) => set({ pulledString })} />
        <Check id={id('protect-texture')} label="Protect Texture" value={protectTexture} onChange={(on) => brushes().setProtectTexture(on)} />
      </div>
      <Slider id={id('smoothing')} label="Smoothing" min={0} max={95} step={1} unit="%" value={b.smoothing * 100} onChange={(v) => set({ smoothing: v / 100 })} />
      <button type="button" className="button small" data-brush-reset onClick={() => set({ ...DEFAULT_BRUSH, size: b.size, tip: b.tip })}>
        Reset All Sections
      </button>

      <StrokePreview settings={b} />
    </div>
  )
}

// --- parts ------------------------------------------------------------------------------------

function Section({ title, id, open, on, onToggle, children }: { title: string; id: string; open?: boolean; on?: boolean; onToggle?(on: boolean): void; children: ReactNode }) {
  const [shown, setShown] = useState(!!open)
  return (
    <section className="brush-section" data-section={id}>
      <header className="brush-section-head">
        {onToggle && <input type="checkbox" aria-label={`${title} on`} data-section-on={id} checked={!!on} onChange={(e) => onToggle(e.target.checked)} />}
        <button type="button" className="brush-section-title" aria-expanded={shown} onClick={() => setShown(!shown)}>
          {title}
        </button>
      </header>
      {shown && <div className="brush-section-body">{children}</div>}
    </section>
  )
}

function Slider({ id, label, min, max, step, unit, value, onChange }: { id: string; label: string; min: number; max: number; step: number; unit: string; value: number; onChange(v: number): void }) {
  const [typed, setTyped] = useState<string | null>(null)
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="slider-row">
        <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(clamp(Number(e.target.value)))} />
        <input
          className="slider-number"
          aria-label={`${label}${unit ? `, ${unit}` : ''}`}
          inputMode="decimal"
          value={typed ?? String(Math.round(value / step) * step)}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => {
            const n = Number(typed)
            if (typed !== null && Number.isFinite(n)) onChange(clamp(n))
            setTyped(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="unit">{unit}</span>
      </div>
    </div>
  )
}

const Percent = ({ id, label, value, onChange, min = 0 }: { id: string; label: string; value: number; onChange(v: number): void; min?: number }) => (
  <Slider id={id} label={label} min={min} max={100} step={1} unit="%" value={value * 100} onChange={(v) => onChange(v / 100)} />
)

const Check = ({ id, label, value, onChange }: { id: string; label: string; value: boolean; onChange(v: boolean): void }) => (
  <label className="check">
    <input type="checkbox" id={id} checked={value} onChange={(e) => onChange(e.target.checked)} />
    {label}
  </label>
)

/** A Brush Pose value: on (with its number) or the pen's. */
function PoseRow({ id, label, min, max, unit, value, scale = 1, onChange }: { id: string; label: string; min: number; max: number; unit: string; value: number | null; scale?: number; onChange(v: number | null): void }) {
  return (
    <div className="pose-row">
      <Check id={`${id}-on`} label={`Override ${label}`} value={value !== null} onChange={(on) => onChange(on ? (min + max) / 2 / scale : null)} />
      {value !== null && <Slider id={id} label={label} min={min} max={max} step={1} unit={unit} value={value * scale} onChange={(v) => onChange(v / scale)} />}
    </div>
  )
}

/** A property's control: Photoshop's menu, Fade's steps, the minimum, and the curve the input goes through. */
function Control({ b, target, set, id, minLabel = 'Minimum', noMin }: { b: BrushSettings; target: DynTarget; set(p: Partial<BrushSettings>): void; id: string; minLabel?: string; noMin?: boolean }) {
  const c = controlOf(b, target)
  const [curveShown, setCurveShown] = useState(false)
  const put = (patch: Partial<NonNullable<typeof c>> | null) => set({ dynamics: withControl(b, target, patch === null ? null : { input: 'pressure', curve: [...LINEAR], min: 0, ...(c ?? {}), ...patch }).dynamics })
  return (
    <div className="control-row" data-control={target}>
      <label className="field">
        <span>Control</span>
        <select id={id} value={c?.input ?? ''} onChange={(e) => (e.target.value ? put({ input: e.target.value as DynInput, ...(e.target.value === 'fade' ? { steps: c?.steps ?? 25 } : {}) }) : put(null))}>
          <option value="">Off</option>
          {DYN_INPUTS.map((i) => (
            <option key={i} value={i}>
              {DYN_INPUT_LABELS[i]}
            </option>
          ))}
        </select>
      </label>
      {c?.input === 'fade' && <Slider id={`${id}-steps`} label="Steps" min={1} max={999} step={1} unit="" value={c.steps ?? 25} onChange={(steps) => put({ steps })} />}
      {c && !noMin && target !== 'angle' && <Percent id={`${id}-min`} label={minLabel} value={c.min} onChange={(min) => put({ min })} />}
      {c && (
        <>
          <button type="button" className="button small" aria-expanded={curveShown} data-curve-toggle={target} onClick={() => setCurveShown(!curveShown)}>
            Curve
          </button>
          {curveShown && <ControlCurve id={`${id}-curve`} curve={c.curve} onChange={(curve) => put({ curve })} />}
        </>
      )}
    </div>
  )
}

/** A control's curve: values at evenly spaced inputs, each dragged up or down; points added or taken away. */
function ControlCurve({ id, curve, onChange }: { id: string; curve: number[]; onChange(c: number[]): void }) {
  const svg = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const S = 120
  const n = curve.length
  const x = (i: number) => (i / (n - 1)) * S
  const path = curve.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${(1 - v) * S}`).join(' ')
  const resample = (k: number) => Array.from({ length: k }, (_, i) => curveAt(curve, i / (k - 1)))
  return (
    <div className="control-curve">
      <svg
        ref={svg}
        id={id}
        className="curve-box"
        viewBox={`0 0 ${S} ${S}`}
        onPointerMove={(e) => {
          if (drag === null) return
          const r = svg.current!.getBoundingClientRect()
          const v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))
          onChange(curve.map((c, i) => (i === drag ? v : c)))
        }}
        onPointerUp={() => setDrag(null)}
      >
        <line className="curve-diagonal" x1={0} y1={S} x2={S} y2={0} />
        <path className="curve-line" d={path} />
        {curve.map((v, i) => (
          <circle
            key={i}
            className="curve-point"
            cx={x(i)}
            cy={(1 - v) * S}
            r={4}
            data-point={i}
            onPointerDown={(e) => {
              setDrag(i)
              ;(svg.current as Element).setPointerCapture(e.pointerId)
            }}
          />
        ))}
      </svg>
      <div className="check-row">
        <button type="button" className="button small" disabled={n >= 16} onClick={() => onChange(resample(n + 1))}>
          More points
        </button>
        <button type="button" className="button small" disabled={n <= 2} onClick={() => onChange(resample(n - 1))}>
          Fewer
        </button>
        <button type="button" className="button small" onClick={() => onChange([...LINEAR])}>
          Straight
        </button>
      </div>
    </div>
  )
}

function TextureSection({ b, set, id }: { b: BrushSettings; set(p: Partial<BrushSettings>): void; id: (k: string) => string }) {
  const t = b.texture!
  const put = (patch: Partial<typeof t>) => set({ texture: { ...t, ...patch } })
  const patterns = brushAssets().list('pattern')
  return (
    <>
      <label className="field">
        <span>Pattern</span>
        <select id={id('texture-id')} value={t.id} onChange={(e) => put({ id: e.target.value })}>
          {BUILTIN_TEXTURES.map((p) => (
            <option key={p} value={p}>
              {TEXTURE_LABELS[p]}
            </option>
          ))}
          {patterns.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <Check id={id('texture-invert')} label="Invert" value={t.invert} onChange={(invert) => put({ invert })} />
      <Slider id={id('texture-scale')} label="Scale" min={1} max={1000} step={1} unit="%" value={t.scale * 100} onChange={(v) => put({ scale: Math.max(0.01, v / 100) })} />
      <Slider id={id('texture-brightness')} label="Brightness" min={-150} max={150} step={1} unit="" value={t.brightness} onChange={(brightness) => put({ brightness })} />
      <Slider id={id('texture-contrast')} label="Contrast" min={-50} max={100} step={1} unit="" value={t.contrast} onChange={(contrast) => put({ contrast })} />
      <Check id={id('texture-each')} label="Texture Each Tip" value={t.eachTip} onChange={(eachTip) => put({ eachTip })} />
      <label className="field">
        <span>Mode</span>
        <select id={id('texture-mode')} value={t.mode} onChange={(e) => put({ mode: e.target.value as never })}>
          {TEXTURE_MODES.map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      <Percent id={id('texture-depth')} label="Depth" value={t.depth} onChange={(depth) => put({ depth })} />
      {t.eachTip && (
        <>
          <Percent id={id('texture-min-depth')} label="Minimum Depth" value={t.minDepth} onChange={(minDepth) => put({ minDepth })} />
          <Percent id={id('texture-depth-jitter')} label="Depth Jitter" value={t.depthJitter} onChange={(depthJitter) => put({ depthJitter })} />
          <Control b={b} target="texture-depth" set={set} id={id('texture-depth-control')} noMin />
        </>
      )}
    </>
  )
}

/** Every tip: the round one, the built-in images, and the user's (Define Brush Preset, ABR files). */
function TipPicker({ value, onChange, id }: { value: TipId; onChange(t: TipId): void; id: string }) {
  const tips: { id: TipId; name: string }[] = [...BUILTIN_TIPS.map((t) => ({ id: t, name: t[0].toUpperCase() + t.slice(1) })), ...brushAssets().list('tip').map((a) => ({ id: a.id, name: a.name }))]
  return (
    <div className="tip-picker" role="radiogroup" aria-label="Tip" id={id}>
      {tips.map((t) => (
        <button key={t.id} type="button" role="radio" aria-checked={value === t.id} className="tip-cell" title={t.name} data-tip={t.id} onClick={() => onChange(t.id)}>
          <TipThumb tip={t.id} />
        </button>
      ))}
    </div>
  )
}

const THUMB = 36

function TipThumb({ tip }: { tip: TipId }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const img = ctx.createImageData(THUMB, THUMB)
    const ink = getComputedStyle(c).color.match(/\d+/g)?.map(Number) ?? [220, 220, 220]
    const t = tipImage(tip)
    for (let y = 0; y < THUMB; y++)
      for (let x = 0; x < THUMB; x++) {
        const ux = ((x + 0.5) / THUMB) * 2 - 1
        const uy = ((y + 0.5) / THUMB) * 2 - 1
        const v = t ? sampleTip(t, ux, uy, 2 / THUMB) : Math.hypot(ux, uy) < 0.85 ? 1 : 0
        img.data.set([ink[0], ink[1], ink[2], Math.round(v * 255)], (y * THUMB + x) * 4)
      }
    ctx.putImageData(img, 0, 0)
  }, [tip])
  return <canvas ref={ref} width={THUMB} height={THUMB} aria-hidden />
}

const PW = 248
const PH = 64

function StrokePreview({ settings }: { settings: BrushSettings }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const key = JSON.stringify(settings)
  useEffect(() => {
    // Drawn a moment after the settings settle, so a slider's drag stays smooth.
    const timer = setTimeout(() => {
      const c = ref.current
      const ctx = c?.getContext('2d')
      if (!c || !ctx) return
      const a = strokePreview(settings, PW, PH, 40)
      const img = ctx.createImageData(PW, PH)
      const ink = getComputedStyle(c).color.match(/\d+/g)?.map(Number) ?? [220, 220, 220]
      for (let i = 0; i < PW * PH; i++) img.data.set([ink[0], ink[1], ink[2], Math.round(a[i] * 255)], i * 4)
      ctx.putImageData(img, 0, 0)
    }, 60)
    return () => clearTimeout(timer)
    // The settings are the whole input.
  }, [key])
  return <canvas ref={ref} width={PW} height={PH} className="brush-preview brush-settings-preview" data-brush-preview aria-label="What the brush paints" />
}
