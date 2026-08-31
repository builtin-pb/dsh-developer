import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { secretFreeEnvironment } from '../lib/runtime.js'
import { inspectUiCapabilities } from '../lib/ui-capabilities.js'

const enabled = process.env.DSH_DEVELOPER_UI_PROVIDER_TEST === '1'

function rpcClient(entry, outputDir) {
  const child = spawn(process.execPath, [
    entry,
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
  ], {
    cwd: outputDir,
    env: secretFreeEnvironment(),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let nextId = 1
  let buffered = ''
  let stderr = ''
  const pending = new Map()
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffered += chunk
    while (true) {
      const end = buffered.indexOf('\n')
      if (end < 0) break
      const line = buffered.slice(0, end).replace(/\r$/u, '')
      buffered = buffered.slice(end + 1)
      if (line.length === 0) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id === undefined || !pending.has(message.id)) continue
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error !== undefined) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
    }
  })
  child.once('error', (error) => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  })
  return {
    async request(method, params) {
      const id = nextId++
      const result = new Promise((resolveResult, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('MCP request timed out; stderr: ' + stderr))
        }, 10_000)
        pending.set(id, { resolve: resolveResult, reject, timer })
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      return result
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    },
    async close() {
      child.stdin.end()
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await new Promise((accept) => {
        if (child.exitCode !== null || child.signalCode !== null) accept()
        else {
          const timer = setTimeout(accept, 5_000)
          child.once('close', () => {
            clearTimeout(timer)
            accept()
          })
        }
      })
    },
  }
}

test('recognizes the pinned live Playwright MCP schema without inventing guard evidence', {
  skip: !enabled,
}, async () => {
  const entry = resolve(process.env.DSH_DEVELOPER_PLAYWRIGHT_MCP_ENTRY ?? '')
  assert.notEqual(entry, resolve(''), 'DSH_DEVELOPER_PLAYWRIGHT_MCP_ENTRY must name cli.js')
  const outputDir = await mkdtemp(join(tmpdir(), 'dsh-developer-ui-provider-'))
  const client = rpcClient(entry, outputDir)
  try {
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-developer-provider-probe', version: '0.1.0' },
    })
    client.notify('notifications/initialized', {})
    const listed = await client.request('tools/list', {})
    assert.ok(Array.isArray(listed.tools))
    const report = inspectUiCapabilities(listed.tools.map((tool) => ({
      name: 'mcp__dsh_ui__' + tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema,
    })))
    assert.equal(report.ok, false)
    assert.equal(report.providers[0].ready, true)
    assert.equal(report.providers[0].adapter, 'playwright-compatible')
    assert.ok(report.providers[0].catalogTools >= 20)
    assert.equal(report.providers[0].riskTools.length, 4)
  } finally {
    await client.close()
    await rm(outputDir, { recursive: true, force: true })
  }
})
