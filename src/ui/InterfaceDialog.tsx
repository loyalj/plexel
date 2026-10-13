/**
 * Edit → Interface: the interface's size, density, contrast and motion,
 * and how much it explains itself. Changes show at once, as a preferences
 * pane's do, and are kept; Restore Defaults puts every one back.
 */
import { useSyncExternalStore } from 'react'
import { Dialog } from './Dialog'
import { Field } from './docDialogs'
import { DEFAULT_PREFS, SCALES, interfacePrefs, type InterfacePrefs } from './interface'

export function InterfaceDialog({ onClose }: { onClose(): void }) {
  const p = useSyncExternalStore(interfacePrefs().subscribe, interfacePrefs().get)
  const set = (change: Partial<InterfacePrefs>) => interfacePrefs().update(change)
  const toggle = (key: 'richTips' | 'keyHints' | 'tabHides' | 'springTools', label: string, note: string) => (
    <label className="check pref-check">
      <input type="checkbox" checked={p[key]} data-pref={key} onChange={(e) => set({ [key]: e.target.checked })} />
      {label}
      <span className="field-note">{note}</span>
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
        <Field id="pref-scale" label="Interface size">
          <select id="pref-scale" value={p.scale} onChange={(e) => set({ scale: Number(e.target.value) })} autoFocus>
            {SCALES.map((s) => (
              <option key={s} value={s}>
                {Math.round(s * 100)}%
              </option>
            ))}
          </select>
          <span className="field-note">Menus, panels, bars and dialogs. The canvas keeps its own zoom.</span>
        </Field>
        <Field id="pref-density" label="Density">
          <select id="pref-density" value={p.density} onChange={(e) => set({ density: e.target.value as InterfacePrefs['density'] })}>
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact: tighter rows and bars, for small screens</option>
          </select>
        </Field>
        <Field id="pref-contrast" label="Contrast">
          <select id="pref-contrast" value={p.contrast} onChange={(e) => set({ contrast: e.target.value as InterfacePrefs['contrast'] })}>
            <option value="normal">The theme’s own</option>
            <option value="more">More: stronger text, edges and focus rings</option>
          </select>
        </Field>
        <Field id="pref-motion" label="Motion">
          <select id="pref-motion" value={p.motion} onChange={(e) => set({ motion: e.target.value as InterfacePrefs['motion'] })}>
            <option value="system">As the system says</option>
            <option value="reduce">Reduced: no transitions or animations</option>
          </select>
        </Field>
        <fieldset className="field-group">
          <legend>Help as you work</legend>
          {toggle('richTips', 'Rich tooltips', 'Tools list their keys; unavailable commands say why.')}
          {toggle('keyHints', 'Key hints in the status bar', 'What each key does with the tool in use.')}
          {toggle('springTools', 'Hold a tool’s key to use it for a moment', 'Let go and the tool before comes back. A quick tap still switches for good.')}
          {toggle('tabHides', 'Tab hides the panels', 'As in Photoshop. Off, Tab only moves the focus between controls.')}
        </fieldset>
      </div>
    </Dialog>
  )
}
