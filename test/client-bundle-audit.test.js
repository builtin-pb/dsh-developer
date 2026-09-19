import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET } from '../lib/constants.js'
import {
  CLIENT_BUNDLE_PLATFORM_MODULES,
  CLIENT_BUNDLE_PREVIEW_PLATFORM_MODULES,
  inspectClientBundle,
} from '../lib/client-bundle-audit.js'

function manifest(client = {}) {
  return {
    name: 'client-fixture',
    exports: { './client': { default: './lib/client.js' } },
    dsh: { client: { platform: 'web', ...client } },
  }
}

function bundle(body = 'return { apply() {} }') {
  return 'window.__ModuleLoader__.load({ id: "client-fixture", factory: (require) => { ' + body + ' } })\n'
}

test('accepts the public lazy-CJS handoff and exact declared module requests', () => {
  const result = inspectClientBundle(
    new Map([['lib/client.js', bundle('const React = require("react"); const feature = require("feature/client"); return { React, feature }')]]),
    manifest({ external: ['feature/client'], inject: ['feature'] }),
  )
  assert.equal(result.declared, true)
  assert.equal(result.registrationId, 'client-fixture')
  assert.deepEqual(result.dynamicRequests, ['feature/client'])
  assert.deepEqual(result.lanes, {
    release: { target: DSH_COMPATIBILITY_TARGET, ok: true, missing: [] },
    preview: { target: DSH_PREVIEW_TARGET, ok: true, missing: [] },
  })
  assert.equal(result.repositoryCodeExecuted, false)
  assert.ok(CLIENT_BUNDLE_PLATFORM_MODULES.includes('react'))
  assert.ok(CLIENT_BUNDLE_PREVIEW_PLATFORM_MODULES.includes('@deepseek-ai/dsh-client-store'))
})

test('accepts current store and dockkit seeds on both exact lanes', () => {
  for (const request of ['@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-dockkit']) {
    const result = inspectClientBundle(new Map([['lib/client.js', bundle('return require(' + JSON.stringify(request) + ')')]]), manifest())
    assert.equal(result.lanes.release.ok, true)
    assert.equal(result.lanes.preview.ok, true)
  }
})

test('rejects the removed aggregate runtime on both current lanes', () => {
  assert.throws(() => inspectClientBundle(
    new Map([['lib/client.js', bundle('return require("@deepseek-ai/dsh-client-runtime/client")')]]), manifest(),
  ), error => error.code === 'CLIENT_BUNDLE_EXTERNAL_DRIFT'
    && error.details.target === DSH_COMPATIBILITY_TARGET
    && error.details.requests[0] === '@deepseek-ai/dsh-client-runtime/client'
    && error.details.previewRequests[0] === '@deepseek-ai/dsh-client-runtime/client')
})

test('rejects Node builtins even when a manifest tries to declare them', () => {
  assert.throws(
    () => inspectClientBundle(
      new Map([['lib/client.js', bundle('const crypto = require("node:crypto"); return { crypto }')]]),
      manifest({ external: ['node:crypto'] }),
    ),
    (error) => error.code === 'CLIENT_BUNDLE_UNSAFE_IMPORT'
      && error.details.requests[0] === 'node:crypto',
  )
})

test('rejects package-local and file URL requests at the browser boundary', () => {
  for (const request of ['./host.js', 'file:///C:/plugin/host.js']) {
    assert.throws(
      () => inspectClientBundle(
        new Map([['lib/client.js', bundle('return require("' + request + '")')]]),
        manifest({ external: [request] }),
      ),
      (error) => error.code === 'CLIENT_BUNDLE_UNSAFE_IMPORT'
        && error.details.requests[0] === request,
    )
  }
})

test('rejects dynamic requests missing from dsh.client.external', () => {
  assert.throws(
    () => inspectClientBundle(
      new Map([['lib/client.js', bundle('return require("feature/client")')]]),
      manifest(),
    ),
    (error) => error.code === 'CLIENT_BUNDLE_EXTERNAL_DRIFT'
      && error.details.requests[0] === 'feature/client',
  )
})

test('rejects a valid script that registers the wrong package id', () => {
  const source = 'window.__ModuleLoader__.load({ id: "another-plugin", factory: () => ({}) })\n'
  assert.throws(
    () => inspectClientBundle(new Map([['lib/client.js', source]]), manifest()),
    (error) => error.code === 'CLIENT_BUNDLE_REGISTRATION_INVALID'
      && error.details.observed[0] === 'another-plugin',
  )
})

