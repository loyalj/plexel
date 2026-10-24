/**
 * What the document area shows with nothing open: a page of cards, as
 * Woodson's start page has, rather than a dialog over the canvas.
 *
 *   Open   Open…, then the recent files with their pictures (the
 *          thumbnail.png each .pxll carries, kept beside its handle in
 *          io/handles.ts), each with a × that takes it off the list. Only
 *          where files can be reopened where they are (Chrome, Edge).
 *   New    Custom… (the New Document dialog), New from Clipboard, then one
 *          card per preset, each making its document at once with the
 *          preset as it stands (app/files.ts newFromPreset)
 *
 * Open comes first, as Woodson's own projects do: the files you came back
 * for shouldn't sit under ten presets.
 *
 * Every card is a button, so Tab, Enter and Space work; the arrow keys also
 * move between cards, by where they sit on the page.
 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import { PRESETS, type Preset } from '../doc/presets'
import { forgetRecent, recentPicture, type RecentFile } from '../io/handles'
import { ago, useRecent } from './docDialogs'
import { Icon } from './Icon'
import type { IconName } from './icons'

interface Props {
  canRecent: boolean
  /** The keys for a command as they are now, for the cards that run one. */
  keys(id: string): string
  onCustom(): void
  onPreset(p: Preset): void
  onFromClipboard(): void
  onOpen(): void
  onOpenRecent(r: RecentFile): void
}

export function StartPage({ canRecent, keys, onCustom, onPreset, onFromClipboard, onOpen, onOpenRecent }: Props) {
  return (
    <div className="start" data-screen="start" onKeyDown={arrows}>
      <section className="start-section" aria-labelledby="start-open">
        <h2 id="start-open">{canRecent ? 'Open' : 'Open a file'}</h2>
        <ul className="start-grid">
          <li>
            <ActionCard icon="start.open" title="Open…" detail="Documents and images" keys={keys('file.open')} data="open" onClick={onOpen} />
          </li>
          {canRecent && <RecentCards onOpen={onOpenRecent} />}
        </ul>
      </section>
      <section className="start-section" aria-labelledby="start-new">
        <h2 id="start-new">New</h2>
        <ul className="start-grid">
          <li>
            <ActionCard icon="start.custom" title="Custom…" detail="Size, mode, background" keys={keys('file.new')} data="custom" onClick={onCustom} />
          </li>
          <li>
            <ActionCard icon="start.clipboard" title="From Clipboard" detail="The size of what’s copied" keys={keys('file.new-from-clipboard')} data="clipboard" onClick={onFromClipboard} />
          </li>
          {PRESETS.map((p) => (
            <li key={p.id}>
              <PresetCard preset={p} onClick={() => onPreset(p)} />
            </li>
          ))}
        </ul>
      </section>
      <p className="start-hint">
        Or drop a .pxll file or an image (PNG, JPEG, TIFF) here. <kbd>{keys('palette.open')}</kbd> lists every command.
      </p>
    </div>
  )
}

function ActionCard({ icon, title, detail, keys, data, onClick }: { icon: IconName; title: string; detail: string; keys: string; data: string; onClick(): void }) {
  return (
    <button type="button" className="start-card" data-start-card={data} data-tip={keys ? `${title} (${keys})` : undefined} onClick={onClick}>
      <span className="start-pic start-pic-icon">
        <Icon name={icon} />
      </span>
      <span className="start-title">{title}</span>
      <span className="start-detail">{detail}</span>
    </button>
  )
}

const MODE_NAMES: Record<Preset['mode'], string> = { rgb: 'RGB', cmyk: 'CMYK', gray: 'Gray' }

/** What sets a preset apart besides its size: the mode, a depth over 8 bits, the resolution for print. */
function presetNote(p: Preset) {
  const mode = `${MODE_NAMES[p.mode]}${p.depth > 8 ? ` ${p.depth}-bit` : ''}`
  return p.unit === 'px' ? mode : `${mode} · ${p.resolution} ppi`
}

