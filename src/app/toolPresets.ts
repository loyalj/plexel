/**
 * Tool presets, as Photoshop's are: a tool with its options, saved under a
 * name and chosen again in one go (the Tool Presets panel). Each tool that
 * has options says how to take them and how to put them back (`SOURCES`);
 * a preset holds what it took, and choosing it switches to its tool and
 * lays its options over the tool's. App-wide and remembered by the
 * browser, like the brushes. Photoshop's own (TPL files, io/tpl.ts) come
 * in as patches over the tool's options: what Plexel can read of them.
 */
import { readBrush, readMixer, readSmudge } from '../brush/defs'
import { tipId } from '../brush/tips'
import { Listeners } from '../lib/listeners'
import { tools, type ToolId } from '../tools'
import { brushAssets } from './brushAssets'
import { brushes, type PaintTool } from './brushes'
import { fillTools } from './fillTools'
import { freehand } from './freehand'
import { moveTool } from './moveTool'
import { notify } from './notices'
import { retouch } from './retouch'
import { selectTools } from './selectTools'
import { typeSettings } from './typeSettings'
import { shapeTools } from './vectors'

export interface ToolPreset {
  id: string
  name: string
  tool: ToolId
  /** The tool's options as its source took them; a patch, for one from a file. */
  options: Record<string, unknown>
  /** Where it came from: an imported file's name; none for one saved here. */
  group?: string
}

type Opts = Record<string, unknown>

/**
 * Values from a preset laid over the current ones, only where they're the
 * same kind of thing (a number for a number, an object for an object), so
 * a preset saved by an older Plexel, or read from a file, can't put
 * something strange into a tool. Each store reads its own values again
 * when the page loads.
 */
export function overlay<T>(current: T, patch: unknown): T {
  if (patch === undefined) return current
  if (current === null || typeof current !== 'object' || Array.isArray(current)) return typeof patch === typeof current && (typeof patch !== 'number' || Number.isFinite(patch)) ? (patch as T) : current
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return current
  const out = { ...current } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch as Opts)) {
    // A key the tool hasn't got, or whose value is null (no pattern chosen), takes the preset's value as it is if it's plain.
    if (!(k in out)) continue
    out[k] = out[k] === null ? (v === null || typeof v === 'string' ? v : out[k]) : overlay(out[k], v)
  }
  return out as T
}

interface Source {
  take(): Opts
  give(o: Opts): void
}

const paint = (tool: PaintTool): Source => ({
  take: () => {
    const s = brushes().get()
    return {
      brush: s[tool],
      ...(tool === 'mixer' ? { mixer: s.mixerSettings } : {}),
      ...(tool === 'smudge' ? { smudge: s.smudgeSettings } : {}),
      ...(tool === 'clone' || tool === 'heal' ? { source: retouch().get()[tool] } : {}),
    }
  },
  give: (o) => {
    const s = brushes().get()
    if (o.brush) brushes().replace(tool, readBrush(o.brush))
    if (o.mixer && tool === 'mixer') brushes().updateMixer(readMixer(overlay(s.mixerSettings, o.mixer)))
    if (o.smudge && tool === 'smudge') brushes().updateSmudge(readSmudge(overlay(s.smudgeSettings, o.smudge)))
    if (o.source && (tool === 'clone' || tool === 'heal')) retouch().update(tool, overlay(retouch().get()[tool], o.source))
  },
})

const select = <K extends 'marquee' | 'lasso' | 'wand' | 'quick'>(key: K): Source => ({
  take: () => ({ [key]: selectTools().get()[key], op: selectTools().get().op }),
  give: (o) => {
    if (o[key]) selectTools().update(key, overlay(selectTools().get()[key], o[key]) as never)
    if (typeof o.op === 'string') selectTools().update('op', overlay(selectTools().get().op, o.op) as never)
  },
})

const fill = <K extends 'gradient' | 'bucket'>(key: K): Source => ({
  take: () => ({ [key]: fillTools().get()[key] }),
  give: (o) => {
    if (o[key]) fillTools().update(key, overlay(fillTools().get()[key], o[key]))
  },
})

const shape: Source = {
  take: () => ({ shape: shapeTools().get() }),
  give: (o) => {
    if (o.shape) shapeTools().update(overlay(shapeTools().get(), o.shape))
  },
}

const free: Source = {
  take: () => ({ freehand: freehand().get() }),
  give: (o) => {
    if (o.freehand) freehand().update(overlay(freehand().get(), o.freehand))
  },
}

/** Each tool with options of its own, and how to take and give them. */
const SOURCES: Partial<Record<ToolId, Source>> = {
  brush: paint('brush'),
  eraser: paint('eraser'),
  mixer: paint('mixer'),
  smudge: paint('smudge'),
  clone: paint('clone'),
  heal: paint('heal'),
  spot: paint('spot'),
  marquee: select('marquee'),
  lasso: select('lasso'),
  wand: select('wand'),
  quick: select('quick'),
  gradient: fill('gradient'),
  bucket: fill('bucket'),
  shape,
  pen: shape,
  curvature: shape,
  pencil: free,
  vbrush: free,
  blob: free,
  type: {
    take: () => ({ type: typeSettings().get() }),
    give: (o) => {
      const t = o.type as { char?: Opts; para?: Opts } | undefined
      // Character and paragraph settings are partial already: what's given is set.
      if (t && typeof t === 'object') typeSettings().update({ char: t.char && typeof t.char === 'object' ? t.char : {}, para: t.para && typeof t.para === 'object' ? t.para : {} })
    },
  },
  move: {
    take: () => ({ move: moveTool().get() }),
    give: (o) => {
      if (o.move) moveTool().update(overlay(moveTool().get(), o.move))
    },
  },
}

