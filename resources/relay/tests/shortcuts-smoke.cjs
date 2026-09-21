const { _electron: electron } = require('playwright')
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-shortcut-qa-'))
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
  const p = await app.firstWindow()
  const errors = []
  p.on('pageerror', (e) => errors.push(String(e)))
  const request = (op, args = {}) =>
    p.evaluate(({ op, args }) => window.relay.request('local', op, args), { op, args })
  const key = async (k) => {
    await app.evaluate(({ BrowserWindow }, key) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: key.replace('Arrow', ''),
        modifiers: [process.platform === 'darwin' ? 'meta' : 'control']
      })
      w.webContents.sendInputEvent({
        type: 'keyUp',
        keyCode: key.replace('Arrow', ''),
        modifiers: [process.platform === 'darwin' ? 'meta' : 'control']
      })
    }, k)
  }
  const selected = async (name) => {
    await p.waitForFunction(
      (name) =>
        [...document.querySelectorAll('button[aria-selected=true]')].some(
          (b) => b.textContent === name
        ),
      name
    )
  }
  try {
    await p.getByRole('button', { name: /^Genral/ }).waitFor()
    const a = (await request('workspace_create', { name: 'Alpha' })).workspace
    await request('terminal_new', { workspace: a.id, name: 'Second' })
    await request('workspace_create', { name: 'Beta' })
    await p.reload()
    await selected('Genral')
    await key('ArrowDown')
    await selected('Alpha')
    await key('ArrowDown')
    await selected('Beta')
    await key('ArrowDown')
    await selected('Genral')
    await key('ArrowUp')
    await selected('Beta')
    await key('ArrowUp')
    await selected('Alpha')
    await p.locator('.xterm-helper-textarea:visible').focus()
    await key('ArrowRight')
    await p.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent === 'Second' && b.className.includes('border-b-2')
      )
    )
    await key('ArrowRight')
    await p.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent === 'Terminal 1' && b.className.includes('border-b-2')
      )
    )
    await key('ArrowLeft')
    await p.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent === 'Second' && b.className.includes('border-b-2')
      )
    )
    await key('w')
    await p.getByRole('button', { name: 'Second', exact: true }).waitFor({ state: 'detached' })
    await key('w')
    await p.getByRole('button', { name: 'Terminal 1', exact: true }).waitFor({ state: 'detached' })
    if (!(await request('snapshot')).workspaces.some((w) => w.id === a.id)) {
      throw new Error('Workspace closed with final terminal')
    }
    await key('w')
    await p.getByRole('button', { name: 'Alpha', exact: true }).waitFor({ state: 'detached' })
    await p.getByRole('button', { name: /^Genral/ }).click()
    await key('w')
    await p.getByRole('button', { name: 'Terminal 1', exact: true }).waitFor({ state: 'detached' })
    await key('w')
    if (!(await request('snapshot')).workspaces.some((w) => w.id === 'genral' && w.permanent)) {
      throw new Error('Genral removed')
    }
    await key('n')
    await p.getByRole('dialog').waitFor()
    await key('t')
    if ((await request('snapshot')).workspaces.find((w) => w.id === 'genral').terminals.length) {
      throw new Error('Terminal created behind workspace dialog')
    }
    await p.getByLabel('Name', { exact: true }).fill('Shortcut workspace')
    await p.getByRole('dialog').getByRole('button', { name: 'New workspace', exact: true }).click()
    await selected('Shortcut workspace')
    await p.getByRole('dialog').waitFor({ state: 'detached' })
    await p.locator('.xterm-helper-textarea:visible').focus()
    await key('t')
    await p.getByRole('button', { name: 'Terminal 2', exact: true }).waitFor()
    await p.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent === 'Terminal 2' && b.className.includes('border-b-2')
      )
    )
    await p.locator('.xterm-helper-textarea:visible').focus()
    await key('t')
    await p.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent === 'Terminal 3' && b.className.includes('border-b-2')
      )
    )
    const created = (await request('snapshot')).workspaces.find(
      (w) => w.name === 'Shortcut workspace'
    )
    if (created.terminals.length !== 3) {
      throw new Error('New terminal shortcut did not create exactly one terminal')
    }
    await p.getByRole('button', { name: 'Beta', exact: true }).click()
    await selected('Beta')
    if (await p.getByRole('textbox', { name: 'Rename workspace' }).count()) {
      throw new Error('First workspace click must only select')
    }
    await p.getByRole('button', { name: 'Beta', exact: true }).click()
    const workspaceName = p.getByRole('textbox', { name: 'Rename workspace' })
    await workspaceName.fill('Renamed workspace')
    if (process.env.RELAY_QA_OUTPUT) {
      await p.screenshot({ path: path.join(process.env.RELAY_QA_OUTPUT, 'rename-workspace.png') })
    }
    await workspaceName.press('Enter')
    await selected('Renamed workspace')
    await p.getByRole('button', { name: 'Renamed workspace', exact: true }).click()
    await workspaceName.fill('Cancelled workspace')
    await workspaceName.press('Escape')
    await selected('Renamed workspace')
    await p.getByRole('button', { name: 'Terminal 1', exact: true }).click()
    const terminalName = p.getByRole('textbox', { name: 'Rename terminal' })
    await terminalName.fill('Agent renamed')
    if (process.env.RELAY_QA_OUTPUT) {
      await p.screenshot({ path: path.join(process.env.RELAY_QA_OUTPUT, 'rename-terminal.png') })
    }
    await key('w')
    await terminalName.press('Enter')
    await p.getByRole('button', { name: 'Agent renamed', exact: true }).waitFor()
    const persisted = (await request('snapshot')).workspaces.find(
      (w) => w.name === 'Renamed workspace'
    )
    if (persisted.terminals.length !== 1 || persisted.terminals[0].name !== 'Agent renamed') {
      throw new Error('Terminal rename did not persist or shortcut closed editing session')
    }
    await p.getByRole('button', { name: 'Agent renamed', exact: true }).click()
    await terminalName.fill('   ')
    await terminalName.press('Enter')
    await p.getByRole('alert').filter({ hasText: 'Enter a name.' }).waitFor()
    await terminalName.press('Escape')
    await p.reload()
    await p.getByRole('button', { name: 'Renamed workspace', exact: true }).click()
    await p.getByRole('button', { name: 'Agent renamed', exact: true }).waitFor()
    if (errors.length) {
      throw new Error(errors.join('\n'))
    }
    console.log(
      'PASS: actual Cmd-arrow navigation and wrapping; terminal focus; Cmd-W closes individual terminals, then empty workspace; Genral protected; Cmd-N workspace creation; Cmd-T terminal creation and dialog guard; inline workspace and terminal rename, cancellation, validation, and reload persistence; window remains open.'
    )
  } finally {
    const snap = await request('snapshot')
    for (const w of snap.workspaces) {
      for (const t of w.terminals) {
        await request('terminal_remove', { workspace: w.id, terminal: t.id })
      }
    }
    await app.close()
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
