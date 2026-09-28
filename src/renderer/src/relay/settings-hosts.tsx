import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import type { Host } from '../../../shared/relay/types'

export function HostSettings({
  hosts,
  sessHosts,
  openAdd,
  remove
}: {
  hosts: Host[]
  sessHosts: Host[]
  openAdd: () => void
  remove: (name: string) => Promise<void>
}) {
  const [confirming, setConfirming] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const rows = [
    ...hosts.map((host) => ({ host, managed: true })),
    ...sessHosts.map((host) => ({ host, managed: false }))
  ]
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Hosts</Label>
        <Button size="sm" variant="outline" onClick={openAdd}>
          Add host…
        </Button>
      </div>
      {rows.map(({ host, managed }) => (
        <div
          key={host.name}
          data-host-row={host.name}
          className="flex items-center justify-between gap-3"
        >
          <span className="min-w-0 flex-1 truncate text-sm">
            {host.name}
            <span className="ml-2 text-xs text-muted-foreground">{host.ssh}</span>
          </span>
          {managed ? (
            confirming === host.name ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => setConfirming('')}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    setError('')
                    try {
                      await remove(host.name)
                      setConfirming('')
                    } catch (e) {
                      setError(String(e))
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  Remove
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirming(host.name)}>
                Remove
              </Button>
            )
          ) : (
            <span className="text-xs text-muted-foreground">From sess</span>
          )}
        </div>
      ))}
      {confirming && (
        <p className="text-sm text-muted-foreground">
          Remove host {confirming}? Its workspaces and sessions stay on the machine.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
