import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { formatDevelopmentReport, runDevelopmentServer, verifyDevelopmentPlugin } from '../lib/development.js'
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
import { readFile, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
export const name = 'overlay-fixture'
export const inject = ['tools']
export async function apply(ctx, config) {
  if (config.webWorkspaceMarker) ctx.inject(['agents', 'workspaceRegistry'], webCtx => {
    const observe = async () => {
      try {
        await webCtx.loader.await()
        // Start after the parent receives dev readiness, which includes its
        // asynchronous workspace registration, just as a browser user would.
        const deadline = Date.now() + 15000
        while (!await readFile(config.webWorkspaceMarker + '.start').catch(() => undefined)) {
          if (Date.now() > deadline) throw new Error('parent did not begin the Web workspace check')
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        const controller = webCtx.get('sessionController')
        let created, api
        if (controller) { created = await controller.create({}); api = 'session-controller' }
        else {
          const response = await webCtx.get('apiProxy').sessions.create({ rpcId: 'preview-create', method: 'session.create', payload: {} })
          if (!response.result.ok) throw new Error(response.result.error.message)
          created = response.result.value
          api = 'legacy-api-proxy'
        }
        const { sessionId } = created
        const agent = webCtx.agents.get(sessionId)
        const result = await webCtx.tools.execute({ callId: 'preview-workspace-read', name: 'read',
          arguments: { file_path: 'workspace.txt' }, agent, signal: new AbortController().signal })
        await writeFile(config.webWorkspaceMarker, JSON.stringify({ api, cwd: agent.session.header.cwd,
          processCwd: process.cwd(), workspaces: webCtx.workspaceRegistry.list().map(item => item.path),
          isError: result.isError, line: result.value?.lines?.[0]?.text }))
      } catch (error) { await writeFile(config.webWorkspaceMarker, JSON.stringify({ error: error.message })) }
    }
    const ready = webCtx.get('appReady')
    if (ready) webCtx.effect(() => ready.onReady(() => { void observe() }))
    else setTimeout(() => { void observe() }, 0)
  })
  if (config.agentChecks) {
    const calls = new Map()
    ctx.on('agent/disposed', ({ agent }) => writeFileSync(config.agentDisposedMarker,
      JSON.stringify({ id: agent.id, registered: Boolean(ctx.get('agents').get(agent.id)) })))
    ctx.tools.register({
      name: 'agent_state', description: 'Observe the real verification Agent.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: () => false, execute: async (_args, exec) => {
        if (!exec.agent) throw new Error('fixture requires a real Agent')
        const agent = exec.agent
        calls.set(agent.id, (calls.get(agent.id) ?? 0) + 1)
        return { selectedWorkspace: agent.session.header.cwd === config.agentWorkspace, registered: Boolean(ctx.get('agents').get(agent.id)),
          policy: ctx.get('approval').effectivePolicy(agent.session), batchCalls: calls.get(agent.id) }
      },
    })
    ctx.tools.register({
      name: 'require_approval', description: 'Observe native approval without a model turn.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      isConcurrencySafe: () => false, execute: async (_args, exec) => {
        await ctx.get('approval').request({ agent: exec.agent, signal: exec.signal,
          description: 'Fixture approval request', kind: 'tool', details: {} })
        return 'approval must not be manufactured'
      },
    })
  }
  if (config.exitCodeOnShutdown !== undefined) {
    ctx.effect(() => () => process.exit(config.exitCodeOnShutdown), 'fixture abnormal shutdown')
  }
  let started = false
  let calls = 0
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
      calls += 1
      if (config.processDiagnostic) console.error(config.processDiagnostic)
      if (config.errorOnCall === calls) throw new Error(config.errorMessage)
      if (config.interruptOnCall === calls) {
        await writeFile(config.interruptMarker, JSON.stringify({ home: process.env.DSH_HOME, pid: process.pid }))
        if (config.interruptMode === 'exit') process.exit(23)
        const timer = setInterval(() => {}, 1000)
        ctx.effect(() => () => clearInterval(timer), 'stop hanging fixture')
        await new Promise(() => {})
      }
      if (browserState) return browserState()
      if (config.workerMarker) {
        const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready')"],
          { stdio: ['ignore', config.workerStdio, config.workerStdio, 'ipc'] })
        await new Promise(resolve => worker.once('message', resolve))
        const profilePath = process.env.DSH_HOME + '/profiles/developer-test/'
        const modules = await readFile(profilePath + 'node_modules/.modules.yaml', 'utf8')
        const manifest = JSON.parse(await readFile(profilePath + 'package.json', 'utf8'))
        await writeFile(config.workerMarker, JSON.stringify({ pid: worker.pid, home: process.env.DSH_HOME, modules,
          patchReload: manifest.dsh.profile.patchReload, watcher: Boolean(ctx.get('hmr')) }))
        worker.disconnect()
        worker.unref()
      }
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

