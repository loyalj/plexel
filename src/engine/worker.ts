/**
 * The engine worker: it owns the GPU device and draws the canvas.
 *
 * The page hands over an OffscreenCanvas once, and from then on every pixel
 * on it is drawn here. React never touches the GPU and this file never
 * touches the DOM: the same split as Fresyn's audio thread, and for the
 * same reason. A panel re-rendering must never cost the canvas a frame.
 *
 * The page sends documents as scenes (only what changed), views, and which
 * document is in front; the renderer (render/renderer.ts) draws from those.
 * Calls (tiles, images, thumbnails) are answered whether or not there's a
 * GPU yet, as far as each can be.
 */
import { nodeImage } from './nodeImage'
import { writePsdPlan } from './psdWrite'
import { openPsd } from './psdHost'
import { convertSets } from './convertHost'
import type { DocLook } from '../color/proof'
import { acquireDevice, describeGpu } from './gpu'
import { held, pinSet, setOnCollected, store, tileHandlers, tilesReady, unpinSet, type Handler } from './tileHost'
import type { EngineCalls, FromEngine, Rgb, ToEngine } from './protocol'
import { Renderer } from '../render/renderer'
import { registerTip, tipFromBytes } from '../brush/tips'
import { registerTexture } from '../brush/textures'
import type { DisplayProfileId } from '../color/profiles'
import type { SceneUpdate } from '../render/scene'
import type { View } from '../render/view'
import type { Overlay } from '../render/overlay'
import { addProfile, colour } from './colourHost'
import { exportImage, importImage, optimizeImage } from './imageHost'
import { bakeEffects, mergeNodes, rasterizeNode, readPixels8, renderSmall, samplePoint, shrink } from '../render/readback'
import { alphaBounds, valueAt } from '../tiles/coverage'
import { encodePng } from '../io/png'
import { selectHandlers } from './selectHost'
import { guarded, workIdle } from './work'
import { clipHandlers } from './clipHost'
import { fillHandlers } from './fillHost'
import { channelHandlers } from './channelHost'
import { dabCoverage, onWholePixels, retouchArea, selectionCoverage } from './retouchHost'
import { selectImageHandlers } from './selectImageHost'
import { cancelJob, cancelledError, endJob, isCancelled, progress, setJobPost } from './jobs'

/**
 * The worker's global, typed by hand. The project compiles against the DOM
 * library, and pulling in the WebWorker one as well makes the two fight over
 * every global they share, so this names only the two members we use.
 */
const scope = self as unknown as {
  postMessage(m: FromEngine, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<ToEngine>) => void) | null
}
const post = (m: FromEngine, transfer: Transferable[] = []) => scope.postMessage(m, transfer)
setJobPost((m) => post(m))

/** Workers with an OffscreenCanvas get requestAnimationFrame; anything else gets a 60 Hz timer. */
const nextFrame: (fn: () => void) => void =
  typeof requestAnimationFrame === 'function' ? (fn) => requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16)

/**
 * A lost device is asked for again this many times in a row before the
 * engine gives up. A driver reset recovers on the first try; a GPU that
 * loses every device it is given would otherwise loop forever.
 */
const MAX_RECOVERIES = 3

interface Gpu {
  device: GPUDevice
  context: GPUCanvasContext
  format: GPUTextureFormat
  renderer: Renderer
  features: string[]
}

let canvas: OffscreenCanvas | null = null
let gpu: Gpu | null = null
let starting: Promise<void> | null = null
let recoveries = 0
let frames = 0
let framePending = false
let dpr = 1

/** What the renderer needs, kept here too so a replacement device starts from it. */
let pasteboard: Rgb = [0.25, 0.25, 0.25]
let display: DisplayProfileId = 'srgb'
let front: string | null = null
const scenes = new Map<string, SceneUpdate>()
const views = new Map<string, View>()
const splits = new Map<string, { second: View | null; split: number }>()
const looks = new Map<string, DocLook>()
const overlays = new Map<string, Overlay>()
let penRing: SharedArrayBuffer | null = null


