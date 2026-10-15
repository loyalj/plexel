/**
 * The Channels panel's state for each open document: which channels are
 * shown and which are edited. View state, as in Photoshop: none of it is
 * in the history or the file.
 *
 *   colour   the colour channels shown (Red, Green, Blue; Cyan, Magenta,
 *            Yellow, Black; Gray). Hidden ones are left out of the canvas
 *            in the display pass; one alone shows in gray; none shows
 *            paper.
 *   extras   alpha and spot channels shown or hidden, by id, where that
 *            was changed: otherwise spots are shown (they're part of the
 *            picture) and alphas hidden.
 *   target   what the tools edit: some or all of the colour channels, or
 *            one alpha or spot channel.
 *
 * A click on a row targets that channel and shows it alone; Shift-click
 * adds it. The eyes only show and hide. Picking another layer targets the
 * colour channels again, so a channel picked long ago never leaves a
 * layer unpaintable.
 */
import { channelKind, channelOpacity, ALPHA_TINT, type ColourMode, type Doc, type DocChannel } from '../doc/types'
import type { ShownChannel } from '../render/overlay'
import { Listeners } from '../lib/listeners'
import { colourEngineNow } from './colour'
import { documents, type OpenDoc } from './documents'
import { proofing } from './proofing'

/** At most this many alpha and spot channels show on the canvas at once (the screen pass's room). */
export const MAX_SHOWN = 4

export type ChannelTarget = { colour: boolean[] } | { channel: string }

export interface ChannelView {
  colour: boolean[]
  extras: Record<string, boolean>
  target: ChannelTarget
}

/** The colour channels' names, in order, for a mode. */
export const COLOUR_NAMES: Record<ColourMode, string[]> = {
  rgb: ['Red', 'Green', 'Blue'],
  cmyk: ['Cyan', 'Magenta', 'Yellow', 'Black'],
  gray: ['Gray'],
}
export const COMPOSITE_NAME: Record<ColourMode, string> = { rgb: 'RGB', cmyk: 'CMYK', gray: 'Gray' }

const all = (mode: ColourMode) => COLOUR_NAMES[mode].map(() => true)
const fresh = (mode: ColourMode): ChannelView => ({ colour: all(mode), extras: {}, target: { colour: all(mode) } })

const views = new Map<string, ChannelView>()
const changes = new Listeners()

/** A view made to fit its document: as many colour channels as the mode has, a target that's still there. */
function fit(v: ChannelView, doc: Doc): ChannelView {
  const n = COLOUR_NAMES[doc.mode].length
  let out = v
  if (v.colour.length !== n) out = { ...out, colour: all(doc.mode) }
  const t = out.target
  // A channel picked that's gone (deleted, or undone): the colour channels picked and shown again, not a canvas of paper.
  if ('colour' in t ? t.colour.length !== n || !t.colour.some(Boolean) : !doc.channels?.some((c) => c.id === t.channel)) out = { ...out, colour: all(doc.mode), target: { colour: all(doc.mode) } }
  return out
}

function viewOf(d: OpenDoc): ChannelView {
  const had = views.get(d.key)
  const v = fit(had ?? fresh(d.history.present.mode), d.history.present)
  if (v !== had) views.set(d.key, v)
  // The colour shown again (read during a render, say): the engine's look follows, once the render's done.
  if (had && v.colour !== had.colour) queueMicrotask(() => proofing.update(d.key, { channels: undefined }))
  return v
}

/** Whether an alpha or spot channel is shown. */
export function extraShown(v: ChannelView, c: DocChannel): boolean {
  return v.extras[c.id] ?? channelKind(c) === 'spot'
}

/** The alpha and spot channels shown on the canvas, as the engine draws them: the first MAX_SHOWN, colours in sRGB. */
export function shownChannels(doc: Doc, v: ChannelView): ShownChannel[] {
  const out: ShownChannel[] = []
  for (const c of doc.channels ?? []) {
    if (!extraShown(v, c) || out.length >= MAX_SHOWN) continue
    out.push({ id: c.id, kind: channelKind(c), colour: channelSrgb(c), opacity: channelOpacity(c), marks: c.marks ?? 'masked' })
  }
  return out
}

/** A channel's colour on screen, sRGB: an alpha's tint, a spot's ink. */
export function channelSrgb(c: DocChannel): [number, number, number] {
  if (channelKind(c) !== 'spot' || !c.ink) return c.tint ?? ALPHA_TINT
  const cms = colourEngineNow()
  if (!cms) return c.ink.space === 'rgb' ? (c.ink.c.slice(0, 3) as [number, number, number]) : [0.5, 0.5, 0.5]
  return cms.converter.convert(c.ink, { space: 'rgb', profile: { builtin: 'srgb' } }, 'relative', true).c.slice(0, 3) as [number, number, number]
}

function set(key: string, v: ChannelView) {
  const was = views.get(key)
  views.set(key, v)
  if (!was || was.colour.some((x, i) => x !== v.colour[i]) || was.colour.length !== v.colour.length) proofing.update(key, { channels: v.colour.every(Boolean) ? undefined : [...v.colour] })
  changes.emit()
}

