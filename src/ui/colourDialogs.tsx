/**
 * Colour Settings, Assign Profile and Convert to Profile with their Load
 * Profile buttons, and Proof Setup.
 */
import { useState, useSyncExternalStore, type FormEvent } from 'react'
import { colourEngine } from '../app/colour'
import { INTENT_NAMES, colourSettings, type ColourSettings } from '../app/colourSettings'
import type { Intent } from '../color/cms'
import { BUILTIN_BY_ID, BUILTIN_PROFILES, DISPLAY_PROFILE_IDS, builtinsFor, type DisplayProfileId } from '../color/profiles'
import type { ProofSetup } from '../color/proof'
import type { ColourMode, Doc, ProfileRef } from '../doc/types'
import { assets } from '../io/assets'
import { Dialog } from './Dialog'

export function ColourSettingsDialog({ onClose }: { onClose(): void }) {
  const current = useSyncExternalStore(colourSettings.subscribe, colourSettings.get)
  const [s, setS] = useState<ColourSettings>(current)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    colourSettings.set(s)
    onClose()
  }
  return (
    <Dialog
      id="colourSettings"
      title="Colour Settings"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="colour-settings-form" className="button primary">
            OK
          </button>
        </>
      }
    >
      <form id="colour-settings-form" className="form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="cs-display">Display</label>
          <select id="cs-display" value={s.display} onChange={(e) => setS({ ...s, display: e.target.value as DisplayProfileId })}>
            {DISPLAY_PROFILE_IDS.map((id) => (
              <option key={id} value={id}>
                {BUILTIN_BY_ID.get(id)!.name}
              </option>
            ))}
          </select>
          <span className="field-note">
            The colour space of your screen. Browsers don’t say which profile a monitor has, so pick Display P3 for a wide-gamut screen
            (most recent Macs and many laptops) and sRGB otherwise.
          </span>
        </div>
        <div className="field">
          <label htmlFor="cs-intent">Rendering intent</label>
          <select id="cs-intent" value={s.intent} onChange={(e) => setS({ ...s, intent: e.target.value as Intent })}>
            {(Object.keys(INTENT_NAMES) as Intent[]).map((i) => (
              <option key={i} value={i}>
                {INTENT_NAMES[i]}
              </option>
            ))}
          </select>
          <span className="field-note">How colours are converted into a document’s colour space, as when filling with a colour picked elsewhere.</span>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.blackPointCompensation} onChange={(e) => setS({ ...s, blackPointCompensation: e.target.checked })} />
          Use black point compensation
        </label>
        <fieldset className="field-group">
          <legend>Working spaces</legend>
          <span className="field-note">What Image → Mode converts to. Working CMYK is also the printing condition documents are proofed against to start with.</span>
          {(['rgb', 'cmyk', 'gray'] as ColourMode[]).map((m) => (
            <div className="field" key={m}>
              <label htmlFor={`cs-working-${m}`}>{MODE_NAMES[m]}</label>
              <ProfileSelect id={`cs-working-${m}`} mode={m} value={s.working[m]} onChange={(ref) => setS({ ...s, working: { ...s.working, [m]: ref } })} />
            </div>
          ))}
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

const MODE_NAMES = { rgb: 'RGB', gray: 'Gray', cmyk: 'CMYK' }

/** Profiles loaded this session, by hash, with their names and modes: every profile list offers them. */
const loaded = new Map<string, { ref: ProfileRef; name: string; mode: ColourMode }>()

/**
 * A profile list: the built-ins (for one mode, or all of them grouped by
 * mode) and those loaded this session, with Load Profile… at the end.
 */
function ProfileSelect({ id, mode, value, onChange }: { id: string; mode: ColourMode | null; value: ProfileRef; onChange(ref: ProfileRef, mode: ColourMode): void }) {
  const [, bump] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const extra = [...loaded.values()].filter((p) => !mode || p.mode === mode)
  const current = JSON.stringify(value)
  const known = BUILTIN_PROFILES.some((p) => JSON.stringify({ builtin: p.id }) === current) || extra.some((p) => JSON.stringify(p.ref) === current)
  const modes: ColourMode[] = mode ? [mode] : ['rgb', 'cmyk', 'gray']
  return (
    <>
      <select
        id={id}
        value={current}
        onChange={async (e) => {
          if (e.target.value === 'load') {
            const r = await loadAnyProfile()
            if (!r) return
            if ('error' in r) return setError(r.error)
            if (mode && r.mode !== mode) return setError(`“${r.name}” is a ${MODE_NAMES[r.mode]} profile; this needs ${MODE_NAMES[mode]}.`)
            setError(null)
            bump((x) => x + 1)
            return onChange(r.ref, r.mode)
          }
          const ref = JSON.parse(e.target.value) as ProfileRef
          const m = 'builtin' in ref ? BUILTIN_BY_ID.get(ref.builtin)!.mode : loaded.get(ref.asset)!.mode
          onChange(ref, m)
        }}
      >
        {!known && <option value={current}>{'asset' in value ? 'Embedded profile' : value.builtin}</option>}
        {modes.map((m) => (
          <optgroup key={m} label={MODE_NAMES[m]}>
            {builtinsFor(m).map((p) => (
              <option key={p.id} value={JSON.stringify({ builtin: p.id })}>
                {p.name}
              </option>
            ))}
            {extra
              .filter((p) => p.mode === m)
              .map((p) => (
                <option key={JSON.stringify(p.ref)} value={JSON.stringify(p.ref)}>
                  {p.name}
                </option>
              ))}
          </optgroup>
        ))}
        <option value="load">Load Profile…</option>
      </select>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </>
  )
}

