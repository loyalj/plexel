/** An artboard's settings read back from a file (doc/artboards.ts has the rest), apart so the node registry can read them without a cycle. */
import { readBool, readNumber, type Warn } from './read'
import { MAX_SIDE, type Artboard } from './types'
import type { ParamColour } from './params'

export function readArtboard(raw: Record<string, unknown>, warn: Warn): Artboard {
  const bg = raw.background
  const background = Array.isArray(bg) && bg.length >= 1 && bg.length <= 4 && bg.every((v) => typeof v === 'number' && Number.isFinite(v)) ? (bg.map((v) => Math.min(1, Math.max(0, v))) as ParamColour) : null
  if (bg !== null && bg !== undefined && !background) warn('An artboard’s background could not be read; made it transparent')
  return {
    width: Math.round(readNumber(raw.width, 1080, 1, MAX_SIDE, 'an artboard’s width', warn)),
    height: Math.round(readNumber(raw.height, 1080, 1, MAX_SIDE, 'an artboard’s height', warn)),
    background,
    clip: readBool(raw.clip, true, 'whether an artboard clips', warn),
  }
}
