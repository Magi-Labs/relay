import type { Dispatch, SetStateAction } from 'react'
import type { Workspace, Session, Snapshot } from '../../../shared/relay/types'
import type { OpenFile } from './editor'
export async function closeActiveTab({
  file,
  workspace,
  terminal,
  host,
  snapshot,
  setFile,
  setBusy,
  updateSnapshot,
  setTerminalId,
  selectWorkspace
}: {
  file?: OpenFile
  workspace?: Workspace
  terminal?: Session
  host: string
  snapshot?: Snapshot
  setFile: Dispatch<SetStateAction<OpenFile | undefined>>
  setBusy: Dispatch<SetStateAction<boolean>>
  updateSnapshot: (host: string, snapshot: Snapshot) => void
  setTerminalId: (id: string) => void
  selectWorkspace: (host: string, id: string) => void
}) {
  if (file) {
    setFile(undefined)
    return
  }
  if (!workspace || (!terminal && workspace.permanent)) {
    return
  }
  setBusy(true)
  try {
    await window.relay.request(host, terminal ? 'terminal_remove' : 'workspace_archive', {
      workspace: workspace.id,
      ...(terminal ? { terminal: terminal.id } : {})
    })
    const next = await window.relay.request<Snapshot>(host, 'snapshot')
    updateSnapshot(host, next)
    if (terminal) {
      const remaining = next.workspaces.find((w) => w.id === workspace.id)?.terminals || []
      const index = workspace.terminals.findIndex((t) => t.id === terminal.id)
      const sibling = remaining.find((t) => (t.tab_id || t.id) === (terminal.tab_id || terminal.id))
      setTerminalId(sibling?.id || remaining[Math.min(index, remaining.length - 1)]?.id || '')
    } else {
      const index = snapshot?.workspaces.findIndex((w) => w.id === workspace.id) || 0
      selectWorkspace(
        host,
        next.workspaces[Math.min(index, next.workspaces.length - 1)]?.id || 'genral'
      )
    }
  } finally {
    setBusy(false)
  }
}
