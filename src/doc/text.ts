/**
 * Text, as a document holds it (ARCHITECTURE.md, "Type").
 *
 * A text node's content is paragraphs of runs. A run is text with a
 * character style (named, in the document, or none) and settings of its
 * own on top; a paragraph has a paragraph style and settings of its own.
 * Styles are named and based on one another; a paragraph style carries
 * character settings too, the default for its text, as InDesign's do.
 * What a character ends up with is the defaults, then the paragraph
 * style's chain, then the run's character style's chain, then the run's
 * own settings: `resolveChar`.
 *
 * Positions in text are UTF-16 offsets into the whole content with each
 * paragraph break counted as one character, so a selection can cross
 * paragraphs. The edits here are pure: content in, content out.
 */
import { isObject, type Warn } from './read'
import type { Doc } from './types'
import { deepEqual } from '../lib/equal'
import { clamp } from '../lib/num'

export interface CharProps {
  /** The font's family and style, as the font menu names them ("Inter Variable", "Bold"). */
  font: string
  style: string
  /** In document pixels. */
  size: number
  /** Baseline to baseline, in document pixels; null for auto (120% of the size). */
  leading: number | null
  /** Thousandths of an em added after each character, as Photoshop's tracking. */
  tracking: number
  kerning: 'metrics' | 'none'
  /** Up from the baseline, in document pixels. */
  baselineShift: number
  /** OpenType features as HarfBuzz writes them: "smcp", "liga=0", "ss01". */
  features: string[]
  /** Variation axes by tag ("wght": 650), over the style's own coordinates. */
  variations: Record<string, number>
  horizontalScale: number
  verticalScale: number
  underline: boolean
  strikethrough: boolean
  /** A BCP 47 language tag, for shaping (and hyphenation, later). */
  language: string
}

export type Align = 'left' | 'centre' | 'right' | 'justify' | 'justify-all'

export interface ParaProps {
  align: Align
  direction: 'auto' | 'ltr' | 'rtl'
  indentLeft: number
  indentRight: number
  indentFirst: number
  spaceBefore: number
  spaceAfter: number
  /** Single-line breaks each line as it comes; every-line (Knuth-Plass) weighs the whole paragraph. */
  composer: 'single' | 'every'
}

export interface Run {
  text: string
  style: string | null
  props: Partial<CharProps>
}

export interface Paragraph {
  runs: Run[]
  style: string | null
  props: Partial<ParaProps>
}

export interface TextContent {
  paragraphs: Paragraph[]
}

export interface CharStyle {
  id: string
  name: string
  basedOn: string | null
  char: Partial<CharProps>
}

export interface ParaStyle {
  id: string
  name: string
  basedOn: string | null
  para: Partial<ParaProps>
  /** The character settings its text starts from. */
  char: Partial<CharProps>
}

export interface TextStyles {
  character: CharStyle[]
  paragraph: ParaStyle[]
}

export const DEFAULT_FONT = 'Inter Variable'

export const DEFAULT_CHAR: CharProps = {
  font: DEFAULT_FONT,
  style: 'Regular',
  size: 48,
  leading: null,
  tracking: 0,
  kerning: 'metrics',
  baselineShift: 0,
  features: [],
  variations: {},
  horizontalScale: 100,
  verticalScale: 100,
  underline: false,
  strikethrough: false,
  language: 'en',
}

export const DEFAULT_PARA: ParaProps = {
  align: 'left',
  direction: 'auto',
  indentLeft: 0,
  indentRight: 0,
  indentFirst: 0,
  spaceBefore: 0,
  spaceAfter: 0,
  composer: 'every',
}

export const NO_STYLES: TextStyles = { character: [], paragraph: [] }

/** Auto leading: 120% of the size, as Photoshop and Illustrator have it. */
export const leadingOf = (c: CharProps) => c.leading ?? c.size * 1.2

// --- reading ---------------------------------------------------------------------------------

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const ALIGNS: Align[] = ['left', 'centre', 'right', 'justify', 'justify-all']
const TAG = /^[A-Za-z0-9 ]{4}$/
const FEATURE = /^[-+]?[A-Za-z0-9]{4}(\[[0-9:]*\])?(=[0-9a-z]+)?$/

