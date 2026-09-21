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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { Host, Snapshot } from '../../../shared/relay/types'
import type { FormKind } from './forms'
export function WorkspaceSidebar({
  host,
  hosts,
  snapshot,
  workspaceId,
  query,
  setQuery,
  selectHost,
  selectWorkspace,
  setForm,
  openRepositories,
  openSettings,
  refresh
}: {
  host: string
  hosts: Host[]
  snapshot?: Snapshot
  workspaceId: string
  query: string
  setQuery: (value: string) => void
  selectHost: (host: string) => void
  selectWorkspace: (id: string) => void
  openRepositories: () => void
  setForm: (kind: FormKind) => void
  refresh: () => void
  openSettings: () => void
}) {
  const menus = useInteractions()
  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 p-3">
        {host === 'local' ? (
          <Monitor className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <Server className="size-4 shrink-0 text-muted-foreground" />
        )}
        <Select value={host} onValueChange={selectHost}>
          <SelectTrigger aria-label="Execution host" className="min-w-0 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">Local</SelectItem>
            {hosts.map((h) => (
              <SelectItem key={h.name} value={h.name}>
                {h.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
          disabled={!snapshot}
          onClick={() => setForm('workspace')}
        >
          <Plus />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek px-2">
        <ReorderList
          items={(snapshot?.workspaces || []).filter((w) =>
            w.name.toLowerCase().includes(query.toLowerCase())
          )}
          disabled={!!query}
          reorder={async (ids) => {
            await window.relay.request(host, 'workspace_reorder', { ids })
            refresh()
          }}
        >
          {(w) => (
            <RenameItem
              actions={menus.workspace(w)}
              key={w.id}
              name={w.name}
              kind="workspace"
              selected={w.id === workspaceId}
              className="relay-row py-2 text-sm"
              enabled={!w.permanent}
              select={() => selectWorkspace(w.id)}
              rename={async (name) => {
                await window.relay.request(host, 'workspace_rename', { workspace: w.id, name })
                refresh()
              }}
              leading={<TerminalSquare className="size-4 shrink-0 text-muted-foreground" />}
              trailing={
                w.permanent ? (
                  <LockKeyhole
                    aria-label="Permanent workspace"
                    className="size-3 text-muted-foreground"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">{w.repos.length || ''}</span>
                )
              }
            />
          )}
        </ReorderList>
      </div>
      <div className="space-y-1 border-t p-2">
        <Button
          variant="ghost"
          className="w-full justify-start"
          size="sm"
          disabled={!snapshot}
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
