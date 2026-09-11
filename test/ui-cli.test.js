import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import {
  formatUiCliReport,
  parseUiCliInput,
  resolveUiCliConfiguration,
  UiCliController,
  uiCliConfigurationRequested,
  uiCliSessionIdentity,
} from '../lib/ui-cli-internal.js'
import { createUiCliController } from '../lib/ui-cli.js'
import { createUiCliToolDefinition, hasUiCliTool } from '../lib/ui-cli-tool.js'
import { findSecrets } from '../lib/security.js'
import { DshDeveloperError } from '../lib/errors.js'

test('keeps the safe UI action vocabulary closed and credential-free', () => {
  const home = '/private/var/folders/ab/ExampleOsGeneratedDirectoryWith123/T/dsh-developer-dev-AbCd12'
  assert.deepEqual(parseUiCliInput({ operation: 'open', developmentServer: home }), { operation: 'open', developmentServer: home })
  for (const value of [
    { operation: 'open' },
    { operation: 'open', url: 'about:blank', developmentServer: home },
    { operation: 'navigate', developmentServer: home },
    { operation: 'open', developmentServer: 'relative' },
  ]) assert.throws(() => parseUiCliInput(value), { code: 'UI_INPUT_INVALID' })
  assert.deepEqual(parseUiCliInput({
    operation: 'fill',
    target: 'e12',
    text: 'hello',
  }), {
    operation: 'fill',
    target: 'e12',
    text: 'hello',
  })
  assert.deepEqual(parseUiCliInput({
    operation: 'resize',
    width: 390,
    height: 844,
  }), {
    operation: 'resize',
    width: 390,
    height: 844,
  })
  assert.throws(
    () => parseUiCliInput({ operation: 'navigate', url: 'https://example.com' }),
    (error) => error.code === 'UI_INPUT_INVALID' && /loopback/u.test(error.message),
  )
  assert.throws(
    () => parseUiCliInput({ operation: 'click', target: 'button.primary' }),
    (error) => error.code === 'UI_INPUT_INVALID' && /exact element ref/u.test(error.message),
  )
  assert.throws(
    () => parseUiCliInput({
      operation: 'fill',
      target: 'e1',
      text: ['pass', 'word', '=', 'fixture', 'value', '123456'].join(''),
    }),
    (error) => error.code === 'SECRET_DETECTED',
  )
  assert.throws(
    () => parseUiCliInput({ operation: 'open', url: 'about:blank', headed: true }),
    (error) => error.code === 'UI_INPUT_INVALID' && /does not accept headed/u.test(error.message),
  )
})

test('find and log results reach the rendered tool content', () => {
  const rendered = formatUiCliReport({ operation: 'find', session: { digest: 'sha256:' + 'a'.repeat(64) },
    evidenceDigest: 'sha256:' + 'b'.repeat(64), result: { provider: { result: 'Found 1 match: button Continue [ref=e15]' } } })
  assert.match(rendered, /UNTRUSTED PAGE DATA\nFound 1 match: button Continue \[ref=e15\]/u)
})

test('derives stable opaque browser ownership from the caller session', () => {
  const first = uiCliSessionIdentity('session-a')
  const second = uiCliSessionIdentity('session-a')
  const other = uiCliSessionIdentity('session-b')
  assert.deepEqual(first, second)
  assert.notEqual(first.internal, other.internal)
  assert.match(first.internal, /^dshdev-[a-f0-9]{24}$/u)
  assert.match(first.digest, /^sha256:[a-f0-9]{64}$/u)
  assert.equal(JSON.stringify(first).includes('session-a'), false)
})

