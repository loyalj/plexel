/**
 * The shell: menu bar, document tabs, canvas, dock and status bar, plus the
 * dialogs and the palette that sit over them.
 *
 * App owns the view state (appearance, workspace, which dialog is open) and
 * builds the CommandContext every command acts through. The documents live
 * in the document store (app/documents.ts), which App reads and every edit
 * goes through. The menus, the palette and the keyboard all run commands by
 * id through the same `run`, so a command behaves the same however it was
 * reached.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Autosave } from './app/autosave'
import { documents, isDirty, newId, selectedIds } from './app/documents'
import { guidePrefs } from './app/guidePrefs'
import { GuideLayoutDialog, GuideSettingsDialog, NewGuideDialog } from './ui/guideDialogs'
import { alignLayers, alignWhy, distributeLayers, distributeWhy, guidesFromShape } from './app/align'
import { clearGuides } from './doc/guides'
import { closeIfClean, exportDoc, newDocument, openDialog as openFileDialog, openFile, openImage, openRecent, placeDialog, placeImage, save, saveAs } from './app/files'
import { COMMANDS, MENUS, adjustmentMenu, commandById, contextMenu, rulerMenu, runtimeCommands, shortcutsOf, type CommandContext, type CommandDef, type DialogId, type ScreenMode } from './commands'
import {
  addGroup,
  clipToBelow,
  insertNode,
  releaseClip,
  moveNode,
  removeNode,
  renameDoc,
  renameNode,
  resizeCanvas,
  setBlend,
  setFillOpacity,
  setKnockout,
  setLocked,
  setVisibleMany,
  setMaskProps,
  setOpacity,
  setProfile,
  setResample,
  setResolution,
  setVisible,
  shiftNode,
  setTiling,
} from './doc/edit'
import { makeNode } from './doc/nodes'
import { colours } from './app/colours'
import * as selection from './app/selection'
import { beginFreeTransform, beginTransformSelection, cropToSelection, nudge, rasterize, sessions, transformBy } from './app/canvasTools'
import { beginLiquify } from './app/liquify'
import * as construct from './app/construct'
import { OffsetPathDialog, SimplifyDialog } from './ui/constructDialogs'
import { BorderDialog, ColourRangeDialog, FeatherDialog, GrowDialog, LoadSelectionDialog, SaveSelectionDialog, SelectMaskDialog } from './ui/selectDialogs'
import { DefinePatternDialog, FillDialog } from './ui/fillDialogs'
import * as fills from './app/fills'
import * as effects from './app/effects'
import * as vectors from './app/vectors'
import './app/toolGestures'
import { selectTools } from './app/selectTools'
import * as clipboard from './app/clipboard'
import * as typing from './app/typing'
import { addFontFiles, loadSystemFonts } from './app/fonts'
import { CharacterPanel, ParagraphPanel } from './ui/TypePanels'
import { SeparationsPanel } from './ui/SeparationsPanel'
import { ChannelsPanel, PatternsPanel } from './ui/ChannelsPanel'
import { GraphicStylesPanel } from './ui/GraphicStylesPanel'
import { AdjustDialog, FilterDialog, LayerStyleDialog } from './ui/effectDialogs'
import { ColourPanel } from './ui/ColourPanel'
import { AssignProfileDialog, ColourSettingsDialog, ConvertProfileDialog, ProofSetupDialog } from './ui/colourDialogs'
import { convertDepth, convertDocument, convertMode } from './app/convert'
import { proofing } from './app/proofing'
import { freshName, placeOf } from './doc/tree'
import { engine } from './engine/EngineHost'
import { matches, parseShortcut } from './input/shortcuts'
import { canSaveInPlace, downloadAs, pickExportFile, writeToHandle } from './io/files'
import { keyChanges, setKeyChanges, subscribeKeys } from './input/keymap'
import { ShortcutsDialog } from './ui/ShortcutsDialog'
import { WORKSPACE_FILE_TYPE, readWorkspaceFile, workspaceFileName, workspaceFileText, type WorkspaceFile } from './ui/workspaceFile'
import { memoryStore } from './io/journal'
import { opfsAvailable, opfsStore, requestPersistence } from './io/opfs'
import { assets } from './io/assets'
import { startCollecting } from './app/pixels'
import { colourEngine } from './app/colour'
import { PXLL_EXTENSION } from './io/pxll'
import { CommandPalette } from './ui/CommandPalette'
import { DocTabs } from './ui/DocTabs'
import { Dock, DropIndicator, FloatingPanels, iconPanel, showIconPanel } from './ui/Dock'
import { activate, inIcons, isOpen, isShown, openPanel, openPanels, togglePanel, type Layout } from './ui/layout'
import { ImportWorkspaceDialog, ManageWorkspacesDialog, NewWorkspaceDialog } from './ui/workspaceDialogs'
import { CanvasSizeDialog, CloseDocDialog, NewDocDialog, RecentDialog, RenameDocDialog, ResolutionDialog } from './ui/docDialogs'
import { AboutDialog, GpuDialog } from './ui/dialogs'
import { HistoryPanel } from './ui/HistoryPanel'
import { LayersPanel } from './ui/LayersPanel'
import { MenuBar } from './ui/MenuBar'
import { Notices } from './ui/Notices'
import { PropertiesPanel } from './ui/PropertiesPanel'
import { StatusBar } from './ui/StatusBar'
import { applyAppearance, loadAppearance, saveAppearance, type Appearance } from './ui/theme'
import { Unsupported } from './ui/Unsupported'
import { Viewport } from './ui/Viewport'
import { WORKSPACES, addWorkspace, deleteWorkspace, isPristine, loadWorkspace, newWorkspace, renameWorkspace, resetWorkspace, saveChanges, saveWorkspace, switchWorkspace, workspaceName, type Workspace } from './ui/workspace'
import { ContextMenu } from './ui/ContextMenu'
import { Tooltips } from './ui/Tooltips'
import { InterfaceDialog } from './ui/InterfaceDialog'
import { interfacePrefs } from './ui/interface'
import { springTools } from './app/springTools'
import { Icon } from './ui/Icon'
import { tilingOf, type NodeId } from './doc/types'
import { notify } from './app/notices'
import { views } from './app/views'
import { colourSettings } from './app/colourSettings'
import { tools } from './tools'
import { Toolbar } from './ui/Toolbar'
import { OptionsBar, stepSize } from './ui/OptionsBar'
import { SwatchesPanel } from './ui/SwatchesPanel'
import { BrushesPanel } from './ui/BrushesPanel'
import { BrushSettingsPanel } from './ui/BrushSettingsPanel'
import { DefineBrushDialog } from './ui/DefineBrushDialog'
import { pickBrushFiles } from './app/brushImport'
import { PenDialog } from './ui/PenDialog'
import { brushes } from './app/brushes'
import { TOOL_BY_ID } from './tools'
import { ExportDialog } from './ui/ExportDialog'
import { isImageName } from './io/raster'
import { hasPageSelection, isTyping } from './input/guard'
import { docPoint } from './render/view'

/**
 * Every command's keys now (your changes included), parsed: again only when
 * the keys or the commands change. check-commands guarantees the registry's
 * all parse and none collide; the keymap keeps yours that way.
 */
