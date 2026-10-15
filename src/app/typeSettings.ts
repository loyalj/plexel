/**
 * What new text gets: the Character and Paragraph panels' settings while no
 * text is selected, as Photoshop's are. Kept in the browser.
 */
import { readCharProps, readParaProps, type CharProps, type ParaProps } from '../doc/text'
import { Listeners } from '../lib/listeners'

export interface TypeSettings {
  char: Partial<CharProps>
  para: Partial<ParaProps>
}

const KEY = 'plexel.typeSettings.v1'

class TypeSettingsStore {
  private state: TypeSettings
  private changes = new Listeners()
  constructor() {
    let raw: { char?: unknown; para?: unknown } | null = null
    try {
      raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    } catch {
      raw = null
    }
    this.state = { char: readCharProps(raw?.char), para: readParaProps(raw?.para) }
  }
  get = () => this.state
  subscribe = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }
  update(patch: { char?: Partial<CharProps>; para?: Partial<ParaProps> }) {
    this.state = { char: { ...this.state.char, ...patch.char }, para: { ...this.state.para, ...patch.para } }
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state))
    } catch {
      // Not remembered; still used.
    }
    this.changes.emit()
  }
}

let store: TypeSettingsStore | null = null
export const typeSettings = () => (store ??= new TypeSettingsStore())
