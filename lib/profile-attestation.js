import { DshDeveloperError } from './errors.js'
import { inspectProfileAttestationInternal } from './profile-attestation-internal.js'

const OPTION_KEYS = new Set(['dshPath', 'signal'])

function assertSignal(signal) {
  if (signal === undefined) return
  if (signal === null
      || typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function') {
    throw new DshDeveloperError('PROFILE_ATTESTATION_OPTIONS_INVALID', 'signal must be an AbortSignal when present.')
  }
}

export async function inspectProfileAttestation(profilePath, options = {}) {
  if (typeof profilePath !== 'string' || profilePath.length === 0) {
    throw new DshDeveloperError(
      'PROFILE_ATTESTATION_OPTIONS_INVALID',
      'profilePath must be a non-empty explicit profile directory path.',
    )
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new DshDeveloperError('PROFILE_ATTESTATION_OPTIONS_INVALID', 'Profile attestation options must be an object.')
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new DshDeveloperError(
        'PROFILE_ATTESTATION_OPTIONS_INVALID',
        'Unsupported profile attestation option "' + key + '".',
      )
    }
  }
  if (options.dshPath !== undefined && (typeof options.dshPath !== 'string' || options.dshPath.length === 0)) {
    throw new DshDeveloperError(
      'PROFILE_ATTESTATION_OPTIONS_INVALID',
      'dshPath must be a non-empty DSH path when present.',
    )
  }
  assertSignal(options.signal)
  return inspectProfileAttestationInternal(profilePath, options)
}

export function formatProfileAttestationReport(report) {
  const lines = [
    'PASS DSH profile attestation ' + report.profile.name + ' @ ' + report.runtime.version
      + ' [' + report.runtime.claim + ', static-state]',
  ]
  for (const value of report.checks) {
    const boundary = value.blocking ? 'blocking' : 'advisory'
    lines.push('  ' + value.status.padEnd(4) + ' ' + value.id + ' [' + boundary + '] ' + value.message)
  }
  lines.push('Evidence: ' + report.evidenceDigest)
  lines.push('Boundary: static installed state only; no package code ran and compatibility, boot, or activation was not proved.')
  return lines.join('\n')
}
