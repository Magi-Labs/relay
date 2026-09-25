import { terminalTabs } from '../../../shared/relay/types'
import { useEffect, useRef } from 'react'
import type { Session, Workspace } from '../../../shared/relay/types'

export function useWorkspaceShortcuts(options: {
  disabled: boolean
  host: string
  workspaces: { host: string; workspace: Workspace }[]
  workspace?: Workspace
  terminal?: Session
  selectWorkspace: (host: string, id: string) => void
  selectTerminal: (id: string) => void
  newWorkspace: () => void
  newTerminal: () => Promise<void>
  split: (axis: 'columns' | 'rows') => Promise<void>
  closeTab: () => Promise<void>
  report: (error: unknown) => void
}) {
  const pending = useRef(false)
  useEffect(
    () =>
      window.relay.onShortcut((shortcut) => {
        if (
          options.disabled ||
          pending.current ||
          document.querySelector('[data-relay-renaming]')
        ) {
          return
        }
        if (shortcut === 'split-right' || shortcut === 'split-down') {
          if (!options.terminal) {
            return
          }
          pending.current = true
          void options
            .split(shortcut === 'split-right' ? 'columns' : 'rows')
            .catch(options.report)
            .finally(() => {
              pending.current = false
            })
          return
        }
        if (shortcut === 'new-workspace') {
          options.newWorkspace()
          return
        }
        if (shortcut === 'new-terminal' && !options.workspace) {
          return
        }
        if (shortcut === 'close-tab' || shortcut === 'new-terminal') {
          pending.current = true
          const action = shortcut === 'new-terminal' ? options.newTerminal : options.closeTab
          void action()
            .catch(options.report)
            .finally(() => {
              pending.current = false
            })
          return
        }
        if (shortcut.endsWith('workspace')) {
          const rows = options.workspaces
          if (!rows.length) {
            return
          }
          const index = rows.findIndex(
            (row) => row.host === options.host && row.workspace.id === options.workspace?.id
          )
          const offset = shortcut.startsWith('previous') ? -1 : 1
          const next = rows[(Math.max(0, index) + offset + rows.length) % rows.length]
          options.selectWorkspace(next.host, next.workspace.id)
          return
        }
        const items = terminalTabs(options.workspace?.terminals || [])
        if (!items.length) {
          return
        }
        const currentTab = options.terminal?.tab_id || options.terminal?.id
        const index = items.findIndex((item) => (item.tab_id || item.id) === currentTab)
        const offset = shortcut.startsWith('previous') ? -1 : 1
        const next = items[(Math.max(0, index) + offset + items.length) % items.length]
        options.selectTerminal(next.id)
      }),
    [options]
  )
}
