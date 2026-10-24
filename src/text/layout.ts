/**
 * Text layout: content in, glyphs placed out (ARCHITECTURE.md, "Type").
 *
 * Paragraph by paragraph:
 *
 * 1. Each character's settings are resolved through the styles, and its
 *    font chosen: the run's, or for a character that font lacks, a
 *    fallback for its script.
 * 2. Bidi levels (UAX #9) and scripts split the paragraph into items of one
 *    font, size, direction and script, each shaped by HarfBuzz with the
 *    whole paragraph as context.
 * 3. Line break opportunities (UAX #14), with soft hyphens and, when the
 *    paragraph hyphenates, the places its language's patterns allow
 *    (text/hyphenate.ts), cut it into segments, and a composer picks the
 *    breaks: single-line takes each line as full as it goes; every-line
 *    weighs the whole paragraph (Knuth and Plass), for even justified
 *    spacing or the least ragged edge. A line ending inside a word gets a
 *    hyphen, within the paragraph's hyphenation settings.
 * 4. Each line is put in visual order (bidi's rule L2), aligned or
 *    justified, and its glyphs placed: on baselines down the frame for area
 *    text, from the origin for point text, or along the path for path text.
 *    Spaces, letters and glyphs take the paragraph's wanted spacing and
 *    scaling; a justified line stretches or shrinks its word spaces within
 *    their range first, then its letter spacing, then its glyphs' width
 *    (Photoshop's Justification). A tab moves to the next tab stop, lining
 *    the text after it up as the stop says, with its leader in the gap.
 *
 * Each glyph keeps the paint its characters have of their own, if any
 * (colour per character): the glyph set says which, for the outline
 * builder (vector/outline.ts).
 *
 * What comes out is a glyph set the vector pipeline draws, and for editing,
 * each line's caret positions and characters' boxes.
 *
 * Pure apart from the fonts it's handed: check-text runs it in Node.
 */
import LineBreaker from 'linebreak'
import bidiFactory from 'bidi-js'
import { DEFAULT_FONT, leadingOf, paragraphText, resolveChar, resolvePara, type CharProps, type ParaProps, type Paragraph, type TextContent, type TextStyles } from '../doc/text'
import type { Face, Font, ShapedGlyph } from './hb'
import type { Box, PathData } from '../geom/path'
import { glyphsBounds, type CharPaint, type GlyphSet } from '../geom/glyphs'
import type { Hyphenator } from './hyphenate'
import type { TabStop } from '../doc/text'
import { distanceAlong, pathPolys } from './framePath'

export { distanceAlong }

const bidi = bidiFactory()

/** Where layout gets fonts: synchronously, from what's loaded. */
export interface FontProvider {
  /** The face for a family and style, and the style's own variation coordinates; null when it isn't available. */
  face(family: string, style: string): { face: Face; coords: Record<string, number> } | null
  /** Faces to try, in order, for a character the chosen font lacks: for its script first. */
  fallbacks(script: string): Face[]
  /** The face to use when a font is missing altogether. */
  defaultFace(): { face: Face; coords: Record<string, number> }
  /** Whether a font face() gave nothing for is known and still loading: not missing, only not here yet. */
  pending?(family: string, style: string): boolean
  /**
   * Moves on whenever what the provider gives changes (a font arrives).
   * Given, paragraphs' shaping is kept between layouts (paraCache); a
   * provider without one has every paragraph shaped each time.
   */
  readonly version?: number
}

export interface LayoutInput {
  content: TextContent
  styles?: TextStyles
  mode: 'point' | 'area' | 'path'
  /** Area text's frame or path text's path, in the node's coordinates. */
  frame: PathData | null
  pathOffset?: number
  /** Where words may break, for paragraphs that hyphenate; none, and they don't. */
  hyphenator?: Hyphenator
}

/** One laid-out line, for editing: where it is and where each position falls. */
export interface Line {
  para: number
  /** Positions in the whole content: [start, end), end before any paragraph break. */
  start: number
  end: number
  baseline: number
  top: number
  bottom: number
  /** Left to right on screen, whatever the text's direction. */
  x0: number
  x1: number
  rtl: boolean
  /** Each character's box on the line, left and right, for positions start..end-1. */
  boxes: [number, number][]
  /** Each character's direction: true where it's right to left. */
  charRtl: boolean[]
}

export interface TextLayout {
  glyphs: GlyphSet
  lines: Line[]
  /** The ink's box, in the node's coordinates. */
  bounds: Box | null
  /** Text that didn't fit the frame (or ran off the path's end). */
  overflow: boolean
  /** Fonts the text asks for that aren't available, as "family style". */
  missing: string[]
  /** Fonts it asks for that are known but still loading (drawn in the default meanwhile). */
  pending: string[]
  /** Path text: where on the path each line's x is measured (arc length = x + this). */
  pathStart?: number
}

// --- scripts -------------------------------------------------------------------------------------

