import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET } from '../lib/constants.js'
import { assertOfficialDshInvocation, locateInstalledDshPackage, resolveInstalledDshEntry } from '../lib/dsh-installation.js'
import { resolveDshInvocation } from '../lib/runtime.js'
import {
  capabilitySpecs,
  formatCapabilityReport,
  inspectDshCapabilities,
} from '../lib/capabilities.js'

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

async function fakeDsh(version = DSH_COMPATIBILITY_TARGET, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-capabilities-'))
  const dshRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  const entry = join(dshRoot, 'lib', 'bin.js')
  await mkdir(dirname(entry), { recursive: true })
  const help = options.help ?? 'Usage: dsh --profile <name> --dump-config plugin\n'
  await writeFile(entry, [
    "const arg = process.argv[2]",
    "if (arg === '--version') process.stdout.write(" + JSON.stringify(version + '\n') + ")",
    "else if (arg === '--help') process.stdout.write(" + JSON.stringify(help) + ")",
    "else process.exitCode = 2",
    '',
  ].join('\n'), 'utf8')
  await writeJson(join(dshRoot, 'package.json'), {
    name: '@deepseek-ai/dsh',
    version: options.packageVersion ?? version,
    type: 'module',
    publishConfig: { access: 'public' },
  })
  async function addPackage(name, packageOptions = {}) {
    await writeJson(join(dshRoot, 'node_modules', ...name.split('/'), 'package.json'), {
      name,
      version: packageOptions.version ?? version,
      main: 'lib/index.js',
      ...(packageOptions.unpublished ? { private: true } : { publishConfig: { access: 'public' } }),
    })
  }
  async function runDsh(_invocation, args) {
    if (args[0] === '--version') return { stdout: version + '\n', stderr: '', exitCode: 0 }
    if (args[0] === '--help') return { stdout: help, stderr: '', exitCode: 0 }
    throw new Error('unexpected fake DSH arguments: ' + args.join(' '))
  }
  async function smokeDshInstall() {
    return {
      installed: true,
      discovered: true,
      loaded: true,
      loadWitness: 'registration-nonce',
      uninstalled: true,
    }
  }
  return { root, entry, addPackage, runDsh, smokeDshInstall }
}

function inspectionOptions(fixture) {
  return {
    runDsh: fixture.runDsh,
    smokeDshInstall: fixture.smokeDshInstall,
  }
}

