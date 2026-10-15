/**
 * A vector node's shape, wherever it's asked for: the engine drawing it,
 * the page hit testing it, drawing its outline on the canvas, or expanding
 * a compound shape. A shape is a path in the node's own coordinates and
 * the transform that places it; a compound shape's path is its operands
 * combined (geom/boolean.ts), worked out in document pixels, so its own
 * transform is the identity.
 *
 * Hidden operands take no part: hiding one is how to see the compound
 * without it.
 */
import { IDENTITY, type DocNode, type NodeId } from '../doc/types'
import { fillItem, geometryPath, type AppearanceItem } from '../doc/vector'
import { divide, regionAt } from '../geom/regions'
import { booleanPaths } from '../geom/boolean'
import { EMPTY_PATH as EMPTY, pathBounds, transformPath, unionBox, type Box, type Mat, type PathData } from '../geom/path'
import { appearanceReach, longestLine, needsLength } from './outline'

export type Lookup = (id: NodeId) => DocNode | undefined

import { glyphsBounds, glyphsToPath, type Outline } from '../geom/glyphs'
import { hasPathEffects, itemBounds, pixelReach } from './itemEffects'

export interface VectorShape {
  /** A path, or (text) its glyphs. */
  path: Outline
  transform: Mat
  appearance: AppearanceItem[]
}

/** Remembers compound results by a version the caller gives (the scene's content version, or the node objects). */
export type BoolCache = Map<string, { version: string; path: PathData }>

/** A compound shape's operands, bottom first, each in document pixels. */
export function operandsOf(get: Lookup, n: DocNode, cache?: BoolCache, versionOf?: (id: NodeId) => string) {
  if (n.kind !== 'boolean') return []
  const out: { path: PathData; op: 'add' | 'subtract' | 'intersect' | 'exclude' }[] = []
  for (const id of n.children ?? []) {
    const c = get(id)
    if (!c || !c.visible) continue
    const path = docPathOf(get, c, cache, versionOf)
    // A Live Paint group's paths aren't combined: their union is its outline.
    if (path) out.push({ path, op: out.length && !n.props.live ? (n.props.ops[id] ?? 'add') : 'add' })
  }
  return out
}

/** A vector's or compound's path in document pixels; null for anything else. */
export function docPathOf(get: Lookup, n: DocNode, cache?: BoolCache, versionOf?: (id: NodeId) => string): PathData | null {
  if (n.kind === 'vector') return n.props.geometry ? transformPath(geometryPath(n.props.geometry), n.transform) : null
  if (n.kind !== 'boolean') return null
  const key = n.id
  const version = versionOf?.(n.id)
  const hit = cache?.get(key)
  if (hit && version !== undefined && hit.version === version) return hit.path
  const path = booleanPaths(operandsOf(get, n, cache, versionOf))
  if (cache && version !== undefined) {
    cache.set(key, { version, path })
    // A few hundred compounds is plenty; the oldest go first.
    if (cache.size > 256) cache.delete(cache.keys().next().value!)
  }
  return path
}

/** What a vector or compound node draws: its path, the transform placing it, and its appearance. */
export function shapeOf(get: Lookup, n: DocNode, cache?: BoolCache, versionOf?: (id: NodeId) => string): VectorShape | null {
  // Text: the glyphs the page laid out and attached.
  if (n.kind === 'text') return n.props.layout ? { path: n.props.layout, transform: n.transform, appearance: n.props.appearance } : null
  if (n.kind === 'vector') return n.props.geometry ? { path: geometryPath(n.props.geometry), transform: n.transform, appearance: n.props.appearance } : null
  if (n.kind === 'boolean') {
    const path = docPathOf(get, n, cache, versionOf)
    return path ? { path, transform: IDENTITY, appearance: n.props.appearance } : null
  }
  return null
}

/**
 * Where a vector or compound can draw, in document pixels, without working
 * out a compound: its geometry's box (a compound's operands' together, which
 * the result can't leave), grown by how far its strokes reach.
 */
