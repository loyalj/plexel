/**
 * Hyphenation: where a word may break, by the Knuth–Liang patterns TeX
 * uses (the hyphen package's, ISC; the patterns' own licences are TeX's).
 *
 * Each language's patterns are fetched the first time text in it asks,
 * as their own small download; until they're here its words don't break,
 * and `version` moves on when they arrive so text is laid out again (as
 * fonts do, text/fonts.ts). A language is found by its BCP 47 tag: the
 * whole tag where patterns have it (en-GB), else its first part (de-AT is
 * German). Layout asks synchronously (text/layout.ts, Hyphenator).
 *
 * Pure apart from the module loads: check-text runs it in Node.
 */
import { Listeners } from '../lib/listeners'

type Patterns = unknown
type Hyphenate = (text: string, options?: { hyphenChar?: string; minWordLength?: number }) => string

/** The languages with patterns, by lower-case tag, and how to fetch each. */
const LOADERS: Record<string, () => Promise<{ default?: Patterns } | Patterns>> = {
  'en-us': () => import('hyphen/patterns/en-us.js'),
  'en-gb': () => import('hyphen/patterns/en-gb.js'),
  de: () => import('hyphen/patterns/de-1996.js'),
  'de-ch': () => import('hyphen/patterns/de-ch-1901.js'),
  fr: () => import('hyphen/patterns/fr.js'),
  es: () => import('hyphen/patterns/es.js'),
  it: () => import('hyphen/patterns/it.js'),
  pt: () => import('hyphen/patterns/pt.js'),
  nl: () => import('hyphen/patterns/nl.js'),
  sv: () => import('hyphen/patterns/sv.js'),
  da: () => import('hyphen/patterns/da.js'),
  nb: () => import('hyphen/patterns/nb.js'),
  nn: () => import('hyphen/patterns/nn.js'),
  fi: () => import('hyphen/patterns/fi.js'),
  pl: () => import('hyphen/patterns/pl.js'),
  cs: () => import('hyphen/patterns/cs.js'),
  sk: () => import('hyphen/patterns/sk.js'),
  hu: () => import('hyphen/patterns/hu.js'),
  ro: () => import('hyphen/patterns/ro.js'),
  hr: () => import('hyphen/patterns/hr.js'),
  sl: () => import('hyphen/patterns/sl.js'),
  ru: () => import('hyphen/patterns/ru.js'),
  uk: () => import('hyphen/patterns/uk.js'),
  el: () => import('hyphen/patterns/el-monoton.js'),
  tr: () => import('hyphen/patterns/tr.js'),
  ca: () => import('hyphen/patterns/ca.js'),
  la: () => import('hyphen/patterns/la.js'),
  et: () => import('hyphen/patterns/et.js'),
  lt: () => import('hyphen/patterns/lt.js'),
  lv: () => import('hyphen/patterns/lv.js'),
  id: () => import('hyphen/patterns/id.js'),
}

/** Tags that are another's patterns: one load, one set of points. */
const ALIASES: Record<string, string> = { en: 'en-us', no: 'nb' }

/** The languages hyphenation knows, by tag, for the panels. */
export const HYPHENATION_LANGUAGES = [...Object.keys(LOADERS), ...Object.keys(ALIASES)]

/** A language tag as the patterns are known by; null for one without patterns. */
export function patternsFor(lang: string): string | null {
  const t = lang.toLowerCase()
  if (LOADERS[t]) return t
  if (ALIASES[t]) return ALIASES[t]
  const base = t.split('-')[0]
  return LOADERS[base] ? base : (ALIASES[base] ?? null)
}

/** What layout asks: where a word may break (offsets inside it), or null while its language's patterns aren't here. */
export interface Hyphenator {
  points(word: string, lang: string): number[] | null
  /** Moves on when a language's patterns arrive. */
  readonly version: number
}

const SHY = '­'

export class Hyphenation implements Hyphenator {
  version = 0
  private ready = new Map<string, Hyphenate>()
  private loading = new Map<string, Promise<void>>()
  private failed = new Set<string>()
  private cache = new Map<string, number[]>()
  private changes = new Listeners()

  subscribe = (fn: () => void) => this.changes.subscribe(fn)

  points(word: string, lang: string): number[] | null {
    const tag = patternsFor(lang)
    if (!tag || this.failed.has(tag)) return []
    const h = this.ready.get(tag)
    if (!h) {
      void this.load(tag)
      return null
    }
    const key = `${tag}\u0000${word}`
    let out = this.cache.get(key)
    if (!out) {
      out = []
      // The word with soft hyphens where it may break; their places are the points.
      const marked = h(word, { hyphenChar: SHY, minWordLength: 1 })
      let at = 0
      for (const ch of marked) {
        if (ch === SHY) out.push(at)
        else at += ch.length
      }
      if (this.cache.size > 20000) this.cache.clear()
      this.cache.set(key, out)
    }
    return out
  }

  /** Fetches a language's patterns (once), and says so when they're in. */
  load(lang: string): Promise<void> {
    const tag = patternsFor(lang)
    if (!tag) return Promise.resolve()
    let p = this.loading.get(tag)
    if (!p) {
      p = (async () => {
        try {
          const [mod, make] = await Promise.all([LOADERS[tag](), import('hyphen/hyphen.js')])
          const patterns = (mod as { default?: Patterns }).default ?? mod
          const create = ((make as { default?: unknown }).default ?? make) as (p: Patterns, o?: object) => Hyphenate
          this.ready.set(tag, create(patterns, { hyphenChar: SHY }))
        } catch {
          this.failed.add(tag)
        }
        this.version++
        this.changes.emit()
      })()
      this.loading.set(tag, p)
    }
    return p
  }
}

let shared: Hyphenation | null = null
/** The page's hyphenation (and the checks'). */
export const hyphenation = () => (shared ??= new Hyphenation())
