import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DshDeveloperError, asDiagnostic } from './errors.js'
import { assertOfficialDshInvocation } from './dsh-installation.js'
import { inspectProject } from './project.js'
import { resolveDshInvocation, runDsh, secretFreeEnvironment } from './runtime.js'
import { findSecrets, redactSensitiveOutput } from './security.js'
import { createDevelopmentBrowserHandoff } from './development-browser.js'

// Cordis replaces a row's whole config. Keep automatic browser opening off
// explicitly: replacing printUrl alone discards the --no-open binding.
const BACKGROUND_WEB_PATCH = '- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: false\n'

const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u
const MAX_CASE_BYTES = 128 * 1024

/** Case data exercises real global tools; it cannot request an approval override or supply a fake Agent. */
export function validateToolCases(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new DshDeveloperError('DEVELOPMENT_CASES_INVALID', 'Provide 1–32 native tool cases.')
  }
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).some(key => !['name', 'tool', 'arguments', 'expected', 'isError', 'resultPath', 'maxResultBytes'].includes(key))
        || (item.name !== undefined && (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 128
          || /[\u0000-\u001f\u007f-\u009f]/u.test(item.name)))
        || typeof item.tool !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(item.tool)
        || !item.arguments || typeof item.arguments !== 'object' || Array.isArray(item.arguments)
        || (item.isError !== undefined && typeof item.isError !== 'boolean')
        || (item.maxResultBytes !== undefined && (!Number.isSafeInteger(item.maxResultBytes) || item.maxResultBytes < 1))
        || (item.resultPath !== undefined && (typeof item.resultPath !== 'string' || item.resultPath.length > 512
          || !/^(?:\/(?:[^~]|~[01])*)?$/u.test(item.resultPath)))) {
      throw new DshDeveloperError('DEVELOPMENT_CASES_INVALID', 'Each case needs a tool and argument object; maxResultBytes must be a positive safe integer when supplied.')
    }
    if (!Object.hasOwn(item, 'expected') && item.isError !== true) {
      throw new DshDeveloperError('DEVELOPMENT_CASES_INVALID', 'A successful case needs an expected canonical value.')
    }
  }
  return value
}

/** Accept only a consistent prefix of this invocation's requested cases. */
export function validVerificationReceipt(value, cases, workspace) {
  if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean' || typeof value.complete !== 'boolean'
      || !['startup', 'agent-setup', 'cases', 'agent-dispose', 'complete'].includes(value.phase)
      || value.caseCount !== cases.length || !Array.isArray(value.cases) || value.cases.length > cases.length
      || !value.cases.every((item, index) => item?.index === index + 1 && item.tool === cases[index].tool
        && item.name === cases[index].name && typeof item.passed === 'boolean')) return false
  if (['error', 'cleanupError'].some(key => Object.hasOwn(value, key)
    && (typeof value[key] !== 'string' || value[key].length > 2048))) return false
  if (['startup', 'agent-setup'].includes(value.phase) && (value.cases.length || value.activeCase !== null)) return false
  if (workspace === undefined) {
    if (value.agent !== undefined || ['agent-setup', 'agent-dispose'].includes(value.phase)) return false
  } else if (value.agent !== undefined) {
    if (!value.agent || typeof value.agent.id !== 'string' || !value.agent.id
        || !(value.agent.preset === null || typeof value.agent.preset === 'string')) return false
  } else if (['cases', 'agent-dispose', 'complete'].includes(value.phase)) return false
  if (value.complete) {
    return value.phase === 'complete' && value.cases.length === cases.length && value.activeCase === null
      && !Object.hasOwn(value, 'error') && !Object.hasOwn(value, 'cleanupError')
      && value.ok === value.cases.every(item => item.passed)
  }
  if (value.ok || value.phase === 'complete') return false
  if (value.activeCase === null) return true
  const next = cases[value.cases.length]
  return Boolean(next && value.activeCase?.index === value.cases.length + 1
    && value.activeCase.tool === next.tool && value.activeCase.name === next.name)
}

