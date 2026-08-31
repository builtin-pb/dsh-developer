import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { registerNativeTool } from '../lib/native-tool.js'
import { registerUiSafetyGuard } from '../lib/ui-policy.js'

const enabled = process.env.DSH_DEVELOPER_UI_BROWSER_TEST === '1'

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
        <head><meta charset="utf-8"><title>DSH UI witness</title></head>
        <body>
          <main>
            <h1>Agent-native UI witness</h1>
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

function textOf(result) {
  assert.equal(result.isError, false, JSON.stringify(result))
  if (typeof result.value === 'string') return result.value
  if (Array.isArray(result.value?.content)) {
    return result.value.content
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
  }
  return JSON.stringify(result.value)
}

test('drives a real isolated browser through the exact DSH tool and guard pipeline', {
  skip: !enabled,
}, async () => {
  const modules = resolve(process.env.DSH_DEVELOPER_DSH_MODULES ?? '')
  const providerEntry = resolve(process.env.DSH_DEVELOPER_PLAYWRIGHT_MCP_ENTRY ?? '')
  const executablePath = resolve(process.env.DSH_DEVELOPER_BROWSER_EXECUTABLE ?? '')
  assert.notEqual(modules, resolve(''), 'DSH_DEVELOPER_DSH_MODULES must name the exact DSH module directory')
  assert.notEqual(providerEntry, resolve(''), 'DSH_DEVELOPER_PLAYWRIGHT_MCP_ENTRY must name cli.js')
  assert.notEqual(executablePath, resolve(''), 'DSH_DEVELOPER_BROWSER_EXECUTABLE must name Chrome or Edge')

  const [{ Context }, systemPromptModule, toolsModule, mcpClient] = await Promise.all([
    import(moduleUrl(modules, 'cordis')),
    import(moduleUrl(modules, 'dsh-system-prompt')),
    import(moduleUrl(modules, 'dsh-tools')),
    import(moduleUrl(modules, 'dsh-mcp-client')),
  ])
  const outputDir = await mkdtemp(join(tmpdir(), 'dsh-developer-ui-browser-'))
  const server = pageServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  const url = 'http://127.0.0.1:' + address.port + '/'
  const ctx = new Context()
  let call = 0
  const execute = (name, args = {}) => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: 'ui-browser-' + (++call),
    name: 'mcp__dsh_ui__' + name,
    arguments: args,
  })
  try {
    await ctx.plugin(systemPromptModule.default)
    await ctx.plugin(toolsModule.default)
    registerNativeTool(ctx)
    registerUiSafetyGuard(ctx)
    await mcpClient.apply(ctx, {
      transport: 'stdio',
      serverName: 'dsh_ui',
      command: process.execPath,
      args: [
        providerEntry,
        '--headless',
        '--isolated',
        '--sandbox',
        '--block-service-workers',
        '--codegen', 'none',
        '--snapshot-mode', 'none',
        '--console-level', 'error',
        '--allowed-origins', 'localhost:*;127.0.0.1:*',
        '--proxy-server', 'http://127.0.0.1:9',
        '--proxy-bypass', 'localhost,127.0.0.1,[::1]',
        '--image-responses', 'omit',
        '--output-dir', outputDir,
        '--output-max-size', '8388608',
        '--executable-path', executablePath,
        '--viewport-size', '1024x720',
      ],
      env: {},
      cwd: outputDir,
      toolCallTimeoutMs: 20_000,
      failOnStartupError: true,
      reconnect: { enabled: false },
    })

    const admission = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'ui-browser-admission',
      name: 'dsh_developer',
      arguments: { operation: 'ui' },
    })
    assert.equal(admission.isError, false)
    assert.equal(admission.value.report.ok, true)

    const redirected = await execute('browser_navigate', { url: url + 'redirect' })
    assert.equal(redirected.isError, true, JSON.stringify(redirected))
    assert.match(JSON.stringify(redirected), /ERR_(?:PROXY_CONNECTION_FAILED|CONNECTION_REFUSED)/u)
    await delay(250)
    textOf(await execute('browser_navigate', { url: 'about:blank' }))

    textOf(await execute('browser_navigate', { url }))
    const initial = textOf(await execute('browser_snapshot', { depth: 8 }))
    assert.match(initial, /Agent-native UI witness/u)
    const input = initial.match(/textbox "Name" \[ref=([^\]]+)\]/u)
    const button = initial.match(/button "Verify" \[ref=([^\]]+)\]/u)
    assert.notEqual(input, null, initial)
    assert.notEqual(button, null, initial)

    textOf(await execute('browser_type', {
      element: 'Name input',
      target: input[1],
      text: 'DSH agent',
    }))
    textOf(await execute('browser_click', {
      element: 'Verify button',
      target: button[1],
    }))
    textOf(await execute('browser_wait_for', { text: 'Verified DSH agent' }))
    const finalSnapshot = textOf(await execute('browser_snapshot', { depth: 8 }))
    assert.match(finalSnapshot, /Verified DSH agent/u)

    textOf(await execute('browser_console_messages', { level: 'error' }))
    textOf(await execute('browser_take_screenshot', {
      filename: 'ui-witness.png',
      type: 'png',
      scale: 'css',
      fullPage: false,
    }))
    const screenshot = await stat(join(outputDir, 'ui-witness.png'))
    assert.equal(screenshot.isFile(), true)
    assert.ok(screenshot.size > 0 && screenshot.size <= 8 * 1024 * 1024)
    textOf(await execute('browser_close'))
  } finally {
    await ctx.fiber.dispose()
    server.close()
    await once(server, 'close')
    await rm(outputDir, { recursive: true, force: true })
  }
})
