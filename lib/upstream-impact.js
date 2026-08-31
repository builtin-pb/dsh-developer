import { DshDeveloperError } from './errors.js'
import { inspectUpstreamImpactInternal } from './upstream-impact-internal.js'

const OPTION_KEYS = new Set(['releaseDsh', 'previewDsh', 'signal'])

function assertSignal(signal) {
  if (signal === undefined) return
  if (signal === null
      || typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function') {
    throw new DshDeveloperError('IMPACT_OPTIONS_INVALID', 'signal must be an AbortSignal when present.')
  }
}

export async function inspectUpstreamImpact(source, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new DshDeveloperError('IMPACT_OPTIONS_INVALID', 'Impact options must be an object.')
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new DshDeveloperError('IMPACT_OPTIONS_INVALID', 'Unsupported impact option "' + key + '".')
    }
  }
  for (const key of ['releaseDsh', 'previewDsh']) {
    if (typeof options[key] !== 'string' || options[key].length === 0) {
      throw new DshDeveloperError('IMPACT_OPTIONS_INVALID', key + ' must be a non-empty DSH path.')
    }
  }
  assertSignal(options.signal)
  return inspectUpstreamImpactInternal(source, options)
}

export function formatUpstreamImpactReport(report) {
  const label = report.plugin?.name ?? report.source
  const lines = [(report.ok ? 'PASS' : 'FAIL') + ' DSH upstream impact ' + label]
  for (const value of report.checks) {
    lines.push('  ' + value.status.padEnd(4) + ' ' + value.id + ': ' + value.message)
  }
  for (const lane of report.lanes) {
    lines.push('  ' + (lane.ok ? 'PASS' : 'FAIL') + ' ' + lane.id + ' ' + lane.expectedVersion)
  }
  lines.push('  SURFACES ' + report.summary.packages + ' package'
    + (report.summary.packages === 1 ? '' : 's') + ', '
    + report.summary.services + ' service' + (report.summary.services === 1 ? '' : 's'))
  lines.push('  IMPACT ' + report.summary.revalidation + ' revalidation trigger'
    + (report.summary.revalidation === 1 ? '' : 's'))
  for (const value of report.changes.filter((change) => change.classification !== 'unchanged')) {
    lines.push('    ' + value.package + ' [' + value.classification + '] ' + value.reasons.join(', '))
  }
  lines.push('Evidence: ' + report.evidenceDigest)
  return lines.join('\n')
}
