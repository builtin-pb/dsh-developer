import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { delimiter, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { DSH_COMPATIBILITY_TARGET, LIMITS } from './constants.js'
import { DshDeveloperError } from './errors.js'

const SAFE_ENVIRONMENT_KEYS = new Set([
  'CI',
  'COMSPEC',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'WINDIR',
])

const SMOKE_PROFILE = 'dsh-developer-smoke'
const LOAD_WITNESS_FILENAME = '.dsh-developer-load-witness'

export function secretFreeEnvironment(overrides = {}) {
  const environment = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && SAFE_ENVIRONMENT_KEYS.has(key.toLocaleUpperCase('en-US'))) environment[key] = value
  }
  return {
    ...environment,
    NO_COLOR: '1',
    CI: '1',
    DSH_TELEMETRY_MODE: 'DISABLED',
    ...overrides,
  }
}

async function terminateProcessTree(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    await new Promise((accept) => {
      let killer
      try {
        killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        })
      } catch {
        child.kill()
        accept()
        return
      }
      killer.once('error', () => accept())
      killer.once('close', () => accept())
    })
    if (child.exitCode === null && child.signalCode === null) child.kill()
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await new Promise((accept) => setTimeout(accept, 750))
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

export async function runBounded(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? LIMITS.commandTimeoutMs
  const outputLimit = options.outputLimit ?? LIMITS.commandOutputBytes
  const acceptedExitCodes = options.acceptedExitCodes ?? [0]
  const input = options.input
  if (input !== undefined
      && typeof input !== 'string'
      && !Buffer.isBuffer(input)
      && !(input instanceof Uint8Array)) {
    throw new DshDeveloperError('COMMAND_OPTIONS_INVALID', 'input must be a string, Buffer, or Uint8Array when present.')
  }
  if (options.encoding !== undefined && options.encoding !== 'utf8' && options.encoding !== null) {
    throw new DshDeveloperError('COMMAND_OPTIONS_INVALID', 'encoding must be "utf8" or null when present.')
  }
  const inputLimit = options.inputLimit ?? LIMITS.commandOutputBytes
  if (!Number.isSafeInteger(inputLimit) || inputLimit <= 0) {
    throw new DshDeveloperError('COMMAND_OPTIONS_INVALID', 'inputLimit must be a positive safe integer.')
  }
  if (input !== undefined && Buffer.byteLength(input) > inputLimit) {
    throw new DshDeveloperError('COMMAND_INPUT_LIMIT', (options.label ?? command) + ' input exceeds its bounded transport limit.')
  }
  if (!Array.isArray(acceptedExitCodes)
      || acceptedExitCodes.length === 0
      || acceptedExitCodes.some((value) => !Number.isInteger(value))) {
    throw new DshDeveloperError('COMMAND_OPTIONS_INVALID', 'acceptedExitCodes must contain one or more integers.')
  }
  if (options.signal?.aborted) {
    throw new DshDeveloperError('CANCELLED', (options.label ?? command) + ' was cancelled before start.')
  }
  const timeout = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal
  let child
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? secretFreeEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
  } catch (error) {
    throw new DshDeveloperError('COMMAND_START_FAILED', 'Could not start ' + (options.label ?? command) + ': ' + error.message)
  }
  const timer = setTimeout(() => timeout.abort(new Error('command timeout')), timeoutMs)
  let termination
  function requestTermination() {
    if (termination === undefined) termination = terminateProcessTree(child)
  }
  const onAbort = () => requestTermination()
  signal.addEventListener('abort', onAbort, { once: true })

  let stdout = Buffer.alloc(0)
  let stderr = Buffer.alloc(0)
  let exceeded = false
  function append(current, chunk) {
    const combined = Buffer.concat([current, chunk])
    if (combined.byteLength > outputLimit) {
      exceeded = true
      requestTermination()
      return combined.subarray(0, outputLimit)
    }
    return combined
  }
  child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
  child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })

  let inputError
  if (input !== undefined) {
    child.stdin.once('error', (error) => { inputError = error })
    child.stdin.end(input)
  }

  let exit
  try {
    exit = await new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', (code, closeSignal) => accept({ code, signal: closeSignal }))
    })
  } catch (error) {
    throw new DshDeveloperError('COMMAND_FAILED', (options.label ?? command) + ' failed to run: ' + error.message)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    if (termination !== undefined) await termination.catch(() => {})
  }
  if (signal.aborted) {
    throw new DshDeveloperError(
      timeout.signal.aborted ? 'COMMAND_TIMEOUT' : 'CANCELLED',
      (options.label ?? command) + (timeout.signal.aborted ? ' exceeded its time limit.' : ' was cancelled.'),
    )
  }
  if (exceeded) {
    throw new DshDeveloperError('COMMAND_OUTPUT_LIMIT', (options.label ?? command) + ' exceeded its output limit.')
  }
  if (inputError !== undefined) {
    throw new DshDeveloperError('COMMAND_INPUT_FAILED', (options.label ?? command) + ' did not consume its bounded input: ' + inputError.message)
  }
  const binary = options.encoding === null
  const decodedStdout = binary ? stdout : new TextDecoder('utf-8').decode(stdout)
  const decodedStderr = binary ? stderr : new TextDecoder('utf-8').decode(stderr)
  if (!acceptedExitCodes.includes(exit.code)) {
    throw new DshDeveloperError(
      'COMMAND_EXITED',
      (options.label ?? command) + ' exited unsuccessfully.',
      {
        exitCode: exit.code,
        exitSignal: exit.signal,
        ...(options.diagnosticOutput ? { stdout: decodedStdout, stderr: decodedStderr } : {}),
      },
    )
  }
  return {
    stdout: decodedStdout,
    stderr: decodedStderr,
    exitCode: exit.code,
  }
}

