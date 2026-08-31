import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET } from './constants.js'
import {
  installedPackageEvidence,
  locateDshPackage,
  locateInstalledDshPackage,
} from './dsh-installation.js'
import { asDiagnostic, DshDeveloperError } from './errors.js'
import { resolveDshInvocation, runDsh, smokeDshInstall } from './runtime.js'

const productRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const REVIEWED_DSH_VERSIONS = Object.freeze([DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET])

const CAPABILITIES = Object.freeze([
  {
    id: 'plugin.native-surface',
    label: 'Native plugin, skill, command, shell-environment, and model-tool services',
    packages: [
      '@deepseek-ai/dsh-skill',
      '@deepseek-ai/dsh-commands',
      '@deepseek-ai/dsh-shell-env',
      '@deepseek-ai/dsh-tools',
    ],
  },
  {
    id: 'subagent.core',
    label: 'Subagent provider registry and lifecycle service',
    packages: ['@deepseek-ai/dsh-subagent'],
  },
  {
    id: 'subagent.acp',
    label: 'Out-of-process ACP subagent provider',
    packages: ['@deepseek-ai/dsh-subagent-acp'],
  },
  {
    id: 'sandbox.contract',
    label: 'Per-call DSH sandbox policy contract',
    packages: ['@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-sandbox-policy'],
  },
  {
    id: 'sandbox.local-provider',
    label: 'Local same-world filesystem sandbox provider',
    packages: ['@deepseek-ai/dsh-sandbox-local'],
  },
  {
    id: 'sandbox.windows-acl',
    label: 'Windows restricted-token and ACL sandbox provider',
    packages: ['@deepseek-ai/dsh-sandbox-windows-acl'],
    partialGuarantee: 'Write restriction only; reads, network, process visibility, credentials, devices, and hard-link aliases are not fully confined.',
  },
  {
    id: 'team.experimental',
    label: 'Experimental durable Agent Team service',
    packages: ['@deepseek-ai/dsh-experimental-agent-team'],
    experimental: true,
  },
  {
    id: 'session.snapshot-support',
    label: 'Keyless recorded-session conformance support',
    packages: ['@deepseek-ai/dsh-session-snapshot'],
    experimental: true,
  },
])

function check(id, status, message, evidence, blocking = true) {
  return {
    id,
    status,
    blocking,
    message,
    ...(evidence === undefined ? {} : { evidence }),
  }
}

function laneFor(version) {
  if (version === DSH_COMPATIBILITY_TARGET) {
    return { id: 'release', claim: 'blocking', recognized: true }
  }
  if (version === DSH_PREVIEW_TARGET) {
    return { id: 'preview', claim: 'preview', recognized: true }
  }
  return { id: 'unrecognized', claim: 'unsupported', recognized: false }
}

async function inspectCapability(spec, dshPackage, runtimeVersion, lane) {
  const packages = []
  for (const name of spec.packages) {
    const installed = await locateInstalledDshPackage(dshPackage, name)
    packages.push(installed ? installedPackageEvidence(installed) : { name, missing: true })
  }
  const present = packages.filter((value) => !value.missing)
  const semanticsReviewed = lane.recognized
    && present.length === packages.length
    && present.every((value) => value.version === runtimeVersion)
  let status
  if (present.length === 0) status = 'absent'
  else if (present.length !== packages.length) status = 'partial'
  else if (!semanticsReviewed) status = 'present-unclassified'
  else if (spec.experimental || present.some((value) => value.access !== 'public')) status = 'experimental'
  else if (spec.partialGuarantee) status = 'partial'
  else status = 'native'
  const declaredPartial = status === 'partial' && semanticsReviewed && Boolean(spec.partialGuarantee)
  const message = status === 'absent'
    ? 'No matching installed package was found; this is not evidence that every custom profile lacks the capability.'
    : status === 'partial'
      ? declaredPartial
        ? 'The public package inventory is present. Declared partial guarantee: ' + spec.partialGuarantee
        : 'Only part of the declared package contract is installed.'
      : status === 'present-unclassified'
        ? 'The package inventory is present, but this exact DSH/package version has no reviewed semantic classification.'
      : status === 'experimental'
        ? 'The package inventory is present but experimental or unpublished.'
        : 'The public package inventory is present.'
  return {
    id: spec.id,
    label: spec.label,
    status,
    confidence: 'inventory',
    semantics: present.length === 0 ? 'not-applicable' : semanticsReviewed ? 'reviewed' : 'unreviewed',
    message,
    ...(semanticsReviewed && spec.partialGuarantee ? { partialGuarantee: spec.partialGuarantee } : {}),
    packages,
  }
}

