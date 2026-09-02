import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import { DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET } from './constants.js'
import { inspectCohortRanges } from './cohort-range.js'
import {
  assertOfficialDshInvocation,
  locateInstalledDshPackage,
} from './dsh-installation.js'
import { asDiagnostic, DshDeveloperError } from './errors.js'
import { mapTreeEntries, scanOrdinaryTree } from './files.js'
import { resolveDshInvocation } from './runtime.js'
import { inspectExecutableModuleClosure } from './web-route-audit.js'

const PACKAGE_FILE_BYTES = 1024 * 1024
const MAX_PACKAGES = 512
const MAX_DECLARATION_FILES = 4096
const MAX_DECLARATION_BYTES = 32 * 1024 * 1024
const CODE_PATH = /\.(?:[cm]?[jt]sx?|mts|cts)$/iu
const CODE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']
const CODE_INDEX_FILES = CODE_EXTENSIONS.map((extension) => `index${extension}`)
const SERVICE_NAME = /^(?=.{1,128}$)[A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z_$][A-Za-z0-9_$-]*)*$/u
const DSH_CLIENT_PACKAGE_PREFIX = '@deepseek-ai/dsh-client-'
const IGNORED_CTX_PROPERTIES = new Set([
  'effect',
  'emit',
  'get',
  'inject',
  'logger',
  'on',
  'plugin',
  'provide',
  'reflect',
  'scope',
  'set',
])

function assertActive(signal) {
  if (signal?.aborted) throw new DshDeveloperError('CANCELLED', 'Upstream impact inspection was cancelled.')
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => [key, stableValue(value[key])]))
  }
  return value
}

function digest(value) {
  return 'sha256:' + createHash('sha256')
    .update(JSON.stringify(stableValue(value)), 'utf8')
    .digest('hex')
}

function fileDigest(buffer) {
  return 'sha256:' + createHash('sha256').update(buffer).digest('hex')
}

function check(id, status, message, blocking, evidence) {
  return {
    id,
    status,
    blocking,
    message,
    ...(evidence === undefined ? {} : { evidence }),
  }
}

function isUpstreamPackage(name) {
  return typeof name === 'string' && name.startsWith('@deepseek-ai/')
}

function splitSpecifier(specifier) {
  if (!isUpstreamPackage(specifier)) return undefined
  const parts = specifier.split('/')
  if (parts.length < 2 || !parts[1]) return undefined
  const packageName = parts.slice(0, 2).join('/')
  const suffix = parts.slice(2).join('/')
  return { packageName, subpath: suffix ? './' + suffix : '.' }
}

function addEvidence(target, value) {
  const key = JSON.stringify(value)
  if (!target.some((item) => JSON.stringify(item) === key)) target.push(value)
}

function addPackageReference(packages, specifier, evidence) {
  const parsed = splitSpecifier(specifier)
  if (!parsed) return
  let item = packages.get(parsed.packageName)
  if (!item) {
    item = { package: parsed.packageName, subpaths: new Set(), evidence: [] }
    packages.set(parsed.packageName, item)
  }
  item.subpaths.add(parsed.subpath)
  addEvidence(item.evidence, evidence)
}

function addServiceReference(services, name, evidence) {
  if (!SERVICE_NAME.test(name)) return
  let item = services.get(name)
  if (!item) {
    item = { service: name, evidence: [] }
    services.set(name, item)
  }
  addEvidence(item.evidence, evidence)
}

function addInvalidInjectValue(target, value) {
  target.set(JSON.stringify(value), value)
}

function parsePackageManifest(files) {
  const content = files.get('package.json')
  if (content === undefined) {
    throw new DshDeveloperError('IMPACT_PACKAGE_MISSING', 'Upstream impact inspection requires package.json.')
  }
  let value
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new DshDeveloperError('IMPACT_PACKAGE_INVALID', 'package.json is not valid JSON: ' + error.message)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DshDeveloperError('IMPACT_PACKAGE_INVALID', 'package.json must contain one JSON object.')
  }
  return value
}

function declaredUpstream(value) {
  const upstream = value.dshDeveloper?.upstream
  if (upstream === undefined) return { packages: [], services: [] }
  if (upstream === null || typeof upstream !== 'object' || Array.isArray(upstream)) {
    throw new DshDeveloperError('IMPACT_DECLARATION_INVALID', 'dshDeveloper.upstream must be an object.')
  }
  const unknown = Object.keys(upstream).filter((key) => !['packages', 'services'].includes(key))
  if (unknown.length > 0) {
    throw new DshDeveloperError('IMPACT_DECLARATION_INVALID', 'Unsupported dshDeveloper.upstream field "' + unknown[0] + '".')
  }
  const packages = upstream.packages ?? []
  const services = upstream.services ?? []
  if (!Array.isArray(packages) || !Array.isArray(services)) {
    throw new DshDeveloperError('IMPACT_DECLARATION_INVALID', 'Upstream packages and services must be arrays.')
  }
  if (packages.length > 128 || services.length > 128) {
    throw new DshDeveloperError('IMPACT_DECLARATION_INVALID', 'Upstream declarations exceed the 128-item bound.')
  }
  for (const specifier of packages) {
    if (typeof specifier !== 'string' || !splitSpecifier(specifier)) {
      throw new DshDeveloperError('IMPACT_DECLARATION_INVALID', 'Every upstream package must be an @deepseek-ai package specifier.')
    }
  }
  for (const service of services) {
    if (typeof service !== 'string' || !SERVICE_NAME.test(service)) {
      throw new DshDeveloperError('IMPACT_DECLARATION_INVALID', 'Every upstream service must be a bounded service name.')
    }
  }
  return { packages: [...new Set(packages)], services: [...new Set(services)] }
}

