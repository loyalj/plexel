/**
 * Opening and saving files on the user's computer.
 *
 * In Chromium the File System Access API lets Save write back to the file
 * a document came from, the way a desktop editor does. Elsewhere, Open is a
 * file input and Save is a download, so every save there is a Save As.
 * Which one the browser has is decided once, by `canSaveInPlace`.
 */
import { PXLL_EXTENSION, PXLL_MIME } from './pxll'
import { IMAGE_TYPES } from './raster'

type Picker = {
  showOpenFilePicker?(o: unknown): Promise<FileSystemFileHandle[]>
  showSaveFilePicker?(o: unknown): Promise<FileSystemFileHandle>
}
const picker = () => (typeof window === 'undefined' ? {} : (window as unknown as Picker))

export const canSaveInPlace = () => typeof picker().showSaveFilePicker === 'function' && typeof picker().showOpenFilePicker === 'function'

const TYPES = [{ description: 'Plexel document', accept: { [PXLL_MIME]: [PXLL_EXTENSION] } }]
const IMAGES = { description: 'Images (PNG, JPEG, TIFF)', accept: Object.fromEntries(Object.values(IMAGE_TYPES).map((t) => [t.mime, t.extensions])) }
/** Other apps' documents Plexel opens. */
const OTHERS = { description: 'Photoshop and SVG files', accept: { 'image/vnd.adobe.photoshop': ['.psd', '.psb'], 'image/svg+xml': ['.svg'] } }
/** What Open offers: everything together, then each on its own. */
const OPEN_TYPES = [
  { description: 'Plexel documents, images, Photoshop and SVG files', accept: { [PXLL_MIME]: [PXLL_EXTENSION], ...IMAGES.accept, ...OTHERS.accept } },
  ...TYPES,
  IMAGES,
  OTHERS,
]
const acceptList = (types: { accept: Record<string, string[]> }[]) => [...new Set(types.flatMap((t) => Object.values(t.accept).flat()))].join(',')

/** The user cancelling a picker is not an error, so it comes back as null. */
const cancelled = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/** Asks for a file to open: a document or an image, or only an image when `images` is set. */
export async function pickFileToOpen(images = false): Promise<{ file: File; handle: FileSystemFileHandle | null } | null> {
  const p = picker()
  const types = images ? [IMAGES] : OPEN_TYPES
  if (p.showOpenFilePicker) {
    try {
      const [handle] = await p.showOpenFilePicker({ types, excludeAcceptAllOption: false, id: images ? 'plexel-images' : 'plexel-docs' })
      return { file: await handle.getFile(), handle }
    } catch (e) {
      if (cancelled(e)) return null
      throw e
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = acceptList(types)
    input.onchange = () => resolve(input.files?.[0] ? { file: input.files[0], handle: null } : null)
    // `cancel` fires when the picker is dismissed. Where a browser doesn't
    // send it the promise just never settles, which holds nothing open.
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

export async function pickFileToSave(suggestedName: string): Promise<FileSystemFileHandle | null> {
  const p = picker()
  if (!p.showSaveFilePicker) return null
  try {
    return await p.showSaveFilePicker({ suggestedName: withExtension(suggestedName), types: TYPES, id: 'plexel-docs' })
  } catch (e) {
    if (cancelled(e)) return null
    throw e
  }
}

/**
 * Writes the blob to the file. createWritable keeps the old file intact
 * until close, so a failed save leaves the previous version, not half of
 * the new one.
 */
export async function writeToHandle(handle: FileSystemFileHandle, blob: Blob) {
  const w = await handle.createWritable()
  try {
    await w.write(blob)
    await w.close()
  } catch (e) {
    await w.abort().catch(() => {})
    throw e
  }
}

/** Asks where to save an exported file of `type`, or null where the browser can't ask (it downloads instead). */
export async function pickExportFile(suggestedName: string, type: { description: string; mime: string; extensions: readonly string[] }): Promise<FileSystemFileHandle | null | 'cancelled'> {
  const p = picker()
  if (!p.showSaveFilePicker) return null
  try {
    return await p.showSaveFilePicker({ suggestedName, types: [{ description: type.description, accept: { [type.mime]: type.extensions } }], id: 'plexel-export' })
  } catch (e) {
    if (cancelled(e)) return 'cancelled'
    throw e
  }
}

/** Saves a .pxll by download, for browsers that can't write to a chosen file. */
export function download(blob: Blob, name: string) {
  downloadAs(blob, withExtension(name))
}

/** Downloads a blob under exactly `name`. */
export function downloadAs(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function withExtension(name: string) {
  const base = name.trim() || 'Untitled'
  return base.toLowerCase().endsWith(PXLL_EXTENSION) ? base : base + PXLL_EXTENSION
}

/** "poster.pxll" → "poster", for the document's name. */
export const withoutExtension = (name: string) => name.replace(/\.pxll$/i, '')

/** "photo.tiff" → "photo": any image extension Plexel opens. */
export const withoutImageExtension = (name: string) => name.replace(/\.(png|jpe?g|jpe|tiff?)$/i, '')

/**
 * Writes a file as a stream: `write` gets a sink and puts the bytes into it
 * in order, so a big document goes to disk as it's made instead of being
 * built in memory first. `beforeClose` runs once everything is written and
 * before the old file is replaced (createWritable writes to a copy until
 * close), which is the last moment the old file can still be read.
 */
export async function writeStreamToHandle(handle: FileSystemFileHandle, write: (sink: { write(chunk: Uint8Array): Promise<void> }) => Promise<void>, beforeClose?: () => Promise<unknown>) {
  const w = await handle.createWritable()
  try {
    await write({ write: (chunk) => w.write(chunk as Uint8Array<ArrayBuffer>) })
    await beforeClose?.()
    await w.close()
  } catch (e) {
    await w.abort().catch(() => {})
    throw e
  }
}
