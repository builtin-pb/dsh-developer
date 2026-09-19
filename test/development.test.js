import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { developmentInstallerNeedsQuotes, developmentPathArgument, formatDevelopmentReport, runDevelopmentServer, validateToolCases, validReloadObservation, validVerificationReceipt, verifyDevelopmentPlugin } from '../lib/development.js'
import { apply as verifyTools, observeToolCase, selectCaseValue } from '../lib/development-probe.js'
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

test('a startup that logs an error then hangs preserves protected diagnostics and removes its profile', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dev-timeout-diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  await mkdir(join(root, '.git'))
  const source = join(root, 'plugin'), installation = join(root, 'runtime')
  await mkdir(source); await mkdir(installation)
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture', dsh: { bundle: { patch: './patch.yml' } } }))
  await writeFile(join(installation, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0',
    publishConfig: { access: 'public' }, bin: { dsh: './bin.cjs' } }))
  const realNow = Date.now.bind(Date)
  let clockOffset = 0
  t.mock.method(Date, 'now', () => realNow() + clockOffset)
  for (const mode of ['timeout', 'pem-timeout', 'cancel']) {
    const markerPath = join(root, mode + '.json')
    const controller = new AbortController()
    const credential = ['pass', 'word'].join('') + '=fixture-only-value'
    const marker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
    const dshPath = join(installation, 'bin.cjs')
    await writeFile(dshPath, `
      if (!process.argv.includes('plugin') && !process.argv.includes('--dump-config')) {
        setInterval(() => {}, 1000);
        process.stdout.write('ordinary startup log\\n'.repeat(30000) + ${JSON.stringify(mode === 'pem-timeout' ? marker + '\n' : '')}, () => {
          process.stderr.write(${JSON.stringify('Error: delayed fixture startup failed\n' + credential + '\n')}, () => {
            require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ pid: process.pid, home: process.env.DSH_HOME }));
          });
        });
      }
    `)
    const running = runDevelopmentServer(source, { dshPath, signal: controller.signal,
      onReady() { throw new Error('A hung startup must never announce readiness') },
    }).then(() => { throw new Error('Expected startup to fail') }, error => error)
    try {
      let observed
      const deadline = realNow() + 5000
      while (!observed && realNow() < deadline) {
        try { observed = JSON.parse(await readFile(markerPath, 'utf8')) } catch {}
        if (!observed) await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert(observed, 'the fixture must publish its logs before the startup deadline')
      if (mode === 'cancel') controller.abort()
      else clockOffset = 31_000 // Exercise the unchanged 30-second deadline without waiting 30 seconds.
      const error = await running
      assert.equal(error.code, mode === 'cancel' ? 'CANCELLED' : 'DEVELOPMENT_SERVER_TIMEOUT')
      assert.equal(error.details.output.truncated.stdout, true)
      assert.equal(error.details.output.truncated.stderr, false)
      const withheld = mode === 'pem-timeout'
      assert.deepEqual(error.details.output.withheld, { stdout: withheld, stderr: withheld })
      if (withheld) {
        assert.equal(error.details.stdout, '[redacted: process output contained a private key]\n')
        assert.equal(error.details.stderr, error.details.stdout)
        assert.doesNotMatch(error.message, /delayed fixture startup failed/u)
      } else {
        assert.match(error.details.stderr, /delayed fixture startup failed/u)
        assert.match(error.details.stderr, /redacted: possible credential/u)
        if (mode === 'timeout') assert.match(error.message, /delayed fixture startup failed/u)
      }
      assert(!JSON.stringify(error).includes('fixture-only-value'))
      assert.throws(() => process.kill(observed.pid, 0), { code: 'ESRCH' })
      await assert.rejects(stat(observed.home), { code: 'ENOENT' })
    } finally { controller.abort(); await running; clockOffset = 0 }
  }
})