function manifestEntryPaths(manifest, files) {
  const candidates = []
  let declared = false
  let complete = true
  const rootExport = manifest.exports && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports)
    && Object.keys(manifest.exports).some((key) => key.startsWith('.'))
    ? manifest.exports['.']
    : manifest.exports
  if (Object.hasOwn(manifest, 'exports')) {
    declared = true
    const targets = runtimeExportTargets(rootExport)
    if (!targets || targets.length === 0) complete = false
    for (const target of targets ?? []) candidates.push({ target, main: false })
  } else if (Object.hasOwn(manifest, 'main')) {
    declared = true
    if (typeof manifest.main === 'string') candidates.push({ target: manifest.main, main: true })
    else complete = false
  }
  if (!declared && files.has('index.js')) candidates.push({ target: 'index.js', main: true })
  const entries = []
  for (const candidate of candidates) {
    const resolved = resolveManifestEntry(candidate.target, files, candidate.main)
    if (resolved) entries.push(resolved)
    else complete = false
  }
  return {
    entries: [...new Set(entries)].sort((left, right) => left.localeCompare(right, 'en')),
    complete: complete && entries.length > 0,
  }
}

function resolveManifestEntry(target, files, main) {
  if (typeof target !== 'string' || target.length === 0) return undefined
  if (!main && !target.startsWith('./')) return undefined
  const portable = target.replaceAll('\\', '/')
  if (portable.startsWith('/') || /^[A-Za-z]:\//u.test(portable)
      || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(portable)) return undefined
  const base = posix.normalize(portable.replace(/^\.\//u, ''))
  if (base === '..' || base.startsWith('../')) return undefined
  const candidates = [
    base,
    ...CODE_EXTENSIONS.map((extension) => base + extension),
    ...CODE_INDEX_FILES.map((name) => posix.join(base, name)),
  ]
  return candidates.find((value) => files.has(value) && CODE_PATH.test(value)
    && !/\.d\.(?:[cm]?ts|tsx)$/iu.test(value))
}

function runtimeModuleClosure(manifest, files) {
  const discovery = manifestEntryPaths(manifest, files)
  const closure = inspectExecutableModuleClosure(files, { entryPaths: discovery.entries })
  const manifestIncomplete = discovery.complete ? [] : ['package.json']
  return {
    ...closure,
    incompletePaths: [...new Set([
      ...closure.incompletePaths,
      ...manifestIncomplete,
    ])].sort((left, right) => left.localeCompare(right, 'en')),
    activationIncompletePaths: [...new Set([
      ...closure.activationIncompletePaths,
      ...manifestIncomplete,
    ])].sort((left, right) => left.localeCompare(right, 'en')),
  }
}

function runtimeExportTargets(value, state = { depth: 0, count: 0, target: [] }) {
  if (state.depth > 64 || state.count >= 256) return undefined
  state.count += 1
  if (typeof value === 'string') state.target.push(value)
  else if (Array.isArray(value)) {
    for (const item of value) {
      state.depth += 1
      if (!runtimeExportTargets(item, state)) return undefined
      state.depth -= 1
    }
  }
  else if (value && typeof value === 'object') {
    for (const [condition, item] of Object.entries(value)) {
      if (condition === 'types' || condition === 'typings') continue
      state.depth += 1
      if (!runtimeExportTargets(item, state)) return undefined
      state.depth -= 1
    }
  }
  return state.target
}

export function discoverUpstreamReferences(tree) {
  const files = mapTreeEntries(tree)
  const manifest = parsePackageManifest(files)
  const declared = declaredUpstream(manifest)
  const packages = new Map()
  const services = new Map()
  const unparsedInjectDeclarations = new Set()
  const invalidInjectValues = new Map()

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const dependencies = manifest[field]
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue
    for (const name of Object.keys(dependencies)) {
      addPackageReference(packages, name, {
        kind: 'package-manifest',
        path: 'package.json',
        field,
        ...(typeof dependencies[name] === 'string' ? { range: dependencies[name] } : {}),
      })
    }
  }
  for (const specifier of declared.packages) {
    addPackageReference(packages, specifier, { kind: 'declared', path: 'package.json' })
  }
  for (const service of declared.services) {
    addServiceReference(services, service, { kind: 'declared', path: 'package.json' })
  }

  const closure = runtimeModuleClosure(manifest, files)
  for (const path of closure.activationIncompletePaths) unparsedInjectDeclarations.add(path)
  for (const injectExport of closure.injectExports) {
    if (!injectExport.complete) {
      unparsedInjectDeclarations.add(injectExport.sourcePath ?? injectExport.entryPath)
      continue
    }
    if (!injectExport.present) continue
    for (const value of injectExport.values) {
      if (!SERVICE_NAME.test(value.service)) {
        addInvalidInjectValue(invalidInjectValues, {
          path: injectExport.definingPath,
          kind: 'inject',
          value: value.service,
        })
        continue
      }
      addServiceReference(services, value.service, {
        kind: 'inject',
        requirement: value.requirement,
        path: injectExport.definingPath,
      })
    }
  }
  for (const executableModule of closure.modules) {
    const path = executableModule.sourcePath
    for (const edge of executableModule.moduleEdges) {
      addPackageReference(packages, edge.specifier, { kind: 'static-import', path })
    }
    const contextReferences = executableModule.context
    if (!contextReferences.complete) unparsedInjectDeclarations.add(path)
    for (const declaration of contextReferences.injections) {
      if (!declaration.complete) {
        unparsedInjectDeclarations.add(path)
        continue
      }
      for (const value of declaration.values.filter((value) => !SERVICE_NAME.test(value))) {
        addInvalidInjectValue(invalidInjectValues, { path, kind: 'context-inject', value })
      }
      for (const service of declaration.values) {
        addServiceReference(services, service, {
          kind: 'context-inject',
          requirement: 'runtime',
          path,
        })
      }
    }
    for (const service of contextReferences.serviceLookups) {
      addServiceReference(services, service, { kind: 'service-lookup', path })
    }
    for (const property of contextReferences.properties) {
      if (!IGNORED_CTX_PROPERTIES.has(property)) {
        addServiceReference(services, property, { kind: 'context-property', path })
      }
    }
  }

  const patchPath = typeof manifest.dsh?.bundle?.patch === 'string'
    ? manifest.dsh.bundle.patch.replace(/^\.\//u, '')
    : undefined
  if (patchPath && files.has(patchPath)) {
    for (const match of files.get(patchPath).matchAll(/@deepseek-ai\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9*._/-]+)?/giu)) {
      addPackageReference(packages, match[0], { kind: 'bundle-reference', path: patchPath })
    }
  }

  if (manifest.dsh?.bundle || files.has('cordis.patch.yml')) {
    addPackageReference(packages, '@deepseek-ai/dsh', { kind: 'bundle-host', path: 'package.json' })
  }

  const declaredPackages = new Set(declared.packages.map((value) => splitSpecifier(value).packageName))
  const declaredServices = new Set(declared.services)
  const resultPackages = [...packages.values()]
    .map((value) => ({
      package: value.package,
      subpaths: [...value.subpaths].sort((left, right) => left.localeCompare(right, 'en')),
      evidence: value.evidence.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en')),
      declared: declaredPackages.has(value.package)
        || value.evidence.some((item) => item.kind === 'package-manifest'),
    }))
    .sort((left, right) => left.package.localeCompare(right.package, 'en'))
  const resultServices = [...services.values()]
    .map((value) => ({
      service: value.service,
      evidence: value.evidence.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en')),
      declared: declaredServices.has(value.service)
        || value.evidence.some((item) => item.kind === 'inject' || item.kind === 'context-inject'),
    }))
    .sort((left, right) => left.service.localeCompare(right.service, 'en'))
  return {
    plugin: {
      name: typeof manifest.name === 'string' ? manifest.name : undefined,
      version: typeof manifest.version === 'string' ? manifest.version : undefined,
    },
    packages: resultPackages,
    services: resultServices,
    coverage: {
      undeclaredPackages: resultPackages
        .filter((value) => !value.declared && !value.evidence.every((item) => item.kind === 'bundle-host'))
        .map((value) => value.package),
      undeclaredServices: resultServices.filter((value) => !value.declared).map((value) => value.service),
      invalidInjectValues: [...invalidInjectValues.values()]
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en')),
      unparsedInjectDeclarations: [...unparsedInjectDeclarations]
        .sort((left, right) => left.localeCompare(right, 'en')),
      unparsedModuleClosure: [...closure.incompletePaths],
    },
  }
}

