const { _electron: electron } = require('playwright')
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os')
// Mouse-tracking apps get plain clicks; Cmd/Ctrl+click still opens links instead of reaching the app.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mouse-links-qa-'))
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
  const wait = (fn, arg) => p.waitForFunction(fn, arg, { timeout: 10000 })
  try {
    await wait(() => document.activeElement?.classList.contains('xterm-helper-textarea'))
    await app.evaluate(({ shell }) => {
      global.urls = []
      shell.openExternal = async (url) => {
        global.urls.push(url)
      }
    })
    const ws = await p.evaluate(() =>
      window.relay
        .request('local', 'snapshot')
        .then((s) => s.workspaces.find((w) => w.id === 'genral'))
    )
    const key = JSON.stringify(['local', 'genral', ws.terminals[0].id])
    const received = path.join(fixture, 'mouse.bin')
    const script = path.join(fixture, 'mouse-app.sh')
    fs.writeFileSync(
      script,
      `clear; printf 'https://example.com/mouse-link\\n\\033[?1000h\\033[?1006h'; stty raw -echo; exec dd bs=1 of='${received}' 2>/dev/null\n`
    )
    await p.evaluate(({ key, script }) => window.relay.write(key, `sh '${script}'\r`), {
      key,
      script
    })
    await wait(() =>
      [...document.querySelectorAll('.xterm-rows > div')].some((r) =>
        r.textContent.startsWith('https://example.com/mouse-link')
      )
    )
    await p.waitForTimeout(500)
    const screen = await p.locator('.xterm-screen').first().boundingBox()
    const x = screen.x + 40,
      y = screen.y + 6
    const bytes = () => (fs.existsSync(received) ? fs.readFileSync(received, 'latin1') : '')
    await p.mouse.click(x, y)
    for (let i = 0; i < 40 && !bytes().includes('[<0;'); i++) {
      await p.waitForTimeout(100)
    }
    if (!bytes().includes('[<0;')) {
      throw new Error('Plain click did not reach the mouse-tracking app')
    }
    const before = bytes().length
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await p.keyboard.down(mod)
    await p.mouse.move(x + 4, y)
    await p.mouse.click(x + 4, y)
    await p.keyboard.up(mod)
    for (let i = 0; i < 40 && !(await app.evaluate(() => global.urls.length)); i++) {
      await p.waitForTimeout(100)
    }
    const urls = await app.evaluate(() => global.urls)
    if (urls.join() !== 'https://example.com/mouse-link') {
      throw new Error(`Modifier click did not open the link: ${JSON.stringify(urls)}`)
    }
    if (bytes().length !== before) {
      throw new Error('Modifier click leaked to the mouse-tracking app')
    }
    console.log('mouse links smoke passed')
  } finally {
    await app.close()
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
