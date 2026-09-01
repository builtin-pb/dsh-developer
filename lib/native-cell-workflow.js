import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path'
import { createCellStageAuthorityFactory } from './cell-stage-authority.js'
import { inspectIsolatedCellAdmission } from './cell-admission.js'
import { inspectDshCapabilities } from './capabilities.js'
import { LIMITS } from './constants.js'
import { doctorSource, reportDigest } from './doctor.js'
import { DshDeveloperError } from './errors.js'
import { fingerprintFileMap, scanOrdinaryTree } from './files.js'
import { openIsolatedCell } from './isolated-cell.js'
import { inspectProfilePreflight } from './profile-preflight.js'
import { findSecrets } from './security.js'

const PLAN_TTL_MS = 10 * 60 * 1_000
const DEFAULT_COMMAND_TIMEOUT_MS = LIMITS.commandTimeoutMs
const COMMAND_LIMIT = 4
const COMMAND_CHARS = 2_000
const OUTCOME_CHARS = 1_000
const MODEL_STREAM_CHARS = 16_000
const PROFILE = 'headless'
const TOOL_NAME = 'dsh_developer'
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u
const STAGE_PREFIX = '.dsh-developer-cell-authority-'
const DISCARD_PREFIX = '.dsh-developer-cell-discard-'
const DIAGNOSTIC_MESSAGE_CHARS = 800
const DIAGNOSTIC_PATH_CHARS = 2_000
const DIAGNOSTIC_DEPTH = 2
const DIAGNOSTIC_CHILDREN = 4
const RENDER_STREAM_CHARS = 2_000

const FIXED_POLICY = Object.freeze({
  version: 1,
  profile: PROFILE,
  dshLanes: Object.freeze(['0.1.1-rc.2', '0.1.2-alpha.3']),
  admission: Object.freeze({ provider: 'wsl2-bubblewrap', exact: true }),
  containment: Object.freeze({
    source: 'read-only-snapshot',
    repositoryExecution: 'isolated-copy-only',
    mounts: 'none-beyond-cell-owned-workspace',
    network: 'none',
    credentials: 'none',
    sourceWrites: 'none',
    realProfileWrites: 'none',
    outputBytes: LIMITS.commandOutputBytes,
    commandTimeoutMs: LIMITS.commandTimeoutMs,
    commands: COMMAND_LIMIT,
  }),
})

const PROCESS_SLOT = {
  record: null,
  tombstones: new WeakMap(),
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

function digest(value) {
  return 'sha256:' + createHash('sha256')
    .update(JSON.stringify(stableValue(value)), 'utf8')
    .digest('hex')
}

function error(code, message, details = {}) {
  return new DshDeveloperError(code, message, details)
}

function safeDiagnosticText(value, limit, fallback) {
  if (typeof value !== 'string' || value.length === 0) return fallback
  if (findSecrets(value).length > 0) return '[REDACTED: potential credential diagnostic]'
  return value.length <= limit ? value : value.slice(0, limit) + '[truncated]'
}

function safeDiagnosticCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(value)
    ? value
    : 'UNEXPECTED_ERROR'
}

function safeDiagnosticPath(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return safeDiagnosticText(value, DIAGNOSTIC_PATH_CHARS, undefined)
}

function safeDiagnosticDetails(details, depth, seen) {
  if (details === null || typeof details !== 'object' || Array.isArray(details)
      || depth >= DIAGNOSTIC_DEPTH || seen.has(details)) return {}
  seen.add(details)
  const output = {}
  for (const key of ['commandIndex', 'timeoutMs', 'limit']) {
    if (Number.isSafeInteger(details[key]) && details[key] >= 0) output[key] = details[key]
  }
  for (const key of ['expiresAt', 'phase', 'disposition', 'evidenceDigest', 'expected', 'actual']) {
    if (typeof details[key] === 'string') {
      output[key] = safeDiagnosticText(details[key], 200, '[unavailable]')
    }
  }
  const retainedRoot = safeDiagnosticPath(details.retainedRoot)
  if (retainedRoot !== undefined) output.retainedRoot = retainedRoot
  if (Array.isArray(details.findingKinds)) {
    output.findingKinds = details.findingKinds.slice(0, 8)
      .filter((value) => typeof value === 'string')
      .map((value) => safeDiagnosticText(value, 80, '[unavailable]'))
  }
  let children = 0
  for (const key of ['cleanup', 'operation', 'failure', 'command']) {
    if (details[key] !== undefined && children < DIAGNOSTIC_CHILDREN) {
      output[key] = safeCellWorkflowDiagnostic(details[key], depth + 1, seen)
      children += 1
    }
  }
  return output
}

export function safeCellWorkflowDiagnostic(cause, depth = 0, seen = new WeakSet()) {
  const trusted = cause instanceof DshDeveloperError
  const diagnosticLike = cause !== null && typeof cause === 'object'
    && typeof cause.code === 'string' && typeof cause.message === 'string'
  const code = trusted || diagnosticLike ? safeDiagnosticCode(cause.code) : 'UNEXPECTED_ERROR'
  const message = trusted || diagnosticLike
    ? safeDiagnosticText(cause.message, DIAGNOSTIC_MESSAGE_CHARS, 'Isolated Build failed.')
    : 'An unexpected isolated Build failure occurred.'
  const details = trusted || diagnosticLike
    ? safeDiagnosticDetails(cause.details, depth, seen)
    : {}
  return { code, message, ...details }
}

export function toModelSafeCellWorkflowError(cause) {
  const diagnostic = safeCellWorkflowDiagnostic(cause)
  const { code, message, ...details } = diagnostic
  return error(code, message, details)
}

function assertActive(signal, message = 'Isolated Build workflow was cancelled.') {
  if (signal?.aborted) throw error('CANCELLED', message)
}

function combineSignals(...signals) {
  const usable = signals.filter(Boolean)
  if (usable.length === 0) return undefined
  if (usable.length === 1) return usable[0]
  return AbortSignal.any(usable)
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) deepFreeze(nested)
  return value
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function samePathSnapshot(left, right) {
  return left.length === right.length && left.every((entry, index) => (
    entry.path === right[index].path
      && entry.dev === right[index].dev
      && entry.ino === right[index].ino
  ))
}

function pathInside(parent, candidate) {
  const relation = relative(resolve(parent), resolve(candidate))
  return relation === ''
    || (relation !== '..' && !relation.startsWith('..' + sep) && !isAbsolute(relation))
}

function runtimeProfileDirectory(environment = process.env) {
  const configured = typeof environment.DSH_HOME === 'string' && environment.DSH_HOME.trim().length > 0
    ? environment.DSH_HOME
    : join(homedir(), '.dsh')
  const expanded = configured === '~'
    ? homedir()
    : configured.startsWith('~/') || configured.startsWith('~\\')
      ? join(homedir(), configured.slice(2))
      : configured
  return resolve(expanded)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function assertExactObject(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw error('TOOL_USAGE', label + ' must be one JSON object.')
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw error('TOOL_USAGE', 'Field "' + key + '" is not valid in ' + label + '.')
  }
}

export function validateCellPlanFields(input) {
  if (!nonEmptyString(input.outcome) || input.outcome.length > OUTCOME_CHARS || input.outcome.includes('\0')) {
    throw error('TOOL_USAGE', 'outcome must be a non-empty string of at most ' + OUTCOME_CHARS + ' characters.')
  }
  const outcomeFindings = findSecrets(input.outcome)
  if (outcomeFindings.length > 0) {
    throw error('CELL_PLAN_SECRET', 'outcome contains potential credentials and cannot enter an approval record.', {
      findingKinds: outcomeFindings,
    })
  }
  if (!Array.isArray(input.commands) || input.commands.length < 1 || input.commands.length > COMMAND_LIMIT) {
    throw error('TOOL_USAGE', 'commands must contain 1 to ' + COMMAND_LIMIT + ' ordered command objects.')
  }
  const commands = input.commands.map((item, index) => {
    assertExactObject(item, new Set(['command', 'timeoutMs']), 'commands[' + index + ']')
    if (!nonEmptyString(item.command) || item.command.length > COMMAND_CHARS || item.command.includes('\0')) {
      throw error('TOOL_USAGE', 'commands[' + index + '].command must be non-empty, NUL-free, and at most '
        + COMMAND_CHARS + ' characters.')
    }
    const findings = findSecrets(item.command)
    if (findings.length > 0) {
      throw error('CELL_PLAN_SECRET', 'commands[' + index + '] contains potential credentials and cannot enter an approval record.', {
        index,
        findingKinds: findings,
      })
    }
    const timeoutMs = item.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.commandTimeoutMs) {
      throw error('TOOL_USAGE', 'commands[' + index + '].timeoutMs must be an integer from 1 through '
        + LIMITS.commandTimeoutMs + '.')
    }
    return deepFreeze({ command: item.command, timeoutMs })
  })
  return deepFreeze({ outcome: input.outcome, commands })
}

