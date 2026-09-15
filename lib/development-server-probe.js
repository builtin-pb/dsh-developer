// Records the address after DSH's native webServer service has successfully bound.
import { writeFile } from 'node:fs/promises'
import { assertDevelopmentStartup } from './development-startup.js'
import { redactSensitiveOutput } from './security.js'

export const name = 'dsh-developer-server-observer'
export const inject = ['webServer', 'connection', 'workspaceRegistry', 'loader']

export async function apply(ctx) {
  const { host, port } = ctx.webServer
  const origin = 'http://127.0.0.1:' + port + '/'
  const connection = ctx.connection
  const workspace = await ctx.workspaceRegistry.create(process.env.DSH_DEVELOPER_WORKSPACE)
  // Older releases serve the root directly; current DSH owns its launch-token exchange.
  const url = typeof connection.authenticatedUrl === 'function' ? connection.authenticatedUrl(origin) : origin
  let publication, disposed = false
  ctx.effect(() => () => { disposed = true }, 'cancel development startup observation')
  const publish = record => publication ??= writeFile(process.env.DSH_DEVELOPER_SERVER_RESULT, JSON.stringify({
    kind: 'dsh-development-server-private', version: 1,
    token: process.env.DSH_DEVELOPER_SERVER_TOKEN, ...record,
  }), { flag: 'wx', mode: 0o600 })
  const fail = async error => {
    if (disposed) return
    try {
      // 1,024 UTF-16 units remain below the parent's 8 KiB JSON receipt cap,
      // including escaped control characters and multibyte error messages.
      await publish({ error: redactSensitiveOutput(String(error?.message ?? error)).slice(0, 1024) })
    } catch (failure) {
      process.stderr.write('Development server observation failed: ' + redactSensitiveOutput(failure.message).slice(0, 1024) + '\n')
      ctx.get('appExit')(1)
    }
  }
  // Do not await Loader settlement inside this plugin's apply: its own fiber
  // belongs to that settlement. Observe failures even if appReady never fires.
  const startup = Promise.resolve().then(() => assertDevelopmentStartup(ctx))
  void startup.catch(fail)
  const announce = () => { void (async () => {
    await startup
    if (disposed) return
    // The launcher can mount watchers or other entries between initial Loader
    // settlement and appReady. Certify the composition that will be served.
    await assertDevelopmentStartup(ctx)
    if (!disposed) await publish({ host, port, url, pid: process.pid,
      workspace: { id: workspace.id, path: workspace.path } })
  })().catch(fail) }
  const ready = ctx.get('appReady')
  if (ready) {
    ctx.effect(() => ready.onReady(announce), 'wait for development Web startup')
  } else announce()
}
