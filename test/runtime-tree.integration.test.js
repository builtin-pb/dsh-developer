import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runBounded } from '../lib/runtime.js'

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
