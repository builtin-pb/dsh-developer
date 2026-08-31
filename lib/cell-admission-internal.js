import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectDshCapabilities } from './capabilities.js'
import {
  assertOfficialDshInvocation,
  installedPackageEvidence,
  locateDshPackage,
  locateInstalledDshPackage,
  resolveInstalledDshEntry,
} from './dsh-installation.js'
import { asDiagnostic, DshDeveloperError } from './errors.js'
import { conformExecutionLab } from './execution-lab.js'
import { resolveDshInvocation } from './runtime.js'

const CONTRACT_BYTES = 256 * 1024
const REVIEWED_EVIDENCE = Object.freeze([
  Object.freeze({
    id: 'dsh-discussion-4873',
    kind: 'dsh-community-demand',
    url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/4873',
    observedAt: '2026-08-31',
    runtime: '@deepseek-ai/dsh 0.1.1-rc.2',
    finding: 'A plugin author reports parallel subagents contaminating shared work and requests a disposable per-child write root.',
  }),
  Object.freeze({
    id: 'dsh-discussion-962',
    kind: 'dsh-community-security-reproduction',
    url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/962',
    observedAt: '2026-08-31',
    runtime: '@deepseek-ai/dsh 0.1.0-rc.6',
    finding: 'A keyless analysis reproduces readable credentials, host process visibility, and unrestricted sandbox network as one exfiltration path.',
  }),
  Object.freeze({
    id: 'codex-issue-31572',
    kind: 'cross-harness-corroboration',
    url: 'https://github.com/openai/codex/issues/31572',
    observedAt: '2026-08-31',
    runtime: 'Codex Desktop',
    finding: 'A shared-checkout multi-agent run reproduces branch drift and identifies isolated worktrees or verified per-child roots as acceptable remedies.',
  }),
])

const CANDIDATE = Object.freeze({
  id: 'isolated-agent-cell',
  guarantee: Object.freeze([
    'one separately owned disposable workspace per admitted child',
    'local OS boundary around every child-visible filesystem and command capability',
    'credential-free fixed environment and no child network',
    'bounded resources, cancellation, recovery, and verified orphan cleanup',
  ]),
  excluded: Object.freeze([
    'roster',
    'mailbox',
    'task board',
    'ordinary child lifecycle',
    'generic workflow orchestration',
  ]),
  trustedInput: 'the user-selected, provenance-reviewed official @deepseek-ai/dsh installation',
  exit: 'adopt equivalent public DSH behavior, shim older supported lanes, then deprecate and remove after an approved migration',
})

function check(id, status, message, evidence, blocking = true) {
  return {
    id,
    status,
    blocking,
    message,
    ...(evidence === undefined ? {} : { evidence }),
  }
}

async function loadInstalledModule(entry, dependencies) {
  if (dependencies.importModule) return dependencies.importModule(entry)
  return import(pathToFileURL(entry).href)
}

async function probeSharedWorkspace(invocation, runtimeVersion, dependencies) {
  try {
    const dshPackage = await locateDshPackage(invocation)
    if (!dshPackage) throw new DshDeveloperError('DSH_PACKAGE_NOT_FOUND', 'The official DSH package could not be located.')
    const installed = await locateInstalledDshPackage(dshPackage, '@deepseek-ai/dsh-subagent')
    if (!installed) throw new DshDeveloperError('DSH_SUBAGENT_NOT_FOUND', 'The public DSH subagent package is not installed.')
    const packageEvidence = installedPackageEvidence(installed)
    if (packageEvidence.version !== runtimeVersion || packageEvidence.access !== 'public') {
      throw new DshDeveloperError('DSH_SUBAGENT_IDENTITY_MISMATCH', 'The subagent package does not match the public DSH runtime.', {
        package: packageEvidence,
        runtimeVersion,
      })
    }
    const entry = await resolveInstalledDshEntry(installed)
    const module = await loadInstalledModule(entry, dependencies)
    if (typeof module.childSessionMeta !== 'function') {
      throw new DshDeveloperError('DSH_SUBAGENT_CONTRACT_UNKNOWN', 'The reviewed childSessionMeta behavior seam is unavailable.')
    }
    const workspace = process.platform === 'win32'
      ? 'C:\\dsh-developer\\admission-parent'
      : '/dsh-developer/admission-parent'
    const parent = {
      session: { header: { id: 'admission-parent', cwd: workspace } },
      ctx: { get: () => undefined },
    }
    const first = module.childSessionMeta(parent, 1, 0)
    const second = module.childSessionMeta(parent, 1, 0)
    const inherited = first?.cwd === workspace && second?.cwd === workspace
    const targetAlias = inherited
      && join(first.cwd, 'src', 'plugin.js') === join(second.cwd, 'src', 'plugin.js')
    return {
      ok: inherited && targetAlias,
      evidence: {
        package: packageEvidence,
        probe: 'childSessionMeta(parent, 1, 0) twice',
        bothChildrenInheritedParentWorkspace: inherited,
        representativeWriteTargetAliases: targetAlias,
      },
    }
  } catch (error) {
    return { ok: false, evidence: asDiagnostic(error) }
  }
}