test('consumes only bounded tokened startup error receipts and stops the owned process', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dev-error-receipt-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  await mkdir(join(root, '.git'))
  const source = join(root, 'plugin'), installation = join(root, 'runtime')
  await mkdir(source); await mkdir(installation)
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture', dsh: { bundle: { patch: './patch.yml' } } }))
  await writeFile(join(installation, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0',
    publishConfig: { access: 'public' }, bin: { dsh: './bin.cjs' } }))
  const credential = ['pass', 'word'].join('') + '=fixture-only-value'
  for (const [mode, fields] of [
    ['valid', { error: 'delayed fixture startup failed\n' + credential }],
    ['foreign', { token: 'foreign-token', error: 'untrusted failure' }],
    ['wrong-type', { error: { message: 'untrusted failure' } }],
    ['too-long', { error: 'x'.repeat(1025) }],
    ['too-large', { error: 'x'.repeat(9000) }],
    ['wrong-version', { version: 2, error: 'untrusted failure' }],
  ]) {
    const marker = join(root, mode + '.json'), dshPath = join(installation, 'bin.cjs')
    const controller = new AbortController()
    await writeFile(dshPath, `
      if (!process.argv.includes('plugin') && !process.argv.includes('--dump-config')) {
        setInterval(() => {}, 1000);
        const fs = require('node:fs');
        // The valid receipt lets the parent terminate us immediately.
        fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, home: process.env.DSH_HOME }));
        fs.writeFileSync(process.env.DSH_DEVELOPER_SERVER_RESULT, JSON.stringify({
          kind: 'dsh-development-server-private', version: 1, token: process.env.DSH_DEVELOPER_SERVER_TOKEN,
          ...${JSON.stringify(fields)}
        }));
      }
    `)
    let settled = false
    const running = runDevelopmentServer(source, { dshPath, signal: controller.signal,
      onReady() { throw new Error('Error receipts cannot announce readiness') },
    }).then(() => { throw new Error('Expected startup failure') }, error => { settled = true; return error })
    try {
      let observed
      const deadline = Date.now() + 5000
      while (!observed && Date.now() < deadline) {
        try { observed = JSON.parse(await readFile(marker, 'utf8')) } catch {}
        if (!observed) await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert(observed)
      if (mode !== 'valid') {
        await new Promise(resolve => setTimeout(resolve, 200))
        assert.equal(settled, false, mode + ' must not be accepted as a failure receipt')
        controller.abort()
      }
      const error = await running
      assert.equal(error.code, mode === 'valid' ? 'DEVELOPMENT_SERVER_STARTUP_FAILED' : 'CANCELLED')
      if (mode === 'valid') {
        assert.match(error.message, /delayed fixture startup failed/u)
        assert.match(error.message, /redacted: possible credential/u)
      }
      assert(!JSON.stringify(error).includes('fixture-only-value'))
      assert.throws(() => process.kill(observed.pid, 0), { code: 'ESRCH' })
      await assert.rejects(stat(observed.home), { code: 'ENOENT' })
    } finally { controller.abort(); await running }
  }
})

