import assert from 'node:assert/strict'
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import { assertOfficialDshInvocation } from '../lib/dsh-installation.js'
import { resolveDshInvocation, runBounded, runDsh, secretFreeEnvironment, smokeDshInstall } from '../lib/runtime.js'

test('rejects invalid or unsupported process-group cleanup before spawning', async () => {
  for (const cleanupProcessGroupOnExit of ['true', 1, {}, ...(process.platform === 'win32' ? [true] : [])]) {
    await assert.rejects(runBounded('must-not-spawn', [], { cleanupProcessGroupOnExit }), {
      code: 'COMMAND_OPTIONS_INVALID',
    })
  }
})

test('retains a bounded log tail without terminating a long-lived command', async () => {
  const report = await runBounded(process.execPath, ['-e', "process.stdout.write('x'.repeat(2048) + 'finished')"], {
    outputLimit: 64, outputMode: 'tail', timeoutMs: 0,
  })
  assert.equal(report.exitCode, 0)
  assert.equal(report.stdout.length, 64)
  assert.ok(report.stdout.endsWith('finished'))
})

test('protected output withholds both streams after a PEM marker and preserves original truncation and exit evidence', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const other = stream === 'stdout' ? 'stderr' : 'stdout'
    const code = `
      process.${stream}.write('-----BEGIN PRI');
      setTimeout(() => {
        process.${stream}.write('VATE KEY-----\\n' + 'short body line\\n'.repeat(100));
        process.${other}.write('Useful diagnostic: 界🙂é\\n');
        process.exitCode = 7;
      }, 25);
    `
    await assert.rejects(runBounded(process.execPath, ['-e', code], {
      protectOutput: true, diagnosticOutput: true, outputMode: 'tail', outputLimit: 128,
    }), error => {
      assert.equal(error.code, 'COMMAND_EXITED')
      assert.equal(error.details.exitCode, 7)
      assert.equal(error.details.exitSignal, null)
      assert.equal(error.details[stream], '[redacted: process output contained a private key]\n')
      assert.equal(error.details[other], '[redacted: process output contained a private key]\n')
      assert.equal(error.details.output.truncated[stream], true)
      assert.equal(error.details.output.truncated[other], false)
      assert.equal(error.details.output.withheld[stream], true)
      assert.equal(error.details.output.withheld[other], true)
      return true
    })
  }
})

test('raw binary output remains byte-exact even when it includes a private-key marker', async () => {
  const marker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
  const input = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.from(marker + '\nbody\n')])
  const result = await runBounded(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
    input, encoding: null, outputLimit: 1024,
  })
  assert.deepEqual(result.stdout, input)
  assert.equal(result.output, undefined)
  await assert.rejects(runBounded('must-not-spawn', [], { protectOutput: 'true' }), { code: 'COMMAND_OPTIONS_INVALID' })
})

test('protected output withholds a real PEM body on the opposite stream, in either arrival order', async () => {
  const pem = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
  const begin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
  const end = ['-----END', 'PRIVATE KEY-----'].join(' ')
  const lines = pem.split('\n').filter(line => line && !line.startsWith('---')).join('').match(/.{1,16}/gu)
  const body = lines.join('\n') + '\n' + end + '\n'
  assert.equal(createPrivateKey(begin + '\n' + body).asymmetricKeyType, 'rsa')
  for (const headerStream of ['stdout', 'stderr']) {
    const bodyStream = headerStream === 'stdout' ? 'stderr' : 'stdout'
    const headerWrite = `process.${headerStream}.write(${JSON.stringify(begin + '\n')})`
    const bodyWrite = `process.${bodyStream}.write(${JSON.stringify('ordinary noise\n'.repeat(300) + body)})`
    for (const headerFirst of [true, false]) {
      const writes = headerFirst ? [headerWrite, bodyWrite] : [bodyWrite, headerWrite]
      const code = `${writes[0]}; setTimeout(() => { ${writes[1]}; process.exitCode = 7 }, 25)`
      const result = await runBounded(process.execPath, ['-e', code], {
        protectOutput: true, outputMode: 'tail', outputLimit: 2048, acceptedExitCodes: [7],
      })
      assert.equal(result.exitCode, 7)
      assert.equal(result.stdout, '[redacted: process output contained a private key]\n')
      assert.equal(result.stderr, result.stdout)
      assert.deepEqual(result.output.withheld, { stdout: true, stderr: true })
      assert.equal(result.output.truncated[headerStream], false)
      assert.equal(result.output.truncated[bodyStream], true)
      assert(lines.every(line => !JSON.stringify(result).includes(line)))
    }
  }
})

