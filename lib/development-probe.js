// @ts-check
/** @import {} from '@deepseek-ai/dsh-cmdline' */
/** @import {} from '@deepseek-ai/dsh-agent-presets' */
// Loaded only in a disposable, explicitly executed development profile.
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { assertDevelopmentStartup } from './development-startup.js'
import { findSecrets, redactSensitiveOutput } from './security.js'

export const name = 'dsh-developer-verification'
export const inject = ['tools', 'appExit', 'loader']

/**
 * Select an own canonical result field with RFC 6901 JSON Pointer semantics.
 * @param {unknown} value
 * @param {string} [pointer]
 * @returns {{ found: true, value: unknown } | { found: false }}
 */
export function selectCaseValue(value, pointer = '') {
  if (pointer === '') return { found: true, value: value ?? null }
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return { found: false }
    value = /** @type {Record<string, unknown>} */ (value)[key]
  }
  return { found: true, value }
}

/**
 * Compare full results, then keep a bounded explanation for the developer.
 * @param {import('./development-types.js').ToolCase} item
 * @param {import('@deepseek-ai/dsh-tools').ToolExecutionResult} result
 * @param {number} index
 * @returns {import('./development-types.js').CaseReceipt}
 */
export function observeToolCase(item, result, index) {
  const selected = selectCaseValue(result.value, item.resultPath)
  const valueText = JSON.stringify(result.value ?? null), contentText = JSON.stringify(result.content)
  const valueBytes = Buffer.byteLength(valueText)
  const contentBytes = Buffer.byteLength(contentText)
  // Detect a key marker before clipping: it may occur beyond the displayed
  // fields while another case or field contains an otherwise innocent fragment.
  const privateKeyOutput = findSecrets(valueText + '\n' + contentText).includes('private-key')
  const resultBytes = valueBytes + contentBytes
  const outputLimitExceeded = item.maxResultBytes !== undefined && resultBytes > item.maxResultBytes
  /** @type {string[]} */
  const failures = []
  if (result.isError !== (item.isError ?? false)) failures.push(item.isError ? 'expected-error' : 'unexpected-error')
  const errorContains = item.errorContains
  if (item.isError === true && errorContains !== undefined
      && !result.content.some(block => block.type === 'text' && typeof block.text === 'string'
        && block.text.includes(errorContains))) failures.push('error-message-mismatch')
  if (!selected.found) failures.push('missing-result-path')
  else if (Object.hasOwn(item, 'expected') && !isDeepStrictEqual(selected.value, item.expected)) failures.push('value-mismatch')
  if (outputLimitExceeded) failures.push('result-budget-exceeded')
  /** @type {import('./development-types.js').CaseReceipt} */
  const observed = { index: index + 1, ...(item.name === undefined ? {} : { name: item.name }),
    tool: item.tool, passed: failures.length === 0, failures, isError: result.isError,
    ...(privateKeyOutput ? { privateKeyOutput: true } : {}),
    valueBytes, contentBytes, resultBytes,
    ...(item.maxResultBytes !== undefined ? { maxResultBytes: item.maxResultBytes, outputLimitExceeded } : {}) }
  // Full comparisons precede receipt clipping. A shared 3 KiB allowance for
  // the name and result fields leaves room for 32 cases and their metadata.
  let remaining = 3072 - (item.name === undefined ? 0 : Buffer.byteLength(JSON.stringify(item.name)))
  /**
   * @template {keyof import('./development-types.js').CaseReceiptFields} K
   * @param {K} key
   * @param {import('./development-types.js').CaseReceipt[K]} value
   */
  const retain = (key, value) => {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (bytes <= 1024 && bytes <= remaining) {
      observed[key] = value
      remaining -= bytes
    } else observed[/** @type {`${K}Omitted`} */ (key + 'Omitted')] = true
  }
  if (selected.found) retain('value', selected.value)
  if (failures.includes('value-mismatch')) retain('expected', item.expected)
  if (item.resultPath !== undefined) retain('resultPath', item.resultPath)
  if (item.errorContains !== undefined) retain('errorContains', item.errorContains)
  if (item.resultPath === undefined || failures.length) retain('content', result.content)
  return observed
}