export function classifyHostInjectContract(references) {
  const invalid = references.coverage.invalidInjectValues ?? []
  const clientPackageInjections = invalid.filter((value) => value.value.startsWith(DSH_CLIENT_PACKAGE_PREFIX))
  const invalidValues = invalid.filter((value) => !value.value.startsWith(DSH_CLIENT_PACKAGE_PREFIX))
  const unparsedDeclarations = references.coverage.unparsedInjectDeclarations
  const paths = [...new Set([
    ...unparsedDeclarations,
    ...invalid.map((value) => value.path),
  ])].sort((left, right) => left.localeCompare(right, 'en'))
  return {
    ok: paths.length === 0,
    paths,
    clientPackageInjections,
    invalidValues,
    unparsedDeclarations,
  }
}

function packageDependencyNames(value) {
  const names = new Set()
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const dependencies = value[field]
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue
    for (const name of Object.keys(dependencies)) {
      if (isUpstreamPackage(name)) names.add(name)
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right, 'en'))
}

async function packageInventory(dshPackage, options, dependencies) {
  const locate = dependencies.locateInstalledDshPackage ?? locateInstalledDshPackage
  const queue = ['@deepseek-ai/dsh', ...packageDependencyNames(dshPackage.value)]
  const seen = new Set()
  const inventory = new Map()
  while (queue.length > 0) {
    assertActive(options.signal)
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    if (seen.size > MAX_PACKAGES) {
      throw new DshDeveloperError('DSH_SURFACE_BOUNDS_EXCEEDED', 'Official DSH package inventory exceeds ' + MAX_PACKAGES + ' packages.')
    }
    const installed = name === '@deepseek-ai/dsh'
      ? dshPackage
      : await locate(dshPackage, name)
    if (!installed) continue
    inventory.set(name, installed)
    for (const dependency of packageDependencyNames(installed.value)) {
      if (!seen.has(dependency)) queue.push(dependency)
    }
  }
  return inventory
}