test('rejects registration records without an executable factory', () => {
  const source = 'window.__ModuleLoader__.load({ id: "client-fixture", factory: null })\n'
  assert.throws(
    () => inspectClientBundle(new Map([['lib/client.js', source]]), manifest()),
    (error) => error.code === 'CLIENT_BUNDLE_REGISTRATION_INVALID'
      && error.details.observed.length === 0,
  )
})

test('rejects ESM or missing client artifacts before DSH Web can load them', () => {
  assert.throws(
    () => inspectClientBundle(new Map([['lib/client.js', 'export function apply() {}\n']]), manifest()),
    (error) => error.code === 'CLIENT_BUNDLE_SYNTAX',
  )
  assert.throws(
    () => inspectClientBundle(new Map(), manifest()),
    (error) => error.code === 'CLIENT_BUNDLE_MISSING',
  )
})

test('does not impose a Web contract on a host-only plugin', () => {
  assert.deepEqual(inspectClientBundle(new Map(), { name: 'host-only' }), { declared: false })
})

test('rejects the legacy top-level client declaration with migration evidence', () => {
  assert.throws(
    () => inspectClientBundle(new Map(), {
      name: 'legacy-client',
      client: { platform: 'web' },
    }),
    (error) => error.code === 'CLIENT_DECLARATION_MISSING'
      && error.details.legacyClient === true
      && /legacy top-level package\.json client field/u.test(error.message),
  )
})

test('ignores diagnostic strings and comments that merely mention boundary calls', () => {
  const source = [
    'window.__ModuleLoader__.load({ id: "client-fixture", factory: (require) => {',
    '  const message = `require("${spec}") missed the module table`;',
    '  // require("node:crypto")',
    '  return { message };',
    '} })',
    '',
  ].join('\n')
  const result = inspectClientBundle(new Map([['lib/client.js', source]]), manifest())
  assert.deepEqual(result.requests, [])

  const fake = 'const message = \'window.__ModuleLoader__.load({ id: "client-fixture", factory: () => ({}) })\';\n'
  assert.throws(
    () => inspectClientBundle(new Map([['lib/client.js', fake]]), manifest()),
    (error) => error.code === 'CLIENT_BUNDLE_REGISTRATION_INVALID',
  )
})

test('audits executable requests inside template expressions', () => {
  const source = [
    'window.__ModuleLoader__.load({ id: "client-fixture", factory: (require) => {',
    '  return `unsafe: ${require("node:crypto")}`;',
    '} })',
    '',
  ].join('\n')
  assert.throws(
    () => inspectClientBundle(new Map([['lib/client.js', source]]), manifest()),
    (error) => error.code === 'CLIENT_BUNDLE_UNSAFE_IMPORT'
      && error.details.requests[0] === 'node:crypto',
  )
})

test('rejects non-literal loader requests instead of guessing their boundary', () => {
  const source = [
    'window.__ModuleLoader__.load({ id: "client-fixture", factory: (require) => {',
    '  const specifier = "react";',
    '  return require(specifier);',
    '} })',
    '',
  ].join('\n')
  assert.throws(
    () => inspectClientBundle(new Map([['lib/client.js', source]]), manifest()),
    (error) => error.code === 'CLIENT_BUNDLE_DYNAMIC_REQUEST'
      && error.details.calls === 1,
  )
})

test('refuses unchecked async chunks whether missing, harmless, or unsafe', () => {
  for (const chunk of [undefined, 'module.exports = {}', 'require("node:fs")']) {
    const files = new Map([['lib/client.js', bundle('return require.async("./chunk.js")')]])
    if (chunk !== undefined) files.set('lib/chunk.js', chunk)
    assert.throws(() => inspectClientBundle(files, manifest()), error =>
      error.code === 'CLIENT_BUNDLE_UNSUPPORTED_LOADER' && /this audit cannot verify/u.test(error.message))
  }
})

test('recognizes async spellings, indirect references and executable expressions', () => {
  for (const body of [
    'return require["async"]("./chunk.js")',
    'return require[`async`]("./chunk.js")',
    'return require /* loader */ . /* method */ async("./chunk.js")',
    'return require?.async?.("./chunk.js")',
    'return require[method]("./chunk.js")',
    'return r\\u0065quire["as\\u0079nc"]("./chunk.js")',
    'return `${require.async("./chunk.js")}`',
    'const load = require.async; return load("./chunk.js")',
    'const { async: load } = require; return load("./chunk.js")',
    'const loader = require; return loader.async("./chunk.js")',
    'return useLoader(require)',
    'return require',
    'require = replacement; return require("react")',
    'return require?.("react")',
  ]) {
    assert.throws(() => inspectClientBundle(new Map([['lib/client.js', bundle(body)]]), manifest()),
      error => error.code === 'CLIENT_BUNDLE_UNSUPPORTED_LOADER', body)
  }
})

