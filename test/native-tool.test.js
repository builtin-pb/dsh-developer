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
})

test('forwards cancellation and returns canonical evidence with compact native rendering', async () => {
  const signal = new AbortController().signal
  let received
  const definition = createNativeToolDefinition(async (input, options) => {
    received = { input, signal: options.signal }
    return {
      operation: 'doctor',
      ok: true,
      report: { ok: true, source: 'plugin', checks: [], fingerprint: 'sha256:test' },
    }
  })
  const value = await definition.execute(
    { operation: 'doctor', source: 'plugin' },
    { signal },
  )
  assert.deepEqual(received.input, { operation: 'doctor', source: 'plugin' })
  assert.equal(received.signal, signal)
  assert.equal(value.report.fingerprint, 'sha256:test')
  assert.deepEqual(definition.output.render({}, value), [{
    type: 'text',
    text: 'PASS Doctor plugin\nFingerprint: sha256:test',
  }])
})
