const { _electron: electron } = require('playwright')
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os')
// Theme toggle recolors shell and terminal in place; apps (Claude, Codex) get OSC 11 and mode 2031 reports.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-theme-qa-'))
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
  try {
    await p.waitForFunction(() => document.querySelector('.xterm-screen'), null, { timeout: 10000 })
    await p.evaluate(() => (document.querySelector('.xterm').dataset.probe = 'kept'))
    const ws = await p.evaluate(() =>
      window.relay
        .request('local', 'snapshot')
        .then((s) => s.workspaces.find((w) => w.id === 'genral'))
    )
    const key = JSON.stringify(['local', 'genral', ws.terminals[0].id])
    const received = path.join(fixture, 'scheme.bin')
    const script = path.join(fixture, 'scheme-app.sh')
    fs.writeFileSync(
      script,
      `stty raw -echo; printf '\\033]11;?\\033\\\\\\033[?2031h'; exec dd bs=1 of='${received}' 2>/dev/null\n`
    )
    await p.evaluate(({ key, script }) => window.relay.write(key, `sh '${script}'\r`), {
      key,
      script
    })
    const bytes = () => (fs.existsSync(received) ? fs.readFileSync(received, 'latin1') : '')
    const until = async (text) => {
      for (let i = 0; i < 50 && !bytes().includes(text); i++) {
        await p.waitForTimeout(100)
      }
      if (!bytes().includes(text)) {
        throw new Error(`App never received ${JSON.stringify(text)}: ${JSON.stringify(bytes())}`)
      }
    }
    await until(']11;rgb:')
    const state = () =>
      p.evaluate(() => ({
        dark: document.documentElement.classList.contains('dark'),
        bg: getComputedStyle(document.querySelector('.xterm-viewport') || document.body)
          .backgroundColor,
        kept: document.querySelector('.xterm')?.dataset.probe === 'kept'
      }))
    const before = await state()
    const toggle = p.getByRole('button', { name: /Switch to (light|dark) mode/ })
    await toggle.click()
    await p.waitForTimeout(300)
    const after = await state()
    if (after.dark === before.dark) {
      throw new Error('Toggle did not switch theme')
    }
    if (!after.kept) {
      throw new Error('Terminal was recreated on theme change')
    }
    await until(`[?997;${after.dark ? 1 : 2}n`)
    const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('relay.appearance')).theme)
    if (saved !== (after.dark ? 'dark' : 'light')) {
      throw new Error(`Theme not saved: ${saved}`)
    }
    await p.screenshot({ path: path.join(process.env.SHOT_DIR || fixture, `theme-${saved}.png`) })
    await toggle.click()
    await until(`[?997;${before.dark ? 1 : 2}n`)
    if ((await state()).dark !== before.dark) {
      throw new Error('Second toggle did not switch back')
    }
    await p.screenshot({ path: path.join(process.env.SHOT_DIR || fixture, 'theme-back.png') })
    console.log('theme smoke passed', JSON.stringify(bytes()))
  } finally {
    await app.close()
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
