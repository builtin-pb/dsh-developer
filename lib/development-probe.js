// Loaded only in a disposable, explicitly executed development profile.
import { access, readFile, writeFile } from 'node:fs/promises'
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

export function apply(ctx) {
  const tools = ctx.tools
  const requestExit = ctx.appExit
  const controller = new AbortController()
  ctx.effect(() => () => controller.abort(), 'cancel development verification')
  const pending = async () => {
    const spec = JSON.parse(await readFile(process.env.DSH_DEVELOPER_CASES, 'utf8'))
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
    const cases = []
    for (const [index, item] of spec.entries()) {
      controller.signal.throwIfAborted()
      const result = await tools.execute({
        callId: 'dsh-developer-case-' + index,
        name: item.tool,
        arguments: item.arguments,
        signal: controller.signal,
      })
      const selected = selectCaseValue(result.value, item.resultPath)
      const valueBytes = Buffer.byteLength(JSON.stringify(result.value ?? null))
      const contentBytes = Buffer.byteLength(JSON.stringify(result.content))
      const resultBytes = valueBytes + contentBytes
      const outputLimitExceeded = item.maxResultBytes !== undefined && resultBytes > item.maxResultBytes
      const passed = result.isError === (item.isError ?? false) && selected.found
        && (!Object.hasOwn(item, 'expected') || isDeepStrictEqual(selected.value, item.expected))
        && !outputLimitExceeded
      const observed = { tool: item.tool, passed, isError: result.isError, valueBytes, contentBytes, resultBytes,
        ...(item.maxResultBytes !== undefined ? { maxResultBytes: item.maxResultBytes, outputLimitExceeded } : {}) }
      // Comparisons use full values. Receipts retain bounded fields, so a large
      // result cannot overflow the parent's receipt limit and erase the verdict.
      // 32 cases with three 1 KiB fields plus bounded metadata fit within 128 KiB.
      for (const [key, value] of Object.entries({
        ...(selected.found ? { value: selected.value } : {}),
        ...(item.resultPath !== undefined ? { resultPath: item.resultPath } : {}),
        ...(item.resultPath === undefined || !passed ? { content: result.content } : {}),
      })) {
        if (Buffer.byteLength(JSON.stringify(value)) <= 1024) observed[key] = value
        else observed[key + 'Omitted'] = true
      }
      cases.push(observed)
    }
    const report = { ok: cases.every(item => item.passed), cases, scope: 'global native registry; no model or Agent invocation' }
    await writeFile(process.env.DSH_DEVELOPER_CASE_RESULT, JSON.stringify(report), { flag: 'wx', mode: 0o600 })
    requestExit(report.ok ? 0 : 1)
  }
  const start = () => { void Promise.resolve().then(pending).catch(async error => {
    if (controller.signal.aborted) return
    await writeFile(process.env.DSH_DEVELOPER_CASE_RESULT,
      JSON.stringify({ ok: false, error: redactSensitiveOutput(String(error?.message ?? error)).slice(0, 2048), cases: [] }), { flag: 'wx', mode: 0o600 }).catch(() => {})
    requestExit(1)
  }) }
  // The launch wrapper publishes completion only after the official CLI entry
  // settles successfully, including the native readiness and watcher setup.
  start()
}
