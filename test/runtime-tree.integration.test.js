import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runBounded } from '../lib/runtime.js'

for (const stdio of ['ignore', 'inherit']) test(`opt-in cleanup reaps a TERM-resistant worker with ${stdio} stdio after leader exit`, {
  skip: process.env.DSH_DEVELOPER_PROCESS_TEST !== '1' || process.platform === 'win32',
  timeout: 8_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-exit-worker-'))
  const marker = join(root, 'worker.pid')
  const worker = `
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
    process.send('ready');
  `
  const leader = `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', ${JSON.stringify(worker)}, process.argv[1]],
      { stdio: ['ignore', ${JSON.stringify(stdio)}, ${JSON.stringify(stdio)}, 'ipc'] });
    child.once('message', () => setTimeout(() => process.exit(23), 500));
  `
  try {
    const result = await runBounded(process.execPath, ['-e', leader, marker], {
      cleanupProcessGroupOnExit: true, acceptedExitCodes: [23], timeoutMs: 1_000,
    })
    assert.equal(result.exitCode, 23, 'cleanup preserves the leader exit status even when its grace period crosses the deadline')
    const pid = Number(await readFile(marker, 'utf8'))
    // SIGKILL ends execution before the OS necessarily reaps the orphan PID.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') break; throw error }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally {
    const pid = Number(await readFile(marker, 'utf8').catch(() => ''))
    if (pid > 0) { try { process.kill(pid, 'SIGKILL') } catch {} }
    await rm(root, { recursive: true, force: true })
  }
})

for (const first of ['cancellation', 'timeout']) test(`preserves ${first} as the initiating cause during slow termination`, {
  skip: process.env.DSH_DEVELOPER_PROCESS_TEST !== '1' || process.platform === 'win32',
  timeout: 8_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-termination-cause-'))
  const ready = join(root, 'ready')
  const controller = new AbortController()
  const code = `
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(process.argv[1], 'ready');
    setInterval(() => {}, 1000);
  `
  const started = Date.now()
  const running = runBounded(process.execPath, ['-e', code, ready], {
    timeoutMs: 2_000, signal: controller.signal,
  })
  const checked = assert.rejects(running, { code: first === 'cancellation' ? 'CANCELLED' : 'COMMAND_TIMEOUT' })
  try {
    // Wait for a real TERM handler; cancellation must exercise the grace period.
    while (!await stat(ready).catch(() => undefined)) {
      assert.ok(Date.now() - started < 1_500, 'child did not become ready')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const cancelAt = first === 'cancellation' ? 1_750 : 2_250
    await new Promise(resolve => setTimeout(resolve, Math.max(0, started + cancelAt - Date.now())))
    controller.abort()
    await checked
  } finally {
    controller.abort()
    await running.catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test('cancellation kills a TERM-resistant descendant after its leader exits', {
  skip: process.env.DSH_DEVELOPER_PROCESS_TEST !== '1' || process.platform === 'win32',
  timeout: 8_000,
}, async () => {
  const controller = new AbortController()
  const childCode = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
    setInterval(() => {}, 1000);
  `
  const timer = setTimeout(() => controller.abort(), 400)
  try {
    await assert.rejects(runBounded(process.execPath, ['-e', childCode], { signal: controller.signal, timeoutMs: 5_000 }),
      error => error.code === 'CANCELLED')
  } finally { clearTimeout(timer) }
})

test('cancellation terminates the command process tree', {
  skip: process.env.DSH_DEVELOPER_PROCESS_TEST !== '1',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-process-tree-'))
  const sentinel = join(root, 'grandchild-survived.txt')
  const grandchildCode = [
    "const { writeFileSync } = require('node:fs')",
    "setTimeout(() => writeFileSync(process.argv[1], 'survived'), 1200)",
    "setInterval(() => {}, 1000)",
  ].join(';')
  const childCode = [
    "const { spawn } = require('node:child_process')",
    'spawn(process.execPath, [' + JSON.stringify('-e') + ', ' + JSON.stringify(grandchildCode) + ', process.argv[1]], { stdio: ' + JSON.stringify('ignore') + ' })',
    'setInterval(() => {}, 1000)',
  ].join(';')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 150)
  try {
    await assert.rejects(
      runBounded(process.execPath, ['-e', childCode, sentinel], {
        signal: controller.signal,
        timeoutMs: 5_000,
        label: 'process-tree probe',
      }),
      (error) => error.code === 'CANCELLED',
    )
    await new Promise((accept) => setTimeout(accept, 1_700))
    await assert.rejects(stat(sentinel), /ENOENT/u)
  } finally {
    clearTimeout(timer)
    await rm(root, { recursive: true, force: true })
  }
})
