import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runDevelopmentServer } from '../lib/development.js'
import { registerUiCliTool } from '../lib/ui-cli-tool.js'
import { runBounded, secretFreeEnvironment } from '../lib/runtime.js'

const enabled = process.env.DSH_DEVELOPER_UI_DEV_TEST === '1'
const project = fileURLToPath(new URL('../', import.meta.url))

function ref(tree, role, name) {
  if (!tree || typeof tree !== 'object') return undefined
  if (tree.role === role && (name === undefined || tree.name === name) && tree.ref) return tree.ref
  for (const child of Object.values(tree)) {
    const found = ref(child, role, name)
    if (found) return found
  }
}

test('native and shell UI authenticate into owned DSH Web, interact, reload and reject stopped references', {
  skip: !enabled, timeout: 120_000,
}, async () => {
  const modules = resolve(process.env.DSH_DEVELOPER_DSH_MODULES ?? '')
  const dshPath = process.env.DSH_DEVELOPER_DSH
  assert.notEqual(modules, resolve(''), 'select the exact DSH module directory')
  assert.ok(dshPath, 'select the exact DSH launcher')
  const source = resolve(process.env.DSH_DEVELOPER_UI_DEV_SOURCE ?? join(project, 'examples/session-status'))
  const root = await mkdtemp(join(tmpdir(), 'dsh-ui-development-live-'))
  const previousRoot = process.env.DSH_DEVELOPER_UI_CLI_ROOT
  process.env.DSH_DEVELOPER_UI_CLI_ROOT = join(root, 'browser')
  const [{ Context }, system, tools] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools']
    .map(name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href)))
  const ctx = new Context()
  const abort = new AbortController()
  let sequence = 0, ready, shellOpen = false
  const receipts = []
  const execute = async (input, allowFailure = false) => {
    const outcome = await ctx.tools.execute({ name: 'dsh_ui', callId: 'development-ui-' + (++sequence),
      agent: { id: 'development-ui-integration' }, arguments: input, signal: AbortSignal.timeout(25_000) })
    receipts.push(outcome)
    if (!allowFailure) assert.equal(outcome.isError, false, 'native UI action failed: ' + input.operation)
    return allowFailure ? outcome : outcome.value
  }
  const environment = secretFreeEnvironment(Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => key.startsWith('DSH_DEVELOPER_UI_') ||
      ['DSH_DEVELOPER_PLAYWRIGHT_CLI_ENTRY', 'DSH_DEVELOPER_BROWSER_EXECUTABLE'].includes(key))))
  const shell = async (...args) => {
    const result = await runBounded(process.execPath, [join(project, 'bin/dsh-developer.js'), 'ui',
      '--session', 'development-shell-integration', ...args, '--json'], {
      cwd: root, env: environment, timeoutMs: 25_000, outputLimit: 128 * 1024,
    })
    const value = JSON.parse(result.stdout)
    receipts.push(value)
    return value
  }
  const snapshot = async () => JSON.parse((await execute({ operation: 'snapshot', depth: 10 })).result.pageData.content)
  const witness = process.env.DSH_DEVELOPER_UI_DEV_EVIDENCE
  try {
    await ctx.plugin(system.default)
    await ctx.plugin(tools.default)
    await registerUiCliTool(ctx)
    await runDevelopmentServer(source, { dshPath, online: true, signal: abort.signal, onReady: async report => {
      ready = report
      assert.equal(new URL(report.url).search, '')
      assert.equal(JSON.stringify(report).includes('?token='), false)
      await execute(report.ui)
      // The workspace is loaded over DSH's live authenticated RPC connection.
      await execute({ operation: 'wait', text: basename(source), timeoutMs: 10_000 })
      let tree = await snapshot()
      const continueButton = ref(tree, 'button', 'Continue')
      if (continueButton) {
        await execute({ operation: 'click', target: continueButton })
        await execute({ operation: 'wait', text: 'Configure later', timeoutMs: 5_000 })
      }
      tree = await snapshot()
      const later = ref(tree, 'button', 'Configure later')
      if (later) await execute({ operation: 'click', target: later })
      tree = await snapshot()
      assert.doesNotMatch(JSON.stringify(tree), /Add an API key to get started/u)
      assert.doesNotMatch(JSON.stringify(tree), /Reconnecting/u)
      const editor = ref(tree, 'textbox', 'Describe what you want to build, / commands, @ files or sessions')
      assert.ok(editor, 'the connected DSH composer must be available')
      await execute({ operation: 'fill', target: editor, text: 'Local browser development witness' })
      await execute({ operation: 'wait', text: 'Local browser development witness', timeoutMs: 5_000 })
      // No model task or external message is submitted.
      await execute({ operation: 'fill', target: editor, text: '' })
      const consoleReport = await execute({ operation: 'console' })
      assert.doesNotMatch(consoleReport.result.provider.result, /\[ERROR\]/u)
      await execute({ operation: 'requests' })
      const image = await execute({ operation: 'screenshot' })
      if (witness) await copyFile(image.result.artifacts[0].path, resolve(witness))
      await execute({ operation: 'navigate', url: report.url })
      await execute({ operation: 'wait', text: basename(source), timeoutMs: 10_000 })
      assert.doesNotMatch(JSON.stringify(await snapshot()), /Reconnecting/u)
      await execute({ operation: 'close' })

      shellOpen = true
      await shell('--action', 'open', '--development-server', report.home)
      await shell('--action', 'wait', '--text', basename(source), '--timeout-ms', '10000')
      const shellSnapshot = await shell('--action', 'snapshot', '--depth', '10')
      assert.doesNotMatch(shellSnapshot.result.pageData.content, /Reconnecting/u)
      await shell('--action', 'close')
      shellOpen = false

      const privateRecord = JSON.parse(await readFile(join(report.home, 'server.json'), 'utf8'))
      const loginToken = new URL(privateRecord.url).searchParams.get('token')
      assert.ok(loginToken, 'this integration run must exercise authenticated DSH')
      assert.equal(JSON.stringify(receipts).includes(loginToken), false, 'native login must never reach tool outputs')
      abort.abort()
    } })
    await assert.rejects(stat(ready.home), { code: 'ENOENT' })
    const stale = await execute(ready.ui, true)
    assert.equal(stale.isError, true)
    assert.match(stale.error.message, /running dsh-developer dev/u)
    assert.throws(() => process.kill(ready.pid, 0), { code: 'ESRCH' })
  } finally {
    abort.abort()
    if (shellOpen) await shell('--action', 'close').catch(() => {})
    await ctx.fiber.dispose()
    if (previousRoot === undefined) delete process.env.DSH_DEVELOPER_UI_CLI_ROOT
    else process.env.DSH_DEVELOPER_UI_CLI_ROOT = previousRoot
    await rm(root, { recursive: true, force: true })
  }
})

