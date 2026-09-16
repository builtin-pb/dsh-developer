import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

// Exercise the actual parent polling and cleanup code. Module hooks, fetch and
// the browser handoff are isolated in a subprocess: no native DSH, HTTP socket,
// browser or personal profile is used, and test/run.js imports stay unaffected.
async function runCallbackFixture(t, scenario) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reload-callbacks-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'plugin'), runtime = join(root, 'runtime')
  await mkdir(source)
  await mkdir(runtime)
  await writeFile(join(source, 'package.json'), JSON.stringify({
    name: 'reload-callback-fixture', dsh: { bundle: { patch: './patch.yml' } },
  }))
  await writeFile(join(runtime, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version: '1.0.0', publishConfig: { access: 'public' }, bin: { dsh: './bin.cjs' },
  }))
  const dshPath = join(runtime, 'bin.cjs')
  await writeFile(dshPath, '')
  const runtimeUrl = new URL('../lib/runtime.js', import.meta.url).href
  const browserUrl = new URL('../lib/development-browser.js', import.meta.url).href
  const runtimeStub = `
    export * from ${JSON.stringify(runtimeUrl + '?actual')}
    import { writeFile } from 'node:fs/promises'
    export async function runDsh(_invocation, _args, options) {
      const path = options.env.DSH_DEVELOPER_SERVER_RESULT
      if (!path) return {} // preparation commands
      const token = options.env.DSH_DEVELOPER_SERVER_TOKEN
      globalThis.fixtureState = { stopped: false, handoffClosed: false }
      await writeFile(path, JSON.stringify({ token, host: '127.0.0.1', port: 4173,
        url: 'http://127.0.0.1:4173/', pid: 123, workspace: { id: 'fixture', path: options.cwd } }))
      await writeFile(path + '.reload', JSON.stringify({ token,
        sequence: 1, attempt: 0, warnings: 0, status: 'settled', active: 1, inactive: 0 }))
      await new Promise(resolve => {
        const stop = () => {
          globalThis.fixtureState.stopped = true
          options.onExit({ code: 0, signal: null })
          resolve()
        }
        if (options.signal.aborted) stop()
        else options.signal.addEventListener('abort', stop, { once: true })
      })
      return {}
    }
  `
  const browserStub = `
    export async function createDevelopmentBrowserHandoff() {
      return async () => { globalThis.fixtureState.handoffClosed = true }
    }
  `
  const script = join(root, 'scenario.mjs')
  await writeFile(script, `
    import assert from 'node:assert/strict'
    import { stat } from 'node:fs/promises'
    import { registerHooks } from 'node:module'
    import { setImmediate } from 'node:timers/promises'
    registerHooks({ load(url, context, nextLoad) {
      if (url === ${JSON.stringify(runtimeUrl)}) return {
        format: 'module', shortCircuit: true, source: ${JSON.stringify(runtimeStub)},
      }
      if (url === ${JSON.stringify(browserUrl)}) return {
        format: 'module', shortCircuit: true, source: ${JSON.stringify(browserStub)},
      }
      return nextLoad(url, context)
    } })
    globalThis.fetch = async () => ({ ok: true, body: { cancel: async () => {} } })
    const { runDevelopmentServer } = await import(${JSON.stringify(new URL('../lib/development.js', import.meta.url).href)})
    const source = ${JSON.stringify(source)}, dshPath = ${JSON.stringify(dshPath)}
    async function bounded(promise) {
      let timer
      try {
        return await Promise.race([promise, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('callback lifecycle did not finish within 3 seconds')), 3000)
        })])
      } finally { clearTimeout(timer) }
    }
    async function assertCleaned(ready) {
      assert(ready, 'the callback must run after readiness')
      assert.equal(globalThis.fixtureState.stopped, true, 'the mocked child must stop')
      assert.equal(globalThis.fixtureState.handoffClosed, true, 'the handoff must close')
      await assert.rejects(stat(ready.home), { code: 'ENOENT' })
    }
    ${scenario}
  `)
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    ['--unhandled-rejections=strict', script], {
      timeout: 15_000,
      // Keep profiles inside the fixture even if a regression blocks cleanup.
      env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
    })
  assert.equal(stdout, '')
  assert.equal(stderr, '')
}

for (const callbackName of ['onReload', 'onReady']) {
  test(callbackName + ' cancellation removes the profile before callback settlement and consumes a late rejection', async t => {
    await runCallbackFixture(t, `
      const callbackName = ${JSON.stringify(callbackName)}
      const controller = new AbortController()
      const callback = Promise.withResolvers(), entered = Promise.withResolvers()
      let ready
      const pendingCallback = () => { entered.resolve(); return callback.promise }
      const running = runDevelopmentServer(source, { dshPath, watch: true, signal: controller.signal,
        onReady: report => {
          ready = report
          if (callbackName === 'onReady') return pendingCallback()
        },
        onReload: callbackName === 'onReload' ? pendingCallback : undefined,
      })
      try {
        await bounded(entered.promise)
        controller.abort()
        const report = await bounded(running)
        assert.equal(report.stopped, true)
        await assertCleaned(ready)
        // Reject only after cleanup has finished. Strict unhandled-rejection mode
        // makes dropping the losing callback promise fail the subprocess.
        callback.reject(new Error('late callback rejection'))
        await setImmediate()
        await setImmediate()
      } finally {
        controller.abort()
        callback.resolve()
        await bounded(running).catch(() => {})
      }
    `)
  })
}

test('falsy reload callback rejections fail the server operation and still clean up', async t => {
  await runCallbackFixture(t, `
    for (const reason of [undefined, null, false, 0, '']) for (const synchronous of [false, true]) {
      const controller = new AbortController()
      let ready, called = false
      const running = runDevelopmentServer(source, { dshPath, watch: true, signal: controller.signal,
        onReady: report => { ready = report },
        onReload: () => {
          called = true
          if (synchronous) throw reason
          return Promise.reject(reason)
        },
      })
      try {
        const outcome = await bounded(running.then(report => ({ report }), error => ({ error })))
        assert.equal(called, true)
        assert(!Object.hasOwn(outcome, 'report'), 'callback rejection ' + String(reason) + ' must not report success')
        assert(outcome.error instanceof Error, 'non-Error callback rejection must be normalized')
        assert.equal(outcome.error.code, 'DEVELOPMENT_CALLBACK_FAILED')
        await assertCleaned(ready)
      } finally {
        controller.abort()
        await bounded(running).catch(() => {})
      }
    }
  `)
})