function portablePackagePath(root, path) {
  return relative(root, path).split(sep).join('/')
}

function sameFile(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
}

async function readStablePackageFile(path, context) {
  assertActive(context.signal)
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > PACKAGE_FILE_BYTES) {
    throw new DshDeveloperError('DSH_SURFACE_FILE_INVALID', 'A DSH surface file is not a bounded ordinary file.', { path })
  }
  const first = await readFile(path)
  const middle = await lstat(path)
  const second = await readFile(path)
  const after = await lstat(path)
  if (!sameFile(before, middle) || !sameFile(middle, after) || !first.equals(second)) {
    throw new DshDeveloperError('DSH_SURFACE_MUTATED', 'A DSH package file changed during impact inspection.', { path })
  }
  return first
}

async function declarationFiles(installed, context, fresh = false) {
  const cacheKey = installed.root.toLocaleLowerCase('en-US')
  if (!fresh && context.declarationCache.has(cacheKey)) return context.declarationCache.get(cacheKey)
  const files = new Map()
  async function visit(directory) {
    assertActive(context.signal)
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      if (child.name === 'node_modules') continue
      const absolute = resolve(directory, child.name)
      if (child.isSymbolicLink()) continue
      if (child.isDirectory()) {
        await visit(absolute)
        continue
      }
      if (!child.isFile() || !child.name.endsWith('.d.ts')) continue
      const buffer = await readStablePackageFile(absolute, context)
      context.declarationFiles += 1
      context.declarationBytes += buffer.byteLength
      if (context.declarationFiles > MAX_DECLARATION_FILES || context.declarationBytes > MAX_DECLARATION_BYTES) {
        throw new DshDeveloperError('DSH_SURFACE_BOUNDS_EXCEEDED', 'Official DSH declarations exceed the bounded inspection budget.')
      }
      files.set(portablePackagePath(installed.root, absolute), buffer)
    }
  }
  await visit(installed.root)
  if (!fresh) context.declarationCache.set(cacheKey, files)
  return files
}

