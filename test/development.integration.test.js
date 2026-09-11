import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runDevelopmentServer, verifyDevelopmentPlugin } from '../lib/development.js'
import { resolvePackageManager } from '../lib/project.js'
import { runBounded, secretFreeEnvironment } from '../lib/runtime.js'
import { inspectDshKnowledge } from '../lib/knowledge.js'
import { readDevelopmentBrowserTarget } from '../lib/development-browser.js'

// Explicit script only: npm run test:development:dsh. Requires built example, pnpm and DSH.
const example = resolve(fileURLToPath(new URL('../examples/package-check/', import.meta.url)))
const casesPath = join(example, 'tool-cases.json')
const dshPath = process.env.DSH_DEVELOPER_DSH

test('verifies tools in shipped headless and Web compositions without a model task', { timeout: 90_000 }, async () => {
  for (const profile of ['headless', 'web']) {
    const report = await verifyDevelopmentPlugin(example, { casesPath, dshPath, profile })
    assert.equal(report.ok, true, JSON.stringify(report))
    assert.equal(report.cases.length, 8)
    assert.equal(report.profile, profile)
    assert.deepEqual(report.disabledApplicationEntries,
      profile === 'headless' ? ['headless-startup', 'headless-runner'] : undefined)
    assert.equal(report.cleanup, 'disposable profile removed')
  }
})