test('reports a pre-readiness leader exit without waiting indefinitely for an escaped worker pipe', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dev-early-exit-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  await mkdir(join(root, '.git'))
  const source = join(root, 'plugin'), installation = join(root, 'runtime')
  await mkdir(source); await mkdir(installation)
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture', dsh: { bundle: { patch: './patch.yml' } } }))
  await writeFile(join(installation, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0',
    publishConfig: { access: 'public' }, bin: { dsh: './bin.cjs' } }))
  const marker = join(root, 'worker.json'), dshPath = join(installation, 'bin.cjs')
  await writeFile(dshPath, `
    if (!process.argv.includes('plugin') && !process.argv.includes('--dump-config')) {
      const child = require('node:child_process').spawn(process.execPath,
        ['-e', "setInterval(() => {}, 1000); process.send('ready')"],
        { detached: true, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      child.once('message', () => {
        require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ worker: child.pid, home: process.env.DSH_HOME }));
        process.stderr.write('Error: fixture leader failed\\n', () => process.exit(7));
      });
    }
  `)
  const controller = new AbortController()
  const started = Date.now()
  try {
    await assert.rejects(runDevelopmentServer(source, { dshPath, signal: controller.signal }), error => {
      assert.equal(error.code, 'DEVELOPMENT_SERVER_EXITED')
      assert.equal(error.details.exitCode, 7)
      assert.equal(error.details.output.incomplete, true)
      assert.match(error.details.output.incompleteReason, /Descendants may still be running/)
      assert.deepEqual(error.details.output.withheld, { stdout: true, stderr: true })
      assert.equal(error.details.stdout, '[redacted: process output did not finish draining]\n')
      assert.equal(error.details.stderr, error.details.stdout)
      return true
    })
    assert(Date.now() - started < 8000, 'must not wait for the 30-second readiness deadline')
    const observed = JSON.parse(await readFile(marker, 'utf8'))
    // The escaped process is deliberately outside our ownership. Closing the
    // reader bounds the wait; it must not be reported as descendant cleanup.
    process.kill(observed.worker, 0)
    await assert.rejects(stat(observed.home), { code: 'ENOENT' })
  } finally {
    controller.abort()
    const observed = JSON.parse(await readFile(marker, 'utf8').catch(() => '{}'))
    if (observed.worker) try { process.kill(observed.worker, 'SIGKILL') } catch {}
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
  assert.doesNotThrow(() => validateToolCases([{ ...cases[0], name: '空结果 / empty results' }]))
  for (const name of ['', '   ', null, 42, 'line\nbreak', 'a'.repeat(129)]) {
    assert.throws(() => validateToolCases([{ ...cases[0], name }]), { code: 'DEVELOPMENT_CASES_INVALID' })
  }
})

test('specific error assertions require explicit error cases and bounded nonblank literals', () => {
  const base = { tool: 'fixture', arguments: {}, isError: true }
  const cases = [{ ...base, errorContains: 'NOT_FOUND' }]
  assert.equal(validateToolCases(cases), cases)
  for (const errorContains of ['', '  \n', null, 4, {}, 'x'.repeat(513)]) {
    assert.throws(() => validateToolCases([{ ...base, errorContains }]), { code: 'DEVELOPMENT_CASES_INVALID' })
  }
  for (const isError of [false, undefined]) {
    assert.throws(() => validateToolCases([{ ...base, isError, expected: null, errorContains: 'NOT_FOUND' }]),
      { code: 'DEVELOPMENT_CASES_INVALID' })
  }
})

test('verification refuses numbers that would change during case transport', () => {
  for (const literal of ['1e400', '-1e400', '-0']) {
    for (const payload of [literal, `{"nested":[{"value":${literal}}]}`]) {
      const expected = JSON.parse(`[{"tool":"value","arguments":{},"expected":${payload}}]`)
      assert.throws(() => validateToolCases(expected), {
        code: 'DEVELOPMENT_CASES_INVALID',
        message: /Case #1: expected must not contain non-finite numbers or negative zero/u,
      })
      const args = JSON.parse(`[{"tool":"value","arguments":{"value":${payload}},"expected":null}]`)
      assert.throws(() => validateToolCases(args), {
        code: 'DEVELOPMENT_CASES_INVALID',
        message: /Case #1: arguments must not contain non-finite numbers or negative zero/u,
      })
    }
  }
  const cases = [{ tool: 'value', arguments: { numeric: [0, -1, Number.MAX_VALUE, Number.MIN_VALUE],
    text: ['-0', '1e400'], empty: null }, expected: { values: [0, -1.5, true, false, null, '1e400'] } }]
  assert.equal(validateToolCases(cases), cases)
  assert.deepEqual(JSON.parse(JSON.stringify(cases)), cases)
})

