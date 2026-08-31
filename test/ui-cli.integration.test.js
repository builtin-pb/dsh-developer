import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerNativeTool } from '../lib/native-tool.js'
import { runBounded, secretFreeEnvironment } from '../lib/runtime.js'
import { registerUiCliTool } from '../lib/ui-cli-tool.js'

const enabled = process.env.DSH_DEVELOPER_UI_CLI_TEST === '1'

function moduleUrl(modules, packageName) {
  return pathToFileURL(join(modules, '@deepseek-ai', packageName, 'lib', 'index.js')).href
}

function pageServer() {
  return createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: 'https://example.com/' })
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(`<!doctype html>
      <html lang="en">
        <head><meta charset="utf-8"><title>DSH native UI witness</title></head>
        <body>
          <main>
            <h1>Low-context UI witness</h1>
            <label>Name <input aria-label="Name"></label>
            <button type="button">Verify</button>
            <p role="status">Waiting</p>
          </main>
          <script>
            document.querySelector('button').addEventListener('click', () => {
              const name = document.querySelector('input').value
              document.querySelector('[role=status]').textContent = 'Verified ' + name
            })
          </script>
        </body>
      </html>`)
  })
}

function valueOf(outcome) {
  assert.equal(outcome.isError, false, JSON.stringify(outcome))
  assert.equal(typeof outcome.value, 'object')
  return outcome.value
}

function elementRef(value, role, name) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = elementRef(item, role, name)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  if (value.role === role && value.name === name && typeof value.ref === 'string') return value.ref
  for (const item of Object.values(value)) {
    const found = elementRef(item, role, name)
    if (found !== undefined) return found
  }
  return undefined
}

