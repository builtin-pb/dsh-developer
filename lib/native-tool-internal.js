// @ts-check
/** @import { Agent } from '@deepseek-ai/dsh-agent' */
/** @import { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools' */
/** @import { NativeInput, NativeOperation, OperationExecutor, NativeEnvelope, CellPlanFields } from './native-tool-types.js' */

import { isAbsolute, resolve } from 'node:path'
import { formatCapabilityReport } from './capabilities.js'
import { formatCompatibilityMatrix } from './compatibility.js'
import { formatAuthoritySafetyReport, formatDelegationSafetyReport } from './delegation-safety.js'
import { asDiagnostic, DshDeveloperError } from './errors.js'
import { formatCellWorkflowReport, validateCellPlanFields } from './native-cell-workflow.js'
import { formatHookBridgeReport } from './hook-bridge-doctor.js'
import { formatProfilePreflightReport } from './profile-preflight.js'
import {
  appendFirstNextAction,
  deriveNextActions,
  formatFirstNextAction,
  NEXT_ACTION_SCHEMA,
  withNextActions,
} from './recovery-actions.js'
import { formatUiCapabilityReport } from './ui-capabilities.js'
import { formatUpstreamImpactReport } from './upstream-impact.js'
import { formatProjectReport } from './project.js'
import { formatDshKnowledgeReport, KNOWLEDGE_TOPICS } from './knowledge.js'
import { formatSessionReport } from './session.js'

/**
 * @param {Agent | undefined | null} agent
 * @param {{ allowLaunchDirectory?: boolean }} [options]
 */
export function agentProjectRoot(agent, { allowLaunchDirectory = false } = {}) {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd
  if (agent == null && allowLaunchDirectory) return process.cwd()
  throw new DshDeveloperError('HOOK_PROJECT_UNAVAILABLE', 'This operation requires a live Agent project root.')
}

// Absolute selections are explicit; relative selections belong to the Agent's
// workspace. Only human commands without an Agent fall back to launch cwd.
/**
 * @param {string} source
 * @param {Agent | undefined | null} agent
 * @param {{ allowLaunchDirectory?: boolean }} [options]
 */
export function resolveNativeSource(source, agent, options) {
  return isAbsolute(source) ? source : resolve(agentProjectRoot(agent, options), source)
}

export const NATIVE_TOOL_NAME = 'dsh_developer'
/** @type {readonly NativeOperation[]} */
export const NATIVE_TOOL_OPERATIONS = Object.freeze([
  'project',
  'knowledge',
  'session',
  'authority',
  'capabilities',
  'doctor',
  'hook-doctor',
  'preflight',
  'impact',
  'compatibility',
  'delegation',
  'ui',
  'cell-plan',
  'cell-run',
  'cell-apply',
  'cell-discard',
])

/** @type {Readonly<Record<NativeOperation, ReadonlySet<string>>>} */
const OPERATION_FIELDS = Object.freeze({
  project: new Set(['source']),
  knowledge: new Set(['source', 'topic', 'packageName', 'consumerRoot']),
  session: new Set(['source', 'limit']),
  authority: new Set(),
  capabilities: new Set(),
  doctor: new Set(['source', 'skipRuntime']),
  'hook-doctor': new Set(['source', 'dialect']),
  preflight: new Set(['source', 'profile']),
  impact: new Set(['source', 'releaseDsh', 'previewDsh']),
  compatibility: new Set(['source', 'releaseDsh', 'previewDsh']),
  delegation: new Set(),
  ui: new Set(),
  'cell-plan': new Set(['outcome', 'commands']),
  'cell-run': new Set(['planDigest']),
  'cell-apply': new Set(['planDigest']),
  'cell-discard': new Set(['planDigest']),
})
/** @type {Readonly<Record<NativeOperation, readonly string[]>>} */
const REQUIRED_FIELDS = Object.freeze({
  project: [],
  knowledge: [],
  session: ['source'],
  authority: [],
  capabilities: [],
  doctor: ['source'],
  'hook-doctor': ['source', 'dialect'],
  preflight: ['source'],
  impact: ['source', 'previewDsh'],
  compatibility: ['source', 'previewDsh'],
  delegation: [],
  ui: [],
  'cell-plan': ['outcome'],
  'cell-run': ['planDigest'],
  'cell-apply': ['planDigest'],
  'cell-discard': ['planDigest'],
})

/** @param {unknown} value @returns {value is string} */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {value is NativeOperation} */
function isNativeOperation(value) {
  return typeof value === 'string' && NATIVE_TOOL_OPERATIONS.some(operation => operation === value)
}

/** @param {unknown} value @param {string} key */
function requiredString(value, key) {
  if (!nonEmptyString(value)) throw new DshDeveloperError('TOOL_USAGE', key + ' must be a non-empty string.')
  return value
}

