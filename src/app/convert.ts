/**
 * Convert to Profile and Image → Mode: the front document's pixels
 * converted in the engine (engine/convertHost.ts), every other colour it
 * holds converted here (doc/convert.ts) through the same profiles, intent
 * and black-point setting, and the two committed as one step.
 */
import type { Intent } from '../color/cms'
import { BUILTIN_BY_ID } from '../color/profiles'
import { convertDoc, pixelSets, type ConvertTarget } from '../doc/convert'
import type { ColourMode, Depth, ProfileRef } from '../doc/types'
import { engine } from '../engine/EngineHost'
import { assets } from '../io/assets'
import { colourEngine } from './colour'
import { colourSettings } from './colourSettings'
import { documents } from './documents'
import { dismiss, notify } from './notices'
import { swatchColourIn } from './docSwatches'
import { recolourLinked } from '../doc/swatches'

const MODE_NAMES: Record<ColourMode, string> = { rgb: 'RGB', gray: 'Gray', cmyk: 'CMYK' }

let busy = false
let working: number | null = null

/**
 * Converts the front document. `label` names the step ("Convert to
 * Profile", "CMYK Color", "16 Bits/Channel"). Resolves once it's committed,
 * or with nothing done when there was nothing to do or it failed (which is
 * said).
 */
export async function convertDocument(target: ConvertTarget, intent: Intent, bpc: boolean, label: string): Promise<boolean> {
  const d = documents().active()
  if (!d || busy) return false
  const doc = d.history.present
  const sameSpace = doc.mode === target.mode && JSON.stringify(doc.profile) === JSON.stringify(target.profile)
  if (sameSpace && doc.depth === target.depth) return false
  busy = true
  try {
    const { cms, registry } = await colourEngine()
    const from = registry.resolve(doc.profile, doc.mode)
    const to = registry.resolve(target.profile, target.mode)
    if (to.substituted) {
      notify('error', `The document can’t be converted: ${to.substituted}.`)
      return false
    }
    const profiles = 'asset' in target.profile ? [{ hash: target.profile.asset, bytes: assets().get(target.profile.asset)! }].filter((p) => p.bytes) : []
    const sets = pixelSets(doc)
    // A big document takes seconds, and the canvas waits meanwhile: say so.
    working = doc.width * doc.height > 16e6 ? notify('info', `Converting ${doc.name}…`) : null
    const map = await engine().call('tiles.convert', { sets, from: { mode: doc.mode, profile: doc.profile, depth: doc.depth }, to: target, intent, bpc, profiles })
    const t = sameSpace ? null : cms.transform(from.profile, to.profile, intent, bpc ? 0x2000 : 0)
    let warnings: string[] = []
    try {
      const fn = (c: number[]) => (t ? t.one(c).map((v) => Math.min(1, Math.max(0, v))) : [...c])
      const current = documents().get(d.key)?.history.present
      if (current !== doc) {
        notify('warning', 'The document changed while it was being converted, so the conversion was left out. Try again.')
        return false
      }
      const r = convertDoc(doc, target, fn, new Map(Object.entries(map)))
      warnings = r.warnings
      // Fills and strokes linked to swatches take the swatch's own colour in the new space, not a conversion of the old numbers.
      const colourOf = swatchColourIn(r.doc)
      const next = colourOf ? recolourLinked(r.doc, colourOf) : r.doc
      documents().commit(() => next, { key: d.key, label })
    } finally {
      t?.close()
    }
    for (const w of warnings) notify('warning', w)
    return true
  } catch (e) {
    notify('error', `The document couldn’t be converted: ${e instanceof Error ? e.message : String(e)}`)
    return false
  } finally {
    busy = false
    if (working !== null) dismiss(working)
  }
}

/** Image → Mode: to the mode's working space (Colour Settings), with its intent and black point. */
export function convertMode(mode: ColourMode) {
  const d = documents().active()
  if (!d) return
  const doc = d.history.present
  if (doc.mode === mode) return
  const s = colourSettings.get()
  void convertDocument({ mode, profile: s.working[mode], depth: doc.depth }, s.intent, s.blackPointCompensation, `${MODE_NAMES[mode]} Colour`)
}

/** Image → Mode → 8 or 16 Bits/Channel. */
export function convertDepth(depth: Depth) {
  const d = documents().active()
  if (!d) return
  const doc = d.history.present
  if (doc.depth === depth) return
  const s = colourSettings.get()
  void convertDocument({ mode: doc.mode, profile: doc.profile, depth }, s.intent, s.blackPointCompensation, `${depth} Bits/Channel`)
}

/** A profile's mode, for the Convert to Profile dialog: built-ins say, loaded ones are read. */
export async function profileMode(ref: ProfileRef): Promise<ColourMode | null> {
  if ('builtin' in ref) return BUILTIN_BY_ID.get(ref.builtin)?.mode ?? null
  const bytes = assets().get(ref.asset)
  if (!bytes) return null
  const { cms } = await colourEngine()
  try {
    const p = cms.openProfile(bytes)
    const space = p.space
    p.close()
    return space === 'rgb' || space === 'gray' || space === 'cmyk' ? space : null
  } catch {
    return null
  }
}