const parsedShortcuts = (defs: CommandDef[]) =>
  defs.flatMap((c) =>
    shortcutsOf(c).flatMap((text) => {
      const s = parseShortcut(text)
      return s ? [{ id: c.id, s }] : []
    }),
  )

/** Reads a workspace file chosen from the computer: its contents, or a notice saying why not. */
function pickWorkspaceFile(): Promise<WorkspaceFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      const read = readWorkspaceFile(await file.text(), file.name)
      if ('problem' in read) {
        notify('error', `“${file.name}” couldn’t be imported as a workspace.`, [read.problem])
        return resolve(null)
      }
      resolve(read)
    }
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

/**
 * The page's autosave, made once the journal's owner is known. One tab
 * owns the journal at a time (a Web Lock says which); another tab, or a
 * browser with no private storage, runs against memory, so everything else
 * behaves the same, and says it isn't keeping anything.
 */
let autosave: Autosave = new Autosave(memoryStore(), null, assets(), null)
let restoring: Promise<{ restored: number; problems: string[] }> | null = null

async function claimJournal(): Promise<string | null> {
  if (!opfsAvailable()) return 'This browser has no private storage for the page, so unsaved changes are lost when the tab closes.'
  if (!navigator.locks) return null
  const owned = await new Promise<boolean>((resolve) => {
    void navigator.locks.request('plexel-journal', { ifAvailable: true }, (lock) => {
      resolve(!!lock)
      // Held for as long as the tab lives.
      return lock ? new Promise(() => {}) : undefined
    })
  })
  return owned ? null : 'Plexel is open in another tab, which keeps the autosave. Changes made in this tab aren’t kept when it closes, so save them to files.'
}

async function startAutosave() {
  const unavailable = await claimJournal()
  const pixels = unavailable
    ? null
    : {
        write: (ids: string[]) => engine().call('tiles.journal', { ids }),
        restore: (ids: string[]) => engine().call('tiles.restore', { ids }),
        collect: (live: string[]) => engine().call('tiles.collectJournal', { live }),
      }
  autosave = new Autosave(unavailable ? memoryStore() : opfsStore, pixels, assets(), unavailable)
  return autosave.start()
}

