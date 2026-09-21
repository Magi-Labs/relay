const { _electron } = require('playwright'),
  { expect } = require('playwright/test')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-links-qa-'))
;(async () => {
  const app = await _electron.launch({
    executablePath: process.env.RELAY_EXECUTABLE || require('electron'),
    args: process.env.RELAY_EXECUTABLE ? [] : ['.'],
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CLICOLOR: '0',
      CI: '1',
      RELAY_ROOT: `${fixture}/root`,
      RELAY_USER_DATA_PATH: `${fixture}/profile`
    }
  })
  const p = await app.firstWindow()
  const request = (op, args = {}) =>
    p.evaluate(({ op, args }) => window.relay.request('local', op, args), { op, args })
  try {
    await p.waitForFunction(() =>
      document.activeElement?.classList.contains('xterm-helper-textarea')
    )
    await app.evaluate(({ shell }) => {
      global.urls = []
      shell.openExternal = async (url) => {
        global.urls.push(url)
      }
    })
    const ws = (await request('snapshot')).workspaces.find((w) => w.id === 'genral'),
      t = ws.terminals[0]
    fs.writeFileSync(path.join(ws.path, 'notes.md'), '# General notes\nSecond line\n')
    fs.writeFileSync(path.join(ws.path, 'other.txt'), 'Other file')
    await p.getByRole('button', { name: 'Refresh repositories', exact: true }).click()
    const key = JSON.stringify(['local', 'genral', t.id])
    await p.evaluate(
      ({ key }) =>
        window.relay.write(
          key,
          "printf '\\nhttps://example.com/relay\\nhttp://localhost:3000/test\\nnotes.md:2:1\\n'\r"
        ),
      { key }
    )
    const rowFor = (text) => p.locator('.xterm-rows > div').filter({ hasText: text }).last()
    await expect
      .poll(async () => (await rowFor('https://example.com/relay').innerText()).trim())
      .toBe('https://example.com/relay')
    const point = async (text) => {
      const row = rowFor(text),
        box = await row.boundingBox(),
        content = await row.innerText()
      const cols = Number(
        execFileSync('tmux', [
          'display-message',
          '-p',
          '-t',
          `=relay-${t.id}:`,
          '#{pane_width}'
        ]).toString()
      )
      const screen = await p.locator('.xterm-screen').boundingBox()
      return {
        x: screen.x + ((content.indexOf(text) + 2) * screen.width) / cols,
        y: box.y + box.height / 2
      }
    }
    let pos = await point('https://example.com/relay')
    await p.mouse.click(pos.x, pos.y)
    expect(await app.evaluate(() => global.urls)).toEqual([])
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await p.keyboard.down(mod)
    await p.mouse.move(pos.x, pos.y)
    await expect.poll(() => p.locator('.xterm-cursor-pointer').count()).toBe(1)
    await p.mouse.click(pos.x, pos.y)
    await p.keyboard.up(mod)
    await expect.poll(() => app.evaluate(() => global.urls)).toEqual(['https://example.com/relay'])
    pos = await point('http://localhost:3000/test')
    await p.keyboard.down(mod)
    await p.mouse.move(pos.x, pos.y)
    await expect.poll(() => p.locator('.xterm-cursor-pointer').count()).toBe(1)
    await p.mouse.click(pos.x, pos.y)
    await p.keyboard.up(mod)
    await expect
      .poll(() => app.evaluate(() => global.urls))
      .toEqual(['https://example.com/relay', 'http://localhost:3000/test'])
    const script = path.join(ws.path, 'capabilities.sh')
    const output = path.join(ws.path, 'capabilities.json')
    fs.writeFileSync(
      script,
      `#!/bin/sh
python3 -c 'import os,json; print(json.dumps({k:os.environ.get(k) for k in ["NO_COLOR","CI","FORCE_COLOR","CLICOLOR","COLORTERM","TERM_PROGRAM","FORCE_HYPERLINK"]}))' > '${output}'
printf '\\033[31mRELAY_RED\\033[0m\\n'
printf '\\033[38;2;17;129;203mRELAY_RGB\\033[0m\\n'
printf '\\033]8;;https://example.com/native-target\\033\\\\Native hyperlink label\\033]8;;\\033\\\\\\n'
printf '  ENG-42 (https://          IN REVIEW    Other column\\n  linear.app/example/      other-column\\n  issue/ENG-42)\\n'
`
    )
    await p.evaluate(({ key, script }) => window.relay.write(key, `sh '${script}'\r`), {
      key,
      script
    })
    await expect
      .poll(() => fs.existsSync(output) && fs.readFileSync(output, 'utf8').includes('}'))
      .toBe(true)
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual({
      NO_COLOR: null,
      CI: null,
      FORCE_COLOR: null,
      CLICOLOR: null,
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'tmux',
      FORCE_HYPERLINK: '1'
    })
    await expect(rowFor('RELAY_RED')).toContainText('RELAY_RED')
    const red = rowFor('RELAY_RED').locator('span').filter({ hasText: 'RELAY_RED' }).first()
    expect(await red.evaluate((e) => getComputedStyle(e).color)).not.toBe(
      await p.locator('.xterm').evaluate((e) => getComputedStyle(e).color)
    )
    const rgb = rowFor('RELAY_RGB').locator('span').filter({ hasText: 'RELAY_RGB' }).first()
    await expect
      .poll(() => rgb.evaluate((e) => getComputedStyle(e).color))
      .toBe('rgb(17, 129, 203)')
    for (const [label, expected] of [
      ['Native hyperlink label', 'https://example.com/native-target'],
      ['ENG-42 (https://', 'https://linear.app/example/issue/ENG-42'],
      ['linear.app/example/', 'https://linear.app/example/issue/ENG-42'],
      ['issue/ENG-42)', 'https://linear.app/example/issue/ENG-42']
    ]) {
      pos = await point(label === 'ENG-42 (https://' ? 'https://' : label)
      // The scheme also appears in the shell command; select the rendered table row explicitly.
      if (label === 'ENG-42 (https://') {
        const table = await rowFor(label).boundingBox()
        const first = await point('linear.app/example/')
        const cols = Number(
          execFileSync('tmux', [
            'display-message',
            '-p',
            '-t',
            `=relay-${t.id}:`,
            '#{pane_width}'
          ]).toString()
        )
        const screen = await p.locator('.xterm-screen').boundingBox()
        pos = { x: first.x + (8 * screen.width) / cols, y: table.y + table.height / 2 }
      }
      await p.keyboard.down(mod)
      await p.mouse.move(pos.x, pos.y)
      await expect.poll(() => p.locator('.xterm-cursor-pointer').count()).toBe(1)
      const count = (await app.evaluate(() => global.urls)).length
      await p.mouse.click(pos.x, pos.y)
      await p.keyboard.up(mod)
      await expect.poll(() => app.evaluate(() => global.urls)).toHaveLength(count + 1)
      expect((await app.evaluate(() => global.urls)).at(-1)).toBe(expected)
    }
    pos = await point('Other column')
    await p.keyboard.down(mod)
    await p.mouse.move(pos.x, pos.y)
    await expect.poll(() => p.locator('.xterm-cursor-pointer').count()).toBe(0)
    await p.keyboard.up(mod)
    const wrappedUrl = 'https://example.com/' + 'segment/'.repeat(40) + 'wrapped-end'
    fs.writeFileSync(script, `printf '%s\\n' '${wrappedUrl}'`)
    await p.evaluate(({ key, script }) => window.relay.write(key, `sh '${script}'\r`), {
      key,
      script
    })
    await expect(rowFor('wrapped-end')).toContainText('wrapped-end')
    pos = await point('wrapped-end')
    await p.keyboard.down(mod)
    await p.mouse.move(pos.x, pos.y)
    await expect.poll(() => p.locator('.xterm-cursor-pointer').count()).toBe(1)
    await p.mouse.click(pos.x, pos.y)
    await p.keyboard.up(mod)
    await expect.poll(() => app.evaluate(() => global.urls.at(-1))).toBe(wrappedUrl)
    for (const url of ['file:///tmp/example', 'javascript:alert(1)']) {
      const error = await p.evaluate(async (url) => {
        try {
          await window.relay.openExternal(url)
          return ''
        } catch (error) {
          return String(error)
        }
      }, url)
      expect(error).toContain('Only HTTP and HTTPS links are supported')
    }
    pos = await point('notes.md:2:1')
    await p.keyboard.down(mod)
    await p.mouse.move(pos.x, pos.y)
    await expect.poll(() => p.locator('.xterm-cursor-pointer').count()).toBe(1)
    await p.mouse.click(pos.x, pos.y)
    await p.keyboard.up(mod)
    await p.locator('main').getByRole('button', { name: 'notes.md', exact: true }).waitFor()
    await expect(p.locator('.monaco-editor').first()).toBeVisible()
    const cdp = await p.context().newCDPSession(p)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await p
      .locator('.monaco-editor .view-lines')
      .first()
      .click({ position: { x: 50, y: 25 } })
    await p.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.insertText(' draft-marker')
    )
    await expect(p.getByText('Unsaved changes', { exact: true })).toBeVisible()
    await p.getByRole('button', { name: 'other.txt', exact: true }).click()
    await p.getByRole('button', { name: 'Close other.txt', exact: true }).waitFor()
    await p.locator('main').getByRole('button', { name: 'notes.md', exact: true }).click()
    await expect(p.getByText('Unsaved changes', { exact: true })).toBeVisible()
    await p.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(p.getByText('Saved', { exact: true })).toBeVisible()
    const notes = await request('file', {
      workspace: 'genral',
      repo: '@workspace',
      path: 'notes.md'
    })
    expect(notes.text).toContain('draft-marker')
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const modifiers = [process.platform === 'darwin' ? 'meta' : 'control']
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'w', modifiers })
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'w', modifiers })
    })
    await expect(p.getByRole('button', { name: 'Close notes.md', exact: true })).toHaveCount(0)
    await expect(p.getByRole('button', { name: 'Close other.txt', exact: true })).toBeVisible()
    console.log(
      'PASS: inherited NO_COLOR removed, ANSI and truecolor rendered, native OSC 8 links, full-width and table-wrapped URLs, modifier gating, safe protocols, file tab routing, editable drafts across tabs, and saving to disk.'
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