async function readContract(path) {
  const info = await lstat(path).catch(() => undefined)
  if (!info?.isFile() || info.size > CONTRACT_BYTES) return undefined
  return readFile(path, 'utf8')
}

async function probeSandboxBoundary(invocation, runtimeVersion) {
  try {
    const dshPackage = await locateDshPackage(invocation)
    if (!dshPackage) throw new DshDeveloperError('DSH_PACKAGE_NOT_FOUND', 'The official DSH package could not be located.')
    const installed = await locateInstalledDshPackage(dshPackage, '@deepseek-ai/dsh-sandbox')
    if (!installed) throw new DshDeveloperError('DSH_SANDBOX_NOT_FOUND', 'The public DSH sandbox contract package is not installed.')
    const packageEvidence = installedPackageEvidence(installed)
    if (packageEvidence.version !== runtimeVersion || packageEvidence.access !== 'public') {
      throw new DshDeveloperError('DSH_SANDBOX_IDENTITY_MISMATCH', 'The sandbox package does not match the public DSH runtime.', {
        package: packageEvidence,
        runtimeVersion,
      })
    }
    const markdown = await readContract(join(installed.root, 'README.md'))
    if (markdown === undefined) {
      throw new DshDeveloperError('DSH_SANDBOX_CONTRACT_UNKNOWN', 'The installed sandbox contract is unavailable for bounded inspection.')
    }
    const sameWorld = /Same-world confinement only/iu.test(markdown)
    const fileEffectsOnly = /File effects are the whole policy vocabulary/iu.test(markdown)
    return {
      ok: sameWorld && fileEffectsOnly,
      evidence: {
        package: packageEvidence,
        sameWorldConfinement: sameWorld,
        fileEffectsOnly,
      },
    }
  } catch (error) {
    return { ok: false, evidence: asDiagnostic(error) }
  }
}

