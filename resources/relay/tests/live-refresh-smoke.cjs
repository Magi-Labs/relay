const { _electron: electron } = require('playwright')
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os')
const { execFileSync } = require('node:child_process')
// Changes made outside the UI (CLI, agents) must appear without a reload; ended shells offer Close tab.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-refresh-qa-'))
;(async () => {
  const app = await electron.launch({
    executablePath: process.env.RELAY_EXECUTABLE || require('electron'),
    args: process.env.RELAY_EXECUTABLE ? [] : ['.'],
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      RELAY_ROOT: path.join(fixture, 'root'),
      RELAY_USER_DATA_PATH: path.join(fixture, 'profile')
    }
  })
  const p = await app.firstWindow(),
    errors = []
  p.on('pageerror', (e) => errors.push(String(e)))
  const request = (op, args = {}) =>
    p.evaluate(({ op, args }) => window.relay.request('local', op, args), { op, args })
  const cli = (...args) =>
    execFileSync(
      'python3',
      ['resources/relay/backend/relay.py', '--root', path.join(fixture, 'root'), ...args],
      { env: { ...process.env, RELAY_WORKSPACE: '' } }
    )
  const tabs = () => p.locator('[aria-label^="End session"]').count()
  const sidebarHas = (name, present = true) =>
    p.waitForFunction(
      ({ name, present }) =>
        [...document.querySelectorAll('button')].some((b) =>
          b.textContent.trim().startsWith(name)
        ) === present,
      { name, present },
      { timeout: 8000 }
    )
  try {
    await p
      .locator('[data-host="local"]')
      .getByRole('button', { name: /^Genral/ })
      .waitFor()
    await p.getByRole('button', { name: 'New workspace in Local' }).click()
    await p.locator('#relay-name').fill('UI made')
    await p.getByRole('dialog').getByRole('button', { name: 'New workspace' }).click()
    await sidebarHas('UI made')
    const shown = (await request('snapshot')).workspaces.find((w) => w.name === 'UI made')
    cli('--workspace', shown.id, 'terminal', 'new', '--name', 'Agent tab')
    await p.getByText('Agent tab', { exact: true }).waitFor({ timeout: 8000 })
    const made = JSON.parse(cli('workspace', 'create', 'CLI made', '--json')).data.workspace
    await sidebarHas('CLI made')
    cli('--workspace', made.id, 'workspace', 'rename', '--name', 'CLI renamed')
    await sidebarHas('CLI renamed')
    cli('--workspace', made.id, 'workspace', 'archive')
    await sidebarHas('CLI renamed', false)
    const agent = (await request('snapshot')).workspaces
      .find((w) => w.id === shown.id)
      .terminals.find((t) => t.name === 'Agent tab')
    await p.getByText('Agent tab', { exact: true }).click()
    await p.waitForTimeout(2000)
    cli(
      '--workspace',
      shown.id,
      'terminal',
      'send',
      '--terminal',
      agent.id,
      '--input-text',
      'exit',
      '--enter'
    )
    await p.getByText('This session has ended.').waitFor({ timeout: 8000 })
    const before = await tabs()
    await p.getByRole('button', { name: 'Close tab' }).click()
    await p.waitForFunction(
      (n) => document.querySelectorAll('[aria-label^="End session"]').length === n - 1,
      before,
      { timeout: 8000 }
    )
    if (errors.length) {
      throw new Error(errors.join('\n'))
    }
    console.log('live refresh smoke passed')
  } finally {
    await app.close()
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
