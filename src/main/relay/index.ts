import { installFileDrop } from './file-drop'
import { installClipboardIpc } from './clipboard'
import { removeInheritedNoColor } from '../pty/terminal-color-env'
import { operations } from './operations'
import { configureHomebrewPath } from './homebrew-path'
import { createUpdates } from './updates'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { relayProfile } from './storage-migration'
import { spawn, type IPty } from 'node-pty'
import { Hosts, quote, sshOptions } from './host-client'
import type { TerminalEvent, WorkspaceShortcut } from '../../shared/relay/types'
configureHomebrewPath(app.isPackaged)
const profile =
  process.env.RELAY_USER_DATA_PATH ||
  process.env.MAGI_USER_DATA_PATH ||
  relayProfile(app.getPath('appData'))
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
app.setName('Relay')
const ownsLock = app.requestSingleInstanceLock()
if (!ownsLock) {
  app.quit()
}
const root =
  process.env.RELAY_ROOT || process.env.MAGI_ROOT || join(app.getPath('documents'), 'Relay')
const resources = app.isPackaged
  ? join(process.resourcesPath, 'relay', 'backend')
  : resolve(__dirname, '../../../resources/relay/backend')
const hosts = new Hosts(root, resources)
const terminals = new Map<string, IPty>()
const generations = new Map<string, number>()
let window: BrowserWindow | undefined
const size = (value: number, maximum: number): number =>
  Math.min(maximum, Math.max(2, Math.floor(value) || 80))
