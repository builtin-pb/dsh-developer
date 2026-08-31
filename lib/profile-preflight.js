import { DshDeveloperError } from './errors.js'
import { inspectProfilePreflightInternal } from './profile-preflight-internal.js'

const OPTION_KEYS = new Set(['dshPath', 'profile', 'signal'])

function assertSignal(signal) {
  if (signal === undefined) return
  if (signal === null
      || typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function') {
    throw new DshDeveloperError('PROFILE_PREFLIGHT_OPTIONS_INVALID', 'signal must be an AbortSignal when present.')
  }
}

export async function inspectProfilePreflight(source, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new DshDeveloperError('PROFILE_PREFLIGHT_OPTIONS_INVALID', 'Profile preflight options must be an object.')
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new DshDeveloperError('PROFILE_PREFLIGHT_OPTIONS_INVALID', 'Unsupported profile preflight option "' + key + '".')
    }
  }
  if (options.dshPath !== undefined && (typeof options.dshPath !== 'string' || options.dshPath.length === 0)) {
    throw new DshDeveloperError('PROFILE_PREFLIGHT_OPTIONS_INVALID', 'dshPath must be a non-empty DSH path when present.')
  }
  if (options.profile !== undefined && (typeof options.profile !== 'string' || options.profile.length === 0)) {
    throw new DshDeveloperError('PROFILE_PREFLIGHT_OPTIONS_INVALID', 'profile must be a non-empty DSH profile name when present.')
  }
  assertSignal(options.signal)
  return inspectProfilePreflightInternal(source, { ...options, profile: options.profile ?? 'headless' })
}

export function formatProfilePreflightReport(report) {
  const label = report.plugin?.name ?? report.source
  const lines = [
    (report.ok ? 'PASS' : 'FAIL') + ' DSH profile preflight ' + label + ' -> ' + report.profile,
  ]
  for (const value of report.checks) {
    lines.push('  ' + value.status.padEnd(4) + ' ' + value.id + ': ' + value.message)
  }
  lines.push('  REQUIRED ' + (report.requiredServices.length === 0 ? '(none)' : report.requiredServices.join(', ')))
  lines.push('Evidence: ' + report.evidenceDigest)
  return lines.join('\n')
}
