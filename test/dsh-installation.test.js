import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { locateInstalledDshPackage } from '../lib/dsh-installation.js'

const execute = promisify(execFile)
const packageName = '@dsh-developer-test/peer'

async function put(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh package lookup ü ')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const consumerRoot = join(root, 'selected', 'node_modules', '@deepseek-ai', 'dsh')
  const manifestPath = join(consumerRoot, 'package.json')
  await put(manifestPath, { name: '@deepseek-ai/dsh', version: '1.0.0' })
  async function peer(directory, extra = {}) {
    await put(join(directory, 'package.json'), { name: packageName, version: '1.0.0', ...extra })
    await put(join(directory, 'index.js'), 'throw new Error("audited code must not execute")\n')
    return directory
  }
  return { root, consumer: { root: consumerRoot, manifestPath }, peer }
}

test('installed inventory excludes NODE_PATH packages and guessed source siblings', async t => {
  const f = await fixture(t)
  const foreignModules = join(f.root, 'other-installation', 'node_modules')
  const foreign = await f.peer(join(foreignModules, ...packageName.split('/')))
  await f.peer(join(dirname(f.consumer.root), 'peer'))
  const script = `
    import { createRequire } from 'node:module'
    const [manifestPath, root, name, moduleUrl] = process.argv.slice(1)
    const { locateInstalledDshPackage } = await import(moduleUrl)
    const native = createRequire(manifestPath).resolve(name + '/package.json')
    const inspected = await locateInstalledDshPackage({ root, manifestPath }, name)
    process.stdout.write(JSON.stringify({ native, inspected: inspected ?? null }))
  `
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script,
    f.consumer.manifestPath, f.consumer.root, packageName,
    new URL('../lib/dsh-installation.js', import.meta.url).href], {
    env: { ...process.env, NODE_PATH: foreignModules }, timeout: 10_000,
  })
  const result = JSON.parse(stdout)
  assert.equal(result.native, join(foreign, 'package.json'), 'the injected global lookup must be active')
  assert.equal(result.inspected, null)
})

test('finds nearest, hoisted, and linked package metadata without relying on exports', async t => {
  const f = await fixture(t)
  const hoisted = await f.peer(join(f.root, 'selected', 'node_modules', ...packageName.split('/')))
  assert.equal((await locateInstalledDshPackage(f.consumer, packageName)).root, hoisted)
  const nearest = await f.peer(join(f.consumer.root, 'node_modules', ...packageName.split('/')), {
    version: '2.0.0', exports: { '.': './index.js', './package.json': './decoy.json' },
  })
  await put(join(nearest, 'decoy.json'), { name: packageName, version: '99.0.0' })
  const selected = await locateInstalledDshPackage(f.consumer, packageName)
  assert.equal(selected.root, nearest)
  assert.equal(selected.value.version, '2.0.0')
  assert.equal(selected.manifestPath, join(nearest, 'package.json'))
  await rm(nearest, { recursive: true })
  const target = await f.peer(join(f.root, 'store', 'peer'), {
    version: '3.0.0', exports: { '.': './index.js' },
  })
  try { await symlink(target, nearest, 'junction') } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Directory symlink unavailable.')
    throw error
  }
  const linked = await locateInstalledDshPackage(f.consumer, packageName)
  assert.equal(linked.root, target)
  assert.equal(linked.value.version, '3.0.0')
})

test('reports incomplete nearest packages instead of absence or an unrelated valid copy', async t => {
  const f = await fixture(t)
  await f.peer(join(f.root, 'selected', 'node_modules', ...packageName.split('/')))
  const nearest = join(f.consumer.root, 'node_modules', ...packageName.split('/'))
  await mkdir(nearest, { recursive: true })
  await assert.rejects(locateInstalledDshPackage(f.consumer, packageName), { code: 'DSH_PACKAGE_INVALID' })
  await put(join(nearest, 'package.json'), { name: '@dsh-developer-test/wrong' })
  await assert.rejects(locateInstalledDshPackage(f.consumer, packageName), { code: 'DSH_PACKAGE_INVALID' })
  await put(join(nearest, 'package.json'), '{')
  await assert.rejects(locateInstalledDshPackage(f.consumer, packageName), { code: 'DSH_PACKAGE_INVALID' })
  await rm(nearest, { recursive: true })
  try { await symlink(join(f.root, 'missing-target'), nearest, 'junction') } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Directory symlink unavailable.')
    throw error
  }
  await assert.rejects(locateInstalledDshPackage(f.consumer, packageName), { code: 'DSH_PACKAGE_INVALID' })
})