export function vectorBounds(get: Lookup, n: DocNode): Box | null {
  if (n.kind === 'vector' || n.kind === 'text') {
    const items = n.props.appearance
    const r = appearanceReach(items, needsLength(items) ? longestLine(n.kind === 'text' ? (n.props.layout ? glyphsToPath(n.props.layout) : EMPTY) : geometryPath(n.props.geometry)) : 0)
    let b = n.kind === 'text' ? (n.props.layout ? glyphsBounds(n.props.layout) : null) : n.props.geometry ? pathBounds(geometryPath(n.props.geometry)) : null
    if (!b) return null
    // Path effects on a fill or stroke can take it past the shape (moved, offset, roughened).
    if (n.props.appearance.some((it) => hasPathEffects(it.effects))) {
      const path = n.kind === 'text' ? glyphsToPath(n.props.layout!) : geometryPath(n.props.geometry)
      for (const it of n.props.appearance) if (it.enabled && hasPathEffects(it.effects)) b = unionBox(b, itemBounds(path, it.effects, 'rgb', 0.25))
    }
    const grown: Box = [b![0] - r, b![1] - r, b![2] + r, b![3] + r]
    const pts = [
      [grown[0], grown[1]],
      [grown[2], grown[1]],
      [grown[0], grown[3]],
      [grown[2], grown[3]],
    ].map(([x, y]) => [n.transform[0] * x + n.transform[2] * y + n.transform[4], n.transform[1] * x + n.transform[3] * y + n.transform[5]])
    // And pixel effects (a blur, a shadow) as far as they read.
    const px = Math.max(0, ...n.props.appearance.map((it) => (it.enabled ? pixelReach(it.effects, 'rgb') : 0)))
    return [Math.min(...pts.map((p) => p[0])) - px, Math.min(...pts.map((p) => p[1])) - px, Math.max(...pts.map((p) => p[0])) + px, Math.max(...pts.map((p) => p[1])) + px]
  }
  if (n.kind === 'boolean') {
    let b: Box | null = null
    for (const id of n.children ?? []) {
      const c = get(id)
      if (!c || !c.visible) continue
      b = unionBox(b, geometryBox(get, c))
    }
    if (!b) return null
    const items = n.props.appearance
    if (items.some((it) => hasPathEffects(it.effects))) {
      const path = docPathOf(get, n)
      if (path) for (const it of items) if (it.enabled && hasPathEffects(it.effects)) b = unionBox(b, itemBounds(path, it.effects, 'rgb', 0.25))
    }
    const longest = needsLength(items) ? longestLine(docPathOf(get, n) ?? EMPTY) : 0
    const r = appearanceReach(items, longest) + Math.max(0, ...items.map((it) => (it.enabled ? pixelReach(it.effects, 'rgb') : 0)))
    return [b![0] - r, b![1] - r, b![2] + r, b![3] + r]
  }
  return null
}

/** A vector's or compound's geometry alone, in document pixels: no strokes. */
function geometryBox(get: Lookup, n: DocNode): Box | null {
  if (n.kind === 'vector') return n.props.geometry ? pathBounds(geometryPath(n.props.geometry), n.transform) : null
  if (n.kind === 'boolean') {
    let b: Box | null = null
    for (const id of n.children ?? []) {
      const c = get(id)
      if (c?.visible) b = unionBox(b, geometryBox(get, c))
    }
    return b
  }
  return null
}

const liveCache = new Map<string, { version: string; regions: ReturnType<typeof divide> }>()

/**
 * A Live Paint group's parts, each a path in document pixels with an
 * appearance: its filled regions (the region holding each fill's point,
 * through the group's transform), then its paths' strokes over them.
 */
export function livePaintParts(get: Lookup, n: DocNode, cache?: BoolCache, versionOf?: (id: NodeId) => string): { path: PathData; appearance: AppearanceItem[] }[] {
  if (n.kind !== 'boolean' || !n.props.live) return []
  const kids = (n.children ?? []).map((id) => get(id)).filter((c): c is DocNode => !!c && c.visible && (c.kind === 'vector' || c.kind === 'boolean'))
  const paths = kids.map((c) => docPathOf(get, c, cache, versionOf) ?? { subpaths: [], fillRule: 'nonzero' as const })
  const version = versionOf?.(n.id)
  let hit = liveCache.get(n.id)
  if (!hit || version === undefined || hit.version !== version) {
    hit = { version: version ?? '', regions: divide(paths) }
    if (version !== undefined) liveCache.set(n.id, hit)
    if (liveCache.size > 64) liveCache.delete(liveCache.keys().next().value!)
  }
  const t = n.transform
  const parts: { path: PathData; appearance: AppearanceItem[] }[] = []
  for (const f of n.props.live.fills) {
    const q: [number, number] = [t[0] * f.at[0] + t[2] * f.at[1] + t[4], t[1] * f.at[0] + t[3] * f.at[1] + t[5]]
    const i = regionAt(hit.regions, q)
    if (i >= 0) parts.push({ path: hit.regions[i].path, appearance: [fillItem(f.paint)] })
  }
  kids.forEach((c, i) => {
    const strokes = (c.kind === 'vector' || c.kind === 'boolean' ? c.props.appearance : []).filter((it) => it.kind === 'stroke' && it.enabled)
    if (strokes.length) parts.push({ path: paths[i], appearance: strokes })
  })
  return parts
}
