/**
 * The Layers panel: the document's tree, top layer first.
 *
 * A click selects, the eye shows and hides, the arrow folds a layer's
 * children away, and a double-click (or F2) renames in place: Enter keeps
 * the name, Esc or an empty name puts the old one back. Folding is view
 * state, kept beside the document and not in its history.
 *
 * Dragging a layer moves it: dropped on the top or bottom edge of a row it
 * goes above or below that layer, in the same group; dropped on the middle
 * of a row it goes inside that layer, as its top child. Inside a group
 * that's grouping; inside any other layer it's clipping, since children are
 * clipped to their parent (ARCHITECTURE.md, "Effects and clipping").
 *
 * Thumbnails are rendered by the engine, through the display's colour
 * table, and asked for again only for layers whose content changed.
 *
 * A layer with a mask shows the mask's thumbnail beside its own. A click
 * on either chooses what painting and the pixel commands work on, framed
 * to say which; Shift-click on the mask turns it off and on, and
 * Ctrl-click loads it as the selection, as in Photoshop. A layer clipped
 * to the one below it is marked with a hook.
 *
 * A layer's live filters (and adjustments on it alone) are listed under it,
 * each with its own eye; click one to change its settings in Properties.
 * "fx" marks a layer with a layer style: double-click it for the dialog.
 *
 * Alt-click on an eye shows that layer alone, hiding the rest; Alt-click it
 * again and they come back as they were. Hovering a row shows its quick
 * actions (lock, duplicate, delete); a locked layer shows its lock always.
 * Resting the pointer on a thumbnail shows it larger, and a drag says in
 * words where the layer would land.
 */
import { textEpoch } from '../app/text'
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { interfacePrefs } from './interface'
import { colourSettings } from '../app/colourSettings'
import { selectedIds, type MaskTarget, type OpenDoc } from '../app/documents'
import { pixelMaskOf, vectorMaskOf } from '../app/selection'
import { nodeDef } from '../doc/nodes'
import { ADJUSTMENT_BY_ID } from '../adjust/defs'
import { layerRows, placeOf } from '../doc/tree'
import type { BoolOp, Doc, DocNode, NodeId } from '../doc/types'
import { engine } from '../engine/EngineHost'
import type { Thumbnail } from '../engine/protocol'
import { Icon } from './Icon'
import type { IconName } from './icons'
import { Hint } from './controls'
import { zoomToLayer } from '../app/zoomTo'
import { isArtboard } from '../doc/artboards'

/** Thumbnail size in CSS pixels; rendered at the screen's pixel ratio. */
const THUMB = 22
/** Thumbnails asked for in one call to the engine: a few, so the canvas draws between them. */
const THUMBS_AT_ONCE = 8
/** The larger picture a resting pointer shows. */
const PEEK = 176
const PEEK_DELAY = 450

/** A version per node object, as EngineHost keeps; a subtree's key is its nodes' versions. */
const versions = new WeakMap<DocNode, number>()
let next = 1
const v = (n: DocNode) => {
  let x = versions.get(n)
  if (x === undefined) versions.set(n, (x = next++))
  return x
}
/** A version per symbol's contents object, as for nodes. */
const docVersions = new WeakMap<Doc, number>()
const docVersion = (d: Doc | undefined) => {
  if (!d) return 0
  let x = docVersions.get(d)
  if (x === undefined) docVersions.set(d, (x = next++))
  return x
}
/** `seen` keeps each node's key while one document's are worked out, so a group's isn't walked again for every layer above it. */
function contentKey(doc: Doc, id: NodeId, seen: Map<NodeId, string>): string {
  const had = seen.get(id)
  if (had !== undefined) return had
  const n = doc.nodes[id]
  // An instance's picture is its symbol's too: the symbol's contents count.
  const sym = n?.kind === 'symbol' ? `s${docVersion(doc.symbols?.find((x) => x.id === n.props.symbol)?.content)}` : ''
  const k = n ? `${v(n)}${sym}${n.children?.length ? `(${n.children.map((c) => contentKey(doc, c, seen)).join(',')})` : ''}` : ''
  seen.set(id, k)
  return k
}