async function verificationWorkspace(path) {
  if (path === undefined) return undefined
  if (typeof path === 'string' && path.trim() && !path.includes('\0')) {
    const physical = await realpath(resolve(path)).catch(() => undefined)
    if (physical && (await lstat(physical)).isDirectory()) return physical
  }
  throw new DshDeveloperError('DEVELOPMENT_WORKSPACE_INVALID', '--workspace must select an existing directory for the verification Agent.')
}

async function readCases(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CASE_BYTES) {
    throw new DshDeveloperError('DEVELOPMENT_CASES_INVALID', 'Tool cases must be a bounded ordinary JSON file.')
  }
  const text = await readFile(path, 'utf8')
  if (Buffer.byteLength(text) > MAX_CASE_BYTES || findSecrets(text).length) {
    throw new DshDeveloperError('DEVELOPMENT_CASES_INVALID', 'Tool cases exceed the size limit or contain possible credentials.')
  }
  try { return validateToolCases(JSON.parse(text)) } catch (error) {
    if (error instanceof DshDeveloperError) throw error
    throw new DshDeveloperError('DEVELOPMENT_CASES_INVALID', 'Tool cases are not valid JSON.')
  }
}

async function selectPatch(path) {
  if (path === undefined) return undefined
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) {
    throw new DshDeveloperError('DEVELOPMENT_PATCH_INVALID', 'patchPath (--patch) must select one readable ordinary file.')
  }
  const selected = resolve(path)
  try {
    const info = await lstat(selected)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('not an ordinary file (symlinks are not supported)')
    await access(selected, constants.R_OK)
  } catch (error) {
    throw new DshDeveloperError('DEVELOPMENT_PATCH_INVALID', 'Cannot use --patch ' + JSON.stringify(selected) + ': '
      + (error.code ?? error.message) + '. Select a readable ordinary Cordis patch file.')
  }
  // Keep the original location: native DSH owns overlay parsing and path semantics.
  return selected
}

function overlayFailure(error, patchPath, phase) {
  if (!patchPath || error.code !== 'COMMAND_EXITED') return error
  const diagnostic = asDiagnostic(error)
  for (const key of ['message', 'stdout', 'stderr']) {
    if (typeof diagnostic[key] === 'string') diagnostic[key] = redactSensitiveOutput(diagnostic[key])
  }
  const output = diagnostic.stderr?.trim() || diagnostic.stdout?.trim() || ''
  const detail = output.split('\n').find(line => /^(?:\w*Error:|dsh:)/u.test(line.trim())) ?? diagnostic.message
  const { code, message, ...details } = diagnostic
  return new DshDeveloperError(code, 'DSH ' + phase + ' failed with the selected --patch overlay: '
    + detail.slice(0, 2000), details)
}

