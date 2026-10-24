/**
 * The Tool Presets panel, as Photoshop's: a tool with its options under a
 * name, chosen in one click (app/toolPresets.ts). Current Tool Only shows
 * the presets of the tool in use; off, every tool's, each named with its
 * tool. New keeps the tool's options as they are; Import reads Photoshop's
 * TPL files.
 */
import { memo, useState, useSyncExternalStore } from 'react'
import { hasToolOptions, pickToolPresetFiles, toolPresets, type ToolPreset } from '../app/toolPresets'
import { TOOL_BY_ID, tools } from '../tools'
import { Icon } from './Icon'

const ONLY_KEY = 'plexel.toolPresets.only'

function readOnly(): boolean {
  try {
    return localStorage.getItem(ONLY_KEY) !== '0'
  } catch {
    return true
  }
}

export const ToolPresetsPanel = memo(function ToolPresetsPanel() {
  const list = useSyncExternalStore(toolPresets().subscribe, toolPresets().get)
  const tool = useSyncExternalStore(tools().subscribe, tools().get)
  const [only, setOnly] = useState(readOnly)
  const [naming, setNaming] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const current = toolPresets().current
  const shown = only ? list.filter((p) => p.tool === tool) : list
  const groups = new Map<string, ToolPreset[]>()
  for (const p of shown) groups.set(p.group ?? '', [...(groups.get(p.group ?? '') ?? []), p])
  const toolName = TOOL_BY_ID.get(tool)?.name ?? 'this tool'
  const canSave = hasToolOptions(tool)
  const row = (p: ToolPreset) => (
    <li key={p.id} className="channel-row tool-preset-row" data-tool-preset={p.id} aria-current={current === p.id || undefined}>
      {renaming === p.id ? (
        <form
          className="brush-save"
          onSubmit={(e) => {
            e.preventDefault()
            const input = (e.currentTarget.elements.namedItem('name') as HTMLInputElement | null)?.value ?? ''
            toolPresets().rename(p.id, input)
            setRenaming(null)
          }}
        >
          <input name="name" aria-label="Preset name" defaultValue={p.name} autoFocus onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)} onBlur={() => setRenaming(null)} />
        </form>
      ) : (
        <button type="button" className="tool-preset" aria-pressed={current === p.id} onClick={() => toolPresets().choose(p.id)} onDoubleClick={() => setRenaming(p.id)} title="Click to use it; double-click to rename it">
          <span className="brush-name">{p.name}</span>
          {!only && <span className="item-meta">{TOOL_BY_ID.get(p.tool)?.name ?? p.tool}</span>}
        </button>
      )}
      <button type="button" className="icon-button" aria-label={`Delete ${p.name}`} onClick={() => toolPresets().remove(p.id)}>
        <Icon name="ui.close" />
      </button>
    </li>
  )
  return (
    <div className="tool-presets" data-panel="tool-presets">
      <label className="check">
        <input
          type="checkbox"
          id="tool-presets-only"
          checked={only}
          onChange={(e) => {
            setOnly(e.target.checked)
            try {
              localStorage.setItem(ONLY_KEY, e.target.checked ? '1' : '0')
            } catch {
              // Remembered for this tab only.
            }
          }}
        />
        Current Tool Only
      </label>
      {shown.length === 0 ? (
        <p className="panel-empty">{only ? `No presets for ${toolName}` : 'No tool presets'}</p>
      ) : (
        <ul className="channel-list" aria-label="Tool presets">
          {[...groups].map(([group, items]) =>
            group ? (
              <li key={`group-${group}`}>
                <div className="brush-group" data-tool-preset-group={group}>
                  {group}
                  <button type="button" className="brush-remove" aria-label={`Remove the ${group} presets`} onClick={() => toolPresets().removeGroup(group)}>
                    <Icon name="ui.close" />
                  </button>
                </div>
                <ul className="channel-list nested">{items.map(row)}</ul>
              </li>
            ) : (
              items.map(row)
            ),
          )}
        </ul>
      )}
      <div className="panel-tools">
        {naming === null ? (
          <>
            <button type="button" className="button small" data-tool-preset-new disabled={!canSave} title={canSave ? undefined : `${toolName} has no options to keep`} onClick={() => setNaming(`${toolName} 1`)}>
              New Tool Preset…
            </button>
            <button type="button" className="button small" data-import-tool-presets onClick={() => void pickToolPresetFiles()}>
              Import…
            </button>
          </>
        ) : (
          <form
            className="brush-save"
            onSubmit={(e) => {
              e.preventDefault()
              toolPresets().save(tool, naming)
              setNaming(null)
            }}
          >
            <input id="tool-preset-name" aria-label="Preset name" value={naming} autoFocus onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} />
            <button type="submit" className="button small primary">
              Save
            </button>
          </form>
        )}
      </div>
    </div>
  )
})
