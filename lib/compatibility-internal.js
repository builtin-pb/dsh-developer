import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectDshCapabilities } from './capabilities.js'
import { DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET } from './constants.js'
import { assertOfficialDshInvocation } from './dsh-installation.js'
import { doctorPlugin, reportDigest } from './doctor.js'
import { asDiagnostic, DshDeveloperError } from './errors.js'
import { scanOrdinaryTree } from './files.js'
import {
  resolveDshInvocation,
  runDsh,
  smokeDshInstall,
} from './runtime.js'

const productRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const LANE_SPECS = Object.freeze([
  Object.freeze({ id: 'release', expectedVersion: DSH_COMPATIBILITY_TARGET, blocking: true }),
  Object.freeze({ id: 'preview', expectedVersion: DSH_PREVIEW_TARGET, blocking: false }),
])

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right
}

function check(id, status, message, blocking, evidence) {
  return {
    id,
    status,
    blocking,
    message,
    ...(evidence === undefined ? {} : { evidence }),
  }
}

function packageState(capability) {
  return capability.packages.map(({ name, version, access, publicEntry, missing }) => ({
    name,
    ...(version === undefined ? {} : { version }),
    ...(access === undefined ? {} : { access }),
    ...(publicEntry === undefined ? {} : { publicEntry }),
    ...(missing === undefined ? {} : { missing }),
  }))
}

function contractState(value) {
  if (value === undefined) return undefined
  return {
    status: value.status,
    confidence: value.confidence,
    semantics: value.semantics,
    partialGuarantee: value.partialGuarantee,
    packages: value.packages.map(({ version: _version, ...rest }) => rest),
  }
}

export function compareCapabilityReports(release, preview) {
  if (!release || !preview) return []
  const releaseById = new Map(release.capabilities.map((value) => [value.id, value]))
  const previewById = new Map(preview.capabilities.map((value) => [value.id, value]))
  const ids = [...new Set([...releaseById.keys(), ...previewById.keys()])]
    .sort((left, right) => left.localeCompare(right, 'en'))
  const changes = []
  for (const id of ids) {
    const before = releaseById.get(id)
    const after = previewById.get(id)
    const from = before
      ? {
          status: before.status,
          confidence: before.confidence,
          semantics: before.semantics,
          partialGuarantee: before.partialGuarantee,
          packages: packageState(before),
        }
      : undefined
    const to = after
      ? {
          status: after.status,
          confidence: after.confidence,
          semantics: after.semantics,
          partialGuarantee: after.partialGuarantee,
          packages: packageState(after),
        }
      : undefined
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      const classification = JSON.stringify(contractState(from)) === JSON.stringify(contractState(to))
        ? 'package-version'
        : 'contract'
      changes.push({ id, classification, from, to })
    }
  }
  return changes
}

