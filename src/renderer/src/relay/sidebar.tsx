import { useInteractions } from './workspace-actions'
import { ReorderList } from './reorder-list'
import { RenameItem } from './rename-item'
import {
  Monitor,
  Server,
  Plus,
  TerminalSquare,
  LockKeyhole,
  FolderGit2,
  Settings2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { HostSection } from './host-sections'
import type { FormKind } from './forms'
export function WorkspaceSidebar({
  host,
  sections,
  collapsed,
  reorderHosts,
  toggleHost,
  workspaceId,
  query,
  setQuery,
  selectWorkspace,
  setForm,
  openRepositories,
  openSettings,
  refresh
}: {
  host: string
  sections: HostSection[]
  collapsed: Record<string, boolean>
  reorderHosts: (ids: string[]) => void
  toggleHost: (host: string) => void
  workspaceId: string
  query: string
  setQuery: (value: string) => void
  selectWorkspace: (host: string, id: string) => void
  openRepositories: () => void
  setForm: (kind: FormKind, host?: string) => void
  refresh: () => void
  openSettings: () => void
}) {
  const menus = useInteractions()
  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 p-3">
        <span className="flex-1 text-xs font-medium text-muted-foreground">HOSTS</span>
        <Button
          aria-label="Add host"
          title="Add host"
          variant="ghost"
          size="icon-xs"
          onClick={() => setForm('host')}
        >
          <Plus />
        </Button>
      </div>
      <div className="px-3 pb-3">
        <Input
          aria-label="Filter workspaces"
          placeholder="Find workspace…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="flex items-center justify-between px-3 pb-2 text-xs font-medium text-muted-foreground">
        <span>WORKSPACES</span>
        <Button
          aria-label="New workspace"
          variant="ghost"
          size="icon-xs"
          onClick={() => setForm('workspace')}
        >
          <Plus />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek px-2">
        <ReorderList
          items={sections.map((s) => ({ id: s.host, name: s.label }))}
          disabled={!!query}
          ignore="input, [data-no-drag], [data-host-body]"
          reorder={async (ids) => {
            reorderHosts(ids)
          }}
        >
          {(item) => {
            const section = sections.find((s) => s.host === item.id)!
            const isCollapsed = !!collapsed[section.host] && !query
            return (
              <div className="w-full min-w-0" data-host={section.host}>
                <div className="flex items-center gap-1 px-1 py-1">
                  <button
                    data-no-drag
                    aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${section.label}`}
                    title={isCollapsed ? 'Expand' : 'Collapse'}
                    aria-expanded={!isCollapsed}
                    className="p-1 text-muted-foreground hover:text-foreground"
                    onClick={() => toggleHost(section.host)}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    )}
                  </button>
                  {section.host === 'local' ? (
                    <Monitor className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Server className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                    {section.label}
                  </span>
                  <Button
                    data-no-drag
                    aria-label={`New workspace in ${section.label}`}
                    title={`New workspace in ${section.label}`}
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setForm('workspace', section.host)}
                  >
                    <Plus />
                  </Button>
                </div>
                {section.error && (
                  <p role="alert" className="px-3 pb-1 text-xs text-destructive">
                    {section.error}
                  </p>
                )}
                {!isCollapsed && (
                  <div data-host-body className="pb-1">
                    <ReorderList
                      items={section.workspaces}
                      disabled={!!query}
                      reorder={async (ids) => {
                        await window.relay.request(section.host, 'workspace_reorder', { ids })
                        refresh()
                      }}
                    >
                      {(w) => (
                        <RenameItem
                          actions={menus.workspace(w, section.host)}
                          key={w.id}
                          name={w.name}
                          kind="workspace"
                          selected={section.host === host && w.id === workspaceId}
                          className="relay-row py-2 text-sm"
                          enabled={!w.permanent}
                          select={() => selectWorkspace(section.host, w.id)}
                          rename={async (name) => {
                            await window.relay.request(section.host, 'workspace_rename', {
                              workspace: w.id,
                              name
                            })
                            refresh()
                          }}
                          leading={
                            <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />
                          }
                          trailing={
                            w.permanent ? (
                              <LockKeyhole
                                aria-label="Permanent workspace"
                                className="size-3 text-muted-foreground"
                              />
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {w.repos.length || ''}
                              </span>
                            )
                          }
                        />
                      )}
                    </ReorderList>
                  </div>
                )}
              </div>
            )
          }}
        </ReorderList>
      </div>
      <div className="space-y-1 border-t p-2">
        <Button
          variant="ghost"
          className="w-full justify-start"
          size="sm"
          onClick={openRepositories}
        >
          <FolderGit2 />
          Repositories
        </Button>
        <Button variant="ghost" className="w-full justify-start" size="sm" onClick={openSettings}>
          <Settings2 />
          Settings
        </Button>
      </div>
    </aside>
  )
}