const SCRIPTS: [string, RegExp][] = [
  ['Latn', /\p{Script=Latin}/u],
  ['Arab', /\p{Script=Arabic}/u],
  ['Hebr', /\p{Script=Hebrew}/u],
  ['Deva', /\p{Script=Devanagari}/u],
  ['Beng', /\p{Script=Bengali}/u],
  ['Cyrl', /\p{Script=Cyrillic}/u],
  ['Grek', /\p{Script=Greek}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Hani', /\p{Script=Han}/u],
  ['Hira', /\p{Script=Hiragana}/u],
  ['Kana', /\p{Script=Katakana}/u],
  ['Hang', /\p{Script=Hangul}/u],
  ['Tami', /\p{Script=Tamil}/u],
  ['Gujr', /\p{Script=Gujarati}/u],
  ['Guru', /\p{Script=Gurmukhi}/u],
  ['Geor', /\p{Script=Georgian}/u],
  ['Armn', /\p{Script=Armenian}/u],
  ['Ethi', /\p{Script=Ethiopic}/u],
  ['Khmr', /\p{Script=Khmer}/u],
]

/** A character's script, or '' for the common and inherited ones that take their neighbours'. */
export function scriptOf(ch: string): string {
  for (const [tag, re] of SCRIPTS) if (re.test(ch)) return tag
  return ''
}

const isMark = (ch: string) => /\p{M}/u.test(ch)
/** Word spaces: what justification stretches. Tabs aren't (they go to their stops). */
const isSpace = (code: number) => code === 0x20 || code === 0xa0 || code === 0x3000
const TAB = 0x09

// --- per paragraph ---------------------------------------------------------------------------------

interface Item {
  start: number
  end: number
  props: CharProps
  font: Font
  upem: number
  rtl: boolean
  script: string
  /** Added after each cluster: tracking and the paragraph's wanted letter spacing, in pixels. */
  track: number
  /** The paragraph's wanted glyph scaling, as a factor (spaces aren't scaled; they take word spacing). */
  glyphScale: number
  /** The font's space at this size, unscaled: what word and letter spacing are shares of. */
  spaceAdv: number
  /** Its characters' own paint (colour per character), and a key for it; null for the text's. */
  paint: CharPaint | null
  paintKey: string | null
  /** The hyphen a line ending in it gets, made when first wanted. */
  hyphen?: { gid: number; ax: number }
}

/** A glyph as shaped, in pixels, by the character it belongs to. */
interface PGlyph {
  item: Item
  gid: number
  /** Its cluster's first character, in the paragraph. */
  cluster: number
  ax: number
  dx: number
  dy: number
}

interface Shaped {
  text: string
  items: Item[]
  /** Glyphs of each item, in the order HarfBuzz gives them (visual within the item). */
  glyphs: PGlyph[][]
  /** Each character's advance: its cluster's, on the cluster's first character; 0 on the rest. */
  adv: Float64Array
  /** Each character's cluster: [first, end). */
  clusterOf: Int32Array
  clusterEnd: Int32Array
  levels: Uint8Array
  baseRtl: boolean
  para: ParaProps
  /** Each character's settings. */
  charProps: CharProps[]
  missing: Set<string>
  pending: Set<string>
  /** Offsets a line may end at with a hyphen: soft hyphens and, hyphenating, the patterns' places. */
  hyphens: Set<number>
  /** The paragraph's space width at 100%: what letter spacing's percentages are of. */
  spaceUnit: number
}

/** The font's space, in font units, found once per font. */
const spaceUnits = new WeakMap<Font, number>()
function spaceOf(font: Font, upem: number): number {
  let v = spaceUnits.get(font)
  if (v === undefined) {
    v = font.shape(' ', 0, 1, 'ltr', '', '', [])[0]?.ax || upem / 4
    spaceUnits.set(font, v)
  }
  return v
}

/** A character's own paint, and a key that's the same for the same paint. */
function charPaint(p: CharProps): { paint: CharPaint | null; key: string | null } {
  if (!p.fill && !p.stroke) return { paint: null, key: null }
  const paint: CharPaint = { fill: p.fill, stroke: p.stroke, strokeWidth: p.strokeWidth }
  return { paint, key: JSON.stringify(paint) }
}

/** The hyphen a line ending in an item's text gets: the font's own, at the item's size and scaling. */
function hyphenOf(it: Item): { gid: number; ax: number } {
  if (!it.hyphen) {
    const g = it.font.shape('-', 0, 1, 'ltr', it.script, it.props.language, [])[0]
    it.hyphen = { gid: g?.gid ?? 0, ax: g ? g.ax * (it.props.size / it.upem) * (it.props.horizontalScale / 100) * it.glyphScale : it.props.size / 3 }
  }
  return it.hyphen
}

/** Characters' fonts: the run's, or a fallback that has the character. */
function shapeParagraph(text: string, runs: { start: number; end: number; props: CharProps }[], para: ParaProps, fonts: FontProvider): Shaped {
  const N = text.length
  const missing = new Set<string>()
  const pending = new Set<string>()
  const charProps: CharProps[] = new Array(N)
  for (const r of runs) for (let i = r.start; i < r.end; i++) charProps[i] = r.props

  // Bidi levels.
  const lv = N ? bidi.getEmbeddingLevels(text, para.direction === 'auto' ? undefined : para.direction) : { levels: new Uint8Array(0), paragraphs: [{ start: 0, end: 0, level: para.direction === 'rtl' ? 1 : 0 }] }
  const levels = lv.levels
  const baseRtl = (lv.paragraphs[0]?.level ?? (para.direction === 'rtl' ? 1 : 0)) % 2 === 1

  // Scripts, the common characters taking the one before (or after) them.
  const scripts: string[] = new Array(N)
  let last = ''
  for (let i = 0; i < N; ) {
    const cp = text.codePointAt(i)!
    const ch = String.fromCodePoint(cp)
    const s = scriptOf(ch) || last
    for (let k = 0; k < ch.length; k++) scripts[i + k] = s
    if (s) last = s
    i += ch.length
  }
  let next = ''
  for (let i = N - 1; i >= 0; i--) {
    if (scripts[i]) next = scripts[i]
    else scripts[i] = next || 'Latn'
  }

  // Fonts: the run's face, or the first fallback that has the character.
  const faces: { face: Face; coords: Record<string, number> }[] = new Array(N)
  const faceCache = new Map<string, { face: Face; coords: Record<string, number> } | null>()
  const runFace = (p: CharProps) => {
    const key = `${p.font}\u0000${p.style}`
    if (!faceCache.has(key)) {
      const got = fonts.face(p.font, p.style)
      // A font still loading isn't missing: the default stands in until it arrives, and nothing is said.
      if (!got) (fonts.pending?.(p.font, p.style) ? pending : missing).add(`${p.font} ${p.style}`.trim())
      faceCache.set(key, got)
    }
    return faceCache.get(key) ?? fonts.defaultFace()
  }
  // Each face entry's font, found once (Face.font makes a key of its coordinates each time it's asked).
  const fontOf = new Map<{ face: Face; coords: Record<string, number> }, Font>()
  const fontFor = (f: { face: Face; coords: Record<string, number> }) => {
    let x = fontOf.get(f)
    if (!x) fontOf.set(f, (x = f.face.font(f.coords)))
    return x
  }
  // One entry per fallback face: characters set in the same one are then one item, shaped together.
  const fallbackEntries = new Map<Face, { face: Face; coords: Record<string, number> }>()
  const fallbackEntry = (face: Face) => {
    let e = fallbackEntries.get(face)
    if (!e) fallbackEntries.set(face, (e = { face, coords: {} }))
    return e
  }
  for (let i = 0; i < N; ) {
    const cp = text.codePointAt(i)!
    const len = cp > 0xffff ? 2 : 1
    let f = runFace(charProps[i])
    // Marks stay with their base (none is below U+0300); spaces and controls with the run's font.
    if (i > 0 && cp >= 0x300 && isMark(String.fromCodePoint(cp))) f = faces[i - 1]
    else if (cp > 0x20 && !isSpace(cp) && !fontFor(f).hasGlyph(cp)) {
      const alt = fonts.fallbacks(scripts[i]).find((x) => fontFor(fallbackEntry(x)).hasGlyph(cp))
      if (alt) f = fallbackEntry(alt)
    }
    for (let k = 0; k < len; k++) faces[i + k] = f
    i += len
  }

  // Items: one font, settings, direction and script.
  const items: Item[] = []
  for (let i = 0; i < N; ) {
    let j = i + 1
    while (j < N && faces[j] === faces[i] && charProps[j] === charProps[i] && levels[j] === levels[i] && scripts[j] === scripts[i]) j++
    const p = charProps[i]
    const f = faces[i]
    const font = f.face.font({ ...f.coords, ...p.variations })
    const upem = f.face.info.upem
    const spaceAdv = spaceOf(font, upem) * (p.size / upem) * (p.horizontalScale / 100)
    const cp = charPaint(p)
    items.push({
      start: i,
      end: j,
      props: p,
      font,
      upem,
      rtl: levels[i] % 2 === 1,
      script: scripts[i],
      track: (p.tracking / 1000) * p.size + (para.letterSpacing[1] / 100) * spaceAdv,
      glyphScale: para.glyphScaling[1] / 100,
      spaceAdv,
      paint: cp.paint,
      paintKey: cp.key,
    })
    i = j
  }

  // Shape each item, in context.
  const adv = new Float64Array(N)
  const clusterOf = new Int32Array(N).fill(-1)
  const clusterEnd = new Int32Array(N)
  const glyphs: PGlyph[][] = []
  for (const it of items) {
    const p = it.props
    const features = [...p.features]
    if (p.kerning === 'none') features.push('kern=0')
    const shaped: ShapedGlyph[] = it.font.shape(text, it.start, it.end - it.start, it.rtl ? 'rtl' : 'ltr', it.script, p.language, features)
    const s = p.size / it.upem
    const hs = p.horizontalScale / 100
    const wordSpace = para.wordSpacing[1] / 100
    // Spaces at the wanted word spacing, everything else at the wanted glyph scaling.
    const list: PGlyph[] = shaped.map((g) => {
      const k = isSpace(text.charCodeAt(g.cluster)) ? wordSpace : it.glyphScale
      return { item: it, gid: g.gid, cluster: g.cluster, ax: g.ax * s * hs * k, dx: g.dx * s * hs * k, dy: g.dy * s }
    })
    glyphs.push(list)
    // Clusters in logical order: each starts at its smallest offset.
    const starts = [...new Set(list.map((g) => g.cluster))].sort((a, b) => a - b)
    for (let k = 0; k < starts.length; k++) {
      const c0 = starts[k]
      const c1 = k + 1 < starts.length ? starts[k + 1] : it.end
      for (let q = c0; q < c1; q++) {
        clusterOf[q] = c0
        clusterEnd[q] = c1
      }
    }
    for (const g of list) adv[g.cluster] += g.ax
    for (const c0 of starts) adv[c0] += it.track
  }
  for (let i = 0; i < N; i++) {
    if (clusterOf[i] < 0) {
      clusterOf[i] = i
      clusterEnd[i] = i + 1
    }
    // A tab's width depends on where it falls (placeLine); for breaking, a default stop's worth.
    if (text.charCodeAt(i) === TAB) adv[i] = para.tabInterval || charProps[i].size * 4
  }
  const spaceUnit = items[0]?.spaceAdv ?? (charProps[0]?.size ?? 12) / 4
  return { text, items, glyphs, adv, clusterOf, clusterEnd, levels, baseRtl, para, charProps, missing, pending, hyphens: new Set(), spaceUnit }
}

/** Break opportunities (UAX #14): offsets a line may end at, the ones it must, and those after a soft hyphen. */
function breaks(text: string): { at: number; required: boolean; hyphen: boolean }[] {
  const out: { at: number; required: boolean; hyphen: boolean }[] = []
  if (!text) return [{ at: 0, required: true, hyphen: false }]
  const lb = new LineBreaker(text)
  for (let b = lb.nextBreak(); b; b = lb.nextBreak()) out.push({ at: b.position, required: b.required, hyphen: !b.required && text.charCodeAt(b.position - 1) === 0xad })
  if (!out.length || out[out.length - 1].at !== text.length) out.push({ at: text.length, required: true, hyphen: false })
  return out
}

interface Segment {
  start: number
  end: number
  /** Width without its trailing spaces, which hang past the line's end. */
  width: number
  trail: number
  /** How many spaces it has, trailing included: where justification goes. */
  spaces: number
  trailSpaces: number
  /** How wide its spaces are, not counting trailing ones: what can stretch and shrink. */
  spaceWidth: number
  required: boolean
  /** The hyphen's width when a line ends here inside a word; 0 for a break between words. */
  hyphen: number
  /** Its letters (clusters that aren't spaces) and their width: what letter spacing and glyph scaling work on. */
  letters: number
  glyphWidth: number
}

/**
 * A paragraph's segments: from break to break, the breaks being UAX #14's,
 * soft hyphens, and (hyphenating) the places the patterns allow in each
 * word long enough, kept clear of its ends; capitalized words only when
 * the paragraph says so. A word whose language's patterns aren't loaded
 * yet doesn't break (they're asked for, and text is laid out again).
 */
function segments(sh: Shaped, hyph?: Hyphenator): Segment[] {
  const bs = breaks(sh.text)
  const hy = sh.para.hyphenation
  if (sh.para.hyphenate && hyph && sh.text) {
    const extra: number[] = []
    for (const m of sh.text.matchAll(/\p{L}[\p{L}\p{M}]*/gu)) {
      const word = m[0]
      const start = m.index ?? 0
      if (word.length <= hy.minWord || (!hy.caps && /^\p{Lu}/u.test(word))) continue
      const pts = hyph.points(word, sh.charProps[start]?.language ?? 'en')
      if (!pts) continue
      for (const p of pts) if (p >= hy.minBefore && word.length - p >= hy.minAfter) extra.push(start + p)
    }
    if (extra.length) {
      const have = new Set(bs.map((b) => b.at))
      for (const at of extra) if (!have.has(at)) bs.push({ at, required: false, hyphen: true })
      bs.sort((a, b) => a.at - b.at)
    }
  }
  const out: Segment[] = []
  let prev = 0
  for (const b of bs) {
    if (b.at <= prev && b.at !== 0) continue
    if (b.hyphen) sh.hyphens.add(b.at)
    out.push(measure(sh, prev, b.at, b.required, b.hyphen ? hyphenWidth(sh, b.at) : 0))
    prev = b.at
  }
  return out
}

/** The item a character is set in. */
function itemAt(sh: Shaped, i: number): Item | undefined {
  for (const it of sh.items) if (i >= it.start && i < it.end) return it
  return undefined
}

/** How wide the hyphen is for a line ending at `at`: the font's of the character before it. */
function hyphenWidth(sh: Shaped, at: number): number {
  const it = itemAt(sh, at - 1)
  return it ? hyphenOf(it).ax : 0
}

/** A stretch of a paragraph [start, end) as a segment: its widths and spaces. */
function measure(sh: Shaped, start: number, end: number, required: boolean, hyphen = 0): Segment {
  let width = 0
  let spaces = 0
  let spaceWidth = 0
  let letters = 0
  let glyphWidth = 0
  for (let i = start; i < end; i++) {
    width += sh.adv[i]
    const code = sh.text.charCodeAt(i)
    if (isSpace(code)) {
      spaces++
      spaceWidth += sh.adv[i]
    } else if (code !== TAB && sh.clusterOf[i] === i && sh.adv[i] > 0) {
      letters++
      glyphWidth += sh.adv[i]
    }
  }
  let trail = 0
  let trailSpaces = 0
  for (let i = end - 1; i >= start && (isSpace(sh.text.charCodeAt(i)) || sh.text.charCodeAt(i) === 0x2028); i--) {
    trail += sh.adv[i]
    if (isSpace(sh.text.charCodeAt(i))) {
      trailSpaces++
      spaceWidth -= sh.adv[i]
    }
  }
  return { start, end, width: width - trail, trail, spaces, trailSpaces, spaceWidth, required, hyphen, letters, glyphWidth }
}

/** Where a too-long segment can be cut: at cluster boundaries. */
function splitSegment(sh: Shaped, seg: Segment, width: number): Segment[] {
  const out: Segment[] = []
  let s = seg.start
  let w = 0
  for (let i = seg.start; i < seg.end; i = sh.clusterEnd[i]) {
    const a = sh.adv[i]
    if (w + a > width && i > s) {
      out.push(measure(sh, s, i, false))
      s = i
      w = 0
    }
    w += a
  }
  out.push(measure(sh, s, seg.end, seg.required, seg.hyphen))
  return out
}

/** The segments from offset `from` on, the first cut to start there. */
function segmentsFrom(sh: Shaped, segs: Segment[], from: number): Segment[] {
  const out: Segment[] = []
  for (const g of segs) {
    if (g.end <= from) continue
    out.push(g.start < from ? measure(sh, from, g.end, g.required, g.hyphen) : g)
  }
  return out
}

/**
 * Single-line composer: each line as full as it will go. Returns each
 * line's end offset. A line ends at the last break that fits: a hyphen
 * only where the hyphen fits too, not more lines in a row than the
 * paragraph's limit, and (with a hyphenation zone) not when the line
 * already reaches within the zone of its end without it.
 */
function composeGreedy(sh: Shaped, input: Segment[], widthAt: (line: number) => number): number[] {
  const hy = sh.para.hyphenation
  const segs = input.slice()
  const ends: number[] = []
  let line = 0
  let run = 0
  let k = 0
  while (k < segs.length) {
    const avail = widthAt(line)
    let w = 0
    let trail = 0
    let started = false
    let wordEnd = -1
    let wordW = 0
    let hyphEnd = -1
    let j = k
    let forced = false
    for (; j < segs.length; j++) {
      const seg = segs[j]
      // A segment too long for a whole line is cut where it must be.
      if (!started && seg.width > avail + 1e-6 && seg.end - seg.start > 1) {
        const parts = splitSegment(sh, seg, avail)
        if (parts.length > 1) segs.splice(j, 1, ...parts)
      }
      const s = segs[j]
      const nw = (started ? w + trail : 0) + s.width
      if (started && nw > avail + 1e-6) break
      w = nw
      trail = s.trail
      started = true
      if (s.hyphen > 0) {
        if (nw + s.hyphen <= avail + 1e-6) hyphEnd = j
      } else {
        wordEnd = j
        wordW = nw
      }
      if (s.required) {
        forced = true
        j++
        break
      }
    }
    if (forced || j >= segs.length) {
      ends.push(segs[j - 1].end)
      run = 0
      line++
      k = j
      continue
    }
    // Past the line's end at segment j: end at the latest break allowed.
    const hyphenOk = hyphEnd > wordEnd && (hy.limit === 0 || run < hy.limit) && (hy.zone <= 0 || wordEnd < k || avail - wordW > hy.zone)
    let end = hyphenOk ? hyphEnd : wordEnd
    if (end < k) end = hyphEnd >= k ? hyphEnd : Math.max(k, j - 1)
    ends.push(segs[end].end)
    run = segs[end].hyphen > 0 ? run + 1 : 0
    line++
    k = end + 1
  }
  if (!ends.length) ends.push(sh.text.length)
  return ends
}

/**
 * Every-line composer (Knuth and Plass): the breaks that make the whole
 * paragraph best. Justified, lines are scored by how far they must stretch
 * or shrink, against what their word spaces, letter spacing and glyph
 * scaling may give within the paragraph's ranges; otherwise by the square of
 * the space left at their end, the least ragged edge. A line ending in a
 * hyphen costs more, two in a row more again, and more in a row than the
 * limit aren't allowed. The last line is free.
 */
function composeOptimal(sh: Shaped, segs: Segment[], width: number, justified: boolean, firstIndent: number): number[] | null {
  const n = segs.length
  if (n > 3000) return null
  const para = sh.para
  const [wMin, wDes, wMax] = para.wordSpacing
  const [lMin, lDes, lMax] = para.letterSpacing
  const [gMin, gDes, gMax] = para.glyphScaling
  const unit = sh.spaceUnit
  const limit = para.hyphenation.limit
  const hyphenCost = justified ? 2500 : (width * 0.15) ** 2
  const best = new Float64Array(n + 1).fill(Infinity)
  const from = new Int32Array(n + 1).fill(-1)
  const run = new Int32Array(n + 1)
  best[0] = 0
  // Required breaks split the problem: a line never runs past one.
  for (let i = 0; i < n; i++) {
    if (best[i] === Infinity) continue
    let w = 0
    let spaceW = 0
    let letters = 0
    let glyphW = 0
    const avail = width - (i === 0 ? firstIndent : 0)
    for (let j = i; j < n; j++) {
      const s = segs[j]
      const last = j === n - 1 || s.required
      const hy = !last && s.hyphen > 0 ? s.hyphen : 0
      const natural = w + s.width + hy
      // The spaces between this line's segments (the trailing ones of all but its last) and inside them.
      const inner = spaceW + s.spaceWidth
      letters += s.letters
      glyphW += s.glyphWidth
      const gaps = Math.max(0, letters - 1)
      const stretch = (inner * (wMax - wDes)) / Math.max(1, wDes) + (gaps * unit * (lMax - lDes)) / 100 + (glyphW * (gMax - gDes)) / Math.max(1, gDes)
      const shrink = justified ? (inner * (wDes - wMin)) / Math.max(1, wDes) + (gaps * unit * (lDes - lMin)) / 100 + (glyphW * (gDes - gMin)) / Math.max(1, gDes) : 0
      const slack = avail - natural
      let cost: number
      if (natural - shrink > avail + 1e-6) {
        // Too long: allowed only for a line of one segment, which can't be helped.
        if (j > i) break
        cost = 1e6
      } else if (last) cost = slack < 0 ? 100 : 0
      else if (justified) {
        // A line with nothing to stretch (one word) is as bad as a line can be, worse than any loose line with spaces.
        const r = Math.abs(slack) < 1e-6 ? 0 : slack > 0 ? (stretch > 1e-6 ? slack / stretch : 100) : shrink > 1e-6 ? slack / shrink : -100
        const bad = 100 * Math.min(Math.abs(r), 100) ** 3
        cost = (1 + bad) ** 2
      } else cost = slack * slack
      const allowed = !hy || limit === 0 || run[i] < limit
      if (hy) cost += hyphenCost + (run[i] ? 3000 : 0)
      const total = best[i] + cost
      if (allowed && total < best[j + 1]) {
        best[j + 1] = total
        from[j + 1] = i
        run[j + 1] = hy ? run[i] + 1 : 0
      }
      if (s.required && j < n - 1) break
      w = natural - hy + s.trail
      spaceW = inner + s.trail
    }
  }
  if (best[n] === Infinity) return null
  const cuts: number[] = []
  for (let k = n; k > 0; k = from[k]) {
    if (from[k] < 0) return null
    cuts.unshift(segs[k - 1].end)
  }
  return cuts
}

// --- lines into glyphs ----------------------------------------------------------------------------

interface Placed {
  glyphs: { outline: number[]; m: number[]; item: Item }[]
  boxes: [number, number][]
  charRtl: boolean[]
  width: number
}

/** What a justified line adds: after each inner word space, after each letter but the last, and to glyphs' width (a share). */
interface Just {
  space: number
  letter: number
  scale: number
}
const NO_JUST: Just = { space: 0, letter: 0, scale: 0 }

/** A paragraph's tab stops for one line: `offset` is how far the line starts from where they're measured (the first line's indent). */
interface Tabs {
  stops: TabStop[]
  interval: number
  offset: number
}

/**
 * One line of a paragraph, [s, e), laid out left to right from x = 0:
 * its pieces in visual order (rule L2), glyphs placed on baseline 0 (y
 * down), justified by `just`, tabs moved to their stops, a hyphen at its
 * end when it breaks a word.
 */
function placeLine(sh: Shaped, s: number, e: number, just: Just, hyphen: boolean, tabs: Tabs | null): Placed {
  // Trailing spaces hang: drawn, but not counted in the line's width.
  let contentEnd = e
  while (contentEnd > s && (isSpace(sh.text.charCodeAt(contentEnd - 1)) || sh.text.charCodeAt(contentEnd - 1) === 0x2028)) contentEnd--
  // The last letter's cluster: no letter spacing after it.
  const lastCluster = contentEnd > s ? sh.clusterOf[contentEnd - 1] : -1
  const pieces: { item: number; glyphs: PGlyph[]; level: number }[] = []
  sh.items.forEach((it, k) => {
    if (it.end <= s || it.start >= e) return
    const gs = sh.glyphs[k].filter((g) => g.cluster >= s && g.cluster < e)
    if (gs.length) pieces.push({ item: k, glyphs: gs, level: sh.levels[Math.max(s, it.start)] })
  })
  // Reverse runs of pieces from the highest level down to the lowest odd one.
  const maxLevel = Math.max(0, ...pieces.map((p) => p.level))
  const minOdd = Math.min(...pieces.map((p) => p.level).filter((l) => l % 2 === 1), Infinity)
  for (let level = maxLevel; level >= minOdd && level > 0; level--) {
    for (let i = 0; i < pieces.length; ) {
      if (pieces[i].level < level) {
        i++
        continue
      }
      let j = i
      while (j < pieces.length && pieces[j].level >= level) j++
      pieces.splice(i, j - i, ...pieces.slice(i, j).reverse())
      i = j
    }
  }
  const boxes: [number, number][] = Array.from({ length: e - s }, () => [0, 0] as [number, number])
  const charRtl: boolean[] = Array.from({ length: e - s }, (_, i) => sh.levels[s + i] % 2 === 1)
  const glyphs: Placed['glyphs'] = []
  const k = 1 + just.scale
  let x = 0
  /** A tab at `x`: where the text after it starts, its leader drawn in the gap. */
  const tabTo = (it: Item, cluster: number): number => {
    let next = cluster + 1
    while (next < contentEnd && sh.text.charCodeAt(next) !== TAB) next++
    let after = 0
    for (let q = cluster + 1; q < next; q++) after += sh.adv[q]
    const stops = tabs!.stops
    const stop = stops.find((t) => t.at - tabs!.offset > x + 0.5)
    const interval = tabs!.interval || it.props.size * 4
    const at = stop ? stop.at - tabs!.offset : (Math.floor((x + tabs!.offset) / interval + 1e-9) + 1) * interval - tabs!.offset
    let start = at
    if (stop?.align === 'right') start = at - after
    else if (stop?.align === 'centre') start = at - after / 2
    else if (stop?.align === 'decimal') {
      let upTo = 0
      for (let q = cluster + 1; q < next && sh.text[q] !== stop.char; q++) upTo += sh.adv[q]
      start = at - upTo
    }
    start = Math.max(start, x)
    if (stop?.leader && start > x) {
      // The leader repeated across the gap, on a grid from the stop so leaders line up from line to line.
      const lg = it.font.shape(stop.leader, 0, stop.leader.length, 'ltr', it.script, it.props.language, [])
      const scale = it.props.size / it.upem
      const hs = it.props.horizontalScale / 100
      const lw = lg.reduce((n, g) => n + g.ax, 0) * scale * hs
      if (lw > 0.01) {
        for (let p = at - Math.floor((at - x) / lw) * lw; p + lw <= start + 1e-6; p += lw) {
          let gx = p
          for (const g of lg) {
            const o = it.font.outline(g.gid)
            if (o.length) glyphs.push({ outline: o, m: [scale * hs, 0, 0, -(scale * it.props.verticalScale) / 100, gx + g.dx * scale * hs, -g.dy * scale - it.props.baselineShift], item: it })
            gx += g.ax * scale * hs
          }
        }
      }
    }
    return start
  }
  for (const piece of pieces) {
    const it = sh.items[piece.item]
    const p = it.props
    const scale = p.size / it.upem
    const hs = p.horizontalScale / 100
    const vs = p.verticalScale / 100
    // Each cluster's span on screen, as its glyphs go by.
    const spans = new Map<number, [number, number]>()
    for (let gi = 0; gi < piece.glyphs.length; gi++) {
      const g = piece.glyphs[gi]
      const code = sh.text.charCodeAt(g.cluster)
      const tab = code === TAB
      const space = isSpace(code)
      // Justification's glyph scaling: letters only.
      const gk = space || tab ? 1 : k
      const outline = tab ? [] : it.font.outline(g.gid)
      if (outline.length) glyphs.push({ outline, m: [scale * hs * (space ? 1 : it.glyphScale) * gk, 0, 0, -scale * vs, x + g.dx * gk, -g.dy - p.baselineShift], item: it })
      const begin = x
      if (tab && tabs && !it.rtl) x = tabTo(it, g.cluster)
      else x += g.ax * gk
      // A cluster's last glyph (in visual order, where the next one's cluster differs) takes the tracking and any justification.
      if (piece.glyphs[gi + 1]?.cluster !== g.cluster) {
        if (!tab) x += it.track
        if (just.space && space && g.cluster < contentEnd) x += just.space
        if (just.letter && !space && !tab && g.cluster !== lastCluster && g.cluster < contentEnd) x += just.letter
      }
      const span = spans.get(g.cluster)
      spans.set(g.cluster, span ? [Math.min(span[0], begin), Math.max(span[1], x)] : [begin, x])
    }
    // Characters' boxes: a cluster's span shared evenly, in reading order.
    for (const [c0, [l, r]] of spans) {
      const c1 = Math.min(sh.clusterEnd[c0], e)
      const count = Math.max(1, c1 - c0)
      for (let q = c0; q < c1; q++) {
        const f0 = (q - c0) / count
        const f1 = (q - c0 + 1) / count
        boxes[q - s] = it.rtl ? [r - (r - l) * f1, r - (r - l) * f0] : [l + (r - l) * f0, l + (r - l) * f1]
      }
    }
  }
  // The width that counts: up to the last character that isn't a trailing space.
  let width = 0
  for (let q = s; q < contentEnd; q++) width = Math.max(width, boxes[q - s][1])
  // A word broken at the line's end: its hyphen, after it.
  if (hyphen && !sh.baseRtl && e > s) {
    const it = itemAt(sh, e - 1)
    if (it) {
      const h = hyphenOf(it)
      const scale = it.props.size / it.upem
      const o = it.font.outline(h.gid)
      if (o.length) glyphs.push({ outline: o, m: [scale * (it.props.horizontalScale / 100) * it.glyphScale, 0, 0, -scale * (it.props.verticalScale / 100), width, -it.props.baselineShift], item: it })
      width += h.ax
    }
  }
  return { glyphs, boxes, charRtl, width }
}

/** The free stretch of a frame across a band of rows: the widest run inside it at the band's top, middle and bottom. */
function frameSpan(polys: number[][], y0: number, y1: number): [number, number] | null {
  const at = (y: number): [number, number][] => {
    const xs: { x: number; d: number }[] = []
    for (const pts of polys) {
      const n = pts.length / 2
      for (let i = 0; i < n; i++) {
        const ax = pts[i * 2]
        const ay = pts[i * 2 + 1]
        const bx = pts[((i + 1) % n) * 2]
        const by = pts[((i + 1) % n) * 2 + 1]
        if (ay <= y === by <= y) continue
        xs.push({ x: ax + ((bx - ax) * (y - ay)) / (by - ay), d: by > ay ? 1 : -1 })
      }
    }
    xs.sort((a, b) => a.x - b.x)
    const out: [number, number][] = []
    let wn = 0
    for (let k = 0; k < xs.length; k++) {
      const was = wn
      wn += xs[k].d
      if (was === 0 && wn !== 0) out.push([xs[k].x, xs[k].x])
      else if (was !== 0 && wn === 0 && out.length) out[out.length - 1][1] = xs[k].x
    }
    return out
  }
  // The intersection of the spans at three heights, its widest piece.
  let spans = at(y0 + 1e-6)
  for (const y of [(y0 + y1) / 2, y1 - 1e-6]) {
    const other = at(y)
    const next: [number, number][] = []
    for (const a of spans) for (const b of other) if (Math.min(a[1], b[1]) > Math.max(a[0], b[0])) next.push([Math.max(a[0], b[0]), Math.min(a[1], b[1])])
    spans = next
  }
  if (!spans.length) return null
  return spans.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a))
}