async function inspectLane(spec, dshPath, source, plugin, executable, options, dependencies) {
  const resolveInvocation = dependencies.resolveDshInvocation ?? resolveDshInvocation
  const assertOfficial = dependencies.assertOfficialDshInvocation ?? assertOfficialDshInvocation
  const invoke = dependencies.runDsh ?? runDsh
  const inspectCapabilities = dependencies.inspectDshCapabilities ?? inspectDshCapabilities
  const smoke = dependencies.smokeDshInstall ?? smokeDshInstall
  const checks = []
  let invocation
  let capabilities
  let lifecycle

  try {
    invocation = await resolveInvocation(dshPath)
    const installed = await assertOfficial(invocation)
    const versionResult = await invoke(invocation, ['--version'], {
      signal: options.signal,
      label: 'DSH ' + spec.id + ' compatibility identity probe',
    })
    const cliVersion = versionResult.stdout.trim()
    const packageVersion = installed.value.version
    if (cliVersion !== spec.expectedVersion || packageVersion !== spec.expectedVersion) {
      throw new DshDeveloperError(
        'DSH_MATRIX_LANE_MISMATCH',
        'The ' + spec.id + ' lane must be exact DSH ' + spec.expectedVersion + '.',
        {
          lane: spec.id,
          expected: spec.expectedVersion,
          cliVersion,
          packageVersion,
          dshPath: invocation.displayPath,
        },
      )
    }
    checks.push(check(
      'runtime.identity',
      'PASS',
      'The selected executable is the package-declared public DSH ' + spec.expectedVersion + ' entry.',
      spec.blocking,
      { version: cliVersion, dshPath: invocation.displayPath },
    ))
  } catch (error) {
    if (error?.code === 'CANCELLED') throw error
    checks.push(check(
      'runtime.identity',
      'FAIL',
      'The exact official DSH ' + spec.expectedVersion + ' lane could not be established.',
      spec.blocking,
      asDiagnostic(error),
    ))
    return {
      id: spec.id,
      claim: spec.blocking ? 'blocking' : 'advisory',
      expectedVersion: spec.expectedVersion,
      ok: false,
      checks,
    }
  }

  try {
    capabilities = await inspectCapabilities(invocation.displayPath, {
      signal: options.signal,
      resolveDshInvocation: async () => invocation,
    })
    if (capabilities.runtime.version !== spec.expectedVersion
        || capabilities.runtime.lane.id !== spec.id
        || !capabilities.ok) {
      throw new DshDeveloperError(
        'DSH_MATRIX_CAPABILITIES_FAILED',
        'The ' + spec.id + ' capability report did not establish its exact lane contract.',
        {
          expectedVersion: spec.expectedVersion,
          actualVersion: capabilities.runtime.version,
          actualLane: capabilities.runtime.lane.id,
          capabilityDigest: capabilities.evidenceDigest,
        },
      )
    }
    checks.push(check(
      'runtime.capabilities',
      'PASS',
      'The exact lane passed controlled DSH capability and self-lifecycle inspection.',
      spec.blocking,
      { digest: capabilities.evidenceDigest },
    ))
  } catch (error) {
    if (error?.code === 'CANCELLED') throw error
    checks.push(check(
      'runtime.capabilities',
      'FAIL',
      'The exact lane failed controlled DSH capability inspection.',
      spec.blocking,
      asDiagnostic(error),
    ))
  }

  if (!executable) {
    checks.push(check(
      'plugin.lifecycle',
      'SKIP',
      'Arbitrary repository code is never executed; behavior requires product source or byte-for-byte reproducible promoted output.',
      spec.blocking,
    ))
  } else if (!capabilities?.ok) {
    checks.push(check(
      'plugin.lifecycle',
      'SKIP',
      'Plugin behavior was not executed because the lane capability gate failed.',
      spec.blocking,
    ))
  } else {
    try {
      lifecycle = await smoke(
        source,
        plugin.name,
        plugin.packageName,
        invocation,
        { signal: options.signal },
      )
      if (lifecycle?.installed !== true
          || lifecycle?.discovered !== true
          || lifecycle?.loaded !== true
          || lifecycle?.loadWitness !== 'registration-nonce'
          || lifecycle?.uninstalled !== true) {
        throw new DshDeveloperError(
          'DSH_MATRIX_LIFECYCLE_EVIDENCE_INVALID',
          'The compatibility lifecycle returned incomplete evidence.',
          { lifecycle },
        )
      }
      checks.push(check(
        'plugin.lifecycle',
        'PASS',
        'The exact plugin installed, registered its load witness, appeared in config, and uninstalled in a disposable profile.',
        spec.blocking,
        lifecycle,
      ))
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error
      checks.push(check(
        'plugin.lifecycle',
        'FAIL',
        'The plugin failed its witnessed lifecycle on this exact DSH lane.',
        spec.blocking,
        asDiagnostic(error),
      ))
    }
  }

  return {
    id: spec.id,
    claim: spec.blocking ? 'blocking' : 'advisory',
    expectedVersion: spec.expectedVersion,
    ok: checks.every((value) => value.status === 'PASS'),
    checks,
    capabilityDigest: capabilities?.evidenceDigest,
    capabilities,
    lifecycle,
  }
}