/** Character settings read back: only the ones present, each in range; the rest are left to inherit. */
export function readCharProps(raw: unknown): Partial<CharProps> {
  if (!isObject(raw)) return {}
  const o: Partial<CharProps> = {}
  if (typeof raw.font === 'string' && raw.font) o.font = raw.font.slice(0, 200)
  if (typeof raw.style === 'string' && raw.style) o.style = raw.style.slice(0, 200)
  if (finite(raw.size)) o.size = clamp(raw.size, 0.1, 10000)
  if (raw.leading === null) o.leading = null
  else if (finite(raw.leading)) o.leading = clamp(raw.leading, 0, 20000)
  if (finite(raw.tracking)) o.tracking = clamp(raw.tracking, -1000, 10000)
  if (raw.kerning === 'metrics' || raw.kerning === 'none') o.kerning = raw.kerning
  if (finite(raw.baselineShift)) o.baselineShift = clamp(raw.baselineShift, -10000, 10000)
  if (Array.isArray(raw.features)) o.features = raw.features.filter((f): f is string => typeof f === 'string' && FEATURE.test(f)).slice(0, 64)
  if (isObject(raw.variations)) o.variations = Object.fromEntries(Object.entries(raw.variations).filter(([t, v]) => TAG.test(t) && finite(v)).slice(0, 32)) as Record<string, number>
  if (finite(raw.horizontalScale)) o.horizontalScale = clamp(raw.horizontalScale, 1, 1000)
  if (finite(raw.verticalScale)) o.verticalScale = clamp(raw.verticalScale, 1, 1000)
  if (typeof raw.underline === 'boolean') o.underline = raw.underline
  if (typeof raw.strikethrough === 'boolean') o.strikethrough = raw.strikethrough
  if (typeof raw.language === 'string' && /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(raw.language)) o.language = raw.language
  return o
}

export function readParaProps(raw: unknown): Partial<ParaProps> {
  if (!isObject(raw)) return {}
  const o: Partial<ParaProps> = {}
  if (ALIGNS.includes(raw.align as Align)) o.align = raw.align as Align
  if (raw.direction === 'auto' || raw.direction === 'ltr' || raw.direction === 'rtl') o.direction = raw.direction
  for (const k of ['indentLeft', 'indentRight', 'indentFirst', 'spaceBefore', 'spaceAfter'] as const) if (finite(raw[k])) o[k] = clamp(raw[k] as number, -100000, 100000)
  if (raw.composer === 'single' || raw.composer === 'every') o.composer = raw.composer
  return o
}

const readRef = (v: unknown) => (typeof v === 'string' && v ? v : null)

export function readTextContent(raw: unknown, warn: Warn): TextContent {
  const r = isObject(raw) ? raw : {}
  const paragraphs: Paragraph[] = []
  for (const p of Array.isArray(r.paragraphs) ? r.paragraphs : []) {
    if (!isObject(p)) {
      warn('a paragraph of text was not readable; left it out')
      continue
    }
    const runs: Run[] = []
    for (const run of Array.isArray(p.runs) ? p.runs : []) {
      if (!isObject(run) || typeof run.text !== 'string') continue
      // Paragraph breaks live between paragraphs, not in runs.
      runs.push({ text: run.text.replace(/[\n\r]/g, ' '), style: readRef(run.style), props: readCharProps(run.props) })
    }
    paragraphs.push(normalize({ runs, style: readRef(p.style), props: readParaProps(p.props) }))
  }
  return { paragraphs: paragraphs.length ? paragraphs : [emptyParagraph()] }
}

