import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AppBoundary } from './ui/ErrorBoundary'
import { applyAppearance, loadAppearance } from './ui/theme'
import { applyPrefs, interfacePrefs } from './ui/interface'
import { installInputGuard } from './input/guard'
import './app.css'
import { engine } from './engine/EngineHost'
import { documents } from './app/documents'
import { views } from './app/views'
import { createDoc, insertNode, setFx } from './doc/edit'
import { makeNode } from './doc/nodes'
import { layoutOf, startFonts } from './app/text'
import { colours } from './app/colours'
import { retouch } from './app/retouch'
import { transformUi } from './app/freeTransform'
import { liquifySettings } from './app/liquify'
import { proofing } from './app/proofing'
import { convertDocument, convertMode } from './app/convert'
import { openFile } from './app/files'
import { brushes } from './app/brushes'
import { importBrushes } from './app/brushImport'
import { tools } from './tools'
import { selectTools } from './app/selectTools'
import { fillTools } from './app/fillTools'
import { guidePrefs } from './app/guidePrefs'
import { origins } from './app/viewAids'
import { moveTool } from './app/moveTool'
import { channels } from './app/channels'
import { widthPointsOf, widthSelection } from './app/widthTool'
import { preloadDialogs } from './ui/lazyDialogs'

// Before the first render, not during it: React would paint one frame in
// the default palette before an effect could repaint it, and a flash of
// the wrong theme on every load is worse than no themes at all.
applyAppearance(loadAppearance())
// The interface's size, density, contrast and motion, for the same reason.
applyPrefs(interfacePrefs().get())

// Keys and the mouse are the app's: the browser's own responses to them
// (find, print, page zoom, back, its context menu...) are cancelled.
installInputGuard()

// A handle for the browser checks and the bench, which probe the engine
// and read the document store directly. Nothing in the app uses it.
// The exporters load when first called, as they do in the app (app/files.ts),
// so the handle doesn't put them back into the app's first download.
const exporters = () => import('./app/exports')
const lazyExports = {
  psdOf: async (...a: Parameters<Awaited<ReturnType<typeof exporters>>['psdOf']>) => (await exporters()).psdOf(...a),
  svgOf: async (...a: Parameters<Awaited<ReturnType<typeof exporters>>['svgOf']>) => (await exporters()).svgOf(...a),
  pdfOf: async (...a: Parameters<Awaited<ReturnType<typeof exporters>>['pdfOf']>) => (await exporters()).pdfOf(...a),
}
;(globalThis as { plexel?: unknown }).plexel = { engine, documents, views, doc: { createDoc, insertNode, makeNode, setFx }, text: { layoutOf, startFonts }, colours, proofing, convert: { convertMode, convertDocument }, files: { openFile }, exports: lazyExports, brushes, importBrushes, tools, selectTools, fillTools, interfacePrefs, guidePrefs, origins, moveTool, retouch, transformUi, liquifySettings, channels, width: { pointsOf: widthPointsOf, selection: widthSelection }, dialogsLoaded: preloadDialogs }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outermost, so that whatever throws, the page still says so instead
        of going blank. */}
    <AppBoundary>
      <App />
    </AppBoundary>
  </StrictMode>,
)
