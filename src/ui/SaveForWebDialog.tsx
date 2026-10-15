/**
 * Save for Web, as Photoshop's (Legacy) has it: the image as it will be on
 * the web, made in the formats and settings you're choosing between, side
 * by side, each with its file's size and how long it takes to download.
 *
 * Original shows the image alone; Optimized the one being set; 2-Up the
 * original beside it; 4-Up the original and three to compare, each with
 * its own settings (click one to set it). The panes pan together; the
 * size the image is made at is the same for all. Save writes the chosen
 * pane's file. The settings are remembered for next time.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { engine } from '../engine/EngineHost'
import { saveForWeb } from '../app/files'
import { formatOf, readWebOptions, sizeText, timeText, webDefaults, WEB_FORMATS, type WebFormat, type WebOptions } from '../io/webOptions'
import type { OpenDoc } from '../app/documents'
import { Dialog } from './Dialog'
import { HexColourChip } from './ColourChip'
import { SliderField } from './controls'

const KEY = 'plexel.saveForWeb.v1'
type Layout = 'original' | 'optimized' | '2up' | '4up'
const LAYOUTS: [Layout, string][] = [
  ['original', 'Original'],
  ['optimized', 'Optimized'],
  ['2up', '2-Up'],
  ['4up', '4-Up'],
]
const ZOOMS = [0.25, 0.5, 1, 2]
/** What a download time is worked out at, megabits a second. */
const MBPS = 8

interface Made {
  bytes: number
  bitmap: ImageBitmap | null
  error?: string
}

/** The settings as last left, at this document's size. */
function remembered(w: number, h: number): { layout: Layout; panes: WebOptions[]; chosen: number } {
  const d = [webDefaults('jpeg', w, h), webDefaults('png8', w, h), webDefaults('webp', w, h)]
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    const layout: Layout = LAYOUTS.some(([l]) => l === raw?.layout) ? raw.layout : '2up'
    const panes = d.map((x, i) => readWebOptions(raw?.panes?.[i], x))
    const chosen = Number.isInteger(raw?.chosen) && raw.chosen >= 0 && raw.chosen < 3 ? raw.chosen : 0
    return { layout, panes, chosen }
  } catch {
    return { layout: '2up', panes: d, chosen: 0 }
  }
}

/** One pane: the image drawn at the zoom and pan, its caption under it. */
function Pane({ made, caption, chosen, onPick, zoom, pan, onPan, label }: { made: Made | null; caption: string; chosen: boolean; onPick?: () => void; zoom: number; pan: [number, number]; onPan(dx: number, dy: number): void; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const r = c.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    c.width = Math.max(1, Math.round(r.width * dpr))
    c.height = Math.max(1, Math.round(r.height * dpr))
    const g = c.getContext('2d')
    if (!g) return
    g.setTransform(1, 0, 0, 1, 0, 0)
    // A checkerboard behind, for what's see-through.
    const s = 8 * dpr
    for (let y = 0; y < c.height; y += s) for (let x = 0; x < c.width; x += s) {
      g.fillStyle = ((x + y) / s) % 2 ? '#ccc' : '#fff'
      g.fillRect(x, y, s, s)
    }
    const b = made?.bitmap
    if (!b) return
    // The image centred, then panned (in image pixels), at the zoom in device pixels.
    const k = zoom
    const w = b.width * k
    const h = b.height * k
    g.imageSmoothingEnabled = k < 1
    g.drawImage(b, Math.round((c.width - w) / 2 - pan[0] * k), Math.round((c.height - h) / 2 - pan[1] * k), w, h)
  }, [made, zoom, pan])
  return (
    <figure className={`sfw-pane${chosen ? ' chosen' : ''}`} data-sfw-pane={label}>
      <canvas
        ref={canvas}
        className="sfw-canvas"
        onPointerDown={(e: ReactPointerEvent) => {
          onPick?.()
          drag.current = { x: e.clientX, y: e.clientY }
          ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e: ReactPointerEvent) => {
          if (!drag.current) return
          const dpr = window.devicePixelRatio || 1
          onPan(((drag.current.x - e.clientX) * dpr) / zoom, ((drag.current.y - e.clientY) * dpr) / zoom)
          drag.current = { x: e.clientX, y: e.clientY }
        }}
        onPointerUp={() => (drag.current = null)}
      />
      <figcaption data-sfw-caption>{made?.error ?? caption}</figcaption>
    </figure>
  )
}

