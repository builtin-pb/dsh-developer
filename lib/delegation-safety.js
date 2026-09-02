import { createHash } from 'node:crypto'

const TARGET_TOOLS = Object.freeze(['bash', 'pwsh', 'edit', 'write'])
const TARGET_SET = new Set(TARGET_TOOLS)
const ESCALATION_FIELDS = Object.freeze(['sandbox_permissions', 'justification'])
const ESCALATION_BLOCK = ' Attempting a command the sandbox may deny is safe and expected:'
const FIXED_SCOPE_DESCRIPTION = 'This session has fixed authority; do not request sandbox escalation.'
const FIXED_SCOPE_DENIAL = 'This agent cannot widen its current permission scope. Omit sandbox_permissions and justification; report a denied operation instead.'
const FIXED_SCOPE_MARKER = '[sandbox: authority is fixed for this session — do not request sandbox escalation]'
const PWSH_CAPTURE_ESCALATION = 'do not retry the command another way — escalate the exact command once or restructure it to avoid capturing output.'
const PWSH_CAPTURE_FIXED = 'do not retry the command another way; restructure it to avoid capturing output.'
const ESCALATION_LANGUAGE = /\bescalat(?:e|es|ed|ing|ion)\b/iu
const ESCALATION_HINT = /\[sandbox: escalation available — retry this exact (?:command|operation) once with sandbox_permissions \(the narrowest wider mode that suffices\) \+ justification; the approval prompt asks the user\]/gu

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

function eventValue(events, type, key) {
  if (!Array.isArray(events)) return null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== type) continue
    const value = event?.data?.[key]
    return nonEmptyString(value) ? value : null
  }
  return null
}

function serviceValue(read) {
  try {
    const value = read()
    return nonEmptyString(value) ? value : null
  } catch {
    return null
  }
}

export function resolveAuthorityStateFromSources(authoritySources, agent) {
  const identity = delegatedIdentity(agent)
  const session = agent?.session
  const events = session?.events
  const loggedSandbox = eventValue(events, 'sandbox/mode', 'mode')
  const loggedApproval = eventValue(events, 'approval/policy', 'policy')
  const sandboxMode = loggedSandbox ?? serviceValue(
    () => authoritySources?.sandboxPolicy?.()?.resolve?.({ session })?.mode,
  )
  const approvalPolicy = loggedApproval ?? serviceValue(
    () => {
      const approval = authoritySources?.approval?.()
      return approval?.overrideOf?.(session) ?? approval?.config?.policy
    },
  )
  const reasons = [
    ...identity.delegated ? ['delegated-child'] : [],
    ...approvalPolicy === 'never' ? ['approval-disabled'] : [],
    ...sandboxMode === 'danger-full-access' ? ['maximum-sandbox'] : [],
  ]
  return {
    ...identity,
    sandboxMode,
    approvalPolicy,
    fixed: reasons.length > 0,
    reasons,
  }
}

export function resolveAuthorityState(ctx, agent) {
  return resolveAuthorityStateFromSources({
    sandboxPolicy: () => ctx?.get?.('sandboxPolicy'),
    approval: () => ctx?.get?.('approval'),
  }, agent)
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
  if (typeof description !== 'string') throw new TypeError('fixed-authority tool description must be a string')
  let safe = description
  const boundary = safe.indexOf(ESCALATION_BLOCK)
  if (boundary >= 0) {
    safe = safe.slice(0, boundary).trimEnd()
  }
  safe = safe.replace(PWSH_CAPTURE_ESCALATION, PWSH_CAPTURE_FIXED)
  if (ESCALATION_FIELDS.some((field) => safe.includes(field))) {
    throw new TypeError('fixed-authority tool description still advertises escalation fields')
  }
  if (ESCALATION_LANGUAGE.test(safe.replaceAll(FIXED_SCOPE_DESCRIPTION, ''))) {
    throw new TypeError('fixed-authority tool description still advertises escalation')
  }
  if (safe.includes(FIXED_SCOPE_DESCRIPTION)) return safe
  return safe.trimEnd() + ' ' + FIXED_SCOPE_DESCRIPTION
}

export function sanitizeEscalationArguments(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  if (!ESCALATION_FIELDS.some((field) => Object.hasOwn(value, field))) return value
  return Object.freeze(Object.fromEntries(
    Object.entries(value).filter(([field]) => !ESCALATION_FIELDS.includes(field)),
  ))
}