export function readTextStyles(raw: unknown, warn: Warn): TextStyles {
  const r = isObject(raw) ? raw : {}
  const ids = new Set<string>()
  const ok = (s: Record<string, unknown>) => typeof s.id === 'string' && s.id && !ids.has(s.id) && (ids.add(s.id), true)
  const character: CharStyle[] = []
  for (const s of Array.isArray(r.character) ? r.character : []) {
    if (!isObject(s) || !ok(s)) {
      warn('a character style was not readable; left it out')
      continue
    }
    character.push({ id: s.id as string, name: typeof s.name === 'string' && s.name ? s.name : 'Character Style', basedOn: readRef(s.basedOn), char: readCharProps(s.char) })
  }
  const paragraph: ParaStyle[] = []
  for (const s of Array.isArray(r.paragraph) ? r.paragraph : []) {
    if (!isObject(s) || !ok(s)) {
      warn('a paragraph style was not readable; left it out')
      continue
    }
    paragraph.push({ id: s.id as string, name: typeof s.name === 'string' && s.name ? s.name : 'Paragraph Style', basedOn: readRef(s.basedOn), para: readParaProps(s.para), char: readCharProps(s.char) })
  }
  return { character, paragraph }
}

// --- resolving ---------------------------------------------------------------------------------

/** A style and the ones it's based on, nearest last; a loop is cut where it comes back. */
function chain<S extends { id: string; basedOn: string | null }>(list: S[], id: string | null): S[] {
  const out: S[] = []
  const seen = new Set<string>()
  for (let at = id; at && !seen.has(at) && out.length < 16; ) {
    seen.add(at)
    const s = list.find((x) => x.id === at)
    if (!s) break
    out.unshift(s)
    at = s.basedOn
  }
  return out
}

export function resolvePara(p: Paragraph, styles: TextStyles = NO_STYLES): ParaProps {
  let o: ParaProps = { ...DEFAULT_PARA }
  for (const s of chain(styles.paragraph, p.style)) o = { ...o, ...s.para }
  return { ...o, ...p.props }
}

export function resolveChar(run: Pick<Run, 'style' | 'props'>, p: Pick<Paragraph, 'style'>, styles: TextStyles = NO_STYLES): CharProps {
  let o: CharProps = { ...DEFAULT_CHAR }
  for (const s of chain(styles.paragraph, p.style)) o = { ...o, ...s.char }
  for (const s of chain(styles.character, run.style)) o = { ...o, ...s.char }
  return { ...o, ...run.props }
}

// --- text and positions ----------------------------------------------------------------------

export const emptyParagraph = (props: Partial<CharProps> = {}, style: string | null = null): Paragraph => ({ runs: [{ text: '', style, props }], style: null, props: {} })

export const paragraphText = (p: Paragraph) => p.runs.map((r) => r.text).join('')

/** The whole text, paragraphs joined by line feeds: the space positions count in. */
export const plainText = (c: TextContent) => c.paragraphs.map(paragraphText).join('\n')

const lengths = new WeakMap<Paragraph, number>()
/**
 * A paragraph's length in characters, kept by the paragraph (an edit makes
 * new ones): the caret's positions are worked out from these on every move,
 * and joining a long story's runs each time cost every keystroke.
 */
function paragraphLength(p: Paragraph): number {
  let n = lengths.get(p)
  if (n === undefined) {
    n = 0
    for (const r of p.runs) n += r.text.length
    lengths.set(p, n)
  }
  return n
}

export const textLength = (c: TextContent) => c.paragraphs.reduce((n, p, i) => n + paragraphLength(p) + (i ? 1 : 0), 0)

/** A position as (paragraph, offset in it). */
export function locate(c: TextContent, pos: number): { para: number; offset: number } {
  let at = 0
  for (let i = 0; i < c.paragraphs.length; i++) {
    const len = paragraphLength(c.paragraphs[i])
    if (pos <= at + len) return { para: i, offset: Math.max(0, pos - at) }
    at += len + 1
  }
  const last = c.paragraphs.length - 1
  return { para: last, offset: paragraphLength(c.paragraphs[last]) }
}

/** Where a paragraph starts in the whole text. */
export function paragraphStart(c: TextContent, para: number): number {
  let at = 0
  for (let i = 0; i < para; i++) at += paragraphLength(c.paragraphs[i]) + 1
  return at
}

