// Observe activation failures before Web dependencies exist; publish readiness
// only after the native server and the complete enabled composition are ready.
import { rename, writeFile } from 'node:fs/promises'
import { assertDevelopmentStartup } from './development-startup.js'
import { findSecrets, redactSensitiveOutput } from './security.js'
import { observeDevelopmentReload } from './development-watch-probe.js'

export const name = 'dsh-developer-server-observer'
export const inject = ['loader']

export function apply(ctx, config = {}) {
  const loader = ctx.loader
  const exit = ctx.get('appExit')
  let publication, disposed = false
  ctx.effect(() => () => { disposed = true }, 'cancel development startup observation')
  const publish = record => publication ??= writeFile(process.env.DSH_DEVELOPER_SERVER_RESULT, JSON.stringify({
    kind: 'dsh-development-server-private', version: 1,
    token: process.env.DSH_DEVELOPER_SERVER_TOKEN, ...record,
  }), { flag: 'wx', mode: 0o600 })
  const fail = async error => {
    // A failure already observed still belongs to this startup when Loader
    // rollback disposes us. Teardown may itself be slow or never settle.
    try {
      // 1,024 UTF-16 units remain below the parent's 8 KiB JSON receipt cap,
      // including escaped control characters and multibyte error messages.
      const message = String(error?.message ?? error)
      await publish({ error: redactSensitiveOutput(message).slice(0, 1024),
        ...(findSecrets(message).includes('private-key') ? { privateKeyOutput: true } : {}) })
    } catch (failure) {
      process.stderr.write('Development server observation failed: ' + redactSensitiveOutput(failure.message).slice(0, 1024) + '\n')
      exit?.(1)
    }
  }
  ctx.on('internal/status', fiber => {
    if (disposed || fiber.state !== 3 || fiber.uid === null) return
    // Cordis traces objects through context-specific proxies. The live fiber
    // uid, not JavaScript object identity, associates an event with its entry.
    const entry = [...loader.entries()].find(entry => entry.fiber?.uid === fiber.uid)
    if (!entry) return
    void (async () => {
      if (!entry.disabled) await fiber.await()
    })().catch(fail)
  }, { global: true })
  // Do not await Loader settlement inside this plugin's apply: its own fiber
  // belongs to that settlement. The event listener above captures a failed
  // entry before settlement can be delayed by unrelated rollback disposers.
  const startup = Promise.resolve().then(() => assertDevelopmentStartup({ loader }))
  void startup.catch(fail)
  ctx.inject(['webServer', 'connection', 'workspaceRegistry'], async webCtx => {
    let webDisposed = false
    webCtx.effect(() => () => { webDisposed = true }, 'cancel development Web readiness')
    try {
      const { host, port } = webCtx.webServer
      const origin = 'http://127.0.0.1:' + port + '/'
      const connection = webCtx.connection
      const workspace = await webCtx.workspaceRegistry.create(process.env.DSH_DEVELOPER_WORKSPACE)
      if (disposed || webDisposed) return
      // Current DSH owns its launch-token exchange; older releases serve root directly.
      const url = typeof connection.authenticatedUrl === 'function' ? connection.authenticatedUrl(origin) : origin
      const announce = () => { void (async () => {
        await startup
        if (disposed || webDisposed) return
        // Recheck entries mounted between initial settlement and appReady.
        await assertDevelopmentStartup({ loader })
        if (!disposed && !webDisposed) {
          if (config.watch) {
            const path = process.env.DSH_DEVELOPER_SERVER_RESULT + '.reload'
            let writing = Promise.resolve()
            observeDevelopmentReload(ctx, { publish(record) {
              // Serialize atomic replacements: a burst of native events cannot
              // race the temporary file or expose a partially written receipt.
              writing = writing.then(async () => {
                if (disposed) return
                await writeFile(path + '.pending', JSON.stringify({ token: process.env.DSH_DEVELOPER_SERVER_TOKEN,
                  ...record }), { mode: 0o600 })
                await rename(path + '.pending', path)
              }).catch(() => { exit?.(1) })
            } })
            ctx.effect(() => () => writing, 'drain development reload observations')
          }
          await publish({ host, port, url, pid: process.pid,
            workspace: { id: workspace.id, path: workspace.path } })
        }
      })().catch(fail) }
      const ready = webCtx.get('appReady')
      if (ready) webCtx.effect(() => ready.onReady(announce), 'wait for development Web startup')
      else announce()
    } catch (error) { await fail(error) }
  })
}
