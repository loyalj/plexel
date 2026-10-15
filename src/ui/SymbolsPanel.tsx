/**
 * The Symbols panel: the document's symbols, each with a picture of it and
 * how many instances it has. Click Place (or drag the picture onto the
 * canvas) for an instance; double-click a symbol to edit it, which every
 * instance follows. New Symbol makes one of the selected layers; with an
 * instance selected, Replace shows another symbol in it and Break Link
 * makes it a group of its own. The selected instance's symbol is marked.
 */
import { memo, useEffect, useState, useSyncExternalStore } from 'react'
import { canvasPointOf } from '../app/colourDrag'
import { documents, newId } from '../app/documents'
import { breakLinkSelected, canMakeSymbol, duplicateSymbolOf, editSymbol, newSymbolFromSelection, placeInstance, removeSymbol, renameSymbolTo, replaceSelected, selectedSymbol } from '../app/symbols'
import { instancesOf } from '../doc/symbols'
import type { Doc, DocSymbol } from '../doc/types'
import { engine } from '../engine/EngineHost'
import { Icon } from './Icon'
import { Hint } from './controls'

const THUMB = 56

/** A symbol's picture, as a data URL, kept per contents (a new edit, a new picture). */
const thumbs = new WeakMap<Doc, Promise<string | null>>()

function thumbOf(content: Doc): Promise<string | null> {
  let p = thumbs.get(content)
  if (!p) {
    p = (async () => {
      const key = newId('symthumb')
      engine().setScene(key, content)
      try {
        const img = await engine().call('render.nodeImage', { key, node: null, srgb: true })
        if (!img || !img.w || !img.h) return null
        const c = document.createElement('canvas')
        c.width = img.w
        c.height = img.h
        const ctx = c.getContext('2d')!
        const data = new ImageData(img.w, img.h)
        // sRGB with alpha: four channels a pixel.
        for (let i = 0, j = 0; i < img.w * img.h; i++, j += img.channels) {
          data.data[i * 4] = img.data[j]
          data.data[i * 4 + 1] = img.data[j + 1]
          data.data[i * 4 + 2] = img.data[j + 2]
          data.data[i * 4 + 3] = img.data[j + img.channels - 1]
        }
        ctx.putImageData(data, 0, 0)
        const k = Math.min(1, (THUMB * 2) / Math.max(img.w, img.h))
        const out = document.createElement('canvas')
        out.width = Math.max(1, Math.round(img.w * k))
        out.height = Math.max(1, Math.round(img.h * k))
        out.getContext('2d')!.drawImage(c, 0, 0, out.width, out.height)
        return out.toDataURL()
      } catch {
        return null
      } finally {
        engine().closeDoc(key)
      }
    })()
    thumbs.set(content, p)
  }
  return p
}

function Thumb({ symbol }: { symbol: DocSymbol }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void thumbOf(symbol.content).then((u) => live && setUrl(u))
    return () => {
      live = false
    }
  }, [symbol.content])
  return <span className="symbol-thumb checker">{url ? <img src={url} alt="" draggable={false} /> : null}</span>
}

function Name({ name, onRename }: { name: string; onRename(n: string): void }) {
  const [editing, setEditing] = useState<string | null>(null)
  if (editing === null)
    return (
      <span className="channel-name" onDoubleClick={(e) => (e.stopPropagation(), setEditing(name))} data-tip="Double-click to rename">
        {name}
      </span>
    )
  return (
    <input
      className="channel-name"
      value={editing}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setEditing(e.target.value)}
      onBlur={() => {
        if (editing.trim() && editing !== name) onRename(editing)
        setEditing(null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setEditing(null)
      }}
    />
  )
}