test('retains earlier native results and identifies an invocation interrupted by timeout, cancellation or exit', { timeout: 120_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-interrupted-cases-'))
  try {
    const { archive } = await createOverlayFixture(temporary)
    const fixtureCases = join(temporary, 'cases.json'), patchPath = join(temporary, 'interrupt.patch.yml')
    const marker = join(temporary, 'interrupted.json')
    await writeFile(fixtureCases, JSON.stringify(['first result', 'interrupted result', 'never invoked'].map(name => ({
      name, tool: 'overlay_value', arguments: {}, expected: 'ready',
    }))))
    for (const mode of ['timeout', 'cancel', 'exit']) {
      await rm(marker, { force: true })
      await writeFile(patchPath, '- id: overlay-fixture\n  config:\n    value: ready\n    interruptOnCall: 2\n'
        + '    interruptMode: ' + mode + '\n    interruptMarker: ' + JSON.stringify(marker) + '\n')
      const controller = new AbortController()
      const running = verifyDevelopmentPlugin(archive, { dshPath, casesPath: fixtureCases, patchPath, online: true,
        timeoutMs: mode === 'timeout' ? 15_000 : 30_000, signal: controller.signal,
        ...(mode === 'cancel' ? { workspacePath: temporary } : {}),
      }).then(report => ({ report }), error => ({ error }))
      try {
        if (mode === 'cancel') {
          const deadline = Date.now() + 30_000
          while (Date.now() < deadline && !await stat(marker).catch(() => undefined)) {
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          assert(await stat(marker).catch(() => undefined), 'the second invocation must begin before cancellation')
          controller.abort()
        }
        const outcome = await running
        if (mode === 'cancel') assert.equal(outcome.error?.code, 'CANCELLED')
        else assert.equal(outcome.error, undefined)
        const report = outcome.report ?? outcome.error.details.verification
        assert.equal(report.ok, false)
        assert.equal(report.complete, false)
        assert.equal(report.caseCount, 3)
        if (mode === 'cancel') assert.equal(report.agent.workspace, await realpath(temporary))
        assert.equal(report.cases.length, 1)
        assert.equal(report.cases[0].passed, true)
        assert.equal(report.cases[0].value, 'ready')
        assert.deepEqual(report.activeCase, { index: 2, tool: 'overlay_value', name: 'interrupted result' })
        assert.equal(report.diagnostic.code, { timeout: 'COMMAND_TIMEOUT', cancel: 'CANCELLED', exit: 'COMMAND_EXITED' }[mode])
        const observed = JSON.parse(await readFile(marker, 'utf8'))
        await assert.rejects(stat(observed.home), { code: 'ENOENT' })
      } finally { controller.abort(); await running }
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('verifies workspace-relative and Agent-scoped tools with native policy and awaited disposal', { timeout: 90_000 }, async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agent-cases-')))
  try {
    const { archive } = await createOverlayFixture(temporary)
    const workspace = join(temporary, '工作 space')
    await mkdir(workspace)
    await writeFile(join(workspace, 'marker.txt'), 'selected workspace\n')
    const disposed = join(temporary, 'agent-disposed.json')
    const patchPath = join(temporary, 'agent.patch.yml'), fixtureCases = join(temporary, 'cases.json')
    await writeFile(patchPath, '- id: overlay-fixture\n  config:\n    agentChecks: true\n    agentDisposedMarker: ' + JSON.stringify(disposed)
      + '\n    agentWorkspace: ' + JSON.stringify(workspace) + '\n')
    const state = batchCalls => ({ selectedWorkspace: true, registered: true, policy: 'ask', batchCalls })
    await writeFile(fixtureCases, JSON.stringify([
      { name: 'relative file in selected workspace', tool: 'read', arguments: { file_path: 'marker.txt' }, resultPath: '/lines/0/text', expected: 'selected workspace' },
      { name: 'fresh Agent', tool: 'agent_state', arguments: {}, expected: state(1) },
      { name: 'no synthetic approval', tool: 'require_approval', arguments: {}, isError: true },
      { name: 'same Agent and unchanged policy', tool: 'agent_state', arguments: {}, expected: state(2) },
    ]))
    for (const profile of ['developer-test', 'web']) {
      await rm(disposed, { force: true })
      const report = await verifyDevelopmentPlugin(archive, { dshPath, profile, casesPath: fixtureCases, patchPath,
        workspacePath: workspace, online: true })
      assert.equal(report.ok, true, JSON.stringify(report))
      assert.equal(report.complete, true)
      assert.equal(report.phase, 'complete')
      assert.equal(report.workspace, workspace)
      assert.equal(report.agent.workspace, workspace)
      if (profile === 'web') assert.equal(report.agent.preset, 'standard')
      assert.equal(report.cases[2].isError, true)
      assert.match(JSON.stringify(report.cases[2].content), /turn/i)
      assert.deepEqual(JSON.parse(await readFile(disposed, 'utf8')), { id: report.agent.id, registered: false })
      assert.equal(await readFile(join(workspace, 'marker.txt'), 'utf8'), 'selected workspace\n')
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('retains native completion and verdicts while withholding a credential-like diagnostic path', { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-protected-receipt-'))
  try {
    const { archive } = await createOverlayFixture(temporary)
    const patchPath = join(temporary, 'diagnostic.patch.yml'), fixtureCases = join(temporary, 'cases.json')
    const diagnosticPath = '/tmp/' + ['plugin-development', 'workspace-2026', 'projects', 'commands', 'README.md'].join('/')
    await writeFile(patchPath, '- id: overlay-fixture\n  config:\n    value: ready\n    errorOnCall: 2\n'
      + '    errorMessage: ' + JSON.stringify('File has not been read: ' + diagnosticPath) + '\n')
    for (const mode of ['matching', 'wrong-message', 'unexpected-error']) {
      const expectedError = mode !== 'unexpected-error', expectedPass = mode === 'matching'
      await writeFile(fixtureCases, JSON.stringify([
        { name: 'before error', tool: 'overlay_value', arguments: {}, expected: 'ready' },
        { name: 'diagnostic', tool: 'overlay_value', arguments: {}, isError: expectedError, expected: null,
          ...(expectedError ? { errorContains: mode === 'matching' ? 'has not been read' : 'unrelated failure' } : {}) },
        { name: 'after error', tool: 'overlay_value', arguments: {}, expected: 'ready' },
      ]))
      const report = await verifyDevelopmentPlugin(archive, { dshPath, casesPath: fixtureCases, patchPath, online: true })
      assert.equal(report.complete, true, JSON.stringify(report))
      assert.equal(report.ok, expectedPass)
      assert.equal(report.phase, 'complete')
      assert.deepEqual(report.cases.map(item => item.passed), [true, expectedPass, true])
      assert.equal(report.cases[1].contentWithheld, true)
      assert.equal(report.outputProtection.withheld, true)
      assert(!JSON.stringify(report).includes(diagnosticPath))
      if (!expectedPass) {
        assert.equal(report.diagnostic.code, 'DEVELOPMENT_CASES_FAILED')
        assert.deepEqual(report.cases[1].failures, [expectedError ? 'error-message-mismatch' : 'unexpected-error'])
      }
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('private-key protection covers both native result and process diagnostic channels', { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-cross-channel-protection-'))
  try {
    const { archive } = await createOverlayFixture(temporary)
    const patchPath = join(temporary, 'protection.patch.yml'), fixtureCases = join(temporary, 'cases.json')
    const marker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
    const fragment = 'short-body-fragment'
    for (const markerInProcess of [true, false]) {
      await writeFile(patchPath, '- id: overlay-fixture\n  config:\n    structured: true\n'
        + '    value: ' + JSON.stringify(markerInProcess ? fragment : marker) + '\n'
        + '    processDiagnostic: ' + JSON.stringify(markerInProcess ? marker : fragment) + '\n')
      await writeFile(fixtureCases, JSON.stringify([{ tool: 'overlay_value', arguments: {},
        resultPath: '/status', expected: markerInProcess ? 'ready' : 'wrong' }]))
      const report = await verifyDevelopmentPlugin(archive, { dshPath, casesPath: fixtureCases, patchPath, online: true })
      assert.equal(report.complete, true, JSON.stringify(report))
      assert.equal(report.ok, markerInProcess)
      assert.equal(report.cases[0].passed, markerInProcess)
      assert.equal(report.cases[0].valueWithheld, true)
      assert.equal(report.outputProtection.reason, 'private-key')
      assert(!JSON.stringify(report).includes(marker))
      assert(!JSON.stringify(report).includes(fragment))
      if (!markerInProcess) {
        assert.equal(report.diagnostic.code, 'DEVELOPMENT_CASES_FAILED')
        assert.equal(report.diagnostic.stderr, undefined)
        assert.equal(report.diagnostic.stdout, undefined)
        assert.deepEqual(report.diagnostic.output.withheld, { stdout: true, stderr: true })
      }
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('self-hosted project verification resolves the real Agent workspace and rejects escape', { timeout: 60_000 }, async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dsh-selfhost-agent-')))
  try {
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ name: 'selected-workspace', version: '1.0.0' }))
    const fixtureCases = join(temporary, 'cases.json')
    await writeFile(fixtureCases, JSON.stringify([
      { name: 'selected project', tool: 'dsh_developer', arguments: { operation: 'project' },
        resultPath: '/report/project/name', expected: 'selected-workspace' },
      { name: 'workspace escape', tool: 'dsh_developer', arguments: { operation: 'project', source: '..' }, isError: true },
    ]))
    const report = await verifyDevelopmentPlugin(fileURLToPath(new URL('../', import.meta.url)),
      { dshPath, casesPath: fixtureCases, workspacePath: temporary })
    assert.equal(report.ok, true, JSON.stringify(report))
    assert.match(JSON.stringify(report.cases[1].content), /inside.*workspace/i)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('verification reaps native tool workers before removing its disposable profile', {
  skip: process.platform === 'win32', timeout: 60_000,
}, async () => {
  // POSIX process-group cleanup only: taskkill cannot promise this after a
  // Windows leader exits, so do not claim coverage of that lifecycle here.
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-verification-workers-'))
  const marker = join(temporary, 'worker.json')
  try {
    const { archive } = await createOverlayFixture(temporary)
    const fixtureCases = join(temporary, 'cases.json')
    const patchPath = join(temporary, 'worker.patch.yml')
    for (const [stdio, expected, ok] of [['ignore', 'installed default', true], ['inherit', 'wrong', false]]) {
      await writeFile(fixtureCases, JSON.stringify([{ tool: 'overlay_value', arguments: {}, expected }]))
      await writeFile(patchPath, '- id: overlay-fixture\n  config:\n    value: installed default\n    workerStdio: '
        + stdio + '\n    workerMarker: ' + JSON.stringify(marker) + '\n')
      const result = await verifyDevelopmentPlugin(archive, { dshPath, casesPath: fixtureCases, patchPath, timeoutMs: 15_000 })
      assert.equal(result.ok, ok, JSON.stringify(result))
      assert.equal(result.cases.length, 1, 'cleanup must retain the native case evidence')
      assert.equal(result.cases[0].passed, ok)
      assert.equal(result.processCleanup.platform, process.platform)
      assert.match(result.processCleanup.afterLeaderExit, /Attempt SIGTERM.*SIGKILL.*await/u)
      assert.match(result.processCleanup.limitation, /not proof that every descendant exited/u)
      const worker = JSON.parse(await readFile(marker, 'utf8'))
      // pnpm 11 writes JSON to .modules.yaml; earlier versions use YAML.
      let store
      try { store = JSON.parse(worker.modules).storeDir } catch { store = /^storeDir: (.+)$/mu.exec(worker.modules)?.[1] }
      assert.ok(store?.startsWith(worker.home + '/pnpm-store/'), 'pnpm must actually use the disposable store: ' + store)
      if (worker.patchReload !== undefined) {
        assert.equal(worker.patchReload, 'startup')
        assert.equal(result.patchReload, 'startup')
        assert.equal(worker.watcher, false, 'one-shot verification must not start native patch watchers')
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { process.kill(worker.pid, 0) } catch (error) { if (error.code === 'ESRCH') break; throw error }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.throws(() => process.kill(worker.pid, 0), { code: 'ESRCH' })
      await assert.rejects(stat(worker.home), { code: 'ENOENT' })
    }
  } finally {
    const worker = JSON.parse(await readFile(marker, 'utf8').catch(() => '{}'))
    if (worker.pid) { try { process.kill(worker.pid, 'SIGKILL') } catch {} }
    await rm(temporary, { recursive: true, force: true })
  }
})

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
    assert.match(formatDevelopmentReport(failed), /delayed fixture startup failed/u)
    await assert.rejects(stat(callMarker), { code: 'ENOENT' })

    // Older Web launchers expose no appReady service. Verification above uses
    // completed CLI evaluation; Web startup has a separate native readiness path.
    if (knowledge.installed?.version === '0.1.1-rc.2') return
    // Failure reporting cannot wait for unrelated rollback. This sibling takes
    // longer to dispose than dev's readiness deadline; the original activation
    // error must reach the parent before cleanup is forcibly bounded there.
    const slowCleanup = join(temporary, 'slow-cleanup.mjs')
    const cleanupMarker = join(temporary, 'slow-cleanup-mounted.json')
    await writeFile(slowCleanup, `
import { writeFile } from 'node:fs/promises'
export const name = 'slow-startup-cleanup'
export async function apply(ctx) {
  ctx.effect(() => async () => {
    await new Promise(resolve => setTimeout(resolve, 45_000))
  }, 'slow sibling cleanup')
  await writeFile(${JSON.stringify(cleanupMarker)}, JSON.stringify({ mounted: true }))
}
`)
    await writeFile(patchPath, patch + '    failStartup: true\n- insert:\n    - id: slow-startup-cleanup\n      name: '
      + JSON.stringify(pathToFileURL(slowCleanup).href) + '\n')
    let announced = false
    await assert.rejects(runDevelopmentServer(archive, { dshPath, patchPath, online: true, signal: controller.signal,
      onReady() { announced = true; controller.abort() },
    }), error => {
      assert.match(error.message, /delayed fixture startup failed/u, JSON.stringify({
        code: error.code, message: error.message, ...error.details,
      }))
      return true
    })
    assert.equal(announced, false)
    assert.deepEqual(JSON.parse(await readFile(cleanupMarker, 'utf8')), { mounted: true })
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

    // A complete failed comparison intentionally exits 1; the selected overlay
    // loaded successfully and must not be blamed for the test verdict.
    await writeFile(fixtureCases, JSON.stringify([{ tool: 'overlay_value', arguments: {}, expected: 'wrong expectation' }]))
    const comparison = await invoke()
    assert.equal(comparison.exitCode, 1)
    const comparisonReport = JSON.parse(comparison.stdout)
    assert.equal(comparisonReport.ok, false)
    assert.equal(comparisonReport.cases.length, 1)
    assert.equal(comparisonReport.cases[0].passed, false)
    assert.equal(comparisonReport.cases[0].value, 'documented override')
    assert.equal(comparisonReport.diagnostic.code, 'DEVELOPMENT_CASES_FAILED')
    assert.equal(comparisonReport.diagnostic.exitCode, 1)
    assert.equal(comparisonReport.diagnostic.failedCases, 1)
    assert.match(comparisonReport.diagnostic.message, /verification completed; 1 of 1 cases failed/u)
    assert.doesNotMatch(comparisonReport.diagnostic.message, /boot|overlay|startup/u)
    await rm(observationPath)

    // Even a complete failed-case receipt cannot explain an unexpected exit.
    await writeFile(patchPath, '- id: overlay-fixture\n  config:\n    value: documented override\n    exitCodeOnShutdown: 23\n')
    const unexpectedExit = await invoke()
    assert.equal(unexpectedExit.exitCode, 1)
    const unexpectedReport = JSON.parse(unexpectedExit.stdout)
    assert.equal(unexpectedReport.ok, false)
    assert.equal(unexpectedReport.cases.length, 1)
    assert.equal(unexpectedReport.cases[0].passed, false)
    assert.equal(unexpectedReport.diagnostic.code, 'COMMAND_EXITED')
    assert.equal(unexpectedReport.diagnostic.exitCode, 23)

    // Cordis dump-config can compose this, but actual boot must reject the duplicate id.
    await writeFile(patchPath, '- insert:\n    - id: overlay-fixture\n      name: dsh-development-overlay-fixture\n')
    const duplicate = await invoke()
    assert.equal(duplicate.exitCode, 1)
    const failed = JSON.parse(duplicate.stdout)
    assert.equal(failed.ok, false)
    assert.equal(failed.cleanup, 'disposable profile removed')
    assert.equal(failed.diagnostic.code, 'COMMAND_EXITED')
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
    assert.equal(JSON.parse(malformed.stderr).code, 'COMMAND_EXITED')
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
    const entry = { name: 'structured output', tool: 'overlay_value', arguments: {}, expected }
    await writeFile(fixtureCases, JSON.stringify([entry]))
    const options = { dshPath, casesPath: fixtureCases, patchPath, online: true }
    const unlimited = await verifyDevelopmentPlugin(archive, options)
    assert.equal(unlimited.ok, true, JSON.stringify(unlimited))
    const observed = unlimited.cases[0]
    assert.equal(observed.name, 'structured output')
    assert.equal(observed.index, 1)
    assert.deepEqual(observed.failures, [])
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
    assert.deepEqual(limited.cases[0].failures, ['result-budget-exceeded'])

    await writeFile(fixtureCases, JSON.stringify(Array.from({ length: 32 }, () => ({ ...entry, expected: 'wrong' }))))
    const many = await verifyDevelopmentPlugin(archive, options)
    assert.equal(many.ok, false)
    assert.equal(many.cases.length, 32)
    assert(many.cases.every(item => item.passed === false && item.valueOmitted && item.contentOmitted))
    assert(many.cases.every((item, index) => item.index === index + 1 && item.expected === 'wrong'
      && item.failures.length === 1 && item.failures[0] === 'value-mismatch'))
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
        assert.equal(value.workspace.path, join(value.home, 'workspace'))
        assert.deepEqual(await readdir(value.workspace.path), [], 'archive workspace must not expose profile data or the package store')
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

test('native Host hot reload disposes and reapplies edited source in the same Web process', { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-native-hmr-'))
  const source = join(temporary, 'plugin # & source'), marker = join(temporary, 'lifecycle.jsonl')
  const controller = new AbortController()
  let ready
  const reloads = []
  const records = async () => (await readFile(marker, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const until = async predicate => {
    const deadline = Date.now() + 10_000
    while (!await predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert(await predicate(), 'expected native reload observation before deadline')
  }
  try {
    await mkdir(source)
    // Exercise both the source and the native pnpm store argument on Windows.
    // os.tmpdir checks TEMP before TMP; keep this test's homes under its fixture.
    if (process.platform === 'win32') {
      const temporaryHomes = join(temporary, 'temporary # & profiles')
      await mkdir(temporaryHomes)
      const previous = process.env.TEMP
      process.env.TEMP = temporaryHomes
      t.after(() => { if (previous === undefined) delete process.env.TEMP; else process.env.TEMP = previous })
    }
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'dsh-native-hmr-fixture', version: '1.0.0',
      type: 'module', main: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(source, 'cordis.patch.yml'), '- insert:\n    - id: native-hmr-fixture\n      name: dsh-native-hmr-fixture\n')
    await writeFile(join(source, 'value.js'), 'export const version = 1\n')
    await writeFile(join(source, 'index.js'), `
      import { appendFileSync } from 'node:fs'
      import { version } from './value.js'
      export const name = 'native-hmr-fixture'
      export function apply(ctx) {
        const record = event => appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ event, version, pid: process.pid }) + '\\n')
        record('apply')
        if (version === 4) throw new Error('fixture reload activation failed')
        ctx.effect(() => () => record('dispose'))
      }
    `)
    const report = await runDevelopmentServer(source, { dshPath, watch: true, signal: controller.signal,
      onReload: observation => reloads.push(observation),
      onReady: async value => {
        ready = value
        assert.deepEqual(value.reload, { mode: 'native-host-hmr', root: await realpath(source) })
        // Readiness covers native activation, not the filesystem watcher's initial scan.
        await new Promise(resolve => setTimeout(resolve, 500))
        await writeFile(join(source, 'value.js'), 'export const version = 2\n')
        await until(async () => (await records()).some(item => item.event === 'apply' && item.version === 2))
        assert.deepEqual(await records(), [
          { event: 'apply', version: 1, pid: value.pid },
          { event: 'dispose', version: 1, pid: value.pid },
          { event: 'apply', version: 2, pid: value.pid },
        ])
        await until(() => reloads.at(-1)?.status === 'settled')
        await writeFile(join(source, 'value.js'), 'export const version = ;\n')
        await until(() => reloads.at(-1)?.status === 'warning')
        assert(reloads.at(-1).warnings > 0)
        assert.equal((await records()).at(-1).version, 2, 'syntax failure retains the previous plugin')
        await writeFile(join(source, 'value.js'), 'export const version = 3\n')
        await until(async () => (await records()).at(-1)?.version === 3 && reloads.at(-1)?.status === 'settled')
        const warningsBeforeActivationFailure = reloads.at(-1).warnings
        await writeFile(join(source, 'value.js'), 'export const version = 4\n')
        await until(async () => {
          const observation = reloads.at(-1)
          if (observation?.status === 'failed' && observation.inactive > 0) return true
          // Current DSH HMR rolls a failed activation back to the previous
          // plugin. Prove restoration as well as the warning; a merely active
          // composition does not prove the failed edit was rolled back.
          const last = (await records()).at(-1)
          return observation?.status === 'warning' && observation.inactive === 0
            && observation.warnings > warningsBeforeActivationFailure
            && last?.event === 'apply' && last.version === 3
        })
        await writeFile(join(source, 'value.js'), 'export const version = 5\n')
        await until(async () => (await records()).at(-1)?.version === 5 && reloads.at(-1)?.status === 'settled')
        assert.equal(reloads.at(-1).inactive, 0)
        assert(reloads.at(-1).warnings > 0, 'recovery retains the warning history')
        controller.abort()
      },
    })
    assert.equal(report.stopped, true)
    // Cancellation owns process termination, not successful execution of every
    // native disposer: Windows uses taskkill and POSIX has a bounded grace.
    // Reload disposal is asserted above while the process is still running.
    await assert.rejects(stat(ready.home), { code: 'ENOENT' })
    assert.throws(() => process.kill(ready.pid, 0), { code: 'ESRCH' })
  } finally { controller.abort(); await rm(temporary, { recursive: true, force: true }) }
})

test('Web preview selects a sample workspace independently of source or archive installation', { timeout: 60_000 }, async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dsh-preview-workspace-')))
  try {
    const { source, archive } = await createOverlayFixture(temporary)
    const workspace = join(temporary, 'sample 工作 project')
    await mkdir(workspace)
    await writeFile(join(workspace, 'workspace.txt'), 'preview workspace\n')
    const marker = join(temporary, 'workspace-observation.json'), patchPath = join(temporary, 'workspace.patch.yml')
    await writeFile(patchPath, '- id: overlay-fixture\n  config:\n    webWorkspaceMarker: ' + JSON.stringify(marker) + '\n')
    for (const selection of [source, archive]) {
      await rm(marker, { force: true })
      await rm(marker + '.start', { force: true })
      const controller = new AbortController()
      let ready
      const report = await runDevelopmentServer(selection, { dshPath, patchPath, workspacePath: workspace,
        online: true, signal: controller.signal, onReady: async value => {
          ready = value
          assert.equal(value.workspace.path, workspace)
          await writeFile(marker + '.start', 'ready')
          assert.equal(value.source, await realpath(selection))
          const deadline = Date.now() + 10_000
          let observed
          while (!observed && Date.now() < deadline) {
            try { observed = JSON.parse(await readFile(marker, 'utf8')) } catch {}
            if (!observed) await new Promise(resolve => setTimeout(resolve, 50))
          }
          assert(observed, 'the native Web session must finish its workspace read')
          assert(['session-controller', 'legacy-api-proxy'].includes(observed.api))
          assert.deepEqual(observed, { api: observed.api, cwd: workspace, processCwd: workspace, workspaces: [workspace],
            isError: false, line: 'preview workspace' })
          controller.abort()
        },
      })
      assert.equal(report.stopped, true)
      await assert.rejects(stat(ready.home), { code: 'ENOENT' })
      assert.equal(await readFile(join(workspace, 'workspace.txt'), 'utf8'), 'preview workspace\n')
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
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
