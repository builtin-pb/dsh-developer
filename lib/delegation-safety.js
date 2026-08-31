import { createHash } from 'node:crypto'

const TARGET_TOOLS = Object.freeze(['bash', 'pwsh', 'edit', 'write'])
const TARGET_SET = new Set(TARGET_TOOLS)
const ESCALATION_FIELDS = Object.freeze(['sandbox_permissions', 'justification'])
const ESCALATION_BLOCK = ' Attempting a command the sandbox may deny is safe and expected:'
const FIXED_SCOPE_DESCRIPTION = 'This delegated child has a fixed permission scope; a sandbox denial is final for this agent.'
const FIXED_SCOPE_DENIAL = 'This delegated agent cannot widen its permission scope. Omit sandbox_permissions and justification; report a denied operation to the parent instead.'

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

function digest(value) {
  return 'sha256:' + createHash('sha256')
    .update(JSON.stringify(stableValue(value)), 'utf8')
    .digest('hex')
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function delegatedIdentity(agent) {
  const header = agent?.session?.header
  if (header === null || typeof header !== 'object') {
    return { available: false, delegated: false, depth: null, parentSession: null }
  }
  const depth = header.delegationDepth
  const parentSession = header.parentSession
  const delegated = header.origin === 'subagent'
    && Number.isSafeInteger(depth)
    && depth > 0
    && nonEmptyString(parentSession)
  return {
    available: true,
    delegated,
    depth: Number.isSafeInteger(depth) ? depth : null,
    parentSession: nonEmptyString(parentSession) ? parentSession : null,
  }
}

export function isDelegatedAgent(agent) {
  return delegatedIdentity(agent).delegated
}

function parameterProperties(definition) {
  const parameters = definition?.parameters
  if (parameters === null
      || typeof parameters !== 'object'
      || Array.isArray(parameters)
      || parameters.type !== 'object'
      || parameters.properties === null
      || typeof parameters.properties !== 'object'
      || Array.isArray(parameters.properties)) {
    return undefined
  }
  return parameters.properties
}

function escalationFields(properties) {
  return ESCALATION_FIELDS.filter((field) => Object.hasOwn(properties, field))
}

function fixedScopeDescription(description) {
  if (typeof description !== 'string') throw new TypeError('delegated tool description must be a string')
  let safe = description
  if (ESCALATION_FIELDS.some((field) => safe.includes(field))) {
    const boundary = safe.indexOf(ESCALATION_BLOCK)
    if (boundary < 0) {
      throw new TypeError('delegated tool escalation guidance has an unrecognized shape')
    }
    safe = safe.slice(0, boundary).trimEnd()
  }
  if (ESCALATION_FIELDS.some((field) => safe.includes(field))) {
    throw new TypeError('delegated tool description still advertises escalation fields')
  }
  return safe.trimEnd() + ' ' + FIXED_SCOPE_DESCRIPTION
}

export function createDelegatedToolShadow(definition) {
  if (definition === null || typeof definition !== 'object' || !TARGET_SET.has(definition.name)) {
    throw new TypeError('delegated tool shadow requires a recognized tool definition')
  }
  const properties = parameterProperties(definition)
  if (properties === undefined) throw new TypeError('delegated tool parameters must be an object JSON schema')
  const exposed = escalationFields(properties)
  if (exposed.length === 0) return undefined
  if (exposed.length !== ESCALATION_FIELDS.length) {
    throw new TypeError('delegated tool exposes only part of the escalation argument pair')
  }
  const parameters = structuredClone(definition.parameters)
  for (const field of ESCALATION_FIELDS) delete parameters.properties[field]
  if (parameters.required !== undefined && !Array.isArray(parameters.required)) {
    throw new TypeError('delegated tool required fields must be an array')
  }
  if (parameters.required !== undefined) {
    parameters.required = parameters.required.filter((field) => !ESCALATION_FIELDS.includes(field))
  }
  const residual = JSON.stringify(parameters)
  if (ESCALATION_FIELDS.some((field) => residual.includes(field))) {
    throw new TypeError('delegated tool parameters still advertise escalation fields')
  }
  return {
    ...definition,
    description: fixedScopeDescription(definition.description),
    parameters,
  }
}

export function delegatedEscalationGuardReason(exec) {
  if (exec === null || typeof exec !== 'object' || !TARGET_SET.has(exec.name)) return undefined
  const args = exec.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  return ESCALATION_FIELDS.some((field) => Object.hasOwn(args, field))
    ? FIXED_SCOPE_DENIAL
    : undefined
}

function usableSchemas(value) {
  if (!Array.isArray(value)) throw new TypeError('delegation inspection requires a tool-schema array')
  return value.filter((schema) => schema !== null
    && typeof schema === 'object'
    && TARGET_SET.has(schema.name))
}

function toolSurface(schema) {
  const properties = parameterProperties(schema)
  if (properties === undefined) {
    return { name: schema.name, status: 'uninspectable', exposed: [...ESCALATION_FIELDS] }
  }
  const exposed = escalationFields(properties)
  return {
    name: schema.name,
    status: exposed.length === 0 ? 'fixed-scope' : exposed.length === 2 ? 'escalation-advertised' : 'partial-drift',
    exposed,
  }
}

export function inspectDelegationSafety(agent, value) {
  const identity = delegatedIdentity(agent)
  const tools = usableSchemas(value)
    .map(toolSurface)
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  const unsafe = tools.filter((tool) => tool.exposed.length > 0)
  const checks = []
  checks.push({
    id: 'agent-scope',
    status: identity.available ? 'PASS' : 'FAIL',
    blocking: true,
    message: identity.available
      ? identity.delegated
        ? 'The calling session is a durable delegated child with fixed authority.'
        : 'The calling session is not a delegated child; escalation fields remain valid when its approval policy permits them.'
      : 'The calling agent session header is unavailable.',
  })
  if (identity.available && identity.delegated) {
    checks.push({
      id: 'fixed-scope-schema',
      status: unsafe.length === 0 ? 'PASS' : 'FAIL',
      blocking: true,
      message: unsafe.length === 0
        ? 'No recognized shell or mutating file tool advertises authority this child cannot obtain.'
        : 'Fixed-scope tools still advertise escalation fields: '
          + unsafe.map((tool) => tool.name + ' (' + tool.exposed.join(', ') + ')').join('; ') + '.',
    })
  }
  const missingCoverage = identity.available && identity.delegated && tools.length === 0
  checks.push({
    id: 'covered-tools',
    status: missingCoverage ? 'FAIL' : 'INFO',
    blocking: missingCoverage,
    message: missingCoverage
      ? 'No recognized shell or mutating file tool schema is visible in this delegated scope.'
      : tools.length + ' recognized shell or mutating file tool schema(s) are visible in this agent scope.',
  })
  const report = {
    kind: 'delegation-safety',
    version: 1,
    ok: identity.available && (!identity.delegated || (tools.length > 0 && unsafe.length === 0)),
    applies: identity.delegated,
    agent: {
      delegated: identity.delegated,
      depth: identity.depth,
      hasParent: identity.parentSession !== null,
    },
    tools,
    checks,
    policy: {
      fixedScope: identity.delegated,
      hiddenFields: [...ESCALATION_FIELDS],
      runtimeGuard: identity.delegated ? 'deny-escalation-arguments' : 'not-applicable',
    },
  }
  report.evidenceDigest = digest(report)
  return report
}

export function formatDelegationSafetyReport(report) {
  const scope = report.applies
    ? 'delegated child depth ' + report.agent.depth
    : 'top-level or non-delegated agent'
  const lines = [(report.ok ? 'PASS' : 'FAIL') + ' Delegation safety (' + scope + ')']
  for (const item of report.checks) {
    if (item.status === 'PASS') continue
    lines.push(item.status + ' ' + item.id + ': ' + item.message)
  }
  if (report.applies) {
    lines.push('Fixed-scope tools: ' + report.tools.filter((tool) => tool.status === 'fixed-scope').length
      + '/' + report.tools.length)
  }
  lines.push('Evidence: ' + report.evidenceDigest)
  return lines.join('\n')
}

export function registerDelegationSafety(ctx) {
  const installed = new Map()
  const install = (agent) => {
    if (installed.has(agent) || !isDelegatedAgent(agent)) return
    const disposers = [agent.ctx.tools.guard(delegatedEscalationGuardReason)]
    for (const name of TARGET_TOOLS) {
      const definition = ctx.tools.get(name, agent)
      if (definition === undefined) continue
      try {
        const shadow = createDelegatedToolShadow(definition)
        if (shadow !== undefined) disposers.push(agent.ctx.tools.register(shadow))
      } catch (error) {
        ctx.logger?.warn?.('dsh-developer: could not correct delegated ' + name + ' schema: ' + error.message)
      }
    }
    installed.set(agent, () => {
      for (const dispose of disposers.reverse()) dispose()
    })
  }
  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => { installed.delete(agent) })
  return ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'dsh-developer.delegationSafety()')
}

export const DELEGATION_TARGET_TOOLS = TARGET_TOOLS
export const DELEGATION_ESCALATION_FIELDS = ESCALATION_FIELDS
