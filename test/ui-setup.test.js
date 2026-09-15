import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { installUiCli, setupUi, uiDiscoveryCandidates } from '../lib/ui-setup.js'
import { loadUiConfiguration, readUiSettings, uiConfigPath, UI_CLI_ENVIRONMENT } from '../lib/ui-configuration.js'
import { registerUiCliToolWithDependencies } from '../lib/ui-cli-tool.js'
import { parseCliArguments, assertCliCommandOptions } from '../lib/cli-options.js'
import { inspectUiCapabilities } from '../lib/ui-capabilities.js'
import { DshDeveloperError } from '../lib/errors.js'

const run = promisify(execFile)
function assertSetupRecovery(message, installCli = false, limit = 700) {
  const suffix = installCli ? ' --install-cli' : ''
  assert.ok(message.includes('In a DSH agent shell'))
  assert.ok(message.includes('node "$DSH_DEVELOPER_BIN" ui-setup' + suffix + ' (POSIX)'))
  assert.ok(message.includes('node "$env:DSH_DEVELOPER_BIN" ui-setup' + suffix + ' (PowerShell)'))
  assert.ok(message.includes('outside DSH, run node bin/dsh-developer.js ui-setup' + suffix + ' from the dsh-developer checkout root'))
  assert.doesNotMatch(message, /(?:run|rerun|retry) dsh-developer ui-setup/iu)
  assert.ok(message.length < limit, 'recovery should remain concise')
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ui-setup-')))
  const previous = Object.fromEntries(Object.values(UI_CLI_ENVIRONMENT).map(key => [key, process.env[key]]))
  for (const key of Object.values(UI_CLI_ENVIRONMENT)) delete process.env[key]
  const config = join(root, 'private state', 'config.json')
  process.env.DSH_DEVELOPER_UI_CONFIG = config
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  const entry = await provider(join(root, 'installed CLI'))
  const browser = join(root, 'Google Chrome')
  await writeFile(browser, 'This fixture must never be executed during setup.')
  return { root, config, entry, browser }
}
async function provider(root, version = '0.1.18') {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@playwright/cli', version }))
  const entry = join(root, 'playwright-cli.js')
  await writeFile(entry, 'process.stdout.write(JSON.stringify({browsers:[]}))')
  return entry
}

test('ui-setup options are closed and cannot install through runtime or admission commands', () => {
  const parsed = parseCliArguments(['ui-setup', '--install-cli', '--cli-entry', '/installed/playwright-cli.js',
    '--browser-executable', '/Applications/Google Chrome', '--config', '/tmp/config.json', '--json'])
  assert.equal(parsed.options.installCli, true)
  assert.doesNotThrow(() => assertCliCommandOptions(parsed.command, parsed.options))
  for (const command of ['ui', 'dev', 'doctor', 'capabilities']) {
    assert.throws(() => assertCliCommandOptions(command, { installCli: true }), { code: 'CLI_USAGE' })
    assert.throws(() => assertCliCommandOptions(command, { config: '/tmp/config.json' }), { code: 'CLI_USAGE' })
  }
  assert.throws(() => assertCliCommandOptions('ui-setup', { url: 'http://localhost' }), { code: 'CLI_USAGE' })
})

test('saves private configuration without launching a browser and activates only at registration', async t => {
  const f = await fixture(t)
  const registrations = []
  const dependencies = { tools: { register(tool) { registrations.push(tool) } }, effect() {} }
  assert.equal(await registerUiCliToolWithDependencies(dependencies), undefined)
  await assert.rejects(lstat(dirname(f.config)), { code: 'ENOENT' })
  const report = await setupUi({ cliEntry: f.entry, browserExecutable: f.browser })
  assert.equal(report.restartRequired, true)
  assert.equal(report.browserLaunched, false)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(f.root))
  assert.equal(registrations.length, 0)
  const saved = await readUiSettings()
  assert.equal(saved.entry, f.entry)
  assert.equal(saved.browser, f.browser)
  if (process.platform !== 'win32') assert.equal((await lstat(f.config)).mode & 0o777, 0o600)
  await assert.rejects(lstat(saved.root), { code: 'ENOENT' })
  const controller = await registerUiCliToolWithDependencies(dependencies)
  assert.deepEqual(registrations.map(tool => tool.name), ['dsh_ui'])
  assert.equal(inspectUiCapabilities(registrations, { nativeCliActive: true }).ok, true)
  await controller.dispose()
  const shell = await run(process.execPath, ['bin/dsh-developer.js', 'ui', '--session', 'setup-witness', '--action', 'status', '--json'], { cwd: resolve('.'), env: process.env })
  assert.equal(JSON.parse(shell.stdout).ok, true)
})

