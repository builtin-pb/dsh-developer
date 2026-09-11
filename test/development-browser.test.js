import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { inspect } from 'node:util'
import initializeDevelopmentBrowser, {
  createDevelopmentBrowserHandoff, DEVELOPMENT_SERVER_ENV, readDevelopmentBrowserTarget,
} from '../lib/development-browser.js'

// Generate credentials only in memory. Assertions deliberately compare booleans
// instead of secret-bearing objects, so even regression failures cannot print them.
async function privateServer(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'development-browser-test-'))
  let close = async () => {}
  t.after(async () => {
    try { await close() } finally { await rm(root, { recursive: true, force: true }) }
  })
  const home = await mkdtemp(join(root, 'dsh-developer-dev-'))
  await chmod(home, 0o700)
  const path = join(home, 'server.json')
  const origin = 'http://127.0.0.1:43127'
  const loginToken = randomBytes(32).toString('base64url')
  const record = {
    kind: 'dsh-development-server-private', version: 1,
    host: '127.0.0.1', port: 43127, pid: process.pid,
    token: randomBytes(24).toString('hex'), url: origin + '/?token=' + loginToken,
  }
  const write = async (value = record) => {
    await writeFile(path, JSON.stringify(value), { mode: 0o600 })
    await chmod(path, 0o600)
  }
  await write()
  const start = async (options = {}, selectedHome = home) => {
    await close()
    close = await createDevelopmentBrowserHandoff(selectedHome, { nonce: record.token, loginUrl: record.url, ...options })
  }
  await start()
  return { root, home, path, origin, record, loginToken, write, start, close: () => close() }
}

function selectServer(t, home) {
  const previous = process.env[DEVELOPMENT_SERVER_ENV]
  if (home === undefined) delete process.env[DEVELOPMENT_SERVER_ENV]
  else process.env[DEVELOPMENT_SERVER_ENV] = home
  t.after(() => {
    if (previous === undefined) delete process.env[DEVELOPMENT_SERVER_ENV]
    else process.env[DEVELOPMENT_SERVER_ENV] = previous
  })
}

async function privateFailure(operation, fixture, code) {
  let failure
  try { await operation() } catch (error) { failure = error }
  assert.ok(failure instanceof Error, 'the unsafe operation must reject')
  const output = String(failure) + inspect(failure, { depth: 10 }) + JSON.stringify(failure)
  assert.ok(![fixture.home, fixture.record.token, fixture.record.url, fixture.loginToken]
    .some(value => output.includes(value)), 'errors must omit private paths, credentials, URLs and nested causes')
  if (code) assert.ok(failure.code === code, 'invalid references must have the public diagnostic code')
  else assert.ok(/^DSH development browser login failed\./u.test(failure.message), 'login failures must be generic')
  return failure
}

const invalidTarget = (fixture, home = fixture.home) => privateFailure(
  () => readDevelopmentBrowserTarget(home), fixture, 'UI_DEVELOPMENT_SERVER_INVALID',
)

test('development browser reads a private live reference and separates login from page URLs', async t => {
  const fixture = await privateServer(t)
  const target = await readDevelopmentBrowserTarget(fixture.home)
  assert.ok(target.home === fixture.home)
  assert.ok(target.origin === fixture.origin)
  assert.ok(target.url === fixture.origin + '/', 'page URL must omit the launch credential')
  assert.ok(target.loginUrl === fixture.record.url, 'the private login URL must remain intact')

  // Older DSH versions publish an unauthenticated root; these remain usable.
  await fixture.write({ ...fixture.record, url: fixture.origin + '/' })
  await fixture.start({ loginUrl: fixture.origin + '/' })
  const legacy = await readDevelopmentBrowserTarget(fixture.home)
  assert.ok(legacy.url === fixture.origin + '/' && legacy.loginUrl === legacy.url)
})

