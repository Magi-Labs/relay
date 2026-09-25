import { useEffect, useState } from 'react'
import type { Snapshot, Workspace } from '../../../shared/relay/types'
export type HostSection = {
  host: string
  label: string
  workspaces: Workspace[]
  error?: string
}
export type HostRow = { host: string; workspace: Workspace }
export type SidebarState = { order: string[]; collapsed: Record<string, boolean> }
const storageKey = 'relay.sidebar'
export function readSidebarState(): SidebarState {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) || '{}')
    const order = Array.isArray(data.order)
      ? data.order.filter((value: unknown): value is string => typeof value === 'string')
      : []
    const collapsed: Record<string, boolean> = {}
    const saved = data.collapsed && typeof data.collapsed === 'object' ? data.collapsed : {}
    for (const [name, value] of Object.entries(saved)) {
      if (typeof value === 'boolean') {
        collapsed[name] = value
      }
    }
    return { order, collapsed }
  } catch {
    return { order: [], collapsed: {} }
  }
}
export function orderHosts(names: string[], order: string[]): string[] {
  const rank = new Map(order.map((name, index) => [name, index]))
  return [...names].sort((a, b) => (rank.get(a) ?? order.length) - (rank.get(b) ?? order.length))
}
export function hostLabel(host: string): string {
  return host === 'local' ? 'Local' : host
}
export function visibleSections(
  names: string[],
  snapshots: Record<string, Snapshot | undefined>,
  errors: Record<string, string>,
  query: string
): HostSection[] {
  const needle = query.trim().toLowerCase()
  return names
    .map((host) => ({
      host,
      label: hostLabel(host),
      workspaces: (snapshots[host]?.workspaces || []).filter((w) =>
        w.name.toLowerCase().includes(needle)
      ),
      ...(errors[host] ? { error: errors[host] } : {})
    }))
    .filter((section) => !needle || section.workspaces.length > 0)
}
export const flattenWorkspaces = (sections: HostSection[]): HostRow[] =>
  sections.flatMap((section) =>
    section.workspaces.map((workspace) => ({ host: section.host, workspace }))
  )
export function useHostSections(names: string[]) {
  const [state, set] = useState(readSidebarState)
  useEffect(() => localStorage.setItem(storageKey, JSON.stringify(state)), [state])
  return {
    order: orderHosts(names, state.order),
    collapsed: state.collapsed,
    reorder: (ids: string[]) => set((s) => ({ ...s, order: ids })),
    toggle: (host: string) =>
      set((s) => ({ ...s, collapsed: { ...s.collapsed, [host]: !s.collapsed[host] } }))
  }
}
