import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../lib/development-probe.js'

// These contexts test probe orchestration only. Actual Agent/policy behavior
// belongs to the native DSH integration tests, not these test doubles.
const cases = [{ name: 'first', tool: 'scoped', arguments: {}, expected: 'done' },
  { name: 'second', tool: 'scoped', arguments: {}, expected: 'done' }]
const result = () => ({ isError: false, value: 'done', content: [] })
const deferred = () => Promise.withResolvers()

async function bounded(promise) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('probe test did not settle')), 5000)
    })])
  } finally { clearTimeout(timer) }
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-probe-unit-'))
  const environment = { DSH_DEVELOPER_CASES: join(root, 'cases.json'),
    DSH_DEVELOPER_CASE_RESULT: join(root, 'result.json'), DSH_DEVELOPER_BOOT_COMPLETE: join(root, 'boot'),
    DSH_DEVELOPER_VERIFY_WORKSPACE: options.global ? undefined : root }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await writeFile(environment.DSH_DEVELOPER_CASES, JSON.stringify(cases))
  await writeFile(environment.DSH_DEVELOPER_BOOT_COMPLETE, '')
  const exited = deferred(), disposers = []
  const state = { root, exits: [], lookups: [], executions: [], disposalCalls: 0,
    read: async () => JSON.parse(await readFile(environment.DSH_DEVELOPER_CASE_RESULT, 'utf8')),
    cancel: () => disposers.forEach(dispose => dispose()),
  }
  state.waitFor = async predicate => bounded((async () => {
    while (true) {
      const receipt = await state.read().catch(() => undefined)
      if (receipt && predicate(receipt)) return receipt
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  })())
  state.agent = Object.freeze({ id: 'unit-agent', session: Object.freeze({ header: Object.freeze({ cwd: root }) }) })
  const agentCtx = Object.freeze({ marker: 'agent context' })
  const presets = { async mount(context) {
    assert.equal(this, presets, 'mount must retain its service receiver')
    assert.equal(context, agentCtx)
    state.mountReceipt = await state.read()
    if (options.mount) return options.mount(state)
    return { id: 'configured-default' }
  } }
  const agents = { async create(input) {
    state.createInput = input
    state.createReceipt = await state.read()
    assert.match(input.sessionId, /^[a-f0-9-]{36}$/u)
    assert.deepEqual(input.meta, { cwd: root })
    assert.equal(input.signal.aborted, false)
    const setupResult = await input.setup(agentCtx)
    assert.equal(setupResult, undefined, 'a preset is not a factory commit transaction')
    return { agent: state.agent, async dispose() {
      state.disposalCalls += 1
      state.disposeReceipt = await state.read()
      if (options.dispose) await options.dispose(state)
      state.disposed = true
    } }
  } }
  const ctx = {
    effect: effect => disposers.push(effect()),
    appExit: code => { state.exits.push(code); exited.resolve(code) },
    loader: { await: async () => { state.startupReceipt = await state.read() }, entries: () => [] },
    get: name => {
      assert.equal(options.global, undefined, 'agentless mode must not resolve Agent services')
      if (name === 'agents') return options.missingFactory ? undefined : agents
      if (name === 'agentPresets') return options.noPreset ? undefined : presets
      assert.fail('unexpected service: ' + name)
    },
    tools: {
      get: (name, agent) => {
        state.lookups.push({ name, agent })
        return (options.global ? agent === undefined : agent === state.agent) ? {} : undefined
      },
      execute: async input => {
        state.executions.push(input)
        assert.equal(input.agent, options.global ? undefined : state.agent)
        const receipt = await state.read()
        assert.equal(receipt.phase, 'cases')
        assert.equal(receipt.complete, false)
        assert.equal(receipt.activeCase.index, state.executions.length)
        if (options.execute) return options.execute(input, state)
        return result()
      },
    },
  }
  state.start = () => apply(ctx)
  state.finish = async () => { const code = await bounded(exited.promise); return { code, receipt: await state.read() } }
  t.after(async () => {
    state.cancel()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  return state
}

test('global verification retains agentless dispatch and complete checkpoints', async t => {
  const state = await fixture(t, { global: true })
  state.start()
  const { code, receipt } = await state.finish()
  assert.equal(code, 0)
  assert.equal(state.startupReceipt.phase, 'startup')
  assert.equal(receipt.phase, 'complete')
  assert.equal(receipt.complete, true)
  assert.equal(receipt.ok, true)
  assert.equal(Object.hasOwn(receipt, 'agent'), false)
  assert(state.executions.every(input => !Object.hasOwn(input, 'agent')))
  assert.equal(state.disposalCalls, 0)
})

test('Agent verification mounts the default with a void setup and scopes lookup and execution', async t => {
  const state = await fixture(t)
  state.start()
  const { code, receipt } = await state.finish()
  assert.equal(code, 0)
  assert.equal(state.createReceipt.phase, 'agent-setup')
  assert.equal(state.mountReceipt.phase, 'agent-setup')
  assert.equal(Object.hasOwn(state.createReceipt, 'agent'), false)
  assert(state.lookups.length > 0)
  assert(state.lookups.every(lookup => lookup.agent === state.agent))
  assert.equal(state.disposalCalls, 1)
  assert.equal(state.disposed, true)
  assert.equal(state.disposeReceipt.phase, 'agent-dispose')
  assert.equal(state.disposeReceipt.complete, false)
  assert.equal(state.disposeReceipt.cases.length, 2)
  assert.equal(receipt.complete, true)
  assert.equal(receipt.phase, 'complete')
  assert.deepEqual(receipt.agent, { id: 'unit-agent', preset: 'configured-default' })
  assert.match(receipt.scope, /real Agent.*native policy.*does not submit a model turn/u)
  if (process.platform !== 'win32') assert.equal((await stat(join(state.root, 'result.json'))).mode & 0o777, 0o600)
  await assert.rejects(stat(join(state.root, 'result.json.pending')), { code: 'ENOENT' })
})

test('a composition without agentPresets still uses the native Agent factory', async t => {
  const state = await fixture(t, { noPreset: true })
  state.start()
  const { code, receipt } = await state.finish()
  assert.equal(code, 0)
  assert.equal(receipt.agent.preset, null)
  assert.equal(state.mountReceipt, undefined)
  assert.equal(state.disposalCalls, 1)
})

test('missing native Agent factory fails in setup without global fallback', async t => {
  const state = await fixture(t, { missingFactory: true })
  state.start()
  const { code, receipt } = await state.finish()
  assert.equal(code, 1)
  assert.equal(receipt.phase, 'agent-setup')
  assert.equal(receipt.complete, false)
  assert.match(receipt.error, /native agents factory/u)
  assert.equal(state.lookups.length, 0)
  assert.equal(state.executions.length, 0)
})

test('preset mount failure propagates without retrying an uncomposed Agent', async t => {
  const state = await fixture(t, { mount: () => { throw new Error('broken default preset') } })
  state.start()
  const { code, receipt } = await state.finish()
  assert.equal(code, 1)
  assert.equal(receipt.phase, 'agent-setup')
  assert.equal(receipt.error, 'broken default preset')
  assert.equal(receipt.complete, false)
  assert.equal(Object.hasOwn(receipt, 'agent'), false)
  assert.equal(state.executions.length, 0)
  assert.equal(state.disposalCalls, 0, 'creation rollback belongs to the native factory, which returned no handle')
})

test('disposal failure retains all returned cases and cannot publish completion', async t => {
  const state = await fixture(t, { dispose: () => { throw new Error('disposal failed') } })
  state.start()
  const { code, receipt } = await state.finish()
  assert.equal(code, 1)
  assert.equal(receipt.ok, false)
  assert.equal(receipt.complete, false)
  assert.equal(receipt.phase, 'agent-dispose')
  assert.equal(receipt.cases.length, 2)
  assert.equal(receipt.activeCase, null)
  assert.equal(receipt.error, 'disposal failed')
  assert.equal(state.disposalCalls, 1)
})

test('a pending disposal keeps the atomic checkpoint incomplete until it resolves', async t => {
  const entered = deferred(), release = deferred()
  const state = await fixture(t, { dispose: async () => { entered.resolve(); await release.promise } })
  state.start()
  try {
    await bounded(entered.promise)
    const receipt = await state.read()
    assert.equal(receipt.phase, 'agent-dispose')
    assert.equal(receipt.complete, false)
    assert.equal(receipt.cases.length, 2)
    assert.equal(receipt.activeCase, null)
    assert.deepEqual(state.exits, [])
  } finally { release.resolve() }
  const { code, receipt } = await state.finish()
  assert.equal(code, 0)
  assert.equal(receipt.phase, 'complete')
})

test('invocation failure is checkpointed before hanging teardown and survives cleanup failure', async t => {
  const entered = deferred(), release = deferred()
  const state = await fixture(t, {
    execute: (_input, state) => {
      if (state.executions.length === 2) throw new Error('invocation failed')
      return result()
    },
    dispose: async () => { entered.resolve(); await release.promise; throw new Error('cleanup failed') },
  })
  state.start()
  try {
    await bounded(entered.promise)
    const receipt = await state.read()
    assert.equal(receipt.error, 'invocation failed')
    assert.equal(receipt.phase, 'agent-dispose')
    assert.equal(receipt.complete, false)
    assert.equal(receipt.cases.length, 1)
    assert.deepEqual(receipt.activeCase, { index: 2, name: 'second', tool: 'scoped' })
    assert.deepEqual(state.exits, [])
  } finally { release.resolve() }
  const { code, receipt } = await state.finish()
  assert.equal(code, 1)
  assert.equal(receipt.error, 'invocation failed')
  assert.equal(receipt.cleanupError, 'cleanup failed')
  assert.equal(state.disposalCalls, 1)
})

test('invocation and cleanup diagnostics are withheld and bounded independently', async t => {
  const secret = 'sk-' + 'A'.repeat(32)
  const state = await fixture(t, {
    execute: () => { throw new Error(secret + '\n' + 'i'.repeat(4000)) },
    dispose: () => { throw new Error(secret + '\n' + 'c'.repeat(4000)) },
  })
  state.start()
  const { receipt } = await state.finish()
  for (const text of [receipt.error, receipt.cleanupError]) {
    assert.equal(text.includes(secret), false)
    assert.equal(text.length, 2048)
    assert.match(text, /redacted/u)
  }
})

test('cancellation drains a cooperative invocation and disposes without requesting an exit', async t => {
  const entered = deferred()
  const state = await fixture(t, { execute: async (input, state) => {
    if (state.executions.length === 1) return result()
    entered.resolve()
    await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }))
  } })
  state.start()
  await bounded(entered.promise)
  state.cancel()
  const receipt = await state.waitFor(receipt => receipt.phase === 'agent-dispose' && state.disposed && Boolean(receipt.error))
  assert.equal(receipt.complete, false)
  assert.equal(receipt.ok, false)
  assert.equal(receipt.cases.length, 1)
  assert.equal(receipt.activeCase.index, 2)
  assert.equal(state.disposalCalls, 1)
  assert.deepEqual(state.exits, [])
})

test('cancellation while disposal is pending cannot turn returned cases into a complete receipt', async t => {
  const entered = deferred(), release = deferred()
  const state = await fixture(t, { dispose: async () => { entered.resolve(); await release.promise } })
  state.start()
  try { await bounded(entered.promise); state.cancel() } finally { release.resolve() }
  const receipt = await state.waitFor(receipt => state.disposed && Boolean(receipt.error))
  assert.equal(receipt.phase, 'agent-dispose')
  assert.equal(receipt.complete, false)
  assert.equal(receipt.cases.length, 2)
  assert.equal(receipt.activeCase, null)
  assert.deepEqual(state.exits, [])
})
