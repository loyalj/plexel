/**
 * Converting a document's pixels, as the engine worker does it: every tile
 * set through one conversion (the document's profile to the target's, with
 * the intent and black-point setting asked for: LittleCMS's, sampled on a
 * grid as color/convertLut.ts does), into new sets held for the page to
 * commit. The page converts the rest of the
 * document (doc/convert.ts) and commits both as one step.
 */
import type { Intent } from '../color/cms'
import type { ColourMode, Depth, ProfileRef } from '../doc/types'
import { convertSet } from '../tiles/convert'
import { buildConvertLut, runConvertLut } from '../color/convertLut'
import { colour } from './colourHost'
import { pinSet, store, unpinSet } from './tileHost'

export interface ConvertSpace {
  mode: ColourMode
  profile: ProfileRef
  depth: Depth
}

/** New sets are held this long for the page to commit them, as selection results are. */
const HOLD_MS = 60_000

const sameProfile = (a: ProfileRef, b: ProfileRef) => JSON.stringify(a) === JSON.stringify(b)

export async function convertSets(sets: string[], from: ConvertSpace, to: ConvertSpace, intent: Intent, bpc: boolean): Promise<Record<string, string>> {
  const { cms, registry } = await colour()
  const same = from.mode === to.mode && sameProfile(from.profile, to.profile)
  const lut = same ? null : buildConvertLut(cms, registry.resolve(from.profile, from.mode).profile, registry.resolve(to.profile, to.mode).profile, intent, bpc)
  const out: Record<string, string> = {}
  for (const id of sets) {
    if (!store.hasSet(id)) continue
    const next = await convertSet(store, id, { mode: to.mode, depth: to.depth }, lut ? (c, n) => runConvertLut(lut, c, n) : null)
    pinSet(next)
    setTimeout(() => unpinSet(next), HOLD_MS)
    out[id] = next
  }
  return out
}
