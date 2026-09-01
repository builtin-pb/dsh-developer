import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { LIMITS } from './constants.js'
import {
  assertOfficialDshInvocation,
  locateInstalledDshPackage,
  resolveInstalledDshEntry,
} from './dsh-installation.js'
import { DshDeveloperError } from './errors.js'
import { resolveDshInvocation } from './runtime.js'
import { findSecrets } from './security.js'

const PACKAGE_BYTES = 1024 * 1024
const CONFIG_DEPTH = 16
const CONFIG_NODES = 4096
const EVENT_KEYS = 64
const GROUPS_PER_EVENT = 64
const HOOKS_PER_GROUP = 64
const TOTAL_HANDLERS = 256
const COMMAND_CHARS = 8192
const MATCHER_CHARS = 2000
const MAX_TIMEOUT_SECONDS = 3600

const BRIDGE_NAMES = Object.freeze({
  codex: '@deepseek-ai/dsh-hooks-codex',
  'claude-code': '@deepseek-ai/dsh-hooks-claude-code',
})
const PROTOCOL_NAME = '@deepseek-ai/dsh-hook-protocol'

export const REVIEWED_HOOK_BRIDGE_LANES = Object.freeze({
  release: Object.freeze({
    version: '0.1.1-rc.2',
    dsh: Object.freeze({
      manifest: 'sha256:dc930c0b18158f49ae3753ceaf6b1b7ae71dc6c8f45c85a2d679b142024addf7',
      entry: 'sha256:c0226687bb20f45c603ec6fe50f3de16d1c3510c3a803304ec575ef9bc366c62',
    }),
    bridgeStatus: 'reviewed-absent',
  }),
  preview: Object.freeze({
    version: '0.1.2-alpha.3',
    dsh: Object.freeze({
      manifest: 'sha256:55a3faef50e35cc7add312af7ea6802bafb899c873aae9abb5d497d10bf4f7cd',
      entry: 'sha256:dc23f6c5dd7df8834e3e38bdb9609d77b459834681ae9b7133b417b0c35f3166',
    }),
    bridgeStatus: 'reviewed-partial',
    bridges: Object.freeze({
      codex: Object.freeze({
        name: '@deepseek-ai/dsh-hooks-codex',
        version: '0.1.2-alpha.3',
        manifest: 'sha256:f195fc0cbd86ec945fc1937c7f260eaef40795f90c3ea0b15234f5da5651d835',
        entry: 'sha256:45d8e4404d668e0eae420637dcb1331b3c74899e422d70b7455779a2676fb939',
        invariant: 'sha256:92cdfd08b88830b522a3a3239647e36e9ed63392d73ca82123b4e35af666092d',
      }),
      'claude-code': Object.freeze({
        name: '@deepseek-ai/dsh-hooks-claude-code',
        version: '0.1.2-alpha.3',
        manifest: 'sha256:162bbd1144d0fec181ef25ff7c379f5c3aa6fa13360504ef567b001f87f4777c',
        entry: 'sha256:e721b84cb0487c10e6144189e285669669c335d4cd6fc03ce35d7db43073a512',
        invariant: 'sha256:b86472e551fbba6c189b40fb4a70cddc4a2d0510ba4e1b9f76f9191aaa1f63e3',
      }),
    }),
    protocol: Object.freeze({
      name: PROTOCOL_NAME,
      version: '0.1.2-alpha.3',
      manifest: 'sha256:10cff724f969a77e2279a028be0d3fd6d7c50843482c8d3fbf4dff599c8b9e31',
      entry: 'sha256:8b03c89ed6529049eb4fb567fff6ad8d593e9405f1cc87487c446d8030be98a3',
      invariant: 'sha256:bf6d47961654759f5515982c7783602afb9bb05e6ab8c3c35edae15840b2dfc5',
    }),
  }),
})