function PresetCard({ preset: p, onClick }: { preset: Preset; onClick(): void }) {
  // "Full HD, 1920 × 1080": the name, then the size.
  const cut = p.name.indexOf(', ')
  const title = cut > 0 ? p.name.slice(0, cut) : p.name
  const size = cut > 0 ? p.name.slice(cut + 2) : `${p.width} × ${p.height} ${p.unit}`
  return (
    <button type="button" className="start-card" data-start-card={`preset-${p.id}`} aria-label={`New ${p.name}, ${presetNote(p)}`} onClick={onClick}>
      <span className="start-pic">
        <PageShape width={p.width} height={p.height} />
        <span className="start-note">{presetNote(p)}</span>
      </span>
      <span className="start-title">{title}</span>
      <span className="start-detail">{size}</span>
    </button>
  )
}

/** The page's shape, to scale, fitted to the card's picture. */
function PageShape({ width, height }: { width: number; height: number }) {
  const s = 72 / Math.max(width, height)
  const w = Math.max(6, width * s)
  const h = Math.max(6, height * s)
  return (
    <svg className="start-page-shape" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <rect x={50 - w / 2} y={50 - h / 2} width={w} height={h} rx={1.5} />
    </svg>
  )
}

function RecentCards({ onOpen }: { onOpen(r: RecentFile): void }) {
  const list = useRecent()
  if (!list) return null
  if (!list.length)
    return (
      <li className="start-empty">
        <p>Files you open or save appear here.</p>
      </li>
    )
  return (
    <>
      {list.map((r) => (
        <li key={r.handleKey} className="start-recent">
          <button type="button" className="start-card" data-start-card="recent" data-recent={r.name} data-tip={r.name} onClick={() => onOpen(r)}>
            <span className="start-pic">
              <RecentPicture handleKey={r.handleKey} at={r.at} />
            </span>
            <span className="start-title">{r.name}</span>
            <span className="start-detail">{ago(r.at)}</span>
          </button>
          <button type="button" className="start-forget" aria-label={`Remove ${r.name} from Recent`} data-tip="Remove from Recent (the file stays where it is)" onClick={() => void forgetRecent(r.handleKey)}>
            <Icon name="ui.close" />
          </button>
        </li>
      ))}
    </>
  )
}

/** A recent file's picture; `at` changes when the file is saved again, so a fresh picture is read. */
function RecentPicture({ handleKey, at }: { handleKey: string; at: number }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    let made: string | null = null
    void recentPicture(handleKey).then((b) => {
      if (!live || !b) return
      made = URL.createObjectURL(b)
      setUrl(made)
    })
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [handleKey, at])
  return url ? <img className="start-thumb" src={url} alt="" draggable={false} /> : <Icon name="start.custom" className="start-thumb-none" />
}

/** The arrow keys move between cards: to the nearest one that way, by where they sit. */
function arrows(e: KeyboardEvent<HTMLDivElement>) {
  const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
  const from = e.target as HTMLElement
  if (!dir || !from.matches('[data-start-card]') || e.altKey || e.ctrlKey || e.metaKey) return
  const at = from.getBoundingClientRect()
  const cx = at.left + at.width / 2
  const cy = at.top + at.height / 2
  let best: HTMLElement | null = null
  let bestScore = Infinity
  for (const el of e.currentTarget.querySelectorAll<HTMLElement>('[data-start-card]')) {
    if (el === from) continue
    const r = el.getBoundingClientRect()
    const dx = r.left + r.width / 2 - cx
    const dy = r.top + r.height / 2 - cy
    // Only cards that way; along the way counts, across it counts for more.
    const along = dx * dir[0] + dy * dir[1]
    if (along <= 1) continue
    const across = Math.abs(dir[0] ? dy : dx)
    const score = along + across * 4
    if (score < bestScore) {
      bestScore = score
      best = el
    }
  }
  if (!best) return
  e.preventDefault()
  best.focus()
  best.scrollIntoView({ block: 'nearest' })
}
