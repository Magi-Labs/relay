import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  RelayApi,
  TerminalEvent,
  WorkspaceShortcut,
  UpdateState
} from '../../shared/relay/types'
const api: RelayApi = {
  dropFiles: (host, workspace, terminal, files) =>
    ipcRenderer.invoke(
      'relay:drop-files',
      host,
      workspace,
      terminal,
      files.map((file) => webUtils.getPathForFile(file))
    ),
  copyText: (text) => ipcRenderer.invoke('relay:copy', text),
  readClipboardText: () => ipcRenderer.invoke('relay:clipboard-read'),
  getUpdate: () => ipcRenderer.invoke('relay:update:get'),
  runUpdate: () => ipcRenderer.invoke('relay:update:run'),
  onUpdate: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, state: UpdateState): void =>
      listener(state)
    ipcRenderer.on('relay:update', callback)
    return () => ipcRenderer.removeListener('relay:update', callback)
  },
  onShortcut: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, shortcut: WorkspaceShortcut): void =>
      listener(shortcut)
    ipcRenderer.on('relay:shortcut', callback)
    return () => ipcRenderer.removeListener('relay:shortcut', callback)
  },
  request: (host, op, args) => ipcRenderer.invoke('relay:request', host, op, args),
  attach: (host, workspace, terminal, cols, rows) =>
    ipcRenderer.invoke('relay:attach', host, workspace, terminal, cols, rows),
  write: (key, data) => ipcRenderer.send('relay:write', key, data),
  resize: (key, cols, rows) => ipcRenderer.send('relay:resize', key, cols, rows),
  detach: (key) => ipcRenderer.send('relay:detach', key),
  onTerminal: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, event: TerminalEvent): void =>
      listener(event)
    ipcRenderer.on('relay:terminal', callback)
    return () => ipcRenderer.removeListener('relay:terminal', callback)
  },
  chooseDirectory: () => ipcRenderer.invoke('relay:directory'),
  openExternal: (url) => ipcRenderer.invoke('relay:external', url)
}
contextBridge.exposeInMainWorld('relay', api)
