/**
 * A few words by the pointer while a drag goes on: where a guide is, how
 * far a move has gone. Set by the gestures, in the canvas's device pixels;
 * the canvas (ui/Viewport.tsx) shows it beside the point.
 */
import { formatLength, type Unit } from '../doc/units'
import { documents } from './documents'
import { guidePrefs } from './guidePrefs'

export interface Readout {
  text: string
  /** Device pixels on the canvas. */
  x: number
  y: number
}

class ReadoutStore {
  private value: Readout | null = null
  private listeners = new Set<() => void>()
  get = () => this.value
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  set(r: Readout | null) {
    if (r === this.value || (r && this.value && r.text === this.value.text && r.x === this.value.x && r.y === this.value.y)) return
    this.value = r
    for (const fn of this.listeners) fn()
  }
}

let store: ReadoutStore | null = null
export const readout = () => (store ??= new ReadoutStore())

/** A length in the rulers' units, with the unit: "120 px", "1.5 in". */
export function lengthText(px: number, unit: Unit = guidePrefs().get().units): string {
  const ppi = documents().active()?.history.present.resolution ?? 72
  return `${formatLength(px, unit, ppi)} ${unit}`
}
