import { DshDeveloperError } from './errors.js'
import { issueCellAdmissionGrant } from './cell-admission-grant.js'
import {
  formatCellAdmissionReport,
  inspectIsolatedCellAdmissionInternal,
  isolatedCellEvidenceSources,
} from './cell-admission-internal.js'

const ALLOWED_OPTIONS = new Set(['distro', 'signal'])

function validateOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new DshDeveloperError('ADMISSION_OPTIONS_INVALID', 'Cell admission options must be one object.')
  }
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.has(key)) {
      throw new DshDeveloperError('ADMISSION_OPTIONS_INVALID', 'Unsupported cell admission option "' + key + '".')
    }
  }
  if (options.distro !== undefined && (typeof options.distro !== 'string' || options.distro.length === 0)) {
    throw new DshDeveloperError('ADMISSION_OPTIONS_INVALID', 'distro must be a non-empty string when present.')
  }
  if (options.signal !== undefined) {
    const signal = options.signal
    if (signal === null
      || typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function') {
      throw new DshDeveloperError('ADMISSION_OPTIONS_INVALID', 'signal must be an AbortSignal when present.')
    }
  }
}

export async function inspectIsolatedCellAdmission(dshPath, options = {}) {
  validateOptions(options)
  const report = await inspectIsolatedCellAdmissionInternal(dshPath, options)
  return issueCellAdmissionGrant(report)
}

export { formatCellAdmissionReport, isolatedCellEvidenceSources }