scope.onmessage = (e) => {
  const m = e.data
  switch (m.type) {
    case 'init':
      canvas = m.canvas
      canvas.width = Math.max(1, m.width)
      canvas.height = Math.max(1, m.height)
      dpr = m.dpr
      starting = start()
      break
    case 'resize':
      if (!canvas) break
      dpr = m.dpr
      // Setting width or height clears the canvas even when it is
      // unchanged, so only touch them on a real change.
      if (canvas.width !== m.width || canvas.height !== m.height) {
        canvas.width = Math.max(1, m.width)
        canvas.height = Math.max(1, m.height)
      }
      gpu?.renderer.resize({ width: canvas.width, height: canvas.height, dpr })
      requestFrame()
      break
    case 'theme':
      pasteboard = m.pasteboard
      gpu?.renderer.setPasteboard(pasteboard)
      requestFrame()
      break
    case 'scene': {
      if (m.profile) addProfile(m.profile.hash, m.profile.bytes)
      // Kept whole, so a replacement device can be given everything again.
      const prev = scenes.get(m.key)
      scenes.set(m.key, merge(prev, m.update))
      gpu?.renderer.updateScene(m.key, m.update)
      requestFrame()
      break
    }
    case 'look':
      if (m.profile) addProfile(m.profile.hash, m.profile.bytes)
      looks.set(m.key, m.look)
      gpu?.renderer.setLook(m.key, m.look)
      requestFrame()
      break
    case 'view':
      views.set(m.key, m.view)
      gpu?.renderer.setView(m.key, m.view)
      requestFrame()
      break
    case 'split':
      splits.set(m.key, { second: m.second, split: m.split })
      gpu?.renderer.setSplit(m.key, m.second, m.split)
      requestFrame()
      break
    case 'overlay':
      overlays.set(m.key, m.overlay)
      gpu?.renderer.setOverlay(m.key, m.overlay)
      requestFrame()
      break
    case 'front':
      front = m.key
      gpu?.renderer.setFront(front)
      requestFrame()
      break
    case 'close':
      scenes.delete(m.key)
      views.delete(m.key)
      splits.delete(m.key)
      looks.delete(m.key)
      overlays.delete(m.key)
      gpu?.renderer.close(m.key)
      requestFrame()
      break
    case 'display':
      display = m.profile
      configure()
      gpu?.renderer.setDisplay(display)
      requestFrame()
      break
    case 'pen':
      penRing = m.ring
      gpu?.renderer.setPenRing({ buffer: m.ring })
      break
    case 'brush.assets':
      for (const t of m.tips) registerTip(t.id, tipFromBytes(t.width, t.height, t.data))
      for (const t of m.textures) registerTexture(t.id, { width: t.width, height: t.height, data: Float32Array.from(t.data, (v) => v / 255) })
      break
    case 'stroke.begin': {
      const why = gpu ? gpu.renderer.beginStroke(m.start) : 'The graphics device isn’t ready yet.'
      if (why) post({ type: 'stroke.refused', id: m.start.id, reason: why })
      break
    }
    case 'stroke.samples':
      gpu?.renderer.addSamples(m.id, m.samples)
      break
    case 'job.cancel':
      cancelJob(m.job)
      break
    case 'stroke.cancel':
      gpu?.renderer.cancelStroke(m.id)
      break
    case 'cursor':
      gpu?.renderer.setCursor(m.cursor)
      requestFrame()
      break
    case 'call':
      handleCall(m.method, m.args).then(
        ({ value, transfer }) => {
          // A result that can't be sent (one that won't clone) is the call's failure, not a call that never answers.
          try {
            post({ type: 'reply', id: m.id, ok: true, value }, transfer)
          } catch (e) {
            post(failure(m.id, e))
          }
        },
        (e) => post(failure(m.id, e)),
      )
      break
  }
}

/** A call's failure as a reply: what went wrong, and what kind of error it was. */
function failure(id: number, e: unknown): FromEngine {
  return { type: 'reply', id, ok: false, error: e instanceof Error ? e.message : String(e), name: e instanceof Error ? e.name : 'Error' }
}

