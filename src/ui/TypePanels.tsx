/**
 * The Character and Paragraph panels. They act on the text being edited
 * (its selection, or what's typed next at a caret), on a selected text
 * layer as a whole, or, with neither, on new text's settings, as
 * Photoshop's do. Each shows the settings in force there.
 *
 * A drag of a number is one step; choosing a font, a style or a feature is
 * one each.
 */
import { memo, useEffect, useRef, useState } from 'react'
import { addFontFiles, canLoadSystemFonts, fontLibraryNow, loadSystemFonts, systemFontsLoaded } from '../app/fonts'
import { applyChar, applyPara, shownChar, shownPara, subscribeTyping, typeTarget } from '../app/typing'
import { addCharStyle, addParaStyle, deleteTextStyle, redefineCharStyle, redefineParaStyle, renameTextStyle } from '../app/textStyles'
import { typeSettings } from '../app/typeSettings'
import { documents } from '../app/documents'
import { DEFAULT_CHAR, DEFAULT_PARA, locate, runAtPos, NO_STYLES, type Align, type CharProps, type ParaProps } from '../doc/text'
import { startFonts } from '../app/text'
import { Icon } from './Icon'
import { NumberInput, ScrubLabel, Segmented, SliderField } from './controls'

const DIRECTIONS: [ParaProps['direction'], string, string][] = [
  ['auto', 'Auto', 'From the text'],
  ['ltr', 'Left to right', 'Left to right'],
  ['rtl', 'Right to left', 'Right to left'],
]
const COMPOSERS: [ParaProps['composer'], string][] = [
  ['every', 'Every-line'],
  ['single', 'Single-line'],
]

/** Re-renders on anything the panels show: the document, the editing session, the fonts, new text's settings. */
function useTypeState() {
  const [, tick] = useState(0)
  useEffect(() => {
    const bump = () => tick((n) => n + 1)
    const offs = [documents().subscribe(bump), subscribeTyping(bump), typeSettings().subscribe(bump)]
    let offFonts = () => {}
    void startFonts().then((lib) => {
      offFonts = lib.subscribe(bump)
      bump()
    })
    return () => {
      offs.forEach((f) => f())
      offFonts()
    }
  }, [])
}

/** OpenType features the panel offers: those on by default are switched off with "=0". */
const FEATURES: { tag: string; label: string; onByDefault?: boolean }[] = [
  { tag: 'liga', label: 'Ligatures', onByDefault: true },
  { tag: 'calt', label: 'Contextual alternates', onByDefault: true },
  { tag: 'dlig', label: 'Discretionary ligatures' },
  { tag: 'smcp', label: 'Small caps' },
  { tag: 'c2sc', label: 'Capitals to small caps' },
  { tag: 'onum', label: 'Oldstyle figures' },
  { tag: 'lnum', label: 'Lining figures' },
  { tag: 'tnum', label: 'Tabular figures' },
  { tag: 'pnum', label: 'Proportional figures' },
  { tag: 'zero', label: 'Slashed zero' },
  { tag: 'frac', label: 'Fractions' },
  { tag: 'ordn', label: 'Ordinals' },
  { tag: 'sups', label: 'Superscript' },
  { tag: 'subs', label: 'Subscript' },
  { tag: 'case', label: 'Case-sensitive forms' },
  { tag: 'ss01', label: 'Stylistic set 1' },
  { tag: 'ss02', label: 'Stylistic set 2' },
  { tag: 'ss03', label: 'Stylistic set 3' },
  { tag: 'swsh', label: 'Swash' },
]

const featureOn = (list: string[], f: (typeof FEATURES)[number]) => (f.onByDefault ? !list.includes(`${f.tag}=0`) : list.includes(f.tag))
function toggleFeature(list: string[], f: (typeof FEATURES)[number], on: boolean): string[] {
  const rest = list.filter((x) => x !== f.tag && x !== `${f.tag}=0` && x !== `+${f.tag}` && x !== `-${f.tag}`)
  if (f.onByDefault) return on ? rest : [...rest, `${f.tag}=0`]
  return on ? [...rest, f.tag] : rest
}

