import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { resolveDshInvocation, runBounded, secretFreeEnvironment, smokeDshInstall } from '../lib/runtime.js'

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

test('passes bounded stdin and preserves binary stdout when requested', {
  skip: process.env.DSH_DEVELOPER_PROCESS_TEST !== '1',
}, async () => {
  const input = Buffer.from([0, 1, 2, 10, 13, 255])
  const result = await runBounded(process.execPath, [
    '-e',
    "const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks)))",
  ], {
    input,
    encoding: null,
    timeoutMs: 5_000,
    outputLimit: 1_024,
  })
  assert.deepEqual(result.stdout, input)
  assert.deepEqual(result.stderr, Buffer.alloc(0))
  assert.equal(result.exitCode, 0)
})

test('rejects oversized command input before spawning', async () => {
  await assert.rejects(
    runBounded(process.execPath, ['-e', ''], { input: Buffer.alloc(5), inputLimit: 4 }),
    (error) => error.code === 'COMMAND_INPUT_LIMIT',
  )
})

test('uses offline script-disabled install and a flag-compatible uninstall', async () => {
  const calls = []
  let dumps = 0
  const runDsh = async (_invocation, args, options) => {
    calls.push({ args, options })
    if (args.includes('--dump-config')) {
      dumps += 1
      return { stdout: dumps === 1 ? '- id: sample-plugin\n' : '- id: another-plugin\n', stderr: '' }
    }
    if (args.length === 2 && args[0] === '--profile') {
      await writeFile(
        join(options.cwd, '.dsh-developer-load-witness'),
        options.env.DSH_DEVELOPER_LOAD_PROBE + '\n',
        'utf8',
      )
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
  assert.deepEqual(result, {
    installed: true,
    discovered: true,
    loaded: true,
    loadWitness: 'registration-nonce',
    uninstalled: true,
  })
  assert.deepEqual(calls[0].args, [
    'plugin',
    '--profile',
    'dsh-developer-smoke',
    'add',
    'C:\\candidate',
    '--offline',
    '--ignore-scripts',
  ])
  assert.deepEqual(calls[2].args, ['--profile', 'dsh-developer-smoke'])
  assert.deepEqual(calls[3].args, [
    'plugin',
    '--profile',
    'dsh-developer-smoke',
    'remove',
    'sample-plugin',
  ])
  assert.ok(calls.every((value) => value.options.cwd === value.options.env.DSH_HOME))
  assert.match(calls[0].options.env.DSH_DEVELOPER_LOAD_PROBE, /^[a-f0-9]{64}$/u)
})

test('resolves a pnpm local-bin DSH wrapper to the official package entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-pnpm-wrapper-'))
  const wrapper = join(root, 'node_modules', '.bin', 'dsh.cmd')
  const entry = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  try {
    await mkdir(dirname(wrapper), { recursive: true })
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(wrapper, '@echo off\r\n', 'utf8')
    await writeFile(entry, '', 'utf8')
    const invocation = await resolveDshInvocation(wrapper)
    assert.equal(invocation.command, process.execPath)
    assert.deepEqual(invocation.prefixArgs, [entry])
    assert.equal(invocation.displayPath, wrapper)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