test('distinguishes loader references from text, member methods and shadowed bindings', () => {
  for (const body of [
    'const text = "require.async(\\\"./chunk.js\\\")"; /* require.async("./chunk.js") */',
    'const pattern = /require\\.async/; // require.async("./chunk.js")\n',
    'object.require.async("./chunk.js"); other.async("./chunk.js")',
    'function local(require) { return require.async("./chunk.js") }',
    '{ const require = { async() {} }; require.async("./chunk.js") }',
    'function local(require) { return require("node:fs") }',
    'const local = (require) => require["async"]("./chunk.js")',
    'try {} catch (require) { require.async("./chunk.js") }',
  ]) {
    const result = inspectClientBundle(new Map([['lib/client.js', bundle(body)]]), manifest())
    assert.deepEqual(result.requests, [], body)
  }
})

test('audits direct loader calls through comments, escapes and nested closures', () => {
  const result = inspectClientBundle(new Map([['lib/client.js', bundle(
    'const load = () => r\\u0065quire /* module */ ("react"); return load',
  )]]), manifest())
  assert.deepEqual(result.requests, ['react'])
  assert.throws(() => inspectClientBundle(new Map([['lib/client.js', bundle(
    'return r\\u0065quire /* module */ ("node:fs")',
  )]]), manifest()), error => error.code === 'CLIENT_BUNDLE_UNSAFE_IMPORT')
})

test('does not certify an overwritten or computed registration factory', () => {
  for (const extra of [
    ', factory: (require) => require.async("./chunk.js")',
    ', "factory": (require) => require.async("./chunk.js")',
    ', [name]: replacement',
    ', ...replacement',
    ', id: "another-package"',
  ]) {
    const source = 'window.__ModuleLoader__.load({ id: "client-fixture", factory: require => ({})' + extra + ' })'
    assert.throws(() => inspectClientBundle(new Map([['lib/client.js', source]]), manifest()),
      error => error.code === 'CLIENT_BUNDLE_REGISTRATION_INVALID', extra)
  }
})

test('requires a real registration call and its complete factory expression', () => {
  const registration = bundle('return require("node:fs")').trim()
  for (const source of [
    'object.' + registration,
    'object. /* member */ ' + registration,
    'object?.' + registration,
    'globalThis.' + registration,
    'é' + registration,
    'new ' + registration,
    'const window = {}; ' + registration,
    'window.__ModuleLoader__.load({ id: "client-fixture", factory: function(require) { return require("node:fs") }.bind(null) })',
  ]) {
    assert.throws(() => inspectClientBundle(new Map([['lib/client.js', source]]), manifest()),
      error => error.code === 'CLIENT_BUNDLE_REGISTRATION_INVALID', source)
  }
  for (const source of [bundle('return require("react")').trim() + '.then(() => {})',
    'window.__ModuleLoader__.load({ id: "client-fixture", factory() { return {} } })']) {
    assert.equal(inspectClientBundle(new Map([['lib/client.js', source]]), manifest()).declared, true)
  }
})

test('does not mistake a free require for the supplied DSH loader', () => {
  for (const source of ['require("react"); ' + bundle(),
    'window.__ModuleLoader__.load({ id: "client-fixture", factory() { return require("react") } })']) {
    assert.throws(() => inspectClientBundle(new Map([['lib/client.js', source]]), manifest()),
      error => error.code === 'CLIENT_BUNDLE_UNSUPPORTED_LOADER')
  }
})

test('refuses implicit factory arguments as an alternative loader reference', () => {
  for (const body of [
    'const require = arguments[0]; return require("node:fs")',
    'return arguments[0].async("./chunk.js")',
    'return (() => arguments[0].async("./chunk.js"))()',
    'var arguments; return arguments[0].async("./chunk.js")',
    'return { [arguments[0].async("./chunk.js")]() {} }',
    'return class { [arguments[0].async("./chunk.js")]() {} }',
  ]) {
    const source = 'window.__ModuleLoader__.load({ id: "client-fixture", factory() { ' + body + ' } })'
    assert.throws(() => inspectClientBundle(new Map([['lib/client.js', source]]), manifest()),
      error => error.code === 'CLIENT_BUNDLE_UNSUPPORTED_LOADER', body)
  }
  assert.throws(() => inspectClientBundle(new Map([['lib/client.js',
    'window.__ModuleLoader__.load({ id: "client-fixture", factory: function arguments(require) { return arguments[0].async("./chunk.js") } })',
  ]]), manifest()), error => error.code === 'CLIENT_BUNDLE_UNSUPPORTED_LOADER')
  const source = methodBundle('function local() { return arguments[0] }; '
    + '(() => { var arguments = [1]; return arguments[0] })(); '
    + '{ const arguments = { async() {} }; arguments.async("local"); } return require("react")')
  assert.deepEqual(inspectClientBundle(new Map([['lib/client.js', source]]), manifest()).requests, ['react'])
})