test('pins the configured upstream CLI package before returning a runtime configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-ui-config-'))
  const packageRoot = join(root, 'node_modules', '@playwright', 'cli')
  const evidenceRoot = join(root, 'runtime')
  const entry = join(packageRoot, 'playwright-cli.js')
  const browser = join(root, 'chrome.exe')
  try {
    await mkdir(packageRoot, { recursive: true })
    await writeFile(entry, '', 'utf8')
    await writeFile(browser, '', 'utf8')
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@playwright/cli',
      version: '0.1.18',
    }), 'utf8')
    const configuration = await resolveUiCliConfiguration({
      DSH_DEVELOPER_PLAYWRIGHT_CLI_ENTRY: entry,
      DSH_DEVELOPER_BROWSER_EXECUTABLE: browser,
      DSH_DEVELOPER_UI_CLI_ROOT: evidenceRoot,
    })
    assert.equal(configuration.provider, '@playwright/cli')
    assert.equal(configuration.providerVersion, '0.1.18')
    assert.match(configuration.evidenceDigest, /^sha256:[a-f0-9]{64}$/u)

    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@playwright/cli',
      version: '0.1.19',
    }), 'utf8')
    await assert.rejects(
      resolveUiCliConfiguration({
        DSH_DEVELOPER_PLAYWRIGHT_CLI_ENTRY: entry,
        DSH_DEVELOPER_BROWSER_EXECUTABLE: browser,
        DSH_DEVELOPER_UI_CLI_ROOT: evidenceRoot,
      }),
      (error) => error.code === 'UI_CLI_VERSION_MISMATCH',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('treats every UI environment field as configuration and rejects partial setup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ui-absent-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const absent = { DSH_DEVELOPER_UI_CONFIG: join(root, 'absent.json') }
  await assert.rejects(resolveUiCliConfiguration(absent), { code: 'UI_CLI_NOT_CONFIGURED' })
  const partial = { ...absent, DSH_DEVELOPER_UI_CLI_ROOT: join(root, 'runtime') }
  assert.equal(uiCliConfigurationRequested(partial), true)
  await assert.rejects(
    resolveUiCliConfiguration(partial),
    (error) => error.code === 'UI_CLI_NOT_CONFIGURED',
  )
  await assert.rejects(
    createUiCliController({ runBounded: async () => {} }),
    (error) => error.code === 'UI_OPTIONS_INVALID',
  )
})

