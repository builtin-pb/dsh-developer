import { createHash } from 'node:crypto'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import semver from 'semver'
import {
  DSH_COMPATIBILITY_TARGET,
  DSH_PREVIEW_TARGET,
  PRODUCT_NAME,
  PRODUCT_VERSION,
} from './constants.js'
import { assertOfficialDshInvocation, locateInstalledDshPackage } from './dsh-installation.js'
import { DshDeveloperError } from './errors.js'
import { resolveDshInvocation } from './runtime.js'
import { findSecrets } from './security.js'

const FORMAT = 'dsh-profile-attestation'
const SCHEMA_VERSION = 1
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_LOCK_BYTES = 2 * 1024 * 1024
const MAX_PACKAGES = 64
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u
const ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`
const WORKSPACE_CONFIG = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`
const REQUIRED_FILES = new Set(['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml'])
const OPTIONAL_FILES = new Set(['cordis.yml', 'pnpm-lock.yaml'])
const SECRET_FILENAMES = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|_netrc|credentials(?:\..*)?)$/iu

function failure(code, message, details = {}, recovery = 'Restore an ordinary exact-lane profile and rerun the read-only attestation.') {
  throw new DshDeveloperError(code, message, { ...details, recovery })
}

function active(signal) {
  if (signal?.aborted) failure('CANCELLED', 'Profile attestation was cancelled.', {}, 'Rerun when the profile can remain unchanged for the complete scan.')
}

function hash(value) {
  return 'sha256:' + createHash('sha256').update(value).digest('hex')
}

function canonicalDigest(value) {
  return hash(JSON.stringify(value))
}

function normalizeText(value) {
  return value.replace(/\r\n?/gu, '\n')
}

function sameStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function identity(info) {
  return { dev: String(info.dev), ino: String(info.ino) }
}

function inside(root, candidate) {
  const value = relative(resolve(root), resolve(candidate))
  return value === '' || (value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value))
}

function equalPath(left, right) {
  const normalize = (value) => process.platform === 'win32' ? resolve(value).toLocaleLowerCase('en-US') : resolve(value)
  return normalize(left) === normalize(right)
}

async function readStableText(path, limit, label, signal, scanSecrets = true) {
  active(signal)
  const before = await lstat(path, { bigint: true }).catch((cause) => {
    failure('PROFILE_FILE_UNAVAILABLE', 'An attested file is unavailable.', { label, path, cause: cause.code })
  })
  if (before.isSymbolicLink() || !before.isFile()) {
    failure('PROFILE_UNSAFE_FILE', 'Attested files must be ordinary files, never links or special files.', { label, path })
  }
  if (before.size > BigInt(limit)) failure('PROFILE_FILE_TOO_LARGE', 'An attested file exceeds its bounded read limit.', { label, path, limit })
  const handle = await open(path, 'r')
  let buffer
  try {
    const opened = await handle.stat({ bigint: true })
    if (!sameStat(before, opened)) failure('PROFILE_STATE_CHANGED', 'An attested file changed while it was opened.', { label, path })
    buffer = await handle.readFile()
    const afterRead = await handle.stat({ bigint: true })
    if (!sameStat(opened, afterRead)) failure('PROFILE_STATE_CHANGED', 'An attested file changed while it was read.', { label, path })
  } finally {
    await handle.close()
  }
  const after = await lstat(path, { bigint: true }).catch(() => undefined)
  if (!after || !sameStat(before, after)) failure('PROFILE_STATE_CHANGED', 'An attested file changed before its digest was sealed.', { label, path })
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    failure('PROFILE_NON_TEXT_FILE', 'Attested manifests, configuration, and entries must be UTF-8 text.', { label, path })
  }
  if (text.includes('\0')) failure('PROFILE_NON_TEXT_FILE', 'An attested text file contains a NUL byte.', { label, path })
  const secretScanText = text.replace(/@deepseek-ai\/[a-z0-9._-]+/giu, '@deepseek-ai/package')
  const findingKinds = scanSecrets ? findSecrets(secretScanText) : []
  if (scanSecrets && (findingKinds.length > 0 || /:\/\/[^/\s:@]+:[^/\s@]+@/u.test(text))) {
    failure(
      'PROFILE_SECRET_STATE',
      'Potential credentials were found in attested state; no digest or content was emitted.',
      { label, findingKinds: findingKinds.length > 0 ? findingKinds : ['url-credentials'] },
      'Remove or redact credentials from the profile/package state, then rerun.',
    )
  }
  return { path, bytes: buffer.byteLength, digest: hash(buffer), text }
}

