import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDelegatedToolShadow,
  delegatedEscalationGuardReason,
  formatDelegationSafetyReport,
  inspectDelegationSafety,
  isDelegatedAgent,
  registerDelegationSafety,
} from '../lib/delegation-safety.js'

function agent(header = {}) {
  return { session: { header } }
}

function delegatedHeader(depth = 1) {
  return { origin: 'subagent', delegationDepth: depth, parentSession: 'parent-session' }
}

function schema(name, fields = ['sandbox_permissions', 'justification']) {
  return {
    name,
    description: name + ' tool',
    parameters: {
      type: 'object',
      properties: Object.fromEntries(fields.map((field) => [field, { type: 'string' }])),
      required: [...fields],
      additionalProperties: false,
    },
  }
}

test('classifies only durable subagent lineage as delegated', () => {
  assert.equal(isDelegatedAgent(agent(delegatedHeader())), true)
  assert.equal(isDelegatedAgent(agent({ ...delegatedHeader(), delegationDepth: 0 })), false)
  assert.equal(isDelegatedAgent(agent({ ...delegatedHeader(), parentSession: undefined })), false)
  assert.equal(isDelegatedAgent(agent({ ...delegatedHeader(), origin: undefined })), false)
  assert.equal(isDelegatedAgent(undefined), false)
})

test('shadows a recognized tool without escalation fields or guidance', async () => {
  const execute = async () => ({ ok: true })
  const output = { schema: { type: 'object', properties: {} }, render() { return [] } }
  const definition = {
    ...schema('bash'),
    description: 'Execute a command. Attempting a command the sandbox may deny is safe and expected: retry with `sandbox_permissions` plus `justification`.',
    execute,
    output,
  }
  const shadow = createDelegatedToolShadow(definition)
  assert.equal(shadow.execute, execute)
  assert.equal(shadow.output, output)
  assert.deepEqual(Object.keys(shadow.parameters.properties), [])
  assert.deepEqual(shadow.parameters.required, [])
  assert.doesNotMatch(shadow.description, /sandbox_permissions|justification/u)
  assert.match(shadow.description, /fixed permission scope/u)
  assert.ok(Object.hasOwn(definition.parameters.properties, 'sandbox_permissions'))
  assert.deepEqual(await shadow.execute(), { ok: true })
})

test('does not shadow an already-correct surface and rejects partial drift', () => {
  assert.equal(createDelegatedToolShadow(schema('write', [])), undefined)
  assert.throws(
    () => createDelegatedToolShadow(schema('edit', ['sandbox_permissions'])),
    /only part of the escalation argument pair/u,
  )
  const nested = schema('edit')
  nested.parameters.allOf = [{ required: ['sandbox_permissions'] }]
  assert.throws(
    () => createDelegatedToolShadow(nested),
    /parameters still advertise escalation fields/u,
  )
  assert.throws(() => createDelegatedToolShadow(schema('read')), /recognized tool definition/u)
})

test('guard denies hidden escalation arguments only on protected tools', () => {
  assert.match(
    delegatedEscalationGuardReason({ name: 'pwsh', arguments: { sandbox_permissions: 'workspace-write' } }),
    /cannot widen/u,
  )
  assert.match(
    delegatedEscalationGuardReason({ name: 'write', arguments: { justification: '' } }),
    /report a denied operation/u,
  )
  assert.equal(delegatedEscalationGuardReason({ name: 'bash', arguments: { command: 'pwd' } }), undefined)
  assert.equal(delegatedEscalationGuardReason({ name: 'third_party', arguments: { justification: '' } }), undefined)
})

test('delegation evidence fails exposed child schemas but treats top-level exposure as valid', () => {
  const unsafe = [schema('bash'), schema('write')]
  const child = inspectDelegationSafety(agent(delegatedHeader(2)), unsafe)
  assert.equal(child.ok, false)
  assert.equal(child.applies, true)
  assert.equal(child.tools[0].status, 'escalation-advertised')
  assert.match(formatDelegationSafetyReport(child), /^FAIL Delegation safety \(delegated child depth 2\)/u)

  const top = inspectDelegationSafety(agent({}), unsafe)
  assert.equal(top.ok, true)
  assert.equal(top.applies, false)
  assert.match(formatDelegationSafetyReport(top), /^PASS Delegation safety \(top-level/u)
})

test('delegation evidence is stable after fixed-scope projection regardless of schema order', () => {
  const safe = [schema('write', []), schema('bash', [])]
  const first = inspectDelegationSafety(agent(delegatedHeader()), safe)
  const second = inspectDelegationSafety(agent(delegatedHeader()), [...safe].reverse())
  assert.equal(first.ok, true)
  assert.equal(first.evidenceDigest, second.evidenceDigest)
  assert.match(first.evidenceDigest, /^sha256:[a-f0-9]{64}$/u)
})

test('delegation evidence fails closed when a child has no covered tool schema', () => {
  const report = inspectDelegationSafety(agent(delegatedHeader()), [])
  assert.equal(report.ok, false)
  assert.equal(report.applies, true)
  const coverage = report.checks.find((value) => value.id === 'covered-tools')
  assert.equal(coverage.status, 'FAIL')
  assert.equal(coverage.blocking, true)
})

test('installs child-scoped shadows and a guard without changing top-level schemas', () => {
  const definitions = new Map([
    ['bash', { ...schema('bash'), execute() {}, output: { schema: {}, render() {} } }],
    ['write', { ...schema('write'), execute() {}, output: { schema: {}, render() {} } }],
  ])
  const topRegistrations = []
  const childRegistrations = []
  const guards = []
  function scopedAgent(header, registrations) {
    return {
      session: { header },
      ctx: {
        tools: {
          register(value) {
            registrations.push(value)
            return () => {}
          },
          guard(value) {
            guards.push(value)
            return () => {}
          },
        },
      },
    }
  }
  const top = scopedAgent({}, topRegistrations)
  const child = scopedAgent(delegatedHeader(), childRegistrations)
  const listeners = new Map()
  const ctx = {
    agents: { list: () => [top, child] },
    tools: { get: (name) => definitions.get(name) },
    on(name, callback) { listeners.set(name, callback) },
    effect(factory) {
      const dispose = factory()
      return dispose
    },
    logger: { warn() {} },
  }
  const dispose = registerDelegationSafety(ctx)
  assert.equal(topRegistrations.length, 0)
  assert.deepEqual(childRegistrations.map((value) => value.name), ['bash', 'write'])
  assert.equal(guards.length, 1)
  assert.ok(childRegistrations.every((value) => !Object.hasOwn(value.parameters.properties, 'sandbox_permissions')))

  const later = scopedAgent(delegatedHeader(2), [])
  listeners.get('agent/created')({ agent: later })
  assert.equal(guards.length, 2)
  listeners.get('agent/disposed')({ agent: later })
  dispose()
})
