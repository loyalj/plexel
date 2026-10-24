/**
 * What the page and the engine worker say to each other.
 *
 * Types only, so either side can import this without pulling in the other:
 * the worker must never load React, and the page must never load the GPU
 * code. Every message is a member of a discriminated union, so a new one is
 * a compile error at every `switch` that forgot it.
 */

import type { NodeImage } from './nodeImage'
import type { PsdPlan } from '../io/psd/plan'
import type { PsdOpened } from './psdHost'
import type { ConvertSpace } from './convertHost'
import type { Intent } from '../color/cms'
import type { DocLook } from '../color/proof'
import type { TileFormat } from '../tiles/format'
import type { StoreStats } from '../tiles/store'
import type { DisplayProfileId } from '../color/profiles'
import type { ColourMode, Depth, DocNode, NodeId, ProfileRef } from '../doc/types'
import type { SceneUpdate } from '../render/scene'
import type { View } from '../render/view'
import type { ImportInto } from './imageHost'
import type { WebOptions } from '../io/webOptions'
import type { StrokeStart } from '../render/strokes'
import type { PenSample } from '../brush/stroke'
import type { SelectCalls } from './selectHost'
import type { ClipCalls } from './clipHost'
import type { FillCalls } from './fillHost'
import type { ChannelCalls } from './channelHost'
import type { SelectImageCalls } from './selectImageHost'
import type { Overlay } from '../render/overlay'

/** RGB in 0..1, already linear or not as the field says. */
export type Rgb = [number, number, number]

export type ToEngine =
  /**
   * The first message, and the only one that transfers anything. The canvas
   * arrives with the size it should be drawn at, in device pixels, so the
   * first frame is already sharp.
   */
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number; dpr: number }
  /**
   * The canvas's size in device pixels changed (a resize, a zoom, a move to
   * another screen), with the device pixel ratio, which sets how big 100%
   * is and how big a checkerboard square is.
   */
  | { type: 'resize'; width: number; height: number; dpr: number }
  /**
   * The colours the engine paints with that belong to the theme. Sent at
   * start-up and on every theme change, read from the stylesheet so the
   * palette stays in theme.css and nowhere else.
   */
  | { type: 'theme'; pasteboard: Rgb }
  /**
   * A document's nodes and fields, as far as they changed since the last
   * scene for it (EngineHost works out which). An embedded profile's bytes
   * come along the first time, since the engine converts colours itself.
   */
  | { type: 'scene'; key: string; update: SceneUpdate; profile: { hash: string; bytes: Uint8Array } | null }
  /** Where a document sits in the canvas. The page owns the view; the engine draws through it. */
  | { type: 'view'; key: string; view: View }
  /** Split view: a document's second pane and where the canvas is cut (a share of its width); `second` null for one pane. */
  | { type: 'split'; key: string; second: View | null; split: number }
  /** Which document is in front, or none. */
  | { type: 'front'; key: string | null }
  /** A document closed: everything the engine kept for it can go. */
  | { type: 'close'; key: string }
  /** The display's profile, from Colour Settings. */
  | { type: 'display'; profile: DisplayProfileId }
  /** How a document is looked at: proofing, the gamut warning, separations (color/proof.ts), with a proof profile's bytes when it isn't built in. */
  | { type: 'look'; key: string; look: DocLook; profile: { hash: string; bytes: Uint8Array } | null }
  /** The shared ring pen samples arrive through (input/penRing.ts), once. */
  | { type: 'pen'; ring: SharedArrayBuffer }
  /** Image brush tips and patterns a stroke will use, sent once each before it: 8-bit grey (app/brushAssets.ts). */
  | { type: 'brush.assets'; tips: BrushImage[]; textures: BrushImage[] }
  /** A stroke starts; its samples follow through the ring, or as messages without one. */
  | { type: 'stroke.begin'; start: StrokeStart }
  | { type: 'stroke.samples'; id: number; samples: PenSample[] }
  /** A stroke abandoned: the layer shows as it was. */
  | { type: 'stroke.cancel'; id: number }
  /** What the tools draw over a document: lines, handles, a crop's shade, Quick Mask. */
  | { type: 'overlay'; key: string; overlay: Overlay }
  /** The brush cursor, in document pixels, or null to hide it; with `loops`, the tip's own outline instead of a circle. */
  | { type: 'cursor'; cursor: BrushCursor | null }
  /** A request that wants an answer: see EngineCalls. `id` pairs it with its reply. */
  | ({ type: 'call'; id: number } & CallMessage)
  /** A long job called off by the page (engine/jobs.ts). */
  | { type: 'job.cancel'; job: string }

