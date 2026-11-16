import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { Host, Snapshot } from '../../../shared/relay/types'
export function useHostSnapshots(
  revision: number,
  refresh: () => void,
  validate: (host: string, ids: string[]) => void,
  setError: Dispatch<SetStateAction<string>>
) {
  const [hosts, setHosts] = useState<Host[]>([])
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({})
  const [hostErrors, setHostErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const snapshotsRef = useRef(snapshots)
  snapshotsRef.current = snapshots
  const sequence = useRef<Record<string, number>>({})
  useEffect(() => {
    let active = true
    setLoading(!Object.keys(snapshotsRef.current).length)
    setError('')
    // Per-host sequence numbers let each host render as soon as it answers without stale overwrites.
    const load = (name: string) => {
      const seq = (sequence.current[name] = (sequence.current[name] || 0) + 1)
      return window.relay.request<Snapshot>(name, 'snapshot').then(
        (result) => {
          if (sequence.current[name] !== seq) {
            return
          }
          setSnapshots((previous) => ({ ...previous, [name]: result }))
          setHostErrors(({ [name]: _cleared, ...rest }) => rest)
          validate(
            name,
            result.workspaces.map((w) => w.id)
          )
          return result
        },
        (e) => {
          if (sequence.current[name] !== seq) {
            return
          }
          if (name === 'local') {
            throw e
          }
          setSnapshots(({ [name]: _removed, ...rest }) => rest)
          setHostErrors((previous) => ({ ...previous, [name]: String(e) }))
          return undefined
        }
      )
    }
    load('local')
      .then((localSnapshot) => {
        if (!active || !localSnapshot) {
          return
        }
        const remotes = [
          ...localSnapshot.hosts,
          ...localSnapshot.sessRemotes.filter(
            (h) => !localSnapshot.hosts.some((r) => r.name === h.name)
          )
        ]
        const known = (name: string) => name === 'local' || remotes.some((h) => h.name === name)
        setHosts(remotes)
        setSnapshots((previous) =>
          Object.fromEntries(Object.entries(previous).filter(([name]) => known(name)))
        )
        setHostErrors((previous) =>
          Object.fromEntries(Object.entries(previous).filter(([name]) => known(name)))
        )
        setLoading(false)
        for (const h of remotes) {
          void load(h.name)
        }
      })
      .catch((e) => {
        if (active) {
          setError(String(e))
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [revision, validate, setError])
  useEffect(() => {
    // CLI commands, agents and other windows edit host state directly; reload when it moves.
    let checking = false
    const check = async () => {
      if (checking || document.visibilityState !== 'visible') {
        return
      }
      checking = true
      try {
        const current = Object.entries(snapshotsRef.current).filter(([, s]) => s.fingerprint)
        const changed = await Promise.all(
          current.map(([name, s]) =>
            window.relay
              .request<{ fingerprint: string }>(name, 'changes')
              .then((r) => r.fingerprint !== s.fingerprint)
              .catch(() => true)
          )
        )
        if (changed.some(Boolean)) {
          refresh()
        }
      } finally {
        checking = false
      }
    }
    const timer = setInterval(() => void check(), 2000)
    const onFocus = () => void check()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [refresh])

  return { hosts, snapshots, setSnapshots, snapshotsRef, hostErrors, loading }
}
