/**
 * Every node kind, declared once.
 *
 * The layers panel, the loader, the edits that check what may go where,
 * and (from phase 4) the render graph's evaluators all read this. A new kind
 * is one entry here, plus its evaluator when it can be drawn.
 *
 * `readProps` is how a kind's properties come back from a file: every field
 * read with a default, anything unknown dropped with a warning. A field
 * added to a kind later gets a default here and older files open with it
 * filled in, with no format change.
 */
import {
  BLEND_MODES,
  IDENTITY,
  type BlendModeId,
  type BoolOp,
  type DocNode,
  type KindProps,
  type LockFlags,
  type NodeBase,
  type NodeId,
  type NodeKind,
} from './types'
import { isObject, readBool, readNumber, readOneOf, readParams, readRef, readString, type Warn } from './read'
import { readAppearance, readGeometry, readPaint } from './vector'
import { emptyParagraph, readTextContent } from './text'

export interface NodeDef<K extends NodeKind = NodeKind> {
  kind: K
  /** What the kind is called in menus and messages: "Group", "Pixel Layer". */
  label: string
  /** The name a new node of this kind gets, before a number is added. */
  defaultName: string
  /** Whether it holds children. Children are clipped to it. */
  container: boolean
  /** Which kinds it may hold as children. */
  accepts?: (kind: NodeKind) => boolean
  /**
   * Where a node of this kind may sit: among layers, in another node's
   * `masks`, in its `effects`, or (an adjustment) among layers or in
   * `effects` alike.
   */
  role: 'layer' | 'mask' | 'effect' | 'layer-or-effect'
  defaults(): KindProps[K]
  readProps(raw: unknown, warn: Warn): KindProps[K]
}

const RESAMPLE = ['nearest', 'bilinear', 'bicubic', 'lanczos'] as const
const BOOL_OPS: readonly BoolOp[] = ['add', 'subtract', 'intersect', 'exclude']
const TEXT_MODES = ['point', 'area', 'path'] as const
const MASK_SOURCES = ['pixel', 'vector'] as const
const KNOCKOUTS = ['none', 'shallow', 'deep'] as const

const obj = (raw: unknown) => (isObject(raw) ? raw : {})

/** Layer kinds: what a group may hold. */
const LAYER_KINDS: NodeKind[] = ['group', 'pixel', 'vector', 'boolean', 'text', 'adjustment', 'filter', 'embedded', 'linked', 'fill']