export default function App() {
  const [appearance, setAppearanceState] = useState<Appearance>(loadAppearance)
  const [workspace, setWorkspace] = useState<Workspace>(loadWorkspace)
  /** Changes where the panels are, in the workspace in use. */
  const setLayout = useCallback((f: (l: Layout) => Layout) => setWorkspace((w) => {
    const layout = f(w.layout)
    return layout === w.layout ? w : { ...w, layout }
  }), [])
  const [dialog, setDialog] = useState<DialogId | null>(null)
  /** A workspace read from a file, while Import Workspace asks what to call it. */
  const [importing, setImporting] = useState<WorkspaceFile | null>(null)
  const keys = useSyncExternalStore(subscribeKeys, keyChanges)
  // The last number key typed with a painting tool, so two quick digits make one value.
  const lastDigit = useRef<{ digit: number; flow: boolean; at: number } | null>(null)
  const [palette, setPalette] = useState(false)
  const [closing, setClosing] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)
  const [fullscreen, setFullscreen] = useState(() => !!document.fullscreenElement)
  const [screen, setScreen] = useState<ScreenMode>('standard')
  // Tab hides the bars and panels; Shift+Tab the dock alone.
  const [panelsHidden, setPanelsHidden] = useState(false)
  const [dockHidden, setDockHidden] = useState(false)
  /** A word on entering a screen mode, so the way back is never a mystery. */
  const [modeNote, setModeNote] = useState<string | null>(null)
  /** Whether Full Screen Mode put the browser into full screen, so leaving it takes it out again. */
  const ownFullscreen = useRef(false)
  /** A menu at a point: the canvas's context menu, a ruler's, or the Layers panel's adjustment layers. */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; kind?: 'ruler' | 'adjustment' } | null>(null)
  const closeMenu = useCallback(() => setMenuAt(null), [])
  /** Per document: the layer shown alone by an Alt-click, and how every layer was before. */
  const solos = useRef(new Map<string, { id: NodeId; saved: Map<NodeId, boolean> }>())
  const prefs = useSyncExternalStore(interfacePrefs().subscribe, interfacePrefs().get)
  const aids = useSyncExternalStore(guidePrefs().subscribe, guidePrefs().get)
  const state = useSyncExternalStore(engine().subscribe, engine().getState)
  const docs = useSyncExternalStore(documents().subscribe, documents().getState)
  const clips = useSyncExternalStore(clipboard.subscribeClipboard, clipboard.clipVersion)
  const tool = useSyncExternalStore(tools().subscribe, tools().get)
  // View → Proof Colours and Gamut Warning tick by the front document's look.
  const look = useSyncExternalStore(proofing.subscribe, proofing.active)
  // The autosave is replaced once the journal's owner is known, so the
  // subscription follows `restored`, which changes just after.
  const subscribeSave = useCallback((fn: () => void) => autosave.onStatus(fn), [restored])
  const saveStatus = useSyncExternalStore(subscribeSave, () => autosave.status())
  const active = docs.docs.find((d) => d.key === docs.active) ?? null
  const doc = active?.history.present ?? null

  // --- start-up: what was open last time ---
  useEffect(() => {
    restoring ??= startAutosave()
    startCollecting()
    void colourEngine()
    let live = true
    void restoring.then(({ problems }) => {
      if (!live) return
      setRestored(true)
      if (problems.length) notify('warning', 'Some of what was open last time couldn’t be restored.', problems)
    })
    void requestPersistence()
    return () => {
      live = false
    }
  }, [])

  const setAppearance = useCallback((a: Appearance) => {
    applyAppearance(a)
    saveAppearance(a)
    setAppearanceState(a)
  }, [])

  // The pasteboard is the theme's, but the engine paints it, so it's read
  // from the stylesheet after every change of palette. Reading the computed
  // value keeps theme.css the one place the colour is written.
  useEffect(() => {
    engine().setPasteboard(getComputedStyle(document.documentElement).getPropertyValue('--pasteboard'))
  }, [appearance])

  // The engine draws what it's told: every open document (so switching tabs
  // is instant), which one is in front, and the display's profile.
  useEffect(() => {
    engine().setProfileSource((hash) => assets().get(hash))
    const apply = () => engine().setDisplay(colourSettings.get().display)
    apply()
    return colourSettings.subscribe(apply)
  }, [])
  const sentKeys = useRef(new Set<string>())
  useEffect(() => {
    for (const d of docs.docs) {
      engine().setScene(d.key, d.history.present)
      sentKeys.current.add(d.key)
    }
    for (const k of [...sentKeys.current]) {
      if (docs.docs.some((d) => d.key === k)) continue
      engine().closeDoc(k)
      views().forget(k)
      sentKeys.current.delete(k)
    }
    engine().setFront(docs.active)
  }, [docs])
  // A document gets its view the first time it's in front and the canvas has a size.
  useEffect(() => {
    const ensure = () => docs.active && views().ensure(docs.active)
    ensure()
    return engine().onCanvasSize(ensure)
  }, [docs.active])

  useEffect(() => {
    const dirty = active && isDirty(active)
    document.title = active ? `${active.file?.name ?? active.history.present.name}${dirty ? ' •' : ''} — Plexel` : 'Plexel'
  }, [active])

  useEffect(() => saveWorkspace(workspace), [workspace])

  useEffect(() => {
    if (!modeNote) return
    const t = setTimeout(() => setModeNote(null), 2600)
    return () => clearTimeout(t)
  }, [modeNote])

  useEffect(() => {
    const on = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])

  // Leaving the page asks first only when unsaved work isn't safe in the
  // journal yet. Normally it is, and the next visit reopens it.
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      const unsaved = documents().getState().docs.some(isDirty)
      const st = autosave.status().state
      if (unsaved && (st === 'failed' || st === 'unavailable' || !autosave.settled)) e.preventDefault()
    }
    addEventListener('beforeunload', onLeave)
    return () => removeEventListener('beforeunload', onLeave)
  }, [])

  // Dropping a .pxll anywhere opens it. In Chromium the drop carries a file
  // handle, so the document can be saved back in place. An image dropped on
  // the canvas of an open document becomes a layer there, under the
  // pointer; dropped anywhere else, or with nothing open, it opens as a
  // document of its own.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    const drop = async (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return
      e.preventDefault()
      const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file')
      const canvas = document.querySelector<HTMLCanvasElement>('[data-engine-canvas]')
      const onCanvas = !!canvas && e.target === canvas
      for (const item of items) {
        const file = item.getAsFile()
        if (!file) continue
        if (isImageName(file.name) || file.type.startsWith('image/')) {
          const key = documents().getState().active
          const v = views().get(key)
          if (onCanvas && key && v) {
            const r = canvas!.getBoundingClientRect()
            const c = engine().canvasSize()
            const k = c.width / Math.max(1, r.width)
            const [x, y] = docPoint(v, c, (e.clientX - r.left) * k, (e.clientY - r.top) * k)
            await placeImage(file, { x, y })
          } else await openImage(file)
          continue
        }
        if (!file.name.toLowerCase().endsWith(PXLL_EXTENSION)) {
          notify('warning', `“${file.name}” isn’t something Plexel opens: .pxll documents and PNG, JPEG and TIFF images are.`)
          continue
        }
        const handle = (await (item as DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.()) ?? null
        await openFile(file, handle && handle.kind === 'file' ? (handle as FileSystemFileHandle) : null)
      }
    }
    addEventListener('dragover', over)
    addEventListener('drop', drop)
    return () => {
      removeEventListener('dragover', over)
      removeEventListener('drop', drop)
    }
  }, [])

  const requestClose = useCallback((key: string) => {
    if (closeIfClean(key) === 'dirty') setClosing(key)
  }, [])

  const ctx = useMemo<CommandContext>(() => {
    const store = documents()
    const sel = () => store.active()?.selected ?? null
    const showLayers = () => setLayout((l) => (isOpen(l, 'layers') ? l : openPanel(l, 'layers')))
    return {
      appearance,
      setAppearance,
      panelOpen: (id) => isShown(workspace.layout, id) || (iconPanel() === id && inIcons(workspace.layout, id)),
      togglePanel: (id) => {
        // A panel folded to icons is shown beside its column, or put back.
        if (inIcons(workspace.layout, id)) {
          const showing = iconPanel() === id
          if (!showing) setLayout((l) => activate(l, id))
          showIconPanel(showing ? null : id)
          setPanelsHidden(false)
          setDockHidden(false)
          return
        }
        setLayout((l) => togglePanel(l, id))
        // A panel asked for is shown, wherever Tab or Shift+Tab put them.
        if (!isShown(workspace.layout, id)) {
          setPanelsHidden(false)
          setDockHidden(false)
        }
      },
      resetWorkspace: () => setWorkspace((w) => resetWorkspace(w)),
      workspace: () => workspace.current,
      workspaceName: () => workspaceName(workspace),
      workspacePristine: () => isPristine(workspace),
      customWorkspaces: () => workspace.custom.map((w) => ({ id: w.id, name: w.name })),
      saveWorkspaceChanges: () => setWorkspace((w) => saveChanges(w)),
      exportWorkspace: () => {
        const name = workspaceName(workspace)
        const blob = new Blob([workspaceFileText(name, workspace.layout, keyChanges())], { type: WORKSPACE_FILE_TYPE.mime })
        const fileName = workspaceFileName(name)
        void (async () => {
          try {
            const handle = await pickExportFile(fileName, WORKSPACE_FILE_TYPE)
            if (handle === 'cancelled') return
            if (handle) await writeToHandle(handle, blob)
            else downloadAs(blob, fileName)
            notify('info', `${name} was exported, with ${Object.keys(keyChanges()).length ? 'your keyboard shortcuts' : 'no changed keyboard shortcuts'}.`)
          } catch (e) {
            notify('error', `${name} couldn’t be exported.`, [e instanceof Error ? e.message : String(e)])
          }
        })()
      },
      importWorkspace: () => {
        void pickWorkspaceFile().then((f) => {
          if (!f) return
          setImporting(f)
          setDialog('importWorkspace')
        })
      },
      setWorkspace: (id: string) => {
        setWorkspace((w) => switchWorkspace(w, id))
        setPanelsHidden(false)
        setDockHidden(false)
      },
      screenMode: () => screen,
      setScreenMode: (m) => {
        if (m === screen) return
        setScreen(m)
        // Full Screen Mode starts with the panels away, and fills the screen;
        // leaving it brings them back, and gives the screen back if it took it.
        setPanelsHidden(m === 'full')
        if (m === 'full' && !document.fullscreenElement) {
          ownFullscreen.current = true
          void document.documentElement.requestFullscreen().catch(() => (ownFullscreen.current = false))
        } else if (m !== 'full' && ownFullscreen.current) {
          ownFullscreen.current = false
          if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
        }
        setModeNote(m === 'standard' ? null : m === 'full' ? 'Full Screen Mode: F for the standard screen, Tab for the panels' : 'Full Screen Mode with Menu Bar: F for the next mode')
      },
      panelsHidden: () => panelsHidden,
      dockHidden: () => dockHidden,
      hidePanels: (which) => {
        if (which === 'all') setPanelsHidden((h) => !h)
        else {
          setPanelsHidden(false)
          setDockHidden((h) => !h)
        }
      },
      tabHides: () => prefs.tabHides,
      openDialog: (id) => setDialog(id),
      importBrushes: () => void pickBrushFiles(),
      openPalette: () => setPalette(true),
      fullscreen: () => fullscreen,
      toggleFullscreen: () => {
        if (document.fullscreenElement) void document.exitFullscreen()
        else void document.documentElement.requestFullscreen().catch(() => {})
      },

      hasDoc: () => !!store.active(),
      hasRecent: () => canSaveInPlace(),
      open: () => void openFileDialog(),
      save: () => void save(),
      saveAs: () => void saveAs(),
      close: () => {
        const k = store.getState().active
        if (k) requestClose(k)
      },
      undoLabel: () => {
        const h = store.active()?.history
        return h && h.past.length ? h.label : null
      },
      redoLabel: () => {
        const h = store.active()?.history
        return h && h.future.length ? h.futureLabels[0] : null
      },
      undo: () => store.undo(),
      redo: () => store.redo(),

      selectedLayer: sel,
      selectedKind: () => {
        const d = store.active()
        return d?.selected ? (d.history.present.nodes[d.selected]?.kind ?? null) : null
      },
      newPixelLayer: () => {
        const d = store.active()
        if (!d) return
        const docNow = d.history.present
        const place = d.selected ? placeOf(docNow, d.selected) : null
        const parent = place?.slot === 'children' ? place.parent : docNow.root
        const index = place?.slot === 'children' ? place.index + 1 : (docNow.nodes[docNow.root].children?.length ?? 0)
        const id = newId('n')
        store.commit((x) => insertNode(x, makeNode('pixel', id, freshName(x, 'Layer')), parent, index))
        store.select(id)
        showLayers()
      },
      // Through the selection when there is one, on the mask when it's the target.
      fill: (which) => void selection.fillTarget(which),
      swapColours: () => colours().swap(),
      resetColours: () => colours().reset(),
      newGroup: () => {
        const d = store.active()
        if (!d) return
        const docNow = d.history.present
        // Above the selected layer, in its group; otherwise at the top.
        const place = d.selected ? placeOf(docNow, d.selected) : null
        const parent = place?.slot === 'children' ? place.parent : docNow.root
        const index = place?.slot === 'children' ? place.index + 1 : (docNow.nodes[docNow.root].children?.length ?? 0)
        const id = newId('n')
        store.commit((x) => addGroup(x, id, freshName(x, 'Group'), parent, index))
        store.select(id)
        showLayers()
      },
      deleteLayer: () => {
        // Every layer selected goes, as one step.
        const d = store.active()
        const ids = d ? selectedIds(d) : []
        if (ids.length) store.commit((x) => ids.reduce((y, id) => (y.nodes[id] ? removeNode(y, id) : y), x), ids.length > 1 ? { label: 'Delete Layers' } : {})
      },
      renameLayer: () => {
        const id = sel()
        if (!id) return
        showLayers()
        setRenaming(id)
      },
      shiftLayer: (step) => {
        const id = sel()
        if (id) store.commit((x) => shiftNode(x, id, step))
      },
      canShiftLayer: (step) => {
        const d = store.active()
        const id = d?.selected
        if (!d || !id) return false
        return shiftNode(d.history.present, id, step) !== d.history.present
      },
      toggleLayerVisible: () => {
        const d = store.active()
        const id = d?.selected
        if (d && id) store.commit((x) => setVisible(x, id, !x.nodes[id].visible))
      },

      place: () => void placeDialog(),
      act: (a) => {
        if (a === 'grow' || a === 'similar') return selection.growSimilar(a === 'grow')
        if (a === 'transform-selection') return void beginTransformSelection()
        void fills.newFillLayer(a === 'fill-layer-solid' ? 'solid' : a === 'fill-layer-gradient' ? 'gradient' : 'pattern').then((id) => id && showLayers())
      },
      hasChannels: () => !!active?.history.present.channels?.length,
      canCopy: (merged) => clipboard.canCopy(merged),
      copy: (o) => clipboard.copy(o),
      paste: (how) => void clipboard.paste(how),
      newFromClipboard: () => void clipboard.newFromClipboard(),
      layerVia: (cut) => void clipboard.layerVia(cut),
      duplicateLayer: () => {
        clipboard.duplicateLayer()
        showLayers()
      },
      copyStyle: clipboard.copyStyle,
      pasteStyle: () => void clipboard.pasteStyle(),
      hasStyleClip: clipboard.hasStyleClip,
      zoomIn: () => views().zoomStep(1),
      zoomOut: () => views().zoomStep(-1),
      fitOnScreen: () => views().fit(),
      actualPixels: () => views().actualSize(),
      rotateView: (deg) => views().rotateBy(deg),
      resetRotation: () => views().rotate(0),
      tool: () => tools().get(),
      setTool: (id) => tools().set(id),
      resizeBrush: (dir) => {
        if (tools().get() === 'quick') return selectTools().update('quick', { size: stepSize(selectTools().get().quick.size, dir) })
        const t = TOOL_BY_ID.get(tools().get())?.paints ?? 'brush'
        brushes().update(t, { size: stepSize(brushes().get()[t].size, dir) })
      },
      paints: () => !!TOOL_BY_ID.get(tools().get())?.paints,
      hardenBrush: (dir) => {
        const t = TOOL_BY_ID.get(tools().get())?.paints ?? 'brush'
        const h = brushes().get()[t].hardness
        // Photoshop's steps: 0, 25, 50, 75 and 100%.
        brushes().update(t, { hardness: Math.min(1, Math.max(0, dir > 0 ? Math.floor(h * 4 + 1e-6) / 4 + 0.25 : Math.ceil(h * 4 - 1e-6) / 4 - 0.25)) })
      },
      brushDigit: (digit, flow) => {
        const t = TOOL_BY_ID.get(tools().get())?.paints
        if (!t) return
        const now = performance.now()
        const last = lastDigit.current
        // Two digits typed within a moment are one number (4 then 5 is 45%; 0 then 5 is 5%).
        const pair = !!last && last.flow === flow && now - last.at < 600
        const value = pair ? (last.digit * 10 + digit) / 100 : digit === 0 ? 1 : digit / 10
        lastDigit.current = pair ? null : { digit, flow, at: now }
        const key = flow || (t === 'mixer' || t === 'smudge') ? 'flow' : 'opacity'
        // The Smudge's number keys set its strength, as Photoshop's do.
        if (t === 'smudge' && !flow) brushes().updateSmudge({ strength: Math.max(0.01, value) })
        else brushes().update(t, { [key]: Math.max(0.01, value) })
      },

      hasSelection: () => !!store.active()?.history.present.selection,
      canReselect: () => !!store.active()?.lastSelection,
      selectAll: selection.selectAll,
      deselect: selection.deselect,
      reselect: selection.reselect,
      inverse: selection.inverse,
      quickMask: () => !!store.active()?.quickMask,
      toggleQuickMask: () => void selection.toggleQuickMask(),
      deleteOrClear: () => {
        const d = store.active()
        if (!d) return
        // Direct Selection or the Pen with points selected: those points go.
        if (vectors.deleteSelectedAnchors()) return
        if (d.history.present.selection && selection.pixelTarget(d)) void selection.clearTarget()
        else if (!d.history.present.selection && d.selected) {
          const ids = selectedIds(d)
          store.commit((x) => ids.reduce((y, id) => (y.nodes[id] ? removeNode(y, id) : y), x), ids.length > 1 ? { label: 'Delete Layers' } : {})
        }
      },
      freeTransform: (mode) => void beginFreeTransform(mode),
      liquify: () => void beginLiquify(),
      transform: (kind) => void transformBy(kind),
      session: () => {
        const s = sessions().get()
        return s && s.key === store.getState().active ? s.kind : null
      },
      commitSession: () => sessions().commit(),
      cancelSession: () => sessions().end(true),
      nudge: (dx, dy) => nudge(dx, dy, tools().get()),
      hasMask: () => {
        const d = store.active()
        return !!d && !!selection.maskOf(d, 'pixel')
      },
      maskEnabled: () => {
        const d = store.active()
        return !!d && !!selection.maskOf(d, 'pixel')?.visible
      },
      addMask: (kind) => void selection.addLayerMask(kind),
      deleteMask: () => selection.deleteLayerMask('pixel'),
      applyMask: () => void selection.applyLayerMask(),
      toggleMask: () => selection.toggleMaskEnabled('pixel'),
      invertMask: () => {
        const d = store.active()
        const m = d && selection.maskOf(d, 'pixel')
        if (m) store.commit((x) => setMaskProps(x, m.id, { invert: !m.props.invert }), { key: d.key, label: 'Invert Layer Mask' })
      },
      isClipped: () => {
        const d = store.active()
        if (!d?.selected) return false
        const p = placeOf(d.history.present, d.selected)
        return !!p && p.slot === 'children' && d.history.present.nodes[p.parent].kind !== 'group'
      },
      canClip: () => {
        const d = store.active()
        return !!d?.selected && clipToBelow(d.history.present, d.selected) !== d.history.present
      },
      toggleClip: () => {
        const d = store.active()
        const id = d?.selected
        if (!d || !id) return
        const p = placeOf(d.history.present, id)
        const clipped = !!p && p.slot === 'children' && d.history.present.nodes[p.parent].kind !== 'group'
        store.commit((x) => (clipped ? releaseClip(x, id) : clipToBelow(x, id)), { label: clipped ? 'Release Clipping Mask' : 'Create Clipping Mask' })
      },
      rasterize: () => void rasterize(),
      cropToSelection: () => void cropToSelection(),

      canCombine: () => vectors.canCombine(store.active()),
      combine: (op) => vectors.combineShapes(op),
      shapeCount: () => construct.selectedShapes(store.active()).length,
      isPlainShape: () => {
        const d = store.active()
        const n = d?.selected ? d.history.present.nodes[d.selected] : undefined
        return n?.kind === 'vector' && !!n.props.geometry
      },
      isLivePaint: () => {
        const d = store.active()
        return construct.isLivePaint(d?.selected ? d.history.present.nodes[d.selected] : undefined)
      },
      construct: (kind) => {
        if (kind.startsWith('pf-')) construct.pathfinder(kind.slice(3) as construct.PathfinderOp)
        else if (kind === 'outline-stroke') construct.outlineStroke()
        else if (kind === 'join') construct.joinShape()
        else if (kind === 'smooth') construct.smoothShape()
        else if (kind === 'live-make') construct.makeLivePaint()
        else if (kind === 'live-expand') construct.expandLivePaint()
      },
      isCompound: () => vectors.isCompound(store.active()),
      releaseCompound: vectors.releaseSelectedCompound,
      expandCompound: vectors.expandSelectedCompound,
      isLiveShape: () => vectors.isLiveShape(store.active()),
      convertToPath: vectors.convertSelectedToPath,
      isText: () => {
        const d = store.active()
        return !!d?.selected && d.history.present.nodes[d.selected]?.kind === 'text'
      },
      docMode: () => store.active()?.history.present.mode ?? null,
      docTiling: () => {
        const d = store.active()
        return d ? tilingOf(d.history.present) : null
      },
      setTiling: (t) => {
        store.commit((x) => setTiling(x, t), { label: t === 'off' ? 'Not Tiled' : 'Tiled' })
        // Making it a tile shows the copies, whatever the switch was left at.
        if (t !== 'off' && !guidePrefs().get().tiledView) guidePrefs().toggle('tiledView')
      },
      docDepth: () => store.active()?.history.present.depth ?? null,
      convertMode,
      convertDepth,
      proofColours: () => !!store.active() && look.proof,
      toggleProofColours: () => {
        const d = store.active()
        if (d) proofing.update(d.key, { proof: !proofing.get(d.key).proof })
      },
      gamutWarning: () => !!store.active() && look.gamut,
      toggleGamutWarning: () => {
        const d = store.active()
        if (d) proofing.update(d.key, { gamut: !proofing.get(d.key).gamut })
      },
      isSplit: () => views().isSplit(),
      toggleSplit: () => views().toggleSplit(),
      viewAid: (k) => aids[k],
      toggleViewAid: (k) => guidePrefs().toggle(k),
      snapTo: (k) => aids.snapTo[k],
      toggleSnapTo: (k) => guidePrefs().toggleSnapTo(k),
      units: () => aids.units,
      setUnits: (u) => guidePrefs().update({ units: u }),
      hasGuides: () => !!store.active()?.history.present.guides.length,
      clearGuides: () => store.commit((x) => clearGuides(x), { label: 'Clear Guides' }),
      guidesFromShape: () => void guidesFromShape(),
      alignTo: () => aids.alignTo,
      setAlignTo: (a) => guidePrefs().update({ alignTo: a }),
      alignWhy: () => alignWhy(store.active(), aids.alignTo),
      distributeWhy: () => distributeWhy(store.active(), aids.alignTo),
      align: (op) => void alignLayers(op),
      distribute: (op) => void distributeLayers(op),
      createOutlines: typing.createOutlines,
      addFonts: () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.multiple = true
        input.accept = '.ttf,.otf,.ttc,font/ttf,font/otf'
        input.onchange = () => void addFontFiles([...(input.files ?? [])])
        input.click()
      },
      loadSystemFonts: () => void loadSystemFonts(),
      hasVectorMask: () => {
        const d = store.active()
        return !!d && !!selection.maskOf(d, 'vector')
      },
      vectorMaskEnabled: () => {
        const d = store.active()
        return !!d && !!selection.maskOf(d, 'vector')?.visible
      },
      addVectorMask: vectors.addVectorMaskTo,
      deleteVectorMask: () => selection.deleteLayerMask('vector'),
      toggleVectorMask: () => selection.toggleMaskEnabled('vector'),

      newAdjustment: (id) => {
        effects.newAdjustmentLayer(id)
        showLayers()
      },
      newFilterLayer: (id) => {
        effects.newFilterLayer(id)
        showLayers()
      },
      canFilter: () => {
        const d = store.active()
        const n = d ? effects.filterTarget(d) : null
        return !!n && n.kind !== 'adjustment' && n.kind !== 'group'
      },
      hasLiveFilters: () => {
        const d = store.active()
        const n = d ? effects.filterTarget(d) : null
        return !!n && n.kind === 'pixel' && n.effects.length > 0
      },
      applyLiveFilters: () => void effects.applyLiveFilters(),
      hasStyle: () => {
        const d = store.active()
        return !!d?.selected && (d.history.present.nodes[d.selected]?.fx.length ?? 0) > 0
      },
      clearStyle: effects.clearFx,
      toSmartObject: () => void effects.toSmartObject(),
      editContents: effects.editContents,
    }
    // docs and tool are dependencies so enabled(), the ticks and the menu labels see the latest state.
  }, [appearance, setAppearance, workspace, fullscreen, requestClose, docs, tool, look, clips, screen, panelsHidden, dockHidden, prefs, aids])

  const run = useCallback(
    (id: string) => {
      const def = commandById(id, ctx)
      if (!def || (def.enabled && !def.enabled(ctx))) return
      def.run(ctx)
    },
    [ctx],
  )

  /** Which paste the last Ctrl+V asked for, for the paste event that follows it. */
  const pasteHow = useRef<'paste' | 'in-place' | null>(null)

  // Shortcuts. While a dialog or the palette is open, keys belong to it.
  // In a text field a shortcut needs Ctrl, so typing a letter types it,
  // and Ctrl+Z and Ctrl+A there are the field's own undo and select-all.
  // `keys` is what shortcutsOf reads: a change to your keys parses them again.
  const shortcuts = useMemo(() => parsedShortcuts([...COMMANDS, ...runtimeCommands(ctx)]), [ctx, keys])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog || palette || closing) return
      for (const { id, s } of shortcuts) {
        if (!matches(s, e)) continue
        const def = commandById(id, ctx)
        if (e.repeat && !def?.repeats) return
        const clip = def?.clipboard
        // A field's own clipboard, and text selected on the page, are the browser's.
        if (clip && (isTyping(e.target) || (clip !== 'paste' && hasPageSelection()))) return
        // Paste runs from the paste event that follows, which carries the clipboard.
        if (clip === 'paste') {
          pasteHow.current = id === 'edit.paste-in-place' ? 'in-place' : 'paste'
          return
        }
        if (isTyping(e.target) && (!s.mod || id === 'edit.undo' || id === 'edit.redo' || id === 'select.all')) return
        // Tab is a focused control's (it moves the focus on); from the canvas, or with nothing focused, it's the command's.
        if (def?.focusKey && e.target instanceof HTMLElement && e.target !== document.body && !e.target.closest('.viewport')) return
        // A dropdown takes its own plain keys (Delete, letters to jump), but
        // not Ctrl ones.
        if (e.target instanceof HTMLSelectElement && !s.mod) return
        // A plain key whose command can't run now (Esc, Enter, Delete, the
        // arrows) is left to whatever else wants it: an open menu, a
        // focused control. A Ctrl one is kept from the browser either way.
        if (!s.mod && !s.alt && def?.enabled && !def.enabled(ctx)) return
        // Copy with nothing to copy leaves the key to the browser.
        if (clip && def?.enabled && !def.enabled(ctx)) return
        e.preventDefault()
        // A tool's key held down rather than tapped gives the tool back on release (app/springTools.ts).
        const springy = prefs.springTools && id.startsWith('tool.') && !id.startsWith('tool.next-')
        const before = tools().get()
        run(id)
        if (springy) springTools().press(e.code, before, tools().get())
        return
      }
    }
    const onKeyUp = (e: KeyboardEvent) => springTools().release(e.code)
    const onBlur = () => springTools().blur()
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [run, ctx, dialog, palette, closing, prefs, shortcuts])

  // Paste, from the browser's paste event: Ctrl+V (Ctrl+Shift+V in place) anywhere but a text field.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const how = pasteHow.current ?? 'paste'
      pasteHow.current = null
      if (dialog || palette || closing || isTyping(e.target)) return
      e.preventDefault()
      void clipboard.paste(how, e.clipboardData)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [dialog, palette, closing])

  if (state.status === 'unsupported') return <Unsupported reason={state.reason ?? 'WebGPU is not available.'} />

  const store = documents()
  const closeDialog = () => setDialog(null)
  const anyPanel = openPanels(workspace.layout).length > 0
  const closingDoc = closing ? store.get(closing) : null
  const content = active
    ? {
        layers: (
          <LayersPanel
            doc={active}
            renaming={renaming}
            onRenaming={setRenaming}
            onSelect={(id, mask) => store.select(id, undefined, mask ?? false)}
            onSelectMany={(ids, key) => store.selectMany(ids, key)}
            onToggleEffect={(id) => effects.toggleEffect(id)}
            onStyle={(id) => {
              store.select(id)
              setDialog('layerStyle')
            }}
            onMaskClick={(layer, _mask, how) => {
              const m = active.history.present.nodes[_mask]
              store.select(layer, undefined, m?.kind === 'mask' && m.props.source === 'vector' ? 'vector' : 'pixel')
              if (how === 'toggle') selection.toggleMaskEnabled()
              else selection.selectionFromMask(_mask)
            }}
            onToggleVisible={(id) => store.commit((x) => setVisible(x, id, !x.nodes[id].visible))}
            onSolo={(id) => {
              const docNow = active.history.present
              const was = solos.current.get(active.key)
              if (was && was.id === id) {
                // The second Alt-click: everything as it was before the first.
                solos.current.delete(active.key)
                store.commit((x) => setVisibleMany(x, was.saved), { label: 'Show All Layers' })
                return
              }
              // Every layer outside this one is hidden, but the groups it's in stay shown; its own clipped layers and children stay as they are.
              const ancestors = new Set<NodeId>()
              for (let p = placeOf(docNow, id); p; p = placeOf(docNow, p.parent)) ancestors.add(p.parent)
              const saved = new Map<NodeId, boolean>()
              const next = new Map<NodeId, boolean>()
              const walk = (n: NodeId) => {
                for (const c of docNow.nodes[n]?.children ?? []) {
                  if (!docNow.nodes[c]) continue
                  saved.set(c, docNow.nodes[c].visible)
                  next.set(c, c === id || ancestors.has(c))
                  if (c !== id) walk(c)
                }
              }
              walk(docNow.root)
              solos.current.set(active.key, { id, saved })
              store.commit((x) => setVisibleMany(x, next), { label: 'Show Only This Layer' })
            }}
            onToggleLock={(id) => store.commit((x) => setLocked(x, id, { all: !x.nodes[id].locked.all }))}
            onDuplicate={(id) => {
              store.select(id)
              clipboard.duplicateLayer()
            }}
            onDeleteLayer={(id) => store.commit((x) => removeNode(x, id))}
            onToggleFold={(id) => store.toggleFolded(id)}
            onRename={(id, name) => store.commit((x) => renameNode(x, id, name))}
            onMove={(id, parent, index) => store.commit((x) => moveNode(x, id, parent, index))}
            onNewLayer={() => run('layer.new-pixel')}
            onNewAdjustment={(at) => setMenuAt({ x: at.x, y: at.y, kind: 'adjustment' })}
            onDuplicateSelected={() => run('layer.duplicate')}
            onDelete={() => run('layer.delete')}
          />
        ),
        history: <HistoryPanel doc={active} onJump={(i) => store.jumpTo(i)} />,
        colour: <ColourPanel doc={doc} />,
        swatches: <SwatchesPanel />,
        brushes: <BrushesPanel />,
        'brush-settings': <BrushSettingsPanel />,
        character: <CharacterPanel />,
        paragraph: <ParagraphPanel />,
        separations: <SeparationsPanel />,
        channels: <ChannelsPanel />,
        patterns: <PatternsPanel openDialog={setDialog} />,
        'graphic-styles': <GraphicStylesPanel />,
        properties: (
          <PropertiesPanel
            doc={active}
            onOpacity={(id, o) => store.commit((x) => setOpacity(x, id, o), { coalesce: `opacity:${id}` })}
            onFill={(id, o) => store.commit((x) => setFillOpacity(x, id, o), { coalesce: `fill:${id}` })}
            onBlend={(id, b) => store.commit((x) => setBlend(x, id, b))}
            onVisible={(id, v) => store.commit((x) => setVisible(x, id, v))}
            onLockAll={(id, all) => store.commit((x) => setLocked(x, id, { all }))}
            onLockPosition={(id, position) => store.commit((x) => setLocked(x, id, { position }))}
            onResample={(id, r) => store.commit((x) => setResample(x, id, r))}
            onKnockout={(id, k) => store.commit((x) => setKnockout(x, id, k))}
            onStyle={() => setDialog('layerStyle')}
          />
        ),
      }
    : { colour: <ColourPanel doc={null} />, swatches: <SwatchesPanel />, brushes: <BrushesPanel />, 'brush-settings': <BrushSettingsPanel />, character: <CharacterPanel />, paragraph: <ParagraphPanel />, separations: <SeparationsPanel />, channels: <ChannelsPanel />, patterns: <PatternsPanel openDialog={setDialog} />, 'graphic-styles': <GraphicStylesPanel /> }

  const showDock = anyPanel && !panelsHidden && !dockHidden
  return (
    <div className="app" data-screen-mode={screen} data-panels-hidden={panelsHidden || undefined}>
      {screen !== 'full' && (
        <MenuBar
          menus={MENUS}
          ctx={ctx}
          onRun={run}
          extra={
            <label className="workspace-switch" data-tip="Workspace: the panels for a kind of work. Each keeps how you leave it.">
              <Icon name="ui.workspace" />
              <select aria-label="Workspace" data-workspace-switch value={workspace.current} onChange={(e) => ctx.setWorkspace(e.target.value)}>
                {WORKSPACES.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
                {workspace.custom.length > 0 && (
                  <optgroup label="Your workspaces">
                    {workspace.custom.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
          }
        />
      )}
      {/* The tool's settings across the whole window, as Photoshop's options bar; under it the toolbar at the left edge, the docks, and the tabs over the canvas, all starting level. */}
      {!panelsHidden && <OptionsBar />}
      <div className={`main${showDock ? '' : ' no-dock'}`}>
        {!panelsHidden && <Toolbar />}
        {showDock && <Dock side="left" layout={workspace.layout} content={content} scale={prefs.scale} onLayout={setLayout} />}
        <div className="center">
          {screen === 'standard' && <DocTabs docs={docs.docs} active={docs.active} onActivate={(k) => store.activate(k)} onClose={requestClose} />}
          <div className="stage">
            <Viewport
              state={state}
              hasDoc={!!active || !restored}
              active={!!active}
              canRecent={canSaveInPlace()}
              onNew={() => setDialog('new')}
              onOpen={() => void openFileDialog()}
              onOpenRecent={(r) => void openRecent(r.handleKey, r.name)}
              onContextMenu={(x, y) => setMenuAt({ x, y })}
              onRulerMenu={(x, y) => setMenuAt({ x, y, kind: 'ruler' })}
            >
              <Notices />
              {modeNote && (
                <div className="screen-mode-note" role="status" data-mode-note>
                  {modeNote}
                </div>
              )}
            </Viewport>
          </div>
        </div>
        {showDock && <Dock side="right" layout={workspace.layout} content={content} scale={prefs.scale} onLayout={setLayout} />}
      </div>
      {showDock && <FloatingPanels layout={workspace.layout} content={content} scale={prefs.scale} onLayout={setLayout} />}
      <DropIndicator />
      {screen === 'standard' && <ViewStatus state={state} doc={doc} autosave={saveStatus} />}
      {palette && <CommandPalette ctx={ctx} onRun={run} onClose={() => setPalette(false)} />}
      {menuAt && <ContextMenu items={menuAt.kind === 'ruler' ? rulerMenu() : menuAt.kind === 'adjustment' ? adjustmentMenu() : contextMenu(ctx)} up={menuAt.kind === 'adjustment'} ctx={ctx} x={menuAt.x} y={menuAt.y} onRun={run} onClose={closeMenu} />}
      <Tooltips />
      {dialog === 'interface' && <InterfaceDialog onClose={closeDialog} />}
      {dialog === 'newGuide' && doc && <NewGuideDialog doc={doc} onClose={closeDialog} />}
      {dialog === 'guideLayout' && doc && <GuideLayoutDialog doc={doc} onClose={closeDialog} />}
      {dialog === 'guideSettings' && <GuideSettingsDialog onClose={closeDialog} />}
      {dialog === 'newWorkspace' && (
        <NewWorkspaceDialog
          ws={workspace}
          onClose={closeDialog}
          onSave={(name) => {
            closeDialog()
            setWorkspace((w) => newWorkspace(w, name))
          }}
        />
      )}
      {dialog === 'manageWorkspaces' && (
        <ManageWorkspacesDialog ws={workspace} onClose={closeDialog} onRename={(id, name) => setWorkspace((w) => renameWorkspace(w, id, name))} onDelete={(id) => setWorkspace((w) => deleteWorkspace(w, id))} />
      )}
      {dialog === 'about' && <AboutDialog onClose={closeDialog} />}
      {dialog === 'gpu' && <GpuDialog state={state} onClose={closeDialog} />}
      {dialog === 'shortcuts' && <ShortcutsDialog defs={[...COMMANDS, ...runtimeCommands(ctx)]} changes={keys} onSave={setKeyChanges} onClose={closeDialog} />}
      {dialog === 'importWorkspace' && importing && (
        <ImportWorkspaceDialog
          ws={workspace}
          file={importing}
          ownKeys={Object.keys(keys).length}
          onClose={() => {
            closeDialog()
            setImporting(null)
          }}
          onImport={(name, useKeys) => {
            closeDialog()
            setImporting(null)
            setWorkspace((w) => addWorkspace(w, name, importing.layout))
            if (useKeys && importing.keys) setKeyChanges(importing.keys)
            setPanelsHidden(false)
            setDockHidden(false)
          }}
        />
      )}
      {dialog === 'new' && (
        <NewDocDialog
          onClose={closeDialog}
          onCreate={(o, background) => {
            closeDialog()
            void newDocument(o, background).catch((e) => notify('error', 'The document couldn’t be made.', [String(e)]))
          }}
        />
      )}
      {dialog === 'colourSettings' && <ColourSettingsDialog onClose={closeDialog} />}
      {dialog === 'feather' && <FeatherDialog onClose={closeDialog} />}
      {(dialog === 'expand' || dialog === 'contract') && <GrowDialog kind={dialog} onClose={closeDialog} />}
      {dialog === 'selectMask' && <SelectMaskDialog onClose={closeDialog} />}
      {(dialog === 'border' || dialog === 'smooth') && <BorderDialog kind={dialog} onClose={closeDialog} />}
      {dialog === 'colourRange' && <ColourRangeDialog onClose={closeDialog} />}
      {dialog === 'saveSelection' && active && <SaveSelectionDialog doc={active.history.present} onClose={closeDialog} />}
      {dialog === 'loadSelection' && active && <LoadSelectionDialog doc={active.history.present} onClose={closeDialog} />}
      {dialog === 'fill' && active && <FillDialog doc={active.history.present} onClose={closeDialog} />}
      {dialog === 'definePattern' && active && <DefinePatternDialog doc={active.history.present} onClose={closeDialog} />}
      {dialog?.startsWith('filter:') && active && <FilterDialog doc={active} filter={dialog.slice(7)} onClose={closeDialog} />}
      {dialog?.startsWith('adjust:') && active && <AdjustDialog doc={active} adjustment={dialog.slice(7)} onClose={closeDialog} />}
      {dialog === 'offsetPath' && active && <OffsetPathDialog doc={active} onClose={closeDialog} />}
      {dialog === 'simplify' && active && <SimplifyDialog doc={active} onClose={closeDialog} />}
      {dialog === 'layerStyle' && active?.selected && <LayerStyleDialog doc={active} node={active.selected} onClose={closeDialog} />}
      {dialog === 'pen' && <PenDialog onClose={closeDialog} />}
      {dialog === 'defineBrush' && <DefineBrushDialog onClose={closeDialog} />}
      {dialog === 'export' && doc && (
        <ExportDialog
          doc={doc}
          onClose={closeDialog}
          onExport={(format, quality, o) => {
            closeDialog()
            void exportDoc(format, quality, undefined, o)
          }}
        />
      )}
      {dialog === 'assignProfile' && doc && (
        <AssignProfileDialog
          doc={doc}
          onClose={closeDialog}
          onApply={(ref) => {
            closeDialog()
            store.commit((x) => setProfile(x, ref))
          }}
        />
      )}
      {dialog === 'convertProfile' && doc && (
        <ConvertProfileDialog
          doc={doc}
          onClose={closeDialog}
          onConvert={(to, intent, bpc) => {
            closeDialog()
            void convertDocument({ mode: to.mode, profile: to.profile, depth: doc.depth }, intent, bpc, 'Convert to Profile')
          }}
        />
      )}
      {dialog === 'proofSetup' && doc && (
        <ProofSetupDialog
          setup={proofing.get(store.getState().active).setup}
          onClose={closeDialog}
          onApply={(setup) => {
            closeDialog()
            const key = store.getState().active
            if (key) proofing.update(key, { setup })
          }}
        />
      )}
      {dialog === 'recent' && <RecentDialog onClose={closeDialog} onOpen={(r) => void openRecent(r.handleKey, r.name)} />}
      {dialog === 'canvasSize' && doc && (
        <CanvasSizeDialog
          doc={doc}
          onClose={closeDialog}
          onApply={(w, h, a) => {
            closeDialog()
            store.commit((x) => resizeCanvas(x, w, h, a))
          }}
        />
      )}
      {dialog === 'resolution' && doc && (
        <ResolutionDialog
          doc={doc}
          onClose={closeDialog}
          onApply={(ppi) => {
            closeDialog()
            store.commit((x) => setResolution(x, ppi))
          }}
        />
      )}
      {dialog === 'renameDoc' && doc && (
        <RenameDocDialog
          doc={doc}
          onClose={closeDialog}
          onApply={(name) => {
            closeDialog()
            store.commit((x) => renameDoc(x, name))
          }}
        />
      )}
      {closingDoc && (
        <CloseDocDialog
          name={closingDoc.file?.name ?? closingDoc.history.present.name}
          onClose={() => setClosing(null)}
          onDiscard={() => {
            setClosing(null)
            store.remove(closingDoc.key)
          }}
          onSave={() => {
            const key = closingDoc.key
            setClosing(null)
            void save(key).then((ok) => ok && store.remove(key))
          }}
        />
      )}
    </div>
  )
}

/**
 * The status bar with the front view's zoom and rotation. It follows the
 * view itself, so panning (a new view every frame) redraws the status bar
 * and not the whole app: with hundreds of layers, the Layers panel alone
 * would cost frames.
 */
function ViewStatus(props: Omit<Parameters<typeof StatusBar>[0], 'zoom' | 'rotation'>) {
  const view = useSyncExternalStore(views().subscribe, views().front)
  return <StatusBar {...props} zoom={view?.zoom ?? null} rotation={view?.rotation ?? 0} />
}