function validateDigest(value) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw error('TOOL_USAGE', 'planDigest must be a sha256 digest.')
  }
  return value
}

async function ordinaryPathSnapshot(path, signal) {
  const absolute = resolve(path)
  if (!isAbsolute(path)) {
    throw error('CELL_WORKSPACE_AUTHORITY_UNAVAILABLE', 'The live agent workspace authority is not an absolute path.')
  }
  const root = parse(absolute).root
  const segments = relative(root, absolute).split(sep).filter(Boolean)
  const snapshot = []
  let current = root
  for (const segment of [null, ...segments]) {
    assertActive(signal, 'Workspace identity inspection was cancelled.')
    if (segment !== null) current = join(current, segment)
    const info = await lstat(current, { bigint: true }).catch((cause) => {
      throw error('CELL_WORKSPACE_AUTHORITY_UNAVAILABLE', 'The live agent workspace path is unavailable.', {
        path: current,
        cause: cause.message,
      })
    })
    if (info.isSymbolicLink()) {
      throw error('CELL_WORKSPACE_LINK', 'The live agent workspace authority traverses a symbolic link or junction.', {
        linkedAncestor: current,
      })
    }
    if (!info.isDirectory()) {
      throw error('CELL_WORKSPACE_AUTHORITY_UNAVAILABLE', 'Every live agent workspace ancestor must be an ordinary directory.', {
        path: current,
      })
    }
    snapshot.push({ path: current, dev: String(info.dev), ino: String(info.ino) })
  }
  return snapshot
}

async function inspectProfileFence(path, signal) {
  const reserved = resolve(path)
  let existing = reserved
  let exists = true
  while (true) {
    assertActive(signal, 'Real-profile identity inspection was cancelled.')
    try {
      await lstat(existing)
      break
    } catch (cause) {
      if (cause?.code !== 'ENOENT') {
        throw error('CELL_PROFILE_AUTHORITY_UNAVAILABLE', 'The real-profile fence cannot be inspected.')
      }
      exists = false
      const parent = dirname(existing)
      if (parent === existing) {
        throw error('CELL_PROFILE_AUTHORITY_UNAVAILABLE', 'No physical ancestor proves the real-profile fence.')
      }
      existing = parent
    }
  }
  const before = await ordinaryPathSnapshot(existing, signal)
  const ancestorPhysical = resolve(await realpath(existing).catch(() => {
    throw error('CELL_PROFILE_AUTHORITY_UNAVAILABLE', 'The real-profile physical ancestor cannot be resolved.')
  }))
  const after = await ordinaryPathSnapshot(existing, signal)
  if (!samePathSnapshot(before, after)) {
    throw error('CELL_PROFILE_AUTHORITY_CHANGED', 'The real-profile fence changed during physical inspection.')
  }
  const physicalRoot = resolve(ancestorPhysical, relative(existing, reserved))
  const identityDigest = digest({
    reserved,
    existing,
    exists: exists && existing === reserved,
    physicalRoot,
    pathIdentity: after,
  })
  return deepFreeze({
    path: reserved,
    physicalRoot,
    exists: exists && existing === reserved,
    identityDigest,
  })
}

async function assertProfileFence(record, signal) {
  const current = await inspectProfileFence(record.profile.path, signal)
  if (current.identityDigest !== record.profile.identityDigest) {
    throw error('CELL_PROFILE_AUTHORITY_CHANGED', 'The real-profile physical fence changed after planning.')
  }
  return current
}

export async function inspectLiveAgentWorkspace(agent, options = {}) {
  if (agent === null || typeof agent !== 'object' || agent.ctx === null || typeof agent.ctx !== 'object') {
    throw error('CELL_AGENT_REQUIRED', 'Isolated Build requires the exact live top-level exec.agent object.')
  }
  if (typeof options.isRootAgent !== 'function' || options.isRootAgent(agent) !== true) {
    throw error(
      'CELL_ROOT_AGENT_NOT_LIVE',
      'The exact exec.agent object is not present in the authoritative live top-level Agent registry.',
    )
  }
  const header = agent.session?.header
  if (header === null || typeof header !== 'object') {
    throw error('CELL_WORKSPACE_AUTHORITY_UNAVAILABLE', 'The live agent session header is unavailable.')
  }
  const childMarkers = header.origin === 'subagent'
    || header.parentSession !== undefined
    || (header.delegationDepth !== undefined && header.delegationDepth !== 0)
  if (childMarkers) {
    throw error('CELL_TOP_LEVEL_AGENT_REQUIRED', 'Delegated, sibling, and child Agent contexts cannot own an isolated Build workflow.')
  }
  if (!nonEmptyString(header.id) || !nonEmptyString(header.cwd) || !isAbsolute(header.cwd)) {
    throw error(
      'CELL_WORKSPACE_AUTHORITY_UNAVAILABLE',
      'The exact live session.header.id and absolute session.header.cwd authorities are required; process cwd is never used.',
    )
  }
  const before = await ordinaryPathSnapshot(header.cwd, options.signal)
  const physicalRoot = await realpath(resolve(header.cwd)).catch((cause) => {
    throw error('CELL_WORKSPACE_AUTHORITY_UNAVAILABLE', 'The live agent workspace physical path cannot be resolved.', {
      path: resolve(header.cwd),
      cause: cause.message,
    })
  })
  const after = await ordinaryPathSnapshot(header.cwd, options.signal)
  if (!samePathSnapshot(before, after)) {
    throw error('CELL_WORKSPACE_MUTATED', 'The live agent workspace path changed while physical authority was verified.')
  }
  const physical = resolve(physicalRoot)
  const finalEntry = after.at(-1)
  return deepFreeze({
    root: physical,
    headerPath: resolve(header.cwd),
    sessionId: header.id,
    pathIdentity: after,
    identityDigest: digest({ physical, pathIdentity: after }),
    rootIdentity: { dev: finalEntry.dev, ino: finalEntry.ino },
  })
}

function runtimeBinding(report) {
  const runtime = report?.runtime
  if (report?.ok !== true || runtime?.lane?.recognized !== true || !FIXED_POLICY.dshLanes.includes(runtime.version)) {
    throw error('CELL_DSH_LANE_UNAVAILABLE', 'Isolated Build requires an exact reviewed release or preview DSH lane.', {
      runtime: runtime ? { version: runtime.version, lane: runtime.lane } : null,
    })
  }
  return deepFreeze({
    version: runtime.version,
    lane: runtime.lane,
    package: runtime.package,
    evidenceDigest: report.evidenceDigest,
  })
}

function planPayload(record, evidence) {
  return {
    version: 1,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ownerNonce: record.ownerNonce,
    outcome: record.outcome,
    commands: record.commands,
    workspace: {
      root: evidence.workspace.root,
      identityDigest: evidence.workspace.identityDigest,
      rootIdentity: evidence.workspace.rootIdentity,
    },
    profileFence: {
      identityDigest: evidence.profile.identityDigest,
      physicalRoot: evidence.profile.physicalRoot,
    },
    sourceFingerprint: evidence.tree.fingerprint,
    doctorDigest: reportDigest(evidence.doctor),
    runtime: evidence.runtime,
    policy: FIXED_POLICY,
  }
}