test('authenticated browser preserves streaming and blocks other origins, redirects and requests after owner stop', {
  skip: !enabled, timeout: 45_000,
}, async () => {
  const { createServer } = await import('node:http')
  const { randomBytes, createHash } = await import('node:crypto')
  const { realpath } = await import('node:fs/promises')
  const { createDevelopmentBrowserHandoff } = await import('../lib/development-browser.js')
  const { createUiCliController } = await import('../lib/ui-cli.js')
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-ui-boundary-live-'))
  const home = await mkdtemp(join(root, 'dsh-developer-dev-'))
  const previousRoot = process.env.DSH_DEVELOPER_UI_CLI_ROOT
  process.env.DSH_DEVELOPER_UI_CLI_ROOT = join(root, 'browser')
  const token = randomBytes(32).toString('base64url')
  const cookie = 'v1.' + Buffer.from(JSON.stringify({fixture:true})).toString('base64url') + '.' + randomBytes(32).toString('base64url')
  let cookieName
  let foreignRequests = 0, ownedRequests = 0, closeHandoff, controller
  const listen = server => new Promise((accept, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', accept)
  })
  const close = server => new Promise(accept => { server.close(accept); server.closeAllConnections() })
  const foreign = createServer((_req, res) => { foreignRequests++; res.end('foreign') })
  foreign.on('upgrade', (_req, socket) => { foreignRequests++; socket.destroy() })
  await listen(foreign)
  const foreignOrigin = 'http://127.0.0.1:' + foreign.address().port
  const server = createServer((request, response) => {
    ownedRequests++
    if (request.url === '/?token=' + token) {
      response.writeHead(303, { location: '/', 'set-cookie': cookieName + '=' + cookie + '; Path=/; HttpOnly; SameSite=Strict' })
      response.end(); return
    }
    if (request.headers.cookie !== cookieName + '=' + cookie) { response.writeHead(401); response.end(); return }
    if (request.url === '/plugins/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      response.flushHeaders()
      const timer = setTimeout(() => response.write('data: HMR stream received\n\n'), 100)
      response.on('close', () => clearTimeout(timer))
      return
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { location: foreignOrigin + '/redirected' }); response.end(); return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><html><body><h1>Owned development fixture</h1><p id="events">Waiting</p>'
      + '<script>new EventSource("/plugins/events").onmessage=e=>document.querySelector("#events").textContent=e.data;'
      + 'fetch(' + JSON.stringify(foreignOrigin + '/fetch') + ').catch(()=>{});'
      + 'new WebSocket(' + JSON.stringify(foreignOrigin.replace('http:', 'ws:') + '/socket') + ');'
      + 'const workerCode=' + JSON.stringify('const ws=new WebSocket(' + JSON.stringify(foreignOrigin.replace('http:', 'ws:') + '/worker')
        + '); ws.onopen=()=>postMessage("Worker escaped"); ws.onerror=()=>postMessage("Worker WebSocket blocked"); fetch('
        + JSON.stringify(foreignOrigin + '/worker-fetch') + ').then(()=>postMessage("Worker escaped"),()=>postMessage("Worker HTTP blocked"));') + ';'
      + 'const worker=new Worker(URL.createObjectURL(new Blob([workerCode],{type:"text/javascript"})));'
      + 'worker.onmessage=e=>{const p=document.createElement("p");p.textContent=e.data;document.body.append(p)};'
      + '</script></body></html>')
  })
  try {
    await listen(server)
    const origin = 'http://127.0.0.1:' + server.address().port
    cookieName = 'dsh-auth-' + createHash('sha256').update(new URL(origin).host).digest('base64url')
    const nonce = randomBytes(24).toString('hex')
    const loginUrl = origin + '/?token=' + token
    await writeFile(join(home, 'server.json'), JSON.stringify({ kind: 'dsh-development-server-private', version: 1,
      host: '127.0.0.1', port: server.address().port, pid: process.pid, token: nonce, url: loginUrl }), { mode: 0o600 })
    closeHandoff = await createDevelopmentBrowserHandoff(home, { nonce, loginUrl })
    controller = await createUiCliController()
    const reports = []
    const execute = async input => { const value = await controller.execute('boundary-witness', input); reports.push(value); return value }
    await execute({ operation: 'open', developmentServer: home })
    await execute({ operation: 'wait', text: 'HMR stream received', timeoutMs: 5_000 })
    await execute({ operation: 'wait', text: 'Worker WebSocket blocked', timeoutMs: 5_000 })
    await execute({ operation: 'wait', text: 'Worker HTTP blocked', timeoutMs: 5_000 })
    assert.equal(foreignRequests, 0, 'HTTP and WebSocket requests must not reach a different localhost port')
    await assert.rejects(execute({ operation: 'navigate', url: origin + '/redirect' }))
    assert.equal(foreignRequests, 0, 'redirects must not carry the DSH cookie to another origin')
    await execute({ operation: 'navigate', url: origin + '/' })
    await execute({ operation: 'wait', text: 'HMR stream received', timeoutMs: 5_000 })
    await closeHandoff()
    const before = ownedRequests
    await assert.rejects(execute({ operation: 'navigate', url: origin + '/' }))
    assert.equal(ownedRequests, before, 'a live PID and reused port must not substitute for the stopped owner')
    const text = JSON.stringify(reports)
    assert.ok(!text.includes(token) && !text.includes(cookie), 'private login and cookies must not appear in UI output')
  } finally {
    await controller?.dispose()
    await closeHandoff?.()
    await Promise.all([close(server), close(foreign)])
    if (previousRoot === undefined) delete process.env.DSH_DEVELOPER_UI_CLI_ROOT
    else process.env.DSH_DEVELOPER_UI_CLI_ROOT = previousRoot
    await rm(root, { recursive: true, force: true })
  }
})
