import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { parse } from '@babel/parser'
import {
  CLIENT_BUNDLE_CORE_SERVICE_OWNERS,
  CLIENT_BUNDLE_PLATFORM_MODULES,
  CLIENT_BUNDLE_PREVIEW_PLATFORM_MODULES,
  inspectClientBundle,
  inspectClientServiceOwnership,
} from '../lib/client-bundle-audit.js'
import { DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET } from '../lib/constants.js'

const roots = (process.env.DSH_DEVELOPER_CLIENT_CORPUS_ROOTS ?? '').split(delimiter).filter(Boolean)
const versions = new Map([[DSH_COMPATIBILITY_TARGET, 'release'], [DSH_PREVIEW_TARGET, 'preview']])

async function discoverPackages(root, found) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    let value
    try { value = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
    if (value?.name?.startsWith('@deepseek-ai/') && (value.dsh?.client || value.name === '@deepseek-ai/dsh-web-frontend')) {
      if (versions.has(value.version)) found.set(value.name + '@' + value.version, { root: path, value })
      continue
    }
    await discoverPackages(path, found)
  }
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') continue
    if (Array.isArray(value)) for (const child of value) walk(child, visit)
    else if (value && typeof value === 'object') walk(value, visit)
  }
}

// Independent native-corpus observation: the product's bounded lexical scanner
// does not claim to discover Cordis Service subclass constructor registrations.
function constructorServices(source) {
  const ast = parse(source, { sourceType: 'script' }), cordisBindings = new Set(), services = []
  walk(ast, node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier'
        && node.init?.type === 'CallExpression' && node.init.callee.name === 'require'
        && node.init.arguments[0]?.value === '@deepseek-ai/cordis') cordisBindings.add(node.id.name)
  })
  walk(ast, node => {
    if (!['ClassExpression', 'ClassDeclaration'].includes(node.type)
        || node.superClass?.type !== 'MemberExpression'
        || !cordisBindings.has(node.superClass.object?.name)
        || node.superClass.property?.name !== 'Service') return
    for (const method of node.body.body) {
      if (method.kind !== 'constructor') continue
      walk(method.body, call => {
        if (call.type === 'CallExpression' && call.callee.type === 'Super'
            && call.arguments[1]?.type === 'StringLiteral') services.push(call.arguments[1].value)
      })
    }
  })
  return services
}

async function frontendSeeds(root) {
  const results = []
  const assets = join(root, 'dist', 'assets')
  for (const file of await readdir(assets)) {
    if (!file.endsWith('.js')) continue
    const source = await readFile(join(assets, file), 'utf8')
    if (!source.includes('staticModules:')) continue
    walk(parse(source, { sourceType: 'module' }), node => {
      if (node.type !== 'ObjectExpression') return
      const keys = node.properties.map(property => property.key?.name ?? property.key?.value)
      if (keys.includes('react') && keys.includes('@deepseek-ai/cordis')) results.push(keys)
    })
  }
  assert.equal(results.length, 1, 'Expected one exact native frontend static-module declaration')
  return results[0]
}

test('matches exact installed lane platform tables and ownership; retains bounded audit refusals', {
  skip: roots.length === 0,
}, async t => {
  const packages = new Map(), observed = new Set()
  for (const root of roots) await discoverPackages(root, packages)
  for (const [version, lane] of versions) {
    const frontend = packages.get('@deepseek-ai/dsh-web-frontend@' + version)
    assert.ok(frontend, 'Missing exact ' + lane + ' frontend')
    assert.deepEqual((await frontendSeeds(frontend.root)).sort(),
      [...(lane === 'release' ? CLIENT_BUNDLE_PLATFORM_MODULES : CLIENT_BUNDLE_PREVIEW_PLATFORM_MODULES)].sort())
  }
  for (const { root, value } of packages.values()) {
    if (!value.dsh?.client) continue
    const lane = versions.get(value.version)
    const declaration = value.exports?.['./client']
    const target = typeof declaration === 'string' ? declaration : declaration?.default
    assert.equal(typeof target, 'string', value.name + ' must export ./client')
    const relative = target.replace(/^\.\//u, '').replaceAll('\\', '/')
    const source = await readFile(join(root, relative), 'utf8')
    await t.test(value.name + '@' + value.version, () => {
      const ownership = inspectClientServiceOwnership(source, value.name)
      assert.equal(ownership.dynamicProvides, 0, value.name + ' computes a client service name')
      for (const service of new Set([...ownership.providedServices, ...constructorServices(source)])) {
        observed.add(lane + ':' + service)
        assert.equal(CLIENT_BUNDLE_CORE_SERVICE_OWNERS[service]?.[lane], value.name, lane + ' owner of ' + service)
        // Exercise the same service name through the consumer audit: exact owner
        // is accepted, unrelated plugins cannot replace it without a collision.
        assert.deepEqual(inspectClientServiceOwnership('ctx.provide(' + JSON.stringify(service) + ', {})', value.name).coreServiceCollisions, [])
        assert.equal(inspectClientServiceOwnership('ctx.provide(' + JSON.stringify(service) + ', {})', 'unrelated-plugin').coreServiceCollisions.length, 1)
      }
      assert.deepEqual(ownership.coreServiceCollisions, [], value.name)
      if (value.version === '0.1.6-alpha.2'
          && ['@deepseek-ai/dsh-client-ui-sidebar-documentpreview', '@deepseek-ai/dsh-client-ui-sidebar-terminal'].includes(value.name)) {
        // These entries now delegate to secondary chunks. Their presence in
        // upstream does not make our entry-only audit a proof of those bytes.
        assert.throws(() => inspectClientBundle(new Map([[relative, source]]), value),
          error => error.code === 'CLIENT_BUNDLE_UNSUPPORTED_LOADER')
        t.diagnostic(value.name + '@' + value.version + ': async chunks are not audited; ownership only verified')
      } else if (value.name === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview') {
        // The shipped PDF implementation retains a Node-only guarded branch.
        // This corpus observation is an explicit refusal, never audit success:
        // no reachability proof or Node-import exemption is added to the product.
        assert.throws(() => inspectClientBundle(new Map([[relative, source]]), value),
          error => error.code === 'CLIENT_BUNDLE_UNSAFE_IMPORT'
            && error.details.requests.length === 1 && error.details.requests[0] === 'url')
        t.diagnostic(value.name + '@' + value.version + ': audit remains unsupported (guarded require("url")); ownership only verified')
      } else {
        const inspected = inspectClientBundle(new Map([[relative, source]]), value)
        assert.equal(inspected.lanes[lane].ok, true, value.name)
      }
    })
  }
  for (const [service, owners] of Object.entries(CLIENT_BUNDLE_CORE_SERVICE_OWNERS)) {
    for (const lane of Object.keys(owners)) assert.ok(observed.has(lane + ':' + service), 'No native declaration for ' + lane + ':' + service)
  }
})
