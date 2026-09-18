// @ts-check
import { createHash } from 'node:crypto'

/**
 * @import { Context, Disposable } from '@deepseek-ai/cordis'
 * @import { Agent } from '@deepseek-ai/dsh-agent'
 * @import { ToolDefinition, ToolOutputDefinition, ToolResult, ToolExecution } from '@deepseek-ai/dsh-tools'
 * @import { AuthoritySources, AuthoritySafetyDependencies, AgentSession } from './delegation-types.js'
 */

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

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object'
}

/** @param {unknown} value @returns {value is unknown[]} */
function isUnknownArray(value) {
  return Array.isArray(value)
}

/** @param {unknown} value @returns {unknown} */
function stableValue(value) {
  if (isUnknownArray(value)) return value.map(stableValue)
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

/** @param {unknown} value */
function digest(value) {
  return 'sha256:' + createHash('sha256')
    .update(JSON.stringify(stableValue(value)), 'utf8')
    .digest('hex')
}

/** @param {unknown} value @returns {value is string} */
function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/** @param {Agent | undefined} agent */
function delegatedIdentity(agent) {
  const header = agent?.session?.header
  if (header === null || typeof header !== 'object') {
    return { available: false, delegated: false, depth: null, parentSession: null }
  }
  const depth = header.delegationDepth
  const parentSession = header.parentSession
  const delegated = header.origin === 'subagent'
    && typeof depth === 'number'
    && Number.isSafeInteger(depth)
    && depth > 0
    && nonEmptyString(parentSession)
  return {
    available: true,
    delegated,
    depth: typeof depth === 'number' && Number.isSafeInteger(depth) ? depth : null,
    parentSession: nonEmptyString(parentSession) ? parentSession : null,
  }
}

/** @param {Agent | undefined} agent */
export function isDelegatedAgent(agent) {
  return delegatedIdentity(agent).delegated
}

/** @param {unknown} events @param {string} type @param {string} key */
function eventValue(events, type, key) {
  if (!isUnknownArray(events)) return null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!isRecord(event) || event.type !== type) continue
    const value = isRecord(event.data) ? event.data[key] : undefined
    return nonEmptyString(value) ? value : null
  }
  return null
}

/** @param {() => string | undefined} read */
function serviceValue(read) {
  try {
    const value = read()
    return nonEmptyString(value) ? value : null
  } catch {
    return null
  }
}