export const NODE_DEFS: { [K in NodeKind]: NodeDef<K> } = {
  group: {
    kind: 'group',
    label: 'Group',
    defaultName: 'Group',
    container: true,
    accepts: (k) => LAYER_KINDS.includes(k),
    role: 'layer',
    defaults: () => ({ knockout: 'none' }),
    readProps: (raw, warn) => ({ knockout: readOneOf(obj(raw).knockout, KNOCKOUTS, 'none', 'a group’s knockout', warn) }),
  },
  pixel: {
    kind: 'pixel',
    label: 'Pixel Layer',
    defaultName: 'Layer',
    // Any node can hold children, clipped to it: a pixel layer with a
    // texture clipped inside it is the classic case.
    container: true,
    accepts: (k) => LAYER_KINDS.includes(k),
    role: 'layer',
    defaults: () => ({ tiles: null, resample: 'bicubic' }),
    readProps: (raw, warn) => {
      const r = obj(raw)
      return {
        tiles: readRef(r.tiles, 'a pixel layer’s tiles', warn),
        resample: readOneOf(r.resample, RESAMPLE, 'bicubic', 'a pixel layer’s resampling', warn),
      }
    },
  },
  vector: {
    kind: 'vector',
    label: 'Shape',
    defaultName: 'Shape',
    container: true,
    accepts: (k) => LAYER_KINDS.includes(k),
    role: 'layer',
    defaults: () => ({ geometry: null, appearance: [], graphicStyle: null }),
    readProps: (raw, warn) => {
      const r = obj(raw)
      return {
        geometry: readGeometry(r.geometry, warn),
        appearance: readAppearance(r.appearance, warn),
        graphicStyle: readRef(r.graphicStyle, 'a shape’s graphic style', warn),
      }
    },
  },
  boolean: {
    kind: 'boolean',
    label: 'Compound Shape',
    defaultName: 'Compound',
    container: true,
    // Only shapes and other compounds can be combined.
    accepts: (k) => k === 'vector' || k === 'boolean',
    role: 'layer',
    defaults: () => ({ ops: {}, appearance: [] }),
    readProps: (raw, warn) => {
      const ops: Record<NodeId, BoolOp> = {}
      const r = obj(raw).ops
      if (isObject(r)) {
        for (const [id, op] of Object.entries(r)) ops[id] = readOneOf(op, BOOL_OPS, 'add', 'a compound shape’s operation', warn)
      }
      const link = obj(raw).graphicStyle
      const live = obj(raw).live
      return {
        ops,
        appearance: readAppearance(obj(raw).appearance, warn),
        ...(typeof link === 'string' && link ? { graphicStyle: link } : {}),
        // A Live Paint group's fills: each a point and a paint.
        ...(isObject(live)
          ? {
              live: {
                fills: (Array.isArray(live.fills) ? live.fills : [])
                  .filter((f): f is Record<string, unknown> => isObject(f) && Array.isArray(f.at) && f.at.length === 2 && f.at.every((x) => typeof x === 'number' && Number.isFinite(x)))
                  .map((f) => ({ at: (f.at as number[]).slice(0, 2) as [number, number], paint: readPaint(f.paint) })),
              },
            }
          : {}),
      }
    },
  },
  text: {
    kind: 'text',
    label: 'Text',
    defaultName: 'Text',
    container: true,
    accepts: (k) => LAYER_KINDS.includes(k),
    role: 'layer',
    defaults: () => ({ mode: 'point', content: { paragraphs: [emptyParagraph()] }, frame: null, pathOffset: 0, appearance: [] }),
    readProps: (raw, warn) => {
      const r = obj(raw)
      return {
        mode: readOneOf(r.mode, TEXT_MODES, 'point', 'a text layer’s kind', warn),
        content: readTextContent(r.content, warn),
        frame: readGeometry(r.frame, warn),
        pathOffset: readNumber(r.pathOffset, 0, -1e7, 1e7, 'path text’s start', warn),
        appearance: readAppearance(r.appearance, warn),
        ...(typeof r.graphicStyle === 'string' && r.graphicStyle ? { graphicStyle: r.graphicStyle } : {}),
      }
    },
  },
  adjustment: {
    kind: 'adjustment',
    label: 'Adjustment',
    defaultName: 'Adjustment',
    container: false,
    // In the tree it adjusts what's below it; in a node's effects, that node alone.
    role: 'layer-or-effect',
    defaults: () => ({ adjustment: '', params: {} }),
    readProps: (raw, warn) => {
      const r = obj(raw)
      return {
        adjustment: readString(r.adjustment, '', 'an adjustment’s kind', warn),
        params: readParams(r.params, 'an adjustment’s settings', warn),
      }
    },
  },
  filter: {
    kind: 'filter',
    label: 'Live Filter',
    defaultName: 'Filter',
    container: false,
    // In a layer's effects, or among the layers, filtering everything below (a filter layer).
    role: 'layer-or-effect',
    defaults: () => ({ filter: '', params: {} }),
    readProps: (raw, warn) => {
      const r = obj(raw)
      return {
        filter: readString(r.filter, '', 'a filter’s kind', warn),
        params: readParams(r.params, 'a filter’s settings', warn),
      }
    },
  },
  embedded: {
    kind: 'embedded',
    label: 'Smart Object',
    defaultName: 'Smart Object',
    container: true,
    accepts: (k) => LAYER_KINDS.includes(k),
    role: 'layer',
    defaults: () => ({ asset: null, content: null }),
    // The contents are a whole document, read by serialize.ts, which knows how.
    readProps: (raw, warn) => ({ asset: readRef(obj(raw).asset, 'an embedded document’s source', warn), content: null }),
  },
  linked: {
    kind: 'linked',
    label: 'Linked File',
    defaultName: 'Linked',
    container: true,
    accepts: (k) => LAYER_KINDS.includes(k),
    role: 'layer',
    defaults: () => ({ asset: null, fileName: '' }),
    readProps: (raw, warn) => {
      const r = obj(raw)
      return {
        asset: readRef(r.asset, 'a linked file’s copy', warn),
        fileName: readString(r.fileName, '', 'a linked file’s name', warn),
      }
    },
  },
  fill: {
    kind: 'fill',
    label: 'Fill Layer',
    defaultName: 'Fill',
    container: true,
    accepts: (k) => LAYER_KINDS.includes(k),
    role: 'layer',
    defaults: () => ({ paint: { kind: 'solid', colour: [0, 0, 0] } }),
    readProps: (raw) => ({ paint: readPaint(obj(raw).paint) }),
  },
  mask: {
    kind: 'mask',
    label: 'Mask',
    defaultName: 'Mask',
    container: false,
    role: 'mask',
    defaults: () => ({ source: 'pixel', tiles: null, geometry: null, density: 1, feather: 0, invert: false, outside: 1 }),
    readProps: (raw, warn) => {
      const r = obj(raw)
      return {
        source: readOneOf(r.source, MASK_SOURCES, 'pixel', 'a mask’s kind', warn),
        tiles: readRef(r.tiles, 'a mask’s tiles', warn),
        geometry: readGeometry(r.geometry, warn),
        density: readNumber(r.density, 1, 0, 1, 'a mask’s density', warn),
        feather: readNumber(r.feather, 0, 0, 1000, 'a mask’s feather', warn),
        invert: readBool(r.invert, false, 'a mask’s invert', warn),
        outside: readNumber(r.outside, 1, 0, 1, 'a mask’s outside', warn),
      }
    },
  },
}

