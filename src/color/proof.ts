/**
 * How a document is looked at, as opposed to what it is: soft-proofing,
 * the gamut warning and separations. View state, kept per open document
 * and never in its history, as Photoshop keeps Proof Setup per window.
 *
 * The page holds it (app/proofing.ts) and sends it to the engine, which
 * folds the proof condition and gamut check into the document's display
 * table and the rest into the display pass (color/lut.ts, `Look`).
 */
import type { Intent } from './cms'
import type { ColourMode, ProfileRef } from '../doc/types'

/** A printing condition to proof against: Photoshop's Proof Setup. */
export interface ProofSetup {
  profile: ProfileRef
  /** The profile's colour space. */
  mode: ColourMode
  intent: Intent
  bpc: boolean
  /** Show the paper's own white (absolute colorimetric), not the display's. */
  paper: boolean
  /** Show the ink's own black, not the display's. Implied by `paper`. */
  black: boolean
}

export interface DocLook {
  setup: ProofSetup
  /** Proof Colours: shown as they'd print on `setup`. */
  proof: boolean
  /** Gamut Warning: what `setup` can't reproduce, marked. */
  gamut: boolean
  /** CMYK: which inks are shown (Separations). */
  inks: [boolean, boolean, boolean, boolean]
  /** CMYK: total ink, in percent (300 is 300%), past which coverage is too heavy. */
  inkLimit: number
  /** Mark pixels over the ink limit on the canvas. */
  inkWarning: boolean
  /** The colour channels shown (the Channels panel's eyes), in the mode's order; absent is all. */
  channels?: boolean[]
}

const DEFAULT_PROOF: ProofSetup = { profile: { builtin: 'generic-cmyk' }, mode: 'cmyk', intent: 'relative', bpc: true, paper: false, black: false }

export const DEFAULT_LOOK: DocLook = { setup: DEFAULT_PROOF, proof: false, gamut: false, inks: [true, true, true, true], inkLimit: 300, inkWarning: false }

/** Whether a look changes nothing on screen. */
export const plainLook = (l: DocLook) => !l.proof && !l.gamut && !l.inkWarning && l.inks.every(Boolean) && (!l.channels || l.channels.every(Boolean))

/** The part of a look that's in the display table, as a key. */
export function tableKey(l: DocLook): string {
  const s = l.setup
  const cond = `${JSON.stringify(s.profile)}/${s.mode}/${s.intent}/${s.bpc ? 1 : 0}`
  return `${l.proof ? `p:${cond}/${s.paper ? 1 : 0}/${s.black || s.paper ? 1 : 0}` : '-'}|${l.gamut ? `g:${cond}` : '-'}`
}