/**
 * The parent validates case policy and limits before writing this private file.
 * Independently admit its JSON shape here before using it in native calls.
 * @param {unknown} value
 * @returns {value is import('./development-types.js').ToolCase[]}
 */
function isToolCases(value) {
  if (!Array.isArray(value)) return false
  /** @type {unknown[]} */
  const items = value
  return items.every(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
    if (!('tool' in item) || typeof item.tool !== 'string') return false
    if (!('arguments' in item) || item.arguments === null || typeof item.arguments !== 'object'
      || Array.isArray(item.arguments)) return false
    return (!('name' in item) || item.name === undefined || typeof item.name === 'string')
      && (!('isError' in item) || item.isError === undefined || typeof item.isError === 'boolean')
      && (!('errorContains' in item) || item.errorContains === undefined || typeof item.errorContains === 'string')
      && (!('resultPath' in item) || item.resultPath === undefined || typeof item.resultPath === 'string')
      && (!('maxResultBytes' in item) || item.maxResultBytes === undefined || typeof item.maxResultBytes === 'number')
  })
}

/** @param {import('./development-types.js').VerificationContext} ctx */
export function apply(ctx) {
  const tools = ctx.tools
  const requestExit = ctx.appExit
  const controller = new AbortController()
  ctx.effect(() => () => controller.abort(), 'cancel development verification')
  /** @type {import('./development-types.js').CaseReceipt[]} */
  const cases = []
  const workspace = process.env.DSH_DEVELOPER_VERIFY_WORKSPACE
  const path = process.env.DSH_DEVELOPER_CASE_RESULT
  const casesPath = process.env.DSH_DEVELOPER_CASES
  const bootPath = process.env.DSH_DEVELOPER_BOOT_COMPLETE
  /** @type {import('./development-types.js').ToolCase[] | undefined} */
  let spec
  /** @type {import('@deepseek-ai/dsh-agent').AgentHandle | undefined} */
  let handle
  /** @type {import('./development-types.js').AgentReceipt | undefined} */
  let agent
  /** @type {string | undefined} */
  let error
  /** @type {string | undefined} */
  let cleanupError
  /** @type {import('./development-types.js').ActiveCase | null} */
  let activeCase = null
  let privateKeyOutput = false, phase = 'startup'
  /** @param {unknown} failure @returns {string} */
  const diagnostic = failure => {
    const raw = String(((typeof failure === 'object' && failure !== null || typeof failure === 'function')
      && 'message' in failure ? failure.message : undefined) ?? failure)
    privateKeyOutput ||= findSecrets(raw).includes('private-key')
    return redactSensitiveOutput(raw).slice(0, 2048)
  }
  const publish = async () => {
    if (path === undefined) throw new Error('Missing development case result path.')
    if (spec === undefined) throw new Error('Development cases have not been loaded.')
    const complete = phase === 'complete'
    const report = { ok: complete && cases.every(item => item.passed), complete, phase, caseCount: spec.length,
      cases, activeCase, ...(agent === undefined ? {} : { agent }),
      ...(privateKeyOutput ? { privateKeyOutput: true } : {}),
      ...(error === undefined ? {} : { error }), ...(cleanupError === undefined ? {} : { cleanupError }),
      scope: workspace === undefined ? 'global native registry; no model or Agent invocation'
        : 'real Agent; native tool registry and native policy; verifier does not submit a model turn' }
    // The parent may terminate this process during a write. Replace the last
    // complete JSON checkpoint atomically, keeping prior evidence readable.
    const pendingPath = path + '.pending'
    try {
      await writeFile(pendingPath, JSON.stringify(report), { flag: 'wx', mode: 0o600 })
      await rename(pendingPath, path)
    } finally {
      await rm(pendingPath, { force: true })
    }
    return report
  }
  const pending = async () => {
    if (casesPath === undefined || bootPath === undefined) throw new Error('Missing development verification input paths.')
    /** @type {unknown} */
    const input = JSON.parse(await readFile(casesPath, 'utf8'))
    if (!isToolCases(input)) throw new TypeError('Invalid development tool case file.')
    spec = input
    await publish()
    // The parent bounds startup and cancellation for this whole invocation.
    while (true) {
      controller.signal.throwIfAborted()
      try {
        await access(bootPath)
        break
      } catch (error) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error
      }
      await new Promise(/** @param {(value: void) => void} resolve */ resolve => setTimeout(resolve, 25))
    }
    await assertDevelopmentStartup(ctx)
    controller.signal.throwIfAborted()
    if (workspace !== undefined) {
      phase = 'agent-setup'
      await publish()
      controller.signal.throwIfAborted()
      const agents = ctx.get(/** @satisfies {keyof import('@deepseek-ai/cordis').Context} */ ('agents'))
      if (typeof agents?.create !== 'function') throw new Error('Agent-scoped verification requires the native agents factory.')
      /** @type {import('./development-types.js').AgentReceipt['preset']} */
      let preset = null
      handle = await agents.create({
        // Mint the session identity here; the upstream brand has no runtime representation.
        sessionId: /** @type {import('@deepseek-ai/dsh-agent').CreateAgentOptions['sessionId']} */ (randomUUID()),
        meta: { cwd: workspace }, signal: controller.signal,
        setup: async agentCtx => {
          const presets = ctx.get(/** @satisfies {keyof import('@deepseek-ai/cordis').Context} */ ('agentPresets'))
          // A setup return value is a factory commit transaction, not a preset.
          // Keep the service receiver and deliberately return void.
          if (presets) preset = (await presets.mount(agentCtx)).id
        },
      })
      agent = { id: handle.agent.id, preset }
    }
    phase = 'cases'
    await publish()
    controller.signal.throwIfAborted()
    const deadline = Date.now() + 10_000
    while (spec.some(item => !tools.get(item.tool, handle?.agent))) {
      controller.signal.throwIfAborted()
      if (Date.now() > deadline) throw new Error('Expected tool did not register: ' + spec.filter(item => !tools.get(item.tool, handle?.agent)).map(item => item.tool).join(', '))
      await new Promise(/** @param {(value: void) => void} resolve */ resolve => setTimeout(resolve, 25))
    }
    for (const [index, item] of spec.entries()) {
      controller.signal.throwIfAborted()
      activeCase = { index: index + 1, tool: item.tool, ...(item.name === undefined ? {} : { name: item.name }) }
      await publish()
      controller.signal.throwIfAborted()
      const result = await tools.execute({
        callId: /** @type {import('@deepseek-ai/dsh-tools').ToolExecutionInput['callId']} */ ('dsh-developer-case-' + index),
        name: item.tool,
        arguments: item.arguments,
        signal: controller.signal,
        ...(handle === undefined ? {} : { agent: handle.agent }),
      })
      cases.push(observeToolCase(item, result, index))
      activeCase = null
      await publish()
    }
    controller.signal.throwIfAborted()
  }
  const finish = async () => {
    try { await pending() } catch (failure) { error = diagnostic(failure) }
    if (handle) {
      phase = 'agent-dispose'
      // Publish the invocation error before teardown, which may itself hang.
      // A publication failure must not prevent attempting owned cleanup.
      try { await publish() } catch (failure) { error ??= diagnostic(failure) }
      try { await handle.dispose() } catch (failure) {
        if (error === undefined) error = diagnostic(failure)
        else cleanupError = diagnostic(failure)
      }
    }
    if (controller.signal.aborted) error ??= diagnostic(controller.signal.reason)
    if (error === undefined) phase = 'complete'
    if (spec) {
      try { await publish() } catch (failure) { error ??= diagnostic(failure) }
    }
    // The parent owns cancellation and its process exit status.
    if (!controller.signal.aborted) requestExit(error === undefined && cases.every(item => item.passed) ? 0 : 1)
  }
  // The launch wrapper publishes completion only after the official CLI entry
  // settles successfully, including the native readiness and watcher setup.
  void finish()
}
