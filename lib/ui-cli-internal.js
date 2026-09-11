import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  unlink,
} from 'node:fs/promises'
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { LIMITS } from './constants.js'
import { DshDeveloperError } from './errors.js'
import { runBounded, secretFreeEnvironment } from './runtime.js'
import { assertNoSecrets, findSecrets, redactSensitiveOutput } from './security.js'
import { isUiLoopbackUrl } from './ui-policy.js'
import { DEVELOPMENT_SERVER_ENV, readDevelopmentBrowserTarget } from './development-browser.js'

import { loadUiConfiguration } from './ui-configuration.js'
export { PLAYWRIGHT_CLI_CONTRACT_VERSION, UI_CLI_ENVIRONMENT, uiCliConfigurationRequested, uiCliConfigurationAvailable } from './ui-configuration.js'
export const UI_CLI_OPERATIONS = Object.freeze([
  'status',
  'open',
  'navigate',
  'snapshot',
  'find',
  'fill',
  'click',
  'press',
  'select',
  'check',
  'uncheck',
  'hover',
  'resize',
  'wait',
  'screenshot',
  'console',
  'requests',
  'close',
])

const OPERATION_FIELDS = Object.freeze({
  status: new Set(),
  open: new Set(['url', 'developmentServer']),
  navigate: new Set(['url']),
  snapshot: new Set(['target', 'depth']),
  find: new Set(['text']),
  fill: new Set(['target', 'text']),
  click: new Set(['target']),
  press: new Set(['key']),
  select: new Set(['target', 'text']),
  check: new Set(['target']),
  uncheck: new Set(['target']),
  hover: new Set(['target']),
  resize: new Set(['width', 'height']),
  wait: new Set(['text', 'timeoutMs']),
  screenshot: new Set(['target']),
  console: new Set(),
  requests: new Set(),
  close: new Set(),
})
const REQUIRED_FIELDS = Object.freeze({
  status: [],
  open: [],
  navigate: ['url'],
  snapshot: [],
  find: ['text'],
  fill: ['target', 'text'],
  click: ['target'],
  press: ['key'],
  select: ['target', 'text'],
  check: ['target'],
  uncheck: ['target'],
  hover: ['target'],
  resize: ['width', 'height'],
  wait: ['text'],
  screenshot: [],
  console: [],
  requests: [],
  close: [],
})
const TARGET_PATTERN = /^e[1-9][0-9]{0,5}$/u
const SAFE_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])
const MAX_OUTPUT_FILES = 64
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const COMMAND_OUTPUT_BYTES = 64 * 1024
const INLINE_PAGE_BYTES = LIMITS.longTextChars

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    )
  }
  return value
}

function digest(value) {
  return 'sha256:' + createHash('sha256')
    .update(JSON.stringify(stableValue(value)), 'utf8')
    .digest('hex')
}

function inputError(message) {
  throw new DshDeveloperError('UI_INPUT_INVALID', message)
}

function boundedString(value, field, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximum) {
    inputError(field + ' must be ' + (allowEmpty ? 'a' : 'a non-empty') + ' string of at most ' + maximum + ' characters.')
  }
  assertNoSecrets(value, 'UI ' + field)
  return value
}

