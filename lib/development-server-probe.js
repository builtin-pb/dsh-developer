// Records the address after DSH's native webServer service has successfully bound.
import { writeFile } from 'node:fs/promises'

export const name = 'dsh-developer-server-observer'
export const inject = ['webServer', 'connection', 'workspaceRegistry']

export async function apply(ctx) {
  const { host, port } = ctx.webServer
  const origin = 'http://127.0.0.1:' + port + '/'
  const connection = ctx.connection
  const workspace = await ctx.workspaceRegistry.create(process.env.DSH_DEVELOPER_WORKSPACE)
  // Older releases serve the root directly; current DSH owns its launch-token exchange.
  const url = typeof connection.authenticatedUrl === 'function' ? connection.authenticatedUrl(origin) : origin
  const publish = () => writeFile(process.env.DSH_DEVELOPER_SERVER_RESULT, JSON.stringify({
    kind: 'dsh-development-server-private', version: 1,
    token: process.env.DSH_DEVELOPER_SERVER_TOKEN, host, port, url, pid: process.pid,
    workspace: { id: workspace.id, path: workspace.path },
  }), { flag: 'wx', mode: 0o600 })
  const ready = ctx.get('appReady')
  if (ready) {
    ctx.effect(() => ready.onReady(() => {
      void publish().catch(error => {
        process.stderr.write('Development server observation failed: ' + error.message + '\n')
        ctx.get('appExit')(1)
      })
    }), 'wait for development Web startup')
  } else await publish()
}
