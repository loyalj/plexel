/**
 * The front document's swatches (doc/swatches.ts) as the page edits them:
 * made from the foreground colour, changed, deleted, loaded from and saved
 * to Adobe Swatch Exchange libraries, and applied to fills and strokes.
 * Every edit is one named step.
 */
import type { ColourValue } from '../color/value'
import { addSwatch, removeSwatch, updateSwatch, type DocSwatch, type SwatchColourFn, type SwatchKind, tinted } from '../doc/swatches'
import type { Doc } from '../doc/types'
import { readAse, writeAse } from '../io/ase'
import { colourEngineNow } from './colour'
import { colours } from './colours'
import { colourSettings } from './colourSettings'
import { documents, newId } from './documents'
import { notify } from './notices'

/** How a swatch's colour is made in `doc`'s terms: converted with the Colour Settings' intent, then tinted. Null until the colour engine is up. */
export function swatchColourIn(doc: Doc): SwatchColourFn | null {
  const cms = colourEngineNow()
  if (!cms) return null
  const { intent, blackPointCompensation } = colourSettings.get()
  return (s, tint) => tinted(cms.converter.convert(s.colour, { space: doc.mode, profile: doc.profile }, intent, blackPointCompensation).c, doc.mode, tint)
}

const freshName = (doc: Doc, base: string) => {
  const names = new Set((doc.swatches ?? []).map((s) => s.name))
  if (!names.has(base)) return base
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`
}

const describe = (c: ColourValue) => {
  const pct = (v: number) => Math.round(v * 100)
  if (c.space === 'cmyk') return `C${pct(c.c[0])} M${pct(c.c[1])} Y${pct(c.c[2])} K${pct(c.c[3])}`
  if (c.space === 'lab') return `L${Math.round(c.c[0])} a${Math.round(c.c[1])} b${Math.round(c.c[2])}`
  if (c.space === 'gray') return `K${100 - pct(c.c[0])}`
  return `R${Math.round(c.c[0] * 255)} G${Math.round(c.c[1] * 255)} B${Math.round(c.c[2] * 255)}`
}

/** A new document swatch from the foreground colour. Returns its id. */
export function newDocSwatch(kind: SwatchKind, name?: string): string | null {
  const d = documents().active()
  if (!d) return null
  const colour = colours().get().fg
  const id = newId('w')
  documents().commit((x) => addSwatch(x, { id, kind, name: name?.trim() || freshName(x, kind === 'spot' ? 'Spot Colour' : describe(colour)), colour }), { key: d.key, label: 'New Swatch' })
  return id
}

export function editDocSwatch(id: string, patch: Partial<Omit<DocSwatch, 'id'>>, label = 'Swatch Options', coalesce?: string) {
  const d = documents().active()
  const colourOf = d && swatchColourIn(d.history.present)
  if (!d || !colourOf) return
  documents().commit((x) => updateSwatch(x, id, patch, swatchColourIn(x) ?? colourOf), { key: d.key, label, coalesce })
}

export function deleteDocSwatch(id: string) {
  const d = documents().active()
  if (!d) return
  documents().commit((x) => removeSwatch(x, id), { key: d.key, label: 'Delete Swatch' })
}

/** Swatches from an Adobe Swatch Exchange file (.ase), added to the front document. */
export async function loadLibrary(file: File) {
  const d = documents().active()
  if (!d) return
  const r = readAse(new Uint8Array(await file.arrayBuffer()), colourSettings.get().working)
  if (!r.ok) return notify('error', `“${file.name}” couldn’t be read as a swatch library: ${r.error}`)
  if (!r.swatches.length) return notify('info', `“${file.name}” has no colours Plexel can use.`)
  documents().commit(
    (x) => {
      let doc = x
      const names = new Set((x.swatches ?? []).map((s) => s.name))
      for (const s of r.swatches) {
        // A library loaded twice doesn't double up.
        if (names.has(s.name)) continue
        doc = addSwatch(doc, { ...s, id: newId('w') })
        names.add(s.name)
      }
      return doc
    },
    { key: d.key, label: 'Load Swatches' },
  )
  for (const w of r.warnings) notify('warning', w)
}

/** The front document's swatches as an Adobe Swatch Exchange file. */
export function libraryBytes(): Uint8Array | null {
  const d = documents().active()
  const list = d?.history.present.swatches ?? []
  return list.length ? writeAse(list) : null
}