/** Dragging a symbol's picture onto the canvas places an instance where it's let go. */
function pressThumb(e: React.PointerEvent, symbol: DocSymbol, url: string | null) {
  if (e.button !== 0) return
  const x0 = e.clientX
  const y0 = e.clientY
  let ghost: HTMLDivElement | null = null
  const move = (m: PointerEvent) => {
    if (m.pointerId !== e.pointerId) return
    if (!ghost && Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return
    if (!ghost) {
      ghost = document.createElement('div')
      ghost.className = 'symbol-drag'
      ghost.dataset.symbolDrag = ''
      if (url) ghost.style.backgroundImage = `url(${url})`
      document.body.appendChild(ghost)
    }
    ghost.style.left = `${m.clientX}px`
    ghost.style.top = `${m.clientY}px`
  }
  const end = (u: PointerEvent) => {
    if (u.pointerId !== e.pointerId) return
    removeEventListener('pointermove', move)
    removeEventListener('pointerup', end)
    removeEventListener('pointercancel', end)
    if (!ghost) return
    ghost.remove()
    const swallow = (c: Event) => c.stopPropagation()
    addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0)
    const at = u.type === 'pointerup' ? canvasPointOf(u.clientX, u.clientY) : null
    if (at) placeInstance(symbol.id, at)
  }
  addEventListener('pointermove', move)
  addEventListener('pointerup', end)
  addEventListener('pointercancel', end)
}

export const SymbolsPanel = memo(function SymbolsPanel() {
  const d = useSyncExternalStore(documents().subscribe, () => documents().active())
  const doc = d?.history.present
  const [urls, setUrls] = useState<Map<string, string | null>>(new Map())
  useEffect(() => {
    let live = true
    for (const s of doc?.symbols ?? []) void thumbOf(s.content).then((u) => live && setUrls((m) => (m.get(s.id) === u ? m : new Map(m).set(s.id, u))))
    return () => {
      live = false
    }
  }, [doc?.symbols])
  if (!d || !doc) return <p className="panel-empty">No document open</p>
  // A symbol being edited in its own tab: say so, and offer the way back.
  if (d.symbolOf)
    return (
      <p className="panel-empty">
        Editing a symbol <Hint text="What you do here goes into its document at once: every instance follows. Close the tab when you're done." />
      </p>
    )
  const list = doc.symbols ?? []
  const current = selectedSymbol(d)
  return (
    <div className="symbols" data-panel="symbols">
      {list.length ? (
        <ul className="channel-list symbol-list">
          {list.map((s) => {
            const n = instancesOf(doc, s.id).length
            return (
              <li key={s.id} className={`channel-row symbol-row${current === s.id ? ' current' : ''}`} data-symbol={s.id} aria-current={current === s.id || undefined} onDoubleClick={() => editSymbol(s.id)}>
                <button type="button" className="symbol-place" data-tip="Click to place an instance in the middle of the view, or drag it onto the canvas. Double-click to edit the symbol." aria-label={`Place ${s.name}`} onPointerDown={(e) => pressThumb(e, s, urls.get(s.id) ?? null)} onClick={() => placeInstance(s.id)}>
                  <Thumb symbol={s} />
                </button>
                <Name name={s.name} onRename={(name) => renameSymbolTo(s.id, name)} />
                <span className="item-meta" data-symbol-count={n}>
                  {n}
                </span>
                <button type="button" className="icon-button" aria-label={`Edit ${s.name}`} data-tip="Edit Symbol: every instance follows" data-symbol-edit={s.id} onClick={() => editSymbol(s.id)}>
                  <Icon name="ui.settings" />
                </button>
                <button type="button" className="icon-button" aria-label={`Duplicate ${s.name}`} data-tip="Duplicate" onClick={() => duplicateSymbolOf(s.id)}>
                  <Icon name="ui.duplicate" />
                </button>
                <button type="button" className="icon-button" aria-label={`Delete ${s.name}`} data-tip="Delete: its instances become groups of their own" data-symbol-delete={s.id} onClick={() => removeSymbol(s.id)}>
                  <Icon name="ui.close" />
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="panel-empty">
          No symbols <Hint text="Select some layers and choose New Symbol (F8): they become a symbol, placed where they were, and every instance follows when you edit it." />
        </p>
      )}
      <div className="panel-tools">
        <button type="button" className="button small" data-symbols="new" disabled={!canMakeSymbol(d)} data-why="Select the layers to make a symbol of" onClick={() => void newSymbolFromSelection()}>
          New Symbol
        </button>
        {current && (
          <>
            <select aria-label="Replace the selected instance's symbol" data-symbols="replace" value={current} onChange={(e) => replaceSelected(e.target.value)}>
              {list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button type="button" className="button small" data-symbols="break" data-tip="The instance becomes a group of its own, no longer following the symbol" onClick={() => breakLinkSelected()}>
              Break Link
            </button>
          </>
        )}
      </div>
    </div>
  )
})