/** Reads an ICC file, of any mode, and keeps it as an asset. */
async function loadAnyProfile(): Promise<{ ref: ProfileRef; name: string; mode: ColourMode } | { error: string } | null> {
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.icc,.icm'
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
  if (!file) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { cms } = await colourEngine()
  try {
    const p = cms.openProfile(bytes)
    const { space, description } = p
    p.close()
    if (space !== 'rgb' && space !== 'cmyk' && space !== 'gray') return { error: `“${description}” is a ${space.toUpperCase()} profile; Plexel works in RGB, CMYK and Gray.` }
    const ref = { asset: await assets().put(bytes) }
    const r = { ref, name: description, mode: space as ColourMode }
    loaded.set(ref.asset, r)
    return r
  } catch (e) {
    return { error: `“${file.name}” isn’t a profile Plexel can read: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Reads an ICC file and checks it's a profile for the document's mode. */
async function loadProfile(doc: Doc): Promise<{ ref: ProfileRef; name: string } | { error: string } | null> {
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.icc,.icm'
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
  if (!file) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { cms } = await colourEngine()
  try {
    const p = cms.openProfile(bytes)
    const { space, description } = p
    p.close()
    if (space !== doc.mode) return { error: `“${description}” is a ${space.toUpperCase()} profile; this document is ${MODE_NAMES[doc.mode]}.` }
    return { ref: { asset: await assets().put(bytes) }, name: description }
  } catch (e) {
    return { error: `“${file.name}” isn’t a profile Plexel can read: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export function AssignProfileDialog({ doc, onApply, onClose }: { doc: Doc; onApply(ref: ProfileRef): void; onClose(): void }) {
  const builtins = builtinsFor(doc.mode)
  /** Loaded and embedded profiles, by hash, with their names. */
  const [extra, setExtra] = useState<{ ref: ProfileRef; name: string }[]>(() =>
    'asset' in doc.profile ? [{ ref: doc.profile, name: 'Embedded profile' }] : [],
  )
  const [choice, setChoice] = useState(JSON.stringify(doc.profile))
  const [error, setError] = useState<string | null>(null)
  const note = 'builtin' in JSON.parse(choice) ? BUILTIN_BY_ID.get(JSON.parse(choice).builtin)?.note : undefined
  return (
    <Dialog
      id="assignProfile"
      title="Assign Profile"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={() => onApply(JSON.parse(choice))}>
            Assign
          </button>
        </>
      }
    >
      <p>
        The document’s numbers stay the same and are read in the profile you choose, so its colours look different. To keep the
        colours and change the numbers instead, use Convert to Profile.
      </p>
      <div className="field">
        <label htmlFor="assign-profile">{MODE_NAMES[doc.mode]} profile</label>
        <select id="assign-profile" value={choice} onChange={(e) => setChoice(e.target.value)}>
          {builtins.map((p) => (
            <option key={p.id} value={JSON.stringify({ builtin: p.id })}>
              {p.name}
            </option>
          ))}
          {extra.map((p) => (
            <option key={JSON.stringify(p.ref)} value={JSON.stringify(p.ref)}>
              {p.name}
            </option>
          ))}
        </select>
        {note && <span className="field-note">{note}</span>}
      </div>
      <div>
        <button
          type="button"
          className="button"
          onClick={async () => {
            const r = await loadProfile(doc)
            if (!r) return
            if ('error' in r) return setError(r.error)
            setError(null)
            setExtra((x) => [...x.filter((p) => JSON.stringify(p.ref) !== JSON.stringify(r.ref)), r])
            setChoice(JSON.stringify(r.ref))
          }}
        >
          Load Profile…
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}

function IntentSelect({ id, value, onChange }: { id: string; value: Intent; onChange(i: Intent): void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value as Intent)}>
      {(Object.keys(INTENT_NAMES) as Intent[]).map((i) => (
        <option key={i} value={i}>
          {INTENT_NAMES[i]}
        </option>
      ))}
    </select>
  )
}

/**
 * Convert to Profile: the document's colours kept as nearly as the
 * destination allows, its numbers changed, its mode too when the
 * destination profile is for another one.
 */
export function ConvertProfileDialog({ doc, onConvert, onClose }: { doc: Doc; onConvert(to: { profile: ProfileRef; mode: ColourMode }, intent: Intent, bpc: boolean): void; onClose(): void }) {
  const settings = colourSettings.get()
  const [to, setTo] = useState<{ profile: ProfileRef; mode: ColourMode }>({ profile: doc.mode === 'cmyk' ? settings.working.rgb : settings.working.cmyk, mode: doc.mode === 'cmyk' ? 'rgb' : 'cmyk' })
  const [intent, setIntent] = useState<Intent>(settings.intent)
  const [bpc, setBpc] = useState(settings.blackPointCompensation)
  const note = 'builtin' in to.profile ? BUILTIN_BY_ID.get(to.profile.builtin)?.note : undefined
  return (
    <Dialog
      id="convertProfile"
      title="Convert to Profile"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" data-convert onClick={() => onConvert(to, intent, bpc)}>
            Convert
          </button>
        </>
      }
    >
      <p>
        The colours are kept as nearly as the destination allows and the numbers change to match, every layer, shape, text and effect at
        once. A profile for another mode changes the document’s mode too.
      </p>
      <div className="field">
        <span className="field-label">Source</span>
        <span data-convert-source>
          {MODE_NAMES[doc.mode]}, {'builtin' in doc.profile ? (BUILTIN_BY_ID.get(doc.profile.builtin)?.name ?? doc.profile.builtin) : (loaded.get(doc.profile.asset)?.name ?? 'Embedded profile')}
        </span>
      </div>
      <div className="field">
        <label htmlFor="convert-profile">Destination</label>
        <ProfileSelect id="convert-profile" mode={null} value={to.profile} onChange={(profile, mode) => setTo({ profile, mode })} />
        {note && <span className="field-note">{note}</span>}
      </div>
      <div className="field">
        <label htmlFor="convert-intent">Rendering intent</label>
        <IntentSelect id="convert-intent" value={intent} onChange={setIntent} />
      </div>
      <label className="check">
        <input type="checkbox" checked={bpc} onChange={(e) => setBpc(e.target.checked)} />
        Use black point compensation
      </label>
    </Dialog>
  )
}