test('development browser rejects noncanonical and indirect home references', async t => {
  const cases = [
    ['relative path', f => basename(f.home)],
    ['trailing separator', f => f.home + '/'],
    ['dot segment', f => f.home + '/.'],
    ['parent traversal', f => f.home + '/../' + basename(f.home)],
    ['ordinary directory with the wrong name', async f => {
      const path = join(f.root, 'ordinary-home')
      await rename(f.home, path)
      return path
    }],
    ['missing home', f => join(f.root, 'dsh-developer-dev-Missing')],
    ['home is a file', async f => {
      const path = join(f.root, 'dsh-developer-dev-File')
      await writeFile(path, JSON.stringify(f.record), { mode: 0o600 })
      return path
    }],
    ['home symlink', async f => {
      const path = join(f.root, 'dsh-developer-dev-Alias')
      await symlink(f.home, path, 'junction')
      return path
    }],
    ['ancestor symlink', async f => {
      const path = join(f.root, 'alias')
      await symlink(f.root, path, 'junction')
      return join(path, basename(f.home))
    }],
    ['non-string reference', () => ({})],
  ]
  for (const [name, select] of cases) await t.test(name, async t => {
    const fixture = await privateServer(t)
    const home = await select(fixture)
    // A matching live owner must not mask a missing path/canonicality check.
    if (typeof home === 'string') await fixture.start({}, home)
    await invalidTarget(fixture, home)
  })
})

test('development browser rejects shared permissions on the home or server record', {
  skip: process.platform === 'win32',
}, async t => {
  for (const [name, field, mode] of [
    ['group-readable home', 'home', 0o740],
    ['group-writable home', 'home', 0o720],
    ['world-searchable home', 'home', 0o701],
    ['group-readable record', 'path', 0o640],
    ['group-writable record', 'path', 0o620],
    ['world-readable record', 'path', 0o604],
  ]) await t.test(name, async t => {
    const fixture = await privateServer(t)
    await chmod(fixture[field], mode)
    await invalidTarget(fixture)
  })
})

test('development browser rejects records that are missing, directories, symlinks or hardlinks', async t => {
  for (const kind of ['missing', 'directory', 'symlink', 'hardlink']) await t.test(kind, async t => {
    const fixture = await privateServer(t)
    if (kind === 'hardlink') await link(fixture.path, join(fixture.root, 'second-name'))
    else {
      const original = join(fixture.root, 'original.json')
      await rename(fixture.path, original)
      if (kind === 'directory') await mkdir(fixture.path, { mode: 0o700 })
      if (kind === 'symlink') await symlink(original, fixture.path, 'file')
    }
    await invalidTarget(fixture)
  })
})

test('development browser rejects references owned by a different effective caller', {
  skip: typeof process.getuid !== 'function',
}, async t => {
  const fixture = await privateServer(t)
  const uid = process.getuid()
  // Files remain real and unchanged; simulate a caller that does not own them.
  t.mock.method(process, 'getuid', () => uid + 1)
  await invalidTarget(fixture)
})

test('development browser rejects malformed and oversized private records without quoting them', async t => {
  for (const [name, content] of [
    ['truncated JSON containing credentials', f => JSON.stringify(f.record).slice(0, -1)],
    ['oversized otherwise-valid JSON', f => JSON.stringify({ ...f.record, extra: 'x'.repeat(8192) })],
    ['null record', () => 'null'],
    ['array record', () => '[]'],
    ['wrong record kind', f => JSON.stringify({ ...f.record, kind: 'dsh-development-server' })],
    ['unknown version', f => JSON.stringify({ ...f.record, version: 2 })],
    ['missing ownership credential', f => JSON.stringify({ ...f.record, token: undefined })],
    ['malformed ownership credential', f => JSON.stringify({ ...f.record, token: f.loginToken })],
    ['non-loopback host', f => JSON.stringify({ ...f.record, host: '0.0.0.0' })],
    ['string port', f => JSON.stringify({ ...f.record, port: String(f.record.port) })],
    ['zero port', f => JSON.stringify({ ...f.record, port: 0 })],
    ['out-of-range port', f => JSON.stringify({ ...f.record, port: 65536 })],
    ['process group instead of pid', f => JSON.stringify({ ...f.record, pid: -1 })],
    ['fractional pid', f => JSON.stringify({ ...f.record, pid: 1.5 })],
  ]) await t.test(name, async t => {
    const fixture = await privateServer(t)
    if (name === 'missing ownership credential') await fixture.start({ nonce: undefined })
    if (name === 'malformed ownership credential') await fixture.start({ nonce: fixture.loginToken })
    await writeFile(fixture.path, content(fixture))
    await invalidTarget(fixture)
  })
})

