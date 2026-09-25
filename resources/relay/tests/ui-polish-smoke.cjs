const { _electron } = require('playwright')
const { execFileSync } = require('node:child_process')
const { expect } = require('playwright/test')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-polish-qa-'))
;(async () => {
  const app = await _electron.launch({
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
  const row = (name) =>
    p
      .locator('[data-host="local"] button.relay-row')
      .filter({ has: p.locator('[data-rename-label]', { hasText: name }) })
  const menu = async (locator, name) => {
    await locator.click({ button: 'right' })
    await p.getByRole('menuitem', { name, exact: true }).click()
  }
  const key = (k) =>
    app.evaluate(({ BrowserWindow }, key) => {
      const w = BrowserWindow.getAllWindows()[0],
        modifiers = [process.platform === 'darwin' ? 'meta' : 'control']
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
      w.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
    }, k)
  try {
    await row('Genral').waitFor()
    await row('Genral').click({ button: 'right' })
    await expect(
      p.getByRole('menuitem', { name: 'Archive workspace', exact: true })
    ).toHaveAttribute('aria-disabled', 'true')
    await p.keyboard.press('Escape')
    const a = (await request('workspace_create', { name: 'Polish Alpha' })).workspace
    const b = (await request('workspace_create', { name: 'Polish Beta' })).workspace
    fs.mkdirSync(path.join(a.path, 'folder'), { recursive: true })
    fs.writeFileSync(
      path.join(a.path, 'folder', 'notes.md'),
      Array.from({ length: 500 }, (_, i) => `Line ${i + 1}`).join('\n')
    )
    fs.writeFileSync(path.join(a.path, 'other.txt'), 'Second file')
    fs.symlinkSync('folder/notes.md', path.join(a.path, 'alias.md'))
    await p.reload()
    await row('Polish Alpha').waitFor()
    await menu(row('Polish Alpha'), 'New terminal')
    await expect(row('Polish Alpha')).toHaveAttribute('aria-selected', 'true')
    await p.getByRole('button', { name: 'Terminal 2', exact: true }).waitFor()
    expect((await request('snapshot')).workspaces.find((w) => w.id === a.id).terminals.length).toBe(
      2
    )
    await menu(p.getByRole('button', { name: 'Terminal 2', exact: true }), 'Rename terminal')
    const rename = p.getByRole('textbox', { name: 'Rename terminal' })
    await rename.fill('Agent pane')
    await rename.press('Enter')
    await p.getByRole('button', { name: 'Agent pane', exact: true }).waitFor()
    await p.getByRole('button', { name: 'End session Agent pane', exact: true }).click()
    await expect(p.getByRole('dialog')).toContainText('Agent pane')
    await p.getByRole('button', { name: 'Cancel', exact: true }).click()
    await p.evaluate(() => {
      window.qa = {}
    })
    await app.evaluate(({ clipboard }) => {
      global.copies = []
      clipboard.writeText = (text) => global.copies.push(text)
    })
    await menu(row('Polish Beta'), 'Copy workspace path')
    expect(await app.evaluate(() => global.copies)).toEqual([b.path])
    const from = await row('Polish Beta').boundingBox(),
      to = await row('Polish Alpha').boundingBox()
    await p.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await p.mouse.down()
    await p.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 })
    await p.mouse.up()
    await expect
      .poll(async () => (await request('snapshot')).workspaces.map((w) => w.name))
      .toEqual(['Genral', 'Polish Beta', 'Polish Alpha'])
    await menu(row('Polish Beta'), 'Archive workspace')
    await p.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(row('Polish Beta')).toHaveCount(0)
    await expect(row('Polish Alpha')).toHaveAttribute('aria-selected', 'true')
    await p.getByRole('tab', { name: 'Files', exact: true }).click()
    await p.getByRole('button', { name: 'folder', exact: true }).click()
    await p.evaluate(() => {
      window.qa.terminal = document.querySelector(
        '[data-cached-terminal][aria-hidden=false] .xterm'
      )
    })
    await p.getByRole('button', { name: 'notes.md', exact: true }).click()
    await expect(p.locator('.monaco-editor')).toBeVisible()
    await expect(p.getByText('Saved', { exact: true })).toBeVisible()
    expect(await p.evaluate(() => window.qa.terminal.isConnected)).toBe(true)
    const tab = p.locator('main').getByRole('button', { name: 'notes.md', exact: true })
    await p.getByRole('button', { name: 'alias.md', exact: true }).click()
    await expect(p.locator('main button[aria-label^="Close "]')).toHaveCount(1)
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await p.locator('.monaco-editor').hover()
    await p.mouse.wheel(0, 900)
    const savedScroll = () =>
      p.evaluate(() => {
        const key = Object.keys(localStorage).find((k) => k.startsWith('relay.editor:'))
        return key ? JSON.parse(localStorage.getItem(key)).top : 0
      })
    await expect.poll(savedScroll).toBeGreaterThan(0)
    const visibleLine = () =>
      p.evaluate(() => {
        const node = document.querySelector('.monaco-editor')
        if (!node) {
          return undefined
        }
        const editor = node.getBoundingClientRect()
        return [...document.querySelectorAll('.line-numbers')].find((n) => {
          const r = n.getBoundingClientRect()
          return r.y >= editor.y && r.y < editor.bottom
        })?.textContent
      })
    const scrolledLine = await visibleLine()

    await menu(tab, 'Reveal in file tree')
    await expect(p.locator('aside button[aria-current=page]')).toHaveAttribute(
      'title',
      path.join(a.path, 'folder', 'notes.md')
    )
    await p.getByRole('button', { name: 'Refresh repositories', exact: true }).click()
    await expect(p.getByRole('button', { name: 'folder', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    await p.getByRole('button', { name: 'other.txt', exact: true }).click()
    await p.locator('main').getByRole('button', { name: 'other.txt', exact: true }).waitFor()
    await key('w')
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await p.reload()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(row('Polish Alpha')).toHaveAttribute('aria-selected', 'true')
    await expect.poll(visibleLine).toBe(scrolledLine)
    await p.getByRole('button', { name: 'Agent pane', exact: true }).click()
    await p.getByRole('button', { name: 'All tabs', exact: true }).click()
    await p.getByRole('menuitem', { name: 'Terminal: Terminal 1', exact: true }).click()
    await expect(p.getByRole('button', { name: 'Terminal 1', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await p.getByRole('button', { name: '0 repos · 0 changes', exact: true }).click()
    await expect(p.getByRole('tab', { name: 'Source control', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    // Force overflow without starting the additional sessions.
    for (let i = 0; i < 10; i++) {
      await request('terminal_new', { workspace: a.id, name: `Extra terminal ${i}` })
    }
    await p.getByRole('button', { name: 'Refresh repositories', exact: true }).click()
    await p.getByRole('button', { name: 'All tabs', exact: true }).click()
    await p.getByRole('menuitem', { name: 'Terminal: Extra terminal 9', exact: true }).click()
    await expect(p.getByRole('button', { name: 'Extra terminal 9', exact: true })).toBeInViewport()
    await expect(p.getByRole('button', { name: 'New terminal', exact: true })).toBeInViewport()
    expect(await p.locator('[data-cached-terminal]').count()).toBeLessThanOrEqual(3)
    const identityTerminal = (await request('snapshot')).workspaces
      .find((w) => w.id === a.id)
      .terminals.find((t) => t.name === 'Extra terminal 9')
    const identityKey = JSON.stringify(['local', a.id, identityTerminal.id])
    await p.evaluate(
      (key) => window.relay.write(key, "bash -c 'exec -a codex sleep 60'\r"),
      identityKey
    )
    await expect
      .poll(async () => (await request('status', { workspace: a.id })).agents[identityTerminal.id])
      .toBe('codex')
    await p.getByRole('button', { name: 'Refresh repositories', exact: true }).click()
    await expect(p.locator('main [data-agent="codex"]').first()).toBeVisible()
    await p.evaluate((key) => window.relay.write(key, '\x03'), identityKey)
    await expect
      .poll(async () => (await request('status', { workspace: a.id })).agents[identityTerminal.id])
      .toBe(null)
    await p.getByRole('button', { name: 'Refresh repositories', exact: true }).click()
    await expect(p.locator('main [data-agent="codex"]')).toHaveCount(0)
    const source = path.join(fixture, 'source')
    fs.mkdirSync(source)
    const git = (...args) => execFileSync('git', ['-C', source, ...args], { stdio: 'pipe' })
    git('init', '-b', 'main')
    git('config', 'user.email', 'qa@example.test')
    git('config', 'user.name', 'Relay QA')
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'original')
    git('add', '.')
    git('commit', '-m', 'initial')
    const registered = await request('repo_register', { name: 'qa-repo', path: source })
    const attached = await request('repo_attach', {
      workspace: a.id,
      repo: registered.id,
      new_branch: 'ui-polish'
    })
    fs.writeFileSync(path.join(attached.path, 'tracked.txt'), 'changed')
    await p.getByRole('button', { name: 'Refresh repositories', exact: true }).click()
    const changed = p
      .locator('aside button')
      .filter({ has: p.locator('span', { hasText: /^tracked.txt$/ }) })
      .first()
    await changed.waitFor()
    await menu(changed, 'Stage file')
    await expect
      .poll(async () => (await request('status', { workspace: a.id })).repos[0].files[0].index)
      .toBe('M')
    await p.getByRole('button', { name: 'Unstage tracked.txt', exact: true }).waitFor()
    await menu(changed, 'Open diff')
    await expect(p.locator('.monaco-diff-editor')).toBeVisible()
    await menu(changed, 'Unstage file')
    await expect
      .poll(async () => (await request('status', { workspace: a.id })).repos[0].files[0].index)
      .toBe('.')
    const diffTab = p
      .locator('main')
      .getByRole('button', { name: 'tracked.txt · staged diff', exact: true })
    await menu(diffTab, 'Close other files')
    await expect(p.locator('main button[aria-label^="Close "]')).toHaveCount(1)
    await expect(p.getByRole('menu')).toHaveCount(0)
    if (process.env.RELAY_QA_OUTPUT) {
      await p.screenshot({ path: path.join(process.env.RELAY_QA_OUTPUT, 'v023-ui.png') })
    }
    expect(errors).toEqual([])
    console.log(
      'PASS: whole workspace row drag; protected and targeted menus; rename and explicit end-session dialog; clipboard routing; file/terminal continuity; tree highlight/reveal/refresh; neighboring file close; navigation and file-tab restoration; tab overflow; source-control shortcut; bounded cache.'
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