export function SaveForWebDialog({ doc, onClose }: { doc: OpenDoc; onClose(): void }) {
  const W = doc.history.present.width
  const H = doc.history.present.height
  const start = useMemo(() => remembered(W, H), [W, H])
  const [layout, setLayout] = useState<Layout>(start.layout)
  const [panes, setPanes] = useState<WebOptions[]>(start.panes)
  const [chosen, setChosen] = useState(start.chosen)
  const [size, setSize] = useState<[number, number]>([W, H])
  const [lock, setLock] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState<[number, number]>([0, 0])
  const [made, setMade] = useState<(Made | null)[]>([null, null, null])
  const [original, setOriginal] = useState<Made | null>(null)
  const [busy, setBusy] = useState(false)
  // Which panes show: 2-Up the chosen one, 4-Up all three.
  const shown = layout === '4up' ? [0, 1, 2] : layout === 'original' ? [] : [chosen]
  const o = panes[chosen]
  const withSize = (p: WebOptions): WebOptions => ({ ...p, width: size[0], height: size[1] })
  const set = (patch: Partial<WebOptions>) => setPanes((ps) => ps.map((p, i) => (i === chosen ? { ...p, ...patch } : p)))

  // The original, at the size being made: what the optimized ones are compared with.
  useEffect(() => {
    let live = true
    const make = async () => {
      try {
        const r = await engine().call('image.optimize', { key: doc.key, o: { ...webDefaults('png24', size[0], size[1]), embedProfile: false } })
        const bitmap = await createImageBitmap(new Blob([r.bytes as BlobPart], { type: r.mime }))
        if (live) setOriginal({ bytes: r.bytes.length, bitmap })
        else bitmap.close()
      } catch (e) {
        if (live) setOriginal({ bytes: 0, bitmap: null, error: e instanceof Error ? e.message : String(e) })
      }
    }
    const t = setTimeout(() => void make(), 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [doc.key, size])

  // Each shown pane made again a moment after its settings stop changing.
  const keys = shown.map((i) => JSON.stringify(withSize(panes[i])))
  useEffect(() => {
    let live = true
    setBusy(true)
    const make = async () => {
      for (const i of shown) {
        try {
          const r = await engine().call('image.optimize', { key: doc.key, o: withSize(panes[i]) })
          const bitmap = await createImageBitmap(new Blob([r.bytes as BlobPart], { type: r.mime }))
          if (!live) {
            bitmap.close()
            return
          }
          setMade((m) => m.map((x, j) => (j === i ? { bytes: r.bytes.length, bitmap } : x)))
        } catch (e) {
          if (live) setMade((m) => m.map((x, j) => (j === i ? { bytes: 0, bitmap: null, error: e instanceof Error ? e.message : String(e) } : x)))
        }
      }
      if (live) setBusy(false)
    }
    const t = setTimeout(() => void make(), 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [doc.key, keys.join('|')])

  const remember = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ layout, panes, chosen }))
    } catch {
      // Remembered for this time only.
    }
  }
  const caption = (i: number) => {
    const m = made[i]
    const p = panes[i]
    if (!m) return `${formatOf(p.format).label} …`
    const what = p.format === 'jpeg' || (p.format === 'webp' && !p.lossless) ? `${formatOf(p.format).label} ${p.quality}%` : p.format === 'png8' ? `PNG-8, ${p.colours} colours${p.dither ? ', dithered' : ''}` : p.format === 'webp' ? 'WebP lossless' : 'PNG-24'
    return `${what} · ${sizeText(m.bytes)} · ${timeText(m.bytes, MBPS)} at ${MBPS} Mbps`
  }
  const setW = (w: number) => setSize([w, lock ? Math.max(1, Math.round((w * H) / W)) : size[1]])
  const setH = (h: number) => setSize([lock ? Math.max(1, Math.round((h * W) / H)) : size[0], h])
  const lossy = o.format === 'jpeg' || (o.format === 'webp' && !o.lossless)
  const matteHex = o.matte ? '#' + o.matte.map((v) => v.toString(16).padStart(2, '0')).join('') : '#ffffff'
  return (
    <Dialog
      id="saveForWeb"
      title="Save for Web"
      onClose={onClose}
      footer={
        <>
          <span className="sfw-busy" aria-live="polite">{busy ? 'Making…' : ''}</span>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            data-sfw-save
            onClick={() => {
              remember()
              onClose()
              void saveForWeb(withSize(o), doc.key)
            }}
          >
            Save…
          </button>
        </>
      }
    >
      <div className="sfw">
        <div className="sfw-view">
          <div className="sfw-bar">
            <div className="sfw-tabs" role="tablist" aria-label="Layout">
              {LAYOUTS.map(([l, label]) => (
                <button key={l} type="button" role="tab" aria-selected={layout === l} data-sfw-layout={l} onClick={() => setLayout(l)}>
                  {label}
                </button>
              ))}
            </div>
            <select aria-label="Zoom" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
              {ZOOMS.map((z) => (
                <option key={z} value={z}>
                  {z * 100}%
                </option>
              ))}
            </select>
          </div>
          <div className={`sfw-panes sfw-${layout}`}>
            {(layout === 'original' || layout === '2up' || layout === '4up') && <Pane label="original" made={original} caption={`Original · ${size[0]} × ${size[1]} px`} chosen={false} zoom={zoom} pan={pan} onPan={(dx, dy) => setPan(([x, y]) => [x + dx, y + dy])} />}
            {shown.map((i) => (
              <Pane key={i} label={String(i)} made={made[i]} caption={caption(i)} chosen={layout === '4up' && i === chosen} onPick={() => setChosen(i)} zoom={zoom} pan={pan} onPan={(dx, dy) => setPan(([x, y]) => [x + dx, y + dy])} />
            ))}
          </div>
        </div>
        <div className="sfw-settings form">
          <div className="field">
            <label htmlFor="sfw-format">Format</label>
            <select id="sfw-format" value={o.format} onChange={(e) => set(webDefaultsKeep(o, e.target.value as WebFormat))}>
              {WEB_FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          {o.format === 'webp' && (
            <label className="check">
              <input type="checkbox" id="sfw-lossless" checked={o.lossless} onChange={(e) => set({ lossless: e.target.checked })} />
              Lossless
            </label>
          )}
          {lossy && (
            <SliderField id="sfw-quality" label="Quality" min={1} max={100} value={o.quality} onChange={(quality) => set({ quality })} />
          )}
          {o.format === 'png8' && (
            <>
              <div className="field">
                <label htmlFor="sfw-colours">Colours</label>
                <select id="sfw-colours" value={o.colours} onChange={(e) => set({ colours: Number(e.target.value) })}>
                  {[2, 4, 8, 16, 32, 64, 128, 256].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <label className="check">
                <input type="checkbox" id="sfw-dither" checked={o.dither} onChange={(e) => set({ dither: e.target.checked })} />
                Dither
              </label>
            </>
          )}
          {o.format !== 'jpeg' && (
            <label className="check">
              <input type="checkbox" id="sfw-transparency" checked={o.transparency} onChange={(e) => set({ transparency: e.target.checked })} />
              Transparency
            </label>
          )}
          <div className="field">
            <label htmlFor="sfw-matte">Matte</label>
            <div className="field-row">
              <select id="sfw-matte-kind" aria-label="Matte" value={o.matte ? 'colour' : 'none'} onChange={(e) => set({ matte: e.target.value === 'none' ? null : (o.matte ?? [255, 255, 255]) })}>
                {o.format !== 'jpeg' && <option value="none">None</option>}
                <option value="colour">Colour</option>
              </select>
              {(o.matte || o.format === 'jpeg') && <HexColourChip id="sfw-matte" value={matteHex} label="Matte colour" onChange={(v) => set({ matte: [1, 3, 5].map((k) => parseInt(v.slice(k, k + 2), 16)) as [number, number, number] })} />}
            </div>
          </div>
          <fieldset className="sfw-size">
            <legend>Image size</legend>
            <div className="field-row">
              <label>
                W <input id="sfw-width" type="number" min={1} max={30000} value={size[0]} onChange={(e) => Number(e.target.value) > 0 && setW(Math.round(Number(e.target.value)))} />
              </label>
              <label>
                H <input id="sfw-height" type="number" min={1} max={30000} value={size[1]} onChange={(e) => Number(e.target.value) > 0 && setH(Math.round(Number(e.target.value)))} />
              </label>
            </div>
            <div className="field-row">
              <label>
                <input id="sfw-percent" type="number" min={1} max={1000} value={Math.round((size[0] / W) * 1000) / 10} onChange={(e) => Number(e.target.value) > 0 && setSize([Math.max(1, Math.round((W * Number(e.target.value)) / 100)), Math.max(1, Math.round((H * Number(e.target.value)) / 100))])} /> %
              </label>
              <label className="check">
                <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} />
                Keep proportions
              </label>
            </div>
          </fieldset>
          <label className="check">
            <input type="checkbox" id="sfw-srgb" checked={o.srgb} onChange={(e) => set({ srgb: e.target.checked })} />
            Convert to sRGB
          </label>
          <label className="check">
            <input type="checkbox" id="sfw-profile" checked={o.embedProfile} onChange={(e) => set({ embedProfile: e.target.checked })} />
            Embed colour profile
          </label>
        </div>
      </div>
    </Dialog>
  )
}

/** A pane switched to another format: that format's own defaults for what it alone has, the rest kept. */
function webDefaultsKeep(o: WebOptions, f: WebFormat): Partial<WebOptions> {
  const d = webDefaults(f, o.width, o.height)
  return { format: f, quality: d.quality, transparency: d.transparency, matte: f === 'jpeg' ? (o.matte ?? [255, 255, 255]) : d.matte }
}
