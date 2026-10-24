/**
 * The font menu: a button showing the family in its own face, and a list
 * that drops from it with every family drawn in its face, a search field,
 * favourites (the star), the ones used lately, and kinds (sans, serif,
 * mono, script, display; app/fontMenu.ts). The list draws only the rows in
 * view, so a computer's thousand fonts open at once. Arrow keys move,
 * Enter picks, Esc closes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { FONT_KINDS, fontKind, fontMenu, previewFamily, type FontKind } from '../app/fontMenu'
import { canLoadSystemFonts, fontLibraryNow, loadSystemFonts, subscribeSystemFonts, systemFontsLoaded } from '../app/fonts'
import type { FontLibrary } from '../text/fonts'
import { Icon } from './Icon'

const ROW = 30
const SHOWN = 11
const noop = () => () => {}

type Filter = 'all' | 'favourites' | 'recent' | FontKind

const FILTERS: [Filter, string][] = [['all', 'All'], ['favourites', '★'], ['recent', 'Recent'], ...FONT_KINDS]

/** The library's version, following it. */
function useLibrary(): FontLibrary | null {
  const lib = fontLibraryNow()
  useSyncExternalStore(lib?.subscribe ?? noop, () => lib?.version ?? -1)
  useSyncExternalStore(subscribeSystemFonts, systemFontsLoaded)
  return lib
}

export function FontPicker({ id, value, label, onPick, className }: { id: string; value: string; label: string; onPick(family: string): void; className?: string }) {
  const lib = useLibrary()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const fam = lib?.families().find((f) => f.family === value)
  const face = lib && fam ? previewFamily(lib, fam.family, fam.styles) : null
  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        className={`font-picker${className ? ` ${className}` : ''}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-font-picker={value}
        data-missing={fam ? undefined : ''}
        onClick={() => setOpen(!open)}
      >
        <span className="font-picker-name" style={face ? { fontFamily: `${face}, var(--font-ui, sans-serif)` } : undefined}>
          {value}
          {!fam && <span className="font-picker-missing"> (missing)</span>}
        </span>
        <Icon name="layer.fold-open" />
      </button>
      {open && lib && createPortal(<FontList lib={lib} anchor={button.current} value={value} onPick={(f) => (onPick(f), fontMenu.used(f), setOpen(false))} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

function FontList({ lib, anchor, value, onPick, onClose }: { lib: FontLibrary; anchor: HTMLElement | null; value: string; onPick(f: string): void; onClose(): void }) {
  useLibrary()
  const prefs = useSyncExternalStore(fontMenu.subscribe, fontMenu.get)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [active, setActive] = useState(0)
  const [scroll, setScroll] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const families = lib.families()
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    let out = families
    if (filter === 'favourites') out = out.filter((f) => prefs.favourites.includes(f.family))
    else if (filter === 'recent') out = prefs.recent.map((r) => families.find((f) => f.family === r)).filter((f): f is (typeof families)[number] => !!f)
    else if (filter !== 'all') out = out.filter((f) => fontKind(f.family) === filter)
    return q ? out.filter((f) => f.family.toLowerCase().includes(q)) : out
  }, [families, query, filter, prefs])

  // Opened on the family chosen.
  useLayoutEffect(() => {
    const at = shown.findIndex((f) => f.family === value)
    if (at >= 0 && list.current) {
      setActive(at)
      list.current.scrollTop = Math.max(0, (at - 4) * ROW)
      setScroll(list.current.scrollTop)
    }
    // Only when it opens.
  }, [])

  useLayoutEffect(() => {
    const el = box.current
    if (!el || !anchor) return
    const a = anchor.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, a.left))
    const below = a.bottom + 4
    const top = below + r.height > window.innerHeight - 8 ? Math.max(8, a.top - 4 - r.height) : below
    setPos({ left, top })
  }, [anchor])

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (box.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    // Esc closes it before the tool or the app take the key.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
      anchor?.focus()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', esc, true)
    }
  }, [anchor, onClose])

  const show = (i: number) => {
    const el = list.current
    if (!el) return
    if (i * ROW < el.scrollTop) el.scrollTop = i * ROW
    else if ((i + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (i + 1) * ROW - el.clientHeight
  }
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const i = Math.min(shown.length - 1, Math.max(0, active + (e.key === 'ArrowDown' ? 1 : -1)))
      setActive(i)
      show(i)
    } else if (e.key === 'Enter' && shown[active]) {
      e.preventDefault()
      onPick(shown[active].family)
      anchor?.focus()
    }
  }
  const first = Math.max(0, Math.floor(scroll / ROW) - 2)
  const last = Math.min(shown.length, first + SHOWN + 4)
  return (
    <div ref={box} className="font-list" role="dialog" aria-label="Fonts" data-font-list style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }} onKeyDown={key}>
      <input
        type="search"
        className="font-list-search"
        placeholder="Search fonts"
        aria-label="Search fonts"
        value={query}
        autoFocus
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
          if (list.current) list.current.scrollTop = 0
          setScroll(0)
        }}
      />
      <div className="font-list-filters" role="group" aria-label="Show">
        {FILTERS.map(([f, l]) => (
          <button key={f} type="button" aria-pressed={filter === f} data-font-filter={f} title={f === 'favourites' ? 'Favourites' : undefined} onClick={() => (setFilter(f), setActive(0), list.current && (list.current.scrollTop = 0), setScroll(0))}>
            {l}
          </button>
        ))}
      </div>
      <div ref={list} className="font-list-rows" role="listbox" aria-label="Font families" style={{ height: SHOWN * ROW }} onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
        <div style={{ height: shown.length * ROW, position: 'relative' }}>
          {shown.slice(first, last).map((f, k) => {
            const i = first + k
            const css = previewFamily(lib, f.family, f.styles)
            const fav = prefs.favourites.includes(f.family)
            return (
              <div
                key={f.family}
                role="option"
                aria-selected={f.family === value}
                className={`font-row${i === active ? ' active' : ''}`}
                data-font-family={f.family}
                style={{ top: i * ROW, height: ROW }}
                onPointerEnter={() => setActive(i)}
                onClick={() => onPick(f.family)}
              >
                <button type="button" className={`font-star${fav ? ' on' : ''}`} aria-label={fav ? `Unfavourite ${f.family}` : `Favourite ${f.family}`} aria-pressed={fav} onClick={(e) => (e.stopPropagation(), fontMenu.toggleFavourite(f.family))}>
                  {fav ? '★' : '☆'}
                </button>
                <span className="font-row-name" style={css ? { fontFamily: `${css}, sans-serif` } : undefined}>
                  {f.family}
                </span>
                <span className="font-row-meta">{f.styles.length > 1 ? f.styles.length : ''}</span>
              </div>
            )
          })}
        </div>
        {!shown.length && <p className="field-empty">{filter === 'favourites' ? 'No favourites yet: star a font to keep it here.' : filter === 'recent' ? 'No fonts used yet.' : 'No fonts match.'}</p>}
      </div>
      {canLoadSystemFonts() && !systemFontsLoaded() && (
        <button type="button" className="button small" data-font-list-system onClick={() => void loadSystemFonts()}>
          Load System Fonts
        </button>
      )}
    </div>
  )
}