test('development browser accepts only the exact localhost root and bounded launch credential', async t => {
  const cases = [
    ['remote host', f => 'http://example.invalid:43127/?token=' + f.loginToken],
    ['localhost alias', f => f.record.url.replace('127.0.0.1', 'localhost')],
    ['deceptive host suffix', f => f.record.url.replace('127.0.0.1', '127.0.0.1.example.invalid')],
    ['alternate numeric loopback', f => f.record.url.replace('127.0.0.1', '2130706433')],
    ['different port', f => f.record.url.replace(':43127', ':43128')],
    ['different protocol', f => f.record.url.replace('http:', 'https:')],
    ['URL credentials', f => f.record.url.replace('http://', 'http://user:pass@')],
    ['non-root path', f => f.record.url.replace('/?', '/login?')],
    ['normalized parent path', f => f.record.url.replace('/?', '/a/../?')],
    ['fragment', f => f.record.url + '#private'],
    ['leading whitespace', f => ' ' + f.record.url],
    ['duplicate launch credential', f => f.record.url + '&token=' + f.loginToken],
    ['unrecognized query', f => f.record.url + '&next=https://example.invalid/'],
    ['empty launch credential', f => f.origin + '/?token='],
    ['short launch credential', f => f.origin + '/?token=' + f.loginToken.slice(0, 31)],
    ['oversized launch credential', f => f.origin + '/?token=' + f.loginToken.repeat(4)],
    ['credential with encoded separator', f => f.record.url + '%2F'],
  ]
  for (const [name, url] of cases) await t.test(name, async t => {
    const fixture = await privateServer(t)
    const loginUrl = url(fixture)
    await fixture.write({ ...fixture.record, url: loginUrl })
    // Authenticate the exact bad value, so rejection must come from validation
    // rather than an unrelated mismatch with the handoff response.
    await fixture.start({ loginUrl })
    await invalidTarget(fixture)
  })
})

test('development browser requires live owner confirmation even when the recorded PID is still alive', async t => {
  for (const name of ['closed owner', 'stopped development server', 'wrong nonce', 'different private URL', 'removed home']) {
    await t.test(name, async t => {
      const fixture = await privateServer(t)
      assert.ok(fixture.record.pid === process.pid, 'the reference deliberately has a live, reusable PID')
      if (name === 'closed owner') await Promise.all([fixture.close(), fixture.close()])
      if (name === 'stopped development server') await fixture.start({ isRunning: () => false })
      if (name === 'wrong nonce') await fixture.write({ ...fixture.record, token: randomBytes(24).toString('hex') })
      if (name === 'different private URL') await fixture.start({ loginUrl: fixture.origin + '/' })
      if (name === 'removed home') await rm(fixture.home, { recursive: true })
      await invalidTarget(fixture)
    })
  }
})

function browserHarness(t, { addCookiesError } = {}) {
  const listeners = new Map()
  const state = { cookies: [], navigations: [], closeCalls: 0 }
  let closed = false, notifyClosed
  const whenClosed = new Promise(resolve => { notifyClosed = resolve })
  const context = {
    addCookies: async cookies => {
      if (addCookiesError) throw addCookiesError
      state.cookies.push(cookies)
    },
    on: (event, callback) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(callback)
      return context
    },
    close: async () => {
      state.closeCalls++
      if (closed) return
      closed = true
      for (const callback of listeners.get('close') ?? []) callback()
      notifyClosed()
    },
  }
  t.after(async () => { if (!closed) await context.close() })
  const page = () => ({ context: () => context, goto: async url => { state.navigations.push(url) } })
  return { context, page, state, whenClosed }
}

function nativeCookieFixture(fixture) {
  const authority = new URL(fixture.origin).host
  const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
  const value = 'v1.' + randomBytes(24).toString('base64url') + '.' + randomBytes(32).toString('base64url')
  const pair = name + '=' + value
  return { name, value, pair, header: pair + '; HttpOnly; Path=/; SameSite=Strict' }
}

