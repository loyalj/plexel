/**
 * SVG files opened as documents (io/svg/read.ts), on the page: colour
 * names are the browser's to know, and embedded images are decoded by the
 * engine into pixel layers sized as the SVG says.
 */
import type { Affine, Doc, DocNode } from '../doc/types'
import { engine } from '../engine/EngineHost'
import { svgToDoc } from '../io/svg/read'
import { documents, newId } from './documents'
import { notify } from './notices'


let ctx: CanvasRenderingContext2D | null = null

/** A CSS colour name as RGB, asking the browser (which knows all 148 and the system colours). */
function namedColour(name: string): [number, number, number] | null {
  ctx ??= document.createElement('canvas').getContext('2d')
  if (!ctx) return null
  // Two different starting colours: a name the browser doesn't know leaves each as it was.
  ctx.fillStyle = '#010203'
  ctx.fillStyle = name
  const a = ctx.fillStyle
  ctx.fillStyle = '#040506'
  ctx.fillStyle = name
  if (a !== ctx.fillStyle) return null
  const m = /^#([0-9a-f]{6})$/i.exec(a)
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255) as [number, number, number]
  const r = /rgba?\(([^)]*)\)/.exec(a)
  return r ? (r[1].split(',').slice(0, 3).map((v) => Number(v) / 255) as [number, number, number]) : null
}

/** SVG markup read as a document, its embedded images decoded into pixel layers; with what couldn't come over. */
export async function readSvg(text: string, name: string): Promise<{ doc: Doc; warnings: string[] }> {
  const r = svgToDoc(text, name, { newId, namedColour })
  const nodes = { ...r.doc.nodes }
  const warnings = [...r.warnings]
  for (const img of r.images) {
    try {
      const got = await engine().call('image.import', { bytes: img.bytes, name: 'image', into: { mode: 'rgb', depth: 8, profile: { builtin: 'srgb' }, intent: 'relative', blackPointCompensation: true } })
      const n = nodes[img.node] as DocNode & { kind: 'pixel' }
      const sx = img.width > 0 ? img.width / got.width : 1
      const sy = img.height > 0 ? img.height / got.height : 1
      const t = n.transform
      // The image fitted inside its box, centred, as SVG's default (xMidYMid meet) has it.
      const s = Math.min(sx, sy)
      const fit: Affine = [s, 0, 0, s, img.width > 0 ? (img.width - got.width * s) / 2 : 0, img.height > 0 ? (img.height - got.height * s) / 2 : 0]
      nodes[img.node] = { ...n, props: { ...n.props, tiles: got.set }, transform: [t[0] * fit[0], t[1] * fit[0], t[2] * fit[3], t[3] * fit[3], t[0] * fit[4] + t[2] * fit[5] + t[4], t[1] * fit[4] + t[3] * fit[5] + t[5]] } as DocNode
      warnings.push(...got.warnings)
    } catch (e) {
      warnings.push(`An embedded image couldn’t be decoded: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { doc: { ...r.doc, nodes }, warnings: [...new Set(warnings)] }
}

export async function openSvg(file: File): Promise<boolean> {
  try {
    const r = await readSvg(await file.text(), file.name)
    documents().add({ doc: r.doc, file: null, saved: false, label: 'Open SVG' })
    if (r.warnings.length) notify('warning', `“${file.name}” opened, with a few things that couldn’t come over.`, r.warnings)
    return true
  } catch (e) {
    notify('error', `“${file.name}” couldn’t be opened.`, [e instanceof Error ? e.message : String(e)])
    return false
  }
}
