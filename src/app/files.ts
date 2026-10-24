/**
 * New, Open, Save, Save As, Close, Import as Layer and Export: the file
 * commands, between the document store and the user's disk.
 *
 * Save writes back to the document's own file when the browser can (File
 * System Access, in Chromium), and asks for permission first when it has to,
 * which needs the click or key press that started the save. Otherwise it
 * downloads. A file that's already open is brought to the front rather
 * than opened twice.
 *
 * Saving to a file streams: the zip goes to disk as it's made, one layer's
 * tiles at a time. Opening a big file reads only the document and each
 * layer's tile index; tiles are read from the file when they're first drawn.
 */
import { isPsd, isSvg } from '../io/sniff'
// PSD, SVG and PDF are read and written by modules loaded when they're first
// needed (import() where they're used), not with the app: they're a large
// part of it that most visits never touch.
import { addDocumentFonts } from './fonts'
import { fontsToCarry } from './fontEmbed'
import { DEFAULT_PROFILES, createDoc, dropLostSets, insertNode, tileSetsOf, type NewDocOptions } from '../doc/edit'
import { makeNode } from '../doc/nodes'
import { freshName, placeOf } from '../doc/tree'
import type { Doc } from '../doc/types'
import { engine } from '../engine/EngineHost'
import { assets } from '../io/assets'
import { readPxll, pxllBlob, writePxll, type PxllSources } from '../io/pxll'
import {
  canSaveInPlace,
  download,
  downloadAs,
  pickExportFile,
  pickFileToOpen,
  pickFileToSave,
  withExtension,
  withoutExtension,
  withoutImageExtension,
  writeStreamToHandle,
  writeToHandle,
} from '../io/files'
import { loadHandle, requestRead, requestWrite, storeHandle, touchRecent, forgetRecent } from '../io/handles'
import { isImageName, sniff } from '../io/raster'
import { colours } from './colours'
import { colourSettings } from './colourSettings'
import { documents, isDirty, newId } from './documents'
import { notify } from './notices'
import { fillSet, hold, paper } from './pixels'
import { saveToParent } from './effects'
import { formatOf, type WebOptions } from '../io/webOptions'
import { addArtboard, fitCanvasToArtboards, makeArtboard, whiteIn } from '../doc/artboards'
import type { ParamColour } from '../doc/params'
import { colourEngineNow } from './colour'
import { artboardDocs, selectedArtboard } from './artboards'
import { ZipWriter, memorySink } from '../io/zip'
import { builtinsFor } from '../color/profiles'
import { toPixels } from '../doc/units'
import type { Preset } from '../doc/presets'

/** What a new document starts with, as Photoshop offers it. */
export type Background = 'white' | 'black' | 'background' | 'transparent'

/** Files bigger than this open with their tiles left in the file until drawn. */
const LAZY_BYTES = 64 * 1024 * 1024
/** The threshold in use: check-canvas lowers it to exercise reading on demand with small files. */
const lazyBytes = () => (globalThis as { plexelLazyBytes?: number }).plexelLazyBytes ?? LAZY_BYTES

/**
 * A new document. Unless it's transparent it starts with a Background
 * pixel layer filled with the chosen colour, converted to the document's
 * own space.
 */
