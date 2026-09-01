import semver from 'semver'

const MAX_RANGE_LENGTH = 512
const MAX_ALTERNATIVES = 32

export function satisfiesNpmRange(versionValue, rangeValue) {
  if (typeof versionValue !== 'string'
      || typeof rangeValue !== 'string'
      || rangeValue.length > MAX_RANGE_LENGTH) {
    return { known: false, satisfies: false }
  }
  let range = rangeValue.trim()
  if (range.startsWith('workspace:')) {
    range = range.slice('workspace:'.length)
    if (['*', '^', '~'].includes(range)) return { known: false, satisfies: false }
  }
  if (range.split('||').length > MAX_ALTERNATIVES) return { known: false, satisfies: false }
  try {
    const version = semver.valid(versionValue)
    const normalizedRange = semver.validRange(range)
    if (!version || !normalizedRange) return { known: false, satisfies: false }
    return {
      known: true,
      satisfies: semver.satisfies(version, normalizedRange, { includePrerelease: false }),
    }
  } catch {
    return { known: false, satisfies: false }
  }
}

export function inspectCohortRanges(references, changes) {
  const surfaces = new Map(changes.map((value) => [value.package, value]))
  const findings = []
  for (const reference of references.packages) {
    if (!reference.package.startsWith('@deepseek-ai/')) continue
    const surface = surfaces.get(reference.package)
    if (!surface) continue
    const lanes = [
      ['release', surface.release?.version],
      ['preview', surface.preview?.version],
    ]
    for (const evidence of reference.evidence) {
      if (evidence.kind !== 'package-manifest'
          || !['peerDependencies', 'devDependencies'].includes(evidence.field)
          || typeof evidence.range !== 'string') continue
      const results = lanes.map(([lane, version]) => typeof version === 'string'
        ? { lane, version, available: true, ...satisfiesNpmRange(version, evidence.range) }
        : { lane, available: false, known: true, satisfies: false })
      const unknown = results.some((value) => !value.known)
      const acceptedLanes = results.filter((value) => value.known && value.satisfies).map((value) => value.lane)
      findings.push({
        package: reference.package,
        field: evidence.field,
        range: evidence.range,
        status: unknown ? 'unknown' : acceptedLanes.length > 0 ? 'covered' : 'uncovered',
        acceptedLanes,
        lanes: results,
      })
    }
  }
  return findings.sort((left, right) => {
    const byPackage = left.package.localeCompare(right.package, 'en')
    return byPackage || left.field.localeCompare(right.field, 'en')
  })
}
