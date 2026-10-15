/**
 * Spring-loaded tools, as Photoshop has them: tap a tool's key and the tool
 * changes for good; hold it, and the tool is yours only while the key is
 * down, the one before coming back when it's let go. Hold V to nudge a layer
 * mid-painting, hold I to sample a colour, and carry on with the Brush.
 *
 * A press counts as a hold when the key stays down longer than HOLD_MS, or
 * when the tool is used on the canvas before it's let go, however quickly.
 * If a drag is still going when the key comes up, the old tool comes back
 * once the drag ends, so a move or a stroke is never cut short.
 *
 * Space for the Hand already works this way, in the canvas itself.
 */
import { canvasGesture } from './gesture'
import { tools, type ToolId } from '../tools'
import { Listeners } from '../lib/listeners'

/** How long a key has to stay down to be a hold rather than a tap. */
export const HOLD_MS = 250

interface Held {
  /** The physical key (`KeyboardEvent.code`), so Shift or a layout can't confuse the release. */
  code: string
  /** The tool to go back to. */
  from: ToolId
  /** The tool the key chose. */
  to: ToolId
  at: number
  /** Used on the canvas while held: a hold, however short. */
  used: boolean
}

type Clock = () => number

/**
 * The state of one held key. The clock and the tool store are passed in,
 * so check-commands can drive it without a browser.
 */
export class Spring {
  held: Held | null = null
  /** Waiting for a drag to end before going back. */
  private pending: ToolId | null = null
  private changes = new Listeners()

  constructor(
    private now: Clock,
    private setTool: (id: ToolId) => void,
    private dragging: () => boolean,
  ) {}

  subscribe = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }
  get = () => this.held

  private emit() {
    this.changes.emit()
  }

  /** A tool key went down and chose `to`, over `from`. */
  press(code: string, from: ToolId, to: ToolId) {
    if (this.held?.code === code) return
    // A second tool key while one is held: it's still the first tool that comes back.
    const back = this.held ? this.held.from : this.pending ?? from
    this.pending = null
    this.held = from === to && !this.held ? null : { code, from: back, to, at: this.now(), used: false }
    this.emit()
  }

  /** The held tool was used on the canvas. */
  use() {
    if (this.held && !this.held.used) {
      this.held.used = true
      this.emit()
    }
  }

  /** A key came up: the tool to go back to, if it was a hold (it's set here too). */
  release(code: string): ToolId | null {
    const h = this.held
    if (!h || h.code !== code) return null
    this.held = null
    this.emit()
    if (!h.used && this.now() - h.at < HOLD_MS) return null
    if (this.dragging()) this.pending = h.from
    else this.setTool(h.from)
    return h.from
  }

  /** The window lost the keys: a hold ends as if let go, a tap stays. */
  blur() {
    if (this.held) this.release(this.held.code)
  }

  /** A drag ended: go back now if a release was waiting on it. */
  dragEnded() {
    if (!this.pending) return
    const back = this.pending
    this.pending = null
    this.setTool(back)
  }

  /** Something else chose a tool (a click on the toolbar): nothing to go back to. */
  forget() {
    if (!this.held && !this.pending) return
    this.held = null
    this.pending = null
    this.emit()
  }
}

let spring: Spring | null = null
export function springTools(): Spring {
  if (spring) return spring
  const s = new Spring(
    () => performance.now(),
    (id) => tools().set(id),
    () => canvasGesture.get() !== null,
  )
  canvasGesture.subscribe(() => {
    if (canvasGesture.get() === null) s.dragEnded()
  })
  spring = s
  return s
}
