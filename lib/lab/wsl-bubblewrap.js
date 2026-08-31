import { randomBytes } from 'node:crypto'
import { arch, hostname, release } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { LIMITS } from '../constants.js'
import { asDiagnostic, DshDeveloperError } from '../errors.js'
import { runBounded, secretFreeEnvironment } from '../runtime.js'

export const WSL_BUBBLEWRAP_PROVIDER_ID = 'wsl2-bubblewrap'

const CELL_ID_PATTERN = /^[a-f0-9]{32}$/u
const DISTRO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/u
const ROOT_PATTERN = /^\/tmp\/dsh-developer-lab-[a-f0-9]{32}$/u
const CREDENTIAL_CANARY_PATTERN = /^\/var\/tmp\/dsh-developer-credential-canary-[a-f0-9]{32}$/u
const CONTROLLER_LEASE_NAME = 'controller.lease'
const CRASH_READY_NAME = 'controller-crash-ready'
const STALE_LEASE_SECONDS = 6
const CRASH_HELPER = fileURLToPath(new URL('./crash-controller.js', import.meta.url))
const SUPERVISOR = [
  'set -eu',
  'lease=$1',
  'shift',
  '"$@" </dev/null &',
  'cell=$!',
  'terminate() { kill -KILL "$cell" 2>/dev/null || true; wait "$cell" 2>/dev/null || true; }',
  "trap 'terminate' HUP INT TERM EXIT",
  '(last=""; misses=0; while kill -0 "$cell" 2>/dev/null; do current=$(/usr/bin/stat -c %y "$lease" 2>/dev/null || echo missing); if [ "$current" = "$last" ]; then misses=$((misses + 1)); else last=$current; misses=0; fi; if [ "$misses" -ge 4 ]; then kill -KILL "$cell" 2>/dev/null || true; exit 0; fi; /usr/bin/sleep 1; done) &',
  'watchdog=$!',
  'set +e',
  'wait "$cell"',
  'status=$?',
  'set -e',
  'kill "$watchdog" 2>/dev/null || true',
  'wait "$watchdog" 2>/dev/null || true',
  'trap - HUP INT TERM EXIT',
  'exit "$status"',
].join('\n')

const RESOURCE_LIMITS = Object.freeze({
  memoryBytes: 1024 * 1024 * 1024,
  swapBytes: 0,
  tasks: 64,
  cpuQuota: '100%',
  cpuSeconds: 45,
  fileBytes: 64 * 1024 * 1024,
  openFiles: 256,
})

function check(id, status, message, evidence) {
  return {
    id,
    status,
    blocking: true,
    message,
    ...(evidence === undefined ? {} : { evidence }),
  }
}

function normalizeDistro(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !DISTRO_PATTERN.test(value)) {
    throw new DshDeveloperError(
      'LAB_DISTRO_INVALID',
      'The WSL distribution name must be 1-64 portable characters without control characters.',
    )
  }
  return value
}

function parsePositiveInteger(value, label) {
  if (!/^\d+$/u.test(value)) {
    throw new DshDeveloperError('LAB_PROVIDER_INVALID', label + ' did not return an integer.', { value })
  }
  return Number(value)
}

function parsePasswd(value, uid) {
  const fields = value.trim().split(':')
  if (fields.length !== 7 || fields[2] !== String(uid)) {
    throw new DshDeveloperError('LAB_PROVIDER_INVALID', 'The WSL user identity could not be resolved safely.')
  }
  const home = fields[5]
  if (!/^\/home\/[A-Za-z0-9._-]+$/u.test(home)) {
    throw new DshDeveloperError(
      'LAB_HOME_UNSUPPORTED',
      'The strict WSL provider requires a non-root default user whose home is directly under /home.',
      { home },
    )
  }
  return { name: fields[0], uid, gid: parsePositiveInteger(fields[3], 'WSL gid'), home, shell: fields[6] }
}

export function parseWindowsMounts(stdout) {
  if (stdout.trim().length === 0) return []
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new DshDeveloperError('LAB_MOUNT_INVENTORY_INVALID', 'WSL returned invalid mount inventory JSON: ' + error.message)
  }
  const filesystems = parsed?.filesystems
  if (!Array.isArray(filesystems)) {
    throw new DshDeveloperError('LAB_MOUNT_INVENTORY_INVALID', 'WSL mount inventory lacks a filesystems array.')
  }
  return filesystems.map((value) => {
    const target = value?.target
    const fstype = value?.fstype
    if (typeof target !== 'string' || !target.startsWith('/') || !['9p', 'drvfs'].includes(fstype)) {
      throw new DshDeveloperError('LAB_MOUNT_INVENTORY_INVALID', 'WSL returned an unsupported Windows mount row.', { value })
    }
    if (!(target === '/mnt'
      || target.startsWith('/mnt/')
      || target === '/usr/lib/wsl'
      || target.startsWith('/usr/lib/wsl/'))) {
      throw new DshDeveloperError(
        'LAB_WINDOWS_MOUNT_UNMASKED',
        'A Windows-backed WSL mount exists outside the strict provider mask.',
        { target, fstype },
      )
    }
    return { target, fstype, source: typeof value.source === 'string' ? value.source : undefined }
  })
}

function validateCellInput(workspace, cellId, command) {
  if (!ROOT_PATTERN.test(workspace.replace(/\/workspace$/u, '')) || !workspace.endsWith('/workspace')) {
    throw new DshDeveloperError('LAB_WORKSPACE_INVALID', 'The lab workspace must be owned by a validated private WSL lab root.')
  }
  if (!CELL_ID_PATTERN.test(cellId)) throw new DshDeveloperError('LAB_CELL_ID_INVALID', 'The lab cell identifier is invalid.')
  if (!Array.isArray(command)
      || command.length === 0
      || typeof command[0] !== 'string'
      || !command[0].startsWith('/')
      || command.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw new DshDeveloperError('LAB_COMMAND_INVALID', 'A lab command must be a non-empty absolute argv without NUL characters.')
  }
}

