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
import {
  claimCellTransactionAuthority,
  createCellTransactionAuthorityFactory,
} from './cell-transaction-authority.js'
import { inspectIsolatedCellAdmission } from './cell-admission.js'
import { inspectDshCapabilities } from './capabilities.js'
import { LIMITS } from './constants.js'
import { doctorSource, reportDigest } from './doctor.js'
import { DshDeveloperError } from './errors.js'
import {
  assertPortableRelativePath,
  fingerprintFileMap,
  scanOrdinaryTree,
  writeFilesExclusive,
} from './files.js'
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
const TRANSACTION_PREFIX = '.dsh-developer-cell-apply-'
const METADATA_DIRECTORIES = new Set(['.git', '.hg', '.svn'])
const DIAGNOSTIC_MESSAGE_CHARS = 800
const DIAGNOSTIC_PATH_CHARS = 2_000
const DIAGNOSTIC_DEPTH = 2
const DIAGNOSTIC_CHILDREN = 4
const RENDER_STREAM_CHARS = 2_000
const RESUMABLE_CLEANUP_DIAGNOSTICS = new Set([
  'CANCELLED',
  'EACCES',
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'EPERM',
])

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
  for (const key of ['commandIndex', 'timeoutMs', 'limit', 'retainedTransactions']) {
    if (Number.isSafeInteger(details[key]) && details[key] >= 0) output[key] = details[key]
  }
  for (const key of ['expiresAt', 'phase', 'disposition', 'evidenceDigest', 'expected', 'actual', 'recoveryState']) {
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

function statIdentity(info) {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs ?? BigInt(Math.trunc(Number(info.mtimeMs) * 1_000_000))),
    nlink: String(info.nlink),
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.nlink === right.nlink
}

function samePhysicalObjectIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
}

function sameManagedTreePhysicalIdentity(left, right) {
  const project = (identity) => ({
    rootIdentity: {
      dev: identity.rootIdentity.dev,
      ino: identity.rootIdentity.ino,
    },
    directories: identity.directories.map(({ path, dev, ino, nlink }) => ({ path, dev, ino, nlink })),
    files: identity.files.map(({ path, dev, ino, nlink }) => ({ path, dev, ino, nlink })),
  })
  return digest(project(left)) === digest(project(right))
}

async function inspectManagedTreeIdentity(root, tree, options = {}) {
  const absoluteRoot = resolve(root)
  const expected = new Map(tree.entries.map((entry) => [entry.path, entry]))
  const observedFiles = new Set()
  const directories = []
  const files = []
  const rootSnapshot = await ordinaryPathSnapshot(absoluteRoot, options.signal)
  if (resolve(await realpath(absoluteRoot)) !== absoluteRoot) {
    throw error('CELL_TREE_IDENTITY_INVALID', 'A managed tree root no longer resolves to its exact ordinary path.')
  }

  async function visit(directory, relativeDirectory = '') {
    assertActive(options.signal, 'Managed tree identity inspection was cancelled.')
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      assertActive(options.signal, 'Managed tree identity inspection was cancelled.')
      const relativePath = relativeDirectory === '' ? child.name : relativeDirectory + '/' + child.name
      assertPortableRelativePath(relativePath)
      const absolute = join(directory, child.name)
      const before = await lstat(absolute, { bigint: true })
      if (before.isSymbolicLink()) {
        throw error('CELL_TREE_LINK', 'Managed apply trees may not contain links or junctions.')
      }
      if (before.isDirectory()) {
        if (METADATA_DIRECTORIES.has(child.name)) continue
        const identity = statIdentity(before)
        directories.push({ path: relativePath, ...identity })
        await visit(absolute, relativePath)
        const after = await lstat(absolute, { bigint: true })
        if (!after.isDirectory() || !sameFileIdentity(identity, statIdentity(after))) {
          throw error('CELL_TREE_IDENTITY_CHANGED', 'A managed directory changed during physical inspection.')
        }
        continue
      }
      if (!before.isFile() || before.nlink !== 1n) {
        throw error(
          before.isFile() ? 'CELL_TREE_HARDLINK' : 'CELL_TREE_SPECIAL_FILE',
          before.isFile()
            ? 'Managed apply trees reject multiply-linked files.'
            : 'Managed apply trees accept only ordinary files and directories.',
        )
      }
      const expectedEntry = expected.get(relativePath)
      if (expectedEntry === undefined) {
        throw error('CELL_TREE_IDENTITY_MISMATCH', 'Physical managed files differ from the sealed tree snapshot.')
      }
      const handle = await open(absolute, 'r')
      let content
      let openedIdentity
      try {
        const opened = await handle.stat({ bigint: true })
        openedIdentity = statIdentity(opened)
        if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(statIdentity(before), openedIdentity)) {
          throw error('CELL_TREE_IDENTITY_CHANGED', 'A managed file changed while its physical identity was opened.')
        }
        content = await handle.readFile()
        const afterRead = await handle.stat({ bigint: true })
        if (!sameFileIdentity(openedIdentity, statIdentity(afterRead))) {
          throw error('CELL_TREE_IDENTITY_CHANGED', 'A managed file changed while its bytes were verified.')
        }
      } finally {
        await handle.close()
      }
      const after = await lstat(absolute, { bigint: true })
      const contentDigest = createHash('sha256').update(content).digest('hex')
      if (!sameFileIdentity(openedIdentity, statIdentity(after))
          || content.byteLength !== expectedEntry.bytes
          || contentDigest !== expectedEntry.digest) {
        throw error('CELL_TREE_IDENTITY_MISMATCH', 'Physical managed file identity or bytes differ from the sealed tree snapshot.')
      }
      observedFiles.add(relativePath)
      files.push({ path: relativePath, ...openedIdentity })
    }
  }

  await visit(absoluteRoot)
  if (observedFiles.size !== expected.size) {
    throw error('CELL_TREE_IDENTITY_MISMATCH', 'The sealed tree snapshot has no exact physical file set.')
  }
  directories.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  const value = {
    root: absoluteRoot,
    rootIdentity: rootSnapshot.at(-1),
    directories,
    files,
  }
  return deepFreeze({ ...value, digest: digest(value) })
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
    sourcePhysicalTreeDigest: evidence.treeIdentity.digest,
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
      physicalTreeIdentity: evidence.treeIdentity.digest,
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

function applyEvidenceDigest(record, evidence) {
  return digest({
    planDigest: record.digest,
    ownerNonce: record.ownerNonce,
    source: {
      rootIdentity: evidence.source.workspace.identityDigest,
      treeIdentity: evidence.source.treeIdentity.digest,
      fingerprint: evidence.source.tree.fingerprint,
    },
    stage: {
      authority: record.stage.authorityDigest,
      treeIdentity: evidence.stageIdentity.digest,
      fingerprint: evidence.stage.fingerprint,
      changes: record.stage.changes,
    },
    doctor: evidence.doctor,
    preflight: evidence.preflight,
  })
}

