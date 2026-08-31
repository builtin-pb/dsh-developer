import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { registerNativeTool } from '../lib/native-tool.js'
import { registerUiSafetyGuard } from '../lib/ui-policy.js'

const enabled = process.env.DSH_DEVELOPER_UI_DSH_TEST === '1'

function moduleUrl(modules, packageName) {
  return pathToFileURL(join(modules, '@deepseek-ai', packageName, 'lib', 'index.js')).href
}

test('composes the live provider through the exact DSH tool registry and guard pipeline', {
  skip: !enabled,
}, async () => {
  const modules = resolve(process.env.DSH_DEVELOPER_DSH_MODULES ?? '')
  const providerEntry = resolve(process.env.DSH_DEVELOPER_PLAYWRIGHT_MCP_ENTRY ?? '')
  assert.notEqual(modules, resolve(''), 'DSH_DEVELOPER_DSH_MODULES must name the exact DSH module directory')
  assert.notEqual(providerEntry, resolve(''), 'DSH_DEVELOPER_PLAYWRIGHT_MCP_ENTRY must name cli.js')

  const [{ Context }, systemPromptModule, toolsModule, mcpClient] = await Promise.all([
    import(moduleUrl(modules, 'cordis')),
    import(moduleUrl(modules, 'dsh-system-prompt')),
    import(moduleUrl(modules, 'dsh-tools')),
    import(moduleUrl(modules, 'dsh-mcp-client')),
  ])
  const home = await mkdtemp(join(tmpdir(), 'dsh-developer-ui-dsh-'))
  const ctx = new Context()
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
        '--output-dir', home,
        '--output-max-size', '8388608',
      ],
      env: {},
      cwd: home,
      toolCallTimeoutMs: 10_000,
      failOnStartupError: true,
      reconnect: { enabled: false },
    })

    const admitted = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'ui-admission',
      name: 'dsh_developer',
      arguments: { operation: 'ui' },
    })
    assert.equal(admitted.isError, false)
    assert.equal(admitted.value.report.ok, true)
    assert.equal(admitted.value.report.selected.namespace, 'dsh_ui')
    assert.ok(admitted.value.report.selected.catalogTools >= 20)

    const code = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'ui-denied-code',
      name: 'mcp__dsh_ui__browser_run_code_unsafe',
      arguments: { code: 'async () => 42' },
    })
    assert.equal(code.isError, true)
    assert.match(JSON.stringify(code), /dsh-developer denies code execution/u)

    const remote = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'ui-denied-navigation',
      name: 'mcp__dsh_ui__browser_navigate',
      arguments: { url: 'https://example.com' },
    })
    assert.equal(remote.isError, true)
    assert.match(JSON.stringify(remote), /only to explicit HTTP\(S\) loopback URLs/u)
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