export function buildBubblewrapArgv({ workspace, cellId, command }) {
  validateCellInput(workspace, cellId, command)
  return [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--die-with-parent',
    '--new-session',
    '--hostname', 'dsh-developer-cell',
    '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--proc', '/proc',
    '--dev', '/dev',
    '--ro-bind', '/dev/null', '/init',
    '--tmpfs', '/opt',
    '--dir', '/opt/workspace',
    '--bind', workspace, '/opt/workspace',
    '--tmpfs', '/tmp',
    '--dir', '/tmp/home',
    '--tmpfs', '/home',
    '--tmpfs', '/root',
    '--tmpfs', '/mnt',
    '--tmpfs', '/run',
    '--tmpfs', '/sys',
    '--tmpfs', '/usr/local',
    '--tmpfs', '/usr/lib/wsl',
    '--clearenv',
    '--setenv', 'PATH', '/usr/bin:/bin',
    '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'HOME', '/tmp/home',
    '--setenv', 'DSH_DEVELOPER_CELL_ID', cellId,
    '--chdir', '/opt/workspace',
    '--',
    '/usr/bin/prlimit',
    '--cpu=' + RESOURCE_LIMITS.cpuSeconds,
    '--fsize=' + RESOURCE_LIMITS.fileBytes,
    '--nofile=' + RESOURCE_LIMITS.openFiles,
    '--core=0',
    '--',
    ...command,
  ]
}

function unitBase(cellId) {
  return 'dsh-developer-' + cellId
}

function unitName(cellId) {
  return unitBase(cellId) + '.scope'
}

function buildScopedCommand(workspace, cellId, lease, command) {
  const bwrap = buildBubblewrapArgv({ workspace, cellId, command })
  return [
    '/usr/bin/systemd-run',
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    '--unit=' + unitBase(cellId),
    '-p', 'MemoryMax=' + RESOURCE_LIMITS.memoryBytes,
    '-p', 'MemorySwapMax=' + RESOURCE_LIMITS.swapBytes,
    '-p', 'TasksMax=' + RESOURCE_LIMITS.tasks,
    '-p', 'CPUQuota=' + RESOURCE_LIMITS.cpuQuota,
    '/bin/sh',
    '-c',
    SUPERVISOR,
    'dsh-developer-supervisor',
    lease,
    '/usr/bin/bwrap',
    ...bwrap,
  ]
}

function wslExecutable() {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
  return join(systemRoot, 'System32', 'wsl.exe')
}

function createRunner(options) {
  const execute = options.runBounded ?? runBounded
  const executable = options.wslPath ?? wslExecutable()
  return async function runWsl(distro, argv, runOptions = {}) {
    return execute(executable, [
      ...(distro ? ['-d', distro] : []),
      '--exec',
      ...argv,
    ], {
      label: runOptions.label ?? 'WSL execution lab probe',
      signal: runOptions.inheritSignal === false ? undefined : runOptions.signal ?? options.signal,
      acceptedExitCodes: runOptions.acceptedExitCodes,
      timeoutMs: runOptions.timeoutMs ?? LIMITS.commandTimeoutMs,
      outputLimit: runOptions.outputLimit ?? LIMITS.commandOutputBytes,
      diagnosticOutput: true,
      env: secretFreeEnvironment(runOptions.hostEnvironment),
    })
  }
}

