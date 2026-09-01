import assert from 'node:assert/strict'
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
