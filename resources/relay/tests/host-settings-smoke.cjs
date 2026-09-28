const { _electron } = require('playwright')
const { expect } = require('playwright/test')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hosts-qa-'))
;(async () => {
  const app = await _electron.launch({
    executablePath: process.env.RELAY_EXECUTABLE || require('electron'),
    args: process.env.RELAY_EXECUTABLE ? [] : ['.'],
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      RELAY_ROOT: `${fixture}/root`,
      RELAY_USER_DATA_PATH: `${fixture}/profile`
    }
  })
  const p = await app.firstWindow()
  p.on('pageerror', (error) => console.error('Renderer:', error.message))
  const request = (host, op, args = {}) =>
    p.evaluate(({ host, op, args }) => window.relay.request(host, op, args), { host, op, args })
  const hostNames = async () => (await request('local', 'snapshot')).hosts.map((h) => h.name)
  try {
    await p.locator('.xterm-helper-textarea:visible').waitFor()
    await request('local', 'host_add', { name: 'Doomed', ssh: 'local-vm', root: '~/relay' })
    await p.reload()
    await p.locator('[data-host="Doomed"]').waitFor()
    // Hosts are managed from Settings only: no sidebar add control.
    expect(
      await p.locator('aside').getByRole('button', { name: 'Add host', exact: true }).count()
    ).toBe(0)
    await p.getByRole('button', { name: 'Settings', exact: true }).click()
    await p.getByRole('dialog', { name: 'Settings' }).waitFor()
    await p.locator('[data-host-row="Doomed"]').waitFor()
    // Remove is a confirmed two-step action.
    await p.locator('[data-host-row="Doomed"]').getByRole('button', { name: 'Remove' }).click()
    await p.locator('[data-host-row="Doomed"]').getByRole('button', { name: 'Remove' }).click()
    await expect.poll(hostNames, { timeout: 15000 }).not.toContain('Doomed')
    await expect.poll(() => p.locator('[data-host="Doomed"]').count()).toBe(0)
    // Adding reuses the shared host form, opened from Settings.
    await p.getByRole('button', { name: /Add host/ }).click()
    await p.getByRole('dialog', { name: 'Add host' }).waitFor()
    await p.locator('#relay-name').fill('Freshhost')
    await p.locator('#relay-ssh').fill('local-vm')
    await p.locator('#relay-root').press('Enter')
    await expect.poll(hostNames, { timeout: 15000 }).toContain('Freshhost')
    await p.locator('[data-host-row="Freshhost"]').waitFor()
    await p.locator('[data-host="Freshhost"]').waitFor()
    // Close Settings: modal dialogs mark outside content aria-hidden (sidebar rows included).
    await p.keyboard.press('Escape')
    await p.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'hidden' })
    // Each workspace row carries its own add-terminal button.
    const terminalCount = async () =>
      (await request('local', 'snapshot')).workspaces.flatMap((w) => w.terminals).length
    const before = await terminalCount()
    await p
      .locator('[data-host="local"]')
      .getByRole('button', { name: 'New terminal in Genral', exact: true })
      .click()
    await expect.poll(terminalCount, { timeout: 15000 }).toBe(before + 1)
    console.log(
      'PASS: hosts are added and removed from Settings only; removal is confirmed inline and drops the sidebar section; adding reuses the shared host form; each workspace row carries its own add-terminal button.'
    )
  } finally {
    console.log('Host feedback:', await p.getByRole('alert').allTextContents())
    for (const ws of (await request('local', 'snapshot')).workspaces)
      for (const t of ws.terminals)
        await request('local', 'terminal_remove', { workspace: ws.id, terminal: t.id })
    await app.close()
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
