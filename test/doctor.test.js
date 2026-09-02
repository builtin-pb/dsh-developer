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
  assert.deepEqual(report, JSON.parse(JSON.stringify(report)), 'Doctor evidence must be lossless JSON for native tools')
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

test('audits an extensionless non-dot main and blocks a missing declared entry', async () => {
  const { parent, root } = await copiedOrdinaryFixture()
  try {
    const packagePath = join(root, 'package.json')
    const packageValue = JSON.parse(await readFile(packagePath, 'utf8'))
    delete packageValue.exports
    packageValue.main = 'dist/plugin'
    await writeFile(packagePath, JSON.stringify(packageValue, null, 2) + '\n', 'utf8')
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'dist', 'plugin.js'), [
      "import '@deepseek-ai/dsh-commands'",
      'export function apply(ctx) { ctx.commands.register({}) }',
      '',
    ].join('\n'), 'utf8')

    const exact = await doctorPlugin(root, { runtime: 'skip' })
    const impact = exact.checks.find((value) => value.id === 'compatibility.upstream-attachments')
    assert.equal(impact.status, 'WARN')
    assert.deepEqual(impact.evidence.undeclaredPackages, ['@deepseek-ai/dsh-commands'])
    assert.deepEqual(impact.evidence.undeclaredServices, ['commands'])

    packageValue.main = 'dist/missing'
    await writeFile(packagePath, JSON.stringify(packageValue, null, 2) + '\n', 'utf8')
    const missing = await doctorPlugin(root, { runtime: 'skip' })
    const failed = missing.checks.find((value) => value.id === 'compatibility.upstream-attachments')
    assert.equal(failed.status, 'FAIL')
    assert.equal(failed.evidence.code, 'UNSCOPED_INJECT_CONTRACT')
    assert.deepEqual(failed.evidence.paths, ['package.json'])
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
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
    const packagePath = join(root, 'package.json')
    const packageValue = JSON.parse(await readFile(packagePath, 'utf8'))
    packageValue.optionalDependencies = { '@example/entry-only': '1.0.0' }
    await writeFile(packagePath, JSON.stringify(packageValue, null, 2) + '\n', 'utf8')
    await writeFile(join(root, 'index.js'), "import '@example/entry-only'\n", 'utf8')

    const report = await doctorPlugin(root, { runtime: 'skip' })
    assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2))
    const entrypoint = report.checks.find((check) => check.id === 'dsh.entrypoint')
    assert.equal(entrypoint.status, 'PASS')
    assert.equal(entrypoint.evidence.mounted, false)
    const coldBoot = report.checks.find((check) => check.id === 'dependencies.cold-boot')
    assert.equal(coldBoot.status, 'PASS')
    assert.deepEqual(coldBoot.evidence.roots, [])

    await writeFile(join(root, 'cordis.patch.yml'), [
      '- insert:',
      "    - name: '@example/dependency-plugin'",
      '      config: {}',
      '      id: dependency-plugin',
      '',
    ].join('\n'), 'utf8')
    packageValue.optionalDependencies['@example/dependency-plugin'] = '1.0.0'
    await writeFile(packagePath, JSON.stringify(packageValue, null, 2) + '\n', 'utf8')
    const brokenProfile = await doctorPlugin(root, { runtime: 'skip' })
    const failed = brokenProfile.checks.find((check) => check.id === 'dependencies.cold-boot')
    assert.equal(failed.status, 'FAIL')
    assert.deepEqual(failed.evidence.collisions, [{
      package: '@example/dependency-plugin',
      range: '1.0.0',
      paths: ['cordis.patch.yml'],
    }])
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('resolves the imported root export before a legacy main entry', async () => {
  const { parent, root } = await copiedOrdinaryFixture()
  try {
    const packagePath = join(root, 'package.json')
    const packageValue = JSON.parse(await readFile(packagePath, 'utf8'))
    packageValue.main = './legacy.js'
    packageValue.exports = { '.': { import: './index.js', default: './legacy.js' } }
    await writeFile(packagePath, JSON.stringify(packageValue, null, 2) + '\n', 'utf8')
    await writeFile(join(root, 'legacy.js'), 'throw new Error("legacy entry must not load")\n', 'utf8')

    const report = await doctorPlugin(root, { runtime: 'skip' })
    assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2))
    const entrypoint = report.checks.find((check) => check.id === 'dsh.entrypoint')
    assert.equal(entrypoint.evidence.entryPath, 'index.js')
    assert.equal(entrypoint.evidence.entryVia, 'exports.import')
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

test('accepts the native DSH whenToUse skill hint', async () => {
  const root = await generatedFixture()
  try {
    const skillPath = join(root, 'skills', 'doctor-fixture', 'SKILL.md')
    const skill = await readFile(skillPath, 'utf8')
    await writeFile(
      skillPath,
      skill.replace('\n---\n\n#', '\nwhenToUse: "Use for every doctor fixture request."\n---\n\n#'),
      'utf8',
    )
    const report = await doctorPlugin(root, { runtime: 'skip' })
    assert.equal(report.checks.find((check) => check.id === 'skill.integrity').status, 'PASS')
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

test('blocks eager imports from optional packages without rejecting a gated dynamic import', async () => {
  const { parent, root } = await copiedOrdinaryFixture()
  try {
    const packagePath = join(root, 'package.json')
    const packageValue = JSON.parse(await readFile(packagePath, 'utf8'))
    packageValue.optionalDependencies = { '@deepseek-ai/dsh-util-time': '0.1.1-rc.2' }
    await writeFile(packagePath, JSON.stringify(packageValue, null, 2) + '\n', 'utf8')
    await writeFile(join(root, 'index.js'), [
      'import {',
      '  canonicalClientTimeZone,',
      "} from '@deepseek-ai/dsh-util-time'",
      'export function apply() { canonicalClientTimeZone("Asia/Shanghai") }',
      '',
    ].join('\n'), 'utf8')

    const eager = await doctorPlugin(root, { runtime: 'skip' })
    const failed = eager.checks.find((check) => check.id === 'dependencies.cold-boot')
    assert.equal(failed.status, 'FAIL')
    assert.equal(failed.evidence.code, 'OPTIONAL_EAGER_IMPORT')
    assert.deepEqual(failed.evidence.collisions, [{
      package: '@deepseek-ai/dsh-util-time',
      range: '0.1.1-rc.2',
      paths: ['index.js'],
    }])
    assert.match(failed.recovery, /Move every boot-required package to dependencies/u)

    await writeFile(join(root, 'index.js'), [
      "const ready = true; import '@deepseek-ai/dsh-util-time'",
      'export function apply() { return ready }',
      '',
    ].join('\n'), 'utf8')
    const sameLineStatic = await doctorPlugin(root, { runtime: 'skip' })
    assert.equal(
      sameLineStatic.checks.find((check) => check.id === 'dependencies.cold-boot').status,
      'FAIL',
    )

    await writeFile(join(root, 'index.js'), [
      "const runtime = await import('@deepseek-ai/dsh-util-time')",
      'export function apply() { return runtime }',
      '',
    ].join('\n'), 'utf8')
    const topLevel = await doctorPlugin(root, { runtime: 'skip' })
    const topLevelFailure = topLevel.checks.find((check) => check.id === 'dependencies.cold-boot')
    assert.equal(topLevelFailure.status, 'FAIL')
    assert.equal(topLevelFailure.evidence.code, 'OPTIONAL_EAGER_IMPORT')

    await writeFile(join(root, 'index.js'), [
      'const runtime = await (/* still cold boot */ import(',
      "  '@deepseek-ai/dsh-util-time'",
      '))',
      'export function apply() { return runtime }',
      '',
    ].join('\n'), 'utf8')
    const parenthesized = await doctorPlugin(root, { runtime: 'skip' })
    const parenthesizedFailure = parenthesized.checks.find((check) => check.id === 'dependencies.cold-boot')
    assert.equal(parenthesizedFailure.status, 'FAIL')
    assert.equal(parenthesizedFailure.evidence.code, 'OPTIONAL_EAGER_IMPORT')

    await writeFile(join(root, 'index.js'), [
      "const runtime = (await import('@deepseek-ai/dsh-util-time'))",
      'export function apply() { return runtime }',
      '',
    ].join('\n'), 'utf8')
    const outerParentheses = await doctorPlugin(root, { runtime: 'skip' })
    assert.equal(
      outerParentheses.checks.find((check) => check.id === 'dependencies.cold-boot').status,
      'FAIL',
    )

    await writeFile(join(root, 'index.js'), [
      'const runtime = import(`@deepseek-ai/dsh-util-time`)',
      'export function apply() { return runtime }',
      '',
    ].join('\n'), 'utf8')
    const templateImport = await doctorPlugin(root, { runtime: 'skip' })
    const templateImportFailure = templateImport.checks.find((check) => check.id === 'dependencies.cold-boot')
    assert.equal(templateImportFailure.status, 'FAIL')
    assert.equal(templateImportFailure.evidence.code, 'OPTIONAL_EAGER_IMPORT')

    await writeFile(join(root, 'index.js'), [
      "const state = { pending: import('@deepseek-ai/dsh-util-time') }",
      'export function apply() { return state }',
      '',
    ].join('\n'), 'utf8')
    const objectImport = await doctorPlugin(root, { runtime: 'skip' })
    assert.equal(objectImport.checks.find((check) => check.id === 'dependencies.cold-boot').status, 'FAIL')

    await writeFile(join(root, 'index.js'), [
      "const state = `${import('@deepseek-ai/dsh-util-time')}`",
      'export function apply() { return state }',
      '',
    ].join('\n'), 'utf8')
    const templateExpression = await doctorPlugin(root, { runtime: 'skip' })
    assert.equal(templateExpression.checks.find((check) => check.id === 'dependencies.cold-boot').status, 'FAIL')

    await writeFile(join(root, 'index.js'), [
      "const load = async () => await import('@deepseek-ai/dsh-util-time')",
      'export function apply() { return load }',
      '',
    ].join('\n'), 'utf8')
    const lazyArrow = await doctorPlugin(root, { runtime: 'skip' })
    const lazyArrowCheck = lazyArrow.checks.find((check) => check.id === 'dependencies.cold-boot')
    assert.equal(lazyArrowCheck.status, 'PASS')

    await writeFile(join(root, 'index.js'), [
      'const enabled = false',
      'if (enabled)',
      '  console.log("disabled")',
      'else',
      "  await import('@deepseek-ai/dsh-util-time')",
      'export function apply() {}',
      '',
    ].join('\n'), 'utf8')
    const gatedStatement = await doctorPlugin(root, { runtime: 'skip' })
    const gatedStatementCheck = gatedStatement.checks.find((check) => check.id === 'dependencies.cold-boot')
    assert.equal(gatedStatementCheck.status, 'PASS')

    await writeFile(join(root, 'index.js'), [
      'const enabled = false',
      'if (enabled)',
      '  await',
      "    import('@deepseek-ai/dsh-util-time')",
      'const stringLookalike = "; import \'@deepseek-ai/dsh-util-time\'"',
      'const regexLookalike = /; import "@deepseek-ai\\/dsh-util-time"/',
      'export function apply() { return { stringLookalike, regexLookalike } }',
      '',
    ].join('\n'), 'utf8')
    const splitGate = await doctorPlugin(root, { runtime: 'skip' })
    const splitGateCheck = splitGate.checks.find((check) => check.id === 'dependencies.cold-boot')
    assert.equal(splitGateCheck.status, 'PASS')

    packageValue.main = 'index.ts'
    await writeFile(packagePath, JSON.stringify(packageValue, null, 2) + '\n', 'utf8')
    await writeFile(join(root, 'index.ts'), [
      'import',
      "  type { Clock } from '@deepseek-ai/dsh-util-time'",
      "import { type Clock as ClockAlias } from '@deepseek-ai/dsh-util-time'",
      'export function apply() { return /** @type {Clock | ClockAlias | undefined} */ (undefined) }',
      '',
    ].join('\n'), 'utf8')
    const typeOnly = await doctorPlugin(root, { runtime: 'skip' })
    const typeOnlyCheck = typeOnly.checks.find((check) => check.id === 'dependencies.cold-boot')
    assert.equal(typeOnlyCheck.status, 'PASS')

    packageValue.main = 'index.js'
    await writeFile(packagePath, JSON.stringify(packageValue, null, 2) + '\n', 'utf8')
    await writeFile(join(root, 'index.js'), [
      'export async function apply(enabled) {',
      '  const note = `',
      "  import { fake } from '@deepseek-ai/dsh-util-time'",
      '  `',
      '  /*',
      "  import { fake } from '@deepseek-ai/dsh-util-time'",
      '  */',
      '  if (enabled) await import("./optional-feature.js")',
      '  return note',
      '}',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(root, 'optional-feature.js'), [
      "import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'",
      'export const zone = canonicalClientTimeZone("Asia/Shanghai")',
      '',
    ].join('\n'), 'utf8')
    const gated = await doctorPlugin(root, { runtime: 'skip' })
    const passed = gated.checks.find((check) => check.id === 'dependencies.cold-boot')
    assert.equal(passed.status, 'PASS')
    assert.deepEqual(passed.evidence.collisions, [])
    assert.equal(gated.ok, true, JSON.stringify(gated.checks, null, 2))
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
    assert.equal(report.checks.find((value) => value.id === 'dependencies.cold-boot').status, 'SKIP')
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

test('blocks opaque runtime loaders while accepting an exact declared literal import', async () => {
  const root = await generatedFixture()
  try {
    for (const loader of [
      "const packageName = '@deepseek-ai/dsh-unknown'; import(packageName)",
      "const moduleName = '@deepseek-ai/dsh-unknown'; require(moduleName)",
      "eval(\"import('@deepseek-ai/dsh-unknown')\")",
    ]) {
      await writeFile(join(root, 'index.js'), [
        "export const name = 'doctor-fixture'",
        "export const inject = ['skills']",
        loader,
        "export async function apply(ctx) { ctx.skills.register({ name: 'visible' }) }",
        '',
      ].join('\n'), 'utf8')
      const report = await doctorPlugin(root, { runtime: 'skip' })
      const failed = report.checks.find((value) => value.id === 'compatibility.upstream-attachments')
      assert.equal(failed.status, 'FAIL', loader)
      assert.equal(failed.evidence.code, 'UNSCOPED_INJECT_CONTRACT', loader)
      assert.deepEqual(failed.evidence.paths, ['index.js'], loader)
    }

    const packagePath = join(root, 'package.json')
    const packageValue = JSON.parse(await readFile(packagePath, 'utf8'))
    packageValue.dshDeveloper.upstream.packages = ['@deepseek-ai/dsh-unknown']
    await writeFile(packagePath, JSON.stringify(packageValue, null, 2) + '\n', 'utf8')
    await writeFile(join(root, 'index.js'), [
      "export const name = 'doctor-fixture'",
      "export const inject = ['skills']",
      "import('@deepseek-ai/dsh-unknown')",
      "export async function apply(ctx) { ctx.skills.register({ name: 'visible' }) }",
      '',
    ].join('\n'), 'utf8')
    const exact = await doctorPlugin(root, { runtime: 'skip' })
    assert.equal(
      exact.checks.find((value) => value.id === 'compatibility.upstream-attachments').status,
      'PASS',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('warns on deferred opaque loaders but blocks activation-reachable helper loaders', async () => {
  const root = await generatedFixture()
  try {
    const shared = [
      "export const name = 'doctor-fixture'",
      "export const inject = ['skills']",
      "const packageName = '@deepseek-ai/dsh-hidden'",
      'function load() { return import(packageName) }',
    ]
    await writeFile(join(root, 'index.js'), [
      ...shared,
      "export async function apply(ctx) { ctx.skills.register({ name: 'visible' }) }",
      '',
    ].join('\n'), 'utf8')
    const deferred = await doctorPlugin(root, { runtime: 'skip' })
    const deferredCheck = deferred.checks
      .find((value) => value.id === 'compatibility.upstream-attachments')
    assert.equal(deferredCheck.status, 'WARN')
    assert.equal(deferredCheck.blocking, false)
    assert.deepEqual(deferredCheck.evidence.unparsedInjectDeclarations, [])
    assert.deepEqual(deferredCheck.evidence.unparsedModuleClosure, ['index.js'])

    await writeFile(join(root, 'index.js'), [
      ...shared,
      "export async function apply(ctx) { load(); ctx.skills.register({ name: 'visible' }) }",
      '',
    ].join('\n'), 'utf8')
    const activated = await doctorPlugin(root, { runtime: 'skip' })
    const failed = activated.checks
      .find((value) => value.id === 'compatibility.upstream-attachments')
    assert.equal(failed.status, 'FAIL')
    assert.equal(failed.blocking, true)
    assert.equal(failed.evidence.code, 'UNSCOPED_INJECT_CONTRACT')
    assert.deepEqual(failed.evidence.paths, ['index.js'])
    assert.equal(activated.ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolves Host inject only through exact named exports', async () => {
  const root = await generatedFixture()
  try {
    await writeFile(join(root, 'attachment.js'), [
      "export const deps = ['@deepseek-ai/dsh-client-runtime']",
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(root, 'index.js'), [
      "export const name = 'doctor-fixture'",
      "export { deps as inject } from './attachment.js'",
      'export async function apply() {}',
      '',
    ].join('\n'), 'utf8')
    const reexported = await doctorPlugin(root, { runtime: 'skip' })
    const hostFailure = reexported.checks.find((value) => value.id === 'dsh.host-client-inject')
    assert.equal(hostFailure.status, 'FAIL')
    assert.equal(hostFailure.evidence.code, 'HOST_CLIENT_PACKAGE_INJECT')
    assert.deepEqual(hostFailure.evidence.injections.map((value) => value.value), [
      '@deepseek-ai/dsh-client-runtime',
    ])

    await writeFile(join(root, 'index.js'), [
      "export const name = 'doctor-fixture'",
      '// export const inject = Object.freeze(dynamicServices)',
      'const inert = `export const inject = ["@deepseek-ai/dsh-client-runtime"]`',
      'export async function apply() { return inert }',
      '',
    ].join('\n'), 'utf8')
    const inert = await doctorPlugin(root, { runtime: 'skip' })
    assert.equal(inert.checks.find((value) => value.id === 'dsh.host-client-inject').status, 'PASS')
    assert.equal(
      inert.checks.find((value) => value.id === 'compatibility.upstream-attachments').status,
      'PASS',
    )

    await writeFile(join(root, 'index.js'), [
      "export const name = 'doctor-fixture'",
      "const deps = ['skills']",
      'consume(deps)',
      'export { deps as inject }',
      'export async function apply() {}',
      '',
    ].join('\n'), 'utf8')
    const escaped = await doctorPlugin(root, { runtime: 'skip' })
    assert.equal(
      escaped.checks.find((value) => value.id === 'compatibility.upstream-attachments').status,
      'FAIL',
    )
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

test('reviews raw plugin-owned Web routes without blocking intentional public intent', async () => {
  const { parent, root } = await copiedOrdinaryFixture()
  try {
    await writeFile(join(root, 'index.js'), [
      "export const inject = ['webServer']",
      'export function apply(ctx) {',
      '  ctx.webServer.register({',
      "    kind: 'prefix',",
      "    path: '/ping',",
      '    handler: (_req, res) => { res.writeHead(200); res.end("pong") },',
      '  })',
      '}',
      '',
    ].join('\n'), 'utf8')

    const rawReport = await doctorPlugin(root, { runtime: 'skip' })
    const rawCheck = rawReport.checks.find((candidate) => candidate.id === 'web.raw-route-auth')
    assert.equal(rawCheck.status, 'WARN')
    assert.equal(rawCheck.blocking, false)
    assert.equal(rawReport.ok, true, JSON.stringify(rawReport.checks, null, 2))
    assert.equal(rawCheck.evidence.rawRoutes[0].routePath, '/ping')
    assert.equal(rawCheck.evidence.repositoryCodeExecuted, false)
    assert.equal(rawCheck.evidence.lanes.release.target, '0.1.1-rc.2')
    assert.equal(rawCheck.evidence.lanes.preview.target, '0.1.2-alpha.3')
    assert.match(rawCheck.message, /not claiming every raw route is unsafe/u)
    assert.match(rawCheck.recovery, /intentionally public/u)
    assert.match(rawCheck.recovery, /upstream connection service/u)

    await writeFile(join(root, 'index.js'), [
      "export const inject = ['connection']",
      'export function apply(ctx) {',
      "  ctx.connection.rpc.handle('/ping', async () => ({ ok: true }))",
      '}',
      '',
    ].join('\n'), 'utf8')

    const connectionReport = await doctorPlugin(root, { runtime: 'skip' })
    const connectionCheck = connectionReport.checks.find((candidate) => candidate.id === 'web.raw-route-auth')
    assert.equal(connectionCheck.status, 'PASS')
    assert.equal(connectionCheck.blocking, false)
    assert.deepEqual(connectionCheck.evidence.rawRoutes, [])
    assert.equal(connectionCheck.evidence.connectionRoutes[0].authBoundary, 'host-connection')
    assert.match(connectionCheck.message, /local absence is not a safety proof/u)

    await writeFile(join(root, 'index.js'), [
      'export function apply(ctx) {',
      '  const broken = ([)]',
      '}',
      '',
    ].join('\n'), 'utf8')
    const incompleteReport = await doctorPlugin(root, { runtime: 'skip' })
    const incompleteCheck = incompleteReport.checks
      .find((candidate) => candidate.id === 'web.raw-route-auth')
    assert.equal(incompleteCheck.status, 'WARN')
    assert.equal(incompleteCheck.blocking, false)
    assert.deepEqual(incompleteCheck.evidence.coverage.incompletePaths, ['index.js'])
    assert.match(incompleteCheck.message, /not claiming clean route absence/u)
    assert.match(incompleteCheck.recovery, /Repair malformed or unsupported reachable source/u)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
