/**
 * A colour, as the user picked it: its own space, its own profile, its own
 * numbers. A swatch picked in CMYK stays those CMYK numbers through a
 * change of document mode, and a Lab colour is the same colour everywhere.
 * It is converted only when it's used: to the document's space when it's
 * painted with, to the display's when it's shown.
 *
 *   rgb, gray, cmyk: 0..1 per channel. Gray 0 is black; CMYK is ink.
 *   lab: L 0..100, a and b about -128..127, under D50. No profile.
 */
import type { ColourMode, ProfileRef } from '../doc/types'
import { deltaE2000 } from './models'
import type { Intent, Profile, Transform } from './cms'
import type { ProfileRegistry } from './profiles'

export type ValueSpace = ColourMode | 'lab'

export interface ColourValue {
  space: ValueSpace
  /** The profile the numbers are in; null for Lab. */
  profile: ProfileRef | null
  c: number[]
}

export const CHANNELS: Record<ValueSpace, number> = { rgb: 3, gray: 1, cmyk: 4, lab: 3 }

export const BLACK: ColourValue = { space: 'rgb', profile: { builtin: 'srgb' }, c: [0, 0, 0] }
export const WHITE: ColourValue = { space: 'rgb', profile: { builtin: 'srgb' }, c: [1, 1, 1] }

const SPACES: ValueSpace[] = ['rgb', 'gray', 'cmyk', 'lab']

/** A stored colour value read back, or null when it isn't one: a space, its numbers, and a profile (none for Lab). */
export function readColourValue(v: unknown): ColourValue | null {
  if (!v || typeof v !== 'object') return null
  const { space, profile, c } = v as Partial<ColourValue>
  if (!SPACES.includes(space as ValueSpace) || !Array.isArray(c) || c.length !== CHANNELS[space as ValueSpace]) return null
  if (!c.every((x) => typeof x === 'number' && Number.isFinite(x))) return null
  const p = profile && typeof profile === 'object' && ('builtin' in profile || 'asset' in profile) ? profile : null
  if (space !== 'lab' && !p) return null
  return { space: space as ValueSpace, profile: space === 'lab' ? null : p, c: [...c] }
}

export const sameValue = (a: ColourValue, b: ColourValue) =>
  a.space === b.space && JSON.stringify(a.profile) === JSON.stringify(b.profile) && a.c.length === b.c.length && a.c.every((v, i) => v === b.c[i])

/** Where a colour is going: a space and a profile in it. */
export interface Target {
  space: ValueSpace
  profile: ProfileRef | null
}

export interface Converted {
  c: number[]
  /** The colour was outside the target's gamut and was clipped to it. */
  clipped: boolean
}

/**
 * Converts colours between spaces, keeping a transform per pair of
 * profiles and intent, so the colour panel's sliders, which convert on
 * every move, don't rebuild one each time.
 */
export class Converter {
  private cache = new Map<string, Transform>()

  constructor(private registry: ProfileRegistry) {}

  private profileFor(t: Target): Profile {
    if (t.space === 'lab' || !t.profile) return this.registry.lab()
    return this.registry.resolve(t.profile, t.space).profile
  }

  private transform(from: Target, to: Target, intent: Intent, bpc = true): Transform {
    const key = JSON.stringify([from.space, from.profile, to.space, to.profile, intent, bpc])
    let t = this.cache.get(key)
    if (!t) {
      t = this.registry.cms.transform(this.profileFor(from), this.profileFor(to), intent, bpc ? 0x2000 : 0)
      this.cache.set(key, t)
    }
    return t
  }

  /**
   * Converts a colour. Black-point compensation is on unless asked
   * otherwise, as Photoshop has it, so a conversion to a space with a
   * lighter black keeps its shadow detail.
   */
  convert(v: ColourValue, to: Target, intent: Intent = 'relative', bpc = true): Converted {
    if (v.space === to.space && JSON.stringify(v.profile) === JSON.stringify(to.profile)) return { c: [...v.c], clipped: false }
    const raw = this.transform(v, to, intent, bpc).one(v.c)
    const inGamut = raw.every((x) => x >= -1e-4 && x <= 1 + 1e-4)
    const c = to.space === 'lab' ? raw : raw.map((x) => Math.min(1, Math.max(0, x)))
    // An unbounded float transform says plainly when a colour is out of an
    // RGB or Gray gamut. CMYK tables clip by themselves, so the test there
    // is whether the colour survives the trip there and back under the
    // same intent and black-point setting. Comparing it straight with the
    // original would call black out of gamut: with black-point
    // compensation it maps to the inks' darkest black, which is the point.
    let clipped = to.space !== 'lab' && !inGamut
    if (!clipped && to.space === 'cmyk' && v.space !== 'lab') {
      const back = this.transform(to, v, intent, bpc).one(c)
      clipped = deltaE2000(this.toLab(v), this.toLab({ space: v.space, profile: v.profile, c: back })) > 2
    } else if (!clipped && to.space === 'cmyk') {
      clipped = deltaE2000(v.c, this.toLab({ space: to.space, profile: to.profile, c })) > 2
    }
    return { c, clipped }
  }

  toLab(v: ColourValue): number[] {
    if (v.space === 'lab') return [...v.c]
    return this.transform(v, { space: 'lab', profile: null }, 'relative').one(v.c)
  }

  /** Forgets cached transforms, for when profiles change. */
  clear() {
    for (const t of this.cache.values()) t.close()
    this.cache.clear()
  }
}
