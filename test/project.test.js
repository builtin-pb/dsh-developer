import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { inspectProject, resolvePackageManager, runProjectScript } from '../lib/project.js'
import { runBounded } from '../lib/runtime.js'

async function fixture(t, manifest = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-project-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.git'))
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
  return root
}

test('inspects an existing dependency-bearing plugin without importing it or walking node_modules', async t => {
  const root = await fixture(t, { name: 'ordinary-plugin', dsh: { bundle: { patch: './plugin.yml' } }, scripts: { build: 'node build.js' } })
  await mkdir(join(root, 'node_modules'))
  await writeFile(join(root, 'node_modules', 'binary'), Buffer.from([255, 0, 1]))
  await writeFile(join(root, 'index.js'), 'throw new Error("must never execute")')
  const report = await inspectProject(root)
  assert.equal(report.ok, true)
  assert.equal(report.project.kind, 'plugin')
  assert.equal(report.project.hasDependencies, true)
  assert.deepEqual(report.tasks[0].argv, ['npm', 'run', 'build'])
})

test('selects a nested package and the containing workspace toolchain', async t => {
  const root = await fixture(t, { name: 'workspace', packageManager: 'pnpm@11.7.0' })
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
  await writeFile(join(root, 'AGENTS.md'), 'Project conventions')
  const nested = join(root, 'packages', '插件 with spaces')
  await mkdir(join(nested, 'src'), { recursive: true })
  await writeFile(join(nested, 'package.json'), JSON.stringify({ name: 'nested', scripts: { test: 'node --test' } }))
  await writeFile(join(nested, 'src', 'index.ts'), 'export {}')
  const report = await inspectProject(join(nested, 'src', 'index.ts'))
  assert.equal(report.project.root, nested)
  assert.equal(report.packageManager.root, root)
  assert.equal(report.packageManager.name, 'pnpm')
  assert.deepEqual(report.instructionFiles, [join(root, 'AGENTS.md')])
})

test('does not leave the Agent workspace through parent traversal or a project symlink', async t => {
  const root = await fixture(t, { name: 'workspace' })
  const other = await fixture(t, { name: 'outside' })
  await assert.rejects(inspectProject(other, { sourceRoot: root }), { code: 'PROJECT_OUTSIDE_WORKSPACE' })
  await symlink(other, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(inspectProject('linked', { sourceRoot: root }), { code: 'PROJECT_OUTSIDE_WORKSPACE' })
})

test('distinguishes an upstream checkout and reports conflicting package managers', async t => {
  const root = await fixture(t, { name: '@deepseek-ai/dsh-root', packageManager: 'pnpm@11.7.0' })
  await mkdir(join(root, 'packages', 'core'), { recursive: true })
  await mkdir(join(root, 'apps', 'cli'), { recursive: true })
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []')
  await writeFile(join(root, 'package-lock.json'), '{}')
  const report = await inspectProject(root)
  assert.equal(report.project.kind, 'upstream')
  assert.equal(report.ok, false)
  assert.match(report.notices.join('\n'), /lockfiles disagree/u)
})

test('cancellation and malformed metadata do not trigger project code', async t => {
  const root = await fixture(t)
  await assert.rejects(inspectProject(root, { signal: AbortSignal.abort() }), { code: 'CANCELLED' })
  await writeFile(join(root, 'package.json'), '{broken')
  await assert.rejects(inspectProject(root), { code: 'PROJECT_MANIFEST_INVALID' })
})

test('runs the selected real script in its package and preserves a failing exit status', async t => {
  const root = await fixture(t, { name: 'script-project', scripts: { test: 'node check.cjs', failure: 'node -e "process.exit(7)"' } })
  await writeFile(join(root, 'check.cjs'), 'require("node:fs").writeFileSync("observed.txt", JSON.stringify({ cwd: process.cwd(), marker: process.env.DSH_DEVELOPER_PROJECT_TEST_MARKER })); console.log("checked")')
  const previous = process.env.DSH_DEVELOPER_PROJECT_TEST_MARKER
  process.env.DSH_DEVELOPER_PROJECT_TEST_MARKER = 'native-project-environment'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_DEVELOPER_PROJECT_TEST_MARKER
    else process.env.DSH_DEVELOPER_PROJECT_TEST_MARKER = previous
  })
  const success = await runProjectScript(root, 'test')
  assert.equal(success.ok, true)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'observed.txt'), 'utf8')), { cwd: root, marker: 'native-project-environment' })
  assert.match(success.stdout, /checked/u)
  const failure = await runProjectScript(root, 'failure')
  assert.equal(failure.ok, false)
  assert.equal(failure.exitCode, 7)
  await assert.rejects(runProjectScript(root, '--help'), { code: 'PROJECT_TASK_UNAVAILABLE' })
})

