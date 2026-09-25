const { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join, resolve, dirname } = require('node:path')
const root = resolve(__dirname, '../..')
const stage = join(root, 'out/relay-package')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
cpSync(join(root, 'out/relay'), join(stage, 'out/relay'), { recursive: true })
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'))
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      packageManager: 'npm@11.11.0',
      name: 'relay',
      version: '0.3.3',
      description: 'Multi-repo terminal workspaces for coding agents',
      author: 'Deepak Silaych',
      license: 'MIT',
      main: 'out/relay/main/index.js',
      dependencies: { 'node-pty': pkg.dependencies['node-pty'] }
    },
    null,
    2
  )
)
const pty = dirname(require.resolve('node-pty/package.json'))
for (const item of ['package.json', 'LICENSE', 'lib', 'build/Release']) {
  cpSync(join(pty, item), join(stage, 'node_modules/node-pty', item), {
    recursive: true,
    filter: (path) => !/\.test\.js(?:\.map)?$|\.o$|\.a$/.test(path)
  })
}
const addon = dirname(require.resolve('node-addon-api/package.json', { paths: [pty] }))
cpSync(addon, join(stage, 'node_modules/node-addon-api'), { recursive: true })
console.log('Staged Relay with node-pty; other runtime modules are bundled by Vite.')
