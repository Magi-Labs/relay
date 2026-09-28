import { app, clipboard, ipcMain } from 'electron'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

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
  ipcMain.handle('relay:clipboard-image', (event) => {
    authorize(event)
    if (clipboard.readBuffer('public.file-url').length) {
      return null // a copied file carries an icon image; not an image copy
    }
    const image = clipboard.readImage()
    if (image.isEmpty()) {
      return null
    }
    const now = new Date()
    const pad = (value: number) => String(value).padStart(2, '0')
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} at ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`
    const file = join(app.getPath('temp'), `Pasted image ${stamp}.png`)
    writeFileSync(file, image.toPNG())
    return file
  })
}