function digestEvidence(runtime, checks, capabilities) {
  const canonical = JSON.stringify({
    version: runtime.version,
    lane: runtime.lane,
    node: runtime.node,
    platform: runtime.platform,
    arch: runtime.arch,
    package: runtime.package,
    checks: checks.map(({ id, status, blocking, evidence }) => ({
      id,
      status,
      blocking,
      ...(evidence === undefined ? {} : { evidence }),
    })),
    capabilities: capabilities.map(({ id, status, confidence, semantics, partialGuarantee, packages }) => ({
      id,
      status,
      confidence,
      ...(semantics ? { semantics } : {}),
      ...(partialGuarantee ? { partialGuarantee } : {}),
      packages,
    })),
  })
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export async function inspectDshCapabilities(dshPath, options = {}) {
  const invocation = options.resolveDshInvocation
    ? await options.resolveDshInvocation(dshPath)
    : await resolveDshInvocation(dshPath)
  const invoke = options.runDsh ?? runDsh
  const versionResult = await invoke(invocation, ['--version'], {
    signal: options.signal,
    label: 'DSH capability version probe',
  })
  const version = versionResult.stdout.trim()
  if (version.length === 0) throw new DshDeveloperError('DSH_VERSION_INVALID', 'DSH returned an empty version string.')
  const lane = laneFor(version)
  const checks = [
    check(
      'runtime.version',
      lane.recognized ? 'PASS' : 'WARN',
      lane.recognized
        ? 'DSH version belongs to a declared compatibility lane.'
        : 'DSH version is inspectable but has no compatibility claim.',
      { version, lane: lane.id, claim: lane.claim },
      false,
    ),
  ]

  const help = await invoke(invocation, ['--help'], {
    signal: options.signal,
    label: 'DSH capability CLI probe',
  })
  const missingCli = ['--profile', '--dump-config', 'plugin'].filter((token) => !help.stdout.includes(token))
  checks.push(check(
    'runtime.cli-contract',
    missingCli.length === 0 ? 'PASS' : 'FAIL',
    missingCli.length === 0
      ? 'DSH exposes profile selection, config inspection, and plugin management entry points.'
      : 'DSH help is missing required developer entry points.',
    { missing: missingCli },
  ))

  let lifecycle
  try {
    const runLifecycle = options.smokeDshInstall ?? smokeDshInstall
    const lifecycleCandidate = await runLifecycle(
      productRoot,
      'dsh-developer',
      'dsh-developer',
      invocation,
      options,
    )
    if (lifecycleCandidate?.installed !== true
      || lifecycleCandidate?.discovered !== true
      || lifecycleCandidate?.loaded !== true
      || lifecycleCandidate?.loadWitness !== 'registration-nonce'
      || lifecycleCandidate?.uninstalled !== true) {
      throw new DshDeveloperError(
        'DSH_LIFECYCLE_EVIDENCE_INVALID',
        'The controlled plugin lifecycle returned incomplete evidence.',
        { lifecycle: lifecycleCandidate },
      )
    }
    lifecycle = lifecycleCandidate
    checks.push(check(
      'runtime.plugin-lifecycle',
      'PASS',
      'The controlled dsh-developer probe installed, emitted its registration witness, appeared in config, and uninstalled in a disposable profile.',
      lifecycle,
    ))
  } catch (error) {
    checks.push(check(
      'runtime.plugin-lifecycle',
      'FAIL',
      'The controlled clean-profile plugin lifecycle failed.',
      asDiagnostic(error),
    ))
  }

  const dshPackage = await locateDshPackage(invocation)
  if (!dshPackage) {
    checks.push(check(
      'installation.package-identity',
      'FAIL',
      'The official @deepseek-ai/dsh package manifest could not be located beside the executable.',
      { dshPath: invocation.displayPath },
    ))
  } else {
    const packageVersion = typeof dshPackage.value.version === 'string' ? dshPackage.value.version : undefined
    const publicPackage = dshPackage.value.publishConfig?.access === 'public' && dshPackage.value.private !== true
    const packageMatches = packageVersion === version && publicPackage
    checks.push(check(
      'installation.package-identity',
      packageMatches ? 'PASS' : 'FAIL',
      packageMatches
        ? 'CLI version and public @deepseek-ai/dsh package identity agree.'
        : 'CLI version and public @deepseek-ai/dsh package identity do not agree.',
      {
        name: dshPackage.value.name,
        packageVersion,
        cliVersion: version,
        access: publicPackage ? 'public' : 'non-public',
      },
    ))
  }

  const capabilities = []
  for (const spec of CAPABILITIES) {
    capabilities.push(await inspectCapability(spec, dshPackage, version, lane))
  }
  capabilities.unshift({
    id: 'plugin.lifecycle',
    label: 'Profile and plugin lifecycle CLI',
    status: missingCli.length === 0 && lifecycle ? 'native' : 'partial',
    confidence: 'behavior',
    message: missingCli.length === 0 && lifecycle
      ? 'The installed CLI completed the controlled install, witnessed registration, discovery, and uninstall lifecycle.'
      : 'The installed CLI did not complete every required lifecycle check.',
    packages: [{ name: '@deepseek-ai/dsh', version }],
  })

  const runtime = {
    version,
    lane,
    dshPath: invocation.displayPath,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    package: dshPackage
      ? {
          name: dshPackage.value.name,
          version: dshPackage.value.version,
          access: dshPackage.value.publishConfig?.access,
        }
      : undefined,
  }
  const report = {
    kind: 'dsh-capabilities',
    ok: !checks.some((value) => value.blocking && value.status === 'FAIL'),
    verifiedAt: new Date().toISOString(),
    runtime,
    checks,
    capabilities,
  }
  report.evidenceDigest = digestEvidence(runtime, checks, capabilities)
  return report
}

export function formatCapabilityReport(report) {
  const lines = [
    (report.ok ? 'PASS' : 'FAIL') + ' DSH capabilities ' + report.runtime.version
      + ' [' + report.runtime.lane.claim + ']',
  ]
  for (const value of report.checks) {
    lines.push('  ' + value.status.padEnd(4) + ' ' + value.id + ': ' + value.message)
  }
  for (const capability of report.capabilities) {
    const evidence = capability.confidence + (capability.semantics ? '/' + capability.semantics : '')
    lines.push('  ' + capability.status.toUpperCase().padEnd(12)
      + ' ' + capability.id + ' [' + evidence + '] ' + capability.message)
  }
  lines.push('Evidence: ' + report.evidenceDigest)
  return lines.join('\n')
}

export function capabilitySpecs() {
  return CAPABILITIES.map((value) => ({
    id: value.id,
    label: value.label,
    packages: [...value.packages],
    experimental: Boolean(value.experimental),
    ...(value.partialGuarantee ? { partialGuarantee: value.partialGuarantee } : {}),
    reviewedVersions: [...REVIEWED_DSH_VERSIONS],
  }))
}