function planReport(record, evidence) {
  return {
    kind: 'isolated-cell-plan',
    version: 1,
    ok: true,
    outcome: record.outcome,
    planDigest: record.digest,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    commands: record.commands.map((command, index) => ({
      index: index + 1,
      command: command.command,
      timeoutMs: command.timeoutMs,
    })),
    source: {
      path: evidence.workspace.root,
      authority: 'live-root-agent-session.header.cwd',
      physicalIdentity: evidence.workspace.identityDigest,
      fingerprint: evidence.tree.fingerprint,
      unchanged: true,
    },
    runtime: evidence.runtime,
    policy: FIXED_POLICY,
    effects: {
      source: 'none',
      stage: 'none-until-approved-run',
      realProfile: 'none',
      realProfilePhysicalIdentity: evidence.profile.identityDigest,
      executionAuthority: 'none-plan-is-not-approval',
    },
    approval: {
      required: 'audited-tools/pre-execute-allowed-once',
      boundToDigest: true,
      granted: false,
    },
  }
}

function renderApprovalReason(record) {
  const lines = [
    'Approve this exact isolated Build plan once.',
    'Outcome: ' + record.outcome,
    'Plan: ' + record.digest,
    'Source: ' + record.workspace.root,
    'Source fingerprint: ' + record.sourceFingerprint,
    'DSH lane: ' + record.runtime.version + ' (' + record.runtime.lane.id + ')',
    'Authority: isolated copy only; source and real profiles stay unchanged; network, host mounts, and credentials are unavailable.',
    'Commands:',
  ]
  for (const [index, item] of record.commands.entries()) {
    lines.push((index + 1) + '. [' + item.timeoutMs + ' ms] ' + item.command)
  }
  return lines.join('\n')
}

function parseApprovalInput(exec) {
  if (exec?.name !== TOOL_NAME) return null
  const input = exec.arguments
  if (input === null || typeof input !== 'object' || Array.isArray(input) || input.operation !== 'cell-run') return null
  assertExactObject(input, new Set(['operation', 'planDigest']), 'cell-run')
  return { planDigest: validateDigest(input.planDigest) }
}

function capacityDetails(record) {
  return {
    limit: 1,
    phase: record.phase,
    retainedRoot: record.stage?.anchor ?? null,
  }
}

function tombstonesFor(slot, owner) {
  let values = slot.tombstones.get(owner)
  if (values === undefined) {
    values = new Set()
    slot.tombstones.set(owner, values)
  }
  return values
}

async function stageIdentity(root) {
  const info = await lstat(root, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw error('CELL_STAGE_IDENTITY_MISMATCH', 'The retained stage root is no longer its owned ordinary directory.', { root })
  }
  return { dev: String(info.dev), ino: String(info.ino), mode: Number(info.mode) }
}

async function setDirectoryModeByIdentity(path, expectedIdentity, mode) {
  let handle
  try {
    handle = await open(path, 'r')
    const info = await handle.stat({ bigint: true })
    if (!info.isDirectory() || !sameIdentity(
      { dev: String(info.dev), ino: String(info.ino) },
      expectedIdentity,
    )) {
      throw error('CELL_STAGE_IDENTITY_MISMATCH', 'The controller refused to change mode on a replaced stage directory.', {
        retainedRoot: path,
      })
    }
    try {
      await handle.chmod(mode)
      return
    } catch (cause) {
      if (process.platform !== 'win32' || cause?.code !== 'EPERM') throw cause
    }
  } finally {
    await handle?.close()
  }
  const before = await stageIdentity(path)
  if (!sameIdentity(before, expectedIdentity)) {
    throw error('CELL_STAGE_IDENTITY_MISMATCH', 'The controller refused a Windows mode change on a replaced stage directory.', {
      retainedRoot: path,
    })
  }
  await chmod(path, mode)
  const after = await stageIdentity(path)
  if (!sameIdentity(after, expectedIdentity)) {
    throw error('CELL_STAGE_IDENTITY_MISMATCH', 'The stage directory changed during its Windows mode transition.', {
      retainedRoot: path,
    })
  }
}

function prefixSnapshotMatches(expected, actual) {
  return actual.length === expected.length + 1
    && samePathSnapshot(expected, actual.slice(0, expected.length))
}

async function selectStageBase(record, dependencies, signal) {
  const tempPhysical = resolve(await realpath(dependencies.getTempDirectory()))
  const candidates = [tempPhysical, dirname(record.workspace.root), dirname(record.profile.physicalRoot)]
  const visited = new Set()
  for (const initial of candidates) {
    let candidate = resolve(initial)
    while (!visited.has(candidate)) {
      visited.add(candidate)
      if (!pathInside(record.workspace.root, candidate)
          && !pathInside(record.profile.physicalRoot, candidate)) {
        try {
          const snapshot = await ordinaryPathSnapshot(candidate, signal)
          const physical = resolve(await realpath(candidate))
          if (physical === candidate) return { base: candidate, snapshot }
        } catch {
          assertActive(signal, 'Result-stage base inspection was cancelled.')
          // Try the next physical ancestor; failure remains closed if none is usable.
        }
      }
      const parent = dirname(candidate)
      if (parent === candidate) break
      candidate = parent
    }
  }
  throw error('CELL_STAGE_SEPARATION_LOST', 'No ordinary controller stage base is provably outside source and real profile.')
}

async function verifyStageCapability(record, stage, options = {}) {
  const ancestry = await ordinaryPathSnapshot(stage.anchor, options.signal)
  if (!prefixSnapshotMatches(stage.baseSnapshot, ancestry)
      || !sameIdentity(ancestry.at(-1), stage.anchorIdentity)) {
    throw error('CELL_STAGE_ANCESTRY_MISMATCH', 'The controller-owned stage ancestry changed; cleanup remains poisoned.', {
      retainedRoot: stage.anchor,
    })
  }
  const anchorPhysical = resolve(await realpath(stage.anchor))
  const profile = await assertProfileFence(record, options.signal)
  if (anchorPhysical !== resolve(stage.anchor)
      || pathInside(record.workspace.root, anchorPhysical)
      || pathInside(anchorPhysical, record.workspace.root)
      || pathInside(profile.physicalRoot, anchorPhysical)
      || pathInside(anchorPhysical, profile.physicalRoot)) {
    throw error('CELL_STAGE_SEPARATION_LOST', 'The controller-owned stage is no longer physically separated from source and real profile.', {
      retainedRoot: stage.anchor,
    })
  }
  const anchorIdentity = await stageIdentity(stage.anchor)
  if (!sameIdentity(anchorIdentity, stage.anchorIdentity)) {
    throw error('CELL_STAGE_IDENTITY_MISMATCH', 'The controller-owned stage anchor identity changed.', {
      retainedRoot: stage.anchor,
    })
  }
  if (options.requireRoot !== false) {
    const expectedRoot = stage.quarantineName === undefined
      ? join(stage.anchor, 'stage')
      : join(stage.anchor, stage.quarantineName)
    if (stage.root !== expectedRoot) {
      throw error('CELL_STAGE_OWNERSHIP_INVALID', 'The retained stage root is not the exact controller-minted child.', {
        retainedRoot: stage.anchor,
      })
    }
    const rootIdentity = await stageIdentity(stage.root)
    if (!sameIdentity(rootIdentity, stage.rootIdentity)
        || resolve(await realpath(stage.root)) !== resolve(stage.root)) {
      throw error('CELL_STAGE_IDENTITY_MISMATCH', 'The controller-owned stage root identity changed.', {
        retainedRoot: stage.anchor,
      })
    }
  }
  if (options.requireDestination !== false) {
    if (stage.destination !== join(stage.root, 'result')) {
      throw error('CELL_STAGE_OWNERSHIP_INVALID', 'The retained result is not the exact controller-minted result child.', {
        retainedRoot: stage.anchor,
      })
    }
    const destinationIdentity = await stageIdentity(stage.destination)
    if (!sameIdentity(destinationIdentity, stage.destinationIdentity)
        || resolve(await realpath(stage.destination)) !== resolve(stage.destination)) {
      throw error('CELL_STAGE_IDENTITY_MISMATCH', 'The controller-owned result identity changed.', {
        retainedRoot: stage.anchor,
      })
    }
  }
}

