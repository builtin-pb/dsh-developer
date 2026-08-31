import { createRequire } from 'node:module'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DshDeveloperError } from './errors.js'

const PACKAGE_BYTES = 1024 * 1024

async function readJson(path) {
  const info = await lstat(path).catch(() => undefined)
  if (!info?.isFile()) return undefined
  if (info.size > PACKAGE_BYTES) {
    throw new DshDeveloperError('DSH_PACKAGE_INVALID', 'A DSH package manifest exceeds the inspection limit.', { path })
  }
  let value
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new DshDeveloperError('DSH_PACKAGE_INVALID', 'A DSH package manifest is not valid JSON: ' + error.message, { path })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DshDeveloperError('DSH_PACKAGE_INVALID', 'A DSH package manifest must contain one JSON object.', { path })
  }
  return value
}

export async function locateDshPackage(invocation) {
  const entry = invocation.prefixArgs.find((value) => isAbsolute(value) && /\.[cm]?js$/iu.test(value))
  if (!entry) return undefined
  let directory = dirname(resolve(entry))
  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = join(directory, 'package.json')
    const value = await readJson(manifestPath)
    if (value?.name === '@deepseek-ai/dsh') {
      return {
        root: await realpath(directory),
        manifestPath: await realpath(manifestPath),
        value,
      }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

export async function assertOfficialDshInvocation(invocation) {
  const dshPackage = await locateDshPackage(invocation)
  if (!dshPackage) {
    throw new DshDeveloperError(
      'DSH_PACKAGE_NOT_FOUND',
      'The selected DSH entry is not inside an official @deepseek-ai/dsh package; refusing to execute it.',
      { dshPath: invocation.displayPath },
    )
  }
  const publicPackage = dshPackage.value.publishConfig?.access === 'public' && dshPackage.value.private !== true
  const declaredBin = dshPackage.value.bin?.dsh
  if (!publicPackage || typeof declaredBin !== 'string') {
    throw new DshDeveloperError(
      'DSH_PACKAGE_IDENTITY_INVALID',
      'The selected DSH package lacks the public official CLI identity; refusing to execute it.',
      { dshPath: invocation.displayPath },
    )
  }
  const actual = invocation.prefixArgs.find((value) => isAbsolute(value) && /\.[cm]?js$/iu.test(value))
  if (!actual) {
    throw new DshDeveloperError(
      'DSH_ENTRY_UNVERIFIED',
      'The selected DSH invocation has no inspectable JavaScript entry; refusing to execute it for admission.',
      { dshPath: invocation.displayPath },
    )
  }
  const expected = await realpath(resolve(dshPackage.root, declaredBin)).catch(() => undefined)
  const observed = await realpath(resolve(actual)).catch(() => undefined)
  const normalize = (value) => process.platform === 'win32' ? value?.toLocaleLowerCase('en-US') : value
  if (!expected || !observed || normalize(expected) !== normalize(observed) || escapesRoot(dshPackage.root, expected)) {
    throw new DshDeveloperError(
      'DSH_ENTRY_UNVERIFIED',
      'The selected DSH invocation does not resolve to its package-declared CLI entry; refusing to execute it.',
      { dshPath: invocation.displayPath },
    )
  }
  return dshPackage
}

export async function locateInstalledDshPackage(dshPackage, packageName) {
  if (!dshPackage) return undefined
  const parts = packageName.split('/')
  const candidates = [
    join(dshPackage.root, 'node_modules', ...parts, 'package.json'),
    join(dirname(dshPackage.root), parts.at(-1), 'package.json'),
    join(dirname(dirname(dshPackage.root)), ...parts, 'package.json'),
  ]
  try {
    const localRequire = createRequire(dshPackage.manifestPath)
    candidates.unshift(localRequire.resolve(packageName + '/package.json'))
  } catch {
    // Some packages do not export package.json; bounded path candidates remain.
  }
  const seen = new Set()
  for (const candidate of candidates) {
    const absolute = resolve(candidate)
    const key = absolute.toLocaleLowerCase('en-US')
    if (seen.has(key)) continue
    seen.add(key)
    const value = await readJson(absolute)
    if (value?.name !== packageName) continue
    return {
      root: await realpath(dirname(absolute)),
      manifestPath: await realpath(absolute),
      value,
    }
  }
  return undefined
}

function packageExportTarget(value) {
  const root = value.exports?.['.']
  if (typeof root === 'string') return root
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    for (const key of ['import', 'default', 'node', 'require']) {
      if (typeof root[key] === 'string') return root[key]
    }
  }
  return typeof value.main === 'string' ? value.main : undefined
}

function escapesRoot(root, candidate) {
  const outside = relative(root, candidate)
  return outside === '..' || outside.startsWith('..\\') || outside.startsWith('../') || isAbsolute(outside)
}

export async function resolveInstalledDshEntry(installed) {
  const target = packageExportTarget(installed.value)
  if (!target) {
    throw new DshDeveloperError('DSH_PACKAGE_ENTRY_MISSING', 'An installed DSH package has no public root entry.', {
      package: installed.value.name,
    })
  }
  const candidate = resolve(installed.root, target)
  if (escapesRoot(installed.root, candidate)) {
    throw new DshDeveloperError('DSH_PACKAGE_ENTRY_INVALID', 'An installed DSH package entry escapes its package root.', {
      package: installed.value.name,
    })
  }
  const entry = await realpath(candidate).catch(() => undefined)
  if (!entry) {
    throw new DshDeveloperError('DSH_PACKAGE_ENTRY_MISSING', 'An installed DSH package root entry does not exist.', {
      package: installed.value.name,
    })
  }
  if (escapesRoot(installed.root, entry)) {
    throw new DshDeveloperError('DSH_PACKAGE_ENTRY_INVALID', 'An installed DSH package entry resolves outside its package root.', {
      package: installed.value.name,
    })
  }
  const info = await lstat(entry)
  if (!info.isFile()) {
    throw new DshDeveloperError('DSH_PACKAGE_ENTRY_INVALID', 'An installed DSH package root entry is not a file.', {
      package: installed.value.name,
    })
  }
  return entry
}

export function installedPackageEvidence(installed) {
  const value = installed.value
  return {
    name: value.name,
    version: typeof value.version === 'string' ? value.version : undefined,
    access: value.publishConfig?.access === 'public' && value.private !== true ? 'public' : 'unpublished',
    publicEntry: Boolean(value.exports?.['.'] ?? value.main),
    repositoryDirectory: typeof value.repository?.directory === 'string' ? value.repository.directory : undefined,
  }
}