function renderApplyApprovalReason(record, evidenceDigest) {
  const lines = [
    'Approve this exact staged tree application once.',
    'Plan: ' + record.digest,
    'Apply evidence: ' + evidenceDigest,
    'Source: ' + record.workspace.root,
    'Source fingerprint: ' + record.sourceFingerprint,
    'Staged fingerprint: ' + record.stage.fingerprint,
    'Changed paths:',
  ]
  for (const key of ['created', 'modified', 'deleted']) {
    lines.push(key + ': ' + (record.stage.changes[key].length === 0
      ? '(none)'
      : record.stage.changes[key].join(', ')))
  }
  lines.push(
    'Effects: replace only the approved source managed tree with the exact staged tree; create one controller-owned backup/transaction outside source, stage, and the real profile; execute no staged or source code.',
    'Failure effect: restore and verify the original source fingerprint before returning; retain poisoned recovery state if rollback cannot be proved.',
    'Success effect: final static Doctor and exact preflight on unchanged applied bytes, then verified backup and stage cleanup; release workflow capacity only after both cleanups.',
    'Real profile effect: none.',
  )
  const reason = lines.join('\n')
  const reasonWithoutAuthorityPath = reason.replace(
    'Source: ' + record.workspace.root,
    'Source: <controller-verified-workspace>',
  )
  const workspaceFindings = findSecrets(record.workspace.root)
    .filter((kind) => kind !== 'high-entropy-token')
  if (findSecrets(reasonWithoutAuthorityPath).length > 0 || workspaceFindings.length > 0) {
    throw error('CELL_APPLY_APPROVAL_SECRET', 'Apply evidence contains potential credentials and cannot enter an approval record.')
  }
  return reason
}

function parseApprovalInput(exec) {
  if (exec?.name !== TOOL_NAME) return null
  const input = exec.arguments
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || !['cell-run', 'cell-apply'].includes(input.operation)) return null
  assertExactObject(input, new Set(['operation', 'planDigest']), input.operation)
  return { operation: input.operation, planDigest: validateDigest(input.planDigest) }
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
    values = new Map()
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
  if (Object.keys(changes).sort().join(',') !== 'created,deleted,modified') return false
  return ['created', 'modified', 'deleted'].every((key) => {
    if (!Array.isArray(changes[key]) || changes[key].length > LIMITS.fileCount) return false
    let previous
    for (const value of changes[key]) {
      if (typeof value !== 'string' || value.length > LIMITS.longTextChars || findSecrets(value).length > 0) return false
      try {
        assertPortableRelativePath(value)
      } catch {
        return false
      }
      if (previous !== undefined && previous.localeCompare(value, 'en') >= 0) return false
      previous = value
    }
    return true
  })
}

function changedPathsBetween(sourceTree, resultTree) {
  const source = new Map(sourceTree.entries.map((entry) => [entry.path, entry.digest]))
  const result = new Map(resultTree.entries.map((entry) => [entry.path, entry.digest]))
  return deepFreeze({
    created: [...result.keys()].filter((path) => !source.has(path)).sort((left, right) => left.localeCompare(right, 'en')),
    modified: [...result.keys()].filter((path) => source.has(path) && source.get(path) !== result.get(path))
      .sort((left, right) => left.localeCompare(right, 'en')),
    deleted: [...source.keys()].filter((path) => !result.has(path)).sort((left, right) => left.localeCompare(right, 'en')),
  })
}

