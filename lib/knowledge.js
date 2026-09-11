import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { locateDshPackage, locateInstalledDshPackage, localPackageSearchPaths } from './dsh-installation.js'
import { DshDeveloperError } from './errors.js'
import { resolveDshInvocation } from './runtime.js'
import { satisfies, valid, validRange } from 'semver'

export const KNOWLEDGE_TOPICS = Object.freeze([
  'tool', 'lifecycle', 'configuration', 'ui', 'packaging', 'core', 'testing',
])

// Navigation hints, not copied API contracts. Public documentation basis:
// https://github.com/deepseek-ai/deepseek-harness/tree/c291e7961a515f6d7af9304e7fd1d257929aef26/docs
// Package ownership also follows the published packages' repository.directory.
// All evidence below comes from the selected local files, never this revision.
const ROUTES = {
  tool: {
    docs: ['docs/user/develop/basic/tool.md', 'docs/cookbook/adding-a-tool.md', 'docs/subsystems/tools.md'],
    owners: ['tools', 'tool-todo'],
    match: /defineTool|register\(|ToolDefinition|execute\(/u,
  },
  lifecycle: {
    docs: ['docs/user/develop/framework/index.md', 'docs/cordis-primer.md', 'docs/subsystems/extensions.md'],
    owners: ['cordis', 'loader', 'app-boot'],
    match: /dispose|inject|apply\(|lifecycle/iu,
  },
  configuration: {
    docs: ['docs/user/develop/basic/config.md', 'docs/subsystems/settings.md', 'apps/cli/reference/README.md'],
    owners: ['settings', 'loader', 'cli'],
    match: /Schema|Config|SettingsNamespace|layer/iu,
  },
  ui: {
    docs: ['docs/subsystems/web-client.md', 'docs/subsystems/client-modules.md', 'docs/subsystems/slots.md', 'docs/api-gateway.md'],
    owners: ['ui-renderer', 'ui-slots', 'gateway', 'connection'],
    match: /renderSlot|register|Remote|export (?:class|interface|function)/u,
  },
  packaging: {
    docs: ['docs/user/develop/basic/publish.md', 'apps/cli/reference/README.md'],
    owners: ['cli', 'app-boot'],
    match: /bundle|profile|publish|package/iu,
  },
  core: {
    docs: ['docs/architecture.md', 'docs/subsystems/core.md', 'docs/subsystems/session.md'],
    owners: ['agent', 'agent-loop', 'session'],
    match: /AgentHandle|export (?:class|interface)|async |cancel/iu,
  },
  testing: {
    docs: ['docs/development.md', 'CONTRIBUTING.md'],
    owners: ['tools', 'agent-loop', 'cli'],
    match: /test\(|it\(|describe\(|test:|vitest|typecheck/u,
  },
}

const OWNERS = {
  cli: ['@deepseek-ai/dsh', 'apps/cli'],
  tools: ['@deepseek-ai/dsh-tools', 'packages/core/tools'],
  'tool-todo': ['@deepseek-ai/dsh-tool-todo', 'packages/todo/tool-todo'],
  cordis: ['@deepseek-ai/cordis', 'vendor/cordis'],
  loader: ['@deepseek-ai/cordis-plugin-loader', 'vendor/loader'],
  'app-boot': ['@deepseek-ai/dsh-app-boot', 'packages/boot/app-boot'],
  settings: ['@deepseek-ai/dsh-settings', 'packages/settings/settings'],
  'ui-renderer': ['@deepseek-ai/dsh-client-ui-renderer', 'packages/client/ui-renderer'],
  'ui-slots': ['@deepseek-ai/dsh-client-ui-slots', 'packages/client/ui-slots'],
  gateway: ['@deepseek-ai/dsh-api-gateway', 'packages/api/gateway'],
  connection: ['@deepseek-ai/dsh-client-connection', 'packages/client/connection'],
  agent: ['@deepseek-ai/dsh-agent', 'packages/core/agent'],
  'agent-loop': ['@deepseek-ai/dsh-agent-loop', 'packages/core/agent-loop'],
  session: ['@deepseek-ai/dsh-session', 'packages/core/session'],
}

const LIMITS = Object.freeze({
  fileBytes: 256 * 1024,
  metadataBytes: 64 * 1024,
  totalReadBytes: 8 * 1024 * 1024,
  evidenceFiles: 96,
  excerptChars: 1800,
  excerptLines: 32,
  directoryEntries: 2048,
  packageEntries: 192,
  directoryDepth: 3,
  sourcesPerPackage: 3,
  testsPerPackage: 2,
  declarationsPerPackage: 4,
  // The existing installation helpers independently bound each manifest to 1 MiB.
  identityManifestBytes: 1024 * 1024,
  developmentPackages: 96,
  developmentEdges: 512,
})
const CODE = /\.[cm]?[jt]sx?$/iu
const DECLARATION = /\.d\.[cm]?ts$/iu
const TEST = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/iu
const OMIT = /^(?:\..*|node_modules|config|configs|credentials|secrets|fixtures|__fixtures__|coverage|dist|lib)$/iu
const PACKAGE_NAME = /^@deepseek-ai\/[a-z0-9][a-z0-9._-]{0,200}$/u

function cancelled(signal) {
  if (signal?.aborted) throw new DshDeveloperError('CANCELLED', 'DSH knowledge lookup was cancelled.')
}

function inside(root, target) {
  const rel = relative(root, target)
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}

function smallString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value)
    ? value : null
}

function safeRepositoryDirectory(value) {
  return smallString(value) && !isAbsolute(value) && !/[\\:]/u.test(value)
    && value.split('/').every(part => part && !OMIT.test(part))
}

async function developmentPeers(resolvePackage, seed, signal) {
  const queue = [{ name: seed }]
  const dependencies = {}, missing = []
  const seen = new Set(), pins = new Map()
  let root
  let edges = 0
  while (queue.length) {
    cancelled(signal)
    const request = queue.shift()
    const pkg = await resolvePackage(request.name, request.from, seen.size < LIMITS.developmentPackages)
    cancelled(signal)
    if (!request.from) root = pkg
    const identity = pkg?.manifestPath ?? JSON.stringify([request.from?.manifestPath, request.name])
    const version = valid(pkg?.value.version ?? '')
    if (!seen.has(identity)) {
      if (seen.size >= LIMITS.developmentPackages) {
        missing.push({ name: request.name, reason: 'peer-closure-limit' })
        break
      }
      seen.add(identity)
      if (!pkg || !version || version !== pkg.value.version) {
        missing.push({ name: request.name, ...(request.consumer ? { consumer: request.consumer } : {}),
          reason: 'exact-installed-version-unavailable' })
        continue
      }
      const previous = pins.get(request.name)
      if (previous && previous.manifestPath !== pkg.manifestPath) {
        // A version pin cannot preserve distinct module instances or nominal
        // types. Even equal versions at different physical roots are ambiguous.
        delete dependencies[request.name]
        missing.push({ name: request.name, consumer: request.consumer, reason: 'installed-peer-identity-conflict',
          identities: [previous, { root: pkg.root, manifestPath: pkg.manifestPath, version, consumer: request.consumer }] })
      } else {
        pins.set(request.name, { root: pkg.root, manifestPath: pkg.manifestPath, version, consumer: request.consumer })
        dependencies[request.name] = version
      }
      const peers = pkg.value.peerDependencies
      if (peers !== undefined && (!peers || typeof peers !== 'object' || Array.isArray(peers))) {
        missing.push({ name: request.name, reason: 'invalid-peer-dependencies' })
      }
      for (const [name, range] of Object.entries(peers && typeof peers === 'object' && !Array.isArray(peers) ? peers : {})) {
        if (!name.startsWith('@deepseek-ai/')) continue
        if (edges >= LIMITS.developmentEdges) {
          missing.push({ name: request.name, reason: 'peer-edge-limit' })
          break
        }
        edges += 1
        if (!PACKAGE_NAME.test(name)) {
          missing.push({ name: request.name, reason: 'invalid-peer-package-name' })
          continue
        }
        queue.push({ name, range, consumer: request.name, from: pkg })
      }
    }
    if (request.range !== undefined && version
        && (typeof request.range !== 'string' || !validRange(request.range) || !satisfies(version, request.range))) {
      missing.push({ name: request.name, consumer: request.consumer, reason: 'installed-peer-range-mismatch' })
    }
  }
  return { rootPackage: seed, root: root?.root ?? null, manifestPath: root?.manifestPath ?? null,
    dependencies, complete: missing.length === 0, missing, usage: { packages: seen.size, edges },
    scope: 'Exact installed @deepseek-ai peerDependencies closure from each consumer’s physical package root using ancestor node_modules lookup. Distinct physical identities, including equal versions, cannot share a flat pin. Type-only imports and ordinary dependencies are not discovered; custom loaders, export-condition entry selection and preserve-symlinks modes are not modeled. This is not a complete TypeScript dependency recipe or an install or runtime-compatibility proof.' }
}

async function locateKnowledgePackage(state, consumer, name, packages, allowNew) {
  if (consumer.value.name === name && consumer.value.exports != null) return consumer
  // Node supplies the search order. Exclude NODE_PATH/global lookup locations,
  // which are not a portable import basis for the selected installed graph.
  const paths = localPackageSearchPaths(consumer, name)
  for (const path of paths) {
    cancelled(state.signal)
    const candidate = join(path, ...name.split('/'))
    try { await lstat(candidate) } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue
      return undefined
    }
    // The nearest package directory shadows all later copies, even if its
    // manifest is absent, malformed, mismatched or unsafe to inspect.
    const root = await realpath(candidate).catch(() => undefined)
    if (!root) return undefined
    if (packages.has(root)) {
      const pkg = packages.get(root)
      return pkg.value.name === name ? pkg : undefined
    }
    if (!allowNew) return undefined
    const checked = await checkedPath(root, 'package.json', state.signal)
    if (!checked.path || !checked.info.isFile() || checked.info.size > LIMITS.identityManifestBytes) return undefined
    let exportedManifest
    try { exportedManifest = createRequire(consumer.manifestPath).resolve(name + '/package.json') } catch { /* Export-hidden metadata is read below. */ }
    if (exportedManifest === checked.path) {
      // Reuse the metadata-only helper only when its first candidate is proven
      // to be this consumer's nearest manifest, rather than a guessed sibling.
      try {
        const pkg = await locateInstalledDshPackage(consumer, name)
        cancelled(state.signal)
        if (pkg?.root !== root || pkg.manifestPath !== checked.path) return undefined
        packages.set(root, pkg)
        return pkg
      } catch (error) {
        cancelled(state.signal)
        if (error.code !== 'DSH_PACKAGE_INVALID') throw error
        return undefined
      }
    }
    const manifest = await readText(state, root, 'package.json', LIMITS.identityManifestBytes)
    if (!manifest.text) return undefined
    try {
      const value = JSON.parse(manifest.text)
      if (value?.name !== name) return undefined
      const pkg = { root, manifestPath: manifest.path, value }
      packages.set(root, pkg)
      return pkg
    } catch { return undefined }
  }
  return undefined
}

// Reject symlinks even within a package: an exported declaration must not alias a
// user's config. Package roots themselves may be real npm/pnpm link targets.
async function checkedPath(root, name, signal) {
  cancelled(signal)
  const target = resolve(root, name)
  if (!inside(root, target)) return { reason: 'outside-root' }
  let current = root
  try {
    for (const part of relative(root, target).split(/[\\/]/u).filter(Boolean)) {
      current = join(current, part)
      const info = await lstat(current)
      cancelled(signal)
      if (info.isSymbolicLink()) return { reason: 'symlink' }
    }
    if (!inside(root, await realpath(target))) return { reason: 'outside-root' }
    return { path: target, info: await lstat(target) }
  } catch (error) {
    cancelled(signal)
    return { reason: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'not-found' : 'unreadable' }
  }
}

async function readText(state, root, name, maxBytes = LIMITS.fileBytes) {
  const checked = await checkedPath(root, name, state.signal)
  if (!checked.path) return checked
  if (!checked.info.isFile()) return { reason: 'not-regular-file' }
  if (checked.info.size > maxBytes) return { reason: 'file-size-limit' }
  if (state.usage.readBytes + maxBytes + 1 > LIMITS.totalReadBytes) return { reason: 'total-read-limit' }
  let handle
  try {
    handle = await open(checked.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const info = await handle.stat()
    cancelled(state.signal)
    if (!info.isFile() || info.ino !== checked.info.ino || info.dev !== checked.info.dev) return { reason: 'file-changed' }
    if (info.size > maxBytes) return { reason: 'file-size-limit' }
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      cancelled(state.signal)
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      state.usage.readBytes += bytesRead
      if (bytesRead === 0) break
      length += bytesRead
    }
    cancelled(state.signal)
    if (length > maxBytes) return { reason: 'file-size-limit' }
    const after = await handle.stat()
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || length !== info.size) return { reason: 'file-changed' }
    const bytes = buffer.subarray(0, length)
    let text
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return { reason: 'not-utf8' } }
    if (text.includes('\0')) return { reason: 'not-text' }
    return { path: checked.path, text, bytes: length, sha256: createHash('sha256').update(bytes).digest('hex') }
  } catch (error) {
    cancelled(state.signal)
    return { reason: error.code === 'ENOENT' ? 'not-found' : 'unreadable' }
  } finally {
    await handle?.close()
  }
}

async function readManifest(state, root, name = 'package.json') {
  const file = await readText(state, root, name, LIMITS.metadataBytes)
  if (file.reason) return file
  try {
    const value = JSON.parse(file.text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { reason: 'invalid-manifest' }
    return { ...file, value }
  } catch { return { reason: 'invalid-manifest' } }
}

function excerpt(file, topics, kind) {
  const lines = file.text.split('\n')
  const index = lines.findIndex((line) => kind === 'test' ? /\b(?:describe|it|test)\(/u.test(line)
    : topics.some((topic) => ROUTES[topic].match.test(line)))
  const start = Math.max(0, index - 3)
  const selected = lines.slice(start, start + LIMITS.excerptLines).join('\n')
  const text = selected.slice(0, LIMITS.excerptChars)
  return {
    startLine: start + 1,
    endLine: start + text.split('\n').length,
    excerpt: text,
    truncated: start > 0 || text.length < lines.slice(start).join('\n').length,
  }
}

function missing(state, context, name, kind, reason) {
  state.report.missing.push({ origin: context.origin, packageName: context.packageName ?? null, topics: context.topics,
    path: resolve(context.root, name), kind, reason })
}

async function evidence(state, context, name, kind) {
  const key = context.origin + ':' + resolve(context.root, name)
  const previous = state.seen.get(key)
  if (previous) {
    previous.topics = [...new Set([...previous.topics, ...context.topics])]
    return true
  }
  if (state.report.evidence.length >= LIMITS.evidenceFiles) {
    missing(state, context, name, kind, 'evidence-limit')
    return false
  }
  const file = await readText(state, context.root, name)
  if (file.reason) {
    missing(state, context, name, kind, file.reason)
    return false
  }
  const item = {
    origin: context.origin, topics: context.topics, kind,
    packageName: context.packageName ?? null, packageVersion: context.packageVersion ?? null,
    path: file.path, relativePath: name.replaceAll('\\', '/'),
    bytes: file.bytes, sha256: file.sha256, ...excerpt(file, context.topics, kind),
  }
  state.report.evidence.push(item)
  state.seen.set(key, item)
  return true
}

// Only discover code under known source/test directories of selected owners.
// opendir avoids allocating an unbounded directory listing before applying limits.
async function discoverCode(state, context) {
  const files = []
  let entries = 0
  let limited = false
  async function visit(name, depth) {
    const checked = await checkedPath(context.root, name, state.signal)
    if (!checked.info?.isDirectory()) return
    const directory = await opendir(checked.path).catch(() => null)
    if (!directory) return
    for await (const entry of directory) {
      cancelled(state.signal)
      if (entries >= LIMITS.packageEntries || state.usage.directoryEntries >= LIMITS.directoryEntries) {
        limited = true
        break
      }
      entries += 1
      state.usage.directoryEntries += 1
      if (OMIT.test(entry.name) || entry.isSymbolicLink()) continue
      const child = name + '/' + entry.name
      if (entry.isDirectory()) {
        if (depth < LIMITS.directoryDepth) await visit(child, depth + 1)
        else limited = true
      }
      else if (entry.isFile() && CODE.test(entry.name) && !DECLARATION.test(entry.name)) files.push(child)
    }
  }
  for (const directory of ['src', 'tests', 'test', '__tests__']) await visit(directory, 0)
  if (limited) missing(state, context, '.', 'source', 'directory-search-limit')
  const tests = files.filter((file) => TEST.test(file) || /(?:^|\/)(?:tests?|__tests__)\//u.test(file))
  const sources = files.filter((file) => !tests.includes(file))
  const priority = (file) => /\/index\.[cm]?[jt]sx?$/u.test(file) ? 0 : /\/types\.[cm]?[jt]s$/u.test(file) ? 1 : 2
  sources.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b, 'en'))
  tests.sort()
  return { sources: sources.slice(0, LIMITS.sourcesPerPackage), tests: tests.slice(0, LIMITS.testsPerPackage), limited }
}

function declarationPaths(manifest) {
  const paths = new Set()
  let nodes = 0
  function add(value) {
    if (typeof value === 'string' && value.length < 512 && DECLARATION.test(value) && !value.includes('*')) {
      paths.add(value.replace(/^\.\//u, ''))
    }
  }
  function visit(value, depth) {
    nodes += 1
    if (nodes > 128 || depth > 6) return
    if (typeof value === 'string') add(value)
    else if (value && typeof value === 'object') {
      for (const key of Object.keys(value).slice(0, 32)) visit(value[key], depth + 1)
    }
  }
  add(manifest.types)
  add(manifest.typings)
  visit(manifest.exports, 0)
  return [...paths].sort((a, b) => Number(a.includes('invariant')) - Number(b.includes('invariant')))
    .slice(0, LIMITS.declarationsPerPackage)
}

function safeDeclaration(name) {
  const clean = name.replace(/^\.\//u, '')
  return !isAbsolute(clean) && !clean.includes('\\') && !clean.includes('*')
    && clean.split('/').every((part) => part && !part.startsWith('.') && !/^(?:config|configs|credentials|secrets)$/iu.test(part))
}

async function inspectPackage(state, context, manifest) {
  // Prefer the canonical README but recognize npm's conventional variants.
  let readme = false
  for (const name of ['README.md', 'readme.md', 'README', 'README.txt']) {
    const checked = await checkedPath(context.root, name, state.signal)
    if (checked.reason === 'not-found') continue
    readme = await evidence(state, context, name, 'readme')
    break
  }
  if (!readme) missing(state, context, 'README.md', 'readme', 'readme-unavailable')
  if (context.origin === 'installed') {
    const declarations = declarationPaths(manifest)
    if (!declarations.length) missing(state, context, 'package.json', 'declaration', 'no-declared-types')
    for (const name of declarations) {
      if (!safeDeclaration(name)) missing(state, context, 'package.json', 'declaration', 'unsafe-declaration-path')
      else await evidence(state, context, name, 'declaration')
    }
  }
  const code = await discoverCode(state, context)
  for (const name of code.sources) await evidence(state, context, name, 'source')
  for (const name of code.tests) await evidence(state, context, name, 'test')
  if (!code.sources.length) missing(state, context, 'src', 'source', code.limited ? 'search-incomplete' : 'no-source-found-in-owner')
  if (!code.tests.length) missing(state, context, 'tests', 'test', code.limited ? 'search-incomplete' : 'no-tests-found-in-owner')
}

// Read only Git identity files; do not run Git, hooks, filters, or project code.
// Linked worktrees necessarily put their Git metadata outside the checkout.
async function checkoutCommit(state, root) {
  const dotGit = await checkedPath(root, '.git', state.signal)
  let gitRoot
  if (dotGit.info?.isDirectory()) gitRoot = dotGit.path
  else if (dotGit.info?.isFile()) {
    const pointer = await readText(state, root, '.git', 4096)
    const match = pointer.text?.trim().match(/^gitdir: ([^\r\n\0]+)$/u)
    if (match) gitRoot = await realpath(resolve(root, match[1])).catch(() => null)
  }
  if (!gitRoot) return { commit: null, reason: 'git-metadata-unavailable' }
  const head = await readText(state, gitRoot, 'HEAD', 4096)
  const text = head.text?.trim()
  if (/^(?:[a-f\d]{40}|[a-f\d]{64})$/iu.test(text ?? '')) return { commit: text.toLowerCase(), ref: null }
  const ref = text?.startsWith('ref: refs/') ? text.slice(5) : null
  if (!ref || ref.length > 256 || /[\x00-\x20\x7f~^:?*\[\\]/u.test(ref)
      || ref.includes('..') || ref.includes('@{')
      || ref.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    return { commit: null, reason: 'git-head-unavailable' }
  }
  const common = await readText(state, gitRoot, 'commondir', 4096)
  let commonRoot = gitRoot
  if (common.text && !/[\r\n\0]/u.test(common.text.trim())) {
    commonRoot = await realpath(resolve(gitRoot, common.text.trim())).catch(() => gitRoot)
  }
  for (const directory of [...new Set([gitRoot, commonRoot])]) {
    const loose = await readText(state, directory, ref, 4096)
    if (/^(?:[a-f\d]{40}|[a-f\d]{64})$/iu.test(loose.text?.trim() ?? '')) return { commit: loose.text.trim().toLowerCase(), ref }
    const packed = await readText(state, directory, 'packed-refs', LIMITS.fileBytes)
    for (const line of packed.text?.split('\n') ?? []) {
      const parts = line.split(' ')
      if (parts[1] === ref && /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu.test(parts[0])) return { commit: parts[0].toLowerCase(), ref }
    }
  }
  return { commit: null, ref, reason: 'git-ref-unavailable' }
}

/**
 * Inspect local DSH knowledge without executing the target or using the network.
 * Omitted topic selects tool authoring to keep the first lookup focused.
 * `packageName` selects one exact @deepseek-ai package instead of the topic's
 * owners, and seeds its installed peer closure. Topic still selects documentation
 * and excerpt hints. Installed repository.directory locates custom source owners;
 * without it, only known owner mappings are used, never a checkout-wide search.
 * `ok: true` means metadata/evidence retrieval completed, including explicit
 * omissions and version mismatches; it does not assert compatibility or complete
 * source coverage. Invalid targets and cancellation throw instead of returning.
 * An upstream-only request does not discover
 * an unrelated DSH on PATH; provide both paths to compare targets explicitly.
 * `commit` identifies HEAD, not a clean snapshot: evidence hashes identify the
 * working files actually read. Missing records describe this bounded search,
 * never the absence of an API or proof of runtime compatibility.
 */
export async function inspectDshKnowledge({ dshPath, upstreamRoot, topic, packageName, signal } = {}) {
  cancelled(signal)
  if (topic !== undefined && !KNOWLEDGE_TOPICS.includes(topic)) {
    throw new DshDeveloperError('KNOWLEDGE_TOPIC_INVALID', 'Choose a DSH knowledge topic: ' + KNOWLEDGE_TOPICS.join(', ') + '.')
  }
  if (packageName !== undefined && (typeof packageName !== 'string' || !PACKAGE_NAME.test(packageName))) {
    throw new DshDeveloperError('KNOWLEDGE_PACKAGE_INVALID', 'packageName must be one exact @deepseek-ai/name package, without a version or subpath.')
  }
  for (const [name, value] of Object.entries({ dshPath, upstreamRoot })) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0'))) {
      throw new DshDeveloperError('KNOWLEDGE_PATH_INVALID', name + ' must be a nonempty local path.')
    }
  }
  const topics = [topic ?? 'tool']
  const report = {
    kind: 'dsh-knowledge', ok: true, schemaVersion: 1, topics, packageName: packageName ?? null,
    installed: null, upstream: null, development: null, versionMismatch: null, packageVersionMismatches: [],
    evidence: [], missing: [], warnings: [], limits: { ...LIMITS }, usage: { readBytes: 0, directoryEntries: 0 },
  }
  const state = { report, signal, seen: new Map(), usage: report.usage }
  if (topic === undefined) report.warnings.push('Default topic: tool. Available topics: ' + KNOWLEDGE_TOPICS.join(', ') + '.')
  const owners = packageName === undefined
    ? [...new Set(topics.flatMap(selected => ROUTES[selected].owners))].map(owner => ({
        name: OWNERS[owner][0], directory: OWNERS[owner][1],
        topics: topics.filter(selected => ROUTES[selected].owners.includes(owner)),
      }))
    : [{ name: packageName, directory: Object.values(OWNERS).find(([name]) => name === packageName)?.[1], topics }]
  const installedPackages = new Map()
  if (dshPath !== undefined || upstreamRoot === undefined) {
    const invocation = await resolveDshInvocation(dshPath)
    cancelled(signal)
    const dsh = await locateDshPackage(invocation)
    cancelled(signal)
    if (!dsh) throw new DshDeveloperError('DSH_PACKAGE_NOT_FOUND', 'The selected entry has no inspectable @deepseek-ai/dsh package.')
    installedPackages.set('@deepseek-ai/dsh', dsh)
    const consumerPackages = new Map([[dsh.manifestPath, installedPackages]])
    const physicalPackages = new Map([[dsh.root, dsh]])
    const resolvePackage = async (name, consumer = dsh, allowNew = true) => {
      cancelled(signal)
      let cache = consumerPackages.get(consumer.manifestPath)
      if (!cache) consumerPackages.set(consumer.manifestPath, cache = new Map())
      if (!cache.has(name)) {
        const pkg = await locateKnowledgePackage(state, consumer, name, physicalPackages, allowNew)
        // A traversal limit must not poison later topic evidence lookups.
        if (allowNew || pkg) cache.set(name, pkg)
      }
      cancelled(signal)
      return cache.get(name)
    }
    report.development = await developmentPeers(resolvePackage, owners[0].name, signal)
    report.installed = { root: dsh.root, entry: invocation.prefixArgs[0] ?? invocation.command,
      manifestPath: dsh.manifestPath, version: smallString(dsh.value.version), packages: [] }
    for (const name of new Set(['@deepseek-ai/dsh', ...owners.map(owner => owner.name)])) {
      cancelled(signal)
      const pkg = await resolvePackage(name)
      cancelled(signal)
      const selected = owners.find(owner => owner.name === name)?.topics ?? []
      const context = { origin: 'installed', root: dsh.root, packageName: name, topics: selected }
      if (!pkg) {
        missing(state, context, 'package.json', 'package', 'package-not-installed')
        continue
      }
      const identity = { name, version: smallString(pkg.value.version), root: pkg.root, manifestPath: pkg.manifestPath,
        repositoryDirectory: smallString(pkg.value.repository?.directory) }
      report.installed.packages.push(identity)
      if (selected.length) await inspectPackage(state, { ...context, root: pkg.root, packageVersion: identity.version }, pkg.value)
    }
    if (packageName !== undefined) {
      const directory = installedPackages.get(packageName)?.value.repository?.directory
      if (directory !== undefined) {
        owners[0].directory = safeRepositoryDirectory(directory) ? directory : undefined
        if (owners[0].directory === undefined) owners[0].missingReason = 'unsafe-repository-directory'
      }
    }
    report.warnings.push('Installed evidence describes package files only; upstream documentation is not bundled or fetched. Missing source and tests are reported per owner.')
  }
  if (upstreamRoot !== undefined) {
    const root = await realpath(resolve(upstreamRoot)).catch(() => null)
    if (!root) throw new DshDeveloperError('KNOWLEDGE_UPSTREAM_INVALID', 'The selected upstream root is unavailable.')
    const manifest = await readManifest(state, root)
    if (!manifest.value || manifest.value.name !== '@deepseek-ai/dsh-root' || !smallString(manifest.value.version)) {
      throw new DshDeveloperError('KNOWLEDGE_UPSTREAM_INVALID', 'Expected an upstream @deepseek-ai/dsh-root package manifest.', { reason: manifest.reason ?? 'package-identity' })
    }
    report.upstream = { root, version: manifest.value.version, manifestPath: manifest.path,
      manifestSha256: manifest.sha256, ...await checkoutCommit(state, root), workingTree: 'not-verified-clean', packages: [] }
    for (const selected of topics) {
      for (const doc of ROUTES[selected].docs) await evidence(state, { origin: 'upstream', root, topics: [selected] }, doc, 'documentation')
    }
    for (const owner of owners) {
      const { name, directory } = owner
      const context = { origin: 'upstream', root, packageName: name, topics: owner.topics }
      if (directory === undefined) {
        missing(state, context, 'package.json', 'package', owner.missingReason ?? 'source-owner-unavailable')
        continue
      }
      const pkg = await readManifest(state, root, directory + '/package.json')
      if (!pkg.value || pkg.value.name !== name) {
        missing(state, context, directory + '/package.json', 'package', pkg.reason ?? 'package-name-mismatch')
        continue
      }
      const packageRoot = dirname(pkg.path)
      const version = smallString(pkg.value.version)
      report.upstream.packages.push({ name, version, root: packageRoot, manifestPath: pkg.path, manifestSha256: pkg.sha256 })
      await inspectPackage(state, { ...context, root: packageRoot, packageVersion: version }, pkg.value)
    }
    report.warnings.push('Checkout excerpts are current working files. HEAD is recorded without executing Git; cleanliness and correspondence to the commit are not verified. Each evidence file has a SHA-256 digest.')
    if (!report.upstream.commit) report.warnings.push('The exact checkout commit is unavailable: ' + report.upstream.reason + '.')
  }
  if (report.installed && report.upstream) {
    report.versionMismatch = report.installed.version === null ? null : report.installed.version !== report.upstream.version
    if (report.versionMismatch) report.warnings.push('Version mismatch: installed DSH ' + report.installed.version + ' differs from checkout ' + report.upstream.version + '. Checkout evidence does not describe the installed version.')
    else if (report.versionMismatch === false) report.warnings.push('Equal package versions do not prove identical source or runtime compatibility.')
    for (const pkg of report.upstream.packages) {
      const installed = report.installed.packages.find((item) => item.name === pkg.name)
      if (installed?.version && pkg.version && installed.version !== pkg.version) {
        report.packageVersionMismatches.push({ name: pkg.name, installedVersion: installed.version, upstreamVersion: pkg.version })
      }
    }
  }
  if (!report.installed?.version && report.installed) report.warnings.push('The installed DSH package does not declare an exact version.')
  report.warnings.push('Curated paths are navigation hints. Missing files may reflect packaging, version changes, or inspection limits; no current-master fallback is used.')
  if (report.missing.some((item) => item.reason.includes('limit'))) report.warnings.push('An inspection limit was reached. Select one topic for a narrower lookup; omissions are listed below.')
  cancelled(signal)
  return report
}

export function formatDshKnowledgeReport(report) {
  const lines = ['DSH knowledge: ' + report.topics.join(', ')]
  if (report.packageName) lines.push('Selected package: ' + report.packageName)
  if (report.installed) lines.push('Installed: ' + (report.installed.version ?? 'version unavailable') + ' — ' + report.installed.root)
  if (report.upstream) lines.push('Checkout: ' + report.upstream.version + ' @ ' + (report.upstream.commit ?? 'commit unavailable') + ' — ' + report.upstream.root)
  if (report.development) {
    lines.push('Development dependencies (' + (report.development.complete ? 'complete DSH peer closure' : 'incomplete; inspect missing peers') + '):',
      JSON.stringify(report.development.dependencies, null, 2), report.development.scope)
    for (const item of report.development.missing) lines.push('Unresolved peer: ' + item.name + ' — ' + item.reason)
  }
  for (const warning of report.warnings) lines.push('Note: ' + warning)
  for (const mismatch of report.packageVersionMismatches) {
    lines.push('Package version mismatch: ' + mismatch.name + ' installed ' + mismatch.installedVersion + ', checkout ' + mismatch.upstreamVersion)
  }
  for (const item of report.evidence) {
    lines.push('', '[' + item.origin + ' / ' + item.kind + '] ' + item.path + ':' + item.startLine + '-' + item.endLine
      + (item.packageName ? ' (' + item.packageName + '@' + (item.packageVersion ?? 'unknown') + ')' : ''),
    'SHA-256: ' + item.sha256 + (item.truncated ? ' (excerpt)' : ' (complete file)'), item.excerpt)
  }
  if (report.missing.length) lines.push('', 'Unavailable in this bounded lookup:')
  for (const item of report.missing) lines.push('- [' + item.origin + ' / ' + item.kind + '] ' + (item.packageName ? item.packageName + ': ' : '') + item.path + ' — ' + item.reason)
  return lines.join('\n')
}