/** A line's height above and below its baseline: its biggest font's ascent and descent. */
function lineMetrics(sh: Shaped, s: number, e: number): { ascent: number; descent: number; leading: number } {
  let ascent = 0
  let descent = 0
  let leading = 0
  const seen = new Set<Item>()
  for (const it of sh.items) {
    if (it.end <= s || it.start >= e || seen.has(it)) continue
    seen.add(it)
    const m = it.font.metrics()
    const k = (it.props.size / it.upem) * (it.props.verticalScale / 100)
    ascent = Math.max(ascent, m.ascender * k + Math.max(0, it.props.baselineShift))
    descent = Math.max(descent, -m.descender * k - Math.min(0, it.props.baselineShift))
    leading = Math.max(leading, leadingOf(it.props, sh.para.autoLeading))
  }
  if (!seen.size) {
    // An empty line: the settings typing there would get.
    const p = sh.charProps[s] ?? sh.charProps[s - 1]
    if (p) {
      ascent = p.size * 0.8
      descent = p.size * 0.2
      leading = leadingOf(p, sh.para.autoLeading)
    }
  }
  return { ascent, descent, leading }
}

// --- the whole text --------------------------------------------------------------------------------

/** Lays text out: its glyphs, its lines, whether it overflows. */
/**
 * A paragraph shaped, split into segments, and broken into lines, with each
 * line's glyphs placed, for each width it's been set at, kept by the
 * paragraph object: an edit replaces only the paragraphs it touches
 * (doc/text.ts), so typing in one paragraph of a long story shapes, breaks
 * and places that one, and only moves the rest. Valid for the same provider
 * at the same version, and the same styles.
 */