function sameChangedPaths(left, right) {
  return ['created', 'modified', 'deleted'].every((key) => left[key].length === right[key].length
    && left[key].every((path, index) => path === right[key][index]))
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
  const exactChanges = changedPathsBetween(record.sourceTree, verified)
  if (!sameChangedPaths(staged.changes, exactChanges)) {
    throw error('CELL_STAGE_CHANGESET_MISMATCH', 'The cell-reported changed paths do not exactly match the sealed trees.', {
      retainedRoot: stage.anchor,
    })
  }
  const physicalIdentity = await dependencies.inspectTreeIdentity(stage.destination, verified, { signal })
  assertActive(signal, 'Result-stage sealing was cancelled after physical identity verification.')
  stage.state = 'sealed'
  stage.fingerprint = staged.resultFingerprint
  stage.tree = deepFreeze(structuredClone(verified))
  stage.physicalIdentity = physicalIdentity
  stage.changes = exactChanges
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

async function verifyTransactionCapability(record, transaction, dependencies, options = {}) {
  const ancestry = await ordinaryPathSnapshot(transaction.root, options.signal)
  if (!prefixSnapshotMatches(transaction.baseSnapshot, ancestry)
      || !sameIdentity(ancestry.at(-1), transaction.rootIdentity)
      || resolve(await realpath(transaction.root)) !== resolve(transaction.root)) {
    throw error('CELL_TRANSACTION_ANCESTRY_MISMATCH', 'The controller-owned apply transaction ancestry changed.', {
      retainedRoot: transaction.root,
    })
  }
  const profile = await assertProfileFence(record, options.signal)
  const separated = [record.workspace.root, profile.physicalRoot, record.stage?.anchor]
    .filter(Boolean)
    .every((boundary) => !pathInside(boundary, transaction.root) && !pathInside(transaction.root, boundary))
  if (!separated) {
    throw error('CELL_TRANSACTION_SEPARATION_LOST', 'The apply transaction is no longer outside source, stage, and real profile.', {
      retainedRoot: transaction.root,
    })
  }
  if (options.requireChildren === false) return
  for (const key of ['backup', 'candidate', 'held', 'failed']) {
    const expected = join(transaction.root, key)
    if (transaction[key] !== expected) {
      throw error('CELL_TRANSACTION_AUTHORITY_INVALID', 'A private transaction child no longer has its controller-minted path.', {
        retainedRoot: transaction.root,
      })
    }
    const current = await stageIdentity(expected)
    if (!sameIdentity(current, transaction.identities[key])
        || resolve(await realpath(expected)) !== resolve(expected)) {
      throw error('CELL_TRANSACTION_IDENTITY_MISMATCH', 'A private transaction child identity changed.', {
        retainedRoot: transaction.root,
      })
    }
  }
}

async function assertNoOrphanTransactions(workspaceRoot, activeTransactionRoot, signal) {
  assertActive(signal, 'Apply recovery inspection was cancelled.')
  const parent = dirname(workspaceRoot)
  const active = activeTransactionRoot === undefined ? undefined : resolve(activeTransactionRoot)
  const candidates = (await readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.name.startsWith(TRANSACTION_PREFIX))
    .map((entry) => join(parent, entry.name))
    .filter((path) => active === undefined || resolve(path) !== active)
    .sort((left, right) => left.localeCompare(right, 'en'))
  const matching = []
  for (const candidate of candidates) {
    let recovery
    for (const state of ['committed', 'committing', 'prepared', 'minted']) {
      try {
        const marker = JSON.parse(await readFile(join(candidate, 'state-' + state + '.json'), 'utf8'))
        if (marker?.kind === 'dsh-developer-cell-apply-recovery'
            && marker.version === 1 && typeof marker.source === 'string') {
          recovery = { source: marker.source, state }
          break
        }
      } catch (cause) {
        if (cause?.code !== 'ENOENT' && !(cause instanceof SyntaxError)) throw cause
      }
    }
    if (recovery !== undefined && resolve(recovery.source) === resolve(workspaceRoot)) {
      matching.push({ root: candidate, state: recovery.state })
    }
  }
  if (matching.length > 0) {
    throw error(
      'CELL_APPLY_RECOVERY_PENDING',
      'A prior Apply transaction remains beside source; inspect its recovery markers before planning another Build.',
      {
        retainedRoot: matching[0].root,
        retainedTransactions: matching.length,
        recoveryState: matching[0].state,
      },
    )
  }
}

async function writeTransactionMarker(record, transaction, state) {
  const marker = join(transaction.root, 'state-' + state + '.json')
  const payload = JSON.stringify({
    kind: 'dsh-developer-cell-apply-recovery',
    version: 1,
    state,
    source: record.workspace.root,
    sourceIdentity: record.workspace.identityDigest,
    sourceFingerprint: record.sourceFingerprint,
    stageFingerprint: record.stage.fingerprint,
    changedPaths: record.stage.changes,
  }) + '\n'
  const handle = await open(marker, 'wx', 0o600)
  try {
    await handle.writeFile(payload, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  transaction.markers.push(marker)
  return marker
}

async function mintTransactionAuthority(record, dependencies, capability, signal) {
  assertActive(signal, 'Apply transaction minting was cancelled.')
  if (record.transaction !== undefined) {
    throw error('CELL_TRANSACTION_AUTHORITY_REUSED', 'Only one controller-owned apply transaction may exist at a time.')
  }
  const profile = await assertProfileFence(record, signal)
  if (pathInside(profile.physicalRoot, record.workspace.root)
      || pathInside(record.workspace.root, profile.physicalRoot)) {
    throw error('CELL_APPLY_PROFILE_OVERLAP', 'The approved source overlaps the real DSH profile and cannot be applied.')
  }
  const base = dirname(record.workspace.root)
  const baseSnapshot = await ordinaryPathSnapshot(base, signal)
  if (resolve(await realpath(base)) !== resolve(base)) {
    throw error('CELL_TRANSACTION_BASE_INVALID', 'The source parent is not one exact ordinary physical directory.')
  }
  const root = await dependencies.makeTemp(join(base, TRANSACTION_PREFIX))
  const transaction = {
    state: 'minting',
    capability,
    base,
    baseSnapshot,
    root,
    backup: join(root, 'backup'),
    candidate: join(root, 'candidate'),
    held: join(root, 'held'),
    failed: join(root, 'failed'),
    rootIdentity: await stageIdentity(root),
    identities: {},
    sourceFingerprint: record.sourceFingerprint,
    stageFingerprint: record.stage.fingerprint,
    mutationStarted: false,
    rollbackVerified: false,
    cleanup: undefined,
    markers: [],
  }
  record.transaction = transaction
  for (const key of ['backup', 'candidate', 'held', 'failed']) {
    await dependencies.makeDirectory(transaction[key], { mode: 0o700 })
    transaction.identities[key] = await stageIdentity(transaction[key])
  }
  await verifyTransactionCapability(record, transaction, dependencies, { signal })
  await writeTransactionMarker(record, transaction, 'minted')
  transaction.state = 'minted'
  transaction.authorityDigest = digest({
    root,
    rootIdentity: transaction.rootIdentity,
    identities: transaction.identities,
    sourceIdentity: record.workspace.identityDigest,
    stageAuthority: record.stage.authorityDigest,
    ownerNonce: record.ownerNonce,
  })
  return {
    root: transaction.root,
    backup: transaction.backup,
    candidate: transaction.candidate,
    held: transaction.held,
  }
}

function entryMap(tree) {
  return new Map(tree.entries.map((entry) => [entry.path, entry.content]))
}

async function prepareApplyTransaction(record, dependencies, signal) {
  let capability
  capability = createCellTransactionAuthorityFactory(
    () => mintTransactionAuthority(record, dependencies, capability, signal),
  )
  const authority = await claimCellTransactionAuthority(capability)
  if (authority.capability !== capability || record.transaction?.capability !== capability) {
    throw error('CELL_TRANSACTION_AUTHORITY_INVALID', 'The apply transaction did not retain its exact controller capability.')
  }
  const transaction = record.transaction
  await dependencies.writeFiles(transaction.backup, entryMap(record.sourceTree), { signal })
  const backup = await dependencies.scanTree(transaction.backup, { signal })
  const backupIdentity = await dependencies.inspectTreeIdentity(transaction.backup, backup, { signal })
  if (backup.fingerprint !== record.sourceFingerprint) {
    throw error('CELL_TRANSACTION_BACKUP_MISMATCH', 'The controller backup is not byte-identical to the approved source.', {
      retainedRoot: transaction.root,
    })
  }
  transaction.backupTree = deepFreeze(structuredClone(backup))
  transaction.backupIdentity = backupIdentity
  await dependencies.applyBarrier('after-backup-copy', { record, transaction })
  assertActive(signal, 'Apply transaction preparation was cancelled after backup verification.')

  await dependencies.writeFiles(transaction.candidate, entryMap(record.stage.tree), { signal })
  const candidate = await dependencies.scanTree(transaction.candidate, { signal })
  const candidateIdentity = await dependencies.inspectTreeIdentity(transaction.candidate, candidate, { signal })
  if (candidate.fingerprint !== record.stage.fingerprint) {
    throw error('CELL_TRANSACTION_CANDIDATE_MISMATCH', 'The controller candidate is not byte-identical to the sealed stage.', {
      retainedRoot: transaction.root,
    })
  }
  transaction.candidateTree = deepFreeze(structuredClone(candidate))
  transaction.candidateIdentity = candidateIdentity
  await writeTransactionMarker(record, transaction, 'prepared')
  transaction.state = 'prepared'
  await dependencies.applyBarrier('after-candidate-copy', { record, transaction })
  assertActive(signal, 'Apply transaction preparation was cancelled after candidate verification.')
  return transaction
}

function identityByPath(identity) {
  return new Map(identity.files.map((entry) => [entry.path, entry]))
}

async function assertFileIdentity(path, expected, code) {
  const before = await lstat(path, { bigint: true })
  const actual = statIdentity(before)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || expected === undefined || !sameFileIdentity(actual, expected)) {
    throw error(code, 'A transaction file changed physical identity before its exact rename.')
  }
  return actual
}

async function restoreFileContentInPlace(path, content, expected, observed) {
  if (!samePhysicalObjectIdentity(observed, expected)) {
    throw error('CELL_APPLY_ROLLBACK_IDENTITY_CHANGED', 'Rollback refused a different source file identity.')
  }
  await assertFileIdentity(path, observed, 'CELL_APPLY_ROLLBACK_IDENTITY_CHANGED')
  if (resolve(await realpath(path)) !== resolve(path)) {
    throw error('CELL_APPLY_ROLLBACK_IDENTITY_CHANGED', 'Rollback refused a linked source path.')
  }
  const handle = await open(path, 'r+')
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(statIdentity(opened), observed)) {
      throw error('CELL_APPLY_ROLLBACK_IDENTITY_CHANGED', 'Rollback opened a different source file identity.')
    }
    const current = await lstat(path, { bigint: true })
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n
        || !sameFileIdentity(statIdentity(current), observed)
        || resolve(await realpath(path)) !== resolve(path)) {
      throw error('CELL_APPLY_ROLLBACK_IDENTITY_CHANGED', 'The source file changed while rollback acquired it.')
    }
    await handle.truncate(0)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  const restored = await lstat(path, { bigint: true })
  if (!restored.isFile() || restored.isSymbolicLink() || restored.nlink !== 1n
      || !samePhysicalObjectIdentity(statIdentity(restored), expected)
      || resolve(await realpath(path)) !== resolve(path)) {
    throw error('CELL_APPLY_ROLLBACK_IDENTITY_CHANGED', 'Rollback restored bytes into a different source file identity.')
  }
}

async function ensureOrdinaryParents(root, relativeFile, created = undefined) {
  const segments = relativeFile.split('/').slice(0, -1)
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    try {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(current)) !== resolve(current)) {
        throw error('CELL_APPLY_PARENT_INVALID', 'An apply destination parent is not one exact ordinary directory.')
      }
    } catch (cause) {
      if (cause?.code !== 'ENOENT') throw cause
      await mkdir(current, { mode: 0o700 })
      created?.push(current)
    }
  }
}

