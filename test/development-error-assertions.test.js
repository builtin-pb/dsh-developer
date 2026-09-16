import assert from 'node:assert/strict'
import test from 'node:test'
import { observeToolCase } from '../lib/development-probe.js'

const errorCase = { tool: 'fixture', arguments: {}, isError: true, expected: null, errorContains: 'INVALID_ARGUMENTS' }
const text = value => ({ type: 'text', text: value })
const failure = (...content) => ({ isError: true, content })

test('matching rendered error passes and retains the expected literal', () => {
  const observed = observeToolCase(errorCase, failure(text('Error: INVALID_ARGUMENTS')), 0)
  assert.equal(observed.passed, true)
  assert.deepEqual(observed.failures, [])
  assert.equal(observed.errorContains, 'INVALID_ARGUMENTS')
})

test('a different error fails even though isError and the absent canonical value match', () => {
  const observed = observeToolCase(errorCase, failure(text('Error: AGENT_WORKSPACE_REQUIRED')), 0)
  assert.equal(observed.passed, false)
  assert.deepEqual(observed.failures, ['error-message-mismatch'])
  assert.equal(observed.value, null)
  assert.equal(observed.errorContains, 'INVALID_ARGUMENTS')
})

test('error matching is case-sensitive and literal, not a regular expression', () => {
  assert.deepEqual(observeToolCase(errorCase, failure(text('invalid_arguments')), 0).failures,
    ['error-message-mismatch'])
  const item = { ...errorCase, errorContains: 'bad [input].*' }
  assert.equal(observeToolCase(item, failure(text('Error: bad [input].* here')), 0).passed, true)
  assert.equal(observeToolCase(item, failure(text('Error: bad input anything')), 0).passed, false)
})

test('fragments in separate text blocks never form a match', () => {
  const result = failure(text('Error: INVALID_'), text('ARGUMENTS'))
  assert.deepEqual(observeToolCase(errorCase, result, 0).failures, ['error-message-mismatch'])
  assert.equal(observeToolCase(errorCase, failure(text('unrelated'), text('INVALID_ARGUMENTS')), 0).passed, true)
})

test('nontext fields and nested text-shaped resource data cannot satisfy an assertion', () => {
  const result = failure(
    { type: 'image', text: 'INVALID_ARGUMENTS', data: 'INVALID_ARGUMENTS', mimeType: 'image/png' },
    { type: 'resource', resource: { type: 'text', text: 'INVALID_ARGUMENTS' } },
  )
  assert.deepEqual(observeToolCase(errorCase, result, 0).failures, ['error-message-mismatch'])
})

test('canonical error metadata cannot silently substitute for rendered text', () => {
  const result = { ...failure(text('a different rendered message')), error: { message: 'INVALID_ARGUMENTS' } }
  assert.deepEqual(observeToolCase(errorCase, result, 0).failures, ['error-message-mismatch'])
  assert.deepEqual(observeToolCase(errorCase, failure(), 0).failures, ['error-message-mismatch'])
})

test('matching happens before clipping a long returned message', () => {
  const result = failure(text('ordinary detail '.repeat(300) + 'INVALID_ARGUMENTS'))
  const observed = observeToolCase(errorCase, result, 0)
  assert.equal(observed.passed, true)
  assert.equal(observed.contentOmitted, true)
  assert.equal(Object.hasOwn(observed, 'content'), false)
  assert.equal(observed.errorContains, 'INVALID_ARGUMENTS')
  assert.equal(observed.contentBytes, Buffer.byteLength(JSON.stringify(result.content)))
})

test('a 512-code-unit assertion still obeys the 1 KiB UTF-8 receipt field limit', () => {
  const errorContains = '界'.repeat(512)
  const observed = observeToolCase({ ...errorCase, errorContains }, failure(text(errorContains)), 0)
  assert.equal(observed.passed, true)
  assert.equal(observed.errorContainsOmitted, true)
  assert.equal(Object.hasOwn(observed, 'errorContains'), false)
})

test('assertion fields share the existing 3 KiB payload allowance', () => {
  const item = { ...errorCase, name: 'n'.repeat(128), expected: 'e'.repeat(1000), errorContains: 'a'.repeat(512) }
  const result = { isError: false, content: [text(item.errorContains)], value: 'v'.repeat(1000) }
  const observed = observeToolCase(item, result, 0)
  assert.deepEqual(observed.failures, ['expected-error', 'value-mismatch'])
  assert.equal(observed.errorContains, item.errorContains)
  assert.equal(observed.contentOmitted, true)
  const fields = ['name', 'value', 'expected', 'resultPath', 'errorContains', 'content']
    .filter(key => Object.hasOwn(observed, key))
  assert.ok(fields.every(key => Buffer.byteLength(JSON.stringify(observed[key])) <= 1024))
  assert.ok(fields.reduce((total, key) => total + Buffer.byteLength(JSON.stringify(observed[key])), 0) <= 3072)
})

test('a matching error cannot bypass the full result byte budget', () => {
  const result = failure(text('Error: INVALID_ARGUMENTS'))
  const measured = observeToolCase(errorCase, result, 0).resultBytes
  assert.equal(observeToolCase({ ...errorCase, maxResultBytes: measured }, result, 0).passed, true)
  const observed = observeToolCase({ ...errorCase, maxResultBytes: measured - 1 }, result, 0)
  assert.deepEqual(observed.failures, ['result-budget-exceeded'])
  assert.equal(observed.outputLimitExceeded, true)
})

test('a successful result containing the phrase still fails the expected-error assertion', () => {
  const observed = observeToolCase(errorCase, { isError: false, value: null, content: [text('INVALID_ARGUMENTS')] }, 0)
  assert.deepEqual(observed.failures, ['expected-error'])
})

test('existing error cases without a substring retain their behavior', () => {
  const { errorContains, ...item } = errorCase
  const observed = observeToolCase(item, failure(text('any error')), 0)
  assert.equal(observed.passed, true)
  assert.equal(Object.hasOwn(observed, 'errorContains'), false)
})

test('canonical resultPath remains value-only and needs no error assertion', () => {
  const item = { tool: 'fixture', arguments: {}, resultPath: '/issues/0/code', expected: 'FILE_TOO_LARGE' }
  assert.equal(observeToolCase(item, {
    isError: false, value: { issues: [{ code: 'FILE_TOO_LARGE' }] }, content: [],
  }, 0).passed, true)
  const observed = observeToolCase({ ...errorCase, resultPath: '/error/info/code' }, {
    ...failure(text('INVALID_ARGUMENTS')), error: { info: { code: 'INVALID_ARGUMENTS' } },
  }, 0)
  assert.deepEqual(observed.failures, ['missing-result-path'])
})

test('full-output private-key detection survives message matching and clipping', () => {
  const marker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
  const observed = observeToolCase(errorCase, failure(text('detail '.repeat(400) + marker + '\nINVALID_ARGUMENTS')), 0)
  assert.equal(observed.passed, true)
  assert.equal(observed.privateKeyOutput, true)
  assert.equal(observed.contentOmitted, true)
  assert.equal(observed.errorContains, 'INVALID_ARGUMENTS')
})
