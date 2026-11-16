import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { Host, Snapshot, Workspace } from '../../../shared/relay/types'
export type FormKind = 'workspace' | 'repo' | 'host' | 'attach' | 'ticket'
export function WorkspaceForm({
  kind,
  host,
  snapshot,
  workspace,
  editHost,
  close,
  done
}: {
  kind: FormKind
  host: string
  snapshot: Snapshot
  workspace?: Workspace
  editHost?: Host
  close: () => void
  done: (workspace?: string) => void
}) {
  const [name, setName] = useState(
    kind === 'ticket' ? workspace?.ticket || '' : editHost?.name || ''
  )
  const [ticket, setTicket] = useState('')
  const [path, setPath] = useState('')
  const [url, setUrl] = useState('')
  const [ssh, setSsh] = useState(editHost?.ssh || 'local-vm')
  const [root, setRoot] = useState(editHost?.root || '~/relay')
  const [utility, setUtility] = useState(false)
  const [selected, setSelected] = useState<Record<string, { branch: string; mode: string }>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const titles = {
    workspace: 'New workspace',
    repo: 'Add repository',
    host: editHost ? 'Save host' : 'Add host',
    attach: 'Attach repositories',
    ticket: 'Attach Linear ticket'
  }
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      if (kind === 'host') {
        await (editHost
          ? window.relay.request('local', 'host_update', {
              name: editHost.name,
              new_name: name,
              ssh,
              root
            })
          : window.relay.request('local', 'host_add', { name, ssh, root }))
      }
      if (kind === 'host' && editHost) {
        done(name)
        close()
        return
      }
      if (kind === 'repo') {
        await window.relay.request(host, 'repo_register', { name, path, url, utility })
      }
      if (kind === 'ticket') {
        await window.relay.request(host, 'ticket_attach', {
          workspace: workspace?.id,
          ticket: name
        })
      }
      const repos = Object.entries(selected).map(([repo, value]) => ({
        repo,
        ...(value.mode === 'existing' ? { branch: value.branch } : { new_branch: value.branch }),
        base: 'HEAD'
      }))
      if (repos.some((repo) => 'branch' in repo && !repo.branch)) {
        throw new Error('Enter the existing branch name.')
      }
      if (kind === 'workspace') {
        const result = await window.relay.request<{
          workspace: Workspace
          errors: { repo: string; error: string }[]
        }>(host, 'workspace_create', { name, repos, ticket })
        if (result.errors.length) {
          done(result.workspace.id)
          throw new Error(
            `Workspace created, but some attachments failed: ${result.errors
              .map((e) => `${e.repo}: ${e.error}`)
              .join('; ')}`
          )
        }
        done(result.workspace.id)
      } else if (kind === 'attach') {
        for (const repo of repos) {
          await window.relay.request(host, 'repo_attach', { workspace: workspace?.id, ...repo })
        }
        done()
      } else {
        done()
      }
      close()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          close()
        }
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto scrollbar-sleek">
        <DialogHeader>
          <DialogTitle>{kind === 'host' && editHost ? 'Edit host' : titles[kind]}</DialogTitle>
          <DialogDescription>
            {kind === 'workspace' || kind === 'attach'
              ? 'Each selected repository gets its own worktree inside this workspace.'
              : kind === 'repo'
                ? `Register a repository on ${host}. GitHub clones use gh.`
                : kind === 'host'
                  ? 'Use an SSH alias or a preset already configured with sess.'
                  : 'Show the linked issue in this workspace’s status bar.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {kind !== 'attach' && (
            <div className="space-y-2">
              <Label htmlFor="relay-name">{kind === 'ticket' ? 'Ticket ID or URL' : 'Name'}</Label>
              <Input
                id="relay-name"
                autoFocus
                required={kind !== 'repo' && kind !== 'ticket'}
                placeholder={
                  kind === 'ticket'
                    ? workspace?.ticket || 'ENG-123 or https://linear.app/…'
                    : kind === 'repo'
                      ? 'Optional repository name'
                      : 'Name'
                }
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}
          {kind === 'workspace' && (
            <div className="space-y-2">
              <Label htmlFor="relay-ticket">Linear ticket ID or URL (optional)</Label>
              <Input
                id="relay-ticket"
                value={ticket}
                onChange={(e) => setTicket(e.target.value)}
                placeholder="ENG-123 or https://linear.app/…"
              />
              <p className="text-xs text-muted-foreground">
                Verified using Linear CLI on {host}. Its live status appears below your workspace.
              </p>
            </div>
          )}
          {kind === 'ticket' && (
            <p className="text-xs text-muted-foreground">
              Verified using Linear CLI on {host}. Clear the ID to detach.
            </p>
          )}
          {kind === 'host' && (
            <>
              <Label htmlFor="relay-ssh">SSH alias</Label>
              <Input id="relay-ssh" value={ssh} onChange={(e) => setSsh(e.target.value)} required />
              <Label htmlFor="relay-root">Host folder</Label>
              <Input
                id="relay-root"
                value={root}
                onChange={(e) => setRoot(e.target.value)}
                required
              />
            </>
          )}
          {kind === 'repo' && (
            <>
              <Label htmlFor="relay-path">Existing path on {host}</Label>
              <div className="flex gap-2">
                <Input
                  id="relay-path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/path/to/repository"
                />
                {host === 'local' && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      void window.relay.chooseDirectory().then((value) => {
                        if (value) {
                          setPath(value)
                        }
                      })
                    }
                  >
                    Browse
                  </Button>
                )}
              </div>
              <Label htmlFor="relay-url">Or clone from GitHub</Label>
              <Input
                id="relay-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="owner/repository"
              />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={utility}
                  onCheckedChange={(value) => setUtility(value === true)}
                />
                Shared utility repository (no worktrees)
              </label>
            </>
          )}
          {(kind === 'workspace' || kind === 'attach') && (
            <div className="space-y-3">
              {kind === 'workspace' && (
                <p className="text-xs text-muted-foreground">
                  Leave all unchecked for a blank workspace.
                </p>
              )}
              {snapshot.repos
                .filter(
                  (repo) =>
                    !repo.utility &&
                    !workspace?.repos.some((r) => kind === 'attach' && r.id === repo.id)
                )
                .map((repo) => (
                  <div key={repo.id} className="space-y-2 rounded-md border p-3">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={!!selected[repo.id]}
                        onCheckedChange={(checked) =>
                          setSelected((previous) => {
                            const next = { ...previous }
                            if (checked) {
                              next[repo.id] = { branch: '', mode: 'new' }
                            } else {
                              delete next[repo.id]
                            }
                            return next
                          })
                        }
                      />
                      {repo.name}
                    </label>
                    {selected[repo.id] && (
                      <div className="flex gap-2">
                        <Select
                          value={selected[repo.id].mode}
                          onValueChange={(mode) =>
                            setSelected({ ...selected, [repo.id]: { ...selected[repo.id], mode } })
                          }
                        >
                          <SelectTrigger className="w-36">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="new">New branch</SelectItem>
                            <SelectItem value="existing">Existing branch</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          aria-label={`Branch for ${repo.name}`}
                          placeholder={
                            selected[repo.id].mode === 'new'
                              ? 'Automatic task branch'
                              : 'Branch name'
                          }
                          value={selected[repo.id].branch}
                          onChange={(e) =>
                            setSelected({
                              ...selected,
                              [repo.id]: { ...selected[repo.id], branch: e.target.value }
                            })
                          }
                        />
                      </div>
                    )}
                  </div>
                ))}
              {snapshot.repos.filter((r) => !r.utility).length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Add repositories first, or start blank.
                </p>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button disabled={busy}>{busy ? 'Working…' : titles[kind]}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
