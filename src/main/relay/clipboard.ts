import { clipboard, ipcMain } from 'electron'

export function installClipboardIpc(
  authorize: (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => void
): void {
  ipcMain.handle('relay:copy', (event, text: string) => {
    authorize(event)
    if (typeof text !== 'string' || text.length > 8 * 1024 * 1024) {
      throw new Error('Clipboard text is too large')
    }
    clipboard.writeText(text)
  })
  ipcMain.handle('relay:clipboard-read', (event) => {
    authorize(event)
    return clipboard.readText()
  })
}
