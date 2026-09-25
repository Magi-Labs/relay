import { createContext, useContext, useState } from 'react'
import type { Workspace, Session } from '../../../shared/relay/types'
import type { FormKind } from './forms'
import { copyPath, command, type Action } from './action-menu'
import { SessionConfirmation } from './session-confirmation'
type Menus = {
  workspace: (w: Workspace, host?: string) => Action[]
  terminal: (w: Workspace, t: Session, host?: string) => Action[]
  end: (w: Workspace, t: Session, host?: string) => void
}
export const InteractionContext = createContext<Menus>({
  workspace: () => [],
  terminal: () => [],
  end: () => {}
})
export const useInteractions = () => useContext(InteractionContext)
export function useWorkspaceActions({
  host,
  workspaceId,
  refresh,
  report,
  select,
  form
}: {
  host: string
  workspaceId: string
  refresh: () => void
  report: (e: unknown) => void
  select: (host: string, workspace: string, terminal?: string) => void
  form: (kind: FormKind, host?: string) => void
}) {
  const [target, setTarget] = useState<{ workspace: Workspace; terminal?: Session; host: string }>()
  const [pending, setPending] = useState(false)
  const create = async (
    targetHost: string,
    w: Workspace,
    terminal?: Session,
    axis?: 'columns' | 'rows'
  ) => {
    setPending(true)
    try {
      const result = await window.relay.request<{ id: string }>(
        targetHost,
        terminal ? 'terminal_split' : 'terminal_new',
        { workspace: w.id, terminal: terminal?.id, axis }
      )
      select(targetHost, w.id, result.id)
      refresh()
    } finally {
      setPending(false)
    }
  }
  const menus: Menus = {
    end: (workspace, terminal, targetHost) =>
      setTarget({ workspace, terminal, host: targetHost || host }),
    workspace: (w, targetHost) => {
      const h = targetHost || host
      return [
        {
          label: 'New terminal',
          disabled: pending,
          shortcut: `${command}T`,
          run: () => create(h, w)
        },
        {
          label: 'Attach repositories',
          run: () => {
            select(h, w.id)
            form('attach', h)
          }
        },
        { label: 'Copy workspace path', run: () => copyPath(w.path) },
        {
          label: 'Archive workspace',
          danger: true,
          disabled: pending || !!w.permanent,
          run: () => setTarget({ workspace: w, host: h })
        }
      ]
    },
    terminal: (w, t, targetHost) => {
      const h = targetHost || host
      return [
        {
          label: 'Split side by side',
          disabled: pending,
          shortcut: `${command}D`,
          run: () => create(h, w, t, 'columns')
        },
        {
          label: 'Split above/below',
          disabled: pending,
          shortcut: `${command}⇧D`,
          run: () => create(h, w, t, 'rows')
        },
        {
          label: 'Copy current path',
          run: async () => {
            const result = await window.relay.request<{ path: string }>(h, 'terminal_cwd', {
              workspace: w.id,
              terminal: t.id
            })
            await copyPath(result.path)
          }
        },
        {
          label: 'End terminal session',
          danger: true,
          run: () => setTarget({ workspace: w, terminal: t, host: h })
        }
      ]
    }
  }
  return {
    menus,
    pending,
    confirming: !!target,
    dialog: target && (
      <SessionConfirmation
        kind={target.terminal ? 'terminal' : 'archive'}
        name={target.terminal?.name || target.workspace.name}
        busy={pending}
        close={() => setTarget(undefined)}
        confirm={async () => {
          setPending(true)
          try {
            await window.relay.request(
              target.host,
              target.terminal ? 'terminal_remove' : 'workspace_archive',
              { workspace: target.workspace.id, terminal: target.terminal?.id }
            )
            if (!target.terminal && target.workspace.id === workspaceId && target.host === host) {
              select(target.host, 'genral')
            }
            refresh()
            setTarget(undefined)
          } catch (e) {
            report(e)
          } finally {
            setPending(false)
          }
        }}
      />
    )
  }
}
