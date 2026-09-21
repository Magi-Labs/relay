import { fileKey } from './file-tabs'
import { lazy, Suspense, useEffect, useState } from 'react'
import type { Workspace, Session } from '../../../shared/relay/types'
import type { OpenFile } from './editor'
import { TerminalLayout } from './terminal-layout'
import { Button } from '@/components/ui/button'
import { TerminalSquare } from 'lucide-react'
const FileViewer = lazy(() => import('./editor').then((m) => ({ default: m.FileViewer })))
type Cached = { key: string; host: string; workspace: Workspace; terminal: Session }
function retain(
  cache: Cached[],
  key: string,
  host: string,
  workspace?: Workspace,
  terminal?: Session
) {
  const current = workspace && terminal ? { key, host, workspace, terminal } : undefined
  const valid = cache.filter(
    (c) =>
      !(c.host === host && c.workspace.id === workspace?.id) ||
      workspace.terminals.some((t) => t.id === c.terminal.id)
  )
  const entries = [...valid.filter((c) => c.key !== key), ...(current ? [current] : [])].slice(-3)
  // Bound dormant views by both tab count and total split panes.
  while (
    entries.length > 1 &&
    entries.reduce(
      (n, c) =>
        n +
        c.workspace.terminals.filter(
          (t) => (t.tab_id || t.id) === (c.terminal.tab_id || c.terminal.id)
        ).length,
      0
    ) > 12
  ) {
    entries.shift()
  }
  return entries
}
export function WorkspaceContent({
  revision,
  host,
  workspace,
  terminal,
  file,
  theme,
  fontSize,
  loading,
  select,
  openFile,
  refresh,
  terminalNew
}: {
  revision: number
  host: string
  workspace?: Workspace
  terminal?: Session
  file?: OpenFile
  theme: string
  fontSize: number
  loading: boolean
  select: (id: string) => void
  openFile: (file: OpenFile) => void
  refresh: () => void
  terminalNew: () => Promise<void>
}) {
  const [cache, setCache] = useState<Cached[]>([])
  const key =
    workspace && terminal
      ? JSON.stringify([host, workspace.id, terminal.tab_id || terminal.id])
      : ''
  const entries = retain(cache, key, host, workspace, terminal)
  useEffect(
    () => setCache((previous) => retain(previous, key, host, workspace, terminal)),
    [key, host, workspace, terminal]
  )
  return (
    <div className="relative min-h-0 flex-1">
      {entries.map((c) => (
        <div
          key={c.key}
          data-cached-terminal={c.key}
          aria-hidden={c.key !== key || !!file}
          className={`absolute inset-0 ${c.key !== key || file ? 'invisible pointer-events-none' : ''}`}
        >
          <TerminalLayout
            host={c.host}
            workspace={c.workspace}
            terminal={c.terminal.id}
            visible={c.key === key && !file}
            fontSize={fontSize}
            theme={theme}
            select={select}
            openFile={openFile}
            refresh={refresh}
          />
        </div>
      ))}
      {file && workspace ? (
        <div className="absolute inset-0">
          <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading editor…</p>}>
            <FileViewer
              key={JSON.stringify([host, workspace.id, fileKey(file), file.line, file.column])}
              openFile={openFile}
              revision={revision}
              host={host}
              workspace={workspace.id}
              file={file}
              theme={theme}
            />
          </Suspense>
        </div>
      ) : (
        !terminal && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
            <TerminalSquare className="size-8" />
            <p className="text-sm">
              {loading
                ? 'Connecting to host…'
                : workspace
                  ? 'Start a terminal in this workspace.'
                  : 'Select a workspace to start.'}
            </p>
            {workspace && (
              <Button size="sm" onClick={() => void terminalNew()}>
                New terminal
              </Button>
            )}
          </div>
        )
      )}
    </div>
  )
}
