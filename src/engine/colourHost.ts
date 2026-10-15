/**
 * The colour engine as the engine worker runs it: LittleCMS loaded once,
 * profiles resolved for each document (embedded ones arrive with the
 * document's scene, as bytes), and display lookup tables built and kept.
 *
 * A table depends on the document's mode and profile and on the display's
 * profile, so it's keyed by all three and built once per combination.
 */
import wasmUrl from '../color/wasm/pxcms.wasm?url'
import { startCms, type Cms, type Transform } from '../color/cms'
import { ProfileRegistry, type DisplayProfileId } from '../color/profiles'
import { buildLookLut, type Lut } from '../color/lut'
import { tableKey, type DocLook } from '../color/proof'
import { buildCmykTables, type CmykTables } from '../color/cmykAdjust'
import type { ColourMode, ProfileRef } from '../doc/types'

let started: Promise<{ cms: Cms; registry: ProfileRegistry }> | null = null
let ready: { cms: Cms; registry: ProfileRegistry } | null = null
const assetBytes = new Map<string, Uint8Array>()

export function colour() {
  started ??= (async () => {
    const cms = await startCms({ url: wasmUrl })
    ready = { cms, registry: new ProfileRegistry(cms, { get: (h) => assetBytes.get(h) }) }
    return ready
  })()
  return started
}

/** The engine if it has loaded, for code that can wait a frame. */
export const colourNow = () => ready

/** An embedded profile's bytes, from the page. */
export function addProfile(hash: string, bytes: Uint8Array) {
  if (!assetBytes.has(hash)) assetBytes.set(hash, bytes)
}

const profileKey = (ref: ProfileRef) => ('builtin' in ref ? `b:${ref.builtin}` : `a:${ref.asset}`)

const luts = new Map<string, { lut: Lut; substituted?: string }>()

/** Tables kept at most; each is a megabyte or two. */
const LUT_CACHE = 24

/**
 * The table that shows a document on a display (or in an sRGB file, for
 * previews), soft-proofed and with the gamut marked as `look` says. Null
 * until the engine has loaded; the caller asks again next frame.
 */
export function lutFor(mode: ColourMode, profile: ProfileRef, target: DisplayProfileId, look: DocLook | null = null): { lut: Lut; key: string; substituted?: string } | null {
  if (!ready) {
    void colour()
    return null
  }
  const key = `${mode}|${profileKey(profile)}|${target}|${look ? tableKey(look) : '-|-'}`
  let entry = luts.get(key)
  if (!entry) {
    const from = ready.registry.resolve(profile, mode)
    const to = ready.registry.builtin(target)
    const s = look?.setup
    const cond = s ? { profile: ready.registry.resolve(s.profile, s.mode).profile, intent: s.intent, bpc: s.bpc } : null
    const lut = buildLookLut(ready.cms, from.profile, to, {
      proof: look?.proof && cond && s ? { ...cond, paper: s.paper, black: s.black || s.paper } : null,
      gamut: look?.gamut && cond ? cond : null,
    })
    entry = { lut, substituted: from.substituted }
    luts.set(key, entry)
    while (luts.size > LUT_CACHE) luts.delete(luts.keys().next().value!)
  }
  return { ...entry, key }
}

const cmykTables = new Map<string, CmykTables>()

/**
 * A CMYK profile's tables for colour adjustments (color/cmykAdjust.ts),
 * against Adobe RGB compatible: made the first time they're asked for
 * (well under a second) and kept. Null until the engine has loaded.
 */
export function cmykTablesFor(profile: ProfileRef): CmykTables | null {
  if (!ready) {
    void colour()
    return null
  }
  const key = profileKey(profile)
  let t = cmykTables.get(key)
  if (!t) {
    t = buildCmykTables(ready.cms, ready.registry.resolve(profile, 'cmyk').profile, ready.registry.builtin('adobe-rgb-compatible'))
    cmykTables.set(key, t)
  }
  return t
}

/** A converter between two of a document's spaces, for import and export; the caller closes it. */
export function transformBetween(
  from: { mode: ColourMode; profile: ProfileRef },
  to: { mode: ColourMode; profile: ProfileRef } | { display: DisplayProfileId },
  intent: 'perceptual' | 'relative' | 'saturation' | 'absolute' = 'relative',
): Transform {
  if (!ready) throw new Error('The colour engine hasn’t loaded')
  const a = ready.registry.resolve(from.profile, from.mode).profile
  const b = 'display' in to ? ready.registry.builtin(to.display) : ready.registry.resolve(to.profile, to.mode).profile
  return ready.cms.transform(a, b, intent, 0x2000)
}

/** sRGB (0..1) in the display's space: for theme colours on a Display P3 canvas. */
export function themeColour(rgb: [number, number, number], display: DisplayProfileId): [number, number, number] {
  if (display === 'srgb' || !ready) return rgb
  const t = ready.cms.transform(ready.registry.builtin('srgb'), ready.registry.builtin(display), 'relative', 0)
  try {
    return t.one(rgb) as [number, number, number]
  } finally {
    t.close()
  }
}
