import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../../shared/relay/types'
const releaseUrl = 'https://github.com/DeepakSilaych/relay/releases'
export function createUpdates(publish: (state: UpdateState) => void) {
  const supported =
    app.isPackaged &&
    (process.platform !== 'darwin' ||
      JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')).relayAutoUpdate ===
        true)
  let state: UpdateState = {
    phase: supported ? 'idle' : 'unsupported',
    version: app.isPackaged ? app.getVersion() : '0.3.3-dev',
    message:
      app.isPackaged && !supported
        ? 'This build is not Developer ID-signed. Install updates from View releases; automatic installation requires a signed build.'
        : app.isPackaged
          ? 'Updates come from Relay releases on GitHub.'
          : 'This is a development build. Install a Relay release to enable updates.',
    releaseUrl
  }
  let running = false
  const update = (values: Partial<UpdateState>) => {
    state = { ...state, ...values }
    publish(state)
  }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false
  autoUpdater.setFeedURL({ provider: 'github', owner: 'DeepakSilaych', repo: 'relay' })
  autoUpdater.on('error', (error) => update({ phase: 'error', message: error.message }))
  autoUpdater.on('download-progress', (progress) =>
    update({ phase: 'downloading', percent: progress.percent, message: 'Downloading update…' })
  )
  return {
    get: () => state,
    run: async () => {
      if (running || !supported) {
        return state
      }
      running = true
      try {
        update({ phase: 'checking', message: 'Checking GitHub releases…', percent: undefined })
        const result = await autoUpdater.checkForUpdates()
        if (!result || !result.isUpdateAvailable) {
          update({ phase: 'current', message: 'Relay is up to date.' })
          return state
        }
        // Never install an upstream Orca artifact from the fork's release history.
        if (
          !result.updateInfo.files.length ||
          result.updateInfo.files.some(
            (file) => !decodeURIComponent(file.url.split('/').pop() || '').startsWith('Relay-')
          )
        ) {
          throw new Error('This release does not contain Relay update artifacts.')
        }
        update({ phase: 'downloading', message: 'Downloading update…', percent: 0 })
        await autoUpdater.downloadUpdate()
        update({ phase: 'restarting', message: 'Restarting Relay to install the update…' })
        setImmediate(() => autoUpdater.quitAndInstall(false, true))
      } catch (error) {
        update({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
      } finally {
        running = false
      }
      return state
    }
  }
}