/** A number typed (Enter or leaving the field commits), with a unit. */
function NumberField({ id, label, value, unit, min, max, step = 1, onChange, title, def }: { id: string; label: string; value: number; unit: string; min: number; max: number; step?: number; onChange(v: number): void; title?: string; def?: number }) {
  return (
    <div className="type-field">
      <ScrubLabel htmlFor={id} value={value} min={min} max={max} step={step} onChange={onChange} hint={title} defaultValue={def}>
        {label}
      </ScrubLabel>
      <NumberInput id={id} value={value} min={min} max={max} step={step} format={(v) => String(Math.round(v * 100) / 100)} onChange={onChange} />
      <em>{unit}</em>
    </div>
  )
}

export const CharacterPanel = memo(function CharacterPanel() {
  useTypeState()
  const lib = fontLibraryNow()
  const c = shownChar()
  const target = typeTarget()
  const families = lib?.families() ?? []
  const family = families.find((f) => f.family === c.font)
  const face = lib?.face(c.font, c.style)
  const axes = face?.face.info.axes ?? []
  const fileInput = useRef<HTMLInputElement>(null)
  const set = (patch: Partial<CharProps>, key?: string) => applyChar(patch, key ? `char:${key}` : undefined)
  const doc = documents().active()?.history.present
  const styles = doc?.textStyles ?? NO_STYLES
  const runStyle = target.kind === 'editing' ? runAtPos(target.s.content(), target.s.range()[0] + (target.s.range()[0] < target.s.range()[1] ? 1 : 0)).run.style : target.kind === 'layer' ? target.node.props.content.paragraphs[0].runs[0].style : null
  return (
    <div className="type-panel" data-panel-body="character">
      <p className="field-meta" data-type-target={target.kind}>
        {target.kind === 'editing' ? (target.s.range()[0] === target.s.range()[1] ? 'For what’s typed next.' : 'For the selected text.') : target.kind === 'layer' ? 'For the whole text layer.' : 'For new text.'}
      </p>
      <div className="field">
        <label htmlFor="type-font">Font</label>
        <select id="type-font" value={family ? c.font : ''} onChange={(e) => {
          const f = families.find((x) => x.family === e.target.value)
          if (!f) return
          // The same style in the new family if it has one, else its regular.
          const style = f.styles.find((s) => s.style === c.style)?.style ?? f.styles.find((s) => /^(regular|book|roman|normal)$/i.test(s.style))?.style ?? f.styles[0].style
          set({ font: f.family, style })
        }}>
          {!family && <option value="">{c.font} (missing)</option>}
          {families.map((f) => (
            <option key={f.family} value={f.family}>
              {f.family}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="type-style">Style</label>
        <select id="type-style" value={c.style} onChange={(e) => set({ style: e.target.value })}>
          {!family?.styles.some((s) => s.style === c.style) && <option value={c.style}>{c.style}</option>}
          {family?.styles.map((s) => (
            <option key={s.style} value={s.style}>
              {s.style}
            </option>
          ))}
        </select>
      </div>
      <div className="panel-tools">
        {canLoadSystemFonts() && !systemFontsLoaded() && (
          <button type="button" className="button small" data-type-system-fonts onClick={() => void loadSystemFonts()}>
            Load System Fonts
          </button>
        )}
        <button type="button" className="button small" onClick={() => fileInput.current?.click()}>
          Add Fonts…
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          accept=".ttf,.otf,.ttc,font/ttf,font/otf"
          data-type-add-fonts
          onChange={async (e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            if (files.length) await addFontFiles(files)
          }}
        />
      </div>
      <div className="type-grid">
        <NumberField id="type-size" label="Size" unit="px" value={c.size} min={0.1} max={10000} step={1} onChange={(v) => set({ size: v }, 'size')} />
        <NumberField id="type-leading" label="Leading" unit={c.leading === null ? 'px (auto)' : 'px'} value={c.leading ?? c.size * 1.2} min={0} max={20000} onChange={(v) => set({ leading: v }, 'leading')} title="Baseline to baseline. Clear it with Auto." />
        <NumberField def={0} id="type-tracking" label="Tracking" unit="/1000 em" value={c.tracking} min={-1000} max={10000} step={10} onChange={(v) => set({ tracking: v }, 'tracking')} />
        <NumberField def={0} id="type-shift" label="Baseline" unit="px" value={c.baselineShift} min={-10000} max={10000} onChange={(v) => set({ baselineShift: v }, 'shift')} />
        <NumberField def={100} id="type-hscale" label="Width" unit="%" value={c.horizontalScale} min={1} max={1000} onChange={(v) => set({ horizontalScale: v }, 'hscale')} />
        <NumberField def={100} id="type-vscale" label="Height" unit="%" value={c.verticalScale} min={1} max={1000} onChange={(v) => set({ verticalScale: v }, 'vscale')} />
      </div>
      <div className="panel-tools">
        <button type="button" className="options-toggle" aria-pressed={c.leading === null} onClick={() => set({ leading: null })} data-tip="Leading of 120% of the size">
          Auto leading
        </button>
        <button type="button" className="options-toggle" aria-pressed={c.kerning === 'metrics'} data-type-kerning onClick={() => set({ kerning: c.kerning === 'metrics' ? 'none' : 'metrics' })} data-tip="The font’s own kerning">
          Kerning
        </button>
        <button type="button" className="options-toggle" aria-pressed={c.underline} data-type-underline onClick={() => set({ underline: !c.underline })}>
          Underline
        </button>
        <button type="button" className="options-toggle" aria-pressed={c.strikethrough} onClick={() => set({ strikethrough: !c.strikethrough })}>
          Strikethrough
        </button>
      </div>
      {axes.length > 0 && (
        <div className="type-axes" data-type-axes>
          {axes.map((a) => {
            const v = c.variations[a.tag] ?? face?.coords[a.tag] ?? a.default
            return (
              <SliderField key={a.tag} id={`type-axis-${a.tag}`} label={a.name} min={a.min} max={a.max} step={Math.max(0.1, Math.round((a.max - a.min) / 20) / 10)} value={Math.round(v * 10) / 10} onChange={(x) => set({ variations: { ...c.variations, [a.tag]: x } }, `axis:${a.tag}`)} />
            )
          })}
        </div>
      )}
      <details className="type-features">
        <summary>OpenType features</summary>
        {FEATURES.map((f) => (
          <label className="check" key={f.tag}>
            <input type="checkbox" data-type-feature={f.tag} checked={featureOn(c.features, f)} onChange={(e) => set({ features: toggleFeature(c.features, f, e.target.checked) })} />
            {f.label}
          </label>
        ))}
      </details>
      <div className="field">
        <label htmlFor="type-language">Language</label>
        <input id="type-language" defaultValue={c.language} key={c.language} onBlur={(e) => /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(e.target.value) && e.target.value !== c.language && set({ language: e.target.value })} />
      </div>
      <StyleList
        kind="character"
        styles={styles.character}
        current={runStyle}
        onApply={(id) => applyChar({}, undefined, id)}
        onNew={() => {
          const id = addCharStyle(stripDefaults(shownChar()), runStyle)
          applyChar({}, undefined, id)
        }}
        onRedefine={(id) => redefineCharStyle(id, stripDefaults(shownChar()))}
        onDelete={(id) => deleteTextStyle('character', id)}
        disabled={!doc}
      />
    </div>
  )
})

export const ParagraphPanel = memo(function ParagraphPanel() {
  useTypeState()
  const p = shownPara()
  const target = typeTarget()
  const doc = documents().active()?.history.present
  const styles = doc?.textStyles ?? NO_STYLES
  const paraStyle = target.kind === 'editing' ? target.s.content().paragraphs[locate(target.s.content(), target.s.range()[0]).para].style : target.kind === 'layer' ? target.node.props.content.paragraphs[0].style : null
  const set = (patch: Partial<ParaProps>, key?: string) => applyPara(patch, key ? `para:${key}` : undefined)
  const ALIGN: [Align, string][] = [
    ['left', 'Left'],
    ['centre', 'Centre'],
    ['right', 'Right'],
    ['justify', 'Justify'],
    ['justify-all', 'Justify all'],
  ]
  return (
    <div className="type-panel" data-panel-body="paragraph">
      <div className="panel-tools" role="group" aria-label="Alignment">
        {ALIGN.map(([a, label]) => (
          <button key={a} type="button" className="options-toggle" aria-pressed={p.align === a} data-type-align={a} onClick={() => set({ align: a })} data-tip={a === 'justify' ? 'Justified, the last line aligned to the start' : undefined}>
            {label}
          </button>
        ))}
      </div>
      <div className="type-grid">
        <NumberField def={0} id="para-indent-left" label="Indent left" unit="px" value={p.indentLeft} min={-100000} max={100000} onChange={(v) => set({ indentLeft: v }, 'il')} />
        <NumberField def={0} id="para-indent-right" label="Indent right" unit="px" value={p.indentRight} min={-100000} max={100000} onChange={(v) => set({ indentRight: v }, 'ir')} />
        <NumberField def={0} id="para-indent-first" label="First line" unit="px" value={p.indentFirst} min={-100000} max={100000} onChange={(v) => set({ indentFirst: v }, 'if')} />
        <NumberField def={0} id="para-space-before" label="Space before" unit="px" value={p.spaceBefore} min={-100000} max={100000} onChange={(v) => set({ spaceBefore: v }, 'sb')} />
        <NumberField def={0} id="para-space-after" label="Space after" unit="px" value={p.spaceAfter} min={-100000} max={100000} onChange={(v) => set({ spaceAfter: v }, 'sa')} />
      </div>
      <Segmented id="para-direction" label="Direction" value={p.direction} options={DIRECTIONS} onChange={(v) => set({ direction: v })} />
      <Segmented id="para-composer" label="Composer" hint="Every-line weighs the whole paragraph for even spacing; single-line fills each line as it goes" value={p.composer} options={COMPOSERS} onChange={(v) => set({ composer: v })} />
      <StyleList
        kind="paragraph"
        styles={styles.paragraph}
        current={paraStyle}
        onApply={(id) => applyPara({}, undefined, id)}
        onNew={() => {
          const id = addParaStyle(stripParaDefaults(shownPara()), stripDefaults(shownChar()), paraStyle)
          applyPara({}, undefined, id)
        }}
        onRedefine={(id) => redefineParaStyle(id, stripParaDefaults(shownPara()), stripDefaults(shownChar()))}
        onDelete={(id) => deleteTextStyle('paragraph', id)}
        disabled={!doc}
      />
    </div>
  )
})

/** Settings without those left at the defaults: what a style made from them records. */
const stripDefaults = (c: CharProps): Partial<CharProps> => differing(c, DEFAULT_CHAR) as Partial<CharProps>
const stripParaDefaults = (p: ParaProps): Partial<ParaProps> => differing(p, DEFAULT_PARA) as Partial<ParaProps>
const differing = (o: object, d: object) => Object.fromEntries(Object.entries(o).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((d as Record<string, unknown>)[k])))

function StyleList({ kind, styles, current, onApply, onNew, onRedefine, onDelete, disabled }: { kind: 'character' | 'paragraph'; styles: { id: string; name: string }[]; current: string | null; onApply(id: string | null): void; onNew(): void; onRedefine(id: string): void; onDelete(id: string): void; disabled: boolean }) {
  // Double-click a style's name to rename it: Enter or leaving keeps the new name, Esc doesn't.
  const [naming, setNaming] = useState<string | null>(null)
  const rename = (id: string, name: string) => {
    setNaming(null)
    const t = name.trim()
    if (t && t !== styles.find((s) => s.id === id)?.name) renameTextStyle(kind, id, t)
  }
  return (
    <div className="type-styles" data-type-styles={kind}>
      <span className="field-label">{kind === 'character' ? 'Character styles' : 'Paragraph styles'}</span>
      <ul className="appearance-list">
        <li className={`appearance-item${current === null ? ' open' : ''}`}>
          <button type="button" className="appearance-pick" onClick={() => onApply(null)} disabled={disabled}>
            None
          </button>
        </li>
        {styles.map((s) => (
          <li key={s.id} className={`appearance-item${current === s.id ? ' open' : ''}`} data-style={s.id}>
            {naming === s.id ? (
              <input
                className="appearance-pick"
                data-style-name={s.id}
                defaultValue={s.name}
                autoFocus
                aria-label={`Name of ${s.name}`}
                onFocus={(e) => e.target.select()}
                onBlur={(e) => rename(s.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') rename(s.id, e.currentTarget.value)
                  else if (e.key === 'Escape') setNaming(null)
                  e.stopPropagation()
                }}
              />
            ) : (
              <button type="button" className="appearance-pick" onClick={() => onApply(s.id)} onDoubleClick={() => setNaming(s.id)} data-tip="Click to apply; double-click to rename">
                {s.name}
              </button>
            )}
            <button type="button" className="icon-button" aria-label={`Redefine ${s.name} from the selection`} data-tip="Redefine from the selection" onClick={() => onRedefine(s.id)}>
              <Icon name="ui.reset" />
            </button>
            <button type="button" className="icon-button" aria-label={`Delete ${s.name}`} onClick={() => onDelete(s.id)}>
              <Icon name="ui.close" />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="button small" disabled={disabled} data-type-new-style={kind} onClick={onNew}>
        New {kind === 'character' ? 'Character' : 'Paragraph'} Style
      </button>
    </div>
  )
}