const emit = (event: TerminalEvent): void => {
  if (window && !window.isDestroyed()) {
    window.webContents.send('relay:terminal', event)
  }
}
function detach(key: string): void {
  generations.set(key, (generations.get(key) || 0) + 1)
  const pty = terminals.get(key)
  terminals.delete(key)
  pty?.kill()
}
function authorize(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): void {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error('Untrusted IPC sender')
  }
}
if (ownsLock) {
  installFileDrop(hosts, authorize, (key) => terminals.has(key))
  installClipboardIpc(authorize)
  ipcMain.handle(
    'relay:request',
    (event, host: string, op: string, args?: Record<string, unknown>) => {
      authorize(event)
      if (!operations.has(op)) {
        throw new Error('Unsupported operation')
      }
      return hosts.request(host, op, args)
    }
  )
  ipcMain.handle(
    'relay:attach',
    async (
      event,
      hostName: string,
      workspace: string,
      terminal: string,
      cols: number,
      rows: number
    ) => {
      authorize(event)
      if (process.platform === 'win32') {
        throw new Error('Relay sess terminals currently require macOS or Linux.')
      }
      const key = JSON.stringify([hostName, workspace, terminal])
      detach(key)
      const generation = generations.get(key)
      const prepared = await hosts.request<{
        program: string
        args: string[]
        env: Record<string, string>
        cwd: string
      }>(hostName, 'terminal_prepare', { workspace, terminal })
      const host = await hosts.resolve(hostName)
      const command = [
        'env',
        ...Object.entries(prepared.env).map(([k, v]) => `${k}=${v}`),
        prepared.program,
        ...prepared.args
      ]
        .map(quote)
        .join(' ')
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
      removeInheritedNoColor(env)
      delete env.CI
      delete env.TMUX
      delete env.TMUX_PANE
      if (generation !== generations.get(key)) {
        throw new Error('Attachment cancelled')
      }
      const pty = spawn(
        host ? 'ssh' : prepared.program,
        host ? ['-tt', ...sshOptions, '--', host.ssh, command] : prepared.args,
        {
          name: 'xterm-256color',
          cols: size(cols, 500),
          rows: size(rows, 300),
          cwd: host ? app.getPath('home') : prepared.cwd,
          env: {
            ...env,
            ...(host ? {} : prepared.env),
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            TERM_PROGRAM: 'Relay',
            TERM_PROGRAM_VERSION: app.getVersion(),
            FORCE_HYPERLINK: '1'
          }
        }
      )
      terminals.set(key, pty)
      pty.onData((data) => emit({ key, data }))
      pty.onExit(() => {
        if (terminals.get(key) === pty) {
          terminals.delete(key)
          emit({ key, state: 'unverifiable' })
        }
      })
      emit({ key, state: 'live' })
      return key
    }
  )
  ipcMain.on('relay:write', (event, key: string, data: string) => {
    authorize(event)
    if (typeof data === 'string' && data.length <= 1024 * 1024) {
      terminals.get(key)?.write(data)
    }
  })
  ipcMain.on('relay:resize', (event, key: string, cols: number, rows: number) => {
    authorize(event)
    terminals.get(key)?.resize(size(cols, 500), size(rows, 300))
  })
  ipcMain.on('relay:detach', (event, key: string) => {
    authorize(event)
    detach(key)
  })
  ipcMain.handle('relay:directory', async (event) => {
    authorize(event)
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('relay:external', (event, url: string) => {
    authorize(event)
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Only HTTP and HTTPS links are supported')
    }
    return shell.openExternal(url)
  })
  app.on('second-instance', () => {
    if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
      window?.show()
      window?.focus()
    }
  })
  app.whenReady().then(() => {
    const updates = createUpdates((state) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send('relay:update', state)
      }
    })
    ipcMain.handle('relay:update:get', (event) => {
      authorize(event)
      return updates.get()
    })
    ipcMain.handle('relay:update:run', (event) => {
      authorize(event)
      return updates.run()
    })
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: 'Relay', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
        {
          label: 'Workspace',
          submenu: (
            [
              ['Split terminal vertically', 'CmdOrCtrl+D', 'split-right'],
              ['Split terminal horizontally', 'CmdOrCtrl+Shift+D', 'split-down'],
              ['New workspace', 'CmdOrCtrl+N', 'new-workspace'],
              ['New terminal', 'CmdOrCtrl+T', 'new-terminal'],
              ['Previous workspace', 'CmdOrCtrl+Up', 'previous-workspace'],
              ['Next workspace', 'CmdOrCtrl+Down', 'next-workspace'],
              ['Previous terminal', 'CmdOrCtrl+Left', 'previous-terminal'],
              ['Next terminal', 'CmdOrCtrl+Right', 'next-terminal'],
              ['Close tab or empty workspace', 'CmdOrCtrl+W', 'close-tab']
            ] satisfies [string, string, WorkspaceShortcut][]
          ).map(([label, accelerator, shortcut]) => ({
            label,
            accelerator,
            click: () => window?.webContents.send('relay:shortcut', shortcut)
          }))
        },
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'toggleDevTools' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { role: 'togglefullscreen' }
          ]
        },
        { role: 'windowMenu' }
      ])
    )
    window = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 900,
      minHeight: 560,
      title: 'Relay',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    window.webContents.on('before-input-event', (event, input) => {
      const modifier =
        process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
      if (
        input.type !== 'keyDown' ||
        !modifier ||
        input.alt ||
        (input.shift && input.key.toLowerCase() !== 'd')
      ) {
        return
      }
      const keys: Record<string, WorkspaceShortcut> = {
        ArrowUp: 'previous-workspace',
        ArrowDown: 'next-workspace',
        ArrowLeft: 'previous-terminal',
        ArrowRight: 'next-terminal',
        n: 'new-workspace',
        t: 'new-terminal',
        d: input.shift ? 'split-down' : 'split-right',
        w: 'close-tab'
      }
      const shortcut = keys[input.key.length === 1 ? input.key.toLowerCase() : input.key]
      if (shortcut) {
        event.preventDefault()
        if (!input.isAutoRepeat) {
          window?.webContents.send('relay:shortcut', shortcut)
        }
      }
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.once('ready-to-show', () => {
      if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
        window?.show()
      }
    })
    if (process.env.ELECTRON_RENDERER_URL) {
      void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/relay.html`)
    } else {
      void window.loadFile(join(__dirname, '../renderer/relay.html'))
    }
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    for (const key of terminals.keys()) {
      detach(key)
    }
    hosts.close()
  })
}
