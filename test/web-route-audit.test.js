import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXECUTABLE_EXPORT_CHAIN_LIMIT,
  EXECUTABLE_GRAPH_SOURCE_BYTES_LIMIT,
  EXECUTABLE_MODULE_EDGE_LIMIT,
  EXECUTABLE_MODULE_LIMIT,
  EXECUTABLE_SOURCE_BYTES_LIMIT,
  inspectExecutableModuleClosure,
  inspectExecutableModuleMetadata,
  inspectWebRouteAuth,
} from '../lib/web-route-audit.js'

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
  assert.equal(unrelatedReachable.coverage.bareServiceBindings, 'coverage-incomplete')
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

test('resolves direct, async, named-expression, and local-alias apply exports', () => {
  const sources = [
    [
      'export async function apply(ctx) {',
      "  ctx.webServer.register({ kind: 'prefix', path: '/direct-async' })",
      '}',
    ].join('\n'),
    [
      'export const apply = async function namedApply(ctx) {',
      "  ctx.webServer.register({ kind: 'prefix', path: '/named-expression' })",
      '}',
    ].join('\n'),
    [
      'async function activate(ctx) {',
      "  ctx.webServer.register({ kind: 'prefix', path: '/local-alias' })",
      '}',
      'export { activate as apply }',
    ].join('\n'),
    [
      'const activate = (ctx) => {',
      "  ctx.webServer.register({ kind: 'prefix', path: '/local-variable-alias' })",
      '}',
      'export { activate as apply }',
    ].join('\n'),
  ]
  const expected = [
    '/direct-async', '/named-expression', '/local-alias', '/local-variable-alias',
  ]
  for (let index = 0; index < sources.length; index += 1) {
    const result = inspectWebRouteAuth(new Map([['index.js', sources[index]]]), {
      entryPath: 'index.js',
    })
    assert.deepEqual(result.rawRoutes.map((value) => value.routePath), [expected[index]])
    assert.deepEqual(result.coverage.incompletePaths, [])
  }
})

test('resolves explicit imported aliases and bounded static re-export chains', () => {
  const reexported = inspectWebRouteAuth(new Map([
    ['index.js', "export { middle as apply } from './middle.js'\n"],
    ['middle.js', "export { activate as middle } from './impl.js'\n"],
    ['impl.js', [
      'export async function activate(ctx) {',
      "  ctx.webServer.register({ kind: 'prefix', path: '/reexported' })",
      '}',
    ].join('\n')],
  ]), { entryPath: 'index.js' })
  assert.deepEqual(reexported.reachablePaths, ['impl.js', 'index.js', 'middle.js'])
  assert.deepEqual(reexported.rawRoutes.map((value) => ({
    path: value.routePath,
    source: value.sourcePath,
  })), [{ path: '/reexported', source: 'impl.js' }])
  assert.deepEqual(reexported.coverage.incompletePaths, [])

  const importedAlias = inspectWebRouteAuth(new Map([
    ['index.js', "import { activate as local } from './impl.js'\nexport { local as apply }\n"],
    ['impl.js', [
      'export function activate(ctx) {',
      "  ctx.connection.rpc.handle('/imported-alias', async () => ({}))",
      '}',
    ].join('\n')],
  ]), { entryPath: 'index.js' })
  assert.deepEqual(importedAlias.connectionRoutes.map((value) => value.routePath), [
    '/imported-alias',
  ])

  const defaultAlias = inspectWebRouteAuth(new Map([
    ['index.js', "export { default as apply } from './impl.js'\n"],
    ['impl.js', [
      'export default function named(ctx) {',
      "  ctx.webServer.register({ kind: 'prefix', path: '/default-alias' })",
      '}',
    ].join('\n')],
  ]), { entryPath: 'index.js' })
  assert.deepEqual(defaultAlias.rawRoutes.map((value) => value.routePath), [
    '/default-alias',
  ])
  assert.deepEqual(defaultAlias.coverage.incompletePaths, [])

  const directoryTsx = inspectWebRouteAuth(new Map([
    ['index.ts', "export { apply } from './tsx-impl'\n"],
    ['tsx-impl/index.tsx', [
      'export const apply = (ctx: HostContext) => {',
      "  ctx.webServer.register({ kind: 'prefix', path: '/directory-tsx' })",
      '  return <View />',
      '}',
    ].join('\n')],
  ]), { entryPath: 'index.ts' })
  assert.deepEqual(directoryTsx.rawRoutes.map((value) => value.routePath), [
    '/directory-tsx',
  ])
  assert.deepEqual(directoryTsx.coverage.incompletePaths, [])

  const files = new Map()
  for (let index = 0; index <= EXECUTABLE_EXPORT_CHAIN_LIMIT; index += 1) {
    files.set(`chain${index}.js`, index === EXECUTABLE_EXPORT_CHAIN_LIMIT
      ? 'export function apply(ctx) {}\n'
      : `export { apply } from './chain${index + 1}.js'\n`)
  }
  const bounded = inspectWebRouteAuth(files, { entryPath: 'chain0.js' })
  assert.deepEqual(bounded.rawRoutes, [])
  assert.ok(bounded.coverage.incompletePaths.includes('chain0.js'))
})

test('attributes routes only to the exact apply binding and its own executable body', () => {
  const result = inspectWebRouteAuth(new Map([['index.js', [
    'export function apply(ctx) {',
    "  naked: { ctx.webServer.register({ kind: 'prefix', path: '/labeled' }) }",
    "  { ctx.webServer.register({ kind: 'prefix', path: '/naked' }) }",
    '  const nested = () => typeof',
    "    ctx.webServer.register({ kind: 'prefix', path: '/nested-capture' })",
    '  class RouteBase extends ctx.webServer.register({ kind: "prefix", path: "/heritage" }) {',
    "    method() { ctx.webServer.register({ kind: 'prefix', path: '/class-method' }) }",
    '  }',
    "  try { throw local } catch (ctx) { ctx.webServer.register({ kind: 'prefix', path: '/catch' }) }",
    "  for (let ctx of contexts) { ctx.webServer.register({ kind: 'prefix', path: '/loop' }) }",
    '  return { nested, RouteBase }',
    '}',
  ].join('\n')]]), { entryPath: 'index.js' })

  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), [
    '/labeled', '/naked', '/heritage',
  ])
})

test('marks star, missing, mutable, and cyclic apply exports incomplete', () => {
  const cases = [
    new Map([
      ['index.js', "export * from './impl.js'\n"],
      ['impl.js', "export function apply(ctx) { ctx.webServer.register({ path: '/star' }) }\n"],
    ]),
    new Map([['index.js', "export { apply } from './missing.js'\n"]]),
    new Map([['index.js', [
      "let apply = (ctx) => ctx.webServer.register({ path: '/mutable' })",
      'apply = replacement',
      'export { apply }',
    ].join('\n')]]),
    new Map([
      ['index.js', "export { apply } from './cycle.js'\n"],
      ['cycle.js', "export { apply } from './index.js'\n"],
    ]),
  ]
  for (const files of cases) {
    const result = inspectWebRouteAuth(files, { entryPath: 'index.js' })
    assert.deepEqual(result.rawRoutes, [])
    assert.ok(result.coverage.incompletePaths.includes('index.js'))
  }
})

