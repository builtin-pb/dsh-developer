import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { formatDevelopmentDiagnostic, formatDevelopmentReport, verifyDevelopmentPlugin } from '../lib/development.js'

const base = { code: 'COMMAND_EXITED', message: 'DSH exited unsuccessfully.' }

test('startup diagnostics show the actionable error rather than losing it behind a long stack', () => {
  const diagnostic = { ...base, stderr: 'startup progress\nError [ERR_MODULE_NOT_FOUND]: Cannot find package missing-library\n'
    + '    at loader (loader.js:1:1)\n'.repeat(30) }
  const original = structuredClone(diagnostic)
  const text = formatDevelopmentDiagnostic(diagnostic)
  assert.match(text, /Cannot find package missing-library/u)
  assert.match(text, /additional output omitted/u)
  assert(text.split('\n').length <= 14)
  assert.deepEqual(diagnostic, original)
})

test('a generic stderr summary does not hide the package-manager cause on stdout', () => {
  const text = formatDevelopmentDiagnostic({ ...base,
    stderr: 'dsh: initialized profile\ndsh: pnpm failed in profile directory',
    stdout: '[ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER] Specifier is not supported by any available resolver.' })
  assert.match(text, /pnpm failed/u)
  assert.match(text, /ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER/u)
  assert.match(text, /Process stdout/u)
})

test('startup diagnostics use stdout when stderr is empty and bound long individual lines', () => {
  assert.match(formatDevelopmentDiagnostic({ ...base, stderr: ' \n', stdout: 'dsh: missing configuration' }), /Process stdout:\ndsh: missing configuration/u)
  const text = formatDevelopmentDiagnostic({ ...base, stderr: 'Error: ' + 'long detail '.repeat(1000) })
  assert.match(text, /Error: long detail/u)
  assert.match(text, /additional output omitted/u)
  assert(text.length < 3200)
  assert.match(formatDevelopmentDiagnostic({ ...base, stdout: 'last line', output: { truncated: { stdout: true } } }), /additional output omitted/u)
})

test('human excerpts protect complete lines and honor cross-channel withholding before clipping', () => {
  const secret = 'sk-' + 'A1b2C3d4'.repeat(4)
  const text = formatDevelopmentDiagnostic({ ...base, stderr: 'Error: safe cause\n' + 'padding '.repeat(700) + secret })
  assert.match(text, /safe cause/u)
  assert(!text.includes(secret))
  const marker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
  for (const diagnostic of [
    { ...base, stdout: marker, stderr: 'short-key-body-fragment' },
    { ...base, message: marker, stderr: 'short-key-body-fragment' },
    { ...base, message: 'short-key-body-fragment', stdout: marker },
    { ...base, message: 'short-key-body-fragment', privateKeyOutput: true },
    { ...base, stderr: 'short-key-body-fragment', output: { withheld: { stdout: true, stderr: true } } },
    { ...base, stderr: 'short-key-body-fragment', output: { incomplete: true } },
  ]) {
    const rendered = formatDevelopmentDiagnostic(diagnostic)
    assert(!rendered.includes('short-key-body-fragment'))
    assert(!rendered.includes(marker))
    assert.match(rendered, /Process output withheld/u)
  }
})

test('completed assertion failures remain focused on case outcomes', () => {
  const text = formatDevelopmentReport({ ok: false, complete: true, cases: [],
    diagnostic: { ...base, stderr: 'irrelevant startup detail' } })
  assert(!text.includes('irrelevant startup detail'))
})

test('the verification runner and CLI expose captured startup causes in normal output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dev-diagnostic-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  await mkdir(join(root, '.git'))
  const source = join(root, 'plugin'), runtime = join(root, 'runtime')
  await mkdir(source); await mkdir(runtime)
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture', dsh: { bundle: { patch: './patch.yml' } } }))
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0',
    publishConfig: { access: 'public' }, bin: { dsh: './bin.cjs' } }))
  const casesPath = join(root, 'cases.json'), dshPath = join(runtime, 'bin.cjs')
  await writeFile(casesPath, JSON.stringify([{ tool: 'fixture', arguments: {}, expected: true }]))
  const cause = 'Error [ERR_MODULE_NOT_FOUND]: Cannot find package missing-library\n'
  await writeFile(dshPath, `
    if (process.argv.includes('plugin')) {
      const profile = require('node:path').join(process.env.DSH_HOME, 'profiles', 'developer-test');
      require('node:fs').mkdirSync(profile, { recursive: true });
      require('node:fs').writeFileSync(require('node:path').join(profile, 'package.json'), '{}');
    } else if (!process.argv.includes('--dump-config')) {
      process.stderr.write(${JSON.stringify(cause)}); process.exitCode = 7;
    }
  `)
  // Local process fixture tests the production verification/report boundary;
  // it does not stand in for a native DSH registration or startup test.
  const report = await verifyDevelopmentPlugin(source, { dshPath, casesPath })
  assert.equal(report.complete, false)
  assert.equal(report.phase, 'startup')
  assert.equal(report.diagnostic.exitCode, 7)
  assert.match(formatDevelopmentReport(report), /Cannot find package missing-library/u)
  const cli = fileURLToPath(new URL('../bin/dsh-developer.js', import.meta.url))
  await assert.rejects(promisify(execFile)(process.execPath,
    [cli, 'verify', '--source', source, '--cases', casesPath, '--dsh', dshPath]), error => {
    assert.equal(error.code, 1)
    assert.match(error.stdout, /Cannot find package missing-library/u)
    assert.match(error.stdout, /INCOMPLETE/u)
    return true
  })
  // Preparation failures happen before a verification report can exist.
  await writeFile(dshPath, `process.stderr.write(${JSON.stringify(cause)}); process.exitCode = 7;`)
  await assert.rejects(promisify(execFile)(process.execPath,
    [cli, 'verify', '--source', source, '--cases', casesPath, '--dsh', dshPath]), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /Cannot find package missing-library/u)
    return true
  })
})