/** Where the brush is: its centre and diameter in document pixels, and its shape when it isn't a circle. */
export interface BrushCursor {
  key: string
  x: number
  y: number
  size: number
  /** The tip's outline, turned and squashed as the dab is, in document pixels (brush/outline.ts). */
  loops?: [number, number][][] | null
  /** What the pen's pressure paints now, inside the brush's full size: its outline, in document pixels. */
  inner?: [number, number][][] | null
}

/** A brush tip or pattern image, by its content hash. */
export interface BrushImage {
  id: string
  width: number
  height: number
  data: Uint8Array
}

/** What a tile set looks like, for thumbnails: empty, one value throughout, mixed, or not in the store. */
export type SetDescription =
  | { kind: 'empty' }
  | { kind: 'uniform'; value: number[]; tiles: number }
  | { kind: 'mixed'; tiles: number }
  | { kind: 'missing' }

/**
 * The calls the page can make, each with its arguments and its result.
 * The tile store lives in the worker (ARCHITECTURE.md, "The threads"), so
 * everything the page does with pixels is one of these.
 */
export interface EngineCalls extends SelectCalls, ClipCalls, FillCalls, SelectImageCalls, ChannelCalls {
  /** A new set covering a canvas with one value: samples per plane, alpha last. */
  'tiles.fill': { args: { format: TileFormat; width: number; height: number; value: number[] }; result: string }
  'tiles.describe': { args: { ids: string[] }; result: Record<string, SetDescription> }
  /** A set as pack bytes, for a .pxll file. */
  'tiles.pack': { args: { id: string }; result: Uint8Array }
  /** Pack bytes back into the store, under the set's id. */
  'tiles.unpack': { args: { id: string; bytes: Uint8Array }; result: string }
  /** Writes sets to the journal; returns how many new tiles that took. */
  'tiles.journal': { args: { ids: string[] }; result: number }
  'tiles.restore': { args: { ids: string[] }; result: { restored: string[]; missing: string[] } }
  /** Removes journalled sets that no journalled document holds. */
  'tiles.collectJournal': { args: { live: string[] }; result: { sets: number; tiles: number } }
  /** Frees every set not in `live`, and the tiles only they held. */
  'tiles.gc': { args: { live: string[] }; result: { sets: number; tiles: number } }
  'tiles.stats': { args: Record<string, never>; result: StoreStats & { tileSize: number } }
  /**
   * A set read on demand from a file: its pack starts at `start` in `file`
   * (packs are stored uncompressed in a .pxll), and its tiles are read
   * from there when first drawn, not now.
   */
  'tiles.unpackLazy': { args: { id: string; source: string; file: Blob; start: number; length: number }; result: string }
  /** Reads every tile still waiting in the file `source` names, before that file is overwritten. */
  'tiles.materialize': { args: { source: string }; result: number }
  /** Decodes an image into a new set: in its own format, or converted into a document's. */
  /** A node (or with none, the composite) rendered and cropped: sRGB PNG for SVG, the document's own samples for PDF (engine/nodeImage.ts). */
  'render.nodeImage': { args: { key: string; node: NodeId | null; srgb: boolean }; result: NodeImage | null }
  /** A PSD or PSB written from the page's plan (io/psd/plan.ts), pixels read and rendered here. */
  'psd.write': { args: { plan: PsdPlan }; result: Uint8Array }
  /** A Photoshop file (PSD or PSB) opened as a document (engine/psdHost.ts); its tile sets held a minute for the page. */
  'psd.open': { args: { bytes: Uint8Array; name: string; working: Record<ColourMode, ProfileRef>; intent: Intent; bpc: boolean; job?: string }; result: PsdOpened }
  'image.import': {
    args: { bytes: Uint8Array; name: string; into: ImportInto | null }
    result: { set: string; width: number; height: number; mode: ColourMode; depth: Depth; icc: Uint8Array | null; warnings: string[] }
  }
  /** A document's composite as a PNG or JPEG file. */
  'image.optimize': { args: { key: string; o: WebOptions }; result: { bytes: Uint8Array; mime: string; warnings: string[] } }
  'image.export': { args: { key: string; format: 'png' | 'jpeg' | 'webp'; quality: number; lossless?: boolean }; result: { bytes: Uint8Array; mime: string; warnings: string[] } }
  /** Thumbnails of nodes, each fitting `size` pixels, as straight 8-bit RGBA in the display's space; empty data when there's nothing to show. */
  'render.thumbnails': { args: { key: string; nodes: NodeId[]; size: number }; result: Record<NodeId, Thumbnail | null> }
  /** The whole document, small, as an sRGB PNG, for thumbnail.png and preview.png in a .pxll. */
  'render.preview': { args: { key: string; size: number }; result: Uint8Array | null }
  /**
   * Resolves once a frame has been drawn that reflects every message sent
   * before this call, with no tiles left to render: the canvas is up to
   * date. For the checks and the bench, which would otherwise guess.
   */
  'render.idle': { args: Record<string, never>; result: number }
  /** Ends a stroke: bakes it into a new tile set, which the page commits; `overflow` says it grew too big for all of it to be painted. */
  'stroke.end': { args: { id: number }; result: { set: string | null; overflow: boolean } }
  /**
   * The Patch tool: what the selection covers of a layer healed from the
   * pixels `offset` from it (document pixels: the source is where a pixel
   * is plus the offset). Returns the layer's new set.
   */
  'retouch.patch': { args: { key: string; layer: string | null; format: TileFormat; transform: number[]; selection: string; offset: [number, number]; sampleAll: boolean }; result: string | null }
  /** The composite's colour at a document point, averaged over size × size pixels: the document's own values, 0..1, alpha last; null off the canvas. */
  'render.sample': { args: { key: string; x: number; y: number; size: number }; result: number[] | null }
  /** Pixel sets converted to another mode, profile or depth (engine/convertHost.ts): old id to new, each held a minute for the page to commit. */
  'tiles.convert': { args: { sets: string[]; from: ConvertSpace; to: ConvertSpace; intent: Intent; bpc: boolean; profiles: { hash: string; bytes: Uint8Array }[] }; result: Record<string, string> }
  /**
   * What history's past states cost in tiles: for each past state, newest
   * first, the bytes of tiles it holds that no state after it does.
   */
  'tiles.historyCost': { args: { past: string[][]; kept: string[] }; result: number[] }
  /** The renderer's figures, for Graphics Information and the bench. */
  'render.stats': { args: Record<string, never>; result: RenderStats }
  /** Composite storage for 8-bit documents, for the bench's comparison. */
  'render.setStore': { args: { store: 'f16' | 'f32' }; result: 'f16' | 'f32' }
  /** The smallest rectangle holding a set's pixels that aren't transparent, in its own pixels: Free Transform's box. */
  'tiles.alphaBounds': { args: { set: string }; result: [number, number, number, number] | null }
  /** Many sets read at a point each, in one go: a layer's alpha or a mask's coverage (tiles/coverage.ts' valueAt), for picking the layer under the pointer. */
  'tiles.valuesAt': { args: { points: { set: string; x: number; y: number; kind: 'alpha' | 'cover'; outside?: number }[] }; result: number[] }
  /** Rasterize: a pixel layer (or a smart object's contents) through its transform, baked into tiles on the document's grid. */
  'render.rasterize': { args: { key: string; node: NodeId }; result: string | null }
  /** Merge Layers: the layers (painting order) drawn together into a new tile set, held until the page commits it. */
  'render.merge': { args: { key: string; nodes: NodeId[] }; result: string | null }
  /**
   * A pixel layer with effects (filter or adjustment nodes, not in the
   * document) run on it for good, through the selection if there is one:
   * the Filter menu applied, or a layer's live filters baked in.
   */
  'render.bake': { args: { key: string; node: NodeId; effects: DocNode[]; selection: string | null; job?: string }; result: string | null }
  /** The document's histogram, 256 levels a channel in its own terms (CMYK as ink), from the composite at no more than about 4 megapixels. */
  'render.histogram': { args: { key: string }; result: number[][] }
  /** The checks' probes into the GPU, against the CPU references (checks/probe.ts). */
  'test.probe': { args: { kind: string; [k: string]: unknown }; result: unknown }
}