function absentDirectoryRoots(sourceIdentity, stageIdentity) {
  const staged = new Set(stageIdentity.directories.map((entry) => entry.path))
  const candidates = sourceIdentity.directories.map((entry) => entry.path)
    .filter((path) => !staged.has(path))
    .sort((left, right) => left.split('/').length - right.split('/').length
      || left.localeCompare(right, 'en'))
  const roots = []
  for (const path of candidates) {
    if (!roots.some((root) => path === root || path.startsWith(root + '/'))) roots.push(path)
  }
  return roots
}

async function commitCandidate(record, transaction, dependencies, signal) {
  const source = record.workspace.root
  const sourceFiles = identityByPath(record.sourceTreeIdentity)
  const candidateFiles = identityByPath(transaction.candidateIdentity)
  const oldPaths = [...record.stage.changes.deleted, ...record.stage.changes.modified]
    .sort((left, right) => right.split('/').length - left.split('/').length
      || left.localeCompare(right, 'en'))
  const newPaths = [...record.stage.changes.created, ...record.stage.changes.modified]
    .sort((left, right) => left.split('/').length - right.split('/').length
      || left.localeCompare(right, 'en'))
  await writeTransactionMarker(record, transaction, 'committing')
  transaction.heldFiles = []
  transaction.heldDirectories = []
  transaction.installedFiles = []
  transaction.createdDirectories = []
  transaction.mutationStarted = true
  transaction.state = 'committing'
  await mkdir(join(transaction.held, 'files'), { mode: 0o700 })
  await mkdir(join(transaction.held, 'directories'), { mode: 0o700 })

  for (const path of oldPaths) {
    await dependencies.applyBarrier('before-move-original', { record, transaction, path })
    assertActive(signal, 'Source application was cancelled before moving an original file.')
    await verifyTransactionCapability(record, transaction, dependencies, { signal })
    const sourcePath = join(source, ...path.split('/'))
    await assertFileIdentity(sourcePath, sourceFiles.get(path), 'CELL_APPLY_SOURCE_IDENTITY_CHANGED')
    const heldPath = join(transaction.held, 'files', ...path.split('/'))
    await ensureOrdinaryParents(join(transaction.held, 'files'), path)
    await rename(sourcePath, heldPath)
    transaction.heldFiles.push({ path, heldPath, identity: sourceFiles.get(path) })
    await dependencies.applyBarrier('after-move-original', { record, transaction, path })
    assertActive(signal, 'Source application was cancelled after moving an original file.')
  }

  let heldDirectoryIndex = 0
  for (const path of absentDirectoryRoots(record.sourceTreeIdentity, record.stage.physicalIdentity)) {
    const sourcePath = join(source, ...path.split('/'))
    const children = await readdir(sourcePath).catch((cause) => cause?.code === 'ENOENT' ? null : Promise.reject(cause))
    if (children === null || children.length !== 0) continue
    const heldPath = join(transaction.held, 'directories', String(++heldDirectoryIndex))
    const before = await stageIdentity(sourcePath)
    await rename(sourcePath, heldPath)
    transaction.heldDirectories.push({ path, heldPath, identity: before })
  }

  for (const path of newPaths) {
    await dependencies.applyBarrier('before-install-candidate', { record, transaction, path })
    assertActive(signal, 'Source application was cancelled before installing a candidate file.')
    await verifyTransactionCapability(record, transaction, dependencies, { signal })
    const candidatePath = join(transaction.candidate, ...path.split('/'))
    await assertFileIdentity(candidatePath, candidateFiles.get(path), 'CELL_APPLY_CANDIDATE_IDENTITY_CHANGED')
    await ensureOrdinaryParents(source, path, transaction.createdDirectories)
    const destination = join(source, ...path.split('/'))
    await rename(candidatePath, destination)
    transaction.installedFiles.push({ path, destination, identity: candidateFiles.get(path) })
    await dependencies.applyBarrier('after-install-candidate', { record, transaction, path })
    assertActive(signal, 'Source application was cancelled after installing a candidate file.')
  }
  transaction.state = 'validating'
}

async function moveCurrentFileToFailed(record, transaction, dependencies, path, identity, label) {
  await verifyTransactionCapability(record, transaction, dependencies)
  const sourcePath = join(record.workspace.root, ...path.split('/'))
  await assertFileIdentity(sourcePath, identity, 'CELL_APPLY_ROLLBACK_IDENTITY_CHANGED')
  const failedRoot = join(transaction.failed, label)
  await mkdir(failedRoot, { recursive: true, mode: 0o700 })
  const failedPath = join(failedRoot, ...path.split('/'))
  await ensureOrdinaryParents(failedRoot, path)
  await rename(sourcePath, failedPath)
}

async function rollbackSource(record, transaction, dependencies, failure) {
  transaction.state = 'rolling-back'
  await dependencies.applyBarrier('before-rollback', { record, transaction, failure })
  for (const installed of [...transaction.installedFiles].reverse()) {
    const present = await lstat(installed.destination).then(() => true, (cause) => cause?.code === 'ENOENT' ? false : Promise.reject(cause))
    if (!present) continue
    await moveCurrentFileToFailed(
      record,
      transaction,
      dependencies,
      installed.path,
      installed.identity,
      'installed',
    )
  }
  for (const path of [...transaction.createdDirectories].sort((left, right) => right.length - left.length)) {
    await rmdir(path).catch((cause) => { if (!['ENOENT', 'ENOTEMPTY'].includes(cause?.code)) throw cause })
  }
  for (const held of [...transaction.heldDirectories].reverse()) {
    await ensureOrdinaryParents(record.workspace.root, held.path)
    await rename(held.heldPath, join(record.workspace.root, ...held.path.split('/')))
  }
  for (const held of [...transaction.heldFiles].reverse()) {
    await ensureOrdinaryParents(record.workspace.root, held.path)
    await rename(held.heldPath, join(record.workspace.root, ...held.path.split('/')))
  }

  let current = await dependencies.scanTree(record.workspace.root, {})
  if (current.fingerprint !== record.sourceFingerprint) {
    const original = new Map(record.sourceTree.entries.map((entry) => [entry.path, entry]))
    const originalIdentities = identityByPath(record.sourceTreeIdentity)
    const currentMap = new Map(current.entries.map((entry) => [entry.path, entry]))
    const currentIdentity = await dependencies.inspectTreeIdentity(record.workspace.root, current, {})
    const identities = identityByPath(currentIdentity)
    for (const [path, entry] of currentMap) {
      const expected = original.get(path)
      if (expected !== undefined && expected.digest === entry.digest) continue
      const expectedIdentity = originalIdentities.get(path)
      const actualIdentity = identities.get(path)
      if (expected !== undefined && expectedIdentity !== undefined && actualIdentity !== undefined
          && samePhysicalObjectIdentity(actualIdentity, expectedIdentity)) {
        await restoreFileContentInPlace(
          join(record.workspace.root, ...path.split('/')),
          expected.content,
          expectedIdentity,
          actualIdentity,
        )
        continue
      }
      await moveCurrentFileToFailed(record, transaction, dependencies, path, identities.get(path), 'drift')
    }
    const remaining = await dependencies.scanTree(record.workspace.root, {})
    const remainingMap = new Map(remaining.entries.map((entry) => [entry.path, entry]))
    const restore = new Map()
    for (const entry of record.sourceTree.entries) {
      if (remainingMap.get(entry.path)?.digest !== entry.digest) restore.set(entry.path, entry.content)
    }
    for (const path of restore.keys()) await ensureOrdinaryParents(record.workspace.root, path)
    await dependencies.writeFiles(record.workspace.root, restore, {})
    current = await dependencies.scanTree(record.workspace.root, {})
  }
  const workspace = await dependencies.inspectWorkspace(record.owner, {
    isRootAgent: dependencies.isRootAgent,
  })
  const currentIdentity = await dependencies.inspectTreeIdentity(record.workspace.root, current, {})
  if (current.fingerprint !== record.sourceFingerprint
      || workspace.identityDigest !== record.workspace.identityDigest
      || !sameManagedTreePhysicalIdentity(currentIdentity, record.sourceTreeIdentity)) {
    throw error('CELL_APPLY_ROLLBACK_MISMATCH', 'Rollback could not prove the original source bytes and physical identity.', {
      expected: record.sourceFingerprint,
      actual: current.fingerprint,
      retainedRoot: transaction.root,
    })
  }
  transaction.rollbackVerified = true
  transaction.state = 'rolled-back'
  await dependencies.applyBarrier('after-rollback', { record, transaction })
  return current
}

