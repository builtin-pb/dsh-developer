import assert from 'node:assert/strict'
import test from 'node:test'
import { formatCompatibilityMatrix, inspectCompatibilityMatrix } from '../lib/compatibility.js'
import {
  compareCapabilityReports,
  inspectCompatibilityMatrixInternal,
} from '../lib/compatibility-internal.js'

const FINGERPRINT = 'sha256:' + 'a'.repeat(64)

function doctorReport(reproducible = true) {
  return {
    ok: true,
    fingerprint: FINGERPRINT,
    plugin: { name: 'matrix-fixture', packageName: 'matrix-fixture' },
    checks: [
      {
        id: 'packaging.reproducible',
        status: reproducible ? 'PASS' : 'WARN',
        blocking: reproducible,
        message: reproducible ? 'reproduced' : 'repository audit only',
      },
    ],
  }
}

function capabilityReport(lane, version, packageVersion = version) {
  return {
    ok: true,
    runtime: { version, lane: { id: lane } },
    evidenceDigest: 'sha256:' + (lane === 'release' ? 'b' : 'c').repeat(64),
    capabilities: [
      {
        id: 'plugin.lifecycle',
        status: 'native',
        semantics: 'reviewed',
        packages: [{ name: '@deepseek-ai/dsh', version: packageVersion, access: 'public', publicEntry: true }],
      },
      {
        id: 'sandbox.contract',
        status: lane === 'release' ? 'absent' : 'native',
        semantics: lane === 'release' ? 'not-applicable' : 'reviewed',
        packages: lane === 'release'
          ? [{ name: '@deepseek-ai/dsh-sandbox', missing: true }]
          : [{ name: '@deepseek-ai/dsh-sandbox', version, access: 'public', publicEntry: true }],
      },
    ],
  }
}

function dependencies(options = {}) {
  const lifecycleCalls = []
  const versions = {
    release: options.releaseVersion ?? '0.1.1-rc.2',
    preview: options.previewVersion ?? '0.1.2-alpha.2',
  }
  return {
    lifecycleCalls,
    values: {
      lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
      realpath: async (value) => value,
      doctorPlugin: async () => doctorReport(options.reproducible ?? true),
      scanOrdinaryTree: async () => ({ fingerprint: options.freshFingerprint ?? FINGERPRINT }),
      resolveDshInvocation: async (value) => ({
        command: 'fake',
        prefixArgs: [],
        displayPath: value,
      }),
      assertOfficialDshInvocation: async (invocation) => ({
        value: { version: versions[invocation.displayPath] },
      }),
      runDsh: async (invocation) => ({
        stdout: versions[invocation.displayPath] + '\n',
        stderr: '',
        exitCode: 0,
      }),
      inspectDshCapabilities: async (path) => capabilityReport(path, versions[path]),
      smokeDshInstall: async (_source, _name, _packageName, invocation) => {
        lifecycleCalls.push(invocation.displayPath)
        if (options.previewLifecycleFailure && invocation.displayPath === 'preview') {
          throw new Error('injected preview lifecycle failure')
        }
        return {
          installed: true,
          discovered: true,
          loaded: true,
          loadWitness: 'registration-nonce',
          uninstalled: true,
        }
      },
    },
  }
}

async function inspect(values) {
  return inspectCompatibilityMatrixInternal('C:\\fixture', {
    releaseDsh: 'release',
    previewDsh: 'preview',
  }, values)
}