/** Whether a tool has options a preset can keep. */
export const hasToolOptions = (tool: ToolId) => !!SOURCES[tool]

const KEY = 'plexel.toolPresets.v1'

function load(): ToolPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(raw)
      ? raw.filter((p): p is ToolPreset => !!p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.tool === 'string' && !!SOURCES[p.tool as ToolId] && !!p.options && typeof p.options === 'object').map((p) => ({ id: p.id, name: p.name, tool: p.tool, options: p.options, ...(typeof p.group === 'string' ? { group: p.group } : {}) }))
      : []
  } catch {
    return []
  }
}

class ToolPresetStore {
  private list = load()
  private changes = new Listeners()
  /** The preset last chosen, for the panel's highlight, until the tool's options change. */
  current: string | null = null

  get = () => this.list

  subscribe = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }

  private set(next: ToolPreset[]) {
    this.list = next
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // Kept for this tab only.
    }
    this.changes.emit()
  }

  /** New Tool Preset: the tool's options as they are now. Null when the tool has none. */
  save(tool: ToolId, name: string): string | null {
    const src = SOURCES[tool]
    if (!src) return null
    const id = `tp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`
    // A deep copy, so the preset doesn't change with the tool.
    this.set([...this.list, { id, name: name.trim() || 'Tool Preset', tool, options: JSON.parse(JSON.stringify(src.take())) }])
    this.current = id
    return id
  }

  /** Chooses a preset: its tool, with its options. */
  choose(id: string) {
    const p = this.list.find((x) => x.id === id)
    const src = p && SOURCES[p.tool]
    if (!p || !src) return
    tools().set(p.tool)
    src.give(p.options)
    this.current = id
    this.changes.emit()
  }

  rename(id: string, name: string) {
    const n = name.trim()
    if (n) this.set(this.list.map((p) => (p.id === id ? { ...p, name: n } : p)))
  }

  remove(id: string) {
    if (this.current === id) this.current = null
    this.set(this.list.filter((p) => p.id !== id))
  }

  removeGroup(group: string) {
    this.set(this.list.filter((p) => p.group !== group))
  }

  /** Presets from a file, added together under `group`. */
  add(list: { name: string; tool: ToolId; options: Opts }[], group: string) {
    const stamp = Date.now().toString(36)
    this.set([...this.list, ...list.map((p, i) => ({ id: `tp-${stamp}-${i}`, name: p.name, tool: p.tool, options: p.options, group }))])
  }
}

let store: ToolPresetStore | null = null
export const toolPresets = () => (store ??= new ToolPresetStore())

/** Asks for TPL files and imports them (the Tool Presets panel's Import). */
export function pickToolPresetFiles(): Promise<number> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.tpl'
    input.multiple = true
    input.onchange = () => {
      const files = [...(input.files ?? [])]
      if (!files.length) return resolve(0)
      void importToolPresets(files).then(resolve)
    }
    input.click()
  })
}

/** Imports Photoshop's tool presets: the ones for tools Plexel has, grouped by file; their tips and patterns into the brush library. */
export async function importToolPresets(files: File[]): Promise<number> {
  const { readTpl } = await import('../io/tpl')
  let added = 0
  for (const file of files) {
    try {
      const f = readTpl(new Uint8Array(await file.arrayBuffer()))
      // Tips and patterns go into the brush library, named by their pixels; textures follow their patterns' new names.
      const pat = new Map(f.patterns.map((p) => [p.id, `pat:${tipId(p.width, p.height, p.data).slice(4)}`]))
      for (const t of f.tips) await brushAssets().add({ id: t.id, kind: 'tip', name: t.name, width: t.width, height: t.height, data: t.data })
      for (const p of f.patterns) await brushAssets().add({ id: pat.get(p.id)!, kind: 'pattern', name: p.name, width: p.width, height: p.height, data: p.data })
      const list = f.presets.map((p) => {
        const brush = p.options.brush as { texture?: { id: string } | null } | undefined
        const t = brush?.texture
        if (t?.id.startsWith('pat:')) t.id = pat.get(t.id.slice(4)) ?? 'paper'
        return { name: p.name, tool: p.tool, options: p.options }
      })
      toolPresets().add(list, file.name.replace(/\.tpl$/i, ''))
      added += list.length
      if (!list.length) notify('warning', `“${file.name}” has no presets for Plexel’s tools in it.`, f.warnings)
      else if (f.warnings.length) notify('warning', `${list.length} tool preset${list.length === 1 ? '' : 's'} came in from “${file.name}”, with a few things that couldn’t.`, f.warnings)
      else notify('info', `${list.length} tool preset${list.length === 1 ? '' : 's'} came in from “${file.name}”.`)
    } catch (e) {
      notify('error', `“${file.name}” couldn’t be read as Photoshop tool presets.`, [e instanceof Error ? e.message : String(e)])
    }
  }
  return added
}
