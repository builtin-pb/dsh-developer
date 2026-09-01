import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createFixedAuthorityToolShadow,
  createDelegatedToolShadow,
  delegatedEscalationGuardReason,
  formatAuthoritySafetyReport,
  formatDelegationSafetyReport,
  inspectAuthoritySafety,
  inspectDelegationSafety,
  isDelegatedAgent,
  registerAuthoritySafety,
  registerDelegationSafety,
  resolveAuthorityState,
  sanitizeEscalationArguments,
} from '../lib/delegation-safety.js'

function agent(header = {}, events = []) {
  return { session: { header, events } }
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
    output: {
      schema: { type: 'object', properties: {} },
      render() { return [] },
    },
    async execute(args) { return args },
  }
}

test('classifies only durable subagent lineage as delegated', () => {
  assert.equal(isDelegatedAgent(agent(delegatedHeader())), true)
  assert.equal(isDelegatedAgent(agent({ ...delegatedHeader(), delegationDepth: 0 })), false)
  assert.equal(isDelegatedAgent(agent({ ...delegatedHeader(), parentSession: undefined })), false)
  assert.equal(isDelegatedAgent(agent({ ...delegatedHeader(), origin: undefined })), false)
  assert.equal(isDelegatedAgent(undefined), false)
})

test('shadows a recognized tool and strips impossible arguments before upstream execution', async () => {
  let received
  const execute = async (args) => {
    received = args
    return { ok: true }
  }
  let renderedArgs
  const output = {
    schema: { type: 'object', properties: {} },
    render(args) {
      renderedArgs = args
      return []
    },
  }
  const definition = {
    ...schema('bash'),
    description: 'Execute a command. That EPERM is the documented boundary: do not retry the command another way — escalate the exact command once or restructure it to avoid capturing output. Attempting a command the sandbox may deny is safe and expected: retry with `sandbox_permissions` plus `justification`.',
    execute,
    output,
  }
  const shadow = createDelegatedToolShadow(definition)
  assert.notEqual(shadow.execute, execute)
  assert.notEqual(shadow.output, output)
  assert.deepEqual(Object.keys(shadow.parameters.properties), [])
  assert.deepEqual(shadow.parameters.required, [])
  assert.doesNotMatch(shadow.description, /sandbox_permissions|justification/u)
  assert.doesNotMatch(shadow.description, /escalate the exact command/u)
  assert.match(shadow.description, /restructure it to avoid capturing output/u)
  assert.match(shadow.description, /fixed authority/u)
  assert.ok(Object.hasOwn(definition.parameters.properties, 'sandbox_permissions'))
  assert.deepEqual(await shadow.execute({ command: 'pwd', sandbox_permissions: 'workspace-write', justification: 'why' }), { ok: true })
  assert.deepEqual(received, { command: 'pwd' })
  shadow.output.render({ command: 'pwd', sandbox_permissions: 'workspace-write', justification: 'why' }, {})
  assert.deepEqual(renderedArgs, { command: 'pwd' })
})

