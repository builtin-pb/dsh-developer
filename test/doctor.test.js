import assert from 'node:assert/strict'
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { withCreatorFingerprint } from '../lib/creator-export.js'
import { doctorPlugin } from '../lib/doctor.js'
import { writeFilesExclusive } from '../lib/files.js'
import { renderGeneratedBundle } from '../lib/templates.js'

const ordinaryPluginFixture = fileURLToPath(new URL('./fixtures/ordinary-dsh-plugin/', import.meta.url))

function exportValue() {
  return withCreatorFingerprint({
    format: 'dsh-creator-export',
    schemaVersion: 1,
    name: 'doctor-fixture',
    packageName: 'doctor-fixture',
    author: 'Doctor test contributors',
    description: 'A fixture for deterministic Doctor checks.',
    goal: 'Exercise the release catalogue.',
    instructions: 'Return one deterministic result.',
    compatibilityTarget: '0.1.1-rc.2',
    decisions: [],
    unresolvedRisks: [],
    tools: [],
    resources: [],
  })
}

async function generatedFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-doctor-'))
  await writeFilesExclusive(root, renderGeneratedBundle(exportValue()).files)
  return root
}

async function addClientBundle(root, body) {
  const packagePath = join(root, 'package.json')
  const packageValue = JSON.parse(await readFile(packagePath, 'utf8'))
  packageValue.exports = {
    ...(packageValue.exports ?? {}),
    './client': { default: './lib/client.js' },
  }
  packageValue.dsh.client = { platform: 'web' }
  await writeFile(packagePath, JSON.stringify(packageValue, null, 2) + '\n', 'utf8')
  await mkdir(join(root, 'lib'), { recursive: true })
  await writeFile(
    join(root, 'lib', 'client.js'),
    'window.__ModuleLoader__.load({ id: "doctor-fixture", factory: (require) => { ' + body + ' } })\n',
    'utf8',
  )
}

async function copiedOrdinaryFixture() {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-developer-ordinary-'))
  const root = join(parent, 'ordinary-dsh-plugin')
  await cp(ordinaryPluginFixture, root, { recursive: true })
  return { parent, root }
}

test('assesses an ordinary hand-written DSH plugin without generated Codex bundle requirements', async () => {
  const report = await doctorPlugin(ordinaryPluginFixture, { runtime: 'skip' })

  assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2))
  assert.equal(report.plugin.name, 'ordinary-dsh-plugin')
  const codex = report.checks.find((check) => check.id === 'manifest.codex-plugin')
  assert.equal(codex.status, 'SKIP')
  assert.equal(codex.blocking, false)
  const skill = report.checks.find((check) => check.id === 'skill.integrity')
  assert.equal(skill.status, 'SKIP')
  assert.equal(skill.blocking, false)
  const docs = report.checks.find((check) => check.id === 'docs-and-license')
  assert.equal(docs.status, 'WARN')
  assert.equal(docs.blocking, false)
  assert.deepEqual(docs.evidence.missing, ['README.md'])
  assert.equal(docs.recovery, 'Add README.md before a public release.')
  assert.equal(report.checks.find((check) => check.id === 'manifest.package').status, 'PASS')
  assert.equal(report.checks.find((check) => check.id === 'dsh.entrypoint').status, 'PASS')
})

