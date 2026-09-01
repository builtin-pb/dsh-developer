import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectWebRouteAuth } from '../lib/web-route-audit.js'

test('reports the M5 raw Web route as an authentication-boundary review without executing it', () => {
  const result = inspectWebRouteAuth(new Map([['index.js', [
    "export const inject = ['webServer']",
    'export function apply(ctx) {',
    '  ctx.webServer.register({',
    "    kind: 'prefix',",
    "    path: '/ping',",
    '    handler: (_req, res) => { res.writeHead(200); res.end("pong") },',
    '  })',
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })

  assert.deepEqual(result.rawRoutes, [{
    sourcePath: 'index.js',
    line: 3,
    call: 'ctx.webServer.register',
    kind: 'prefix',
    routePath: '/ping',
    authBoundary: 'raw-web-server',
    hostAuthentication: 'not-established-by-registration',
    intent: 'review-required',
  }])
  assert.deepEqual(result.connectionRoutes, [])
  assert.equal(result.repositoryCodeExecuted, false)
  assert.equal(result.lanes.release.target, '0.1.1-rc.2')
  assert.equal(result.lanes.preview.target, '0.1.2-alpha.3')
  assert.equal(result.coverage.absenceIsLocal, true)
})

test('distinguishes an authenticated connection registration from a raw Web route', () => {
  const result = inspectWebRouteAuth(new Map([['index.js', [
    "export const inject = ['connection']",
    'export function apply(ctx) {',
    "  ctx.connection.rpc.handle('/ping', async () => ({ ok: true }))",
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })

  assert.deepEqual(result.rawRoutes, [])
  assert.deepEqual(result.connectionRoutes, [{
    sourcePath: 'index.js',
    line: 3,
    call: 'ctx.connection.rpc.handle',
    routePath: '/ping',
    authBoundary: 'host-connection',
    hostAuthentication: 'connection-boundary',
    intent: 'authenticated-channel',
  }])
})

test('limits evidence to reachable modules and a proven package-entry apply context', () => {
  const files = new Map([
    ['index.js', [
      "import './lib/live.js'",
      '// import "./lib/unused.js"',
      'const quoted = \'ctx.webServer.register({ path: "/quoted" })\'',
      'const template = `webServer.register({ path: "/template" })`',
      'const pattern = /ctx\\.webServer\\.register\\(/',
      'export function apply() { return { quoted, template, pattern } }',
      '',
    ].join('\n')],
    ['lib/live.js', [
      "export const inject = ['connection']",
      "export const register = (ctx) => ctx.connection.rpc.handle('/live', async () => ({ ok: true }))",
      '',
    ].join('\n')],
    ['lib/unused.js', "ctx.webServer.register({ kind: 'prefix', path: '/unused' })\n"],
  ])

  const result = inspectWebRouteAuth(files, { entryPath: 'index.js' })
  assert.deepEqual(result.reachablePaths, ['index.js', 'lib/live.js'])
  assert.deepEqual(result.rawRoutes, [])
  assert.deepEqual(result.connectionRoutes, [])
  assert.equal(result.coverage.nestedOrShadowedContextBindings, 'not-claimed')
})

test('omits bare service calls when an exported inject or call-site binding is insufficient proof', () => {
  const destructured = inspectWebRouteAuth(new Map([['index.js', [
    "export const inject = ['webServer']",
    'export function apply({ webServer }) {',
    "  webServer.register({ kind: 'prefix', path: '/public', handler() {} })",
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })
  assert.deepEqual(destructured.rawRoutes, [])

  const nonExportedInject = inspectWebRouteAuth(new Map([['index.js', [
    "const inject = ['webServer']",
    'export function apply(ctx) {',
    "  webServer.register({ kind: 'prefix', path: '/not-a-contract' })",
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })
  assert.deepEqual(nonExportedInject.rawRoutes, [])

  const localShadow = inspectWebRouteAuth(new Map([['index.js', [
    "export const inject = ['webServer']",
    'export function apply(ctx) {',
    '  const webServer = { register() {} }',
    "  webServer.register({ kind: 'prefix', path: '/local-shadow' })",
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })
  assert.deepEqual(localShadow.rawRoutes, [])

  const unrelatedReachable = inspectWebRouteAuth(new Map([
    ['index.js', "export const inject = ['webServer']\nimport './helper.js'\nexport function apply() {}\n"],
    ['helper.js', [
      'const webServer = { register() {} }',
      "webServer.register({ kind: 'prefix', path: '/local-helper' })",
      '',
    ].join('\n')],
  ]), { entryPath: 'index.js' })
  assert.deepEqual(unrelatedReachable.rawRoutes, [])
  assert.equal(unrelatedReachable.coverage.bareServiceBindings, 'not-claimed')
})

test('omits nested owners and shadowed ctx bindings instead of claiming the DSH root context', () => {
  const nestedOwner = inspectWebRouteAuth(new Map([['index.js', [
    'export function apply(ctx) {',
    "  wrapper.ctx.webServer.register({ kind: 'prefix', path: '/nested-owner' })",
    "  wrapper.ctx.connection.rpc.handle('/nested-connection', async () => ({}))",
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })
  assert.deepEqual(nestedOwner.rawRoutes, [])
  assert.deepEqual(nestedOwner.connectionRoutes, [])

  const shadowed = inspectWebRouteAuth(new Map([['index.js', [
    'export function apply(ctx) {',
    '  function nested(ctx) {',
    "    ctx.connection.rpc.handle('/shadowed', async () => ({}))",
    '  }',
    "  ctx.webServer.register({ kind: 'prefix', path: '/root' })",
    '  return nested',
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })
  assert.deepEqual(shadowed.connectionRoutes, [])
  assert.deepEqual(shadowed.rawRoutes.map((value) => value.routePath), ['/root'])
})

test('omits lexical, catch, object-method, and class-method ctx bindings inside root apply', () => {
  const result = inspectWebRouteAuth(new Map([['index.js', [
    'export function apply(ctx) {',
    '  {',
    '    const ctx = localContext',
    "    ctx.webServer.register({ kind: 'prefix', path: '/block-shadow' })",
    '  }',
    '  try { throw localContext } catch (ctx) {',
    "    ctx.connection.rpc.handle('/catch-shadow', async () => ({}))",
    '  }',
    '  const handlers = {',
    '    run(ctx) {',
    "      ctx.webServer.register({ kind: 'prefix', path: '/object-method-shadow' })",
    '    },',
    '  }',
    '  class Feature {',
    '    run(ctx) {',
    "      ctx.connection.rpc.handle('/class-method-shadow', async () => ({}))",
    '    }',
    '  }',
    "  ctx.webServer.register({ kind: 'prefix', path: '/root' })",
    '  return { handlers, Feature }',
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })

  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/root'])
  assert.deepEqual(result.connectionRoutes, [])
})

test('proves an exported apply arrow while omitting a nested arrow context', () => {
  const result = inspectWebRouteAuth(new Map([['index.js', [
    'export const apply = (ctx) => {',
    '  const nested = (ctx) => {',
    "    ctx.connection.rpc.handle('/nested-arrow', async () => ({}))",
    '  }',
    "  ctx.webServer.register({ kind: 'prefix', path: '/arrow-root' })",
    '  return nested',
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })

  assert.deepEqual(result.connectionRoutes, [])
  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/arrow-root'])
})

test('does not claim coverage for dynamic or aliased route registration', () => {
  const result = inspectWebRouteAuth(new Map([['index.js', [
    "export const inject = ['webServer']",
    'export function apply(ctx) {',
    '  const register = ctx.webServer.register.bind(ctx.webServer)',
    "  register({ kind: 'prefix', path: '/alias' })",
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })

  assert.deepEqual(result.rawRoutes, [])
  assert.equal(result.coverage.dynamicOrAliasedRegistrations, 'not-claimed')
  assert.equal(result.coverage.absenceIsLocal, true)
})

test('scans executable template expressions while ignoring template text', () => {
  const result = inspectWebRouteAuth(new Map([['index.js', [
    'export function apply(ctx) {',
    '  const inert = `ctx.webServer.register({ path: "/inert" })`',
    "  return `${ctx.webServer.register({ kind: 'prefix', path: '/expression' })}`",
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })

  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/expression'])
})

test('treats regex literals after control heads as inert while preserving division-side calls', () => {
  const result = inspectWebRouteAuth(new Map([['index.js', [
    'export async function apply(ctx) {',
    '  if ((ready)) /ctx\\.webServer\\.register\\(/.test(source)',
    '  while (ready) /ctx\\.connection\\.rpc\\.handle\\(/.test(source)',
    '  for (; ready;) /ctx\\.webServer\\.register\\(/.test(source)',
    '  for await (const item of items) /ctx\\.connection\\.rpc\\.handle\\(/.test(item)',
    "  const quotient = total() / ctx.webServer.register({ kind: 'prefix', path: '/real' })",
    '  return quotient',
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })

  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/real'])
  assert.deepEqual(result.connectionRoutes, [])
})

test('omits erased TypeScript import queries while preserving proven runtime dynamic imports', () => {
  const result = inspectWebRouteAuth(new Map([
    ['index.ts', [
      "import type { RawRoute } from './types'",
      "export type { ConnectionRoute } from './exported'",
      "type Route = import('./query-types').Route",
      "interface Config { route: import('./interface-types').Route }",
      "type Wrapped = Promise<import('./generic-types').Value>",
      "function typed(value: import('./parameter-types').Value): import('./return-types').Value { return value }",
      "const runtimeModule = import('./dynamic-runtime')",
      "function loadRuntime() { return import('./return-runtime') }",
      "async function loadAwaited() { return await import('./await-runtime') }",
      "void import('./void-runtime')",
      "import { type RuntimeMeta, live } from './runtime'",
      'export function apply(ctx) { return { live: live(ctx), runtimeModule, loadRuntime, loadAwaited, typed } }',
      '',
    ].join('\n')],
    ['types.ts', [
      'export function apply(ctx) {',
      "  ctx.webServer.register({ kind: 'prefix', path: '/type-only-import' })",
      '}',
      '',
    ].join('\n')],
    ['exported.ts', [
      'export function apply(ctx) {',
      "  ctx.connection.rpc.handle('/type-only-export', async () => ({}))",
      '}',
      '',
    ].join('\n')],
    ['query-types.ts', 'export type Route = { path: string }\n'],
    ['interface-types.ts', 'export type Route = { path: string }\n'],
    ['generic-types.ts', 'export type Value = string\n'],
    ['parameter-types.ts', 'export type Value = string\n'],
    ['return-types.ts', 'export type Value = string\n'],
    ['dynamic-runtime.ts', 'export const loaded = true\n'],
    ['return-runtime.ts', 'export const loaded = true\n'],
    ['await-runtime.ts', 'export const loaded = true\n'],
    ['void-runtime.ts', 'export const loaded = true\n'],
    ['runtime.ts', 'export const live = (ctx: unknown) => ctx\nexport type RuntimeMeta = {}\n'],
  ]), { entryPath: 'index.ts' })

  assert.deepEqual(result.reachablePaths, [
    'await-runtime.ts',
    'dynamic-runtime.ts',
    'index.ts',
    'return-runtime.ts',
    'runtime.ts',
    'void-runtime.ts',
  ])
  assert.deepEqual(result.rawRoutes, [])
  assert.deepEqual(result.connectionRoutes, [])
})
