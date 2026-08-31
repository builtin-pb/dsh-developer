import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { acquireCellAdmissionLease, issueCellAdmissionGrant } from '../lib/cell-admission-grant.js'
import { DshDeveloperError } from '../lib/errors.js'
import { fingerprintFileMap } from '../lib/files.js'
import { openIsolatedCellInternal } from '../lib/isolated-cell-internal.js'
import { openIsolatedCell } from '../lib/isolated-cell.js'

test('runs in a private cell and stages a full changed tree without touching source', async () => {
  const source = await mkdtemp(join(tmpdir(), 'dsh-developer-cell-source-'))
  await writeFile(join(source, 'index.js'), 'export const value = "before"\n', 'utf8')
  let runSpec
  let disposed = false
  const snapshotEntries = [
    { path: 'index.js', content: 'export const value = "after"\n' },
    { path: 'lib/new.js', content: 'export const added = true\n' },
  ]
  const fakeCell = {
    provider: { id: 'fake', distro: 'fixture', kernel: 'fixture', bwrapVersion: 'fixture' },
    async run(command, options) {
      runSpec = { command, options }
      return {
        stdout: 'ok\n', stderr: '', exitCode: 7,
        cleanup: { found: [1], killed: [1], remaining: [] },
      }
    },
    async snapshot() {
      return {
        entries: snapshotEntries,
        fingerprint: fingerprintFileMap(new Map(snapshotEntries.map((entry) => [entry.path, entry.content]))),
      }
    },
    async dispose() { disposed = true },
  }
  let stagingRoot
  try {
    const cell = await openIsolatedCellInternal(source, {}, {
      createWslBubblewrapCell: async () => fakeCell,
      mkdtemp: async () => {
        stagingRoot = await mkdtemp(join(tmpdir(), 'dsh-developer-cell-stage-test-'))
        return stagingRoot
      },
    })
    const result = await cell.exec('node --test', { timeoutMs: 1_000 })
    assert.equal(result.exitCode, 7)
    assert.deepEqual(runSpec.command, ['/bin/sh', '-c', 'node --test'])
    assert.equal(runSpec.options.acceptedExitCodes.length, 256)
    assert.equal(result.cleanup.remaining, 0)

    const staged = await cell.stageResult()
    assert.equal(staged.changed, true)
    assert.equal(staged.stagingRoot, stagingRoot)
    assert.deepEqual(staged.changes, { created: ['lib/new.js'], modified: ['index.js'], deleted: [] })
    assert.equal(await readFile(join(staged.staging, 'index.js'), 'utf8'), 'export const value = "after"\n')
    assert.equal(await readFile(join(source, 'index.js'), 'utf8'), 'export const value = "before"\n')
    await assert.rejects(cell.exec('true'), (error) => error.code === 'CELL_SEALED')
    await cell.dispose()
    await cell.dispose()
    assert.equal(disposed, true)
  } finally {
    await rm(source, { recursive: true, force: true })
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true })
  }
})

test('places host staging outside a junction-aliased physical source tree', async () => {
  const sourceRoot = resolve('lexical-source')
  const hostTempRoot = resolve('lexical-host-temp')
  const physicalSourceRoot = resolve('physical-source')
  const physicalTempRoot = join(physicalSourceRoot, 'host-temp')
  const before = [{ path: 'index.js', content: 'before\n' }]
  const after = [{ path: 'index.js', content: 'after\n' }]
  let stagingPrefix
  const fakeCell = {
    provider: { id: 'fake', distro: 'fixture', kernel: 'fixture', bwrapVersion: 'fixture' },
    async run() { throw new Error('unused') },
    async snapshot() {
      return { entries: after, fingerprint: fingerprintFileMap(new Map([['index.js', 'after\n']])) }
    },
    async dispose() {},
  }
  const cell = await openIsolatedCellInternal('fixture', {}, {
    scanOrdinaryTree: async () => ({
      root: sourceRoot,
      entries: before,
      fingerprint: fingerprintFileMap(new Map([['index.js', 'before\n']])),
    }),
    createWslBubblewrapCell: async () => fakeCell,
    tmpdir: () => hostTempRoot,
    realpath: async (value) => (
      resolve(value) === sourceRoot ? physicalSourceRoot : physicalTempRoot
    ),
    mkdtemp: async (prefix) => {
      stagingPrefix = prefix
      throw new Error('stop after selecting the staging base')
    },
  })

  await assert.rejects(cell.stageResult(), /stop after selecting the staging base/)
  assert.equal(dirname(stagingPrefix), dirname(physicalSourceRoot))
  await cell.dispose()
})