const EVENT_SPECS = Object.freeze({
  codex: Object.freeze({
    supported: Object.freeze([
      Object.freeze({ name: 'PreToolUse', matcherSubject: 'tool-name', effects: ['deny-tool'], limitations: ['ask-allow-context-rewrite-not-mapped'] }),
      Object.freeze({ name: 'PostToolUse', matcherSubject: 'tool-name', effects: ['block-tool-result', 'append-context'], limitations: ['tool-input-command-only', 'tool-output-text-only'] }),
      Object.freeze({ name: 'SessionStart', matcherSubject: 'session-source', effects: ['inject-context'], limitations: ['detached', 'may-miss-first-request'] }),
      Object.freeze({ name: 'UserPromptSubmit', matcherSubject: 'none', effects: ['deny-prompt', 'append-context'], limitations: ['matcher-ignored'] }),
      Object.freeze({ name: 'Stop', matcherSubject: 'none', effects: ['continue-turn'], limitations: ['matcher-ignored', 'static-loop-guard'] }),
    ]),
    unsupported: Object.freeze(['PermissionRequest', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop']),
  }),
  'claude-code': Object.freeze({
    supported: Object.freeze([
      Object.freeze({ name: 'SessionStart', matcherSubject: 'session-source', effects: ['inject-context'], limitations: ['detached', 'json-context-only'] }),
      Object.freeze({ name: 'UserPromptSubmit', matcherSubject: 'none', effects: ['deny-prompt', 'append-context'], limitations: ['matcher-ignored'] }),
      Object.freeze({ name: 'PreToolUse', matcherSubject: 'tool-name', effects: ['deny-tool', 'ask-tool'], limitations: ['context-rewrite-not-mapped'] }),
      Object.freeze({ name: 'PostToolUse', matcherSubject: 'tool-name', effects: ['block-tool-result', 'append-context'], limitations: [] }),
      Object.freeze({ name: 'Stop', matcherSubject: 'none', effects: ['continue-turn'], limitations: ['matcher-ignored', 'static-loop-guard'] }),
      Object.freeze({ name: 'SubagentStart', matcherSubject: 'agent-type:general-purpose', effects: ['inject-live-child-context'], limitations: ['detached', 'in-process-child-only', 'partial-payload'] }),
      Object.freeze({ name: 'SubagentStop', matcherSubject: 'agent-type:general-purpose', effects: ['observe-only'], limitations: ['detached', 'partial-payload'] }),
    ]),
    unsupported: Object.freeze([
      'Setup',
      'InstructionsLoaded',
      'UserPromptExpansion',
      'MessageDisplay',
      'PermissionRequest',
      'PostToolUseFailure',
      'PostToolBatch',
      'PermissionDenied',
      'Notification',
      'TaskCreated',
      'TaskCompleted',
      'StopFailure',
      'TeammateIdle',
      'ConfigChange',
      'CwdChanged',
      'FileChanged',
      'WorktreeCreate',
      'WorktreeRemove',
      'PreCompact',
      'PostCompact',
      'SessionEnd',
      'Elicitation',
      'ElicitationResult',
    ]),
  }),
})

const CLAUDE_LITERAL = /^[A-Za-z0-9_|]+$/u
const CLAUDE_IGNORED_HANDLER_OPTIONS = new Set([
  'args',
  'async',
  'asyncRewake',
  'shell',
  'if',
  'once',
  'statusMessage',
])

function active(signal) {
  if (signal?.aborted) throw new DshDeveloperError('CANCELLED', 'Hook Bridge Doctor was cancelled.')
}

function digest(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  return 'sha256:' + createHash('sha256').update(input).digest('hex')
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function normalizedPath(value) {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLocaleLowerCase('en-US') : absolute
}

function inside(root, candidate) {
  const value = relative(resolve(root), resolve(candidate))
  return value === '' || (value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value))
}

function sourceFailure(code, message) {
  throw new DshDeveloperError(code, message)
}

async function readStableBytes(path, limit, signal, label, options = {}) {
  active(signal)
  const before = await lstat(path, { bigint: true }).catch(() => {
    sourceFailure(label + '_UNAVAILABLE', 'A required static inspection file is unavailable.')
  })
  if (before.isSymbolicLink() || !before.isFile()) {
    sourceFailure(label + '_UNSAFE', 'Static inspection accepts only ordinary files, never links or special files.')
  }
  if (options.rejectHardlinks === true && before.nlink !== 1n) {
    sourceFailure(label + '_UNSAFE', 'Static inspection rejects source files with hard-link aliases.')
  }
  if (before.size > BigInt(limit)) sourceFailure(label + '_TOO_LARGE', 'A static inspection file exceeds its bounded read limit.')
  const handle = await open(path, 'r').catch(() => {
    sourceFailure(label + '_UNAVAILABLE', 'A required static inspection file could not be opened.')
  })
  let buffer
  try {
    active(signal)
    const opened = await handle.stat({ bigint: true })
    if (!sameStat(before, opened)) sourceFailure(label + '_MUTATED', 'A static inspection file changed while it was opened.')
    buffer = await handle.readFile()
    active(signal)
    const afterRead = await handle.stat({ bigint: true })
    if (!sameStat(opened, afterRead)) sourceFailure(label + '_MUTATED', 'A static inspection file changed while it was read.')
  } finally {
    await handle.close()
  }
  const after = await lstat(path, { bigint: true }).catch(() => undefined)
  if (!after || !sameStat(before, after)) sourceFailure(label + '_MUTATED', 'A static inspection file changed before its evidence was sealed.')
  if (buffer.byteLength > limit) sourceFailure(label + '_TOO_LARGE', 'A static inspection file exceeds its bounded read limit.')
  return { buffer, bytes: buffer.byteLength, fingerprint: digest(buffer) }
}

function decodeText(snapshot, label) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.buffer)
  } catch {
    sourceFailure(label + '_INVALID_TEXT', 'A static inspection file is not valid UTF-8 text.')
  }
  if (text.includes('\0')) sourceFailure(label + '_INVALID_TEXT', 'A static inspection file contains a NUL byte.')
  return text
}

function parseManifest(snapshot) {
  const text = decodeText(snapshot, 'HOOK_PACKAGE')
  let value
  try {
    value = JSON.parse(text)
  } catch {
    sourceFailure('HOOK_PACKAGE_INVALID', 'A reviewed package manifest is not valid JSON.')
  }
  if (!plainObject(value)) sourceFailure('HOOK_PACKAGE_INVALID', 'A reviewed package manifest must contain one JSON object.')
  return value
}

async function authorizeSourcePath(source, sourceRoot, signal) {
  active(signal)
  const absolute = sourceRoot === undefined || isAbsolute(source)
    ? resolve(source)
    : resolve(sourceRoot, source)
  if (sourceRoot === undefined) return absolute
  const root = resolve(sourceRoot)
  if (!inside(root, absolute)) {
    sourceFailure('HOOK_SOURCE_OUTSIDE_PROJECT', 'Native Hook Bridge Doctor accepts only a source inside the current project.')
  }
  const rootPhysical = await realpath(root).catch(() => {
    sourceFailure('HOOK_PROJECT_UNAVAILABLE', 'The current project root is unavailable for source confinement.')
  })
  if (normalizedPath(rootPhysical) !== normalizedPath(root)) {
    sourceFailure('HOOK_PROJECT_LINKED', 'The current project root traverses a link or junction.')
  }
  return absolute
}

