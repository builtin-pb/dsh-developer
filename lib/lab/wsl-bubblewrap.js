import { randomBytes } from 'node:crypto'
import { arch, hostname, release } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { LIMITS } from '../constants.js'
import { asDiagnostic, DshDeveloperError } from '../errors.js'
import { fingerprintFileMap } from '../files.js'
import { runBounded, secretFreeEnvironment } from '../runtime.js'
import { decodeTextTree, encodeTextTree, TEXT_TAR_MAX_BYTES } from './text-tar.js'

export const WSL_BUBBLEWRAP_PROVIDER_ID = 'wsl2-bubblewrap'

const CELL_ID_PATTERN = /^[a-f0-9]{32}$/u
const DISTRO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/u
const ROOT_PATTERN = /^\/tmp\/dsh-developer-lab-[a-f0-9]{32}$/u
const CREDENTIAL_CANARY_PATTERN = /^\/var\/tmp\/dsh-developer-credential-canary-[a-f0-9]{32}$/u
const CONTROLLER_LEASE_NAME = 'controller.lease'
const CRASH_READY_NAME = 'controller-crash-ready'
const STALE_LEASE_SECONDS = 6
const CRASH_HELPER = fileURLToPath(new URL('./crash-controller.js', import.meta.url))
const WORKSPACE_WATCHDOG = [
  'import json, os, stat, subprocess, sys, time',
  'config = json.load(sys.stdin)',
  'workspace = config["workspace"]',
  'ready = config["ready"]',
  'stop = config["stop"]',
  'violation = config["violation"]',
  'unit = config["unit"]',
  'control = config["control"]',
  'cgroup = config["cgroup"]',
  'byte_limit = config["byteLimit"]',
  'entry_limit = config["entryLimit"]',
  'marker = config["cellId"].encode("ascii")',
  'def measure():',
  '    byte_count = 0',
  '    entry_count = 0',
  '    pending = [workspace]',
  '    while pending:',
  '        directory = pending.pop()',
  '        try:',
  '            rows = list(os.scandir(directory))',
  '        except FileNotFoundError:',
  '            if directory == workspace:',
  '                raise',
  '            continue',
  '        for row in rows:',
  '            try:',
  '                info = row.stat(follow_symlinks=False)',
  '            except FileNotFoundError:',
  '                continue',
  '            entry_count += 1',
  '            byte_count += info.st_size',
  '            if stat.S_ISDIR(info.st_mode):',
  '                pending.append(row.path)',
  '            if byte_count > byte_limit or entry_count > entry_limit:',
  '                return byte_count, entry_count',
  '    return byte_count, entry_count',
  'def record(reason, byte_count, entry_count):',
  '    termination = "fallback"',
  '    try:',
  '        with open(cgroup + "/cgroup.freeze", "w", encoding="ascii") as freeze_file:',
  '            freeze_file.write("1")',
  '        with open(cgroup + "/cgroup.kill", "w", encoding="ascii") as kill_file:',
  '            kill_file.write("1")',
  '        termination = "cgroup"',
  '    except OSError:',
  '        pass',
  '    if termination != "cgroup":',
  '        try:',
  '            with open(control, "r", encoding="ascii") as control_file:',
  '                controlled_process = int(control_file.read())',
  '            os.kill(controlled_process, 19)',
  '            os.kill(controlled_process, 9)',
  '        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError):',
  '            pass',
  '        targets = set()',
  '        parents = {}',
  '        for name in os.listdir("/proc"):',
  '            if not name.isdigit():',
  '                continue',
  '            try:',
  '                process_id = int(name)',
  '                with open("/proc/" + name + "/cmdline", "rb") as command_line:',
  '                    if marker in command_line.read():',
  '                        targets.add(process_id)',
  '                with open("/proc/" + name + "/status", "r", encoding="ascii") as status_file:',
  '                    for status_line in status_file:',
  '                        if status_line.startswith("PPid:"):',
  '                            parents[process_id] = int(status_line.split()[1])',
  '                            break',
  '            except (FileNotFoundError, PermissionError, ProcessLookupError):',
  '                pass',
  '        changed = True',
  '        while changed:',
  '            changed = False',
  '            for process_id, parent_id in parents.items():',
  '                if parent_id in targets and process_id not in targets:',
  '                    targets.add(process_id)',
  '                    changed = True',
  '        for signal_number in (19, 9):',
  '            for process_id in targets:',
  '                try:',
  '                    os.kill(process_id, signal_number)',
  '                except (PermissionError, ProcessLookupError):',
  '                    pass',
  '        subprocess.run(["/usr/bin/systemctl", "--user", "kill", "--kill-whom=all", "--signal=KILL", unit], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)',
  '    try:',
  '        descriptor = os.open(violation, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)',
  '        os.write(descriptor, (reason + "|" + str(byte_count) + "|" + str(entry_count) + "|" + termination).encode("ascii"))',
  '        os.close(descriptor)',
  '    except FileExistsError:',
  '        pass',
  'with open(ready, "x", encoding="ascii"):',
  '    pass',
  'while True:',
  '    try:',
  '        byte_count, entry_count = measure()',
  '    except Exception:',
  '        record("scan", 0, 0)',
  '        break',
  '    if byte_count > byte_limit:',
  '        record("bytes", byte_count, entry_count)',
  '        break',
  '    if entry_count > entry_limit:',
  '        record("entries", byte_count, entry_count)',
  '        break',
  '    if os.path.exists(stop):',
  '        break',
  '    time.sleep(0.025)',
].join('\n')
const WORKSPACE_MEASURE = [
  'import json, os, stat, sys',
  'workspace = sys.argv[1]',
  'byte_count = 0',
  'entry_count = 0',
  'pending = [workspace]',
  'while pending:',
  '    directory = pending.pop()',
  '    for row in os.scandir(directory):',
  '        info = row.stat(follow_symlinks=False)',
  '        byte_count += info.st_size',
  '        entry_count += 1',
  '        if stat.S_ISDIR(info.st_mode):',
  '            pending.append(row.path)',
  'print(json.dumps({"bytes": byte_count, "entries": entry_count}, separators=(",", ":")))',
].join('\n')
const SUPERVISOR = [
  'set -eu',
  'lease=$1',
  'control=$2',
  'shift 2',
  '"$@" </dev/null &',
  'cell=$!',
  'printf "%s" "$cell" > "$control"',
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
  'rm -f -- "$control"',
  'exit "$status"',
].join('\n')

