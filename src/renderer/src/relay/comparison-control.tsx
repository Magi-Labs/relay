import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { RepoStatus } from '../../../shared/relay/types'
export function ComparisonControl({
  repo,
  host,
  workspace,
  refresh,
  report
}: {
  repo: RepoStatus
  host: string
  workspace: string
  refresh: () => void
  report: (error: unknown) => void
}) {
  const [value, setValue] = useState(repo.comparison_ref || 'auto')
  const [busy, setBusy] = useState(false)
  useEffect(() => setValue(repo.comparison_ref || 'auto'), [repo.comparison_ref])
  return (
    <form
      className="space-y-1 px-3 pb-2"
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        try {
          await window.relay.request(host, 'repo_compare', {
            workspace,
            repo: repo.id,
            comparison_ref: value.trim() || 'auto'
          })
          refresh()
        } catch (error) {
          report(error)
        } finally {
          setBusy(false)
        }
      }}
    >
      <label className="text-xs text-muted-foreground" htmlFor={`compare-${repo.id}`}>
        Compare working tree against
      </label>
      <div className="flex gap-1">
        <Input
          id={`compare-${repo.id}`}
          aria-label={`Comparison ref for ${repo.name}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="dev, main, commit or auto"
        />
        <Button size="sm" variant="outline" disabled={busy}>
          Apply
        </Button>
      </div>
      <p
        className={`text-xs ${repo.comparison?.error ? 'text-destructive' : 'text-muted-foreground'}`}
        role={repo.comparison?.error ? 'alert' : undefined}
      >
        {repo.comparison?.error ||
          (repo.comparison
            ? `${repo.comparison.files.length} changed · vs ${repo.comparison.ref}`
            : 'Loading comparison…')}
      </p>
    </form>
  )
}