/** A scene with an update applied to it, as one full update. */
function merge(prev: SceneUpdate | undefined, u: SceneUpdate): SceneUpdate {
  if (!prev || u.reset) return { ...u, reset: true }
  const nodes = new Map(prev.nodes.map((n) => [n.node.id, n]))
  for (const id of u.removed) nodes.delete(id)
  for (const n of u.nodes) nodes.set(n.node.id, n)
  return { doc: u.doc, nodes: [...nodes.values()], removed: [], reset: true }
}

async function start() {
  const got = await acquireDevice()
  if (!got.ok) {
    post({ type: 'unsupported', reason: got.reason })
    return
  }
  if (!canvas) return
  const { device, adapter, features } = got

  const context = canvas.getContext('webgpu')
  if (!context) {
    post({ type: 'unsupported', reason: 'The browser gave the canvas no WebGPU context.' })
    return
  }
  const format = navigator.gpu.getPreferredCanvasFormat()
  device.onuncapturederror = (ev) => {
    // Logged as well as shown, so a browser check counts it as a problem.
    console.error(`GPU: ${ev.error.message}`)
    post({ type: 'error', message: `GPU: ${ev.error.message}` })
  }
  void device.lost.then((info) => onLost(info))

  const renderer = new Renderer(device, context, format, store, features, requestFrame)
  // The Healing Brush and the Spot Healing Brush, finished on the CPU from their dabs.
  renderer.finishRetouch = async (st) => {
    const doc = renderer.docState(st.start.key)?.scene.doc
    if (!doc) throw new Error('That document isn’t open any more.')
    if (!onWholePixels(st.transform)) throw new Error('Healing works on a layer that isn’t turned or scaled, on whole pixels: rasterize it first, or use the Clone Stamp.')
    const cov = await dabCoverage(st.placed, st.transform, doc.width, doc.height, st.start.selection ?? null, st.start.retouch === 'spot')
    if (!cov) return st.base
    const area = { key: st.start.key, layer: st.base, format: { mode: st.mode, depth: st.depth }, transform: st.transform, rect: cov.rect, k: cov.k }
    return st.start.retouch === 'heal' && st.start.clone ? retouchArea(renderer, area, { kind: 'heal', offset: st.start.clone.offset, sampleAll: st.start.clone.sampleAll }) : retouchArea(renderer, area, { kind: 'spot', seed: st.start.seed })
  }
  gpu = { device, context, format, renderer, features }
  configure()
  renderer.resize({ width: canvas.width, height: canvas.height, dpr })
  renderer.setPasteboard(pasteboard)
  renderer.setDisplay(display)
  for (const [key, u] of scenes) renderer.updateScene(key, u)
  for (const [key, v] of views) renderer.setView(key, v)
  for (const [key, sp] of splits) renderer.setSplit(key, sp.second, sp.split)
  for (const [key, l] of looks) renderer.setLook(key, l)
  for (const [key, o] of overlays) renderer.setOverlay(key, o)
  renderer.setFront(front)
  setOnCollected((live) => renderer.forgetSets(live))
  renderer.pins = { pin: pinSet, unpin: unpinSet }
  if (penRing) renderer.setPenRing({ buffer: penRing })
  // The colour engine loads alongside, for the display tables.
  void colour().then(() => requestFrame())
  draw()
  recoveries = 0
  post({ type: 'ready', gpu: describeGpu(adapter, device, format, features) })
}

/**
 * The canvas in the display's colour space: Display P3 when the display
 * is set to it, so the browser doesn't squeeze the image back into sRGB.
 * Opaque: the pasteboard covers everything, and an opaque canvas lets the
 * compositor skip blending it with the page behind.
 */
function configure() {
  if (!gpu) return
  gpu.context.configure({ device: gpu.device, format: gpu.format, alphaMode: 'opaque', colorSpace: display === 'display-p3' ? 'display-p3' : 'srgb' })
}

function onLost(info: GPUDeviceLostInfo) {
  gpu = null
  // 'destroyed' is our own doing, never a fault.
  if (info.reason === 'destroyed') return
  const recovering = recoveries < MAX_RECOVERIES
  post({ type: 'lost', reason: info.message || 'the device was lost', recovering })
  if (recovering) {
    recoveries++
    starting = start()
  }
}

