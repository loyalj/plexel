/**
 * Exports that are more than a flattened image: Photoshop (PSD, or PSB for
 * big documents), SVG and PDF. Each is put together on the page, where the
 * document and its fonts are, with the engine reading and rendering pixels.
 */
import { fillsAsShapes, tileSetsOf } from '../doc/edit'
import type { Doc, NodeId } from '../doc/types'
import type { NodeImage } from '../engine/nodeImage'
import { docToSvg } from '../io/svg/write'
import { formatHex } from '../color/models'
import { layoutOf, startFonts } from './text'
import { docToPdf } from '../io/pdf/write'
import { docToEps } from '../io/eps/write'
import { deflateZlib } from '../io/png'
import { swatchColourIn } from './docSwatches'
import { profileLabel } from '../color/profiles'
import { engine } from '../engine/EngineHost'
import { assets } from '../io/assets'
import { docToPlan } from '../io/psd/fromDoc'
import { colourEngine } from './colour'
import { colourSettings } from './colourSettings'
import { fontLibrary } from './fonts'
import { newId } from './documents'
import { hold } from './pixels'
import { expandDoc } from '../doc/expand'

export interface Exported {
  bytes: Uint8Array
  mime: string
  warnings: string[]
}

/** The document's profile as ICC bytes, embedded or built in. */
export async function profileBytes(doc: Doc): Promise<Uint8Array | null> {
  if ('asset' in doc.profile) return assets().get(doc.profile.asset) ?? null
  const { registry } = await colourEngine()
  try {
    return registry.builtin(doc.profile.builtin).bytes()
  } catch {
    return null
  }
}

/** A font's PostScript name: the font's own when it's here, otherwise made from its family and style as Adobe names them. */
export async function postscriptNames(): Promise<(family: string, style: string) => string> {
  const lib = await fontLibrary().catch(() => null)
  return (family, style) => lib?.resolve(family, style)?.postscript ?? `${family.replace(/\s+/g, '')}${style ? `-${style.replace(/\s+/g, '')}` : ''}`
}

/**
 * A document as a PSD (or PSB), its smart objects' contents nested as
 * PSBs. `key` is its scene in the engine; a smart object's contents are
 * put in a scene of their own while they're written.
 */
export async function psdOf(doc: Doc, key: string, psb = false): Promise<Exported> {
  doc = expandDoc(doc)
  const warnings: string[] = []
  const psName = await postscriptNames()
  const write = async (d: Doc, k: string, big: boolean): Promise<Uint8Array> => {
    const r = await docToPlan(d, k, {
      psName,
      icc: await profileBytes(d),
      smartObject: async (n) => {
        const c = n.props.content
        if (!c) return null
        const tmp = newId('psd')
        engine().setScene(tmp, c)
        try {
          return await write(c, tmp, true)
        } finally {
          engine().closeDoc(tmp)
        }
      },
    }, { psb: big })
    warnings.push(...r.warnings)
    return engine().call('psd.write', { plan: r.plan })
  }
  const release = hold(tileSetsOf(doc))
  try {
    const bytes = await write(doc, key, psb)
    return { bytes, mime: 'image/vnd.adobe.photoshop', warnings: [...new Set(warnings)] }
  } finally {
    release()
  }
}

/**
 * Some of a document rendered on its own, through a scene the engine holds
 * just for it: the root's children replaced by `children`, and `alone` (a
 * single layer) at full strength in Normal, as a file lays its opacity and
 * blend mode on it.
 */
export async function renderPart(doc: Doc, children: NodeId[], srgb: boolean, alone = false): Promise<NodeImage | null> {
  const root = doc.nodes[doc.root]
  const nodes = { ...doc.nodes, [doc.root]: { ...root, children } }
  if (alone && children.length === 1) {
    const n = doc.nodes[children[0]]
    nodes[n.id] = { ...n, opacity: 1, blend: 'normal', visible: true }
  }
  const tmp = newId('part')
  engine().setScene(tmp, { ...doc, nodes })
  try {
    return await engine().call('render.nodeImage', { key: tmp, node: null, srgb })
  } finally {
    engine().closeDoc(tmp)
  }
}

