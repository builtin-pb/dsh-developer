import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { formatDevelopmentReport, runDevelopmentServer, validateToolCases, verifyDevelopmentPlugin } from '../lib/development.js'
import { selectCaseValue } from '../lib/development-probe.js'
import { parseCliArguments, assertCliCommandOptions } from '../lib/cli-options.js'
import { deriveNextActions } from '../lib/recovery-actions.js'
import { parseNativeToolInput } from '../lib/native-tool-internal.js'

test('verification requires behavior assertions rather than registration alone', () => {
  assert.throws(() => validateToolCases([]), { code: 'DEVELOPMENT_CASES_INVALID' })
  assert.throws(() => validateToolCases([{ tool: 'greet', arguments: {} }]), { code: 'DEVELOPMENT_CASES_INVALID' })
  const cases = [{ tool: 'greet', arguments: { name: 'Ada' }, expected: 'Hello Ada' }, { tool: 'greet', arguments: {}, isError: true }]
  assert.equal(validateToolCases(cases), cases)
  assert.throws(() => validateToolCases([{ ...cases[0], agent: { fake: true } }]), { code: 'DEVELOPMENT_CASES_INVALID' })
  assert.throws(() => validateToolCases([{ ...cases[0], approval: true }]), { code: 'DEVELOPMENT_CASES_INVALID' })
  for (const maxResultBytes of [0, -1, 1.5, '1000', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateToolCases([{ ...cases[0], maxResultBytes }]), { code: 'DEVELOPMENT_CASES_INVALID' })
  }
  assert.doesNotThrow(() => validateToolCases([{ ...cases[0], maxResultBytes: 4096 }]))
})

test('compares selected canonical fields without treating a missing path as null', () => {
  const value = { items: [{ 'a/b': { '~value': null } }] }
  assert.deepEqual(selectCaseValue(value, '/items/0/a~1b/~0value'), { found: true, value: null })
  assert.deepEqual(selectCaseValue(value, '/items/9'), { found: false })
  assert.deepEqual(selectCaseValue(value, '/toString'), { found: false })
  assert.deepEqual(selectCaseValue(undefined), { found: true, value: null })
  assert.throws(() => validateToolCases([{ tool: 'test', arguments: {}, resultPath: 'items', expected: 1 }]), { code: 'DEVELOPMENT_CASES_INVALID' })
  assert.throws(() => validateToolCases([{ tool: 'test', arguments: {}, resultPath: '/~bad', expected: 1 }]), { code: 'DEVELOPMENT_CASES_INVALID' })
})

test('explains output budget failures and omitted values in the human report', () => {
  const text = formatDevelopmentReport({ ok: false, cases: [
    { tool: 'large', passed: false, resultBytes: 100000, maxResultBytes: 4096, outputLimitExceeded: true },
    { tool: 'allowed', passed: true, resultBytes: 100000, valueOmitted: true },
  ] })
  assert.match(text, /100000 result bytes; limit 4096.*output budget exceeded/u)
  assert.match(text, /PASS allowed.*compared in full/u)
  assert.doesNotMatch(text, /undefined/u)
})

test('development execution is CLI-only and its network option cannot alter static native operations', () => {
  const parsed = parseCliArguments(['verify', '--source', 'plugin', '--cases', 'cases.json', '--online'])
  assertCliCommandOptions(parsed.command, parsed.options)
  assert.equal(parsed.options.online, true)
  assert.throws(() => assertCliCommandOptions('project', { online: true }), /does not accept/u)
  assert.throws(() => parseNativeToolInput({ operation: 'verify', source: 'plugin' }), /operation must be/u)
  assert.throws(() => parseNativeToolInput({ operation: 'project', source: 'plugin', script: 'test' }), /not valid/u)
  for (const operation of ['project', 'knowledge', 'doctor', 'preflight']) {
    assert.throws(() => parseNativeToolInput({ operation, source: 'plugin', patchPath: 'trusted.yml' }), /not valid/u)
    assert.throws(() => parseNativeToolInput({ operation, source: 'plugin', patch: 'trusted.yml' }), /not valid/u)
  }
  assert.deepEqual(parseNativeToolInput({ operation: 'project' }), { operation: 'project' })
})

test('rejects invalid overlay selections before installing or booting DSH', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-overlay-selection-'))
  try {
    const casesPath = join(temporary, 'cases.json')
    const patchPath = join(temporary, 'ordinary patch.yml')
    await writeFile(casesPath, JSON.stringify([{ tool: 'fixture', arguments: {}, expected: 'value' }]))
    await writeFile(patchPath, '[]\n')
    const link = join(temporary, 'linked.yml')
    let linked = false
    try { await symlink(patchPath, link); linked = true } catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
    }
    const source = join(temporary, 'nonexistent source')
    for (const run of [verifyDevelopmentPlugin, runDevelopmentServer]) {
      for (const invalid of ['', '   ', null, [], {}, 12, 'bad\0path', temporary, ...(linked ? [link] : []), join(temporary, 'missing.yml')]) {
        await assert.rejects(run(source, { casesPath, patchPath: invalid }), error => {
          assert.equal(error.code, 'DEVELOPMENT_PATCH_INVALID')
          assert.match(error.message, /--patch/u)
          return true
        })
      }
      // A real file (including spaces) and omission both advance to source validation.
      await assert.rejects(run(source, { casesPath, patchPath }), { code: 'ENOENT' })
      await assert.rejects(run(source, { casesPath }), { code: 'ENOENT' })
      await assert.rejects(run(source, { casesPath, patchPath: link, signal: AbortSignal.abort() }), { code: 'CANCELLED' })
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})


test('knowledge lookup failures preserve the chosen target instead of demanding an audit lane', () => {
  assert.deepEqual(deriveNextActions({ operation: 'knowledge', diagnostic: { code: 'DSH_PACKAGE_NOT_FOUND' } }), [])
})