/** Runs next to each other with the same style and settings become one; empty ones go, but a paragraph keeps one. */
function normalize(p: Paragraph): Paragraph {
  const runs: Run[] = []
  for (const r of p.runs) {
    const last = runs[runs.length - 1]
    if (last && last.style === r.style && sameProps(last.props, r.props)) runs[runs.length - 1] = { ...last, text: last.text + r.text }
    else if (r.text || !runs.length) runs.push(r)
  }
  // A leading empty run gives way to text after it.
  if (runs.length > 1 && !runs[0].text) runs.shift()
  return { ...p, runs: runs.length ? runs : [{ text: '', style: null, props: {} }] }
}

const sameProps = (a: Partial<CharProps>, b: Partial<CharProps>) => deepEqual(a, b)

/** A paragraph's runs cut at an offset, so a range's runs can be changed alone. */
function splitAt(p: Paragraph, offset: number): Run[] {
  const out: Run[] = []
  let at = 0
  for (const r of p.runs) {
    const end = at + r.text.length
    if (offset > at && offset < end) {
      out.push({ ...r, text: r.text.slice(0, offset - at) }, { ...r, text: r.text.slice(offset - at) })
    } else out.push(r)
    at = end
  }
  return out
}

/** The run a character typed at `offset` takes its style from: the one before it, or the first. */
function runAt(p: Paragraph, offset: number): Run {
  let at = 0
  for (const r of p.runs) {
    const end = at + r.text.length
    if (offset > at && offset <= end) return r
    at = end
  }
  return p.runs[0]
}

/** The character settings in force at a position (what typing there would get). */
export function runAtPos(c: TextContent, pos: number): { run: Run; para: Paragraph } {
  const { para, offset } = locate(c, pos)
  const p = c.paragraphs[para]
  return { run: runAt(p, offset), para: p }
}

// --- edits ---------------------------------------------------------------------------------------

/** Deletes [a, b), joining paragraphs it runs across; the first keeps its settings. */
export function deleteRange(c: TextContent, a: number, b: number): TextContent {
  if (b <= a) return c
  const A = locate(c, a)
  const B = locate(c, b)
  const first = c.paragraphs[A.para]
  const last = c.paragraphs[B.para]
  const keep = (p: Paragraph, from: number, to: number): Run[] => {
    const out: Run[] = []
    let at = 0
    for (const r of p.runs) {
      const s = Math.max(from, at)
      const e = Math.min(to, at + r.text.length)
      if (e > s) out.push({ ...r, text: r.text.slice(s - at, e - at) })
      at += r.text.length
    }
    return out
  }
  const head = keep(first, 0, A.offset)
  const tail = keep(last, B.offset, Infinity)
  // An emptied paragraph keeps the style of what was deleted, for typing.
  const merged = normalize({ ...first, runs: head.length || tail.length ? [...head, ...tail] : [{ ...runAt(first, A.offset), text: '' }] })
  return { paragraphs: [...c.paragraphs.slice(0, A.para), merged, ...c.paragraphs.slice(B.para + 1)] }
}

/**
 * Inserts text at `pos`: line feeds start new paragraphs (with the same
 * paragraph settings). It takes the style of the character before it, or
 * `as` when given (what the Character panel set for the next typing).
 */
export function insertText(c: TextContent, pos: number, text: string, as?: Pick<Run, 'style' | 'props'>): TextContent {
  if (!text) return c
  const { para, offset } = locate(c, pos)
  const p = c.paragraphs[para]
  const like = as ?? runAt(p, offset)
  const parts = text.replace(/\r\n?/g, '\n').split('\n')
  const runs = splitAt(p, offset)
  let at = 0
  const before: Run[] = []
  const after: Run[] = []
  for (const r of runs) {
    ;(at < offset ? before : after).push(r)
    at += r.text.length
  }
  if (parts.length === 1) {
    return replaceParagraphs(c, para, 1, [normalize({ ...p, runs: [...before, { text: parts[0], style: like.style, props: like.props }, ...after] })])
  }
  const out: Paragraph[] = []
  out.push(normalize({ ...p, runs: [...before, { text: parts[0], style: like.style, props: like.props }] }))
  for (const mid of parts.slice(1, -1)) out.push(normalize({ ...p, runs: [{ text: mid, style: like.style, props: like.props }] }))
  out.push(normalize({ ...p, runs: [{ text: parts[parts.length - 1], style: like.style, props: like.props }, ...after] }))
  return replaceParagraphs(c, para, 1, out)
}

