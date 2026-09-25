const { readFileSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { execFileSync } = require('node:child_process')
const { build, Platform, Arch } = require('electron-builder')
const { parse } = require('yaml')
const root = resolve(__dirname, '../..')
const config = parse(readFileSync(resolve(root, 'config/electron-builder.relay.yml'), 'utf8'))
execFileSync(process.execPath, [resolve(root, 'config/scripts/fetch-sess.cjs'), 'darwin-arm64'], {
  stdio: 'inherit'
})
const projectDir = resolve(root, config.directories.app)
config.directories = { app: projectDir, output: resolve(root, config.directories.output) }
config.mac.icon = resolve(root, config.mac.icon)
config.mac.entitlements = resolve(root, config.mac.entitlements)
config.mac.entitlementsInherit = resolve(root, config.mac.entitlementsInherit)
config.afterSign = ({ appOutDir, packager }) => {
  const app = join(appOutDir, `${packager.appInfo.productFilename}.app`)
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
config.extraResources = config.extraResources.map((resource) => ({
  ...resource,
  from: resolve(root, resource.from)
}))
config.electronVersion = require('electron/package.json').version
build({
  projectDir,
  config,
  targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64),
  publish: 'never'
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
