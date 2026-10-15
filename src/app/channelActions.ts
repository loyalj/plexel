/**
 * The Channels panel's actions on the document: New Channel, New Spot
 * Channel, Channel Options, duplicating, deleting and moving a channel,
 * and picking one by its place in the list (Ctrl+3 onwards). Each change
 * to a channel is a step in the history; what's shown and picked is the
 * view's (app/channels.ts).
 */
import { addChannel, moveChannel, removeChannel, setChannelOptions, type ChannelOptions } from '../doc/edit'
import type { ColourValue } from '../color/value'
import type { Doc } from '../doc/types'
import { channels, channelTarget, COLOUR_NAMES } from './channels'
import { documents, newId } from './documents'
import { hold } from './pixels'
import { freshChannelName } from './selection'

const store = () => documents()
const active = () => store().active()

/** New Channel: an empty alpha channel (nothing selected), picked and shown alone, ready to paint. */
export function newChannel(): string | null {
  const d = active()
  if (!d) return null
  const id = newId('ch')
  store().commit((x) => addChannel(x, { id, name: freshChannelName(x), tiles: null, transform: [1, 0, 0, 1, 0, 0] }), { key: d.key, label: 'New Channel' })
  channels.pickChannel(d.key, id)
  return id
}

/** "Spot Colour 1", "Spot Colour 2"... */
export function freshSpotName(doc: Doc): string {
  const used = new Set((doc.channels ?? []).map((c) => c.name))
  for (let i = 1; ; i++) if (!used.has(`Spot Colour ${i}`)) return `Spot Colour ${i}`
}

/**
 * New Spot Channel: an ink of its own, filled with the selection when
 * there is one (as Photoshop does), picked with the colour still shown so
 * the ink shows over the picture.
 */
export function newSpotChannel(o: { name: string; ink: ColourValue; solidity: number }): string | null {
  const d = active()
  if (!d) return null
  const doc = d.history.present
  const id = newId('ch')
  const tiles = doc.selection?.tiles ?? null
  const release = tiles ? hold([tiles]) : () => {}
  store().commit((x) => addChannel(x, { id, name: o.name.trim() || freshSpotName(x), tiles, transform: [1, 0, 0, 1, 0, 0], kind: 'spot', ink: o.ink, opacity: o.solidity }), {
    key: d.key,
    label: 'New Spot Channel',
  })
  release()
  channels.pickChannel(d.key, id, true)
  channels.showColour(d.key)
  return id
}

/** Channel Options' OK: the name, how it shows, and (for a spot) its ink; an alpha made a spot or back. */
export function setOptions(id: string, o: ChannelOptions) {
  const d = active()
  if (d) store().commit((x) => setChannelOptions(x, id, o), { key: d.key, label: 'Channel Options' })
}

/** A channel dragged to another place in the list. */
export function moveDocChannel(id: string, index: number) {
  const d = active()
  if (d) store().commit((x) => moveChannel(x, id, index), { key: d.key, label: 'Move Channel' })
}

/** The alpha or spot channel picked, for the commands that work on it. */
export function pickedChannel() {
  const d = active()
  return d ? channelTarget(d) : null
}

/** Duplicate Channel on the one picked: the same coverage and look under a new name, picked. */
export function duplicatePicked() {
  const d = active()
  const ch = d ? channelTarget(d) : null
  if (!d || !ch) return
  const id = newId('ch')
  const at = (d.history.present.channels ?? []).findIndex((c) => c.id === ch.id)
  store().commit((x) => addChannel(x, { ...ch, id, name: `${ch.name} copy` }, at + 1), { key: d.key, label: 'Duplicate Channel' })
  channels.pickChannel(d.key, id, true)
}

/** Delete Channel on the one picked; the colour channels are picked again. */
export function deletePicked() {
  const d = active()
  const ch = d ? channelTarget(d) : null
  if (!d || !ch) return
  store().commit((x) => removeChannel(x, ch.id), { key: d.key, label: 'Delete Channel' })
  channels.pickComposite(d.key)
}

/**
 * Ctrl+2 picks the composite; Ctrl+3 onwards the channels in the panel's
 * order after it: the colour channels, then the alpha and spot channels.
 */
export function pickNth(n: number) {
  const d = active()
  if (!d) return
  const doc = d.history.present
  if (n === 0) return channels.pickComposite(d.key)
  const colours = COLOUR_NAMES[doc.mode].length
  // A gray document's one channel is its composite: Ctrl+3 is its first alpha or spot channel.
  const listed = colours > 1 ? colours : 0
  if (n <= listed) return channels.pickColour(d.key, n - 1)
  const ch = doc.channels?.[n - 1 - listed]
  if (ch) channels.pickChannel(d.key, ch.id)
}
