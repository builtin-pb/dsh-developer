import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import {
  CLIENT_BUNDLE_CORE_SERVICE_OWNERS,
  inspectClientBundle,
  inspectClientServiceOwnership,
} from '../lib/client-bundle-audit.js'
import { DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET } from '../lib/constants.js'

const roots = (process.env.DSH_DEVELOPER_CLIENT_CORPUS_ROOTS ?? '')
  .split(delimiter)
  .filter(Boolean)

async function discoverClientPackages(root, found) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    let packageValue
    try {
      packageValue = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (packageValue?.name?.startsWith('@deepseek-ai/') && packageValue.dsh?.client) {
      const key = packageValue.name + '@' + packageValue.version
      if (!found.has(key)) found.set(key, { root: path, value: packageValue })
      continue
    }
    await discoverClientPackages(path, found)
  }
}

function clientTarget(packageValue) {
  const declaration = packageValue.exports?.['./client']
  if (typeof declaration === 'string') return declaration
  return declaration?.default
}

test('matches reviewed client ownership to exact installed release and preview bundles', {
  skip: roots.length === 0,
}, async () => {
  const packages = new Map()
  for (const root of roots) await discoverClientPackages(root, packages)
  const observed = []
  for (const { root, value } of packages.values()) {
    const target = clientTarget(value)
    assert.equal(typeof target, 'string', value.name + ' must export ./client')
    const clientPath = join(root, target.replace(/^\.\//u, ''))
    const source = await readFile(clientPath, 'utf8')
    const ownership = inspectClientServiceOwnership(source, value.name)
    assert.equal(ownership.dynamicProvides, 0, value.name + ' computes a client service name')
    for (const service of ownership.providedServices) {
      observed.push([value.name, value.version, service])
      const owners = CLIENT_BUNDLE_CORE_SERVICE_OWNERS[service]
      assert.ok(owners, value.name + ' provides unreviewed core service ' + service)
      assert.ok(
        Object.values(owners).includes(value.name),
        value.name + ' no longer owns core service ' + service,
      )
    }
    assert.deepEqual(ownership.coreServiceCollisions, [], value.name)
    if (value.version === DSH_COMPATIBILITY_TARGET) {
      const relative = target.replace(/^\.\//u, '').replaceAll('\\', '/')
      const inspected = inspectClientBundle(new Map([[relative, source]]), value)
      assert.equal(inspected.lanes.release.ok, true, value.name)
    }
  }
  assert.ok(packages.size > 0, 'No exact DSH client packages were discovered')
  assert.ok(observed.some((value) => value[1] === DSH_COMPATIBILITY_TARGET), 'No release providers were observed')
  assert.ok(observed.some((value) => value[1] === DSH_PREVIEW_TARGET), 'No preview providers were observed')
})
