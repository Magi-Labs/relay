import { discardDrafts } from './file-drafts'
import { useEffect, useState } from 'react'
import { File, GitCompareArrows, X } from 'lucide-react'
import type { OpenFile } from './editor'
import { ActionMenu, copyPath, type Action } from './action-menu'
export const fileKey = (file: OpenFile) =>
  JSON.stringify([
    file.absolutePath || [file.repo, file.path],
    file.scope,
    file.scope === 'comparison' ? file.comparisonRef : undefined
  ])
type Group = { files: OpenFile[]; active?: OpenFile }
function read(): Record<string, Group> {
  try {
    const stored = JSON.parse(localStorage.getItem('relay.file-tabs') || '{}'),
      result: Record<string, Group> = {}
    const valid = (f: OpenFile) =>
      f &&
      typeof f.repo === 'string' &&
      typeof f.path === 'string' &&
      (!f.scope || ['working', 'staged', 'comparison'].includes(f.scope))
    for (const [key, value] of Object.entries(stored).slice(-50)) {
      if (
        !value ||
        typeof value !== 'object' ||
        !('files' in value) ||
        !Array.isArray(value.files)
      ) {
        continue
      }
      const files: OpenFile[] = value.files.filter(valid).slice(-50)
      result[key] = {
        files,
        active:
          'active' in value
            ? files.find((f) => JSON.stringify(f) === JSON.stringify(value.active))
            : undefined
      }
    }
    return result
  } catch {
    return {}
  }
}
export function useFileTabs(
  context: string,
  host: string,
  workspace: string,
  report: (e: unknown) => void
) {
  const [groups, setGroups] = useState(read)
  useEffect(
    () =>
      localStorage.setItem(
        'relay.file-tabs',
        JSON.stringify(groups, (key, value) =>
          key === 'line' || key === 'column' ? undefined : value
        )
      ),
    [groups]
  )
  const current = groups[context] || { files: [] }
  const select = (file?: OpenFile) => {
    const save = (next?: OpenFile) =>
      setGroups((all) => {
        const group = all[context] || { files: [] }
        const nextKey = next && fileKey(next)
        const files = next
          ? [...group.files.filter((f) => fileKey(f) !== nextKey), next]
          : group.files
        // Updating an existing tab must not move it to the end.
        const existing = next && group.files.findIndex((f) => fileKey(f) === nextKey)
        if (typeof existing === 'number' && existing >= 0) {
          files.splice(-1, 1)
          next = { ...group.files[existing], line: next?.line, column: next?.column }
          files.splice(existing, 0, next)
        }
        return { ...all, [context]: { files: files.slice(-50), active: next } }
      })
    if (!file || file.absolutePath) {
      save(file)
      return
    }
    void window.relay
      .request<{ absolutePath: string }>(host, 'file_info', {
        workspace,
        repo: file.repo,
        path: file.path
      })
      .then((info) => save({ ...file, ...info }))
      .catch(report)
  }
  const close = (file = current.active) => {
    if (!file || !discardDrafts(host, workspace, [file])) {
      return
    }
    setGroups((all) => {
      const group = all[context] || { files: [] },
        index = group.files.findIndex((f) => fileKey(f) === fileKey(file))
      const files = group.files.filter((f) => fileKey(f) !== fileKey(file))
      return {
        ...all,
        [context]: {
          files,
          active:
            group.active && fileKey(group.active) === fileKey(file)
              ? files[Math.min(index, files.length - 1)]
              : group.active
        }
      }
    })
  }
  const closeOthers = (file: OpenFile) => {
    if (
      !discardDrafts(
        host,
        workspace,
        current.files.filter((f) => fileKey(f) !== fileKey(file))
      )
    ) {
      return
    }
    setGroups((all) => ({ ...all, [context]: { files: [file], active: file } }))
  }
  return {
    files: current.files,
    file: current.active,
    select,
    close,
    closeOthers,
    deactivate: (key: string) =>
      setGroups((all) => ({ ...all, [key]: { ...(all[key] || { files: [] }), active: undefined } }))
  }
}
export function FileTabs({
  files,
  active,
  select,
  close,
  closeOthers,
  reveal
}: {
  files: OpenFile[]
  active?: OpenFile
  select: (file: OpenFile) => void
  close: (file: OpenFile) => void
  closeOthers: (file: OpenFile) => void
  reveal: (file: OpenFile) => void
}) {
  return files.map((file) => {
    const name = file.path.split('/').pop(),
      duplicate = files.some(
        (f) => fileKey(f) !== fileKey(file) && f.path.split('/').pop() === name
      )
    const label = `${name}${file.scope ? ` · ${file.scope === 'comparison' ? `vs ${file.comparisonRef}` : file.scope} diff` : ''}`
    const actions: Action[] = [
      { label: 'Copy path', run: () => copyPath(file.absolutePath || file.path) },
      { label: 'Reveal in file tree', run: () => reveal(file) },
      { label: 'Close file', run: () => close(file) },
      { label: 'Close other files', run: () => closeOthers(file), disabled: files.length < 2 }
    ]
    const Icon = file.scope ? GitCompareArrows : File
    return (
      <ActionMenu key={fileKey(file)} actions={actions}>
        <div
          className={`group flex h-full shrink-0 items-center border-r ${active && fileKey(active) === fileKey(file) ? 'border-b-2 border-b-foreground bg-accent' : ''}`}
        >
          <button
            title={file.absolutePath || file.path}
            aria-selected={!!active && fileKey(active) === fileKey(file)}
            className="flex h-full items-center gap-2 px-3 text-xs"
            onClick={() => select({ ...file, line: undefined, column: undefined })}
          >
            <Icon className="size-3.5" />
            <span className="max-w-48 truncate">
              {label}
              {duplicate && (
                <span className="ml-2 text-muted-foreground">
                  {file.repo.startsWith('@') ? file.path.split('/').slice(-2, -1) : file.repo}
                </span>
              )}
            </span>
          </button>
          <button
            className="p-2 text-muted-foreground hover:text-foreground"
            aria-label={`Close ${name}`}
            onClick={() => close(file)}
          >
            <X className="size-3" />
          </button>
        </div>
      </ActionMenu>
    )
  })
}