async function discoverProvider(options, runWsl) {
  if ((options.platform ?? process.platform) !== 'win32') {
    throw new DshDeveloperError('LAB_PROVIDER_UNAVAILABLE', 'The WSL2 Bubblewrap provider is available only from a Windows host.')
  }
  const requestedDistro = normalizeDistro(options.distro)
  const distroResult = await runWsl(requestedDistro, ['/usr/bin/printenv', 'WSL_DISTRO_NAME'], {
    label: 'WSL distribution identity probe',
  })
  const distro = normalizeDistro(distroResult.stdout.trim())
  if (requestedDistro && requestedDistro.toLocaleLowerCase('en-US') !== distro.toLocaleLowerCase('en-US')) {
    throw new DshDeveloperError('LAB_DISTRO_MISMATCH', 'WSL opened a different distribution than requested.', {
      requested: requestedDistro,
      actual: distro,
    })
  }
  const [uidResult, kernelResult, bwrapResult, prlimitResult, systemdResult, mountResult] = await Promise.all([
    runWsl(distro, ['/usr/bin/id', '-u'], { label: 'WSL user identity probe' }),
    runWsl(distro, ['/usr/bin/uname', '-r'], { label: 'WSL kernel probe' }),
    runWsl(distro, ['/usr/bin/bwrap', '--version'], { label: 'Bubblewrap version probe' }),
    runWsl(distro, ['/usr/bin/prlimit', '--version'], { label: 'prlimit version probe' }),
    runWsl(distro, ['/usr/bin/systemctl', 'is-system-running'], {
      label: 'WSL systemd probe',
      acceptedExitCodes: [0, 1],
    }),
    runWsl(distro, [
      '/usr/bin/findmnt',
      '--json',
      '--types', '9p,drvfs',
      '--output', 'TARGET,FSTYPE,SOURCE',
    ], {
      label: 'WSL Windows-mount inventory',
      acceptedExitCodes: [0, 1],
    }),
  ])
  const uid = parsePositiveInteger(uidResult.stdout.trim(), 'WSL uid')
  if (uid === 0) throw new DshDeveloperError('LAB_ROOT_USER_FORBIDDEN', 'The strict execution lab never runs under the WSL root user.')
  const passwdResult = await runWsl(distro, ['/usr/bin/getent', 'passwd', String(uid)], {
    label: 'WSL passwd identity probe',
  })
  const user = parsePasswd(passwdResult.stdout, uid)
  const kernel = kernelResult.stdout.trim()
  if (!/microsoft-standard-WSL2/iu.test(kernel)) {
    throw new DshDeveloperError('LAB_WSL2_REQUIRED', 'The selected distribution is not running on a recognized WSL2 kernel.', { kernel })
  }
  const bwrapVersion = bwrapResult.stdout.trim()
  if (!/^bubblewrap \d+\.\d+\.\d+$/u.test(bwrapVersion)) {
    throw new DshDeveloperError('LAB_BWRAP_INVALID', 'Bubblewrap returned an unrecognized version string.', { bwrapVersion })
  }
  const systemdState = systemdResult.stdout.trim()
  if (!['running', 'degraded'].includes(systemdState)) {
    throw new DshDeveloperError('LAB_RESOURCE_PROVIDER_UNAVAILABLE', 'The WSL systemd user-scope provider is not running.', {
      systemdState,
    })
  }
  const windowsMounts = parseWindowsMounts(mountResult.stdout)
    .sort((left, right) => left.target.localeCompare(right.target, 'en'))
  return {
    id: WSL_BUBBLEWRAP_PROVIDER_ID,
    distro,
    kernel,
    bwrapVersion,
    prlimitVersion: prlimitResult.stdout.trim().split(/\r?\n/u)[0],
    systemdState,
    user,
    windowsMounts,
    host: {
      platform: options.platform ?? process.platform,
      release: options.hostRelease ?? release(),
      arch: options.hostArch ?? arch(),
      hostname: options.hostName ?? hostname(),
    },
  }
}

function parsePids(stdout) {
  return stdout.split(/\r?\n/u).filter(Boolean).map((value) => {
    if (!/^\d+$/u.test(value)) throw new DshDeveloperError('LAB_PROCESS_EVIDENCE_INVALID', 'WSL returned a non-numeric process identifier.')
    return Number(value)
  })
}

async function findMarkerPids(runWsl, distro, cellId, runOptions = {}) {
  const result = await runWsl(distro, ['/usr/bin/pgrep', '-f', '--', cellId], {
    ...runOptions,
    label: 'execution-cell process scan',
    acceptedExitCodes: [0, 1],
    timeoutMs: 5_000,
  })
  return result.exitCode === 1 ? [] : parsePids(result.stdout)
}

async function waitForMarker(runWsl, distro, cellId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const pids = await findMarkerPids(runWsl, distro, cellId)
    if (pids.length > 0) return pids
    await delay(100)
  }
  throw new DshDeveloperError('LAB_CELL_START_UNPROVED', 'The execution cell did not expose its unique process marker before the probe deadline.')
}

async function reapCell(runWsl, distro, cellId) {
  const found = await findMarkerPids(runWsl, distro, cellId, { inheritSignal: false })
  if (found.length > 0) {
    await runWsl(distro, ['/usr/bin/kill', '-KILL', '--', ...found.map(String)], {
      label: 'execution-cell orphan cleanup',
      acceptedExitCodes: [0, 1],
      timeoutMs: 5_000,
      inheritSignal: false,
    })
  }
  const unit = unitName(cellId)
  await runWsl(distro, ['/usr/bin/systemctl', '--user', 'stop', unit], {
    label: 'execution-cell resource-scope cleanup',
    acceptedExitCodes: [0, 1, 3, 4, 5],
    timeoutMs: 5_000,
    inheritSignal: false,
  })
  let remaining = []
  for (let attempt = 0; attempt < 20; attempt += 1) {
    remaining = await findMarkerPids(runWsl, distro, cellId, { inheritSignal: false })
    if (remaining.length === 0) break
    await delay(100)
  }
  return { found, killed: found.length, remaining, unit }
}

function rootIdFromPath(root) {
  if (!ROOT_PATTERN.test(root)) throw new DshDeveloperError('LAB_ROOT_INVALID', 'The WSL lab root name is invalid.', { root })
  return root.slice('/tmp/dsh-developer-lab-'.length)
}

function credentialCanaryForRoot(root) {
  return '/var/tmp/dsh-developer-credential-canary-' + rootIdFromPath(root)
}

async function pathMetadata(runWsl, distro, path) {
  const result = await runWsl(distro, ['/usr/bin/stat', '-c', '%f|%u|%a|%Y', path], {
    label: 'lab recovery metadata probe',
    acceptedExitCodes: [0, 1],
    timeoutMs: 5_000,
    inheritSignal: false,
  })
  if (result.exitCode === 1) return undefined
  const fields = result.stdout.trim().split('|')
  if (fields.length !== 4 || !/^[a-f0-9]+$/iu.test(fields[0])) {
    throw new DshDeveloperError('LAB_RECOVERY_METADATA_INVALID', 'WSL returned invalid recovery metadata.', { path })
  }
  return {
    type: Number.parseInt(fields[0], 16) & 0xf000,
    uid: parsePositiveInteger(fields[1], 'recovery path uid'),
    mode: fields[2],
    modifiedSeconds: parsePositiveInteger(fields[3], 'recovery path modification time'),
  }
}