export const replaceRange = (c: TextContent, a: number, b: number, text: string, as?: Pick<Run, 'style' | 'props'>) => insertText(deleteRange(c, a, b), a, text, as ?? runAtPos(c, a + (a < b ? 1 : 0)).run)

function replaceParagraphs(c: TextContent, at: number, count: number, ps: Paragraph[]): TextContent {
  return { paragraphs: [...c.paragraphs.slice(0, at), ...ps, ...c.paragraphs.slice(at + count)] }
}

/**
 * Character settings (and, when given, a character style) on [a, b). An
 * empty range changes nothing here: the caller keeps the settings for what's
 * typed next. A setting given as undefined goes back to inheriting.
 */
export function styleRange(c: TextContent, a: number, b: number, patch: Partial<CharProps>, style?: string | null): TextContent {
  if (b <= a) return c
  const paragraphs = c.paragraphs.map((p, i) => {
    const start = paragraphStart(c, i)
    const end = start + paragraphText(p).length
    const from = Math.max(a, start) - start
    const to = Math.min(b, end) - start
    if (to <= from && !(p.runs.length === 1 && !p.runs[0].text && a <= start && b > start)) return p
    let runs = splitAt({ ...p, runs: splitAt(p, from) }, to)
    let at = 0
    runs = runs.map((r) => {
      const s = at
      at += r.text.length
      const inside = (s >= from && at <= to && r.text) || (!r.text && p.runs.length === 1)
      if (!inside) return r
      const props: Partial<CharProps> = { ...r.props }
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete props[k as keyof CharProps]
        else (props as Record<string, unknown>)[k] = v
      }
      return { text: r.text, style: style === undefined ? r.style : style, props }
    })
    return normalize({ ...p, runs })
  })
  return { paragraphs }
}

/** Paragraph settings (and, when given, a paragraph style) on every paragraph [a, b] touches. */
export function styleParagraphs(c: TextContent, a: number, b: number, patch: Partial<ParaProps>, style?: string | null): TextContent {
  const first = locate(c, a).para
  const last = locate(c, Math.max(a, b)).para
  return {
    paragraphs: c.paragraphs.map((p, i) => {
      if (i < first || i > last) return p
      const props: Partial<ParaProps> = { ...p.props }
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete props[k as keyof ParaProps]
        else (props as Record<string, unknown>)[k] = v
      }
      return { ...p, props, style: style === undefined ? p.style : style }
    }),
  }
}

/** Plain text as content: one run per paragraph, with these settings. */
export function contentFrom(text: string, props: Partial<CharProps> = {}, style: string | null = null): TextContent {
  return { paragraphs: text.replace(/\r\n?/g, '\n').split('\n').map((t) => normalize({ runs: [{ text: t, style, props }], style: null, props: {} })) }
}

/** The text in [a, b), for copying. */
export const textIn = (c: TextContent, a: number, b: number) => plainText(c).slice(a, b)

/** Every font a document's text uses (smart objects' contents too), as family and style. */
export function fontsUsed(doc: Doc): { family: string; style: string }[] {
  const seen = new Map<string, { family: string; style: string }>()
  const visit = (d: Doc) => {
    for (const n of Object.values(d.nodes)) {
      if (n.kind === 'embedded' && n.props.content) visit(n.props.content)
      if (n.kind !== 'text') continue
      for (const p of n.props.content.paragraphs)
        for (const r of p.runs) {
          const c = resolveChar(r, p, d.textStyles)
          seen.set(`${c.font}\u0000${c.style}`, { family: c.font, style: c.style })
        }
    }
  }
  visit(doc)
  return [...seen.values()]
}