/** @param {unknown} value @param {string} key */
function optionalString(value, key) {
  if (value === undefined) return undefined
  if (!nonEmptyString(value)) throw new DshDeveloperError('TOOL_USAGE', key + ' must be a non-empty string when present.')
  return value
}

/** @param {unknown} value @returns {value is CellPlanFields} */
function isCellPlanFields(value) {
  if (!isRecord(value) || typeof value.outcome !== 'string' || !Array.isArray(value.commands)) return false
  /** @type {unknown[]} */
  const commands = value.commands
  return commands.every(item => isRecord(item) && typeof item.command === 'string'
    && typeof item.timeoutMs === 'number' && Number.isInteger(item.timeoutMs))
}

/** @param {unknown} value @returns {NativeInput} */
export function parseNativeToolInput(value) {
  if (!isRecord(value)) {
    throw new DshDeveloperError('TOOL_USAGE', 'dsh_developer input must be one JSON object.')
  }
  if (!isNativeOperation(value.operation)) {
    throw new DshDeveloperError(
      'TOOL_USAGE',
      'operation must be one of: ' + NATIVE_TOOL_OPERATIONS.join(', ') + '.',
    )
  }
  const allowed = OPERATION_FIELDS[value.operation]
  for (const key of Object.keys(value)) {
    if (key !== 'operation' && !allowed.has(key)) {
      throw new DshDeveloperError(
        'TOOL_USAGE',
        'Field "' + key + '" is not valid for operation "' + value.operation + '".',
      )
    }
  }
  for (const key of REQUIRED_FIELDS[value.operation]) {
    if (!nonEmptyString(value[key])) {
      throw new DshDeveloperError('TOOL_USAGE', key + ' must be a non-empty string.')
    }
  }
  for (const key of ['source', 'profile', 'releaseDsh', 'previewDsh', 'packageName', 'consumerRoot']) {
    if (value[key] !== undefined && !nonEmptyString(value[key])) {
      throw new DshDeveloperError('TOOL_USAGE', key + ' must be a non-empty string when present.')
    }
  }
  if (value.skipRuntime !== undefined && typeof value.skipRuntime !== 'boolean') {
    throw new DshDeveloperError('TOOL_USAGE', 'skipRuntime must be boolean when present.')
  }
  if (value.topic !== undefined && (typeof value.topic !== 'string' || !KNOWLEDGE_TOPICS.includes(value.topic))) {
    throw new DshDeveloperError('TOOL_USAGE', 'Choose a documented DSH knowledge topic.')
  }
  if (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 0 || value.limit > 100)) {
    throw new DshDeveloperError('TOOL_USAGE', 'limit must be an integer from 0 through 100.')
  }
  if (value.operation === 'hook-doctor' && value.dialect !== 'codex' && value.dialect !== 'claude-code') {
    throw new DshDeveloperError('TOOL_USAGE', 'dialect must be "codex" or "claude-code".')
  }
  if (value.operation === 'cell-plan') {
    // The engine enforces command policy and secrets; narrow its unchecked result.
    /** @type {unknown} */
    const normalized = validateCellPlanFields(value)
    if (!isCellPlanFields(normalized)) throw new TypeError('Invalid normalized cell plan fields')
    return { operation: value.operation, ...normalized }
  }
  if ((value.operation === 'cell-run' || value.operation === 'cell-apply' || value.operation === 'cell-discard')
      && (typeof value.planDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.planDigest))) {
    throw new DshDeveloperError('TOOL_USAGE', 'planDigest must be a sha256 digest.')
  }
  // Build each operation from individually narrowed fields. Preserve omission
  // of optional properties, including explicitly supplied undefined values.
  const operation = value.operation
  switch (operation) {
    case 'project':
      return { operation, ...('source' in value ? { source: optionalString(value.source, 'source') } : {}) }
    case 'knowledge':
      return {
        operation,
        ...('source' in value ? { source: optionalString(value.source, 'source') } : {}),
        ...('topic' in value ? { topic: optionalString(value.topic, 'topic') } : {}),
        ...('packageName' in value ? { packageName: optionalString(value.packageName, 'packageName') } : {}),
        ...('consumerRoot' in value ? { consumerRoot: optionalString(value.consumerRoot, 'consumerRoot') } : {}),
      }
    case 'session':
      return { operation, source: requiredString(value.source, 'source'),
        ...('limit' in value ? { limit: value.limit } : {}) }
    case 'authority': case 'capabilities': case 'delegation': case 'ui':
      return { operation }
    case 'doctor':
      return { operation, source: requiredString(value.source, 'source'),
        ...('skipRuntime' in value ? { skipRuntime: value.skipRuntime } : {}) }
    case 'hook-doctor': {
      const dialect = value.dialect
      if (dialect !== 'codex' && dialect !== 'claude-code') throw new DshDeveloperError('TOOL_USAGE', 'dialect must be "codex" or "claude-code".')
      return { operation, source: requiredString(value.source, 'source'), dialect }
    }
    case 'preflight':
      return { operation, source: requiredString(value.source, 'source'),
        ...('profile' in value ? { profile: optionalString(value.profile, 'profile') } : {}) }
    case 'impact': case 'compatibility':
      return { operation, source: requiredString(value.source, 'source'), previewDsh: requiredString(value.previewDsh, 'previewDsh'),
        ...('releaseDsh' in value ? { releaseDsh: optionalString(value.releaseDsh, 'releaseDsh') } : {}) }
    case 'cell-run': case 'cell-apply': case 'cell-discard':
      return { operation, planDigest: requiredString(value.planDigest, 'planDigest') }
  }
}