interface ParaCache {
  fonts: FontProvider
  version: number
  /** The hyphenator's version: patterns arriving break words anew. */
  hyph: number
  styles: TextStyles | undefined
  sh: Shaped
  segs: Segment[]
  /** By what it was composed for (`composeKey`): the line ends, and each line placed (by start, end and justification). */
  set: Map<string, { ends: number[]; placed: Map<string, Placed> }>
}

/** Widths kept for a paragraph: a frame dragged wider sets it at many, and only the last few are likely again. */
const WIDTHS_KEPT = 4
const paraCache = new WeakMap<Paragraph, ParaCache>()

export function layoutText(input: LayoutInput, fonts: FontProvider): TextLayout {
  const styles = input.styles
  const outlines: number[][] = []
  const outlineIndex = new Map<number[], number>()
  const placements: number[] = []
  const lines: Line[] = []
  const missing = new Set<string>()
  const pending = new Set<string>()
  let overflow = false
  const hyphVersion = input.hyphenator?.version ?? 0
  // Colour per character: each glyph's paint by index, the paints in order of first use.
  const paints: CharPaint[] = []
  const paintIndex = new Map<string, number>()
  const paintOf: number[] = []
  const paintOfItem = (it: Item | null): number => {
    if (!it?.paintKey) return -1
    let k = paintIndex.get(it.paintKey)
    if (k === undefined) {
      k = paints.length
      paints.push(it.paint!)
      paintIndex.set(it.paintKey, k)
    }
    return k
  }

  const place = (outline: number[], m: number[], it: Item | null) => {
    let k = outlineIndex.get(outline)
    if (k === undefined) {
      k = outlines.length
      outlines.push(outline)
      outlineIndex.set(outline, k)
    }
    placements.push(k, ...m)
    paintOf.push(paintOfItem(it))
  }
  const UNIT_SQUARE = [0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 4]
  // A bar from x0 to x1, h thick about yc: an underline or a strikethrough, as a unit square placed.
  const rect = (x0: number, x1: number, yc: number, h: number, it: Item) => {
    if (x1 > x0 && h > 0) place(UNIT_SQUARE, [x1 - x0, 0, 0, h, x0, yc - h / 2], it)
  }

  // The frame: area text's polygon and box; path text's polyline.
  const framePolys = input.frame ? pathPolys(input.frame) : []
  let fx0 = 0
  let fy0 = 0
  let fx1 = 0
  let fy1 = 0
  if (framePolys.length) {
    fx0 = Infinity
    fy0 = Infinity
    fx1 = -Infinity
    fy1 = -Infinity
    for (const pts of framePolys)
      for (let i = 0; i < pts.length; i += 2) {
        fx0 = Math.min(fx0, pts[i])
        fx1 = Math.max(fx1, pts[i])
        fy0 = Math.min(fy0, pts[i + 1])
        fy1 = Math.max(fy1, pts[i + 1])
      }
  }
  const area = input.mode === 'area' && framePolys.length > 0
  const onPath = input.mode === 'path' && framePolys.length > 0
  const rectFrame = area && isRect(framePolys)

  // Path text is one line: its paragraphs run on, joined by spaces.
  const content: TextContent = onPath
    ? { paragraphs: [{ ...input.content.paragraphs[0], runs: input.content.paragraphs.flatMap((p, i) => (i ? [{ text: ' ', style: p.runs[0].style, props: p.runs[0].props }, ...p.runs] : p.runs)) }] }
    : input.content

  let y = area ? fy0 : 0
  let first = true
  let posBase = 0
  for (let pi = 0; pi < content.paragraphs.length; pi++) {
    const p = content.paragraphs[pi]
    const text = paragraphText(p)
    const para = resolvePara(p, styles)
    // Path text's paragraph is made afresh each time (above), so there's nothing to keep.
    const keep = !onPath && fonts.version !== undefined
    let cached = keep ? paraCache.get(p) : undefined
    if (cached && (cached.fonts !== fonts || cached.version !== fonts.version || cached.styles !== styles || cached.hyph !== hyphVersion)) cached = undefined
    if (!cached) {
      const runs: { start: number; end: number; props: CharProps }[] = []
      let at = 0
      for (const r of p.runs) {
        runs.push({ start: at, end: at + r.text.length, props: resolveChar(r, p, styles) })
        at += r.text.length
      }
      // An empty paragraph still has its run's settings, for its line's height.
      const shaped = shapeParagraph(text, runs.length ? runs : [{ start: 0, end: 0, props: resolveChar({ style: null, props: {} }, p, styles) }], para, fonts)
      if (!text.length) shaped.charProps[0] = runs[0]?.props ?? resolveChar({ style: null, props: {} }, p, styles)
      cached = { fonts, version: fonts.version ?? 0, hyph: hyphVersion, styles, sh: shaped, segs: segments(shaped, input.hyphenator), set: new Map() }
      if (keep) paraCache.set(p, cached)
    }
    const { sh, segs } = cached
    for (const m of sh.missing) missing.add(m)
    for (const m of sh.pending) pending.add(m)
    if (!first) y += para.spaceBefore

    // Line widths: area text's frame (less indents); point and path text don't wrap.
    const indentStart = para.indentLeft
    const indentEnd = para.indentRight
    const fullWidth = area ? fx1 - fx0 - indentStart - indentEnd : Infinity
    const widthAt = (line: number) => (area ? fullWidth - (line === 0 ? para.indentFirst : 0) : Infinity)
    // Kept with the paragraph, by what they depend on; a shaped frame's are worked out below, line by line, where they fall.
    const composeKey = !area ? 'free' : rectFrame ? `${fullWidth}|${para.indentFirst}|${para.composer}|${para.align}` : null
    // Tab stops are measured from the paragraph's start edge: the first line starts its indent along.
    const tabsFor = (li: number): Tabs => ({ stops: para.tabs, interval: para.tabInterval, offset: area && li === 0 ? para.indentFirst : 0 })
    let ends: number[]
    let kept = composeKey !== null ? cached.set.get(composeKey) : undefined
    if (kept) ends = kept.ends
    else if (!area) ends = composeGreedy(sh, segs, () => Infinity)
    else if (rectFrame && para.composer === 'every') ends = composeOptimal(sh, segs, fullWidth, para.align === 'justify' || para.align === 'justify-all', para.indentFirst) ?? composeGreedy(sh, segs, widthAt)
    else ends = area && !rectFrame ? [] : composeGreedy(sh, segs, widthAt)
    if (composeKey !== null && !kept) {
      kept = { ends, placed: new Map() }
      cached.set.set(composeKey, kept)
      if (cached.set.size > WIDTHS_KEPT) cached.set.delete(cached.set.keys().next().value!)
    }
    // A line placed, kept with the ends it was broken at; a shaped frame's lines are placed each time.
    const placedLine = (from: number, to: number, just: Just, li: number): Placed => {
      const hyphen = sh.hyphens.has(to) && to < text.length
      const tabs = tabsFor(li)
      if (!kept) return placeLine(sh, from, to, just, hyphen, tabs)
      const k = `${from}|${to}|${just.space}|${just.letter}|${just.scale}|${hyphen}|${tabs.offset}`
      let p = kept.placed.get(k)
      if (!p) kept.placed.set(k, (p = placeLine(sh, from, to, just, hyphen, tabs)))
      return p
    }

    // A shaped frame's lines: where each was broken, so it's set there.
    const tops: number[] = []
    if (area && !rectFrame) {
      // A shaped frame: lines broken one at a time, each as wide as the frame is where it falls.
      ends = []
      let s = 0
      let lineNo = 0
      let probeY = y
      while (s < text.length || (s === 0 && !text.length)) {
        const m = lineMetrics(sh, s, Math.min(text.length, s + 1))
        const top = probeY
        const span = frameSpan(framePolys, top, top + m.ascent + m.descent)
        if (!span) {
          probeY += m.leading || 1
          if (probeY > fy1) break
          continue
        }
        const w = span[1] - span[0] - indentStart - indentEnd - (lineNo === 0 ? para.indentFirst : 0)
        const rest = segmentsFrom(sh, segs, s)
        // Too narrow here for the next word: further down, unless no part of the frame is wide enough for it.
        if (rest.length && rest[0].width > w && rest[0].width <= fx1 - fx0 - indentStart - indentEnd) {
          probeY += m.leading || 1
          if (probeY > fy1) break
          continue
        }
        const one = composeGreedy(sh, rest.length ? rest : [measure(sh, s, text.length, true)], (k) => (k === 0 ? w : Infinity))
        const e = one[0] ?? text.length
        ends.push(e)
        tops.push(top)
        probeY += m.leading
        lineNo++
        if (e <= s) break
        s = e
        if (!text.length) break
      }
      if (!ends.length || ends[ends.length - 1] < text.length) {
        overflow = true
        if (!ends.length) ends = []
      }
    }

    let s = 0
    for (let li = 0; li < ends.length; li++) {
      const e = ends[li]
      if (e < s) continue
      const m = lineMetrics(sh, s, Math.max(e, s + 1))
      // First baseline: the line's ascent below the top for area text; the origin for point text.
      const baseline = tops[li] !== undefined ? tops[li] + m.ascent : area ? (first ? y + m.ascent : y + m.leading) : first ? 0 : y + m.leading
      if (area && baseline + m.descent > fy1 + 1e-6) {
        overflow = true
        break
      }
      const lastLine = li === ends.length - 1
      let x0 = 0
      let x1 = 0
      if (area) {
        const span = rectFrame ? [fx0, fx1] : (frameSpan(framePolys, baseline - m.ascent, baseline + m.descent) ?? [fx0, fx1])
        x0 = span[0] + (sh.baseRtl ? indentEnd : indentStart + (li === 0 ? para.indentFirst : 0))
        x1 = span[1] - (sh.baseRtl ? indentStart + (li === 0 ? para.indentFirst : 0) : indentEnd)
      }
      const natural = placedLine(s, e, NO_JUST, li)
      let just = NO_JUST
      let oneWord = false
      const justify = area && (para.align === 'justify-all' || (para.align === 'justify' && !lastLine))
      if (justify) {
        // Negative where the composer chose to tighten the line.
        const stats = lineStats(sh, s, e)
        oneWord = stats.spaces === 0
        just = justification(para, x1 - x0 - natural.width, stats, sh.spaceUnit)
      }
      const placed = just !== NO_JUST ? placedLine(s, e, just, li) : natural
      // Where the line starts: by alignment, in the frame or about the origin; a justified line of one word as the paragraph says.
      const align = oneWord && para.singleWord !== 'full' ? para.singleWord : para.align === 'justify' || para.align === 'justify-all' ? (sh.baseRtl ? 'right' : 'left') : para.align
      const startSide = sh.baseRtl ? (align === 'left' ? 'right' : align === 'right' ? 'left' : align) : align
      let ox: number
      if (area) ox = startSide === 'left' ? x0 : startSide === 'right' ? x1 - placed.width : (x0 + x1 - placed.width) / 2
      else ox = startSide === 'left' ? 0 : startSide === 'right' ? -placed.width : -placed.width / 2
      if (!area) {
        x0 = ox
        x1 = ox + placed.width
      }
      for (const g of placed.glyphs) place(g.outline, [g.m[0], g.m[1], g.m[2], g.m[3], g.m[4] + ox, g.m[5] + baseline], g.item)
      // Underline and strikethrough, run by run.
      for (const it of sh.items) {
        if (it.end <= s || it.start >= e || !(it.props.underline || it.props.strikethrough)) continue
        let l = Infinity
        let r = -Infinity
        for (let q = Math.max(s, it.start); q < Math.min(e, it.end); q++) {
          const b = placed.boxes[q - s]
          l = Math.min(l, b[0])
          r = Math.max(r, b[1])
        }
        const mt = it.font.metrics()
        const k = it.props.size / it.upem
        if (it.props.underline) rect(l + ox, r + ox, baseline - mt.underlineOffset * k, Math.max(1e-3, mt.underlineSize * k), it)
        if (it.props.strikethrough) rect(l + ox, r + ox, baseline - mt.strikeOffset * k, Math.max(1e-3, mt.strikeSize * k), it)
      }
      lines.push({
        para: pi,
        start: posBase + s,
        end: posBase + e,
        baseline,
        top: baseline - m.ascent,
        bottom: baseline + m.descent,
        x0,
        x1,
        rtl: sh.baseRtl,
        boxes: placed.boxes.map(([a, b]) => [a + ox, b + ox] as [number, number]),
        charRtl: placed.charRtl,
      })
      y = baseline
      first = false
      s = e
    }
    if (!ends.length && !area) {
      // Point text's empty paragraph: still a line, for the caret.
      const m = lineMetrics(sh, 0, 1)
      const baseline = first ? 0 : y + m.leading
      lines.push({ para: pi, start: posBase, end: posBase, baseline, top: baseline - m.ascent, bottom: baseline + m.descent, x0: 0, x1: 0, rtl: sh.baseRtl, boxes: [], charRtl: [] })
      y = baseline
      first = false
    }
    y += para.spaceAfter
    posBase += text.length + 1
    if (overflow) break
  }

  let glyphs: GlyphSet = paints.length ? { kind: 'glyphs', outlines, placements, paints, paintOf } : { kind: 'glyphs', outlines, placements }
  let pathStart: number | undefined
  if (onPath) {
    const r = alongPath(glyphs, lines, framePolys[0], input.pathOffset ?? 0, input.content.paragraphs[0] ? resolvePara(input.content.paragraphs[0], styles).align : 'left')
    glyphs = r.glyphs
    overflow = r.overflow
    pathStart = r.start
  }
  return { glyphs, lines, bounds: glyphsBounds(glyphs), overflow, missing: [...missing], pending: [...pending], pathStart }
}

