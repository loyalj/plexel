/**
 * The colour engine on the page, started once: the wasm, the profile
 * registry over the page's assets, and a converter for the colour panel
 * and for fills. It loads in the background at start-up; anything that
 * needs it waits for `colourEngine()`.
 */
import wasmUrl from '../color/wasm/pxcms.wasm?url'
import { startCms, type Cms } from '../color/cms'
import { ProfileRegistry } from '../color/profiles'
import { Converter } from '../color/value'
import { assets } from '../io/assets'
import type { Doc } from '../doc/types'
import type { ParamColour } from '../doc/params'
import { colours } from './colours'
import { colourSettings } from './colourSettings'

export interface ColourEngine {
  cms: Cms
  registry: ProfileRegistry
  converter: Converter
}

let engine: Promise<ColourEngine> | null = null
let ready: ColourEngine | null = null

export function colourEngine(): Promise<ColourEngine> {
  engine ??= (async () => {
    const bytes = await (await fetch(wasmUrl)).arrayBuffer()
    const cms = await startCms(bytes)
    const registry = new ProfileRegistry(cms, assets())
    ready = { cms, registry, converter: new Converter(registry) }
    return ready
  })()
  return engine
}

/** The engine if it has finished loading, for code that can draw a placeholder until then. */
export const colourEngineNow = () => ready

/**
 * The foreground (or background) colour in a document's own terms, as
 * parameters and paints hold colours; null until the colour engine is up.
 */
export function swatchIn(doc: Doc, which: 'fg' | 'bg' = 'fg'): ParamColour | null {
  const cms = colourEngineNow()
  if (!cms) return null
  const { intent, blackPointCompensation } = colourSettings.get()
  return cms.converter.convert(colours().get()[which], { space: doc.mode, profile: doc.profile }, intent, blackPointCompensation).c
}