async function inspectOrdinaryDirectoryPath(input, signal) {
  const absolute = resolve(input)
  const root = parse(absolute).root
  const segments = relative(root, absolute).split(sep).filter(Boolean)
  const pathIdentity = []
  let current = root
  for (const segment of [undefined, ...segments]) {
    active(signal)
    if (segment !== undefined) current = join(current, segment)
    const info = await lstat(current, { bigint: true }).catch((cause) => {
      failure('PROFILE_PATH_UNAVAILABLE', 'The explicit profile path is unavailable.', { path: current, cause: cause.code })
    })
    if (info.isSymbolicLink()) failure('PROFILE_LINKED_PATH', 'The explicit profile path traverses a link or junction.', { linkedPath: current }, 'Use an ordinary physical profile directory and pass that exact path.')
    if (!info.isDirectory()) failure('PROFILE_PATH_INVALID', 'Every profile path component must be an ordinary directory.', { path: current })
    pathIdentity.push({ path: current, ...identity(info) })
  }
  const physicalPath = await realpath(absolute)
  return {
    path: absolute,
    physicalPath,
    pathIdentity,
    identityDigest: canonicalDigest({ path: absolute, physicalPath, pathIdentity }),
  }
}

async function listLayout(root, lane, signal) {
  active(signal)
  const allowedDirectories = new Set(['node_modules', ...(lane === 'preview' ? ['.dsh-module-fallback'] : [])])
  const values = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const info = await lstat(path, { bigint: true })
    if (info.isSymbolicLink()) failure('PROFILE_LINKED_STATE', 'Profile top-level state contains a link or junction.', { path }, 'Replace linked profile state with an ordinary pnpm hoisted installation.')
    if (info.isDirectory()) {
      if (!allowedDirectories.has(entry.name)) failure('PROFILE_LAYOUT_UNSUPPORTED', 'The profile contains an unrecognized top-level directory.', { name: entry.name })
      values.push({ name: entry.name, kind: 'directory' })
    } else if (info.isFile()) {
      if (SECRET_FILENAMES.test(entry.name)) failure('PROFILE_SECRET_STATE', 'The profile contains a credential-bearing configuration filename.', { name: entry.name }, 'Remove the credential file from the profile and use DSH credential services instead.')
      if (!REQUIRED_FILES.has(entry.name) && !OPTIONAL_FILES.has(entry.name)) failure('PROFILE_LAYOUT_UNSUPPORTED', 'The profile contains an unrecognized top-level file.', { name: entry.name })
      values.push({ name: entry.name, kind: 'file' })
    } else failure('PROFILE_LAYOUT_UNSUPPORTED', 'The profile contains special top-level filesystem state.', { name: entry.name })
  }
  values.sort((left, right) => left.name.localeCompare(right.name, 'en'))
  for (const name of REQUIRED_FILES) {
    if (!values.some((value) => value.name === name && value.kind === 'file')) failure('PROFILE_LAYOUT_INCOMPLETE', 'The profile is missing a required exact-lane file.', { name })
  }
  return values
}

function parseJson(file, label) {
  let value
  try { value = JSON.parse(file.text) } catch {
    failure('PROFILE_JSON_INVALID', 'An attested JSON manifest is invalid.', { label })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) failure('PROFILE_JSON_INVALID', 'An attested JSON manifest must contain one object.', { label })
  return value
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) failure('PROFILE_LAYOUT_UNSUPPORTED', label + ' contains an unsupported field.', { field: key })
}