function correctFixedScopeContent(content) {
  if (!Array.isArray(content)) return content
  let changed = false
  const corrected = content.map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block
    const text = block.text.replace(ESCALATION_HINT, FIXED_SCOPE_MARKER)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? corrected : content
}

function correctedOutput(definition) {
  const output = definition.output
  if (output === null || typeof output !== 'object' || typeof output.render !== 'function') {
    throw new TypeError('fixed-authority tool output contract is unavailable')
  }
  return {
    ...output,
    render(args, value) {
      return output.render.call(output, sanitizeEscalationArguments(args), value)
    },
    ...typeof output.presentationMeta === 'function' ? {
      presentationMeta(args, value) {
        return output.presentationMeta.call(output, sanitizeEscalationArguments(args), value)
      },
    } : {},
  }
}

export function createFixedAuthorityToolShadow(definition) {
  if (definition === null || typeof definition !== 'object' || !TARGET_SET.has(definition.name)) {
    throw new TypeError('fixed-authority tool shadow requires a recognized tool definition')
  }
  if (typeof definition.execute !== 'function') {
    throw new TypeError('fixed-authority tool execution contract is unavailable')
  }
  const properties = parameterProperties(definition)
  if (properties === undefined) throw new TypeError('fixed-authority tool parameters must be an object JSON schema')
  const exposed = escalationFields(properties)
  if (exposed.length === 1) {
    throw new TypeError('fixed-authority tool exposes only part of the escalation argument pair')
  }
  const parameters = structuredClone(definition.parameters)
  for (const field of ESCALATION_FIELDS) delete parameters.properties[field]
  if (parameters.required !== undefined && !Array.isArray(parameters.required)) {
    throw new TypeError('fixed-authority tool required fields must be an array')
  }
  if (parameters.required !== undefined) {
    parameters.required = parameters.required.filter((field) => !ESCALATION_FIELDS.includes(field))
  }
  const residual = JSON.stringify(parameters)
  if (ESCALATION_FIELDS.some((field) => residual.includes(field))) {
    throw new TypeError('fixed-authority tool parameters still advertise escalation fields')
  }
  const output = correctedOutput(definition)
  const originalFinalizer = definition.finalizeContent
  return {
    ...definition,
    description: fixedScopeDescription(definition.description),
    parameters,
    output,
    async execute(args, exec) {
      return await definition.execute.call(definition, sanitizeEscalationArguments(args), exec)
    },
    finalizeContent(exec, result) {
      let preferred
      if (typeof originalFinalizer === 'function') {
        try {
          preferred = originalFinalizer.call(definition, exec, result)
        } catch {
          preferred = undefined
        }
      }
      const base = preferred === undefined ? result.content : preferred
      const corrected = correctFixedScopeContent(base)
      return preferred !== undefined || corrected !== base ? corrected : undefined
    },
    ...typeof definition.isConcurrencySafe === 'function' ? {
      isConcurrencySafe(args) {
        return definition.isConcurrencySafe.call(definition, sanitizeEscalationArguments(args))
      },
    } : {},
    ...typeof definition.presentCall === 'function' ? {
      presentCall(args) {
        return definition.presentCall.call(definition, sanitizeEscalationArguments(args))
      },
    } : {},
    ...typeof definition.presentResult === 'function' ? {
      presentResult(args, result) {
        return definition.presentResult.call(definition, sanitizeEscalationArguments(args), result)
      },
    } : {},
  }
}

export function createDelegatedToolShadow(definition) {
  return createFixedAuthorityToolShadow(definition)
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
  if (!Array.isArray(value)) throw new TypeError('authority inspection requires a tool-schema array')
  return value.filter((schema) => schema !== null
    && typeof schema === 'object'
    && TARGET_SET.has(schema.name))
}

function toolSurface(schema) {
  const properties = parameterProperties(schema)
  const exposed = properties === undefined ? [...ESCALATION_FIELDS] : escalationFields(properties)
  const description = typeof schema.description === 'string' ? schema.description : undefined
  const inspectedDescription = description?.replaceAll(FIXED_SCOPE_DESCRIPTION, '')
  const guidance = description === undefined
    ? ['uninspectable-description']
    : [
        ...ESCALATION_FIELDS.filter((field) => inspectedDescription.includes(field)),
        ...ESCALATION_LANGUAGE.test(inspectedDescription) ? ['escalation-language'] : [],
      ]
  let status
  if (properties === undefined || description === undefined) status = 'uninspectable'
  else if (exposed.length === 1) status = 'partial-drift'
  else if (exposed.length > 0 || guidance.length > 0) status = 'escalation-advertised'
  else status = 'fixed-scope'
  return {
    name: schema.name,
    status,
    exposed,
    guidance,
  }
}