function contextServices(content) {
  const text = content.toString('utf8')
  if (!/declare\s+module\s+["']@deepseek-ai\/cordis["']/u.test(text)) return []
  const names = new Set()
  for (const match of text.matchAll(/interface\s+Context\s*\{([\s\S]*?)\}/gu)) {
    for (const property of match[1].matchAll(/^\s*(?:readonly\s+)?["']?([A-Za-z_$][A-Za-z0-9_$-]*)["']?\s*[?:]/gmu)) {
      if (SERVICE_NAME.test(property[1])) names.add(property[1])
    }
  }
  return [...names]
}

async function serviceIndex(inventory, context) {
  const result = new Map()
  for (const [name, installed] of inventory) {
    const declarations = await declarationFiles(installed, context)
    const services = new Set()
    for (const content of declarations.values()) {
      for (const service of contextServices(content)) services.add(service)
    }
    for (const service of services) {
      const packages = result.get(service) ?? []
      packages.push(name)
      packages.sort((left, right) => left.localeCompare(right, 'en'))
      result.set(service, packages)
    }
  }
  return result
}

export async function indexInstalledServiceOwners(dshPackage, options = {}, dependencies = {}) {
  const inventory = dependencies.packageInventory
    ? await dependencies.packageInventory(dshPackage, options)
    : await packageInventory(dshPackage, options, dependencies)
  const context = {
    signal: options.signal,
    declarationCache: new Map(),
    declarationFiles: 0,
    declarationBytes: 0,
  }
  const services = dependencies.serviceIndex
    ? await dependencies.serviceIndex(inventory, context)
    : await serviceIndex(inventory, context)
  return new Map([...services.entries()]
    .map(([service, owners]) => [
      service,
      [...owners].sort((left, right) => left.localeCompare(right, 'en')),
    ])
    .sort(([left], [right]) => left.localeCompare(right, 'en')))
}

function laneCheck(id, expectedVersion, installed, invocation) {
  const version = installed.value.version
  if (version !== expectedVersion) {
    throw new DshDeveloperError('DSH_IMPACT_LANE_MISMATCH', 'The ' + id + ' impact lane must be exact DSH ' + expectedVersion + '.', {
      lane: id,
      expected: expectedVersion,
      actual: version,
      dshPath: invocation.displayPath,
    })
  }
  return {
    id,
    ok: true,
    expectedVersion,
    version,
    dshPath: invocation.displayPath,
    package: installed,
  }
}

async function inspectLane(id, expectedVersion, dshPath, options, dependencies) {
  const resolveInvocation = dependencies.resolveDshInvocation ?? resolveDshInvocation
  const assertOfficial = dependencies.assertOfficialDshInvocation ?? assertOfficialDshInvocation
  try {
    const invocation = await resolveInvocation(dshPath)
    const installed = await assertOfficial(invocation)
    return laneCheck(id, expectedVersion, installed, invocation)
  } catch (error) {
    if (error?.code === 'CANCELLED') throw error
    return {
      id,
      ok: false,
      expectedVersion,
      dshPath,
      error: asDiagnostic(error),
    }
  }
}

function selectedManifest(value) {
  const select = (field) => value[field] === undefined ? undefined : stableValue(value[field])
  return {
    type: select('type'),
    main: select('main'),
    module: select('module'),
    types: select('types'),
    exports: select('exports'),
    bin: select('bin'),
    dsh: select('dsh'),
    peerDependencies: select('peerDependencies'),
    peerDependenciesMeta: select('peerDependenciesMeta'),
    dependencies: select('dependencies'),
    optionalDependencies: select('optionalDependencies'),
  }
}

function exportValue(exportsValue, subpath) {
  if (exportsValue === undefined) return undefined
  if (typeof exportsValue === 'string' || Array.isArray(exportsValue)) return subpath === '.' ? exportsValue : undefined
  if (!exportsValue || typeof exportsValue !== 'object') return undefined
  const keys = Object.keys(exportsValue)
  if (!keys.some((key) => key.startsWith('.'))) return subpath === '.' ? exportsValue : undefined
  if (exportsValue[subpath] !== undefined) return exportsValue[subpath]
  for (const key of keys.filter((value) => value.includes('*'))) {
    const [prefix, suffix = ''] = key.split('*')
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
    const wildcard = subpath.slice(prefix.length, subpath.length - suffix.length)
    const replace = (value) => {
      if (typeof value === 'string') return value.replaceAll('*', wildcard)
      if (Array.isArray(value)) return value.map(replace)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, replace(item)]))
      return value
    }
    return replace(exportsValue[key])
  }
  return undefined
}

function stringTargets(value, target = []) {
  if (typeof value === 'string') target.push(value)
  else if (Array.isArray(value)) value.forEach((item) => stringTargets(item, target))
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => stringTargets(item, target))
  return target
}

function insideRoot(root, candidate) {
  const path = relative(root, candidate)
  return path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path)
}

async function entryDigests(installed, subpaths, context) {
  const targets = new Set()
  for (const subpath of subpaths.length > 0 ? subpaths : ['.']) {
    for (const target of stringTargets(exportValue(installed.value.exports, subpath))) targets.add(target)
    if (subpath === '.') {
      for (const field of ['main', 'module', 'types']) {
        if (typeof installed.value[field] === 'string') targets.add(installed.value[field])
      }
    }
  }
  const result = {}
  for (const target of [...targets].sort((left, right) => left.localeCompare(right, 'en'))) {
    assertActive(context.signal)
    if (!target.startsWith('./') || target.includes('*')) continue
    const candidate = resolve(installed.root, target)
    if (!insideRoot(installed.root, candidate)) continue
    const info = await lstat(candidate).catch(() => undefined)
    if (!info?.isFile() || info.isSymbolicLink() || info.size > PACKAGE_FILE_BYTES) continue
    result[portablePackagePath(installed.root, candidate)] = fileDigest(await readStablePackageFile(candidate, context))
  }
  return result
}

async function stablePackageManifest(installed, context) {
  const buffer = await readStablePackageFile(installed.manifestPath, context)
  let value
  try {
    value = JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    throw new DshDeveloperError('DSH_SURFACE_MANIFEST_INVALID', 'A DSH package manifest is invalid JSON: ' + error.message, {
      package: installed.value.name,
    })
  }
  if (JSON.stringify(stableValue(value)) !== JSON.stringify(stableValue(installed.value))) {
    throw new DshDeveloperError('DSH_SURFACE_MUTATED', 'A DSH package manifest changed after lane identity was established.', {
      package: installed.value.name,
    })
  }
  return value
}