test('drives one agent-owned browser through the exact compact DSH tool surface', {
  skip: !enabled,
}, async () => {
  const modules = resolve(process.env.DSH_DEVELOPER_DSH_MODULES ?? '')
  const entry = resolve(process.env.DSH_DEVELOPER_PLAYWRIGHT_CLI_ENTRY ?? '')
  const browser = resolve(process.env.DSH_DEVELOPER_BROWSER_EXECUTABLE ?? '')
  assert.notEqual(modules, resolve(''), 'DSH_DEVELOPER_DSH_MODULES must name the exact DSH module directory')
  assert.notEqual(entry, resolve(''), 'DSH_DEVELOPER_PLAYWRIGHT_CLI_ENTRY must name playwright-cli.js')
  assert.notEqual(browser, resolve(''), 'DSH_DEVELOPER_BROWSER_EXECUTABLE must name Chrome or Edge')

  const [{ Context }, systemPromptModule, toolsModule] = await Promise.all([
    import(moduleUrl(modules, 'cordis')),
    import(moduleUrl(modules, 'dsh-system-prompt')),
    import(moduleUrl(modules, 'dsh-tools')),
  ])
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-ui-cli-live-'))
  const previousRoot = process.env.DSH_DEVELOPER_UI_CLI_ROOT
  process.env.DSH_DEVELOPER_UI_CLI_ROOT = root
  const server = pageServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  const url = 'http://127.0.0.1:' + address.port + '/'
  const cliEntry = fileURLToPath(new URL('../bin/dsh-developer.js', import.meta.url))
  const cliEnvironment = secretFreeEnvironment({
    DSH_DEVELOPER_PLAYWRIGHT_CLI_ENTRY: entry,
    DSH_DEVELOPER_BROWSER_EXECUTABLE: browser,
    DSH_DEVELOPER_UI_CLI_ROOT: root,
  })
  const executeCli = async (...args) => {
    const result = await runBounded(process.execPath, [
      cliEntry,
      'ui',
      '--session', 'codex-ui-integration',
      ...args,
      '--json',
    ], {
      cwd: root,
      env: cliEnvironment,
      timeoutMs: 25_000,
      outputLimit: 128 * 1024,
      label: 'dsh-developer direct UI CLI integration',
    })
    return JSON.parse(result.stdout)
  }
  const ctx = new Context()
  const agent = { id: 'native-ui-integration-agent' }
  let directSessionOpen = false
  let call = 0
  const execute = (name, arguments_) => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: 'ui-cli-live-' + (++call),
    name,
    arguments: arguments_,
    agent,
  })
  try {
    await ctx.plugin(systemPromptModule.default)
    await ctx.plugin(toolsModule.default)
    registerNativeTool(ctx)
    await registerUiCliTool(ctx)

    const admission = valueOf(await execute('dsh_developer', { operation: 'ui' }))
    assert.equal(admission.report.ok, true)
    assert.equal(admission.report.selected.adapter, 'playwright-cli-native')
    assert.equal(admission.report.selected.namespace, 'native')
    assert.equal(admission.report.selected.catalogTools, 1)

    valueOf(await execute('dsh_ui', { operation: 'open', url }))
    const initial = valueOf(await execute('dsh_ui', { operation: 'snapshot', depth: 8 }))
    const content = initial.result.pageData.content
    assert.match(content, /Low-context UI witness/u)
    const snapshot = JSON.parse(content)
    const input = elementRef(snapshot, 'textbox', 'Name')
    const button = elementRef(snapshot, 'button', 'Verify')
    assert.notEqual(input, undefined, content)
    assert.notEqual(button, undefined, content)

    valueOf(await execute('dsh_ui', {
      operation: 'fill',
      target: input,
      text: 'DSH agent',
    }))
    valueOf(await execute('dsh_ui', { operation: 'click', target: button }))
    const found = valueOf(await execute('dsh_ui', {
      operation: 'find',
      text: 'Verified DSH agent',
    }))
    assert.match(found.result.provider.result, /^Found 1 match for /u)
    const waited = valueOf(await execute('dsh_ui', {
      operation: 'wait',
      text: 'Verified DSH agent',
      timeoutMs: 5_000,
    }))
    assert.equal(waited.result.wait.matched, true)
    valueOf(await execute('dsh_ui', { operation: 'console' }))
    valueOf(await execute('dsh_ui', { operation: 'requests' }))

    const screenshot = valueOf(await execute('dsh_ui', { operation: 'screenshot' }))
    assert.equal(screenshot.result.artifacts.length, 1)
    const screenshotInfo = await stat(screenshot.result.artifacts[0].path)
    assert.equal(screenshotInfo.isFile(), true)
    assert.ok(screenshotInfo.size > 0 && screenshotInfo.size <= 8 * 1024 * 1024)

    const redirected = await execute('dsh_ui', { operation: 'navigate', url: url + 'redirect' })
    assert.equal(redirected.isError, true, JSON.stringify(redirected))
    assert.match(JSON.stringify(redirected), /protected Playwright CLI goto exited unsuccessfully/u)
    valueOf(await execute('dsh_ui', { operation: 'navigate', url: 'about:blank' }))
    valueOf(await execute('dsh_ui', { operation: 'close' }))

    const directOpen = await executeCli('--action', 'open', '--url', url)
    directSessionOpen = true
    assert.equal(directOpen.operation, 'open')
    assert.equal(directOpen.route.modelToolSchemas, 1)
    const directSnapshot = await executeCli('--action', 'snapshot', '--depth', '6')
    const directTree = JSON.parse(directSnapshot.result.pageData.content)
    assert.notEqual(elementRef(directTree, 'button', 'Verify'), undefined)
    const directClose = await executeCli('--action', 'close')
    assert.equal(directClose.result.provider.status, 'closed')
    directSessionOpen = false
  } finally {
    if (directSessionOpen) await executeCli('--action', 'close').catch(() => {})
    await ctx.fiber.dispose()
    server.close()
    await once(server, 'close')
    if (previousRoot === undefined) delete process.env.DSH_DEVELOPER_UI_CLI_ROOT
    else process.env.DSH_DEVELOPER_UI_CLI_ROOT = previousRoot
    await rm(root, { recursive: true, force: true })
  }
})