test('keeps an already-correct surface sanitized and rejects partial drift', async () => {
  const corrected = createFixedAuthorityToolShadow(schema('write', []))
  assert.deepEqual(corrected.parameters.properties, {})
  assert.deepEqual(await corrected.execute({ file_path: 'a', justification: 'stale' }), { file_path: 'a' })
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

test('rewrites upstream denial hints at the final model-facing boundary', () => {
  const definition = schema('pwsh')
  const shadow = createFixedAuthorityToolShadow(definition)
  const hint = '[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'
  const result = { content: [{ type: 'text', text: 'denied\n' + hint }], isError: false }
  const content = shadow.finalizeContent({ arguments: {} }, result)
  assert.doesNotMatch(content[0].text, /escalation available/u)
  assert.match(content[0].text, /authority is fixed/u)
})

test('sanitizes only the paired escalation keys', () => {
  const untouched = { command: 'pwd' }
  assert.equal(sanitizeEscalationArguments(untouched), untouched)
  assert.deepEqual(sanitizeEscalationArguments({
    command: 'pwd', sandbox_permissions: 'workspace-write', justification: 'why', timeoutMs: 10,
  }), { command: 'pwd', timeoutMs: 10 })
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
  assert.match(formatDelegationSafetyReport(top), /^PASS Delegation safety \(non-delegated/u)
})

test('authority evidence applies to approval-disabled and maximum-sandbox top-level sessions', () => {
  const unsafe = [schema('pwsh'), schema('write')]
  const ctx = { get() {} }
  const never = agent({}, [{ type: 'approval/policy', data: { policy: 'never' } }])
  const neverReport = inspectAuthoritySafety(ctx, never, unsafe)
  assert.equal(neverReport.applies, true)
  assert.equal(neverReport.ok, false)
  assert.deepEqual(neverReport.authority.reasons, ['approval-disabled'])

  const maximum = agent({}, [{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }])
  const fixedSchemas = unsafe.map(createFixedAuthorityToolShadow)
  const maximumReport = inspectAuthoritySafety(ctx, maximum, fixedSchemas)
  assert.equal(maximumReport.ok, true)
  assert.deepEqual(maximumReport.authority.reasons, ['maximum-sandbox'])
  assert.match(formatAuthoritySafetyReport(maximumReport), /^PASS Authority safety/u)
})

test('authority evidence fails description-only escalation guidance', () => {
  const misleading = schema('pwsh', [])
  misleading.description = 'Retry by escalating the exact command.'
  const maximum = agent({}, [{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }])
  const report = inspectAuthoritySafety({ get() {} }, maximum, [misleading])
  assert.equal(report.ok, false)
  assert.equal(report.tools[0].status, 'escalation-advertised')
  assert.deepEqual(report.tools[0].exposed, [])
  assert.deepEqual(report.tools[0].guidance, ['escalation-language'])
})

test('authority state prefers durable events and falls back to composed services', () => {
  const composed = agent()
  const ctx = {
    get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
      if (name === 'approval') return { config: { policy: 'ask' } }
    },
  }
  assert.deepEqual(resolveAuthorityState(ctx, composed).reasons, [])
  composed.session.events.push({ type: 'approval/policy', data: { policy: 'never' } })
  assert.deepEqual(resolveAuthorityState(ctx, composed).reasons, ['approval-disabled'])
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

test('installs child-scoped shadows without changing mutable top-level schemas', () => {
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
    get() {},
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
  assert.equal(guards.length, 0)
  assert.ok(childRegistrations.every((value) => !Object.hasOwn(value.parameters.properties, 'sandbox_permissions')))

  const later = scopedAgent(delegatedHeader(2), [])
  listeners.get('agent/created')({ agent: later })
  assert.equal(guards.length, 0)
  listeners.get('agent/disposed')({ agent: later })
  dispose()
})

test('guards a fixed scope when schema drift prevents safe shadowing', () => {
  const partial = schema('write', ['sandbox_permissions'])
  const guards = []
  const warnings = []
  const child = {
    session: { header: delegatedHeader(), events: [] },
    ctx: {
      tools: {
        register() { throw new Error('must not register partial schema') },
        guard(value) {
          guards.push(value)
          return () => {}
        },
      },
    },
  }
  const ctx = {
    agents: { list: () => [child] },
    tools: { get: (name) => name === 'write' ? partial : undefined },
    get() {},
    on() {},
    effect(factory) { return factory() },
    logger: { warn(message) { warnings.push(message) } },
  }
  const dispose = registerAuthoritySafety(ctx)
  assert.equal(guards.length, 1)
  assert.match(guards[0]({ name: 'write', arguments: { justification: 'stale' } }), /cannot widen/u)
  assert.equal(guards[0]({ name: 'write', arguments: { file_path: 'a' } }), undefined)
  assert.match(warnings[0], /only part of the escalation argument pair/u)
  dispose()
})

test('reconciles top-level shadows when permission events fix and release authority', () => {
  const definition = schema('write')
  const registrations = []
  const listeners = new Map()
  const top = {
    session: { header: {}, events: [] },
    ctx: {
      tools: {
        register(value) {
          const entry = { value, active: true }
          registrations.push(entry)
          return () => { entry.active = false }
        },
        guard() { return () => {} },
      },
    },
  }
  const ctx = {
    agents: { list: () => [top] },
    tools: { get: (name) => name === 'write' ? definition : undefined },
    get() {},
    on(name, callback) { listeners.set(name, callback) },
    effect(factory) { return factory() },
    logger: { warn() {} },
  }
  const dispose = registerAuthoritySafety(ctx)
  assert.equal(registrations.length, 0)

  top.session.events.push({ type: 'sandbox/mode', data: { mode: 'danger-full-access' } })
  listeners.get('session/event')(top.session, top.session.events.at(-1))
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].active, true)

  top.session.events.push({ type: 'sandbox/mode', data: { mode: 'workspace-write' } })
  listeners.get('session/event')(top.session, top.session.events.at(-1))
  assert.equal(registrations[0].active, false)
  dispose()
})

test('refreshes fixed-authority shadows after live tool recomposition', async () => {
  let generation = 1
  const listeners = new Map()
  const registrations = []
  const definitions = () => ({
    ...schema('write'),
    async execute() { return { generation } },
  })
  const top = {
    session: {
      header: {},
      events: [{ type: 'approval/policy', data: { policy: 'never' } }],
    },
    ctx: {
      tools: {
        register(value) {
          const entry = { value, active: true }
          registrations.push(entry)
          return () => { entry.active = false }
        },
        guard() { return () => {} },
      },
    },
  }
  const ctx = {
    agents: { list: () => [top] },
    tools: { get: (name) => name === 'write' ? definitions() : undefined },
    get() {},
    on(name, callback) { listeners.set(name, callback) },
    effect(factory) { return factory() },
    logger: { warn() {} },
  }
  const dispose = registerAuthoritySafety(ctx)
  assert.equal(registrations.length, 1)
  assert.deepEqual(await registrations[0].value.execute({}), { generation: 1 })

  generation = 2
  listeners.get('tools/change')()
  assert.equal(registrations[0].active, false)
  assert.equal(registrations[1].active, true)
  assert.deepEqual(await registrations[1].value.execute({}), { generation: 2 })
  dispose()
})
