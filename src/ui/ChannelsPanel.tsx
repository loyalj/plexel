/**
 * The Channels panel and the Patterns panel: what a document keeps besides
 * its layers.
 *
 * Channels lists the composite, each colour channel, then the alpha and
 * spot channels, each with an eye and a thumbnail. A click on a row picks
 * it (what the tools edit) and shows it alone; Shift-click adds it; the
 * eyes only show and hide (app/channels.ts). Ctrl-click loads a channel as
 * the selection (Shift adds, Alt subtracts, both intersect): an alpha or
 * spot channel by its coverage, a colour channel by its brightness, the
 * composite by its luminosity. Alpha and spot channels are renamed by a
 * double-click on the name, opened in Channel Options by a double-click on
 * the thumbnail, and moved by dragging. Patterns are the document's
 * patterns made from pixels, for fills, fill layers, the Paint Bucket and
 * shapes.
 */
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { deletePicked, duplicatePicked, moveDocChannel, newChannel } from '../app/channelActions'
import { channels, COLOUR_NAMES, COMPOSITE_NAME, extraShown, type ChannelView } from '../app/channels'
import { colourSettings } from '../app/colourSettings'
import { documents, type OpenDoc } from '../app/documents'
import { deletePattern, renameDocPattern } from '../app/fills'
import { loadColourChannel, loadSelection, renameDocChannel, saveSelection } from '../app/selection'
import { opFor } from '../app/selectTools'
import type { DialogId } from '../commands'
import { PATTERN_TILE_TYPES, channelKind, type Doc, type DocChannel, type PatternTileType } from '../doc/types'
import { engine } from '../engine/EngineHost'
import type { Thumbnail } from '../engine/protocol'
import { Icon } from './Icon'
import { Hint, NumberField } from './controls'
import { cancelPattern, editPattern, finishPattern, makePatternFromSelection, patternEditOf, renameEditedPattern, savePatternCopy, setPatternTile, setTileSize, subscribePatternEdit } from '../app/patternEdit'
import { guidePrefs } from '../app/guidePrefs'
import { BRICK_OFFSETS, TILE_TYPE_LABELS } from '../doc/patterns'
import { MAX_PATTERN } from '../vector/paint'