function validateProfileManifest(file, lane) {
  const value = parseJson(file, 'profile package.json')
  exactKeys(value, new Set(['name', 'private', 'dependencies', 'dsh']), 'Profile package.json')
  if (typeof value.name !== 'string' || value.name.length === 0 || value.private !== true) failure('PROFILE_MANIFEST_INVALID', 'The profile manifest must have a non-empty name and private: true.')
  const dependencies = value.dependencies ?? {}
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) failure('PROFILE_MANIFEST_INVALID', 'Profile dependencies must be an object.')
  const dependencyOrder = Object.keys(dependencies)
  if (dependencyOrder.length > MAX_PACKAGES) failure('PROFILE_MANIFEST_INVALID', 'The v1 attestation package limit was exceeded.', { limit: MAX_PACKAGES })
  for (const name of dependencyOrder) {
    if (!PACKAGE_NAME.test(name) || typeof dependencies[name] !== 'string' || dependencies[name].length === 0) failure('PROFILE_MANIFEST_INVALID', 'Every profile dependency must have a valid package name and non-empty registry range.', { package: name })
  }
  const dsh = value.dsh
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) failure('PROFILE_MANIFEST_INVALID', 'Profile package.json must declare dsh.profile.')
  exactKeys(dsh, new Set(['profile']), 'Profile dsh manifest')
  const profile = dsh.profile
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) failure('PROFILE_MANIFEST_INVALID', 'Profile package.json must declare dsh.profile as an object.')
  exactKeys(profile, new Set(['bundles', ...(lane === 'preview' ? ['patchReload'] : [])]), 'dsh.profile')
  if (!Array.isArray(profile.bundles) || profile.bundles.length > MAX_PACKAGES) failure('PROFILE_MANIFEST_INVALID', 'dsh.profile.bundles must be a bounded ordered array.')
  const bundleOrder = [...profile.bundles]
  if (bundleOrder.some((name) => typeof name !== 'string' || !PACKAGE_NAME.test(name)) || new Set(bundleOrder).size !== bundleOrder.length) failure('PROFILE_MANIFEST_INVALID', 'Bundle names must be valid and unique while preserving order.')
  if (profile.patchReload !== undefined && !['live', 'startup'].includes(profile.patchReload)) failure('PROFILE_MANIFEST_INVALID', 'Preview patchReload must be live or startup.')
  return {
    value,
    evidence: {
      digest: file.digest,
      bytes: file.bytes,
      name: value.name,
      dependencyOrder,
      dependencies: Object.fromEntries(dependencyOrder.map((name) => [name, dependencies[name]])),
      bundleOrder,
      ...(profile.patchReload === undefined ? {} : { patchReload: profile.patchReload }),
    },
  }
}

