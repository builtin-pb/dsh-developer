import { DshDeveloperError } from './errors.js'
import { openAdmittedIsolatedCellInternal } from './isolated-cell-internal.js'

const OPTION_KEYS = new Set(['admission', 'signal'])

export async function openIsolatedCell(source, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new DshDeveloperError('CELL_OPTIONS_INVALID', 'Isolated-cell options must be an object.')
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new DshDeveloperError('CELL_OPTIONS_INVALID', 'Unsupported isolated-cell option "' + key + '".')
    }
  }
  return openAdmittedIsolatedCellInternal(source, options)
}