test('accepts a DSH profile bundle that mounts dependencies instead of its own package', async () => {
  const { parent, root } = await copiedOrdinaryFixture()
  try {
    await writeFile(join(root, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: dependency-plugin',
      "      name: '@example/dependency-plugin'",
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(root, 'index.js'), 'export {}\n', 'utf8')

    const report = await doctorPlugin(root, { runtime: 'skip' })
    assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2))
    const entrypoint = report.checks.find((check) => check.id === 'dsh.entrypoint')
    assert.equal(entrypoint.status, 'PASS')
    assert.equal(entrypoint.evidence.mounted, false)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('keeps generated bundles strict when their Codex manifest is missing', async () => {
  const root = await generatedFixture()
  try {
    await rm(join(root, '.codex-plugin'), { recursive: true, force: true })
    const report = await doctorPlugin(root, { runtime: 'skip', requireGenerated: true })
    assert.equal(report.ok, false)
    assert.equal(report.checks.find((check) => check.id === 'manifest.codex-plugin').status, 'FAIL')
    assert.equal(report.checks.find((check) => check.id === 'skill.integrity').status, 'FAIL')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports a browser-plane failure when an ordinary plugin exports a client without dsh.client', async () => {
  const { parent, root } = await copiedOrdinaryFixture()
  try {
    const packagePath = join(root, 'package.json')
    const packageValue = JSON.parse(await readFile(packagePath, 'utf8'))
    packageValue.exports['./client'] = { default: './client.js' }
    await writeFile(packagePath, JSON.stringify(packageValue, null, 2) + '\n', 'utf8')
    await writeFile(
      join(root, 'client.js'),
      'window.__ModuleLoader__.load({ id: "ordinary-dsh-plugin", factory: () => ({}) })\n',
      'utf8',
    )

    const report = await doctorPlugin(root, { runtime: 'skip' })
    const failed = report.checks.filter((check) => check.status === 'FAIL')
    assert.deepEqual(failed.map((check) => check.id), ['web.client-bundle'])
    assert.equal(failed[0].evidence.code, 'CLIENT_DECLARATION_MISSING')
    assert.match(failed[0].message, /"\.\/client" browser entry/u)
    assert.match(failed[0].message, /package\.json dsh\.client declaration/u)
    assert.match(failed[0].recovery, /platform "web"/u)
    assert.equal(report.ok, false)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('accepts exact generated bytes and blocks post-generation drift', async () => {
  const root = await generatedFixture()
  try {
    const exact = await doctorPlugin(root, {
      runtime: 'skip',
      requireGenerated: true,
    })
    assert.equal(exact.ok, true, JSON.stringify(exact.checks, null, 2))

    await appendFile(join(root, 'README.md'), '\nChanged after generation.\n', 'utf8')
    const changed = await doctorPlugin(root, {
      runtime: 'skip',
      requireGenerated: true,
    })
    assert.equal(changed.ok, false)
    assert.equal(
      changed.checks.find((check) => check.id === 'packaging.reproducible').status,
      'FAIL',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('treats partial provenance as a blocking integrity failure', async () => {
  const root = await generatedFixture()
  try {
    await unlink(join(root, 'dsh-developer.manifest.json'))
    const report = await doctorPlugin(root, { runtime: 'skip' })
    const check = report.checks.find((candidate) => candidate.id === 'packaging.reproducible')
    assert.equal(check.status, 'FAIL')
    assert.equal(check.blocking, true)
    assert.equal(report.ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('requires the declared package entry on the matching DSH row', async () => {
  const root = await generatedFixture()
  try {
    await writeFile(join(root, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: doctor-fixture',
      "      name: 'different-package'",
      '    - id: unrelated-row',
      "      name: 'doctor-fixture'",
      '',
    ].join('\n'), 'utf8')
    const report = await doctorPlugin(root, { runtime: 'skip' })
    assert.equal(report.checks.find((value) => value.id === 'dsh.entrypoint').status, 'FAIL')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('blocks an incomplete upstream attachment claim for dynamic inject source', async () => {
  const root = await generatedFixture()
  try {
    await writeFile(join(root, 'index.js'), [
      "export const name = 'doctor-fixture'",
      "const required = ['skills']",
      'export const inject = Object.freeze(required)',
      'export async function apply() {}',
      '',
    ].join('\n'), 'utf8')
    const report = await doctorPlugin(root, { runtime: 'skip' })
    const failed = report.checks.find((value) => value.id === 'compatibility.upstream-attachments')
    assert.equal(failed.status, 'FAIL')
    assert.equal(failed.evidence.code, 'UNSCOPED_INJECT_CONTRACT')
    assert.deepEqual(failed.evidence.paths, ['index.js'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('blocks DSH Client package identifiers in Host inject with targeted recovery', async () => {
  const root = await generatedFixture()
  try {
    await writeFile(join(root, 'index.js'), [
      "export const name = 'doctor-fixture'",
      "export const inject = ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation']",
      'export async function apply() {}',
      '',
    ].join('\n'), 'utf8')
    const report = await doctorPlugin(root, { runtime: 'skip' })
    const failed = report.checks.find((value) => value.id === 'dsh.host-client-inject')
    assert.equal(failed.status, 'FAIL')
    assert.equal(failed.evidence.code, 'HOST_CLIENT_PACKAGE_INJECT')
    assert.deepEqual(failed.evidence.injections.map((value) => value.value), [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-conversation',
    ])
    assert.match(failed.recovery, /package\.json dsh\.client\.inject/u)
    assert.equal(report.ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps release-valid Web bundles nonblocking when only the preview module table drifts', async () => {
  const root = await generatedFixture()
  try {
    await addClientBundle(root, 'return require("@deepseek-ai/dsh-client-runtime/client")')

    const report = await doctorPlugin(root, { runtime: 'skip' })
    const check = report.checks.find((candidate) => candidate.id === 'web.client-bundle')
    assert.equal(check.status, 'WARN')
    assert.equal(check.blocking, false)
    assert.equal(check.evidence.lanes.release.ok, true)
    assert.deepEqual(check.evidence.lanes.preview.missing, ['@deepseek-ai/dsh-client-runtime/client'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('blocks Web bundles that leak Node imports into the browser module table', async () => {
  const root = await generatedFixture()
  try {
    await addClientBundle(root, 'return require("node:crypto")')
    const report = await doctorPlugin(root, { runtime: 'skip' })
    const check = report.checks.find((candidate) => candidate.id === 'web.client-bundle')
    assert.equal(check.status, 'FAIL')
    assert.equal(check.blocking, true)
    assert.equal(check.evidence.code, 'CLIENT_BUNDLE_UNSAFE_IMPORT')
    assert.equal(report.ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps proven DSH-owned client service replacement visible and nonblocking', async () => {
  const root = await generatedFixture()
  try {
    await addClientBundle(root, 'ctx.provide("chatFileMentions", {}); return {}')
    const report = await doctorPlugin(root, { runtime: 'skip' })
    const check = report.checks.find((candidate) => candidate.id === 'web.client-bundle')
    assert.equal(check.status, 'WARN')
    assert.equal(check.blocking, false)
    assert.equal(check.evidence.coreServiceCollisions[0].service, 'chatFileMentions')
    assert.equal(
      check.evidence.coreServiceCollisions[0].lanes[0].owner,
      '@deepseek-ai/dsh-client-ui-deliverables',
    )
    assert.match(check.recovery, /Rename the provided services/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps computed client service ownership visible instead of claiming a clean boundary', async () => {
  const root = await generatedFixture()
  try {
    await addClientBundle(root, 'const name = "feature"; ctx.provide(name, {}); return {}')
    const report = await doctorPlugin(root, { runtime: 'skip' })
    const check = report.checks.find((candidate) => candidate.id === 'web.client-bundle')
    assert.equal(check.status, 'WARN')
    assert.equal(check.blocking, false)
    assert.equal(check.evidence.dynamicProvides, 1)
    assert.match(check.message, /prevent static ownership proof/u)
    assert.match(check.recovery, /Use literal provider names/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
