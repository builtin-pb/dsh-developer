import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  capabilitySpecs,
  formatCapabilityReport,
  inspectDshCapabilities,
} from '../lib/capabilities.js'

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

async function fakeDsh(version = '0.1.1-rc.2', options = {}) {
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
      version,
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
    for (const name of [
      '@deepseek-ai/dsh-skill',
      '@deepseek-ai/dsh-commands',
      '@deepseek-ai/dsh-shell-env',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-subagent',
      '@deepseek-ai/dsh-sandbox',
      '@deepseek-ai/dsh-sandbox-policy',
      '@deepseek-ai/dsh-sandbox-local',
      '@deepseek-ai/dsh-sandbox-windows-acl',
    ]) await fixture.addPackage(name)
    await fixture.addPackage('@deepseek-ai/dsh-experimental-agent-team', { unpublished: true })

    const first = await inspectDshCapabilities(fixture.entry, inspectionOptions(fixture))
    const second = await inspectDshCapabilities(fixture.entry, inspectionOptions(fixture))
    assert.equal(first.ok, true, JSON.stringify(first.checks, null, 2))
    assert.equal(first.runtime.lane.claim, 'blocking')
    assert.equal(first.capabilities.find((value) => value.id === 'subagent.core').status, 'native')
    assert.equal(first.capabilities.find((value) => value.id === 'subagent.acp').status, 'absent')
    const windowsSandbox = first.capabilities.find((value) => value.id === 'sandbox.windows-acl')
    assert.equal(windowsSandbox.status, 'partial')
    assert.equal(windowsSandbox.semantics, 'reviewed')
    assert.match(windowsSandbox.partialGuarantee, /network/u)
    assert.equal(first.capabilities.find((value) => value.id === 'team.experimental').status, 'experimental')
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
    assert.match(formatCapabilityReport(first), /^PASS DSH capabilities 0\.1\.1-rc\.2 \[blocking\]/u)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('recognizes the declared preview lane without promoting it to blocking evidence', async () => {
  const fixture = await fakeDsh('0.1.2-alpha.2')
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
    assert.equal(capability.status, 'present-unclassified')
    assert.equal(capability.semantics, 'unreviewed')
    assert.equal(capability.partialGuarantee, undefined)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('fails conformance when CLI and package identity disagree', async () => {
  const fixture = await fakeDsh('0.1.1-rc.2', {
    packageVersion: '0.1.2-alpha.2',
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
  assert.ok(specs.every((value) => value.reviewedVersions.includes('0.1.1-rc.2')))
  const nativeSurface = specs.find((value) => value.id === 'plugin.native-surface')
  assert.ok(nativeSurface.packages.includes('@deepseek-ai/dsh-commands'))
  assert.ok(nativeSurface.packages.includes('@deepseek-ai/dsh-tools'))
  assert.ok(!nativeSurface.packages.includes('@deepseek-ai/dsh-native-command'))
  assert.match(specs.find((value) => value.id === 'sandbox.windows-acl').partialGuarantee, /Write restriction only/u)
})
