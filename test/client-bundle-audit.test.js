import assert from 'node:assert/strict'
import test from 'node:test'
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
    release: { target: '0.1.1-rc.2', ok: true, missing: [] },
    preview: { target: '0.1.2-alpha.3', ok: true, missing: [] },
  })
  assert.equal(result.repositoryCodeExecuted, false)
  assert.ok(CLIENT_BUNDLE_PLATFORM_MODULES.includes('react'))
  assert.ok(CLIENT_BUNDLE_PREVIEW_PLATFORM_MODULES.includes('@deepseek-ai/dsh-client-store'))
})

test('reports release-only platform requests as advisory preview drift', () => {
  const result = inspectClientBundle(
    new Map([['lib/client.js', bundle('return require("@deepseek-ai/dsh-client-runtime/client")')]]),
    manifest(),
  )
  assert.equal(result.lanes.release.ok, true)
  assert.equal(result.lanes.preview.ok, false)
  assert.deepEqual(result.lanes.preview.missing, ['@deepseek-ai/dsh-client-runtime/client'])
})

test('blocks preview-only platform requests for the supported release', () => {
  assert.throws(
    () => inspectClientBundle(
      new Map([['lib/client.js', bundle('return require("@deepseek-ai/dsh-client-store")')]]),
      manifest(),
    ),
    (error) => error.code === 'CLIENT_BUNDLE_EXTERNAL_DRIFT'
      && error.details.target === '0.1.1-rc.2'
      && error.details.requests[0] === '@deepseek-ai/dsh-client-store'
      && error.details.previewTarget === '0.1.2-alpha.3'
      && error.details.previewRequests.length === 0,
  )
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
      { target: '0.1.1-rc.2', owner: '@deepseek-ai/dsh-client-ui-deliverables' },
      { target: '0.1.2-alpha.3', owner: '@deepseek-ai/dsh-client-ui-deliverables' },
    ],
  }])
  assert.equal(result.repositoryCodeExecuted, false)
})

test('recognizes official ownership across release and preview service moves', () => {
  const owner = manifest()
  owner.name = '@deepseek-ai/dsh-client-runtime'
  const result = inspectClientBundle(
    new Map([['lib/client.js', 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-runtime", factory: (require) => { ctx.reflect.provide("sessions", {}); return {} } })\n']]),
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
