import { ComparisonControl } from './comparison-control'
import { GitStatusIcon, RepoStatusIcon } from './git-status-icon'
import { Directory, useFileTree, type Tree } from './file-tree'
import { ActionMenu, copyPath } from './action-menu'
import { useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Plus,
  Minus,
  RefreshCw,
  ChevronsDownUp
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import type { RepoStatus, Workspace } from '../../../shared/relay/types'
import type { OpenFile } from './editor'
type Props = {
  activeFile?: OpenFile
  requestView?: { view: string; file?: OpenFile; serial: number }
  tree?: Tree

  host: string
  workspace: Workspace
  statuses: RepoStatus[]
  openFile: (file: OpenFile) => void
  refresh: () => void
  report: (error: unknown) => void
}
function Repository({ repo, props, view }: { repo: RepoStatus; props: Props; view: string }) {
  const [expanded, setExpanded] = useState(props.statuses.length === 1)
  useEffect(() => {
    if (props.activeFile?.absolutePath?.startsWith(`${repo.path}/`)) {
      setExpanded(true)
    }
  }, [props.activeFile, repo.path])
  const [visibleCount, setVisibleCount] = useState(100)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const action = async (action: string, path = '') => {
    setBusy(true)
    try {
      await window.relay.request(props.host, 'git_action', {
        workspace: props.workspace.id,
        repo: repo.id,
        action,
        path,
        message
      })
      if (action === 'commit') {
        setMessage('')
      }
      props.refresh()
    } catch (e) {
      props.report(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="border-b pb-2">
      <button
        className="relay-row rounded-none py-2 text-xs font-medium"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <RepoStatusIcon error={repo.error} changes={repo.files.length} />
        <span className="flex-1 truncate">{repo.name}</span>
        <span className="text-muted-foreground">
          {repo.utility ? 'shared' : repo.files.length || ''}
        </span>
      </button>
      {busy && (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          Updating {repo.name}…
        </p>
      )}
      {expanded && (
        <>
          <div className="flex items-center gap-1 px-3 pb-2 text-xs text-muted-foreground">
            <GitBranch className="size-3" />
            <span className="truncate">{repo.branch || 'Repository'}</span>
            {repo.ahead > 0 && <span>↑{repo.ahead}</span>}
            {repo.behind > 0 && <span>↓{repo.behind}</span>}
          </div>
          {view === 'files' && (
            <ComparisonControl
              repo={repo}
              host={props.host}
              workspace={props.workspace.id}
              refresh={props.refresh}
              report={props.report}
            />
          )}
          {repo.error ? (
            <p className="px-3 text-xs text-destructive">{repo.error}</p>
          ) : view === 'files' ? (
            <Directory
              comparison={repo.comparison}
              tree={props.tree!}
              root={repo.path}
              host={props.host}
              workspace={props.workspace.id}
              repo={repo.id}
              openFile={props.openFile}
            />
          ) : (
            <>
              {(['staged', 'working'] as const).map((scope) => {
                const rows = repo.files
                  .filter((f) =>
                    scope === 'staged'
                      ? !['.', '?'].includes(f.index)
                      : f.worktree !== '.' || f.untracked
                  )
                  .sort((a, b) => Number(a.untracked) - Number(b.untracked))
                return (
                  rows.length > 0 && (
                    <div key={scope}>
                      <p className="px-3 py-2 text-xs font-medium text-muted-foreground">
                        {scope === 'staged' ? 'Staged changes' : 'Changes'}{' '}
                        <span>{rows.length}</span>
                      </p>
                      {rows.slice(0, visibleCount).map((file) => {
                        const code = scope === 'staged' ? file.index : file.worktree
                        const Icon = getFileTypeIcon(file.path)
                        return (
                          <ActionMenu
                            key={file.path}
                            actions={[
                              {
                                label: 'Open diff',
                                run: () => props.openFile({ repo: repo.id, path: file.path, scope })
                              },
                              {
                                label: 'Open file',
                                disabled: code === 'D',
                                run: () => props.openFile({ repo: repo.id, path: file.path })
                              },
                              { label: 'Copy relative path', run: () => copyPath(file.path) },
                              {
                                label: 'Copy absolute path',
                                run: () => copyPath(`${repo.path}/${file.path}`)
                              },
                              {
                                label: scope === 'staged' ? 'Unstage file' : 'Stage file',
                                disabled: busy || file.conflict,
                                run: () =>
                                  action(scope === 'staged' ? 'unstage' : 'stage', file.path)
                              }
                            ]}
                          >
                            <div className="group flex items-center px-2">
                              <button
                                className="relay-row min-w-0 flex-1 text-xs"
                                onClick={() =>
                                  props.openFile({ repo: repo.id, path: file.path, scope })
                                }
                              >
                                <Icon className="size-4 shrink-0 text-muted-foreground" />
                                <span className="truncate" title={file.path}>
                                  {file.path}
                                </span>
                                <GitStatusIcon file={file} code={code} />
                              </button>
                              <Button
                                disabled={busy || file.conflict}
                                aria-label={`${scope === 'staged' ? 'Unstage' : 'Stage'} ${file.path}`}
                                variant="ghost"
                                size="icon-xs"
                                onClick={() =>
                                  void action(scope === 'staged' ? 'unstage' : 'stage', file.path)
                                }
                              >
                                {scope === 'staged' ? <Minus /> : <Plus />}
                              </Button>
                            </div>
                          </ActionMenu>
                        )
                      })}
                      {rows.length > visibleCount && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mx-2"
                          onClick={() => setVisibleCount((count) => count + 100)}
                        >
                          Show next {Math.min(100, rows.length - visibleCount)} of{' '}
                          {rows.length - visibleCount} remaining
                        </Button>
                      )}
                    </div>
                  )
                )
              })}
              {repo.files.length === 0 && (
                <p className="px-3 py-2 text-xs text-muted-foreground">Working tree clean</p>
              )}
              {repo.files.some((f) => !['.', '?'].includes(f.index)) && (
                <form
                  className="space-y-2 p-3"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void action('commit')
                  }}
                >
                  <Input
                    aria-label={`Commit message for ${repo.name}`}
                    placeholder="Commit message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                  <Button className="w-full" size="sm" disabled={busy || !message.trim()}>
                    Commit staged
                  </Button>
                </form>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
export function Repositories(props: Props) {
  const tree = useFileTree(props.host, props.workspace, props.activeFile || props.requestView?.file)
  const [view, setView] = useState(props.workspace.permanent ? 'files' : 'git')
  useEffect(() => {
    if (props.requestView) {
      setView(props.requestView.view)
    }
  }, [props.requestView])
  return (
    <aside className="flex h-full min-h-0 flex-col border-l bg-sidebar">
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-2">
        <Tabs value={view} onValueChange={setView}>
          <TabsList variant="line">
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="git">Source control</TabsTrigger>
          </TabsList>
        </Tabs>
        {view === 'files' && (
          <Button
            aria-label="Collapse all folders"
            title="Collapse all folders"
            variant="ghost"
            size="icon-xs"
            onClick={tree.collapse}
          >
            <ChevronsDownUp />
          </Button>
        )}
        <Button
          aria-label="Refresh repositories"
          variant="ghost"
          size="icon-xs"
          onClick={() => {
            tree.refresh()
            props.refresh()
          }}
        >
          <RefreshCw />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
        {view === 'files' && (
          <section className="border-b">
            <p className="px-3 py-2 text-xs font-medium text-muted-foreground">Workspace files</p>
            <Directory
              tree={tree}
              root={props.workspace.path}
              host={props.host}
              workspace={props.workspace.id}
              repo="@workspace"
              openFile={props.openFile}
            />
          </section>
        )}
        {view === 'files' && tree.external && (
          <section className="border-b">
            <p className="truncate px-3 py-2 text-xs text-muted-foreground" title={tree.external}>
              {tree.external}
            </p>
            <Directory
              host={props.host}
              workspace={props.workspace.id}
              repo="@files"
              directory={tree.external}
              root={tree.external}
              openFile={props.openFile}
              tree={tree}
            />
          </section>
        )}
        {props.statuses.map((repo) => (
          <Repository key={repo.id} repo={repo} props={{ ...props, tree }} view={view} />
        ))}
        {props.statuses.length === 0 && view !== 'files' && (
          <p className="p-4 text-xs leading-relaxed text-muted-foreground">
            Attach repositories to browse files and changes. Blank workspaces can attach worktrees
            later through the Relay CLI.
          </p>
        )}
      </div>
    </aside>
  )
}