export const channels = {
  /** A document's view; the default for one not open. */
  get(key: string | null | undefined): ChannelView | null {
    const d = key ? documents().get(key) : null
    return d ? viewOf(d) : null
  },
  active(): ChannelView | null {
    return channels.get(documents().getState().active)
  },
  subscribe(fn: () => void) {
    return changes.subscribe(fn)
  },

  /** A click on the composite's row: every colour channel shown and edited. */
  pickComposite(key: string) {
    const d = documents().get(key)
    if (!d) return
    const v = viewOf(d)
    set(key, { ...v, colour: all(d.history.present.mode), target: { colour: all(d.history.present.mode) } })
  },

  /** A click on a colour channel's row: that one alone shown and edited; with `add`, added to those. */
  pickColour(key: string, index: number, add = false) {
    const d = documents().get(key)
    if (!d) return
    const v = viewOf(d)
    const n = COLOUR_NAMES[d.history.present.mode].length
    if (index < 0 || index >= n) return
    const was = 'colour' in v.target ? v.target.colour : v.colour.map(() => false)
    // Shift-click takes a channel out again, but never the last one.
    const target = add ? was.map((x, i) => (i === index ? !x : x)) : was.map((_, i) => i === index)
    if (!target.some(Boolean)) target[index] = true
    set(key, { ...v, colour: add ? v.colour.map((x, i) => x || i === index) : target, target: { colour: target } })
  },

  /** A click on an alpha or spot channel's row: it's edited and shown, alone (the colour hidden) unless `add`. */
  pickChannel(key: string, id: string, add = false) {
    const d = documents().get(key)
    if (!d?.history.present.channels?.some((c) => c.id === id)) return
    const v = viewOf(d)
    const extras = { ...v.extras, [id]: true }
    if (!add) for (const c of d.history.present.channels) if (c.id !== id && channelKind(c) === 'alpha') extras[c.id] = false
    set(key, { colour: add ? v.colour : v.colour.map(() => false), extras, target: { channel: id } })
  },

  /** A colour channel's eye; the composite's (index -1) shows them all, or hides them all when all are shown. */
  toggleColour(key: string, index: number) {
    const d = documents().get(key)
    if (!d) return
    const v = viewOf(d)
    const colour = index < 0 ? v.colour.map(() => !v.colour.every(Boolean)) : v.colour.map((x, i) => (i === index ? !x : x))
    set(key, { ...v, colour })
  },

  /** An alpha or spot channel's eye. */
  toggleExtra(key: string, id: string) {
    const d = documents().get(key)
    const c = d?.history.present.channels?.find((x) => x.id === id)
    if (!d || !c) return
    const v = viewOf(d)
    set(key, { ...v, extras: { ...v.extras, [id]: !extraShown(v, c) } })
  },

  /** Every colour channel shown, what's picked left as it is. */
  showColour(key: string) {
    const d = documents().get(key)
    if (!d) return
    const v = viewOf(d)
    if (!v.colour.every(Boolean)) set(key, { ...v, colour: v.colour.map(() => true) })
  },

  /** Shows a channel (one just made, so it can be seen being painted). */
  show(key: string, id: string) {
    const d = documents().get(key)
    if (!d) return
    const v = viewOf(d)
    if (v.extras[id] !== true) set(key, { ...v, extras: { ...v.extras, [id]: true } })
  },
}

/** The alpha or spot channel the tools edit, if one is targeted (and Quick Mask isn't on, which edits the selection). */
export function channelTarget(d: OpenDoc): DocChannel | null {
  if (d.quickMask) return null
  const t = viewOf(d).target
  return 'channel' in t ? (d.history.present.channels?.find((c) => c.id === t.channel) ?? null) : null
}

/**
 * The colour channels a layer's pixels are edited in, when only some are
 * targeted: true for each edited; null for all of them (the usual case).
 */
export function planesTarget(d: OpenDoc): boolean[] | null {
  const t = viewOf(d).target
  if (!('colour' in t) || t.colour.every(Boolean)) return null
  return [...t.colour]
}

// A closed document's view goes with it; a layer picked targets the colour channels again; a channel deleted is no longer shown or targeted.
let picked = new Map<string, string | null>()
documents().subscribe(() => {
  const docs = documents().getState().docs
  const open = new Set(docs.map((d) => d.key))
  let changed = false
  for (const k of [...views.keys()]) if (!open.has(k)) views.delete(k)
  const next = new Map<string, string | null>()
  for (const d of docs) {
    next.set(d.key, d.selected)
    const v = views.get(d.key)
    if (!v) continue
    const was = picked.get(d.key)
    if (was !== undefined && was !== d.selected && 'channel' in v.target) {
      views.set(d.key, { ...v, colour: all(d.history.present.mode), target: { colour: all(d.history.present.mode) } })
      proofing.update(d.key, { channels: undefined })
      changed = true
      continue
    }
    const f = fit(v, d.history.present)
    if (f !== v) {
      views.set(d.key, f)
      if (f.colour !== v.colour) proofing.update(d.key, { channels: undefined })
      changed = true
    }
  }
  picked = next
  if (changed) changes.emit()
})