async function prepare(source, options) {
  const profile = options.profile ?? 'developer-test'
  if (!PROFILE_NAME.test(profile)) throw new DshDeveloperError('DEVELOPMENT_PROFILE_INVALID', 'Use a simple profile name.')
  if (options.signal?.aborted) throw new DshDeveloperError('CANCELLED', 'Development was cancelled before preparation.')
  const patchPath = await selectPatch(options.patchPath)
  const selected = await realpath(resolve(source))
  const info = await lstat(selected)
  if (!info.isDirectory() && !(info.isFile() && selected.endsWith('.tgz'))) {
    throw new DshDeveloperError('DEVELOPMENT_SOURCE_INVALID', 'Select a plugin directory or packed .tgz artifact.')
  }
  const project = info.isDirectory() ? await inspectProject(selected, { signal: options.signal }) : undefined
  if (project && (project.project.root !== selected || project.project.kind !== 'plugin')) {
    throw new DshDeveloperError('DEVELOPMENT_SOURCE_INVALID', 'Select the package directory declaring dsh.bundle; use project scripts for upstream work.')
  }
  const invocation = await resolveDshInvocation(options.dshPath)
  const installed = await assertOfficialDshInvocation(invocation)
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-developer-dev-')))
  const environment = secretFreeEnvironment({
    DSH_HOME: home, npm_config_ignore_scripts: 'true',
    npm_config_cache: join(home, 'npm-cache'), npm_config_store_dir: join(home, 'pnpm-store'),
    npm_config_offline: options.online ? 'false' : 'true',
  })
  const state = { source: selected, project: project?.project ?? null, home, profile, invocation, environment, patchPath,
    patchArgs: patchPath === undefined ? [] : ['--patch', patchPath],
    runtime: { version: installed.value.version, path: invocation.displayPath }, installed: false }
  try {
    // Plugin installation creates a shipped template or a base-backed custom profile.
    // pnpm 11 ignores npm_config_store_dir; pass its native option explicitly.
    await runDsh(invocation, ['plugin', '--profile', profile, 'add', selected, '--ignore-scripts',
      '--store-dir', join(home, 'pnpm-store'), ...(options.online ? [] : ['--offline'])], {
      cwd: home, env: environment, signal: options.signal, timeoutMs: options.timeoutMs ?? 120_000, diagnosticOutput: true, protectOutput: true,
    })
    await runDsh(invocation, ['--profile', profile, ...state.patchArgs, '--dump-config'], {
      cwd: home, env: environment, signal: options.signal, diagnosticOutput: true, protectOutput: true,
    }).catch(error => { throw overlayFailure(error, patchPath, 'configuration preparation') })
    state.installed = true
    return state
  } catch (error) {
    await rm(home, { recursive: true, force: true })
    throw error
  }
}

function safeDiagnostic(error) {
  const diagnostic = asDiagnostic(error)
  return findSecrets(JSON.stringify(diagnostic)).length
    ? { code: error.code ?? 'DEVELOPMENT_FAILED', message: 'Development failed; output withheld because it may contain credentials.' }
    : diagnostic
}

