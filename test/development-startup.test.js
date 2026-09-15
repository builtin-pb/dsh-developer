import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertDevelopmentStartup } from '../lib/development-startup.js'
import { apply as observeServer } from '../lib/development-server-probe.js'

function context(entries, settle = async () => {}) {
  return { loader: { await: settle, entries: () => entries } }
}
function entry(id, fiber, disabled = false) {
  return { options: { id, name: 'fixture-' + id }, disabled, fiber }
}

test('checks the settled composition, accepting active and explicitly disabled entries', async () => {
  const plugin = entry('delayed', { state: 0 })
  await assertDevelopmentStartup(context([plugin, entry('disabled', undefined, true)], async () => {
    plugin.fiber.state = 2
  }))
})

test('rejects failed optional entries even when the application can serve healthy siblings', async () => {
  const failed = entry('optional-tool', { state: 3, await: async () => { throw new Error('fixture startup rejected') } })
  await assert.rejects(assertDevelopmentStartup(context([entry('healthy', { state: 2 }), failed])),
    /optional-tool.*fixture startup rejected/u)
})

test('reports pending, failed import and invalid disabled expressions without waiting on pending fibers', async () => {
  const pending = entry('pending', { state: 0, inject: { absentService: true }, ctx: { get() {} },
    await() { throw new Error('must not await a pending fiber') } })
  const badCondition = entry('condition', undefined)
  Object.defineProperty(badCondition, 'disabled', { get() { throw new Error('disabled expression rejected') } })
  await assert.rejects(assertDevelopmentStartup(context([pending, entry('missing', undefined), badCondition])), error => {
    assert.match(error.message, /3 inactive enabled entries/u)
    assert.match(error.message, /missing services: absentService/u)
    assert.match(error.message, /missing.*failed to import/u)
    assert.match(error.message, /condition.*disabled expression rejected/u)
    return true
  })
})

test('bounds diagnostics and redacts credentials before retaining an activation error', async () => {
  const token = 'sk-' + 'A1b2C3d4'.repeat(4)
  const entries = Array.from({ length: 10 }, (_, i) => entry(String(i), { state: 3,
    await: async () => { throw new Error('credential ' + token + '\n' + 'x'.repeat(10000)) } }))
  await assert.rejects(assertDevelopmentStartup(context(entries)), error => {
    assert(!error.message.includes(token))
    assert.match(error.message, /10 inactive enabled entries/u)
    assert.match(error.message, /Additional entries omitted/u)
    assert(error.message.length < 17000)
    return true
  })
})

test('withholds activation details when a key marker appears beyond the displayed entries', async () => {
  const marker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
  const entries = Array.from({ length: 10 }, (_, i) => entry(String(i), { state: 3,
    await: async () => { throw new Error(i === 9 ? marker : 'body-fragment-before-marker') } }))
  await assert.rejects(assertDevelopmentStartup(context(entries)), error => {
    assert.match(error.message, /activation diagnostics contained a private key/u)
    assert(!error.message.includes('body-fragment-before-marker'))
    return true
  })
})

test('rechecks entries added after initial settlement before publishing Web readiness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-startup-publication-'))
  const path = join(root, 'server.json')
  const settings = { DSH_DEVELOPER_SERVER_RESULT: path, DSH_DEVELOPER_SERVER_TOKEN: 'fixture-token',
    DSH_DEVELOPER_WORKSPACE: root }
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]))
  Object.assign(process.env, settings)
  const disposers = []
  t.after(async () => {
    disposers.reverse().forEach(dispose => dispose())
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  let ready, sawInitialAudit
  const audited = new Promise(resolve => { sawInitialAudit = resolve })
  const entries = [entry('healthy', { state: 2 })]
  await observeServer({
    webServer: { host: '127.0.0.1', port: 4173 }, connection: {},
    workspaceRegistry: { create: async path => ({ id: 'fixture', path }) },
    loader: { await: async () => {}, entries: () => { sawInitialAudit(); return entries } },
    effect: effect => { disposers.push(effect()) },
    get: name => name === 'appReady' ? { onReady: listener => { ready = listener; return () => {} } }
      : () => assert.fail('observation should be written without appExit'),
  })
  await audited
  entries.push(entry('late', { state: 0, inject: { unavailable: true }, ctx: { get() {} } }))
  ready()
  const deadline = Date.now() + 5000
  let receipt
  while (!receipt && Date.now() < deadline) {
    try { receipt = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  assert(receipt, 'startup observation must settle')
  assert.equal(receipt.token, settings.DSH_DEVELOPER_SERVER_TOKEN)
  assert.match(receipt.error, /late.*missing services: unavailable/u)
  assert.equal(receipt.url, undefined)
})