test('bounds the reachable module graph without losing the trusted entry route', () => {
  const files = new Map()
  for (let index = 0; index <= EXECUTABLE_MODULE_LIMIT; index += 1) {
    files.set(`module${index}.js`, index === EXECUTABLE_MODULE_LIMIT
      ? 'export const end = true\n'
      : `import './module${index + 1}.js'\nexport const value${index} = true\n`)
  }
  files.set('module0.js', [
    "import './module1.js'",
    'export function apply(ctx) {',
    "  ctx.webServer.register({ kind: 'prefix', path: '/bounded-modules' })",
    '}',
  ].join('\n'))
  const result = inspectWebRouteAuth(files, { entryPath: 'module0.js' })
  assert.equal(result.reachablePaths.length, EXECUTABLE_MODULE_LIMIT)
  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/bounded-modules'])
  assert.ok(result.coverage.incompletePaths.includes('module0.js'))

  const closure = inspectExecutableModuleClosure(files, { entryPaths: ['module0.js'] })
  assert.equal(closure.modules.length, EXECUTABLE_MODULE_LIMIT)
  assert.deepEqual(closure.incompletePaths, ['module0.js'])
  assert.deepEqual(closure.resources.exhausted, ['modules'])
  assert.equal(Object.isFrozen(closure.modules[0]), true)
})

