/**
 * The profiles Plexel ships, and finding the profile a document means.
 *
 * Every built-in profile is made here from its published definition
 * (primaries, white point and tone curve) rather than shipped as a file,
 * so there's nothing third-party to license. The CMYK one is the generic
 * ink model in cmykModel.ts, named as such. Profiles users load, or that
 * come embedded in files, are content-addressed assets (assets.ts), and a
 * document refers to them by hash.
 *
 * Each engine builds a profile once, the first time it's asked for, and
 * keeps it.
 */
import type { ColourMode, ProfileRef } from '../doc/types'
import { forwardTable, inverseTable } from './cmykModel'
import type { Chromaticity, Cms, Curve, Profile } from './cms'

const D65: Chromaticity = { x: 0.3127, y: 0.329 }
const D50: Chromaticity = { x: 0.3457, y: 0.3585 }
/** The sRGB curve as ICC parametric type 4. */
const SRGB_CURVE: Curve = { parametric: 4, params: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045] }
const COPYRIGHT = 'No copyright. Made by Plexel from published definitions.'

export interface BuiltinProfile {
  id: string
  name: string
  mode: ColourMode
  /** Shown in the profile list under its name. */
  note?: string
  build(cms: Cms): Profile
}

export const BUILTIN_PROFILES: BuiltinProfile[] = [
  { id: 'srgb', name: 'sRGB IEC61966-2.1', mode: 'rgb', build: (cms) => cms.srgb() },
  {
    id: 'display-p3',
    name: 'Display P3',
    mode: 'rgb',
    build: (cms) =>
      cms.rgbProfile({ white: D65, red: { x: 0.68, y: 0.32 }, green: { x: 0.265, y: 0.69 }, blue: { x: 0.15, y: 0.06 }, curve: SRGB_CURVE, description: 'Display P3', copyright: COPYRIGHT }),
  },
  {
    id: 'adobe-rgb-compatible',
    name: 'Adobe RGB (1998) compatible',
    mode: 'rgb',
    build: (cms) =>
      cms.rgbProfile({ white: D65, red: { x: 0.64, y: 0.33 }, green: { x: 0.21, y: 0.71 }, blue: { x: 0.15, y: 0.06 }, curve: { gamma: 563 / 256 }, description: 'Adobe RGB (1998) compatible', copyright: COPYRIGHT }),
  },
  {
    id: 'prophoto-compatible',
    name: 'ProPhoto RGB compatible',
    mode: 'rgb',
    build: (cms) =>
      cms.rgbProfile({ white: D50, red: { x: 0.7347, y: 0.2653 }, green: { x: 0.1596, y: 0.8404 }, blue: { x: 0.0366, y: 0.0001 }, curve: { gamma: 1.8 }, description: 'ProPhoto RGB compatible', copyright: COPYRIGHT }),
  },
  {
    id: 'rec2020',
    name: 'Rec. ITU-R BT.2020',
    mode: 'rgb',
    build: (cms) =>
      cms.rgbProfile({ white: D65, red: { x: 0.708, y: 0.292 }, green: { x: 0.17, y: 0.797 }, blue: { x: 0.131, y: 0.046 }, curve: { parametric: 3, params: [1 / 0.45, 1 / 1.099, 0.099 / 1.099, 1 / 4.5, 0.081] }, description: 'Rec. ITU-R BT.2020', copyright: COPYRIGHT }),
  },
  { id: 'gray-gamma-2.2', name: 'Gray Gamma 2.2', mode: 'gray', build: (cms) => cms.grayProfile({ white: D50, curve: { gamma: 2.2 }, description: 'Gray Gamma 2.2', copyright: COPYRIGHT }) },
  { id: 'gray-gamma-1.8', name: 'Gray Gamma 1.8', mode: 'gray', build: (cms) => cms.grayProfile({ white: D50, curve: { gamma: 1.8 }, description: 'Gray Gamma 1.8', copyright: COPYRIGHT }) },
  {
    id: 'generic-cmyk',
    name: 'Generic CMYK (Plexel)',
    mode: 'cmyk',
    note: 'A plausible ink model for working in CMYK. Not a press profile: for print, load your printer’s.',
    build: (cms) =>
      cms.clutProfile({ space: 'cmyk', channels: 4, a2bPoints: 17, a2b: forwardTable(17), b2aPoints: 33, b2a: inverseTable(33), description: 'Generic CMYK (Plexel)', copyright: COPYRIGHT }),
  },
]

export const BUILTIN_BY_ID = new Map(BUILTIN_PROFILES.map((p) => [p.id, p]))

