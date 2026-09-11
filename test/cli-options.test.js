import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { assertCliCommandOptions, parseCliArguments } from '../lib/cli-options.js'

test('normalizes dashed value and flag options to the CLI option vocabulary', () => {
  assert.deepEqual(parseCliArguments([
    'compatibility',
    '--source', 'plugin',
    '--release-dsh', 'release',
    '--preview-dsh', 'preview',
    '--from-dsh', '0.1.1-rc.2',
    '--to-dsh', '0.1.2-alpha.3',
    '--profile', 'headless',
    '--wsl-distro', 'Ubuntu-22.04',
    '--skip-runtime',
    '--json',
  ]), {
    command: 'compatibility',
    options: {
      source: 'plugin',
      releaseDsh: 'release',
      previewDsh: 'preview',
      fromDsh: '0.1.1-rc.2',
      toDsh: '0.1.2-alpha.3',
      profile: 'headless',
      wslDistro: 'Ubuntu-22.04',
      skipRuntime: true,
      json: true,
    },
  })
})

test('parses the closed agent-native UI command surface', () => {
  const development = parseCliArguments(['ui', '--session', 'preview', '--action', 'open',
    '--development-server', '/tmp/dsh-developer-dev-fixture'])
  assert.equal(development.options.developmentServer, '/tmp/dsh-developer-dev-fixture')
  assert.doesNotThrow(() => assertCliCommandOptions(development.command, development.options))
  assert.throws(() => assertCliCommandOptions('doctor', { developmentServer: '/tmp/dsh-developer-dev-fixture' }), /does not accept/u)
  assert.deepEqual(parseCliArguments([
    'ui',
    '--session', 'codex-preview',
    '--action', 'wait',
    '--text', 'Ready',
    '--timeout-ms', '1500',
    '--json',
  ]), {
    command: 'ui',
    options: {
      session: 'codex-preview',
      action: 'wait',
      text: 'Ready',
      timeoutMs: '1500',
      json: true,
    },
  })
  assert.doesNotThrow(() => assertCliCommandOptions('ui', {
    session: 'codex-preview',
    action: 'snapshot',
    target: 'e12',
    depth: '4',
  }))
  assert.throws(
    () => assertCliCommandOptions('ui', { source: 'plugin' }),
    (error) => error.code === 'CLI_USAGE'
      && error.message === 'ui does not accept --source.',
  )
})

test('parses only the explicit Hook Bridge Doctor lane and dialect surface', () => {
  const parsed = parseCliArguments([
    'hook-doctor',
    '--source', 'hooks.json',
    '--dialect', 'codex',
    '--dsh', 'D:/runtime/dsh.cmd',
    '--json',
  ])
  assert.deepEqual(parsed, {
    command: 'hook-doctor',
    options: {
      source: 'hooks.json',
      dialect: 'codex',
      dsh: 'D:/runtime/dsh.cmd',
      json: true,
    },
  })
  assert.doesNotThrow(() => assertCliCommandOptions(parsed.command, parsed.options))
  assert.throws(
    () => assertCliCommandOptions('hook-doctor', { source: 'hooks.json', dialect: 'codex', dsh: 'dsh', skipRuntime: true }),
    /hook-doctor does not accept --skip-runtime/u,
  )
})

test('keeps Hook Doctor CLI human output on the exact redacted formatter', async () => {
  const source = await readFile(new URL('../bin/dsh-developer.js', import.meta.url), 'utf8')
  assert.match(
    source,
    /printFormattedReport\(report, options\.json, command, formatHookBridgeReport\)/u,
  )
})

test('rejects unknown options and missing values', () => {
  assert.throws(
    () => parseCliArguments(['doctor', '--source']),
    (error) => error.code === 'CLI_USAGE' && /requires a value/u.test(error.message),
  )
  assert.throws(
    () => parseCliArguments(['doctor', '--trust-source']),
    (error) => error.code === 'CLI_USAGE' && /Unknown option/u.test(error.message),
  )
})

test('forwards only run arguments after -- without interpreting script flags', () => {
  const args = ['--help', '--source', 'a different target', '', '汉字', '--', 'literal; $(text)']
  const parsed = parseCliArguments(['run', '--source', 'project', '--script', 'test', '--json', '--', ...args])
  assert.deepEqual(parsed.options, { source: 'project', script: 'test', json: true, scriptArgs: args })
  assert.doesNotThrow(() => assertCliCommandOptions(parsed.command, parsed.options))
  assert.deepEqual(parseCliArguments(['run', '--']).options.scriptArgs, [])
  assert.throws(() => parseCliArguments(['run', '--unknown']), { code: 'CLI_USAGE' })
  for (const command of ['project', 'knowledge', 'session', 'verify', 'dev', 'doctor', 'promote', 'ui']) {
    assert.throws(() => parseCliArguments([command, '--', '--help']), { code: 'CLI_USAGE' })
    assert.throws(() => assertCliCommandOptions(command, { scriptArgs: [] }), { code: 'CLI_USAGE' })
  }
})

test('accepts exactly one trusted overlay only on verify and dev', () => {
  for (const command of ['verify', 'dev']) {
    const parsed = parseCliArguments([command, '--source', 'packed plugin.tgz', '--patch', 'config changes.patch.yml'])
    assert.equal(parsed.options.patch, 'config changes.patch.yml')
    assert.doesNotThrow(() => assertCliCommandOptions(command, parsed.options))
    assert.throws(() => parseCliArguments([command, '--patch']), { code: 'CLI_USAGE' })
    assert.throws(() => parseCliArguments([command, '--patch', '--json']), { code: 'CLI_USAGE' })
    assert.throws(() => parseCliArguments([command, '--patch', 'one.yml', '--patch', 'two.yml']), /--patch accepts one file/u)
  }
  for (const command of ['project', 'knowledge', 'session', 'run', 'admit-cell', 'attest-profile', 'capabilities',
    'compatibility', 'doctor', 'fingerprint', 'hook-doctor', 'impact', 'migration', 'lab', 'preflight', 'promote', 'ui']) {
    const parsed = parseCliArguments([command, '--patch', 'config changes.patch.yml'])
    assert.throws(() => assertCliCommandOptions(command, parsed.options), {
      code: 'CLI_USAGE', message: command + ' does not accept --patch.',
    })
  }
})

test('keeps command option surfaces closed after global option parsing', () => {
  assert.doesNotThrow(() => assertCliCommandOptions('attest-profile', {
    profile: 'C:/profiles/web',
    dsh: 'dsh',
    json: true,
  }))
  assert.doesNotThrow(() => assertCliCommandOptions('preflight', {
    source: 'plugin',
    profile: 'headless',
    dsh: 'dsh',
    json: true,
  }))
  assert.doesNotThrow(() => assertCliCommandOptions('migration', {
    source: 'plugin',
    fromDsh: '0.1.1-rc.2',
    toDsh: '0.1.2-alpha.3',
    json: true,
  }))
  for (const command of [
    'admit-cell',
    'capabilities',
    'compatibility',
    'doctor',
    'fingerprint',
    'impact',
    'hook-doctor',
    'lab',
    'migration',
    'promote',
  ]) {
    assert.throws(
      () => assertCliCommandOptions(command, { profile: 'headless' }),
      (error) => error.code === 'CLI_USAGE'
        && error.message === command + ' does not accept --profile.',
    )
  }
})