export const NODE_KINDS = Object.keys(NODE_DEFS) as NodeKind[]

/** Whether a kind may sit among layers (a group's children). */
export const isLayerKind = (k: NodeKind) => NODE_DEFS[k].role === 'layer' || NODE_DEFS[k].role === 'layer-or-effect'
/** Whether a kind may sit in a node's effects. */
export const isEffectKind = (k: NodeKind) => NODE_DEFS[k].role === 'effect' || NODE_DEFS[k].role === 'layer-or-effect'

export const nodeDef = <K extends NodeKind>(kind: K): NodeDef<K> => NODE_DEFS[kind] as NodeDef<K>

const NO_LOCKS: LockFlags = { pixels: false, position: false, all: false }

/**
 * A new node of a kind, with every field at its default. The caller gives
 * the id, so edits stay pure and checks stay repeatable.
 */
export function makeNode<K extends NodeKind>(kind: K, id: NodeId, name?: string, props?: Partial<KindProps[K]>): NodeBase<K> {
  const def = nodeDef(kind)
  const node: NodeBase<K> = {
    id,
    kind,
    name: name ?? def.defaultName,
    visible: true,
    locked: { ...NO_LOCKS },
    opacity: 1,
    fillOpacity: 1,
    // Photoshop's default for a new group is pass-through, so a group
    // changes nothing about how its layers blend until asked to.
    blend: kind === 'group' ? 'pass-through' : 'normal',
    blendIf: null,
    transform: [...IDENTITY],
    masks: [],
    effects: [],
    fx: [],
    tag: null,
    props: { ...def.defaults(), ...props },
  }
  if (def.container) node.children = []
  return node
}

/** Whether a blend mode may be used on a node of this kind. */
export const blendAllowed = (kind: NodeKind, blend: BlendModeId) => blend !== 'pass-through' || kind === 'group'

export const isBlendMode = (v: unknown): v is BlendModeId => BLEND_MODES.includes(v as BlendModeId)

export type { DocNode }
