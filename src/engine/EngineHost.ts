/**
 * The page's handle on the engine worker. React talks to this, never to the
 * worker, and never to the GPU.
 *
 * One per page, made on first use. StrictMode mounts every component twice
 * in development, and a canvas can hand its control to an OffscreenCanvas
 * only once, so the host remembers which canvas it was given and ignores a
 * second attach of the same one. A different canvas (the viewport really was
 * rebuilt) gets a fresh worker, because the old one's canvas is gone.
 */
import type { DocLook } from '../color/proof'
import type { BrushCursor, BrushImage, EngineCalls, FromEngine, GpuInfo, Rgb, ToEngine } from './protocol'
import type { Doc, DocNode } from '../doc/types'
import type { DisplayProfileId } from '../color/profiles'
import { sceneChannels, scenePatterns, type SceneDoc } from '../render/scene'
import type { Overlay } from '../render/overlay'
import { paneCanvas, paneRects, type Canvas, type Pane, type View } from '../render/view'
import type { StrokeStart } from '../render/strokes'
import type { PenSample } from '../brush/stroke'
import { RingWriter, createRing, type Ring } from '../input/penRing'
import { Listeners } from '../lib/listeners'
import { expandDoc } from '../doc/expand'

/** A version per node object: every edit replaces the nodes it touches, so a new object is a new version. */
const versions = new WeakMap<DocNode, number>()
let nextVersion = 1
const versionOf = (n: DocNode) => {
  let v = versions.get(n)
  if (v === undefined) {
    v = nextVersion++
    versions.set(n, v)
  }
  return v
}

/** What was last sent for a document, to send only what changed. */
interface Sent {
  nodes: Doc['nodes']
  fields: string
  profiles: Set<string>
  /** The decorations' epoch the nodes were sent at. */
  epoch: number
}

/** Kinds the page decorates: text (its glyphs), and smart objects (text in their contents). */
const DECORATED = new Set(['text', 'embedded'])

export type EngineStatus = 'idle' | 'starting' | 'ready' | 'unsupported' | 'lost'

export interface EngineState {
  status: EngineStatus
  gpu: GpuInfo | null
  /** Why there's no engine, or why it was lost; written for the screen. */
  reason: string | null
  /** The most recent error the engine reported and survived. */
  error: string | null
  frames: number
  /** The canvas's size in device pixels, as last drawn. */
  width: number
  height: number
  /** The document's zoom as last drawn (1 is 100%), or null with no document. */
  zoom: number | null
  /** Tiles still to render for the view on screen; 0 when the canvas is up to date. */
  pending: number
}

/**
 * The part of the state that changes rarely: whether there's an engine, its
 * GPU, and what went wrong. The rest changes every frame, so whatever only
 * needs this (the app itself) subscribes to it alone and isn't drawn again
 * each frame.
 */
export type EngineHealth = Pick<EngineState, 'status' | 'gpu' | 'reason' | 'error'>

const healthOf = ({ status, gpu, reason, error }: EngineState): EngineHealth => ({ status, gpu, reason, error })

const INITIAL: EngineState = {
  status: 'idle',
  gpu: null,
  reason: null,
  error: null,
  frames: 0,
  width: 0,
  height: 0,
  zoom: null,
  pending: 0,
}

class EngineHost {
  private worker: Worker | null = null
  private canvas: HTMLCanvasElement | null = null
  private observer: ResizeObserver | null = null
  private state: EngineState = INITIAL
  private changes = new Listeners()
  private health: EngineHealth = healthOf(INITIAL)
  private healthChanges = new Listeners()
  private pasteboard: Rgb | null = null
  private nextCall = 1
  private calls = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  /** Calls made before there is a worker, sent as soon as there is one. */
  private queued: ToEngine[] = []
  /** Everything the engine has been told about documents, to tell a new worker again. */
  private sent = new Map<string, Sent>()
  /**
   * What the page adds to a node on its way to the engine and the document
   * doesn't hold: text's laid-out glyphs (the engine has no fonts). Kept to
   * one object per node and epoch, so a node sent again is the same version.
   */
  private decorate: ((node: DocNode, doc: Doc) => DocNode) | null = null
  private decorEpoch = 0
  private scenes = new Map<string, Doc>()
  private views = new Map<string, View>()
  private frontKey: string | null = null
  private displayProfile: DisplayProfileId = 'srgb'
  private profileBytes: (hash: string) => Uint8Array | undefined = () => undefined
  private size: Canvas = { width: 0, height: 0, dpr: 1 }
  private ring: Ring | null = createRing()
  private ringWriter = this.ring ? new RingWriter(this.ring) : null
  private refusedListeners = new Set<(id: number, reason: string) => void>()
  private sizeChanges = new Listeners()

