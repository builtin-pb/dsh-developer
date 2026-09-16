import assert from 'node:assert/strict'
import test from 'node:test'
import { protectVerificationReceipt, validVerificationReceipt } from '../lib/development-receipt.js'
import { observeToolCase } from '../lib/development-probe.js'
import { findSecrets } from '../lib/security.js'
import { formatDevelopmentReport } from '../lib/development.js'

function receipt(cases, results) {
  return { ok: true, complete: true, phase: 'complete', caseCount: cases.length, activeCase: null,
    cases: results.map((result, index) => observeToolCase(cases[index], result, index)),
    scope: 'global native registry; no model or Agent invocation' }
}
const text = value => [{ type: 'text', text: value }]

test('a conservative path finding withholds the error text without losing completed case outcomes', () => {
  const path = '/private/tmp/dsh-enhancements-september16-evening/authoring-trial/fixtures/policy/README.md'
  assert.deepEqual(findSecrets(path), ['high-entropy-token'])
  const cases = [{ name: 'denied write', tool: 'write', arguments: {}, isError: true, expected: null }]
  const raw = receipt(cases, [{ isError: true, value: null, content: text('File has not been read: ' + path) }])
  assert.equal(validVerificationReceipt(raw, cases), true)
  const protectedResult = protectVerificationReceipt(raw, cases)
  assert.equal(validVerificationReceipt(protectedResult, cases), true)
  assert.equal(protectedResult.ok, true)
  assert.equal(protectedResult.complete, true)
  assert.equal(protectedResult.phase, 'complete')
  assert.equal(protectedResult.cases[0].passed, true)
  assert.equal(protectedResult.cases[0].value, null)
  assert.equal(protectedResult.cases[0].contentWithheld, true)
  assert.equal(protectedResult.cases[0].content, undefined)
  assert.deepEqual(protectedResult.outputProtection, { withheld: true, reason: 'possible-credentials' })
  assert.match(formatDevelopmentReport(protectedResult), /Withheld possible credentials in: content/u)
  assert(!JSON.stringify(protectedResult).includes(path))
})

test('credential-bearing canonical values keep the mismatch verdict and the safe expected value', () => {
  const secret = 'sk-' + 'A1b2C3d4'.repeat(4)
  const cases = [{ tool: 'fixture', arguments: {}, expected: { status: 'ready' } }]
  const raw = receipt(cases, [{ isError: false, value: { status: 'ready', token: secret }, content: text('ready') }])
  raw.ok = false
  const protectedResult = protectVerificationReceipt(raw, cases)
  assert.equal(validVerificationReceipt(protectedResult, cases), true)
  const observed = protectedResult.cases[0]
  assert.equal(observed.passed, false)
  assert.deepEqual(observed.failures, ['value-mismatch'])
  assert.equal(observed.valueWithheld, true)
  assert.deepEqual(observed.expected, cases[0].expected)
  assert.deepEqual(observed.content, text('ready'))
  assert.equal(observed.resultBytes, raw.cases[0].resultBytes)
  assert(!JSON.stringify(protectedResult).includes(secret))
  assert.deepEqual(findSecrets(JSON.stringify(protectedResult)), [])
})

test('a private-key marker beyond clipping withholds fragments from every case and metadata', () => {
  const marker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
  const fragment = 'innocent-looking-fragment'
  const cases = [1, 2].map(() => ({ tool: 'fixture', arguments: {}, expected: true }))
  const raw = receipt(cases, [
    { isError: false, value: fragment, content: text('first fragment') },
    { isError: false, value: true, content: text('padding\n'.repeat(1000) + marker) },
  ])
  raw.ok = false
  raw.agent = { id: 'ordinary-agent', preset: 'standard' }
  assert.equal(raw.cases[1].contentOmitted, true)
  assert.equal(raw.cases[1].privateKeyOutput, true)
  assert(!JSON.stringify(raw).includes(marker), 'the marker itself is outside retained payload')
  const protectedResult = protectVerificationReceipt(raw, cases)
  assert.equal(validVerificationReceipt(protectedResult, cases, '/selected'), true)
  assert.equal(protectedResult.cases[0].passed, false)
  assert.equal(protectedResult.cases[1].passed, true)
  assert.equal(protectedResult.cases[0].valueWithheld, true)
  assert.equal(protectedResult.cases[0].contentWithheld, true)
  assert.equal(protectedResult.agent.metadataWithheld, true)
  assert.equal(protectedResult.outputProtection.reason, 'private-key')
  assert(!JSON.stringify(protectedResult).includes(fragment))
  assert(!JSON.stringify(protectedResult).includes('first fragment'))
  assert.deepEqual(findSecrets(JSON.stringify(protectedResult)), [])
})