test('rejects and removes a created staging directory that aliases back into source', async () => {
  const sourceRoot = resolve('lexical-source-postcheck')
  const hostTempRoot = resolve('lexical-temp-postcheck')
  const stagingRoot = resolve('lexical-staging-postcheck')
  const physicalSourceRoot = resolve('physical-source-postcheck')
  const before = [{ path: 'index.js', content: 'before\n' }]
  const after = [{ path: 'index.js', content: 'after\n' }]
  let removed
  const fakeCell = {
    provider: { id: 'fake', distro: 'fixture', kernel: 'fixture', bwrapVersion: 'fixture' },
    async run() { throw new Error('unused') },
    async snapshot() {
      return { entries: after, fingerprint: fingerprintFileMap(new Map([['index.js', 'after\n']])) }
    },
    async dispose() {},
  }
  const cell = await openIsolatedCellInternal('fixture', {}, {
    scanOrdinaryTree: async () => ({
      root: sourceRoot,
      entries: before,
      fingerprint: fingerprintFileMap(new Map([['index.js', 'before\n']])),
    }),
    createWslBubblewrapCell: async () => fakeCell,
    tmpdir: () => hostTempRoot,
    mkdtemp: async () => stagingRoot,
    realpath: async (value) => {
      if (resolve(value) === sourceRoot) return physicalSourceRoot
      if (resolve(value) === hostTempRoot) return resolve('physical-external-temp')
      return join(physicalSourceRoot, '.dsh-developer-cell-result-alias')
    },
    rm: async (path) => { removed = path },
  })

  await assert.rejects(
    cell.stageResult(),
    (error) => error.code === 'CELL_STAGING_SEPARATION',
  )
  assert.equal(removed, stagingRoot)
  await cell.dispose()
})

test('public isolated-cell API rejects dependency injection', async () => {
  let called = false
  await assert.rejects(
    openIsolatedCell('.', { createWslBubblewrapCell: async () => { called = true } }),
    (error) => error.code === 'CELL_OPTIONS_INVALID',
  )
  assert.equal(called, false)
})

test('public isolated-cell API requires an authentic admitted report before reading source', async () => {
  await assert.rejects(
    openIsolatedCell('must-not-be-read'),
    (error) => error.code === 'CELL_ADMISSION_REQUIRED',
  )
  const unsupported = issueCellAdmissionGrant({
    kind: 'isolated-agent-cell-admission',
    admitted: false,
    disposition: 'Unsupported',
    evidenceDigest: 'sha256:fixture',
    runtime: { version: 'fixture' },
    checks: [],
  })
  unsupported.admitted = true
  unsupported.disposition = 'Incubate'
  await assert.rejects(
    openIsolatedCell('must-not-be-read', { admission: unsupported }),
    (error) => error.code === 'CELL_NOT_ADMITTED',
  )
})

test('bounds public cell capacity across reusable admission reports', () => {
  const admitted = issueCellAdmissionGrant({
    kind: 'isolated-agent-cell-admission',
    admitted: true,
    disposition: 'Incubate',
    evidenceDigest: 'sha256:admitted-fixture',
    runtime: { version: 'fixture' },
    checks: [{
      id: 'replacement.local-boundary',
      evidence: { provider: { id: 'wsl2-bubblewrap', distro: 'Ubuntu-22.04' } },
    }],
  })
  const first = acquireCellAdmissionLease(admitted)
  assert.throws(
    () => acquireCellAdmissionLease(admitted),
    (error) => error.code === 'CELL_CAPACITY' && error.details.limit === 1,
  )
  first.release()
  first.release()
  const second = acquireCellAdmissionLease(admitted)
  second.release()
})