async function mintStageAuthority(record, dependencies, capability, signal) {
  assertActive(signal, 'Result-stage authority minting was cancelled.')
  if (record.stage !== undefined) {
    throw error('CELL_STAGE_AUTHORITY_REUSED', 'Only one controller-owned stage authority may exist.')
  }
  await assertProfileFence(record, signal)
  const selectedBase = await selectStageBase(record, dependencies, signal)
  const stagingBase = selectedBase.base
  const baseSnapshot = selectedBase.snapshot
  assertActive(signal, 'Result-stage authority minting was cancelled before filesystem allocation.')
  const anchor = await dependencies.makeTemp(join(stagingBase, STAGE_PREFIX))
  const stage = {
    state: 'minting',
    capability,
    anchor,
    root: join(anchor, 'stage'),
    destination: join(anchor, 'stage', 'result'),
    baseSnapshot,
    anchorIdentity: await stageIdentity(anchor),
    rootIdentity: undefined,
    destinationIdentity: undefined,
    sourceFingerprint: record.sourceFingerprint,
    fingerprint: null,
    changes: { created: [], modified: [], deleted: [] },
    cleanup: undefined,
  }
  record.stage = stage
  await dependencies.makeDirectory(stage.root, { mode: 0o700 })
  await dependencies.makeDirectory(stage.destination, { mode: 0o700 })
  stage.rootIdentity = await stageIdentity(stage.root)
  stage.destinationIdentity = await stageIdentity(stage.destination)
  await verifyStageCapability(record, stage, { signal })
  await dependencies.setDirectoryMode(stage.anchor, stage.anchorIdentity, 0o500)
  stage.state = 'minted'
  stage.authorityDigest = digest({
    anchor: stage.anchor,
    anchorIdentity: stage.anchorIdentity,
    rootIdentity: stage.rootIdentity,
    destinationIdentity: stage.destinationIdentity,
    sourceIdentity: record.workspace.identityDigest,
    ownerNonce: record.ownerNonce,
  })
  return { root: stage.root, destination: stage.destination }
}

function validateChangedPaths(changes) {
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) return false
  return ['created', 'modified', 'deleted'].every((key) => Array.isArray(changes[key])
    && changes[key].length <= LIMITS.fileCount
    && changes[key].every((value) => typeof value === 'string' && value.length <= LIMITS.longTextChars))
}

async function sealStageResult(record, staged, dependencies, capability, signal) {
  if (staged === null || typeof staged !== 'object' || typeof staged.changed !== 'boolean'
      || staged.sourceFingerprint !== record.sourceFingerprint || !validateChangedPaths(staged.changes)) {
    throw error('CELL_STAGE_RESULT_INVALID', 'The authentic cell returned malformed or source-mismatched stage evidence.')
  }
  if (!staged.changed) {
    if (record.stage !== undefined
        || staged.staging !== undefined
        || staged.stagingRoot !== undefined
        || staged.stageAuthority !== undefined
        || staged.resultFingerprint !== record.sourceFingerprint
        || staged.changes.created.length + staged.changes.modified.length + staged.changes.deleted.length !== 0) {
      throw error('CELL_STAGE_RESULT_INVALID', 'An unchanged cell result carried unowned or inconsistent stage evidence.')
    }
    return undefined
  }
  const stage = record.stage
  if (stage === undefined || stage.state !== 'minted'
      || staged.stageAuthority !== capability
      || resolve(staged.stagingRoot) !== resolve(stage.root)
      || resolve(staged.staging) !== resolve(stage.destination)
      || resolve(staged.staging) !== resolve(join(staged.stagingRoot, 'result'))
      || !DIGEST_PATTERN.test(staged.resultFingerprint)) {
    throw error('CELL_STAGE_OWNERSHIP_INVALID', 'Changed bytes were not returned through the exact controller-minted stage authority.', {
      retainedRoot: stage?.anchor,
    })
  }
  await verifyStageCapability(record, stage, { signal })
  const verified = await dependencies.scanTree(stage.destination, { signal })
  assertActive(signal, 'Result-stage sealing was cancelled after fingerprint verification.')
  if (verified.fingerprint !== staged.resultFingerprint) {
    throw error('CELL_STAGE_MUTATED', 'The controller-owned result differs from the cell snapshot fingerprint.', {
      expected: staged.resultFingerprint,
      actual: verified.fingerprint,
      retainedRoot: stage.anchor,
    })
  }
  stage.state = 'sealed'
  stage.fingerprint = staged.resultFingerprint
  stage.changes = deepFreeze(structuredClone(staged.changes))
  return stage
}

function expectedRemainingFingerprint(cleanup) {
  const remaining = new Map(cleanup.manifest
    .filter((entry) => !cleanup.removedFiles.has(entry.path))
    .map((entry) => [entry.path, entry.content]))
  return fingerprintFileMap(remaining)
}

async function verifyCleanupTree(stage, dependencies) {
  const tree = await dependencies.scanTree(stage.destination, {})
  if (tree.fingerprint !== expectedRemainingFingerprint(stage.cleanup)) {
    throw error('CELL_STAGE_MUTATED', 'The quarantined result no longer matches resumable cleanup evidence.', {
      retainedRoot: stage.anchor,
    })
  }
  return tree
}

async function drainQuarantine(record, dependencies) {
  const stage = record.stage
  const cleanup = stage.cleanup
  const directories = new Set()
  if (!cleanup.destinationRemoved) {
    await verifyStageCapability(record, stage)
    await verifyCleanupTree(stage, dependencies)
    for (const entry of cleanup.manifest) {
      const absolute = join(stage.destination, ...entry.path.split('/'))
      let current = dirname(absolute)
      while (current !== stage.destination && pathInside(stage.destination, current)) {
        directories.add(current)
        current = dirname(current)
      }
      if (cleanup.removedFiles.has(entry.path)) continue
      await dependencies.cleanupBarrier('before-delete-entry', { record, stage, path: entry.path })
      await verifyStageCapability(record, stage)
      const info = await lstat(absolute)
      if (!info.isFile() || info.isSymbolicLink()
          || await readFile(absolute, 'utf8') !== entry.content) {
        throw error('CELL_STAGE_CLEANUP_AMBIGUOUS', 'A quarantined file changed before deletion.', {
          retainedRoot: stage.anchor,
        })
      }
      await unlink(absolute)
      cleanup.removedFiles.add(entry.path)
    }
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      if (cleanup.removedDirectories.has(directory)) continue
      await dependencies.cleanupBarrier('before-delete-directory', { record, stage, path: directory })
      await verifyStageCapability(record, stage)
      if ((await readdir(directory)).length !== 0) {
        throw error('CELL_STAGE_CLEANUP_AMBIGUOUS', 'Unexpected entries remain in a quarantined directory.', {
          retainedRoot: stage.anchor,
        })
      }
      await rmdir(directory)
      cleanup.removedDirectories.add(directory)
    }
    await verifyStageCapability(record, stage)
    if ((await readdir(stage.destination)).length !== 0) {
      throw error('CELL_STAGE_CLEANUP_AMBIGUOUS', 'Unexpected entries remain in the quarantined result.', {
        retainedRoot: stage.anchor,
      })
    }
    await rmdir(stage.destination)
    cleanup.destinationRemoved = true
  }
  if (!cleanup.rootRemoved) {
    await dependencies.setDirectoryMode(stage.anchor, stage.anchorIdentity, 0o700)
    try {
      await verifyStageCapability(record, stage, { requireDestination: false })
      if ((await readdir(stage.root)).length !== 0) {
        throw error('CELL_STAGE_CLEANUP_AMBIGUOUS', 'Unexpected entries remain in the quarantined stage root.', {
          retainedRoot: stage.anchor,
        })
      }
      await rmdir(stage.root)
      cleanup.rootRemoved = true
    } finally {
      if (!cleanup.anchorRemoved) {
        await dependencies.setDirectoryMode(stage.anchor, stage.anchorIdentity, 0o500)
      }
    }
  }
  if (!cleanup.anchorRemoved) {
    await verifyStageCapability(record, stage, { requireRoot: false, requireDestination: false })
    if ((await readdir(stage.anchor)).length !== 0) {
      throw error('CELL_STAGE_CLEANUP_AMBIGUOUS', 'Unexpected entries remain in the quarantined authority root.', {
        retainedRoot: stage.anchor,
      })
    }
    await rmdir(stage.anchor)
    cleanup.anchorRemoved = true
  }
  return { removed: true, absent: false, root: stage.anchor }
}