test('maps safe actions to argv-only Playwright CLI calls with bounded artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-ui-controller-'))
  const evidenceRoot = join(root, 'evidence')
  await mkdir(evidenceRoot)
  const calls = []
  let open = false
  let internalSession
  const runner = async (command, args, options) => {
    calls.push({ command, args, options })
    const hasSession = args[1]?.startsWith('-s=')
    const operation = args[hasSession ? 2 : 1]
    if (hasSession) internalSession = args[1].slice(3)
    if (operation === 'list') {
      return {
        stdout: JSON.stringify({
          browsers: open ? [{
            name: internalSession,
            status: 'open',
            browserType: 'chrome',
            headed: false,
            persistent: false,
            attached: false,
            compatible: true,
            version: 'test-browser',
          }] : [],
        }),
        stderr: '',
        exitCode: 0,
      }
    }
    const outputDir = options.env.PLAYWRIGHT_MCP_OUTPUT_DIR
    if (operation === 'open') {
      open = true
      const filename = 'page-2026-09-11T00-24-44-895Z.yml'
      // Playwright uses path.relative(), including native Windows separators.
      const artifactPath = relative(root, join(outputDir, filename))
      assert.deepEqual(findSecrets(artifactPath.replaceAll('\\', '/')), ['high-entropy-token'])
      await writeFile(join(outputDir, filename), '- heading "UI" [ref=e1]\n', 'utf8')
      return {
        stdout: JSON.stringify({
          session: internalSession,
          pid: 99,
          result: { snapshot: { file: artifactPath } },
        }),
        stderr: '',
        exitCode: 0,
      }
    }
    if (operation === 'snapshot') {
      return {
        stdout: JSON.stringify({ snapshot: ['- textbox "Name" [ref=e2]'] }),
        stderr: '',
        exitCode: 0,
      }
    }
    if (operation === 'find') {
      return {
        stdout: JSON.stringify({ result: 'Found 1 match for "Ready":\n\n- status: Ready' }),
        stderr: '',
        exitCode: 0,
      }
    }
    if (operation === 'screenshot') {
      const filename = 'page-2026-09-11T00-24-44-895Z.png'
      await writeFile(join(outputDir, filename), Buffer.from([137, 80, 78, 71]))
      return {
        stdout: JSON.stringify({
          result: '- [Screenshot of viewport](' + relative(root, join(outputDir, filename)) + ')',
        }),
        stderr: '',
        exitCode: 0,
      }
    }
    if (operation === 'close') {
      open = false
      return { stdout: JSON.stringify({ session: internalSession, status: 'closed' }), stderr: '', exitCode: 0 }
    }
    throw new Error('Unexpected operation: ' + operation)
  }
  const controller = new UiCliController({
    entry: 'C:\\provider\\playwright-cli.js',
    browser: 'C:\\browser\\chrome.exe',
    root,
    evidenceRoot,
    provider: '@playwright/cli',
    providerVersion: '0.1.18',
    evidenceDigest: 'sha256:' + 'a'.repeat(64),
  }, { runBounded: runner })
  try {
    const opened = await controller.execute('agent-session', {
      operation: 'open',
      url: 'http://127.0.0.1:4173/',
    })
    assert.equal(opened.ok, true)
    assert.equal(opened.result.artifacts.length, 1)
    assert.equal(opened.result.provider.pid, undefined)
    assert.equal(opened.result.provider.session, undefined)

    const snapshot = await controller.execute('agent-session', { operation: 'snapshot', depth: 4 })
    assert.deepEqual(JSON.parse(snapshot.result.pageData.content), ['- textbox "Name" [ref=e2]'])
    assert.equal(snapshot.result.artifacts.length, 0)
    assert.equal(snapshot.result.provider.snapshot, undefined)
    assert.equal(snapshot.result.storage.maximumBytes, 8 * 1024 * 1024)

    const waited = await controller.execute('agent-session', {
      operation: 'wait',
      text: 'Ready',
      timeoutMs: 500,
    })
    assert.equal(waited.result.wait.matched, true)
    assert.equal(waited.result.wait.attempts, 1)

    const screenshot = await controller.execute('agent-session', { operation: 'screenshot' })
    assert.equal(screenshot.result.artifacts.length, 1)
    assert.equal(screenshot.result.artifacts[0].kind, 'png')

    const closed = await controller.execute('agent-session', { operation: 'close' })
    assert.equal(closed.result.provider.status, 'closed')
    assert.ok(calls.every((call) => call.command === process.execPath))
    assert.ok(calls.every((call) => call.options.env.DEEPSEEK_API_KEY === undefined))
    assert.ok(calls.every((call) => call.options.env.PLAYWRIGHT_MCP_PROXY_SERVER === 'http://127.0.0.1:9'))
    assert.ok(calls.some((call) => call.args.includes('--depth=4')))
    assert.ok(calls.every((call) => call.args.includes('--json')))
  } finally {
    await controller.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('verified artifact paths do not hide credentials or allow evidence-directory escapes', async t => {
  const secret = ['sk-', '0123456789abcdef0123456789abcdef'].join('')
  for (const [kind, expected] of [['provider-content', 'SECRET_DETECTED'], ['snapshot-content', 'SECRET_DETECTED'],
    ['filename', 'SECRET_DETECTED'], ['directory-name', 'SECRET_DETECTED'], ['outside-directory', 'UI_ARTIFACT_INVALID'],
    ['normalized-away-secret', 'UI_ARTIFACT_INVALID'], ['screenshot-normalized-away-secret', 'UI_ARTIFACT_INVALID']]) {
    await t.test(kind, async t => {
      const temporary = await mkdtemp(join(tmpdir(), 'dsh-ui-artifact-boundary-'))
      t.after(() => rm(temporary, { recursive: true, force: true }))
      const root = kind === 'directory-name' ? join(temporary, secret) : temporary
      const evidenceRoot = join(root, 'evidence')
      await mkdir(evidenceRoot, { recursive: true })
      let closed = false
      const controller = new UiCliController({ entry: '/unused/playwright-cli.js', browser: '/unused/browser',
        root, evidenceRoot, provider: '@playwright/cli', providerVersion: '0.1.18' }, {
        runBounded: async (_command, args, options) => {
          const action = args[2]
          if (action === 'close') {
            closed = true
            return { stdout: '{"status":"closed"}', stderr: '', exitCode: 0 }
          }
          const filename = kind === 'filename' ? secret + '.yml' : 'page-2026-09-11T00-24-44-895Z.yml'
          const file = join(options.env.PLAYWRIGHT_MCP_OUTPUT_DIR, filename)
          await writeFile(file, kind === 'snapshot-content' ? secret : '- heading "Safe"\n')
          const reference = kind.includes('normalized-away')
            ? relative(root, options.env.PLAYWRIGHT_MCP_OUTPUT_DIR) + '/' + secret + '/../' + filename
            : kind === 'outside-directory' ? '../outside.yml' : relative(root, file)
          const result = kind.startsWith('screenshot') ? { result: '- [Screenshot of viewport](' + reference + ')' }
            : { snapshot: { file: reference }, ...(kind === 'provider-content' ? { note: secret } : {}) }
          return { stdout: JSON.stringify(result), stderr: '', exitCode: 0 }
        },
      })
      try {
        await assert.rejects(controller.execute('native-ui-integration-agent', {
          operation: kind.startsWith('screenshot') ? 'screenshot' : 'snapshot',
        }), { code: expected })
        assert.equal(closed, true, 'a rejected result closes its browser session')
      } finally { await controller.dispose() }
    })
  }
})

test('binds the native UI tool to the calling DSH agent identity', async () => {
  const calls = []
  const definition = createUiCliToolDefinition({
    disposeOwner() {},
    async execute(sessionId, args, options) {
      calls.push({ sessionId, args, options })
      return {
        kind: 'ui-cli-action',
        version: 1,
        ok: true,
        operation: args.operation,
        session: { digest: 'sha256:' + 'b'.repeat(64) },
        route: {},
        authority: {},
        result: { provider: { status: 'closed' } },
        evidenceDigest: 'sha256:' + 'c'.repeat(64),
      }
    },
  })
  const signal = new AbortController().signal
  const scopedTools = { get: () => definition }
  assert.equal(hasUiCliTool(scopedTools), true)
  assert.equal(hasUiCliTool({ tools: scopedTools }), true)
  await assert.rejects(
    definition.execute({ operation: 'status' }, { signal }),
    (error) => error.code === 'UI_AGENT_REQUIRED',
  )
  const report = await definition.execute(
    { operation: 'status' },
    { signal, agent: { id: 'agent-7', ctx: { effect() {} } } },
  )
  assert.equal(report.ok, true)
  assert.equal(calls[0].sessionId, 'agent-7')
  assert.equal(calls[0].options.signal, signal)
  assert.equal(definition.isConcurrencySafe(), true)
  assert.ok(JSON.stringify(definition.parameters).length < 3_000)
})

async function ownerHarness(t, beforeCommand = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ui-owner-'))
  const evidenceRoot = join(root, 'evidence')
  await mkdir(evidenceRoot)
  const open = new Set(), calls = []
  const controller = new UiCliController({ root, evidenceRoot, entry: '/fixture/playwright-cli.js',
    browser: '/fixture/browser', provider: '@playwright/cli', providerVersion: '0.1.18', evidenceDigest: 'fixture',
  }, { runBounded: async (_command, args, options) => {
    const session = args[1].startsWith('-s=') ? args[1].slice(3) : undefined
    const operation = args[session ? 2 : 1]
    calls.push({ session, operation, signal: options.signal, timeoutMs: options.timeoutMs })
    await beforeCommand({ session, operation, signal: options.signal })
    if (operation === 'list') return { stdout: JSON.stringify({ browsers: [...open].map(name => ({ name, status: 'open' })) }) }
    if (operation === 'open') open.add(session)
    if (operation === 'close') open.delete(session)
    return { stdout: JSON.stringify({ result: 'Found 1 match for Ready' }) }
  } })
  t.after(async () => {
    try { await controller.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  return { controller, tool: createUiCliToolDefinition(controller), open, calls }
}

function fixtureOwner(id) {
  const effects = []
  let ended = false
  const agent = { id, ctx: { effect(factory) {
    assert.equal(ended, false, 'cannot attach to a disposed scope')
    effects.push(factory())
  } } }
  return { agent, async dispose() {
    ended = true
    await Promise.all(effects.splice(0).map(dispose => dispose()))
  } }
}

// Also run against the installed native Context: Agent.ctx uses this awaited
// Cordis scope teardown. This gate needs no model, DSH profile, or real browser.
for (const native of [false, true]) test(`Agent UI cleanup aborts, drains and isolates owners (${native ? 'native Cordis' : 'fixture'})`, {
  skip: native && process.env.DSH_DEVELOPER_UI_OWNER_TEST !== '1', timeout: 5_000,
}, async t => {
  let makeOwner = async id => fixtureOwner(id)
  if (native) {
    assert.ok(process.env.DSH_DEVELOPER_DSH_MODULES, 'select the exact installed DSH node_modules')
    const { Context } = await import(pathToFileURL(join(process.env.DSH_DEVELOPER_DSH_MODULES,
      '@deepseek-ai', 'cordis', 'lib', 'index.js')).href)
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    makeOwner = async id => {
      let agent
      const scope = ctx.plugin(scoped => { agent = { id, ctx: scoped } })
      await scope
      return { agent, dispose: () => scope.dispose() }
    }
  }
  const started = Promise.withResolvers(), aborted = Promise.withResolvers(), drain = Promise.withResolvers()
  const first = await makeOwner('first-owner'), second = await makeOwner('second-owner')
  const firstSession = uiCliSessionIdentity(first.agent.id).internal
  const f = await ownerHarness(t, async ({ session, operation, signal }) => {
    if (session !== firstSession || operation !== 'click') return
    started.resolve()
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    await drain.promise
    assert.equal(signal.aborted, true)
    throw new DshDeveloperError('CANCELLED', 'fixture provider drained')
  })
  const execute = (owner, input) => f.tool.execute(input, { agent: owner.agent })
  await execute(first, { operation: 'open', url: 'about:blank' })
  await execute(second, { operation: 'open', url: 'about:blank' })
  const active = assert.rejects(execute(first, { operation: 'click', target: 'e1' }), { code: 'CANCELLED' })
  await started.promise
  const queued = assert.rejects(execute(first, { operation: 'fill', target: 'e2', text: 'queued' }), { code: 'CANCELLED' })
  let disposed = false
  const disposal = first.dispose().then(() => { disposed = true })
  await aborted.promise
  assert.equal(disposed, false, 'native scope must await provider drain and close')
  assert.equal(f.calls.filter(call => call.operation === 'close').length, 0)
  assert.equal((await execute(second, { operation: 'find', text: 'Ready' })).ok, true)
  await assert.rejects(execute(first, { operation: 'open', url: 'about:blank' }), { code: 'UI_OWNER_DISPOSED' })
  drain.resolve()
  await Promise.all([active, queued, disposal])
  assert.equal(f.calls.some(call => call.operation === 'fill'), false, 'queued calls must not reach the provider')
  const close = f.calls.find(call => call.operation === 'close')
  assert.equal(close.session, firstSession)
  assert.equal(close.signal.aborted, false, 'cleanup needs its own live signal')
  assert.equal(close.timeoutMs, 5_000)
  assert.deepEqual([...f.open], [uiCliSessionIdentity(second.agent.id).internal])
  assert.equal((await execute(second, { operation: 'find', text: 'Ready' })).ok, true)
  // DSH may resume the same durable session with a different live Agent object.
  const resumed = await makeOwner('first-owner')
  assert.equal((await execute(resumed, { operation: 'open', url: 'about:blank' })).ok, true)
  await assert.rejects(execute(first, { operation: 'find', text: 'Ready' }), { code: 'UI_OWNER_DISPOSED' })
  await resumed.dispose()
  await second.dispose()
  assert.equal(f.open.size, 0)
})

test('plugin disposal aborts every owner before waiting and is joinable', { timeout: 5_000 }, async t => {
  const started = new Map(['one', 'two'].map(id => [uiCliSessionIdentity(id).internal, Promise.withResolvers()]))
  const aborted = new Set(), drain = Promise.withResolvers()
  const f = await ownerHarness(t, async ({ session, operation, signal }) => {
    if (operation !== 'click') return
    started.get(session).resolve()
    signal.addEventListener('abort', () => aborted.add(session), { once: true })
    await drain.promise
    throw new DshDeveloperError('CANCELLED', 'fixture drained')
  })
  for (const id of ['one', 'two']) await f.controller.execute(id, { operation: 'open', url: 'about:blank' })
  const pending = ['one', 'two'].map(id => assert.rejects(f.controller.execute(id,
    { operation: 'click', target: 'e1' }), { code: 'CANCELLED' }))
  await Promise.all([...started.values()].map(value => value.promise))
  const disposal = f.controller.dispose()
  assert.equal(f.controller.dispose(), disposal)
  assert.equal(aborted.size, 2)
  await assert.rejects(f.controller.execute('three', { operation: 'open', url: 'about:blank' }), { code: 'UI_CONTROLLER_DISPOSED' })
  drain.resolve()
  await Promise.all([...pending, disposal])
  assert.equal(f.open.size, 0)
})

test('caller cancellation skips queued work without ending the Agent browser', async t => {
  const f = await ownerHarness(t)
  await f.controller.execute('caller', { operation: 'open', url: 'about:blank' })
  await assert.rejects(f.controller.execute('caller', { operation: 'click', target: 'e1' },
    { signal: AbortSignal.abort() }), { code: 'CANCELLED' })
  assert.equal(f.calls.some(call => call.operation === 'click'), false)
  assert.equal((await f.controller.execute('caller', { operation: 'find', text: 'Ready' })).ok, true)
  assert.equal(f.open.size, 1)
})

test('owner disposal during open retains ownership when the first cleanup fails', { timeout: 5_000 }, async t => {
  const started = Promise.withResolvers(), aborted = Promise.withResolvers(), drain = Promise.withResolvers()
  let closes = 0
  const f = await ownerHarness(t, async ({ session, operation, signal }) => {
    if (operation === 'open') {
      f.open.add(session) // Browser exists before the provider returns its receipt.
      started.resolve()
      signal.addEventListener('abort', () => aborted.resolve(), { once: true })
      await drain.promise
      throw new DshDeveloperError('CANCELLED', 'opening provider drained')
    }
    if (operation === 'close') {
      assert.equal(signal.aborted, false)
      if (++closes === 1) throw new Error('first close failed')
    }
  })
  const owner = fixtureOwner('opening-owner')
  const opening = assert.rejects(f.tool.execute({ operation: 'open', url: 'about:blank' },
    { agent: owner.agent }), { code: 'CANCELLED' })
  await started.promise
  const disposing = owner.dispose()
  await aborted.promise
  assert.equal(closes, 0, 'do not close concurrently with opening provider')
  drain.resolve()
  await Promise.all([opening, disposing])
  assert.equal(closes, 2, 'disposal must retry the failed launch cleanup')
  assert.equal(f.open.size, 0)
})

for (const plugin of [false, true]) test(`${plugin ? 'plugin' : 'owner'} cleanup failure retains the browser and permits an explicit retry`, async t => {
  let failClose = true
  const rejectedSession = uiCliSessionIdentity('close-failure').internal
  const failure = new Error('fixture close failed')
  const f = await ownerHarness(t, async ({ session, operation }) => {
    if (session === rejectedSession && operation === 'close' && failClose) throw failure
  })
  for (const id of ['close-failure', 'unaffected']) await f.controller.execute(id, { operation: 'open', url: 'about:blank' })
  const dispose = () => plugin ? f.controller.dispose() : f.controller.disposeOwner('close-failure')
  const first = dispose()
  assert.equal(dispose(), first, 'concurrent cleanup joins the same attempt')
  await assert.rejects(first, error => plugin
    ? error instanceof AggregateError && error.errors[0] === failure : error === failure)
  assert.equal(f.open.has(rejectedSession), true, 'a failed close did not establish that the browser ended')
  await assert.rejects(f.controller.execute('close-failure', { operation: 'find', text: 'Ready' }),
    { code: plugin ? 'UI_CONTROLLER_DISPOSED' : 'UI_OWNER_DISPOSED' })
  if (!plugin) assert.equal((await f.controller.execute('unaffected', { operation: 'find', text: 'Ready' })).ok, true)
  else assert.deepEqual([...f.open], [rejectedSession], 'plugin cleanup still closed the other owner')
  failClose = false
  const retry = dispose()
  assert.notEqual(retry, first)
  await retry
  assert.equal(f.calls.filter(call => call.session === rejectedSession && call.operation === 'close').length, 2)
  assert.equal(f.open.has(rejectedSession), false)
})

test('diagnostic logs redact possible credentials without discarding the browser or useful lines', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ui-logs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const evidenceRoot = join(root, 'evidence')
  await mkdir(evidenceRoot)
  const secret = 'sk-' + 'aB7Cd9Ef'.repeat(4)
  let closes = 0
  const controller = new UiCliController({ root, evidenceRoot, entry: '/provider/playwright-cli.js',
    browser: '/browser/chrome', provider: '@playwright/cli', providerVersion: '0.1.18', evidenceDigest: 'sha256:' + 'a'.repeat(64),
  }, { runBounded: async (_command, args) => {
    const operation = args[1] === 'list' ? 'list' : args[2]
    if (operation === 'list') return { stdout: JSON.stringify({ browsers: [] }) }
    if (operation === 'close') closes++
    if (operation === 'requests' || operation === 'console') return { stdout: JSON.stringify({ result:
      'Healthy local operation\nprivate value ' + secret + '\nOther useful diagnostic\n' }) }
    return { stdout: JSON.stringify({ result: 'Found 1 match: button Continue [ref=e15]' }) }
  } })
  t.after(() => controller.dispose())
  await controller.execute('log-witness', { operation: 'open', url: 'about:blank' })
  for (const operation of ['requests', 'console']) {
    const report = await controller.execute('log-witness', { operation })
    const content = formatUiCliReport(report)
    assert.equal(JSON.stringify(report).includes(secret), false)
    assert.match(content, /Healthy local operation/u)
    assert.match(content, /Other useful diagnostic/u)
    assert.match(content, /\[redacted: possible credential\]/u)
  }
  assert.equal(closes, 0)
  const found = await controller.execute('log-witness', { operation: 'find', text: 'Continue' })
  assert.match(formatUiCliReport(found), /\[ref=e15\]/u)
})