function scalar(raw) {
  const value = raw.trim()
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/gu, "'")
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) } catch { failure('PROFILE_LOCK_INVALID', 'The lockfile contains an invalid quoted scalar.') }
  }
  if (/[#\[\]{}&*!|>]/u.test(value)) failure('PROFILE_LOCK_INVALID', 'The lockfile uses a YAML form outside the bounded v1 grammar.')
  return value
}

function yamlKey(raw) {
  return scalar(raw.replace(/:\s*$/u, ''))
}

function section(lines, name) {
  const start = lines.findIndex((line) => line === name + ':')
  if (start < 0) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[^\s#][^:]*:/u.test(lines[index])) { end = index; break }
  }
  return lines.slice(start + 1, end)
}

function parseLock(file, manifest) {
  const text = normalizeText(file.text)
  if (text.includes('\t')) failure('PROFILE_LOCK_INVALID', 'The lockfile must use spaces, not tabs.')
  const lines = text.split('\n')
  const versionLine = lines.find((line) => line.startsWith('lockfileVersion:'))
  if (!versionLine || scalar(versionLine.slice('lockfileVersion:'.length)) !== '9.0') failure('PROFILE_LOCK_INVALID', 'Only the exact pnpm lockfileVersion 9.0 layout is supported.')
  const importerLines = section(lines, 'importers')
  if (!importerLines) failure('PROFILE_LOCK_INVALID', 'The lockfile has no importers section.')
  const dot = importerLines.findIndex((line) => /^  \.:(?:\s*\{\})?\s*$/u.test(line))
  if (dot < 0) failure('PROFILE_LOCK_INVALID', 'The lockfile has no root profile importer.')
  const locked = new Map()
  let dependenciesStart = -1
  for (let index = dot + 1; index < importerLines.length; index += 1) {
    if (/^  \S/u.test(importerLines[index])) break
    if (/^    dependencies:\s*$/u.test(importerLines[index])) { dependenciesStart = index + 1; break }
  }
  if (dependenciesStart >= 0) {
    for (let index = dependenciesStart; index < importerLines.length;) {
      const line = importerLines[index]
      if (line.trim() === '') { index += 1; continue }
      if (!/^      \S/u.test(line)) break
      const name = yamlKey(line.trim())
      const fields = {}
      index += 1
      while (index < importerLines.length && /^        \S/u.test(importerLines[index])) {
        const match = /^        ([A-Za-z]+):\s*(.+)$/u.exec(importerLines[index])
        if (!match) failure('PROFILE_LOCK_INVALID', 'A direct lock importer field is unsupported.')
        fields[match[1]] = scalar(match[2])
        index += 1
      }
      if (typeof fields.specifier !== 'string' || typeof fields.version !== 'string') failure('PROFILE_LOCK_INVALID', 'Every direct lock entry needs specifier and version.', { package: name })
      locked.set(name, fields)
    }
  }
  const names = manifest.evidence.dependencyOrder
  if (names.length !== locked.size || names.some((name) => !locked.has(name))) failure('PROFILE_LOCK_DRIFT', 'Profile dependencies and the root lock importer differ.', {}, 'Run pnpm install in the profile under user authority, then rerun attestation.')
  const packageLines = section(lines, 'packages') ?? []
  const records = new Map()
  for (let index = 0; index < packageLines.length;) {
    if (!/^  \S/u.test(packageLines[index])) { index += 1; continue }
    const key = yamlKey(packageLines[index].trim())
    const body = []
    index += 1
    while (index < packageLines.length && !/^  \S/u.test(packageLines[index])) body.push(packageLines[index++])
    records.set(key, body)
  }
  const dependencies = []
  for (const name of names) {
    const entry = locked.get(name)
    const declared = manifest.evidence.dependencies[name]
    if (entry.specifier !== declared || /^(?:file|link|workspace|git|https?):/iu.test(declared) || !semver.validRange(declared)) failure('PROFILE_LOCK_MUTABLE_RESOLUTION', 'Direct profile packages must use matching immutable registry ranges.', { package: name }, 'Install a registry version with integrity evidence; linked, workspace, git, path, and URL packages are outside v1.')
    const resolvedVersion = entry.version.split('(')[0]
    if (!semver.valid(resolvedVersion) || !semver.satisfies(resolvedVersion, declared)) failure('PROFILE_LOCK_DRIFT', 'A locked direct version does not satisfy the profile manifest.', { package: name })
    const key = name + '@' + resolvedVersion
    const body = records.get(key)
    if (!body) failure('PROFILE_LOCK_DRIFT', 'The lockfile has no package record for a direct dependency.', { package: name, key })
    if (body.some((line) => /^    (?:os|cpu|libc):|^    optional:\s*true/u.test(line))) failure('PROFILE_PACKAGE_CONDITIONAL', 'Conditional or optional direct package records are outside the attestation claim.', { package: name })
    const resolution = body.find((line) => /^    resolution:/u.test(line))
    const match = resolution && /integrity:\s*([^,}\s]+)/u.exec(resolution)
    const integrity = match?.[1]
    if (!integrity || !INTEGRITY.test(integrity)) failure('PROFILE_LOCK_INTEGRITY_MISSING', 'A direct registry package lacks bounded lockfile integrity evidence.', { package: name })
    dependencies.push({ name, specifier: entry.specifier, lockVersion: entry.version, version: resolvedVersion, packageKey: key, integrity })
  }
  return { present: true, digest: file.digest, bytes: file.bytes, lockfileVersion: '9.0', dependencies }
}

