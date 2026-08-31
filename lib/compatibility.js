import { DshDeveloperError } from './errors.js'
import { inspectCompatibilityMatrixInternal } from './compatibility-internal.js'

const OPTION_KEYS = new Set(['releaseDsh', 'previewDsh', 'signal'])

function assertSignal(signal) {
  if (signal === undefined) return
  if (signal === null
      || typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function') {
    throw new DshDeveloperError('COMPATIBILITY_OPTIONS_INVALID', 'signal must be an AbortSignal when present.')
  }
}

export async function inspectCompatibilityMatrix(source, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new DshDeveloperError('COMPATIBILITY_OPTIONS_INVALID', 'Compatibility options must be an object.')
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new DshDeveloperError('COMPATIBILITY_OPTIONS_INVALID', 'Unsupported compatibility option "' + key + '".')
    }
  }
  for (const key of ['releaseDsh', 'previewDsh']) {
    if (typeof options[key] !== 'string' || options[key].length === 0) {
      throw new DshDeveloperError('COMPATIBILITY_OPTIONS_INVALID', key + ' must be a non-empty DSH path.')
    }
  }
  assertSignal(options.signal)
  return inspectCompatibilityMatrixInternal(source, options)
}

export function formatCompatibilityMatrix(report) {
  const lines = [
    (report.ok ? 'PASS' : 'FAIL') + ' DSH compatibility matrix ' + (report.plugin?.name ?? report.source),
  ]
  for (const value of report.checks) {
    lines.push('  ' + value.status.padEnd(4) + ' ' + value.id + ': ' + value.message)
  }
  for (const lane of report.lanes) {
    lines.push('  ' + (lane.ok ? 'PASS' : 'FAIL') + ' ' + lane.id + ' ' + lane.expectedVersion + ' [' + lane.claim + ']')
    for (const value of lane.checks) {
      lines.push('    ' + value.status.padEnd(4) + ' ' + value.id + ': ' + value.message)
    }
  }
  const contractChanges = report.drift.filter((value) => value.classification === 'contract').length
  lines.push('  DRIFT ' + report.drift.length + ' revalidation trigger' + (report.drift.length === 1 ? '' : 's')
    + ' (' + contractChanges + ' contract)')
  for (const value of report.drift) lines.push('    ' + value.id + ' [' + value.classification + ']')
  lines.push('Evidence: ' + report.evidenceDigest)
  return lines.join('\n')
}