test('allows harmless parameter redeclaration but refuses actual loader assignments', () => {
  for (const body of ['var require; return require("react")', 'for (var require; false;) {} return require("react")']) {
    assert.deepEqual(inspectClientBundle(new Map([['lib/client.js', methodBundle(body)]]), manifest()).requests, ['react'])
  }
  for (const body of ['var require = other; return require("react")',
    'for (var require of []) {}', 'for (var require in {}) {}']) {
    assert.throws(() => inspectClientBundle(new Map([['lib/client.js', methodBundle(body)]]), manifest()),
      error => error.code === 'CLIENT_BUNDLE_UNSUPPORTED_LOADER', body)
  }
})

test('returns an explicit analysis refusal for valid deeply nested expressions', () => {
  for (const expression of [Array(20_000).fill('0').join('+'), 'object' + '.property'.repeat(20_000)]) {
    const source = bundle('const data = ' + expression + '; return require("react")')
    assert.throws(() => inspectClientBundle(new Map([['lib/client.js', source]]), manifest()),
      error => error.code === 'CLIENT_BUNDLE_ANALYSIS_LIMIT')
  }
})

test('does not confuse ordinary member methods with the loader require function', () => {
  const source = [
    'window.__ModuleLoader__.load({ id: "client-fixture", factory: (require) => {',
    '  class State { #require() { return {}; } read() { return this.#require(); } }',
    '  return new State();',
    '} })',
    '',
  ].join('\n')
  const result = inspectClientBundle(new Map([['lib/client.js', source]]), manifest())
  assert.deepEqual(result.requests, [])
})

test('ignores regex literal text while auditing template-expression code', () => {
  const source = [
    'window.__ModuleLoader__.load({ id: "client-fixture", factory: (require) => {',
    '  const pattern = /require\\("node:crypto"\\)/;',
    '  return `${/}/.test("}") ? require("react") : pattern}`;',
    '} })',
    '',
  ].join('\n')
  const result = inspectClientBundle(new Map([['lib/client.js', source]]), manifest())
  assert.deepEqual(result.requests, ['react'])
})

test('reports direct replacement of a DSH-owned client service without executing the bundle', () => {
  const result = inspectClientBundle(
    new Map([['lib/client.js', bundle('ctx.provide("chatFileMentions", {}); return {}')]]),
    manifest(),
  )
  assert.deepEqual(result.providedServices, ['chatFileMentions'])
  assert.deepEqual(result.coreServiceCollisions, [{
    service: 'chatFileMentions',
    lanes: [
      { target: DSH_COMPATIBILITY_TARGET, owner: '@deepseek-ai/dsh-client-ui-deliverables' },
      { target: DSH_PREVIEW_TARGET, owner: '@deepseek-ai/dsh-client-ui-deliverables' },
    ],
  }])
  assert.equal(result.repositoryCodeExecuted, false)
})