/** Execute a trusted plugin and optional patchPath overlay through native DSH in a disposable profile. */
export async function verifyDevelopmentPlugin(source, options = {}) {
  const workspace = await verificationWorkspace(options.workspacePath)
  const cases = await readCases(resolve(options.casesPath))
  const state = await prepare(source, options)
  const casesPath = join(state.home, 'cases.json')
  const resultPath = join(state.home, 'result.json')
  const bootPath = join(state.home, 'boot-complete')
  const patchPath = join(state.home, 'verification.patch.yml')
  // The shipped headless application otherwise requires and executes a model task.
  // These are the same ordinary rows disabled by upstream's native tool fixtures.
  const disabledApplicationEntries = state.profile === 'headless' ? ['headless-startup', 'headless-runner'] : []
  const appArgs = state.profile === 'web' ? ['--port', '0', '--no-open'] : []
  let executionError
  let patchReload
  try {
    // A one-shot verifier needs initial patch composition, not live reload.
    // New DSH launchers declare this supported lifecycle setting themselves;
    // leave older profile formats alone instead of guessing launcher flags.
    const manifestPath = join(state.home, 'profiles', state.profile, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.dsh?.profile?.patchReload === 'live') {
      manifest.dsh.profile.patchReload = 'startup'
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    }
    patchReload = manifest.dsh?.profile?.patchReload
    await writeFile(casesPath, JSON.stringify(cases), { flag: 'wx', mode: 0o600 })
    await writeFile(patchPath, (state.profile === 'web' ? BACKGROUND_WEB_PATCH : '')
      + disabledApplicationEntries.map(id => '- id: ' + id + '\n  disabled: true\n').join('')
      + '- insert:\n    - id: dsh-developer-verification\n      name: '
      + JSON.stringify(new URL('./development-probe.js', import.meta.url).href) + '\n', { flag: 'wx' })
    try {
      const invocation = { ...state.invocation,
        prefixArgs: [fileURLToPath(new URL('./development-launch.js', import.meta.url)), ...state.invocation.prefixArgs] }
      await runDsh(invocation, ['--profile', state.profile, ...state.patchArgs, '--patch', patchPath, ...appArgs], {
        cwd: state.home, signal: options.signal, timeoutMs: options.timeoutMs ?? 60_000, diagnosticOutput: true, protectOutput: true,
        // Windows taskkill cannot reliably reap descendants after the leader
        // exits. Only POSIX verification owns post-exit process-group cleanup.
        cleanupProcessGroupOnExit: process.platform !== 'win32',
        env: { ...state.environment, DSH_DEVELOPER_CASES: casesPath, DSH_DEVELOPER_CASE_RESULT: resultPath,
          DSH_DEVELOPER_BOOT_COMPLETE: bootPath,
          ...(workspace === undefined ? {} : { DSH_DEVELOPER_VERIFY_WORKSPACE: workspace }) },
      })
    } catch (error) {
      executionError = safeDiagnostic(overlayFailure(error, state.patchPath, 'verification boot'))
    }
    const stat = await lstat(resultPath).catch(() => undefined)
    let result
    if (stat?.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_CASE_BYTES) {
      const text = await readFile(resultPath, 'utf8')
      if (!findSecrets(text).length) {
        try {
          const parsed = JSON.parse(text)
          if (validVerificationReceipt(parsed, cases, workspace)) result = parsed
        } catch { /* Missing evidence is a failure below. */ }
      }
    }
    // The probe intentionally exits 1 after writing a complete failed-case
    // receipt. This is a verification verdict, not an overlay/startup failure.
    if (executionError?.code === 'COMMAND_EXITED' && executionError.exitCode === 1
        && executionError.exitSignal === null && result?.complete === true && result.ok === false
        && Array.isArray(result.cases) && result.cases.length === cases.length
        && result.cases.every((item, index) => item?.tool === cases[index].tool && typeof item.passed === 'boolean')
        && result.cases.some(item => item.passed === false)) {
      const failedCases = result.cases.filter(item => item.passed === false).length
      executionError = { ...executionError, code: 'DEVELOPMENT_CASES_FAILED',
        message: 'Native tool verification completed; ' + failedCases + ' of ' + cases.length + ' cases failed.',
        failedCases, caseCount: cases.length }
    }
    const complete = result?.complete === true
    const ok = !executionError && complete && result.ok === true
    const report = { kind: 'dsh-development-verification', ok, complete, caseCount: cases.length,
      phase: result?.phase ?? 'startup',
      ...(workspace === undefined ? {} : { workspace }),
      ...(result?.agent ? { agent: { id: result.agent.id, preset: result.agent.preset, workspace } } : {}),
      activeCase: result?.activeCase ?? null, source: state.source, runtime: state.runtime,
      profile: state.profile, installed: state.installed, cases: result?.cases ?? [],
      ...(patchReload === undefined ? {} : { patchReload }),
      ...(disabledApplicationEntries.length ? { disabledApplicationEntries } : {}),
      ...(executionError || result?.error || !complete ? { diagnostic: executionError ?? {
        code: 'DEVELOPMENT_INCOMPLETE', message: result?.error ?? 'No complete native verification receipt was received.',
      } } : {}),
      ...(result?.error ? { invocationError: result.error } : {}),
      ...(result?.cleanupError ? { cleanupError: result.cleanupError } : {}),
      execution: 'explicit host execution of trusted source; not an isolation or adversarial attestation',
      processCleanup: {
        platform: process.platform,
        afterLeaderExit: process.platform === 'win32'
          ? 'No post-exit descendant cleanup. The plugin must stop and await its workers before normal exit.'
          : 'Attempt SIGTERM on the owned process group, then SIGKILL after 750 ms; await this termination sequence.',
        limitation: process.platform === 'win32'
          ? 'Cancellation and timeout attempt taskkill /T; descendants cannot reliably be found after their leader exits.'
          : 'Processes outside the owned group and OS reaping are not verified; this is not proof that every descendant exited.',
      },
      scope: result?.scope ?? 'No successful native invocation evidence.', cleanup: 'disposable profile removed' }
    if (executionError?.code === 'CANCELLED') {
      throw new DshDeveloperError('CANCELLED', 'Development verification was cancelled.', { verification: report })
    }
    return report
  } finally {
    await rm(state.home, { recursive: true, force: true })
  }
}

