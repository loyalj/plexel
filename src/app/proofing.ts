/**
 * Each open document's look (color/proof.ts): Proof Setup, Proof Colours,
 * the Gamut Warning and Separations. View state, so none of it is in the
 * history or the file, as in Photoshop; a document starts with the proof
 * condition being the working CMYK space (Colour Settings).
 */
import { DEFAULT_LOOK, type DocLook, type ProofSetup } from '../color/proof'
import { engine } from '../engine/EngineHost'
import { colourSettings } from './colourSettings'
import { documents } from './documents'
import { Listeners } from '../lib/listeners'

const looks = new Map<string, DocLook>()
const changes = new Listeners()

/** The proof condition a document starts with: the working CMYK space, relative colorimetric. */
function defaultSetup(): ProofSetup {
  return { ...DEFAULT_LOOK.setup, profile: colourSettings.get().working.cmyk, mode: 'cmyk' }
}

export const proofing = {
  get(key: string | null | undefined): DocLook {
    if (!key) return DEFAULT_LOOK
    let l = looks.get(key)
    if (!l) looks.set(key, (l = { ...DEFAULT_LOOK, setup: defaultSetup() }))
    return l
  },
  /** The active document's look. */
  active(): DocLook {
    return proofing.get(documents().getState().active)
  },
  update(key: string, patch: Partial<DocLook>) {
    const next = { ...proofing.get(key), ...patch }
    looks.set(key, next)
    engine().setLook(key, next)
    changes.emit()
  },
  subscribe(fn: () => void) {
    return changes.subscribe(fn)
  },
}

// A closed document's look goes with it.
documents().subscribe(() => {
  const open = new Set(documents().getState().docs.map((d) => d.key))
  for (const k of [...looks.keys()]) if (!open.has(k)) looks.delete(k)
})