async function readConfigSource(path, sourceRoot, signal) {
  const physical = await realpath(path).catch(() => {
    sourceFailure('HOOK_SOURCE_UNAVAILABLE', 'The hook configuration file is unavailable.')
  })
  if (normalizedPath(physical) !== normalizedPath(path)) {
    sourceFailure('HOOK_SOURCE_LINKED', 'The hook configuration path traverses a link or junction.')
  }
  if (sourceRoot !== undefined) {
    const rootPhysical = await realpath(resolve(sourceRoot)).catch(() => {
      sourceFailure('HOOK_PROJECT_UNAVAILABLE', 'The current project root is unavailable for source confinement.')
    })
    if (!inside(rootPhysical, physical)) {
      sourceFailure('HOOK_SOURCE_OUTSIDE_PROJECT', 'Native Hook Bridge Doctor accepts only a source inside the current project.')
    }
  }
  const snapshot = await readStableBytes(physical, LIMITS.creatorBytes, signal, 'HOOK_SOURCE', { rejectHardlinks: true })
  const afterPhysical = await realpath(path).catch(() => undefined)
  if (!afterPhysical || normalizedPath(afterPhysical) !== normalizedPath(physical)) {
    sourceFailure('HOOK_SOURCE_MUTATED', 'The hook configuration path changed while its snapshot was acquired.')
  }
  if (sourceRoot !== undefined) {
    const rootAfter = await realpath(resolve(sourceRoot)).catch(() => undefined)
    if (!rootAfter
        || normalizedPath(rootAfter) !== normalizedPath(resolve(sourceRoot))
        || !inside(rootAfter, afterPhysical)) {
      sourceFailure('HOOK_SOURCE_MUTATED', 'The project boundary changed while hook configuration was inspected.')
    }
  }
  const text = decodeText(snapshot, 'HOOK_SOURCE')
  if (findSecrets(text).length > 0 || /:\/\/[^/\s:@]+:[^/\s@]+@/u.test(text)) {
    sourceFailure('HOOK_SOURCE_SECRET', 'Potential credentials were found in hook configuration; no source digest or content was emitted.')
  }
  return { ...snapshot, text }
}

function boundedConfig(value, signal) {
  const stack = [{ value, depth: 0 }]
  let nodes = 0
  while (stack.length > 0) {
    active(signal)
    const current = stack.pop()
    nodes += 1
    if (nodes > CONFIG_NODES) sourceFailure('HOOK_CONFIG_NODE_LIMIT', 'Hook configuration exceeds the bounded node limit.')
    if (current.depth > CONFIG_DEPTH) sourceFailure('HOOK_CONFIG_DEPTH_LIMIT', 'Hook configuration exceeds the bounded nesting limit.')
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 })
      }
    } else if (plainObject(current.value)) {
      for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 })
    }
  }
  return nodes
}

function readJsonConfig(snapshot, signal) {
  let value
  try {
    value = JSON.parse(snapshot.text)
  } catch {
    sourceFailure('HOOK_CONFIG_INVALID_JSON', 'Hook configuration is not strict JSON.')
  }
  if (!plainObject(value)) sourceFailure('HOOK_CONFIG_INVALID_ROOT', 'Hook configuration must contain one JSON object.')
  const nodes = boundedConfig(value, signal)
  if (Object.prototype.hasOwnProperty.call(value, 'hooks')) {
    if (!plainObject(value.hooks)) sourceFailure('HOOK_CONFIG_INVALID_WRAPPER', 'A present hooks wrapper must contain one JSON object.')
    return { value: value.hooks, shape: 'wrapped', nodes }
  }
  return { value, shape: 'bare', nodes }
}

async function stableArtifact(path, root, signal) {
  const physical = await realpath(path).catch(() => {
    sourceFailure('HOOK_PACKAGE_INCOMPLETE', 'A reviewed package artifact is unavailable.')
  })
  if (!inside(root, physical)) sourceFailure('HOOK_PACKAGE_ESCAPE', 'A reviewed package artifact resolves outside its package root.')
  return { path: physical, ...await readStableBytes(physical, PACKAGE_BYTES, signal, 'HOOK_PACKAGE') }
}