test('invalid numeric case data is rejected before plugin or runtime preparation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-case-number-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const casesPath = join(root, 'cases.json')
  for (const literal of ['1e400', '-0']) {
    for (const field of ['arguments', 'expected']) {
      const candidate = field === 'expected'
        ? `{"tool":"value","arguments":{},"expected":${literal}}`
        : `{"tool":"value","arguments":{"nested":[${literal}]},"expected":null}`
      await writeFile(casesPath, `[{"tool":"value","arguments":{},"expected":null},${candidate}]`)
      await assert.rejects(verifyDevelopmentPlugin(join(root, 'absent-plugin'), {
        casesPath, dshPath: join(root, 'absent-dsh'),
      }), error => error.code === 'DEVELOPMENT_CASES_INVALID'
        && error.message.startsWith(`Case #2: ${field} must not contain non-finite numbers or negative zero`))
    }
  }
})

test('verification explains independent assertion failures without changing their verdict', () => {
  const result = { isError: false, value: { status: null }, content: [{ type: 'text', text: 'ready' }] }
  const base = { name: 'status assertion', tool: 'status', arguments: {}, expected: null, resultPath: '/status' }
  const success = observeToolCase(base, result, 0)
  assert.equal(success.passed, true)
  assert.equal(success.index, 1)
  assert.equal(success.name, base.name)
  assert.deepEqual(success.failures, [])
  const missing = observeToolCase({ ...base, resultPath: '/absent' }, result, 1)
  assert.equal(missing.passed, false)
  assert.deepEqual(missing.failures, ['missing-result-path'])
  assert.equal(Object.hasOwn(missing, 'value'), false)
  const wrong = observeToolCase({ ...base, expected: 'ready', isError: true, maxResultBytes: 1 }, result, 2)
  assert.equal(wrong.passed, false)
  assert.deepEqual(wrong.failures, ['expected-error', 'value-mismatch', 'result-budget-exceeded'])
  assert.equal(wrong.expected, 'ready')
  assert.equal(wrong.value, null)
  const error = observeToolCase(base, { ...result, isError: true }, 3)
  assert.deepEqual(error.failures, ['unexpected-error'])
  const text = formatDevelopmentReport({ ok: false, cases: [missing, wrong, error] })
  assert.match(text, /FAIL #2 status "status assertion"/u)
  assert.match(text, /resultPath is missing/u)
  assert.match(text, /resultPath: "\/absent"/u)
  assert.match(text, /Tool succeeded; expected an error/u)
  assert.match(text, /expected: "ready"/u)
  assert.match(text, /Tool returned an error; expected success/u)
})

test('named failure receipts retain verdicts and fit the receipt budget with maximal fields', () => {
  const value = '\u0000'.repeat(170) // JSON escaping, not JS string length, consumes the budget.
  const item = { name: '\ud800'.repeat(128), tool: 't'.repeat(128), arguments: {},
    resultPath: '/' + 'p'.repeat(511), expected: 'e'.repeat(1022), isError: true, maxResultBytes: 1 }
  assert.doesNotThrow(() => validateToolCases([item]))
  const result = { isError: false, value: { [item.resultPath.slice(1)]: value },
    content: [{ type: 'text', text: 'c'.repeat(2000) }] }
  const cases = Array.from({ length: 32 }, (_, index) => observeToolCase(item, result, index))
  assert(cases.every(row => !row.passed && row.expected === item.expected && row.contentOmitted && row.resultPathOmitted))
  assert(Buffer.byteLength(JSON.stringify({ ok: false, cases })) < 128 * 1024)
  const largeExpected = observeToolCase({ ...item, expected: 'x'.repeat(2000) }, result, 0)
  assert.equal(largeExpected.expectedOmitted, true)
  assert.match(formatDevelopmentReport({ ok: false, cases: [largeExpected] }), /expected: omitted from report; compared in full/u)
})

test('verification checkpoints retain completed cases when a later invocation rejects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-case-checkpoint-'))
  const spec = [{ tool: 'first', arguments: {}, expected: 'done' },
    { name: 'rejected invocation', tool: 'second', arguments: {}, expected: 'done' },
    { tool: 'third', arguments: {}, expected: 'done' }]
  const environment = { DSH_DEVELOPER_CASES: join(root, 'cases.json'),
    DSH_DEVELOPER_CASE_RESULT: join(root, 'result.json'), DSH_DEVELOPER_BOOT_COMPLETE: join(root, 'boot') }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  const disposers = []
  t.after(async () => {
    disposers.forEach(dispose => dispose())
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(environment.DSH_DEVELOPER_CASES, JSON.stringify(spec))
  await writeFile(environment.DSH_DEVELOPER_BOOT_COMPLETE, '')
  let exit, executions = 0
  const exited = new Promise(resolve => { exit = resolve })
  verifyTools({
    effect: effect => disposers.push(effect()), appExit: exit,
    loader: { await: async () => {}, entries: () => [] },
    tools: { get: () => ({}), execute: async () => {
      const checkpoint = JSON.parse(await readFile(environment.DSH_DEVELOPER_CASE_RESULT, 'utf8'))
      assert.equal(validVerificationReceipt(checkpoint, spec), true)
      assert.equal(checkpoint.complete, false)
      assert.equal(checkpoint.activeCase.index, ++executions)
      if (executions === 2) {
        assert.equal(checkpoint.cases.length, 1)
        assert.equal(checkpoint.cases[0].passed, true)
        throw new Error('fixture executor rejected')
      }
      return { isError: false, value: 'done', content: [] }
    } },
  })
  let timer
  try {
    assert.equal(await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('verification did not settle')), 5000)
    })]), 1)
  } finally { clearTimeout(timer) }
  const report = JSON.parse(await readFile(environment.DSH_DEVELOPER_CASE_RESULT, 'utf8'))
  assert.equal(validVerificationReceipt(report, spec), true)
  assert.equal(report.ok, false)
  assert.equal(report.complete, false)
  assert.equal(report.cases.length, 1)
  assert.equal(report.cases[0].value, 'done')
  assert.equal(report.activeCase.index, 2)
  assert.equal(report.error, 'fixture executor rejected')
  assert.equal(executions, 2)
  await assert.rejects(stat(environment.DSH_DEVELOPER_CASE_RESULT + '.pending'), { code: 'ENOENT' })
})

