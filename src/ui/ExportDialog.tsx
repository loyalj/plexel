/**
 * Export: the document flattened into a PNG, a JPEG or a WebP, or with its
 * layers as PSD, SVG or PDF. Says up front what the file will hold (depth,
 * transparency, profile), since none holds everything a document can. A
 * document with artboards exports the whole canvas, every artboard (each a
 * file, several in a zip) or the selected one.
 */
import { useState, type FormEvent } from 'react'
import { EXPORT_FORMATS, type ExportFormat, type ExportScope } from '../app/files'
import { profileLabel } from '../color/profiles'
import type { Doc } from '../doc/types'
import { Dialog } from './Dialog'
import { Hint, Segmented, SliderField } from './controls'
import { artboardsOf } from '../doc/artboards'

const KEY = 'plexel.export.v1'

function remembered(): { format: ExportFormat; quality: number; outlines: boolean; lossless: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    const format: ExportFormat = ['jpeg', 'webp', 'psd', 'psb', 'svg', 'pdf', 'eps'].includes(raw?.format) ? raw.format : 'png'
    const quality = typeof raw?.quality === 'number' && raw.quality >= 0 && raw.quality <= 100 ? raw.quality : 90
    return { format, quality, outlines: raw?.outlines === true, lossless: raw?.lossless === true }
  } catch {
    return { format: 'png', quality: 90, outlines: false, lossless: false }
  }
}

/** What the exported file will be, in a sentence. */
function exportSummary(doc: Doc, format: ExportFormat): string {
  if (format === 'svg') return 'Shapes and text as SVG, in sRGB (SVG has nothing else); layers with effects, masks or pixels as images inside it. Adjustment layers flatten what’s under them.'
  if (format === 'pdf')
    return `For print: shapes as vectors and text as outlines, in the document’s ${doc.mode === 'cmyk' ? 'CMYK' : doc.mode === 'gray' ? 'Gray' : 'RGB'} profile${doc.mode === 'cmyk' ? ' with a PDF/X-4 output intent' : ''}; spot colours as separations; layers with effects as images.`
  if (format === 'eps')
    return `For print tools that want EPS: ${doc.mode === 'cmyk' ? 'CMYK as ink' : doc.mode === 'gray' ? 'Gray' : 'RGB'} device colours (EPS has no profiles), spot colours as separations; shapes and text as vectors above the last layer with pixels, transparency or effects, and everything up to it as one image.`
  if (format === 'psd' || format === 'psb')
    return `Layers, groups, masks, adjustments, layer styles, shapes, text and smart objects, ${doc.depth}-bit ${doc.mode === 'cmyk' ? 'CMYK' : doc.mode === 'gray' ? 'Gray' : 'RGB'} with the document’s profile${format === 'psb' ? ', for documents past 30,000 pixels a side' : ''}.`
  if (format === 'png') {
    if (doc.mode === 'cmyk') return `${doc.depth}-bit RGB with transparency, converted from CMYK to sRGB (PNG has no CMYK).`
    return `${doc.depth}-bit ${doc.mode === 'gray' ? 'Gray' : 'RGB'} with transparency, with the document’s profile (${profileLabel(doc.profile)}).`
  }
  if (format === 'webp') {
    if (doc.mode === 'rgb') return `8-bit RGB with transparency, with the document’s profile (${profileLabel(doc.profile)}): small files for the web.`
    return `8-bit RGB with transparency, converted from ${doc.mode === 'cmyk' ? 'CMYK' : 'Gray'} to sRGB: small files for the web.`
  }
  if (doc.mode === 'rgb') return `8-bit RGB on white (JPEG has no transparency), with the document’s profile (${profileLabel(doc.profile)}).`
  return `8-bit RGB on white, converted from ${doc.mode === 'cmyk' ? 'CMYK' : 'Gray'} to sRGB.`
}

export function ExportDialog({ doc, selectedArtboard, onClose, onExport }: { doc: Doc; selectedArtboard: string | null; onClose(): void; onExport(format: ExportFormat, quality: number, o: { textAsOutlines: boolean; lossless: boolean; scope: ExportScope }): void }) {
  const [s, setS] = useState(remembered)
  const boards = artboardsOf(doc)
  const [scope, setScope] = useState<ExportScope>(boards.length ? (selectedArtboard ? 'artboard' : 'artboards') : 'canvas')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    try {
      localStorage.setItem(KEY, JSON.stringify(s))
    } catch {
      // Remembered for this time only.
    }
    onExport(s.format, s.quality / 100, { textAsOutlines: s.outlines, lossless: s.lossless, scope: boards.length ? scope : 'canvas' })
  }
  return (
    <Dialog
      id="export"
      title="Export"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="export-form" className="button primary">
            Export…
          </button>
        </>
      }
    >
      <form id="export-form" className="form" onSubmit={submit}>
        {boards.length > 0 && (
          <Segmented<ExportScope>
            id="export-scope"
            label="Export"
            value={scope}
            options={[
              ['artboards', boards.length === 1 ? 'The artboard' : `All ${boards.length} artboards`, 'Each artboard as a file of its own, cropped to it; several go in a zip'],
              ...(selectedArtboard ? [['artboard' as ExportScope, 'Selected', `Just “${selectedArtboard}”`] as const] : []),
              ['canvas' as ExportScope, 'Whole canvas', 'Everything, pasteboard and all, as one file'],
            ]}
            onChange={setScope}
          />
        )}
        <div className="field">
          <label htmlFor="export-format">Format</label>
          <select id="export-format" value={s.format} onChange={(e) => setS({ ...s, format: e.target.value as ExportFormat })}>
            {(Object.keys(EXPORT_FORMATS) as ExportFormat[]).map((f) => (
              <option key={f} value={f}>
                {EXPORT_FORMATS[f].label}
              </option>
            ))}
          </select>
          <span className="field-meta" data-export-summary>
            {exportSummary(doc, s.format)}
          </span>
        </div>
        {s.format === 'svg' && (
          <label className="check">
            <input type="checkbox" data-export-outlines checked={s.outlines} onChange={(e) => setS({ ...s, outlines: e.target.checked })} />
            Text as outlines
            <Hint text="Exact wherever it’s opened, but no longer text" />
          </label>
        )}
        {s.format === 'webp' && (
          <label className="check">
            <input type="checkbox" data-export-lossless checked={s.lossless} onChange={(e) => setS({ ...s, lossless: e.target.checked })} />
            Lossless
            <Hint text="Every pixel exactly as it is; bigger files than lossy, smaller than PNG" />
          </label>
        )}
        {(s.format === 'jpeg' || (s.format === 'webp' && !s.lossless)) && (
          <SliderField id="export-quality" label="Quality" min={1} max={100} unit="%" value={s.quality} onChange={(quality) => setS({ ...s, quality })} />
        )}
        <p className="field-meta">
          {doc.width.toLocaleString()} × {doc.height.toLocaleString()} px{s.format === 'png' || s.format === 'jpeg' || s.format === 'webp' ? ', every visible layer flattened' : ''}.
        </p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
