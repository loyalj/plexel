/**
 * The colour picker at the pointer, as Photoshop's HUD colour picker:
 * Shift+Alt and a right-drag on the canvas with a painting tool or the
 * Colour Picker (Ctrl+Alt+Cmd and a drag on a Mac) shows a saturation and
 * brightness square at the pointer, the foreground's place in it under
 * the pointer, with a hue strip beside it. Move in the square for the
 * shade; move across onto the strip for the hue. The foreground follows
 * as you go, and letting go keeps it; Esc puts the colour back.
 */
import { useSyncExternalStore } from 'react'
import { colours } from '../app/colours'
import { colourEngineNow } from '../app/colour'
import { documents } from '../app/documents'
import { hsbToRgb, rgbToHsb } from '../color/models'
import type { ColourValue } from '../color/value'
import { Listeners } from '../lib/listeners'
import { targetOf } from './colourView'

/** The square's side and the strip's width, in CSS pixels. */
const SIDE = 180
const STRIP = 22
const GAP = 8

interface Hud {
  /** The square's corner, in CSS pixels from the viewport's. */
  left: number
  top: number
  hsb: [number, number, number]
  /** The viewport's corner on screen, to read the pointer against. */
  origin: [number, number]
  /** The foreground before, for Esc. */
  was: ColourValue
}

let hud: Hud | null = null
const changes = new Listeners()
const show = (h: Hud | null) => {
  hud = h
  changes.emit()
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function setFg(hsb: [number, number, number]) {
  const doc = documents().active()?.history.present ?? null
  const t = targetOf('hsb', doc)
  colours().setFg({ ...t, c: hsbToRgb(hsb) })
}

export const colourHud = {
  /** Whether a press is the HUD's: Shift+Alt and the right button, or Ctrl+Alt+Cmd and the left on a Mac. */
  wants(e: { button: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }, mac: boolean) {
    return (e.button === 2 && e.shiftKey && e.altKey) || (mac && e.button === 0 && e.ctrlKey && e.altKey && e.metaKey)
  },
  start(clientX: number, clientY: number, viewport: DOMRect): boolean {
    const conv = colourEngineNow()?.converter
    if (!conv) return false
    const doc = documents().active()?.history.present ?? null
    const fg = colours().get().fg
    const [h, s, b] = rgbToHsb(conv.convert(fg, targetOf('hsb', doc)).c) as [number, number, number]
    // The foreground's place in the square under the pointer, kept inside the viewport.
    const x = clientX - viewport.left
    const y = clientY - viewport.top
    const left = Math.min(viewport.width - SIDE - GAP - STRIP - 4, Math.max(4, x - s * SIDE))
    const top = Math.min(viewport.height - SIDE - 4, Math.max(4, y - (1 - b) * SIDE))
    show({ left, top, hsb: [h, s, b], origin: [viewport.left, viewport.top], was: fg })
    return true
  },
  move(clientX: number, clientY: number) {
    if (!hud) return
    const x = clientX - hud.origin[0] - hud.left
    const y = clientY - hud.origin[1] - hud.top
    const [h, s, b] = hud.hsb
    // Past the square, onto the strip: the hue; in it, the shade.
    const next: [number, number, number] = x > SIDE + GAP / 2 ? [clamp01(y / SIDE) * 360, s, b] : [h, clamp01(x / SIDE), 1 - clamp01(y / SIDE)]
    show({ ...hud, hsb: next })
    setFg(next)
  },
  end(cancel = false) {
    if (!hud) return
    if (cancel) colours().setFg(hud.was)
    show(null)
  },
  active: () => hud !== null,
}

export function ColourHud() {
  const h = useSyncExternalStore((l) => changes.subscribe(l), () => hud)
  if (!h) return null
  const [hue, s, b] = h.hsb
  const pure = `hsl(${hue} 100% 50%)`
  const rgb = hsbToRgb(h.hsb).map((v) => Math.round(v * 255))
  return (
    <div className="colour-hud" data-colour-hud="" style={{ left: h.left, top: h.top }} aria-hidden>
      <div className="colour-hud-square" style={{ width: SIDE, height: SIDE, background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pure})` }}>
        <span className="colour-hud-dot" style={{ left: s * SIDE, top: (1 - b) * SIDE, background: `rgb(${rgb.join(' ')})` }} />
      </div>
      <div className="colour-hud-strip" style={{ width: STRIP, height: SIDE, marginLeft: GAP }}>
        <span className="colour-hud-mark" style={{ top: (hue / 360) * SIDE }} />
      </div>
    </div>
  )
}