test('the actual setup CLI accepts spaced overrides, saves once, and reports no local paths', async t => {
  const f = await fixture(t)
  const result = await run(process.execPath, ['bin/dsh-developer.js', 'ui-setup', '--cli-entry', f.entry,
    '--browser-executable', f.browser, '--config', f.config, '--json'], { env: process.env })
  const report = JSON.parse(result.stdout)
  assert.equal(report.providerVersion, '0.1.18')
  assert.equal(report.configuration, 'saved')
  assert.ok(!result.stdout.includes(f.root))
  assert.equal((await readUiSettings()).browser, f.browser)
})

test('shell UI errors explain profile and checkout recovery in text and JSON outside the checkout', async t => {
  const f = await fixture(t)
  const entry = resolve('bin/dsh-developer.js')
  for (const json of [false, true]) {
    await assert.rejects(run(process.execPath, [entry, 'ui', '--session', 'missing-setup', '--action', 'status',
      ...(json ? ['--json'] : [])], { cwd: f.root, env: process.env }), error => {
      assert.equal(error.code, 1)
      assert.doesNotMatch(error.stderr, /(?:run|rerun|retry) dsh-developer ui-setup|In a DSH shell/iu)
      assert.ok(Buffer.byteLength(error.stderr) < 2200, 'the complete CLI error should remain bounded')
      const diagnostic = json ? JSON.parse(error.stderr) : { message: error.stderr }
      if (json) {
        assert.equal(diagnostic.code, 'UI_CLI_NOT_CONFIGURED')
        assert.deepEqual(diagnostic.nextActions.map(action => action.id), ['ui.configure-prerequisites'])
        const [action] = diagnostic.nextActions
        assert.equal(action.automatic, false)
        assertSetupRecovery(action.recovery.text)
        assert.match(action.recovery.text, /Do not discover or install them automatically during runtime or admission/u)
      } else {
        assert.match(error.stderr, /Next action \[ui.configure-prerequisites\]: In a DSH agent shell/u)
        assert.match(error.stderr, /Do not discover or install them automatically during runtime or admission/u)
      }
      assertSetupRecovery(diagnostic.message, false, json ? 700 : 1400)
      assert.match(diagnostic.message, /Append --install-cli/u)
      assert.match(diagnostic.message, /restart DSH/u)
      assert.ok(!error.stderr.includes(f.root))
      return true
    })
  }
  await assert.rejects(lstat(dirname(f.config)), { code: 'ENOENT' })
})

test('environment overrides saved fields and complete legacy environment ignores saved state', async t => {
  const f = await fixture(t)
  await setupUi({ cliEntry: f.entry, browserExecutable: f.browser })
  const other = join(f.root, 'Edge')
  await writeFile(other, '')
  process.env.DSH_DEVELOPER_BROWSER_EXECUTABLE = other
  assert.equal((await loadUiConfiguration()).browser, other)
  process.env.DSH_DEVELOPER_BROWSER_EXECUTABLE = join(f.root, 'missing')
  await assert.rejects(loadUiConfiguration(), { code: 'UI_BROWSER_INVALID' })
  process.env.DSH_DEVELOPER_BROWSER_EXECUTABLE = other
  process.env.DSH_DEVELOPER_PLAYWRIGHT_CLI_ENTRY = f.entry
  await writeFile(f.config, 'broken')
  assert.equal((await loadUiConfiguration()).browser, other)
})

test('bad pin, relative overrides and non-ordinary files fail without saving or executing candidates', async t => {
  const f = await fixture(t)
  const wrong = await provider(join(f.root, 'wrong version'), '0.1.19')
  await assert.rejects(setupUi({ cliEntry: wrong, browserExecutable: f.browser, installCli: true }), { code: 'UI_CLI_VERSION_MISMATCH' })
  await assert.rejects(setupUi({ cliEntry: 'relative', browserExecutable: f.browser }), { code: 'UI_OPTIONS_INVALID' })
  await assert.rejects(setupUi({ cliEntry: f.entry, browserExecutable: f.root }), { code: 'UI_BROWSER_INVALID' })
  await assert.rejects(lstat(dirname(f.config)), { code: 'ENOENT' })
  assert.throws(() => uiConfigPath({ DSH_DEVELOPER_UI_CONFIG: 'relative' }), { code: 'UI_CONFIG_INVALID' })
})