test('reports exact lane evidence without turning absent optional capabilities into failures', async () => {
  const fixture = await fakeDsh()
  try {
    for (const name of new Set(capabilitySpecs()
      .filter((value) => !['subagent.acp', 'team.experimental', 'session.snapshot-support'].includes(value.id))
      .flatMap((value) => value.packages))) await fixture.addPackage(name)
    await fixture.addPackage('@deepseek-ai/dsh-experimental-agent-team', { unpublished: true })

    const first = await inspectDshCapabilities(fixture.entry, inspectionOptions(fixture))
    const second = await inspectDshCapabilities(fixture.entry, inspectionOptions(fixture))
    assert.equal(first.ok, true, JSON.stringify(first.checks, null, 2))
    assert.equal(first.runtime.lane.claim, 'blocking')
    assert.equal(first.capabilities.find((value) => value.id === 'subagent.core').status, 'native')
    assert.equal(first.capabilities.find((value) => value.id === 'subagent.acp').status, 'absent')
    const windowsSandbox = first.capabilities.find((value) => value.id === 'sandbox.windows-acl')
    assert.equal(windowsSandbox.status, 'present-unclassified')
    assert.equal(windowsSandbox.semantics, 'unreviewed')
    assert.equal(windowsSandbox.partialGuarantee, undefined)
    assert.equal(first.capabilities.find((value) => value.id === 'team.experimental').status, 'present-unclassified')
    for (const id of ['plugin.native-surface', 'tools.approval-guard', 'agent.delegation-authority', 'subagent.core']) {
      const capability = first.capabilities.find((value) => value.id === id)
      assert.equal(capability.status, 'native')
      assert.equal(capability.semantics, 'reviewed')
      assert.equal(capability.confidence, 'inventory')
      assert.match(capability.review.observedOn, /macOS ARM64/u)
      assert.match(capability.review.limitation, /not a probe in this inspection/u)
    }
    assert.equal(first.evidenceDigest, second.evidenceDigest)
    const changedLifecycle = await inspectDshCapabilities(fixture.entry, {
      ...inspectionOptions(fixture),
      smokeDshInstall: async () => ({
        installed: true,
        discovered: true,
        loaded: true,
        loadWitness: 'different-witness-kind',
        uninstalled: true,
      }),
    })
    assert.equal(changedLifecycle.ok, false)
    assert.equal(changedLifecycle.capabilities.find((value) => value.id === 'plugin.lifecycle').status, 'partial')
    assert.notEqual(first.evidenceDigest, changedLifecycle.evidenceDigest)
    assert.ok(formatCapabilityReport(first).startsWith('PASS DSH capabilities ' + DSH_COMPATIBILITY_TARGET + ' [blocking]'))
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('recognizes the declared preview lane without promoting it to blocking evidence', async () => {
  const fixture = await fakeDsh(DSH_PREVIEW_TARGET)
  try {
    const report = await inspectDshCapabilities(fixture.entry, inspectionOptions(fixture))
    assert.equal(report.ok, true)
    assert.deepEqual(report.runtime.lane, { id: 'preview', claim: 'preview', recognized: true })
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('does not apply reviewed package semantics to an unrecognized DSH lane', async () => {
  const fixture = await fakeDsh('0.2.0')
  try {
    await fixture.addPackage('@deepseek-ai/dsh-sandbox-windows-acl')
    const report = await inspectDshCapabilities(fixture.entry, inspectionOptions(fixture))
    const capability = report.capabilities.find((value) => value.id === 'sandbox.windows-acl')
    assert.equal(report.runtime.lane.claim, 'unsupported')
    assert.match(formatCapabilityReport(report), /\[unreviewed audit lane\]/u)
    assert.match(formatCapabilityReport(report), /Ordinary development is checked separately/u)
    assert.equal(capability.status, 'present-unclassified')
    assert.equal(capability.semantics, 'unreviewed')
    assert.equal(capability.partialGuarantee, undefined)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('fails conformance when CLI and package identity disagree', async () => {
  const fixture = await fakeDsh(DSH_COMPATIBILITY_TARGET, {
    packageVersion: DSH_PREVIEW_TARGET,
    help: 'Usage: dsh --profile <name>\n',
  })
  try {
    const report = await inspectDshCapabilities(fixture.entry, inspectionOptions(fixture))
    assert.equal(report.ok, false)
    assert.equal(report.checks.find((value) => value.id === 'runtime.cli-contract').status, 'FAIL')
    assert.equal(report.checks.find((value) => value.id === 'installation.package-identity').status, 'FAIL')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('fails the report when the controlled lifecycle cannot settle', async () => {
  const fixture = await fakeDsh()
  try {
    const report = await inspectDshCapabilities(fixture.entry, {
      ...inspectionOptions(fixture),
      smokeDshInstall: async () => { throw new Error('injected lifecycle failure') },
    })
    assert.equal(report.ok, false)
    assert.equal(report.checks.find((value) => value.id === 'runtime.plugin-lifecycle').status, 'FAIL')
    assert.equal(report.capabilities.find((value) => value.id === 'plugin.lifecycle').status, 'partial')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('keeps the capability catalogue closed and uniquely identified', () => {
  const specs = capabilitySpecs()
  assert.equal(new Set(specs.map((value) => value.id)).size, specs.length)
  assert.ok(specs.every((value) => value.packages.length > 0))
  for (const id of ['subagent.acp', 'sandbox.contract', 'sandbox.local-provider',
    'sandbox.windows-acl', 'team.experimental', 'session.snapshot-support']) {
    assert.deepEqual(specs.find((value) => value.id === id).reviewedVersions, ['0.1.1-rc.2', '0.1.2-alpha.3'])
  }
  for (const id of ['tools.approval-guard', 'agent.delegation-authority']) {
    assert.deepEqual(specs.find((value) => value.id === id).reviewedVersions, ['0.1.5-rc.2', '0.1.6-alpha.1', '0.1.6-alpha.2'])
  }
  assert.deepEqual(specs.find((value) => value.id === 'subagent.core').reviewedVersions,
    ['0.1.1-rc.2', '0.1.2-alpha.3', '0.1.5-rc.2', '0.1.6-alpha.1', '0.1.6-alpha.2'])
  const nativeSurface = specs.find((value) => value.id === 'plugin.native-surface')
  assert.ok(nativeSurface.packages.includes('@deepseek-ai/dsh-commands'))
  assert.ok(nativeSurface.packages.includes('@deepseek-ai/dsh-tools'))
  assert.ok(!nativeSurface.packages.includes('@deepseek-ai/dsh-native-command'))
  assert.match(specs.find((value) => value.id === 'sandbox.windows-acl').partialGuarantee, /Write restriction only/u)
})

test('recognized operational lanes do not confer historical provider reviews', async () => {
  for (const version of [DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET]) {
    const fixture = await fakeDsh(version)
    try {
      for (const name of new Set(capabilitySpecs().flatMap((value) => value.packages))) await fixture.addPackage(name)
      const report = await inspectDshCapabilities(fixture.entry, inspectionOptions(fixture))
      assert.equal(report.ok, true)
      assert.equal(report.runtime.lane.recognized, true)
      for (const id of ['subagent.acp', 'sandbox.contract', 'sandbox.local-provider',
        'sandbox.windows-acl', 'team.experimental', 'session.snapshot-support']) {
        const capability = report.capabilities.find((value) => value.id === id)
        assert.equal(capability.status, 'present-unclassified', id)
        assert.equal(capability.semantics, 'unreviewed', id)
        assert.equal(capability.review, undefined, id)
        assert.equal(capability.partialGuarantee, undefined, id)
      }
      for (const id of ['tools.approval-guard', 'agent.delegation-authority', 'subagent.core']) {
        assert.equal(report.capabilities.find((value) => value.id === id).semantics, 'reviewed')
      }
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }
})

test('preserves alpha.1 observations and confines alpha.2 reviews independently of the operational target', async () => {
  for (const version of ['0.1.6-alpha.1', '0.1.6-alpha.2']) {
    const fixture = await fakeDsh(version)
    try {
      for (const name of new Set(capabilitySpecs().flatMap((value) => value.packages))) await fixture.addPackage(name)
      const report = await inspectDshCapabilities(fixture.entry, inspectionOptions(fixture))
      assert.equal(report.ok, true)
      assert.equal(report.runtime.lane.recognized, version === DSH_PREVIEW_TARGET)
      const capabilities = new Map(report.capabilities.map(value => [value.id, value]))
      for (const id of ['plugin.native-surface', 'tools.approval-guard', 'agent.delegation-authority', 'subagent.core']) {
        const capability = capabilities.get(id)
        assert.equal(capability.status, 'native', id)
        assert.equal(capability.semantics, 'reviewed', id)
        assert.deepEqual(capability.review.versions, version === '0.1.6-alpha.1'
          ? ['0.1.5-rc.2', '0.1.6-alpha.1'] : ['0.1.6-alpha.2'])
        assert.equal(capability.review.observedOn, 'macOS ARM64, Node 24.19.0, '
          + (version === '0.1.6-alpha.1' ? '2026-09-16' : '2026-09-19'))
        assert.equal(capability.review.id.endsWith('-alpha2'), version === '0.1.6-alpha.2')
      }
      for (const id of ['subagent.acp', 'sandbox.contract', 'sandbox.local-provider',
        'sandbox.windows-acl', 'team.experimental', 'session.snapshot-support']) {
        const capability = capabilities.get(id)
        assert.equal(capability.status, 'present-unclassified', id)
        assert.equal(capability.semantics, 'unreviewed', id)
        assert.equal(capability.review, undefined, id)
        assert.equal(capability.partialGuarantee, undefined, id)
      }
      if (version === '0.1.6-alpha.2') {
        assert.match(capabilities.get('subagent.core').review.scope,
          /not capacity enforcement, provider execution, continuations, cancellation or isolation/u)
        assert.match(capabilities.get('agent.delegation-authority').review.scope, /not subagent-provider lifecycle or isolation/u)
        assert.match(capabilities.get('plugin.native-surface').review.scope, /headless and Web compositions/u)
      }
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }
})

for (const [lane, dshPath, version] of [
  ['release', process.env.DSH_DEVELOPER_RELEASE_DSH, DSH_COMPATIBILITY_TARGET],
  ['preview', process.env.DSH_DEVELOPER_PREVIEW_DSH, DSH_PREVIEW_TARGET],
]) {
  test('exact ' + lane + ' native subagent registry and shared-workspace contract', {
    skip: process.env.DSH_DEVELOPER_SUBAGENT_CONTRACT_TEST !== '1',
  }, async () => {
    assert.ok(dshPath, 'An explicit exact-lane DSH path is required')
    const installed = await assertOfficialDshInvocation(await resolveDshInvocation(dshPath))
    assert.equal(installed.value.version, version)
    const subagent = await locateInstalledDshPackage(installed, '@deepseek-ai/dsh-subagent')
    assert.equal(subagent.value.version, version)
    assert.equal(subagent.value.publishConfig?.access, 'public')
    const require = createRequire(subagent.manifestPath)
    const [{ Context }, native] = await Promise.all([
      import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href),
      import(pathToFileURL(await resolveInstalledDshEntry(subagent)).href),
    ])
    const parent = { ctx: { get: () => undefined }, session: { header: { id: 'bounded-parent', cwd: process.cwd() } } }
    const first = native.childSessionMeta(parent, 1, false)
    const second = native.childSessionMeta(parent, 1, false)
    assert.equal(first.cwd, parent.session.header.cwd)
    assert.equal(second.cwd, first.cwd)
    assert.equal(first.parentSession, 'bounded-parent')
    assert.equal(first.origin, 'subagent')
    assert.equal(first.delegationDepth, 1)
    const ctx = new Context()
    try {
      await ctx.plugin(native.default)
      const runtime = ctx.get('subagents')
      assert.ok(runtime)
      assert.deepEqual(runtime.list(), [])
      let starts = 0
      const events = []
      ctx.on('subagent/provider-added', provider => events.push('add:' + provider.name))
      ctx.on('subagent/provider-removed', name => events.push('remove:' + name))
      const provider = { name: 'bounded', capabilities: {}, start: async () => { starts += 1; throw new Error('must not execute') } }
      const dispose = runtime.registerProvider(provider)
      assert.deepEqual(runtime.list(), ['bounded'])
      assert.equal(runtime.getProvider('bounded'), provider)
      assert.throws(() => runtime.registerProvider(provider), error => error.code === 'DUPLICATE_PROVIDER')
      await assert.rejects(runtime.start('bounded', { parent, prompt: 'no model', toolFilter: [] }),
        error => error.code === 'UNSUPPORTED_CAPABILITY')
      assert.equal(starts, 0)
      await dispose()
      assert.deepEqual(runtime.list(), [])
      await assert.rejects(runtime.start('bounded', { parent, prompt: 'no model' }), error => error.code === 'NO_PROVIDER')
      assert.equal(starts, 0)
      assert.deepEqual(events, ['add:bounded', 'remove:bounded'])
      // A newly installed Team package must trigger review instead of inheriting
      // a historical experimental classification that would satisfy cell admission.
      const team = await locateInstalledDshPackage(installed, '@deepseek-ai/dsh-experimental-agent-team')
      if (version === '0.1.6-alpha.2') {
        assert.equal(team?.value.version, version)
        assert.equal(team.value.publishConfig?.access, 'public')
      } else {
        assert.equal(team, undefined)
      }
      assert.ok(!capabilitySpecs().find(value => value.id === 'team.experimental').reviewedVersions.includes(version))
    } finally { await ctx.fiber.dispose() }
  })
}

test('historical review stays with its exact version independently of operational lane recognition', async () => {
  const fixture = await fakeDsh('0.1.1-rc.2')
  try {
    await fixture.addPackage('@deepseek-ai/dsh-sandbox-windows-acl')
    const report = await inspectDshCapabilities(fixture.entry, inspectionOptions(fixture))
    assert.equal(report.runtime.lane.recognized, false)
    const capability = report.capabilities.find((value) => value.id === 'sandbox.windows-acl')
    assert.equal(capability.semantics, 'reviewed')
    assert.equal(capability.status, 'partial')
    assert.match(capability.partialGuarantee, /network/u)
    assert.equal(capability.review.id, 'historical-package-contracts')
  } finally { await rm(fixture.root, { recursive: true, force: true }) }
})

test('recorded native review requires matching runtime and complete package identities', async () => {
  for (const version of [DSH_COMPATIBILITY_TARGET, '0.1.6-alpha.2']) {
    for (const mismatch of ['package', 'runtime', 'missing']) {
      const fixture = await fakeDsh(version,
        mismatch === 'runtime' ? { packageVersion: '0.2.0' } : {})
      try {
        for (const name of capabilitySpecs().find((value) => value.id === 'tools.approval-guard').packages) {
          if (mismatch === 'missing' && name === '@deepseek-ai/dsh-tools') continue
          await fixture.addPackage(name, mismatch === 'package' && name === '@deepseek-ai/dsh-tools'
            ? { version: '0.2.0' } : {})
        }
        const report = await inspectDshCapabilities(fixture.entry, inspectionOptions(fixture))
        const capability = report.capabilities.find((value) => value.id === 'tools.approval-guard')
        assert.equal(capability.semantics, 'unreviewed', version + ' ' + mismatch)
        assert.equal(capability.review, undefined, version + ' ' + mismatch)
        assert.equal(capability.status, mismatch === 'missing' ? 'partial' : 'present-unclassified')
      } finally { await rm(fixture.root, { recursive: true, force: true }) }
    }
  }
})

test('review metadata cannot be mutated through returned catalogues or reports', async () => {
  const fixture = await fakeDsh()
  try {
    const spec = capabilitySpecs().find((value) => value.id === 'tools.approval-guard')
    for (const name of spec.packages) await fixture.addPackage(name)
    spec.reviews[0].scope = 'caller changed scope'
    spec.reviews[0].versions.push('9.9.9')
    const first = await inspectDshCapabilities(fixture.entry, inspectionOptions(fixture))
    first.capabilities.find((value) => value.id === spec.id).review.scope = 'caller changed scope'
    const second = await inspectDshCapabilities(fixture.entry, inspectionOptions(fixture))
    assert.equal(first.evidenceDigest, second.evidenceDigest)
    assert.notEqual(second.capabilities.find((value) => value.id === spec.id).review.scope, 'caller changed scope')
    assert.ok(!capabilitySpecs().find((value) => value.id === spec.id).reviewedVersions.includes('9.9.9'))
  } finally { await rm(fixture.root, { recursive: true, force: true }) }
})
