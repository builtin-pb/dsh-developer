// Loaded only in a disposable, explicitly executed development profile.
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { assertDevelopmentStartup } from './development-startup.js'
import { redactSensitiveOutput } from './security.js'

export const name = 'dsh-developer-verification'
export const inject = ['tools', 'appExit', 'loader']

/** Select an own canonical result field with RFC 6901 JSON Pointer semantics. */
export function selectCaseValue(value, pointer = '') {
  if (pointer === '') return { found: true, value: value ?? null }
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return { found: false }
    value = value[key]
  }
  return { found: true, value }
}

/** Compare full results, then keep a bounded explanation for the developer. */
export function observeToolCase(item, result, index) {
  const selected = selectCaseValue(result.value, item.resultPath)
  const valueBytes = Buffer.byteLength(JSON.stringify(result.value ?? null))
  const contentBytes = Buffer.byteLength(JSON.stringify(result.content))
  const resultBytes = valueBytes + contentBytes
  const outputLimitExceeded = item.maxResultBytes !== undefined && resultBytes > item.maxResultBytes
  const failures = []
  if (result.isError !== (item.isError ?? false)) failures.push(item.isError ? 'expected-error' : 'unexpected-error')
  if (!selected.found) failures.push('missing-result-path')
  else if (Object.hasOwn(item, 'expected') && !isDeepStrictEqual(selected.value, item.expected)) failures.push('value-mismatch')
  if (outputLimitExceeded) failures.push('result-budget-exceeded')
  const observed = { index: index + 1, ...(item.name === undefined ? {} : { name: item.name }),
    tool: item.tool, passed: failures.length === 0, failures, isError: result.isError,
    valueBytes, contentBytes, resultBytes,
    ...(item.maxResultBytes !== undefined ? { maxResultBytes: item.maxResultBytes, outputLimitExceeded } : {}) }
  // Full comparisons precede receipt clipping. A shared 3 KiB allowance for
  // the name and result fields leaves room for 32 cases and their metadata.
  let remaining = 3072 - (item.name === undefined ? 0 : Buffer.byteLength(JSON.stringify(item.name)))
  for (const [key, value] of Object.entries({
    ...(selected.found ? { value: selected.value } : {}),
    ...(failures.includes('value-mismatch') ? { expected: item.expected } : {}),
    ...(item.resultPath !== undefined ? { resultPath: item.resultPath } : {}),
    ...(item.resultPath === undefined || failures.length ? { content: result.content } : {}),
  })) {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (bytes <= 1024 && bytes <= remaining) {
      observed[key] = value
      remaining -= bytes
    } else observed[key + 'Omitted'] = true
  }
  return observed
}

export function apply(ctx) {
  const tools = ctx.tools
  const requestExit = ctx.appExit
  const controller = new AbortController()
  ctx.effect(() => () => controller.abort(), 'cancel development verification')
  const cases = []
  const workspace = process.env.DSH_DEVELOPER_VERIFY_WORKSPACE
  const path = process.env.DSH_DEVELOPER_CASE_RESULT
  const casesPath = process.env.DSH_DEVELOPER_CASES
  const bootPath = process.env.DSH_DEVELOPER_BOOT_COMPLETE
  let spec, handle, agent, error, cleanupError, activeCase = null, phase = 'startup'
  const diagnostic = failure => redactSensitiveOutput(String(failure?.message ?? failure)).slice(0, 2048)
  const publish = async () => {
    const complete = phase === 'complete'
    const report = { ok: complete && cases.every(item => item.passed), complete, phase, caseCount: spec.length,
      cases, activeCase, ...(agent === undefined ? {} : { agent }),
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
    spec = JSON.parse(await readFile(casesPath, 'utf8'))
    await publish()
    // The parent bounds startup and cancellation for this whole invocation.
    while (true) {
      controller.signal.throwIfAborted()
      try {
        await access(bootPath)
        break
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await assertDevelopmentStartup(ctx)
    controller.signal.throwIfAborted()
    if (workspace !== undefined) {
      phase = 'agent-setup'
      await publish()
      controller.signal.throwIfAborted()
      const agents = ctx.get('agents')
      if (typeof agents?.create !== 'function') throw new Error('Agent-scoped verification requires the native agents factory.')
      let preset = null
      handle = await agents.create({
        sessionId: randomUUID(), meta: { cwd: workspace }, signal: controller.signal,
        setup: async agentCtx => {
          const presets = ctx.get('agentPresets')
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
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    for (const [index, item] of spec.entries()) {
      controller.signal.throwIfAborted()
      activeCase = { index: index + 1, tool: item.tool, ...(item.name === undefined ? {} : { name: item.name }) }
      await publish()
      controller.signal.throwIfAborted()
      const result = await tools.execute({
        callId: 'dsh-developer-case-' + index,
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