export function parseUiCliInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    inputError('UI input must be one object.')
  }
  const operation = value.operation
  if (typeof operation !== 'string' || !UI_CLI_OPERATIONS.includes(operation)) {
    inputError('operation must be one supported UI action.')
  }
  const allowed = OPERATION_FIELDS[operation]
  for (const key of Object.keys(value)) {
    if (key !== 'operation' && !allowed.has(key)) inputError(operation + ' does not accept ' + key + '.')
  }
  for (const key of REQUIRED_FIELDS[operation]) {
    if (value[key] === undefined) inputError(operation + ' requires ' + key + '.')
  }
  const input = { operation }
  if (operation === 'open' && (value.url === undefined) === (value.developmentServer === undefined)) {
    inputError('open requires exactly one of url or developmentServer.')
  }
  if (value.developmentServer !== undefined) {
    const home = value.developmentServer
    if (typeof home !== 'string' || home.length > 2_048 || !isAbsolute(home)) {
      inputError('developmentServer must be the absolute home returned by dev.')
    }
    // OS temporary-directory names can have high entropy. This is only a
    // filesystem selector; the private-directory and live-owner checks follow.
    if (findSecrets(home).some(kind => kind !== 'high-entropy-token')) assertNoSecrets(home, 'developmentServer')
    input.developmentServer = home
  }
  if (value.url !== undefined) {
    const url = boundedString(value.url, 'url', 2_048)
    if (!isUiLoopbackUrl(url)) inputError('url must be about:blank or an explicit HTTP(S) loopback URL without credentials.')
    input.url = url
  }
  if (value.target !== undefined) {
    const target = boundedString(value.target, 'target', 16)
    if (!TARGET_PATTERN.test(target)) inputError('target must be an exact element ref such as e12.')
    input.target = target
  }
  if (value.text !== undefined) {
    input.text = boundedString(value.text, 'text', operation === 'fill' ? 2_000 : 240, operation === 'fill')
  }
  if (value.key !== undefined) {
    const key = boundedString(value.key, 'key', 20)
    if (key.length !== 1 && !SAFE_KEYS.has(key)) inputError('key must be one character or a supported navigation key.')
    input.key = key
  }
  if (value.depth !== undefined) {
    if (!Number.isSafeInteger(value.depth) || value.depth < 1 || value.depth > 10) {
      inputError('depth must be an integer from 1 through 10.')
    }
    input.depth = value.depth
  }
  if (value.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 250 || value.timeoutMs > 10_000) {
      inputError('timeoutMs must be an integer from 250 through 10000.')
    }
    input.timeoutMs = value.timeoutMs
  }
  if (value.width !== undefined) {
    if (!Number.isSafeInteger(value.width) || value.width < 320 || value.width > 1_920) {
      inputError('width must be an integer from 320 through 1920.')
    }
    input.width = value.width
  }
  if (value.height !== undefined) {
    if (!Number.isSafeInteger(value.height) || value.height < 240 || value.height > 1_080) {
      inputError('height must be an integer from 240 through 1080.')
    }
    input.height = value.height
  }
  return input
}

async function safeDirectory(path) {
  await mkdir(path, { recursive: true })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new DshDeveloperError('UI_ROOT_INVALID', 'The UI CLI root must be an ordinary directory.')
  }
  return realpath(path)
}

export async function resolveUiCliConfiguration(environment = process.env) {
  const configuration = await loadUiConfiguration(environment)
  configuration.root = await safeDirectory(configuration.root)
  configuration.evidenceRoot = await safeDirectory(join(configuration.root, 'evidence'))
  configuration.evidenceDigest = digest(configuration)
  return Object.freeze(configuration)
}

export function uiCliSessionIdentity(value) {
  const raw = boundedString(value, 'session identity', 128)
  const hex = createHash('sha256').update(raw, 'utf8').digest('hex')
  return Object.freeze({
    internal: 'dshdev-' + hex.slice(0, 24),
    digest: 'sha256:' + hex,
  })
}

function parseProviderJson(stdout) {
  const text = stdout.trim()
  if (text.length === 0) throw new DshDeveloperError('UI_CLI_PROTOCOL_INVALID', 'Playwright CLI returned no JSON.')
  try {
    return JSON.parse(text)
  } catch {
    throw new DshDeveloperError('UI_CLI_PROTOCOL_INVALID', 'Playwright CLI returned malformed JSON.')
  }
}

function publicProviderValue(value, options = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const clone = structuredClone(value)
  delete clone.session
  delete clone.pid
  if (options.omitSnapshot) {
    delete clone.snapshot
    if (clone.result !== null && typeof clone.result === 'object' && !Array.isArray(clone.result)) {
      delete clone.result.snapshot
    }
  }
  return clone
}

function artifactStrings(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) artifactStrings(item, found)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'file' || key === 'path') && typeof item === 'string') found.push(item)
      else artifactStrings(item, found)
    }
  }
  return found
}

function screenshotArtifactStrings(value) {
  const result = value?.result
  if (typeof result !== 'string') return []
  const match = result.match(/^- \[Screenshot of (?:viewport|element)\]\(([^)\r\n]+)\)$/u)
  return match === null ? [] : [match[1]]
}

function artifactNamesForInspection(value, verifiedNames) {
  if (typeof value === 'string') return verifiedNames.get(value) ?? value
  if (Array.isArray(value)) return value.map(item => artifactNamesForInspection(item, verifiedNames))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, artifactNamesForInspection(item, verifiedNames)]))
  }
  return value
}

