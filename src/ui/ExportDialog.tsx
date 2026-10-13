/**
 * Export: the document flattened into a PNG or a JPEG. Says up front what
 * the file will hold (depth, transparency, profile), since PNG and JPEG
 * can't hold everything a document can.
 */
import { useState, type FormEvent } from 'react'
import { EXPORT_FORMATS, type ExportFormat } from '../app/files'
import { profileLabel } from '../color/profiles'
import type { Doc } from '../doc/types'
import { Dialog } from './Dialog'

const KEY = 'plexel.export.v1'

function remembered(): { format: ExportFormat; quality: number; outlines: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    const format: ExportFormat = ['jpeg', 'psd', 'psb', 'svg', 'pdf'].includes(raw?.format) ? raw.format : 'png'
    const quality = typeof raw?.quality === 'number' && raw.quality >= 0 && raw.quality <= 100 ? raw.quality : 90
    return { format, quality, outlines: raw?.outlines === true }
  } catch {
    return { format: 'png', quality: 90, outlines: false }
  }
}

/** What the exported file will be, in a sentence. */
export function exportSummary(doc: Doc, format: ExportFormat): string {
  if (format === 'svg') return 'Shapes and text as SVG, in sRGB (SVG has nothing else); layers with effects, masks or pixels as images inside it. Adjustment layers flatten what’s under them.'
  if (format === 'pdf')
    return `For print: shapes as vectors and text as outlines, in the document’s ${doc.mode === 'cmyk' ? 'CMYK' : doc.mode === 'gray' ? 'Gray' : 'RGB'} profile${doc.mode === 'cmyk' ? ' with a PDF/X-4 output intent' : ''}; spot colours as separations; layers with effects as images.`
  if (format === 'psd' || format === 'psb')
    return `Layers, groups, masks, adjustments, layer styles, shapes, text and smart objects, ${doc.depth}-bit ${doc.mode === 'cmyk' ? 'CMYK' : doc.mode === 'gray' ? 'Gray' : 'RGB'} with the document’s profile${format === 'psb' ? ', for documents past 30,000 pixels a side' : ''}.`
  if (format === 'png') {
    if (doc.mode === 'cmyk') return `${doc.depth}-bit RGB with transparency, converted from CMYK to sRGB (PNG has no CMYK).`
    return `${doc.depth}-bit ${doc.mode === 'gray' ? 'Gray' : 'RGB'} with transparency, with the document’s profile (${profileLabel(doc.profile)}).`
  }
  if (doc.mode === 'rgb') return `8-bit RGB on white (JPEG has no transparency), with the document’s profile (${profileLabel(doc.profile)}).`
  return `8-bit RGB on white, converted from ${doc.mode === 'cmyk' ? 'CMYK' : 'Gray'} to sRGB.`
}

export function ExportDialog({ doc, onClose, onExport }: { doc: Doc; onClose(): void; onExport(format: ExportFormat, quality: number, o: { textAsOutlines: boolean }): void }) {
  const [s, setS] = useState(remembered)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    try {
      localStorage.setItem(KEY, JSON.stringify(s))
    } catch {
      // Remembered for this time only.
    }
    onExport(s.format, s.quality / 100, { textAsOutlines: s.outlines })
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
        <div className="field">
          <label htmlFor="export-format">Format</label>
          <select id="export-format" value={s.format} onChange={(e) => setS({ ...s, format: e.target.value as ExportFormat })}>
            {(Object.keys(EXPORT_FORMATS) as ExportFormat[]).map((f) => (
              <option key={f} value={f}>
                {EXPORT_FORMATS[f].label}
              </option>
            ))}
          </select>
          <span className="field-note" data-export-summary>
            {exportSummary(doc, s.format)}
          </span>
        </div>
        {s.format === 'svg' && (
          <label className="check">
            <input type="checkbox" data-export-outlines checked={s.outlines} onChange={(e) => setS({ ...s, outlines: e.target.checked })} />
            Text as outlines (exact, wherever it’s opened; no longer text)
          </label>
        )}
        {s.format === 'jpeg' && (
          <div className="field">
            <label htmlFor="export-quality">Quality</label>
            <div className="slider-row">
              <input id="export-quality" type="range" min={1} max={100} value={s.quality} onChange={(e) => setS({ ...s, quality: Number(e.target.value) })} />
              <span className="slider-number">{s.quality}</span>
              <span className="unit">%</span>
            </div>
          </div>
        )}
        <p className="field-note">
          {doc.width.toLocaleString()} × {doc.height.toLocaleString()} px{s.format === 'png' || s.format === 'jpeg' ? ', every visible layer flattened' : ''}.
        </p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
