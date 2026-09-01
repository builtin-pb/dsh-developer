import { formatCapabilityReport } from './capabilities.js'
import { formatCompatibilityMatrix } from './compatibility.js'
import { formatAuthoritySafetyReport, formatDelegationSafetyReport } from './delegation-safety.js'
import { DshDeveloperError } from './errors.js'
import { formatProfilePreflightReport } from './profile-preflight.js'
import { formatUiCapabilityReport } from './ui-capabilities.js'
import { formatUpstreamImpactReport } from './upstream-impact.js'

export const NATIVE_TOOL_NAME = 'dsh_developer'
export const NATIVE_TOOL_OPERATIONS = Object.freeze([
  'authority',
  'capabilities',
  'doctor',
  'preflight',
  'impact',
  'compatibility',
  'delegation',
  'ui',
])

const OPERATION_FIELDS = Object.freeze({
  authority: new Set(),
  capabilities: new Set(),
  doctor: new Set(['source', 'skipRuntime']),
  preflight: new Set(['source', 'profile']),
  impact: new Set(['source', 'releaseDsh', 'previewDsh']),
  compatibility: new Set(['source', 'releaseDsh', 'previewDsh']),
  delegation: new Set(),
  ui: new Set(),
})
const REQUIRED_FIELDS = Object.freeze({
  authority: [],
  capabilities: [],
  doctor: ['source'],
  preflight: ['source'],
  impact: ['source', 'previewDsh'],
  compatibility: ['source', 'previewDsh'],
  delegation: [],
  ui: [],
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
  for (const key of ['source', 'profile', 'releaseDsh', 'previewDsh']) {
    if (value[key] !== undefined && !nonEmptyString(value[key])) {
      throw new DshDeveloperError('TOOL_USAGE', key + ' must be a non-empty string when present.')
    }
  }
  if (value.skipRuntime !== undefined && typeof value.skipRuntime !== 'boolean') {
    throw new DshDeveloperError('TOOL_USAGE', 'skipRuntime must be boolean when present.')
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
  try {
    if (value.operation === 'authority') return formatAuthoritySafetyReport(value.report)
    if (value.operation === 'capabilities') return formatCapabilityReport(value.report)
    if (value.operation === 'doctor') return formatDoctorReport(value.report)
    if (value.operation === 'preflight') return formatProfilePreflightReport(value.report)
    if (value.operation === 'impact') return formatUpstreamImpactReport(value.report)
    if (value.operation === 'compatibility') return formatCompatibilityMatrix(value.report)
    if (value.operation === 'delegation') return formatDelegationSafetyReport(value.report)
    if (value.operation === 'ui') return formatUiCapabilityReport(value.report)
  } catch {
    // The registry validates the canonical envelope. Keep presentation total if a
    // future report shape drifts before its formatter is updated.
  }
  return 'DSH Developer returned structured evidence; inspect the canonical tool value.'
}

export function createNativeToolDefinition(executeOperation) {
  if (typeof executeOperation !== 'function') {
    throw new TypeError('createNativeToolDefinition requires an operation executor')
  }
  return {
    name: NATIVE_TOOL_NAME,
    description: 'Inspect DSH, plugin, fixed-authority agent, and scoped UI-provider evidence without executing arbitrary repository code. Choose authority, capabilities, doctor, preflight, impact, compatibility, delegation, or ui.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [...NATIVE_TOOL_OPERATIONS],
          description: 'Evidence operation to run.',
        },
        source: { type: 'string', description: 'Creator export or plugin directory.' },
        skipRuntime: { type: 'boolean', description: 'Doctor exploration only; never release evidence.' },
        profile: { type: 'string', description: 'Clean DSH profile for preflight; defaults to headless.' },
        releaseDsh: { type: 'string', description: 'Optional release DSH path; defaults to the running DSH.' },
        previewDsh: { type: 'string', description: 'Required preview DSH path for impact or compatibility.' },
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
        },
        required: ['operation', 'ok', 'report'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: renderEnvelope(value) }]
      },
    },
    async execute(args, exec) {
      const input = parseNativeToolInput(args)
      return executeOperation(input, { signal: exec.signal, agent: exec.agent })
    },
  }
}