/** Proof Setup: the printing condition Proof Colours and the Gamut Warning show. */
export function ProofSetupDialog({ setup, onApply, onClose }: { setup: ProofSetup; onApply(s: ProofSetup): void; onClose(): void }) {
  const [s, setS] = useState<ProofSetup>(setup)
  const note = 'builtin' in s.profile ? BUILTIN_BY_ID.get(s.profile.builtin)?.note : undefined
  return (
    <Dialog
      id="proofSetup"
      title="Proof Setup"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" data-proof-ok onClick={() => onApply(s)}>
            OK
          </button>
        </>
      }
    >
      <p>How the document would look printed on this condition. View → Proof Colours (Ctrl+Y) shows it; View → Gamut Warning marks what it can’t print.</p>
      <div className="field">
        <label htmlFor="proof-profile">Device to simulate</label>
        <ProfileSelect id="proof-profile" mode={null} value={s.profile} onChange={(profile, mode) => setS({ ...s, profile, mode })} />
        {note && <span className="field-note">{note}</span>}
      </div>
      <div className="field">
        <label htmlFor="proof-intent">Rendering intent</label>
        <IntentSelect id="proof-intent" value={s.intent} onChange={(intent) => setS({ ...s, intent })} />
      </div>
      <label className="check">
        <input type="checkbox" checked={s.bpc} onChange={(e) => setS({ ...s, bpc: e.target.checked })} />
        Black point compensation
      </label>
      <fieldset className="field-group">
        <legend>Display options (on screen)</legend>
        <label className="check">
          <input type="checkbox" data-proof-paper checked={s.paper} onChange={(e) => setS({ ...s, paper: e.target.checked, black: e.target.checked || s.black })} />
          Simulate paper colour
        </label>
        <label className="check">
          <input type="checkbox" checked={s.black || s.paper} disabled={s.paper} onChange={(e) => setS({ ...s, black: e.target.checked })} />
          Simulate black ink
        </label>
      </fieldset>
    </Dialog>
  )
}