export async function newDocument(o: NewDocOptions, background: Background = 'white', artboard = false) {
  let doc = createDoc(o, newId('n'))
  if (artboard) {
    // An artboard the size asked for, its background the one chosen, an empty layer on it; the canvas round it is the pasteboard.
    const id = newId('ab')
    const black: ParamColour = doc.mode === 'cmyk' ? [0, 0, 0, 1] : doc.mode === 'gray' ? [0] : [0, 0, 0]
    const conv = colourEngineNow()?.converter
    const bg: ParamColour | null =
      background === 'transparent'
        ? null
        : background === 'white'
          ? whiteIn(doc.mode)
          : background === 'black'
            ? black
            : conv
              ? (conv.convert(colours().get().bg, { space: doc.mode, profile: doc.profile }, colourSettings.get().intent, colourSettings.get().blackPointCompensation).c as ParamColour)
              : whiteIn(doc.mode)
    const a = makeArtboard(id, 'Artboard 1', 0, 0, doc.width, doc.height, doc.mode)
    a.props.artboard.background = bg
    doc = addArtboard(doc, a)
    doc = insertNode(doc, makeNode('pixel', newId('n'), 'Layer 1'), id, 0)
    doc = fitCanvasToArtboards(doc)
    return documents().add({ doc, file: null, saved: false, label: 'New Document' })
  }
  if (background !== 'transparent') {
    const colour = background === 'background' ? colours().get().bg : paper(doc, background)
    const { id } = await fillSet(doc, colour)
    doc = insertNode(doc, makeNode('pixel', newId('n'), 'Background', { tiles: id }), doc.root, 0)
  }
  return documents().add({ doc, file: null, saved: false, label: 'New Document' })
}

/**
 * A new document from a preset, as the start screen's cards make one: what
 * the New Document dialog would make with the preset chosen and nothing
 * else changed.
 */
export function newFromPreset(p: Preset) {
  const width = toPixels(p.width, p.unit, p.resolution)
  const height = toPixels(p.height, p.unit, p.resolution)
  return newDocument({ name: 'Untitled', width, height, resolution: p.resolution, mode: p.mode, depth: p.depth, profile: { builtin: builtinsFor(p.mode)[0].id } })
}

/**
 * The engine and the asset store, as a .pxll writer wants them, for the
 * document `key`. The thumbnail made for the file is left in `made`, for
 * the recent list.
 */
const sourcesFor = (key: string | null, made?: { thumbnail?: Uint8Array }): PxllSources => ({
  pack: (id) => engine().call('tiles.pack', { id }),
  profile: (hash) => assets().get(hash),
  fonts: (doc) => fontsToCarry(doc),
  previews: key
    ? async () => {
        const [thumbnail, preview] = await Promise.all([engine().call('render.preview', { key, size: 256 }), engine().call('render.preview', { key, size: 1024 })])
        if (!thumbnail || !preview) return null
        if (made) made.thumbnail = thumbnail
        return { thumbnail, preview }
      }
    : undefined,
})

/** Writes a document while holding its tiles, so nothing collects them mid-save. */
async function blobOf(doc: Doc, key: string | null): Promise<Blob> {
  const release = hold(tileSetsOf(doc))
  try {
    return await pxllBlob(doc, sourcesFor(key))
  } finally {
    release()
  }
}

/**
 * Files whose tiles are still being read on demand, by the key the engine
 * knows them by. Before anything is written over one of them, its tiles are
 * read in full: once the file is replaced, the old bytes are gone.
 */
const lazyFiles = new Map<string, FileSystemFileHandle>()

async function releaseLazy(target: FileSystemFileHandle) {
  for (const [source, h] of lazyFiles) {
    if (await h.isSameEntry(target).catch(() => false)) {
      await engine().call('tiles.materialize', { source })
      lazyFiles.delete(source)
    }
  }
}

/** Streams a document into a file, holding its tiles meanwhile; resolves to the thumbnail written with it, if one was. */
async function streamTo(handle: FileSystemFileHandle, doc: Doc, key: string): Promise<Uint8Array | null> {
  const release = hold(tileSetsOf(doc))
  const made: { thumbnail?: Uint8Array } = {}
  try {
    await writeStreamToHandle(handle, (sink) => writePxll(doc, sink, sourcesFor(key, made)), () => releaseLazy(handle))
    return made.thumbnail ?? null
  } finally {
    release()
  }
}

/** Is this file already open? Compared by handle, since two files can share a name. */
async function alreadyOpen(handle: FileSystemFileHandle): Promise<string | null> {
  for (const d of documents().getState().docs) {
    if (!d.file?.handleKey) continue
    const h = await loadHandle(d.file.handleKey)
    if (h && (await h.isSameEntry(handle).catch(() => false))) return d.key
  }
  return null
}