  /** For useSyncExternalStore: the state is replaced, never mutated, so this is stable between changes. */
  getState = () => this.state

  subscribe = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }

  /** For useSyncExternalStore: replaced only when the status, GPU, reason or error change, not every frame. */
  getHealth = () => this.health

  subscribeHealth = (fn: () => void) => {
    return this.healthChanges.subscribe(fn)
  }

  attach(canvas: HTMLCanvasElement) {
    if (this.canvas === canvas) return
    this.detach()
    this.canvas = canvas

    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'plexel-engine' })
    this.worker = worker
    worker.onmessage = (e: MessageEvent<FromEngine>) => this.receive(e.data)
    worker.onerror = (e) => {
      this.set({ status: 'lost', reason: `The engine stopped: ${e.message || 'an error in the worker'}` })
      // Nothing will answer the calls waiting on it.
      for (const c of this.calls.values()) c.reject(new Error('The engine stopped before it answered'))
      this.calls.clear()
    }

    const { width, height } = devicePixels(canvas)
    const offscreen = canvas.transferControlToOffscreen()
    this.set({ ...INITIAL, status: 'starting' })
    this.send({ type: 'init', canvas: offscreen, width, height, dpr: devicePixelRatio }, [offscreen])
    if (this.pasteboard) this.send({ type: 'theme', pasteboard: this.pasteboard })
    this.send({ type: 'display', profile: this.displayProfile })
    if (this.ring) this.send({ type: 'pen', ring: this.ring.buffer })
    // A new worker knows nothing: every document again, whole.
    this.sent.clear()
    for (const [key, doc] of this.scenes) this.setScene(key, doc)
    for (const [key, view] of this.views) this.send({ type: 'view', key, view })
    for (const [key, sp] of this.splits) this.send({ type: 'split', key, second: sp.second, split: sp.split })
    for (const [key, look] of this.looks) this.sendLook(key, look)
    this.send({ type: 'front', key: this.frontKey })
    for (const m of this.queued.splice(0)) this.send(m)
    this.size = { width, height, dpr: devicePixelRatio }
    this.emitSize()

    // device-pixel-content-box is the canvas's size in real device pixels,
    // rounded the way the compositor rounds it, so the image is never
    // resampled by a fraction of a pixel. Browsers without it get CSS pixels
    // times the ratio, which is right everywhere but at odd zoom levels.
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      const box = entry.devicePixelContentBoxSize?.[0]
      const w = box ? box.inlineSize : Math.round(entry.contentRect.width * devicePixelRatio)
      const h = box ? box.blockSize : Math.round(entry.contentRect.height * devicePixelRatio)
      this.send({ type: 'resize', width: Math.max(1, w), height: Math.max(1, h), dpr: devicePixelRatio })
      this.size = { width: Math.max(1, w), height: Math.max(1, h), dpr: devicePixelRatio }
      this.emitSize()
    })
    try {
      observer.observe(canvas, { box: 'device-pixel-content-box' })
    } catch {
      observer.observe(canvas)
    }
    this.observer = observer
    this.watchPixelRatio()
  }

  /**
   * A window dragged to a screen with a different pixel ratio keeps its CSS
   * size, and not every browser reports the new device-pixel box when only
   * the ratio changed. So the ratio is watched too: a media query that
   * matches only the current ratio, re-armed each time it stops matching.
   */
  private watchPixelRatio() {
    this.unwatchRatio?.()
    const query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
    const changed = () => {
      if (this.canvas) {
        this.size = { ...devicePixels(this.canvas), dpr: devicePixelRatio }
        this.send({ type: 'resize', ...this.size })
        this.emitSize()
      }
      this.watchPixelRatio()
    }
    query.addEventListener('change', changed, { once: true })
    this.unwatchRatio = () => query.removeEventListener('change', changed)
  }

  private unwatchRatio: (() => void) | null = null

  /** Sets the pasteboard from a CSS colour such as `#3a3a3a`. Remembered, so it reaches a worker started later. */
  setPasteboard(css: string) {
    const rgb = parseHex(css)
    if (!rgb) return
    this.pasteboard = rgb
    this.send({ type: 'theme', pasteboard: rgb })
  }

  /**
   * Asks the engine for something and waits for the answer. Arguments
   * holding a Uint8Array are copied before they are sent, so the caller's
   * array stays usable.
   */
  /**
   * Calls the engine. `give` is buffers the caller hands over: moved to the
   * worker as they are, no copy made, and unusable here afterwards (a whole
   * file just read, say). Otherwise the arguments are copied on their way,
   * as any message is, and the caller keeps its own.
   */
  call<M extends keyof EngineCalls>(method: M, args: EngineCalls[M]['args'], give?: Transferable[]): Promise<EngineCalls[M]['result']> {
    const id = this.nextCall++
    const transfer: Transferable[] = give ? [...give] : []
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject })
      const m = { type: 'call', id, method, args } as ToEngine
      if (this.worker) this.worker.postMessage(m, transfer)
      else this.queued.push(m)
    })
  }

  /** Where embedded profiles' bytes come from, so the engine can be sent them. */
  setProfileSource(fn: (hash: string) => Uint8Array | undefined) {
    this.profileBytes = fn
  }

  /**
   * A document as it is now. Only the nodes that are new objects since the
   * last time are sent (edits replace what they change), with the ones
   * that went; a document the same as last time sends nothing.
   */
  /** Sets what decorates nodes on their way to the engine (app/text.ts: text's glyphs). */
  setDecorator(fn: (node: DocNode, doc: Doc) => DocNode) {
    this.decorate = fn
    this.redecorate()
  }

  /** What decorations depend on has changed (a font arrived): decorated nodes are sent again. */
  redecorate() {
    this.decorEpoch++
    for (const [key, doc] of this.scenes) this.setScene(key, doc)
  }

  setScene(key: string, doc: Doc) {
    // Artboards and symbol instances, as the plain layers they're drawn as (doc/expand.ts).
    doc = expandDoc(doc)
    this.scenes.set(key, doc)
    const fields: SceneDoc = { width: doc.width, height: doc.height, mode: doc.mode, depth: doc.depth, profile: doc.profile, root: doc.root, selection: doc.selection?.tiles ?? null, patterns: scenePatterns(doc), ...(doc.tiled ? { tiled: doc.tiled } : {}), ...(doc.channels?.length ? { channels: sceneChannels(doc) } : {}) }
    const fieldKey = JSON.stringify(fields)
    const prev = this.sent.get(key)
    if (prev && prev.nodes === doc.nodes && prev.fields === fieldKey && prev.epoch === this.decorEpoch) return
    const stale = prev?.epoch !== this.decorEpoch
    const nodes: { node: DocNode; version: number }[] = []
    for (const [id, node] of Object.entries(doc.nodes)) {
      if (prev?.nodes[id] === node && !(stale && DECORATED.has(node.kind))) continue
      const sent = this.decorate && DECORATED.has(node.kind) ? this.decorate(node, doc) : node
      nodes.push({ node: sent, version: versionOf(sent) })
    }
    const removed = prev ? Object.keys(prev.nodes).filter((id) => !(id in doc.nodes)) : []
    const profiles = prev?.profiles ?? new Set<string>()
    let profile: { hash: string; bytes: Uint8Array } | null = null
    if ('asset' in doc.profile && !profiles.has(doc.profile.asset)) {
      const bytes = this.profileBytes(doc.profile.asset)
      if (bytes) {
        profile = { hash: doc.profile.asset, bytes: bytes.slice() }
        profiles.add(doc.profile.asset)
      }
    }
    this.sent.set(key, { nodes: doc.nodes, fields: fieldKey, profiles, epoch: this.decorEpoch })
    this.send({ type: 'scene', key, update: { doc: fields, nodes, removed, reset: !prev }, profile }, profile ? [profile.bytes.buffer as ArrayBuffer] : [])
  }

  setView(key: string, view: View) {
    this.views.set(key, view)
    this.send({ type: 'view', key, view })
  }

  /** Split views: each document's second pane, where the canvas is cut, and which pane the tools work in. */
  private splits = new Map<string, { second: View; split: number; active: 0 | 1 }>()

  /** A document's second pane, or none; `active` is the pane the pointer and tools are in. */
  setSplit(key: string, s: { second: View; split: number; active: 0 | 1 } | null) {
    if (s) this.splits.set(key, s)
    else this.splits.delete(key)
    this.send({ type: 'split', key, second: s?.second ?? null, split: s?.split ?? 0.5 })
    this.emitSize()
  }

  /** The front document's panes on the canvas, in device pixels: one, or two side by side. */
  panes(): Pane[] {
    const sp = this.frontKey ? this.splits.get(this.frontKey) : undefined
    return paneRects(this.size, sp ? sp.split : null)
  }

  /** The pane the tools work in, by index. */
  activePane(): 0 | 1 {
    const sp = this.frontKey ? this.splits.get(this.frontKey) : undefined
    return sp ? sp.active : 0
  }

  /** The whole canvas, in device pixels, whatever the panes. */
  fullCanvasSize = (): Canvas => this.size

  private looks = new Map<string, DocLook>()

  /** How a document is looked at (color/proof.ts): proofing, the gamut warning, separations. */
  setLook(key: string, look: DocLook) {
    if (this.looks.get(key) === look) return
    this.looks.set(key, look)
    this.sendLook(key, look)
  }

  private sendLook(key: string, look: DocLook) {
    const p = look.setup.profile
    const bytes = 'asset' in p ? this.profileBytes(p.asset) : undefined
    const profile = 'asset' in p && bytes ? { hash: p.asset, bytes: bytes.slice() } : null
    this.send({ type: 'look', key, look, profile }, profile ? [profile.bytes.buffer as ArrayBuffer] : [])
  }

  /** What the tools draw over a document, in document pixels. */
  setOverlay(key: string, overlay: Overlay) {
    this.send({ type: 'overlay', key, overlay })
  }

  setFront(key: string | null) {
    if (key === this.frontKey) return
    this.frontKey = key
    this.send({ type: 'front', key })
  }

  /** A document closed: the engine lets go of it. */
  closeDoc(key: string) {
    this.scenes.delete(key)
    this.views.delete(key)
    this.looks.delete(key)
    this.sent.delete(key)
    this.send({ type: 'close', key })
  }

  setDisplay(profile: DisplayProfileId) {
    if (profile === this.displayProfile) return
    this.displayProfile = profile
    this.send({ type: 'display', profile })
  }

  // --- painting -------------------------------------------------------------

  beginStroke(start: StrokeStart) {
    this.send({ type: 'stroke.begin', start })
  }

  /** Image tips and patterns for strokes to come (they arrive before the strokes: messages keep their order). */
  sendBrushAssets(tips: BrushImage[], textures: BrushImage[]) {
    const strip = (a: BrushImage): BrushImage => ({ id: a.id, width: a.width, height: a.height, data: a.data })
    this.send({ type: 'brush.assets', tips: tips.map(strip), textures: textures.map(strip) })
  }

  /** A stroke's samples: through the shared ring when there is one, as a message otherwise. */
  strokeSamples(id: number, samples: PenSample[]) {
    const overflow: PenSample[] = []
    for (const s of samples) if (!this.ringWriter?.push(id, s)) overflow.push(s)
    if (overflow.length) this.send({ type: 'stroke.samples', id, samples: overflow })
  }

  cancelStroke(id: number) {
    this.send({ type: 'stroke.cancel', id })
  }

  setCursor(cursor: BrushCursor | null) {
    this.send({ type: 'cursor', cursor })
  }

  onStrokeRefused(fn: (id: number, reason: string) => void) {
    this.refusedListeners.add(fn)
    return () => {
      this.refusedListeners.delete(fn)
    }
  }

  /** The canvas's size in device pixels, and the pixel ratio: what the view maths works in. */
  /**
   * The canvas the page works in, in device pixels: the whole canvas, or
   * in a split view the active pane, so views, gestures and the rulers
   * measure the pane the pointer is in.
   */
  canvasSize = (): Canvas => {
    const panes = this.panes()
    return panes.length > 1 ? paneCanvas(this.size, panes[this.activePane()]) : this.size
  }

  onCanvasSize = (fn: () => void) => {
    return this.sizeChanges.subscribe(fn)
  }

  private emitSize() {
    this.sizeChanges.emit()
  }

  private detach() {
    this.observer?.disconnect()
    this.observer = null
    this.unwatchRatio?.()
    this.unwatchRatio = null
    this.worker?.terminate()
    this.worker = null
    // Whatever the old worker was asked, it will never answer now.
    for (const c of this.calls.values()) c.reject(new Error('The engine was restarted before it answered'))
    this.calls.clear()
    this.canvas = null
  }

  private send(m: ToEngine, transfer: Transferable[] = []) {
    this.worker?.postMessage(m, transfer)
  }

  private receive(m: FromEngine) {
    switch (m.type) {
      case 'ready':
        this.set({ status: 'ready', gpu: m.gpu, reason: null })
        break
      case 'unsupported':
        this.set({ status: 'unsupported', reason: m.reason })
        break
      case 'lost':
        this.set({ status: m.recovering ? 'starting' : 'lost', reason: m.reason })
        break
      case 'frame':
        this.set({ frames: m.count, width: m.width, height: m.height, zoom: m.zoom, pending: m.pending })
        for (const fn of this.frameListeners) fn(m)
        break
      case 'error':
        this.set({ error: m.message })
        break
      case 'stroke.refused':
        for (const fn of this.refusedListeners) fn(m.id, m.reason)
        break
      case 'progress':
        this.progressListeners.get(m.job)?.(m.fraction)
        break
      case 'reply': {
        const c = this.calls.get(m.id)
        this.calls.delete(m.id)
        if (!c) break
        if (m.ok) c.resolve(m.value)
        else {
          // The worker's error, by name: a DOMException doesn't survive the trip as one, but its name does.
          const e = new Error(m.error)
          e.name = m.name
          c.reject(e)
        }
        break
      }
    }
  }

  private progressListeners = new Map<string, (fraction: number | null) => void>()

  /** A long job's progress as the engine reports it (app/jobs.ts); the function returned stops listening. */
  onProgress(job: string, fn: (fraction: number | null) => void) {
    this.progressListeners.set(job, fn)
    return () => {
      this.progressListeners.delete(job)
    }
  }

  /** Calls a long job off: the engine stops it where it can (engine/jobs.ts). */
  cancelJob(job: string) {
    const m = { type: 'job.cancel', job } as ToEngine
    if (this.worker) this.worker.postMessage(m)
  }

  private frameListeners = new Set<(m: Extract<FromEngine, { type: 'frame' }>) => void>()

  /** Every frame as it's reported, for the bench and the checks' waits. */
  onFrame(fn: (m: Extract<FromEngine, { type: 'frame' }>) => void) {
    this.frameListeners.add(fn)
    return () => {
      this.frameListeners.delete(fn)
    }
  }

  /**
   * Resolves once the canvas has drawn what it had to and has nothing left:
   * at the first frame with nothing pending after one that had work (tiles
   * rendered or waiting). Not at once on the last frame's word: just after
   * a change, frames still report the canvas as it was, with nothing to do.
   * For work that can wait for the canvas (thumbnails), so it doesn't hold
   * back the picture a document has just been opened to. If the canvas
   * never has work, it never resolves: callers race it with a timeout.
   */
  whenDrawn(): Promise<void> {
    return new Promise((resolve) => {
      let worked = false
      const off = this.onFrame((m) => {
        if (m.rendered > 0 || m.pending > 0) worked = true
        if (!worked || m.pending > 0) return
        off()
        resolve()
      })
    })
  }

  private set(patch: Partial<EngineState>) {
    this.state = { ...this.state, ...patch }
    const h = this.health
    const s = this.state
    if (s.status !== h.status || s.gpu !== h.gpu || s.reason !== h.reason || s.error !== h.error) {
      this.health = healthOf(s)
      this.healthChanges.emit()
    }
    this.changes.emit()
  }
}

function devicePixels(canvas: HTMLCanvasElement) {
  const r = canvas.getBoundingClientRect()
  return { width: Math.max(1, Math.round(r.width * devicePixelRatio)), height: Math.max(1, Math.round(r.height * devicePixelRatio)) }
}

/** `#rgb` or `#rrggbb` to 0..1 components; anything else is null. */
function parseHex(css: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim())
  if (!m) return null
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb
}

let host: EngineHost | null = null
/** The page's one engine. */
export const engine = () => (host ??= new EngineHost())