test('cancellation and timeout retain requested protected tails after stopping the child', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-abort-diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  for (const mode of ['cancel', 'timeout']) {
    for (const pem of [false, true]) {
      const ready = join(root, mode + '-' + pem + '.json')
      const controller = new AbortController()
      const credential = ['pass', 'word'].join('') + '=fixture-only-value'
      const marker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
      const code = `
        setInterval(() => {}, 1000);
        process.stdout.write(${JSON.stringify('ordinary log\n'.repeat(100) + (pem ? marker + '\n' : ''))}, () => {
          process.stderr.write(${JSON.stringify('Error: delayed fixture startup failed\n' + credential + '\n')}, () => {
            require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));
          });
        });
      `
      const running = runBounded(process.execPath, ['-e', code], {
        signal: controller.signal, timeoutMs: 2000, outputMode: 'tail', outputLimit: 256,
        protectOutput: true, diagnosticOutput: true,
      }).then(() => { throw new Error('Expected an aborted command') }, error => error)
      try {
        let pid
        const deadline = Date.now() + 1500
        while (pid === undefined && Date.now() < deadline) {
          const value = await readFile(ready, 'utf8').catch(() => undefined)
          if (value) pid = Number(value)
          else await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert(Number.isSafeInteger(pid), 'child must publish its logs before interruption')
        if (mode === 'cancel') controller.abort()
        const error = await running
        assert.equal(error.code, mode === 'cancel' ? 'CANCELLED' : 'COMMAND_TIMEOUT')
        assert.equal(error.details.output.truncated.stdout, true)
        assert.equal(error.details.output.truncated.stderr, false)
        assert.deepEqual(error.details.output.withheld, { stdout: pem, stderr: pem })
        if (pem) {
          assert.equal(error.details.stdout, '[redacted: process output contained a private key]\n')
          assert.equal(error.details.stderr, error.details.stdout)
        } else {
          assert.match(error.details.stderr, /delayed fixture startup failed/u)
          assert.match(error.details.stderr, /redacted: possible credential/u)
        }
        assert(!JSON.stringify(error.details).includes('fixture-only-value'))
        assert(Object.hasOwn(error.details, 'exitCode'))
        assert(Object.hasOwn(error.details, 'exitSignal'))
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
      } finally { controller.abort(); await running }
    }
  }
})