async function createOverlayFixture(temporary) {
  const source = join(temporary, 'plugin source')
  await mkdir(source)
  await writeFile(join(source, 'package.json'), JSON.stringify({
    name: 'dsh-development-overlay-fixture', version: '1.0.0', type: 'module', main: './index.js',
    files: ['index.js', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(source, 'cordis.patch.yml'), '- insert:\n    - id: overlay-fixture\n'
    + '      name: dsh-development-overlay-fixture\n      config:\n        value: installed default\n')
  await writeFile(join(source, 'index.js'), `
import { writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
export const name = 'overlay-fixture'
export const inject = ['tools']
export async function apply(ctx, config) {
  let started = false
  let browserState
  if (config.browserObservationPath) {
    // Import through the running loader to intercept the same module it mounts.
    // A regression must fail without opening the developer's everyday browser.
    const { internals } = await ctx.loader.import('@deepseek-ai/dsh-web-app')
    let launches = 0
    internals.openBrowser = async () => { launches += 1 }
    browserState = async () => {
      await ctx.loader.await()
      // Include the deferred opener and, on older DSH, launcher finalization.
      await new Promise(resolve => setTimeout(resolve, 100))
      const entries = [...ctx.loader.entries()].filter(entry => entry.options.name === '@deepseek-ai/dsh-web-app')
      if (entries.length !== 1) throw new Error('Expected one native Web runtime')
      const state = { openBrowser: entries[0].fiber.config.openBrowser, launches }
      await writeFile(config.browserObservationPath, JSON.stringify(state))
      return state
    }
    void browserState().catch(error => { console.error(error); process.exitCode = 1 })
  }
  if (config.observationPath) await writeFile(config.observationPath, JSON.stringify({
    value: config.value, home: process.env.DSH_HOME, pid: process.pid,
  }))
  ctx.tools.register({
    name: 'overlay_value', description: 'Return the configured fixture value.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: config.structured || browserState ? 'object' : 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
    isConcurrencySafe: () => true, execute: async () => {
      if (browserState) return browserState()
      if (config.callMarker) await writeFile(config.callMarker, JSON.stringify({ started }))
      return config.structured ? { status: 'ready', details: config.value } : config.value
    },
  })
  if (config.delayMs) await new Promise(resolve => setTimeout(resolve, config.delayMs))
  if (config.failStartup) throw new Error('delayed fixture startup failed')
  started = true
  if (config.exitAfterMs) {
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
    await writeFile(config.descendantMarker, JSON.stringify({ pid: descendant.pid }))
    setTimeout(() => process.exit(23), config.exitAfterMs)
  }
}
`)
  const npm = await resolvePackageManager('npm')
  const packed = await runBounded(npm.command, [...npm.prefixArgs, 'pack', '--ignore-scripts', '--json',
    '--pack-destination', temporary, '--cache', join(temporary, 'cache')], { cwd: source, timeoutMs: 30_000 })
  return { source, archive: join(temporary, JSON.parse(packed.stdout)[0].filename) }
}

test('background Web development and verification never launch the default browser', { timeout: 90_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-background-browser-'))
  const controller = new AbortController()
  try {
    const { archive } = await createOverlayFixture(temporary)
    const observationPath = join(temporary, 'browser.json')
    const patchPath = join(temporary, 'browser.patch.yml')
    // The caller's overlay must not undo the background runner's own policy.
    await writeFile(patchPath, '- id: web-runtime\n  config:\n    openBrowser: true\n'
      + '- id: overlay-fixture\n  config:\n    browserObservationPath: ' + JSON.stringify(observationPath) + '\n')
    const expected = { openBrowser: false, launches: 0 }
    const fixtureCases = join(temporary, 'cases.json')
    await writeFile(fixtureCases, JSON.stringify([{ tool: 'overlay_value', arguments: {}, expected }]))
    const report = await verifyDevelopmentPlugin(archive, { dshPath, profile: 'web', casesPath: fixtureCases, patchPath, online: true })
    assert.equal(report.ok, true, JSON.stringify(report))
    assert.deepEqual(JSON.parse(await readFile(observationPath, 'utf8')), expected)
    await rm(observationPath)
    await runDevelopmentServer(archive, { dshPath, patchPath, online: true, signal: controller.signal,
      onReady: async () => {
        const deadline = Date.now() + 5_000
        let observed
        while (!observed && Date.now() < deadline) {
          try { observed = JSON.parse(await readFile(observationPath, 'utf8')) }
          catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
          if (!observed) await new Promise(resolve => setTimeout(resolve, 25))
        }
        assert.deepEqual(observed, expected)
        controller.abort()
      },
    })
  } finally { controller.abort(); await rm(temporary, { recursive: true, force: true }) }
})

test('DSH launcher startup must finish before verification; current Web also waits for readiness', { timeout: 60_000 }, async () => {
  const knowledge = await inspectDshKnowledge({ dshPath, topic: 'tool' })
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-startup-runtime-'))
  const controller = new AbortController()
  try {
    const { archive } = await createOverlayFixture(temporary)
    const fixtureCases = join(temporary, 'cases.json')
    const patchPath = join(temporary, 'startup.patch.yml')
    const callMarker = join(temporary, 'invoked.json')
    await writeFile(fixtureCases, JSON.stringify([{ tool: 'overlay_value', arguments: {}, expected: 'ready' }]))
    const patch = '- id: hmr\n  disabled: true\n- id: session-telemetry-otel\n  disabled: true\n'
      + '- id: overlay-fixture\n  config:\n    value: ready\n    delayMs: 200\n    callMarker: ' + JSON.stringify(callMarker) + '\n'
    await writeFile(patchPath, patch)
    const passed = await verifyDevelopmentPlugin(archive, { dshPath, casesPath: fixtureCases, patchPath, online: true })
    assert.equal(passed.ok, true, JSON.stringify(passed))
    assert.deepEqual(JSON.parse(await readFile(callMarker, 'utf8')), { started: true })
    await rm(callMarker)

    await writeFile(patchPath, patch + '    failStartup: true\n')
    const failed = await verifyDevelopmentPlugin(archive, { dshPath, casesPath: fixtureCases, patchPath, online: true })
    assert.equal(failed.ok, false)
    assert.deepEqual(failed.cases, [])
    assert.match(JSON.stringify(failed.diagnostic), /delayed fixture startup failed/u)
    await assert.rejects(stat(callMarker), { code: 'ENOENT' })

    // Older Web launchers expose no appReady service. Verification above uses
    // completed CLI evaluation; Web startup has a separate native readiness path.
    if (knowledge.installed?.version === '0.1.1-rc.2') return
    let announced = false
    await assert.rejects(runDevelopmentServer(archive, { dshPath, patchPath, online: true, signal: controller.signal,
      onReady() { announced = true; controller.abort() },
    }), /delayed fixture startup failed/u)
    assert.equal(announced, false)
  } finally { controller.abort(); await rm(temporary, { recursive: true, force: true }) }
})

test('trusted overlay changes a packed native tool result and invalid duplicate inserts fail cleanly', { timeout: 120_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-overlay-runtime-'))
  try {
    const { archive } = await createOverlayFixture(temporary)
    const fixtureCases = join(temporary, 'tool cases.json')
    await writeFile(fixtureCases, JSON.stringify([{ tool: 'overlay_value', arguments: {}, expected: 'installed default' }]))
    const baseline = await verifyDevelopmentPlugin(archive, { casesPath: fixtureCases, dshPath, online: true })
    assert.equal(baseline.ok, true, JSON.stringify(baseline))
    const observationPath = join(temporary, 'boot observation.json')
    const patchPath = join(temporary, 'documented changes.patch.yml')
    // This unmatched id must precede the owned probe; reversing the overlays would disable verification.
    await writeFile(patchPath, '- id: overlay-fixture\n  config:\n    value: documented override\n    observationPath: '
      + JSON.stringify(observationPath) + '\n- id: dsh-developer-verification\n  disabled: true\n')
    await writeFile(fixtureCases, JSON.stringify([{ tool: 'overlay_value', arguments: {}, expected: 'documented override' }]))
    const cli = fileURLToPath(new URL('../bin/dsh-developer.js', import.meta.url))
    const args = ['verify', '--source', archive, '--cases', fixtureCases, '--patch', 'documented changes.patch.yml',
      ...(dshPath ? ['--dsh', dshPath] : []), '--online', '--json']
    const invoke = () => runBounded(process.execPath, [cli, ...args], {
      cwd: temporary, env: secretFreeEnvironment({ TMPDIR: temporary, TMP: temporary, TEMP: temporary }),
      timeoutMs: 30_000, acceptedExitCodes: [0, 1],
    })
    const overridden = await invoke()
    assert.equal(overridden.exitCode, 0, overridden.stderr || overridden.stdout)
    assert.equal(JSON.parse(overridden.stdout).cases[0].value, 'documented override')
    const observed = JSON.parse(await readFile(observationPath, 'utf8'))
    assert.equal(observed.value, 'documented override')
    await assert.rejects(stat(observed.home), { code: 'ENOENT' })
    assert.throws(() => process.kill(observed.pid, 0), { code: 'ESRCH' })
    await rm(observationPath)

    // Cordis dump-config can compose this, but actual boot must reject the duplicate id.
    await writeFile(patchPath, '- insert:\n    - id: overlay-fixture\n      name: dsh-development-overlay-fixture\n')
    const duplicate = await invoke()
    assert.equal(duplicate.exitCode, 1)
    const failed = JSON.parse(duplicate.stdout)
    assert.equal(failed.ok, false)
    assert.equal(failed.cleanup, 'disposable profile removed')
    assert.match(JSON.stringify(failed.diagnostic), /duplicate|already exists/iu)
    assert.match(failed.diagnostic.message, /--patch/u)
    assert.deepEqual(failed.cases, [])
    await assert.rejects(stat(observationPath), { code: 'ENOENT' })
    assert.deepEqual((await readdir(temporary)).filter(name => name.startsWith('dsh-developer-dev-')), [])

    // Invalid syntax must fail during preparation, before a probe can publish results.
    await writeFile(patchPath, '- id: [invalid yaml\n')
    const malformed = await invoke()
    assert.equal(malformed.exitCode, 1)
    assert.equal(malformed.stdout, '')
    assert.match(JSON.parse(malformed.stderr).message, /configuration preparation.*--patch/su)
    assert.deepEqual((await readdir(temporary)).filter(name => name.startsWith('dsh-developer-dev-')), [])
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('measures complete native results and retains bounded receipts for large output', { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-output-runtime-'))
  try {
    const { archive } = await createOverlayFixture(temporary)
    const fixtureCases = join(temporary, 'cases.json')
    const patchPath = join(temporary, 'large-output.patch.yml')
    const value = '界😀'.repeat(5000)
    await writeFile(patchPath, '- id: overlay-fixture\n  config:\n    structured: true\n    value: ' + JSON.stringify(value) + '\n')
    const expected = { status: 'ready', details: value }
    const entry = { tool: 'overlay_value', arguments: {}, expected }
    await writeFile(fixtureCases, JSON.stringify([entry]))
    const options = { dshPath, casesPath: fixtureCases, patchPath, online: true }
    const unlimited = await verifyDevelopmentPlugin(archive, options)
    assert.equal(unlimited.ok, true, JSON.stringify(unlimited))
    const observed = unlimited.cases[0]
    assert.equal(observed.valueBytes, Buffer.byteLength(JSON.stringify(expected)))
    assert.equal(observed.contentBytes, Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(expected) }])))
    assert.equal(observed.resultBytes, observed.valueBytes + observed.contentBytes)
    assert.equal(observed.valueOmitted, true)
    assert.equal(observed.contentOmitted, true)
    assert.equal(Object.hasOwn(observed, 'value'), false)

    await writeFile(fixtureCases, JSON.stringify([{ ...entry, resultPath: '/status', expected: 'ready', maxResultBytes: 4096 }]))
    const limited = await verifyDevelopmentPlugin(archive, options)
    assert.equal(limited.ok, false)
    assert.equal(limited.cases[0].outputLimitExceeded, true)
    assert.equal(limited.cases[0].value, 'ready')
    assert.equal(limited.cases[0].resultBytes, observed.resultBytes)

    await writeFile(fixtureCases, JSON.stringify(Array.from({ length: 32 }, () => ({ ...entry, expected: 'wrong' }))))
    const many = await verifyDevelopmentPlugin(archive, options)
    assert.equal(many.ok, false)
    assert.equal(many.cases.length, 32)
    assert(many.cases.every(item => item.passed === false && item.valueOmitted && item.contentOmitted))
    assert(Buffer.byteLength(JSON.stringify(many)) < 128 * 1024)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('trusted overlay reaches Web boot and preserves cancellation and cleanup', { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-overlay-web-'))
  const controller = new AbortController()
  let ready
  try {
    const { archive } = await createOverlayFixture(temporary)
    const patchPath = join(temporary, 'web changes.patch.yml')
    const observationPath = join(temporary, 'web observation.json')
    await writeFile(patchPath, '- id: overlay-fixture\n  config:\n    value: web override\n    observationPath: '
      + JSON.stringify(observationPath) + '\n- id: dsh-developer-server-observer\n  disabled: true\n')
    const report = await runDevelopmentServer(archive, { dshPath, patchPath, online: true, signal: controller.signal,
      onReady: async value => {
        ready = value
        const observed = JSON.parse(await readFile(observationPath, 'utf8'))
        assert.equal(observed.value, 'web override')
        assert.equal(observed.home, value.home)
        assert.equal(observed.pid, value.pid)
        controller.abort()
      },
    })
    assert.equal(report.stopped, true)
    await assert.rejects(stat(ready.home), { code: 'ENOENT' })
    await assert.rejects(fetch(ready.url, { signal: AbortSignal.timeout(500) }))
    assert.throws(() => process.kill(ready.pid, 0), { code: 'ESRCH' })
  } finally { controller.abort(); await rm(temporary, { recursive: true, force: true }) }
})

test('dsh-developer reads its running DSH declarations through the native tool', { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-development-native-'))
  try {
    const [report, sessionReport] = await Promise.all([
      inspectDshKnowledge({ dshPath, topic: 'tool' }),
      inspectDshKnowledge({ dshPath, topic: 'core', packageName: '@deepseek-ai/dsh-session' }),
    ])
    assert.ok(report.evidence.some(item => item.kind === 'declaration'))
    const sessionVersion = sessionReport.development.dependencies['@deepseek-ai/dsh-session']
    assert.equal(typeof sessionVersion, 'string')
    const nativeCases = join(temporary, 'native.json')
    await writeFile(nativeCases, JSON.stringify([
      { tool: 'dsh_developer', arguments: { operation: 'knowledge', topic: 'tool' },
        resultPath: '/report/installed/version', expected: report.installed.version },
      { tool: 'dsh_developer', arguments: { operation: 'knowledge', topic: 'core', packageName: '@deepseek-ai/dsh-session' },
        resultPath: '/report/development/dependencies/@deepseek-ai~1dsh-session', expected: sessionVersion },
    ]))
    const result = await verifyDevelopmentPlugin(fileURLToPath(new URL('../', import.meta.url)), { casesPath: nativeCases, dshPath })
    assert.equal(result.ok, true, JSON.stringify(result.diagnostic ?? result.cases.map(item => ({ tool: item.tool, passed: item.passed }))))
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('verifies real native values and rejects an incorrect expectation', { timeout: 90_000 }, async () => {
  const report = await verifyDevelopmentPlugin(example, { casesPath, dshPath })
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(report.cases.length, 8)
  assert.ok(report.cases.every(item => item.passed))
  assert.equal(report.cases.filter(item => item.isError).length, 3)
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-development-cases-'))
  try {
    const cases = JSON.parse(await readFile(casesPath, 'utf8')).slice(0, 1)
    cases[0].expected.satisfies = false
    cases.push({ tool: cases[0].tool, arguments: cases[0].arguments, resultPath: '/missing', expected: null })
    const wrong = join(temporary, 'wrong.json')
    await writeFile(wrong, JSON.stringify(cases))
    const failed = await verifyDevelopmentPlugin(example, { casesPath: wrong, dshPath })
    assert.equal(failed.ok, false)
    assert.equal(failed.cases[0].passed, false)
    assert.equal(failed.cases[0].value.satisfies, true)
    assert.equal(failed.cases[1].passed, false)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('verifies the production archive including its installed dependency', { timeout: 120_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-development-pack-'))
  try {
    const npm = await resolvePackageManager('npm')
    const packed = await runBounded(npm.command, [...npm.prefixArgs, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary,
      '--cache', join(temporary, 'cache')], { cwd: example, timeoutMs: 30_000 })
    const [archive] = JSON.parse(packed.stdout)
    assert.ok(archive.files.some(item => item.path === 'lib/index.js'))
    assert.ok(archive.files.every(item => !item.path.startsWith('node_modules/') && !item.path.startsWith('src/')))
    const report = await verifyDevelopmentPlugin(join(temporary, archive.filename), { casesPath, dshPath, online: true })
    assert.equal(report.ok, true, JSON.stringify(report))
    assert.equal(report.cases.length, 8)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('owns Web startup, cancellation, endpoint and profile cleanup', { timeout: 60_000 }, async () => {
  const controller = new AbortController()
  let ready
  const report = await runDevelopmentServer(example, { dshPath, signal: controller.signal, onReady: async value => {
    ready = value
    assert.equal(value.workspace.path, example)
    assert.equal(typeof value.workspace.id, 'string')
    assert.equal(new URL(value.url).search, '')
    assert.deepEqual(value.ui, { operation: 'open', developmentServer: value.home })
    const privateTarget = await readDevelopmentBrowserTarget(value.home)
    let response = await fetch(privateTarget.loginUrl, { redirect: 'manual' })
    if (response.status === 303) {
      assert.equal(response.headers.get('location'), '/')
      const cookie = response.headers.get('set-cookie').split(';', 1)[0]
      await response.body?.cancel()
      response = await fetch(new URL('/', value.url), { headers: { cookie } })
    }
    assert.match(await response.text(), /__DSH_BOOT__/u)
    controller.abort()
  } })
  assert.equal(report.stopped, true)
  assert.ok(ready.pid > 0)
  await assert.rejects(stat(ready.home), { code: 'ENOENT' })
  await assert.rejects(fetch(ready.url, { signal: AbortSignal.timeout(500) }))
  assert.throws(() => process.kill(ready.pid, 0), { code: 'ESRCH' })
})

test('never announces a foreign server as DSH readiness', { timeout: 45_000 }, async () => {
  const foreign = createServer((_req, res) => res.end('not DSH'))
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve))
  let announced = false
  try {
    await assert.rejects(runDevelopmentServer(example, { dshPath, port: foreign.address().port,
      timeoutMs: 3_000, onReady: () => { announced = true } }))
    assert.equal(announced, false)
  } finally { await new Promise(resolve => foreign.close(resolve)) }
})

test('revokes the browser handoff on DSH exit while descendants retain its log pipes', { timeout: 40_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-exit-handoff-'))
  const controller = new AbortController()
  let ready, detach, descendant
  try {
    const { archive } = await createOverlayFixture(temporary)
    const marker = join(temporary, 'descendant.json')
    const patchPath = join(temporary, 'exit.patch.yml')
    await writeFile(patchPath, '- id: overlay-fixture\n  config:\n    exitAfterMs: 1500\n    descendantMarker: '
      + JSON.stringify(marker) + '\n')
    await assert.rejects(runDevelopmentServer(archive, { dshPath, patchPath, online: true, signal: controller.signal,
      onReady: async report => {
        ready = report
        descendant = JSON.parse(await readFile(marker, 'utf8')).pid
        const target = await readDevelopmentBrowserTarget(report.home)
        let stopped
        const ownerStopped = new Promise(resolve => { stopped = resolve })
        detach = await target.watchOwner(stopped)
        let timer
        try {
          await Promise.race([ownerStopped, new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('the handoff remained active after DSH exited')), 5_000)
          })])
        } finally { clearTimeout(timer) }
        await assert.rejects(readDevelopmentBrowserTarget(report.home), { code: 'UI_DEVELOPMENT_SERVER_INVALID' })
      },
    }), { code: 'DEVELOPMENT_SERVER_EXITED' })
    assert.ok(ready, 'the server must have reached Web readiness before exiting')
    await assert.rejects(stat(ready.home), { code: 'ENOENT' })
    assert.throws(() => process.kill(ready.pid, 0), { code: 'ESRCH' })
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' })
  } finally {
    controller.abort(); detach?.()
    if (descendant) { try { process.kill(descendant, 'SIGKILL') } catch {} }
    await rm(temporary, { recursive: true, force: true })
  }
})

test('does not announce readiness when DSH exits during browser handoff creation', { timeout: 40_000 }, async t => {
  const { Server } = await import('node:net')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-exit-readiness-'))
  const controller = new AbortController()
  let announced = false, descendant
  try {
    const { archive } = await createOverlayFixture(temporary)
    const observation = join(temporary, 'server-observation.json')
    const marker = join(temporary, 'descendant.json')
    const patchPath = join(temporary, 'exit.patch.yml')
    await writeFile(patchPath, '- id: overlay-fixture\n  config:\n    exitAfterMs: 30000\n    observationPath: '
      + JSON.stringify(observation) + '\n    descendantMarker: ' + JSON.stringify(marker) + '\n')
    const listen = Server.prototype.listen
    t.mock.method(Server.prototype, 'listen', function (...args) {
      if (typeof args[0] !== 'string' || !args[0].includes('dsh-ui-')) return listen.apply(this, args)
      // Delay only the parent-owned handoff socket. The real DSH server has
      // already answered readiness, then exits while its descendant keeps logs open.
      void (async () => {
        const { pid } = JSON.parse(await readFile(observation, 'utf8'))
        descendant = JSON.parse(await readFile(marker, 'utf8')).pid
        process.kill(pid, 'SIGKILL')
        await new Promise(resolve => setTimeout(resolve, 100))
        listen.apply(this, args)
      })().catch(error => this.emit('error', error))
      return this
    })
    await assert.rejects(runDevelopmentServer(archive, { dshPath, patchPath, online: true, signal: controller.signal,
      onReady: () => { announced = true; controller.abort() },
    }), { code: 'DEVELOPMENT_SERVER_EXITED' })
    assert.equal(announced, false)
    const observed = JSON.parse(await readFile(observation, 'utf8'))
    await assert.rejects(stat(observed.home), { code: 'ENOENT' })
    assert.throws(() => process.kill(observed.pid, 0), { code: 'ESRCH' })
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' })
  } finally {
    controller.abort()
    if (descendant) { try { process.kill(descendant, 'SIGKILL') } catch {} }
    await rm(temporary, { recursive: true, force: true })
  }
})