async function packageSurface(installed, subpaths, context) {
  if (!installed) return undefined
  const manifest = await stablePackageManifest(installed, context)
  const declarations = await declarationFiles(installed, context)
  const entries = await entryDigests(installed, subpaths, context)
  const freshDeclarations = await declarationFiles(installed, context, true)
  const freshEntries = await entryDigests(installed, subpaths, context)
  const finalManifest = await stablePackageManifest(installed, context)
  const declarationDigests = Object.fromEntries([...freshDeclarations]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([path, content]) => [path, fileDigest(content)]))
  const initialDeclarationDigests = Object.fromEntries([...declarations]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([path, content]) => [path, fileDigest(content)]))
  if (JSON.stringify(initialDeclarationDigests) !== JSON.stringify(declarationDigests)
      || JSON.stringify(entries) !== JSON.stringify(freshEntries)
      || JSON.stringify(stableValue(manifest)) !== JSON.stringify(stableValue(finalManifest))) {
    throw new DshDeveloperError('DSH_SURFACE_MUTATED', 'A DSH package surface changed during impact inspection.', {
      package: installed.value.name,
    })
  }
  const selected = selectedManifest(finalManifest)
  const surface = {
    name: finalManifest.name,
    version: finalManifest.version,
    access: finalManifest.publishConfig?.access === 'public' && finalManifest.private !== true
      ? 'public'
      : 'unpublished',
    repositoryDirectory: finalManifest.repository?.directory,
    manifest: selected,
    declarations: declarationDigests,
    entries: freshEntries,
  }
  surface.digest = digest(surface)
  return surface
}

function fileChanges(before = {}, after = {}) {
  const result = []
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort((left, right) => left.localeCompare(right, 'en'))
  for (const path of paths) {
    if (before[path] === after[path]) continue
    result.push({
      path,
      status: before[path] === undefined ? 'added' : after[path] === undefined ? 'removed' : 'changed',
      from: before[path],
      to: after[path],
    })
  }
  return result
}

function publicSurface(surface) {
  if (!surface) return undefined
  return {
    name: surface.name,
    version: surface.version,
    access: surface.access,
    repositoryDirectory: surface.repositoryDirectory,
    manifest: surface.manifest,
    digest: surface.digest,
  }
}

export function comparePackageSurfaces(packageName, release, preview) {
  if (!release && !preview) {
    return { package: packageName, classification: 'unresolved', revalidate: true, reasons: ['missing-both-lanes'] }
  }
  if (!release) {
    return {
      package: packageName,
      classification: 'added',
      revalidate: true,
      reasons: ['package-added'],
      preview: publicSurface(preview),
    }
  }
  if (!preview) {
    return {
      package: packageName,
      classification: 'removed',
      revalidate: true,
      reasons: ['package-removed'],
      release: publicSurface(release),
    }
  }
  const reasons = []
  const manifestFields = [
    ['type', 'entry-declaration-changed'],
    ['main', 'entry-declaration-changed'],
    ['module', 'entry-declaration-changed'],
    ['types', 'entry-declaration-changed'],
    ['exports', 'exports-changed'],
    ['bin', 'bin-changed'],
    ['dsh', 'dsh-metadata-changed'],
    ['peerDependencies', 'peer-dependencies-changed'],
    ['peerDependenciesMeta', 'peer-dependencies-changed'],
    ['dependencies', 'runtime-dependencies-changed'],
    ['optionalDependencies', 'runtime-dependencies-changed'],
  ]
  for (const [field, reason] of manifestFields) {
    if (JSON.stringify(release.manifest[field]) !== JSON.stringify(preview.manifest[field]) && !reasons.includes(reason)) {
      reasons.push(reason)
    }
  }
  if (release.access !== preview.access) reasons.push('access-changed')
  const declarations = fileChanges(release.declarations, preview.declarations)
  const entries = fileChanges(release.entries, preview.entries)
  if (declarations.length > 0) reasons.push('declarations-changed')
  if (entries.length > 0) reasons.push('public-entries-changed')
  if (release.version !== preview.version) reasons.push('version-changed')
  const contractReasons = new Set([
    'access-changed',
    'bin-changed',
    'declarations-changed',
    'dsh-metadata-changed',
    'entry-declaration-changed',
    'exports-changed',
    'peer-dependencies-changed',
  ])
  const classification = reasons.length === 0
    ? 'unchanged'
    : reasons.some((value) => contractReasons.has(value))
      ? 'contract'
      : reasons.some((value) => value !== 'version-changed')
        ? 'implementation'
        : 'package-version'
  return {
    package: packageName,
    classification,
    revalidate: classification !== 'unchanged',
    reasons,
    release: publicSurface(release),
    preview: publicSurface(preview),
    changedFiles: {
      declarations: declarations.slice(0, 128),
      entries: entries.slice(0, 128),
    },
  }
}