function privateExchange(t, cookie, {
  status = 303, location = '/', readyStatus = 200, cookies = [cookie.header],
  fetchError, readyError, cancelError, onReady,
} = {}) {
  const state = { requests: [], cancelled: 0 }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    state.requests.push({ url, options })
    const login = state.requests.length % 2 === 1
    if (fetchError) throw fetchError
    if (!login && readyError) throw readyError
    if (!login) await onReady?.(options)
    return {
      status: login ? status : readyStatus,
      headers: new Headers(login ? [['location', location], ...cookies.map(value => ['set-cookie', value])] : []),
      body: { cancel: async () => {
        state.cancelled++
        if (cancelError) throw cancelError
      } },
    }
  })
  return state
}

async function loginFailure(operation, fixture, cookie, rejectedCookies = []) {
  const failure = await privateFailure(operation, fixture)
  const output = String(failure) + inspect(failure, { depth: 10 }) + JSON.stringify(failure)
  const values = rejectedCookies.map(header => header.slice(header.indexOf('=') + 1).split(';', 1)[0])
  assert.ok(![cookie.value, ...values].some(value => value && output.includes(value)),
    'login errors must not expose signed or rejected session cookies or a nested cause')
}

async function waitForClose(browser) {
  let timer
  try {
    await Promise.race([browser.whenClosed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('browser must close when its development owner disappears')), 1500)
    })])
  } finally { clearTimeout(timer) }
}

test('development browser privately authenticates once per context without navigating a page', async t => {
  const fixture = await privateServer(t)
  selectServer(t, fixture.home)
  const cookie = nativeCookieFixture(fixture)
  // Native expiry attributes are accepted, but the isolated browser gets only a
  // generated session cookie; it must never import arbitrary Set-Cookie fields.
  const exchange = privateExchange(t, cookie, {
    cookies: [cookie.header + '; Max-Age=3600; Expires=Wed, 01 Jan 2031 00:00:00 GMT'],
  })
  const browser = browserHarness(t)
  await Promise.all(Array.from({ length: 5 }, () => initializeDevelopmentBrowser({ page: browser.page() })))
  await initializeDevelopmentBrowser({ page: browser.page() })
  assert.equal(exchange.requests.length, 2, 'one native exchange and one clean-root verification per context')
  assert.ok(exchange.requests[0].url === fixture.record.url, 'the launch credential goes only to private Node fetch')
  assert.ok(exchange.requests[1].url === fixture.origin + '/', 'readiness must use the clean root URL')
  assert.ok(new Headers(exchange.requests[0].options.headers).get('cookie') === null)
  assert.ok(new Headers(exchange.requests[1].options.headers).get('cookie') === cookie.pair,
    'readiness must send only the validated native session cookie')
  for (const { options } of exchange.requests) {
    assert.equal(options.redirect, 'manual', 'neither private request may follow a redirect')
    assert.ok(options.signal instanceof AbortSignal && !options.signal.aborted)
  }
  assert.equal(exchange.cancelled, 2)
  assert.equal(browser.state.cookies.length, 1, 'install cookies only once after successful verification')
  assert.equal(browser.state.cookies[0].length, 1, 'install only the native DSH cookie')
  const installed = browser.state.cookies[0][0]
  assert.deepEqual(Object.keys(installed).sort(), ['httpOnly', 'name', 'sameSite', 'secure', 'url', 'value'])
  assert.ok(installed.name === cookie.name && installed.value === cookie.value)
  assert.ok(installed.url === fixture.origin + '/', 'scope the cookie to the clean development root')
  assert.equal(installed.httpOnly, true)
  assert.equal(installed.sameSite, 'Strict')
  assert.equal(installed.secure, false)
  assert.equal(browser.state.navigations.length, 0, 'authentication must never navigate a page')
  assert.equal(browser.state.closeCalls, 0)

  const independent = browserHarness(t)
  await initializeDevelopmentBrowser({ page: independent.page() })
  assert.equal(exchange.requests.length, 4, 'a separate context requires a separate authentication')
  assert.equal(independent.state.cookies.length, 1)
})

