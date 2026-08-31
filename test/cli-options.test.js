import assert from 'node:assert/strict'
import test from 'node:test'
import { assertCliCommandOptions, parseCliArguments } from '../lib/cli-options.js'

test('normalizes dashed value and flag options to the CLI option vocabulary', () => {
  assert.deepEqual(parseCliArguments([
    'compatibility',
    '--source', 'plugin',
    '--release-dsh', 'release',
    '--preview-dsh', 'preview',
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
      profile: 'headless',
      wslDistro: 'Ubuntu-22.04',
      skipRuntime: true,
      json: true,
    },
  })
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
  assert.doesNotThrow(() => assertCliCommandOptions('preflight', {
    source: 'plugin',
    profile: 'headless',
    dsh: 'dsh',
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
    'promote',
  ]) {
    assert.throws(
      () => assertCliCommandOptions(command, { profile: 'headless' }),
      (error) => error.code === 'CLI_USAGE'
        && error.message === command + ' does not accept --profile.',
    )
  }
})