function inspectSafety(value, state, kind, applies) {
  const tools = usableSchemas(value)
    .map(toolSurface)
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  const unsafe = tools.filter((tool) => tool.status !== 'fixed-scope')
  const checks = [{
    id: 'agent-scope',
    status: state.available ? 'PASS' : 'FAIL',
    blocking: true,
    message: state.available
      ? applies
        ? 'The calling session has fixed authority: ' + state.reasons.join(', ') + '.'
        : kind === 'delegation-safety'
          ? 'The calling session is not a delegated child; use authority evidence for other fixed scopes.'
          : 'The calling session is not currently fixed by delegation, disabled approvals, or maximum sandbox mode.'
      : 'The calling agent session header is unavailable.',
  }]
  if (state.available && applies) {
    checks.push({
      id: 'fixed-scope-schema',
      status: unsafe.length === 0 ? 'PASS' : 'FAIL',
      blocking: true,
      message: unsafe.length === 0
        ? 'No recognized shell or mutating file tool advertises authority this session cannot obtain.'
        : 'Fixed-authority tools still advertise impossible escalation: '
          + unsafe.map((tool) => tool.name + ' ('
            + [...tool.exposed, ...tool.guidance].join(', ') + ')').join('; ') + '.',
    })
  }
  const missingCoverage = state.available && applies && tools.length === 0
  checks.push({
    id: 'covered-tools',
    status: missingCoverage ? 'FAIL' : 'INFO',
    blocking: missingCoverage,
    message: missingCoverage
      ? 'No recognized shell or mutating file tool schema is visible in this fixed-authority scope.'
      : tools.length + ' recognized shell or mutating file tool schema(s) are visible in this agent scope.',
  })
  const report = {
    kind,
    version: 2,
    ok: state.available && (!applies || (tools.length > 0 && unsafe.length === 0)),
    applies,
    agent: {
      delegated: state.delegated,
      depth: state.depth,
      hasParent: state.parentSession !== null,
    },
    authority: {
      fixed: applies,
      reasons: applies ? [...state.reasons] : [],
      sandboxMode: state.sandboxMode,
      approvalPolicy: state.approvalPolicy,
    },
    tools,
    checks,
    policy: {
      fixedScope: applies,
      hiddenFields: [...ESCALATION_FIELDS],
      hiddenArgumentHandling: applies ? 'strip-before-upstream-execution' : 'not-applicable',
      denialGuidance: applies ? 'fixed-authority' : 'upstream',
    },
  }
  report.evidenceDigest = digest(report)
  return report
}

export function inspectAuthoritySafetyFromSources(authoritySources, agent, value) {
  const state = resolveAuthorityStateFromSources(authoritySources, agent)
  return inspectSafety(value, state, 'authority-safety', state.fixed)
}

export function inspectAuthoritySafety(ctx, agent, value) {
  return inspectAuthoritySafetyFromSources({
    sandboxPolicy: () => ctx?.get?.('sandboxPolicy'),
    approval: () => ctx?.get?.('approval'),
  }, agent, value)
}

export function inspectDelegationSafety(agent, value) {
  const state = resolveAuthorityState(undefined, agent)
  const delegatedState = {
    ...state,
    fixed: state.delegated,
    reasons: state.delegated ? ['delegated-child'] : [],
  }
  return inspectSafety(value, delegatedState, 'delegation-safety', state.delegated)
}

