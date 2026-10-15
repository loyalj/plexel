/**
 * The Channels panel's dialogs: New Spot Channel (an ink's name, colour
 * and solidity) and Channel Options (an alpha channel's name, tint, its
 * opacity and what the tint marks; a spot channel's name, ink and
 * solidity; either one made the other kind).
 *
 * An ink is the foreground colour, one of the document's spot swatches
 * (whose name it takes), or a colour picked here. Its colour is kept in
 * its own space, as a swatch's is; it's what the ink shows as on screen
 * and what files give as its look.
 */
import { useState } from 'react'
import { freshSpotName, newSpotChannel, setOptions } from '../app/channelActions'
import { channelSrgb } from '../app/channels'
import { colours } from '../app/colours'
import type { ColourValue } from '../color/value'
import { ALPHA_TINT, channelKind, channelOpacity, type Doc, type DocChannel } from '../doc/types'
import { Dialog } from './Dialog'
import { HexColourChip } from './ColourChip'
import { Field, Footer, parseNumber } from './docDialogs'

const hex = (rgb: number[]) => '#' + rgb.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')
const fromHex = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number]
const srgb = (rgb: [number, number, number]): ColourValue => ({ space: 'rgb', profile: { builtin: 'srgb' }, c: rgb })

/** A percentage typed in a field, 0 to 100. */
function percentError(text: string): string | null {
  const n = parseNumber(text)
  if (n === null) return 'Enter a number.'
  if (n < 0 || n > 100) return 'Between 0 and 100.'
  return null
}

/** Where an ink's colour comes from: the foreground, a spot swatch by id, or one picked here. */
type InkSource = 'fg' | 'custom' | `swatch:${string}`

function InkFields({ doc, source, setSource, custom, setCustom, idPrefix }: { doc: Doc; source: InkSource; setSource(s: InkSource): void; custom: string; setCustom(h: string): void; idPrefix: string }) {
  const spots = (doc.swatches ?? []).filter((s) => s.kind === 'spot')
  return (
    <>
      <Field id={`${idPrefix}-ink`} label="Ink">
        <select id={`${idPrefix}-ink`} value={source} onChange={(e) => setSource(e.target.value as InkSource)}>
          <option value="fg">Foreground colour</option>
          {spots.map((s) => (
            <option key={s.id} value={`swatch:${s.id}`}>
              {s.name}
            </option>
          ))}
          <option value="custom">Pick a colour…</option>
        </select>
      </Field>
      {source === 'custom' && (
        <Field id={`${idPrefix}-colour`} label="Colour">
          <HexColourChip id={`${idPrefix}-colour`} value={custom} label="Ink colour" onChange={setCustom} />
        </Field>
      )}
    </>
  )
}

/** The ink a source gives, and the name it suggests (a swatch's). */
function inkOf(doc: Doc, source: InkSource, custom: string): { ink: ColourValue; name: string | null } {
  if (source === 'fg') return { ink: colours().get().fg, name: null }
  if (source === 'custom') return { ink: srgb(fromHex(custom)), name: null }
  const s = doc.swatches?.find((x) => `swatch:${x.id}` === source)
  return s ? { ink: s.colour, name: s.name } : { ink: colours().get().fg, name: null }
}