async function removeLabArtifacts(runWsl, distro, root, credentialCanary = credentialCanaryForRoot(root)) {
  rootIdFromPath(root)
  if (!CREDENTIAL_CANARY_PATTERN.test(credentialCanary)) {
    throw new DshDeveloperError('LAB_CANARY_INVALID', 'Refusing to clean an unvalidated WSL credential canary.')
  }
  await runWsl(distro, ['/usr/bin/rm', '-rf', '--', root], {
    label: 'lab workspace cleanup',
    inheritSignal: false,
  })
  await runWsl(distro, ['/usr/bin/rm', '-f', '--', credentialCanary], {
    label: 'lab credential-canary cleanup',
    inheritSignal: false,
  })
  for (const path of [root, credentialCanary]) {
    const removed = await runWsl(distro, ['/usr/bin/test', '!', '-e', path], {
      label: 'lab artifact cleanup verification',
      acceptedExitCodes: [0, 1],
      inheritSignal: false,
    })
    if (removed.exitCode !== 0) {
      throw new DshDeveloperError('LAB_CLEANUP_FAILED', 'A private WSL lab artifact remains after cleanup.', { path })
    }
  }
}

function startControllerHeartbeat(runWsl, distro, root) {
  rootIdFromPath(root)
  const lease = root + '/' + CONTROLLER_LEASE_NAME
  let active = true
  let pulse
  let pulseError
  const timer = setInterval(() => {
    if (!active || pulse !== undefined) return
    pulse = runWsl(distro, ['/usr/bin/touch', lease], {
      label: 'lab controller heartbeat',
      timeoutMs: 3_000,
      inheritSignal: false,
    }).catch((error) => {
      pulseError = error
      active = false
    }).finally(() => {
      pulse = undefined
    })
  }, 500)
  return {
    async stop() {
      active = false
      clearInterval(timer)
      if (pulse !== undefined) await pulse
      if (pulseError) {
        throw new DshDeveloperError('LAB_CONTROLLER_HEARTBEAT_FAILED', 'The lab controller heartbeat failed.', {
          heartbeat: asDiagnostic(pulseError),
        })
      }
    },
  }
}

async function listLabRoots(runWsl, distro) {
  const result = await runWsl(distro, [
    '/usr/bin/find', '/tmp', '-mindepth', '1', '-maxdepth', '1', '-type', 'd',
    '-name', 'dsh-developer-lab-*', '-printf', '%p\n',
  ], {
    label: 'stale lab-root inventory',
    timeoutMs: 5_000,
    inheritSignal: false,
  })
  return result.stdout.split(/\r?\n/u).filter(Boolean).map((root) => {
    rootIdFromPath(root)
    return root
  })
}

async function listCellLeases(runWsl, distro, root) {
  rootIdFromPath(root)
  const result = await runWsl(distro, [
    '/usr/bin/find', root, '-mindepth', '1', '-maxdepth', '1', '-name', 'lease-*', '-printf', '%f|%y\n',
  ], {
    label: 'stale execution-cell lease inventory',
    acceptedExitCodes: [0, 1],
    timeoutMs: 5_000,
    inheritSignal: false,
  })
  if (result.exitCode === 1) {
    if (!await pathMetadata(runWsl, distro, root)) return undefined
    throw new DshDeveloperError('LAB_RECOVERY_LEASE_INVENTORY_FAILED', 'A stale lab root could not be inventoried safely.', { root })
  }
  return result.stdout.split(/\r?\n/u).filter(Boolean).map((row) => {
    const match = /^lease-([a-f0-9]{32})\|f$/u.exec(row)
    if (!match) throw new DshDeveloperError('LAB_RECOVERY_LEASE_INVALID', 'A stale lab root contains an invalid cell lease.', { row })
    return match[1]
  })
}

async function recoverStaleLabRoots(runWsl, provider) {
  const roots = await listLabRoots(runWsl, provider.distro)
  const nowResult = await runWsl(provider.distro, ['/usr/bin/date', '+%s'], {
    label: 'lab recovery clock probe',
    timeoutMs: 5_000,
    inheritSignal: false,
  })
  const now = parsePositiveInteger(nowResult.stdout.trim(), 'WSL recovery clock')
  const recovered = []
  for (const root of roots) {
    const rootMetadata = await pathMetadata(runWsl, provider.distro, root)
    if (!rootMetadata) continue
    if (rootMetadata.type !== 0x4000 || rootMetadata.uid !== provider.user.uid || rootMetadata.mode !== '700') {
      throw new DshDeveloperError('LAB_RECOVERY_ROOT_UNSAFE', 'A lab-like WSL root is not a private directory owned by the provider user.', {
        root,
        metadata: rootMetadata,
      })
    }
    const leasePath = root + '/' + CONTROLLER_LEASE_NAME
    const leaseMetadata = await pathMetadata(runWsl, provider.distro, leasePath)
    if (leaseMetadata && (leaseMetadata.type !== 0x8000 || leaseMetadata.uid !== provider.user.uid)) {
      throw new DshDeveloperError('LAB_RECOVERY_LEASE_UNSAFE', 'A lab controller lease is not an ordinary provider-owned file.', {
        root,
        metadata: leaseMetadata,
      })
    }
    const anchor = leaseMetadata ?? rootMetadata
    if (now - anchor.modifiedSeconds < STALE_LEASE_SECONDS) continue
    await delay(1_200)
    const secondLease = await pathMetadata(runWsl, provider.distro, leasePath)
    const secondRoot = await pathMetadata(runWsl, provider.distro, root)
    if (!secondRoot) continue
    const secondAnchor = secondLease ?? secondRoot
    if (Boolean(secondLease) !== Boolean(leaseMetadata)
        || secondAnchor.modifiedSeconds !== anchor.modifiedSeconds) continue
    const cellLeases = await listCellLeases(runWsl, provider.distro, root)
    if (!cellLeases) continue
    for (const cellId of cellLeases) {
      const cleanup = await reapCell(runWsl, provider.distro, cellId)
      if (cleanup.remaining.length > 0) {
        throw new DshDeveloperError('LAB_ORPHAN_REMAINS', 'Stale-root recovery could not remove an execution-cell process.', {
          root,
          cleanup,
        })
      }
    }
    await removeLabArtifacts(runWsl, provider.distro, root)
    recovered.push(root)
  }
  return { recovered }
}

