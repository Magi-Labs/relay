import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { spawnProcess } from '../../shared/child-process/run-process'
import type { Host, Snapshot } from '../../shared/relay/types'
export const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const bootstrap = `import sys,json,os,tempfile
from pathlib import Path
p=json.loads(sys.stdin.buffer.raw.readline())
r=Path(p['root']).expanduser().resolve()
old=r.with_name('magi')
if r.name=='relay' and not r.exists() and old.exists() and not old.is_symlink():
    old.rename(r);old.symlink_to(r,target_is_directory=True)
d=r/'utils'/'relay'
previous=r/'utils'/'magi'
if old.is_symlink() and old.resolve()==r and previous.exists() and not previous.is_symlink() and not d.exists():
    previous.rename(d);previous.symlink_to(d,target_is_directory=True)
d.mkdir(parents=True,exist_ok=True)
for name,content in p['files'].items():
    with tempfile.NamedTemporaryFile(mode='w',dir=d,delete=False) as f:
        f.write(content)
        temporary=f.name
    os.replace(temporary,d/name)
os.execv(sys.executable,[sys.executable,'-u',str(d/'relay.py'),'--root',str(r),'--rpc'])`
export const sshOptions = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=8',
  '-o',
  'ServerAliveInterval=5',
  '-o',
  'ServerAliveCountMax=2'
]
class HostClient {
  private child: ReturnType<typeof spawnProcess>
  private pending: {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }[] = []
  private error = ''
  dead = false
  constructor(root: string, resources: string, host?: Host) {
    this.child = spawnProcess(
      host
        ? {
            program: 'ssh',
            args: [...sshOptions, '--', host.ssh, `python3 -u -c ${quote(bootstrap)}`],
            stdio: 'pipe'
          }
        : {
            program: 'python3',
            args: ['-u', join(resources, 'relay.py'), '--root', root, '--rpc'],
            stdio: 'pipe'
          }
    )
    this.child.on('error', (error) => this.fail(error))
    this.child.stdin?.on('error', (error) => this.fail(error))
    this.child.on('exit', () =>
      this.fail(new Error(this.error || 'Host disconnected; session state is unverifiable.'))
    )
    this.child.stderr?.on('data', (data) => {
      this.error = (this.error + data).slice(-4096)
    })
    if (!this.child.stdout || !this.child.stdin) {
      throw new Error('Host pipes unavailable')
    }
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const next = this.pending.shift()
      if (!next) {
        return
      }
      clearTimeout(next.timer)
      try {
        const reply = JSON.parse(line)
        if (!reply.ok) {
          next.reject(new Error(reply.error))
        } else {
          next.resolve(reply.data)
        }
      } catch {
        next.reject(new Error('Invalid host response'))
      }
    })
    if (host) {
      this.child.stdin.write(
        `${JSON.stringify({
          root: host.root,
          files: Object.fromEntries(
            ['relay.py', 'RELAY-CLI.md'].map((name) => [
              name,
              readFileSync(join(resources, name), 'utf8')
            ])
          )
        })}\n`
      )
    }
  }
  request<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.dead) {
      return Promise.reject(new Error('Host disconnected'))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('Host request timed out; inspect host before retrying mutations.'))
        this.child.kill()
      }, 180_000)
      // SAFETY: only the typed desktop bridge consumes backend JSON replies.
      this.pending.push({ resolve: (value) => resolve(value as T), reject, timer })
      this.child.stdin?.write(`${JSON.stringify({ op, args })}\n`)
    })
  }
  private fail(error: Error): void {
    this.dead = true
    for (const next of this.pending.splice(0)) {
      clearTimeout(next.timer)
      next.reject(error)
    }
  }
  close(): void {
    this.fail(new Error('Relay closed'))
    this.child.kill()
  }
}
export class Hosts {
  private clients = new Map<string, HostClient>()
  constructor(
    private root: string,
    private resources: string
  ) {}
  async resolve(name: string): Promise<Host | undefined> {
    if (name === 'local') {
      return undefined
    }
    const snapshot = await this.request<Snapshot>('local', 'snapshot')
    const host = [...snapshot.hosts, ...snapshot.sessRemotes].find((h) => h.name === name)
    if (!host) {
      throw new Error(`Unknown host: ${name}`)
    }
    return host
  }
  // Only the execution host can say a shell ended; losing the attach alone proves nothing.
  endState(name: string, workspace: string, terminal: string): Promise<'exited' | 'unverifiable'> {
    return this.request<{ state: string }>(name, 'terminal_state', { workspace, terminal }).then(
      (result) => (result.state === 'exited' ? 'exited' : 'unverifiable'),
      () => 'unverifiable'
    )
  }
  async request<T>(name: string, op: string, args?: Record<string, unknown>): Promise<T> {
    const channel = op === 'integrations' ? `${name}:integrations` : name
    let client = this.clients.get(channel)
    if (!client || client.dead) {
      const host = await this.resolve(name)
      client = this.clients.get(channel)
      if (!client || client.dead) {
        client = new HostClient(this.root, this.resources, host)
        this.clients.set(channel, client)
      }
    }
    const result = await client.request<T>(op, args)
    if ((op === 'host_update' || op === 'host_remove') && typeof args?.name === 'string') {
      this.forget(args.name)
    }
    return result
  }
  // Drops cached connections so edited SSH settings take effect on the next request.
  forget(name: string): void {
    for (const channel of [name, `${name}:integrations`]) {
      this.clients.get(channel)?.close()
      this.clients.delete(channel)
    }
  }
  close(): void {
    for (const client of this.clients.values()) {
      client.close()
    }
  }
}