test('forwards script argv through the real npm CLI without shell interpolation', async t => {
  const root = await fixture(t, { name: 'script-arguments', scripts: { inspect: 'node arguments.cjs' } })
  await writeFile(join(root, 'arguments.cjs'), 'require("node:fs").writeFileSync("arguments.json", JSON.stringify(process.argv.slice(2))); process.exit(Number(process.argv.at(-1)))')
  const args = ['--help', '--source', 'other project', '', '路径 with spaces', '--', 'literal; $(text)', '7']
  const cli = fileURLToPath(new URL('../bin/dsh-developer.js', import.meta.url))
  const result = await runBounded(process.execPath, [cli, 'run', '--source', root, '--script', 'inspect', '--json', '--', ...args], {
    acceptedExitCodes: [1], timeoutMs: 10_000,
  })
  assert.deepEqual(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8')), args)
  const report = JSON.parse(result.stdout)
  assert.equal(report.exitCode, 7)
  assert.equal(report.ok, false)
  for (const args of [null, false, 'one string', [null], ['invalid\0argument']]) {
    await assert.rejects(runProjectScript(root, 'inspect', { args }), { code: 'PROJECT_ARGUMENTS_INVALID' })
  }
})

test('runs exact declared script names with underscores, slashes, spaces and Unicode', async t => {
  const names = ['_lint', 'build/dev', 'test integration', '测试']
  const unsupported = ['', '--help', 'bad\nname', 'bad\0name']
  const scripts = Object.fromEntries([...names, ...unsupported].map((name, i) => [name, 'node script-' + i + '.cjs']))
  const root = await fixture(t, { name: 'script-names', scripts })
  assert.deepEqual((await inspectProject(root)).tasks.map(task => task.name), names)
  for (const [i, name] of names.entries()) {
    await writeFile(join(root, 'script-' + i + '.cjs'), 'require("node:fs").writeFileSync("invoked.txt", ' + JSON.stringify(name) + ')')
    const report = await runProjectScript(root, name)
    assert.equal(report.ok, true)
    assert.equal(await readFile(join(root, 'invoked.txt'), 'utf8'), name)
  }
  for (const name of unsupported) await assert.rejects(runProjectScript(root, name), { code: 'PROJECT_TASK_UNAVAILABLE' })
})

// The development CI supplies exact managers in disposable installations.
for (const [manager, version, location] of [
  ['pnpm', '11.7.0', process.env.DSH_DEVELOPER_PNPM_TEST ? '' : undefined],
  ['yarn', '1.22.22', process.env.DSH_DEVELOPER_YARN_CLASSIC_ROOT],
  ['yarn', '4.18.0', process.env.DSH_DEVELOPER_YARN_MODERN_ROOT],
]) test(`preserves script flags and empty arguments on ${manager} ${version}`, { skip: location === undefined }, async t => {
  const root = await fixture(t, { name: 'manager-arguments', version: '1.0.0', private: true,
    packageManager: manager + '@' + version, scripts: { inspect: 'node arguments.cjs' } })
  const previous = process.env.PATH
  if (location) process.env.PATH = join(location, 'node_modules', '.bin') + delimiter + previous
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous })
  const invocation = await resolvePackageManager(manager)
  const actual = await runBounded(invocation.command, [...invocation.prefixArgs, '--version'], { cwd: root, env: { ...process.env } })
  assert.equal(actual.stdout.trim(), version)
  if (version.startsWith('4.')) {
    await writeFile(join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\nenableNetwork: false\nenableTelemetry: false\nenableImmutableInstalls: false\n'
      + 'enableGlobalCache: false\nglobalFolder: ' + JSON.stringify(join(root, '.yarn-global')) + '\n')
    await runBounded(invocation.command, [...invocation.prefixArgs, 'install', '--mode=skip-build'], {
      cwd: root, env: { ...process.env }, diagnosticOutput: true,
    })
  }
  const args = ['--help', '--source', 'other project', '', '路径 with spaces', '--', 'literal; $(text)', '7']
  await writeFile(join(root, 'arguments.cjs'), 'require("node:fs").writeFileSync("arguments.json", JSON.stringify(process.argv.slice(2))); process.exit(Number(process.argv.at(-1)))')
  const report = await runProjectScript(root, 'inspect', { args })
  assert.equal(report.exitCode, 7)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8')), args)
})