async function runCell(runWsl, provider, workspace, command, options = {}) {
  const cellId = options.cellId ?? randomBytes(16).toString('hex')
  const root = workspace.slice(0, -'/workspace'.length)
  if (!ROOT_PATTERN.test(root)) throw new DshDeveloperError('LAB_ROOT_INVALID', 'The execution-cell lease root is invalid.', { root })
  const lease = root + '/lease-' + cellId
  const scoped = buildScopedCommand(workspace, cellId, lease, command)
  await runWsl(provider.distro, ['/usr/bin/touch', lease], { label: 'execution-cell lease creation' })
  let pulseError
  let pulse
  let heartbeatActive = true
  const heartbeat = setInterval(() => {
    if (!heartbeatActive || pulse !== undefined) return
    pulse = runWsl(provider.distro, ['/usr/bin/touch', lease], {
      label: 'execution-cell lease heartbeat',
      timeoutMs: 3_000,
    }).catch((error) => {
      pulseError = error
      heartbeatActive = false
    }).finally(() => {
      pulse = undefined
    })
  }, 500)
  function stopHeartbeat() {
    heartbeatActive = false
    clearInterval(heartbeat)
  }
  if (options.closeLeaseSignal?.aborted) stopHeartbeat()
  else options.closeLeaseSignal?.addEventListener('abort', stopHeartbeat, { once: true })
  let result
  let commandError
  try {
    result = await runWsl(provider.distro, scoped, {
      label: options.label ?? 'isolated execution-cell fixture',
      signal: options.signal,
      acceptedExitCodes: options.acceptedExitCodes,
      timeoutMs: options.timeoutMs,
      hostEnvironment: { DSH_DEVELOPER_HOST_CANARY: cellId },
    })
  } catch (error) {
    commandError = error
  }
  stopHeartbeat()
  options.closeLeaseSignal?.removeEventListener('abort', stopHeartbeat)
  if (pulse !== undefined) await pulse
  const cleanup = await reapCell(runWsl, provider.distro, cellId)
  await runWsl(provider.distro, ['/usr/bin/rm', '-f', '--', lease], {
    label: 'execution-cell lease cleanup',
    acceptedExitCodes: [0, 1],
    inheritSignal: false,
  })
  if (cleanup.remaining.length > 0) {
    throw new DshDeveloperError('LAB_ORPHAN_REMAINS', 'The execution cell left processes after forced cleanup.', {
      cellId,
      cleanup,
      command: commandError ? asDiagnostic(commandError) : undefined,
    })
  }
  if (commandError) {
    if (commandError instanceof DshDeveloperError) {
      commandError.details = { ...commandError.details, cellId, cleanup }
    }
    throw commandError
  }
  if (pulseError) {
    throw new DshDeveloperError('LAB_HEARTBEAT_FAILED', 'The execution-cell controller heartbeat failed.', {
      cellId,
      cleanup,
      heartbeat: asDiagnostic(pulseError),
    })
  }
  return { ...result, cellId, cleanup }
}

export async function runControllerCrashFixture({ distro, rootId, cellId }) {
  const normalizedDistro = normalizeDistro(distro)
  if (!CELL_ID_PATTERN.test(rootId) || !CELL_ID_PATTERN.test(cellId)) {
    throw new DshDeveloperError('LAB_CRASH_FIXTURE_INVALID', 'The controller-crash fixture identifiers are invalid.')
  }
  const runWsl = createRunner({})
  const root = '/tmp/dsh-developer-lab-' + rootId
  const workspace = root + '/workspace'
  await runWsl(normalizedDistro, ['/usr/bin/mkdir', '-m', '700', root], { label: 'crash-fixture root creation' })
  await runWsl(normalizedDistro, ['/usr/bin/mkdir', '-m', '700', workspace], { label: 'crash-fixture workspace creation' })
  await runWsl(normalizedDistro, ['/usr/bin/touch', root + '/' + CONTROLLER_LEASE_NAME], {
    label: 'crash-fixture controller lease creation',
  })
  const heartbeat = startControllerHeartbeat(runWsl, normalizedDistro, root)
  const cellController = new AbortController()
  let settled
  try {
    const running = runCell(runWsl, { distro: normalizedDistro }, workspace, ['/usr/bin/sleep', '60'], {
      cellId,
      acceptedExitCodes: [137],
      timeoutMs: 70_000,
      signal: cellController.signal,
    }).then((value) => ({ value }), (error) => ({ error }))
    await waitForMarker(runWsl, normalizedDistro, cellId)
    await runWsl(normalizedDistro, ['/usr/bin/touch', root + '/' + CRASH_READY_NAME], {
      label: 'controller-crash readiness witness',
    })
    settled = await running
    if (settled.error) throw settled.error
    throw new DshDeveloperError('LAB_CRASH_FIXTURE_SETTLED', 'The controller-crash fixture settled before its controller was terminated.')
  } finally {
    cellController.abort()
    await heartbeat.stop()
  }
}

