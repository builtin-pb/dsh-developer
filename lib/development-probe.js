// Loaded only in a disposable, explicitly executed development profile.
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
  let spec, activeCase = null
  const publish = async (complete = false, error) => {
    const report = { ok: complete && cases.every(item => item.passed), complete, caseCount: spec.length,
      cases, activeCase, ...(error === undefined ? {} : { error }),
      scope: 'global native registry; no model or Agent invocation' }
    const path = process.env.DSH_DEVELOPER_CASE_RESULT
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
    spec = JSON.parse(await readFile(process.env.DSH_DEVELOPER_CASES, 'utf8'))
    await publish()
    // The parent bounds startup and cancellation for this whole invocation.
    while (true) {
      controller.signal.throwIfAborted()
      try {
        await access(process.env.DSH_DEVELOPER_BOOT_COMPLETE)
        break
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await assertDevelopmentStartup(ctx)
    const deadline = Date.now() + 10_000
    while (spec.some(item => !tools.get(item.tool))) {
      controller.signal.throwIfAborted()
      if (Date.now() > deadline) throw new Error('Expected tool did not register: ' + spec.filter(item => !tools.get(item.tool)).map(item => item.tool).join(', '))
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    for (const [index, item] of spec.entries()) {
      controller.signal.throwIfAborted()
      activeCase = { index: index + 1, tool: item.tool, ...(item.name === undefined ? {} : { name: item.name }) }
      await publish()
      const result = await tools.execute({
        callId: 'dsh-developer-case-' + index,
        name: item.tool,
        arguments: item.arguments,
        signal: controller.signal,
      })
      cases.push(observeToolCase(item, result, index))
      activeCase = null
      await publish()
    }
    const report = await publish(true)
    requestExit(report.ok ? 0 : 1)
  }
  const start = () => { void Promise.resolve().then(pending).catch(async error => {
    if (controller.signal.aborted) return
    if (spec) await publish(false, redactSensitiveOutput(String(error?.message ?? error)).slice(0, 2048)).catch(() => {})
    requestExit(1)
  }) }
  // The launch wrapper publishes completion only after the official CLI entry
  // settles successfully, including the native readiness and watcher setup.
  start()
}
