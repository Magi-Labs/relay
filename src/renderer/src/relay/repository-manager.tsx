import { useEffect, useState } from 'react'
import { Copy, FolderGit2, Plus, RefreshCw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { RepoStatus, Snapshot } from '../../../shared/relay/types'
import { RepoStatusIcon } from './git-status-icon'
import { copyPath } from './action-menu'
type Details = RepoStatus & {
  remote: string
  workspaces: { id: string; name: string; path: string; branch: string }[]
}
export function RepositoryManager({
  host,
  snapshot,
  close,
  add,
  select
}: {
  host: string
  snapshot: Snapshot
  close: () => void
  add: () => void
  select: (id: string) => void
}) {
  const [repos, setRepos] = useState<Details[]>([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, refresh] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    window.relay
      .request<{ repos: Details[] }>(host, 'repo_inventory')
      .then((value) => {
        if (active) {
          setRepos(value.repos)
        }
      })
      .catch((error) => {
        if (active) {
          setError(String(error))
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [host, revision, snapshot])
  const filtered = repos.filter((repo) =>
    `${repo.name} ${repo.path} ${repo.remote}`.toLowerCase().includes(query.toLowerCase())
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          close()
        }
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Repositories</DialogTitle>
          <DialogDescription>
            Registered repositories on {host}. Workspaces use their own worktrees; utility
            repositories are shared.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            aria-label="Find repositories"
            placeholder="Find repository or path…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh repository list"
            disabled={loading}
            onClick={() => refresh((v) => v + 1)}
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} />
          </Button>
          <Button size="icon" aria-label="Add repository" title="Add repository" onClick={add}>
            <Plus />
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="min-h-0 space-y-3 overflow-y-auto scrollbar-sleek">
          {loading && !repos.length ? (
            <p role="status" className="py-4 text-sm text-muted-foreground">
              Loading repositories…
            </p>
          ) : (
            filtered.map((repo) => (
              <section key={repo.id} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FolderGit2 className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{repo.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {repo.utility ? 'Shared utility' : 'Worktrees'}
                  </span>
                  <RepoStatusIcon error={repo.error} changes={repo.files.length} />
                </div>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 break-all font-mono text-xs text-muted-foreground">
                    {repo.path}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Copy path for ${repo.name}`}
                    onClick={() => void copyPath(repo.path).catch((e) => setError(String(e)))}
                  >
                    <Copy />
                  </Button>
                </div>
                {repo.remote && (
                  <p className="break-all text-xs text-muted-foreground">{repo.remote}</p>
                )}
                {repo.error ? (
                  <p role="alert" className="text-xs text-destructive">
                    {repo.error}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {repo.branch || 'Detached HEAD'} ·{' '}
                    {repo.files.length
                      ? `${repo.files.length} uncommitted files`
                      : 'Working tree clean'}
                    {repo.ahead ? ` · ↑${repo.ahead}` : ''}
                    {repo.behind ? ` · ↓${repo.behind}` : ''}
                  </p>
                )}
                {repo.workspaces.length ? (
                  <div className="space-y-1 border-t pt-2">
                    {repo.workspaces.map((workspace) => (
                      <button
                        key={workspace.id}
                        onClick={() => {
                          select(workspace.id)
                          close()
                        }}
                        className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
                        title={workspace.path}
                      >
                        <span className="font-medium">{workspace.name}</span>
                        <span className="ml-2 text-muted-foreground">{workspace.branch}</span>
                        <span className="mt-1 block truncate font-mono text-muted-foreground">
                          {workspace.path}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {repo.utility ? 'Available in every workspace' : 'Not attached to a workspace'}
                  </p>
                )}
              </section>
            ))
          )}
          {!loading && !error && !filtered.length && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {repos.length
                ? 'No matching repositories.'
                : 'No repositories yet. Use + to add one.'}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
