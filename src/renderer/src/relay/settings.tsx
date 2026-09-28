import { UpdateSettings } from './update-settings'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { HostSettings } from './settings-hosts'
import type { Host } from '../../../shared/relay/types'
export type Appearance = { theme: string; fontSize: number; compact: boolean }
export function RelaySettings({
  value,
  update,
  hosts,
  sessHosts,
  openAddHost,
  removeHost,
  close
}: {
  value: Appearance
  update: (value: Appearance) => void
  hosts: Host[]
  sessHosts: Host[]
  openAddHost: () => void
  removeHost: (name: string) => Promise<void>
  close: () => void
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          close()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Hosts, appearance, and application updates.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <Label>Theme</Label>
            <Select value={value.theme} onValueChange={(theme) => update({ ...value, theme })}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="font-size">Terminal font size</Label>
            <Input
              id="font-size"
              className="w-24"
              type="number"
              min={10}
              max={22}
              value={value.fontSize}
              onChange={(e) =>
                update({
                  ...value,
                  fontSize: Math.max(10, Math.min(22, Number(e.target.value) || 13))
                })
              }
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="compact">Compact sidebar rows</Label>
            <Switch
              id="compact"
              checked={value.compact}
              onCheckedChange={(compact) => update({ ...value, compact })}
            />
          </div>
        </div>
        <HostSettings
          hosts={hosts}
          sessHosts={sessHosts}
          openAdd={openAddHost}
          remove={removeHost}
        />
        <UpdateSettings />
      </DialogContent>
    </Dialog>
  )
}

export function readAppearance(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem('relay.appearance') || '{}')
    return {
      theme: saved.theme === 'light' ? 'light' : 'dark',
      fontSize: Math.max(10, Math.min(22, Number(saved.fontSize) || 13)),
      compact: saved.compact === true
    }
  } catch {
    return { theme: 'dark', fontSize: 13, compact: false }
  }
}
