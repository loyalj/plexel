/** The dialogs the Help menu opens. Each is a Dialog with its own body. */
import type { EngineState } from '../engine/EngineHost'
import { useEffect, useState } from 'react'
import { engine } from '../engine/EngineHost'
import type { EngineCalls } from '../engine/protocol'
import { Dialog } from './Dialog'
import pkg from '../../package.json'
import { ICON_CREDIT } from './icons'

export function AboutDialog({ onClose }: { onClose(): void }) {
  return (
    <Dialog id="about" title="About Plexel" onClose={onClose}>
      <p>
        Plexel is a raster and vector image editor that runs in the browser, on the GPU through WebGPU. Nothing is
        installed and nothing leaves this computer: documents are kept in the browser’s own storage, or in files you
        choose.
      </p>
      <dl className="facts">
        <dt>Version</dt>
        <dd>{pkg.version}</dd>
        <dt>Address</dt>
        <dd>plexel.dblpl.us</dd>
        <dt>Icons</dt>
        <dd>
          <a href={ICON_CREDIT.url} target="_blank" rel="noreferrer">
            {ICON_CREDIT.name}
          </a>
          , {ICON_CREDIT.licence} licence
        </dd>
      </dl>
    </Dialog>
  )
}

const bytes = (n: number) =>
  n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GiB` : n >= 2 ** 20 ? `${(n / 2 ** 20).toFixed(0)} MiB` : `${n} B`

export function GpuDialog({ state, onClose }: { state: EngineState; onClose(): void }) {
  const g = state.gpu
  const [tiles, setTiles] = useState<EngineCalls['tiles.stats']['result'] | null>(null)
  const [render, setRender] = useState<EngineCalls['render.stats']['result'] | null>(null)
  useEffect(() => {
    void engine().call('tiles.stats', {}).then(setTiles, () => {})
    void engine().call('render.stats', {}).then(setRender, () => {})
  }, [])
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
  return (
    <Dialog id="gpu" title="Graphics Information" onClose={onClose}>
      {!g && <p>{state.reason ?? 'The engine hasn’t reported a GPU yet.'}</p>}
      {g && (
        <dl className="facts">
          <dt>Vendor</dt>
          <dd>{g.vendor || '—'}</dd>
          <dt>Architecture</dt>
          <dd>{g.architecture || '—'}</dd>
          <dt>Device</dt>
          <dd>{g.device || '—'}</dd>
          <dt>Description</dt>
          <dd>{g.description || '—'}</dd>
          <dt>Canvas format</dt>
          <dd>{g.canvasFormat}</dd>
          <dt>Optional features</dt>
          <dd>{g.features.length ? g.features.join(', ') : 'none'}</dd>
          <dt>Largest texture</dt>
          <dd>
            {g.limits.maxTextureDimension2D} px, {g.limits.maxTextureArrayLayers} layers
          </dd>
          <dt>Largest buffer</dt>
          <dd>{bytes(g.limits.maxBufferSize)}</dd>
          <dt>Largest storage binding</dt>
          <dd>{bytes(g.limits.maxStorageBufferBindingSize)}</dd>
        </dl>
      )}
      <dl className="facts">
        <dt>Canvas</dt>
        <dd>
          {state.width} × {state.height} device pixels at {devicePixelRatio}×
        </dd>
        <dt>Shared memory</dt>
        <dd>{isolated ? 'yes (cross-origin isolated)' : 'no: the page is not cross-origin isolated'}</dd>
      </dl>
      {tiles && (
        <dl className="facts" data-tile-stats>
          <dt>Tile sets</dt>
          <dd data-stat="sets">{tiles.sets}</dd>
          <dt>Tiles</dt>
          <dd data-stat="tiles">
            {tiles.tiles} ({tiles.uniformTiles} uniform, {tiles.dataTiles} with pixels, {tiles.spilledTiles} spilled to disk)
          </dd>
          <dt>Tile memory</dt>
          <dd data-stat="memory">
            {bytes(tiles.residentBytes)} in use of a {bytes(tiles.budget)} budget
          </dd>
        </dl>
      )}
      {render && (
        <dl className="facts" data-render-stats>
          <dt>Tiles on the GPU</dt>
          <dd data-stat="gpu-tiles">
            {render.tileAtlasUsed} in {bytes(render.tileAtlasBytes)} of atlas
          </dd>
          <dt>Display tiles</dt>
          <dd data-stat="display-tiles">
            {render.displayTiles} in {bytes(render.displayAtlasBytes)}
          </dd>
          <dt>Cached groups</dt>
          <dd>{bytes(render.groupCacheBytes)}</dd>
          <dt>8-bit compositing</dt>
          <dd data-stat="store8">{render.store8 === 'f16' ? 'half floats (f16)' : 'floats (f32)'}; 16-bit documents always f32</dd>
        </dl>
      )}
    </Dialog>
  )
}