test('disposal seals the public handle immediately and can retry failed cleanup', async () => {
  let finishCleanup
  let disposeCalls = 0
  const cleanupStarted = new Promise((resolve) => { finishCleanup = resolve })
  const fakeCell = {
    provider: { id: 'fake', distro: 'fixture', kernel: 'fixture', bwrapVersion: 'fixture' },
    async run() {
      throw new Error('run must not be reached while closing')
    },
    async snapshot() {
      throw new Error('snapshot must not be reached while closing')
    },
    async dispose() {
      disposeCalls += 1
      if (disposeCalls === 1) {
        await cleanupStarted
        throw new Error('fixture cleanup failure')
      }
    },
  }
  const sourceTree = {
    root: 'fixture',
    entries: [],
    fingerprint: fingerprintFileMap(new Map()),
  }
  const cell = await openIsolatedCellInternal('fixture', {}, {
    scanOrdinaryTree: async () => sourceTree,
    createWslBubblewrapCell: async () => fakeCell,
  })

  const firstDispose = cell.dispose()
  await assert.rejects(cell.exec('true'), (error) => error.code === 'CELL_CLOSING')
  finishCleanup()
  await assert.rejects(firstDispose, /fixture cleanup failure/)
  await assert.rejects(cell.stageResult(), (error) => error.code === 'CELL_CLOSING')
  await cell.dispose()
  await cell.dispose()
  assert.equal(disposeCalls, 2)
  await assert.rejects(cell.exec('true'), (error) => error.code === 'CELL_DISPOSED')
})

test('serializes commands and sealing, settles sealing before disposal, and validates method options', async () => {
  let disposed = false
  let snapshotPending
  let observedSignal
  const events = []
  const emptyFingerprint = fingerprintFileMap(new Map())
  const fakeCell = {
    provider: { id: 'fake', distro: 'fixture', kernel: 'fixture', bwrapVersion: 'fixture' },
    async run() {
      throw new Error('run must not enter while sealing')
    },
    async snapshot(options) {
      observedSignal = options.signal
      snapshotPending = new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          events.push('snapshot-cancelled')
          reject(new Error('fixture snapshot cancelled'))
        }, { once: true })
      })
      return snapshotPending
    },
    async dispose() {
      await snapshotPending?.catch(() => {})
      events.push('provider-disposed')
      disposed = true
    },
  }
  const cell = await openIsolatedCellInternal('fixture', {}, {
    scanOrdinaryTree: async () => ({ root: 'fixture', entries: [], fingerprint: emptyFingerprint }),
    createWslBubblewrapCell: async () => fakeCell,
  })

  await assert.rejects(cell.exec('true', null), (error) => error.code === 'CELL_OPTIONS_INVALID')
  await assert.rejects(cell.stageResult(null), (error) => error.code === 'CELL_OPTIONS_INVALID')
  const sealing = cell.stageResult()
  await assert.rejects(cell.exec('true'), (error) => error.code === 'CELL_BUSY')
  await assert.rejects(cell.stageResult(), (error) => error.code === 'CELL_BUSY')
  const disposing = cell.dispose()
  await assert.rejects(cell.exec('true'), (error) => error.code === 'CELL_CLOSING')
  assert.equal(observedSignal.aborted, true)
  await assert.rejects(sealing, /fixture snapshot cancelled/)
  await disposing
  assert.equal(disposed, true)
  assert.deepEqual(events, ['snapshot-cancelled', 'provider-disposed'])
  await assert.rejects(cell.exec('true'), (error) => error.code === 'CELL_DISPOSED')
})