function digestReport(report) {
  const canonical = JSON.stringify({
    sourceFingerprint: report.sourceFingerprint,
    doctorDigest: report.doctorDigest,
    plugin: report.plugin,
    execution: report.execution,
    checks: report.checks.map(({ id, status, blocking }) => ({ id, status, blocking })),
    lanes: report.lanes.map((lane) => ({
      id: lane.id,
      claim: lane.claim,
      expectedVersion: lane.expectedVersion,
      ok: lane.ok,
      capabilityDigest: lane.capabilityDigest,
      checks: lane.checks.map(({ id, status, blocking }) => ({ id, status, blocking })),
    })),
    drift: report.drift,
  })
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export async function inspectCompatibilityMatrixInternal(source, options, dependencies = {}) {
  const absolute = resolve(source)
  const getLstat = dependencies.lstat ?? lstat
  const info = await getLstat(absolute).catch((error) => {
    throw new DshDeveloperError('SOURCE_UNAVAILABLE', 'Cannot inspect compatibility source: ' + error.message, {
      path: absolute,
    })
  })
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new DshDeveloperError(
      'UNSAFE_SOURCE',
      'Compatibility behavior requires an ordinary plugin directory.',
      { path: absolute },
    )
  }
  const getRealpath = dependencies.realpath ?? realpath
  const physicalSource = await getRealpath(absolute)
  const physicalProduct = await getRealpath(productRoot)
  const isProductSource = samePath(physicalSource, physicalProduct)
  const audit = dependencies.doctorPlugin ?? doctorPlugin
  const doctor = await audit(physicalSource, {
    runtime: 'skip',
    requireGenerated: false,
    signal: options.signal,
  })
  const reproducible = doctor.checks.find((value) => value.id === 'packaging.reproducible')?.status === 'PASS'
  const executable = doctor.ok && Boolean(doctor.plugin) && (isProductSource || reproducible)
  const execution = {
    eligible: executable,
    basis: isProductSource
      ? 'product-source'
      : reproducible
        ? 'reproducible-promotion'
        : 'untrusted-repository',
  }
  const checks = [
    check(
      'source.audit',
      doctor.ok ? 'PASS' : 'FAIL',
      doctor.ok
        ? 'The source passed the non-runtime Doctor catalogue.'
        : 'The source failed the non-runtime Doctor catalogue.',
      true,
      { digest: reportDigest(doctor), fingerprint: doctor.fingerprint },
    ),
    check(
      'source.execution-eligibility',
      executable ? 'PASS' : 'FAIL',
      executable
        ? 'Behavior execution is allowed for exact product source or reproducible promoted bytes.'
        : !doctor.ok
          ? 'Behavior execution is withheld because the source audit failed.'
          : 'Behavior execution is withheld from arbitrary repository code.',
      true,
      execution,
    ),
  ]

  const paths = {
    release: options.releaseDsh,
    preview: options.previewDsh,
  }
  const lanes = await Promise.all(LANE_SPECS.map((spec) => inspectLane(
    spec,
    paths[spec.id],
    physicalSource,
    doctor.plugin,
    executable,
    options,
    dependencies,
  )))

  const scan = dependencies.scanOrdinaryTree ?? scanOrdinaryTree
  let freshFingerprint
  if (doctor.fingerprint) {
    try {
      const fresh = await scan(physicalSource, { signal: options.signal, excludeDependencies: true })
      freshFingerprint = fresh.fingerprint
      if (fresh.fingerprint !== doctor.fingerprint) {
        throw new DshDeveloperError(
          'STALE_VERIFICATION',
          'Plugin source changed during compatibility verification.',
          { before: doctor.fingerprint, after: fresh.fingerprint },
        )
      }
      checks.push(check(
        'source.freshness',
        'PASS',
        'A fresh source scan matches the tree exercised by both lanes.',
        true,
        { fingerprint: fresh.fingerprint },
      ))
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error
      checks.push(check(
        'source.freshness',
        'FAIL',
        'The source could not be proven unchanged across the matrix.',
        true,
        asDiagnostic(error),
      ))
    }
  } else {
    checks.push(check(
      'source.freshness',
      'SKIP',
      'No accepted Doctor fingerprint was available for a final source scan.',
      true,
    ))
  }

  const release = lanes.find((value) => value.id === 'release')
  const preview = lanes.find((value) => value.id === 'preview')
  const report = {
    kind: 'dsh-compatibility-matrix',
    ok: checks.every((value) => value.status === 'PASS') && release.ok,
    source: physicalSource,
    sourceFingerprint: freshFingerprint ?? doctor.fingerprint,
    verifiedAt: new Date().toISOString(),
    plugin: doctor.plugin,
    doctorDigest: reportDigest(doctor),
    execution,
    checks,
    lanes,
    drift: compareCapabilityReports(release.capabilities, preview.capabilities),
  }
  report.evidenceDigest = digestReport(report)
  return report
}
