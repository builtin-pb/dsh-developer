import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { doctorPlugin } from '../lib/doctor.js'
import { withCreatorFingerprint } from '../lib/creator-export.js'
import { DshDeveloperError } from '../lib/errors.js'
import { assertAbsentDirectoryDestination } from '../lib/files.js'
import { promoteCreatorExport } from '../lib/promote.js'

function draft(name = 'promoted-plugin') {
  return withCreatorFingerprint({
    format: 'dsh-creator-export',
    schemaVersion: 1,
    name,
    packageName: name,
    author: 'Promotion test contributors',
    description: 'A promoted plugin used to verify the transactional release path.',
    goal: 'Produce one deterministic result.',
    instructions: 'Follow the accepted goal and keep the response concise.',
    compatibilityTarget: '0.1.1-rc.2',
    decisions: [],
    unresolvedRisks: [],
    tools: [],
    resources: [],
  })
}

function fakeRuntime() {
  return {
    checkDshVersion: async () => ({
      version: '0.1.1-rc.2',
      invocation: { displayPath: 'fake-dsh', command: 'fake', prefixArgs: [] },
    }),
    smokeDshInstall: async () => ({ installed: true, discovered: true, uninstalled: true }),
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-test-'))
  const source = join(root, 'creator.json')
  await writeFile(source, JSON.stringify(draft(), null, 2) + '\n', 'utf8')
  return { root, source, output: join(root, 'promoted-plugin') }
}

test('promotes through a fresh final gate and commits one new directory', { skip: process.platform !== 'win32' }, async () => {
  const value = await fixture()
  try {
    const result = await promoteCreatorExport(value.source, value.output, fakeRuntime())
    assert.equal(result.committed, true)
    assert.equal(result.destination, value.output)
    assert.match(result.bundleFingerprint, /^sha256:/u)
    assert.equal(JSON.parse(await readFile(join(value.output, 'package.json'), 'utf8')).name, 'promoted-plugin')

    const report = await doctorPlugin(value.output, {
      ...fakeRuntime(),
      requireGenerated: true,
    })
    assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2))
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('never replaces an existing destination', async () => {
  const value = await fixture()
  try {
    await writeFile(value.output, 'keep me', 'utf8')
    await assert.rejects(
      promoteCreatorExport(value.source, value.output, fakeRuntime()),
      (error) => error instanceof DshDeveloperError && error.code === 'OUTPUT_EXISTS',
    )
    assert.equal(await readFile(value.output, 'utf8'), 'keep me')
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('rejects an output path that traverses a junction ancestor', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-junction-test-'))
  const target = join(root, 'physical-parent')
  const targetChild = join(target, 'ordinary-child')
  const alias = join(root, 'junction-alias')
  await mkdir(targetChild, { recursive: true })
  await symlink(target, alias, 'junction')
  try {
    await assert.rejects(
      assertAbsentDirectoryDestination(join(alias, 'ordinary-child', 'promoted-plugin')),
      (error) => error instanceof DshDeveloperError
        && error.code === 'UNSAFE_OUTPUT_PARENT'
        && error.details.linkedAncestor === alias,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('retains identified staging when the final gate fails', { skip: process.platform !== 'win32' }, async () => {
  const value = await fixture()
  try {
    let failure
    try {
      await promoteCreatorExport(value.source, value.output, {
        ...fakeRuntime(),
        runGeneratedNodeTests: async () => {
          throw new Error('injected generated-test failure')
        },
      })
    } catch (error) {
      failure = error
    }
    assert.equal(failure?.code, 'FINAL_GATE_FAILED')
    assert.ok(failure.details.staging)
    assert.equal((await stat(failure.details.staging)).isDirectory(), true)
    await assert.rejects(stat(value.output), /ENOENT/u)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('cancellation retains staging and schedules no later lifecycle work', { skip: process.platform !== 'win32' }, async () => {
  const value = await fixture()
  const controller = new AbortController()
  let lifecycleCalls = 0
  let failure
  try {
    await promoteCreatorExport(value.source, value.output, {
      checkDshVersion: fakeRuntime().checkDshVersion,
      signal: controller.signal,
      runGeneratedNodeTests: async () => {
        controller.abort()
        throw new DshDeveloperError('CANCELLED', 'injected cancellation')
      },
      smokeDshInstall: async () => {
        lifecycleCalls += 1
      },
    })
  } catch (error) {
    failure = error
  }
  try {
    assert.equal(failure?.code, 'CANCELLED')
    assert.ok(failure.details.staging)
    assert.equal((await stat(failure.details.staging)).isDirectory(), true)
    assert.equal(lifecycleCalls, 0)
    await assert.rejects(stat(value.output), /ENOENT/u)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('a verifier mutation fails before commit and leaves staging', { skip: process.platform !== 'win32' }, async () => {
  const value = await fixture()
  let failure
  try {
    await promoteCreatorExport(value.source, value.output, {
      ...fakeRuntime(),
      runGeneratedNodeTests: async (root) => {
        await writeFile(join(root, 'unexpected.txt'), 'mutation\n', 'utf8')
      },
    })
  } catch (error) {
    failure = error
  }
  try {
    assert.equal(failure?.code, 'FINAL_GATE_FAILED')
    assert.ok(failure.details.staging)
    assert.equal(
      failure.details.doctor.checks.find((check) => check.id === 'verification.freshness').status,
      'FAIL',
    )
    await assert.rejects(stat(value.output), /ENOENT/u)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('reports an ambiguous terminal state when observation fails after commit', { skip: process.platform !== 'win32' }, async () => {
  const value = await fixture()
  let failure
  try {
    await promoteCreatorExport(value.source, value.output, {
      ...fakeRuntime(),
      scanCommittedTree: async () => {
        throw new DshDeveloperError('SOURCE_UNAVAILABLE', 'injected post-commit observation failure')
      },
    })
  } catch (error) {
    failure = error
  }
  try {
    assert.equal(failure?.code, 'COMMIT_STATE_AMBIGUOUS')
    assert.equal(failure.details.commitState, 'ambiguous')
    assert.equal(failure.details.destination, value.output)
    assert.equal(failure.details.cause.code, 'SOURCE_UNAVAILABLE')
    assert.equal((await stat(value.output)).isDirectory(), true)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})
