import { useCallback, useEffect, useState } from 'react'
import type { Integrations, RepoStatus } from '../../../shared/relay/types'

export type WorkspaceTelemetry = {
  statuses: RepoStatus[]
  agents: Record<string, string | null>
  integrations: Integrations | undefined
  reset: () => void
}

export function useWorkspaceTelemetry(
  host: string,
  workspace: { id: string } | undefined,
  revision: number,
  report: (error: unknown) => void
): WorkspaceTelemetry {
  const [statuses, setStatuses] = useState<RepoStatus[]>([])
  const [agents, setAgents] = useState<Record<string, string | null>>({})
  const [integrations, setIntegrations] = useState<Integrations>()
  useEffect(() => {
    if (!workspace) {
      return
    }
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await window.relay.request<{
          repos: RepoStatus[]
          agents?: Record<string, string | null> | null
        }>(host, 'status', {
          workspace: workspace.id
        })
        if (active) {
          setStatuses(result.repos)
          setAgents(result.agents || {})
        }
      } catch (e) {
        if (active) {
          report(e)
        }
      } finally {
        if (active) {
          timer = setTimeout(() => {
            if (document.visibilityState === 'visible') {
              void poll()
            } else {
              timer = setTimeout(poll, 5000)
            }
          }, 5000)
        }
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [host, workspace, revision, report])
  useEffect(() => {
    if (!workspace) {
      return
    }
    let active = true
    setIntegrations(undefined)
    const load = () =>
      window.relay
        .request<Integrations>(host, 'integrations', { workspace: workspace.id })
        .then((value) => {
          if (active) {
            setIntegrations(value)
          }
        })
        .catch(() => {
          if (active) {
            setIntegrations(undefined)
          }
        })
    void load()
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void load()
      }
    }, 60000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [host, workspace])
  const reset = useCallback(() => {
    setStatuses([])
    setAgents({})
    setIntegrations(undefined)
  }, [])
  return { statuses, agents, integrations, reset }
}
