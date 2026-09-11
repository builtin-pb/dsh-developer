// Private bridge between an owned development server and the isolated UI browser.
// The model selects the server directory; only this module reads its login URL.
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { createConnection, createServer } from 'node:net'
import { DshDeveloperError } from './errors.js'

export const DEVELOPMENT_SERVER_ENV = 'DSH_DEVELOPER_UI_DEVELOPMENT_SERVER'

function endpoint(home) {
  const name = 'dsh-ui-' + createHash('sha256').update(home).digest('hex').slice(0, 32)
  return process.platform === 'win32' ? '\\\\.\\pipe\\' + name : '/tmp/' + name + '.sock'
}

/** Lifetime proof from the process that owns dev, rather than a reusable PID. */
export async function createDevelopmentBrowserHandoff(home, { nonce, loginUrl, isRunning = () => true }) {
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    socket.setTimeout(2_000, () => socket.destroy())
    let input = '', watching = false
    socket.on('data', data => {
      if (watching) return socket.destroy()
      input += data.toString('utf8')
      if (input.length > 128) return socket.destroy()
      if (!input.includes('\n')) return
      const watch = input === nonce + ' watch\n'
      if ((!watch && input !== nonce + '\n') || !isRunning()) return socket.destroy()
      const reply = JSON.stringify({ loginUrl }) + '\n'
      if (watch) {
        watching = true
        socket.setTimeout(0)
        socket.write(reply)
      } else socket.end(reply)
    })
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(endpoint(home), accept)
  })
  let closing
  return () => closing ??= new Promise((accept, reject) => {
    for (const socket of sockets) socket.destroy()
    server.close(error => error ? reject(error) : accept())
  })
}

async function confirmOwner(home, nonce, loginUrl, onStopped) {
  const path = endpoint(home)
  if (process.platform !== 'win32') {
    const info = await lstat(path)
    if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid()) throw invalid()
  }
  return new Promise((accept, reject) => {
    const socket = createConnection(path)
    let reply = '', admitted = false, disposed = false
    const dispose = () => { disposed = true; socket.destroy() }
    const stopped = () => {
      if (disposed) return
      dispose()
      if (admitted) onStopped?.()
      else reject(invalid())
    }
    socket.setTimeout(2_000, stopped)
    socket.on('error', stopped)
    socket.on('close', stopped)
    socket.on('end', stopped)
    socket.on('connect', () => socket.write(nonce + (onStopped ? ' watch' : '') + '\n'))
    socket.on('data', data => {
      if (admitted) return stopped()
      reply += data.toString('utf8')
      if (reply.length > 4_096) return stopped()
      if (!reply.includes('\n')) return
      if (reply !== JSON.stringify({ loginUrl }) + '\n') return stopped()
      admitted = true
      socket.setTimeout(0)
      if (!onStopped) dispose()
      accept(dispose)
    })
  })
}

function invalid() {
  return new DshDeveloperError('UI_DEVELOPMENT_SERVER_INVALID',
    'Select the private home directory returned by a running dsh-developer dev command.')
}

function owned(info, directory = false) {
  return !info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile() && info.nlink === 1)
    && (typeof process.getuid !== 'function' || info.uid === process.getuid())
    && (process.platform === 'win32' || (info.mode & 0o077) === 0)
}