test('classifies optional routes while making aliased route coverage incomplete', () => {
  const result = inspectWebRouteAuth(new Map([['index.js', [
    "export const inject = ['webServer']",
    'export function apply(ctx) {',
    '  const register = ctx.webServer.register.bind(ctx.webServer)',
    "  register({ kind: 'prefix', path: '/alias' })",
    "  ctx?.webServer.register({ kind: 'prefix', path: '/optional-raw' })",
    "  ctx?.connection.rpc.handle('/optional-connection', async () => ({}))",
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })

  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/optional-raw'])
  assert.deepEqual(result.connectionRoutes.map((value) => value.routePath), [
    '/optional-connection',
  ])
  assert.equal(result.coverage.dynamicOrAliasedRegistrations, 'coverage-incomplete')
  assert.equal(result.coverage.optionalOrLiteralComputedRegistrations, 'classified')
  assert.deepEqual(result.coverage.incompletePaths, ['index.js'])
  assert.equal(result.coverage.absenceIsLocal, true)
})

test('requires ctx as the first runtime parameter and admits later configuration parameters', () => {
  for (const source of [
    "export function apply(other, ctx) { ctx.webServer.register({ path: '/second' }) }",
    "export function apply(...ctx) { ctx.webServer.register({ path: '/rest' }) }",
  ]) {
    const result = inspectWebRouteAuth(new Map([['index.js', source]]), { entryPath: 'index.js' })
    assert.deepEqual(result.rawRoutes, [])
    assert.deepEqual(result.coverage.incompletePaths, ['index.js'])
  }
  for (const [source, expected] of [
    ["export function apply(ctx, config) { ctx.webServer.register({ path: '/config' }) }", '/config'],
    ["export function apply(ctx, config = {}, internals = {}) { ctx.webServer.register({ path: '/internals' }) }", '/internals'],
    ["export function apply(ctx = local, config = {}) { ctx.webServer.register({ path: '/default' }) }", '/default'],
  ]) {
    const result = inspectWebRouteAuth(new Map([['index.js', source]]), { entryPath: 'index.js' })
    assert.deepEqual(result.rawRoutes.map((value) => value.routePath), [expected])
    assert.deepEqual(result.coverage.incompletePaths, [])
  }
  const bodyOnly = inspectWebRouteAuth(new Map([['index.js', [
    "export function apply(ctx = ctx.webServer.register({ path: '/initializer' }), config = {}) {",
    "  ctx.webServer.register({ path: '/body' })",
    '}',
  ].join('\n')]]), { entryPath: 'index.js' })
  assert.deepEqual(bodyOnly.rawRoutes.map((value) => value.routePath), ['/body'])
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

test('keeps tagged-template routes inside a shadowing arrow scope', () => {
  const result = inspectWebRouteAuth(new Map([['index.js', [
    'export function apply(ctx) {',
    '  const nested = (ctx) => tag',
    "    `${ctx.webServer.register({ kind: 'prefix', path: '/nested-first' })}` +",
    "    `${ctx.connection.rpc.handle('/nested-second', async () => ({}))}`",
    "  ctx.webServer.register({ kind: 'prefix', path: '/root' })",
    '  return nested',
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })

  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/root'])
  assert.deepEqual(result.connectionRoutes, [])
})

test('treats regex literals after control heads as inert while preserving division-side calls', () => {
  const result = inspectWebRouteAuth(new Map([['index.js', [
    'export async function apply(ctx) {',
    '  if ((ready)) /ctx\\.webServer\\.register\\(/.test(source)',
    '  while (ready) /ctx\\.connection\\.rpc\\.handle\\(/.test(source)',
    '  for (; ready;) /ctx\\.webServer\\.register\\(/.test(source)',
    '  for await (const item of items) /ctx\\.connection\\.rpc\\.handle\\(/.test(item)',
    '  const pattern = new /ctx\\.webServer\\.register\\(/',
    '  while (ready) { break',
    '    /ctx\\.webServer\\.register\\(/.test(source)',
    '  }',
    '  debugger',
    '  /ctx\\.connection\\.rpc\\.handle\\(/.test(source)',
    "  const quotient = total() / ctx.webServer.register({ kind: 'prefix', path: '/real' })",
    '  return quotient',
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })

  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/real'])
  assert.deepEqual(result.connectionRoutes, [])
})

test('distinguishes declaration blocks from function, arrow, class, object, and postfix division', () => {
  const result = inspectWebRouteAuth(new Map([['index.js', [
    'export function apply(ctx) {',
    '  function nested() {}',
    '  /ctx\\.webServer\\.register\\(/.test(afterFunction)',
    '  if (ready) {}',
    '  /ctx\\.connection\\.rpc\\.handle\\(/.test(afterIf)',
    '  class Feature {}',
    '  /ctx\\.webServer\\.register\\(/.test(afterClass)',
    "  const objectValue = {} / ctx.webServer.register({ kind: 'prefix', path: '/object' })",
    "  const functionValue = function () {} / ctx.webServer.register({ kind: 'prefix', path: '/function' })",
    "  const arrowValue = (() => {}) / ctx.webServer.register({ kind: 'prefix', path: '/arrow' })",
    "  const classValue = class {} / ctx.webServer.register({ kind: 'prefix', path: '/class' })",
    '  const multilineFunction =',
    "    function () {} / ctx.webServer.register({ kind: 'prefix', path: '/multiline-function' })",
    '  const multilineClass =',
    "    class {} / ctx.webServer.register({ kind: 'prefix', path: '/multiline-class' })",
    '  const prior = value',
    '  function semicolonlessDeclaration() {}',
    '  /ctx\\.webServer\\.register\\(/.test(afterSemicolonlessFunction)',
    "  counter++ / ctx.webServer.register({ kind: 'prefix', path: '/postfix' })",
    '  return { objectValue, functionValue, arrowValue, classValue }',
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })

  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), [
    '/object',
    '/function',
    '/arrow',
    '/class',
    '/multiline-function',
    '/multiline-class',
    '/postfix',
  ])
  assert.deepEqual(result.connectionRoutes, [])
})

test('limits function and class expression names to their expression bodies', () => {
  const result = inspectWebRouteAuth(new Map([['index.js', [
    'export function apply(ctx) {',
    "  ctx.webServer.register({ kind: 'prefix', path: '/before' })",
    '  const handler = function ctx() {',
    "    ctx.webServer.register({ kind: 'prefix', path: '/function-name-shadow' })",
    '  }',
    '  const Handler = class ctx {',
    '    method() {',
    "      ctx.connection.rpc.handle('/class-name-shadow', async () => ({}))",
    '    }',
    '  }',
    "  ctx.webServer.register({ kind: 'prefix', path: '/after' })",
    '  return { handler, Handler }',
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })

  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/before', '/after'])
  assert.deepEqual(result.connectionRoutes, [])
})

test('keeps multiline keyword continuations inside nested arrow ownership', () => {
  const result = inspectWebRouteAuth(new Map([['index.js', [
    'export function apply(ctx) {',
    '  const nested = (value) => candidate',
    "    instanceof ctx.webServer.register({ kind: 'prefix', path: '/nested' })",
    "  ctx.webServer.register({ kind: 'prefix', path: '/root' })",
    '  return nested',
    '}',
    '',
  ].join('\n')]]), { entryPath: 'index.js' })

  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/root'])
})

test('exposes incomplete coverage without trusting imports or routes from an invalid AST', () => {
  const helper = 'export function helper() {}\n'
  const after = inspectWebRouteAuth(new Map([
    ['index.js', [
      "import './helper.js'",
      'export function apply(ctx) {',
      "  ctx.webServer.register({ kind: 'prefix', path: '/before-gap' })",
      '  const broken = ([)]',
      '}',
      '',
    ].join('\n')],
    ['helper.js', helper],
  ]), { entryPath: 'index.js' })
  assert.deepEqual(after.reachablePaths, ['index.js'])
  assert.deepEqual(after.rawRoutes, [])
  assert.deepEqual(after.coverage.incompletePaths, ['index.js'])

  const before = inspectWebRouteAuth(new Map([
    ['index.js', [
      'const broken = ([)]',
      "import './helper.js'",
      'export function apply(ctx) {',
      "  ctx.webServer.register({ kind: 'prefix', path: '/hidden-by-gap' })",
      '}',
      '',
    ].join('\n')],
    ['helper.js', helper],
  ]), { entryPath: 'index.js' })
  assert.deepEqual(before.reachablePaths, ['index.js'])
  assert.deepEqual(before.rawRoutes, [])
  assert.deepEqual(before.coverage.incompletePaths, ['index.js'])
})

test('retains trustworthy entry evidence while marking a malformed reachable module incomplete', () => {
  const result = inspectWebRouteAuth(new Map([
    ['index.js', [
      "import './broken.js'",
      'export function apply(ctx) {',
      "  ctx.webServer.register({ kind: 'prefix', path: '/trusted-entry' })",
      '}',
    ].join('\n')],
    ['broken.js', 'export function broken( {\n'],
  ]), { entryPath: 'index.js' })

  assert.deepEqual(result.reachablePaths, ['broken.js', 'index.js'])
  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/trusted-entry'])
  assert.deepEqual(result.coverage.incompletePaths, ['broken.js'])
})

test('follows runtime imports with more than 128 bindings without following type-only imports', () => {
  const bindings = Array.from({ length: 140 }, (_, index) => `value${index}`)
  const exports = bindings.map((name, index) => `export const ${name} = ${index}`).join('\n')
  const result = inspectWebRouteAuth(new Map([
    ['index.ts', [
      `import { ${bindings.join(', ')} } from './wide'`,
      "import type { Hidden } from './types'",
      'export function apply(ctx: HostContext) {',
      "  ctx.webServer.register({ kind: 'prefix', path: '/wide-import' })",
      '  return value139',
      '}',
    ].join('\n')],
    ['wide.ts', exports],
    ['types.ts', [
      'export type Hidden = true',
      "export function apply(ctx) { ctx.webServer.register({ path: '/type-only' }) }",
    ].join('\n')],
  ]), { entryPath: 'index.ts' })

  assert.deepEqual(result.reachablePaths, ['index.ts', 'wide.ts'])
  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/wide-import'])
})

test('follows transparent TypeScript wrappers without widening direct route ownership', () => {
  const result = inspectWebRouteAuth(new Map([['index.ts', [
    'type Register = (options: object) => void',
    'type Handle = (path: string, callback: () => object) => void',
    'export const apply = (ctx: HostContext) => {',
    "  (ctx.webServer!.register as Register)({ kind: 'prefix', path: '/typed-raw' });",
    "  (ctx.connection!.rpc.handle as Handle)('/typed-connection', () => ({}));",
    '}',
  ].join('\n')]]), { entryPath: 'index.ts' })

  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/typed-raw'])
  assert.deepEqual(result.connectionRoutes.map((value) => value.routePath), [
    '/typed-connection',
  ])
  assert.deepEqual(result.coverage.incompletePaths, [])
})

test('ignores TypeScript overload signatures and resolves the single runtime apply implementation', () => {
  for (const source of [
    [
      'export function apply(ctx: unknown): void;',
      'export function apply(ctx: any) {',
      "  ctx.webServer.register({ path: '/overload' })",
      '}',
    ].join('\n'),
    [
      'function apply(ctx: unknown): void;',
      'function apply(ctx: any) {',
      "  ctx.webServer.register({ path: '/overload' })",
      '}',
      'export { apply }',
    ].join('\n'),
  ]) {
    const result = inspectWebRouteAuth(new Map([['index.ts', source]]), { entryPath: 'index.ts' })
    assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/overload'])
    assert.deepEqual(result.coverage.incompletePaths, [])
    const metadata = inspectExecutableModuleMetadata(source, { sourcePath: 'index.ts' })
    assert.equal(metadata.functions.length, 1)
    assert.equal(metadata.context.complete, true)
    assert.deepEqual(metadata.context.properties, ['webServer'])
  }
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
      "import runtimeEquals = require('./runtime-equals')",
      "import type erasedEquals = require('./erased-equals')",
      "const runtimeModule = import('./dynamic-runtime')",
      "function loadRuntime() { return import('./return-runtime') }",
      "async function loadAwaited() { return await import('./await-runtime') }",
      "void import('./void-runtime')",
      "import { type RuntimeMeta, live } from './runtime'",
      'export function apply(ctx) { return { live: live(ctx), runtimeEquals, runtimeModule, loadRuntime, loadAwaited, typed } }',
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
    ['runtime-equals.ts', 'export const loaded = true\n'],
    ['erased-equals.ts', [
      'export function apply(ctx) {',
      "  ctx.webServer.register({ kind: 'prefix', path: '/type-import-equals' })",
      '}',
      '',
    ].join('\n')],
  ]), { entryPath: 'index.ts' })

  assert.deepEqual(result.reachablePaths, [
    'await-runtime.ts',
    'dynamic-runtime.ts',
    'index.ts',
    'return-runtime.ts',
    'runtime-equals.ts',
    'runtime.ts',
    'void-runtime.ts',
  ])
  assert.deepEqual(result.rawRoutes, [])
  assert.deepEqual(result.connectionRoutes, [])
})

test('classifies literal-computed and optional route chains without widening aliases', () => {
  const exact = inspectWebRouteAuth(new Map([['index.js', [
    'export function apply(ctx, config = {}) {',
    "  ctx?.['webServer']?.[`register`]?.({ ['kind']: 'prefix', ['path']: '/computed' })",
    "  ctx['connection']?.['rpc']?.[`handle`]?.('/optional-rpc', () => config)",
    '}',
  ].join('\n')]]), { entryPath: 'index.js' })
  assert.deepEqual(exact.rawRoutes.map((value) => value.routePath), ['/computed'])
  assert.deepEqual(exact.connectionRoutes.map((value) => value.routePath), ['/optional-rpc'])
  assert.deepEqual(exact.coverage.incompletePaths, [])

  for (const unsupported of [
    'const webServer = ctx.webServer',
    'const register = ctx.webServer.register',
    'const connection = ctx.connection',
    'const handle = ctx.connection.rpc.handle',
    'ctx[serviceName].register({ path: "/dynamic" })',
    'consume(ctx)',
  ]) {
    const result = inspectWebRouteAuth(new Map([['index.js', [
      'export function apply(ctx) {',
      `  ${unsupported}`,
      '}',
    ].join('\n')]]), { entryPath: 'index.js' })
    assert.deepEqual(result.rawRoutes, [], unsupported)
    assert.deepEqual(result.connectionRoutes, [], unsupported)
    assert.deepEqual(result.coverage.incompletePaths, ['index.js'], unsupported)
  }
})

test('attributes routes in later parameter defaults but excludes the ctx initializer', () => {
  const result = inspectWebRouteAuth(new Map([['index.js', [
    'export function apply(',
    "  ctx = ctx.webServer.register({ path: '/self-tdz' }),",
    "  config = ctx.webServer.register({ kind: 'prefix', path: '/config' }),",
    "  internals = ctx.connection.rpc.handle('/internals', () => config),",
    "  { value = ctx.webServer.register({ path: '/destructured' }) } = {},",
    ') {',
    "  ctx.webServer.register({ path: '/body' })",
    '}',
  ].join('\n')]]), { entryPath: 'index.js' })

  assert.deepEqual(result.rawRoutes.map((value) => value.routePath), [
    '/config',
    '/destructured',
    '/body',
  ])
  assert.deepEqual(result.connectionRoutes.map((value) => value.routePath), ['/internals'])
  assert.deepEqual(result.coverage.incompletePaths, [])
})

test('fails dynamic candidate access closed while preserving independently visible routes', () => {
  for (const dynamic of [
    'eval("ctx.webServer.register({ path: \\\'/hidden\\\' })")',
    '(eval)("ctx.webServer.register({ path: \\\'/hidden\\\' })")',
    'function nested() { eval("ctx.webServer.register({ path: \\\'/hidden\\\' })") }; nested()',
    'arguments[0].webServer.register({ path: "/hidden" })',
    'const nested = () => arguments[0]',
  ]) {
    const result = inspectWebRouteAuth(new Map([['index.js', [
      'export function apply(ctx) {',
      `  ${dynamic}`,
      "  ctx.webServer.register({ path: '/visible' })",
      '}',
    ].join('\n')]]), { entryPath: 'index.js' })
    assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/visible'], dynamic)
    assert.deepEqual(result.coverage.incompletePaths, ['index.js'], dynamic)
  }

  for (const safe of [
    'function nested() { return arguments[0] }; nested()',
    'arguments.length; arguments[1]; arguments["2"]',
  ]) {
    const result = inspectWebRouteAuth(new Map([['index.js', [
      'export function apply(ctx) {',
      `  ${safe}`,
      "  ctx.webServer.register({ path: '/visible' })",
      '}',
    ].join('\n')]]), { entryPath: 'index.js' })
    assert.deepEqual(result.rawRoutes.map((value) => value.routePath), ['/visible'], safe)
    assert.deepEqual(result.coverage.incompletePaths, [], safe)
  }

  const shadowedEval = inspectExecutableModuleMetadata([
    'function apply(ctx, eval) {',
    '  eval("opaque")',
    "  ctx.webServer.register({ path: '/visible' })",
    '}',
  ].join('\n'), { sourcePath: 'index.js' })
  assert.equal(shadowedEval.moduleClosureComplete, true)
  assert.equal(shadowedEval.functions[0].routeComplete, true)
  assert.deepEqual(
    shadowedEval.functions[0].rawRoutes.map((value) => value.routePath),
    ['/visible'],
  )

  const arrow = inspectWebRouteAuth(new Map([['index.js', [
    'export const apply = (ctx) => {',
    '  arguments[0]',
    "  ctx.webServer.register({ path: '/arrow' })",
    '}',
  ].join('\n')]]), { entryPath: 'index.js' })
  assert.deepEqual(arrow.rawRoutes.map((value) => value.routePath), ['/arrow'])
  assert.deepEqual(arrow.coverage.incompletePaths, [])
})

test('does not attribute ctx routes inside with object environments', () => {
  const unsafe = inspectExecutableModuleMetadata([
    'function apply(ctx) {',
    "  with (services) { ctx.webServer.register({ path: '/hidden' }) }",
    "  ctx.webServer.register({ path: '/visible' })",
    '}',
  ].join('\n'), { sourcePath: 'index.cjs' })
  assert.equal(unsafe.functions[0].routeComplete, false)
  assert.deepEqual(unsafe.functions[0].rawRoutes.map((value) => value.routePath), ['/visible'])

  const objectExpression = inspectExecutableModuleMetadata([
    'function apply(ctx) {',
    '  with (ctx.scope) { consume(value) }',
    "  ctx.webServer.register({ path: '/visible' })",
    '}',
  ].join('\n'), { sourcePath: 'index.cjs' })
  assert.equal(objectExpression.functions[0].routeComplete, true)
  assert.deepEqual(objectExpression.functions[0].rawRoutes.map((value) => value.routePath), ['/visible'])
})

test('follows exact literal dynamic imports and requires while failing nonliteral closure discovery', () => {
  const exact = inspectWebRouteAuth(new Map([
    ['index.js', [
      'import(`./dynamic.js`)',
      'require(`./required.js`)',
      'function localLoader(runtimeName) {',
      '  const require = (value) => value',
      '  return require(runtimeName)',
      '}',
      'export function apply(ctx) { ctx.logger.info("ready") }',
    ].join('\n')],
    ['dynamic.js', 'export const dynamic = true\n'],
    ['required.js', 'export const required = true\n'],
  ]), { entryPath: 'index.js' })
  assert.deepEqual(exact.reachablePaths, ['dynamic.js', 'index.js', 'required.js'])
  assert.deepEqual(exact.coverage.incompletePaths, [])

  for (const expression of [
    'import(moduleName)',
    'import(`./${moduleName}.js`)',
    'require(moduleName)',
    'const load = require',
  ]) {
    const result = inspectWebRouteAuth(new Map([['index.js', [
      'export function apply(ctx) { ctx.logger.info("ready") }',
      expression,
    ].join('\n')]]), { entryPath: 'index.js' })
    assert.deepEqual(result.coverage.incompletePaths, ['index.js'], expression)
  }
})

test('walks bounded activation calls while leaving deferred local callbacks nonblocking', () => {
  const activatedCases = [
    [
      'direct local function',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'function load() { return import(packageName) }',
        "export function apply(ctx) { load(); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'local arrow',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'const load = () => import(packageName)',
        "export function apply(ctx) { load(); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'top-level direct call',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'function load() { return import(packageName) }',
        'load()',
        "export function apply(ctx) { ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'top-level IIFE',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        '(() => import(packageName))()',
        "export function apply(ctx) { ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'top-level eager callback',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'Promise.resolve().then(() => import(packageName))',
        "export function apply(ctx) { ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'apply eager callback',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        "export function apply(ctx) { Promise.resolve().then(() => import(packageName)); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'Function.prototype.call',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'function load() { return import(packageName) }',
        "export function apply(ctx) { load.call(null); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'Function.prototype.apply',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'function load() { return import(packageName) }',
        "export function apply(ctx) { load.apply(null, []); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'Function.prototype.bind',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'function load() { return import(packageName) }',
        "export function apply(ctx) { load.bind(null)(); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'sequence-last callee',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'function load() { return import(packageName) }',
        "export function apply(ctx) { (0, load)(); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'inline object member',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'function load() { return import(packageName) }',
        "export function apply(ctx) { ({ run: load }).run(); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'bound object member',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'const helper = { load() { return import(packageName) } }',
        "export function apply(ctx) { helper.load(); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'returned local callable',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'function make() { return () => import(packageName) }',
        "export function apply(ctx) { make()(); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'mutable local callable',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'let load = () => undefined',
        'load = () => import(packageName)',
        "export function apply(ctx) { load(); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'inline class constructor',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        "export function apply(ctx) { new (class { constructor() { import(packageName) } })(); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'destructured callback property',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'function run({ load }) { load() }',
        "export function apply(ctx) { run({ load: () => import(packageName) }); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'renamed destructured callback property',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'function run({ load: execute }) { execute() }',
        "export function apply(ctx) { run({ load: () => import(packageName) }); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'destructured callback array item',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'function run([load]) { load() }',
        "export function apply(ctx) { run([() => import(packageName)]); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'defaulted local callback',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'function run(load = () => import(packageName)) { load() }',
        "export function apply(ctx) { run(); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    ...[
      ['object getter direct read', 'void helper.value'],
      ['object getter literal-computed read', "void helper['value']"],
      ['object getter optional read', 'void helper?.value'],
      ['object getter destructuring read', 'const { value } = helper; void value'],
      ['object getter spread read', 'const copy = { ...helper }; void copy'],
    ].map(([label, operation]) => [label, [
      "const packageName = '@deepseek-ai/dsh-hidden'",
      'const helper = { get value() { return import(packageName) } }',
      `export function apply(ctx) { ${operation}; ctx.logger.info('ready') }`,
    ].join('\n')]),
    [
      'object setter assignment',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'const helper = { set value(next) { import(packageName) } }',
        "export function apply(ctx) { helper.value = 1; ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    ...[
      ['constructed instance method', 'new Loader().run()'],
      ['bound instance method', 'loader.run()', 'const loader = new Loader()'],
      ['static class method', 'Loader.run()', undefined, 'static '],
    ].map(([label, operation, setup = '', modifier = '']) => [label, [
      "const packageName = '@deepseek-ai/dsh-hidden'",
      `class Loader { ${modifier}run() { import(packageName) } }`,
      setup,
      `export function apply(ctx) { ${operation}; ctx.logger.info('ready') }`,
    ].filter(Boolean).join('\n')]),
    [
      'returned callable from construction',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'function Factory() { return () => import(packageName) }',
        "export function apply(ctx) { (new Factory())(); ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'tagged template invocation',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'function tag() { return import(packageName) }',
        "export function apply(ctx) { tag`value`; ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    [
      'iterable method invocation',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'const values = { *[Symbol.iterator]() { import(packageName) } }',
        "export function apply(ctx) { const copy = [...values]; ctx.logger.info('ready'); return copy }",
      ].join('\n'),
    ],
    [
      'await thenable method invocation',
      [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'const value = { then() { import(packageName) } }',
        "export async function apply(ctx) { await value; ctx.logger.info('ready') }",
      ].join('\n'),
    ],
    ...[
      ['conditional returned callee', '(enabled ? makeA : makeB)()'],
      ['logical returned callee', '(enabled && makeA)()'],
      ['Reflect.get returned callee', "Reflect.get(helper, 'load')()"],
    ].map(([label, operation]) => [label, [
      "const packageName = '@deepseek-ai/dsh-hidden'",
      'const helper = { load: () => import(packageName) }',
      'const makeA = helper.load; const makeB = helper.load; const enabled = true',
      `export function apply(ctx) { ${operation}; ctx.logger.info('ready') }`,
    ].join('\n')]),
  ]

  for (const [label, source] of activatedCases) {
    const closure = inspectExecutableModuleClosure(new Map([['index.js', source]]), {
      entryPaths: ['index.js'],
    })
    assert.deepEqual(closure.activationIncompletePaths, ['index.js'], label)
  }

  const crossModuleCases = [
    [
      'named import',
      "import { load } from './helper.js'\nexport function apply(ctx) { load(); ctx.logger.info('ready') }\n",
    ],
    [
      'namespace import',
      "import * as helper from './helper.js'\nexport function apply(ctx) { helper.load(); ctx.logger.info('ready') }\n",
    ],
  ]
  for (const [label, source] of crossModuleCases) {
    const closure = inspectExecutableModuleClosure(new Map([
      ['index.js', source],
      ['helper.js', [
        "const packageName = '@deepseek-ai/dsh-hidden'",
        'export function load() { return import(packageName) }',
      ].join('\n')],
    ]), { entryPaths: ['index.js'] })
    assert.deepEqual(closure.activationIncompletePaths, ['helper.js'], label)
  }

  const reexported = inspectExecutableModuleClosure(new Map([
    ['index.js', "import { run } from './bridge.js'\nexport function apply(ctx) { run(); ctx.logger.info('ready') }\n"],
    ['bridge.js', "export { load as run } from './helper.js'\n"],
    ['helper.js', [
      "const packageName = '@deepseek-ai/dsh-hidden'",
      'export function load() { return import(packageName) }',
    ].join('\n')],
  ]), { entryPaths: ['index.js'] })
  assert.deepEqual(reexported.activationIncompletePaths, ['helper.js'])

  const constructed = inspectExecutableModuleClosure(new Map([
    ['index.js', "import { Loader } from './helper.js'\nexport function apply(ctx) { new Loader(); ctx.logger.info('ready') }\n"],
    ['helper.js', [
      "const packageName = '@deepseek-ai/dsh-hidden'",
      'export class Loader { constructor() { import(packageName) } }',
    ].join('\n')],
  ]), { entryPaths: ['index.js'] })
  assert.deepEqual(constructed.activationIncompletePaths, ['helper.js'])

  const inheritedConstructor = inspectExecutableModuleClosure(new Map([
    ['index.js', [
      "import { Base } from './helper.js'",
      'class Loader extends Base {}',
      "export function apply(ctx) { new Loader(); ctx.logger.info('ready') }",
    ].join('\n')],
    ['helper.js', [
      "const packageName = '@deepseek-ai/dsh-hidden'",
      'export class Base { constructor() { import(packageName) } }',
    ].join('\n')],
  ]), { entryPaths: ['index.js'] })
  assert.deepEqual(inheritedConstructor.activationIncompletePaths, ['helper.js'])

  const deferred = inspectExecutableModuleClosure(new Map([['index.js', [
    "const packageName = '@deepseek-ai/dsh-hidden'",
    'function definition(handler) { return { execute: handler } }',
    "export function apply(ctx) { definition(() => import(packageName)); ctx.logger.info('ready') }",
  ].join('\n')]]), { entryPaths: ['index.js'] })
  assert.deepEqual(deferred.incompletePaths, ['index.js'])
  assert.deepEqual(deferred.activationIncompletePaths, [])

  const invokedCallback = inspectExecutableModuleClosure(new Map([['index.js', [
    "const packageName = '@deepseek-ai/dsh-hidden'",
    'function run(handler) { handler() }',
    "export function apply(ctx) { run(() => import(packageName)); ctx.logger.info('ready') }",
  ].join('\n')]]), { entryPaths: ['index.js'] })
  assert.deepEqual(invokedCallback.activationIncompletePaths, ['index.js'])
})

test('fails ambiguous activation roots and locally unresolved member loaders closed', () => {
  for (const source of [
    "const packageName = '@deepseek-ai/dsh-hidden'; module.exports = { apply() { import(packageName) } }",
    "const packageName = '@deepseek-ai/dsh-hidden'; exports.apply = function () { import(packageName) }",
  ]) {
    const closure = inspectExecutableModuleClosure(new Map([['index.cjs', source]]), {
      entryPaths: ['index.cjs'],
    })
    assert.deepEqual(closure.activationIncompletePaths, ['index.cjs'])
  }

  const star = inspectExecutableModuleClosure(new Map([
    ['index.js', "export * from './impl.js'\n"],
    ['impl.js', "export function apply() { import('@deepseek-ai/dsh-hidden') }\n"],
  ]), { entryPaths: ['index.js'] })
  assert.deepEqual(star.activationIncompletePaths, ['index.js'])

  const localRequire = inspectExecutableModuleClosure(new Map([
    ['index.cjs', "const helper = require('./helper.cjs'); exports.apply = () => helper.load()\n"],
    ['helper.cjs', "exports.load = () => import('@deepseek-ai/dsh-hidden')\n"],
  ]), { entryPaths: ['index.cjs'] })
  assert.deepEqual(localRequire.activationIncompletePaths, ['index.cjs'])

  const nestedNamespace = inspectExecutableModuleClosure(new Map([
    ['index.js', "import * as helper from './helper.js'; export function apply() { helper.deep.load() }\n"],
    ['helper.js', "export const deep = { load: () => import('@deepseek-ai/dsh-hidden') }\n"],
  ]), { entryPaths: ['index.js'] })
  assert.deepEqual(nestedNamespace.activationIncompletePaths, ['index.js'])
})

test('resolves only exact unescaped named inject exports across the compact graph', () => {
  const cases = [
    {
      files: new Map([['index.js', "export const inject = ['skills', 'commands']\n"]]),
      expected: [
        { service: 'skills', requirement: 'required' },
        { service: 'commands', requirement: 'required' },
      ],
      definingPath: 'index.js',
    },
    {
      files: new Map([['index.js', [
        "const deps = { required: ['skills'], optional: ['commands'] }",
        'const attachment = deps',
        'export { attachment as inject }',
      ].join('\n')]]),
      expected: [
        { service: 'skills', requirement: 'required' },
        { service: 'commands', requirement: 'optional' },
      ],
      definingPath: 'index.js',
    },
    {
      files: new Map([
        ['index.js', "export { deps as inject } from './attachment.js'\n"],
        ['attachment.js', "export const deps = ['skills']\n"],
      ]),
      expected: [{ service: 'skills', requirement: 'required' }],
      definingPath: 'attachment.js',
    },
    {
      files: new Map([
        ['index.js', [
          "import { deps } from './attachment.js'",
          'export { deps as inject }',
        ].join('\n')],
        ['attachment.js', "export const deps = ['skills']\n"],
      ]),
      expected: [{ service: 'skills', requirement: 'required' }],
      definingPath: 'attachment.js',
    },
  ]
  for (const fixture of cases) {
    const closure = inspectExecutableModuleClosure(fixture.files, { entryPaths: ['index.js'] })
    assert.deepEqual(closure.injectExports, [{
      entryPath: 'index.js',
      complete: true,
      present: true,
      definingPath: fixture.definingPath,
      values: fixture.expected,
    }])
  }

  const absent = inspectExecutableModuleClosure(new Map([['index.js', [
    '// export const inject = dynamicServices',
    'const text = `export const inject = ["fake"]`',
    'export const value = text',
  ].join('\n')]]), { entryPaths: ['index.js'] })
  assert.deepEqual(absent.injectExports, [{
    entryPath: 'index.js', complete: true, present: false, values: [],
  }])

  const incompleteCases = [
    new Map([['index.js', 'export const inject = Object.freeze(["skills"])\n']]),
    new Map([['index.js', 'export let inject = ["skills"]\n']]),
    new Map([['index.js', [
      'export const inject = ["skills"]',
      'inject.push("commands")',
    ].join('\n')]]),
    new Map([['index.js', [
      'const deps = ["skills"]',
      'consume(deps)',
      'export { deps as inject }',
    ].join('\n')]]),
    new Map([
      ['index.js', "export * from './attachment.js'\n"],
      ['attachment.js', 'export const inject = ["skills"]\n'],
    ]),
    new Map([
      ['index.js', "export { inject } from './cycle.js'\n"],
      ['cycle.js', "export { inject } from './index.js'\n"],
    ]),
    new Map([['index.js', "export { inject } from '@deepseek-ai/runtime'\n"]]),
    new Map([
      ['index.js', [
        "import { deps } from './attachment.js'",
        "deps.push('commands')",
        'export { deps as inject }',
      ].join('\n')],
      ['attachment.js', "export const deps = ['skills']\n"],
    ]),
    new Map([
      ['index.js', [
        "import { deps } from './attachment.js'",
        'consume(deps)',
        'export { deps as inject }',
      ].join('\n')],
      ['attachment.js', "export const deps = ['skills']\n"],
    ]),
    new Map([['index.js', 'exports.inject = ["skills"]\n']]),
    new Map([['index.js', 'module.exports.inject = ["skills"]\n']]),
    new Map([['index.js', 'const inject = ["skills"]; module.exports = { inject }\n']]),
    new Map([['index.cjs', 'const value = true\n']]),
  ]
  for (const files of incompleteCases) {
    const entryPath = files.has('index.js') ? 'index.js' : 'index.cjs'
    const closure = inspectExecutableModuleClosure(files, { entryPaths: [entryPath] })
    assert.equal(closure.injectExports[0].complete, false)
  }
})

test('discovers bounded intrinsic module.require edges without chasing shadowed loaders', () => {
  const exactFiles = new Map([
    ['index.cjs', [
      "module.require('./literal.cjs')",
      "module['require'](`./computed.cjs`)",
      "module?.['require']?.('./optional.cjs')",
      'module.exports = {}',
    ].join('\n')],
    ['literal.cjs', 'module.exports = true\n'],
    ['computed.cjs', 'module.exports = true\n'],
    ['optional.cjs', 'module.exports = true\n'],
  ])
  const exact = inspectExecutableModuleClosure(exactFiles, { entryPaths: ['index.cjs'] })
  assert.deepEqual(exact.modules.map((value) => value.sourcePath), [
    'computed.cjs', 'index.cjs', 'literal.cjs', 'optional.cjs',
  ])
  assert.deepEqual(exact.incompletePaths, [])

  for (const loader of [
    'module.require(moduleName)',
    'module[methodName]("./hidden.cjs")',
    'const load = module.require',
    'const alias = module',
  ]) {
    const closure = inspectExecutableModuleClosure(
      new Map([['index.cjs', `${loader}\nmodule.exports = {}\n`]]),
      { entryPaths: ['index.cjs'] },
    )
    assert.deepEqual(closure.incompletePaths, ['index.cjs'], loader)
  }

  const shadowed = inspectExecutableModuleClosure(new Map([['index.cjs', [
    'function load(module) { return module.require(moduleName) }',
    'module.exports = { load }',
  ].join('\n')]]), { entryPaths: ['index.cjs'] })
  assert.deepEqual(shadowed.incompletePaths, [])
})

test('fails explicit Node loader capabilities closed while keeping require.resolve nonexecuting', () => {
  for (const source of [
    "import { createRequire } from 'node:module'; createRequire(import.meta.url)",
    "import { createRequire as makeRequire } from 'module'; makeRequire(import.meta.url)",
    "import * as nodeModule from 'node:module'; nodeModule.createRequire(import.meta.url)",
    "const { createRequire } = require('node:module'); createRequire(__filename)",
    "module.constructor._load('@deepseek-ai/dsh-hidden')",
    "process.mainModule.require('@deepseek-ai/dsh-hidden')",
    "process.getBuiltinModule('module').createRequire(import.meta.url)",
    "process.getBuiltinModule('node:module')._load('@deepseek-ai/dsh-hidden')",
  ]) {
    const closure = inspectExecutableModuleClosure(new Map([['index.js', source + '\n']]), {
      entryPaths: ['index.js'],
    })
    assert.deepEqual(closure.incompletePaths, ['index.js'], source)
  }

  const resolveOnly = inspectExecutableModuleClosure(new Map([['index.js', [
    "require.resolve('@deepseek-ai/dsh-not-executed')",
    'module.exports = {}',
  ].join('\n')]]), { entryPaths: ['index.js'] })
  assert.deepEqual(resolveOnly.incompletePaths, [])

  for (const source of [
    "const resolve = require.resolve; resolve('@deepseek-ai/dsh-hidden')",
    'require.resolve(moduleName)',
  ]) {
    const closure = inspectExecutableModuleClosure(new Map([['index.js', source + '\n']]), {
      entryPaths: ['index.js'],
    })
    assert.deepEqual(closure.incompletePaths, ['index.js'], source)
  }

  const shadowed = inspectExecutableModuleClosure(new Map([['index.js', [
    'function inspect(module, process) {',
    "  module.constructor._load('hidden')",
    "  process.mainModule.require('hidden')",
    '}',
  ].join('\n')]]), { entryPaths: ['index.js'] })
  assert.deepEqual(shadowed.incompletePaths, [])
})

test('treats explicit JSON module edges as data leaves while failing unknown loaders closed', () => {
  const esm = inspectWebRouteAuth(new Map([
    ['index.js', [
      "import config from './config.json' with { type: 'json' }",
      "export function apply(ctx) { ctx.webServer.register({ path: '/json' }); return config }",
    ].join('\n')],
    ['config.json', '{"enabled":true}\n'],
  ]), { entryPath: 'index.js' })
  assert.deepEqual(esm.reachablePaths, ['index.js'])
  assert.deepEqual(esm.rawRoutes.map((value) => value.routePath), ['/json'])
  assert.deepEqual(esm.coverage.incompletePaths, [])

  const cjs = inspectExecutableModuleClosure(new Map([
    ['index.cjs', "const config = require('./config.json')\nmodule.exports = config\n"],
    ['config.json', '{"enabled":true}\n'],
  ]), { entryPaths: ['index.cjs'] })
  assert.deepEqual(cjs.modules.map((value) => value.sourcePath), ['index.cjs'])
  assert.deepEqual(cjs.incompletePaths, [])

  for (const [specifier, dataPath] of [
    ['./config', 'config.json'],
    ['./config.yaml', 'config.yaml'],
  ]) {
    const closure = inspectExecutableModuleClosure(new Map([
      ['index.js', `import ${JSON.stringify(specifier)}\n`],
      [dataPath, '/* not executable source'],
    ]), { entryPaths: ['index.js'] })
    assert.deepEqual(closure.incompletePaths, ['index.js'], specifier)
  }
})

test('resolves exact package imports and self-references while rejecting opaque specifiers', () => {
  const files = new Map([
    ['package.json', JSON.stringify({
      name: 'self-plugin',
      imports: { '#helper': { types: './helper.d.ts', default: './helper.js' } },
      exports: {
        '.': './index.js',
        './feature': './feature.js',
        './data': './config.json',
      },
    })],
    ['index.js', [
      "import '#helper'",
      "import 'self-plugin/feature'",
      "import 'self-plugin/data'",
    ].join('\n')],
    ['helper.js', 'export const helper = true\n'],
    ['feature.js', 'export const feature = true\n'],
    ['config.json', '{"enabled":true}\n'],
  ])
  const exact = inspectExecutableModuleClosure(files, { entryPaths: ['index.js'] })
  assert.deepEqual(exact.modules.map((value) => value.sourcePath), [
    'feature.js', 'helper.js', 'index.js',
  ])
  assert.deepEqual(exact.incompletePaths, [])

  for (const specifier of ['#missing', 'self-plugin/missing']) {
    const broken = new Map(files)
    broken.set('index.js', `import ${JSON.stringify(specifier)}\n`)
    const closure = inspectExecutableModuleClosure(broken, { entryPaths: ['index.js'] })
    assert.deepEqual(closure.incompletePaths, ['index.js'], specifier)
  }

  for (const specifier of [
    'data:text/javascript,export default true',
    'file:///tmp/hidden.js',
    '/tmp/hidden.js',
    '\\hidden\\module.cjs',
    'C:\\hidden\\module.js',
    'https://example.test/hidden.js',
    'custom:loader',
  ]) {
    const closure = inspectExecutableModuleClosure(
      new Map([['index.js', `import ${JSON.stringify(specifier)}\n`]]),
      { entryPaths: ['index.js'] },
    )
    assert.deepEqual(closure.incompletePaths, ['index.js'], specifier)
  }

  for (const specifier of ['node:fs', '@deepseek-ai/dsh-runtime', 'ordinary-package/subpath']) {
    const closure = inspectExecutableModuleClosure(
      new Map([['index.js', `import ${JSON.stringify(specifier)}\n`]]),
      { entryPaths: ['index.js'] },
    )
    assert.deepEqual(closure.incompletePaths, [], specifier)
  }

  const externalImportAlias = new Map(files)
  externalImportAlias.set('package.json', JSON.stringify({
    name: 'self-plugin',
    imports: { '#dsh': '@deepseek-ai/dsh-hidden' },
    exports: { '.': './index.js' },
  }))
  externalImportAlias.set('index.js', "import '#dsh'\n")
  assert.deepEqual(
    inspectExecutableModuleClosure(externalImportAlias, { entryPaths: ['index.js'] })
      .incompletePaths,
    ['index.js'],
  )

  const empty = inspectExecutableModuleClosure(new Map([['package.json', '{}\n']]), {
    entryPaths: [],
  })
  assert.deepEqual(empty.incompletePaths, ['package.json'])
})

test('compacts Babel analysis into frozen plain metadata before graph resolution', () => {
  const metadata = inspectExecutableModuleMetadata([
    "import { helper } from './helper.js'",
    'const activate = (ctx, config = {}) => {',
    "  ctx?.['webServer']?.register?.({ path: '/plain' })",
    '  return helper(config)',
    '}',
    'export { activate as apply }',
  ].join('\n'), { sourcePath: 'index.js' })

  const forbiddenKeys = new Set(['ast', 'programPath', 'path', 'scope', 'binding', 'referencePaths'])
  const seen = new Set()
  function assertPlain(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    assert.equal(value instanceof Map, false)
    assert.equal(value instanceof Set, false)
    assert.equal(value instanceof WeakMap, false)
    assert.equal(value instanceof WeakSet, false)
    assert.equal(Object.isFrozen(value), true)
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `retained Babel graph key: ${key}`)
      assertPlain(child)
    }
  }
  assertPlain(metadata)
  assert.doesNotThrow(() => JSON.stringify(metadata))
  assert.deepEqual(metadata.moduleEdges, [{
    kind: 'import',
    specifier: './helper.js',
    topLevel: true,
    functionIds: [],
  }])
  assert.deepEqual(metadata.exports.map((value) => value.name), ['apply'])
})

test('shares a source budget across the reachable graph and stops without retaining ASTs', () => {
  const files = new Map()
  const padding = `/*${'x'.repeat(EXECUTABLE_SOURCE_BYTES_LIMIT - 256)}*/`
  for (let index = 0; index < 10; index += 1) {
    const next = index < 9 ? `import './module${index + 1}.js'\n` : ''
    const apply = index === 0
      ? "export function apply(ctx) { ctx.webServer.register({ path: '/bounded-source' }) }\n"
      : `export const value${index} = true\n`
    files.set(`module${index}.js`, next + apply + padding)
  }
  const result = inspectWebRouteAuth(files, { entryPath: 'module0.js' })
  assert.ok(result.reachablePaths.length < files.size)
  assert.ok(result.coverage.incompletePaths.includes('module0.js'))
  assert.deepEqual(result.coverage.resources.exhausted, ['sourceBytes'])
  assert.ok(result.coverage.resources.used.sourceBytes <= EXECUTABLE_GRAPH_SOURCE_BYTES_LIMIT)
  assert.equal(result.coverage.retainedAnalysis, 'compact-metadata-only')
})

test('bounds unique module edges with linear deduplication before retaining metadata', () => {
  const imports = Array.from(
    { length: EXECUTABLE_MODULE_EDGE_LIMIT + 1 },
    (_, index) => `import './missing-${index}.js'`,
  )
  const result = inspectWebRouteAuth(new Map([['index.js', [
    ...imports,
    "export function apply(ctx) { ctx.webServer.register({ path: '/not-retained' }) }",
  ].join('\n')]]), { entryPath: 'index.js' })
  assert.deepEqual(result.rawRoutes, [])
  assert.deepEqual(result.reachablePaths, ['index.js'])
  assert.deepEqual(result.coverage.incompletePaths, ['index.js'])
  assert.deepEqual(result.coverage.resources.exhausted, ['edges'])
  assert.equal(result.coverage.resources.used.edges, EXECUTABLE_MODULE_EDGE_LIMIT)
})

test('bounds unique activation-call descriptors with the shared graph edge budget', () => {
  const calls = Array.from(
    { length: EXECUTABLE_MODULE_EDGE_LIMIT + 1 },
    (_, index) => `let callback${index}; callback${index}()`,
  )
  const closure = inspectExecutableModuleClosure(new Map([['index.js', [
    'export function apply(ctx) {',
    ...calls,
    "ctx.logger.info('unreachable proof')",
    '}',
  ].join('\n')]]), { entryPaths: ['index.js'] })
  assert.deepEqual(closure.activationIncompletePaths, ['index.js'])
  assert.deepEqual(closure.resources.exhausted, ['edges'])
  assert.equal(closure.resources.used.edges, EXECUTABLE_MODULE_EDGE_LIMIT)
})
