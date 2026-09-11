import { satisfies, valid, validRange } from 'semver'

export interface VersionCheck {
  version: string
  range: string
  includePrerelease: boolean
  satisfies: boolean
}

/** Check npm semver compatibility without coercing partial versions or guessing ranges. */
export function checkPackageVersion(input: unknown): VersionCheck {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Arguments must be an object with version and range strings.')
  }
  const args = input as Record<string, unknown>
  const unexpected = Object.keys(args).filter(key => !['version', 'range', 'includePrerelease'].includes(key))
  if (unexpected.length > 0) {
    throw new TypeError(`Unknown argument: ${unexpected.join(', ')}. Use version, range, and optionally includePrerelease.`)
  }
  if (typeof args.version !== 'string' || valid(args.version) === null) {
    throw new TypeError('version must be a complete semantic version, for example "1.2.3" or "0.1.1-rc.2".')
  }
  if (typeof args.range !== 'string' || validRange(args.range) === null) {
    throw new TypeError('range must be an npm semver range, for example "^1.2.0", ">=0.1.1-rc.2 <0.2.0", or "*".')
  }
  if (args.includePrerelease !== undefined && typeof args.includePrerelease !== 'boolean') {
    throw new TypeError('includePrerelease must be a boolean; omit it to use npm semver prerelease rules.')
  }
  const includePrerelease = args.includePrerelease ?? false
  return {
    version: args.version,
    range: args.range,
    includePrerelease,
    satisfies: satisfies(args.version, args.range, { includePrerelease }),
  }
}