test('protected interrupted receipts preserve phase, active case and earlier verdicts', () => {
  const secret = 'ghp_' + 'A1b2C3d4'.repeat(4)
  const cases = [{ name: 'first', tool: 'fixture', arguments: {}, expected: true },
    { name: 'next', tool: 'fixture', arguments: {}, expected: true }]
  const raw = { ok: false, complete: false, phase: 'cases', caseCount: 2,
    activeCase: { index: 2, name: 'next', tool: 'fixture' },
    cases: [observeToolCase(cases[0], { isError: false, value: true, content: text(secret) }, 0)],
    error: secret, cleanupError: 'ordinary cleanup failure', extra: { [secret]: 'not a protocol field' } }
  const result = protectVerificationReceipt(raw, cases)
  assert.equal(validVerificationReceipt(result, cases), true)
  assert.deepEqual(result.activeCase, raw.activeCase)
  assert.equal(result.phase, 'cases')
  assert.equal(result.cases[0].passed, true)
  assert.match(result.error, /withheld/u)
  assert.equal(result.cleanupError, raw.cleanupError)
  assert.equal(result.extra, undefined)
  assert(!JSON.stringify(result).includes(secret))
})

test('cross-channel protection withholds expected error text while preserving its mismatch verdict', () => {
  const cases = [{ tool: 'fixture', arguments: {}, isError: true, errorContains: 'expected denial' }]
  // Exercise the receipt protocol independently of the native error matcher.
  const raw = { ok: false, complete: true, phase: 'complete', caseCount: 1, activeCase: null,
    cases: [{ index: 1, tool: 'fixture', passed: false, isError: true,
      failures: ['error-message-mismatch'], errorContains: cases[0].errorContains,
      content: text('different error') }] }
  assert.equal(validVerificationReceipt(raw, cases), true)
  assert.deepEqual(findSecrets(JSON.stringify(raw)), [])
  for (const protection of ['private-key', 'incomplete-process-output']) {
    const projected = protectVerificationReceipt(raw, cases, protection)
    assert.equal(validVerificationReceipt(projected, cases), true)
    assert.equal(projected.complete, true)
    assert.equal(projected.ok, false)
    assert.equal(projected.cases[0].passed, false)
    assert.deepEqual(projected.cases[0].failures, ['error-message-mismatch'])
    assert.equal(projected.cases[0].errorContainsWithheld, true)
    assert.equal(Object.hasOwn(projected.cases[0], 'errorContains'), false)
    assert(!JSON.stringify(projected).includes(cases[0].errorContains))
  }
})

for (const protection of ['private-key', 'incomplete-process-output']) {
  test(`${protection} from the process withholds otherwise clean receipt payload without changing verdicts`, () => {
    const cases = [
      { name: 'matched', tool: 'fixture', arguments: {}, expected: 'ready', resultPath: '/status' },
      { name: 'mismatched', tool: 'fixture', arguments: {}, expected: 'ready', resultPath: '/status', maxResultBytes: 1 },
    ]
    const raw = receipt(cases, [
      { isError: false, value: { status: 'ready' }, content: text('first fragment') },
      { isError: false, value: { status: 'body-fragment' }, content: text('second fragment') },
    ])
    raw.ok = false
    raw.agent = { id: 'native-agent', preset: 'standard' }
    assert.equal(validVerificationReceipt(raw, cases, '/workspace'), true)
    assert.deepEqual(findSecrets(JSON.stringify(raw)), [], 'only the process knows disclosure is unsafe')
    assert.equal(protectVerificationReceipt(raw, cases), raw, 'clean unforced receipts retain explanations')
    const before = structuredClone(raw)
    const protectedResult = protectVerificationReceipt(raw, cases, protection)
    assert.equal(validVerificationReceipt(protectedResult, cases, '/workspace'), true)
    assert.equal(protectedResult.complete, true)
    assert.equal(protectedResult.ok, false)
    assert.equal(protectedResult.phase, 'complete')
    assert.equal(protectedResult.caseCount, 2)
    assert.deepEqual(protectedResult.outputProtection, { withheld: true, reason: protection })
    assert.deepEqual(protectedResult.agent, { id: '[withheld]', preset: null, metadataWithheld: true })
    assert.notEqual(protectedResult.scope, raw.scope)
    for (const [index, observed] of protectedResult.cases.entries()) {
      const original = raw.cases[index]
      for (const key of ['index', 'tool', 'name', 'passed', 'failures', 'isError',
        'valueBytes', 'contentBytes', 'resultBytes', 'maxResultBytes', 'outputLimitExceeded']) {
        assert.deepEqual(observed[key], original[key], `${protection}: preserve ${key}`)
      }
      for (const key of ['value', 'content', 'expected', 'resultPath']) {
        assert.equal(Object.hasOwn(observed, key), false)
        assert.equal(observed[key + 'Withheld'], Object.hasOwn(original, key) ? true : undefined)
      }
    }
    assert.deepEqual(raw, before, 'projection does not rewrite the evidence used for comparisons')
    assert(!JSON.stringify(protectedResult).includes('body-fragment'))
    assert(!JSON.stringify(protectedResult).includes('second fragment'))
  })
}