async function validatedArtifact(outputDir, candidate, baseDirectory) {
  const absolute = resolve(baseDirectory, candidate)
  const canonical = isAbsolute(candidate) ? absolute : relative(baseDirectory, absolute)
  if (candidate !== canonical) {
    throw new DshDeveloperError('UI_ARTIFACT_INVALID', 'Playwright CLI returned a non-canonical artifact path.')
  }
  // Only the combined generated path's entropy is irrelevant. Explicit
  // credential patterns remain forbidden, including in configured directories.
  if (findSecrets(absolute).some(kind => kind !== 'high-entropy-token')) assertNoSecrets(absolute, 'UI artifact path')
  const pathFromRoot = relative(outputDir, absolute)
  if (pathFromRoot.length === 0 || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new DshDeveloperError('UI_ARTIFACT_INVALID', 'Playwright CLI returned an artifact outside its evidence directory.')
  }
  assertNoSecrets(pathFromRoot, 'UI artifact name')
  const info = await lstat(absolute).catch(() => undefined)
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new DshDeveloperError('UI_ARTIFACT_INVALID', 'Playwright CLI returned a missing or non-regular artifact.', { path: absolute })
  }
  if (info.size > MAX_OUTPUT_BYTES) {
    await unlink(absolute).catch(() => {})
    throw new DshDeveloperError('UI_ARTIFACT_LIMIT', 'A UI artifact exceeded the per-session evidence budget.')
  }
  return {
    kind: extname(absolute).slice(1).toLocaleLowerCase('en-US') || 'file',
    path: absolute,
    bytes: info.size,
  }
}

async function enforceOutputBudget(outputDir, protectedPaths = new Set()) {
  const entries = await readdir(outputDir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new DshDeveloperError('UI_ARTIFACT_INVALID', 'The UI evidence directory contains a non-file entry.', { name: entry.name })
    }
    const path = join(outputDir, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      throw new DshDeveloperError('UI_ARTIFACT_INVALID', 'The UI evidence directory contains a symbolic link.', { path })
    }
    files.push({ path, bytes: info.size, modified: info.mtimeMs })
  }
  files.sort((left, right) => left.modified - right.modified || left.path.localeCompare(right.path, 'en'))
  let bytes = files.reduce((sum, file) => sum + file.bytes, 0)
  let count = files.length
  for (const file of files) {
    if (count <= MAX_OUTPUT_FILES && bytes <= MAX_OUTPUT_BYTES) break
    if (protectedPaths.has(file.path)) continue
    await unlink(file.path)
    count -= 1
    bytes -= file.bytes
  }
  if (count > MAX_OUTPUT_FILES || bytes > MAX_OUTPUT_BYTES) {
    for (const path of protectedPaths) await unlink(path).catch(() => {})
    throw new DshDeveloperError('UI_ARTIFACT_LIMIT', 'The current UI evidence cannot fit within the per-session output budget.')
  }
  return { files: count, bytes, maximumFiles: MAX_OUTPUT_FILES, maximumBytes: MAX_OUTPUT_BYTES }
}

function findHasMatch(value) {
  const snapshot = value?.snapshot ?? value?.result?.snapshot
  if (Array.isArray(snapshot)) return snapshot.length > 0
  const result = value?.result
  if (typeof result === 'string') return /^Found [1-9][0-9]* match(?:es)? for /u.test(result)
  return false
}

function filteredStatus(value, internal) {
  const browsers = Array.isArray(value?.browsers) ? value.browsers : []
  const browser = browsers.find((candidate) => candidate?.name === internal)
  if (browser === undefined) return { status: 'closed' }
  return {
    status: browser.status === 'open' ? 'open' : String(browser.status ?? 'unknown'),
    browserType: String(browser.browserType ?? 'unknown'),
    headed: browser.headed === true,
    persistent: browser.persistent === true,
    attached: browser.attached === true,
    compatible: browser.compatible === true,
    runtimeVersion: typeof browser.version === 'string' ? browser.version : undefined,
  }
}

export class UiCliController {
  #active = new Map()
  #config
  #disposed = false
  #queues = new Map()
  #runner

  constructor(configuration, dependencies = {}) {
    this.#config = configuration
    this.#runner = dependencies.runBounded ?? runBounded
  }

