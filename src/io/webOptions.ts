/**
 * Save for Web's settings, shared by its dialog and the engine that makes
 * the files: the format (JPEG, PNG-24, PNG-8 or WebP) and what each takes,
 * the size the image is made at, and its colour: converted to sRGB or
 * not, with the profile embedded or not.
 */

export type WebFormat = 'jpeg' | 'png24' | 'png8' | 'webp'

export const WEB_FORMATS: { id: WebFormat; label: string; ext: string; mime: string }[] = [
  { id: 'jpeg', label: 'JPEG', ext: '.jpg', mime: 'image/jpeg' },
  { id: 'png24', label: 'PNG-24', ext: '.png', mime: 'image/png' },
  { id: 'png8', label: 'PNG-8', ext: '.png', mime: 'image/png' },
  { id: 'webp', label: 'WebP', ext: '.webp', mime: 'image/webp' },
]

export interface WebOptions {
  format: WebFormat
  /** JPEG's and lossy WebP's quality, 0 to 100. */
  quality: number
  /** WebP without loss. */
  lossless: boolean
  /** PNG-8's most colours, 2 to 256. */
  colours: number
  /** PNG-8's dithering. */
  dither: boolean
  /** Transparency kept (PNG and WebP); without it, or in a JPEG, what's see-through is laid on the matte. */
  transparency: boolean
  /** What see-through pixels are laid on, 0..255 each; null is none (PNG-8 keeps partly transparent colours as they are). */
  matte: [number, number, number] | null
  /** The size the image is made at, in pixels. */
  width: number
  height: number
  /** Converted to sRGB, as the web expects; off, an RGB document keeps its own profile. */
  srgb: boolean
  /** The colour profile in the file. */
  embedProfile: boolean
}

export const formatOf = (f: WebFormat) => WEB_FORMATS.find((x) => x.id === f)!

/** Settings for a format at a size, as Save for Web starts them. */
export function webDefaults(format: WebFormat, width: number, height: number): WebOptions {
  return { format, quality: format === 'webp' ? 80 : 60, lossless: false, colours: 128, dither: true, transparency: format !== 'jpeg', matte: format === 'jpeg' ? [255, 255, 255] : null, width, height, srgb: true, embedProfile: true }
}

/** Settings read back from storage, kept in range; anything missing from `d`. */
export function readWebOptions(raw: unknown, d: WebOptions): WebOptions {
  if (!raw || typeof raw !== 'object') return d
  const r = raw as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, dv: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dv)
  const matte = Array.isArray(r.matte) && r.matte.length === 3 && r.matte.every((v) => typeof v === 'number') ? (r.matte.map((v: number) => Math.round(num(v, 0, 255, 255))) as [number, number, number]) : r.matte === null ? null : d.matte
  return {
    format: WEB_FORMATS.some((f) => f.id === r.format) ? (r.format as WebFormat) : d.format,
    quality: Math.round(num(r.quality, 0, 100, d.quality)),
    lossless: typeof r.lossless === 'boolean' ? r.lossless : d.lossless,
    colours: Math.round(num(r.colours, 2, 256, d.colours)),
    dither: typeof r.dither === 'boolean' ? r.dither : d.dither,
    transparency: typeof r.transparency === 'boolean' ? r.transparency : d.transparency,
    matte,
    width: d.width,
    height: d.height,
    srgb: typeof r.srgb === 'boolean' ? r.srgb : d.srgb,
    embedProfile: typeof r.embedProfile === 'boolean' ? r.embedProfile : d.embedProfile,
  }
}

/** A file's size as people read it: "843 B", "12.3 KB", "1.24 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1e6) return `${(bytes / 1000).toFixed(bytes < 1e4 ? 1 : 0)} KB`
  return `${(bytes / 1e6).toFixed(2)} MB`
}

/** How long a file takes to download at `mbps` megabits a second, as Save for Web says it. */
export function timeText(bytes: number, mbps: number): string {
  const s = (bytes * 8) / (mbps * 1e6)
  return s < 1 ? `${Math.max(1, Math.round(s * 1000))} ms` : `${s.toFixed(s < 10 ? 1 : 0)} s`
}
