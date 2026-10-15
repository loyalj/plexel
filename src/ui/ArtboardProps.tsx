/**
 * Properties for an artboard (its name, place and size, a preset size, its
 * background, whether it clips what's in it) and for a symbol instance
 * (which symbol it shows, Edit Symbol, Break Link).
 */
import { ARTBOARD_PRESETS, artboardRect, setArtboard, setArtboardRect, whiteIn, type ArtboardNode } from '../doc/artboards'
import { commitArtboards } from '../app/artboards'
import { documents } from '../app/documents'
import { breakLinkSelected, editSymbol, replaceSelected } from '../app/symbols'
import type { Doc, DocNode } from '../doc/types'
import { DocColourChip } from './ColourChip'
import { Hint, Label, NumberInput, ScrubLabel, Segmented } from './controls'

type Bg = 'white' | 'black' | 'transparent' | 'colour'

function bgKind(n: ArtboardNode, doc: Doc): Bg {
  const c = n.props.artboard.background
  if (!c) return 'transparent'
  const white = whiteIn(doc.mode)
  if (c.every((v, i) => Math.abs(v - white[i]) < 1e-6)) return 'white'
  const black = doc.mode === 'cmyk' ? [0, 0, 0, 1] : doc.mode === 'gray' ? [0] : [0, 0, 0]
  if (c.every((v, i) => Math.abs(v - black[i]) < 1e-6)) return 'black'
  return 'colour'
}

const BACKGROUNDS: [Bg, string, string][] = [
  ['white', 'White', 'White'],
  ['black', 'Black', 'Black'],
  ['transparent', 'None', 'Transparent: what’s under it shows'],
  ['colour', 'Colour', 'A colour of your own'],
]

export function ArtboardProps({ node, doc, docKey }: { node: ArtboardNode; doc: Doc; docKey: string }) {
  const a = node.props.artboard
  const [x0, y0, x1, y1] = artboardRect(node)
  const d = documents().get(docKey)
  const edit = (label: string, fn: (x: Doc) => Doc) => d && commitArtboards(d, fn, label)
  const setRect = (r: [number, number, number, number], carry: boolean, label: string) => edit(label, (x) => setArtboardRect(x, node.id, r, carry))
  const box = (k: 'x' | 'y' | 'w' | 'h', v: number) => {
    v = Math.round(v)
    if (k === 'x') return setRect([v, y0, v + (x1 - x0), y1], true, 'Move Artboard')
    if (k === 'y') return setRect([x0, v, x1, v + (y1 - y0)], true, 'Move Artboard')
    if (k === 'w') return setRect([x0, y0, x0 + Math.max(1, v), y1], false, 'Resize Artboard')
    return setRect([x0, y0, x1, y0 + Math.max(1, v)], false, 'Resize Artboard')
  }
  const preset = ARTBOARD_PRESETS.find((p) => p.width === a.width && p.height === a.height)
  const kind = bgKind(node, doc)
  const black = doc.mode === 'cmyk' ? [0, 0, 0, 1] : doc.mode === 'gray' ? [0] : [0, 0, 0]
  return (
    <div className="form props-layer" data-props="artboard">
      <div className="props-title">
        <strong>{node.name}</strong>
        <span className="layer-kind">Artboard</span>
      </div>
      <div className="field">
        <span className="field-label">Place and size</span>
        <div className="box-fields">
          {(
            [
              ['x', x0],
              ['y', y0],
              ['w', x1 - x0],
              ['h', y1 - y0],
            ] as const
          ).map(([k, v]) => (
            <div className="box-field" key={k}>
              <ScrubLabel htmlFor={`artboard-${k}`} value={v} min={k === 'w' || k === 'h' ? 1 : -Infinity} max={Infinity} step={1} onChange={(n) => box(k, n)}>
                {k.toUpperCase()}
              </ScrubLabel>
              <NumberInput id={`artboard-${k}`} value={v} step={1} min={k === 'w' || k === 'h' ? 1 : -Infinity} onChange={(n) => box(k, n)} />
            </div>
          ))}
        </div>
      </div>
      <div className="field">
        <Label htmlFor="artboard-preset" hint="A common size for a screen, a post or a page. The artboard keeps its top left corner; its layers stay where they are.">
          Size
        </Label>
        <select
          id="artboard-preset"
          value={preset?.id ?? 'custom'}
          onChange={(e) => {
            const p = ARTBOARD_PRESETS.find((x) => x.id === e.target.value)
            if (p) setRect([x0, y0, x0 + p.width, y0 + p.height], false, 'Resize Artboard')
          }}
        >
          {!preset && <option value="custom">Custom</option>}
          {[...new Set(ARTBOARD_PRESETS.map((p) => p.group))].map((g) => (
            <optgroup key={g} label={g}>
              {ARTBOARD_PRESETS.filter((p) => p.group === g).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.width} × {p.height})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <button type="button" className="button small" data-artboard-rotate onClick={() => setRect([x0, y0, x0 + (y1 - y0), y0 + (x1 - x0)], false, 'Resize Artboard')} data-tip="Swaps its width and height: portrait to landscape">
        Portrait / Landscape
      </button>
      <Segmented
        id="artboard-bg"
        label="Background"
        value={kind}
        defaultValue="white"
        options={BACKGROUNDS}
        onChange={(v) => {
          const c = v === 'white' ? whiteIn(doc.mode) : v === 'black' ? black : v === 'transparent' ? null : doc.mode === 'cmyk' ? [0, 0, 0, 0.15] : doc.mode === 'gray' ? [0.85] : [0.85, 0.85, 0.85]
          edit('Artboard Background', (x) => setArtboard(x, node.id, { background: c }))
        }}
      />
      {kind === 'colour' && a.background && (
        <div className="field">
          <span className="field-label">Colour</span>
          <DocColourChip value={a.background} doc={doc} label="Artboard background" onChange={(c) => edit('Artboard Background', (x) => setArtboard(x, node.id, { background: c }))} />
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={a.clip} data-artboard-clip onChange={(e) => edit('Clip to Artboard', (x) => setArtboard(x, node.id, { clip: e.target.checked }))} />
        Clip contents
        <Hint text="On, what’s on the artboard shows only inside it, as in Photoshop. Off, it runs over the edge onto the pasteboard (exporting the artboard still crops to it)." />
      </label>
    </div>
  )
}

/** A symbol instance's part of Properties: the symbol it shows, and the ways to edit or let go of it. */
export function InstanceProps({ node, doc }: { node: DocNode & { kind: 'symbol' }; doc: Doc }) {
  const list = doc.symbols ?? []
  const s = list.find((x) => x.id === node.props.symbol)
  return (
    <div className="field" data-props="instance">
      <Label htmlFor="instance-symbol" hint="An instance shows its symbol as it is now: edit the symbol and every instance follows. Its own place, size, turn, opacity and blend mode are its own.">
        Symbol
      </Label>
      <select id="instance-symbol" value={node.props.symbol} onChange={(e) => replaceSelected(e.target.value)}>
        {!s && <option value={node.props.symbol}>Missing symbol</option>}
        {list.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
      <div className="field-row">
        <button type="button" className="button small" disabled={!s} data-instance-edit onClick={() => s && editSymbol(s.id)}>
          Edit Symbol
        </button>
        <button type="button" className="button small" data-instance-break onClick={() => breakLinkSelected()} data-tip="A group of its own, no longer following the symbol">
          Break Link
        </button>
      </div>
    </div>
  )
}