/** What a line has to justify with: its inner word spaces and their width, its letters and theirs. */
function lineStats(sh: Shaped, s: number, e: number): { spaces: number; spaceWidth: number; letters: number; glyphWidth: number } {
  let contentEnd = e
  while (contentEnd > s && (isSpace(sh.text.charCodeAt(contentEnd - 1)) || sh.text.charCodeAt(contentEnd - 1) === 0x2028)) contentEnd--
  let spaces = 0
  let spaceWidth = 0
  let letters = 0
  let glyphWidth = 0
  for (let q = s; q < contentEnd; q++) {
    const code = sh.text.charCodeAt(q)
    if (isSpace(code)) {
      spaces++
      spaceWidth += sh.adv[q]
    } else if (code !== TAB && sh.clusterOf[q] === q && sh.adv[q] > 0) {
      letters++
      glyphWidth += sh.adv[q]
    }
  }
  return { spaces, spaceWidth, letters, glyphWidth }
}

/**
 * How a justified line takes up `slack` (negative to tighten): word
 * spaces within their least and most first, then letter spacing within
 * its, then glyphs' width within theirs; what's left goes to the word
 * spaces past their limits (or, with no spaces, the letters), as Photoshop
 * does. A line of one word is spread across its letters.
 */
function justification(para: ParaProps, slack: number, st: { spaces: number; spaceWidth: number; letters: number; glyphWidth: number }, unit: number): Just {
  const gaps = Math.max(0, st.letters - 1)
  if (!st.spaces) return para.singleWord === 'full' && gaps ? { space: 0, letter: slack / gaps, scale: 0 } : NO_JUST
  const [wMin, wDes, wMax] = para.wordSpacing
  const [lMin, lDes, lMax] = para.letterSpacing
  const [gMin, gDes, gMax] = para.glyphScaling
  const base = st.spaceWidth / Math.max(0.01, wDes / 100)
  let rest = slack
  let sp = 0
  let le = 0
  let sc = 0
  const take = (cap: number) => {
    const u = rest >= 0 ? Math.min(rest, Math.max(0, cap)) : Math.max(rest, -Math.max(0, cap))
    rest -= u
    return u
  }
  if (rest >= 0) {
    sp += take((base * (wMax - wDes)) / 100)
    le += take((gaps * unit * (lMax - lDes)) / 100)
    sc += take((st.glyphWidth * (gMax - gDes)) / Math.max(1, gDes))
  } else {
    sp += take((base * (wDes - wMin)) / 100)
    le += take((gaps * unit * (lDes - lMin)) / 100)
    sc += take((st.glyphWidth * (gDes - gMin)) / Math.max(1, gDes))
  }
  sp += rest
  return { space: sp / st.spaces, letter: gaps ? le / gaps : 0, scale: st.glyphWidth ? sc / st.glyphWidth : 0 }
}

