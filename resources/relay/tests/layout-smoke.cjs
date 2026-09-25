const { _electron: electron } = require('playwright')
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os')
const { execFileSync } = require('node:child_process')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-layout-qa-'))
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
  const key = (key, shift = false) =>
    app.evaluate(
      ({ BrowserWindow }, { key, shift }) => {
        const w = BrowserWindow.getAllWindows()[0],
          modifiers = [
            process.platform === 'darwin' ? 'meta' : 'control',
            ...(shift ? ['shift'] : [])
          ]
        w.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
        w.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
      },
      { key, shift }
    )
  const panes = (count) =>
    p.waitForFunction(
      (count) =>
        [...document.querySelectorAll('[data-pane]')].filter(
          (n) => n.closest('[aria-hidden]')?.getAttribute('aria-hidden') !== 'true'
        ).length === count,
      count
    )
  const owner = (id) =>
    execFileSync('tmux', ['list-panes', '-a', '-F', '#{session_name}|#{pane_pid}'])
      .toString()
      .split('\n')
      .find((r) => r.startsWith(`relay-${id}|`))
  const drag = async (from, to) => {
    const a = await from.boundingBox(),
      b = await to.boundingBox()
    await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await p.mouse.down()
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
    await p.mouse.up()
    await p.waitForTimeout(80) // dnd-kit suppresses the click that ends a pointer drag for 50 ms.
  }
  try {
    await p
      .locator('[data-host="local"]')
      .getByRole('button', { name: /^Genral/ })
      .waitFor()
    const a = (await request('workspace_create', { name: 'Split test' })).workspace
    const b = (await request('workspace_create', { name: 'Order test' })).workspace
    await p.reload()
    await p.getByRole('button', { name: 'Split test', exact: true }).click()
    await p.waitForFunction(() =>
      document.activeElement?.classList.contains('xterm-helper-textarea')
    )
    const original = owner(a.terminals[0].id)
    await key('d')
    await panes(2)
    await key('d', true)
    await panes(3)
    const ws = (await request('snapshot')).workspaces.find((w) => w.id === a.id)
    const tree = ws.layouts[a.terminals[0].id]
    if (tree.axis !== 'columns' || tree.second.axis !== 'rows') {
      throw new Error('Split direction or nesting incorrect')
    }
    if (original !== owner(a.terminals[0].id)) {
      throw new Error('Split restarted original session')
    }
    const boxes = await p.locator('[data-pane]:visible').evaluateAll((nodes) =>
      nodes.map((n) => {
        const b = n.getBoundingClientRect()
        return { width: b.width, height: b.height, x: b.x, y: b.y }
      })
    )
    if (
      !(
        boxes[0].height > boxes[1].height * 1.8 &&
        boxes[2].y > boxes[1].y &&
        boxes[1].x > boxes[0].x
      )
    ) {
      throw new Error('Nested pane geometry incorrect')
    }
    if (process.env.RELAY_QA_OUTPUT) {
      await p.screenshot({ path: path.join(process.env.RELAY_QA_OUTPUT, 'nested-splits.png') })
    }
    const divider = p.getByRole('separator', { name: 'Resize terminal split' }).first(),
      rect = await p.locator('[data-terminal-layout]:visible').boundingBox(),
      handle = await divider.boundingBox()
    await p.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 4)
    await p.mouse.down()
    await p.mouse.move(rect.x + rect.width * 0.65, handle.y + handle.height / 4, { steps: 8 })
    await p.mouse.up()
    await p.waitForFunction(
      async ({ wid, tid }) =>
        (await window.relay.request('local', 'snapshot')).workspaces.find((w) => w.id === wid)
          .layouts[tid].ratio > 0.63,
      { wid: a.id, tid: a.terminals[0].id }
    )
    await key('t')
    await panes(1)
    await drag(
      p.getByRole('button', { name: 'Reorder Terminal 4', exact: true }),
      p.getByRole('button', { name: 'Reorder Terminal 1', exact: true })
    )
    await p.waitForFunction(
      async (wid) =>
        (await window.relay.request('local', 'snapshot')).workspaces.find((w) => w.id === wid)
          .terminals[0].name === 'Terminal 4',
      a.id
    )
    await drag(
      p.getByRole('button', { name: 'Reorder Order test', exact: true }),
      p.getByRole('button', { name: 'Reorder Split test', exact: true })
    )
    await p.waitForFunction(
      async ({ a, b }) => {
        const ws = (await window.relay.request('local', 'snapshot')).workspaces
        return ws.findIndex((w) => w.id === b) < ws.findIndex((w) => w.id === a)
      },
      { a: a.id, b: b.id }
    )
    await p.getByRole('button', { name: 'Terminal 1', exact: true }).click()
    await panes(3)
    await p.locator(`[data-pane="${tree.second.second.terminal}"] .xterm-helper-textarea`).focus()
    await key('w')
    await panes(2)
    if (original !== owner(a.terminals[0].id)) {
      throw new Error('Closing sibling restarted original session')
    }
    await p.reload()
    await p.getByRole('button', { name: 'Split test', exact: true }).click()
    await p.getByRole('button', { name: 'Terminal 1', exact: true }).click()
    await panes(2)
    const persisted = (await request('snapshot')).workspaces.find((w) => w.id === a.id)
    if (
      persisted.terminals[0].name !== 'Terminal 4' ||
      persisted.layouts[a.terminals[0].id].ratio < 0.63
    ) {
      throw new Error('Order or geometry not persisted')
    }
    await p.getByRole('button', { name: 'Settings', exact: true }).click()
    await p.getByRole('dialog', { name: 'Settings' }).waitFor()
    if (!(await p.getByRole('button', { name: 'Update from GitHub', exact: true }).isDisabled())) {
      throw new Error('Development build must not attempt production update')
    }
    const update = await p.evaluate(() => window.relay.getUpdate())
    if (update.releaseUrl !== 'https://github.com/DeepakSilaych/relay/releases') {
      throw new Error('Incorrect release source')
    }
    if (process.env.RELAY_QA_OUTPUT) {
      await p.screenshot({ path: path.join(process.env.RELAY_QA_OUTPUT, 'relay-settings.png') })
    }
    if (errors.length) {
      throw new Error(errors.join('\n'))
    }
    console.log(
      'PASS: nested splits, pane focus and resize, live session continuity, pane close, actual tab/workspace drag ordering, reload persistence, Settings and dev updater guard.'
    )
  } catch (error) {
    console.error(await p.locator('body').innerText())
    console.error(await request('snapshot'))
    throw error
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