/** @param {unknown} value @returns {NativeEnvelope} */
export function readNativeEnvelope(value) {
  if (!isRecord(value) || !isNativeOperation(value.operation)
      || typeof value.ok !== 'boolean' || !isRecord(value.report)) {
    throw new TypeError('Native operation must return an operation, boolean ok, and object report')
  }
  return { ...value, operation: value.operation, ok: value.ok, report: value.report }
}

/** @param {unknown} report */
export function formatDoctorReport(report) {
  if (!isRecord(report) || typeof report.ok !== 'boolean' || typeof report.source !== 'string'
      || !Array.isArray(report.checks)) throw new TypeError('Invalid doctor report')
  const lines = [(report.ok ? 'PASS' : 'FAIL') + ' Doctor ' + report.source]
  /** @type {unknown[]} */
  const checks = report.checks
  for (const check of checks) {
    if (!isRecord(check) || typeof check.status !== 'string' || typeof check.id !== 'string'
        || typeof check.message !== 'string') throw new TypeError('Invalid doctor check')
    if (check.status === 'PASS') continue
    lines.push(check.status + ' ' + check.id + ': ' + check.message)
  }
  if (report.fingerprint) lines.push('Fingerprint: ' + report.fingerprint)
  return lines.join('\n')
}

/** @param {unknown} rawValue */
function renderEnvelope(rawValue) {
  /** @type {unknown} */
  let text
  try {
    const value = readNativeEnvelope(rawValue)
    if (value.report?.kind === 'dsh-developer-diagnostic') {
      const diagnostic = value.report.diagnostic
      if (isRecord(diagnostic) && typeof diagnostic.code === 'string' && typeof diagnostic.message === 'string') {
        text = diagnostic.code + ': ' + diagnostic.message
      }
    } else if (value.operation === 'project') text = formatProjectReport(value.report)
    else if (value.operation === 'knowledge') text = formatDshKnowledgeReport(value.report)
    else if (value.operation === 'session') text = formatSessionReport(value.report)
    else if (value.operation === 'authority') text = formatAuthoritySafetyReport(value.report)
    else if (value.operation === 'capabilities') text = formatCapabilityReport(value.report)
    else if (value.operation === 'doctor') text = formatDoctorReport(value.report)
    else if (value.operation === 'hook-doctor') text = formatHookBridgeReport(value.report)
    else if (value.operation === 'preflight') text = formatProfilePreflightReport(value.report)
    else if (value.operation === 'impact') text = formatUpstreamImpactReport(value.report)
    else if (value.operation === 'compatibility') text = formatCompatibilityMatrix(value.report)
    else if (value.operation === 'delegation') text = formatDelegationSafetyReport(value.report)
    else if (value.operation === 'ui') text = formatUiCapabilityReport(value.report)
    else if (value.operation === 'cell-plan'
        || value.operation === 'cell-run'
        || value.operation === 'cell-apply'
        || value.operation === 'cell-discard') text = formatCellWorkflowReport(value.report)
  } catch {
    // The registry validates the canonical envelope. Keep presentation total if a
    // future report shape drifts before its formatter is updated.
  }
  /** @type {unknown} */
  const rendered = appendFirstNextAction(
    typeof text === 'string' ? text : 'DSH Developer returned structured evidence; inspect the canonical tool value.',
    rawValue,
  )
  if (typeof rendered !== 'string') throw new TypeError('Invalid native report rendering')
  return rendered
}

/** @param {Record<string, unknown>} context @returns {unknown[]} */
function recoveryActions(context) {
  /** @type {unknown} */
  const actions = deriveNextActions(context)
  if (!Array.isArray(actions)) throw new TypeError('Invalid native recovery actions')
  return actions
}