/** The document as SVG: vectors where SVG can hold them, images where not (io/svg/write.ts). */
export async function svgOf(doc: Doc, textAsOutlines: boolean): Promise<Exported> {
  doc = fillsAsShapes(expandDoc(doc))
  const { converter } = await colourEngine()
  await fontsFor(doc)
  const release = hold(tileSetsOf(doc))
  try {
    const r = await docToSvg(doc, {
      colour: (c) => formatHex(converter.convert({ space: doc.mode, profile: doc.profile, c }, { space: 'rgb', profile: { builtin: 'srgb' } }, 'relative', true).c),
      image: (id) => renderPart(doc, [id], true, true),
      flattened: (count) => renderPart(doc, (doc.nodes[doc.root].children ?? []).slice(0, count), true),
      layout: (n) => layoutOf(n, doc),
      textAsOutlines,
    })
    return { bytes: new TextEncoder().encode(r.svg), mime: 'image/svg+xml', warnings: r.warnings }
  } finally {
    release()
  }
}

/** Fonts loaded before text is written, so it's laid out. */
async function fontsFor(doc: Doc) {
  const hasText = (d: Doc): boolean => Object.values(d.nodes).some((n) => n.kind === 'text' || (n.kind === 'embedded' && !!n.props.content && hasText(n.props.content)))
  if (hasText(doc)) await startFonts().catch(() => null)
}

/** A document's spot channels for a PDF: each ink's name and full strength in the document's terms, and its plane over the canvas. */
async function spotPlanes(doc: Doc) {
  const spots = (doc.channels ?? []).filter((c) => c.kind === 'spot' && c.ink)
  if (!spots.length) return []
  const { converter } = await colourEngine()
  const { intent, blackPointCompensation } = colourSettings.get()
  const tmp = newId('spots')
  engine().setScene(tmp, doc)
  try {
    const out = []
    for (const c of spots) {
      const plane = await engine().call('channel.plane', { key: tmp, channel: c.id })
      out.push({ name: c.name, full: converter.convert(c.ink!, { space: doc.mode, profile: doc.profile }, intent, blackPointCompensation).c, ...plane })
    }
    return out
  } finally {
    engine().closeDoc(tmp)
  }
}

/** The document as a print PDF (io/pdf/write.ts). */
/** The document as EPS: the PDF host's pieces, written as PostScript (io/eps/write.ts). */
export async function epsOf(doc: Doc): Promise<Exported> {
  doc = fillsAsShapes(expandDoc(doc))
  await fontsFor(doc)
  const colourOf = swatchColourIn(doc)
  const release = hold(tileSetsOf(doc))
  try {
    const r = await docToEps(doc, {
      image: (id) => renderPart(doc, [id], false, true),
      flattened: (count) => renderPart(doc, (doc.nodes[doc.root].children ?? []).slice(0, count), false),
      layout: (n) => layoutOf(n, doc),
      profileName: profileLabel(doc.profile),
      spotColour: (s) => (colourOf ? colourOf(s, 1) : doc.mode === 'cmyk' ? [0, 0, 0, 1] : doc.mode === 'gray' ? [0] : [0, 0, 0]),
      spotChannels: () => spotPlanes(doc),
      deflate: deflateZlib,
      now: new Date(),
    })
    return { bytes: r.bytes, mime: 'application/postscript', warnings: r.warnings }
  } finally {
    release()
  }
}

export async function pdfOf(doc: Doc): Promise<Exported> {
  doc = fillsAsShapes(expandDoc(doc))
  const { registry } = await colourEngine()
  await fontsFor(doc)
  const colourOf = swatchColourIn(doc)
  const release = hold(tileSetsOf(doc))
  try {
    const profileName = 'asset' in doc.profile ? (() => { try { return registry.resolve(doc.profile, doc.mode).profile.description } catch { return 'Embedded profile' } })() : profileLabel(doc.profile)
    const r = await docToPdf(doc, {
      image: (id) => renderPart(doc, [id], false, true),
      flattened: (count) => renderPart(doc, (doc.nodes[doc.root].children ?? []).slice(0, count), false),
      layout: (n) => layoutOf(n, doc),
      icc: await profileBytes(doc),
      profileName,
      spotColour: (s) => (colourOf ? colourOf(s, 1) : doc.mode === 'cmyk' ? [0, 0, 0, 1] : doc.mode === 'gray' ? [0] : [0, 0, 0]),
      spotChannels: () => spotPlanes(doc),
      deflate: deflateZlib,
      now: new Date(),
    })
    return { bytes: r.bytes, mime: 'application/pdf', warnings: r.warnings }
  } finally {
    release()
  }
}