test('combines cell and per-command cancellation signals', async () => {
  const cellController = new AbortController()
  const commandController = new AbortController()
  const emptyFingerprint = fingerprintFileMap(new Map())
  let observedSignal
  let disposeCalls = 0
  const fakeCell = {
    provider: { id: 'fake', distro: 'fixture', kernel: 'fixture', bwrapVersion: 'fixture' },
    async run(_command, options) {
      observedSignal = options.signal
      return { stdout: '', stderr: '', exitCode: 0, cleanup: { found: [], killed: [], remaining: [] } }
    },
    async snapshot() { return { entries: [], fingerprint: emptyFingerprint } },
    async dispose() { disposeCalls += 1 },
  }
  const cell = await openIsolatedCellInternal('fixture', { signal: cellController.signal }, {
    scanOrdinaryTree: async () => ({ root: 'fixture', entries: [], fingerprint: emptyFingerprint }),
    createWslBubblewrapCell: async () => fakeCell,
  })
  await cell.exec('true', { signal: commandController.signal })
  assert.notEqual(observedSignal, cellController.signal)
  assert.notEqual(observedSignal, commandController.signal)
  cellController.abort()
  assert.equal(observedSignal.aborted, true)
  await Promise.resolve()
  assert.equal(disposeCalls, 1)
  await cell.dispose()
  assert.equal(disposeCalls, 1)
})

test('disposes a workspace-poisoned cell before returning its command failure', async () => {
  const emptyFingerprint = fingerprintFileMap(new Map())
  let disposed = false
  const fakeCell = {
    provider: { id: 'fake', distro: 'fixture', kernel: 'fixture', bwrapVersion: 'fixture' },
    async run() {
      throw new DshDeveloperError('CELL_WORKSPACE_LIMIT', 'fixture aggregate limit')
    },
    async snapshot() { return { entries: [], fingerprint: emptyFingerprint } },
    async dispose() { disposed = true },
  }
  const cell = await openIsolatedCellInternal('fixture', {}, {
    scanOrdinaryTree: async () => ({ root: 'fixture', entries: [], fingerprint: emptyFingerprint }),
    createWslBubblewrapCell: async () => fakeCell,
  })
  await assert.rejects(cell.exec('true'), (error) => error.code === 'CELL_WORKSPACE_LIMIT')
  assert.equal(disposed, true)
  await assert.rejects(cell.exec('true'), (error) => error.code === 'CELL_DISPOSED')
})

test('reports a retained staging root when cleanup of a failed materialization also fails', async () => {
  const before = [{ path: 'index.js', content: 'before\n' }]
  const after = [{ path: 'index.js', content: 'after\n' }]
  const fakeCell = {
    provider: { id: 'fake', distro: 'fixture', kernel: 'fixture', bwrapVersion: 'fixture' },
    async run() { throw new Error('unused') },
    async snapshot() {
      return { entries: after, fingerprint: fingerprintFileMap(new Map([['index.js', 'after\n']])) }
    },
    async dispose() {},
  }
  const cell = await openIsolatedCellInternal('fixture', {}, {
    scanOrdinaryTree: async () => ({
      root: 'fixture',
      entries: before,
      fingerprint: fingerprintFileMap(new Map([['index.js', 'before\n']])),
    }),
    createWslBubblewrapCell: async () => fakeCell,
    mkdtemp: async () => 'C:\\fixture-staging-root',
    realpath: async (value) => resolve(value),
    mkdir: async () => { throw new Error('fixture materialization failure') },
    rm: async () => { throw new Error('fixture cleanup failure') },
  })
  await assert.rejects(
    cell.stageResult(),
    (error) => error.code === 'CELL_STAGING_CLEANUP_FAILED'
      && error.details.stagingRoot === 'C:\\fixture-staging-root'
      && error.details.failure.message === 'fixture materialization failure'
      && error.details.cleanup.message === 'fixture cleanup failure',
  )
  await cell.dispose()
})