/** @param {Readonly<ToolExecutionResult>} result */
function approvalDeniedResult(result) {
  if (result?.isError !== true || typeof result.error?.message !== 'string') return false
  const message = result.error.message
  return message === 'the user rejected tool "dsh_developer"'
    || message === 'approval for tool "dsh_developer" was cancelled'
    || message === 'tool "dsh_developer" requires approval, but no approval channel is available'
    || message === 'tool "dsh_developer" requires approval, but the call has no agent to route it through'
    || message.startsWith('Approve this exact isolated Build plan once.')
    || message.startsWith('Approve this exact staged tree application once.')
    || message.startsWith('CELL_APPROVAL_')
}

/** @param {OperationExecutor} executeOperation @returns {ToolDefinition} */
export function createNativeToolDefinition(executeOperation) {
  if (typeof executeOperation !== 'function') {
    throw new TypeError('createNativeToolDefinition requires an operation executor')
  }
  return {
    name: NATIVE_TOOL_NAME,
    description: 'Inspect projects, exact DSH source knowledge, and exported session diagnostics. Audit plugins, or use the specialized isolated Build workflow. Ordinary project execution uses the host shell and its approval policy; this tool cannot grant execution authority.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [...NATIVE_TOOL_OPERATIONS],
          description: 'Evidence operation to run.',
        },
        source: { type: 'string', description: 'Project, plugin, Creator export, or workspace-confined hook/session file; knowledge accepts a DSH checkout, package directory, or source file.' },
        limit: { type: 'integer', minimum: 0, maximum: 100, description: 'Recent calls to show for session; default 20. Counts cover the complete bounded file.' },
        consumerRoot: { type: 'string', description: 'Physical package directory whose dependency to resolve. Requires packageName; use the originating package root from knowledge evidence. Absolute paths select explicitly; relative paths use the Agent workspace.' },
        topic: { type: 'string', enum: [...KNOWLEDGE_TOPICS], description: 'DSH development topic for knowledge; a selected source package takes priority over topic owner hints. Its checkout must be inside this workspace.' },
        packageName: { type: 'string', description: 'Exact @deepseek-ai/name package; pair with consumerRoot when following an installed declaration import.' },
        skipRuntime: { type: 'boolean', description: 'Doctor exploration only; never release evidence.' },
        dialect: { type: 'string', enum: ['codex', 'claude-code'], description: 'Hook configuration dialect for hook-doctor.' },
        profile: { type: 'string', description: 'Clean DSH profile for preflight; defaults to headless.' },
        releaseDsh: { type: 'string', description: 'Optional release DSH path; defaults to the running DSH.' },
        previewDsh: { type: 'string', description: 'Required preview DSH path for impact or compatibility.' },
        outcome: { type: 'string', maxLength: 1000, description: 'Bounded desired outcome for cell-plan.' },
        commands: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          description: 'One to four exact ordered isolated commands for cell-plan.',
          items: {
            type: 'object',
            properties: {
              command: { type: 'string', minLength: 1, maxLength: 2000 },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 },
            },
            required: ['command'],
            additionalProperties: false,
          },
        },
        planDigest: {
          type: 'string',
          pattern: '^sha256:[a-f0-9]{64}$',
          description: 'Immutable digest returned by cell-plan; the only cell-run, cell-apply, or cell-discard argument.',
        },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: [...NATIVE_TOOL_OPERATIONS] },
          ok: { type: 'boolean' },
          report: { type: 'object', additionalProperties: true },
          nextActions: {
            type: 'array',
            items: NEXT_ACTION_SCHEMA,
          },
        },
        required: ['operation', 'ok', 'report', 'nextActions'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: renderEnvelope(value) }]
      },
    },
    finalizeContent(exec, result) {
      const args = exec.arguments
      if (!isRecord(args) || (args.operation !== 'cell-run' && args.operation !== 'cell-apply')
          || !approvalDeniedResult(result)) return undefined
      const nextActions = recoveryActions({
        operation: args.operation,
        input: args,
        approvalOutcome: 'denied',
      })
      const text = formatFirstNextAction(nextActions)
      return text.length === 0 ? undefined : [...result.content, { type: 'text', text }]
    },
    async execute(args, exec) {
      const input = parseNativeToolInput(args)
      /** @type {NativeEnvelope} */
      let value
      try {
        value = readNativeEnvelope(await executeOperation(input, {
          signal: exec.signal,
          agent: exec.agent,
          executionToken: exec.token,
          callId: exec.callId,
          parent: exec.parent,
        }))
      } catch (error) {
        /** @type {unknown} */
        const diagnostic = asDiagnostic(error)
        const nextActions = recoveryActions({
          operation: input.operation,
          input,
          diagnostic,
        })
        if (nextActions.length === 0) throw error
        value = {
          operation: input.operation,
          ok: false,
          report: {
            kind: 'dsh-developer-diagnostic',
            ok: false,
            diagnostic,
          },
        }
      }
      return withNextActions(value, {
        operation: input.operation,
        input,
        report: value.report,
        diagnostic: value.report?.diagnostic,
      })
    },
  }
}
