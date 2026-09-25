const { _electron } = require('playwright'),
  { expect } = require('playwright/test')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-copy-qa-')),
  remoteRoot = `/tmp/${path.basename(fixture)}`
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
  const p = await app.firstWindow(),
    remote = 'Copy-VM'
  const request = (host, op, args = {}) =>
    p.evaluate(({ host, op, args }) => window.relay.request(host, op, args), { host, op, args })
  const ssh = (...args) =>
    execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'local-vm', ...args], {
      encoding: 'utf8'
    })
  const key = (key, modifiers) =>
    app.evaluate(
      ({ BrowserWindow }, { key, modifiers }) => {
        const w = BrowserWindow.getAllWindows()[0]
        w.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
        w.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
      },
      { key, modifiers }
    )
  let remoteReady = false
  try {
    await p.locator('[data-host="local"]').waitFor()
    await app.evaluate(({ clipboard, ipcMain }) => {
      global.savedClipboard = clipboard
        .availableFormats()
        .map((format) => [format, clipboard.readBuffer(format)])
      global.copies = []
      global.input = []
      const writeText = clipboard.writeText.bind(clipboard)
      clipboard.writeText = (text) => {
        global.copies.push(text)
        writeText(text)
      }
      ipcMain.on('relay:write', (_e, _key, data) => global.input.push(data))
    })
    await request('local', 'host_add', { name: remote, ssh: 'local-vm', root: remoteRoot })
    await p.reload()
    await p
      .locator(`[data-host="${remote}"]`)
      .getByRole('button', { name: /^Genral/ })
      .click()
    await p.locator('.xterm-helper-textarea:visible').waitFor()
    remoteReady = true
    const ws = (await request(remote, 'snapshot')).workspaces[0],
      t = ws.terminals[0]
    await expect
      .poll(async () => (await request(remote, 'snapshot')).workspaces[0].terminals[0].started)
      .toBe(true)
    await expect
      .poll(() => {
        try {
          return ssh(`tmux show-options -v -t 'relay-${t.id}' mouse`).trim()
        } catch {
          return 'starting'
        }
      })
      .toBe('on')
    const session = JSON.stringify([remote, ws.id, t.id]),
      sample = 'VM_COPY_SELECTION_123'
    await app.evaluate(({ shell }) => {
      global.urls = []
      shell.openExternal = async (url) => {
        global.urls.push(url)
      }
    })
    await p.evaluate(
      ({ session }) =>
        window.relay.write(
          session,
          "printf '\\033[38;2;17;129;203mVM_TRUECOLOR\\033[0m\\n\\033]8;;https://example.com/vm-native\\033\\\\VM_NATIVE_LINK\\033]8;;\\033\\\\\\n'\r"
        ),
      { session }
    )
    const rgb = p
      .locator('.xterm-rows > div span')
      .filter({ hasText: /^VM_TRUECOLOR$/ })
      .last()
    await expect
      .poll(() => rgb.evaluate((e) => getComputedStyle(e).color))
      .toBe('rgb(17, 129, 203)')
    const native = p
      .locator('.xterm-rows > div span')
      .filter({ hasText: /^VM_NATIVE_LINK$/ })
      .last()
    await expect(native).toBeVisible()
    const nativeBox = await native.boundingBox()
    await p.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control')
    await p.mouse.move(nativeBox.x + 3, nativeBox.y + nativeBox.height / 2)
    await expect.poll(() => p.locator('.xterm-cursor-pointer').count()).toBe(1)
    await p.mouse.click(nativeBox.x + 3, nativeBox.y + nativeBox.height / 2)
    await p.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control')
    await expect
      .poll(() => app.evaluate(() => global.urls))
      .toEqual(['https://example.com/vm-native'])

    await p.evaluate(
      ({ session, sample }) =>
        window.relay.write(session, `printf '\\033[?1000h\\033[?1006h\\n${sample}\\n'\r`),
      { session, sample }
    )
    await expect
      .poll(() =>
        ssh(`tmux display-message -p -t '=relay-${t.id}:' '#{mouse_standard_flag}'`).trim()
      )
      .toBe('1')
    const row = p.locator('.xterm-rows > div').filter({ hasText: sample }).last()
    await expect.poll(async () => (await row.innerText()).trim()).toBe(sample)
    const span = row.locator('span').filter({ hasText: sample }).first(),
      box = await span.boundingBox()
    await p.mouse.move(box.x + 0.5, box.y + box.height / 2)
    await p.mouse.down()
    await p.mouse.move(box.x + box.width + 0.5, box.y + box.height / 2, { steps: 8 })
    await p.mouse.up()
    await key('c', [
      process.platform === 'darwin' ? 'meta' : 'control',
      ...(process.platform === 'darwin' ? [] : ['shift'])
    ])
    await expect.poll(() => app.evaluate(() => global.copies.at(-1))).toBe(sample)
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(sample)
    await app.evaluate(({ clipboard }) => clipboard.writeText('stale clipboard'))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.copy())
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(sample)
    await app.evaluate(({ clipboard }) => clipboard.writeText('stale clipboard'))
    await p.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control')
    if (process.platform !== 'darwin') {
      await p.keyboard.down('Shift')
    }
    await p.keyboard.press('c')
    await p.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control')
    if (process.platform !== 'darwin') {
      await p.keyboard.up('Shift')
    }
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(sample)
    await app.evaluate(({ clipboard }) => clipboard.writeText('stale clipboard'))
    await p.locator('.xterm-screen:visible').click({ button: 'right' })
    await p.getByRole('menuitem', { name: 'Copy', exact: true }).click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(sample)
    await app.evaluate(({ clipboard }) => clipboard.writeText('PASTE_SAMPLE_456'))
    await p.locator('.xterm-screen:visible').click({ button: 'right' })
    await p.getByRole('menuitem', { name: 'Paste', exact: true }).click()
    await expect
      .poll(() =>
        app.evaluate(() => global.input.some((data) => data.includes('PASTE_SAMPLE_456')))
      )
      .toBe(true)
    await p.locator('.xterm-helper-textarea:visible').focus()
    await key('c', ['control'])
    await expect.poll(() => app.evaluate(() => global.input.includes('\x03'))).toBe(true)
    await p.getByRole('button', { name: 'Terminal 1', exact: true }).click({ button: 'right' })
    await p.getByRole('menuitem', { name: 'Copy current path', exact: true }).click()
    await expect.poll(() => app.evaluate(() => global.copies.at(-1))).toBe(ws.path)
    await expect
      .poll(
        async () => {
          await p.evaluate(
            ({ session }) => window.relay.write(session, "printf '\\033[?1000l\\033[?1006l'\r"),
            { session }
          )
          await p.waitForTimeout(200)
          return ssh(`tmux display-message -p -t '=relay-${t.id}:' '#{mouse_standard_flag}'`).trim()
        },
        { timeout: 15000 }
      )
      .toBe('0')
    await p.evaluate(
      ({ session }) =>
        window.relay.write(session, 'for i in {1..100}; do echo WHEEL_HISTORY_$i; done\r'),
      { session }
    )
    await expect
      .poll(async () =>
        p.locator('.xterm-rows > div').filter({ hasText: 'WHEEL_HISTORY_100' }).count()
      )
      .toBeGreaterThan(0)
    const screen = await p.locator('.xterm-screen:visible').boundingBox()
    await p.locator('.xterm-helper-textarea:visible').focus()
    await p.mouse.move(screen.x + screen.width / 2, screen.y + screen.height / 2)
    await app.evaluate(() => {
      global.input = []
    })
    await p.mouse.wheel(0, -360)
    await p.waitForTimeout(700)
    await expect
      .poll(() => ssh(`tmux display-message -p -t '=relay-${t.id}:' '#{pane_in_mode}'`).trim(), {
        timeout: 15000
      })
      .toBe('1')
    expect(
      await app.evaluate(() =>
        global.input.some((data) =>
          ['\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB'].some((arrow) => data.includes(arrow))
        )
      )
    ).toBe(false)
    ssh(`tmux send-keys -t '=relay-${t.id}:' -X cancel`)
    console.log(
      'PASS: VM truecolor and native hyperlinks; actual VM drag selection under application mouse capture + Cmd-C, native Edit Copy, and right-click Copy verified against system clipboard; right-click Paste inserts clipboard text; Ctrl-C still interrupts; VM path copying works; wheel enters tmux history without sending arrow keys.'
    )
  } finally {
    for (const host of ['local', ...(remoteReady ? [remote] : [])]) {
      for (const w of (await request(host, 'snapshot')).workspaces) {
        for (const t of w.terminals) {
          await request(host, 'terminal_remove', { workspace: w.id, terminal: t.id })
        }
      }
    }
    await app.evaluate(({ clipboard }) => {
      if (!global.copies.includes(clipboard.readText())) {
        return
      }
      clipboard.clear()
      for (const [format, data] of global.savedClipboard || []) {
        clipboard.writeBuffer(format, data)
      }
    })
    await app.close()
    fs.rmSync(fixture, { recursive: true, force: true })
    ssh(`rm -rf -- '${remoteRoot}'`)
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