test('runDsh reports child exit before inherited stdio closes and still drains descendant output', {
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-exit-'))
  const pidPath = join(root, 'descendant.pid')
  const leaderPidPath = join(root, 'leader.pid')
  const releasePath = join(root, 'release')
  const controller = new AbortController()
  const descendantCode = `
    const { existsSync, writeFileSync } = require('node:fs');
    writeFileSync(process.argv[1], String(process.pid));
    const timer = setInterval(() => {
      if (!existsSync(process.argv[2])) return;
      clearInterval(timer);
      process.stdout.write('descendant tail\\n', () => {
        process.stderr.write('descendant stderr\\n', () => process.exit(0));
      });
    }, 10);
    process.send('ready');
  `
  const childCode = `
    const { spawn } = require('node:child_process');
    require('node:fs').writeFileSync(process.argv[3], String(process.pid));
    const descendant = spawn(process.execPath,
      ['-e', ${JSON.stringify(descendantCode)}, process.argv[1], process.argv[2]],
      // libuv's Windows job kills non-detached children when their parent
      // exits. This fixture needs a surviving descendant to hold the pipes;
      // the test's finally block owns its explicit PID cleanup.
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], detached: process.platform === 'win32', windowsHide: true });
    descendant.once('message', () => {
      process.stdout.write('leader\\n', () => process.exit(0));
    });
  `
  let notifyExit
  const exited = new Promise(resolve => { notifyExit = resolve })
  let settled = false
  let drained = false
  const notifications = []
  const running = runDsh({ command: process.execPath, prefixArgs: ['-e', childCode] }, [pidPath, releasePath, leaderPidPath], {
    signal: controller.signal,
    timeoutMs: 5_000,
    onExit: exit => { notifications.push(exit); notifyExit(exit) },
  })
  // Observe rejections immediately, including a timeout if the exit hook regresses.
  const completed = running.then(value => { settled = true; return value }, error => { settled = true; throw error })
  try {
    const exit = await Promise.race([
      exited,
      completed.then(() => { throw new Error('Runner completed without an early exit notification.') }),
    ])
    const leaderPid = Number(await readFile(leaderPidPath, 'utf8'))
    assert.ok(Number.isSafeInteger(leaderPid) && leaderPid > 0)
    assert.deepEqual(exit, { code: 0, signal: null, pid: leaderPid })
    assert.equal(settled, false, 'runner must still wait for the descendant-held pipes')
    const descendantPid = Number(await readFile(pidPath, 'utf8'))
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0)
    process.kill(descendantPid, 0)
    await writeFile(releasePath, '')
    const report = await completed
    drained = true
    assert.deepEqual(report, {
      stdout: 'leader\ndescendant tail\n', stderr: 'descendant stderr\n', exitCode: 0,
    })
    assert.deepEqual(notifications, [{ code: 0, signal: null, pid: leaderPid }])
  } finally {
    if (!drained) {
      controller.abort()
      // The leader may already be gone, so also clean up the known descendant
      // directly on platforms where tree termination cannot find that leader.
      const descendantPid = Number(await readFile(pidPath, 'utf8').catch(() => ''))
      if (Number.isSafeInteger(descendantPid) && descendantPid > 0) {
        try { process.kill(descendantPid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
    }
    await completed.catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test('contains synchronous exit callback failures without escaping the runner', async () => {
  let calls = 0
  await assert.rejects(runBounded(process.execPath, ['-e', "process.stdout.write('output before exit')"], {
    timeoutMs: 5_000,
    onExit: () => { calls += 1; throw new Error('private callback details') },
  }), error => error.code === 'COMMAND_EXIT_CALLBACK_FAILED' && !error.message.includes('private callback details'))
  assert.equal(calls, 1)
})

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
    assert.deepEqual(invocation.prefixArgs, [await realpath(entry)])
    assert.equal(invocation.displayPath, wrapper)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolves POSIX npm symlinks and pnpm wrappers to inspectable official entries', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-posix-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  const entry = join(packageRoot, 'lib', 'bin.js')
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(entry, '#!/usr/bin/env node\n', { mode: 0o755 })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', publishConfig: { access: 'public' }, bin: { dsh: 'lib/bin.js' },
  }))
  const npmBin = join(root, 'bin', 'dsh')
  const pnpmBin = join(root, 'node_modules', '.bin', 'dsh')
  await mkdir(dirname(npmBin), { recursive: true })
  await mkdir(dirname(pnpmBin), { recursive: true })
  await symlink(entry, npmBin)
  await writeFile(pnpmBin, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  for (const path of [npmBin, pnpmBin, entry]) {
    const invocation = await resolveDshInvocation(path)
    assert.equal(invocation.command, process.execPath)
    assert.deepEqual(invocation.prefixArgs, [entry])
    assert.equal(invocation.displayPath, path)
    assert.equal((await assertOfficialDshInvocation(invocation)).root, packageRoot)
  }

  const badBin = join(root, 'bad', 'dsh')
  await mkdir(dirname(badBin))
  await writeFile(badBin, '#!/bin/sh\nexit 99\n')
  await chmod(badBin, 0o644)
  const previousPath = process.env.PATH
  const previousDsh = process.env.DSH_DEVELOPER_DSH
  try {
    delete process.env.DSH_DEVELOPER_DSH
    process.env.PATH = [dirname(badBin), dirname(npmBin)].join(delimiter)
    assert.deepEqual((await resolveDshInvocation()).prefixArgs, [entry])
    await rm(badBin)
    await symlink(join(root, 'missing'), badBin)
    assert.deepEqual((await resolveDshInvocation()).prefixArgs, [entry])
    process.env.PATH = dirname(badBin)
    await assert.rejects(resolveDshInvocation(), { code: 'DSH_NOT_FOUND' })
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousDsh === undefined) delete process.env.DSH_DEVELOPER_DSH
    else process.env.DSH_DEVELOPER_DSH = previousDsh
  }
})