test('development browser rejects malformed or foreign native cookies before sending them to the clean root', async t => {
  for (const [name, mutate] of [
    ['missing cookie', () => []],
    ['multiple cookies', c => [c.header, 'unrelated=value; Path=/']],
    ['duplicate cookie', c => [c.header, c.header]],
    ['wrong name', c => [c.header.replace(c.name, 'unrelated')]],
    ['cookie for a different authority', c => [c.header.replace(c.name,
      'dsh-auth-' + createHash('sha256').update('127.0.0.1:43128').digest('base64url'))]],
    ['unsigned value', c => [c.header.replace(c.value, randomBytes(32).toString('base64url'))]],
    ['unknown value version', c => [c.header.replace('v1.', 'v2.')]],
    ['empty signed payload', c => [c.header.replace(c.value, 'v1..' + randomBytes(32).toString('base64url'))]],
    ['short MAC', c => [c.header.replace(c.value, c.value.slice(0, -1))]],
    ['long MAC', c => [c.header.replace(c.value, c.value + 'a')]],
    ['non-base64url MAC', c => [c.header.replace(c.value, c.value.slice(0, -1) + '/')]],
    ['missing HttpOnly', c => [c.header.replace('; HttpOnly', '')]],
    ['valued HttpOnly', c => [c.header.replace('HttpOnly', 'HttpOnly=false')]],
    ['missing path', c => [c.header.replace('; Path=/', '')]],
    ['non-root path', c => [c.header.replace('Path=/', 'Path=/other')]],
    ['missing SameSite', c => [c.header.replace('; SameSite=Strict', '')]],
    ['weakened SameSite', c => [c.header.replace('SameSite=Strict', 'SameSite=Lax')]],
    ['domain attribute', c => [c.header + '; Domain=127.0.0.1']],
    ['secure attribute on native HTTP cookie', c => [c.header + '; Secure']],
    ['duplicate attributes with different case', c => [c.header + '; PATH=/']],
    ['oversized cookie', c => [c.header + '; Max-Age=' + '1'.repeat(4096)]],
  ]) await t.test(name, async t => {
    const fixture = await privateServer(t)
    selectServer(t, fixture.home)
    const cookie = nativeCookieFixture(fixture)
    const cookies = mutate(cookie)
    const exchange = privateExchange(t, cookie, { cookies })
    const browser = browserHarness(t)
    await loginFailure(() => initializeDevelopmentBrowser({ page: browser.page() }), fixture, cookie, cookies)
    assert.equal(exchange.requests.length, 1, 'reject untrusted cookies before any subsequent request')
    assert.equal(exchange.cancelled, 1)
    assert.equal(browser.state.cookies.length, 0)
    assert.equal(browser.state.navigations.length, 0)
  })
})

test('development browser reports generic private fetch and login failures without retrying a failed context', async t => {
  for (const name of ['missing reference', 'bad reference', 'request failure', 'aborted request', 'unexpected status',
    'remote redirect', 'non-root redirect', 'unauthenticated root', 'redirecting root', 'root request failure',
    'response cleanup failure', 'cookie installation failure']) {
    await t.test(name, async t => {
      const fixture = await privateServer(t)
      selectServer(t, name === 'missing reference' ? undefined : fixture.home)
      if (name === 'bad reference') await fixture.write({ ...fixture.record, host: 'example.invalid' })
      const cookie = nativeCookieFixture(fixture)
      const sensitiveError = new Error(fixture.home + ' ' + fixture.record.token + ' ' + fixture.record.url,
        { cause: new Error(cookie.value) })
      if (name === 'aborted request') sensitiveError.name = 'AbortError'
      const exchange = privateExchange(t, cookie, {
        ...(['request failure', 'aborted request'].includes(name) ? { fetchError: sensitiveError } : {}),
        ...(name === 'unexpected status' ? { status: 200 } : {}),
        ...(name === 'remote redirect' ? { location: 'https://example.invalid/' } : {}),
        ...(name === 'non-root redirect' ? { location: '/other' } : {}),
        ...(name === 'unauthenticated root' ? { readyStatus: 401 } : {}),
        ...(name === 'redirecting root' ? { readyStatus: 303 } : {}),
        ...(name === 'root request failure' ? { readyError: sensitiveError } : {}),
        ...(name === 'response cleanup failure' ? { cancelError: sensitiveError } : {}),
      })
      const browser = browserHarness(t, name === 'cookie installation failure' ? { addCookiesError: sensitiveError } : {})
      await Promise.all(Array.from({ length: 3 }, () => loginFailure(
        () => initializeDevelopmentBrowser({ page: browser.page() }), fixture, cookie,
      )))
      await loginFailure(() => initializeDevelopmentBrowser({ page: browser.page() }), fixture, cookie)
      const noRequest = ['missing reference', 'bad reference'].includes(name)
      const reachesRoot = ['unauthenticated root', 'redirecting root', 'root request failure', 'cookie installation failure'].includes(name)
      assert.equal(exchange.requests.length, noRequest ? 0 : reachesRoot ? 2 : 1)
      assert.equal(browser.state.cookies.length, 0)
      assert.equal(browser.state.navigations.length, 0)
    })
  }
})

