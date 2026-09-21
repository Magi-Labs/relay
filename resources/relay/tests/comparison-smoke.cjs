const { _electron } = require('playwright')
const { expect } = require('playwright/test')
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os')
const { execFileSync } = require('node:child_process')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-compare-ui-'))
;(async () => {
  const repo = path.join(fixture, 'repo')
  fs.mkdirSync(repo)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
  git('init', '-b', 'main')
  git('config', 'user.name', 'Relay QA')
  git('config', 'user.email', 'qa@example.invalid')
  fs.writeFileSync(path.join(repo, 'note.txt'), 'baseline line\n')
  fs.mkdirSync(path.join(repo, 'deleted'))
  fs.writeFileSync(path.join(repo, 'deleted', 'gone.txt'), 'deleted baseline\n')
  git('add', '.')
  git('commit', '-m', 'Baseline')
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
  const p = await app.firstWindow()
  const errors = []
  p.on('pageerror', (error) => errors.push(String(error)))
  const request = (op, args = {}) =>
    p.evaluate(({ op, args }) => window.relay.request('local', op, args), { op, args })
  try {
    await p.getByRole('button', { name: /^Genral/ }).waitFor()
    await request('repo_register', { path: repo, name: 'CompareRepo' })
    const attached = await request('repo_attach', { workspace: 'genral', repo: 'CompareRepo' })
    fs.writeFileSync(path.join(attached.path, 'note.txt'), 'working line\n')
    fs.rmSync(path.join(attached.path, 'deleted'), { recursive: true })
    fs.writeFileSync(path.join(attached.path, 'new.txt'), 'new content\n')
    await p.getByRole('button', { name: 'Refresh repositories', exact: true }).click()
    await p.getByLabel('Comparison ref for CompareRepo').waitFor()
    await expect(p.getByText('3 changed · vs main', { exact: true })).toBeVisible()
    const section = p
      .locator('section')
      .filter({ has: p.getByLabel('Comparison ref for CompareRepo') })
    const note = section.getByRole('button').filter({ hasText: /^note.txt$/ })
    await expect(note.getByRole('img', { name: 'Modified', exact: true })).toBeVisible()
    await note.click()
    await expect(p.getByText('note.txt · vs main diff', { exact: false })).toBeVisible()
    await expect(p.locator('.monaco-diff-editor')).toBeVisible()
    await expect(p.locator('.monaco-diff-editor .view-lines')).toContainText([
      'baseline',
      'working'
    ])
    await section
      .getByRole('button')
      .filter({ hasText: /^deleted●$/ })
      .click()
    const gone = section.getByRole('button').filter({ hasText: /^gone.txt$/ })
    await expect(gone.getByRole('img', { name: 'Deleted', exact: true })).toBeVisible()
    await gone.click()
    await expect(p.locator('.monaco-diff-editor')).toBeVisible()
    const input = p.getByLabel('Comparison ref for CompareRepo')
    await input.fill('HEAD')
    await section.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(p.getByText('3 changed · vs HEAD', { exact: true })).toBeVisible()
    expect(
      (await request('snapshot')).workspaces.find((w) => w.id === 'genral').comparisonRefs
        .CompareRepo
    ).toBe('HEAD')
    await input.fill('missing-test-ref')
    await section.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(p.getByRole('alert').filter({ hasText: 'does not resolve' })).toBeVisible()
    expect(
      (await request('snapshot')).workspaces.find((w) => w.id === 'genral').comparisonRefs
        .CompareRepo
    ).toBe('HEAD')
    await p.getByRole('button', { name: 'Repositories', exact: true }).click()
    const manager = p.getByRole('dialog')
    await expect(manager.getByText('CompareRepo', { exact: true })).toBeVisible()
    await expect(manager.getByText(fs.realpathSync(repo), { exact: true })).toBeVisible()
    await expect(manager.getByText(attached.path, { exact: true })).toBeVisible()
    await manager.getByLabel('Find repositories').fill('no-such-repo')
    await expect(manager.getByText('No matching repositories.')).toBeVisible()
    await manager.getByLabel('Find repositories').fill('')
    await manager.getByRole('button', { name: 'Add repository', exact: true }).click()
    const extra = path.join(fixture, 'extra')
    execFileSync('git', ['clone', '--local', repo, extra], { stdio: 'pipe' })
    await p.getByLabel('Name', { exact: true }).fill('AddedRepo')
    await p.getByLabel('Existing path on local', { exact: true }).fill(extra)
    await p.getByRole('dialog').getByRole('button', { name: 'Add repository', exact: true }).click()
    await expect(
      p.getByRole('dialog').getByRole('heading', { name: 'Repositories', exact: true })
    ).toBeVisible()
    await expect(p.getByRole('dialog').getByText('AddedRepo', { exact: true })).toBeVisible()
    await p.getByRole('dialog').getByRole('button').filter({ hasText: 'Genral' }).click()
    await expect(p.getByRole('dialog')).toHaveCount(0)
    expect(errors).toEqual([])
    console.log(
      'PASS: explorer comparison decorations, deleted folders/files, base-to-worktree diff, ref editing/persistence, invalid-ref errors, repository browser, filtering, add flow, and workspace navigation.'
    )
  } finally {
    for (const w of (await request('snapshot')).workspaces)
      for (const t of w.terminals)
        await request('terminal_remove', { workspace: w.id, terminal: t.id })
    await app.close()
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
