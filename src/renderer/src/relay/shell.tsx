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
import { useCallback, useEffect, useState, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Host, Snapshot, RepoStatus, Integrations } from '../../../shared/relay/types'
import { WorkspaceForm, type FormKind } from './forms'
import { RelaySettings, readAppearance } from './settings'
import { Repositories } from './repositories'
export function RelayShell() {
  const panels = usePanels()
  const navigation = useNavigation()
  const { host, setHost, workspaceId, setWorkspaceId, terminalId, setTerminalId, validate } =
    navigation
  const [hosts, setHosts] = useState<Host[]>([])
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const [agents, setAgents] = useState<Record<string, string | null>>({})
  const [statuses, setStatuses] = useState<RepoStatus[]>([])
  const [integrations, setIntegrations] = useState<Integrations>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [form, setForm] = useState<FormKind>()
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
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    document.documentElement.classList.toggle('dark', appearance.theme === 'dark')
    localStorage.setItem('relay.appearance', JSON.stringify(appearance))
  }, [appearance])
  useEffect(() => {
    let active = true
    setLoading(!snapshotRef.current)
    setError('')
    window.relay
      .request<Snapshot>('local', 'snapshot')
      .then((result) => {
        if (active) {
          setHosts([
            ...result.hosts,
            ...result.sessRemotes.filter((h) => !result.hosts.some((r) => r.name === h.name))
          ])
        }
      })
      .catch(report)
    window.relay
      .request<Snapshot>(host, 'snapshot')
      .then((result) => {
        if (active) {
          setSnapshot(result)
          validate(result.workspaces.map((w) => w.id))
          setLoading(false)
        }
      })
      .catch((error) => {
        if (active) {
          setError(String(error))
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [host, revision, report, validate])
  useEffect(() => {
    if (!workspace) {
      return
    }
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await window.relay.request<{
          repos: RepoStatus[]
          agents?: Record<string, string | null> | null
        }>(host, 'status', {
          workspace: workspace.id
        })
        if (active) {
          setStatuses(result.repos)
          setAgents(result.agents || {})
        }
      } catch (e) {
        if (active) {
          report(e)
        }
      } finally {
        if (active) {
          timer = setTimeout(() => {
            if (document.visibilityState === 'visible') {
              void poll()
            } else {
              timer = setTimeout(poll, 5000)
            }
          }, 5000)
        }
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [host, workspace, revision, report])
  useEffect(() => {
    if (!workspace) {
      return
    }
    let active = true
    setIntegrations(undefined)
    const load = () =>
      window.relay
        .request<Integrations>(host, 'integrations', { workspace: workspace.id })
        .then((value) => {
          if (active) {
            setIntegrations(value)
          }
        })
        .catch(() => {
          if (active) {
            setIntegrations(undefined)
          }
        })
    void load()
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void load()
      }
    }, 60000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [host, workspace])
  const selectWorkspace = (id: string) => {
    setWorkspaceId(id)
    setRequestView(undefined)
    setStatuses([])
    setAgents({})
    setIntegrations(undefined)
  }
  const interactions = useWorkspaceActions({
    host,
    workspaceId,
    refresh,
    report,
    form: setForm,
    select: (id, terminal) => {
      navigation.select(id, terminal)
      if (terminal) {
        fileTabs.deactivate(JSON.stringify([host, id]))
      }
      setRequestView(undefined)
    }
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
    newWorkspace: () => setForm('workspace'),
    newTerminal: terminalNew,
    split: terminalNew,
    disabled:
      busy || interactions.pending || loading || !!form || settings || interactions.confirming,
    workspaces:
      snapshot?.workspaces.filter((w) => w.name.toLowerCase().includes(query.toLowerCase())) || [],
    workspace,
    terminal,
    selectWorkspace,
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
        setSnapshot,
        setTerminalId,
        selectWorkspace
      })
  })
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
                    hosts={hosts}
                    snapshot={snapshot}
                    workspaceId={workspaceId}
                    query={query}
                    setQuery={setQuery}
                    selectHost={(value) => {
                      setHost(value)
                      setSnapshot(undefined)
                      setStatuses([])
                      setAgents({})
                      setIntegrations(undefined)
                      setRequestView(undefined)
                    }}
                    selectWorkspace={selectWorkspace}
                    setForm={setForm}
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
                attachTicket={() => setForm('ticket')}
              />
              {repositoriesOpen && !form && snapshot && (
                <RepositoryManager
                  key={host}
                  host={host}
                  snapshot={snapshot}
                  close={() => setRepositoriesOpen(false)}
                  add={() => setForm('repo')}
                  select={selectWorkspace}
                />
              )}
              {form && snapshot && (
                <WorkspaceForm
                  key={form}
                  kind={form}
                  host={host}
                  snapshot={snapshot}
                  workspace={workspace}
                  close={() => setForm(undefined)}
                  done={(id) => {
                    if (id) {
                      selectWorkspace(id)
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