/** Document → Channels → New Spot Channel, or the panel's button: an ink of its own, filled with the selection when there is one. */
export function NewSpotChannelDialog({ doc, onClose }: { doc: Doc; onClose(): void }) {
  const [name, setName] = useState(() => freshSpotName(doc))
  const [named, setNamed] = useState(false)
  const [source, setSource] = useState<InkSource>('fg')
  const [custom, setCustom] = useState('#e4007c')
  const [solidity, setSolidity] = useState('0')
  const error = percentError(solidity)
  const pick = (s: InkSource) => {
    setSource(s)
    // A spot swatch's name is the ink's, unless one's been typed.
    const n = inkOf(doc, s, custom).name
    if (n && !named) setName(n)
  }
  return (
    <Dialog id="newSpotChannel" title="New Spot Channel" onClose={onClose} footer={<Footer form="spot-form" primary="OK" onCancel={onClose} disabled={!!error || !name.trim()} />}>
      <form
        id="spot-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          onClose()
          newSpotChannel({ name, ink: inkOf(doc, source, custom).ink, solidity: (parseNumber(solidity) ?? 0) / 100 })
        }}
      >
        <Field id="spot-name" label="Name">
          <input
            id="spot-name"
            value={name}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => {
              setName(e.target.value)
              setNamed(true)
            }}
          />
        </Field>
        <InkFields doc={doc} source={source} setSource={pick} custom={custom} setCustom={setCustom} idPrefix="spot" />
        <Field id="spot-solidity" label="Solidity (%)" error={error}>
          <input id="spot-solidity" inputMode="decimal" value={solidity} onChange={(e) => setSolidity(e.target.value)} />
        </Field>
        <p>
          A spot channel is an ink printed on a plate of its own. Paint it like an alpha channel: black is full ink. Solidity is only how it looks on screen: 0% shows the ink as see-through, 100% as opaque.
          {doc.selection ? ' It starts filled where the selection is.' : ''}
        </p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

/** Channel Options: double-click a channel's thumbnail, or Document → Channels → Channel Options. */
export function ChannelOptionsDialog({ doc, channel, onClose }: { doc: Doc; channel: DocChannel; onClose(): void }) {
  const [name, setName] = useState(channel.name)
  const [kind, setKind] = useState(channelKind(channel))
  const [marks, setMarks] = useState(channel.marks ?? 'masked')
  const [tint, setTint] = useState(hex(channel.tint ?? ALPHA_TINT))
  const [source, setSource] = useState<InkSource>('custom')
  const [custom, setCustom] = useState(hex(channelKind(channel) === 'spot' ? channelSrgb(channel) : [0.89, 0, 0.49]))
  const [opacity, setOpacity] = useState(() => String(Math.round(channelOpacity(channel) * 100)))
  const error = percentError(opacity)
  // The ink as it is, unless another is chosen.
  const keepInk = kind === 'spot' && channelKind(channel) === 'spot' && source === 'custom' && custom === hex(channelSrgb(channel))
  return (
    <Dialog id="channelOptions" title="Channel Options" onClose={onClose} footer={<Footer form="channel-form" primary="OK" onCancel={onClose} disabled={!!error || !name.trim()} />}>
      <form
        id="channel-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          onClose()
          const o = (parseNumber(opacity) ?? 0) / 100
          if (kind === 'spot') setOptions(channel.id, { name, kind: 'spot', ink: keepInk && channel.ink ? channel.ink : inkOf(doc, source, custom).ink, opacity: o })
          else setOptions(channel.id, { name, kind: 'alpha', tint: fromHex(tint), marks, opacity: o })
        }}
      >
        <Field id="channel-name" label="Name">
          <input id="channel-name" value={name} autoFocus onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id="channel-kind" label="Kind">
          <select
            id="channel-kind"
            value={kind}
            onChange={(e) => {
              const k = e.target.value as 'alpha' | 'spot'
              setKind(k)
              if (k !== channelKind(channel)) setOpacity(k === 'spot' ? '0' : '50')
            }}
          >
            <option value="alpha">Alpha channel</option>
            <option value="spot">Spot colour</option>
          </select>
        </Field>
        {kind === 'alpha' ? (
          <>
            <Field id="channel-marks" label="Colour indicates">
              <select id="channel-marks" value={marks} onChange={(e) => setMarks(e.target.value as 'masked' | 'selected')}>
                <option value="masked">Masked areas</option>
                <option value="selected">Selected areas</option>
              </select>
            </Field>
            <Field id="channel-tint" label="Colour">
              <HexColourChip id="channel-tint" value={tint} label="Tint colour" onChange={setTint} />
            </Field>
          </>
        ) : (
          <InkFields doc={doc} source={source} setSource={setSource} custom={custom} setCustom={setCustom} idPrefix="channel" />
        )}
        <Field id="channel-opacity" label={kind === 'alpha' ? 'Opacity (%)' : 'Solidity (%)'} error={error}>
          <input id="channel-opacity" inputMode="decimal" value={opacity} onChange={(e) => setOpacity(e.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