test('recognizes the current session owner on both lanes', () => {
  const owner = manifest()
  owner.name = '@deepseek-ai/dsh-api-session-controller'
  const result = inspectClientBundle(
    new Map([['lib/client.js', 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-api-session-controller", factory: (require) => { ctx.reflect.provide("sessions", {}); return {} } })\n']]),
    owner,
  )
  assert.deepEqual(result.providedServices, ['sessions'])
  assert.deepEqual(result.coreServiceCollisions, [])
})

test('ignores non-executable, unrelated, and dynamic service-provider lookalikes', () => {
  const source = [
    'window.__ModuleLoader__.load({ id: "client-fixture", factory: (require) => {',
    '  const message = `ctx.provide("theme", value)`;',
    '  const pattern = /ctx\\.provide\\("locale"/;',
    '  // ctx.reflect.provide("layout", value)',
    '  service.ctx.provide("connection", value);',
    '  other.provide("chatFileMentions", value);',
    '  const name = "theme";',
    '  ctx.provide(name, value);',
    '  return { message, pattern };',
    '} })',
    '',
  ].join('\n')
  const result = inspectClientBundle(new Map([['lib/client.js', source]]), manifest())
  assert.deepEqual(result.providedServices, [])
  assert.deepEqual(result.coreServiceCollisions, [])
  assert.equal(result.dynamicProvides, 1)
})

test('decodes quoted service names and scans executable template expressions', () => {
  const source = [
    'window.__ModuleLoader__.load({ id: "client-fixture", factory: (require) => {',
    '  return `${ctx.provide("chatFile\\x4dentions", {})}`;',
    '} })',
    '',
  ].join('\n')
  const result = inspectClientBundle(new Map([['lib/client.js', source]]), manifest())
  assert.deepEqual(result.providedServices, ['chatFileMentions'])
  assert.equal(result.coreServiceCollisions.length, 1)
})

function methodBundle(body = 'return {}') {
  return 'window.__ModuleLoader__.load({ id: "client-fixture", factory(require) { ' + body + ' } })\n'
}

test('accepts the shipped compiled object-method factory registration', async () => {
  const source = await readFile(new URL('../examples/session-status/lib/client.js', import.meta.url), 'utf8')
  const result = inspectClientBundle(new Map([['lib/client.js', source]]), {
    name: 'dsh-session-status',
    exports: { './client': './lib/client.js' },
    dsh: { client: { platform: 'web' } },
  })
  assert.equal(result.registrationId, 'dsh-session-status')
  assert.deepEqual(result.requests, ['react/jsx-runtime'])
  assert.deepEqual(result.dynamicRequests, [])
  assert.equal(result.repositoryCodeExecuted, false)
})

test('accepts object-method factory shorthand and still scans its body', () => {
  const result = inspectClientBundle(
    new Map([['lib/client.js', methodBundle('const React = require("react"); return { React }')]]),
    manifest(),
  )
  assert.equal(result.registrationId, 'client-fixture')
  assert.deepEqual(result.requests, ['react'])
  assert.equal(result.validation, 'static-classic-script')
})

test('rejects unsafe, dynamic, and duplicate object-method factory registrations', () => {
  assert.throws(
    () => inspectClientBundle(new Map([['lib/client.js', methodBundle('return require(someModule)')]]), manifest()),
    (error) => error.code === 'CLIENT_BUNDLE_DYNAMIC_REQUEST',
  )
  assert.throws(
    () => inspectClientBundle(new Map([['lib/client.js', methodBundle('return require("node:fs")')]]), manifest()),
    (error) => error.code === 'CLIENT_BUNDLE_UNSAFE_IMPORT' && error.details.requests[0] === 'node:fs',
  )
  assert.throws(
    () => inspectClientBundle(new Map([['lib/client.js', methodBundle() + methodBundle()]]), manifest()),
    (error) => error.code === 'CLIENT_BUNDLE_REGISTRATION_INVALID'
      && error.details.observed.length === 2,
  )
  assert.throws(
    () => inspectClientBundle(new Map([['lib/client.js', 'window.__ModuleLoader__.load({ id: "client-fixture" })\n']]), manifest()),
    (error) => error.code === 'CLIENT_BUNDLE_REGISTRATION_INVALID'
      && error.details.observed.length === 0,
  )
})

test('does not mistake an ordinary require method declaration for a loader call', () => {
  for (const body of ['class State { require() { return {}; } read() { return this.require(); } }',
    'const state = { require() { return {}; } }; state.require();']) {
    const result = inspectClientBundle(new Map([['lib/client.js', bundle(body)]]), manifest())
    assert.deepEqual(result.requests, [])
  }
  for (const body of ['require();', 'require()\n{}', 'require()\r\n{}', 'require()\u2028{}']) {
    assert.throws(() => inspectClientBundle(new Map([['lib/client.js', bundle(body)]]), manifest()),
      error => error.code === 'CLIENT_BUNDLE_DYNAMIC_REQUEST')
  }
})

test('preserves collisions for moved and newly inventoried native services', () => {
  for (const service of ['sessions', 'workspaces', 'slots', 'uiSession', 'uiWorkspace', 'resources',
    'fileUpload', 'documentPreviews', 'sidebarRight', 'sidebarRightTabs', 'webTerminals']) {
    const result = inspectClientBundle(new Map([['lib/client.js', bundle('ctx.provide(' + JSON.stringify(service) + ', {});')]]), manifest())
    assert.equal(result.coreServiceCollisions.length, 1, service)
    assert.deepEqual(result.coreServiceCollisions[0].lanes.map(lane => lane.target),
      service === 'webTerminals' ? [DSH_PREVIEW_TARGET] : [DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET])
  }
  const result = inspectClientBundle(new Map([['lib/client.js',
    'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-runtime", factory: () => { ctx.provide("sessions", {}); } })']]),
  { ...manifest(), name: '@deepseek-ai/dsh-client-runtime' })
  assert.equal(result.coreServiceCollisions.length, 1)
})