/** A name that becomes a field on double-click; Enter keeps it, Esc puts it back. */
function Name({ name, onRename }: { name: string; onRename(n: string): void }) {
  const [editing, setEditing] = useState<string | null>(null)
  if (editing === null)
    return (
      <span className="channel-name" onDoubleClick={() => setEditing(name)} data-tip="Double-click to rename">
        {name}
      </span>
    )
  return (
    <input
      className="channel-name"
      value={editing}
      autoFocus
      onClick={(e) => e.stopPropagation()}
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

const THUMB = 28

interface ChannelThumbs {
  composite: Thumbnail | null
  colour: Thumbnail[]
  extras: Record<string, Thumbnail | null>
}

/** An id for each version of a document's layers, so the thumbnails know the picture changed. */
const versions = new WeakMap<object, number>()
let nextVersion = 1
const versionOf = (o: object) => {
  let v = versions.get(o)
  if (v === undefined) versions.set(o, (v = nextVersion++))
  return v
}

/**
 * The panel's thumbnails, from the engine: after a short pause (a stroke
 * or a drag is one request, not one a step), once the canvas has drawn
 * what it has to.
 */
function useChannelThumbs(key: string, doc: Doc): ChannelThumbs | null {
  const [thumbs, setThumbs] = useState<ChannelThumbs | null>(null)
  const display = useSyncExternalStore(colourSettings.subscribe, colourSettings.get).display
  const signature = useMemo(
    () => `${versionOf(doc.nodes)}|${doc.mode}/${doc.depth}/${JSON.stringify(doc.profile)}/${display}/${doc.width}x${doc.height}|${JSON.stringify((doc.channels ?? []).map((c) => [c.id, c.tiles, c.transform, c.kind]))}`,
    [doc, display],
  )
  const wanted = useRef(doc)
  wanted.current = doc
  useEffect(() => {
    let live = true
    const load = async () => {
      try {
        if (engine().getState().pending > 0) await Promise.race([engine().whenDrawn(), new Promise((r) => setTimeout(r, 2000))])
        if (!live) return
        const d = wanted.current
        const got = await engine().call('channel.thumbs', { key, size: Math.round(THUMB * devicePixelRatio), channels: (d.channels ?? []).map((c) => ({ id: c.id, kind: c.kind })) })
        if (live) setThumbs(got)
      } catch {
        // The document went, or the engine did: the next change asks again.
      }
    }
    const timer = setTimeout(() => void load(), 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [signature, key])
  return thumbs
}

/** A thumbnail on a canvas kept on the CPU, as the Layers panel's are. */
function Thumb({ thumb, onDoubleClick }: { thumb: Thumbnail | null | undefined; onDoubleClick?(): void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const empty = !thumb || !thumb.data.length
  useEffect(() => {
    const c = ref.current
    if (!c || !thumb || !thumb.data.length) return
    c.width = thumb.width
    c.height = thumb.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx?.putImageData(new ImageData(new Uint8ClampedArray(thumb.data), thumb.width, thumb.height), 0, 0)
  }, [thumb])
  return (
    <span className="channel-thumb checker" data-thumb={thumb === undefined ? 'pending' : empty ? 'empty' : 'image'} onDoubleClick={onDoubleClick}>
      {!empty && <canvas ref={ref} />}
    </span>
  )
}

interface RowProps {
  id: string
  name: string
  shown: boolean
  picked: boolean
  hint: string | null
  thumb: Thumbnail | null | undefined
  onEye(): void
  onPick(add: boolean): void
  onLoadSelection(e: { shiftKey: boolean; altKey: boolean }): void
  children?: React.ReactNode
}

function Row({ id, name, shown, picked, hint, thumb, onEye, onPick, onLoadSelection, children, ...extra }: RowProps & React.LiHTMLAttributes<HTMLLIElement> & { onThumbDoubleClick?(): void }) {
  const { onThumbDoubleClick, ...li } = extra
  return (
    <li
      {...li}
      className={`channel-row${picked ? ' selected' : ''}`}
      data-channel-row={id}
      data-picked={picked ? 'yes' : 'no'}
      data-shown={shown ? 'yes' : 'no'}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input')) return
        if (e.ctrlKey || e.metaKey) onLoadSelection(e)
        else onPick(e.shiftKey)
      }}
    >
      <button type="button" className="icon-button" aria-label={`${shown ? 'Hide' : 'Show'} ${name}`} aria-pressed={shown} data-channel-eye={id} onClick={onEye}>
        <Icon name={shown ? 'layer.visible' : 'layer.hidden'} />
      </button>
      <Thumb thumb={thumb} onDoubleClick={onThumbDoubleClick} />
      {children ?? <span className="channel-name">{name}</span>}
      {hint && <span className="item-meta channel-key">{hint}</span>}
    </li>
  )
}

const mod = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+'

export const ChannelsPanel = memo(function ChannelsPanel({ openDialog }: { openDialog(id: DialogId): void }) {
  const d = useSyncExternalStore(documents().subscribe, () => documents().active())
  const view = useSyncExternalStore(channels.subscribe, () => channels.active())
  if (!d || !view) return <p className="panel-empty">No document open</p>
  return <ChannelList d={d} view={view} openDialog={openDialog} />
})

function ChannelList({ d, view, openDialog }: { d: OpenDoc; view: ChannelView; openDialog(id: DialogId): void }) {
  const doc = d.history.present
  const thumbs = useChannelThumbs(d.key, doc)
  // The channel being dragged: a ref, so a drop in the same moment as the drag's start still sees it.
  const dragging = useRef<string | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const names = COLOUR_NAMES[doc.mode]
  const list = doc.channels ?? []
  const target = view.target
  const pickedColour = 'colour' in target ? target.colour : null
  const pickedExtra = 'channel' in target ? (list.find((c) => c.id === target.channel) ?? null) : null
  const allColour = !!pickedColour && pickedColour.every(Boolean)
  const colours = names.length > 1 ? names.length : 0
  const hint = (n: number) => (n <= 7 ? `${mod}${n + 2}` : null)
  const loadExtra = (c: DocChannel, e: { shiftKey: boolean; altKey: boolean }) => loadSelection(c.id, { invert: false, op: opFor(e, 'replace') })
  return (
    <div className="channels" data-panel="channels">
      <ul className="channel-list">
        <Row
          id="composite"
          name={COMPOSITE_NAME[doc.mode]}
          shown={view.colour.every(Boolean)}
          picked={allColour}
          hint={`${mod}2`}
          thumb={thumbs?.composite}
          onEye={() => channels.toggleColour(d.key, -1)}
          onPick={() => channels.pickComposite(d.key)}
          onLoadSelection={(e) => loadColourChannel(null, opFor(e, 'replace'))}
        />
        {colours > 0 &&
          names.map((n, i) => (
            <Row
              key={n}
              id={`colour:${i}`}
              name={n}
              shown={view.colour[i]}
              picked={!!pickedColour && !allColour && pickedColour[i]}
              hint={hint(i + 1)}
              thumb={thumbs?.colour[i]}
              onEye={() => channels.toggleColour(d.key, i)}
              onPick={(add) => channels.pickColour(d.key, i, add)}
              onLoadSelection={(e) => loadColourChannel(i, opFor(e, 'replace'))}
            />
          ))}
        {list.map((c, j) => (
          <Row
            key={c.id}
            id={c.id}
            name={c.name}
            shown={extraShown(view, c)}
            picked={pickedExtra?.id === c.id}
            hint={hint(colours + j + 1)}
            thumb={thumbs ? (thumbs.extras[c.id] ?? undefined) : undefined}
            onEye={() => channels.toggleExtra(d.key, c.id)}
            onPick={(add) => channels.pickChannel(d.key, c.id, add)}
            onLoadSelection={(e) => loadExtra(c, e)}
            onThumbDoubleClick={() => {
              channels.pickChannel(d.key, c.id, true)
              openDialog('channelOptions')
            }}
            draggable
            data-kind={channelKind(c)}
            data-drop={over === j ? 'here' : undefined}
            onDragStart={(e) => {
              dragging.current = c.id
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', c.name)
            }}
            onDragOver={(e) => {
              if (!dragging.current) return
              e.preventDefault()
              setOver(j)
            }}
            onDragLeave={() => setOver((o) => (o === j ? null : o))}
            onDrop={(e) => {
              e.preventDefault()
              if (dragging.current && dragging.current !== c.id) moveDocChannel(dragging.current, j)
              dragging.current = null
              setOver(null)
            }}
            onDragEnd={() => {
              dragging.current = null
              setOver(null)
            }}
          >
            <Name name={c.name} onRename={(n) => renameDocChannel(c.id, n)} />
            {channelKind(c) === 'spot' && <span className="item-meta">Spot</span>}
          </Row>
        ))}
      </ul>
      {!list.length && (
        <p className="panel-empty">
          No alpha or spot channels <Hint text="Save the selection as one, or make a new one to paint." />
        </p>
      )}
      <div className="panel-tools">
        <button
          type="button"
          className="icon-button"
          data-tip="Load the picked channel as the selection"
          aria-label="Load as selection"
          data-channels="load"
          onClick={() => {
            if (pickedExtra) loadExtra(pickedExtra, { shiftKey: false, altKey: false })
            else if (pickedColour && !allColour && pickedColour.filter(Boolean).length === 1) loadColourChannel(pickedColour.indexOf(true), 'replace')
            else loadColourChannel(null, 'replace')
          }}
        >
          <Icon name="channel.load" />
        </button>
        <button type="button" className="button small" disabled={!doc.selection} data-channels="save" data-tip="Save the selection as a new alpha channel" onClick={() => void saveSelection({ channel: null, name: '', op: 'replace' })}>
          Save Selection
        </button>
        <button type="button" className="button small" disabled={!pickedExtra || !doc.selection} data-tip="Replace the picked channel with the selection" onClick={() => pickedExtra && void saveSelection({ channel: pickedExtra.id, name: '', op: 'replace' })}>
          Save Into
        </button>
        <button type="button" className="button small" data-channels="new" data-tip="A new, empty alpha channel to paint" onClick={() => newChannel()}>
          New
        </button>
        <button type="button" className="button small" data-channels="new-spot" data-tip="A new spot colour channel" onClick={() => openDialog('newSpotChannel')}>
          New Spot…
        </button>
        <button type="button" className="button small" disabled={!pickedExtra} data-channels="duplicate" onClick={() => duplicatePicked()}>
          Duplicate
        </button>
        <button type="button" className="button small" disabled={!pickedExtra} data-channels="delete" onClick={() => deletePicked()}>
          Delete
        </button>
      </div>
    </div>
  )
}

export const PatternsPanel = memo(function PatternsPanel({ openDialog }: { openDialog(id: DialogId): void }) {
  const d = useSyncExternalStore(documents().subscribe, () => documents().active())
  useSyncExternalStore(subscribePatternEdit, () => patternEditOf(d?.key)?.tile)
  const doc = d?.history.present
  if (!d || !doc) return <p className="panel-empty">No document open</p>
  // A pattern's tile in its own tab: the Pattern Options.
  const editing = patternEditOf(d.key)
  if (editing) return <PatternOptions tabKey={d.key} doc={doc} />
  const list = doc.patterns ?? []
  return (
    <div className="patterns" data-panel="patterns">
      {list.length === 0 ? (
        <p className="panel-empty">
          No patterns <Hint text="Select an area and define one, or define the whole canvas as one." />
        </p>
      ) : (
        <ul className="channel-list">
          {list.map((p) => (
            <li key={p.id} className="channel-row" data-pattern={p.id} onDoubleClick={() => editPattern(p.id)}>
              <Name name={p.name} onRename={(n) => renameDocPattern(p.id, n)} />
              <span className="item-meta" title={p.art ? 'Made from artwork' : 'Made from pixels'}>
                {p.art ? '◇ ' : ''}
                {p.width} × {p.height}
              </span>
              <button type="button" className="icon-button" aria-label={`Edit ${p.name}`} data-pattern-edit={p.id} data-tip="Edit Pattern: its tile in a tab of its own, its copies round it" onClick={() => editPattern(p.id)}>
                <Icon name="ui.settings" />
              </button>
              <button type="button" className="icon-button" aria-label={`Delete ${p.name}`} onClick={() => deletePattern(p.id)}>
                <Icon name="ui.close" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="panel-tools">
        <button type="button" className="button small" data-patterns="define" onClick={() => openDialog('definePattern')}>
          Define Pattern…
        </button>
        <button type="button" className="button small" data-patterns="make" disabled={!d.selected} title="The selected layers as a new pattern’s tile, opened to edit" onClick={() => void makePatternFromSelection()}>
          Make Pattern
        </button>
      </div>
    </div>
  )
})

/** Pattern editing mode's options: the tile's layout, size and spacing, and the way out. */
function PatternOptions({ tabKey, doc }: { tabKey: string; doc: Doc }) {
  const e = patternEditOf(tabKey)!
  const prefs = useSyncExternalStore(guidePrefs().subscribe, guidePrefs().get)
  const t = e.tile
  const brick = t.type === 'brick-row' || t.type === 'brick-column'
  return (
    <div className="patterns pattern-options" data-panel="patterns" data-pattern-options={e.pattern}>
      <p className="field-meta">
        Pattern Options <Hint text="What’s drawn here is the pattern’s tile; everything drawn with the pattern follows as you go. The copies round it show how the tiles meet." />
      </p>
      <label className="field">
        <span>Name</span>
        <input id="pattern-name" defaultValue={e.name} key={e.name} onBlur={(ev) => renameEditedPattern(tabKey, ev.target.value)} onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()} />
      </label>
      <label className="field">
        <span>Tile Type</span>
        <select id="pattern-tile-type" value={t.type} onChange={(ev) => setPatternTile(tabKey, { type: ev.target.value as PatternTileType })}>
          {PATTERN_TILE_TYPES.map((k) => (
            <option key={k} value={k}>
              {TILE_TYPE_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      {brick && (
        <label className="field">
          <span>Brick Offset</span>
          <select id="pattern-brick-offset" value={String(t.offset)} onChange={(ev) => setPatternTile(tabKey, { offset: Number(ev.target.value) })}>
            {BRICK_OFFSETS.map((o) => (
              <option key={o} value={String(o)}>
                1/{Math.round(1 / o)}
              </option>
            ))}
          </select>
        </label>
      )}
      <NumberField id="pattern-width" label="Width" unit="px" min={1} max={MAX_PATTERN} value={doc.width} onChange={(w) => setTileSize(tabKey, w, doc.height)} hint="The tile’s width: the tab’s canvas, round its middle." />
      <NumberField id="pattern-height" label="Height" unit="px" min={1} max={MAX_PATTERN} value={doc.height} onChange={(h) => setTileSize(tabKey, doc.width, h)} />
      <NumberField id="pattern-spacing-x" label="H Spacing" unit="px" min={-MAX_PATTERN} max={MAX_PATTERN} value={t.spacing[0]} onChange={(v) => setPatternTile(tabKey, { spacing: [v, t.spacing[1]] })} hint="Room between tiles across; less than 0 overlaps them. With none, what’s drawn over the edge comes in at the other side." />
      <NumberField id="pattern-spacing-y" label="V Spacing" unit="px" min={-MAX_PATTERN} max={MAX_PATTERN} value={t.spacing[1]} onChange={(v) => setPatternTile(tabKey, { spacing: [t.spacing[0], v] })} />
      <label className="check">
        <input type="checkbox" id="pattern-copies" checked={prefs.tiledView} onChange={() => guidePrefs().toggle('tiledView')} />
        Show copies
      </label>
      <div className="panel-tools">
        <button type="button" className="button small primary" data-pattern-done onClick={() => void finishPattern(tabKey)}>
          Done
        </button>
        <button type="button" className="button small" data-pattern-cancel onClick={() => cancelPattern(tabKey)}>
          Cancel
        </button>
        <button type="button" className="button small" data-pattern-copy onClick={() => void savePatternCopy(tabKey)}>
          Save a Copy
        </button>
      </div>
    </div>
  )
}
