import { GitStatusIcon } from './git-status-icon'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, LoaderCircle } from 'lucide-react'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { ActionMenu, copyPath } from './action-menu'
import type { Comparison, FileEntry, Workspace } from '../../../shared/relay/types'
import type { OpenFile } from './editor'
export function useFileTree(host: string, workspace: Workspace, active?: OpenFile) {
  const key = `relay.tree:${host}:${workspace.id}`
  const [expanded, setExpanded] = useState<string[]>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]')
      return Array.isArray(value) ? value.filter((v) => typeof v === 'string').slice(-500) : []
    } catch {
      return []
    }
  })
  const [revision, refresh] = useState(0)
  const rowKey = (repo: string, path: string) => JSON.stringify([repo, path])
  const target = active?.absolutePath || (active?.repo === '@files' ? active.path : undefined)
  const roots = [{ id: '@workspace', path: workspace.path }, ...workspace.repos]
  const matching = roots
    .filter((r) => target?.startsWith(`${r.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
  const external = target && !matching ? target.slice(0, target.lastIndexOf('/')) || '/' : undefined
  useEffect(() => localStorage.setItem(key, JSON.stringify(expanded.slice(-500))), [key, expanded])
  const matchId = matching?.id,
    matchPath = matching?.path
  useEffect(() => {
    if (!active) {
      return
    }
    const repo = matchId || active.repo,
      path = matchPath && target ? target.slice(matchPath.length + 1) : active.path
    const parts = path.split('/'),
      parents: string[] = []
    for (let i = 1; i < parts.length; i++) {
      parents.push(rowKey(repo, parts.slice(0, i).join('/')))
    }
    setExpanded((old) => [...new Set([...old, ...parents])])
  }, [active, matchId, matchPath, target])
  return {
    expanded,
    revision,
    target,
    external,
    rowKey,
    toggle: (repo: string, path: string) =>
      setExpanded((old) =>
        old.includes(rowKey(repo, path))
          ? old.filter((p) => p !== rowKey(repo, path))
          : [...old, rowKey(repo, path)]
      ),
    collapse: () => setExpanded([]),
    refresh: () => refresh((n) => n + 1)
  }
}
export type Tree = ReturnType<typeof useFileTree>
export function Directory({
  host,
  workspace,
  repo,
  directory = '',
  root,
  depth = 0,
  openFile,
  tree,
  comparison,
  virtual = false
}: {
  host: string
  workspace: string
  repo: string
  directory?: string
  root: string
  depth?: number
  openFile: (f: OpenFile) => void
  tree: Tree
  comparison?: Comparison
  virtual?: boolean
}) {
  const selectedRow = useRef<HTMLButtonElement>(null)
  const [entries, setEntries] = useState<FileEntry[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [limited, setLimited] = useState(false)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    if (virtual) {
      setEntries([])
      setLoading(false)
      return
    }
    window.relay
      .request<{ entries: FileEntry[]; limited: boolean }>(host, 'files', {
        workspace,
        repo,
        directory
      })
      .then((result) => {
        if (active) {
          setEntries(result.entries)
          setLimited(result.limited)
        }
      })
      .catch((e) => {
        if (active) {
          setError(String(e))
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
  }, [host, workspace, repo, directory, tree.revision, virtual])
  const visible = [...entries]
  const virtualPaths = new Set<string>()
  const changes = comparison?.error ? [] : comparison?.files || []
  const prefix = directory ? `${directory}/` : ''
  for (const change of changes) {
    if (!change.path.startsWith(prefix)) {
      continue
    }
    const rest = change.path.slice(prefix.length),
      name = rest.split('/')[0]
    const path = prefix + name
    if (!visible.some((entry) => entry.path === path)) {
      visible.push({ name, path, directory: rest.includes('/'), symlink: false })
      virtualPaths.add(path)
    }
  }
  visible.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
  const hasSelected = visible.some(
    (entry) => (repo === '@files' ? entry.path : `${root}/${entry.path}`) === tree.target
  )
  useEffect(() => {
    if (hasSelected) {
      selectedRow.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [tree.target, hasSelected])
  return (
    <>
      {loading && (
        <span
          role="status"
          className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground"
        >
          <LoaderCircle className="size-3 animate-spin" />
          Refreshing files…
        </span>
      )}
      {error && (
        <button role="alert" className="px-3 text-xs text-destructive" onClick={tree.refresh}>
          {error} · Retry
        </button>
      )}
      {!loading && !error && !visible.length && (
        <p className="px-3 py-1 text-xs text-muted-foreground">Empty folder</p>
      )}
      {visible.map((entry) => {
        const Icon = entry.directory ? Folder : getFileTypeIcon(entry.name),
          open = tree.expanded.includes(tree.rowKey(repo, entry.path))
        const absolute = repo === '@files' ? entry.path : `${root}/${entry.path}`,
          selected = tree.target === absolute
        const file = { repo, path: entry.path }
        const change = changes.find((f) => f.path === entry.path)
        const nested = entry.directory && changes.some((f) => f.path.startsWith(`${entry.path}/`))
        const diff: OpenFile = { ...file, scope: 'comparison', comparisonRef: comparison?.ref }
        const activate = () =>
          entry.directory ? tree.toggle(repo, entry.path) : openFile(change ? diff : file)
        const actions = [
          ...(!entry.directory && change
            ? [{ label: `Compare with ${comparison?.ref}`, run: () => openFile(diff) }]
            : []),
          {
            label: entry.directory ? (open ? 'Collapse folder' : 'Expand folder') : 'Open file',
            disabled: change?.worktree === 'D',
            run: () => (entry.directory ? tree.toggle(repo, entry.path) : openFile(file))
          },
          {
            label: 'Copy relative path',
            run: () => copyPath(repo === '@files' ? entry.name : entry.path)
          },
          { label: 'Copy absolute path', run: () => copyPath(absolute) }
        ]
        return (
          <div key={entry.path}>
            <ActionMenu actions={actions}>
              <button
                ref={selected ? selectedRow : undefined}
                className={`relay-row text-xs ${selected ? 'bg-accent text-foreground' : ''}`}
                aria-current={selected ? 'page' : undefined}
                aria-expanded={entry.directory ? open : undefined}
                style={{ paddingLeft: 12 + depth * 12 }}
                title={absolute}
                onClick={activate}
              >
                {entry.directory ? (
                  open ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )
                ) : (
                  <span className="w-3" />
                )}
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span
                  className={`truncate ${change?.worktree === 'D' ? 'line-through' : ''}`}
                  style={{
                    color:
                      change || nested
                        ? `var(--git-decoration-${change?.worktree === 'D' ? 'deleted' : change?.worktree === 'A' ? 'added' : 'modified'})`
                        : undefined
                  }}
                >
                  {entry.name}
                </span>
                {change && <GitStatusIcon file={change} code={change.worktree} />}
                {nested && (
                  <span className="ml-auto text-xs text-muted-foreground" title="Contains changes">
                    ●
                  </span>
                )}
              </button>
            </ActionMenu>
            {entry.directory && open && (
              <Directory
                host={host}
                workspace={workspace}
                repo={repo}
                directory={entry.path}
                root={root}
                depth={depth + 1}
                openFile={openFile}
                tree={tree}
                comparison={comparison}
                virtual={virtualPaths.has(entry.path)}
              />
            )}
          </div>
        )
      })}
      {limited && <p className="p-3 text-xs text-muted-foreground">First 2,000 entries shown.</p>}
    </>
  )
}
