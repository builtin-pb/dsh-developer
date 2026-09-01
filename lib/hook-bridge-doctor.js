import { DshDeveloperError } from './errors.js'
import { inspectHookBridgeInternal } from './hook-bridge-doctor-internal.js'

const OPTION_KEYS = new Set(['dialect', 'dshPath', 'signal', 'sourceRoot'])
const DIALECTS = new Set(['codex', 'claude-code'])

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function assertSignal(signal) {
  if (signal === undefined) return
  if (signal === null
      || typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function') {
    throw new DshDeveloperError('HOOK_DOCTOR_OPTIONS_INVALID', 'signal must be an AbortSignal when present.')
  }
}

export async function inspectHookBridge(source, options = {}) {
  if (!nonEmptyString(source)) {
    throw new DshDeveloperError('HOOK_DOCTOR_OPTIONS_INVALID', 'source must be a non-empty hook configuration path.')
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new DshDeveloperError('HOOK_DOCTOR_OPTIONS_INVALID', 'Hook Bridge Doctor options must be one object.')
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new DshDeveloperError('HOOK_DOCTOR_OPTIONS_INVALID', 'Hook Bridge Doctor received an unsupported option.')
    }
  }
  if (!DIALECTS.has(options.dialect)) {
    throw new DshDeveloperError('HOOK_DOCTOR_OPTIONS_INVALID', 'dialect must be "codex" or "claude-code".')
  }
  if (!nonEmptyString(options.dshPath)) {
    throw new DshDeveloperError('HOOK_DOCTOR_OPTIONS_INVALID', 'dshPath must be one explicit non-empty DSH path.')
  }
  if (options.sourceRoot !== undefined && !nonEmptyString(options.sourceRoot)) {
    throw new DshDeveloperError('HOOK_DOCTOR_OPTIONS_INVALID', 'sourceRoot must be a non-empty project path when present.')
  }
  assertSignal(options.signal)
  return inspectHookBridgeInternal(source, options)
}

export function formatHookBridgeReport(report) {
  const lines = [
    (report.ok ? 'PASS' : 'FAIL') + ' Hook Bridge Doctor ' + report.dialect
      + ' [static compatibility; activation not inspected]',
  ]
  for (const value of report.checks) {
    lines.push('  ' + value.status.padEnd(4) + ' ' + value.id + ': ' + value.message)
  }
  if (report.config?.status === 'inspected') {
    const effectiveRunnable = Number.isSafeInteger(report.config.totals?.effectiveRunnable)
      && report.config.totals.effectiveRunnable >= 0
      ? report.config.totals.effectiveRunnable
      : 0
    if (report.config.registration === 'none-invalid-matcher') {
      lines.push('  REGISTRATION none-invalid-matcher: the exact bridge rejects the whole config '
        + 'and registers zero hooks (' + effectiveRunnable + ' effective handlers).')
    } else if (report.config.registration === 'classified') {
      lines.push('  REGISTRATION classified: ' + effectiveRunnable + ' effective handler'
        + (effectiveRunnable === 1 ? '' : 's')
        + (effectiveRunnable === 1 ? ' survives' : ' survive')
        + ' exact bridge parsing; activation remains uninspected.')
    } else {
      lines.push('  REGISTRATION unclassified: zero effective handlers are claimed; '
        + 'activation remains uninspected.')
    }
    for (const event of report.config.events) {
      const label = event.event ?? 'redacted-event-' + event.eventIndex
      lines.push('  EVENT ' + label + ' [' + event.support + '] '
        + event.handlers.runnable + ' subset-accepted, '
        + event.handlers.runtimeRunnable + ' individually bridge-runnable, '
        + event.handlers.skipped + ' skipped, '
        + event.handlers.invalid + ' invalid')
    }
    if (report.config.issues.length > 0) {
      lines.push('  BLOCKERS ' + report.config.issues.length + ' redacted compatibility issue'
        + (report.config.issues.length === 1 ? '' : 's'))
    }
  }
  lines.push('Evidence: ' + report.evidenceDigest)
  return lines.join('\n')
}