export async function readDevelopmentBrowserTarget(home) {
  let file
  try {
    if (typeof home !== 'string' || !isAbsolute(home) || resolve(home) !== home
        || !/^dsh-developer-dev-[A-Za-z0-9]+$/u.test(basename(home))) throw invalid()
    if (!owned(await lstat(home), true) || await realpath(home) !== home) throw invalid()
    const path = join(home, 'server.json')
    const before = await lstat(path)
    if (!owned(before) || before.size > 8192) throw invalid()
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = await file.stat()
    if (!owned(info) || info.size > 8192 || info.dev !== before.dev || info.ino !== before.ino) throw invalid()
    const text = await file.readFile('utf8')
    if (Buffer.byteLength(text) > 8192) throw invalid()
    const value = JSON.parse(text)
    if (value.kind !== 'dsh-development-server-private' || value.version !== 1
        || value.host !== '127.0.0.1' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
        || !Number.isSafeInteger(value.pid) || value.pid < 1 || !/^[a-f0-9]{48}$/u.test(value.token)) throw invalid()
    const url = new URL(value.url)
    if (url.href !== value.url || url.origin !== 'http://127.0.0.1:' + value.port
        || url.pathname !== '/' || url.hash || url.username || url.password) throw invalid()
    const entries = [...url.searchParams]
    if (entries.length !== 0 && (entries.length !== 1 || entries[0][0] !== 'token'
        || !/^[A-Za-z0-9_-]{32,128}$/u.test(entries[0][1]))) throw invalid()
    process.kill(value.pid, 0)
    await confirmOwner(home, value.token, url.href)
    return { home, origin: url.origin, url: url.origin + '/', loginUrl: url.href,
      watchOwner: onStopped => confirmOwner(home, value.token, url.href, onStopped) }
  } catch {
    throw invalid()
  } finally { await file?.close() }
}

const initialized = new WeakMap()

// Pinned Playwright CLI's initPage hook runs in its Node process, before the page
// navigates. Nothing here is a page script or a model-supplied program.
export default async function initializeDevelopmentBrowser({ page }) {
  const context = page.context()
  if (!initialized.has(context)) {
    initialized.set(context, initialize(context))
  }
  await initialized.get(context)
}

function nativeCookie(headers, target) {
  const cookies = headers.getSetCookie()
  if (cookies.length !== 1 || cookies[0].length > 4_096) throw invalid()
  const [pair, ...attributes] = cookies[0].split(';').map(part => part.trim())
  const separator = pair.indexOf('=')
  const name = pair.slice(0, separator), value = pair.slice(separator + 1)
  const expected = 'dsh-auth-' + createHash('sha256').update(new URL(target.origin).host).digest('base64url')
  if (name !== expected || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(value)) throw invalid()
  const fields = new Map(attributes.map(part => {
    const [key, ...rest] = part.split('=')
    return [key.toLowerCase(), rest.join('=')]
  }))
  if (fields.size !== attributes.length || fields.get('path') !== '/' || fields.get('httponly') !== ''
      || fields.get('samesite')?.toLowerCase() !== 'strict' || fields.has('domain') || fields.has('secure')) throw invalid()
  // DSH verifies the signed expiry itself. This browser cookie lasts only for
  // its disposable context; no storage state, personal profile or trace is saved.
  return { name, value, url: target.url, httpOnly: true, sameSite: 'Strict', secure: false }
}

async function initialize(context) {
  let detach
  const controller = new AbortController()
  try {
    const target = await readDevelopmentBrowserTarget(process.env[DEVELOPMENT_SERVER_ENV])
    detach = await target.watchOwner(() => {
      controller.abort()
      void context.close().catch(() => {})
    })
    context.on('close', () => { controller.abort(); detach() })
    if (target.loginUrl !== target.url) {
      // Chromium's exact-port proxy policy also covers workers and redirects.
      // Node performs this one private exchange directly because Playwright's
      // APIRequest proxy bypass accepts hostnames, not the required host:port.
      const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)])
      const response = await fetch(target.loginUrl, { redirect: 'manual', signal: signal() })
      let cookie
      try {
        if (response.status !== 303 || response.headers.get('location') !== '/') throw invalid()
        cookie = nativeCookie(response.headers, target)
      } finally { await response.body?.cancel() }
      const ready = await fetch(target.url, { redirect: 'manual', signal: signal(),
        headers: { cookie: cookie.name + '=' + cookie.value } })
      try { if (ready.status !== 200) throw invalid() } finally { await ready.body?.cancel() }
      await context.addCookies([cookie])
    }
  } catch {
    detach?.()
    throw new Error('DSH development browser login failed. Keep dev running and open its current developmentServer reference.')
  }
}