function formatSafetyReport(report, label) {
  const delegated = report.agent.delegated ?? (label === 'Delegation safety' && report.applies)
  const scope = report.applies
    ? delegated
      ? 'delegated child depth ' + report.agent.depth
      : report.authority?.reasons?.join(', ') ?? 'fixed-authority agent'
    : label === 'Delegation safety' ? 'non-delegated agent' : 'mutable-authority agent'
  const lines = [(report.ok ? 'PASS' : 'FAIL') + ' ' + label + ' (' + scope + ')']
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

export function formatAuthoritySafetyReport(report) {
  return formatSafetyReport(report, 'Authority safety')
}

export function formatDelegationSafetyReport(report) {
  return formatSafetyReport(report, 'Delegation safety')
}

export function registerAuthoritySafetyWithDependencies({
  authoritySources,
  agents,
  tools,
  logger,
  events,
  effect,
}) {
  const installed = new Map()
  const sessionAgents = new Map()
  let internalToolChange = 0

  const mutateTools = (operation) => {
    internalToolChange += 1
    try {
      return operation()
    } finally {
      internalToolChange -= 1
    }
  }

  const disposeAll = (disposers) => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        logger?.warn?.('dsh-developer: fixed-authority disposer failed: ' + (error?.message ?? String(error)))
      }
    }
  }

  const removeRaw = (agent) => {
    const current = installed.get(agent)
    if (current === undefined) return
    installed.delete(agent)
    disposeAll(current.disposers)
  }

  const remove = (agent) => mutateTools(() => { removeRaw(agent) })

  const reconcile = (agent, refresh = false) => {
    const state = resolveAuthorityStateFromSources(authoritySources, agent)
    const current = installed.get(agent)
    if (!state.fixed) {
      remove(agent)
      return
    }
    if (current !== undefined && !refresh) return
    mutateTools(() => {
      if (current !== undefined) removeRaw(agent)
      const disposers = []
      const uncorrected = new Set()
      for (const name of TARGET_TOOLS) {
        const definition = tools.get(name, agent)
        if (definition === undefined) continue
        try {
          disposers.push(agent.ctx.tools.register(createFixedAuthorityToolShadow(definition)))
        } catch (error) {
          uncorrected.add(name)
          logger?.warn?.('dsh-developer: could not correct fixed-authority ' + name + ' schema: ' + error.message)
        }
      }
      if (uncorrected.size > 0) {
        try {
          disposers.push(agent.ctx.tools.guard((exec) => uncorrected.has(exec.name)
            ? delegatedEscalationGuardReason(exec)
            : undefined))
        } catch (error) {
          logger?.warn?.('dsh-developer: could not guard uncorrected fixed-authority tools: '
            + (error?.message ?? String(error)))
        }
      }
      installed.set(agent, { disposers })
    })
  }

  const install = (agent) => {
    sessionAgents.set(agent.session, agent)
    reconcile(agent)
  }

  for (const agent of agents.list()) install(agent)
  events.agentCreated(({ agent }) => { install(agent) })
  events.agentDisposed(({ agent }) => {
    remove(agent)
    sessionAgents.delete(agent.session)
  })
  events.sessionEvent((session, event) => {
    if (event?.type !== 'sandbox/mode' && event?.type !== 'approval/policy') return
    const agent = sessionAgents.get(session)
    if (agent !== undefined) reconcile(agent)
  })
  events.toolsChange(() => {
    if (internalToolChange > 0) return
    for (const agent of sessionAgents.values()) reconcile(agent, true)
  })
  return effect(() => () => {
    for (const agent of [...installed.keys()]) remove(agent)
    sessionAgents.clear()
  }, 'dsh-developer.authoritySafety()')
}

export function registerAuthoritySafety(ctx) {
  return registerAuthoritySafetyWithDependencies({
    authoritySources: {
      sandboxPolicy: () => ctx.get?.('sandboxPolicy'),
      approval: () => ctx.get?.('approval'),
    },
    agents: ctx.agents,
    tools: ctx.tools,
    logger: ctx.logger,
    events: {
      agentCreated: (listener) => ctx.on('agent/created', listener),
      agentDisposed: (listener) => ctx.on('agent/disposed', listener),
      sessionEvent: (listener) => ctx.on('session/event', listener),
      toolsChange: (listener) => ctx.on('tools/change', listener),
    },
    effect: (factory, description) => ctx.effect(factory, description),
  })
}

export function registerDelegationSafety(ctx) {
  return registerAuthoritySafetyWithDependencies({
    authoritySources: {
      sandboxPolicy: () => ctx.get?.('sandboxPolicy'),
      approval: () => ctx.get?.('approval'),
    },
    agents: ctx.agents,
    tools: ctx.tools,
    logger: ctx.logger,
    events: {
      agentCreated: (listener) => ctx.on('agent/created', listener),
      agentDisposed: (listener) => ctx.on('agent/disposed', listener),
      sessionEvent: (listener) => ctx.on('session/event', listener),
      toolsChange: (listener) => ctx.on('tools/change', listener),
    },
    effect: (factory, description) => ctx.effect(factory, description),
  })
}

export const DELEGATION_TARGET_TOOLS = TARGET_TOOLS
export const DELEGATION_ESCALATION_FIELDS = ESCALATION_FIELDS
export const AUTHORITY_TARGET_TOOLS = TARGET_TOOLS
export const AUTHORITY_ESCALATION_FIELDS = ESCALATION_FIELDS
