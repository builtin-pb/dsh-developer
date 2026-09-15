import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { formatDevelopmentReport, runDevelopmentServer, validateToolCases, verifyDevelopmentPlugin } from '../lib/development.js'
import { selectCaseValue } from '../lib/development-probe.js'
import { parseCliArguments, assertCliCommandOptions } from '../lib/cli-options.js'
import { deriveNextActions } from '../lib/recovery-actions.js'
import { parseNativeToolInput } from '../lib/native-tool-internal.js'

test('development startup error tails withhold both streams after a PEM marker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dev-private-key-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  await mkdir(join(root, '.git'))
  const source = join(root, 'plugin')
  const installation = join(root, 'runtime')
  await mkdir(source)
  await mkdir(installation)
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture', dsh: { bundle: { patch: './patch.yml' } } }))
  await writeFile(join(installation, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0',
    publishConfig: { access: 'public' }, bin: { dsh: './bin.cjs' } }))
  const pem = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
  const body = pem.split('\n').filter(line => line && !line.startsWith('---')).join('').match(/.{1,16}/gu)
  const begin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
  const end = ['-----END', 'PRIVATE KEY-----'].join(' ')
  const log = begin + '\n' + body.join('\n') + '\n' + end + '\n'
    + 'safe log line\n'.repeat(37420)
  await writeFile(join(installation, 'log.txt'), log)
  const dshPath = join(installation, 'bin.cjs')
  const patchPath = join(root, 'selected.patch.yml')
  await writeFile(patchPath, '[]\n')
  for (const stream of ['stdout', 'stderr']) {
    const other = stream === 'stdout' ? 'stderr' : 'stdout'
    // Local CLI fixture exercises the public dev path, without launching DSH,
    // installing dependencies, opening a socket or using a personal profile.
    await writeFile(dshPath, `
      if (!process.argv.includes('plugin') && !process.argv.includes('--dump-config')) {
        const log = require('node:fs').readFileSync(require('node:path').join(__dirname, 'log.txt'));
        process.${stream}.write(log.subarray(0, 15));
        setTimeout(() => {
          process.${stream}.write(log.subarray(15));
          process.${other}.write('Error: useful startup failure\\n');
          process.exitCode = 7;
        }, 25);
      }
    `)
    await assert.rejects(runDevelopmentServer(source, { dshPath, patchPath, timeoutMs: 5000 }), error => {
      assert.equal(error.code, 'COMMAND_EXITED')
      assert.equal(error.details.exitCode, 7)
      assert.equal(error.details[stream], '[redacted: process output contained a private key]\n')
      assert.equal(error.details[other], '[redacted: process output contained a private key]\n')
      assert.equal(error.details.output.truncated[stream], true)
      assert.equal(error.details.output.truncated[other], false)
      assert.equal(error.details.output.withheld[stream], true)
      assert.equal(error.details.output.withheld[other], true)
      assert(body.every(line => !JSON.stringify(error).includes(line)))
      return true
    })
  }
})

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

test('human verification receipts keep process cleanup limitations separate from profile removal', () => {
  const report = { ok: true, cleanup: 'disposable profile removed', processCleanup: {
    platform: 'win32', afterLeaderExit: 'The plugin must stop and await its workers before normal exit.',
    limitation: 'Descendants cannot reliably be found after their leader exits.',
  } }
  const text = formatDevelopmentReport(report)
  assert.ok(text.includes('Process cleanup (win32): ' + report.processCleanup.afterLeaderExit))
  assert.ok(text.includes(report.processCleanup.limitation))
  assert.ok(text.endsWith(report.cleanup))
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
