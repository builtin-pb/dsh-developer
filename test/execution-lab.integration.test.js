import assert from 'node:assert/strict'
import test from 'node:test'
import { conformExecutionLab } from '../lib/execution-lab.js'
import { conformWslBubblewrap } from '../lib/lab/wsl-bubblewrap.js'
import { runBounded } from '../lib/runtime.js'

test('conforms the real WSL2 Bubblewrap execution lab', {
  skip: process.env.DSH_DEVELOPER_WSL_LAB_TEST !== '1',
  timeout: 90_000,
}, async () => {
  const report = await conformExecutionLab({
    distro: process.env.DSH_DEVELOPER_WSL_DISTRO || 'Ubuntu-22.04',
  })
  assert.equal(report.ok, true, JSON.stringify(report, null, 2))
  for (const id of [
    'lab.filesystem.workspace-write',
    'lab.filesystem.private-read',
    'lab.filesystem.host-write',
    'lab.environment',
    'lab.network',
    'lab.devices',
    'lab.processes',
    'lab.resources-and-heartbeat',
    'lab.controller-crash-recovery',
    'lab.cancellation',
    'lab.cleanup',
  ]) {
    assert.equal(report.checks.find((value) => value.id === id)?.status, 'PASS', id)
  }
})

test('tears down a real WSL lab root after controller cancellation', {
  skip: process.env.DSH_DEVELOPER_WSL_LAB_TEST !== '1',
  timeout: 30_000,
}, async () => {
  const controller = new AbortController()
  let createdRoot
  const tracedRunBounded = async (command, args, options) => {
    const result = await runBounded(command, args, options)
    const candidate = args.at(-1)
    if (args.includes('/usr/bin/mkdir')
        && typeof candidate === 'string'
        && /^\/tmp\/dsh-developer-lab-[a-f0-9]{32}$/u.test(candidate)) {
      createdRoot = candidate
      controller.abort()
    }
    return result
  }
  const result = await conformWslBubblewrap({
    distro: process.env.DSH_DEVELOPER_WSL_DISTRO || 'Ubuntu-22.04',
    signal: controller.signal,
    runBounded: tracedRunBounded,
  })
  assert.match(createdRoot, /^\/tmp\/dsh-developer-lab-/u)
  assert.equal(result.checks.some((value) => value.status === 'FAIL'), true)
  assert.equal(result.checks.find((value) => value.id === 'lab.cleanup')?.status, 'PASS')
})
