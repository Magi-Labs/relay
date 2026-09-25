import { RepositoryManager } from './repository-manager'
import { AgentIdentities } from './agent-icon'
import { useNavigation } from './navigation-state'
import { Feedback } from './action-menu'
import { InteractionContext, useWorkspaceActions } from './workspace-actions'
import { WorkspaceContent } from './workspace-content'
import type { OpenFile } from './editor'
import { useFileTabs } from './file-tabs'
import { ResizableSidebar, usePanels, WorkspaceHeader } from './panels'
import { closeActiveTab } from './close-active-tab'
import { useWorkspaceShortcuts } from './shortcuts'
import { TerminalTabs } from './terminal-tabs'
import { WorkspaceSidebar } from './sidebar'
import { StatusBar } from './status-bar'
import { useHostSections, visibleSections } from './host-sections'
import { useWorkspaceTelemetry } from './workspace-telemetry'
import { useCallback, useEffect, useState, useRef, useMemo } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Host, Snapshot } from '../../../shared/relay/types'
import { WorkspaceForm, type FormKind } from './forms'
import { RelaySettings, readAppearance } from './settings'
import { Repositories } from './repositories'
export function RelayShell() {
  const panels = usePanels()
  const navigation = useNavigation()
  const { host, workspaceId, terminalId, setTerminalId, validate } = navigation
  const [hosts, setHosts] = useState<Host[]>([])
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({})
  const [hostErrors, setHostErrors] = useState<Record<string, string>>({})
  const snapshot = snapshots[host]
  const snapshotsRef = useRef(snapshots)
  snapshotsRef.current = snapshots

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [form, setForm] = useState<{ kind: FormKind; host?: string }>()
  const [repositoriesOpen, setRepositoriesOpen] = useState(false)
  const [settings, setSettings] = useState(false)
  const [appearance, setAppearance] = useState(readAppearance)
  const [query, setQuery] = useState('')
  const report = useCallback((error: unknown) => setError(String(error)), [])
  const fileTabs = useFileTabs(JSON.stringify([host, workspaceId]), host, workspaceId, report)
  const [requestView, setRequestView] = useState<{
    view: string
    file?: OpenFile
    serial: number
  }>()
  const { file, select: setFile } = fileTabs
  const [busy, setBusy] = useState(false)
  const workspace = snapshot?.workspaces.find((w) => w.id === workspaceId)
  const selectedTerminal = workspace?.terminals.find((t) => t.id === terminalId)
  const terminal = selectedTerminal || workspace?.terminals[0]
  const {
    statuses,
    agents,
    integrations,
    reset: resetTelemetry
  } = useWorkspaceTelemetry(host, workspace, revision, report)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  const names = useMemo(() => ['local', ...hosts.map((h) => h.name)], [hosts])
  const sidebar = useHostSections(names)
  const sections = visibleSections(sidebar.order, snapshots, hostErrors, query)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', appearance.theme === 'dark')
    localStorage.setItem('relay.appearance', JSON.stringify(appearance))
  }, [appearance])
  useEffect(() => {
    let active = true
    setLoading(!Object.keys(snapshotsRef.current).length)
    setError('')
    window.relay
      .request<Snapshot>('local', 'snapshot')
      .then(async (localSnapshot) => {
        const remotes = [
          ...localSnapshot.hosts,
          ...localSnapshot.sessRemotes.filter(
            (h) => !localSnapshot.hosts.some((r) => r.name === h.name)
          )
        ]
        const loaded: Record<string, Snapshot> = { local: localSnapshot }
        const failures: Record<string, string> = {}
        await Promise.all(
          remotes.map((h) =>
            window.relay
              .request<Snapshot>(h.name, 'snapshot')
              .then((result) => {
                loaded[h.name] = result
              })
              .catch((e) => {
                failures[h.name] = String(e)
              })
          )
        )
        if (!active) {
          return
        }
        setHosts(remotes)
        setSnapshots(loaded)
        setHostErrors(failures)
        for (const [name, result] of Object.entries(loaded)) {
          validate(
            name,
            result.workspaces.map((w) => w.id)
          )
        }
        setLoading(false)
      })
      .catch((e) => {
        if (active) {
          setError(String(e))
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [revision, report, validate])

  const openWorkspace = useCallback(
    (targetHost: string, id: string, terminal?: string) => {
      const changed = targetHost !== host || id !== workspaceId
      navigation.select(targetHost, id, terminal)
      if (terminal) {
        fileTabs.deactivate(JSON.stringify([targetHost, id]))
      }
      setRequestView(undefined)
      if (changed) {
        resetTelemetry()
      }
    },
    [host, workspaceId, navigation, fileTabs, resetTelemetry]
  )
  const openForm = useCallback((kind: FormKind, targetHost?: string) => {
    setForm({ kind, host: targetHost })
  }, [])
  const interactions = useWorkspaceActions({
    host,
    workspaceId,
    refresh,
    report,
    form: openForm,
    select: openWorkspace
  })
  const reveal = (file: OpenFile) => {
    setFile(file)
    panels.update('right', { open: true })
    setRequestView({ view: 'files', file, serial: Date.now() })
  }
  const terminalNew = async (axis?: 'columns' | 'rows') => {
    setBusy(true)
    try {
      const result = await window.relay.request<{ id: string }>(
        host,
        axis ? 'terminal_split' : 'terminal_new',
        {
          ...(axis ? { axis, terminal: terminal?.id } : {}),
          workspace: workspaceId
        }
      )
      setTerminalId(result.id)
      setFile(undefined)
      refresh()
    } catch (e) {
      report(e)
    } finally {
      setBusy(false)
    }
  }
  useWorkspaceShortcuts({
    host,
    newWorkspace: () => openForm('workspace'),
    newTerminal: terminalNew,
    split: terminalNew,
    disabled:
      busy || interactions.pending || loading || !!form || settings || interactions.confirming,
    workspaces: (sections.find((s) => s.host === host)?.workspaces || []).map((workspace) => ({
      host,
      workspace
    })),
    workspace,
    terminal,
    selectWorkspace: openWorkspace,
    report,
    selectTerminal: (id) => {
      setTerminalId(id)
      setFile(undefined)
    },
    closeTab: () =>
      closeActiveTab({
        file,
        workspace,
        terminal,
        host,
        snapshot,
        setFile: () => fileTabs.close(),
        setBusy,
        updateSnapshot: (targetHost, next) =>
          setSnapshots((previous) => ({ ...previous, [targetHost]: next })),
        setTerminalId,
        selectWorkspace: openWorkspace
      })
  })
  const formHost = form?.host || host
  const formSnapshot = snapshots[formHost]
  return (
    <AgentIdentities.Provider value={agents}>
      <Feedback.Provider value={report}>
        <InteractionContext.Provider value={interactions.menus}>
          <TooltipProvider>
            <div
              className={`relay-shell bg-background text-foreground ${appearance.compact ? 'relay-compact' : ''}`}
            >
              <WorkspaceHeader host={host} name={workspace?.name} layout={panels} />
              <div className="flex min-h-0 flex-1">
                <ResizableSidebar side="left" layout={panels}>
                  <WorkspaceSidebar
                    refresh={refresh}
                    host={host}
                    sections={sections}
                    collapsed={sidebar.collapsed}
                    reorderHosts={sidebar.reorder}
                    toggleHost={sidebar.toggle}
                    workspaceId={workspaceId}
                    query={query}
                    setQuery={setQuery}
                    selectWorkspace={openWorkspace}
                    setForm={openForm}
                    openRepositories={() => setRepositoriesOpen(true)}
                    openSettings={() => setSettings(true)}
                  />
                </ResizableSidebar>
                <main className="flex min-w-0 flex-1 flex-col">
                  <TerminalTabs
                    host={host}
                    refresh={refresh}
                    workspace={workspace}
                    terminal={terminal}
                    file={file}
                    busy={busy || interactions.pending}
                    setTerminalId={setTerminalId}
                    setFile={setFile}
                    fileTabs={fileTabs}
                    terminalNew={terminalNew}
                    reveal={reveal}
                  />
                  {(busy || interactions.pending) && (
                    <p role="status" className="border-b px-3 py-1 text-xs text-muted-foreground">
                      Updating workspace…
                    </p>
                  )}
                  {error && (
                    <div
                      role="alert"
                      className="flex items-center gap-2 border-b px-4 py-2 text-xs text-destructive"
                    >
                      <span className="flex-1">{error}</span>
                      <Button size="xs" variant="outline" onClick={refresh}>
                        Retry
                      </Button>
                      <Button
                        aria-label="Dismiss error"
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => setError('')}
                      >
                        <X />
                      </Button>
                    </div>
                  )}
                  <WorkspaceContent
                    revision={revision}
                    host={host}
                    workspace={workspace}
                    terminal={terminal}
                    file={file}
                    theme={appearance.theme}
                    fontSize={appearance.fontSize}
                    loading={loading}
                    select={(id) => {
                      // Focus from a fallback/cached view must not overwrite a pending tab selection.
                      if (!terminalId || selectedTerminal) {
                        setTerminalId(id)
                      }
                    }}
                    openFile={setFile}
                    refresh={refresh}
                    terminalNew={terminalNew}
                  />
                </main>
                <ResizableSidebar side="right" layout={panels}>
                  {workspace && (
                    <Repositories
                      key={`${host}:${workspace.id}`}
                      host={host}
                      workspace={workspace}
                      activeFile={file}
                      requestView={requestView}
                      statuses={statuses}
                      openFile={setFile}
                      refresh={refresh}
                      report={report}
                    />
                  )}
                </ResizableSidebar>
              </div>
              <StatusBar
                host={host}
                loading={loading}
                snapshot={snapshot}
                statuses={statuses}
                integrations={integrations}
                workspace={workspace}
                showGit={() => {
                  panels.update('right', { open: true })
                  setRequestView({ view: 'git', serial: Date.now() })
                }}
                attachTicket={() => openForm('ticket')}
              />
              {repositoriesOpen && !form && snapshot && (
                <RepositoryManager
                  key={host}
                  host={host}
                  snapshot={snapshot}
                  close={() => setRepositoriesOpen(false)}
                  add={() => openForm('repo')}
                  select={(id) => openWorkspace(host, id)}
                />
              )}
              {form && formSnapshot && (
                <WorkspaceForm
                  key={form.kind}
                  kind={form.kind}
                  host={formHost}
                  snapshot={formSnapshot}
                  workspace={workspace}
                  close={() => setForm(undefined)}
                  done={(id) => {
                    if (id) {
                      openWorkspace(formHost, id)
                    }
                    refresh()
                  }}
                />
              )}
              {settings && (
                <RelaySettings
                  value={appearance}
                  update={setAppearance}
                  close={() => setSettings(false)}
                />
              )}
              {interactions.dialog}
            </div>
          </TooltipProvider>
        </InteractionContext.Provider>
      </Feedback.Provider>
    </AgentIdentities.Provider>
  )
}