/**
 * Thumbnails for a document's layers: rendered by the engine, after a
 * short pause so a slider drag isn't a thumbnail per step, and only for
 * layers whose content (or the document's colour, or the display) changed.
 */
function useThumbs(key: string, doc: Doc): Map<NodeId, Thumbnail | null> {
  const [thumbs, setThumbs] = useState(new Map<NodeId, Thumbnail | null>())
  const have = useRef(new Map<NodeId, string>())
  const display = useSyncExternalStore(colourSettings.subscribe, colourSettings.get).display
  // Text's picture changes when its fonts arrive, with the document unchanged.
  const fonts = useSyncExternalStore(textEpoch.subscribe, textEpoch.get)
  // Worked out once per document state, not on every render of the panel.
  const { ids, wanted, signature } = useMemo(() => {
    const ids = Object.values(doc.nodes)
      .filter((n) => n.kind === 'pixel' || n.kind === 'mask' || n.kind === 'embedded' || n.kind === 'vector' || n.kind === 'boolean' || n.kind === 'text' || n.kind === 'fill' || n.kind === 'symbol' || (n.kind === 'group' && n.id !== doc.root))
      .map((n) => n.id)
    const colourKey = `${doc.mode}/${doc.depth}/${JSON.stringify(doc.profile)}/${display}/${doc.width}x${doc.height}`
    const seen = new Map<NodeId, string>()
    const wanted = new Map(ids.map((id) => [id, `${id}:${contentKey(doc, id, seen)}:${colourKey}${doc.nodes[id].kind === 'text' || doc.nodes[id].kind === 'embedded' || doc.nodes[id].kind === 'group' ? `:${fonts}` : ''}`]))
    return { ids: new Set(ids), wanted, signature: [...wanted.values()].join('|') }
  }, [doc, display, fonts])
  useEffect(() => {
    let live = true
    const stale = [...ids].filter((id) => have.current.get(id) !== wanted.get(id))
    if (!stale.length) {
      if (thumbs.size !== ids.size) setThumbs((t) => new Map([...t].filter(([id]) => ids.has(id))))
      return
    }
    // The canvas comes first: thumbnails wait until it's drawn what it has to
    // (a document just opened, the view just moved), or two seconds, and are
    // made a few at a time, so frames get in between and a few hundred
    // layers' thumbnails don't hold the canvas still while they're made.
    const canvasFirst = (first: boolean) => (first || engine().getState().pending > 0 ? Promise.race([engine().whenDrawn(), new Promise((r) => setTimeout(r, 2000))]) : Promise.resolve())
    const load = async () => {
      const size = Math.round(THUMB * devicePixelRatio)
      try {
        for (let i = 0; i < stale.length && live; i += THUMBS_AT_ONCE) {
          await canvasFirst(i === 0)
          if (!live) return
          const some = stale.slice(i, i + THUMBS_AT_ONCE)
          const got = await engine().call('render.thumbnails', { key, nodes: some, size })
          if (!live) return
          setThumbs((t) => {
            const m = new Map([...t].filter(([id]) => ids.has(id)))
            for (const id of some) {
              m.set(id, got[id] ?? null)
              have.current.set(id, wanted.get(id)!)
            }
            return m
          })
        }
      } catch {
        // The document went, or the engine did: the next change asks again.
      }
    }
    const timer = setTimeout(() => void load(), 120)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // The signature is everything the thumbnails depend on.
  }, [signature, key])
  return thumbs
}

type Drop = { target: NodeId | null; where: 'above' | 'below' | 'into' }