function digestReport(report) {
  const canonical = JSON.stringify({
    candidate: report.candidate,
    runtime: {
      version: report.runtime.version,
      lane: report.runtime.lane,
      platform: report.runtime.platform,
      arch: report.runtime.arch,
    },
    capabilityDigest: report.capabilityDigest,
    labDigest: report.labDigest,
    sources: report.sources,
    checks: report.checks.map(({ id, status, blocking, evidence }) => ({
      id,
      status,
      blocking,
      ...(evidence === undefined ? {} : { evidence }),
    })),
    disposition: report.disposition,
  })
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export async function inspectIsolatedCellAdmissionInternal(dshPath, options = {}, dependencies = {}) {
  const invocation = dependencies.resolveDshInvocation
    ? await dependencies.resolveDshInvocation(dshPath)
    : await resolveDshInvocation(dshPath)
  await assertOfficialDshInvocation(invocation)
  const inspectCapabilities = dependencies.inspectCapabilities ?? inspectDshCapabilities
  const capabilityReport = await inspectCapabilities(dshPath, {
    signal: options.signal,
    ...(dependencies.capabilitiesOptions ?? {}),
  })
  const laneReviewed = capabilityReport.runtime.lane.recognized
  const unreviewed = {
    ok: false,
    evidence: {
      code: 'DSH_LANE_UNREVIEWED',
      message: 'Installed behavior was not imported or classified because this DSH lane is unreviewed.',
    },
  }
  const sharedWorkspace = dependencies.sharedWorkspaceProbe
    ?? (laneReviewed ? await probeSharedWorkspace(invocation, capabilityReport.runtime.version, dependencies) : unreviewed)
  const sandboxBoundary = dependencies.sandboxBoundaryProbe
    ?? (laneReviewed ? await probeSandboxBoundary(invocation, capabilityReport.runtime.version) : unreviewed)
  const runLab = dependencies.conformLab ?? conformExecutionLab
  const labReport = await runLab({ distro: options.distro, signal: options.signal })
  const subagentCapability = capabilityReport.capabilities.find((value) => value.id === 'subagent.core')
  const teamCapability = capabilityReport.capabilities.find((value) => value.id === 'team.experimental')
  const stableSubagent = subagentCapability?.status === 'native'
  const stableTeamDoesNotCloseGap = teamCapability?.status === 'absent' || teamCapability?.status === 'experimental'

  const checks = [
    check(
      'harm.shared-workspace-alias',
      sharedWorkspace.ok ? 'PASS' : 'FAIL',
      sharedWorkspace.ok
        ? 'The exact installed DSH child metadata contract maps independent children onto the same representative write target.'
        : 'The shared-workspace failure was not reproduced on this exact DSH runtime.',
      sharedWorkspace.evidence,
    ),
    check(
      'corroboration.public-evidence',
      'PASS',
      'Independent DSH plugin-author and security reports reproduce workspace contamination and incomplete confidentiality; a separate harness reports the same shared-checkout failure class.',
      { sourceIds: REVIEWED_EVIDENCE.map((value) => value.id), observedAt: '2026-08-31' },
    ),
    check(
      'upstream.public-gap',
      laneReviewed && capabilityReport.ok && stableSubagent && stableTeamDoesNotCloseGap && sandboxBoundary.ok
        ? 'PASS'
        : 'FAIL',
      laneReviewed && capabilityReport.ok && stableSubagent && stableTeamDoesNotCloseGap && sandboxBoundary.ok
        ? 'DSH supplies lifecycle but the reviewed public contracts retain a shared child workspace and same-world, file-effect-only confinement; experimental Team does not close that gap.'
        : 'The exact DSH lane or its public contracts are not sufficiently classified to assert the gap.',
      {
        lane: capabilityReport.runtime.lane,
        subagentStatus: subagentCapability?.status,
        teamStatus: teamCapability?.status,
        sandbox: sandboxBoundary.evidence,
      },
    ),
    check(
      'replacement.local-boundary',
      labReport.ok ? 'PASS' : 'FAIL',
      labReport.ok
        ? 'The local WSL2/Bubblewrap provider enforces the candidate containment and cleanup prerequisites with fixed keyless fixtures.'
        : 'No verified local boundary is available, so execution-bearing incubation remains unsupported.',
      { provider: labReport.provider, digest: labReport.evidenceDigest },
    ),
    check(
      'replacement.exit-contract',
      'PASS',
      'The candidate excludes native lifecycle and coordination behavior and has an explicit upstream retirement path.',
      { excluded: CANDIDATE.excluded, exit: CANDIDATE.exit },
    ),
  ]
  const admitted = checks.every((value) => value.status === 'PASS')
  const disposition = admitted ? 'Incubate' : 'Unsupported'
  const report = {
    kind: 'isolated-agent-cell-admission',
    ok: admitted,
    admitted,
    verifiedAt: new Date().toISOString(),
    candidate: CANDIDATE,
    runtime: capabilityReport.runtime,
    capabilityDigest: capabilityReport.evidenceDigest,
    labDigest: labReport.evidenceDigest,
    sources: REVIEWED_EVIDENCE,
    checks,
    disposition,
  }
  report.evidenceDigest = digestReport(report)
  return report
}

export function formatCellAdmissionReport(report) {
  const lines = [
    (report.ok ? 'PASS' : 'FAIL') + ' isolated agent cell admission '
      + report.runtime.version + ' [' + report.runtime.lane.claim + '] — ' + report.disposition,
  ]
  for (const value of report.checks) {
    lines.push('  ' + value.status.padEnd(4) + ' ' + value.id + ': ' + value.message)
  }
  lines.push('Admitted guarantee:')
  for (const value of report.candidate.guarantee) lines.push('  - ' + value)
  lines.push('Explicitly excluded: ' + report.candidate.excluded.join(', '))
  lines.push('Trusted input: ' + report.candidate.trustedInput)
  lines.push('Capability evidence: ' + report.capabilityDigest)
  lines.push('Lab evidence: ' + report.labDigest)
  lines.push('Admission evidence: ' + report.evidenceDigest)
  return lines.join('\n')
}

export function isolatedCellEvidenceSources() {
  return REVIEWED_EVIDENCE.map((value) => ({ ...value }))
}