function expectedTransactionFingerprint(cleanup) {
  return fingerprintFileMap(new Map(cleanup.tree.entries
    .filter((entry) => !cleanup.removedFiles.has(entry.path))
    .map((entry) => [entry.path, entry.content])))
}

async function verifyTransactionCleanupState(record, transaction, dependencies) {
  await verifyTransactionCapability(record, transaction, dependencies, { requireChildren: false })
  const current = await dependencies.scanTree(transaction.root, {})
  if (current.fingerprint !== expectedTransactionFingerprint(transaction.cleanup)) {
    throw error('CELL_TRANSACTION_CLEANUP_AMBIGUOUS', 'The retained apply transaction changed during verified cleanup.', {
      retainedRoot: transaction.root,
    })
  }
}

async function drainTransaction(record, transaction, dependencies) {
  const cleanup = transaction.cleanup
  const files = identityByPath(cleanup.identity)
  await verifyTransactionCleanupState(record, transaction, dependencies)
  const markerRank = (path) => {
    const match = /^state-(minted|prepared|committing|committed)\.json$/u.exec(path)
    return match === null ? 0 : 1 + ['minted', 'prepared', 'committing', 'committed'].indexOf(match[1])
  }
  for (const entry of [...cleanup.tree.entries]
    .sort((left, right) => markerRank(left.path) - markerRank(right.path)
      || left.path.localeCompare(right.path, 'en'))) {
    if (cleanup.removedFiles.has(entry.path)) continue
    await dependencies.applyBarrier('before-delete-transaction-entry', { record, transaction, path: entry.path })
    await verifyTransactionCleanupState(record, transaction, dependencies)
    const absolute = join(transaction.root, ...entry.path.split('/'))
    await assertFileIdentity(absolute, files.get(entry.path), 'CELL_TRANSACTION_CLEANUP_AMBIGUOUS')
    if (await readFile(absolute, 'utf8') !== entry.content) {
      throw error('CELL_TRANSACTION_CLEANUP_AMBIGUOUS', 'A transaction file changed before verified deletion.', {
        retainedRoot: transaction.root,
      })
    }
    await unlink(absolute)
    cleanup.removedFiles.add(entry.path)
  }
  for (const directory of [...cleanup.identity.directories]
    .sort((left, right) => right.path.split('/').length - left.path.split('/').length
      || right.path.localeCompare(left.path, 'en'))) {
    if (cleanup.removedDirectories.has(directory.path)) continue
    await dependencies.applyBarrier('before-delete-transaction-directory', {
      record,
      transaction,
      path: directory.path,
    })
    await verifyTransactionCapability(record, transaction, dependencies, { requireChildren: false })
    const absolute = join(transaction.root, ...directory.path.split('/'))
    const current = await stageIdentity(absolute)
    if (!sameIdentity(current, directory) || (await readdir(absolute)).length !== 0) {
      throw error('CELL_TRANSACTION_CLEANUP_AMBIGUOUS', 'A transaction directory changed before verified deletion.', {
        retainedRoot: transaction.root,
      })
    }
    await rmdir(absolute)
    cleanup.removedDirectories.add(directory.path)
  }
  await verifyTransactionCapability(record, transaction, dependencies, { requireChildren: false })
  if ((await readdir(transaction.root)).length !== 0) {
    throw error('CELL_TRANSACTION_CLEANUP_AMBIGUOUS', 'Unexpected entries remain in the apply transaction root.', {
      retainedRoot: transaction.root,
    })
  }
  await rmdir(transaction.root)
  cleanup.rootRemoved = true
  transaction.state = 'cleaned'
  return { removed: true, root: transaction.root }
}

function startTransactionDrain(record, transaction, dependencies) {
  if (transaction.cleanup.promise !== undefined) return transaction.cleanup.promise
  const operation = drainTransaction(record, transaction, dependencies)
  transaction.cleanup.promise = operation
  operation.then(
    () => {},
    () => { if (transaction.cleanup.promise === operation) transaction.cleanup.promise = undefined },
  )
  return operation
}

