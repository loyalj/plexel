/**
 * Workspaces of your own: New Workspace names where the panels are now and
 * saves it; Rename and Delete Workspaces looks after the ones you've made;
 * Import Workspace names one read from a file. The rules (names, replacing)
 * are workspace.ts's; these only ask.
 */
import { useState } from 'react'
import { Dialog } from './Dialog'
import { Field, Footer } from './docDialogs'
import { MAX_NAME, nameProblem, replacedBy, workspaceName, type Workspace } from './workspace'
import type { WorkspaceFile } from './workspaceFile'

export function NewWorkspaceDialog({ ws, onSave, onClose }: { ws: Workspace; onSave(name: string): void; onClose(): void }) {
  // Starting from one of your own, its name: saving again under it replaces it.
  const [name, setName] = useState(() => (ws.custom.some((w) => w.id === ws.current) ? workspaceName(ws) : ''))
  const [tried, setTried] = useState(false)
  const problem = nameProblem(ws, name)
  const replaces = problem ? null : replacedBy(ws, name)
  return (
    <Dialog id="newWorkspace" title="New Workspace" onClose={onClose} footer={<Footer form="new-workspace-form" primary={replaces ? 'Replace' : 'Save'} onCancel={onClose} disabled={tried && !!problem} />}>
      <form
        id="new-workspace-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          setTried(true)
          if (!problem) onSave(name)
        }}
      >
        <Field id="new-workspace-name" label="Name" error={tried || name ? problem : null}>
          <input id="new-workspace-name" value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
        </Field>
        <p>
          {replaces
            ? `This replaces your workspace ${replaces.name} with where the panels are now.`
            : 'Saves where the panels are now: which are open, how they’re grouped and docked, their sizes and the floating windows. It goes in Window → Workspace and the switcher, and Reset brings it back as saved.'}
        </p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

export function ManageWorkspacesDialog({ ws, onRename, onDelete, onClose }: { ws: Workspace; onRename(id: string, name: string): void; onDelete(id: string): void; onClose(): void }) {
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(ws.custom.map((w) => [w.id, w.name])))
  const [confirm, setConfirm] = useState<string | null>(null)
  const problems = Object.fromEntries(ws.custom.map((w) => [w.id, nameProblem(ws, names[w.id] ?? w.name, w.id)]))
  const bad = Object.values(problems).some(Boolean)
  return (
    <Dialog id="manageWorkspaces" title="Your Workspaces" onClose={onClose} footer={<Footer form="manage-workspaces-form" primary="Done" onCancel={onClose} disabled={bad} />}>
      <form
        id="manage-workspaces-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (bad) return
          for (const w of ws.custom) if ((names[w.id] ?? w.name) !== w.name) onRename(w.id, names[w.id])
          onClose()
        }}
      >
        {ws.custom.length === 0 && <p>No workspaces of your own are left. Make one with Window → Workspace → New Workspace.</p>}
        <ul className="workspace-list">
          {ws.custom.map((w) => (
            <li key={w.id} data-workspace={w.id}>
              <Field id={`ws-${w.id}`} label={w.id === ws.current ? `${w.name} (in use)` : w.name} error={problems[w.id]}>
                <div className="workspace-row">
                  <input id={`ws-${w.id}`} value={names[w.id] ?? w.name} maxLength={MAX_NAME} onChange={(e) => setNames((n) => ({ ...n, [w.id]: e.target.value }))} aria-label={`Rename ${w.name}`} />
                  {confirm === w.id ? (
                    <button
                      type="button"
                      className="button danger"
                      data-delete-confirm
                      onClick={(e) => {
                        // The row goes with it: the focus goes to Done, so Esc and Enter still reach the dialog.
                        e.currentTarget.closest('.dialog')?.querySelector<HTMLButtonElement>('.dialog-foot .primary')?.focus()
                        setConfirm(null)
                        onDelete(w.id)
                      }}
                    >
                      Delete {w.name}
                    </button>
                  ) : (
                    <button type="button" className="button" data-delete onClick={() => setConfirm(w.id)}>
                      Delete…
                    </button>
                  )}
                </div>
              </Field>
            </li>
          ))}
        </ul>
        <p>Deleting the workspace in use changes to Essentials. Plexel’s own workspaces can’t be renamed or deleted, only reset.</p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

/**
 * A workspace read from a file, to add as one of yours: its name (one of
 * yours by the same name is replaced, as with New Workspace) and, when the
 * file has them, whether to use its keyboard shortcuts in place of yours.
 */
export function ImportWorkspaceDialog({ ws, file, ownKeys, onImport, onClose }: { ws: Workspace; file: WorkspaceFile; ownKeys: number; onImport(name: string, keys: boolean): void; onClose(): void }) {
  const [name, setName] = useState(file.name)
  const [keys, setKeys] = useState(!!file.keys && ownKeys === 0)
  const [tried, setTried] = useState(false)
  const problem = nameProblem(ws, name)
  const replaces = problem ? null : replacedBy(ws, name)
  const count = file.keys ? Object.keys(file.keys).length : 0
  return (
    <Dialog id="importWorkspace" title="Import Workspace" onClose={onClose} footer={<Footer form="import-workspace-form" primary={replaces ? 'Replace' : 'Import'} onCancel={onClose} disabled={tried && !!problem} />}>
      <form
        id="import-workspace-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          setTried(true)
          if (!problem) onImport(name, keys)
        }}
      >
        <Field id="import-workspace-name" label="Name" error={problem}>
          <input id="import-workspace-name" value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
        </Field>
        {file.keys && (
          <label className="check">
            <input type="checkbox" checked={keys} onChange={(e) => setKeys(e.target.checked)} data-import-keys />
            <span>
              Use its keyboard shortcuts ({count} {count === 1 ? 'command' : 'commands'} changed){ownKeys ? `, in place of yours (${ownKeys} changed)` : ''}
            </span>
          </label>
        )}
        <p>{replaces ? `This replaces your workspace ${replaces.name}.` : 'It goes in Window → Workspace and the switcher as one of yours, and Plexel changes to it.'}</p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