/** Whether a frame is an upright rectangle: then every line is as wide as the next. */
function isRect(polys: number[][]): boolean {
  if (polys.length !== 1) return false
  // Four corners; a closed path comes back to its first (pathPolys), so a fifth equal to it is allowed.
  let p = polys[0]
  if (p.length === 10 && Math.abs(p[8] - p[0]) < 1e-9 && Math.abs(p[9] - p[1]) < 1e-9) p = p.slice(0, 8)
  if (p.length !== 8) return false
  for (let i = 0; i < 4; i++) {
    const ax = p[i * 2]
    const ay = p[i * 2 + 1]
    const bx = p[((i + 1) % 4) * 2]
    const by = p[((i + 1) % 4) * 2 + 1]
    if (Math.abs(ax - bx) > 1e-6 && Math.abs(ay - by) > 1e-6) return false
  }
  return true
}

/**
 * Path text: the line laid out flat, then each glyph moved onto the path,
 * its middle at its distance along it, turned to the path's direction
 * there. Glyphs past the path's end aren't drawn.
 */
/** A frame or text path flattened as layout reads it: a closed one ends back at its start, so text runs along its last side too. */
function alongPath(flat: GlyphSet, lines: Line[], pts: number[], offset: number, align: string): { glyphs: GlyphSet; overflow: boolean; start: number } {
  const n = pts.length / 2
  const cum = [0]
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]))
  const total = cum[n - 1]
  const line = lines[0]
  const width = line ? line.x1 - line.x0 : 0
  const startX = line ? line.x0 : 0
  const start = (align === 'right' ? total - width - offset : align === 'centre' ? (total - width) / 2 + offset : offset) - startX
  if (line) {
    line.x0 += start
    line.x1 += start
    line.boxes = line.boxes.map(([a, b]) => [a + start, b + start])
  }
  const at = (s: number): { x: number; y: number; a: number } | null => {
    if (s < 0 || s > total || n < 2) return null
    let k = 1
    while (k < n - 1 && cum[k] < s) k++
    const seg = cum[k] - cum[k - 1] || 1
    const t = (s - cum[k - 1]) / seg
    const ax = pts[(k - 1) * 2]
    const ay = pts[(k - 1) * 2 + 1]
    const bx = pts[k * 2]
    const by = pts[k * 2 + 1]
    return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, a: Math.atan2(by - ay, bx - ax) }
  }
  const placements: number[] = []
  const paintOf: number[] = []
  let overflow = false
  const p = flat.placements
  for (let i = 0; i < p.length; i += 7) {
    const [a, b, c, d, e, f] = p.slice(i + 1, i + 7)
    // The glyph's own box tells where its middle is.
    const outline = flat.outlines[p[i]]
    let ox0 = Infinity
    let ox1 = -Infinity
    for (let q = 0; q < outline.length; ) {
      const op = outline[q]
      const k = op === 0 || op === 1 ? 2 : op === 3 ? 6 : 0
      for (let j = 0; j < k; j += 2) {
        ox0 = Math.min(ox0, outline[q + 1 + j])
        ox1 = Math.max(ox1, outline[q + 1 + j])
      }
      q += 1 + k
    }
    const mid = ox0 === Infinity ? e : e + (a * (ox0 + ox1)) / 2
    const s = mid + start
    const pos = at(s)
    if (!pos) {
      overflow = overflow || s > total
      continue
    }
    const cos = Math.cos(pos.a)
    const sin = Math.sin(pos.a)
    // In the glyph's frame: x from its middle, y from the baseline; then turned and moved onto the path.
    const lx = e - mid
    const ly = f
    placements.push(p[i], cos * a - sin * b, sin * a + cos * b, cos * c - sin * d, sin * c + cos * d, pos.x + cos * lx - sin * ly, pos.y + sin * lx + cos * ly)
    paintOf.push(flat.paintOf?.[i / 7] ?? -1)
  }
  const glyphs: GlyphSet = flat.paints ? { kind: 'glyphs', outlines: flat.outlines, placements, paints: flat.paints, paintOf } : { kind: 'glyphs', outlines: flat.outlines, placements }
  return { glyphs, overflow, start }
}

/** The default font a document asks for, for messages. */
export const DEFAULT_FAMILY = DEFAULT_FONT
