/**
 * The Glyphs panel, as Photoshop's and Illustrator's: every character the
 * current font has (the text being edited's, a selected text layer's, or
 * new text's), drawn in it, the ones used lately along the top. Click one
 * to see its code and its alternates (the forms the font's OpenType
 * features give it); double-click to put it in the text being edited, at
 * the caret, an alternate with the feature that makes it. Only the rows in
 * view are drawn, so a font of thousands opens at once.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { fontLibraryNow } from '../app/fonts'
import { startFonts } from '../app/text'
import { insertGlyph, isTyping, shownChar, subscribeTyping } from '../app/typing'
import { documents } from '../app/documents'
import { notify } from '../app/notices'
import { alternatesOf, cmapOf, codeName, outlineSvg, type MappedGlyph } from '../text/glyphs'
import type { Font } from '../text/hb'

const CELL = 40
const RECENT_KEY = 'plexel.glyphs.recent'
const RECENT = 16

function readRecent(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number').slice(0, RECENT) : []
  } catch {
    return []
  }
}

/** Ranges the panel can narrow to. */
const RANGES: [string, string, (cp: number) => boolean][] = [
  ['all', 'Entire font', () => true],
  ['latin', 'Latin', (cp) => cp < 0x250 || (cp >= 0x1e00 && cp < 0x1f00)],
  ['punct', 'Punctuation', (cp) => /[\p{P}]/u.test(String.fromCodePoint(cp))],
  ['nums', 'Numbers', (cp) => /\p{N}/u.test(String.fromCodePoint(cp))],
  ['symbols', 'Symbols', (cp) => /\p{S}/u.test(String.fromCodePoint(cp))],
  ['greek', 'Greek and Cyrillic', (cp) => (cp >= 0x370 && cp < 0x530) || (cp >= 0x1f00 && cp < 0x2000)],
  ['other', 'Other scripts', (cp) => cp >= 0x530 && !(cp >= 0x1e00 && cp < 0x2000) && !/[\p{P}\p{S}\p{N}]/u.test(String.fromCodePoint(cp))],
]

/** A glyph drawn in a square, the font's ascender at the top. */
function GlyphCell({ font, gid, upem, asc, desc }: { font: Font; gid: number; upem: number; asc: number; desc: number }) {
  const d = useMemo(() => outlineSvg(font.outline(gid)), [font, gid])
  // Centred across by its own extent, the font's height down.
  const box = useMemo(() => {
    const o = font.outline(gid)
    let x0 = Infinity
    let x1 = -Infinity
    for (let i = 0; i < o.length; ) {
      const op = o[i]
      const n = op === 0 || op === 1 ? 2 : op === 3 ? 6 : 0
      for (let k = 0; k < n; k += 2) {
        x0 = Math.min(x0, o[i + 1 + k])
        x1 = Math.max(x1, o[i + 1 + k])
      }
      i += 1 + n
    }
    const h = asc - desc || upem
    const cx = x0 === Infinity ? upem / 2 : (x0 + x1) / 2
    return `${cx - h / 2} ${-asc} ${h} ${h}`
  }, [font, gid, upem, asc, desc])
  return (
    <svg viewBox={box} aria-hidden="true">
      <path d={d} fill="currentColor" />
    </svg>
  )
}