test('malformed, oversized and linked saved config fail closed with no registration', async t => {
  const f = await fixture(t)
  await mkdir(dirname(f.config), { recursive: true })
  for (const body of ['invalid', '{}', ' '.repeat(8193), JSON.stringify({ version: 1, entry: f.entry, browser: f.browser, root: f.root, extra: true })]) {
    await writeFile(f.config, body)
    await assert.rejects(registerUiCliToolWithDependencies({ tools: { register() { assert.fail('must not register') } }, effect() {} }), { code: 'UI_CONFIG_INVALID' })
  }
  await rm(f.config)
  const target = join(f.root, 'untouched')
  await writeFile(target, '{}')
  await symlink(target, f.config)
  await assert.rejects(setupUi({ cliEntry: f.entry, browserExecutable: f.browser }), { code: 'UI_CONFIG_INVALID' })
  assert.equal(await readFile(target, 'utf8'), '{}')
})

test('optional registration reports unusable storage but does not contain registration bugs', async t => {
  const f = await fixture(t)
  await setupUi({ cliEntry: f.entry, browserExecutable: f.browser })
  const runtime = (await readUiSettings()).root
  await writeFile(runtime, 'a file cannot be runtime storage')
  const diagnostics = []
  assert.equal(await registerUiCliToolWithDependencies({
    tools: { register() { assert.fail('must not register') } }, effect() {},
    onConfigurationError: diagnostic => diagnostics.push(diagnostic),
  }), undefined)
  assert.equal(diagnostics[0].code, 'UI_ROOT_INVALID')
  assertSetupRecovery(diagnostics[0].nextStep)
  await rm(runtime)
  for (const failure of [new Error('unexpected registry failure'), new DshDeveloperError('UI_CONFIG_INVALID', 'registration bug')]) {
    await assert.rejects(registerUiCliToolWithDependencies({
      tools: { register() { throw failure } }, effect() {},
      onConfigurationError() { assert.fail('only configuration loading can be contained') },
    }), error => error === failure)
  }
})

test('explicit setup reuses its dedicated pinned provider without installation', async t => {
  const f = await fixture(t)
  const installed = await provider(join(dirname(f.config), 'provider', 'node_modules', '@playwright', 'cli'))
  await setupUi({ browserExecutable: f.browser, installCli: true })
  assert.equal((await readUiSettings()).entry, installed)
  await setupUi({})
  assert.equal((await readUiSettings()).entry, installed)
})