test('partial or mismatched verification receipts cannot establish a complete verdict', () => {
  const cases = [{ tool: 'first', arguments: {}, expected: 'done' }, { tool: 'next', name: 'next case', arguments: {}, expected: true }]
  const partial = { ok: false, complete: false, phase: 'cases', caseCount: 2,
    cases: [{ index: 1, tool: 'first', passed: true }], activeCase: { index: 2, tool: 'next', name: 'next case' } }
  assert.equal(validVerificationReceipt(partial, cases), true)
  for (const changed of [
    { ok: true }, { complete: true }, { caseCount: 1 }, { activeCase: { index: 1, tool: 'first' } },
    { cases: [{ index: 1, tool: 'other', passed: true }] },
    { cases: [{ index: 2, tool: 'first', passed: true }] },
  ]) assert.equal(validVerificationReceipt({ ...partial, ...changed }, cases), false)
  const complete = { ...partial, complete: true, phase: 'complete', ok: true, activeCase: null,
    cases: [...partial.cases, { index: 2, tool: 'next', name: 'next case', passed: true }] }
  assert.equal(validVerificationReceipt(complete, cases), true)
  assert.equal(validVerificationReceipt({ ...complete, error: 'afterward failure' }, cases), false)
  assert.equal(validVerificationReceipt({ ...complete, ok: false }, cases), false)
  assert.equal(validVerificationReceipt(complete, cases, '/workspace'), false)
  const scoped = { ...complete, agent: { id: 'real-agent', preset: 'standard' } }
  assert.equal(validVerificationReceipt(scoped, cases, '/workspace'), true)
  assert.equal(validVerificationReceipt(scoped, cases), false)
  const disposing = { ...scoped, complete: false, ok: false, phase: 'agent-dispose' }
  assert.equal(validVerificationReceipt(disposing, cases, '/workspace'), true)
  assert.equal(validVerificationReceipt({ ...disposing, ok: true }, cases, '/workspace'), false)
  assert.match(formatDevelopmentReport(partial), /INCOMPLETE: 1 of 2 cases returned results/u)
  assert.match(formatDevelopmentReport(partial), /Interrupted during #2 next "next case"/u)
})

test('Agent verification and Web preview require an existing workspace before runtime preparation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'file')
  await writeFile(file, '')
  for (const workspacePath of ['', ' ', null, false, file, join(root, 'absent'), 'invalid\0path']) {
    await assert.rejects(verifyDevelopmentPlugin(root, { workspacePath }), { code: 'DEVELOPMENT_WORKSPACE_INVALID' })
    await assert.rejects(runDevelopmentServer(root, { workspacePath }), { code: 'DEVELOPMENT_WORKSPACE_INVALID' })
  }
  const parsed = parseCliArguments(['verify', '--workspace', root])
  assert.doesNotThrow(() => assertCliCommandOptions(parsed.command, parsed.options))
  assert.doesNotThrow(() => assertCliCommandOptions('dev', parsed.options))
  for (const command of ['project', 'run', 'doctor']) {
    assert.throws(() => assertCliCommandOptions(command, parsed.options), /does not accept/u)
  }
  assert.throws(() => parseNativeToolInput({ operation: 'project', workspace: root }), /not valid/u)
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

test('dev CLI prints final shutdown reports and preserves incomplete-drain warnings and JSON metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dev-final-report-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cli = fileURLToPath(new URL('../bin/dsh-developer.js', import.meta.url))
  const development = new URL('../lib/development.js', import.meta.url).href
  const ready = { ok: true, url: 'http://127.0.0.1:4173/', profile: 'web', workspace: { id: 'workspace', path: '/example' } }
  const reload = { kind: 'dsh-development-reload', sequence: 2, attempt: 1, warnings: 1, status: 'warning', active: 1, inactive: 0 }
  const reason = 'Inherited pipes did not close after the termination attempt; readers were closed. Descendants may still be running.'
  for (const incomplete of [false, true]) {
    const report = { ok: true, stopped: true, cleanup: 'disposable profile removed',
      ...(incomplete ? { output: { incomplete: true, incompleteReason: reason,
        truncated: { stdout: true, stderr: false }, withheld: { stdout: true, stderr: true } } } : {}) }
    // Stub only the server lifecycle at the CLI boundary; use the actual entry
    // point and formatter without a browser, socket or installed DSH profile.
    const hook = join(root, 'hook.mjs')
    await writeFile(hook, `
      import { registerHooks } from 'node:module'
      registerHooks({ load(url, context, nextLoad) {
        if (url !== ${JSON.stringify(development)}) return nextLoad(url, context)
        return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
          export * from ${JSON.stringify(development + '?actual')}
          export async function runDevelopmentServer(source, options) {
            if (options.watch !== true) throw new Error('watch option did not reach the server')
            if (options.workspacePath !== source) throw new Error('workspace option did not reach the server')
            await options.onReady(${JSON.stringify(ready)})
            await options.onReload(${JSON.stringify(reload)})
            return ${JSON.stringify(report)}
          }
        `)} }
      } })
    `)
    for (const json of [false, true]) {
      const { stdout, stderr } = await promisify(execFile)(process.execPath,
        ['--import', pathToFileURL(hook).href, cli, 'dev', '--source', root, '--watch', '--workspace', root, ...(json ? ['--json'] : [])], { timeout: 10_000 })
      assert.equal(stderr, '')
      if (json) {
        const reports = JSON.parse('[' + stdout.trim().replace(/\}\s*\{/gu, '},{') + ']')
        assert.deepEqual(reports, [ready, reload, report])
      } else {
        assert.match(stdout, /http:\/\/127\.0\.0\.1:4173\//u)
        assert.match(stdout, /Development server stopped\./u)
        assert.match(stdout, /reload warning; current code may be stale/u)
        assert.doesNotMatch(stdout, /Verification workspace|\[object Object\]/u)
        assert.match(stdout, /Web workspace: \/example/u)
        assert.ok(stdout.endsWith(report.cleanup + '\n'))
        if (incomplete) assert.ok(stdout.includes('WARNING: ' + reason))
        else assert.doesNotMatch(stdout, /WARNING:/u)
      }
    }
  }
  assert.match(formatDevelopmentReport({ ok: true, stopped: true, output: { incomplete: true } }),
    /WARNING: .*descendant cleanup is unverified/u)
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

test('native hot reload is opt-in, dev-only and rejects archives before installing DSH', async t => {
  const parsed = parseCliArguments(['dev', '--source', 'plugin', '--watch'])
  assertCliCommandOptions(parsed.command, parsed.options)
  assert.equal(parsed.options.watch, true)
  assert.throws(() => assertCliCommandOptions('verify', { watch: true }), /does not accept/u)
  for (const watch of ['true', 1, null, {}]) {
    await assert.rejects(runDevelopmentServer('missing source', { watch }), { code: 'DEVELOPMENT_WATCH_INVALID' })
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-watch-selection-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const archive = join(root, 'plugin.tgz')
  await writeFile(archive, 'not an archive')
  await assert.rejects(runDevelopmentServer(archive, { watch: true, dshPath: 'missing-dsh' }),
    { code: 'DEVELOPMENT_WATCH_SOURCE_INVALID' })
})

test('installer quoting follows the selected forwarder and reaches both source and store arguments', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-installer-argv-')))
  const temporaryHomes = join(root, 'temporary # & (profiles) 雪')
  const temporaryKey = process.platform === 'win32' ? 'TEMP' : 'TMPDIR'
  const previous = process.env[temporaryKey]
  t.after(async () => {
    if (previous === undefined) delete process.env[temporaryKey]
    else process.env[temporaryKey] = previous
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const source = join(root, 'plugin # & (source) 雪'), installation = join(root, 'runtime')
  await mkdir(join(root, '.git'))
  await mkdir(source)
  await mkdir(installation)
  await mkdir(temporaryHomes)
  process.env[temporaryKey] = temporaryHomes
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture', dsh: { bundle: { patch: './patch.yml' } } }))
  const manifest = { name: '@deepseek-ai/dsh', version: '1.0.0',
    publishConfig: { access: 'public' }, bin: { dsh: './bin.cjs' } }
  await writeFile(join(installation, 'package.json'), JSON.stringify(manifest))
  // Published legacy and current call shapes. Keep both chunks installed and
  // the same version: only the selected CLI import determines argument handling.
  await writeFile(join(installation, 'plugin-old.js'), `
    import { spawnSync } from 'node:child_process';
    export function runPlugin(profile, args) {
      return spawnSync('pnpm', args.map(argument => anchorPathSpec(argument, process.cwd())), {
        cwd: profile, stdio: 'inherit', shell: process.platform === 'win32'
      });
    }
  `)
  await writeFile(join(installation, 'plugin-new.js'), `
    import { runPluginCommand } from '@deepseek-ai/dsh-plugin-manager/operations';
    export async function runPlugin(profile, args) {
      return runPluginCommand({ profile, cwd: process.cwd() }, args, { execution: 'cli' });
    }
  `)
  const dshPath = join(installation, 'bin.cjs'), observedPath = join(root, 'observed.json')
  for (const [chunk, needsQuotes] of [['old', true], ['new', false]]) {
    await writeFile(dshPath, `
      if (false) import('./plugin-${chunk}.js');
      require('node:fs').writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({
        args: process.argv.slice(2), home: process.env.DSH_HOME
      }));
      process.exitCode = 7;
    `)
    const installed = { root: installation, value: manifest }
    assert.equal(await developmentInstallerNeedsQuotes(installed, 'win32'), needsQuotes)
    assert.equal(await developmentInstallerNeedsQuotes(installed, 'linux'), false)
    assert.equal(await developmentInstallerNeedsQuotes(installed, 'darwin'), false)
    // Stop at installation: this observes the public dev call without booting
    // DSH, invoking pnpm, contacting a registry or opening a browser.
    await assert.rejects(runDevelopmentServer(source, { dshPath }), { code: 'COMMAND_EXITED' })
    const observed = JSON.parse(await readFile(observedPath, 'utf8'))
    const quote = path => process.platform === 'win32' && needsQuotes ? '"' + path + '"' : path
    assert.deepEqual(observed.args, ['plugin', '--profile', 'web', 'add', quote(source), '--ignore-scripts',
      '--store-dir', quote(join(observed.home, 'pnpm-store')), '--offline'])
    assert.equal(observed.home.startsWith(temporaryHomes), true)
    await assert.rejects(stat(observed.home), { code: 'ENOENT' })
  }
  // An inline forwarder works too; a missing selected chunk is a read failure,
  // not permission to guess at the argument transport.
  await writeFile(dshPath, await readFile(join(installation, 'plugin-old.js')))
  assert.equal(await developmentInstallerNeedsQuotes({ root: installation, value: manifest }, 'win32'), true)
  await writeFile(dshPath, 'import("./plugin-missing.js")')
  await assert.rejects(developmentInstallerNeedsQuotes({ root: installation, value: manifest }, 'win32'), { code: 'ENOENT' })
})

test('Windows installer paths use legacy shell quotes or direct argv without changing their values', async () => {
  const paths = ['C:\\work space\\plugin # & (source)^', 'C:\\临时 目录\\pnpm-store', 'D:\\plain\\plugin.tgz']
  for (const path of paths) {
    assert.equal(developmentPathArgument(path, 'win32', true), '"' + path + '"')
    assert.equal(developmentPathArgument(path, 'win32', false), path)
    for (const platform of ['linux', 'darwin']) {
      assert.equal(developmentPathArgument(path, platform, true), path)
      assert.equal(developmentPathArgument(path, platform, false), path)
    }
  }
  for (const path of ['C:\\%USERNAME%\\plugin', 'C:\\!NAME!\\plugin', 'C:\\bad"name', 'C:\\line\nbreak']) {
    assert.throws(() => developmentPathArgument(path, 'win32', true), { code: 'DEVELOPMENT_PATH_UNSUPPORTED' })
  }
  const direct = [...paths, 'C:\\%USERNAME%\\plugin', 'C:\\!NAME!\\plugin']
  const { stdout } = await promisify(execFile)(process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--',
      ...direct.map(path => developmentPathArgument(path, 'win32', false))], { windowsHide: true })
  assert.deepEqual(JSON.parse(stdout), direct)
})

test('legacy Windows shell forwarding delivers spaces and punctuation as single arguments',
  { skip: process.platform !== 'win32' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installer-shell-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const entry = join(root, 'echo # & (args).cjs')
    await writeFile(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    const paths = ['C:\\work space\\plugin # & (source)^', 'C:\\临时 目录\\pnpm-store', 'D:\\archive # & plugin.tgz']
    // Reproduce the legacy forwarder's shell:true boundary with an argv echo
    // child. No package installation or DSH application is started.
    const { stdout } = await promisify(execFile)('"' + process.execPath + '"',
      [entry, ...paths].map(path => developmentPathArgument(path, 'win32', true)),
      { shell: true, windowsHide: true })
    assert.deepEqual(JSON.parse(stdout), paths)
  })

test('reload observations require bounded metadata and never label inactive entries settled', () => {
  const observation = { sequence: 1, attempt: 0, warnings: 1, status: 'warning', active: 1, inactive: 0 }
  assert.equal(validReloadObservation(observation), true)
  for (const change of [{ sequence: 0 }, { attempt: -1 }, { warnings: Infinity }, { active: '1' },
    { inactive: Number.MAX_SAFE_INTEGER + 1 }, { status: 'success' }, { status: 'settled', inactive: 1 }]) {
    assert.equal(validReloadObservation({ ...observation, ...change }), false)
  }
  assert.doesNotMatch(formatDevelopmentReport({ kind: 'dsh-development-reload', ...observation }), /PASS|FAIL/u)
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
