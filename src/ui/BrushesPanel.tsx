/**
 * The Brushes panel: every preset with a stroke drawn by it, built-in ones
 * first, then the user's own, grouped as they came (saved here, Defined,
 * or by the ABR file they were imported from). Click one to give it to the
 * painting tool in use (the Brush when another tool is chosen). "Save"
 * keeps the current brush as a preset of the user's own; "Import" reads
 * Photoshop's brush files.
 *
 * The previews are drawn on the CPU by the same code the GPU is checked
 * against (brush/preview.ts), so a preview is what the brush paints. Each is
 * drawn when it scrolls into view: an imported set can hold hundreds.
 */
import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { brushAssets } from '../app/brushAssets'
import { pickBrushFiles } from '../app/brushImport'
import { brushes, type PaintTool, type UserPreset } from '../app/brushes'
import { BRUSH_PRESETS, presetSettings, type BrushSettings } from '../brush/defs'
import { strokePreview } from '../brush/preview'
import { tools, TOOL_BY_ID } from '../tools'
import { Icon } from './Icon'

const W = 168
const H = 40

function Preview({ settings }: { settings: BrushSettings }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const key = JSON.stringify(settings)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true))
    io.observe(c)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    const c = ref.current
    // On the CPU: a GPU canvas is a composited layer of its own, and a long list of presets would be as many (see LayersPanel's thumbnails).
    const ctx = c?.getContext('2d', { willReadFrequently: true })
    if (!c || !ctx) return
    const a = strokePreview(settings, W, H)
    const img = ctx.createImageData(W, H)
    // Drawn in the panel's own ink colour, so it reads in every theme.
    const ink = getComputedStyle(c).color.match(/\d+/g)?.map(Number) ?? [220, 220, 220]
    for (let i = 0; i < W * H; i++) img.data.set([ink[0], ink[1], ink[2], Math.round(a[i] * 255)], i * 4)
    ctx.putImageData(img, 0, 0)
    // The settings are the whole input.
  }, [key, visible])
  return <canvas ref={ref} width={W} height={H} className="brush-preview" aria-hidden />
}

export const BrushesPanel = memo(function BrushesPanel() {
  const state = useSyncExternalStore(brushes().subscribe, brushes().get)
  const toolId = useSyncExternalStore(tools().subscribe, tools().get)
  // Image tips arriving from storage redraw the previews that use them.
  useSyncExternalStore(brushAssets().subscribe, () => brushAssets().list('tip').length)
  const def = TOOL_BY_ID.get(toolId)
  const tool: PaintTool = def?.paints ?? 'brush'
  const [naming, setNaming] = useState<string | null>(null)
  const current = state.preset[tool]
  const groups = new Map<string, UserPreset[]>()
  for (const p of state.user) groups.set(p.group ?? '', [...(groups.get(p.group ?? '') ?? []), p])
  const item = (p: { id: string; name: string; settings: BrushSettings }, user: boolean) => (
    <li key={p.id}>
      <button type="button" className="brush-item" aria-pressed={current === p.id} data-preset={p.id} onClick={() => brushes().choose(tool, p.id)}>
        <span className="brush-name">{p.name}</span>
        <Preview settings={p.settings} />
      </button>
      {user && (
        <button type="button" className="brush-remove" aria-label={`Remove ${p.name}`} onClick={() => brushes().remove(p.id)}>
          <Icon name="ui.close" />
        </button>
      )}
    </li>
  )
  return (
    <div className="brushes-panel">
      <ul className="brush-list" aria-label={`Brushes for the ${def?.paints ? def.name : 'Brush'}`}>
        {BRUSH_PRESETS.map((p) => item({ id: p.id, name: p.name, settings: presetSettings(p) }, false))}
        {[...groups].map(([group, list]) => (
          <li key={`group-${group}`}>
            <div className="brush-group" data-brush-group={group}>
              {group || 'Saved'}
              {group && (
                <button type="button" className="brush-remove" aria-label={`Remove the ${group} brushes`} onClick={() => brushes().removeGroup(group)}>
                  <Icon name="ui.close" />
                </button>
              )}
            </div>
            <ul className="brush-list nested">{list.map((p) => item(p, true))}</ul>
          </li>
        ))}
      </ul>
      <div className="panel-tools">
        {naming === null ? (
          <>
            <button type="button" className="button small" onClick={() => setNaming('My Brush')}>
              Save Current Brush
            </button>
            <button type="button" className="button small" data-import-brushes onClick={() => void pickBrushFiles()}>
              Import…
            </button>
          </>
        ) : (
          <form
            className="brush-save"
            onSubmit={(e) => {
              e.preventDefault()
              brushes().save(tool, naming)
              setNaming(null)
            }}
          >
            <input id="brush-save-name" aria-label="Preset name" value={naming} autoFocus onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} />
            <button type="submit" className="button small primary">
              Save
            </button>
          </form>
        )}
      </div>
    </div>
  )
})