function startCleanupDrain(record, dependencies) {
  const cleanup = record.stage.cleanup
  if (cleanup.promise !== undefined) return cleanup.promise
  const operation = drainQuarantine(record, dependencies)
  cleanup.promise = operation
  operation.then(
    () => {},
    () => { if (cleanup.promise === operation) cleanup.promise = undefined },
  )
  return operation
}

async function assertRetainedStagePresent(stage) {
  try {
    await lstat(stage.anchor)
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      throw error('CELL_STAGE_MISSING', 'The retained controller stage is missing; deletion cannot be verified.', {
        retainedRoot: stage.anchor,
      })
    }
    throw cause
  }
}

async function discardStage(record, dependencies, callerSignal) {
  let stage = record.stage
  if (stage === undefined) return { removed: false, absent: true, root: null }
  await assertRetainedStagePresent(stage)
  if (stage.cleanup?.promise !== undefined) return stage.cleanup.promise
  if (stage.state === 'deleting') return startCleanupDrain(record, dependencies)
  if (stage.state === 'quarantined') {
    assertActive(callerSignal, 'Stage cleanup was cancelled before verified deletion began.')
    await verifyStageCapability(record, stage, { signal: callerSignal })
    const movedTree = await dependencies.scanTree(stage.destination, { signal: callerSignal })
    if (stage.fingerprint !== null && movedTree.fingerprint !== stage.fingerprint) {
      throw error('CELL_STAGE_MUTATED', 'The quarantined result changed before cleanup could resume.', {
        retainedRoot: stage.anchor,
      })
    }
    await dependencies.cleanupBarrier('before-cleanup-commit', { record, stage })
    assertActive(callerSignal, 'Stage cleanup was cancelled before verified deletion began.')
    stage.cleanup = {
      manifest: movedTree.entries.map((entry) => ({ path: entry.path, content: entry.content })),
      removedFiles: new Set(),
      removedDirectories: new Set(),
      destinationRemoved: false,
      rootRemoved: false,
      anchorRemoved: false,
      promise: undefined,
    }
    stage.state = 'deleting'
    return startCleanupDrain(record, dependencies)
  }
  assertActive(callerSignal, 'Stage cleanup was cancelled before quarantine.')
  await verifyStageCapability(record, stage, { signal: callerSignal })
  const verified = await dependencies.scanTree(stage.destination, { signal: callerSignal })
  assertActive(callerSignal, 'Stage cleanup was cancelled before quarantine.')
  if (stage.fingerprint !== null && verified.fingerprint !== stage.fingerprint) {
    throw error('CELL_STAGE_MUTATED', 'The retained stage changed after sealing; capacity remains poisoned.', {
      retainedRoot: stage.anchor,
      expected: stage.fingerprint,
      actual: verified.fingerprint,
    })
  }
  await dependencies.cleanupBarrier('before-quarantine-rename', { record, stage })
  assertActive(callerSignal, 'Stage cleanup was cancelled before quarantine.')
  const originalRoot = stage.root
  const quarantineName = DISCARD_PREFIX + dependencies.randomUUID()
  const quarantine = join(stage.anchor, quarantineName)
  await dependencies.setDirectoryMode(stage.anchor, stage.anchorIdentity, 0o700)
  try {
    await verifyStageCapability(record, stage, { signal: callerSignal })
    await rename(originalRoot, quarantine)
    stage = {
      ...stage,
      state: 'quarantined',
      originalRoot,
      quarantineName,
      root: quarantine,
      destination: join(quarantine, 'result'),
    }
    record.stage = stage
  } finally {
    await dependencies.setDirectoryMode(stage.anchor, stage.anchorIdentity, 0o500)
  }
  await dependencies.cleanupBarrier('after-quarantine-rename', { record, stage })
  await verifyStageCapability(record, stage, { signal: callerSignal })
  const originalMissing = await lstat(originalRoot).then(() => false, (cause) => cause.code === 'ENOENT')
  if (!originalMissing) {
    throw error('CELL_STAGE_CLEANUP_AMBIGUOUS', 'The original stage authority path reappeared after quarantine.', {
      retainedRoot: stage.anchor,
    })
  }
  const movedTree = await dependencies.scanTree(stage.destination, { signal: callerSignal })
  if (movedTree.fingerprint !== verified.fingerprint) {
    throw error('CELL_STAGE_MUTATED', 'The quarantined result changed during the ownership transition.', {
      retainedRoot: stage.anchor,
    })
  }
  await dependencies.cleanupBarrier('before-cleanup-commit', { record, stage })
  assertActive(callerSignal, 'Stage cleanup was cancelled before verified deletion began.')
  stage.cleanup = {
    manifest: movedTree.entries.map((entry) => ({ path: entry.path, content: entry.content })),
    removedFiles: new Set(),
    removedDirectories: new Set(),
    destinationRemoved: false,
    rootRemoved: false,
    anchorRemoved: false,
    promise: undefined,
  }
  stage.state = 'deleting'
  return startCleanupDrain(record, dependencies)
}

function boundedOutput(text) {
  if (text.length <= MODEL_STREAM_CHARS) return { text, truncated: false, originalChars: text.length }
  return {
    text: text.slice(0, MODEL_STREAM_CHARS) + '\n[truncated by dsh-developer]',
    truncated: true,
    originalChars: text.length,
  }
}

function safeCommandResult(index, item, result) {
  if (result === null || typeof result !== 'object'
      || typeof result.stdout !== 'string'
      || typeof result.stderr !== 'string'
      || !Number.isInteger(result.exitCode)
      || result.exitCode < 0 || result.exitCode > 255) {
    throw error('CELL_COMMAND_RESULT_INVALID', 'The isolated cell returned a malformed bounded command result.', {
      commandIndex: index,
    })
  }
  const findings = [...new Set([
    ...findSecrets(result.stdout),
    ...findSecrets(result.stderr),
  ])].sort()
  const redacted = findings.length > 0
  const stdout = redacted ? { text: '[REDACTED: potential credential output]', truncated: false, originalChars: result.stdout.length }
    : boundedOutput(result.stdout)
  const stderr = redacted ? { text: '[REDACTED: potential credential output]', truncated: false, originalChars: result.stderr.length }
    : boundedOutput(result.stderr)
  return {
    index: index + 1,
    command: item.command,
    commandDigest: digest({ command: item.command, timeoutMs: item.timeoutMs }),
    timeoutMs: item.timeoutMs,
    exitCode: result.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    output: {
      redacted,
      findingKinds: findings,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      stdoutChars: stdout.originalChars,
      stderrChars: stderr.originalChars,
    },
    cleanup: {
      observed: Number.isSafeInteger(result.cleanup?.observed) && result.cleanup.observed >= 0
        ? result.cleanup.observed : 0,
      killed: Array.isArray(result.cleanup?.killed)
        ? result.cleanup.killed.slice(0, 64).filter((value) => Number.isSafeInteger(value) && value >= 0)
        : [],
      remaining: Number.isSafeInteger(result.cleanup?.remaining) && result.cleanup.remaining >= 0
        ? result.cleanup.remaining : 0,
    },
  }
}

function reportFailure(record, failure, commands, sourceAfter, cellDisposed) {
  return {
    kind: 'isolated-cell-run',
    version: 1,
    ok: false,
    outcome: record.outcome,
    planDigest: record.digest,
    phase: record.phase,
    failure: safeCellWorkflowDiagnostic(failure),
    commands,
    source: {
      path: record.workspace.root,
      fingerprintBefore: record.sourceFingerprint,
      fingerprintAfter: sourceAfter?.fingerprint ?? null,
      unchanged: sourceAfter?.fingerprint === record.sourceFingerprint,
      effect: 'none-by-controller',
    },
    staging: record.stage === undefined ? { changed: false, retained: false } : {
      changed: true,
      retained: true,
      root: record.stage.anchor,
      path: record.stage.destination,
      fingerprint: record.stage.fingerprint,
    },
    isolation: {
      repositoryExecution: 'isolated-copy-only',
      network: 'none',
      credentials: 'none',
      output: 'bounded-and-secret-scanned',
    },
    cleanup: { cellDisposed, capacityReleased: false, requiresCellDiscard: true },
  }
}

