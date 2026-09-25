import { useCallback, useEffect, useState } from 'react'
type Navigation = {
  host: string
  workspaces: Record<string, string>
  terminals: Record<string, string>
}
function read(): Navigation {
  try {
    const data = JSON.parse(localStorage.getItem('relay.navigation') || '{}')
    const strings = (value: unknown): Record<string, string> =>
      Object.fromEntries(
        Object.entries(value && typeof value === 'object' ? value : {})
          .filter(([, v]) => typeof v === 'string')
          .slice(-200)
      )
    return {
      host: typeof data.host === 'string' ? data.host : 'local',
      workspaces: strings(data.workspaces),
      terminals: strings(data.terminals)
    }
  } catch {
    return { host: 'local', workspaces: {}, terminals: {} }
  }
}
export function useNavigation() {
  const [state, set] = useState(read)
  useEffect(() => localStorage.setItem('relay.navigation', JSON.stringify(state)), [state])
  const host = state.host,
    workspaceId = state.workspaces[host] || 'genral',
    key = JSON.stringify([host, workspaceId])
  const validate = useCallback(
    (target: string, ids: string[]) =>
      set((s) =>
        ids.includes(s.workspaces[target] || 'genral')
          ? s
          : { ...s, workspaces: { ...s.workspaces, [target]: 'genral' } }
      ),
    []
  )
  return {
    validate,
    host,
    workspaceId,
    terminalId: state.terminals[key] || '',
    select: (target: string, workspace: string, terminal?: string) =>
      set((s) => ({
        ...s,
        host: target,
        workspaces: { ...s.workspaces, [target]: workspace },
        terminals: terminal
          ? { ...s.terminals, [JSON.stringify([target, workspace])]: terminal }
          : s.terminals
      })),
    setHost: (host: string) => set((s) => ({ ...s, host })),
    setTerminalId: (id: string) => set((s) => ({ ...s, terminals: { ...s.terminals, [key]: id } }))
  }
}