/** @param {AuthoritySources | undefined} authoritySources @param {Agent | undefined} agent */
export function resolveAuthorityStateFromSources(authoritySources, agent) {
  const identity = delegatedIdentity(agent)
  const session = agent?.session
  // Older hosts expose the log directly; current upstream exposes a snapshot.
  const events = session && 'events' in session ? session.events : session?.snapshotEvents?.()
  const loggedSandbox = eventValue(events, 'sandbox/mode', 'mode')
  const loggedApproval = eventValue(events, 'approval/policy', 'policy')
  const sandboxMode = loggedSandbox ?? serviceValue(
    () => authoritySources?.sandboxPolicy?.()?.resolve?.({ session })?.mode,
  )
  const approvalPolicy = loggedApproval ?? serviceValue(
    () => {
      const approval = authoritySources?.approval?.()
      return (session === undefined ? undefined : approval?.overrideOf?.(session)) ?? approval?.config?.policy
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

/** @param {Context | undefined} ctx @param {Agent | undefined} agent */
export function resolveAuthorityState(ctx, agent) {
  return resolveAuthorityStateFromSources({
    sandboxPolicy: () => ctx?.get?.(/** @satisfies {keyof Context} */ ('sandboxPolicy')),
    approval: () => ctx?.get?.(/** @satisfies {keyof Context} */ ('approval')),
  }, agent)
}

/** @param {unknown} definition */
function parameterProperties(definition) {
  const parameters = isRecord(definition) ? definition.parameters : undefined
  if (!isRecord(parameters)
      || Array.isArray(parameters)
      || parameters.type !== 'object'
      || !isRecord(parameters.properties)
      || Array.isArray(parameters.properties)) {
    return undefined
  }
  return parameters.properties
}

/** @param {Record<string, unknown>} properties */
function escalationFields(properties) {
  return ESCALATION_FIELDS.filter((field) => Object.hasOwn(properties, field))
}

/** @param {unknown} description */
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

/** @param {unknown} value @returns {unknown} */
export function sanitizeEscalationArguments(value) {
  if (!isRecord(value) || Array.isArray(value)) return value
  if (!ESCALATION_FIELDS.some((field) => Object.hasOwn(value, field))) return value
  return Object.freeze(Object.fromEntries(
    Object.entries(value).filter(([field]) => !ESCALATION_FIELDS.includes(field)),
  ))
}

/** @param {ToolResult['content']} content @returns {ToolResult['content']} */
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

/** @param {ToolDefinition} definition @returns {ToolOutputDefinition} */
function correctedOutput(definition) {
  const output = definition.output
  if (output === null || typeof output !== 'object' || typeof output.render !== 'function') {
    throw new TypeError('fixed-authority tool output contract is unavailable')
  }
  const presentationMeta = output.presentationMeta
  return {
    ...output,
    render(args, value) {
      return output.render.call(output, sanitizeEscalationArguments(args), value)
    },
    ...typeof presentationMeta === 'function' ? {
      presentationMeta(args, value) {
        return presentationMeta.call(output, sanitizeEscalationArguments(args), value)
      },
    } : {},
  }
}

/** @param {ToolDefinition} definition @returns {ToolDefinition} */
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
  const clonedProperties = parameterProperties({ parameters })
  if (clonedProperties === undefined) throw new TypeError('fixed-authority tool parameters must be an object JSON schema')
  for (const field of ESCALATION_FIELDS) delete clonedProperties[field]
  if (parameters.required !== undefined && !isUnknownArray(parameters.required)) {
    throw new TypeError('fixed-authority tool required fields must be an array')
  }
  if (parameters.required !== undefined) {
    parameters.required = parameters.required.filter((field) => typeof field !== 'string' || !ESCALATION_FIELDS.includes(field))
  }
  const residual = JSON.stringify(parameters)
  if (ESCALATION_FIELDS.some((field) => residual.includes(field))) {
    throw new TypeError('fixed-authority tool parameters still advertise escalation fields')
  }
  const output = correctedOutput(definition)
  const originalFinalizer = definition.finalizeContent
  const isConcurrencySafe = definition.isConcurrencySafe
  const presentCall = definition.presentCall
  const presentResult = definition.presentResult
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
    ...typeof isConcurrencySafe === 'function' ? {
      isConcurrencySafe(args) {
        return isConcurrencySafe.call(definition, sanitizeEscalationArguments(args))
      },
    } : {},
    ...typeof presentCall === 'function' ? {
      presentCall(args) {
        return presentCall.call(definition, sanitizeEscalationArguments(args))
      },
    } : {},
    ...typeof presentResult === 'function' ? {
      presentResult(args, result) {
        return presentResult.call(definition, sanitizeEscalationArguments(args), result)
      },
    } : {},
  }
}

/** @param {ToolDefinition} definition */
export function createDelegatedToolShadow(definition) {
  return createFixedAuthorityToolShadow(definition)
}

/** @param {Readonly<ToolExecution>} exec */
export function delegatedEscalationGuardReason(exec) {
  if (exec === null || typeof exec !== 'object' || !TARGET_SET.has(exec.name)) return undefined
  const args = exec.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  return ESCALATION_FIELDS.some((field) => Object.hasOwn(args, field))
    ? FIXED_SCOPE_DENIAL
    : undefined
}

/** @param {unknown} value */
function usableSchemas(value) {
  if (!isUnknownArray(value)) throw new TypeError('authority inspection requires a tool-schema array')
  return value.filter(/** @returns {schema is Record<string, unknown> & { name: string }} */ (schema) => isRecord(schema)
    && typeof schema.name === 'string'
    && TARGET_SET.has(schema.name))
}

/** @param {Record<string, unknown> & { name: string }} schema */
function toolSurface(schema) {
  const properties = parameterProperties(schema)
  const exposed = properties === undefined ? [...ESCALATION_FIELDS] : escalationFields(properties)
  const description = typeof schema.description === 'string' ? schema.description : undefined
  const inspectedDescription = description?.replaceAll(FIXED_SCOPE_DESCRIPTION, '') ?? ''
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

/**
 * @param {unknown} value
 * @param {ReturnType<typeof resolveAuthorityStateFromSources>} state
 * @param {'authority-safety' | 'delegation-safety'} kind
 * @param {boolean} applies
 */
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
  return { ...report, evidenceDigest: digest(report) }
}

/** @param {AuthoritySources | undefined} authoritySources @param {Agent | undefined} agent @param {unknown} value */
export function inspectAuthoritySafetyFromSources(authoritySources, agent, value) {
  const state = resolveAuthorityStateFromSources(authoritySources, agent)
  return inspectSafety(value, state, 'authority-safety', state.fixed)
}

/** @param {Context | undefined} ctx @param {Agent | undefined} agent @param {unknown} value */
export function inspectAuthoritySafety(ctx, agent, value) {
  return inspectAuthoritySafetyFromSources({
    sandboxPolicy: () => ctx?.get?.(/** @satisfies {keyof Context} */ ('sandboxPolicy')),
    approval: () => ctx?.get?.(/** @satisfies {keyof Context} */ ('approval')),
  }, agent, value)
}

/** @param {Agent | undefined} agent @param {unknown} value */
export function inspectDelegationSafety(agent, value) {
  const state = resolveAuthorityState(undefined, agent)
  const delegatedState = {
    ...state,
    fixed: state.delegated,
    reasons: state.delegated ? ['delegated-child'] : [],
  }
  return inspectSafety(value, delegatedState, 'delegation-safety', state.delegated)
}

/** @param {unknown} report @param {string} label */
function formatSafetyReport(report, label) {
  if (!isRecord(report) || Array.isArray(report)
      || typeof report.ok !== 'boolean' || typeof report.applies !== 'boolean'
      || !isRecord(report.agent) || Array.isArray(report.agent)
      || !isUnknownArray(report.checks) || typeof report.evidenceDigest !== 'string') {
    throw new TypeError('Invalid safety report')
  }
  if (report.agent.delegated != null && typeof report.agent.delegated !== 'boolean') {
    throw new TypeError('Invalid safety report delegation flag')
  }
  // Historical reports omit delegated and authority. Validate only the fields
  // used for this presentation, retaining their existing scope fallbacks.
  const delegated = report.agent.delegated ?? (label === 'Delegation safety' && report.applies)
  let scope
  if (!report.applies) {
    scope = label === 'Delegation safety' ? 'non-delegated agent' : 'mutable-authority agent'
  } else if (delegated) {
    if (report.agent.depth !== null && typeof report.agent.depth !== 'number') {
      throw new TypeError('Invalid safety report delegation depth')
    }
    scope = 'delegated child depth ' + report.agent.depth
  } else {
    scope = 'fixed-authority agent'
    if (report.authority != null) {
      if (!isRecord(report.authority) || Array.isArray(report.authority)) {
        throw new TypeError('Invalid safety report authority')
      }
      const reasons = report.authority.reasons
      if (reasons != null) {
        if (!isUnknownArray(reasons) || !reasons.every((reason) => typeof reason === 'string')) {
          throw new TypeError('Invalid safety report authority reasons')
        }
        scope = reasons.join(', ')
      }
    }
  }
  const lines = [(report.ok ? 'PASS' : 'FAIL') + ' ' + label + ' (' + scope + ')']
  for (const item of report.checks) {
    if (!isRecord(item) || Array.isArray(item) || typeof item.status !== 'string') {
      throw new TypeError('Invalid safety report check')
    }
    if (item.status === 'PASS') continue
    if (typeof item.id !== 'string' || typeof item.message !== 'string') {
      throw new TypeError('Invalid safety report check')
    }
    lines.push(item.status + ' ' + item.id + ': ' + item.message)
  }
  if (report.applies) {
    if (!isUnknownArray(report.tools)) throw new TypeError('Invalid safety report tools')
    let fixedTools = 0
    for (const tool of report.tools) {
      if (!isRecord(tool) || Array.isArray(tool) || typeof tool.status !== 'string') {
        throw new TypeError('Invalid safety report tool')
      }
      if (tool.status === 'fixed-scope') fixedTools += 1
    }
    lines.push('Fixed-scope tools: ' + fixedTools + '/' + report.tools.length)
  }
  lines.push('Evidence: ' + report.evidenceDigest)
  return lines.join('\n')
}

/** @param {unknown} report */
export function formatAuthoritySafetyReport(report) {
  return formatSafetyReport(report, 'Authority safety')
}

/** @param {unknown} report */
export function formatDelegationSafetyReport(report) {
  return formatSafetyReport(report, 'Delegation safety')
}

/** @param {AuthoritySafetyDependencies} dependencies */
export function registerAuthoritySafetyWithDependencies({
  authoritySources,
  agents,
  tools,
  logger,
  events,
  effect,
}) {
  /** @type {Map<Agent, { disposers: Disposable<void>[] }>} */
  const installed = new Map()
  /** @type {Map<AgentSession, Agent>} */
  const sessionAgents = new Map()
  let internalToolChange = 0

  /** @param {() => void} operation */
  const mutateTools = (operation) => {
    internalToolChange += 1
    try {
      return operation()
    } finally {
      internalToolChange -= 1
    }
  }

  /** @param {Disposable<void>[]} disposers */
  const disposeAll = (disposers) => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        logger?.warn?.('dsh-developer: fixed-authority disposer failed: ' + (isRecord(error) ? error.message ?? String(error) : String(error)))
      }
    }
  }

  /** @param {Agent} agent */
  const removeRaw = (agent) => {
    const current = installed.get(agent)
    if (current === undefined) return
    installed.delete(agent)
    disposeAll(current.disposers)
  }

  /** @param {Agent} agent */
  const remove = (agent) => mutateTools(() => { removeRaw(agent) })

  /** @param {Agent} agent @param {boolean} [refresh] */
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
      /** @type {Disposable<void>[]} */
      const disposers = []
      /** @type {Set<string>} */
      const uncorrected = new Set()
      for (const name of TARGET_TOOLS) {
        const definition = tools.get(name, agent)
        if (definition === undefined) continue
        try {
          disposers.push(agent.ctx.tools.register(createFixedAuthorityToolShadow(definition)))
        } catch (error) {
          uncorrected.add(name)
          logger?.warn?.('dsh-developer: could not correct fixed-authority ' + name + ' schema: ' + (isRecord(error) ? error.message : undefined))
        }
      }
      if (uncorrected.size > 0) {
        try {
          disposers.push(agent.ctx.tools.guard((exec) => uncorrected.has(exec.name)
            ? delegatedEscalationGuardReason(exec)
            : undefined))
        } catch (error) {
          logger?.warn?.('dsh-developer: could not guard uncorrected fixed-authority tools: '
            + (isRecord(error) ? error.message ?? String(error) : String(error)))
        }
      }
      installed.set(agent, { disposers })
    })
  }

  /** @param {Agent} agent */
  const install = (agent) => {
    sessionAgents.set(agent.session, agent)
    reconcile(agent)
  }

  for (const agent of agents.list()) install(agent)
  events.agentCreated(({ agent }) => {
    install(agent)
    return undefined
  })
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

/** @param {Context} ctx */
export function registerAuthoritySafety(ctx) {
  return registerAuthoritySafetyWithDependencies({
    authoritySources: {
      sandboxPolicy: () => ctx.get?.(/** @satisfies {keyof Context} */ ('sandboxPolicy')),
      approval: () => ctx.get?.(/** @satisfies {keyof Context} */ ('approval')),
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

/** @param {Context} ctx */
export function registerDelegationSafety(ctx) {
  return registerAuthoritySafetyWithDependencies({
    authoritySources: {
      sandboxPolicy: () => ctx.get?.(/** @satisfies {keyof Context} */ ('sandboxPolicy')),
      approval: () => ctx.get?.(/** @satisfies {keyof Context} */ ('approval')),
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
