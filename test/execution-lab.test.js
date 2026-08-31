import assert from 'node:assert/strict'
import test from 'node:test'
import { conformExecutionLab, formatExecutionLabReport } from '../lib/execution-lab.js'
import { buildExecutionLabReport } from '../lib/lab/report.js'
import { buildBubblewrapArgv, parseWindowsMounts } from '../lib/lab/wsl-bubblewrap.js'

test('wraps provider evidence in a stable fail-closed lab report', () => {
  const result = {
    provider: { id: 'fixture-provider', version: '1' },
    policy: { network: 'denied' },
    checks: [{
      id: 'lab.fixture',
      status: 'PASS',
      blocking: true,
      message: 'Fixture passed.',
      evidence: { bounded: true },
    }],
  }
  const first = buildExecutionLabReport(result, '2026-01-01T00:00:00.000Z')
  const second = buildExecutionLabReport(result, '2026-01-02T00:00:00.000Z')
  assert.equal(first.ok, true)
  assert.equal(first.evidenceDigest, second.evidenceDigest)
  assert.match(formatExecutionLabReport(first), /^PASS execution lab fixture-provider/u)

  const failed = buildExecutionLabReport({
    provider: { id: 'fixture-provider' },
    policy: {},
    checks: [{ id: 'lab.provider', status: 'FAIL', blocking: true, message: 'failed' }],
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.checks[0].status, 'FAIL')
})

test('fails closed without accepting a caller-supplied provider', async () => {
  let injectedProviderCalled = false
  const report = await conformExecutionLab({
    distro: '\n',
    conformProvider: async () => {
      injectedProviderCalled = true
      return { provider: { id: 'fake' }, policy: {}, checks: [] }
    },
  })
  assert.equal(injectedProviderCalled, false)
  assert.equal(report.ok, false)
  assert.equal(report.provider.id, 'wsl2-bubblewrap')
  assert.equal(report.checks[0].status, 'FAIL')
})

test('constructs a strict argv-only Bubblewrap policy', () => {
  const workspace = '/tmp/dsh-developer-lab-' + 'a'.repeat(32) + '/workspace'
  const cellId = 'b'.repeat(32)
  const argv = buildBubblewrapArgv({
    workspace,
    cellId,
    command: ['/usr/bin/true'],
  })
  const joined = argv.join(' ')
  assert.match(joined, /--unshare-user/u)
  assert.match(joined, /--unshare-pid/u)
  assert.match(joined, /--unshare-net/u)
  assert.match(joined, /--die-with-parent/u)
  assert.match(joined, /--ro-bind \/usr \/usr/u)
  assert.doesNotMatch(joined, /--ro-bind \/ \/ /u)
  for (const link of ['usr/bin /bin', 'usr/sbin /sbin', 'usr/lib /lib', 'usr/lib64 /lib64']) {
    assert.match(joined, new RegExp('--symlink ' + link.replaceAll('/', '\\/'), 'u'))
  }
  assert.match(joined, /--ro-bind \/dev\/null \/init/u)
  for (const path of ['/home', '/root', '/mnt', '/run', '/sys', '/usr/local', '/usr/lib/wsl']) {
    assert.match(joined, new RegExp('--tmpfs ' + path.replaceAll('/', '\\/'), 'u'))
  }
  assert.match(joined, /--clearenv/u)
  assert.match(joined, /\/usr\/bin\/prlimit/u)
  assert.deepEqual(argv.slice(-1), ['/usr/bin/true'])
  assert.throws(
    () => buildBubblewrapArgv({ workspace: '/mnt/d/repo', cellId, command: ['/usr/bin/true'] }),
    (error) => error.code === 'LAB_WORKSPACE_INVALID',
  )
})

test('accepts only Windows mounts covered by the strict masks', () => {
  const safe = parseWindowsMounts(JSON.stringify({
    filesystems: [
      { target: '/mnt/c', fstype: '9p', source: 'C:' },
      { target: '/usr/lib/wsl/drivers', fstype: '9p', source: 'drivers' },
    ],
  }))
  assert.equal(safe.length, 2)
  assert.throws(
    () => parseWindowsMounts(JSON.stringify({
      filesystems: [{ target: '/srv/windows', fstype: '9p', source: 'share' }],
    })),
    (error) => error.code === 'LAB_WINDOWS_MOUNT_UNMASKED',
  )
})