/**
 * Frames are drawn on demand, at most one per display frame. The canvas
 * holds its last image between them, so an editor sitting idle costs the
 * GPU nothing.
 */
function requestFrame() {
  if (framePending || !gpu) return
  framePending = true
  nextFrame(() => {
    framePending = false
    draw()
  })
}

/** Calls waiting for the canvas to be up to date (render.idle). */
const idleWaiters: ((frame: number) => void)[] = []

function draw() {
  if (!gpu || !canvas) return
  const info = gpu.renderer.draw()
  if (!info) {
    // The GPU is still on the last frame; the renderer asks again when it's done.
    void gpu.device.queue.onSubmittedWorkDone().then(() => requestFrame())
    return
  }
  frames++
  if (info.pending === 0 && idleWaiters.length) {
    // Up to date once this frame is on the GPU and done.
    const waiting = idleWaiters.splice(0)
    const n = frames
    void gpu.device.queue.onSubmittedWorkDone().then(() => waiting.forEach((w) => w(n)))
  } else if (idleWaiters.length) requestFrame()
  const view = front ? views.get(front) : undefined
  post({ type: 'frame', count: frames, width: canvas.width, height: canvas.height, zoom: view ? view.zoom : null, ...info })
}

/** Waits for the GPU, for calls that render. */
async function renderer(): Promise<Renderer> {
  if (!gpu) await starting
  if (!gpu) throw new Error('There’s no GPU to render with.')
  return gpu.renderer
}

