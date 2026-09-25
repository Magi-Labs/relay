export type Host = { name: string; ssh: string; root: string }
export type Repo = {
  id: string
  name: string
  path: string
  utility: boolean
  branch?: string
  base?: string
}
export type Session = { id: string; name: string; cwd: string; tab_id?: string }
export type PaneLayout =
  | { terminal: string }
  | { id: string; axis: 'columns' | 'rows'; ratio: number; first: PaneLayout; second: PaneLayout }
export const terminalTabs = (sessions: Session[]): Session[] =>
  sessions.filter(
    (t, i) => sessions.findIndex((s) => (s.tab_id || s.id) === (t.tab_id || t.id)) === i
  )
export type Workspace = {
  id: string
  name: string
  path: string
  repos: Repo[]
  terminals: Session[]
  layouts?: Record<string, PaneLayout>
  ticket: string | null
  permanent?: boolean
}
export type Snapshot = {
  root: string
  hosts: Host[]
  sessRemotes: Host[]
  repos: Repo[]
  workspaces: Workspace[]
  tools: Record<string, boolean>
  errors: string[]
}
export type Change = {
  path: string
  original?: string
  index: string
  worktree: string
  untracked: boolean
  conflict: boolean
}
export type Comparison = { ref: string; commit?: string; files: Change[]; error: string | null }
export type RepoStatus = Repo & {
  comparison?: Comparison
  comparison_ref?: string
  files: Change[]
  branch: string
  ahead: number
  behind: number
  error: string | null
}
export type FileEntry = { name: string; path: string; directory: boolean; symlink: boolean }
export type Integrations = {
  prs: {
    repo: string
    error: string | null
    prs: { number: number; state: string; url: string; title: string; isDraft?: boolean }[]
  }[]
  ticket: {
    id?: string
    error?: string
    issue?: {
      identifier: string
      title: string
      url: string
      state: { name: string; type?: string | null; color?: string | null }
    }
  }
}
export type TerminalEvent = {
  key: string
  data?: string
  state?: 'live' | 'unverifiable' | 'exited'
}
export type WorkspaceShortcut =
  | 'split-right'
  | 'split-down'
  | 'new-workspace'
  | 'new-terminal'
  | 'previous-workspace'
  | 'next-workspace'
  | 'previous-terminal'
  | 'next-terminal'
  | 'close-tab'
export type UpdateState = {
  phase: 'idle' | 'unsupported' | 'checking' | 'current' | 'downloading' | 'restarting' | 'error'
  version: string
  message: string
  releaseUrl: string
  percent?: number
}
export type RelayApi = {
  dropFiles: (host: string, workspace: string, terminal: string, files: File[]) => Promise<string[]>
  copyText: (text: string) => Promise<void>
  readClipboardText: () => Promise<string>
  getUpdate: () => Promise<UpdateState>
  runUpdate: () => Promise<UpdateState>
  onUpdate: (listener: (state: UpdateState) => void) => () => void
  onShortcut: (listener: (shortcut: WorkspaceShortcut) => void) => () => void
  request: <T>(host: string, op: string, args?: Record<string, unknown>) => Promise<T>
  attach: (
    host: string,
    workspace: string,
    terminal: string,
    cols: number,
    rows: number
  ) => Promise<string>
  write: (key: string, data: string) => void
  resize: (key: string, cols: number, rows: number) => void
  detach: (key: string) => void
  onTerminal: (listener: (event: TerminalEvent) => void) => () => void
  chooseDirectory: () => Promise<string | null>
  openExternal: (url: string) => Promise<void>
}
declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Browser globals require interface declaration merging.
  interface Window {
    relay: RelayApi
  }
}
