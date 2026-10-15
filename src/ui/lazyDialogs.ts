/**
 * The dialogs, loaded when first wanted (React.lazy), not with the app; and
 * preloadDialogs, which fetches them all once the page is idle (App.tsx), so
 * a dialog opens at once even the first time. The checks wait on it too
 * (the test handle, main.tsx), so none of them races a dialog's first load.
 */
import { lazy } from 'react'

export const GuideLayoutDialog = lazy(() => import('./guideDialogs').then((m) => ({ default: m.GuideLayoutDialog })))
export const GuideSettingsDialog = lazy(() => import('./guideDialogs').then((m) => ({ default: m.GuideSettingsDialog })))
export const NewGuideDialog = lazy(() => import('./guideDialogs').then((m) => ({ default: m.NewGuideDialog })))
export const OffsetPathDialog = lazy(() => import('./constructDialogs').then((m) => ({ default: m.OffsetPathDialog })))
export const SimplifyDialog = lazy(() => import('./constructDialogs').then((m) => ({ default: m.SimplifyDialog })))
export const BorderDialog = lazy(() => import('./selectDialogs').then((m) => ({ default: m.BorderDialog })))
export const ColourRangeDialog = lazy(() => import('./selectDialogs').then((m) => ({ default: m.ColourRangeDialog })))
export const FeatherDialog = lazy(() => import('./selectDialogs').then((m) => ({ default: m.FeatherDialog })))
export const GrowDialog = lazy(() => import('./selectDialogs').then((m) => ({ default: m.GrowDialog })))
export const LoadSelectionDialog = lazy(() => import('./selectDialogs').then((m) => ({ default: m.LoadSelectionDialog })))
export const SaveSelectionDialog = lazy(() => import('./selectDialogs').then((m) => ({ default: m.SaveSelectionDialog })))
export const SelectMaskDialog = lazy(() => import('./selectDialogs').then((m) => ({ default: m.SelectMaskDialog })))
export const DefinePatternDialog = lazy(() => import('./fillDialogs').then((m) => ({ default: m.DefinePatternDialog })))
export const FillDialog = lazy(() => import('./fillDialogs').then((m) => ({ default: m.FillDialog })))
export const AdjustDialog = lazy(() => import('./effectDialogs').then((m) => ({ default: m.AdjustDialog })))
export const FilterDialog = lazy(() => import('./effectDialogs').then((m) => ({ default: m.FilterDialog })))
export const LayerStyleDialog = lazy(() => import('./effectDialogs').then((m) => ({ default: m.LayerStyleDialog })))
export const AssignProfileDialog = lazy(() => import('./colourDialogs').then((m) => ({ default: m.AssignProfileDialog })))
export const ColourSettingsDialog = lazy(() => import('./colourDialogs').then((m) => ({ default: m.ColourSettingsDialog })))
export const ConvertProfileDialog = lazy(() => import('./colourDialogs').then((m) => ({ default: m.ConvertProfileDialog })))
export const ProofSetupDialog = lazy(() => import('./colourDialogs').then((m) => ({ default: m.ProofSetupDialog })))
export const ShortcutsDialog = lazy(() => import('./ShortcutsDialog').then((m) => ({ default: m.ShortcutsDialog })))
export const ImportWorkspaceDialog = lazy(() => import('./workspaceDialogs').then((m) => ({ default: m.ImportWorkspaceDialog })))
export const ManageWorkspacesDialog = lazy(() => import('./workspaceDialogs').then((m) => ({ default: m.ManageWorkspacesDialog })))
export const NewWorkspaceDialog = lazy(() => import('./workspaceDialogs').then((m) => ({ default: m.NewWorkspaceDialog })))
export const InterfaceDialog = lazy(() => import('./InterfaceDialog').then((m) => ({ default: m.InterfaceDialog })))
export const ToolbarDialog = lazy(() => import('./ToolbarDialog').then((m) => ({ default: m.ToolbarDialog })))
export const DefineBrushDialog = lazy(() => import('./DefineBrushDialog').then((m) => ({ default: m.DefineBrushDialog })))
export const PenDialog = lazy(() => import('./PenDialog').then((m) => ({ default: m.PenDialog })))
export const NewSpotChannelDialog = lazy(() => import('./channelDialogs').then((m) => ({ default: m.NewSpotChannelDialog })))
export const ChannelOptionsDialog = lazy(() => import('./channelDialogs').then((m) => ({ default: m.ChannelOptionsDialog })))
export const WidthPointDialog = lazy(() => import('./widthDialog').then((m) => ({ default: m.WidthPointDialog })))
export const BrushOptionsDialog = lazy(() => import('./brushOptions').then((m) => ({ default: m.BrushOptionsDialog })))
export const SaveForWebDialog = lazy(() => import('./SaveForWebDialog').then((m) => ({ default: m.SaveForWebDialog })))
export const ImageTraceDialog = lazy(() => import('./ImageTraceDialog').then((m) => ({ default: m.ImageTraceDialog })))
export const ExportDialog = lazy(() => import('./ExportDialog').then((m) => ({ default: m.ExportDialog })))

/**
 * The dialogs' code fetched once the page is idle after starting: out of the
 * first download, but there by the time one is opened, so it opens at once.
 * (Each import is the same module as its lazy component's, fetched once.)
 */
export function preloadDialogs(): Promise<void> {
  return Promise.all(
    [
      () => import('./guideDialogs'),
      () => import('./constructDialogs'),
      () => import('./selectDialogs'),
      () => import('./fillDialogs'),
      () => import('./effectDialogs'),
      () => import('./colourDialogs'),
      () => import('./ShortcutsDialog'),
      () => import('./workspaceDialogs'),
      () => import('./InterfaceDialog'),
      () => import('./ToolbarDialog'),
      () => import('./DefineBrushDialog'),
      () => import('./PenDialog'),
      () => import('./ExportDialog'),
      () => import('./channelDialogs'),
      () => import('./widthDialog'),
      () => import('./brushOptions'),
      () => import('./SaveForWebDialog'),
      () => import('./ImageTraceDialog'),
    ].map((load) => load().catch(() => {})),
  ).then(() => {})
}