const RESOURCE_LIMITS = Object.freeze({
  memoryBytes: 256 * 1024 * 1024,
  swapBytes: 0,
  tasks: 32,
  cpuQuota: '100%',
  cpuSeconds: 45,
  fileBytes: LIMITS.fileBytes,
  openFiles: 128,
  writeBytesPerSecond: 4 * 1024 * 1024,
  writeOperationsPerSecond: 128,
})

const WORKSPACE_LIMITS = Object.freeze({
  bytes: 8 * 1024 * 1024,
  entries: 2 * LIMITS.treeEntries,
  observedBytes: 16 * 1024 * 1024,
  observedEntries: 4 * LIMITS.treeEntries,
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

function assertAbortSignal(signal, label) {
  if (signal === undefined) return
  if (signal === null
      || typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function') {
    throw new DshDeveloperError('CELL_OPTIONS_INVALID', label + ' must be an AbortSignal when present.')
  }
}

function combineAbortSignals(...signals) {
  const unique = [...new Set(signals.filter((value) => value !== undefined))]
  if (unique.length === 0) return undefined
  if (unique.length === 1) return unique[0]
  return AbortSignal.any(unique)
}

function assertMethodOptions(options, label) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new DshDeveloperError('CELL_OPTIONS_INVALID', label + ' options must be an object.')
  }
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
    '-p', 'IOAccounting=yes',
    '-p', 'IOWriteBandwidthMax=/tmp ' + RESOURCE_LIMITS.writeBytesPerSecond,
    '-p', 'IOWriteIOPSMax=/tmp ' + RESOURCE_LIMITS.writeOperationsPerSecond,
    '/bin/sh',
    '-c',
    SUPERVISOR,
    'dsh-developer-supervisor',
    lease,
    lease.replace('/lease-', '/quota-pid-'),
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
      signal: runOptions.inheritSignal === false ? runOptions.signal : runOptions.signal ?? options.signal,
      acceptedExitCodes: runOptions.acceptedExitCodes,
      timeoutMs: runOptions.timeoutMs ?? LIMITS.commandTimeoutMs,
      outputLimit: runOptions.outputLimit ?? LIMITS.commandOutputBytes,
      input: runOptions.input,
      encoding: runOptions.encoding,
      diagnosticOutput: runOptions.diagnosticOutput ?? runOptions.encoding !== null,
      inputLimit: runOptions.inputLimit,
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
  await runWsl(distro, ['/usr/bin/chmod', '-R', 'u+rwX', '--', root], {
    label: 'lab hostile-mode normalization',
    acceptedExitCodes: [0, 1],
    inheritSignal: false,
  })
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

function parseWorkspaceViolation(value) {
  if (value.length === 0) return undefined
  const match = /^(bytes|entries|scan)\|(\d+)\|(\d+)\|(cgroup|fallback)$/u.exec(value)
  if (!match) {
    throw new DshDeveloperError('CELL_WORKSPACE_WATCHDOG_FAILED', 'The workspace watchdog returned invalid violation evidence.')
  }
  return {
    reason: match[1],
    bytes: Number(match[2]),
    entries: Number(match[3]),
    termination: match[4],
    limits: { bytes: WORKSPACE_LIMITS.bytes, entries: WORKSPACE_LIMITS.entries },
  }
}

async function measureWorkspaceImpact(runWsl, provider, workspace) {
  const result = await runWsl(provider.distro, ['/usr/bin/python3', '-c', WORKSPACE_MEASURE, workspace], {
    label: 'workspace final bounded-impact measurement',
    inheritSignal: false,
    outputLimit: 4 * 1024,
  })
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new DshDeveloperError('CELL_WORKSPACE_WATCHDOG_FAILED', 'The workspace final measurement returned invalid JSON evidence.')
  }
  if (!Number.isSafeInteger(parsed?.bytes)
      || parsed.bytes < 0
      || !Number.isSafeInteger(parsed?.entries)
      || parsed.entries < 0) {
    throw new DshDeveloperError('CELL_WORKSPACE_WATCHDOG_FAILED', 'The workspace final measurement returned invalid bounded values.')
  }
  return parsed
}