/** A call on the wire: each method with its own arguments, so a message can't pair one with another's. */
export type CallMessage = { [M in keyof EngineCalls]: { method: M; args: EngineCalls[M]['args'] } }[keyof EngineCalls]

export interface Thumbnail {
  width: number
  height: number
  data: Uint8Array
}

export interface RenderStats {
  tileAtlasBytes: number
  tileAtlasUsed: number
  displayAtlasBytes: number
  displayTiles: number
  groupCacheBytes: number
  store8: 'f16' | 'f32'
  tiles: number
  uploads: number
  mips: number
  dispatches: number
}

export type { ProfileRef }

/** What the engine knows about the GPU it was given. */
export interface GpuInfo {
  vendor: string
  architecture: string
  device: string
  description: string
  /** The texture format the canvas was configured with. */
  canvasFormat: GPUTextureFormat
  /** Optional features we asked for and got. */
  features: string[]
  /** The limits the rest of the engine plans around. */
  limits: {
    maxTextureDimension2D: number
    maxTextureArrayLayers: number
    maxBufferSize: number
    maxStorageBufferBindingSize: number
    maxComputeWorkgroupSizeX: number
  }
}

export type FromEngine =
  /** The device is up and the first frame has been drawn. */
  | { type: 'ready'; gpu: GpuInfo }
  /**
   * There is no usable WebGPU: no `navigator.gpu` in the worker, no adapter,
   * or a device request that failed. `reason` is written for the person
   * reading the screen, not for a log.
   */
  | { type: 'unsupported'; reason: string }
  /** The device was lost. `recovering` says whether the engine is asking for a new one. */
  | { type: 'lost'; reason: string; recovering: boolean }
  /**
   * A frame has been presented: how many so far, at what size and zoom,
   * how many tiles it rendered, how many are still to do, and how long it
   * took to build on the CPU.
   */
  | { type: 'frame'; count: number; width: number; height: number; zoom: number | null; rendered: number; pending: number; ms: number; level: number | null }
  /** A stroke couldn't start, and why. */
  | { type: 'stroke.refused'; id: number; reason: string }
  /** How far a long job has got, 0..1, or null when that isn't known (engine/jobs.ts). */
  | { type: 'progress'; job: string; fraction: number | null }
  /** Something went wrong that the page should show, and the engine carried on. */
  | { type: 'error'; message: string }
  /** The answer to a call. */
  | { type: 'reply'; id: number; ok: true; value: unknown }
  /** A call that failed: its error's message, and its name (QuotaExceededError, say), so the page can tell kinds apart. */
  | { type: 'reply'; id: number; ok: false; error: string; name: string }
