/**
 * JPEG, as far as Plexel handles it itself: reading the markers (the
 * colour components, Adobe's transform flag, and the ICC profile, which
 * can be split across several APP2 segments), and writing a profile into a
 * JPEG the browser encoded.
 *
 * The pixels themselves are decoded and encoded by the browser, which does
 * that well for 8-bit RGB and gray. It's asked not to convert colours, so
 * the numbers arrive as they are in the file and the profile read here
 * says what they mean. CMYK JPEGs need a decoder of our own, which comes
 * later; until then they're refused with that said.
 */
export class JpegError extends Error {}

export const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

export interface JpegInfo {
  width: number
  height: number
  components: number
  /** Adobe's APP14 transform: 0 none, 1 YCbCr, 2 YCCK. Null when there's no APP14. */
  adobeTransform: number | null
  icc: Uint8Array | null
  progressive: boolean
}

const ICC_TAG = 'ICC_PROFILE\0'

export function readJpegInfo(b: Uint8Array): JpegInfo {
  if (!isJpeg(b)) throw new JpegError('This isn’t a JPEG file.')
  let at = 2
  let width = 0
  let height = 0
  let components = 0
  let adobeTransform: number | null = null
  let progressive = false
  const icc: { seq: number; data: Uint8Array }[] = []
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) {
      at++
      continue
    }
    const marker = b[at + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      at += marker === 0xff ? 1 : 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) break
    const len = (b[at + 2] << 8) | b[at + 3]
    const seg = b.subarray(at + 4, at + 2 + len)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      height = (seg[1] << 8) | seg[2]
      width = (seg[3] << 8) | seg[4]
      components = seg[5]
      progressive = marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce
    } else if (marker === 0xe2 && seg.length > 14 && String.fromCharCode(...seg.subarray(0, 12)) === ICC_TAG) {
      icc.push({ seq: seg[12], data: seg.subarray(14) })
    } else if (marker === 0xee && seg.length >= 12 && String.fromCharCode(...seg.subarray(0, 5)) === 'Adobe') {
      adobeTransform = seg[11]
    }
    at += 2 + len
  }
  if (!width || !height) throw new JpegError('The JPEG has no frame header.')
  let profile: Uint8Array | null = null
  if (icc.length) {
    icc.sort((x, y) => x.seq - y.seq)
    profile = new Uint8Array(icc.reduce((n, s) => n + s.data.length, 0))
    let o = 0
    for (const s of icc) {
      profile.set(s.data, o)
      o += s.data.length
    }
  }
  return { width, height, components, adobeTransform, icc: profile, progressive }
}

/**
 * The JPEG with `icc` written in as APP2 segments right after the start
 * (after JFIF's APP0 if there is one), replacing any profile it had.
 */
export function withIcc(jpeg: Uint8Array, icc: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = []
  const max = 65533 - 16
  const count = Math.ceil(icc.length / max)
  if (count > 255) throw new JpegError('The profile is too big to embed in a JPEG.')
  for (let i = 0; i < count; i++) {
    const part = icc.subarray(i * max, (i + 1) * max)
    const seg = new Uint8Array(4 + 14 + part.length)
    const len = seg.length - 2
    seg.set([0xff, 0xe2, len >> 8, len & 255])
    for (let c = 0; c < 12; c++) seg[4 + c] = ICC_TAG.charCodeAt(c)
    seg[16] = i + 1
    seg[17] = count
    seg.set(part, 18)
    chunks.push(seg)
  }
  // Keep SOI and an APP0 (JFIF) first; drop existing ICC segments.
  let at = 2
  const head: Uint8Array[] = [jpeg.subarray(0, 2)]
  const rest: Uint8Array[] = []
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1]
    if (marker === 0xda) break
    const len = (jpeg[at + 2] << 8) | jpeg[at + 3]
    const seg = jpeg.subarray(at, at + 2 + len)
    const isIcc = marker === 0xe2 && String.fromCharCode(...jpeg.subarray(at + 4, at + 16)) === ICC_TAG
    if (!isIcc) {
      if (marker === 0xe0 && head.length === 1) head.push(seg)
      else rest.push(seg)
    }
    at += 2 + len
  }
  const tail = jpeg.subarray(at)
  const parts = [...head, ...chunks, ...rest, tail]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
