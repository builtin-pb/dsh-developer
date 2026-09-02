import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import {
  parseUiCliInput,
  resolveUiCliConfiguration,
  UiCliController,
  uiCliConfigurationRequested,
  uiCliSessionIdentity,
} from '../lib/ui-cli-internal.js'
import { createUiCliController } from '../lib/ui-cli.js'
import { createUiCliToolDefinition, hasUiCliTool } from '../lib/ui-cli-tool.js'

test('keeps the safe UI action vocabulary closed and credential-free', () => {
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

test('treats every UI environment field as configuration and rejects partial setup', async () => {
  const partial = { DSH_DEVELOPER_UI_CLI_ROOT: 'C:\\ui-state' }
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
      await writeFile(join(outputDir, 'page-open.yml'), '- heading "UI" [ref=e1]\n', 'utf8')
      return {
        stdout: JSON.stringify({
          session: internalSession,
          pid: 99,
          result: { snapshot: { file: relative(root, join(outputDir, 'page-open.yml')) } },
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
      const filename = 'page-witness.png'
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

test('binds the native UI tool to the calling DSH agent identity', async () => {
  const calls = []
  const definition = createUiCliToolDefinition({
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
    { signal, agent: { id: 'agent-7' } },
  )
  assert.equal(report.ok, true)
  assert.equal(calls[0].sessionId, 'agent-7')
  assert.equal(calls[0].options.signal, signal)
  assert.equal(definition.isConcurrencySafe(), true)
  assert.ok(JSON.stringify(definition.parameters).length < 3_000)
})