function parseProperties(stdout) {
  const values = {}
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
    const index = line.indexOf('=')
    if (index <= 0) throw new DshDeveloperError('LAB_RESOURCE_EVIDENCE_INVALID', 'systemd returned an invalid property row.', { line })
    values[line.slice(0, index)] = line.slice(index + 1)
  }
  return values
}

function assertResourceProperties(values) {
  const expected = {
    MemoryMax: String(RESOURCE_LIMITS.memoryBytes),
    MemorySwapMax: String(RESOURCE_LIMITS.swapBytes),
    TasksMax: String(RESOURCE_LIMITS.tasks),
    CPUQuotaPerSecUSec: '1s',
  }
  for (const [key, value] of Object.entries(expected)) {
    if (values[key] !== value) {
      throw new DshDeveloperError('LAB_RESOURCE_LIMIT_MISMATCH', 'The execution-cell resource scope did not apply its fixed limit.', {
        property: key,
        expected: value,
        actual: values[key],
      })
    }
  }
  return expected
}

class StopConformance extends Error {}

export async function conformWslBubblewrap(options = {}) {
  const runWsl = createRunner(options)
  const checks = []
  let provider = { id: WSL_BUBBLEWRAP_PROVIDER_ID }
  let root
  let credentialCanary
  let controllerHeartbeat
  let stopped = false

  async function verify(id, message, action) {
    if (stopped) return undefined
    try {
      const evidence = await action()
      checks.push(check(id, 'PASS', message, evidence))
      return evidence
    } catch (error) {
      checks.push(check(id, 'FAIL', `The ${id} conformance check failed.`, asDiagnostic(error)))
      stopped = true
      throw new StopConformance()
    }
  }

  try {
    provider = await verify(
      'lab.provider',
      'The selected non-root WSL2 host exposes Bubblewrap, systemd resource units, prlimit, and only maskable Windows mounts.',
      async () => {
        const discovered = await discoverProvider(options, runWsl)
        await recoverStaleLabRoots(runWsl, discovered)
        return discovered
      },
    )
    const rootId = randomBytes(16).toString('hex')
    root = '/tmp/dsh-developer-lab-' + rootId
    const workspace = root + '/workspace'
    const privateCanary = root + '/private-canary'
    credentialCanary = '/var/tmp/dsh-developer-credential-canary-' + rootId
    await verify('lab.workspace.create', 'The provider created one private disposable WSL workspace.', async () => {
      await runWsl(provider.distro, ['/usr/bin/mkdir', '-m', '700', root], { label: 'lab root creation' })
      await runWsl(provider.distro, ['/usr/bin/mkdir', '-m', '700', workspace], { label: 'lab workspace creation' })
      await runWsl(provider.distro, ['/usr/bin/touch', privateCanary], { label: 'lab private-read canary creation' })
      await runWsl(provider.distro, ['/usr/bin/touch', credentialCanary], { label: 'lab credential-read canary creation' })
      await runWsl(provider.distro, ['/usr/bin/touch', root + '/' + CONTROLLER_LEASE_NAME], {
        label: 'lab controller lease creation',
      })
      controllerHeartbeat = startControllerHeartbeat(runWsl, provider.distro, root)
      return { location: 'private WSL /tmp root', mode: '0700', workspace: 'private child directory' }
    })
    await verify('lab.filesystem.workspace-write', 'The cell can write only through its private workspace bind.', async () => {
      await runCell(runWsl, provider, workspace, ['/usr/bin/touch', '/opt/workspace/write-witness'])
      await runWsl(provider.distro, ['/usr/bin/test', '-f', workspace + '/write-witness'], {
        label: 'workspace write witness check',
      })
      return { workspace: '/opt/workspace', persisted: true }
    })
    await verify('lab.filesystem.private-read', 'The minimal runtime omits WSL state, credential canaries, homes, Windows mounts, and WSL integration files.', async () => {
      const hidden = [
        privateCanary,
        credentialCanary,
        '/etc',
        '/var',
        provider.user.home,
        ...provider.windowsMounts.map((value) => value.target),
      ]
      for (const path of hidden) {
        await runCell(runWsl, provider, workspace, ['/usr/bin/test', '!', '-e', path])
      }
      await runCell(runWsl, provider, workspace, ['/usr/bin/test', '!', '-x', '/init'])
      const localRuntime = await runCell(runWsl, provider, workspace, [
        '/usr/bin/find', '/usr/local', '-mindepth', '1', '-print', '-quit',
      ])
      if (localRuntime.stdout.trim().length > 0) {
        throw new DshDeveloperError('LAB_LOCAL_RUNTIME_VISIBLE', 'The cell exposes host content below /usr/local.')
      }
      return {
        hidden: [
          'controller canary',
          'credential canary outside masked paths',
          '/etc',
          '/var',
          provider.user.home,
          ...provider.windowsMounts.map((value) => value.target),
        ],
        usrLocal: 'empty overlay',
        interopExecutable: 'masked',
      }
    })
    await verify('lab.filesystem.host-write', 'The imported read-only runtime rejects writes outside the private workspace.', async () => {
      const result = await runCell(
        runWsl,
        provider,
        workspace,
        ['/usr/bin/touch', '/usr/dsh-developer-write-denied'],
        { acceptedExitCodes: [0, 1] },
      )
      if (result.exitCode === 0) throw new DshDeveloperError('LAB_HOST_WRITE_ALLOWED', 'The cell wrote through the imported read-only runtime.')
      return { deniedPath: '/usr/dsh-developer-write-denied', exitCode: result.exitCode }
    })
    await verify('lab.environment', 'The cell receives only the fixed non-credential environment.', async () => {
      const result = await runCell(runWsl, provider, workspace, ['/usr/bin/env'])
      const rows = result.stdout.trim().split(/\r?\n/u).filter(Boolean)
      const keys = rows.map((value) => value.slice(0, value.indexOf('='))).sort()
      const expected = ['DSH_DEVELOPER_CELL_ID', 'HOME', 'LANG', 'PATH', 'PWD'].sort()
      if (JSON.stringify(keys) !== JSON.stringify(expected)) {
        throw new DshDeveloperError('LAB_ENVIRONMENT_LEAK', 'The cell environment differs from the fixed allowlist.', { keys })
      }
      if (rows.some((value) => value.startsWith('DSH_DEVELOPER_HOST_CANARY='))) {
        throw new DshDeveloperError('LAB_ENVIRONMENT_LEAK', 'The host-only environment canary reached the cell.')
      }
      return { keys }
    })
    await verify('lab.network', 'The cell has a private network namespace with no configured IP route.', async () => {
      const result = await runCell(runWsl, provider, workspace, ['/usr/bin/cat', '/proc/net/route'])
      const routes = result.stdout.split(/\r?\n/u).slice(1).filter((value) => value.trim().length > 0)
      if (routes.length > 0) throw new DshDeveloperError('LAB_NETWORK_ROUTE_PRESENT', 'The cell retained an IP route.', { routes })
      return { routes: 0, namespace: 'private' }
    })
    await verify('lab.devices', 'The cell exposes a fresh device filesystem without host block or WSL GPU devices.', async () => {
      const result = await runCell(runWsl, provider, workspace, [
        '/usr/bin/find', '/dev', '-xdev', '-maxdepth', '2', '-type', 'b', '-print',
      ])
      if (result.stdout.trim().length > 0) {
        throw new DshDeveloperError('LAB_BLOCK_DEVICE_VISIBLE', 'The cell exposes a host block device.', { devices: result.stdout.trim() })
      }
      await runCell(runWsl, provider, workspace, ['/usr/bin/test', '!', '-e', '/dev/dxg'])
      return { blockDevices: 0, wslGpu: 'hidden', sysfs: 'masked' }
    })
    await verify('lab.processes', 'The cell sees only its private PID namespace.', async () => {
      const result = await runCell(runWsl, provider, workspace, [
        '/usr/bin/find', '/proc', '-maxdepth', '1', '-type', 'd', '-regextype', 'posix-extended',
        '-regex', '/proc/[0-9]+', '-printf', '%f\n',
      ])
      const pids = parsePids(result.stdout)
      if (pids.length === 0 || pids.length > 4 || !pids.includes(1)) {
        throw new DshDeveloperError('LAB_PID_NAMESPACE_INVALID', 'The cell process view is not a bounded private PID namespace.', { pids })
      }
      return { visiblePids: pids }
    })
    await verify('lab.resources-and-heartbeat', 'The cell runs in a fixed cgroup scope and heartbeat loss terminates it with exit 137 and no orphan.', async () => {
      const cellId = randomBytes(16).toString('hex')
      const lease = new AbortController()
      const running = runCell(runWsl, provider, workspace, ['/usr/bin/sleep', '30'], {
        cellId,
        closeLeaseSignal: lease.signal,
        acceptedExitCodes: [137],
        timeoutMs: 10_000,
      }).then((value) => ({ value }), (error) => ({ error }))
      let properties
      let settled
      try {
        await waitForMarker(runWsl, provider.distro, cellId)
        const propertiesResult = await runWsl(provider.distro, [
          '/usr/bin/systemctl', '--user', 'show', unitName(cellId), '--no-pager',
          '--property=MemoryMax', '--property=MemorySwapMax', '--property=TasksMax', '--property=CPUQuotaPerSecUSec',
        ], { label: 'execution-cell resource evidence', timeoutMs: 5_000 })
        properties = assertResourceProperties(parseProperties(propertiesResult.stdout))
      } finally {
        lease.abort()
        settled = await running
      }
      if (settled.error) throw settled.error
      const result = settled.value
      if (result.cleanup.remaining.length !== 0) throw new DshDeveloperError('LAB_ORPHAN_REMAINS', 'Lease loss left an execution-cell process.')
      return {
        properties,
        leaseExitCode: result.exitCode,
        cleanup: {
          observedOrphans: result.cleanup.found.length,
          killed: result.cleanup.killed,
          remaining: result.cleanup.remaining.length,
        },
      }
    })
    await verify('lab.controller-crash-recovery', 'A separately terminated controller loses its lease; the cell expires and the next controller removes its orphan scope and root.', async () => {
      const crashRootId = randomBytes(16).toString('hex')
      const crashCellId = randomBytes(16).toString('hex')
      const crashRoot = '/tmp/dsh-developer-lab-' + crashRootId
      const helperController = new AbortController()
      const helperSignal = options.signal
        ? AbortSignal.any([options.signal, helperController.signal])
        : helperController.signal
      const helperRunning = runBounded(process.execPath, [
        CRASH_HELPER,
        provider.distro,
        crashRootId,
        crashCellId,
      ], {
        label: 'outer execution-lab controller fixture',
        signal: helperSignal,
        timeoutMs: 20_000,
        outputLimit: 32 * 1024,
        diagnosticOutput: true,
        env: secretFreeEnvironment(),
      }).then((value) => ({ value }), (error) => ({ error }))
      let ready = false
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (options.signal?.aborted) break
        if (await pathMetadata(runWsl, provider.distro, crashRoot + '/' + CRASH_READY_NAME)) {
          ready = true
          break
        }
        await delay(100)
      }
      helperController.abort()
      const helperSettled = await helperRunning
      let recovery = { recovered: [] }
      if (await pathMetadata(runWsl, provider.distro, crashRoot)) {
        await delay((STALE_LEASE_SECONDS + 1) * 1_000)
        recovery = await recoverStaleLabRoots(runWsl, provider)
      }
      if (options.signal?.aborted) {
        throw new DshDeveloperError('CANCELLED', 'Execution-lab conformance was cancelled during the controller-crash fixture.')
      }
      const helperDiagnostic = helperSettled.error ? asDiagnostic(helperSettled.error) : undefined
      if (!ready || helperDiagnostic?.code !== 'CANCELLED') {
        throw new DshDeveloperError('LAB_CONTROLLER_CRASH_INVALID', 'The outer controller fixture did not reach and report forced termination.', {
          ready,
          helperDiagnostic,
          helperResult: helperSettled.value,
        })
      }
      const crashRootAfterRecovery = await pathMetadata(runWsl, provider.distro, crashRoot)
      if (!recovery.recovered.includes(crashRoot) && crashRootAfterRecovery) {
        throw new DshDeveloperError('LAB_STALE_RECOVERY_UNPROVED', 'The next-controller recovery scan did not remove the crashed controller root.', {
          recovered: recovery.recovered,
        })
      }
      const remaining = await findMarkerPids(runWsl, provider.distro, crashCellId, { inheritSignal: false })
      const unitStatus = await runWsl(provider.distro, [
        '/usr/bin/systemctl', '--user', 'is-active', unitName(crashCellId),
      ], {
        label: 'controller-crash scope verification',
        acceptedExitCodes: [0, 3, 4],
        timeoutMs: 5_000,
        inheritSignal: false,
      })
      if (remaining.length > 0 || unitStatus.exitCode === 0 || crashRootAfterRecovery) {
        throw new DshDeveloperError('LAB_ORPHAN_REMAINS', 'Controller-crash recovery left a process or private root.', {
          remaining,
          unitExitCode: unitStatus.exitCode,
        })
      }
      return {
        outerController: 'force-terminated',
        leaseExpirySeconds: STALE_LEASE_SECONDS,
        staleRootRecovered: true,
        scopeActive: false,
        remainingProcesses: 0,
      }
    })
    await verify('lab.cancellation', 'Cancellation stops the WSL client and the entire cell process tree before delayed effects occur.', async () => {
      const sentinel = workspace + '/cancelled-grandchild-survived'
      const cellId = randomBytes(16).toString('hex')
      const controller = new AbortController()
      const running = runCell(runWsl, provider, workspace, [
        '/bin/sh', '-c', '(sleep 2; touch /opt/workspace/cancelled-grandchild-survived) & wait',
      ], {
        cellId,
        signal: controller.signal,
        timeoutMs: 10_000,
      }).then((value) => ({ value }), (error) => ({ error }))
      let settled
      try {
        await waitForMarker(runWsl, provider.distro, cellId)
      } finally {
        controller.abort()
        settled = await running
      }
      const diagnostic = settled.error ? asDiagnostic(settled.error) : undefined
      if (diagnostic?.code !== 'CANCELLED') {
        throw new DshDeveloperError('LAB_CANCELLATION_INVALID', 'The cell did not report controller cancellation.', { diagnostic })
      }
      await delay(2_300)
      const witness = await runWsl(provider.distro, ['/usr/bin/test', '!', '-e', sentinel], {
        label: 'cancelled-grandchild witness check',
        acceptedExitCodes: [0, 1],
      })
      if (witness.exitCode !== 0) throw new DshDeveloperError('LAB_PROCESS_SURVIVED', 'A cancelled cell produced a delayed grandchild effect.')
      return {
        delayedEffect: 'absent',
        diagnostic: diagnostic ? { code: diagnostic.code, message: diagnostic.message } : undefined,
      }
    })
  } catch (error) {
    if (!(error instanceof StopConformance)) {
      checks.push(check('lab.internal', 'FAIL', 'The lab conformance controller failed unexpectedly.', asDiagnostic(error)))
      stopped = true
    }
  } finally {
    if (root !== undefined) {
      let heartbeatError
      try {
        await controllerHeartbeat?.stop()
      } catch (error) {
        heartbeatError = error
      }
      try {
        await removeLabArtifacts(runWsl, provider.distro, root, credentialCanary)
        if (heartbeatError) throw heartbeatError
        checks.push(check('lab.cleanup', 'PASS', 'The provider removed its private workspace and canaries.', { privateRootRemoved: true }))
      } catch (error) {
        checks.push(check('lab.cleanup', 'FAIL', 'The provider failed to remove or verify its private workspace.', asDiagnostic(error)))
      }
    }
  }

  return {
    provider,
    policy: {
      authority: 'one private writable workspace; only the read-only /usr runtime is imported; WSL state and Windows integration paths are absent',
      environment: ['PATH', 'LANG', 'HOME', 'PWD', 'DSH_DEVELOPER_CELL_ID'],
      network: 'private namespace with no configured route',
      processes: 'private PID namespace with controller heartbeat, exit-137 lease expiry, forced orphan scans, and next-controller stale-root recovery',
      devices: 'fresh /dev; block, GPU, sysfs, and Windows driver views hidden',
      resources: { ...RESOURCE_LIMITS, timeoutMs: LIMITS.commandTimeoutMs, outputBytes: LIMITS.commandOutputBytes },
      syscallBoundary: 'shared WSL2 kernel; no project-specific seccomp filter claimed',
    },
    checks,
  }
}
