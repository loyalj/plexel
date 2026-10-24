/**
 * Edit → Interface: the interface's size, density, contrast and motion,
 * and how much it explains itself. Changes show at once, as a preferences
 * pane's do, and are kept; Restore Defaults puts every one back.
 */
import { useSyncExternalStore } from 'react'
import { Dialog } from './Dialog'
import { Field } from './docDialogs'
import { DEFAULT_PREFS, SCALES, interfacePrefs, type InterfacePrefs } from './interface'
import { Hint, Segmented } from './controls'

const DENSITIES: [InterfacePrefs['density'], string][] = [
  ['comfortable', 'Comfortable'],
  ['compact', 'Compact'],
]
const CONTRASTS: [InterfacePrefs['contrast'], string, string][] = [
  ['normal', 'Normal', 'The theme’s own'],
  ['more', 'More', 'Stronger text, edges and focus rings'],
]
const MOTIONS: [InterfacePrefs['motion'], string, string][] = [
  ['system', 'System', 'As the system says'],
  ['reduce', 'Reduced', 'No transitions or animations'],
]

export function InterfaceDialog({ onClose }: { onClose(): void }) {
  const p = useSyncExternalStore(interfacePrefs().subscribe, interfacePrefs().get)
  const set = (change: Partial<InterfacePrefs>) => interfacePrefs().update(change)
  const toggle = (key: 'richTips' | 'keyHints' | 'tabHides' | 'springTools' | 'padNumbers', label: string, note: string) => (
    <label className="check pref-check">
      <input type="checkbox" checked={p[key]} data-pref={key} onChange={(e) => set({ [key]: e.target.checked })} />
      {label}
      <Hint text={note} />
    </label>
  )
  return (
    <Dialog
      id="interface"
      title="Interface"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" disabled={JSON.stringify(p) === JSON.stringify(DEFAULT_PREFS)} data-why="Every setting is already its default" onClick={() => interfacePrefs().reset()}>
            Restore Defaults
          </button>
          <button type="button" className="button primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="form">
        <Field id="pref-scale" label="Interface size" hint="Menus, panels, bars and dialogs. The canvas keeps its own zoom.">
          <select id="pref-scale" value={p.scale} onChange={(e) => set({ scale: Number(e.target.value) })} autoFocus>
            {SCALES.map((s) => (
              <option key={s} value={s}>
                {Math.round(s * 100)}%
              </option>
            ))}
          </select>
        </Field>
        <Segmented id="pref-density" label="Density" hint="Compact has tighter rows and bars, for small screens" value={p.density} options={DENSITIES} onChange={(density) => set({ density })} />
        <Segmented id="pref-contrast" label="Contrast" hint="More: stronger text, edges and focus rings" value={p.contrast} options={CONTRASTS} onChange={(contrast) => set({ contrast })} />
        <Segmented id="pref-motion" label="Motion" hint="Reduced: no transitions or animations" value={p.motion} options={MOTIONS} onChange={(motion) => set({ motion })} />
        <fieldset className="field-group">
          <legend>Help as you work</legend>
          {toggle('richTips', 'Rich tooltips', 'Tools list their keys; unavailable commands say why.')}
          {toggle('keyHints', 'Key hints in the status bar', 'What each key does with the tool in use.')}
          {toggle('springTools', 'Hold a tool’s key to use it for a moment', 'Let go and the tool before comes back. A quick tap still switches for good.')}
          {toggle('tabHides', 'Tab hides the panels', 'As in Photoshop. Off, Tab only moves the focus between controls.')}
        </fieldset>
        <fieldset className="field-group">
          <legend>Layers</legend>
          {toggle('padNumbers', 'Number new layers in three digits', '“Home 007” rather than “Home 7”, so a long list sorts in order.')}
        </fieldset>
      </div>
    </Dialog>
  )
}