export const GlyphsPanel = memo(function GlyphsPanel() {
  const [, tick] = useState(0)
  useEffect(() => {
    const bump = () => tick((n) => n + 1)
    const offs = [documents().subscribe(bump), subscribeTyping(bump)]
    let off = () => {}
    void startFonts().then((lib) => {
      off = lib.subscribe(bump)
      bump()
    })
    return () => {
      offs.forEach((f) => f())
      off()
    }
  }, [])
  const lib = fontLibraryNow()
  const c = shownChar()
  const face = lib?.face(c.font, c.style) ?? null
  const font = face ? face.face.font({ ...face.coords, ...c.variations }) : null
  const [range, setRange] = useState('all')
  const [picked, setPicked] = useState<number | null>(null)
  const [recent, setRecent] = useState(readRecent)
  const [scroll, setScroll] = useState(0)
  const grid = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(240)
  useEffect(() => {
    const el = grid.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const all: MappedGlyph[] = useMemo(() => (face ? cmapOf(face.face) : []), [face])
  const shown = useMemo(() => {
    const keep = RANGES.find(([id]) => id === range)?.[2] ?? (() => true)
    return all.filter((g) => g.cp > 0x20 && keep(g.cp))
  }, [all, range])
  const alternates = useMemo(() => (font && picked !== null ? alternatesOf(font, picked, c.language) : []), [font, picked, c.language])
  if (!font || !face) return <p className="panel-empty">The characters of the font in use: open the Type tool, or select text.</p>
  const info = face.face.info
  const m = font.metrics()
  const cols = Math.max(1, Math.floor(width / CELL))
  const rows = Math.ceil(shown.length / cols)
  const first = Math.max(0, Math.floor(scroll / CELL) - 1)
  const last = Math.min(rows, first + Math.ceil(320 / CELL) + 3)
  const typing = isTyping()
  const put = (cp: number, feature?: string) => {
    if (!insertGlyph(String.fromCodePoint(cp), feature)) {
      notify('info', 'Click into text with the Type tool first: a glyph goes in at the caret.')
      return
    }
    const next = [cp, ...recent.filter((x) => x !== cp)].slice(0, RECENT)
    setRecent(next)
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    } catch {
      // Kept for this session.
    }
  }
  const cell = (g: MappedGlyph, key: string) => (
    <button
      key={key}
      type="button"
      className={`glyph-cell${picked === g.cp ? ' picked' : ''}`}
      data-glyph={g.cp}
      title={`${String.fromCodePoint(g.cp)} ${codeName(g.cp)}`}
      onClick={() => setPicked(g.cp)}
      onDoubleClick={() => put(g.cp)}
    >
      <GlyphCell font={font} gid={g.gid} upem={info.upem} asc={m.ascender} desc={m.descender} />
    </button>
  )
  const recentShown = recent.map((cp) => all.find((g) => g.cp === cp)).filter((g): g is MappedGlyph => !!g)
  return (
    <div className="glyphs-panel" data-panel-body="glyphs">
      <div className="glyphs-head">
        <span className="glyphs-font" title={`${c.font} ${c.style}`}>
          {info.family} {info.subfamily}
        </span>
        <select aria-label="Show" value={range} data-glyphs-range onChange={(e) => (setRange(e.target.value), grid.current && (grid.current.scrollTop = 0), setScroll(0))}>
          {RANGES.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {recentShown.length > 0 && (
        <div className="glyphs-recent" aria-label="Recently used" data-glyphs-recent>
          {recentShown.map((g) => cell(g, `r${g.cp}`))}
        </div>
      )}
      <div ref={grid} className="glyphs-grid" style={{ height: Math.min(8, Math.max(1, rows)) * CELL }} onScroll={(e) => setScroll(e.currentTarget.scrollTop)} data-glyphs-grid={shown.length}>
        <div style={{ height: rows * CELL, position: 'relative' }}>
          {Array.from({ length: Math.max(0, last - first) }, (_, k) => {
            const r = first + k
            return (
              <div key={r} className="glyphs-row" style={{ top: r * CELL, height: CELL }}>
                {shown.slice(r * cols, r * cols + cols).map((g) => cell(g, `g${g.cp}`))}
              </div>
            )
          })}
        </div>
      </div>
      {picked !== null && (
        <div className="glyphs-picked" data-glyphs-picked={picked}>
          <span>
            {String.fromCodePoint(picked)} <code>{codeName(picked)}</code>
          </span>
          {alternates.length > 0 ? (
            <div className="glyphs-alternates" aria-label="Alternates" data-glyphs-alternates={alternates.length}>
              {alternates.map((a) => (
                <button key={`${a.gid}-${a.feature}`} type="button" className="glyph-cell" data-alternate={a.feature} title={`${a.feature}: double-click to insert`} onDoubleClick={() => put(picked, a.feature)}>
                  <GlyphCell font={font} gid={a.gid} upem={info.upem} asc={m.ascender} desc={m.descender} />
                </button>
              ))}
            </div>
          ) : (
            <em className="type-colour-own">no alternates</em>
          )}
        </div>
      )}
      <p className="field-meta">{typing ? 'Double-click a glyph to insert it at the caret.' : 'Click into text with the Type tool, then double-click a glyph to insert it.'}</p>
    </div>
  )
})