test('executes reproducible bytes on exact release and preview lanes and reports drift', async () => {
  const fixture = dependencies()
  const first = await inspect(fixture.values)
  const second = await inspect(fixture.values)
  assert.equal(first.ok, true, JSON.stringify(first, null, 2))
  assert.deepEqual(first.execution, { eligible: true, basis: 'reproducible-promotion' })
  assert.deepEqual(fixture.lifecycleCalls, ['release', 'preview', 'release', 'preview'])
  assert.deepEqual(first.lanes.map((value) => [value.id, value.ok]), [
    ['release', true],
    ['preview', true],
  ])
  assert.deepEqual(first.drift.map((value) => value.id), ['plugin.lifecycle', 'sandbox.contract'])
  assert.equal(first.drift.find((value) => value.id === 'plugin.lifecycle').classification, 'package-version')
  assert.equal(first.drift.find((value) => value.id === 'sandbox.contract').classification, 'contract')
  assert.equal(first.evidenceDigest, second.evidenceDigest)
  assert.match(formatCompatibilityMatrix(first), /^PASS DSH compatibility matrix matrix-fixture/u)
})

test('keeps preview breakage advisory while preserving it as a failed lane', async () => {
  const fixture = dependencies({ previewLifecycleFailure: true })
  const report = await inspect(fixture.values)
  assert.equal(report.ok, true)
  assert.equal(report.lanes.find((value) => value.id === 'release').ok, true)
  const preview = report.lanes.find((value) => value.id === 'preview')
  assert.equal(preview.ok, false)
  assert.equal(preview.claim, 'advisory')
  assert.equal(preview.checks.find((value) => value.id === 'plugin.lifecycle').status, 'FAIL')
})

test('never executes arbitrary repository code', async () => {
  const fixture = dependencies({ reproducible: false })
  const report = await inspect(fixture.values)
  assert.equal(report.ok, false)
  assert.deepEqual(report.execution, { eligible: false, basis: 'untrusted-repository' })
  assert.deepEqual(fixture.lifecycleCalls, [])
  assert.ok(report.lanes.every((lane) => lane.checks.find((value) => value.id === 'plugin.lifecycle').status === 'SKIP'))
})

test('blocks a mislabeled release lane before capability or plugin execution', async () => {
  const fixture = dependencies({ releaseVersion: '0.1.2-alpha.2' })
  const inspected = []
  const original = fixture.values.inspectDshCapabilities
  fixture.values.inspectDshCapabilities = async (...args) => {
    inspected.push(args[0])
    return original(...args)
  }
  const report = await inspect(fixture.values)
  assert.equal(report.ok, false)
  assert.deepEqual(inspected, ['preview'])
  assert.deepEqual(fixture.lifecycleCalls, ['preview'])
  assert.equal(report.lanes.find((value) => value.id === 'release').checks[0].status, 'FAIL')
})

test('fails when source bytes change during the matrix', async () => {
  const fixture = dependencies({ freshFingerprint: 'sha256:' + 'd'.repeat(64) })
  const report = await inspect(fixture.values)
  assert.equal(report.ok, false)
  const freshness = report.checks.find((value) => value.id === 'source.freshness')
  assert.equal(freshness.status, 'FAIL')
  assert.equal(freshness.evidence.code, 'STALE_VERIFICATION')
})

test('compares capability reports without retaining mutable report objects', () => {
  const release = capabilityReport('release', '0.1.1-rc.2')
  const preview = capabilityReport('preview', '0.1.2-alpha.2')
  const drift = compareCapabilityReports(release, preview)
  release.capabilities[0].packages[0].version = 'mutated'
  assert.equal(drift[0].from.packages[0].version, '0.1.1-rc.2')

  release.capabilities[0].partialGuarantee = 'writes only'
  preview.capabilities[0].partialGuarantee = 'writes and reads'
  assert.equal(
    compareCapabilityReports(release, preview)
      .find((value) => value.id === 'plugin.lifecycle').classification,
    'contract',
  )
})

test('validates the closed public option surface before touching source', async () => {
  await assert.rejects(
    inspectCompatibilityMatrix('C:\\never-read', {
      releaseDsh: 'release',
      previewDsh: 'preview',
      trustMe: true,
    }),
    (error) => error.code === 'COMPATIBILITY_OPTIONS_INVALID',
  )
  await assert.rejects(
    inspectCompatibilityMatrix('C:\\never-read', { releaseDsh: 'release' }),
    (error) => error.code === 'COMPATIBILITY_OPTIONS_INVALID',
  )
})