async function ordinaryPackageRoot(profileRoot, name, signal) {
  let current = join(profileRoot, 'node_modules')
  for (const segment of name.split('/')) {
    active(signal)
    const info = await lstat(current, { bigint: true }).catch(() => undefined)
    if (!info || info.isSymbolicLink() || !info.isDirectory()) failure('PROFILE_PACKAGE_LINKED_OR_MISSING', 'A direct profile package root is missing or linked.', { package: name, path: current }, 'Reinstall the package with the profile nodeLinker: hoisted layout; do not use linked package roots.')
    current = join(current, segment)
  }
  const info = await lstat(current, { bigint: true }).catch(() => undefined)
  if (!info || info.isSymbolicLink() || !info.isDirectory()) failure('PROFILE_PACKAGE_LINKED_OR_MISSING', 'A direct profile package root is missing or linked.', { package: name, path: current }, 'Reinstall the package with the profile nodeLinker: hoisted layout; do not use linked package roots.')
  const physical = await realpath(current)
  if (!inside(profileRoot, physical)) failure('PROFILE_PACKAGE_ESCAPE', 'A direct package root resolves outside the profile.', { package: name })
  return { root: physical, rootIdentity: identity(info) }
}

async function packageFile(root, target, label, signal, scanSecrets) {
  if (typeof target !== 'string' || target.length === 0 || target.includes('\\') || isAbsolute(target)) failure('PROFILE_PACKAGE_ENTRY_INVALID', 'A package file target must be a non-empty relative path.', { label })
  const candidate = resolve(root, target)
  if (!inside(root, candidate)) failure('PROFILE_PACKAGE_ESCAPE', 'A package manifest target escapes its package root.', { label, target })
  let current = root
  for (const segment of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, segment)
    const info = await lstat(current, { bigint: true }).catch(() => undefined)
    if (!info || info.isSymbolicLink()) failure('PROFILE_PACKAGE_LINKED_FILE', 'A bounded package file is missing or linked.', { label, target })
  }
  return readStableText(candidate, MAX_TEXT_BYTES, label, signal, scanSecrets)
}

function rootEntry(value, name, required) {
  if (value.exports !== undefined) {
    if (typeof value.exports === 'string') return value.exports
    if (value.exports && typeof value.exports === 'object' && !Array.isArray(value.exports)) {
      if (typeof value.exports['.'] === 'string') return value.exports['.']
      const root = value.exports['.']
      if (root && typeof root === 'object' && !Array.isArray(root)) {
        for (const [condition, target] of Object.entries(root)) {
          if (condition === 'types') continue
          if (['import', 'node', 'default'].includes(condition) && typeof target === 'string') return target
          failure('PROFILE_PACKAGE_ENTRY_CONDITIONAL', 'An unreviewed package root export condition is outside the bounded v1 claim.', { package: name, condition })
        }
      }
      failure('PROFILE_PACKAGE_ENTRY_CONDITIONAL', 'Conditional package root exports are outside the bounded v1 claim.', { package: name }, 'Use a package with one explicit string root export or main entry for attestation.')
    }
    failure('PROFILE_PACKAGE_ENTRY_CONDITIONAL', 'The package root export layout is unsupported.', { package: name })
  }
  if (typeof value.main === 'string' && value.main.length > 0) return value.main
  if (required) failure('PROFILE_PACKAGE_ENTRY_MISSING', 'An active bundle has no explicit root entry.', { package: name })
}