const handlers: { [M in keyof EngineCalls]: Handler<M> } = {
  ...tileHandlers,
  ...selectHandlers(renderer),
  ...clipHandlers(renderer),
  ...fillHandlers(renderer),
  ...channelHandlers(renderer, () => display),
  'retouch.patch': async (a) => {
    const r = await renderer()
    const cov = await selectionCoverage(a.selection, a.transform)
    if (!cov) return a.layer
    const set = await retouchArea(r, { key: a.key, layer: a.layer, format: a.format, transform: a.transform, rect: cov.rect, k: cov.k }, { kind: 'heal', offset: a.offset, sampleAll: a.sampleAll })
    return set === a.layer ? set : held(set)
  },
  ...selectImageHandlers(renderer),
  // Not while any call may be making tiles nobody holds yet (work.ts).
  'tiles.gc': async (a) => {
    await workIdle()
    return tileHandlers['tiles.gc'](a)
  },
  'image.import': ({ bytes, name, into }) => importImage(store, bytes, name, into),
  'psd.open': ({ bytes, name, working, intent, bpc, job }) => openPsd(bytes, name, working, intent, bpc, job).finally(() => endJob(job)),
  'psd.write': async ({ plan }) => writePsdPlan(await renderer(), plan),
  'render.nodeImage': async ({ key, node, srgb }) => nodeImage(await renderer(), key, node, srgb),
  'tiles.convert': ({ sets, from, to, intent, bpc, profiles }) => {
    for (const p of profiles) addProfile(p.hash, p.bytes)
    return convertSets(sets, from, to, intent, bpc)
  },
  'image.optimize': async ({ key, o }) => optimizeImage(await renderer(), key, o),
  'image.export': async ({ key, format, quality, lossless }) => exportImage(await renderer(), key, { format, quality, lossless }),
  'render.thumbnails': async ({ key, nodes, size }) => {
    const r = await renderer()
    const out: EngineCalls['render.thumbnails']['result'] = {}
    for (const id of nodes) {
      const img = await renderSmall(r, key, id, size, display)
      out[id] = img ? (img.data.length ? shrink(img, size) : img) : null
    }
    return out
  },
  'render.preview': async ({ key, size }) => {
    const img = await renderSmall(await renderer(), key, null, size, 'srgb')
    if (!img || !img.data.length) return null
    const small = shrink(img, size)
    const { registry } = await colour()
    async function* rows() {
      yield small.data
    }
    const blob = await encodePng({ width: small.width, height: small.height, mode: 'rgb', depth: 8, alpha: true, icc: registry.builtin('srgb').bytes(), iccName: 'sRGB IEC61966-2.1' }, rows())
    return new Uint8Array(await blob.arrayBuffer())
  },
  'render.stats': async () => (await renderer()).gpuStats(),
  'tiles.alphaBounds': ({ set }) => (store.hasSet(set) ? alphaBounds(store, set) : null),
  'tiles.valuesAt': ({ points }) => Promise.all(points.map((p) => valueAt(store, p.set, p.x, p.y, p.kind, p.outside ?? 0))),
  'render.bake': async ({ key, node, effects, selection, job }) => {
    try {
      progress(job, null)
      const set = held(await bakeEffects(await renderer(), store, key, node, effects, selection))
      // The GPU's work can't be stopped part way; called off meanwhile, the result is let go.
      if (isCancelled(job)) throw cancelledError()
      return set
    } finally {
      endJob(job)
    }
  },
  'render.histogram': async ({ key }) => {
    const r = await renderer()
    const doc = r.docState(key)?.scene.doc
    if (!doc) return []
    let level = 0
    while ((doc.width / 2 ** level) * (doc.height / 2 ** level) > 4 * 1024 * 1024) level++
    const img = await readPixels8(r, key, null, level)
    const n = img.channels - 1
    const bins = Array.from({ length: n }, () => new Array(256).fill(0))
    for (let i = 0; i < img.width * img.height; i++) {
      const o = i * img.channels
      // Only what's there: transparent pixels have no tone.
      if (!img.data[o + n]) continue
      for (let c = 0; c < n; c++) bins[c][img.data[o + c]]++
    }
    return bins
  },
  'render.rasterize': async ({ key, node }) => {
    // Kept until the page has committed it.
    return held(await rasterizeNode(await renderer(), store, key, node))
  },
  'render.merge': async ({ key, nodes }) => held(await mergeNodes(await renderer(), store, key, nodes)),
  'stroke.end': async ({ id }) => (await renderer()).endStroke(id),
  'render.sample': async ({ key, x, y, size }) => samplePoint(await renderer(), key, x, y, size),
  'render.idle': async () => {
    await renderer()
    return new Promise<number>((resolve) => {
      idleWaiters.push(resolve)
      requestFrame()
    })
  },
  'render.setStore': async ({ store: s }) => {
    const r = await renderer()
    if (s === 'f16' && !gpu?.features.includes('shader-f16')) return r.store8
    r.store8 = s
    for (const key of scenes.keys()) r.close(key)
    for (const [key, u] of scenes) r.updateScene(key, u)
    for (const [key, v] of views) r.setView(key, v)
    for (const [key, l] of looks) r.setLook(key, l)
    requestFrame()
    return r.store8
  },
  'test.probe': async (args) => {
    const { probe } = await import('../checks/probe')
    return probe(await renderer(), store, gpu?.features ?? [], args)
  },
}

/** Every ArrayBuffer in a result, one level down, to transfer rather than copy. */
function transferables(value: unknown): Transferable[] {
  const out = new Set<ArrayBuffer>()
  const visit = (v: unknown, depth: number) => {
    if (v instanceof Uint8Array && v.buffer instanceof ArrayBuffer && v.byteOffset === 0 && v.byteLength === v.buffer.byteLength) out.add(v.buffer)
    else if (v && typeof v === 'object' && depth < 3) for (const x of Object.values(v)) visit(x, depth + 1)
  }
  visit(value, 0)
  return [...out]
}

/** Runs one call from the page. Errors come back as messages, never as a dead worker. */
async function handleCall(method: keyof EngineCalls, args: unknown): Promise<{ value: unknown; transfer: Transferable[] }> {
  await tilesReady()
  const fn = handlers[method] as (a: unknown) => unknown
  if (!fn) throw new Error(`The engine has no call “${method}”`)
  const value = method === 'tiles.gc' ? await fn(args) : await guarded(async () => fn(args))
  if (method.startsWith('tiles.') && method !== 'tiles.gc' && method !== 'tiles.stats' && method !== 'tiles.describe') requestFrame()
  return { value, transfer: transferables(value) }
}