interface Props {
  doc: OpenDoc
  /** The layer being renamed, set by F2 or a double-click. */
  renaming: NodeId | null
  onRenaming(id: NodeId | null): void
  /** Selects a layer; `mask` makes one of its masks, not the layer, what gets edited. */
  onSelect(id: NodeId | null, mask?: MaskTarget): void
  /** Several layers selected (Ctrl- and Shift-click), with `key` as the key layer. */
  onSelectMany(ids: NodeId[], key: NodeId): void
  /** Shift-click on a mask thumbnail (turn it off or on) or Ctrl-click (load it as the selection). */
  onMaskClick(layer: NodeId, mask: NodeId, how: 'toggle' | 'select'): void
  /** Shows or hides one of a layer's effects. */
  onToggleEffect(id: NodeId): void
  /** Opens the Layer Style dialog for a layer. */
  onStyle(id: NodeId): void
  onToggleVisible(id: NodeId): void
  /** Alt-click on an eye: this layer alone, or everything back as it was. */
  onSolo(id: NodeId): void
  /** The row's quick actions. */
  onToggleLock(id: NodeId): void
  onDuplicate(id: NodeId): void
  onDeleteLayer(id: NodeId): void
  onToggleFold(id: NodeId): void
  onRename(id: NodeId, name: string): void
  /** Moves a layer into `parent` at `index` (painting order, counted without it). */
  onMove(id: NodeId, parent: NodeId, index: number): void
  /** The panel's foot: a new pixel layer, a new adjustment layer (a menu of them, at the button), and Duplicate and Delete for what's selected. */
  onNewLayer(): void
  onNewAdjustment(at: { x: number; y: number }): void
  onDuplicateSelected(): void
  onDelete(): void
}

/** What the panel asks for: the app gives the same functions every render (lib/stable.ts), so the memoised panel draws again only for its document. */
export type LayerActions = Omit<Props, 'doc' | 'renaming'>