export function createCellWorkflowSlot() {
  return { record: null, tombstones: new WeakMap() }
}

export function createNativeCellWorkflowController(options = {}) {
  const dependencies = {
    now: options.now ?? Date.now,
    randomBytes: options.randomBytes ?? randomBytes,
    inspectWorkspace: options.inspectWorkspace ?? inspectLiveAgentWorkspace,
    inspectProfileFence: options.inspectProfileFence ?? inspectProfileFence,
    getProfileDirectory: options.getProfileDirectory ?? runtimeProfileDirectory,
    isRootAgent: options.isRootAgent,
    scanTree: options.scanTree ?? scanOrdinaryTree,
    inspectCapabilities: options.inspectCapabilities ?? inspectDshCapabilities,
    doctor: options.doctor ?? doctorSource,
    preflight: options.preflight ?? inspectProfilePreflight,
    inspectAdmission: options.inspectAdmission ?? inspectIsolatedCellAdmission,
    openCell: options.openCell ?? openIsolatedCell,
    makeTemp: options.mkdtemp ?? mkdtemp,
    makeDirectory: options.mkdir ?? mkdir,
    setDirectoryMode: options.setDirectoryMode ?? setDirectoryModeByIdentity,
    getTempDirectory: options.tmpdir ?? tmpdir,
    cleanupBarrier: options.cleanupBarrier ?? (async () => {}),
    randomUUID: options.randomUUID ?? randomUUID,
    dshPath: options.dshPath,
  }
  const slot = options.slot ?? PROCESS_SLOT
  const pendingApprovals = new Map()
  const allowedApprovals = new Map()
  let disposed = false

  function assertController() {
    if (disposed) throw error('CELL_CONTROLLER_DISPOSED', 'The isolated Build controller is disposed.')
  }

  function currentFor(owner, planDigest) {
    if (owner === null || typeof owner !== 'object') {
      throw error('CELL_AGENT_REQUIRED', 'The exact live exec.agent object is required to own this workflow.')
    }
    const record = slot.record
    if (record === null) {
      if (tombstonesFor(slot, owner).has(planDigest)) return { tombstone: true }
      throw error('CELL_PLAN_UNKNOWN', 'No live isolated Build plan matches this digest.')
    }
    if (record.owner !== owner) throw error('CELL_OWNER_MISMATCH', 'The plan belongs to a different live Agent object.')
    if (record.digest !== planDigest) throw error('CELL_PLAN_DIGEST_MISMATCH', 'The plan digest is forged, stale, or not current.')
    return { record }
  }

  async function collectEvidence(record, signal) {
    const workspace = await dependencies.inspectWorkspace(record.owner, {
      signal,
      isRootAgent: dependencies.isRootAgent,
    })
    assertActive(signal, 'Isolated Build planning was cancelled after workspace authority inspection.')
    const tree = await dependencies.scanTree(workspace.root, { signal })
    assertActive(signal, 'Isolated Build planning was cancelled after source fingerprinting.')
    const doctor = await dependencies.doctor(workspace.root, { runtime: 'skip', signal })
    assertActive(signal, 'Isolated Build planning was cancelled after static Doctor.')
    const capabilities = await dependencies.inspectCapabilities(dependencies.dshPath, { signal })
    assertActive(signal, 'Isolated Build planning was cancelled after DSH lane inspection.')
    const runtime = runtimeBinding(capabilities)
    const profile = await dependencies.inspectProfileFence(dependencies.getProfileDirectory(), signal)
    assertActive(signal, 'Isolated Build planning was cancelled after real-profile identity inspection.')
    const workspaceAfter = await dependencies.inspectWorkspace(record.owner, {
      signal,
      isRootAgent: dependencies.isRootAgent,
    })
    assertActive(signal, 'Isolated Build planning was cancelled after final workspace authority inspection.')
    const treeAfter = await dependencies.scanTree(workspaceAfter.root, { signal })
    assertActive(signal, 'Isolated Build planning was cancelled after final source fingerprinting.')
    const profileAfter = await dependencies.inspectProfileFence(profile.path, signal)
    assertActive(signal, 'Isolated Build planning was cancelled after final real-profile identity inspection.')
    if (workspace.identityDigest !== workspaceAfter.identityDigest
        || tree.fingerprint !== treeAfter.fingerprint
        || doctor.fingerprint !== treeAfter.fingerprint
        || profile.identityDigest !== profileAfter.identityDigest) {
      throw error('CELL_PLAN_MUTABLE_SOURCE', 'The authoritative source changed while the plan evidence was sealed.', {
        workspaceBefore: workspace.identityDigest,
        workspaceAfter: workspaceAfter.identityDigest,
        sourceBefore: tree.fingerprint,
        sourceAfter: treeAfter.fingerprint,
        doctor: doctor.fingerprint,
      })
    }
    return { workspace: workspaceAfter, tree: treeAfter, doctor, runtime, profile: profileAfter }
  }

  async function revalidate(record, signal) {
    if (dependencies.now() > record.expiresAt) {
      throw error('CELL_PLAN_EXPIRED', 'The isolated Build plan expired; discard it before creating another plan.', {
        expiresAt: new Date(record.expiresAt).toISOString(),
      })
    }
    const evidence = await collectEvidence(record, signal)
    assertActive(signal, 'Isolated Build plan revalidation was cancelled.')
    const recomputed = digest(planPayload(record, evidence))
    if (recomputed !== record.digest) {
      throw error('CELL_PLAN_STALE', 'Workspace, source, Doctor, DSH lane, commands, or policy no longer matches the immutable plan.', {
        expected: record.digest,
        actual: recomputed,
      })
    }
    return evidence
  }

  async function plan(input, call = {}) {
    assertController()
    const normalized = validateCellPlanFields(input)
    if (slot.record !== null) throw error('CELL_WORKFLOW_CAPACITY', 'Only one process-wide isolated Build workflow may exist.', capacityDetails(slot.record))
    const lifetime = new AbortController()
    const record = {
      phase: 'planning',
      owner: call.agent,
      ownerNonce: dependencies.randomBytes(32).toString('hex'),
      outcome: normalized.outcome,
      commands: normalized.commands,
      createdAt: dependencies.now(),
      expiresAt: dependencies.now() + PLAN_TTL_MS,
      lifetime,
      cell: undefined,
      stage: undefined,
      planPromise: undefined,
      runPromise: undefined,
    }
    slot.record = record
    const signal = combineSignals(call.signal, lifetime.signal)
    const abort = () => lifetime.abort(call.signal.reason)
    call.signal?.addEventListener('abort', abort, { once: true })
    const operation = collectEvidence(record, signal)
    record.planPromise = operation
    try {
      const evidence = await operation
      assertActive(signal, 'Isolated Build planning was cancelled before the plan could be committed.')
      record.workspace = evidence.workspace
      record.sourceFingerprint = evidence.tree.fingerprint
      record.runtime = evidence.runtime
      record.profile = evidence.profile
      record.doctorDigest = reportDigest(evidence.doctor)
      record.digest = digest(planPayload(record, evidence))
      record.phase = 'planned'
      return planReport(record, evidence)
    } catch (cause) {
      if (slot.record === record) slot.record = null
      lifetime.abort(cause)
      throw cause
    } finally {
      record.planPromise = undefined
      call.signal?.removeEventListener('abort', abort)
    }
  }

  async function prepareApproval(exec) {
    assertController()
    let parsed
    try {
      parsed = parseApprovalInput(exec)
      if (parsed === null) return null
      if (typeof exec.token !== 'symbol') {
        return { kind: 'deny', reason: 'CELL_APPROVAL_GATE_UNAVAILABLE: registry-minted execution token is unavailable' }
      }
      if (exec.parent !== undefined) {
        return { kind: 'deny', reason: 'CELL_TOP_LEVEL_CALL_REQUIRED: cell-run cannot be dispatched as a nested tool call' }
      }
      const selected = currentFor(exec.agent, parsed.planDigest)
      if (selected.tombstone) return { kind: 'deny', reason: 'CELL_PLAN_DISCARDED: this plan was already discarded' }
      const record = selected.record
      if (record.phase !== 'planned' && record.phase !== 'staged' && record.phase !== 'failed') {
        return { kind: 'deny', reason: 'CELL_WORKFLOW_BUSY: workflow phase is ' + record.phase }
      }
      if (record.phase !== 'planned') {
        return { kind: 'deny', reason: 'CELL_PLAN_ALREADY_RUN: discard this workflow before planning another run' }
      }
      await revalidate(record, exec.signal)
      assertActive(exec.signal, 'Isolated Build approval preparation was cancelled.')
      pendingApprovals.set(exec.token, {
        owner: exec.agent,
        digest: record.digest,
        callId: exec.callId,
      })
      return { kind: 'ask', reason: renderApprovalReason(record) }
    } catch (cause) {
      const diagnostic = safeCellWorkflowDiagnostic(cause)
      return { kind: 'deny', reason: diagnostic.code + ': ' + diagnostic.message }
    }
  }

  function approvalGuard(exec) {
    let parsed
    try {
      parsed = parseApprovalInput(exec)
    } catch (cause) {
      const diagnostic = safeCellWorkflowDiagnostic(cause)
      return diagnostic.code + ': ' + diagnostic.message
    }
    if (parsed === null) return undefined
    const pending = pendingApprovals.get(exec.token)
    if (pending === undefined
        || pending.owner !== exec.agent
        || pending.digest !== parsed.planDigest
        || pending.callId !== exec.callId) {
      return 'CELL_APPROVAL_GATE_UNAVAILABLE: an audited allowed-once pre-execute proof did not reach the guard'
    }
    pendingApprovals.delete(exec.token)
    allowedApprovals.set(exec.token, pending)
    return undefined
  }

  function consumeApproval(call, planDigest) {
    const proof = allowedApprovals.get(call.executionToken)
    allowedApprovals.delete(call.executionToken)
    pendingApprovals.delete(call.executionToken)
    if (proof === undefined
        || proof.owner !== call.agent
        || proof.digest !== planDigest
        || proof.callId !== call.callId) {
      throw error(
        'CELL_APPROVAL_GATE_UNAVAILABLE',
        'cell-run requires an unconsumed registry-minted proof that audited tools/pre-execute returned allowed-once.',
      )
    }
  }

  function settleExecution(exec) {
    if (exec?.name !== TOOL_NAME || typeof exec.token !== 'symbol') return
    pendingApprovals.delete(exec.token)
    allowedApprovals.delete(exec.token)
  }

  async function run(input, call = {}) {
    assertController()
    const planDigest = validateDigest(input.planDigest)
    consumeApproval(call, planDigest)
    const selected = currentFor(call.agent, planDigest)
    if (selected.tombstone) throw error('CELL_PLAN_DISCARDED', 'This isolated Build plan was already discarded.')
    const record = selected.record
    if (record.phase !== 'planned') throw error('CELL_PLAN_ALREADY_RUN', 'The immutable plan can run only once.')
    record.phase = 'executing'
    const abortForCall = () => record.lifetime.abort(call.signal.reason)
    call.signal?.addEventListener('abort', abortForCall, { once: true })
    const signal = combineSignals(call.signal, record.lifetime.signal)
    const commands = []
    let cellDisposed = false
    let sourceAfter
    let failure
    let commandFailure
    const operation = (async () => {
      try {
        await revalidate(record, signal)
        assertActive(signal, 'Isolated Build was cancelled after final plan revalidation.')
        const admission = await dependencies.inspectAdmission(dependencies.dshPath, { signal })
        assertActive(signal, 'Isolated Build was cancelled after exact admission inspection.')
        if (admission?.admitted !== true) {
          throw error('CELL_NOT_ADMITTED', 'The exact isolated-cell admission report did not admit execution.', {
            disposition: admission?.disposition,
            evidenceDigest: admission?.evidenceDigest,
          })
        }
        record.admission = {
          disposition: admission.disposition,
          evidenceDigest: admission.evidenceDigest,
          runtime: admission.runtime,
        }
        record.phase = 'opening'
        record.cell = await dependencies.openCell(record.workspace.root, { admission, signal })
        assertActive(signal, 'Isolated Build was cancelled while opening its authentic cell.')
        if (record.cell.sourceFingerprint !== record.sourceFingerprint) {
          throw error('CELL_SOURCE_MISMATCH', 'The authentic cell did not open the exact planned source fingerprint.', {
            planned: record.sourceFingerprint,
            opened: record.cell.sourceFingerprint,
          })
        }
        record.phase = 'executing'
        for (const [index, item] of record.commands.entries()) {
          assertActive(signal)
          let result
          try {
            result = await record.cell.exec(item.command, { timeoutMs: item.timeoutMs, signal })
          } catch (cause) {
            if (cause?.code !== 'COMMAND_TIMEOUT' || signal?.aborted) throw cause
            commandFailure = error(
              'COMMAND_TIMEOUT',
              'An isolated command exceeded its exact stored timeout.',
              { commandIndex: index, timeoutMs: item.timeoutMs },
            )
            break
          }
          assertActive(signal, 'Isolated Build was cancelled after an isolated command.')
          const safe = safeCommandResult(index, item, result)
          commands.push(safe)
          if (safe.exitCode !== 0 || safe.output.redacted) break
        }
        record.phase = 'staging'
        let stageAuthority
        stageAuthority = createCellStageAuthorityFactory(
          () => mintStageAuthority(record, dependencies, stageAuthority, signal),
        )
        const staged = await record.cell.stageResult({ signal, authority: stageAuthority })
        assertActive(signal, 'Isolated Build was cancelled after result staging.')
        const sealedStage = await sealStageResult(record, staged, dependencies, stageAuthority, signal)
        const finalSource = sealedStage === undefined ? record.workspace.root : sealedStage.destination
        const finalDoctor = await dependencies.doctor(finalSource, { runtime: 'skip', signal })
        assertActive(signal, 'Isolated Build was cancelled after final static Doctor.')
        const preflight = finalDoctor.plugin === undefined
          ? null
          : await dependencies.preflight(finalSource, {
              dshPath: dependencies.dshPath,
              profile: PROFILE,
              signal,
            })
        assertActive(signal, 'Isolated Build was cancelled after final profile preflight.')
        sourceAfter = await dependencies.scanTree(record.workspace.root, { signal })
        assertActive(signal, 'Isolated Build was cancelled after final source fingerprinting.')
        const workspaceAfter = await dependencies.inspectWorkspace(record.owner, {
          signal,
          isRootAgent: dependencies.isRootAgent,
        })
        assertActive(signal, 'Isolated Build was cancelled after final workspace authority inspection.')
        const unchanged = sourceAfter.fingerprint === record.sourceFingerprint
          && workspaceAfter.identityDigest === record.workspace.identityDigest
        if (!unchanged) {
          throw error('CELL_SOURCE_CHANGED', 'The authoritative source or physical workspace identity changed during isolated execution.', {
            before: record.sourceFingerprint,
            after: sourceAfter.fingerprint,
          })
        }
        const commandsOk = commandFailure === undefined
          && commands.length === record.commands.length
          && commands.every((item) => item.exitCode === 0 && !item.output.redacted)
        const verificationOk = finalDoctor.ok === true && (preflight === null || preflight.ok === true)
        record.phase = 'staged'
        return {
          kind: 'isolated-cell-run',
          version: 1,
          ok: commandsOk && verificationOk,
          outcome: record.outcome,
          planDigest: record.digest,
          phase: record.phase,
          ...(commandFailure === undefined ? {} : { failure: safeCellWorkflowDiagnostic(commandFailure) }),
          commands,
          commandBinding: {
            planned: record.commands.length,
            executed: commands.length,
            exact: commands.every((item, index) => item.commandDigest === digest(record.commands[index])),
          },
          source: {
            path: record.workspace.root,
            physicalIdentity: record.workspace.identityDigest,
            fingerprintBefore: record.sourceFingerprint,
            fingerprintAfter: sourceAfter.fingerprint,
            unchanged: true,
            effect: 'none',
          },
          staging: record.stage === undefined ? {
            changed: false,
            retained: false,
            effect: 'none',
          } : {
            changed: true,
            retained: true,
            effect: 'new-controller-owned-root',
            root: record.stage.anchor,
            path: record.stage.destination,
            fingerprint: record.stage.fingerprint,
            changedPaths: record.stage.changes,
          },
          verification: {
            doctor: { ok: finalDoctor.ok, fingerprint: finalDoctor.fingerprint, digest: reportDigest(finalDoctor) },
            preflight: preflight === null ? { applicable: false } : {
              applicable: true,
              ok: preflight.ok,
              profile: preflight.profile,
              evidenceDigest: preflight.evidenceDigest,
              repositoryCodeExecuted: false,
            },
          },
          runtime: record.runtime,
          admission: record.admission,
          isolation: {
            provider: record.cell.provider,
            repositoryExecution: 'isolated-copy-only',
            network: 'none',
            credentials: 'none',
            sourceMount: 'none',
            output: 'bounded-and-secret-scanned',
          },
          cleanup: {
            cellDisposed: false,
            stageRetained: record.stage !== undefined,
            capacityReleased: false,
            requiresCellDiscard: true,
          },
        }
      } catch (cause) {
        failure = signal?.aborted
          ? error('CANCELLED', 'Isolated Build execution was cancelled.')
          : cause
        try {
          sourceAfter = await dependencies.scanTree(record.workspace?.root, {})
        } catch {
          sourceAfter = undefined
        }
        throw cause
      } finally {
        if (record.cell !== undefined) {
          try {
            await record.cell.dispose()
            cellDisposed = true
            record.cell = undefined
          } catch (cleanupCause) {
            record.phase = 'cleanup-failed'
            failure = error('CELL_CLEANUP_FAILED', 'The authentic cell could not verify disposal; workflow capacity remains poisoned.', {
              retainedRoot: record.stage?.anchor ?? null,
              cleanup: safeCellWorkflowDiagnostic(cleanupCause),
              operation: failure ? safeCellWorkflowDiagnostic(failure) : null,
            })
          }
        }
      }
    })()
    record.runPromise = operation
    try {
      const report = await operation
      report.cleanup.cellDisposed = cellDisposed
      if (failure !== undefined) throw failure
      return report
    } catch (cause) {
      record.phase = record.phase === 'cleanup-failed' ? record.phase : 'failed'
      const finalFailure = failure ?? cause
      return reportFailure(record, finalFailure, commands, sourceAfter, cellDisposed)
    } finally {
      record.runPromise = undefined
      call.signal?.removeEventListener('abort', abortForCall)
    }
  }

  async function discard(input, call = {}, internal = false) {
    const planDigest = validateDigest(input.planDigest)
    if (!internal) assertController()
    const selected = currentFor(call.agent, planDigest)
    if (selected.tombstone) {
      return {
        kind: 'isolated-cell-discard',
        version: 1,
        ok: true,
        planDigest,
        alreadyDiscarded: true,
        cleanup: { verified: true, capacityReleased: true, retainedRoot: null },
      }
    }
    const record = selected.record
    record.lifetime.abort(error('CELL_DISCARDING', 'The isolated Build workflow is being discarded.'))
    if (record.runPromise !== undefined) await record.runPromise.catch(() => {})
    if (record.cell !== undefined) {
      try {
        await record.cell.dispose()
        record.cell = undefined
      } catch (cause) {
        record.phase = 'cleanup-failed'
        throw error('CELL_CLEANUP_FAILED', 'Cell disposal could not be verified; capacity remains poisoned.', {
          retainedRoot: record.stage?.anchor ?? null,
          cleanup: safeCellWorkflowDiagnostic(cause),
        })
      }
    }
    record.phase = 'staged'
    try {
      const cleanup = await discardStage(record, dependencies, call.signal)
      tombstonesFor(slot, record.owner).add(record.digest)
      slot.record = null
      return {
        kind: 'isolated-cell-discard',
        version: 1,
        ok: true,
        planDigest,
        alreadyDiscarded: false,
        source: { path: record.workspace.root, effect: 'none', fingerprint: record.sourceFingerprint },
        cleanup: {
          verified: true,
          stageRemoved: cleanup.removed,
          stageAlreadyAbsent: cleanup.absent,
          capacityReleased: true,
          retainedRoot: null,
        },
      }
    } catch (cause) {
      record.phase = 'cleanup-failed'
      throw error('CELL_DISCARD_CLEANUP_FAILED', 'Stage cleanup is ambiguous; capacity remains poisoned and the retained root is reported.', {
        retainedRoot: record.stage?.anchor ?? null,
        cleanup: safeCellWorkflowDiagnostic(cause),
      })
    }
  }

  async function disposeOwner(owner) {
    const record = slot.record
    if (record === null || record.owner !== owner) return
    record.lifetime.abort(error('CELL_OWNER_DISPOSED', 'The owning Agent was disposed.'))
    if (record.planPromise !== undefined) await record.planPromise.catch(() => {})
    if (slot.record !== record) return
    if (record.digest === undefined) {
      slot.record = null
      return
    }
    try {
      await discard({ planDigest: record.digest }, { agent: owner }, true)
    } catch (cause) {
      const retainedRoot = record.stage?.anchor ?? null
      throw error(
        'CELL_OWNER_CLEANUP_FAILED',
        'Agent disposal could not verify isolated Build cleanup; capacity remains poisoned.',
        { retainedRoot, cleanup: safeCellWorkflowDiagnostic(cause) },
      )
    }
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    pendingApprovals.clear()
    allowedApprovals.clear()
    const record = slot.record
    if (record !== null) await disposeOwner(record.owner)
  }

  return {
    plan,
    prepareApproval,
    approvalGuard,
    settleExecution,
    run,
    discard,
    disposeOwner,
    dispose,
    status() {
      const record = slot.record
      return record === null ? { phase: 'idle' } : capacityDetails(record)
    },
  }
}