async function startWorkspaceWatchdog(runWsl, provider, root, workspace, cellId, commandTimeoutMs, quotaController) {
  const ready = root + '/quota-ready-' + cellId
  const stop = root + '/quota-stop-' + cellId
  const violation = root + '/quota-violation-' + cellId
  const control = root + '/quota-pid-' + cellId
  const watchdogController = new AbortController()
  let stopRequested = false
  let exitedBeforeStop = false
  let watchdogError
  const configuration = JSON.stringify({
    workspace,
    ready,
    stop,
    violation,
    control,
    cellId,
    unit: unitName(cellId),
    cgroup: '/sys/fs/cgroup/user.slice/user-' + provider.user.uid + '.slice/user@'
      + provider.user.uid + '.service/app.slice/' + unitName(cellId),
    byteLimit: WORKSPACE_LIMITS.bytes,
    entryLimit: WORKSPACE_LIMITS.entries,
  })
  const settled = runWsl(provider.distro, ['/usr/bin/python3', '-c', WORKSPACE_WATCHDOG], {
    label: 'execution-cell workspace watchdog',
    signal: watchdogController.signal,
    inheritSignal: false,
    timeoutMs: commandTimeoutMs + 10_000,
    input: configuration,
    inputLimit: 16 * 1024,
    outputLimit: 32 * 1024,
  }).then(
    (result) => {
      if (!stopRequested) {
        exitedBeforeStop = true
        quotaController.abort(new DshDeveloperError('CELL_WORKSPACE_LIMIT', 'The workspace watchdog stopped the execution cell.'))
      }
      return result
    },
    (error) => {
      watchdogError = error
      if (!stopRequested) quotaController.abort(error)
      return undefined
    },
  )

  let readyObserved = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (watchdogError || exitedBeforeStop) break
    if (await pathMetadata(runWsl, provider.distro, ready)) {
      readyObserved = true
      break
    }
    await delay(50)
  }
  if (!readyObserved) {
    stopRequested = true
    watchdogController.abort()
    await settled
    await runWsl(provider.distro, ['/usr/bin/rm', '-f', '--', ready, stop, violation, control], {
      label: 'workspace-watchdog startup cleanup',
      inheritSignal: false,
    }).catch(() => {})
    throw new DshDeveloperError('CELL_WORKSPACE_WATCHDOG_FAILED', 'The workspace watchdog did not establish its controller lease.', {
      ...(watchdogError ? { watchdog: asDiagnostic(watchdogError) } : {}),
    })
  }

  return {
    async stop() {
      stopRequested = true
      let stopError
      try {
        await runWsl(provider.distro, ['/usr/bin/touch', stop], {
          label: 'workspace-watchdog stop request',
          inheritSignal: false,
        })
      } catch (error) {
        stopError = error
        watchdogController.abort()
      }
      await settled
      let evidenceError
      let parsed
      try {
        const result = await runWsl(provider.distro, ['/usr/bin/cat', violation], {
          label: 'workspace-watchdog violation evidence',
          acceptedExitCodes: [0, 1],
          inheritSignal: false,
          outputLimit: 4 * 1024,
        })
        if (result.exitCode === 0) parsed = parseWorkspaceViolation(result.stdout)
      } catch (error) {
        evidenceError = error
      }
      let markerCleanupError
      try {
        await runWsl(provider.distro, ['/usr/bin/rm', '-f', '--', ready, stop, violation, control], {
          label: 'workspace-watchdog marker cleanup',
          inheritSignal: false,
        })
      } catch (error) {
        markerCleanupError = error
      }
      if (stopError || watchdogError || evidenceError || markerCleanupError || (exitedBeforeStop && !parsed)) {
        throw new DshDeveloperError('CELL_WORKSPACE_WATCHDOG_FAILED', 'The workspace watchdog did not settle with complete evidence.', {
          ...(stopError ? { stop: asDiagnostic(stopError) } : {}),
          ...(watchdogError ? { watchdog: asDiagnostic(watchdogError) } : {}),
          ...(evidenceError ? { evidence: asDiagnostic(evidenceError) } : {}),
          ...(markerCleanupError ? { markerCleanup: asDiagnostic(markerCleanupError) } : {}),
          exitedBeforeStop,
          ...(parsed ? { violation: parsed } : {}),
        })
      }
      if (parsed) return parsed
      return undefined
    },
  }
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
  let watchdog
  let workspaceError
  let workspaceViolation
  const quotaController = new AbortController()
  const commandSignal = options.signal
    ? AbortSignal.any([options.signal, quotaController.signal])
    : quotaController.signal
  try {
    watchdog = await startWorkspaceWatchdog(
      runWsl,
      provider,
      root,
      workspace,
      cellId,
      options.timeoutMs ?? LIMITS.commandTimeoutMs,
      quotaController,
    )
  } catch (error) {
    commandError = error
  }
  if (!commandError) {
    try {
      result = await runWsl(provider.distro, scoped, {
        label: options.label ?? 'isolated execution-cell fixture',
        signal: commandSignal,
        acceptedExitCodes: options.acceptedExitCodes,
        timeoutMs: options.timeoutMs,
        hostEnvironment: { DSH_DEVELOPER_HOST_CANARY: cellId },
      })
    } catch (error) {
      commandError = error
    }
  }
  try {
    workspaceViolation = await watchdog?.stop()
  } catch (error) {
    workspaceError = error
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
  if (workspaceError) {
    throw new DshDeveloperError('CELL_WORKSPACE_WATCHDOG_FAILED', 'The execution-cell workspace watchdog failed before cleanup was verified.', {
      cellId,
      cleanup,
      watchdog: asDiagnostic(workspaceError),
      ...(commandError ? { command: asDiagnostic(commandError) } : {}),
    })
  }
  if (workspaceViolation) {
    if (workspaceViolation.reason === 'scan') {
      throw new DshDeveloperError('CELL_WORKSPACE_WATCHDOG_FAILED', 'The workspace watchdog could not inspect the execution cell.', {
        cellId,
        cleanup,
        violation: workspaceViolation,
      })
    }
    let observed
    try {
      observed = await measureWorkspaceImpact(runWsl, provider, workspace)
    } catch (error) {
      throw new DshDeveloperError('CELL_WORKSPACE_WATCHDOG_FAILED', 'The final workspace impact could not be measured after quota termination.', {
        cellId,
        cleanup,
        measurement: asDiagnostic(error),
        violation: workspaceViolation,
      })
    }
    if (observed.bytes > WORKSPACE_LIMITS.observedBytes
        || observed.entries > WORKSPACE_LIMITS.observedEntries) {
      throw new DshDeveloperError('CELL_WORKSPACE_BOUND_BREACHED', 'Workspace growth exceeded the conservative monitored overshoot bound.', {
        cellId,
        cleanup,
        violation: workspaceViolation,
        observed,
        observedBound: {
          bytes: WORKSPACE_LIMITS.observedBytes,
          entries: WORKSPACE_LIMITS.observedEntries,
        },
      })
    }
    throw new DshDeveloperError('CELL_WORKSPACE_LIMIT', 'The execution cell exceeded its aggregate workspace byte or entry limit.', {
      cellId,
      cleanup,
      violation: workspaceViolation,
      observed,
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

function mapSnapshot(entries) {
  return new Map(entries.map((entry) => [entry.path, entry.content]))
}

async function snapshotWorkspace(runWsl, provider, workspace, signal) {
  const result = await runWsl(provider.distro, [
    '/usr/bin/tar',
    '--format=ustar',
    '--sort=name',
    '--mtime=@0',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--create',
    '--file=-',
    '--directory=' + workspace,
    '.',
  ], {
    label: 'isolated cell snapshot export',
    signal,
    encoding: null,
    diagnosticOutput: false,
    outputLimit: TEXT_TAR_MAX_BYTES,
  })
  if (result.stderr.byteLength > 0) {
    throw new DshDeveloperError(
      'CELL_SNAPSHOT_INCOMPLETE',
      'The isolated cell snapshot reported an omitted or unstable filesystem entry.',
    )
  }
  return decodeTextTree(result.stdout)
}

/**
 * Open one private, disposable WSL2/Bubblewrap workspace for model-visible
 * commands. The trusted controller imports and exports bounded text snapshots;
 * repository code is never executed during transfer. Every command still runs
 * through {@link runCell}, so cancellation and settlement include forced
 * process-tree cleanup before the call returns.
 */
export async function createWslBubblewrapCell(options = {}) {
  assertMethodOptions(options, 'isolated-cell')
  assertAbortSignal(options.signal, 'isolated-cell signal')
  const runWsl = createRunner(options)
  const provider = await discoverProvider(options, runWsl)
  await recoverStaleLabRoots(runWsl, provider)
  const rootId = randomBytes(16).toString('hex')
  const root = '/tmp/dsh-developer-lab-' + rootId
  const workspace = root + '/workspace'
  let heartbeat
  let disposed = false
  let closing = false
  let activeOperation
  let disposePromise
  const lifecycleController = new AbortController()

  function assertOpen() {
    if (disposed) throw new DshDeveloperError('CELL_DISPOSED', 'The isolated execution cell is already disposed.')
    if (closing) throw new DshDeveloperError('CELL_CLOSING', 'The isolated execution cell is being disposed.')
    if (options.signal?.aborted) throw new DshDeveloperError('CANCELLED', 'Isolated execution-cell work was cancelled.')
  }

  try {
    await runWsl(provider.distro, ['/usr/bin/mkdir', '-m', '700', root], {
      label: 'isolated cell root creation',
    })
    await runWsl(provider.distro, ['/usr/bin/mkdir', '-m', '700', workspace], {
      label: 'isolated cell workspace creation',
    })
    await runWsl(provider.distro, ['/usr/bin/touch', root + '/' + CONTROLLER_LEASE_NAME], {
      label: 'isolated cell controller lease creation',
    })
    heartbeat = startControllerHeartbeat(runWsl, provider.distro, root)
    const archive = encodeTextTree(options.entries ?? [])
    const imported = await runWsl(provider.distro, [
      '/usr/bin/tar',
      '--extract',
      '--file=-',
      '--directory=' + workspace,
      '--no-same-owner',
      '--no-same-permissions',
    ], {
      label: 'isolated cell source import',
      input: archive,
      inputLimit: TEXT_TAR_MAX_BYTES,
      outputLimit: 32 * 1024,
    })
    if (imported.stdout.length > 0 || imported.stderr.length > 0) {
      throw new DshDeveloperError('CELL_IMPORT_INCOMPLETE', 'The isolated cell source import produced unexpected tar diagnostics.')
    }
  } catch (error) {
    let heartbeatError
    let cleanupError
    try {
      await heartbeat?.stop()
    } catch (failure) {
      heartbeatError = failure
    }
    try {
      if (await pathMetadata(runWsl, provider.distro, root)) await removeLabArtifacts(runWsl, provider.distro, root)
    } catch (failure) {
      cleanupError = failure
    }
    if (heartbeatError || cleanupError) {
      throw new DshDeveloperError('CELL_CREATE_CLEANUP_FAILED', 'The isolated cell failed before publication and cleanup was not verified.', {
        creation: asDiagnostic(error),
        ...(heartbeatError ? { heartbeat: asDiagnostic(heartbeatError) } : {}),
        ...(cleanupError ? { cleanup: asDiagnostic(cleanupError) } : {}),
      })
    }
    throw error
  }

  return {
    provider,
    async run(command, runOptions = {}) {
      assertMethodOptions(runOptions, 'isolated-cell run')
      assertOpen()
      assertAbortSignal(runOptions.signal, 'isolated-cell run signal')
      if (activeOperation !== undefined) {
        throw new DshDeveloperError('CELL_BUSY', 'The isolated execution cell already has an operation in progress.')
      }
      const operation = runCell(runWsl, provider, workspace, command, {
        ...runOptions,
        signal: combineAbortSignals(options.signal, runOptions.signal, lifecycleController.signal),
      })
      activeOperation = operation
      try {
        return await operation
      } finally {
        if (activeOperation === operation) activeOperation = undefined
      }
    },
    async snapshot(snapshotOptions = {}) {
      assertMethodOptions(snapshotOptions, 'isolated-cell snapshot')
      assertOpen()
      assertAbortSignal(snapshotOptions.signal, 'isolated-cell snapshot signal')
      if (activeOperation !== undefined) {
        throw new DshDeveloperError('CELL_BUSY', 'The isolated execution cell already has an operation in progress.')
      }
      const signal = combineAbortSignals(options.signal, snapshotOptions.signal, lifecycleController.signal)
      const operation = (async () => {
        const first = await snapshotWorkspace(runWsl, provider, workspace, signal)
        const second = await snapshotWorkspace(runWsl, provider, workspace, signal)
        const firstFingerprint = fingerprintFileMap(mapSnapshot(first))
        const secondFingerprint = fingerprintFileMap(mapSnapshot(second))
        if (firstFingerprint !== secondFingerprint) {
          throw new DshDeveloperError('MUTABLE_TREE', 'The isolated cell changed while its result snapshot was acquired.')
        }
        return { entries: second, fingerprint: secondFingerprint }
      })()
      activeOperation = operation
      try {
        return await operation
      } finally {
        if (activeOperation === operation) activeOperation = undefined
      }
    },
    async dispose() {
      if (disposed) return
      try {
        if (disposePromise === undefined) {
          closing = true
          lifecycleController.abort(new DshDeveloperError('CELL_CLOSING', 'The isolated execution cell is being disposed.'))
          const pending = activeOperation
          disposePromise = (async () => {
            if (pending !== undefined) await pending.catch(() => {})
            let heartbeatError
            try {
              await heartbeat?.stop()
            } catch (error) {
              heartbeatError = error
            }
            try {
              await removeLabArtifacts(runWsl, provider.distro, root)
            } catch (cleanupError) {
              throw new DshDeveloperError('CELL_CLEANUP_FAILED', 'The isolated cell could not verify removal of its private workspace.', {
                ...(heartbeatError ? { heartbeat: asDiagnostic(heartbeatError) } : {}),
                cleanup: asDiagnostic(cleanupError),
              })
            }
            disposed = true
            if (heartbeatError) throw heartbeatError
          })()
        }
        await disposePromise
      } catch (error) {
        disposePromise = undefined
        throw error
      }
    },
  }
}

export async function runControllerCrashFixture({ distro, rootId, cellId }) {
  const normalizedDistro = normalizeDistro(distro)
  if (!CELL_ID_PATTERN.test(rootId) || !CELL_ID_PATTERN.test(cellId)) {
    throw new DshDeveloperError('LAB_CRASH_FIXTURE_INVALID', 'The controller-crash fixture identifiers are invalid.')
  }
  const runWsl = createRunner({})
  const provider = await discoverProvider({ distro: normalizedDistro }, runWsl)
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
    const running = runCell(runWsl, provider, workspace, ['/usr/bin/sleep', '60'], {
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
    IOAccounting: 'yes',
    IOWriteBandwidthMax: '/tmp ' + RESOURCE_LIMITS.writeBytesPerSecond,
    IOWriteIOPSMax: '/tmp ' + RESOURCE_LIMITS.writeOperationsPerSecond,
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
          '--property=IOAccounting', '--property=IOWriteBandwidthMax', '--property=IOWriteIOPSMax',
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
    await verify('lab.workspace-storage', 'The cell has a rate-limited aggregate byte and entry watchdog that terminates growth within a conservative bound.', async () => {
      let byteDiagnostic
      try {
        await runCell(runWsl, provider, workspace, [
          '/bin/sh',
          '-c',
          'index=0; while :; do /usr/bin/dd if=/dev/zero of="quota-byte-$index" bs=262144 count=1 status=none; index=$((index + 1)); done',
        ], { timeoutMs: 15_000 })
      } catch (error) {
        byteDiagnostic = asDiagnostic(error)
      }
      if (byteDiagnostic?.code !== 'CELL_WORKSPACE_LIMIT'
          || byteDiagnostic.violation?.reason !== 'bytes'
          || byteDiagnostic.violation?.termination !== 'cgroup') {
        throw new DshDeveloperError('LAB_WORKSPACE_LIMIT_INVALID', 'Aggregate workspace byte growth was not stopped by the admitted direct cgroup boundary.', {
          diagnostic: byteDiagnostic,
        })
      }
      await runWsl(provider.distro, [
        '/usr/bin/find', workspace, '-mindepth', '1', '-maxdepth', '1', '-type', 'f',
        '-name', 'quota-byte-*', '-delete',
      ], { label: 'workspace byte-fixture cleanup', inheritSignal: false })

      let entryDiagnostic
      try {
        await runCell(runWsl, provider, workspace, [
          '/usr/bin/python3',
          '-c',
          'import itertools, pathlib; [pathlib.Path(f"quota-entry-{index}").touch() for index in itertools.count()]',
        ], { timeoutMs: 15_000 })
      } catch (error) {
        entryDiagnostic = asDiagnostic(error)
      }
      if (entryDiagnostic?.code !== 'CELL_WORKSPACE_LIMIT'
          || entryDiagnostic.violation?.reason !== 'entries'
          || entryDiagnostic.violation?.termination !== 'cgroup') {
        throw new DshDeveloperError('LAB_WORKSPACE_LIMIT_INVALID', 'Aggregate workspace entry growth was not stopped by the admitted direct cgroup boundary.', {
          diagnostic: entryDiagnostic,
        })
      }
      const usage = await runWsl(provider.distro, ['/usr/bin/du', '-sb', '--', workspace], {
        label: 'workspace bounded-impact evidence',
        outputLimit: 4 * 1024,
      })
      const bytes = Number.parseInt(usage.stdout.split(/\s+/u)[0], 10)
      if (!Number.isSafeInteger(bytes) || bytes > WORKSPACE_LIMITS.observedBytes) {
        throw new DshDeveloperError('LAB_WORKSPACE_BOUND_BREACHED', 'Observed workspace impact exceeded its conservative evidence bound.', {
          bytes,
          observedBound: WORKSPACE_LIMITS.observedBytes,
        })
      }
      return {
        byteViolation: byteDiagnostic.violation,
        byteObserved: byteDiagnostic.observed,
        entryViolation: entryDiagnostic.violation,
        entryObserved: entryDiagnostic.observed,
        observedBytes: bytes,
        observedBound: {
          bytes: WORKSPACE_LIMITS.observedBytes,
          entries: WORKSPACE_LIMITS.observedEntries,
        },
        writeRate: {
          bytesPerSecond: RESOURCE_LIMITS.writeBytesPerSecond,
          operationsPerSecond: RESOURCE_LIMITS.writeOperationsPerSecond,
        },
        cleanup: {
          bytes: byteDiagnostic.cleanup,
          entries: entryDiagnostic.cleanup,
        },
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
      resources: {
        ...RESOURCE_LIMITS,
        workspace: { ...WORKSPACE_LIMITS },
        timeoutMs: LIMITS.commandTimeoutMs,
        outputBytes: LIMITS.commandOutputBytes,
      },
      syscallBoundary: 'shared WSL2 kernel; no project-specific seccomp filter claimed',
    },
    checks,
  }
}