export const LayersPanel = memo(function LayersPanel({ doc, renaming, onRenaming, onSelect, onSelectMany, onMaskClick, onToggleEffect, onStyle, onToggleVisible, onSolo, onToggleLock, onDuplicate, onDeleteLayer, onToggleFold, onRename, onMove, onNewLayer, onNewAdjustment, onDuplicateSelected, onDelete }: Props) {
  const present = doc.history.present
  const rows = layerRows(present, doc.folded)
  const thumbs = useThumbs(doc.key, present)
  const [drop, setDrop] = useState<Drop | null>(null)
  const dragging = useRef<{ id: NodeId; x: number; y: number; started: boolean; pointer: number } | null>(null)
  /** The layer being dragged and where the pointer is, for the label that follows it. */
  const [carry, setCarry] = useState<{ id: NodeId; x: number; y: number } | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const peek = usePeek(doc.key)

  /** Where a drop at (x, y) would put the layer. */
  const dropAt = (x: number, y: number, id: NodeId): Drop | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.layer-row')
    if (!el) return list.current && list.current.getBoundingClientRect().bottom < y ? { target: null, where: 'below' } : null
    const target = el.dataset.layer!
    if (target === id) return null
    const r = el.getBoundingClientRect()
    const f = (y - r.top) / r.height
    const where = f < 0.3 ? 'above' : f > 0.7 ? 'below' : 'into'
    return { target, where }
  }

  /** The parent and index a drop means, or null if the move isn't allowed there. */
  const resolve = (id: NodeId, d: Drop): { parent: NodeId; index: number } | null => {
    if (!d.target) return { parent: present.root, index: 0 }
    const t = present.nodes[d.target]
    if (!t) return null
    if (d.where === 'into') {
      if (!t.children || !nodeDef(t.kind).accepts?.(present.nodes[id].kind)) return null
      return { parent: t.id, index: t.children.filter((c) => c !== id).length }
    }
    const place = placeOf(present, t.id)
    if (!place || place.slot !== 'children') return null
    const siblings = present.nodes[place.parent].children!.filter((c) => c !== id)
    const at = siblings.indexOf(t.id)
    return { parent: place.parent, index: d.where === 'above' ? at + 1 : at }
  }

  const onRowPointerDown = (e: React.PointerEvent, id: NodeId) => {
    // The row keeps whichever of pixels or mask was chosen; a thumbnail chooses.
    const thumb = (e.target as HTMLElement).closest<HTMLElement>('[data-part]')?.dataset.part
    // Ctrl-click adds a layer to those selected, or takes it out; Shift-click selects every row from the key layer to it.
    if (e.button === 0 && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      const all = selectedIds(doc)
      if (all.includes(id)) {
        const rest = all.filter((x) => x !== id)
        if (rest.length) onSelectMany(rest, doc.selected === id ? rest[rest.length - 1] : doc.selected!)
      } else onSelectMany([...all, id], id)
      return
    }
    if (e.button === 0 && e.shiftKey && doc.selected && doc.selected !== id) {
      const order = rows.map((r) => r.node.id)
      const a = order.indexOf(doc.selected)
      const b = order.indexOf(id)
      if (a >= 0 && b >= 0) {
        onSelectMany(order.slice(Math.min(a, b), Math.max(a, b) + 1), doc.selected)
        return
      }
    }
    onSelect(id, thumb ? (thumb === 'mask' ? 'pixel' : thumb === 'vmask' ? 'vector' : false) : doc.selected === id ? doc.maskTarget : false)
    if (e.button !== 0 || renaming) return
    dragging.current = { id, x: e.clientX, y: e.clientY, started: false, pointer: e.pointerId }
  }

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragging.current
      if (!d || e.pointerId !== d.pointer) return
      if (!d.started && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return
      d.started = true
      const at = dropAt(e.clientX, e.clientY, d.id)
      setDrop(at && resolve(d.id, at) ? at : null)
      setCarry({ id: d.id, x: e.clientX, y: e.clientY })
    }
    const up = (e: PointerEvent) => {
      const d = dragging.current
      if (!d || e.pointerId !== d.pointer) return
      dragging.current = null
      if (d.started) {
        const at = dropAt(e.clientX, e.clientY, d.id)
        const r = at && resolve(d.id, at)
        if (r) onMove(d.id, r.parent, r.index)
      }
      setDrop(null)
      setCarry(null)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
    return () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
    }
  })

  return (
    // A click in the empty part of the panel, below the layers, deselects,
    // so the Properties panel goes back to the document.
    <div className="layers" onPointerDown={(e) => e.target === e.currentTarget && onSelect(null)}>
      {rows.length === 0 ? (
        <p className="panel-empty">
          No layers <Hint text="Layer → New Pixel Layer adds one, and File → Import as Layer brings in an image." />
        </p>
      ) : (
        <ul
          ref={list}
          className={`layer-list${drop && !drop.target ? ' drop-end' : ''}`}
          role="tree"
          aria-multiselectable
          aria-label="Layers"
          onPointerDown={(e) => e.target === e.currentTarget && onSelect(null)}
        >
          {rows.map(({ node, depth }) => {
            const selected = doc.selected === node.id
            const also = !selected && doc.others.includes(node.id)
            const hasKids = !!node.children?.length
            const folded = doc.folded.has(node.id)
            const dropHere = drop?.target === node.id ? ` drop-${drop.where}` : ''
            const mask = pixelMaskOf(present, node)
            const vmask = vectorMaskOf(present, node)
            const place = placeOf(present, node.id)
            const parent = place && place.slot === 'children' ? present.nodes[place.parent] : null
            // In a compound shape a child is an operand, not a clipped layer.
            const operand = parent?.kind === 'boolean' ? parent : null
            const clipped = !!parent && parent.kind !== 'group' && !operand
            const onMask = selected && doc.maskTarget === 'pixel' && !!mask
            const onVmask = selected && doc.maskTarget === 'vector' && !!vmask
            return (
              [<li
                key={node.id}
                role="treeitem"
                aria-selected={selected || also}
                aria-expanded={hasKids ? !folded : undefined}
                className={`layer-row${selected ? ' selected' : ''}${also ? ' selected also' : ''}${node.visible ? '' : ' hidden-layer'}${clipped ? ' clipped' : ''}${dropHere}${carry?.id === node.id ? ' carried' : ''}`}
                data-layer={node.id}
                style={{ paddingLeft: 4 + depth * 14 }}
                onPointerDown={(e) => onRowPointerDown(e, node.id)}
                onDoubleClick={() => onRenaming(node.id)}
              >
                <button
                  type="button"
                  className="layer-eye"
                  aria-label={node.visible ? `Hide ${node.name}` : `Show ${node.name}`}
                  aria-pressed={node.visible}
                  data-tip={`${node.visible ? 'Hide' : 'Show'}; Alt-click shows this layer alone, or everything again`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => (e.altKey ? onSolo(node.id) : onToggleVisible(node.id))}
                >
                  <Icon name={node.visible ? 'layer.visible' : 'layer.hidden'} />
                </button>
                <button
                  type="button"
                  className="layer-fold"
                  aria-label={folded ? `Unfold ${node.name}` : `Fold ${node.name}`}
                  disabled={!hasKids}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onToggleFold(node.id)}
                >
                  {hasKids ? <Icon name={folded ? 'layer.fold-closed' : 'layer.fold-open'} /> : ''}
                </button>
                {clipped && (
                  <span className="layer-clip" data-tip="Clipped to the layer below" aria-label="Clipped">
                    <Icon name="layer.clipped" />
                  </span>
                )}
                {operand && (
                  <span className="layer-op" data-op={operandOp(operand, node.id)} data-tip={OP_TITLES[operandOp(operand, node.id)]} aria-label={OP_TITLES[operandOp(operand, node.id)]}>
                    <Icon name={OP_ICONS[operandOp(operand, node.id)]} />
                  </span>
                )}
                {(node.kind === 'pixel' || node.kind === 'group' || node.kind === 'embedded' || node.kind === 'vector' || node.kind === 'boolean' || node.kind === 'text' || node.kind === 'fill' || node.kind === 'symbol') && (
                  <span
                    className={`layer-part${selected && !onMask && !onVmask && (mask || vmask) ? ' target' : ''}${node.kind === 'embedded' ? ' smart' : ''}`}
                    data-part="content"
                    data-tip={node.kind === 'embedded' ? 'Smart object: Layer → Smart Objects → Edit Contents opens it.' : undefined}
                    {...peek.hover(node.id, node.name)}
                    onDoubleClick={(e) => {
                      // The thumbnail frames the layer; the rest of the row renames it.
                      e.stopPropagation()
                      void zoomToLayer(node.id)
                    }}
                  >
                    <LayerThumb thumb={thumbs.get(node.id)} group={node.kind === 'group'} />
                  </span>
                )}
                {node.kind === 'adjustment' && (
                  <span className="layer-thumb adjust" data-thumb="adjust" aria-hidden="true">
                    <Icon name="layer.adjustment" />
                  </span>
                )}
                {mask && (
                  <span
                    className={`layer-part mask${onMask ? ' target' : ''}${mask.visible ? '' : ' disabled'}`}
                    data-part="mask"
                    data-mask={mask.id}
                    data-tip={`Layer mask${mask.visible ? '' : ' (off)'}. Click to paint on it; Shift-click turns it ${mask.visible ? 'off' : 'on'}; Ctrl-click loads it as the selection.`}
                    {...peek.hover(mask.id, `${node.name}: layer mask`)}
                    onPointerDown={(e) => {
                      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) return
                      e.stopPropagation()
                      onMaskClick(node.id, mask.id, e.shiftKey ? 'toggle' : 'select')
                    }}
                  >
                    <LayerThumb thumb={thumbs.get(mask.id)} group={false} />
                  </span>
                )}
                {vmask && (
                  <span
                    className={`layer-part mask vector${onVmask ? ' target' : ''}${vmask.visible ? '' : ' disabled'}`}
                    data-part="vmask"
                    data-mask={vmask.id}
                    data-tip={`Vector mask${vmask.visible ? '' : ' (off)'}. Click to edit its outline with the Pen and Direct Selection; Shift-click turns it ${vmask.visible ? 'off' : 'on'}.`}
                    onPointerDown={(e) => {
                      if (!e.shiftKey) return
                      e.stopPropagation()
                      onMaskClick(node.id, vmask.id, 'toggle')
                    }}
                  >
                    <LayerThumb thumb={thumbs.get(vmask.id)} group={false} />
                  </span>
                )}
                {renaming === node.id ? (
                  <RenameField
                    initial={node.name}
                    onDone={(name) => {
                      onRenaming(null)
                      if (name !== null) onRename(node.id, name)
                    }}
                  />
                ) : (
                  <span className="layer-name">{node.name}</span>
                )}
                {node.fx.some((f) => f.enabled) && (
                  <button
                    type="button"
                    className="layer-fx"
                    data-tip="Layer style: double-click to change it"
                    aria-label={`Layer style of ${node.name}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      onStyle(node.id)
                    }}
                  >
                    fx
                  </button>
                )}
                <span className="layer-kind">{node.kind === 'adjustment' ? adjustmentLabel(node) : isArtboard(node) ? 'Artboard' : nodeDef(node.kind).label}</span>
                <span className={`layer-actions${node.locked.all ? ' locked' : ''}`}>
                  <RowAction label={node.locked.all ? `Unlock ${node.name}` : `Lock ${node.name}`} tip={node.locked.all ? 'Unlock' : 'Lock'} action="lock" pressed={node.locked.all} onAct={() => onToggleLock(node.id)}>
                    <Icon name={node.locked.all ? 'layer.locked' : 'layer.unlocked'} />
                  </RowAction>
                  <RowAction label={`Duplicate ${node.name}`} tip="Duplicate" action="duplicate" onAct={() => onDuplicate(node.id)}>
                    <Icon name="layer.duplicate" />
                  </RowAction>
                  <RowAction label={`Delete ${node.name}`} tip="Delete" action="delete" onAct={() => onDeleteLayer(node.id)}>
                    <Icon name="layer.delete" />
                  </RowAction>
                </span>
              </li>,
              ...node.effects.map((eid) => {
                const e = present.nodes[eid]
                if (!e) return null
                const sel = doc.selected === eid
                return (
                  <li
                    key={eid}
                    role="treeitem"
                    aria-selected={sel}
                    className={`layer-row effect-row${sel ? ' selected' : ''}${e.visible ? '' : ' hidden-layer'}`}
                    data-effect={eid}
                    style={{ paddingLeft: 4 + (depth + 1) * 14 + 22 }}
                    onPointerDown={(ev) => {
                      ev.stopPropagation()
                      onSelect(eid)
                    }}
                  >
                    <button
                      type="button"
                      className="layer-eye"
                      aria-label={e.visible ? `Hide ${e.name}` : `Show ${e.name}`}
                      aria-pressed={e.visible}
                      onPointerDown={(ev) => ev.stopPropagation()}
                      onClick={() => onToggleEffect(eid)}
                    >
                      <Icon name={e.visible ? 'layer.visible' : 'layer.hidden'} />
                    </button>
                    <span className="layer-name">{e.name}</span>
                    <span className="layer-kind">{e.kind === 'filter' ? 'Live Filter' : 'Adjustment'}</span>
                  </li>
                )
              }),
            ]
            )
          })}
        </ul>
      )}
      <div className="panel-tools layers-tools" role="toolbar" aria-label="Layer actions">
        <FootButton action="new-adjustment" label="New Adjustment Layer" icon="layer.new-adjustment" onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          // Up from the button's top, its right edge at the button's (it flips left at the window's edge).
          onNewAdjustment({ x: r.right, y: r.top - 2 })
        }} />
        <FootButton action="new" label="New Pixel Layer" icon="layer.new" onClick={onNewLayer} />
        <FootButton action="duplicate" label="Duplicate Layer" icon="layer.duplicate" why={doc.selected ? null : 'Select a layer first'} onClick={onDuplicateSelected} />
        <FootButton action="delete" label={doc.others.length ? 'Delete Layers' : 'Delete Layer'} icon="layer.delete" why={doc.selected ? null : 'Select a layer first'} onClick={onDelete} />
      </div>
      {/* On the page, not in the dock, whose scrolling and zoom would carry them off. */}
      {carry && createPortal(<DragLabel name={present.nodes[carry.id]?.name ?? ''} drop={drop} doc={present} x={carry.x} y={carry.y} />, document.body)}
      {peek.view && createPortal(peek.view, document.body)}
    </div>
  )
})

/** One of the icon buttons along the panel's foot; `why` disables it and says why. */
function FootButton({ action, label, icon, why = null, onClick }: { action: string; label: string; icon: IconName; why?: string | null; onClick(e: React.MouseEvent<HTMLButtonElement>): void }) {
  return (
    <button type="button" className="icon-button" data-layers-tool={action} aria-label={label} data-tip={label} disabled={!!why} data-why={why ?? undefined} onClick={onClick}>
      <Icon name={icon} />
    </button>
  )
}

/** A quick action on a row: shown while the row is hovered (a locked layer's lock always). */
function RowAction({ label, tip, action, pressed, onAct, children }: { label: string; tip: string; action: string; pressed?: boolean; onAct(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="layer-action"
      aria-label={label}
      aria-pressed={pressed}
      data-tip={tip}
      data-layer-action={action}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onAct()
      }}
    >
      {children}
    </button>
  )
}

/** Where a dragged layer would land, in words, beside the pointer. */
function DragLabel({ name, drop, doc, x, y }: { name: string; drop: Drop | null; doc: Doc; x: number; y: number }) {
  const s = interfacePrefs().get().scale
  const target = drop?.target ? doc.nodes[drop.target] : null
  const where = !drop
    ? 'Can’t go here'
    : !drop.target
      ? 'To the bottom'
      : drop.where === 'into'
        ? target?.kind === 'group' || target?.kind === 'boolean'
          ? `Into ${target.name}`
          : `Clipped to ${target?.name}`
        : `${drop.where === 'above' ? 'Above' : 'Below'} ${target?.name}`
  return (
    <div className={`layer-drag-label${drop ? '' : ' refused'}`} data-drag-label style={{ left: (x + 14) / s, top: (y + 10) / s }}>
      <strong>{name}</strong> {where}
    </div>
  )
}

/**
 * The larger picture of a layer or mask a resting pointer shows, beside
 * the panel: rendered by the engine at its size when asked for, so the
 * rows' thumbnails stay small and cheap.
 */
function usePeek(key: string) {
  const [shown, setShown] = useState<{ id: NodeId; name: string; rect: DOMRect; edge: number; thumb: Thumbnail | null } | null>(null)
  const timer = useRef(0)
  const wanted = useRef<NodeId | null>(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const hover = (id: NodeId, name: string) => ({
    'data-peek': id,
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType === 'touch' || e.buttons) return
      const rect = e.currentTarget.getBoundingClientRect()
      // Beside the dock, not over it.
      const edge = e.currentTarget.closest('.dock')?.getBoundingClientRect().left ?? rect.left
      wanted.current = id
      clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        setShown({ id, name, rect, edge, thumb: null })
        void engine()
          .call('render.thumbnails', { key, nodes: [id], size: Math.round(PEEK * devicePixelRatio) })
          .then((got) => wanted.current === id && setShown((s) => (s && s.id === id ? { ...s, thumb: got[id] ?? null } : s)))
          .catch(() => {})
      }, PEEK_DELAY)
    },
    onPointerLeave: () => {
      wanted.current = null
      clearTimeout(timer.current)
      setShown(null)
    },
    onPointerDown: () => {
      wanted.current = null
      clearTimeout(timer.current)
      setShown(null)
    },
  })
  let view: ReactNode = null
  if (shown) {
    const s = interfacePrefs().get().scale
    // To the left of the panel, level with the row, kept on screen.
    const w = (PEEK + 16) * s
    const left = Math.max(4, shown.edge - w - 8)
    const top = Math.min(innerHeight - (PEEK + 40) * s, Math.max(4, shown.rect.top - 40 * s))
    view = (
      <div className="layer-peek" data-layer-peek={shown.id} style={{ left: left / s, top: top / s }}>
        <LayerThumb thumb={shown.thumb ?? undefined} group={false} />
        <span className="layer-peek-name">{shown.name}</span>
      </div>
    )
  }
  return { hover, view }
}

/** How a compound shape's operand combines with the ones below it: the bottom one is the base. */
function operandOp(compound: DocNode, id: NodeId): BoolOp | 'base' {
  if (compound.kind !== 'boolean') return 'add'
  if (compound.children?.[0] === id) return 'base'
  return compound.props.ops[id] ?? 'add'
}
const OP_ICONS: Record<BoolOp | 'base', IconName> = { base: 'compound.base', add: 'compound.add', subtract: 'compound.subtract', intersect: 'compound.intersect', exclude: 'compound.exclude' }
const OP_TITLES: Record<BoolOp | 'base', string> = {
  base: 'The compound’s base shape',
  add: 'Added to the shapes below it',
  subtract: 'Subtracted from the shapes below it',
  intersect: 'Intersected with the shapes below it',
  exclude: 'Excluded where it overlaps the shapes below it',
}

/** What an adjustment layer is, for its row. */
const adjustmentLabel = (n: DocNode) => (n.kind === 'adjustment' ? (ADJUSTMENT_BY_ID.get(n.props.adjustment)?.label ?? 'Adjustment') : '')

/**
 * A layer's thumbnail: the engine's picture over the checkerboard, or the
 * checkerboard alone when the layer is empty. `data-thumb` says which, and
 * `data-colour` the colour at its centre, for the checks.
 */
function LayerThumb({ thumb, group }: { thumb: Thumbnail | null | undefined; group: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const display = useSyncExternalStore(colourSettings.subscribe, colourSettings.get).display
  const empty = !thumb || !thumb.data.length
  useEffect(() => {
    const c = ref.current
    if (!c || !thumb || !thumb.data.length) return
    c.width = thumb.width
    c.height = thumb.height
    const space = display === 'display-p3' ? 'display-p3' : 'srgb'
    // Kept on the CPU (willReadFrequently): a canvas on the GPU is a
    // composited layer of its own, and two hundred thumbnails made every
    // change to the page cost about 10 ms of working out layers.
    const ctx = c.getContext('2d', { colorSpace: space, willReadFrequently: true })
    if (!ctx) return
    ctx.putImageData(new ImageData(new Uint8ClampedArray(thumb.data), thumb.width, thumb.height, { colorSpace: space }), 0, 0)
  }, [thumb, display])
  const centre = (() => {
    if (!thumb || !thumb.data.length) return undefined
    const o = (Math.floor(thumb.height / 2) * thumb.width + Math.floor(thumb.width / 2)) * 4
    return `rgb(${thumb.data[o]}, ${thumb.data[o + 1]}, ${thumb.data[o + 2]})`
  })()
  return (
    <span className={`layer-thumb checker${group ? ' group' : ''}`} data-thumb={thumb === undefined ? 'pending' : empty ? 'empty' : 'image'} data-colour={centre}>
      {!empty && <canvas ref={ref} />}
    </span>
  )
}

/** The name field for renaming in place. Calls back with the name, or null to keep the old one. */
function RenameField({ initial, onDone }: { initial: string; onDone(name: string | null): void }) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  return (
    <input
      ref={input}
      className="layer-rename"
      aria-label="Layer name"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(value.trim() ? value : null)
        if (e.key === 'Escape') finish(null)
      }}
      onBlur={() => finish(value.trim() ? value : null)}
    />
  )
}
