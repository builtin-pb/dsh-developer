import { DshDeveloperError } from './errors.js'
import { inspectSourceMigrationInternal } from './source-migration-internal.js'
export {
  SOURCE_MIGRATION_LEDGER_DIGEST,
  SOURCE_MIGRATION_LEDGER_V1,
} from './source-migration-rules.js'
import { SOURCE_MIGRATION_LEDGER_V1 } from './source-migration-rules.js'

const OPTION_KEYS = new Set(['fromDsh', 'toDsh', 'signal'])

function assertSignal(signal) {
  if (signal === undefined) return
  if (signal === null
      || typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function') {
    throw new DshDeveloperError(
      'MIGRATION_OPTIONS_INVALID',
      'signal must be an AbortSignal when present.',
    )
  }
}

export async function inspectSourceMigration(source, options = {}) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new DshDeveloperError(
      'MIGRATION_OPTIONS_INVALID',
      'Source migration requires a non-empty plugin source path.',
    )
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new DshDeveloperError('MIGRATION_OPTIONS_INVALID', 'Source-migration options must be an object.')
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new DshDeveloperError(
        'MIGRATION_OPTIONS_INVALID',
        'Unsupported source-migration option "' + key + '".',
      )
    }
  }
  for (const key of ['fromDsh', 'toDsh']) {
    if (typeof options[key] !== 'string' || options[key].length === 0) {
      throw new DshDeveloperError(
        'MIGRATION_OPTIONS_INVALID',
        key + ' must be a non-empty exact DSH version.',
      )
    }
  }
  const corridor = SOURCE_MIGRATION_LEDGER_V1.corridor
  if (options.fromDsh !== corridor.fromDsh || options.toDsh !== corridor.toDsh) {
    throw new DshDeveloperError(
      'MIGRATION_CORRIDOR_UNSUPPORTED',
      'The v1 source-migration ledger supports only exact DSH '
        + corridor.fromDsh + ' -> ' + corridor.toDsh + '.',
      {
        requested: { fromDsh: options.fromDsh, toDsh: options.toDsh },
        supported: { fromDsh: corridor.fromDsh, toDsh: corridor.toDsh },
      },
    )
  }
  assertSignal(options.signal)
  return inspectSourceMigrationInternal(source, options)
}

export function formatSourceMigrationReport(report) {
  const label = report.plugin?.name ?? report.source
  const status = report.ok ? report.findings.length > 0 ? 'ADVISE' : 'PASS' : 'FAIL'
  const lines = [status + ' DSH source migration ' + label + ' '
    + report.corridor.fromDsh + ' -> ' + report.corridor.toDsh]
  for (const check of report.checks) {
    lines.push('  ' + check.status.padEnd(4) + ' ' + check.id + ': ' + check.message)
  }
  for (const finding of report.findings) {
    const location = finding.touchpoint.path + ':' + finding.touchpoint.line + ':' + finding.touchpoint.column
    lines.push('  ACTION ' + location + ' [' + finding.plane + '] ' + finding.ruleId)
    lines.push('    ' + finding.action.message)
    for (const mapping of finding.action.mappings ?? []) {
      lines.push('    MAP ' + mapping.from + ' -> ' + mapping.module + '#' + mapping.to)
    }
    if ((finding.action.unmapped ?? []).length > 0) {
      lines.push('    PENDING ' + finding.action.unmapped.join(', '))
    } else if (finding.action.manualReview) {
      lines.push('    PENDING ' + (finding.action.pending ?? 'Manual review is required.'))
    }
  }
  lines.push('  SUMMARY ' + report.summary.findings + ' finding'
    + (report.summary.findings === 1 ? '' : 's') + ', '
    + report.summary.files + ' file' + (report.summary.files === 1 ? '' : 's') + ', '
    + report.summary.manualReview + ' manual-review touchpoint'
    + (report.summary.manualReview === 1 ? '' : 's'))
  lines.push('Evidence: ' + report.evidenceDigest)
  return lines.join('\n')
}