async function existingFile(path) {
  const info = await lstat(path).catch(() => undefined)
  return info?.isFile() && !info.isSymbolicLink()
}

async function invocationFromPath(input) {
  const absolute = resolve(input)
  if (!(await existingFile(absolute))) {
    throw new DshDeveloperError('DSH_NOT_FOUND', 'DSH executable was not found.', { path: absolute })
  }
  const extension = extname(absolute).toLocaleLowerCase('en-US')
  if (extension === '.cmd' || extension === '.ps1') {
    const candidates = [
      join(dirname(absolute), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join(dirname(dirname(absolute)), '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ]
    let entry
    for (const candidate of candidates) {
      if (await existingFile(candidate)) {
        entry = candidate
        break
      }
    }
    if (!entry) {
      throw new DshDeveloperError(
        'DSH_WRAPPER_UNSUPPORTED',
        'The DSH wrapper does not have an expected adjacent official JavaScript entry.',
        { path: absolute, expectedEntries: candidates },
      )
    }
    return { command: process.execPath, prefixArgs: [entry], displayPath: absolute }
  }
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return { command: process.execPath, prefixArgs: [absolute], displayPath: absolute }
  }
  return { command: absolute, prefixArgs: [], displayPath: absolute }
}

async function findWindowsDshOnPath() {
  const pathValue = process.env.PATH ?? ''
  for (const directory of pathValue.split(delimiter)) {
    const clean = directory.replace(/^"|"$/gu, '')
    if (clean.length === 0) continue
    for (const file of ['dsh.exe', 'dsh.cmd']) {
      const candidate = join(clean, file)
      if (await existingFile(candidate)) return invocationFromPath(candidate)
    }
  }
  throw new DshDeveloperError('DSH_NOT_FOUND', 'DSH was not found on PATH. Pass --dsh <path>.')
}

export async function resolveDshInvocation(dshPath) {
  if (dshPath) return invocationFromPath(dshPath)
  if (process.platform === 'win32') return findWindowsDshOnPath()
  return { command: 'dsh', prefixArgs: [], displayPath: 'dsh' }
}

export async function runDsh(invocation, args, options = {}) {
  return runBounded(invocation.command, [...invocation.prefixArgs, ...args], {
    ...options,
    label: options.label ?? 'DSH',
  })
}

export async function checkDshVersion(dshPath, options = {}) {
  const invocation = await resolveDshInvocation(dshPath)
  const result = await runDsh(invocation, ['--version'], {
    signal: options.signal,
    label: 'DSH version check',
  })
  const version = result.stdout.trim()
  if (version !== DSH_COMPATIBILITY_TARGET) {
    throw new DshDeveloperError(
      'DSH_VERSION_MISMATCH',
      'DSH ' + version + ' is installed; the blocking target is ' + DSH_COMPATIBILITY_TARGET + '.',
      { actual: version, expected: DSH_COMPATIBILITY_TARGET, dshPath: invocation.displayPath },
    )
  }
  return { version, invocation }
}

export async function runGeneratedNodeTests(root, options = {}) {
  if (options.signal?.aborted) throw new DshDeveloperError('CANCELLED', 'Generated plugin test was cancelled.')
  const entry = await import(pathToFileURL(join(root, 'index.js')).href + '?doctor=' + Date.now())
  let registration
  await entry.apply({
    skills: {
      register(value) {
        registration = value
        return () => {}
      },
    },
  })
  if (typeof entry.name !== 'string'
      || !Array.isArray(entry.inject)
      || entry.inject[0] !== 'skills'
      || registration?.name !== entry.name
      || registration?.source !== 'bundled') {
    throw new DshDeveloperError('GENERATED_TEST_FAILED', 'Generated native DSH skill registration assertions failed.')
  }
  return { invoked: true, skill: registration.name }
}

export async function smokeDshInstall(root, pluginName, packageName, invocation, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-developer-smoke-'))
  const loadProbe = randomBytes(32).toString('hex')
  const environment = secretFreeEnvironment({
    DSH_HOME: home,
    DSH_DEVELOPER_LOAD_PROBE: loadProbe,
    DSH_PERMISSION_MODE: 'read-only',
    npm_config_offline: 'true',
    npm_config_ignore_scripts: 'true',
  })
  const invoke = options.runDsh ?? runDsh
  let success = false
  try {
    await invoke(invocation, ['plugin', '--profile', SMOKE_PROFILE, 'add', root, '--offline', '--ignore-scripts'], {
      cwd: home,
      env: environment,
      signal: options.signal,
      label: 'clean-profile DSH install',
    })
    const installed = await invoke(invocation, ['--profile', SMOKE_PROFILE, '--dump-config'], {
      cwd: home,
      env: environment,
      signal: options.signal,
      label: 'clean-profile DSH discovery',
    })
    const idPattern = new RegExp('^\\s*- id:\\s*' + pluginName.replace(/[$^.*+?{}()|[\]\\]/gu, '\\$&') + '\\s*$', 'mu')
    if (!idPattern.test(installed.stdout)) {
      throw new DshDeveloperError(
        'DSH_DISCOVERY_FAILED',
        'DSH installed the package but its bundle row was not discovered.',
        { smokeHome: home, pluginName },
      )
    }
    await invoke(invocation, ['--profile', SMOKE_PROFILE], {
      cwd: home,
      env: environment,
      signal: options.signal,
      label: 'clean-profile DSH plugin load',
    })
    const witnessed = await readFile(join(home, LOAD_WITNESS_FILENAME), 'utf8').catch(() => undefined)
    if (witnessed !== loadProbe + '\n') {
      throw new DshDeveloperError(
        'DSH_LOAD_WITNESS_MISSING',
        'DSH exited without the expected dsh-developer registration witness.',
        { smokeHome: home, pluginName },
      )
    }
    await invoke(invocation, ['plugin', '--profile', SMOKE_PROFILE, 'remove', packageName], {
      cwd: home,
      env: environment,
      signal: options.signal,
      label: 'clean-profile DSH uninstall',
    })
    const removed = await invoke(invocation, ['--profile', SMOKE_PROFILE, '--dump-config'], {
      cwd: home,
      env: environment,
      signal: options.signal,
      label: 'clean-profile DSH post-uninstall check',
    })
    if (idPattern.test(removed.stdout)) {
      throw new DshDeveloperError(
        'DSH_UNINSTALL_FAILED',
        'The plugin bundle row remains after clean-profile uninstall.',
        { smokeHome: home, pluginName },
      )
    }
    success = true
    return {
      installed: true,
      discovered: true,
      loaded: true,
      loadWitness: 'registration-nonce',
      uninstalled: true,
    }
  } catch (error) {
    if (error instanceof DshDeveloperError) {
      error.details = { ...error.details, smokeHome: home }
    }
    throw error
  } finally {
    if (success || options.retainOnFailure === false) {
      await rm(home, { recursive: true, force: true })
    }
  }
}