/** Opens a .pxll, or an image as a new document. */
export async function openFile(file: File, handle: FileSystemFileHandle | null): Promise<boolean> {
  if (handle) {
    const open = await alreadyOpen(handle)
    if (open) {
      documents().activate(open)
      return true
    }
  }
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer())
  if (isPsd(head)) return (await import('./psd')).openPsd(file)
  if (isSvg(head, file.name)) return (await import('./svg')).openSvg(file)
  if (sniff(head, file.name) || (isImageName(file.name) && !file.name.toLowerCase().endsWith('.pxll'))) return openImage(file)

  const lazy = file.size > lazyBytes()
  const read = await readPxll(file, { lazy })
  if (!read.ok) {
    notify('error', `“${file.name}” couldn’t be opened.`, [read.error])
    return false
  }
  const warnings = [...read.warnings]
  let doc = read.doc
  for (const [hash, bytes] of read.profiles) {
    if (!(await assets().putAs(hash, bytes))) warnings.push('An embedded profile didn’t match its name, so it wasn’t used')
  }
  // The document's own fonts, before its text is laid out.
  if (read.fonts.size) await addDocumentFonts(read.fonts)
  // A layer whose pixels can't be had opens empty rather than keeping the
  // document from opening at all.
  const lost = new Set(read.missingSets)
  for (const [id, bytes] of read.packs) {
    try {
      await engine().call('tiles.unpack', { id, bytes })
    } catch (e) {
      lost.add(id)
      warnings.push(`A layer’s pixels couldn’t be read: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const source = newId('f')
  for (const [id, range] of read.ranges) {
    try {
      await engine().call('tiles.unpackLazy', { id, source, file, ...range })
    } catch (e) {
      lost.add(id)
      warnings.push(`A layer’s pixels couldn’t be read: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (read.ranges.size && handle) lazyFiles.set(source, handle)
  if (lost.size) {
    doc = dropLostSets(doc, lost)
    warnings.push(`${lost.size === 1 ? 'A layer' : `${lost.size} layers`} lost ${lost.size === 1 ? 'its' : 'their'} pixels and opened empty`)
  }
  const handleKey = handle ? await storeHandle(handle) : null
  if (handleKey) await touchRecent(handleKey, file.name, read.thumbnail)
  documents().add({ doc, file: { handleKey, name: file.name }, saved: !lost.size })
  if (warnings.length) notify('warning', `“${file.name}” was repaired as it opened.`, warnings)
  return true
}

/** The bytes of a file, for decoding. */
const bytesOf = async (file: File) => new Uint8Array(await file.arrayBuffer())

/**
 * An image as a new document: its own size, mode and depth, its profile
 * (or the mode's default when it has none), and one Background layer.
 * It isn't tied to the image file: saving makes a .pxll.
 */
export async function openImage(file: File): Promise<boolean> {
  try {
    const r = await engine().call('image.import', { bytes: await bytesOf(file), name: file.name, into: null })
    const release = hold([r.set])
    try {
      const profile = r.icc ? { asset: await assets().put(r.icc) } : DEFAULT_PROFILES[r.mode]
      let doc = createDoc({ name: withoutImageExtension(file.name), width: r.width, height: r.height, resolution: 72, mode: r.mode, depth: r.depth, profile }, newId('n'))
      doc = insertNode(doc, makeNode('pixel', newId('n'), 'Background', { tiles: r.set }), doc.root, 0)
      documents().add({ doc, file: null, saved: false, label: 'Open Image' })
    } finally {
      release()
    }
    if (r.warnings.length) notify('warning', `“${file.name}” opened, with a few things to know.`, r.warnings)
    return true
  } catch (e) {
    notify('error', `“${file.name}” couldn’t be opened.`, [e instanceof Error ? e.message : String(e)])
    return false
  }
}

/**
 * An image as a new layer in the front document, above the selected layer,
 * centred, converted into the document's mode, depth and profile with the
 * intent in Colour Settings. One undoable step.
 */
export async function placeImage(file: File, at?: { x: number; y: number }): Promise<boolean> {
  const d = documents().active()
  if (!d) return openImage(file)
  const doc = d.history.present
  const { intent, blackPointCompensation } = colourSettings.get()
  try {
    const r = await engine().call('image.import', { bytes: await bytesOf(file), name: file.name, into: { mode: doc.mode, depth: doc.depth, profile: doc.profile, intent, blackPointCompensation } })
    const release = hold([r.set])
    try {
      const now = documents().get(d.key)!
      const docNow = now.history.present
      const place = now.selected ? placeOf(docNow, now.selected) : null
      const parent = place?.slot === 'children' ? place.parent : docNow.root
      const index = place?.slot === 'children' ? place.index + 1 : (docNow.nodes[docNow.root].children?.length ?? 0)
      const id = newId('n')
      // The file's own name, unless a layer already has it.
      const base = withoutImageExtension(file.name) || 'Image'
      const taken = Object.values(docNow.nodes).some((n) => n.name === base)
      const node = makeNode('pixel', id, taken ? freshName(docNow, base) : base, { tiles: r.set })
      const cx = at ? at.x - r.width / 2 : (docNow.width - r.width) / 2
      const cy = at ? at.y - r.height / 2 : (docNow.height - r.height) / 2
      node.transform = [1, 0, 0, 1, Math.round(cx), Math.round(cy)]
      documents().commit((x) => insertNode(x, node, parent, index), { key: d.key, label: 'Import as Layer' })
      documents().select(id, d.key)
    } finally {
      release()
    }
    if (r.warnings.length) notify('warning', `“${file.name}” was imported, with a few things to know.`, r.warnings)
    return true
  } catch (e) {
    notify('error', `“${file.name}” couldn’t be imported.`, [e instanceof Error ? e.message : String(e)])
    return false
  }
}

export async function openDialog() {
  try {
    const picked = await pickFileToOpen()
    if (picked) await openFile(picked.file, picked.handle)
  } catch (e) {
    notify('error', 'The file couldn’t be opened.', [String(e)])
  }
}

export async function placeDialog() {
  try {
    const picked = await pickFileToOpen(true)
    if (picked) await placeImage(picked.file)
  } catch (e) {
    notify('error', 'The image couldn’t be imported.', [String(e)])
  }
}

export async function openRecent(handleKey: string, name: string) {
  const handle = await loadHandle(handleKey)
  if (!handle) {
    await forgetRecent(handleKey)
    notify('error', `“${name}” is no longer available.`)
    return
  }
  try {
    if (!(await requestRead(handle))) return
    await openFile(await handle.getFile(), handle)
  } catch {
    await forgetRecent(handleKey)
    notify('error', `“${name}” couldn’t be found. It may have been moved or deleted.`)
  }
}

/** Save: to the document's own file if it has one this browser can write to, otherwise Save As. */
export async function save(key = documents().getState().active): Promise<boolean> {
  const d = key ? documents().get(key) : null
  if (!d) return false
  // A smart object's contents save into the document holding it.
  if (d.parent) return saveToParent(d.key)
  if (!d.file?.handleKey || !canSaveInPlace()) return saveAs(key!)
  const handle = await loadHandle(d.file.handleKey)
  if (!handle) return saveAs(key!)
  const doc = d.history.present
  try {
    if (!(await requestWrite(handle))) {
      notify('warning', `Plexel wasn’t allowed to write to “${d.file.name}”, so nothing was saved.`)
      return false
    }
    const thumbnail = await streamTo(handle, doc, d.key)
    documents().markSaved(d.key, doc, d.file)
    await touchRecent(d.file.handleKey, d.file.name, thumbnail)
    notify('info', `Saved “${d.file.name}”.`)
    return true
  } catch (e) {
    notify('error', `“${d.file.name}” couldn’t be saved.`, [e instanceof Error ? e.message : String(e)])
    return false
  }
}

export async function saveAs(key = documents().getState().active): Promise<boolean> {
  const d = key ? documents().get(key) : null
  if (!d) return false
  const doc = d.history.present
  const suggested = withExtension(d.file ? withoutExtension(d.file.name) : doc.name)
  try {
    if (!canSaveInPlace()) {
      download(await blobOf(doc, d.key), suggested)
      documents().markSaved(d.key, doc, { handleKey: null, name: suggested })
      notify('info', `Downloaded “${suggested}”.`)
      return true
    }
    const handle = await pickFileToSave(suggested)
    if (!handle) return false
    const thumbnail = await streamTo(handle, doc, d.key)
    const handleKey = await storeHandle(handle)
    if (handleKey) await touchRecent(handleKey, handle.name, thumbnail)
    documents().markSaved(d.key, doc, { handleKey, name: handle.name })
    notify('info', `Saved “${handle.name}”.`)
    return true
  } catch (e) {
    notify('error', `“${suggested}” couldn’t be saved.`, [e instanceof Error ? e.message : String(e)])
    return false
  }
}

export const EXPORT_FORMATS = {
  png: { label: 'PNG', description: 'PNG image', mime: 'image/png', extensions: ['.png'] },
  jpeg: { label: 'JPEG', description: 'JPEG image', mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'] },
  webp: { label: 'WebP', description: 'WebP image', mime: 'image/webp', extensions: ['.webp'] },
  psd: { label: 'Photoshop (PSD)', description: 'Photoshop document', mime: 'image/vnd.adobe.photoshop', extensions: ['.psd'] },
  psb: { label: 'Photoshop Large Document (PSB)', description: 'Photoshop large document', mime: 'image/vnd.adobe.photoshop', extensions: ['.psb'] },
  svg: { label: 'SVG', description: 'SVG image', mime: 'image/svg+xml', extensions: ['.svg'] },
  pdf: { label: 'PDF', description: 'PDF document', mime: 'application/pdf', extensions: ['.pdf'] },
  eps: { label: 'EPS', description: 'Encapsulated PostScript', mime: 'application/postscript', extensions: ['.eps'] },
} as const
export type ExportFormat = keyof typeof EXPORT_FORMATS

/**
 * Export: the document flattened into a PNG, JPEG or WebP, with its profile
 * embedded, or with its layers as a Photoshop document, an SVG or a PDF
 * (app/exports.ts).
 * Asks where to save where the browser can, otherwise downloads.
 */
export async function exportDoc(format: ExportFormat, quality: number, key = documents().getState().active, o: { textAsOutlines?: boolean; lossless?: boolean; scope?: ExportScope } = {}): Promise<boolean> {
  const d = key ? documents().get(key) : null
  if (!d) return false
  const doc = d.history.present
  const t = EXPORT_FORMATS[format]
  const base = d.file ? withoutExtension(d.file.name) : doc.name
  // Each artboard (or the selected one) as a file of its own: the document cropped to it.
  const boards = o.scope && o.scope !== 'canvas' ? artboardDocs(d, o.scope === 'artboard' ? (selectedArtboard(d) ?? undefined) : undefined) : null
  if (boards && !boards.length) {
    notify('info', o.scope === 'artboard' ? 'Select an artboard, or a layer on one, to export it.' : 'The document has no artboards.')
    return false
  }
  const many = !!boards && boards.length > 1
  const safe = (n: string) => n.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Artboard'
  const name = many ? `${base} artboards.zip` : boards ? `${base} - ${safe(boards[0].name)}${t.extensions[0]}` : `${base}${t.extensions[0]}`
  try {
    const handle = await pickExportFile(name, many ? { description: 'Zip of the artboards', mime: 'application/zip', extensions: ['.zip'] } : t)
    if (handle === 'cancelled') return false
    const release = hold(tileSetsOf(doc))
    let blob: Blob
    const warnings: string[] = []
    try {
      if (!boards) {
        const r = await exportBytes(doc, d.key, format, quality, o)
        warnings.push(...r.warnings)
        blob = new Blob([r.bytes as BlobPart], { type: r.mime })
      } else {
        const files: { name: string; bytes: Uint8Array; mime: string }[] = []
        for (const one of boards) {
          // Each artboard in a scene of its own while it's written.
          const tmp = newId('artboard')
          engine().setScene(tmp, one.doc)
          try {
            const r = await exportBytes(one.doc, tmp, format, quality, o)
            warnings.push(...r.warnings)
            files.push({ name: `${safe(one.name)}${t.extensions[0]}`, bytes: r.bytes, mime: r.mime })
          } finally {
            engine().closeDoc(tmp)
          }
        }
        if (files.length === 1) blob = new Blob([files[0].bytes as BlobPart], { type: files[0].mime })
        else {
          const { sink, blob: zipped } = memorySink()
          const zip = new ZipWriter(sink)
          const used = new Set<string>()
          for (const f of files) {
            let n = f.name
            for (let i = 2; used.has(n); i++) n = f.name.replace(/(\.[^.]+)$/, ` ${i}$1`)
            used.add(n)
            await zip.add(n, f.bytes, { compress: !['image/png', 'image/jpeg', 'image/webp'].includes(f.mime) })
          }
          await zip.finish()
          blob = zipped()
        }
      }
    } finally {
      release()
    }
    if (handle) await writeToHandle(handle, blob)
    else downloadAs(blob, name)
    const unique = [...new Set(warnings)]
    notify(unique.length ? 'warning' : 'info', many ? `Exported ${boards!.length} artboards to “${handle ? handle.name : name}”.` : `Exported “${handle ? handle.name : name}”.`, unique)
    return true
  } catch (e) {
    notify('error', `“${name}” couldn’t be exported.`, [e instanceof Error ? e.message : String(e)])
    return false
  }
}

/** What to export: the whole canvas, every artboard (each a file), or the selected artboard. */
export type ExportScope = 'canvas' | 'artboards' | 'artboard'

/** A document's bytes in a format, from the scene `key` holds it in. */
async function exportBytes(doc: Doc, key: string, format: ExportFormat, quality: number, o: { textAsOutlines?: boolean; lossless?: boolean }): Promise<{ bytes: Uint8Array; mime: string; warnings: string[] }> {
  const exporters = format === 'psd' || format === 'psb' || format === 'svg' || format === 'pdf' || format === 'eps' ? await import('./exports') : null
  if (format === 'psd' || format === 'psb') return exporters!.psdOf(doc, key, format === 'psb')
  if (format === 'svg') return exporters!.svgOf(doc, !!o.textAsOutlines)
  if (format === 'pdf') return exporters!.pdfOf(doc)
  if (format === 'eps') return exporters!.epsOf(doc)
  return engine().call('image.export', { key, format, quality, lossless: !!o.lossless })
}

/**
 * Save for Web's Save: the file its chosen settings make (engine
 * `image.optimize`), named after the document, where the browser lets you
 * choose, otherwise downloaded.
 */
export async function saveForWeb(o: WebOptions, key = documents().getState().active): Promise<boolean> {
  const d = key ? documents().get(key) : null
  if (!d) return false
  const f = formatOf(o.format)
  const name = `${d.file ? withoutExtension(d.file.name) : d.history.present.name}${f.ext}`
  try {
    const handle = await pickExportFile(name, { description: `${f.label} image`, mime: f.mime, extensions: [f.ext] })
    if (handle === 'cancelled') return false
    const release = hold(tileSetsOf(d.history.present))
    let r: { bytes: Uint8Array; mime: string; warnings: string[] }
    try {
      r = await engine().call('image.optimize', { key: d.key, o })
    } finally {
      release()
    }
    const blob = new Blob([r.bytes as BlobPart], { type: r.mime })
    if (handle) await writeToHandle(handle, blob)
    else downloadAs(blob, name)
    notify(r.warnings.length ? 'warning' : 'info', `Saved “${handle ? handle.name : name}” for the web.`, r.warnings)
    return true
  } catch (e) {
    notify('error', `“${name}” couldn’t be saved.`, [e instanceof Error ? e.message : String(e)])
    return false
  }
}

/** Closes a document if it has nothing unsaved; otherwise says so, and the caller asks. */
export function closeIfClean(key: string): 'closed' | 'dirty' {
  const d = documents().get(key)
  if (!d) return 'closed'
  if (isDirty(d)) return 'dirty'
  documents().remove(key)
  return 'closed'
}