async function inspectPackage(rootRecord, name, resolutionEvidence, expectedVersion, requiredBundle, signal) {
  const scanSecrets = resolutionEvidence.kind === 'profile'
  const manifestFile = await readStableText(join(rootRecord.root, 'package.json'), MAX_TEXT_BYTES, 'package manifest ' + name, signal, scanSecrets)
  const value = parseJson(manifestFile, 'package manifest ' + name)
  if (value.name !== name || typeof value.version !== 'string' || value.version.length === 0) failure('PROFILE_PACKAGE_IDENTITY_INVALID', 'An installed package manifest name/version does not match its resolution.', { package: name })
  if (expectedVersion !== undefined && value.version !== expectedVersion) failure('PROFILE_LOCK_DRIFT', 'Installed package version differs from the lockfile.', { package: name, installed: value.version, locked: expectedVersion })
  if (['os', 'cpu', 'libc'].some((field) => value[field] !== undefined)) failure('PROFILE_PACKAGE_CONDITIONAL', 'A direct package has conditional platform installation fields.', { package: name })
  const patchTarget = value.dsh?.bundle?.patch
  if (requiredBundle && typeof patchTarget !== 'string') failure('PROFILE_BUNDLE_INVALID', 'An ordered profile bundle declares no dsh.bundle.patch.', { package: name })
  const entryTarget = rootEntry(value, name, requiredBundle)
  const entry = entryTarget === undefined ? undefined : await packageFile(rootRecord.root, entryTarget, 'package entry ' + name, signal, scanSecrets)
  const patch = typeof patchTarget === 'string' ? await packageFile(rootRecord.root, patchTarget, 'bundle patch ' + name, signal, scanSecrets) : undefined
  return {
    name,
    version: value.version,
    resolution: resolutionEvidence,
    root: rootRecord.root,
    rootIdentity: rootRecord.rootIdentity,
    manifest: { bytes: manifestFile.bytes, digest: manifestFile.digest },
    entry: entry ? { path: entryTarget, bytes: entry.bytes, digest: entry.digest } : { present: false },
    bundlePatch: patch ? { path: patchTarget, bytes: patch.bytes, digest: patch.digest } : { present: false },
    isBundle: Boolean(patch),
  }
}

async function inspectDsh(context, signal) {
  const manifestFile = await readStableText(context.dshPackage.manifestPath, MAX_TEXT_BYTES, 'DSH package manifest', signal, false)
  const value = parseJson(manifestFile, 'DSH package manifest')
  if (value.name !== '@deepseek-ai/dsh' || value.version !== context.version || value.publishConfig?.access !== 'public' || value.private === true) failure('DSH_PACKAGE_IDENTITY_INVALID', 'The official DSH package identity changed during attestation.')
  const target = value.bin?.dsh
  if (typeof target !== 'string') failure('DSH_PACKAGE_IDENTITY_INVALID', 'The official DSH package has no declared dsh bin entry.')
  const expected = await realpath(resolve(context.dshPackage.root, target)).catch(() => undefined)
  if (!expected || !equalPath(expected, context.cliEntry)) failure('DSH_ENTRY_UNVERIFIED', 'The selected CLI does not match the package-declared dsh entry.')
  const entryFile = await readStableText(context.cliEntry, MAX_TEXT_BYTES, 'DSH CLI entry', signal, false)
  const rootInfo = await lstat(context.dshPackage.root, { bigint: true })
  return {
    package: { name: value.name, version: value.version, root: context.dshPackage.root, rootIdentity: identity(rootInfo), manifestDigest: manifestFile.digest },
    cli: { selectedPath: context.invocation.displayPath, entry: context.cliEntry, declaredEntry: target, bytes: entryFile.bytes, digest: entryFile.digest },
  }
}