async function cleanupTransaction(record, dependencies, signal) {
  const transaction = record.transaction
  if (transaction === undefined || transaction.state === 'cleaned') {
    return { removed: false, absent: true, root: null }
  }
  if (transaction.cleanup?.promise !== undefined) return transaction.cleanup.promise
  if (transaction.state === 'deleting') return startTransactionDrain(record, transaction, dependencies)
  assertActive(signal, 'Apply transaction cleanup was cancelled before verified deletion began.')
  await verifyTransactionCapability(record, transaction, dependencies, { signal })
  const tree = await dependencies.scanTree(transaction.root, { signal })
  const identity = await dependencies.inspectTreeIdentity(transaction.root, tree, { signal })
  await dependencies.applyBarrier('before-transaction-cleanup-commit', { record, transaction })
  assertActive(signal, 'Apply transaction cleanup was cancelled before verified deletion began.')
  transaction.cleanup = {
    tree: deepFreeze(structuredClone(tree)),
    identity,
    removedFiles: new Set(),
    removedDirectories: new Set(),
    rootRemoved: false,
    promise: undefined,
  }
  transaction.state = 'deleting'
  return startTransactionDrain(record, transaction, dependencies)
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
    inspectTreeIdentity: options.inspectTreeIdentity ?? inspectManagedTreeIdentity,
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
    applyBarrier: options.applyBarrier ?? (async () => {}),
    writeFiles: options.writeFiles ?? writeFilesExclusive,
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
      const tombstone = tombstonesFor(slot, owner).get(planDigest)
      if (tombstone !== undefined) return { tombstone }
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
    await assertNoOrphanTransactions(workspace.root, record.transaction?.root, signal)
    const tree = await dependencies.scanTree(workspace.root, { signal })
    assertActive(signal, 'Isolated Build planning was cancelled after source fingerprinting.')
    const treeIdentity = await dependencies.inspectTreeIdentity(workspace.root, tree, { signal })
    assertActive(signal, 'Isolated Build planning was cancelled after source physical identity inspection.')
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
    await assertNoOrphanTransactions(workspaceAfter.root, record.transaction?.root, signal)
    const treeAfter = await dependencies.scanTree(workspaceAfter.root, { signal })
    assertActive(signal, 'Isolated Build planning was cancelled after final source fingerprinting.')
    const treeIdentityAfter = await dependencies.inspectTreeIdentity(workspaceAfter.root, treeAfter, { signal })
    assertActive(signal, 'Isolated Build planning was cancelled after final source physical identity inspection.')
    const profileAfter = await dependencies.inspectProfileFence(profile.path, signal)
    assertActive(signal, 'Isolated Build planning was cancelled after final real-profile identity inspection.')
    if (workspace.identityDigest !== workspaceAfter.identityDigest
        || tree.fingerprint !== treeAfter.fingerprint
        || treeIdentity.digest !== treeIdentityAfter.digest
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
    return {
      workspace: workspaceAfter,
      tree: treeAfter,
      treeIdentity: treeIdentityAfter,
      doctor,
      runtime,
      profile: profileAfter,
    }
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

  async function collectApplyEvidence(record, signal) {
    if (!['staged', 'applying'].includes(record.phase) || record.runSucceeded !== true
        || record.stage === undefined || record.stage.state !== 'sealed') {
      throw error('CELL_APPLY_NOT_READY', 'cell-apply requires one successful changed cell-run with a sealed controller stage.')
    }
    if (record.stage.changes.created.length
        + record.stage.changes.modified.length
        + record.stage.changes.deleted.length === 0) {
      throw error('CELL_APPLY_NO_CHANGES', 'The successful cell-run produced no changed stage; discard the workflow.')
    }
    const source = await revalidate(record, signal)
    await verifyStageCapability(record, record.stage, { signal })
    const stage = await dependencies.scanTree(record.stage.destination, { signal })
    assertActive(signal, 'Staged apply evidence was cancelled after fingerprint verification.')
    if (stage.fingerprint !== record.stage.fingerprint) {
      throw error('CELL_STAGE_MUTATED', 'The sealed stage changed before apply approval.', {
        expected: record.stage.fingerprint,
        actual: stage.fingerprint,
        retainedRoot: record.stage.anchor,
      })
    }
    const stageIdentity = await dependencies.inspectTreeIdentity(record.stage.destination, stage, { signal })
    if (stageIdentity.digest !== record.stage.physicalIdentity.digest) {
      throw error('CELL_STAGE_IDENTITY_MISMATCH', 'The sealed stage physical identity changed before apply approval.', {
        retainedRoot: record.stage.anchor,
      })
    }
    const doctorReport = await dependencies.doctor(record.stage.destination, { runtime: 'skip', signal })
    assertActive(signal, 'Staged apply evidence was cancelled after exact static Doctor.')
    const doctor = {
      ok: doctorReport.ok === true,
      fingerprint: doctorReport.fingerprint,
      digest: reportDigest(doctorReport),
    }
    let preflight = { applicable: false }
    if (doctorReport.plugin !== undefined) {
      const value = await dependencies.preflight(record.stage.destination, {
        dshPath: dependencies.dshPath,
        profile: PROFILE,
        signal,
      })
      assertActive(signal, 'Staged apply evidence was cancelled after exact profile preflight.')
      preflight = {
        applicable: true,
        ok: value.ok === true,
        profile: value.profile,
        sourceFingerprint: value.sourceFingerprint ?? stage.fingerprint,
        evidenceDigest: value.evidenceDigest,
      }
    }
    if (doctor.ok !== true
        || doctor.fingerprint !== record.stage.fingerprint
        || doctor.digest !== record.stagedEvidence?.doctor.digest
        || JSON.stringify(preflight) !== JSON.stringify(record.stagedEvidence?.preflight)) {
      throw error('CELL_STAGE_VERIFICATION_DRIFT', 'Exact staged Doctor or preflight evidence no longer matches the successful cell-run.', {
        retainedRoot: record.stage.anchor,
      })
    }
    const evidence = { source, stage, stageIdentity, doctor, preflight }
    return { ...evidence, evidenceDigest: applyEvidenceDigest(record, evidence) }
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
      applyPromise: undefined,
      transaction: undefined,
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
      record.sourceTree = deepFreeze(structuredClone(evidence.tree))
      record.sourceTreeIdentity = evidence.treeIdentity
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
        return { kind: 'deny', reason: 'CELL_TOP_LEVEL_CALL_REQUIRED: ' + parsed.operation + ' cannot be dispatched as a nested tool call' }
      }
      const selected = currentFor(exec.agent, parsed.planDigest)
      if (selected.tombstone) {
        return {
          kind: 'deny',
          reason: selected.tombstone.disposition === 'applied'
            ? 'CELL_PLAN_ALREADY_APPLIED: this plan was already applied and cleaned'
            : 'CELL_PLAN_DISCARDED: this plan was already discarded',
        }
      }
      const record = selected.record
      let evidenceDigest
      let reason
      if (parsed.operation === 'cell-run') {
        if (record.phase !== 'planned') {
          return { kind: 'deny', reason: 'CELL_PLAN_ALREADY_RUN: discard or apply this workflow before planning another run' }
        }
        await revalidate(record, exec.signal)
        reason = renderApprovalReason(record)
      } else {
        if (record.applyCommitted === true) {
          return {
            kind: 'deny',
            reason: 'CELL_PLAN_ALREADY_APPLIED: source is already changed; only verified cleanup may continue',
          }
        }
        if (record.phase !== 'staged') {
          return { kind: 'deny', reason: 'CELL_APPLY_NOT_READY: workflow phase is ' + record.phase }
        }
        const evidence = await collectApplyEvidence(record, exec.signal)
        evidenceDigest = evidence.evidenceDigest
        reason = renderApplyApprovalReason(record, evidenceDigest)
      }
      assertActive(exec.signal, 'Isolated Build approval preparation was cancelled.')
      pendingApprovals.set(exec.token, {
        owner: exec.agent,
        digest: record.digest,
        callId: exec.callId,
        operation: parsed.operation,
        evidenceDigest,
      })
      return { kind: 'ask', reason }
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
        || pending.operation !== parsed.operation
        || pending.callId !== exec.callId) {
      return 'CELL_APPROVAL_GATE_UNAVAILABLE: an audited allowed-once pre-execute proof did not reach the guard'
    }
    pendingApprovals.delete(exec.token)
    allowedApprovals.set(exec.token, pending)
    return undefined
  }

  function consumeApproval(call, operation, planDigest) {
    const proof = allowedApprovals.get(call.executionToken)
    allowedApprovals.delete(call.executionToken)
    pendingApprovals.delete(call.executionToken)
    if (proof === undefined
        || proof.owner !== call.agent
        || proof.digest !== planDigest
        || proof.operation !== operation
        || proof.callId !== call.callId) {
      throw error(
        'CELL_APPROVAL_GATE_UNAVAILABLE',
        operation + ' requires an unconsumed registry-minted proof that audited tools/pre-execute returned allowed-once.',
      )
    }
    return proof
  }

  function settleExecution(exec) {
    if (exec?.name !== TOOL_NAME || typeof exec.token !== 'symbol') return
    pendingApprovals.delete(exec.token)
    allowedApprovals.delete(exec.token)
  }

  async function run(input, call = {}) {
    assertController()
    const planDigest = validateDigest(input.planDigest)
    consumeApproval(call, 'cell-run', planDigest)
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
        const expectedFinalFingerprint = sealedStage?.fingerprint ?? record.sourceFingerprint
        const verificationOk = finalDoctor.ok === true
          && finalDoctor.fingerprint === expectedFinalFingerprint
          && (preflight === null || (preflight.ok === true
            && (preflight.sourceFingerprint === undefined
              || preflight.sourceFingerprint === expectedFinalFingerprint)))
        record.runSucceeded = commandsOk && verificationOk
        record.stagedEvidence = deepFreeze({
          doctor: {
            ok: finalDoctor.ok === true,
            fingerprint: finalDoctor.fingerprint,
            digest: reportDigest(finalDoctor),
          },
          preflight: preflight === null ? { applicable: false } : {
            applicable: true,
            ok: preflight.ok === true,
            profile: preflight.profile,
            sourceFingerprint: preflight.sourceFingerprint ?? expectedFinalFingerprint,
            evidenceDigest: preflight.evidenceDigest,
          },
        })
        record.phase = 'staged'
        return {
          kind: 'isolated-cell-run',
          version: 1,
          ok: record.runSucceeded,
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

  async function apply(input, call = {}) {
    assertController()
    const planDigest = validateDigest(input.planDigest)
    const selected = currentFor(call.agent, planDigest)
    if (selected.tombstone) {
      throw error(
        selected.tombstone.disposition === 'applied' ? 'CELL_PLAN_ALREADY_APPLIED' : 'CELL_PLAN_DISCARDED',
        selected.tombstone.disposition === 'applied'
          ? 'This isolated Build plan was already applied and cleaned.'
          : 'This isolated Build plan was already discarded.',
      )
    }
    const record = selected.record
    if (record.applyCommitted === true) {
      throw error(
        'CELL_PLAN_ALREADY_APPLIED',
        'This isolated Build plan already changed source; only verified cleanup may continue.',
        { retainedRoot: record.transaction?.root ?? record.stage?.anchor ?? null },
      )
    }
    if (record.applyPromise !== undefined) {
      throw error('CELL_APPLY_IN_PROGRESS', 'Another cell-apply is already running for this plan.')
    }
    if (record.phase !== 'staged') {
      throw error('CELL_APPLY_NOT_READY', 'cell-apply requires one staged workflow.', { phase: record.phase })
    }
    const proof = consumeApproval(call, 'cell-apply', planDigest)
    record.phase = 'applying'
    const signal = combineSignals(call.signal, record.lifetime.signal)
    let transaction
    let appliedTree
    let finalDoctor
    let finalPreflight = { applicable: false }
    const operation = (async () => {
      const approved = await collectApplyEvidence(record, call.signal)
      if (approved.evidenceDigest !== proof.evidenceDigest) {
        throw error('CELL_APPLY_APPROVAL_STALE', 'The staged apply evidence changed after its audited approval reason was created.')
      }
      try {
        transaction = await prepareApplyTransaction(record, dependencies, signal)
        const precommit = await collectApplyEvidence(record, signal)
        if (precommit.evidenceDigest !== proof.evidenceDigest) {
          throw error('CELL_APPLY_APPROVAL_STALE', 'Source, stage, Doctor, or preflight changed before the transaction commit.')
        }
        await dependencies.applyBarrier('before-source-commit', { record, transaction })
        assertActive(signal, 'Source application was cancelled before transaction commit.')
        await commitCandidate(record, transaction, dependencies, signal)
        await dependencies.applyBarrier('before-final-apply-validation', { record, transaction })
        assertActive(signal, 'Source application was cancelled before final validation.')
        appliedTree = await dependencies.scanTree(record.workspace.root, { signal })
        const appliedIdentity = await dependencies.inspectTreeIdentity(record.workspace.root, appliedTree, { signal })
        const workspace = await dependencies.inspectWorkspace(record.owner, {
          signal,
          isRootAgent: dependencies.isRootAgent,
        })
        if (appliedTree.fingerprint !== record.stage.fingerprint
            || workspace.identityDigest !== record.workspace.identityDigest) {
          throw error('CELL_APPLY_RESULT_MISMATCH', 'Applied source bytes or root authority differ from the exact staged tree.', {
            expected: record.stage.fingerprint,
            actual: appliedTree.fingerprint,
          })
        }
        finalDoctor = await dependencies.doctor(record.workspace.root, { runtime: 'skip', signal })
        assertActive(signal, 'Source application was cancelled after final static Doctor.')
        if (record.stagedEvidence.preflight.applicable) {
          const value = await dependencies.preflight(record.workspace.root, {
            dshPath: dependencies.dshPath,
            profile: PROFILE,
            signal,
          })
          finalPreflight = {
            applicable: true,
            ok: value.ok === true,
            profile: value.profile,
            sourceFingerprint: value.sourceFingerprint ?? appliedTree.fingerprint,
            evidenceDigest: value.evidenceDigest,
          }
        }
        const doctorEvidence = {
          ok: finalDoctor.ok === true,
          fingerprint: finalDoctor.fingerprint,
          digest: reportDigest(finalDoctor),
        }
        if (doctorEvidence.ok !== true
            || doctorEvidence.fingerprint !== record.stage.fingerprint
            || doctorEvidence.digest !== record.stagedEvidence.doctor.digest
            || JSON.stringify(finalPreflight) !== JSON.stringify(record.stagedEvidence.preflight)) {
          throw error('CELL_APPLY_FINAL_VERIFICATION_FAILED', 'Final applied Doctor or preflight differs from the exact staged evidence.')
        }
        await dependencies.applyBarrier('after-final-apply-validation', { record, transaction })
        assertActive(signal, 'Source application was cancelled after final verification.')
        await writeTransactionMarker(record, transaction, 'committed')
        record.applyCommitted = true
        record.appliedIdentity = appliedIdentity
        record.phase = 'apply-cleaning'
        const backupCleanup = await cleanupTransaction(record, dependencies)
        const stageCleanup = await discardStage(record, dependencies)
        const tombstone = deepFreeze({
          disposition: 'applied',
          sourceFingerprint: record.sourceFingerprint,
          appliedFingerprint: record.stage.fingerprint,
          changedPaths: record.stage.changes,
        })
        tombstonesFor(slot, record.owner).set(record.digest, tombstone)
        slot.record = null
        return {
          kind: 'isolated-cell-apply',
          version: 1,
          ok: true,
          planDigest,
          alreadyApplied: false,
          source: {
            path: record.workspace.root,
            fingerprintBefore: record.sourceFingerprint,
            fingerprintAfter: appliedTree.fingerprint,
            physicalIdentity: workspace.identityDigest,
            changedPaths: record.stage.changes,
            effect: 'exact-staged-tree-applied',
          },
          staging: { fingerprint: record.stage.fingerprint, removed: stageCleanup.removed },
          verification: {
            doctor: doctorEvidence,
            preflight: finalPreflight,
            repositoryCodeExecuted: false,
          },
          rollback: { required: false, verified: false },
          cleanup: {
            backupRemoved: backupCleanup.removed,
            stageRemoved: stageCleanup.removed,
            verified: true,
            capacityReleased: true,
            retainedRoot: null,
          },
        }
      } catch (cause) {
        const failure = cause?.name === 'AbortError' || cause?.code === 'ABORT_ERR'
          ? error('CANCELLED', 'Source application was cancelled.')
          : cause
        if (record.applyCommitted === true) {
          record.phase = 'cleanup-failed'
          const transactionRetained = transaction !== undefined && transaction.state !== 'cleaned'
          const retainedRoot = transactionRetained ? transaction.root : record.stage?.anchor ?? null
          const cleanupFailure = safeCellWorkflowDiagnostic(failure)
          const cleanupResumable = RESUMABLE_CLEANUP_DIAGNOSTICS.has(cleanupFailure.code)
          return {
            kind: 'isolated-cell-apply', version: 1, ok: false, planDigest,
            alreadyApplied: true,
            failure: safeCellWorkflowDiagnostic(error(
              'CELL_APPLY_CLEANUP_FAILED',
              'Source was applied and verified, but cleanup is incomplete; capacity remains poisoned until discard resumes it.',
              { cleanup: cleanupFailure, retainedRoot },
            )),
            source: {
              path: record.workspace.root,
              fingerprintBefore: record.sourceFingerprint,
              fingerprintAfter: record.stage.fingerprint,
              physicalIdentity: record.workspace.identityDigest,
              changedPaths: record.stage.changes,
              effect: 'exact-staged-tree-applied',
            },
            staging: { fingerprint: record.stage.fingerprint, removed: false },
            verification: {
              doctor: {
                ok: finalDoctor?.ok === true,
                fingerprint: finalDoctor?.fingerprint ?? null,
                digest: finalDoctor === undefined ? null : reportDigest(finalDoctor),
              },
              preflight: finalPreflight,
              repositoryCodeExecuted: false,
            },
            rollback: { required: false, verified: false },
            cleanup: {
              backupRemoved: !transactionRetained,
              stageRemoved: false,
              verified: false,
              resumable: cleanupResumable,
              capacityReleased: false,
              retainedRoot,
            },
          }
        }
        let rollbackVerified = false
        let rollbackFailure
        if (transaction?.mutationStarted && record.applyCommitted !== true) {
          try {
            await rollbackSource(record, transaction, dependencies, failure)
            rollbackVerified = true
          } catch (rollbackCause) {
            rollbackFailure = rollbackCause
          }
        }
        if (rollbackFailure !== undefined) {
          record.phase = 'rollback-failed'
          return {
            kind: 'isolated-cell-apply', version: 1, ok: false, planDigest,
            failure: safeCellWorkflowDiagnostic(error(
              'CELL_APPLY_ROLLBACK_FAILED',
              'Apply failed and byte-identical rollback could not be verified; recovery state remains poisoned.',
              { operation: safeCellWorkflowDiagnostic(failure), cleanup: safeCellWorkflowDiagnostic(rollbackFailure), retainedRoot: transaction.root },
            )),
            source: { path: record.workspace.root, fingerprintBefore: record.sourceFingerprint, fingerprintAfter: null },
            rollback: { required: true, verified: false },
            cleanup: { verified: false, capacityReleased: false, retainedRoot: transaction.root },
          }
        }
        let transactionCleaned = transaction === undefined
        if (transaction !== undefined) {
          try {
            await cleanupTransaction(record, dependencies)
            transactionCleaned = true
            record.transaction = undefined
          } catch (cleanupCause) {
            record.phase = 'cleanup-failed'
            return {
              kind: 'isolated-cell-apply', version: 1, ok: false, planDigest,
              failure: safeCellWorkflowDiagnostic(error(
                'CELL_APPLY_CLEANUP_FAILED',
                'Apply failed safely, but transaction cleanup is ambiguous and capacity remains poisoned.',
                { operation: safeCellWorkflowDiagnostic(failure), cleanup: safeCellWorkflowDiagnostic(cleanupCause), retainedRoot: transaction.root },
              )),
              source: { path: record.workspace.root, fingerprintBefore: record.sourceFingerprint, fingerprintAfter: rollbackVerified ? record.sourceFingerprint : null },
              rollback: { required: transaction.mutationStarted, verified: rollbackVerified },
              cleanup: { verified: false, capacityReleased: false, retainedRoot: transaction.root },
            }
          }
        }
        record.phase = 'staged'
        return {
          kind: 'isolated-cell-apply', version: 1, ok: false, planDigest,
          phase: record.phase,
          failure: safeCellWorkflowDiagnostic(failure),
          source: {
            path: record.workspace.root,
            fingerprintBefore: record.sourceFingerprint,
            fingerprintAfter: record.sourceFingerprint,
            effect: transaction?.mutationStarted === true ? 'rolled-back-to-original' : 'none',
          },
          rollback: { required: transaction?.mutationStarted === true, verified: rollbackVerified },
          staging: { retained: true, fingerprint: record.stage.fingerprint },
          cleanup: { transactionCleaned, stageRetained: true, capacityReleased: false, retainedRoot: record.stage.anchor },
        }
      }
    })()
    record.applyPromise = operation
    try {
      return await operation
    } catch (cause) {
      if (record.phase === 'applying' && transaction === undefined && record.applyCommitted !== true) {
        record.phase = 'staged'
      }
      throw cause
    } finally {
      record.applyPromise = undefined
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
        alreadyDiscarded: selected.tombstone.disposition === 'discarded',
        alreadyApplied: selected.tombstone.disposition === 'applied',
        cleanup: { verified: true, capacityReleased: true, retainedRoot: null },
      }
    }
    const record = selected.record
    if (record.phase === 'rollback-failed') {
      throw error('CELL_APPLY_RECOVERY_REQUIRED', 'Unverified source rollback retains the transaction and blocks destructive cleanup.', {
        retainedRoot: record.transaction?.root ?? null,
      })
    }
    record.lifetime.abort(error('CELL_DISCARDING', 'The isolated Build workflow is being discarded.'))
    if (record.runPromise !== undefined) await record.runPromise.catch(() => {})
    if (record.applyPromise !== undefined) await record.applyPromise.catch(() => {})
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
    const applied = record.applyCommitted === true
    record.phase = 'staged'
    try {
      const transactionCleanup = await cleanupTransaction(record, dependencies, call.signal)
      const cleanup = await discardStage(record, dependencies, call.signal)
      tombstonesFor(slot, record.owner).set(record.digest, deepFreeze({
        disposition: applied ? 'applied' : 'discarded',
        sourceFingerprint: record.sourceFingerprint,
        appliedFingerprint: applied ? record.stage?.fingerprint ?? null : null,
      }))
      slot.record = null
      return {
        kind: 'isolated-cell-discard',
        version: 1,
        ok: true,
        planDigest,
        alreadyDiscarded: false,
        alreadyApplied: applied,
        source: {
          path: record.workspace.root,
          effect: applied ? 'already-applied' : 'none',
          fingerprint: applied ? record.stage?.fingerprint ?? null : record.sourceFingerprint,
        },
        cleanup: {
          verified: true,
          transactionRemoved: transactionCleanup.removed,
          stageRemoved: cleanup.removed,
          stageAlreadyAbsent: cleanup.absent,
          capacityReleased: true,
          retainedRoot: null,
        },
      }
    } catch (cause) {
      record.phase = 'cleanup-failed'
      throw error('CELL_DISCARD_CLEANUP_FAILED', 'Transaction or stage cleanup is ambiguous; capacity remains poisoned and the retained root is reported.', {
        retainedRoot: record.transaction?.root ?? record.stage?.anchor ?? null,
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
      const retainedRoot = record.transaction?.root ?? record.stage?.anchor ?? null
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
    apply,
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
  if (report.kind === 'isolated-cell-apply') {
    const lines = [
      (report.ok ? 'PASS' : 'FAIL') + ' Isolated Build apply ' + report.planDigest,
      'Source fingerprint: ' + (report.source.fingerprintAfter ?? '(unverified)'),
      'Rollback verified: ' + report.rollback.verified,
      'Capacity released: ' + report.cleanup.capacityReleased,
    ]
    if (report.failure) lines.push('Failure: ' + report.failure.code + ': ' + report.failure.message)
    return lines.join('\n')
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