/** The built-in profiles for a mode, in the order the dialogs list them. */
export const builtinsFor = (mode: ColourMode) => BUILTIN_PROFILES.filter((p) => p.mode === mode)

/** A profile reference's name for the interface. */
export const profileLabel = (ref: ProfileRef, embeddedName?: string) =>
  'builtin' in ref ? (BUILTIN_BY_ID.get(ref.builtin)?.name ?? ref.builtin) : (embeddedName ?? 'Embedded profile')

/** The profile a new document gets in each mode. */
export const DEFAULT_PROFILE_ID: Record<ColourMode, string> = { rgb: 'srgb', gray: 'gray-gamma-2.2', cmyk: 'generic-cmyk' }

/** The profiles the display can be set to. */
export const DISPLAY_PROFILE_IDS = ['srgb', 'display-p3'] as const
export type DisplayProfileId = (typeof DISPLAY_PROFILE_IDS)[number]

/** Profile bytes by hash, for profiles that aren't built in. */
export interface ProfileAssets {
  get(hash: string): Uint8Array | undefined
}

export interface Resolved {
  profile: Profile
  /** Set when the document's profile couldn't be used and the mode's default stood in. */
  substituted?: string
}

/** Builds and keeps the profiles one engine uses. */
export class ProfileRegistry {
  private builtins = new Map<string, Profile>()
  private embedded = new Map<string, Profile>()
  private labProfile: Profile | null = null

  constructor(
    readonly cms: Cms,
    private assets: ProfileAssets,
  ) {}

  builtin(id: string): Profile {
    let p = this.builtins.get(id)
    if (!p) {
      const def = BUILTIN_BY_ID.get(id)
      if (!def) throw new Error(`No built-in profile “${id}”`)
      p = def.build(this.cms)
      this.builtins.set(id, p)
    }
    return p
  }

  lab(): Profile {
    return (this.labProfile ??= this.cms.lab())
  }

  /**
   * The built-in profile these bytes are exactly (one Plexel embedded in a
   * file it wrote), or null. A file saved from a document in Generic CMYK
   * then opens in Generic CMYK, not in an embedded copy of it: it says so,
   * and shares everything made for the built-in (display and adjustment
   * tables). Only built-ins of the profile's space are made, and only one
   * with the same description is compared byte by byte. The
   * header's creation time differs between two makings of the same
   * profile, and so does the profile ID (a digest that includes it), so
   * neither is compared.
   */
  builtinOf(bytes: Uint8Array, p: Profile): string | null {
    const ignored = (i: number) => (i >= 24 && i < 36) || (i >= 84 && i < 100)
    for (const def of BUILTIN_PROFILES) {
      if (def.mode !== p.space) continue
      const made = this.builtin(def.id)
      if (made.description !== p.description) continue
      const own = made.bytes()
      if (own.length === bytes.length && own.every((b, i) => b === bytes[i] || ignored(i))) return def.id
    }
    return null
  }

  /**
   * The profile a reference means, for a document in `mode`. A profile
   * that can't be had (an unknown built-in, missing bytes, or one for
   * another colour space) is replaced by the mode's default, and the result
   * says why, so the caller can tell the user.
   */
  resolve(ref: ProfileRef, mode: ColourMode): Resolved {
    const fallback = (why: string): Resolved => ({ profile: this.builtin(DEFAULT_PROFILE_ID[mode]), substituted: why })
    if ('builtin' in ref) {
      const def = BUILTIN_BY_ID.get(ref.builtin)
      if (!def) return fallback(`The profile “${ref.builtin}” isn’t one this version has`)
      if (def.mode !== mode) return fallback(`“${def.name}” is for ${def.mode.toUpperCase()}, not ${mode.toUpperCase()}`)
      return { profile: this.builtin(ref.builtin) }
    }
    let p = this.embedded.get(ref.asset)
    if (!p) {
      const bytes = this.assets.get(ref.asset)
      if (!bytes) return fallback('The document’s embedded profile is missing')
      try {
        p = this.cms.openProfile(bytes)
      } catch (e) {
        return fallback(`The document’s embedded profile can’t be read: ${(e as Error).message}`)
      }
      this.embedded.set(ref.asset, p)
    }
    if (p.space !== mode) return fallback(`The embedded profile “${p.description}” is for ${p.space.toUpperCase()}, not ${mode.toUpperCase()}`)
    return { profile: p }
  }

  close() {
    for (const p of [...this.builtins.values(), ...this.embedded.values()]) p.close()
    this.labProfile?.close()
    this.builtins.clear()
    this.embedded.clear()
    this.labProfile = null
  }
}