function reportDigest(report) {
  return digest({
    sourceFingerprint: report.sourceFingerprint,
    plugin: report.plugin,
    references: report.references,
    serviceMappings: report.serviceMappings,
    cohortRanges: report.cohortRanges,
    lanes: report.lanes.map(({ id, ok, expectedVersion, version }) => ({ id, ok, expectedVersion, version })),
    changes: report.changes,
    checks: report.checks.map(({ id, status, blocking }) => ({ id, status, blocking })),
  })
}

export async function inspectUpstreamImpactInternal(source, options, dependencies = {}) {
  const scan = dependencies.scanOrdinaryTree ?? scanOrdinaryTree
  const first = await scan(resolve(source), { signal: options.signal, excludeDependencies: true })
  const references = discoverUpstreamReferences(first)
  const lanes = await Promise.all([
    inspectLane('release', DSH_COMPATIBILITY_TARGET, options.releaseDsh, options, dependencies),
    inspectLane('preview', DSH_PREVIEW_TARGET, options.previewDsh, options, dependencies),
  ])
  const checks = [
    check('source.snapshot', 'PASS', 'Acquired one stable, bounded, credential-free plugin tree.', true, {
      fingerprint: first.fingerprint,
      files: first.fileCount,
    }),
  ]
  const injectContract = classifyHostInjectContract(references)
  checks.push(check(
    'source.inject-contract',
    injectContract.ok ? 'PASS' : 'FAIL',
    injectContract.ok
      ? 'Every discovered inject assignment is a closed literal service declaration.'
      : injectContract.clientPackageInjections.length > 0
        ? 'A Host Cordis inject declaration contains DSH Client package identifiers that only belong in package.json dsh.client.inject.'
        : 'Upstream impact cannot be scoped completely while an inject assignment is dynamic, unsupported, or contains an invalid service name.',
    true,
    injectContract.ok ? undefined : {
      paths: injectContract.paths,
      clientPackageInjections: injectContract.clientPackageInjections,
      invalidValues: injectContract.invalidValues,
      unparsedDeclarations: injectContract.unparsedDeclarations,
    },
  ))
  for (const lane of lanes) {
    checks.push(check(
      'lane.' + lane.id,
      lane.ok ? 'PASS' : 'FAIL',
      lane.ok
        ? 'Established the package-declared official DSH ' + lane.expectedVersion + ' entry without executing it.'
        : 'Could not establish exact official DSH ' + lane.expectedVersion + '.',
      true,
      lane.ok ? { version: lane.version, dshPath: lane.dshPath } : lane.error,
    ))
  }

  const uncovered = [...references.coverage.undeclaredPackages, ...references.coverage.undeclaredServices]
  checks.push(check(
    'source.declaration-coverage',
    uncovered.length === 0 ? 'PASS' : 'WARN',
    uncovered.length === 0
      ? 'Observed upstream package and service surfaces are explicitly declared.'
      : 'Observed upstream surfaces are not all declared; inference remains visible but may be incomplete.',
    false,
    uncovered.length === 0 ? undefined : references.coverage,
  ))

  const serviceMappings = references.services.map((value) => ({
    service: value.service,
    declared: value.declared,
    release: [],
    preview: [],
  }))
  const changes = []
  let cohortRanges = []
  if (lanes.every((lane) => lane.ok)) {
    const laneData = {}
    for (const lane of lanes) {
      const inventory = dependencies.packageInventory
        ? await dependencies.packageInventory(lane.package, options)
        : await packageInventory(lane.package, options, dependencies)
      const context = {
        signal: options.signal,
        declarationCache: new Map(),
        declarationFiles: 0,
        declarationBytes: 0,
      }
      const services = dependencies.serviceIndex
        ? await dependencies.serviceIndex(inventory, context)
        : await serviceIndex(inventory, context)
      laneData[lane.id] = { inventory, context, services }
      for (const mapping of serviceMappings) mapping[lane.id] = services.get(mapping.service) ?? []
    }

    const packageReferences = new Map(references.packages.map((value) => [value.package, {
      ...value,
      services: [],
    }]))
    for (const mapping of serviceMappings) {
      for (const packageName of new Set([...mapping.release, ...mapping.preview])) {
        const current = packageReferences.get(packageName) ?? {
          package: packageName,
          subpaths: ['.'],
          evidence: [],
          declared: false,
          services: [],
        }
        current.services.push(mapping.service)
        current.services.sort((left, right) => left.localeCompare(right, 'en'))
        packageReferences.set(packageName, current)
      }
    }

    const unresolvedServices = serviceMappings
      .filter((value) => value.release.length === 0 && value.preview.length === 0)
      .map((value) => value.service)
    checks.push(check(
      'source.service-resolution',
      unresolvedServices.length === 0 ? 'PASS' : 'FAIL',
      unresolvedServices.length === 0
        ? 'Every referenced Cordis service resolves to a package declaration in at least one exact lane.'
        : 'One or more referenced services could not be mapped to an installed DSH package declaration.',
      true,
      unresolvedServices.length === 0 ? undefined : { unresolvedServices },
    ))

    const locate = dependencies.locateInstalledDshPackage ?? locateInstalledDshPackage
    for (const reference of [...packageReferences.values()].sort((left, right) => left.package.localeCompare(right.package, 'en'))) {
      const releaseInstalled = laneData.release.inventory.get(reference.package)
        ?? await locate(lanes.find((lane) => lane.id === 'release').package, reference.package)
      const previewInstalled = laneData.preview.inventory.get(reference.package)
        ?? await locate(lanes.find((lane) => lane.id === 'preview').package, reference.package)
      const releaseSurface = await packageSurface(releaseInstalled, reference.subpaths, laneData.release.context)
      const previewSurface = await packageSurface(previewInstalled, reference.subpaths, laneData.preview.context)
      changes.push(comparePackageSurfaces(reference.package, releaseSurface, previewSurface))
    }
    const unresolvedPackages = changes
      .filter((value) => value.classification === 'unresolved')
      .map((value) => value.package)
    checks.push(check(
      'source.package-resolution',
      unresolvedPackages.length === 0 ? 'PASS' : 'FAIL',
      unresolvedPackages.length === 0
        ? 'Every referenced upstream package resolves in at least one exact lane.'
        : 'One or more referenced packages are absent from both exact host package graphs.',
      true,
      unresolvedPackages.length === 0 ? undefined : { unresolvedPackages },
    ))
    cohortRanges = inspectCohortRanges(references, changes)
    const laneIssues = (lane) => cohortRanges.filter((value) => {
      const result = value.lanes.find((item) => item.lane === lane)
      return !result || !result.known || !result.satisfies
    })
    const releaseIssues = laneIssues('release')
    const previewIssues = laneIssues('preview')
    checks.push(check(
      'source.release-cohort-coverage',
      releaseIssues.length === 0 ? 'PASS' : 'FAIL',
      releaseIssues.length === 0
        ? 'Every declared DSH peer and development range admits the exact installed release cohort.'
        : 'One or more DSH peer or development ranges exclude or cannot prove the exact installed release cohort.',
      true,
      cohortRanges.length === 0 ? undefined : { ranges: cohortRanges },
    ))
    checks.push(check(
      'source.preview-cohort-coverage',
      previewIssues.length === 0 ? 'PASS' : 'WARN',
      previewIssues.length === 0
        ? 'Every declared DSH peer and development range admits the exact installed preview cohort.'
        : 'One or more DSH peer or development ranges exclude or cannot prove the advisory preview cohort.',
      false,
      cohortRanges.length === 0 ? undefined : { ranges: cohortRanges },
    ))
  } else {
    checks.push(check('source.service-resolution', 'SKIP', 'Service mapping requires both exact official DSH lanes.', true))
    checks.push(check('source.package-resolution', 'SKIP', 'Package impact requires both exact official DSH lanes.', true))
    checks.push(check('source.release-cohort-coverage', 'SKIP', 'Release cohort range proof requires both exact official DSH lanes.', true))
    checks.push(check('source.preview-cohort-coverage', 'SKIP', 'Preview cohort range proof requires both exact official DSH lanes.', false))
  }

  const final = await scan(resolve(source), { signal: options.signal, excludeDependencies: true })
  const fresh = final.fingerprint === first.fingerprint
  checks.push(check(
    'source.freshness',
    fresh ? 'PASS' : 'FAIL',
    fresh
      ? 'A fresh source scan matches the tree used to scope upstream impact.'
      : 'Plugin source changed during upstream impact inspection.',
    true,
    { before: first.fingerprint, after: final.fingerprint },
  ))

  const report = {
    kind: 'dsh-upstream-impact',
    ok: checks.every((value) => !value.blocking || value.status === 'PASS'),
    source: first.root,
    sourceFingerprint: final.fingerprint,
    verifiedAt: new Date().toISOString(),
    plugin: references.plugin,
    references: {
      packages: references.packages,
      services: references.services,
    },
    serviceMappings,
    cohortRanges,
    lanes: lanes.map(({ package: _package, ...lane }) => lane),
    changes,
    checks,
    summary: {
      packages: changes.length,
      services: references.services.length,
      revalidation: changes.filter((value) => value.revalidate).length,
      contract: changes.filter((value) => value.classification === 'contract').length,
      unresolved: changes.filter((value) => value.classification === 'unresolved').length,
      releaseCohortMismatches: cohortRanges.filter((value) => {
        const lane = value.lanes.find((item) => item.lane === 'release')
        return !lane || !lane.known || !lane.satisfies
      }).length,
      previewCohortMismatches: cohortRanges.filter((value) => {
        const lane = value.lanes.find((item) => item.lane === 'preview')
        return !lane || !lane.known || !lane.satisfies
      }).length,
    },
  }
  report.evidenceDigest = reportDigest(report)
  return report
}