test('normal discovery covers Mac, Windows and Linux without PATH or project search', () => {
  const mac = uiDiscoveryCandidates({ platform: 'darwin', home: '/Users/example', executable: '/opt/homebrew/bin/node',
    configPath: '/private/ui/config.json', environment: { PATH: '/untrusted/repo/node_modules/.bin' } })
  assert.ok(mac.browsers.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
  assert.ok(mac.entries.includes('/opt/homebrew/lib/node_modules/@playwright/cli/playwright-cli.js'))
  assert.ok(!JSON.stringify(mac).includes('untrusted'))
  const windows = uiDiscoveryCandidates({ platform: 'win32', home: 'C:\\Users\\example', executable: 'C:\\Program Files\\nodejs\\node.exe',
    configPath: 'C:\\state\\config.json', environment: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' } })
  assert.ok(windows.browsers.includes('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'))
  const linux = uiDiscoveryCandidates({ platform: 'linux', home: '/home/example', executable: '/usr/bin/node', configPath: '/tmp/ui/config.json', environment: {} })
  assert.ok(linux.browsers.includes('/opt/google/chrome/chrome'))
  assert.ok(linux.browsers.includes('/usr/bin/microsoft-edge'))
})

test('explicit installer uses only dedicated state, pinned argv, disabled scripts and isolated npm config', async t => {
  const f = await fixture(t)
  const executable = join(f.root, 'node installation', 'bin', 'node')
  const npmRoot = join(dirname(executable), '..', 'lib', 'node_modules', 'npm')
  await mkdir(join(npmRoot, 'bin'), { recursive: true })
  await writeFile(join(npmRoot, 'bin', 'npm-cli.js'), 'must not execute')
  await writeFile(join(npmRoot, 'package.json'), '{"name":"npm"}')
  let calls = 0
  const entry = await installUiCli(f.config, { executable, runner: async (command, args, options) => {
    calls++
    assert.equal(command, executable)
    assert.ok(args.includes('@playwright/cli@0.1.18'))
    assert.ok(args.includes('--ignore-scripts'))
    assert.ok(args.includes('--no-audit'))
    assert.ok(args.includes('--registry=https://registry.npmjs.org/'))
    const prefix = args[args.indexOf('--prefix') + 1]
    assert.equal(prefix, join(dirname(f.config), 'provider'))
    assert.equal(options.cwd, prefix)
    assert.equal(options.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, '1')
    assert.ok(options.env.HOME.startsWith(prefix))
    assert.notEqual(args[args.indexOf('--userconfig') + 1], args[args.indexOf('--globalconfig') + 1])
    await provider(join(prefix, 'node_modules', '@playwright', 'cli'))
    return { stdout: 'private registry output', stderr: '', exitCode: 0 }
  } })
  assert.equal(calls, 1)
  assert.ok(entry.startsWith(dirname(f.config)))
  await assert.rejects(lstat(f.config), { code: 'ENOENT' })
  await assert.rejects(installUiCli(f.config, { executable, runner() { assert.fail('must not overwrite') } }), { code: 'UI_SETUP_INSTALL_FAILED' })
})

test('installation failure redacts npm output and cannot save activation; cancellation has no effects', async t => {
  const f = await fixture(t)
  const signal = AbortSignal.abort()
  await assert.rejects(setupUi({ cliEntry: f.entry, browserExecutable: f.browser, signal }), { code: 'CANCELLED' })
  await assert.rejects(lstat(dirname(f.config)), { code: 'ENOENT' })
  const executable = join(f.root, 'bin', 'node')
  await assert.rejects(installUiCli(f.config, { executable, runner() { assert.fail('npm is absent') } }), error => {
    assert.equal(error.code, 'UI_SETUP_NPM_MISSING')
    assertSetupRecovery(error.message, true)
    return true
  })
  await assert.rejects(lstat(dirname(f.config)), { code: 'ENOENT' })
  const npm = join(dirname(executable), 'node_modules', 'npm')
  await mkdir(join(npm, 'bin'), { recursive: true })
  await writeFile(join(npm, 'package.json'), '{"name":"npm"}')
  await writeFile(join(npm, 'bin', 'npm-cli.js'), '')
  await assert.rejects(installUiCli(f.config, { executable, runner() { throw new Error('private-token secret-local-path') } }), error => {
    assert.equal(error.code, 'UI_SETUP_INSTALL_FAILED')
    assertSetupRecovery(error.message, true)
    assert.doesNotMatch(JSON.stringify(error), /private-token|secret-local-path/)
    return true
  })
  await assert.rejects(lstat(f.config), { code: 'ENOENT' })
})

test('explicit setup repairs malformed ordinary owned settings while runtime rejects them', async t => {
  const f = await fixture(t)
  await mkdir(dirname(f.config), { recursive: true })
  for (const invalid of ['broken JSON', '{}', ' '.repeat(8193)]) {
    await writeFile(f.config, invalid)
    await assert.rejects(loadUiConfiguration(), error => {
      assert.equal(error.code, 'UI_CONFIG_INVALID')
      assertSetupRecovery(error.message)
      return true
    })
    await setupUi({ cliEntry: f.entry, browserExecutable: f.browser })
    assert.equal((await loadUiConfiguration()).entry, f.entry)
    assert.equal((await readUiSettings()).browser, f.browser)
  }
})

test('failed or cancelled fresh installs clean their prefix and can retry without deleting preexisting data', async t => {
  const f = await fixture(t)
  const executable = join(f.root, 'node', 'bin', 'node')
  const npm = join(dirname(executable), 'node_modules', 'npm')
  await mkdir(join(npm, 'bin'), { recursive: true })
  await writeFile(join(npm, 'package.json'), '{"name":"npm"}')
  await writeFile(join(npm, 'bin', 'npm-cli.js'), '')
  for (const code of ['COMMAND_FAILED', 'CANCELLED']) {
    await assert.rejects(installUiCli(f.config, { executable, runner: async () => {
      await writeFile(join(dirname(f.config), 'provider', 'partial'), 'partial installation')
      throw Object.assign(new Error('private output'), { code })
    } }), { code: code === 'CANCELLED' ? code : 'UI_SETUP_INSTALL_FAILED' })
    await assert.rejects(lstat(join(dirname(f.config), 'provider')), { code: 'ENOENT' })
    await assert.rejects(lstat(f.config), { code: 'ENOENT' })
  }
  const entry = await installUiCli(f.config, { executable, runner: async () => {
    await provider(join(dirname(f.config), 'provider', 'node_modules', '@playwright', 'cli'))
  } })
  assert.equal((await lstat(entry)).isFile(), true)
  const protectedFile = join(dirname(f.config), 'provider', 'user-data')
  await writeFile(protectedFile, 'preserve me')
  await assert.rejects(installUiCli(f.config, { executable, runner() { assert.fail('must not execute') } }), { code: 'UI_SETUP_INSTALL_FAILED' })
  assert.equal(await readFile(protectedFile, 'utf8'), 'preserve me')
})