async function scanPass(context, dependencies) {
  const signal = context.options.signal
  const profileBefore = await inspectOrdinaryDirectoryPath(context.profilePath, signal)
  const layoutBefore = await listLayout(profileBefore.physicalPath, context.lane.id, signal)
  const dsh = await inspectDsh(context, signal)
  const packageFileValue = await readStableText(join(profileBefore.physicalPath, 'package.json'), MAX_TEXT_BYTES, 'profile package.json', signal)
  const patchFile = await readStableText(join(profileBefore.physicalPath, 'cordis.patch.yml'), MAX_TEXT_BYTES, 'profile cordis.patch.yml', signal)
  const workspaceFile = await readStableText(join(profileBefore.physicalPath, 'pnpm-workspace.yaml'), MAX_TEXT_BYTES, 'profile pnpm-workspace.yaml', signal)
  if (normalizeText(workspaceFile.text) !== WORKSPACE_CONFIG) failure('PROFILE_WORKSPACE_UNSUPPORTED', 'pnpm-workspace.yaml differs from the exact rc.2/alpha.3 hoisted profile layout.')
  const rootConfigPresent = layoutBefore.some((value) => value.name === 'cordis.yml')
  const rootConfigFile = rootConfigPresent ? await readStableText(join(profileBefore.physicalPath, 'cordis.yml'), MAX_TEXT_BYTES, 'generated profile cordis.yml', signal) : undefined
  if (rootConfigFile && normalizeText(rootConfigFile.text) !== ROOT_CONFIG) failure('PROFILE_ROOT_CONFIG_INVALID', 'Generated cordis.yml is not the exact empty DSH profile root.')
  const manifest = validateProfileManifest(packageFileValue, context.lane.id)
  const lockPresent = layoutBefore.some((value) => value.name === 'pnpm-lock.yaml')
  let lock
  if (lockPresent) {
    const lockFile = await readStableText(join(profileBefore.physicalPath, 'pnpm-lock.yaml'), MAX_LOCK_BYTES, 'profile pnpm-lock.yaml', signal)
    lock = parseLock(lockFile, manifest)
  } else if (manifest.evidence.dependencyOrder.length > 0) failure('PROFILE_LOCK_MISSING', 'A profile with direct dependencies has no pnpm lockfile.', {}, 'Run pnpm install in the profile under user authority, then rerun attestation.')
  else lock = { present: false, reason: 'no-direct-dependencies' }
  const directPackages = []
  for (const locked of lock.dependencies ?? []) {
    const rootRecord = await ordinaryPackageRoot(profileBefore.physicalPath, locked.name, signal)
    directPackages.push(await inspectPackage(rootRecord, locked.name, { kind: 'profile', lock: locked }, locked.version, false, signal))
  }
  const directByName = new Map(directPackages.map((value) => [value.name, value]))
  const bundles = []
  for (const name of manifest.evidence.bundleOrder) {
    const installed = await (dependencies.locateInstalledDshPackage ?? locateInstalledDshPackage)(context.dshPackage, name)
    if (installed) {
      const info = await lstat(installed.root, { bigint: true })
      bundles.push(await inspectPackage({ root: installed.root, rootIdentity: identity(info) }, name, { kind: 'dsh-installation' }, undefined, true, signal))
    } else {
      const direct = directByName.get(name)
      if (!direct) failure('PROFILE_BUNDLE_MISSING', 'An ordered profile bundle is neither installation-provided nor a locked direct package.', { package: name })
      if (!direct.isBundle) failure('PROFILE_BUNDLE_INVALID', 'An ordered direct package declares no bundle patch.', { package: name })
      bundles.push(direct)
    }
  }
  for (const value of directPackages) {
    const listed = manifest.evidence.bundleOrder.includes(value.name)
    if (value.isBundle !== listed) failure('PROFILE_BUNDLE_ORDER_DRIFT', 'Direct package bundle declarations and dsh.profile.bundles are not reconciled.', { package: value.name, listed, declaresBundle: value.isBundle }, 'Run a successful dsh plugin operation to reconcile bundle order, then rerun attestation.')
  }
  const layoutAfter = await listLayout(profileBefore.physicalPath, context.lane.id, signal)
  const profileAfter = await inspectOrdinaryDirectoryPath(context.profilePath, signal)
  if (JSON.stringify(layoutBefore) !== JSON.stringify(layoutAfter) || profileBefore.identityDigest !== profileAfter.identityDigest) failure('PROFILE_STATE_CHANGED', 'The profile layout or physical identity changed during a scan pass.')
  return {
    attestor: { name: PRODUCT_NAME, version: PRODUCT_VERSION, node: process.version, platform: process.platform, arch: process.arch },
    claim: { type: 'bounded-static-installed-state', packageCodeExecuted: false, runtimeActivated: false, bootProved: false, compatibilityProved: false },
    runtime: { version: context.version, lane: context.lane.id, claim: context.lane.claim },
    installation: dsh,
    profile: {
      name: manifest.evidence.name,
      path: profileBefore.path,
      physicalPath: profileBefore.physicalPath,
      physicalIdentity: profileBefore.identityDigest,
      layout: layoutAfter,
      manifest: manifest.evidence,
      files: {
        patch: { bytes: patchFile.bytes, digest: patchFile.digest },
        workspace: { bytes: workspaceFile.bytes, digest: workspaceFile.digest },
        rootConfig: rootConfigFile ? { present: true, bytes: rootConfigFile.bytes, digest: rootConfigFile.digest } : { present: false },
      },
      lockfile: lock,
      directPackages,
      bundles,
    },
  }
}

