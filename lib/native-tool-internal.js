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

export function agentProjectRoot(agent, { allowLaunchDirectory = false } = {}) {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd
  if (agent == null && allowLaunchDirectory) return process.cwd()
  throw new DshDeveloperError('HOOK_PROJECT_UNAVAILABLE', 'This operation requires a live Agent project root.')
}

// Absolute selections are explicit; relative selections belong to the Agent's
// workspace. Only human commands without an Agent fall back to launch cwd.
export function resolveNativeSource(source, agent, options) {
  return isAbsolute(source) ? source : resolve(agentProjectRoot(agent, options), source)
}

export const NATIVE_TOOL_NAME = 'dsh_developer'
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

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function parseNativeToolInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DshDeveloperError('TOOL_USAGE', 'dsh_developer input must be one JSON object.')
  }
  if (!NATIVE_TOOL_OPERATIONS.includes(value.operation)) {
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
  if (value.topic !== undefined && !KNOWLEDGE_TOPICS.includes(value.topic)) {
    throw new DshDeveloperError('TOOL_USAGE', 'Choose a documented DSH knowledge topic.')
  }
  if (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 0 || value.limit > 100)) {
    throw new DshDeveloperError('TOOL_USAGE', 'limit must be an integer from 0 through 100.')
  }
  if (value.operation === 'hook-doctor' && value.dialect !== 'codex' && value.dialect !== 'claude-code') {
    throw new DshDeveloperError('TOOL_USAGE', 'dialect must be "codex" or "claude-code".')
  }
  if (value.operation === 'cell-plan') {
    const normalized = validateCellPlanFields(value)
    return { operation: value.operation, ...normalized }
  }
  if ((value.operation === 'cell-run' || value.operation === 'cell-apply' || value.operation === 'cell-discard')
      && !/^sha256:[a-f0-9]{64}$/u.test(value.planDigest)) {
    throw new DshDeveloperError('TOOL_USAGE', 'planDigest must be a sha256 digest.')
  }
  return { ...value }
}

export function formatDoctorReport(report) {
  const lines = [(report.ok ? 'PASS' : 'FAIL') + ' Doctor ' + report.source]
  for (const check of report.checks) {
    if (check.status === 'PASS') continue
    lines.push(check.status + ' ' + check.id + ': ' + check.message)
  }
  if (report.fingerprint) lines.push('Fingerprint: ' + report.fingerprint)
  return lines.join('\n')
}

function renderEnvelope(value) {
  let text
  try {
    if (value.report?.kind === 'dsh-developer-diagnostic') {
      text = value.report.diagnostic.code + ': ' + value.report.diagnostic.message
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
  return appendFirstNextAction(
    text ?? 'DSH Developer returned structured evidence; inspect the canonical tool value.',
    value,
  )
}

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
      if (!['cell-run', 'cell-apply'].includes(args?.operation) || !approvalDeniedResult(result)) return undefined
      const nextActions = deriveNextActions({
        operation: args.operation,
        input: args,
        approvalOutcome: 'denied',
      })
      const text = formatFirstNextAction(nextActions)
      return text.length === 0 ? undefined : [...result.content, { type: 'text', text }]
    },
    async execute(args, exec) {
      const input = parseNativeToolInput(args)
      let value
      try {
        value = await executeOperation(input, {
          signal: exec.signal,
          agent: exec.agent,
          executionToken: exec.token,
          callId: exec.callId,
          parent: exec.parent,
        })
      } catch (error) {
        const diagnostic = asDiagnostic(error)
        const nextActions = deriveNextActions({
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
