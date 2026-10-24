/**
 * The .pxll document file: a zip laid out as ARCHITECTURE.md describes.
 *
 *   mimetype            "application/x-plexel", first and stored, so a
 *                       file can be recognised from its first bytes, as ODF
 *                       files are
 *   document.json       the format version, the document's fields, the tree
 *   layers/<id>.tiles   one tile pack per tile set the document holds
 *   profiles/<hash>.icc each embedded ICC profile, named by its SHA-256
 *   fonts/<hash>.font   each font file the text uses that may travel with it,
 *                       named by its SHA-256
 *   thumbnail.png       the document, small (256 pixels), in sRGB, for file
 *                       browsers and the recent-files list
 *   preview.png         the same, larger (1024 pixels), so other tools can
 *                       show something without understanding layers
 *
 * Later phases add assets/. A reader
 * that finds an entry it doesn't know leaves it alone, so a file from a
 * newer build still opens as far as this one understands it (the format
 * number in document.json says when it can't).
 */
import { tileSetsOf } from '../doc/edit'
import type { Doc } from '../doc/types'
import { docToJson, readDocJson } from '../doc/serialize'
import { ZipError, ZipReader, ZipWriter, memorySink, type ZipSink } from './zip'

export const PXLL_MIME = 'application/x-plexel'
/** The mimetype files had before the app was renamed; still read. */
const OLD_MIMES = new Set(['application/x-pixlayer'])
export const PXLL_EXTENSION = '.pxll'

/** Where a document's tiles and profiles come from when it's written. */
export interface PxllSources {
  /** A tile set's pack bytes (tiles/pack.ts). */
  pack(id: string): Promise<Uint8Array>
  /** An embedded profile's bytes by hash. */
  profile(hash: string): Uint8Array | undefined
  /** The font files the document's text uses that may go with it. */
  fonts?(doc: Doc): Promise<{ hash: string; bytes: Uint8Array }[]>
  /** The document flattened, as sRGB PNGs: small for thumbnail.png, larger for preview.png. */
  previews?(): Promise<{ thumbnail: Uint8Array; preview: Uint8Array } | null>
}

const NO_SOURCES: PxllSources = {
  pack: async (id) => {
    throw new Error(`No tiles for ${id}`)
  },
  profile: () => undefined,
}

export async function writePxll(doc: Doc, sink: ZipSink, sources: PxllSources = NO_SOURCES, opts: { forceZip64?: boolean } = {}) {
  const zip = new ZipWriter(sink, opts)
  await zip.add('mimetype', new TextEncoder().encode(PXLL_MIME), { compress: false })
  await zip.add('document.json', new TextEncoder().encode(docToJson(doc)))
  // Packs are deflated tile by tile already, so they're stored.
  for (const id of new Set(tileSetsOf(doc))) await zip.add(`layers/${id}.tiles`, await sources.pack(id), { compress: false })
  if ('asset' in doc.profile) {
    const bytes = sources.profile(doc.profile.asset)
    if (bytes) await zip.add(`profiles/${doc.profile.asset}.icc`, bytes)
  }
  for (const f of (await sources.fonts?.(doc)) ?? []) await zip.add(`fonts/${f.hash}.font`, f.bytes)
  // Previews are a courtesy to other tools: a document saves without them.
  const previews = await sources.previews?.().catch(() => null)
  if (previews) {
    await zip.add('thumbnail.png', previews.thumbnail, { compress: false })
    await zip.add('preview.png', previews.preview, { compress: false })
  }
  await zip.finish()
}

/** The whole file in memory, as a Blob: for downloads, where there's no file to stream to. */
export async function pxllBlob(doc: Doc, sources?: PxllSources, opts: { forceZip64?: boolean } = {}): Promise<Blob> {
  const m = memorySink()
  await writePxll(doc, m.sink, sources, opts)
  return m.blob(PXLL_MIME)
}

export type OpenResult =
  | {
      ok: true
      doc: Doc
      warnings: string[]
      /** Pack bytes by tile-set id, for every set the document holds that the file has. */
      packs: Map<string, Uint8Array>
      /** Sets the document holds that the file doesn't have. */
      missingSets: string[]
      /** Embedded profiles, by hash. */
      profiles: Map<string, Uint8Array>
      /** Font files carried with the document, by hash. */
      fonts: Map<string, Uint8Array>
      /** thumbnail.png, for the recent list; null when the file has none. */
      thumbnail: Uint8Array | null
      /** With `lazy`, the sets left in the file instead: where each pack is. */
      ranges: Map<string, { start: number; length: number }>
    }
  | { ok: false; error: string }

/**
 * Reads a .pxll. With `lazy`, tile packs aren't read at all: their places in
 * the file come back in `ranges`, for the engine to read tiles from when
 * they're drawn. Packs are stored uncompressed, so they can be read in
 * pieces; one that isn't (written by another tool) is read whole.
 */
export async function readPxll(file: Blob, o: { lazy?: boolean } = {}): Promise<OpenResult> {
  let zip: ZipReader
  try {
    zip = await ZipReader.open(file)
  } catch (e) {
    return { ok: false, error: e instanceof ZipError ? `This isn’t a Plexel file: ${e.message}` : String(e) }
  }
  const warnings: string[] = []
  try {
    if (zip.has('mimetype')) {
      const mime = (await zip.readText('mimetype')).trim()
      if (mime !== PXLL_MIME && !OLD_MIMES.has(mime)) return { ok: false, error: `This zip file isn’t a Plexel document (it says it is “${mime}”).` }
    } else {
      warnings.push('The file had no “mimetype” entry; read it anyway')
    }
    if (!zip.has('document.json')) return { ok: false, error: 'This file has no document in it (“document.json” is missing).' }
    const read = readDocJson(await zip.readText('document.json'))
    if (!read.ok) return read
    const packs = new Map<string, Uint8Array>()
    const ranges = new Map<string, { start: number; length: number }>()
    const missingSets: string[] = []
    for (const id of new Set(tileSetsOf(read.doc))) {
      const name = `layers/${id}.tiles`
      if (!zip.has(name)) {
        missingSets.push(id)
        continue
      }
      try {
        const range = o.lazy ? await zip.range(name) : null
        if (range) {
          ranges.set(id, range)
          continue
        }
        packs.set(id, await zip.read(name))
      } catch (e) {
        missingSets.push(id)
        warnings.push(`A layer’s pixels couldn’t be read: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const profiles = new Map<string, Uint8Array>()
    for (const name of zip.entries.keys()) {
      const m = /^profiles\/([0-9a-f]{64})\.icc$/.exec(name)
      if (m) profiles.set(m[1], await zip.read(name))
    }
    const fonts = new Map<string, Uint8Array>()
    for (const name of zip.entries.keys()) {
      const m = /^fonts\/([0-9a-f]{64})\.font$/.exec(name)
      if (m) fonts.set(m[1], await zip.read(name))
    }
    // Only a picture: a file without one, or with one that can't be read, opens all the same.
    const thumbnail = zip.has('thumbnail.png') ? await zip.read('thumbnail.png').catch(() => null) : null
    return { ok: true, doc: read.doc, warnings: [...warnings, ...read.warnings], packs, missingSets, profiles, fonts, ranges, thumbnail }
  } catch (e) {
    return { ok: false, error: e instanceof ZipError ? e.message : `The file could not be read: ${String(e)}` }
  }
}