test('development browser watches a legacy root without a login exchange or cookie installation', async t => {
  const fixture = await privateServer(t)
  await fixture.write({ ...fixture.record, url: fixture.origin + '/' })
  await fixture.start({ loginUrl: fixture.origin + '/' })
  selectServer(t, fixture.home)
  const exchange = privateExchange(t, nativeCookieFixture(fixture))
  const browser = browserHarness(t)
  await initializeDevelopmentBrowser({ page: browser.page() })
  assert.equal(exchange.requests.length, 0)
  assert.equal(browser.state.cookies.length, 0)
  assert.equal(browser.state.navigations.length, 0)
  assert.equal(browser.state.closeCalls, 0)
  await fixture.close()
  await waitForClose(browser)
  assert.equal(browser.state.closeCalls, 1)
})

test('an authenticated development browser closes when its live owner disconnects even with the PID alive', async t => {
  const fixture = await privateServer(t)
  selectServer(t, fixture.home)
  const exchange = privateExchange(t, nativeCookieFixture(fixture))
  const browser = browserHarness(t)
  await initializeDevelopmentBrowser({ page: browser.page() })
  assert.equal(browser.state.cookies.length, 1, 'establish an authenticated context before stopping its owner')
  assert.equal(browser.state.closeCalls, 0)
  await fixture.close()
  assert.equal(fixture.record.pid, process.pid)
  assert.doesNotThrow(() => process.kill(fixture.record.pid, 0))
  // No navigation or new request is needed to notice the lost owner.
  await waitForClose(browser)
  assert.equal(browser.state.closeCalls, 1)
  assert.equal(exchange.requests.length, 2, 'owner loss must not retry the private exchange')
  assert.ok(exchange.requests.every(({ options }) => options.signal.aborted))
})

test('closing an authenticated browser detaches its owner watch', async t => {
  const fixture = await privateServer(t)
  selectServer(t, fixture.home)
  const exchange = privateExchange(t, nativeCookieFixture(fixture))
  const browser = browserHarness(t)
  await initializeDevelopmentBrowser({ page: browser.page() })
  await browser.context.close()
  assert.ok(exchange.requests.every(({ options }) => options.signal.aborted))
  await fixture.close()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(browser.state.closeCalls, 1, 'owner exit must not notify a context whose watch was detached')
})

test('closing the browser aborts pending authentication without installing a cookie', { timeout: 3000 }, async t => {
  const fixture = await privateServer(t)
  selectServer(t, fixture.home)
  const cookie = nativeCookieFixture(fixture)
  const browser = browserHarness(t)
  let enteredRoot
  const atRoot = new Promise(resolve => { enteredRoot = resolve })
  const exchange = privateExchange(t, cookie, { onReady: options => new Promise((_, reject) => {
    enteredRoot()
    options.signal.addEventListener('abort', () => reject(new Error(cookie.value)), { once: true })
  }) })
  const failed = loginFailure(() => initializeDevelopmentBrowser({ page: browser.page() }), fixture, cookie)
  await atRoot
  await browser.context.close()
  await failed
  assert.equal(browser.state.cookies.length, 0, 'a closed context must not receive the session cookie')
  assert.ok(exchange.requests[1].options.signal.aborted)
  await fixture.close()
  // Let the local socket close events run; a detached watch must not close the
  // browser a second time when the development owner subsequently exits.
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(browser.state.closeCalls, 1)
})
