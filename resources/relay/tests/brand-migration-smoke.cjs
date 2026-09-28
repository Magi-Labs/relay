const { _electron } = require('playwright'),
  { expect } = require('playwright/test')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process')
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-migration-qa-')))
const launch = (executablePath, legacy = false) =>
  _electron.launch({
    executablePath,
    args: [],
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      MAGI_ROOT: `${fixture}/Magi`,
      RELAY_ROOT: legacy ? undefined : `${fixture}/Relay`,
      MAGI_USER_DATA_PATH: `${fixture}/profile`,
      RELAY_USER_DATA_PATH: `${fixture}/profile`
    }
  })
;(async () => {
  let app, p
  const request = (op, args = {}) =>
    p.evaluate(({ op, args }) => (window.relay || window.magi).request('local', op, args), {
      op,
      args
    })
  try {
    app = await launch('/Applications/Magi.app/Contents/MacOS/Magi', true)
    p = await app.firstWindow()
    await p.locator('.xterm-helper-textarea:visible').waitFor()
    await p.getByRole('button', { name: 'New workspace in Local', exact: true }).click()
    await p.getByLabel('Name', { exact: true }).fill('Preserved task')
    await p.getByRole('dialog').getByRole('button', { name: 'New workspace', exact: true }).click()
    await p.getByRole('button', { name: 'Preserved task', exact: true }).waitFor()
    const ws = (await request('snapshot')).workspaces.find((w) => w.name === 'Preserved task')
    const session = `=magi-${ws.terminals[0].id}:`
    const owner = () =>
      execFileSync('tmux', ['display-message', '-p', '-t', session, '#{pane_pid}'], {
        encoding: 'utf8'
      }).trim()
    await expect
      .poll(() => {
        try {
          return owner()
        } catch {
          return ''
        }
      })
      .not.toBe('')
    const pid = owner()
    await app.close()
    app = undefined
    expect(owner()).toBe(pid)
    app = await launch(process.env.RELAY_EXECUTABLE)
    p = await app.firstWindow()
    await p.locator('.xterm-helper-textarea:visible').waitFor()
    await expect(p).toHaveTitle('Relay')
    const restored = (await request('snapshot')).workspaces.find((w) => w.id === ws.id)
    expect(restored.path).toBe(ws.path.replace(`${fixture}/Magi`, `${fixture}/Relay`))
    expect(fs.lstatSync(`${fixture}/Magi`).isSymbolicLink()).toBe(true)
    expect(restored.terminals[0].id).toBe(ws.terminals[0].id)
    expect(owner()).toBe(pid)
    const installed = await request('install_cli')
    expect(path.basename(installed.path)).toBe('relay')
    expect(fs.readFileSync(installed.path, 'utf8')).toBe(
      fs.readFileSync(path.join(path.dirname(installed.path), 'magi'), 'utf8')
    )
    console.log(
      'PASS: Magi to Relay migrates storage and preserves workspace IDs, terminal owner process and legacy CLI alias; window title is Relay.'
    )
  } finally {
    if (app) {
      for (const w of (await request('snapshot')).workspaces) {
        for (const t of w.terminals) {
          await request('terminal_remove', { workspace: w.id, terminal: t.id })
        }
      }
      await app.close()
    }
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
