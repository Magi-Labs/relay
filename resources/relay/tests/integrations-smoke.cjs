const { _electron } = require('playwright'),
  { expect } = require('playwright/test')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-integrations-qa-'))
fs.mkdirSync(`${fixture}/bin`)
fs.writeFileSync(
  `${fixture}/bin/linear`,
  `#!/usr/bin/env python3
import json,sys
if sys.argv[1:] != ['issue','view','ENG-123','--json','--no-comments']: sys.exit(1)
print(json.dumps({'identifier':'ENG-123','title':'Checkout regression','url':'https://linear.app/acme/issue/ENG-123','state':{'name':'In Progress','color':'#f2c94c'}}))
`,
  { mode: 0o755 }
)
;(async () => {
  const app = await _electron.launch({
    executablePath: process.env.RELAY_EXECUTABLE || require('electron'),
    args: process.env.RELAY_EXECUTABLE ? [] : ['.'],
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      RELAY_ROOT: `${fixture}/root`,
      RELAY_USER_DATA_PATH: `${fixture}/profile`,
      PATH: `${fixture}/bin:${process.env.PATH}`
    }
  })
  const p = await app.firstWindow()
  const request = (op, args = {}) =>
    p.evaluate(({ op, args }) => window.relay.request('local', op, args), { op, args })
  try {
    await p.locator('[data-host="local"]').waitFor()
    await p.locator('.xterm-helper-textarea:visible').waitFor()
    await p.getByRole('button', { name: 'New workspace', exact: true }).click()
    await p.getByLabel('Name', { exact: true }).fill('Linked task')
    await p
      .getByLabel('Linear ticket ID or URL (optional)')
      .fill('https://linear.app/acme/issue/ENG-123/checkout?source=copy')
    await p.getByRole('button', { name: 'New workspace', exact: true }).last().click()
    await expect(p.locator('footer')).toContainText('ENG-123 · In Progress')
    await expect(
      p.locator('footer').getByRole('img', { name: 'In Progress', exact: true })
    ).toBeVisible()
    await expect(
      p.locator('footer').getByRole('img', { name: 'In Progress', exact: true })
    ).toHaveCSS('color', 'rgb(242, 201, 76)')
    const ws = (await request('snapshot')).workspaces.find((w) => w.name === 'Linked task')
    expect(ws.ticket).toBe('ENG-123')
    await p.getByRole('button', { name: 'Ticket actions' }).click()
    await p.getByRole('menuitem', { name: 'Edit attached ticket' }).click()
    await expect(p.getByLabel('Ticket ID or URL')).toHaveValue('ENG-123')
    await p.getByLabel('Ticket ID or URL').fill('ENG-404')
    await p.getByRole('button', { name: 'Attach Linear ticket', exact: true }).click()
    await expect(p.getByRole('alert')).toContainText('Linear could not load this issue')
    expect((await request('snapshot')).workspaces.find((w) => w.id === ws.id).ticket).toBe(
      'ENG-123'
    )
    await p.getByLabel('Ticket ID or URL').fill('')
    await p.getByRole('button', { name: 'Attach Linear ticket', exact: true }).click()
    await expect(p.locator('footer')).toContainText('Attach ticket')
    expect((await request('snapshot')).workspaces.find((w) => w.id === ws.id).ticket).toBeNull()
    console.log(
      'PASS: optional ticket during workspace creation, CLI-verified attachment, live status, prefilled edit, failure preservation and detach.'
    )
  } finally {
    for (const w of (await request('snapshot')).workspaces) {
      for (const t of w.terminals) {
        await request('terminal_remove', { workspace: w.id, terminal: t.id })
      }
    }
    await app.close()
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
