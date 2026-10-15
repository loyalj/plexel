/**
 * Swatches: colours kept for reuse. App-wide and remembered by the browser,
 * like the foreground and background. Each keeps the space and profile it
 * was picked in (color/value.ts), so a CMYK swatch stays those inks and a
 * Lab one the same colour in every document.
 *
 * Swatches saved in the document itself, global colours and spot colours
 * are the document's (doc/swatches.ts, app/docSwatches.ts).
 */
import { readColourValue, type ColourValue } from '../color/value'
import { Listeners } from '../lib/listeners'

const KEY = 'plexel.swatches.v1'
const SRGB = { builtin: 'srgb' }
const hex = (h: string): ColourValue => ({ space: 'rgb', profile: SRGB, c: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) })

/** The starting set: greys, then the hue circle at full strength, then muted and earth colours. */
const DEFAULT_SWATCHES: ColourValue[] = [
  'ffffff', 'd9d9d9', 'a6a6a6', '737373', '404040', '000000',
  'e8402e', 'f08a24', 'f5c518', '6bbf3a', '24a78a', '2c8fd6', '3c4fc2', '8547c0', 'd23f8b',
  'f2b7ae', 'f9d6a4', 'fbeaa8', 'c7e3b0', 'a9ddd3', 'acd0ee', 'c1c4ec', 'dbc4ec',
  '7a4a2a', 'a87447', 'd9b48f', '5c6b3a', '3d5a6c', '8c3b3b',
].map(hex)

const read = readColourValue

function load(): ColourValue[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (!Array.isArray(raw)) return DEFAULT_SWATCHES
    return raw.map(read).filter((x): x is ColourValue => !!x)
  } catch {
    return DEFAULT_SWATCHES
  }
}

class SwatchStore {
  private list = load()
  private changes = new Listeners()

  get = () => this.list

  subscribe = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }

  private set(next: ColourValue[]) {
    this.list = next
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // Kept for this tab only.
    }
    this.changes.emit()
  }

  add(c: ColourValue) {
    this.set([...this.list, c])
  }

  remove(index: number) {
    this.set(this.list.filter((_, i) => i !== index))
  }

  reset() {
    this.set(DEFAULT_SWATCHES)
  }
}

let store: SwatchStore | null = null
export const swatches = () => (store ??= new SwatchStore())
