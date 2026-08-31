import { DshDeveloperError } from './errors.js'

const grants = new WeakMap()
const MAX_ACTIVE_PUBLIC_CELLS = 1
let activePublicCells = 0

function providerFrom(report) {
  return report?.checks
    ?.find((value) => value?.id === 'replacement.local-boundary')
    ?.evidence
    ?.provider
}

export function issueCellAdmissionGrant(report) {
  if (report === null
      || typeof report !== 'object'
      || report.kind !== 'isolated-agent-cell-admission'
      || typeof report.evidenceDigest !== 'string') {
    throw new DshDeveloperError('CELL_ADMISSION_INVALID', 'Only a completed isolated-cell admission report can issue a grant.')
  }
  const provider = providerFrom(report)
  grants.set(report, Object.freeze({
    admitted: report.admitted === true && report.disposition === 'Incubate',
    evidenceDigest: report.evidenceDigest,
    runtimeVersion: report.runtime?.version,
    providerId: provider?.id,
    distro: provider?.distro,
  }))
  return report
}

export function requireCellAdmissionGrant(report) {
  const grant = report && typeof report === 'object' ? grants.get(report) : undefined
  if (grant === undefined) {
    throw new DshDeveloperError(
      'CELL_ADMISSION_REQUIRED',
      'Opening an isolated cell requires the exact in-process report returned by inspectIsolatedCellAdmission().',
    )
  }
  if (!grant.admitted) {
    throw new DshDeveloperError('CELL_NOT_ADMITTED', 'The inspected DSH and execution-lab boundary did not admit an isolated-cell executor.', {
      evidenceDigest: grant.evidenceDigest,
      runtimeVersion: grant.runtimeVersion,
    })
  }
  if (grant.providerId !== 'wsl2-bubblewrap' || typeof grant.distro !== 'string' || grant.distro.length === 0) {
    throw new DshDeveloperError('CELL_ADMISSION_INVALID', 'The admitted report is not bound to a supported exact execution provider.')
  }
  return grant
}

export function acquireCellAdmissionLease(report) {
  const grant = requireCellAdmissionGrant(report)
  if (activePublicCells >= MAX_ACTIVE_PUBLIC_CELLS) {
    throw new DshDeveloperError(
      'CELL_CAPACITY',
      'This dsh-developer process already owns its maximum admitted isolated-cell workload.',
      { active: activePublicCells, limit: MAX_ACTIVE_PUBLIC_CELLS },
    )
  }
  activePublicCells += 1
  let released = false
  return {
    grant,
    release() {
      if (released) return
      released = true
      activePublicCells -= 1
    },
  }
}
