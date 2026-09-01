import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createNativeToolDefinition,
  NATIVE_TOOL_NAME,
  NATIVE_TOOL_OPERATIONS,
  parseNativeToolInput,
} from '../lib/native-tool-internal.js'

test('registers one closed structured tool instead of multiplying model schemas', () => {
  const definition = createNativeToolDefinition(async () => ({
    operation: 'capabilities',
    ok: true,
    report: {},
  }))
  assert.equal(definition.name, NATIVE_TOOL_NAME)
  assert.deepEqual(definition.parameters.properties.operation.enum, [...NATIVE_TOOL_OPERATIONS])
  assert.equal(definition.parameters.additionalProperties, false)
  assert.equal(definition.output.schema.additionalProperties, false)
  assert.equal(definition.isConcurrencySafe, undefined)
})

test('keeps operation-specific argument surfaces closed before execution', () => {
  assert.deepEqual(
    parseNativeToolInput({ operation: 'preflight', source: 'plugin', profile: 'headless' }),
    { operation: 'preflight', source: 'plugin', profile: 'headless' },
  )
  assert.throws(
    () => parseNativeToolInput({ operation: 'capabilities', source: 'plugin' }),
    /Field "source" is not valid for operation "capabilities"/u,
  )
  assert.throws(
    () => parseNativeToolInput({ operation: 'impact', source: 'plugin' }),
    /previewDsh must be a non-empty string/u,
  )
  assert.throws(
    () => parseNativeToolInput({ operation: 'doctor', source: 'plugin', skipRuntime: 'yes' }),
    /skipRuntime must be boolean/u,
  )
  const digest = 'sha256:' + 'a'.repeat(64)
  assert.deepEqual(parseNativeToolInput({
    operation: 'cell-plan',
    outcome: 'Run focused tests',
    commands: [{ command: 'node --test', timeoutMs: 1_000 }],
  }), {
    operation: 'cell-plan',
    outcome: 'Run focused tests',
    commands: [{ command: 'node --test', timeoutMs: 1_000 }],
  })
  assert.deepEqual(parseNativeToolInput({ operation: 'cell-run', planDigest: digest }), {
    operation: 'cell-run', planDigest: digest,
  })
  assert.deepEqual(parseNativeToolInput({ operation: 'cell-apply', planDigest: digest }), {
    operation: 'cell-apply', planDigest: digest,
  })
  assert.deepEqual(parseNativeToolInput({ operation: 'cell-discard', planDigest: digest }), {
    operation: 'cell-discard', planDigest: digest,
  })
  for (const operation of ['cell-plan', 'cell-run', 'cell-apply', 'cell-discard']) {
    const base = operation === 'cell-plan'
      ? { operation, outcome: 'test', commands: [{ command: 'true' }] }
      : { operation, planDigest: digest }
    assert.throws(
      () => parseNativeToolInput({ ...base, source: 'forged', cwd: 'forged', approval: true }),
      /Field "source" is not valid/u,
    )
  }
  assert.throws(
    () => parseNativeToolInput({ operation: 'cell-plan', outcome: 'test', commands: [{ command: 'true', env: {} }] }),
    /Field "env" is not valid/u,
  )
})

test('forwards cancellation and returns canonical evidence with compact native rendering', async () => {
  const signal = new AbortController().signal
  const agent = { id: 'agent-under-test' }
  let received
  const definition = createNativeToolDefinition(async (input, options) => {
    received = { input, signal: options.signal, agent: options.agent }
    return {
      operation: 'doctor',
      ok: true,
      report: { ok: true, source: 'plugin', checks: [], fingerprint: 'sha256:test' },
    }
  })
  const value = await definition.execute(
    { operation: 'doctor', source: 'plugin' },
    { signal, agent },
  )
  assert.deepEqual(received.input, { operation: 'doctor', source: 'plugin' })
  assert.equal(received.signal, signal)
  assert.equal(received.agent, agent)
  assert.equal(value.report.fingerprint, 'sha256:test')
  assert.deepEqual(definition.output.render({}, value), [{
    type: 'text',
    text: 'PASS Doctor plugin\nFingerprint: sha256:test',
  }])
})

test('renders scoped UI admission evidence without adding another tool schema', async () => {
  const definition = createNativeToolDefinition(async () => ({
    operation: 'ui',
    ok: false,
    report: {
      ok: false,
      selected: null,
      checks: [{ id: 'semantic-provider', status: 'FAIL', message: 'missing' }],
      evidenceDigest: 'sha256:test',
    },
  }))
  const value = await definition.execute({ operation: 'ui' }, { signal: new AbortController().signal })
  assert.equal(value.operation, 'ui')
  assert.match(definition.output.render({}, value)[0].text, /^FAIL UI capabilities/u)
})

test('renders delegated fixed-authority evidence without adding another tool schema', async () => {
  const definition = createNativeToolDefinition(async () => ({
    operation: 'delegation',
    ok: true,
    report: {
      ok: true,
      applies: true,
      agent: { depth: 1 },
      tools: [{ name: 'bash', status: 'fixed-scope', exposed: [] }],
      checks: [{ id: 'agent-scope', status: 'PASS', message: 'delegated' }],
      evidenceDigest: 'sha256:test',
    },
  }))
  const value = await definition.execute({ operation: 'delegation' }, {
    signal: new AbortController().signal,
  })
  assert.equal(value.operation, 'delegation')
  assert.match(definition.output.render({}, value)[0].text, /^PASS Delegation safety/u)
  assert.deepEqual(parseNativeToolInput({ operation: 'delegation' }), { operation: 'delegation' })
  assert.throws(
    () => parseNativeToolInput({ operation: 'delegation', source: 'plugin' }),
    /Field "source" is not valid for operation "delegation"/u,
  )
})

test('renders current fixed-authority evidence on the same native schema', async () => {
  const definition = createNativeToolDefinition(async () => ({
    operation: 'authority',
    ok: true,
    report: {
      ok: true,
      applies: true,
      agent: { delegated: false, depth: null },
      authority: { reasons: ['maximum-sandbox'] },
      tools: [{ name: 'pwsh', status: 'fixed-scope', exposed: [] }],
      checks: [{ id: 'agent-scope', status: 'PASS', message: 'fixed' }],
      evidenceDigest: 'sha256:test',
    },
  }))
  const value = await definition.execute({ operation: 'authority' }, {
    signal: new AbortController().signal,
  })
  assert.match(definition.output.render({}, value)[0].text, /^PASS Authority safety/u)
  assert.deepEqual(parseNativeToolInput({ operation: 'authority' }), { operation: 'authority' })
})