export function formatCellWorkflowReport(report) {
  if (report.kind === 'isolated-cell-plan') {
    return [
      'PLAN Isolated Build: ' + report.outcome,
      'Digest: ' + report.planDigest,
      'Source: ' + report.source.path,
      'Fingerprint: ' + report.source.fingerprint,
      'Commands: ' + report.commands.length,
      'Next: call cell-run with only this planDigest; DSH will request one-time approval.',
    ].join('\n')
  }
  if (report.kind === 'isolated-cell-discard') {
    return (report.ok ? 'PASS' : 'FAIL') + ' Isolated Build discard ' + report.planDigest
      + '\nCapacity released: ' + report.cleanup.capacityReleased
  }
  const lines = [
    (report.ok ? 'PASS' : 'FAIL') + ' Isolated Build: ' + report.outcome,
    'Plan: ' + report.planDigest,
    'Source unchanged: ' + report.source.unchanged,
    'Commands: ' + report.commands.length,
    'Stage: ' + (report.staging.changed ? report.staging.path : '(no changes)'),
    'Cell disposed: ' + report.cleanup.cellDisposed,
    'Discard required: ' + report.cleanup.requiresCellDiscard,
  ]
  const failedCommand = report.commands.find((command) => command.exitCode !== 0 || command.output.redacted)
  if (failedCommand !== undefined) {
    const renderStream = (value) => value.length <= RENDER_STREAM_CHARS
      ? value
      : value.slice(0, RENDER_STREAM_CHARS) + '\n[render truncated by dsh-developer]'
    lines.push('Command ' + failedCommand.index + ' exit: ' + failedCommand.exitCode)
    lines.push('stdout:\n' + renderStream(failedCommand.stdout || '(empty)'))
    lines.push('stderr:\n' + renderStream(failedCommand.stderr || '(empty)'))
  }
  if (report.failure) lines.push('Failure: ' + report.failure.code + ': ' + report.failure.message)
  return lines.join('\n')
}

export const CELL_WORKFLOW_POLICY = FIXED_POLICY
export const CELL_WORKFLOW_PLAN_TTL_MS = PLAN_TTL_MS
