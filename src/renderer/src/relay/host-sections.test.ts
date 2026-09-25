import { describe, expect, it } from 'vitest'
import {
  flattenWorkspaces,
  hostLabel,
  orderHosts,
  visibleSections,
  type HostSection
} from './host-sections'
import type { Snapshot, Workspace } from '../../../shared/relay/types'
const workspace = (id: string, name: string): Workspace => ({
  id,
  name,
  path: `/w/${id}`,
  repos: [],
  terminals: [],
  ticket: null
})
const snapshot = (workspaces: Workspace[]): Snapshot => ({
  root: '/root',
  hosts: [],
  sessRemotes: [],
  repos: [],
  workspaces,
  tools: {},
  errors: []
})
describe('orderHosts', () => {
  it('appends unknown hosts after saved ones, keeping discovery order', () => {
    expect(orderHosts(['a', 'b', 'c'], ['c'])).toEqual(['c', 'a', 'b'])
    expect(orderHosts(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c'])
    expect(orderHosts(['a', 'b', 'c'], ['b', 'a'])).toEqual(['b', 'a', 'c'])
  })
  it('ignores saved names that no longer exist', () => {
    expect(orderHosts(['a'], ['gone', 'a'])).toEqual(['a'])
  })
})
describe('visibleSections', () => {
  const snapshots = {
    local: snapshot([workspace('genral', 'Genral'), workspace('api', 'API work')]),
    'dev-vm': snapshot([workspace('genral', 'Genral'), workspace('rfq', 'Sidecar-RFQ')])
  }
  it('groups workspaces per host', () => {
    const sections = visibleSections(['local', 'dev-vm'], snapshots, {}, '')
    expect(sections.map((s) => s.host)).toEqual(['local', 'dev-vm'])
    expect(sections[0].workspaces.map((w) => w.id)).toEqual(['genral', 'api'])
    expect(sections[1].workspaces.map((w) => w.id)).toEqual(['genral', 'rfq'])
  })
  it('filters workspaces across hosts and hides empty sections', () => {
    const sections = visibleSections(['local', 'dev-vm'], snapshots, {}, 'rfq')
    expect(sections.map((s) => s.host)).toEqual(['dev-vm'])
    expect(sections[0].workspaces.map((w) => w.id)).toEqual(['rfq'])
  })
  it('keeps an unreachable host visible with its error', () => {
    const sections = visibleSections(
      ['local', 'down'],
      snapshots,
      { down: 'Connection refused' },
      ''
    )
    const down = sections.find((s) => s.host === 'down')
    expect(down?.workspaces).toEqual([])
    expect(down?.error).toBe('Connection refused')
  })
  it('labels the local host', () => {
    expect(hostLabel('local')).toBe('Local')
    expect(hostLabel('dev-vm')).toBe('dev-vm')
  })
})
describe('flattenWorkspaces', () => {
  it('flattens in host order for cross-host navigation', () => {
    const sections: HostSection[] = [
      { host: 'local', label: 'Local', workspaces: [workspace('one', 'One')] },
      { host: 'dev-vm', label: 'dev-vm', workspaces: [workspace('two', 'Two')] }
    ]
    expect(flattenWorkspaces(sections)).toEqual([
      {
        host: 'local',
        workspace: {
          id: 'one',
          name: 'One',
          path: '/w/one',
          repos: [],
          terminals: [],
          ticket: null
        }
      },
      {
        host: 'dev-vm',
        workspace: {
          id: 'two',
          name: 'Two',
          path: '/w/two',
          repos: [],
          terminals: [],
          ticket: null
        }
      }
    ])
  })
})