  async execute(sessionId, value, options = {}) {
    if (this.#disposed) throw new DshDeveloperError('UI_CONTROLLER_DISPOSED', 'The UI controller is disposed.')
    if (options === null || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some((key) => key !== 'signal')) {
      throw new DshDeveloperError('UI_OPTIONS_INVALID', 'UI execution options accept only signal.')
    }
    const identity = uiCliSessionIdentity(sessionId)
    const input = parseUiCliInput(value)
    const prior = this.#queues.get(identity.internal) ?? Promise.resolve()
    const operation = prior.catch(() => {}).then(() => this.#executeUnlocked(identity, input, options.signal))
    this.#queues.set(identity.internal, operation)
    try {
      return await operation
    } finally {
      if (this.#queues.get(identity.internal) === operation) this.#queues.delete(identity.internal)
    }
  }

  async #outputDirectory(identity) {
    const directory = join(this.#config.evidenceRoot, identity.internal)
    await mkdir(directory, { recursive: true })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new DshDeveloperError('UI_ARTIFACT_INVALID', 'The session evidence path is not an ordinary directory.')
    }
    return directory
  }

  #environment(outputDir, development) {
    return secretFreeEnvironment({
      NO_UPDATE_NOTIFIER: '1',
      PLAYWRIGHT_MCP_ALLOWED_ORIGINS: 'localhost:*;127.0.0.1:*;[::1]:*',
      PLAYWRIGHT_MCP_BLOCK_SERVICE_WORKERS: '1',
      PLAYWRIGHT_MCP_CONSOLE_LEVEL: 'error',
      PLAYWRIGHT_MCP_EXECUTABLE_PATH: this.#config.browser,
      PLAYWRIGHT_MCP_HEADLESS: '1',
      PLAYWRIGHT_MCP_ISOLATED: '1',
      PLAYWRIGHT_MCP_OUTPUT_DIR: outputDir,
      PLAYWRIGHT_MCP_PROXY_BYPASS: 'localhost,127.0.0.1,[::1]',
      PLAYWRIGHT_MCP_PROXY_SERVER: 'http://127.0.0.1:9',
      PLAYWRIGHT_MCP_SANDBOX: '1',
      PLAYWRIGHT_MCP_TIMEOUT_ACTION: '5000',
      PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION: '15000',
      PLAYWRIGHT_MCP_VIEWPORT_SIZE: '1280x720',
      ...(development ? {
        [DEVELOPMENT_SERVER_ENV]: development.home,
        PLAYWRIGHT_MCP_INIT_PAGE: fileURLToPath(new URL('./development-browser.js', import.meta.url)),
        PLAYWRIGHT_MCP_ALLOWED_ORIGINS: development.origin,
        // Chromium's transport proxy also covers worker WebSockets, which
        // Playwright's frame routing does not. Port zero cannot be a listener.
        PLAYWRIGHT_MCP_PROXY_SERVER: 'http://127.0.0.1:0',
        PLAYWRIGHT_MCP_PROXY_BYPASS: '<-loopback>,' + new URL(development.origin).host,
      } : {}),
    })
  }

  async #invoke(identity, args, options = {}) {
    const outputDir = await this.#outputDirectory(identity)
    const cliArgs = [
      this.#config.entry,
      ...(options.global ? [] : ['-s=' + identity.internal]),
      ...args,
      '--json',
    ]
    const result = await this.#runner(process.execPath, cliArgs, {
      cwd: this.#config.root,
      env: this.#environment(outputDir, options.development),
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 20_000,
      outputLimit: COMMAND_OUTPUT_BYTES,
      label: 'protected Playwright CLI ' + args[0],
    })
    const provider = parseProviderJson(result.stdout)
    return { provider, outputDir }
  }

  async #status(identity, signal) {
    const { provider } = await this.#invoke(identity, ['list'], { global: true, signal, timeoutMs: 10_000 })
    const status = filteredStatus(provider, identity.internal)
    assertNoSecrets(JSON.stringify(status), 'Playwright CLI session status')
    if (status.status === 'open') this.#active.set(identity.internal, identity)
    else this.#active.delete(identity.internal)
    return status
  }

  #command(input) {
    if (input.operation === 'open') return ['open', input.url]
    if (input.operation === 'navigate') return ['goto', input.url]
    if (input.operation === 'find') return ['find', input.text]
    if (input.operation === 'fill') return ['fill', input.target, input.text]
    if (input.operation === 'click') return ['click', input.target]
    if (input.operation === 'press') return ['press', input.key]
    if (input.operation === 'select') return ['select', input.target, input.text]
    if (input.operation === 'check' || input.operation === 'uncheck' || input.operation === 'hover') {
      return [input.operation, input.target]
    }
    if (input.operation === 'resize') return ['resize', String(input.width), String(input.height)]
    if (input.operation === 'console') return ['console', 'error']
    if (input.operation === 'requests') return ['requests']
    return undefined
  }

  async #executeUnlocked(identity, input, signal) {
    if (input.operation === 'status') {
      return this.#report(identity, input, { provider: await this.#status(identity, signal) })
    }
    if (input.operation === 'close') {
      const status = await this.#status(identity, signal)
      if (status.status !== 'open') return this.#report(identity, input, { provider: { status: 'already-closed' } })
      const invoked = await this.#invoke(identity, ['close'], { signal, timeoutMs: 10_000 })
      this.#active.delete(identity.internal)
      return this.#finalize(identity, input, invoked)
    }
    if (input.operation === 'open') {
      const status = await this.#status(identity, signal)
      if (status.status === 'open') {
        throw new DshDeveloperError('UI_SESSION_EXISTS', 'This agent already has an open UI session; navigate or close it first.')
      }
    }

    if (input.operation === 'wait') {
      const started = Date.now()
      const timeoutMs = input.timeoutMs ?? 5_000
      let attempts = 0
      while (Date.now() - started <= timeoutMs) {
        attempts += 1
        const invoked = await this.#invoke(identity, ['find', input.text], {
          signal,
          timeoutMs: Math.min(10_000, timeoutMs + 2_000),
        })
        this.#active.set(identity.internal, identity)
        if (findHasMatch(invoked.provider)) {
          return this.#safeFinalize(identity, input, invoked, {
            wait: { matched: true, attempts, elapsedMs: Date.now() - started },
          })
        }
        const remaining = timeoutMs - (Date.now() - started)
        if (remaining <= 0) break
        try {
          await delay(Math.min(250, remaining), undefined, { signal })
        } catch (error) {
          if (signal?.aborted) throw new DshDeveloperError('CANCELLED', 'The UI wait was cancelled.')
          throw error
        }
      }
      throw new DshDeveloperError('UI_WAIT_TIMEOUT', 'The expected text did not appear before the bounded wait expired.', {
        attempts,
        timeoutMs,
      })
    }

    const development = input.developmentServer === undefined ? undefined
      : await readDevelopmentBrowserTarget(input.developmentServer)
    let args
    if (input.operation === 'snapshot') {
      args = [
        'snapshot',
        ...(input.target ? [input.target] : []),
        '--depth=' + String(input.depth ?? 6),
      ]
    } else if (input.operation === 'screenshot') {
      args = [
        'screenshot',
        ...(input.target ? [input.target] : []),
        '--type=png',
      ]
    } else {
      args = development ? ['open', development.url] : this.#command(input)
    }
    if (args === undefined) throw new DshDeveloperError('UI_INPUT_INVALID', 'The UI operation has no safe CLI mapping.')
    let invoked
    try {
      invoked = await this.#invoke(identity, args, { signal, development })
    } catch (error) {
      if (input.operation === 'open') await this.#closeQuietly(identity)
      throw error
    }
    this.#active.set(identity.internal, identity)
    return this.#safeFinalize(identity, input, invoked)
  }

  async #safeFinalize(identity, input, invoked, additions = {}) {
    try {
      return await this.#finalize(identity, input, invoked, additions)
    } catch (error) {
      await this.#closeQuietly(identity)
      throw error
    }
  }

  async #finalize(identity, input, invoked, additions = {}) {
    if ((input.operation === 'requests' || input.operation === 'console') && typeof invoked.provider?.result === 'string') {
      // Logs are observations, so withhold credential-looking lines while
      // preserving the useful remainder and the running browser session.
      invoked.provider.result = redactSensitiveOutput(invoked.provider.result)
    }
    const screenshotReferences = input.operation === 'screenshot' ? screenshotArtifactStrings(invoked.provider) : []
    const candidates = [
      ...artifactStrings(invoked.provider),
      ...screenshotReferences,
    ]
      .map((candidate) => ({ candidate, baseDirectory: this.#config.root }))
    const artifactsByPath = new Map()
    const verifiedNames = new Map()
    for (const { candidate, baseDirectory } of candidates) {
      const artifact = await validatedArtifact(invoked.outputDir, candidate, baseDirectory)
      artifactsByPath.set(artifact.path, artifact)
      verifiedNames.set(candidate, relative(invoked.outputDir, artifact.path))
    }
    for (const reference of screenshotReferences) {
      verifiedNames.set(invoked.provider.result, invoked.provider.result.replace('(' + reference + ')', '(' + verifiedNames.get(reference) + ')'))
    }
    // The session directory is generated by this controller, not page content.
    // Check verified artifact names separately so its hash plus a timestamped
    // filename cannot be mistaken for a credential. All other values stay scanned.
    assertNoSecrets(JSON.stringify(artifactNamesForInspection(invoked.provider, verifiedNames)), 'Playwright CLI result')
    const artifacts = [...artifactsByPath.values()]
    const protectedPaths = new Set(artifacts.map((artifact) => artifact.path))
    const storage = await enforceOutputBudget(invoked.outputDir, protectedPaths)
    let pageData
    if (input.operation === 'snapshot') {
      const artifact = artifacts.find((item) => item.kind === 'yaml' || item.kind === 'yml')
      const inlineSnapshot = invoked.provider?.snapshot ?? invoked.provider?.result?.snapshot
      if (artifact === undefined && inlineSnapshot === undefined) {
        throw new DshDeveloperError('UI_CLI_PROTOCOL_INVALID', 'Playwright CLI returned no accessibility snapshot.')
      }
      const content = artifact === undefined
        ? typeof inlineSnapshot === 'string'
          ? inlineSnapshot
          : JSON.stringify(inlineSnapshot, null, 2)
        : await readFile(artifact.path, 'utf8')
      assertNoSecrets(content, 'UI snapshot')
      pageData = Buffer.byteLength(content) <= INLINE_PAGE_BYTES
        ? { kind: 'accessibility-snapshot', content }
        : { kind: 'accessibility-snapshot', omitted: true, reason: 'Use find or a targeted snapshot; the full snapshot exceeds the inline budget.' }
    }
    return this.#report(identity, input, {
      provider: publicProviderValue(invoked.provider, { omitSnapshot: input.operation === 'snapshot' }),
      artifacts,
      storage,
      ...(pageData === undefined ? {} : { pageData }),
      ...(additions.wait === undefined ? {} : { wait: additions.wait }),
    })
  }

  async #closeQuietly(identity) {
    await this.#invoke(identity, ['close'], {
      signal: AbortSignal.timeout(5_000),
      timeoutMs: 5_000,
    }).catch(() => {})
    this.#active.delete(identity.internal)
  }

  #report(identity, input, result) {
    const report = {
      kind: 'ui-cli-action',
      version: 1,
      ok: true,
      operation: input.operation,
      session: {
        scope: 'calling-dsh-agent-session',
        digest: identity.digest,
      },
      route: {
        provider: this.#config.provider,
        providerVersion: this.#config.providerVersion,
        providerEvidence: this.#config.evidenceDigest,
        modelToolSchemas: 1,
      },
      authority: {
        profile: 'isolated-memory',
        navigation: 'loopback; development browsers restricted to their DSH origin',
        remoteHttp: 'closed-loopback-proxy',
        arbitraryCode: 'unavailable',
        fileTransfer: 'unavailable',
        pageContent: 'untrusted-data',
      },
      result,
    }
    report.evidenceDigest = digest(report)
    return report
  }

  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    await Promise.allSettled([...this.#queues.values()])
    await Promise.allSettled([...this.#active.values()].map(async (identity) => {
      await this.#closeQuietly(identity)
    }))
    this.#active.clear()
  }
}

export function formatUiCliReport(report) {
  const lines = [
    'PASS dsh_ui ' + report.operation + ' [' + report.session.digest.slice(0, 23) + '…]',
  ]
  if (report.result.wait !== undefined) {
    lines.push('Wait: matched in ' + report.result.wait.elapsedMs + 'ms / ' + report.result.wait.attempts + ' attempts')
  }
  if (report.result.pageData?.content !== undefined) {
    lines.push('UNTRUSTED PAGE DATA')
    lines.push(report.result.pageData.content)
  } else if (report.result.pageData?.omitted) {
    lines.push('Page data omitted: ' + report.result.pageData.reason)
  } else if (typeof report.result.provider?.result === 'string') {
    const text = report.result.provider.result
    lines.push('UNTRUSTED PAGE DATA')
    lines.push(text.length <= INLINE_PAGE_BYTES ? text : text.slice(0, INLINE_PAGE_BYTES) + '\n[output truncated]')
  }
  for (const artifact of report.result.artifacts ?? []) {
    lines.push('Artifact: ' + artifact.path + ' (' + artifact.bytes + ' bytes)')
  }
  lines.push('Evidence: ' + report.evidenceDigest)
  return lines.join('\n')
}
