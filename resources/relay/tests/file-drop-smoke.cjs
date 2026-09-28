const { _electron } = require('playwright')
const { expect } = require('playwright/test')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const { execFileSync } = require('node:child_process')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-drop-qa-'))
const remoteBase = `/tmp/${path.basename(fixture)}`,
  remoteRoot = `${remoteBase}/relay`
const sample = path.join(fixture, "sample ' file.txt")
fs.writeFileSync(sample, 'Relay file drop fixture\n')
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const ssh = (command) =>
  execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'local-vm', command], {
    encoding: 'utf8'
  })
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
  let remoteReady = false,
    uploaded,
    pastedImage
  try {
    await p.locator('.xterm-helper-textarea:visible').waitFor()
    await app.evaluate(({ ipcMain }) => {
      global.input = []
      ipcMain.on('relay:write', (_e, _key, data) => global.input.push(data))
    })
    const drop = async (host = 'local') => {
      const target = p.locator(`.relay-terminal[data-relay-host="${host}"]:visible`)
      await target.waitFor()
      await expect.poll(() => target.locator('.xterm-rows').innerText()).not.toMatch(/^\s*$/)
      await app.evaluate(() => {
        global.input = []
      })
      await p.evaluate(() => {
        const el = document.createElement('input')
        el.type = 'file'
        el.id = 'drop-fixture'
        document.body.append(el)
      })
      const cdp = await p.context().newCDPSession(p)
      const { root } = await cdp.send('DOM.getDocument')
      const { nodeId } = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: '#drop-fixture'
      })
      await cdp.send('DOM.setFileInputFiles', { nodeId, files: [sample] })
      await cdp.detach()
      await target.evaluate((terminal) => {
        const input = document.querySelector('#drop-fixture')
        const data = new DataTransfer()
        data.items.add(input.files[0])
        terminal.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })
        )
        input.remove()
      })
      await expect
        .poll(
          () => app.evaluate(() => global.input.filter((part) => part.includes('sample')).join('')),
          { timeout: 30000 }
        )
        .not.toBe('')
      const input = await app.evaluate(() =>
        global.input.filter((part) => part.includes('sample')).join('')
      )
      expect(input).not.toMatch(/[\r\n]/)
      return execFileSync(
        'python3',
        [
          '-c',
          'import shlex,sys;print(shlex.split(sys.argv[1])[0])',
          input.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '')
        ],
        { encoding: 'utf8' }
      ).trim()
    }
    expect(await drop()).toBe(sample)
    ssh(`mkdir -p ${quote(remoteBase + '/magi/utils')}`)
    await request('local', 'host_add', { name: 'Drop-VM', ssh: 'local-vm', root: remoteRoot })
    await p.reload()
    await p
      .locator('[data-host="Drop-VM"]')
      .getByRole('button', { name: /^Genral/ })
      .click()
    await p.locator('.xterm-helper-textarea:visible').waitFor()
    remoteReady = true
    uploaded = await drop('Drop-VM')
    ssh(`test -L ${quote(remoteBase + '/magi')}`)
    expect(uploaded).toContain('/.local/share/sess/uploads/upload-')
    const result = JSON.parse(
      ssh(
        `python3 -c ${quote('import pathlib,sys,json,stat; p=pathlib.Path(sys.argv[1]); print(json.dumps({"text":p.read_text(),"mode":stat.S_IMODE(p.stat().st_mode)}))')} ${quote(uploaded)}`
      )
    )
    expect(result).toEqual({ text: 'Relay file drop fixture\n', mode: 384 })
    await app.evaluate(({ clipboard }) => clipboard.writeText('PASTE_TEXT_789'))
    await app.evaluate(() => {
      global.input = []
    })
    await p.locator('.xterm-helper-textarea:visible').focus()
    await p.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+Shift+V')
    await expect
      .poll(() => app.evaluate(() => global.input.join('')), { timeout: 10000 })
      .toContain('PASTE_TEXT_789')
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    await app.evaluate(({ clipboard, nativeImage }, data) => {
      clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(data, 'base64')))
    }, png)
    expect(
      await app.evaluate(({ clipboard }) => {
        const size = clipboard.readImage().getSize()
        return `${size.width}x${size.height}`
      })
    ).toBe('1x1')
    await app.evaluate(() => {
      global.input = []
    })
    await p.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+Shift+V')
    await expect
      .poll(
        () =>
          app.evaluate(() => global.input.filter((part) => part.includes('Pasted image')).join('')),
        { timeout: 30000 }
      )
      .not.toBe('')
    const pastedInput = await app.evaluate(() =>
      global.input.filter((part) => part.includes('Pasted image')).join('')
    )
    expect(pastedInput).not.toMatch(/[\r\n]/)
    pastedImage = execFileSync(
      'python3',
      [
        '-c',
        'import shlex,sys;print(shlex.split(sys.argv[1])[0])',
        pastedInput.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '')
      ],
      { encoding: 'utf8' }
    ).trim()
    expect(pastedImage).toContain('/.local/share/sess/uploads/upload-')
    const expectedPng = await app.evaluate(({ clipboard }) =>
      clipboard.readImage().toPNG().toString('base64')
    )
    expect(ssh(`base64 < ${quote(pastedImage)}`).replace(/\s/g, '')).toBe(expectedPng)
    console.log(
      'PASS: real native File drops insert quoted local paths and upload through sess 0.7 to local-vm with exact contents/private permissions without pressing Enter; Cmd-V pastes text directly and pastes clipboard images through the same upload path with exact PNG bytes.'
    )
  } finally {
    console.log('Drop feedback:', await p.getByRole('alert').allTextContents())
    for (const host of ['local', ...(remoteReady ? ['Drop-VM'] : [])])
      for (const ws of (await request(host, 'snapshot')).workspaces)
        for (const t of ws.terminals)
          await request(host, 'terminal_remove', { workspace: ws.id, terminal: t.id })
    await app.close()
    for (const file of [uploaded, pastedImage])
      if (file?.includes('/.local/share/sess/uploads/upload-'))
        ssh(`rm -rf -- ${quote(path.posix.dirname(file))}`)
    if (remoteReady) ssh(`rm -rf -- ${quote(remoteBase)}`)
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
