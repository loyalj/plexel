/**
 * The strip along the bottom: the front document's size, resolution,
 * colour mode and zoom on the left, then the key hints for the tool in use
 * (KeyHints); autosave and the engine on the right.
 */
import type { AutosaveStatus } from '../app/autosave'
import type { Doc } from '../doc/types'
import type { EngineState, EngineStatus } from '../engine/EngineHost'
import { KeyHints } from './KeyHints'

const STATUS_WORDS: Record<EngineStatus, string> = {
  idle: 'Not started',
  starting: 'Starting the GPU',
  ready: 'GPU ready',
  unsupported: 'No WebGPU',
  lost: 'GPU lost',
}

const MODE_NAMES = { rgb: 'RGB', gray: 'Gray', cmyk: 'CMYK' }

export function StatusBar({ state, doc, zoom, rotation, autosave }: { state: EngineState; doc: Doc | null; zoom: number | null; rotation: number; autosave: AutosaveStatus }) {
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
  return (
    <footer className="statusbar">
      {doc ? (
        <span data-status="document">
          {doc.width.toLocaleString()} × {doc.height.toLocaleString()} px · {doc.resolution} ppi · {MODE_NAMES[doc.mode]} {doc.depth}-bit
        </span>
      ) : (
        <span className="status-faint">No document</span>
      )}
      {doc && zoom !== null && <span data-status="zoom">{formatZoom(zoom)}</span>}
      {doc && rotation !== 0 && <span data-status="rotation">{Math.round(rotation * 10) / 10}°</span>}
      {doc && state.pending > 0 && (
        <span className="status-faint" data-status="rendering">
          Rendering…
        </span>
      )}
      <KeyHints />
      <span className="statusbar-spacer" />
      {(autosave.state === 'failed' || autosave.state === 'unavailable') && (
        <span className="status-warn" data-status="autosave" title={autosave.reason}>
          Not autosaving
        </span>
      )}
      {!isolated && (
        <span className="status-warn" title="The page isn't cross-origin isolated, so it can't share memory with the engine. Check the COOP and COEP headers.">
          Not isolated
        </span>
      )}
      {state.width > 0 && (
        <span className="status-faint" data-status="canvas">
          {state.width} × {state.height} px
        </span>
      )}
      <span className="status-engine" data-engine-status={state.status} data-frames={state.frames} title={state.gpu?.description || undefined}>
        <span className="status-dot" />
        {STATUS_WORDS[state.status]}
        {state.gpu && <span className="status-faint">{gpuName(state.gpu.vendor, state.gpu.architecture)}</span>}
      </span>
    </footer>
  )
}

/** 100%, 33.3%, 4.17%: three significant figures below 100. */
export const formatZoom = (z: number) => {
  const pct = z * 100
  return `${pct >= 100 ? Math.round(pct) : Number(pct.toPrecision(3))}%`
}

/** "nvidia ampere", "intel gen-12lp": as much as the browser will say, which is often only the vendor. */
const gpuName = (vendor: string, arch: string) => [vendor, arch].filter(Boolean).join(' ') || 'unnamed adapter'