/** Boot a trusted plugin and optional patchPath overlay; stop removes the temporary Web profile. */
export async function runDevelopmentServer(source, options = {}) {
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw new DshDeveloperError('DEVELOPMENT_PORT_INVALID', 'port must be an integer from 1 to 65535.')
  }
  const state = await prepare(source, { ...options, profile: 'web' })
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const resultPath = join(state.home, 'server.json')
  const patchPath = join(state.home, 'server.patch.yml')
  const token = randomBytes(24).toString('hex')
  let outcome, running, url, server, closeHandoff, exited
  try {
    const workspace = state.project?.root ?? join(state.home, 'workspace')
    if (!state.project) await mkdir(workspace)
    await writeFile(patchPath, BACKGROUND_WEB_PATCH
      + '- insert:\n    - id: dsh-developer-server-observer\n      name: '
      + JSON.stringify(new URL('./development-server-probe.js', import.meta.url).href) + '\n', { flag: 'wx' })
    running = runDsh(state.invocation, ['--profile', 'web', ...state.patchArgs, '--patch', patchPath, '--port', String(options.port ?? 0), '--no-open'], {
      cwd: state.project?.root ?? state.home, env: { ...state.environment, DSH_DEVELOPER_SERVER_TOKEN: token,
        DSH_DEVELOPER_SERVER_RESULT: resultPath, DSH_DEVELOPER_WORKSPACE: workspace },
      signal, timeoutMs: options.timeoutMs ?? 0, outputMode: 'tail', diagnosticOutput: true, protectOutput: true,
      abortDrainTimeoutMs: 1000,
      onExit: status => {
        exited = status
        void closeHandoff?.().catch(() => {})
        // After readiness, request owned cleanup when the server exits. A child
        // retaining inherited log pipes must not keep dev or its browser alive.
        if (closeHandoff) controller.abort()
      },
    }).then(value => { outcome = { value } }, error => { outcome = { error: overlayFailure(error, state.patchPath, 'Web boot') } })
    const deadline = Date.now() + 30_000
    while (true) {
      if (signal.aborted) throw new DshDeveloperError('CANCELLED', 'Development server was cancelled.')
      if (outcome) throw outcome.error ?? new DshDeveloperError('DEVELOPMENT_SERVER_EXITED', 'DSH exited before the Web server was ready.')
      if (exited) throw new DshDeveloperError('DEVELOPMENT_SERVER_EXITED', 'DSH exited before the Web server was ready.',
        { exitCode: exited.code, exitSignal: exited.signal })
      if (Date.now() > deadline) throw new DshDeveloperError('DEVELOPMENT_SERVER_TIMEOUT', 'DSH did not publish a ready Web endpoint.')
      try {
        if (!url) {
          const info = await lstat(resultPath)
          if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('Invalid server observation.')
          const text = await readFile(resultPath, 'utf8')
          if (Buffer.byteLength(text) > 8192) throw new Error('Invalid server observation.')
          server = JSON.parse(text)
          if (server.token !== token) throw new Error('Unexpected server observation.')
          if (Object.hasOwn(server, 'error')) {
            if (server.kind !== 'dsh-development-server-private' || server.version !== 1
                || typeof server.error !== 'string' || !server.error.trim() || server.error.length > 1024) {
              throw new Error('Invalid server failure observation.')
            }
            throw new DshDeveloperError('DEVELOPMENT_SERVER_STARTUP_FAILED', redactSensitiveOutput(server.error))
          }
          if (server.host !== '127.0.0.1' || !Number.isInteger(server.port)
              || server.port < 1 || server.port > 65535 || (options.port !== undefined && server.port !== options.port)) {
            throw new Error('Unexpected server observation.')
          }
          const parsed = new URL(server.url)
          if (parsed.origin !== 'http://127.0.0.1:' + server.port || parsed.pathname !== '/' || parsed.username || parsed.password) {
            throw new Error('Unexpected development URL.')
          }
          url = parsed.href
        }
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(500)])
        let response = await fetch(url, { signal: requestSignal, redirect: 'manual' })
        if (response.status === 303 && response.headers.get('location') === '/') {
          const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
          await response.body?.cancel()
          if (!cookie) throw new Error('DSH did not complete its browser authentication exchange.')
          response = await fetch(new URL('/', url), { headers: { cookie }, signal: requestSignal, redirect: 'error' })
        }
        await response.body?.cancel()
        if (response.ok) break
      } catch (error) {
        if (error?.code === 'DEVELOPMENT_SERVER_STARTUP_FAILED') throw error
        // Wait for a complete valid observation, bounded by startup and cancellation.
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const browserUrl = new URL('/', url).href
    closeHandoff = await createDevelopmentBrowserHandoff(state.home, { nonce: token, loginUrl: url,
      isRunning: () => !exited && !outcome && !signal.aborted })
    if (signal.aborted) throw new DshDeveloperError('CANCELLED', 'Development server was cancelled before Web readiness.')
    if (exited || outcome) {
      throw new DshDeveloperError('DEVELOPMENT_SERVER_EXITED', 'DSH exited before the Web server was ready.')
    }
    await options.onReady?.({ kind: 'dsh-development-server', ok: true, url: browserUrl, source: state.source,
      runtime: state.runtime, profile: 'web', home: state.home, pid: server.pid, pidOwnership: 'calling terminal',
      workspace: server.workspace,
      ui: { operation: 'open', developmentServer: state.home },
      note: 'HTTP readiness only; inspect the rendered plugin through the browser before claiming UI success.' })
    await running
    if (outcome.error && outcome.error.code !== 'CANCELLED') throw outcome.error
    if (exited && exited.code !== 0 && !options.signal?.aborted) {
      throw new DshDeveloperError('DEVELOPMENT_SERVER_EXITED', 'DSH exited after Web readiness.',
        { exitCode: exited.code, exitSignal: exited.signal })
    }
    const output = outcome.error?.details?.output ?? outcome.value?.output
    return { ok: true, stopped: true, cleanup: 'disposable profile removed',
      ...(output?.incomplete ? { output } : {}) }
  } catch (error) {
    if (!['DEVELOPMENT_SERVER_TIMEOUT', 'DEVELOPMENT_SERVER_STARTUP_FAILED', 'DEVELOPMENT_SERVER_EXITED', 'CANCELLED'].includes(error?.code)) throw error
    // Stop first so protected tails include shutdown output and a PEM marker
    // on either stream cannot arrive after diagnostics have been disclosed.
    controller.abort()
    await running
    const captured = outcome?.error?.details ?? outcome?.value ?? {}
    const details = Object.fromEntries(['stdout', 'stderr', 'output', 'exitCode', 'exitSignal']
      .filter(key => Object.hasOwn(captured, key)).map(key => [key, captured[key]]))
    if (options.signal?.aborted) {
      throw new DshDeveloperError('CANCELLED', 'Development server was cancelled.', details)
    }
    if (error.code === 'DEVELOPMENT_SERVER_TIMEOUT' || error.code === 'DEVELOPMENT_SERVER_EXITED') {
      const logs = [details.stderr, details.stdout].filter(value => typeof value === 'string' && value.trim())
      const line = logs.flatMap(value => value.split('\n')).find(value => /\b(?:\w*Error:|dsh:)/u.test(value))
        ?? logs[0]?.trim()
      if (line) error.message += ' Last process diagnostic: ' + line.slice(0, 2000)
    }
    error.details = { ...error.details, ...details }
    throw error
  } finally {
    controller.abort()
    try { await closeHandoff?.() } finally {
      await running
      await rm(state.home, { recursive: true, force: true })
    }
  }
}

