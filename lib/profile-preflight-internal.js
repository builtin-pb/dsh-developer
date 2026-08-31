import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET } from './constants.js'
import { assertOfficialDshInvocation } from './dsh-installation.js'
import { asDiagnostic, DshDeveloperError } from './errors.js'
import { scanOrdinaryTree } from './files.js'
import { resolveDshInvocation, runDsh, secretFreeEnvironment } from './runtime.js'
import {
  discoverUpstreamReferences,
  indexInstalledServiceOwners,
} from './upstream-impact-internal.js'

const PROFILE_NAME = /^[a-z][a-z0-9-]{0,63}$/u

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => [key, stableValue(value[key])]))
  }
  return value
}

function digest(value) {
  return 'sha256:' + createHash('sha256')
    .update(JSON.stringify(stableValue(value)), 'utf8')
    .digest('hex')
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

function laneFor(version) {
  if (version === DSH_COMPATIBILITY_TARGET) return { id: 'release', claim: 'blocking' }
  if (version === DSH_PREVIEW_TARGET) return { id: 'preview', claim: 'advisory' }
  return undefined
}

function requiredServices(references) {
  return references.services
    .filter((value) => value.evidence.some((item) => item.kind === 'inject' && item.requirement !== 'optional'))
    .map((value) => value.service)
    .sort((left, right) => left.localeCompare(right, 'en'))
}

function optionalServices(references, required) {
  const requiredSet = new Set(required)
  return references.services
    .filter((value) => !requiredSet.has(value.service)
      && value.evidence.some((item) => item.kind === 'inject' && item.requirement === 'optional'))
    .map((value) => value.service)
    .sort((left, right) => left.localeCompare(right, 'en'))
}

function runtimeOwnerPlacements(references, services, ownersByService) {
  const runtimeFields = new Set(['dependencies', 'optionalDependencies'])
  return references.packages.flatMap((reference) => {
    const fields = [...new Set(reference.evidence
      .filter((item) => item.kind === 'package-manifest' && runtimeFields.has(item.field))
      .map((item) => item.field))]
      .sort((left, right) => left.localeCompare(right, 'en'))
    if (fields.length === 0) return []
    const attachedServices = services
      .filter((service) => (ownersByService.get(service) ?? []).includes(reference.package))
    if (attachedServices.length === 0) return []
    return [{ package: reference.package, services: attachedServices, fields }]
  })
}

function packageName(specifier) {
  if (!specifier.startsWith('@')) return specifier.split('/')[0]
  return specifier.split('/').slice(0, 2).join('/')
}

function configuredPackages(dump) {
  const mounted = new Set()
  const conditional = new Set()
  for (const block of dump.split(/(?=^- id:)/mu)) {
    if (!block.startsWith('- id:')) continue
    const name = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/mu.exec(block)?.[1]
    if (!name) continue
    const dependency = packageName(name)
    const disabled = /^\s+disabled:\s*(.+?)\s*$/mu.exec(block)?.[1]
    if (disabled === 'true') continue
    if (disabled !== undefined && disabled !== 'false') conditional.add(dependency)
    else mounted.add(dependency)
  }
  return { mounted, conditional }
}

export async function inspectProfileComposition(invocation, profile, services, ownersByService, options = {}) {
  const makeTemp = options.mkdtemp ?? mkdtemp
  const remove = options.rm ?? rm
  const invoke = options.runDsh ?? runDsh
  const home = await makeTemp(join(tmpdir(), 'dsh-developer-preflight-'))
  const environment = secretFreeEnvironment({
    DSH_HOME: home,
    DSH_PERMISSION_MODE: 'read-only',
  })
  try {
    const composed = await invoke(invocation, ['--profile', profile, '--dump-config'], {
      cwd: home,
      env: environment,
      signal: options.signal,
      label: 'DSH profile preflight composition',
      diagnosticOutput: true,
    })
    const configured = configuredPackages(composed.stdout)
    const mappings = services.map((service) => {
      const owners = ownersByService.get(service) ?? []
      return {
        service,
        owners,
        mountedOwners: owners.filter((name) => configured.mounted.has(name)),
        conditionalOwners: owners.filter((name) => configured.conditional.has(name)),
      }
    })
    const missing = mappings
      .filter((value) => value.mountedOwners.length === 0)
      .map((value) => value.service)
    if (missing.length > 0) {
      throw new DshDeveloperError(
        'PROFILE_SERVICES_MISSING',
        'The clean profile composition does not unconditionally mount an owner for every required service.',
        { missingServices: missing, mappings },
      )
    }
    return {
      profile,
      requiredServices: [...services],
      mappings,
      confidence: 'composition',
      profileActivated: false,
      repositoryCodeExecuted: false,
    }
  } catch (error) {
    if (error instanceof DshDeveloperError) {
      error.details = { ...error.details, profile, requiredServices: [...services] }
    }
    throw error
  } finally {
    await remove(home, { recursive: true, force: true })
  }
}

function reportDigest(report) {
  return digest({
    sourceFingerprint: report.sourceFingerprint,
    plugin: report.plugin,
    profile: report.profile,
    runtime: report.runtime,
    requiredServices: report.requiredServices,
    optionalServices: report.optionalServices,
    checks: report.checks.map(({ id, status, blocking, evidence }) => ({
      id,
      status,
      blocking,
      ...(evidence === undefined ? {} : { evidence }),
    })),
  })
}

export async function inspectProfilePreflightInternal(source, options, dependencies = {}) {
  if (!PROFILE_NAME.test(options.profile)) {
    throw new DshDeveloperError(
      'PROFILE_PREFLIGHT_OPTIONS_INVALID',
      'profile must be a lowercase DSH profile name of at most 64 characters.',
    )
  }
  const scan = dependencies.scanOrdinaryTree ?? scanOrdinaryTree
  const first = await scan(resolve(source), { signal: options.signal })
  const references = discoverUpstreamReferences(first)
  const services = requiredServices(references)
  const optional = optionalServices(references, services)
  const checks = [check(
    'source.snapshot',
    'PASS',
    'Acquired one stable plugin snapshot and extracted required Cordis injections without loading repository code.',
    true,
    { fingerprint: first.fingerprint, files: first.fileCount },
  )]
  const unparsedInject = references.coverage.unparsedInjectDeclarations
  checks.push(check(
    'source.inject-contract',
    unparsedInject.length === 0 ? 'PASS' : 'FAIL',
    unparsedInject.length === 0
      ? 'Every discovered inject assignment is a closed literal service declaration.'
      : 'One or more inject assignments are dynamic or outside the supported literal contract.',
    true,
    unparsedInject.length === 0 ? undefined : { paths: unparsedInject },
  ))

  let invocation
  let runtime
  let installed
  try {
    const resolveInvocation = dependencies.resolveDshInvocation ?? resolveDshInvocation
    const establishOfficial = dependencies.assertOfficialDshInvocation ?? assertOfficialDshInvocation
    const invoke = dependencies.runDsh ?? runDsh
    invocation = await resolveInvocation(options.dshPath)
    installed = await establishOfficial(invocation)
    const versionResult = await invoke(invocation, ['--version'], {
      signal: options.signal,
      label: 'DSH profile preflight identity',
    })
    const version = versionResult.stdout.trim()
    const lane = laneFor(version)
    if (!lane || installed.value.version !== version) {
      throw new DshDeveloperError(
        'PROFILE_PREFLIGHT_DSH_UNSUPPORTED',
        'Profile preflight requires an exact reviewed DSH release or preview lane.',
        { cliVersion: version, packageVersion: installed.value.version },
      )
    }
    runtime = { version, lane, dshPath: invocation.displayPath }
    checks.push(check(
      'runtime.identity',
      'PASS',
      'Established the package-declared official DSH ' + version + ' entry.',
      true,
      runtime,
    ))
  } catch (error) {
    if (error?.code === 'CANCELLED') throw error
    checks.push(check(
      'runtime.identity',
      'FAIL',
      'Could not establish an exact reviewed official DSH entry.',
      true,
      asDiagnostic(error),
    ))
  }

  let owners
  if (runtime) {
    try {
      const indexServices = dependencies.indexInstalledServiceOwners ?? indexInstalledServiceOwners
      owners = await indexServices(installed, { signal: options.signal })
      const misplaced = runtimeOwnerPlacements(references, services, owners)
      checks.push(check(
        'source.host-package-placement',
        misplaced.length === 0 ? 'PASS' : 'FAIL',
        misplaced.length === 0
          ? 'Required DSH service owners are inherited from the host rather than installed as runtime copies.'
          : 'One or more required DSH service owners are declared as runtime dependencies and can shadow the host copy.',
        true,
        misplaced.length === 0 ? undefined : { misplaced },
      ))
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error
      checks.push(check(
        'source.host-package-placement',
        'FAIL',
        'Could not classify required DSH service-owner package placement.',
        true,
        asDiagnostic(error),
      ))
    }
  } else {
    checks.push(check(
      'source.host-package-placement',
      'SKIP',
      'Host package placement requires an exact reviewed official DSH entry.',
      true,
    ))
  }

  if (owners && unparsedInject.length === 0) {
    try {
      const compose = dependencies.inspectProfileComposition ?? inspectProfileComposition
      const evidence = await compose(invocation, options.profile, services, owners, {
        signal: options.signal,
        runDsh: dependencies.runDsh,
      })
      checks.push(check(
        'profile.service-contract',
        'PASS',
        services.length === 0
          ? 'The disposable clean profile composed successfully; the plugin declares no required Cordis injections.'
          : 'The clean profile composition unconditionally mounts an installed owner for every required Cordis service.',
        true,
        evidence,
      ))
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error
      checks.push(check(
        'profile.service-contract',
        'FAIL',
        'The clean profile composition does not satisfy the static service contract.',
        true,
        asDiagnostic(error),
      ))
    }
  } else if (!owners) {
    checks.push(check(
      'profile.service-contract',
      'SKIP',
      'Profile service preflight requires an indexed exact DSH service graph.',
      true,
    ))
  } else {
    checks.push(check(
      'profile.service-contract',
      'SKIP',
      'Profile composition is not meaningful until every inject assignment has a closed literal contract.',
      true,
      { paths: unparsedInject },
    ))
  }

  const final = await scan(resolve(source), { signal: options.signal })
  const fresh = final.fingerprint === first.fingerprint
  checks.push(check(
    'source.freshness',
    fresh ? 'PASS' : 'FAIL',
    fresh
      ? 'A fresh source scan matches the tree used to derive the service contract.'
      : 'Plugin source changed during profile preflight.',
    true,
    { before: first.fingerprint, after: final.fingerprint },
  ))

  const report = {
    kind: 'dsh-profile-preflight',
    ok: checks.every((value) => !value.blocking || value.status === 'PASS'),
    source: first.root,
    sourceFingerprint: final.fingerprint,
    verifiedAt: new Date().toISOString(),
    plugin: references.plugin,
    profile: options.profile,
    runtime,
    requiredServices: services,
    optionalServices: optional,
    checks,
  }
  report.evidenceDigest = reportDigest(report)
  return report
}