function laneFor(version) {
  if (version === DSH_COMPATIBILITY_TARGET) return { id: 'release', claim: 'blocking', blocking: true }
  if (version === DSH_PREVIEW_TARGET) return { id: 'preview', claim: 'advisory', blocking: false }
  failure('PROFILE_ATTESTATION_LANE_UNSUPPORTED', 'Profile attestation supports only exact DSH 0.1.1-rc.2 and 0.1.2-alpha.3.', { version }, 'Select one exact reviewed DSH installation and rerun.')
}

export async function inspectProfileAttestationInternal(profilePath, options = {}, dependencies = {}) {
  const resolveInvocation = dependencies.resolveDshInvocation ?? resolveDshInvocation
  const establishOfficial = dependencies.assertOfficialDshInvocation ?? assertOfficialDshInvocation
  const now = dependencies.now ?? (() => new Date())
  try {
    const startedAt = now().toISOString()
    const invocation = await resolveInvocation(options.dshPath)
    const dshPackage = await establishOfficial(invocation)
    const version = dshPackage.value.version
    const lane = laneFor(version)
    const cliCandidate = invocation.prefixArgs.find((value) => isAbsolute(value) && /\.[cm]?js$/iu.test(value))
    const cliEntry = cliCandidate ? await realpath(cliCandidate) : undefined
    if (!cliEntry) failure('DSH_ENTRY_UNVERIFIED', 'The selected DSH CLI has no inspectable JavaScript entry.')
    const context = { profilePath: resolve(profilePath), options, invocation, dshPackage, version, lane, cliEntry }
    const first = await scanPass(context, dependencies)
    if (dependencies.betweenPasses) await dependencies.betweenPasses()
    const second = await scanPass(context, dependencies)
    const firstDigest = canonicalDigest(first)
    const evidenceDigest = canonicalDigest(second)
    if (firstDigest !== evidenceDigest) failure('PROFILE_STATE_CHANGED', 'Attested profile/installation evidence changed between freshness passes.', {}, 'Stop profile/package mutation and rerun the complete read-only scan.')
    const finishedAt = now().toISOString()
    return {
      kind: FORMAT,
      schemaVersion: SCHEMA_VERSION,
      ok: true,
      verifiedAt: finishedAt,
      freshness: { startedAt, finishedAt, passes: 2, stable: true },
      ...second,
      checks: [
        { id: 'runtime.exact-static-identity', status: 'PASS', blocking: lane.blocking, message: 'Official package manifest and declared CLI bytes match the exact ' + lane.id + ' lane.' },
        { id: 'profile.physical-state', status: 'PASS', blocking: true, message: 'The ordinary physical profile identity and bounded files were stable across two passes.' },
        { id: 'profile.lock-and-packages', status: 'PASS', blocking: true, message: 'Manifest order, lock integrity, installed direct packages, and ordered bundles agree.' },
        { id: 'claim.boundary', status: 'PASS', blocking: false, message: 'This receipt attests static bytes only; it is not runtime activation, boot, or compatibility proof.' },
      ],
      evidenceDigest,
    }
  } catch (error) {
    if (error instanceof DshDeveloperError) {
      if (error.details.recovery !== undefined) throw error
      throw new DshDeveloperError(error.code, error.message, { ...error.details, recovery: 'Repair the reported static state and rerun the full attestation.' })
    }
    throw new DshDeveloperError('PROFILE_ATTESTATION_FAILED', 'Profile attestation failed without emitting unbounded state.', {
      cause: error?.code ?? error?.name ?? 'unknown',
      recovery: 'Check filesystem access and exact-lane installation identity, then rerun.',
    })
  }
}