async function locateProtocolPackage(bridgeEntryPath, signal) {
  let resolvedEntry
  try {
    // Resolution is metadata-only: createRequire.resolve never evaluates package code.
    resolvedEntry = await realpath(createRequire(bridgeEntryPath).resolve(PROTOCOL_NAME))
  } catch {
    sourceFailure('HOOK_PROTOCOL_MISSING', 'The selected bridge protocol package is missing.')
  }
  let directory = dirname(resolvedEntry)
  for (let depth = 0; depth < 8; depth += 1) {
    active(signal)
    const manifestPath = await realpath(join(directory, 'package.json')).catch(() => undefined)
    if (!manifestPath) {
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
      continue
    }
    const snapshot = await readStableBytes(manifestPath, PACKAGE_BYTES, signal, 'HOOK_PACKAGE')
    const value = parseManifest(snapshot)
    if (value.name === PROTOCOL_NAME) {
      const root = await realpath(dirname(manifestPath))
      if (!inside(root, resolvedEntry)) sourceFailure('HOOK_PROTOCOL_ENTRY_INVALID', 'The resolved hook protocol entry escapes its package root.')
      return { root, manifestPath, value, snapshot, resolvedEntry }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  sourceFailure('HOOK_PROTOCOL_MISSING', 'The selected bridge protocol package is missing.')
}

async function resealArtifacts(artifacts, signal) {
  for (const artifact of artifacts) {
    active(signal)
    const again = await readStableBytes(artifact.path, PACKAGE_BYTES, signal, 'HOOK_PACKAGE')
    if (again.bytes !== artifact.snapshot.bytes || again.fingerprint !== artifact.snapshot.fingerprint) {
      sourceFailure('HOOK_PACKAGE_MUTATED', 'Reviewed package bytes changed before the lane evidence was sealed.')
    }
  }
}

function laneMatch(version, manifest, entry, reviewed) {
  for (const [id, lane] of Object.entries(reviewed)) {
    if (version === lane.version && manifest === lane.dsh.manifest && entry === lane.dsh.entry) return { id, ...lane }
  }
  return undefined
}

function artifactMismatch(actual, expected) {
  return actual !== expected
}

async function inspectLane(dshPath, dialect, signal, dependencies) {
  const resolveInvocation = dependencies.resolveDshInvocation ?? resolveDshInvocation
  const assertOfficial = dependencies.assertOfficialDshInvocation ?? assertOfficialDshInvocation
  const locateInstalled = dependencies.locateInstalledDshPackage ?? locateInstalledDshPackage
  const resolveEntry = dependencies.resolveInstalledDshEntry ?? resolveInstalledDshEntry
  const reviewed = dependencies.reviewedLanes ?? REVIEWED_HOOK_BRIDGE_LANES
  active(signal)
  const invocation = await resolveInvocation(dshPath)
  const located = await assertOfficial(invocation)
  const manifestSnapshot = await readStableBytes(located.manifestPath, PACKAGE_BYTES, signal, 'HOOK_PACKAGE')
  const manifest = parseManifest(manifestSnapshot)
  if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string') {
    sourceFailure('HOOK_DSH_IDENTITY_INVALID', 'The selected DSH package identity is not reviewable.')
  }
  const declaredEntry = manifest.bin?.dsh
  if (typeof declaredEntry !== 'string') sourceFailure('HOOK_DSH_IDENTITY_INVALID', 'The selected DSH package has no declared CLI entry.')
  const entrySnapshot = await stableArtifact(resolve(located.root, declaredEntry), located.root, signal)
  const lane = laneMatch(manifest.version, manifestSnapshot.fingerprint, entrySnapshot.fingerprint, reviewed)
  if (!lane) sourceFailure('HOOK_LANE_UNREVIEWED', 'The selected DSH bytes have no reviewed Hook Bridge classification.')
  const dshPackage = { ...located, value: manifest }

  if (lane.bridgeStatus === 'reviewed-absent') {
    for (const packageName of Object.values(BRIDGE_NAMES)) {
      const declared = Object.prototype.hasOwnProperty.call(manifest.dependencies ?? {}, packageName)
      const installed = await locateInstalled(dshPackage, packageName)
      if (declared || installed) sourceFailure('HOOK_RELEASE_INVENTORY_DRIFT', 'The reviewed release bridge-absence inventory has drifted.')
    }
    await resealArtifacts([
      { path: located.manifestPath, snapshot: manifestSnapshot },
      { path: entrySnapshot.path, snapshot: entrySnapshot },
    ], signal)
    for (const packageName of Object.values(BRIDGE_NAMES)) {
      if (await locateInstalled(dshPackage, packageName)) {
        sourceFailure('HOOK_RELEASE_INVENTORY_DRIFT', 'The reviewed release bridge-absence inventory changed before evidence was sealed.')
      }
    }
    return {
      id: lane.id,
      dshVersion: lane.version,
      status: lane.bridgeStatus,
      dsh: { manifestDigest: manifestSnapshot.fingerprint, entryDigest: entrySnapshot.fingerprint },
      bridge: { name: BRIDGE_NAMES[dialect], availability: 'not-shipped' },
      protocol: { availability: 'not-applicable' },
      activation: 'not-inspected',
    }
  }

  const expectedBridge = lane.bridges?.[dialect]
  if (!expectedBridge) sourceFailure('HOOK_DIALECT_UNREVIEWED', 'The selected dialect has no reviewed bridge classification in this lane.')
  const bridge = await locateInstalled(dshPackage, expectedBridge.name)
  if (!bridge) sourceFailure('HOOK_BRIDGE_MISSING', 'The reviewed bridge package is missing from the selected DSH lane.')
  const bridgeManifestSnapshot = await readStableBytes(bridge.manifestPath, PACKAGE_BYTES, signal, 'HOOK_PACKAGE')
  const bridgeManifest = parseManifest(bridgeManifestSnapshot)
  const bridgeEntryPath = await resolveEntry({ ...bridge, value: bridgeManifest })
  const bridgeEntrySnapshot = await stableArtifact(bridgeEntryPath, bridge.root, signal)
  const bridgeInvariantSnapshot = await stableArtifact(join(bridge.root, 'lib', 'invariant.js'), bridge.root, signal)
  if (bridgeManifest.name !== expectedBridge.name
      || bridgeManifest.version !== expectedBridge.version
      || artifactMismatch(bridgeManifestSnapshot.fingerprint, expectedBridge.manifest)
      || artifactMismatch(bridgeEntrySnapshot.fingerprint, expectedBridge.entry)
      || artifactMismatch(bridgeInvariantSnapshot.fingerprint, expectedBridge.invariant)) {
    sourceFailure('HOOK_BRIDGE_UNREVIEWED', 'The selected bridge bytes have no reviewed semantic classification.')
  }

  const protocol = await locateProtocolPackage(bridgeEntryPath, signal)
  const expectedProtocol = lane.protocol
  const protocolEntryPath = await resolveEntry(protocol)
  if (normalizedPath(protocolEntryPath) !== normalizedPath(protocol.resolvedEntry)) {
    sourceFailure('HOOK_PROTOCOL_ENTRY_INVALID', 'The bridge-resolved protocol entry differs from its package-declared entry.')
  }
  const protocolEntrySnapshot = await stableArtifact(protocolEntryPath, protocol.root, signal)
  const protocolInvariantSnapshot = await stableArtifact(join(protocol.root, 'lib', 'invariant.js'), protocol.root, signal)
  if (protocol.value.name !== expectedProtocol.name
      || protocol.value.version !== expectedProtocol.version
      || artifactMismatch(protocol.snapshot.fingerprint, expectedProtocol.manifest)
      || artifactMismatch(protocolEntrySnapshot.fingerprint, expectedProtocol.entry)
      || artifactMismatch(protocolInvariantSnapshot.fingerprint, expectedProtocol.invariant)) {
    sourceFailure('HOOK_PROTOCOL_UNREVIEWED', 'The selected hook protocol bytes have no reviewed semantic classification.')
  }
  await resealArtifacts([
    { path: located.manifestPath, snapshot: manifestSnapshot },
    { path: entrySnapshot.path, snapshot: entrySnapshot },
    { path: bridge.manifestPath, snapshot: bridgeManifestSnapshot },
    { path: bridgeEntrySnapshot.path, snapshot: bridgeEntrySnapshot },
    { path: bridgeInvariantSnapshot.path, snapshot: bridgeInvariantSnapshot },
    { path: protocol.manifestPath, snapshot: protocol.snapshot },
    { path: protocolEntrySnapshot.path, snapshot: protocolEntrySnapshot },
    { path: protocolInvariantSnapshot.path, snapshot: protocolInvariantSnapshot },
  ], signal)
  return {
    id: lane.id,
    dshVersion: lane.version,
    status: lane.bridgeStatus,
    dsh: { manifestDigest: manifestSnapshot.fingerprint, entryDigest: entrySnapshot.fingerprint },
    bridge: {
      name: expectedBridge.name,
      version: expectedBridge.version,
      availability: 'shipped-reviewed-partial',
      manifestDigest: bridgeManifestSnapshot.fingerprint,
      entryDigest: bridgeEntrySnapshot.fingerprint,
      invariantDigest: bridgeInvariantSnapshot.fingerprint,
    },
    protocol: {
      name: expectedProtocol.name,
      version: expectedProtocol.version,
      availability: 'shipped-reviewed',
      manifestDigest: protocol.snapshot.fingerprint,
      entryDigest: protocolEntrySnapshot.fingerprint,
      invariantDigest: protocolInvariantSnapshot.fingerprint,
    },
    activation: 'not-inspected',
  }
}

function issue(issues, code, location = {}) {
  issues.push({ code, blocking: true, ...location })
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function matcherClass(event, group, dialect, issues, location, runnableHandlers) {
  const hasMatcher = Object.prototype.hasOwnProperty.call(group, 'matcher')
  if (event.matcherSubject === 'none') {
    if (hasMatcher) issue(issues, 'HOOK_MATCHER_IGNORED', location)
    return { classification: 'ignored-no-subject', invalidRunnableRegex: false }
  }
  if (!hasMatcher) return { classification: 'match-all', invalidRunnableRegex: false }
  if (typeof group.matcher !== 'string') {
    issue(issues, 'HOOK_MATCHER_INVALID_TYPE', location)
    return { classification: 'invalid', invalidRunnableRegex: false }
  }
  if (group.matcher.length > MATCHER_CHARS) {
    sourceFailure('HOOK_MATCHER_LIMIT', 'A hook matcher exceeds the bounded static-compilation limit.')
  }
  if (group.matcher === '' || group.matcher === '*') return { classification: 'match-all', invalidRunnableRegex: false }
  if (dialect === 'claude-code' && CLAUDE_LITERAL.test(group.matcher)) {
    return { classification: 'claude-literal-alternatives', invalidRunnableRegex: false }
  }
  try {
    // Syntax-only bounded compilation. The expression is never evaluated against data.
    new RegExp(group.matcher)
  } catch {
    issue(issues, 'HOOK_MATCHER_INVALID_REGEX', location)
    return { classification: 'invalid', invalidRunnableRegex: runnableHandlers > 0 }
  }
  return {
    classification: dialect === 'codex' ? 'codex-regex' : 'claude-regex',
    invalidRunnableRegex: false,
  }
}

function handlerClass(hook, dialect, issues, location, tokenFlags) {
  if (!plainObject(hook)) {
    issue(issues, 'HOOK_HANDLER_MALFORMED', location)
    return { classification: 'ignored-malformed', accepted: false, runtimeRunnable: false }
  }
  const typePresent = Object.prototype.hasOwnProperty.call(hook, 'type')
  const runtimeType = typeof hook.type === 'string' ? hook.type : 'command'
  const runtimeRunnable = runtimeType === 'command'
    && !(dialect === 'codex' && hook.async === true)
    && typeof hook.command === 'string'
  if (typePresent && typeof hook.type !== 'string') {
    issue(issues, 'HOOK_HANDLER_TYPE_INVALID', location)
    return { classification: 'ignored-malformed', accepted: false, runtimeRunnable }
  }
  const type = typePresent ? hook.type : 'command'
  if (type !== 'command') {
    issue(issues, 'HOOK_HANDLER_TYPE_UNSUPPORTED', location)
    return { classification: 'skipped-handler-type', accepted: false, runtimeRunnable: false }
  }
  if (dialect === 'codex' && hook.async === true) {
    issue(issues, 'HOOK_CODEX_ASYNC_SKIPPED', location)
    return { classification: 'skipped-async', accepted: false, runtimeRunnable: false }
  }
  if (typeof hook.command !== 'string' || hook.command.trim().length === 0 || hook.command.length > COMMAND_CHARS) {
    issue(issues, 'HOOK_COMMAND_INVALID', location)
    return { classification: 'invalid-command', accepted: false, runtimeRunnable }
  }
  let ignoredOptions = false
  const acceptedFields = dialect === 'codex'
    ? new Set(['type', 'command', 'timeout', 'timeoutSec', 'async'])
    : new Set(['type', 'command', 'timeout'])
  const ignoredKeys = new Set()
  if (dialect === 'claude-code') {
    for (const key of CLAUDE_IGNORED_HANDLER_OPTIONS) {
      if (!Object.prototype.hasOwnProperty.call(hook, key)) continue
      ignoredKeys.add(key)
    }
  } else if (Object.prototype.hasOwnProperty.call(hook, 'async') && typeof hook.async !== 'boolean') {
    ignoredOptions = true
    issue(issues, 'HOOK_HANDLER_OPTION_INVALID', location)
  }
  for (const key of Object.keys(hook)) {
    if (!acceptedFields.has(key)) ignoredKeys.add(key)
  }
  if (ignoredKeys.size > 0) {
    ignoredOptions = true
    issue(issues, 'HOOK_HANDLER_OPTION_IGNORED', { ...location, count: ignoredKeys.size })
  }
  const timeoutKeys = dialect === 'codex' ? ['timeout', 'timeoutSec'] : ['timeout']
  if (dialect === 'codex'
      && Object.prototype.hasOwnProperty.call(hook, 'timeout')
      && Object.prototype.hasOwnProperty.call(hook, 'timeoutSec')) {
    ignoredOptions = true
    issue(issues, 'HOOK_TIMEOUT_CONFLICT', location)
  }
  for (const key of timeoutKeys) {
    if (!Object.prototype.hasOwnProperty.call(hook, key)) continue
    const value = hook[key]
    if (typeof value !== 'number'
        || !Number.isSafeInteger(value)
        || value <= 0
        || value > MAX_TIMEOUT_SECONDS) {
      issue(issues, 'HOOK_TIMEOUT_INVALID', location)
      return { classification: 'invalid-timeout', accepted: false, runtimeRunnable }
    }
  }
  if (hook.command.includes('${CLAUDE_PLUGIN_ROOT}')) tokenFlags.claudePluginRoot = true
  if (hook.command.includes('${CLAUDE_PROJECT_DIR}')) tokenFlags.claudeProjectDir = true
  if (/\$\(|`|%[A-Za-z_][A-Za-z0-9_]*%|\$(?:\{)?[A-Za-z_][A-Za-z0-9_]*/u.test(hook.command)) {
    tokenFlags.shellInterpolation = true
  }
  if (dialect === 'claude-code'
      && (hook.command.includes('${CLAUDE_PLUGIN_ROOT}') || hook.command.includes('${CLAUDE_PROJECT_DIR}'))) {
    issue(issues, 'HOOK_SUBSTITUTION_CONTEXT_NOT_INSPECTED', location)
    ignoredOptions = true
  }
  return {
    classification: ignoredOptions ? 'runnable-command-with-ignored-options' : 'runnable-command',
    accepted: !ignoredOptions,
    runtimeRunnable,
  }
}

function summarizeClasses(classes) {
  return [...classes.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([classification, count]) => ({ classification, count }))
}

function unreachableEvent(rawGroups, totals, issues, eventIndex) {
  const classes = new Map()
  const handlers = { runnable: 0, runtimeRunnable: 0, skipped: 0, invalid: 0 }
  if (!Array.isArray(rawGroups)) {
    issue(issues, 'HOOK_EVENT_GROUPS_INVALID', { eventIndex })
    increment(classes, 'ignored-malformed')
    handlers.invalid += 1
    totals.invalid += 1
    return { groups: 0, handlers, handlerClasses: summarizeClasses(classes) }
  }
  if (rawGroups.length > GROUPS_PER_EVENT) sourceFailure('HOOK_GROUP_LIMIT', 'Hook configuration exceeds the bounded groups-per-event limit.')
  totals.groups += rawGroups.length
  for (let groupIndex = 0; groupIndex < rawGroups.length; groupIndex += 1) {
    const group = rawGroups[groupIndex]
    if (!plainObject(group) || !Array.isArray(group.hooks)) {
      increment(classes, 'ignored-malformed')
      handlers.invalid += 1
      totals.invalid += 1
      continue
    }
    if (group.hooks.length > HOOKS_PER_GROUP) sourceFailure('HOOK_HANDLER_GROUP_LIMIT', 'Hook configuration exceeds the bounded handlers-per-group limit.')
    for (let hookIndex = 0; hookIndex < group.hooks.length; hookIndex += 1) {
      totals.handlers += 1
      if (totals.handlers > TOTAL_HANDLERS) sourceFailure('HOOK_HANDLER_LIMIT', 'Hook configuration exceeds the bounded total-handler limit.')
      increment(classes, 'unreachable-event')
      handlers.skipped += 1
      totals.skipped += 1
    }
  }
  return { groups: rawGroups.length, handlers, handlerClasses: summarizeClasses(classes) }
}

function classifyConfig(config, dialect, signal) {
  const spec = EVENT_SPECS[dialect]
  const supported = new Map(spec.supported.map((event) => [event.name, event]))
  const unsupported = new Set(spec.unsupported)
  const eventKeys = Object.keys(config.value)
  if (eventKeys.length > EVENT_KEYS) sourceFailure('HOOK_EVENT_LIMIT', 'Hook configuration exceeds the bounded event-key limit.')
  const issues = []
  const events = []
  const tokenFlags = { claudePluginRoot: false, claudeProjectDir: false, shellInterpolation: false }
  const totals = { events: eventKeys.length, groups: 0, handlers: 0, runnable: 0, runtimeRunnable: 0, skipped: 0, invalid: 0, effectiveRunnable: 0 }
  let invalidRunnableRegex = false

  for (let eventIndex = 0; eventIndex < eventKeys.length; eventIndex += 1) {
    active(signal)
    const name = eventKeys[eventIndex]
    if (unsupported.has(name)) {
      issue(issues, 'HOOK_EVENT_UNSUPPORTED', { eventIndex })
      const unreachable = unreachableEvent(config.value[name], totals, issues, eventIndex)
      events.push({ event: name, support: 'unsupported', matcherSubject: 'none', effects: [], ...unreachable, matcherClasses: [], limitations: ['event-dropped-before-parsing'] })
      continue
    }
    const event = supported.get(name)
    if (!event) {
      issue(issues, 'HOOK_EVENT_UNKNOWN', { eventIndex })
      const unreachable = unreachableEvent(config.value[name], totals, issues, eventIndex)
      events.push({ eventIndex, support: 'unknown', matcherSubject: 'none', effects: [], ...unreachable, matcherClasses: [], limitations: ['event-dropped-before-parsing'] })
      continue
    }
    const rawGroups = config.value[name]
    if (!Array.isArray(rawGroups)) {
      issue(issues, 'HOOK_EVENT_GROUPS_INVALID', { eventIndex })
      events.push({ event: name, support: 'mapped-partial', matcherSubject: event.matcherSubject, effects: event.effects, groups: 0, handlers: { runnable: 0, runtimeRunnable: 0, skipped: 0, invalid: 1 }, handlerClasses: [{ classification: 'ignored-malformed', count: 1 }], matcherClasses: [], limitations: event.limitations })
      totals.invalid += 1
      continue
    }
    if (rawGroups.length > GROUPS_PER_EVENT) sourceFailure('HOOK_GROUP_LIMIT', 'Hook configuration exceeds the bounded groups-per-event limit.')
    const handlerClasses = new Map()
    const matcherClasses = new Map()
    const eventHandlers = { runnable: 0, runtimeRunnable: 0, skipped: 0, invalid: 0 }
    totals.groups += rawGroups.length
    for (let groupIndex = 0; groupIndex < rawGroups.length; groupIndex += 1) {
      active(signal)
      const group = rawGroups[groupIndex]
      const groupLocation = { eventIndex, groupIndex }
      if (!plainObject(group) || !Array.isArray(group.hooks)) {
        issue(issues, 'HOOK_GROUP_MALFORMED', groupLocation)
        increment(handlerClasses, 'ignored-malformed')
        eventHandlers.invalid += 1
        totals.invalid += 1
        continue
      }
      const ignoredGroupOptions = Object.keys(group).filter((key) => key !== 'matcher' && key !== 'hooks').length
      if (ignoredGroupOptions > 0) {
        issue(issues, 'HOOK_GROUP_OPTION_IGNORED', { ...groupLocation, count: ignoredGroupOptions })
      }
      if (group.hooks.length > HOOKS_PER_GROUP) sourceFailure('HOOK_HANDLER_GROUP_LIMIT', 'Hook configuration exceeds the bounded handlers-per-group limit.')
      let runnableInGroup = 0
      for (let hookIndex = 0; hookIndex < group.hooks.length; hookIndex += 1) {
        totals.handlers += 1
        if (totals.handlers > TOTAL_HANDLERS) sourceFailure('HOOK_HANDLER_LIMIT', 'Hook configuration exceeds the bounded total-handler limit.')
        const result = handlerClass(group.hooks[hookIndex], dialect, issues, { eventIndex, groupIndex, hookIndex }, tokenFlags)
        increment(handlerClasses, result.classification)
        if (result.runtimeRunnable) {
          eventHandlers.runtimeRunnable += 1
          totals.runtimeRunnable += 1
          runnableInGroup += 1
        }
        if (result.accepted) {
          eventHandlers.runnable += 1
          totals.runnable += 1
        } else if (result.classification.startsWith('skipped-')) {
          eventHandlers.skipped += 1
          totals.skipped += 1
        } else {
          eventHandlers.invalid += 1
          totals.invalid += 1
        }
      }
      const matcher = matcherClass(event, group, dialect, issues, groupLocation, runnableInGroup)
      increment(matcherClasses, matcher.classification)
      invalidRunnableRegex ||= matcher.invalidRunnableRegex
    }
    events.push({
      event: name,
      support: 'mapped-partial',
      matcherSubject: event.matcherSubject,
      effects: event.effects,
      groups: rawGroups.length,
      handlers: eventHandlers,
      handlerClasses: summarizeClasses(handlerClasses),
      matcherClasses: summarizeClasses(matcherClasses),
      limitations: event.limitations,
    })
  }
  totals.effectiveRunnable = invalidRunnableRegex ? 0 : totals.runtimeRunnable
  return {
    shape: config.shape,
    registration: invalidRunnableRegex ? 'none-invalid-matcher' : 'classified',
    nodes: config.nodes,
    events,
    totals,
    tokenFlags,
    issues,
  }
}

function check(id, status, blocking, message, evidence) {
  return { id, status, blocking, message, ...(evidence === undefined ? {} : { evidence }) }
}

function safeFailureCode(error, fallback) {
  if (error instanceof DshDeveloperError && /^[A-Z0-9_]+$/u.test(error.code)) return error.code
  return fallback
}

function seal(report) {
  report.ok = report.checks.every((value) => !value.blocking || value.status === 'PASS')
    && (report.config?.issues ?? []).every((value) => value.blocking !== true)
  const canonical = {
    kind: report.kind,
    schemaVersion: report.schemaVersion,
    ok: report.ok,
    scope: report.scope,
    dialect: report.dialect,
    source: report.source,
    lane: report.lane,
    config: report.config,
    checks: report.checks.map(({ id, status, blocking, evidence }) => ({ id, status, blocking, ...(evidence === undefined ? {} : { evidence }) })),
    nonClaims: report.nonClaims,
  }
  report.evidenceDigest = digest(JSON.stringify(canonical))
  return report
}

function baseReport(dialect) {
  return {
    kind: 'doctor-hook-bridge',
    schemaVersion: 1,
    ok: false,
    scope: 'static-package-config-compatibility',
    dialect,
    source: { status: 'not-read' },
    lane: {
      status: 'unreviewed',
      bridge: { name: BRIDGE_NAMES[dialect], availability: 'unclassified' },
      protocol: { availability: 'unclassified' },
      activation: 'not-inspected',
    },
    config: { status: 'not-inspected', issues: [] },
    checks: [],
    nonClaims: ['bridge-activation', 'command-behavior', 'hook-output-behavior', 'full-reference-product-parity'],
  }
}

export async function inspectHookBridgeInternal(source, options, dependencies = {}) {
  const report = baseReport(options.dialect)
  let sourcePath
  try {
    sourcePath = await authorizeSourcePath(source, options.sourceRoot, options.signal)
  } catch (error) {
    if (error instanceof DshDeveloperError && error.code === 'CANCELLED') throw error
    const code = safeFailureCode(error, 'HOOK_SOURCE_UNSAFE')
    report.config.issues.push({ code, blocking: true })
    report.checks.push(check('source.authority', 'FAIL', true, 'The hook configuration path is outside the admitted static-read boundary.', { code }))
    return seal(report)
  }

  let lane
  try {
    lane = await inspectLane(options.dshPath, options.dialect, options.signal, dependencies)
    report.lane = lane
    report.checks.push(check('lane.identity', 'PASS', true, 'The selected DSH manifest and CLI entry exactly match a reviewed static lane.', {
      lane: lane.id,
      version: lane.dshVersion,
      manifestDigest: lane.dsh.manifestDigest,
      entryDigest: lane.dsh.entryDigest,
    }))
  } catch (error) {
    if (error instanceof DshDeveloperError && error.code === 'CANCELLED') throw error
    const code = safeFailureCode(error, 'HOOK_LANE_UNREVIEWED')
    report.config.issues.push({ code, blocking: true })
    report.checks.push(check('lane.identity', 'FAIL', true, 'The selected DSH or Hook Bridge bytes are absent, incomplete, or unreviewed.', { code }))
    report.checks.push(check('bridge.activation', 'SKIP', false, 'Bridge activation is never inspected by this static Doctor.', { activation: 'not-inspected' }))
    return seal(report)
  }

  if (lane.status === 'reviewed-absent') {
    report.config.issues.push({ code: 'HOOK_BRIDGE_NOT_SHIPPED', blocking: true })
    report.checks.push(check('bridge.availability', 'FAIL', true, 'This reviewed release does not ship either Hook Bridge; no configuration was read.', {
      availability: lane.bridge.availability,
      bridge: lane.bridge.name,
    }))
    report.checks.push(check('bridge.activation', 'SKIP', false, 'Bridge activation is never inspected by this static Doctor.', { activation: 'not-inspected' }))
    return seal(report)
  }

  report.checks.push(check('bridge.bytes', 'PASS', true, 'The selected bridge and its resolved shared protocol exactly match reviewed partial-support bytes.', {
    bridge: lane.bridge.name,
    bridgeVersion: lane.bridge.version,
    bridgeManifestDigest: lane.bridge.manifestDigest,
    bridgeEntryDigest: lane.bridge.entryDigest,
    bridgeInvariantDigest: lane.bridge.invariantDigest,
    protocolVersion: lane.protocol.version,
    protocolManifestDigest: lane.protocol.manifestDigest,
    protocolEntryDigest: lane.protocol.entryDigest,
    protocolInvariantDigest: lane.protocol.invariantDigest,
  }))
  report.checks.push(check('bridge.activation', 'SKIP', false, 'Package presence is not activation evidence; profile composition is not inspected.', { activation: 'not-inspected' }))

  let snapshot
  let parsed
  try {
    snapshot = await readConfigSource(sourcePath, options.sourceRoot, options.signal)
    parsed = readJsonConfig(snapshot, options.signal)
    report.source = { status: 'read-stable', bytes: snapshot.bytes, fingerprint: snapshot.fingerprint }
    report.checks.push(check('source.snapshot', 'PASS', true, 'The configuration was read once as a stable, ordinary, secret-free UTF-8 file.', {
      bytes: snapshot.bytes,
      fingerprint: snapshot.fingerprint,
    }))
  } catch (error) {
    if (error instanceof DshDeveloperError && error.code === 'CANCELLED') throw error
    const code = safeFailureCode(error, 'HOOK_SOURCE_UNSAFE')
    report.source = { status: code === 'HOOK_SOURCE_SECRET' ? 'redacted' : 'not-read' }
    report.config.issues.push({ code, blocking: true })
    report.checks.push(check('source.snapshot', 'FAIL', true, 'The configuration could not be admitted as stable, bounded, secret-free strict JSON.', { code }))
    return seal(report)
  }

  try {
    report.config = { status: 'inspected', ...classifyConfig(parsed, options.dialect, options.signal) }
    const blocking = report.config.issues.length > 0
    report.checks.push(check('config.compatibility', blocking ? 'FAIL' : 'PASS', true,
      blocking
        ? 'The config contains unsupported, ignored, malformed, ambiguous, or runtime-dependent hook intent.'
        : 'Every configured handler belongs to the exact reviewed synchronous command subset.', {
        registration: report.config.registration,
        totals: report.config.totals,
      }))
  } catch (error) {
    if (error instanceof DshDeveloperError && error.code === 'CANCELLED') throw error
    const code = safeFailureCode(error, 'HOOK_CONFIG_INCOMPLETE')
    report.config = { status: 'incomplete', issues: [{ code, blocking: true }] }
    report.checks.push(check('config.compatibility', 'FAIL', true, 'Configuration traversal exceeded a strict bound or became incomplete.', { code }))
  }
  return seal(report)
}
