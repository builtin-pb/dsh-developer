import assert from 'node:assert/strict'
import test from 'node:test'
import { secretFreeEnvironment, smokeDshInstall } from '../lib/runtime.js'

test('passes only an explicit non-credential host environment allowlist', () => {
  const previousSecret = process.env.DEEPSEEK_API_KEY
  const previousNodeOptions = process.env.NODE_OPTIONS
  process.env.DEEPSEEK_API_KEY = 'not-forwarded'
  process.env.NODE_OPTIONS = '--inspect'
  try {
    const environment = secretFreeEnvironment({ DSH_HOME: 'C:\\isolated' })
    assert.equal(environment.DEEPSEEK_API_KEY, undefined)
    assert.equal(environment.NODE_OPTIONS, undefined)
    assert.equal(environment.DSH_HOME, 'C:\\isolated')
    assert.equal(environment.NO_COLOR, '1')
  } finally {
    if (previousSecret === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousSecret
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previousNodeOptions
  }
})

test('uses offline script-disabled install and a flag-compatible uninstall', async () => {
  const calls = []
  let dumps = 0
  const runDsh = async (_invocation, args) => {
    calls.push(args)
    if (args.includes('--dump-config')) {
      dumps += 1
      return { stdout: dumps === 1 ? '- id: sample-plugin\n' : '- id: another-plugin\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  const result = await smokeDshInstall(
    'C:\\candidate',
    'sample-plugin',
    'sample-plugin',
    { command: 'fake', prefixArgs: [] },
    { runDsh },
  )
  assert.deepEqual(result, { installed: true, discovered: true, uninstalled: true })
  assert.deepEqual(calls[0], [
    'plugin',
    '--profile',
    'headless',
    'add',
    'C:\\candidate',
    '--offline',
    '--ignore-scripts',
  ])
  assert.deepEqual(calls[2], [
    'plugin',
    '--profile',
    'headless',
    'remove',
    'sample-plugin',
  ])
})