export function formatDevelopmentReport(report) {
  const lines = [`${report.ok ? 'PASS' : 'FAIL'} DSH ${report.runtime?.version ?? ''} ${report.profile ?? ''}`]
  if (typeof report.workspace === 'string') lines.push('Verification workspace: ' + report.workspace)
  if (report.agent) lines.push('Agent: ' + report.agent.id + (report.agent.preset === null ? '' : '; preset ' + report.agent.preset))
  if (report.url) lines.push(report.url)
  if (report.ui) lines.push('dsh_ui ' + JSON.stringify(report.ui))
  if (report.stopped) lines.push('Development server stopped.')
  if (report.output?.incomplete) {
    lines.push('WARNING: ' + (report.output.incompleteReason
      ?? 'Process output did not finish draining; descendant cleanup is unverified.'))
  }
  for (const item of report.cases ?? []) {
    const size = item.resultBytes === undefined ? '' : ` (${item.resultBytes} result bytes`
      + (item.maxResultBytes === undefined ? ')' : `; limit ${item.maxResultBytes})`)
    const detail = item.outputLimitExceeded ? 'output budget exceeded'
      : item.valueOmitted ? 'canonical value omitted from report; compared in full'
        : JSON.stringify(item.value ?? item.content) ?? 'result fields omitted'
    const label = (item.index === undefined ? '' : `#${item.index} `) + item.tool
      + (item.name === undefined ? '' : ' ' + JSON.stringify(item.name))
    lines.push(`${item.passed ? 'PASS' : 'FAIL'} ${label}${size}: ${detail}`)
    const reasons = {
      'unexpected-error': 'Tool returned an error; expected success.',
      'expected-error': 'Tool succeeded; expected an error.',
      'missing-result-path': 'Selected resultPath is missing; missing is not null.',
      'value-mismatch': 'Canonical value does not match expected.',
      'result-budget-exceeded': 'Complete tool response exceeds maxResultBytes.',
    }
    for (const reason of item.failures ?? []) lines.push('  ' + (reasons[reason] ?? reason))
    if (Object.hasOwn(item, 'resultPath')) lines.push('  resultPath: ' + JSON.stringify(item.resultPath))
    if (Object.hasOwn(item, 'expected')) lines.push('  expected: ' + JSON.stringify(item.expected))
    if (item.expectedOmitted) lines.push('  expected: omitted from report; compared in full')
  }
  if (report.complete === false) {
    lines.push(`INCOMPLETE: ${report.cases.length} of ${report.caseCount} cases returned results.`
      + (report.phase ? ' Phase: ' + report.phase + '.' : ''))
    if (report.activeCase) lines.push('Interrupted during #' + report.activeCase.index + ' ' + report.activeCase.tool
      + (report.activeCase.name === undefined ? '' : ' ' + JSON.stringify(report.activeCase.name)))
  }
  if (report.invocationError) lines.push('Verification: ' + report.invocationError)
  if (report.cleanupError) lines.push('Agent cleanup: ' + report.cleanupError)
  if (report.diagnostic) lines.push(report.diagnostic.code + ': ' + report.diagnostic.message)
  if (report.disabledApplicationEntries?.length) lines.push('Verification disables: ' + report.disabledApplicationEntries.join(', '))
  if (report.scope) lines.push(report.scope)
  if (report.processCleanup) {
    lines.push('Process cleanup (' + report.processCleanup.platform + '): ' + report.processCleanup.afterLeaderExit)
    lines.push(report.processCleanup.limitation)
  }
  if (report.cleanup) lines.push(report.cleanup)
  return lines.join('\n')
}
