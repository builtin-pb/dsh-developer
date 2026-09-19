import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { DshDeveloperError } from '../lib/errors.js'
import { assertPortableRelativePath, mapTreeEntries, scanOrdinaryTree, scanSourceAuditTree, writeFilesExclusive } from '../lib/files.js'
import { LIMITS } from '../lib/constants.js'
import { TEXT_TAR_MAX_BYTES, encodeTextTree } from '../lib/lab/text-tar.js'
import { PNG } from './fixtures/asset-bytes.js'

test('rejects traversal, absolute, reserved, and nonportable generated paths', () => {
  for (const path of ['../escape', '/absolute', 'C:/absolute', 'CON', 'folder/trailing.', 'a\\b']) {
    assert.throws(
      () => assertPortableRelativePath(path),
      (error) => error instanceof DshDeveloperError && error.code === 'UNSAFE_PATH',
      path,
    )
  }
  assert.equal(assertPortableRelativePath('skills/good-name/SKILL.md'), 'skills/good-name/SKILL.md')
})

test('rejects dependency trees and credential-bearing config paths', async () => {
  for (const forbidden of ['node_modules', '.dsh']) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-developer-tree-'))
    try {
      await mkdir(join(root, forbidden))
      await writeFile(join(root, forbidden, 'file.txt'), 'ordinary text\n', 'utf8')
      await assert.rejects(scanOrdinaryTree(root), /must not be part of the snapshot/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-config-'))
  try {
    await writeFile(join(root, '.env.local'), 'ordinary-looking config\n', 'utf8')
    await assert.rejects(scanOrdinaryTree(root), /Credential-bearing config file/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('read-only analysis excludes installed dependencies without weakening strict transfer scans', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-analysis-tree-'))
  try {
    await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n', 'utf8')
    await mkdir(join(root, 'node_modules', 'fixture'), { recursive: true })
    const dependency = join(root, 'node_modules', 'fixture', 'index.js')
    await writeFile(dependency, 'export const value = 1\n', 'utf8')

    await assert.rejects(scanOrdinaryTree(root), /must not be part of the snapshot/u)
    const first = await scanOrdinaryTree(root, { excludeDependencies: true })
    assert.deepEqual(first.excludedDirectories, ['node_modules'])
    assert.deepEqual(first.entries.map((value) => value.path), ['package.json'])

    await writeFile(dependency, 'export const value = 2\n', 'utf8')
    const second = await scanOrdinaryTree(root, { excludeDependencies: true })
    assert.equal(second.fingerprint, first.fingerprint)

    await mkdir(join(root, '.dsh'))
    await assert.rejects(
      scanOrdinaryTree(root, { excludeDependencies: true }),
      /must not be part of the snapshot/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('audit snapshots account for asset bytes and changes while strict transfers remain text-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-assets-'))
  try {
    await writeFile(join(root, 'logo.png'), PNG)
    const first = await scanOrdinaryTree(root, { allowBinaryAssets: true })
    assert.equal(first.fileCount, 1)
    assert.equal(first.bytes, PNG.length)
    assert.equal(first.entries[0].mediaType, 'image/png')
    assert.equal(Object.hasOwn(first.entries[0], 'content'), false)
    assert.deepEqual(first, JSON.parse(JSON.stringify(first)))
    const files = mapTreeEntries(first)
    assert.equal(files.has('logo.png'), true)
    assert.equal(files.get('logo.png'), undefined)
    await assert.rejects(scanOrdinaryTree(root), { code: 'BINARY_FILE' })
    await assert.rejects(writeFilesExclusive(join(root, 'output'), files), { code: 'INVALID_GENERATED_FILE' })

    const changed = Buffer.from(PNG)
    changed[45] ^= 1
    await writeFile(join(root, 'logo.png'), changed)
    const second = await scanOrdinaryTree(root, { allowBinaryAssets: true })
    assert.notEqual(second.fingerprint, first.fingerprint)
    assert.notEqual(second.entries[0].digest, first.entries[0].digest)
    assert.equal(second.bytes, first.bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('asset acceptance still rejects binary source, mismatched headers, credentials and size violations', async () => {
  const cases = [
    ['index.js', PNG, 'BINARY_FILE'],
    ['asset.bin', PNG, 'BINARY_FILE'],
    ['fake.png', Buffer.from([0, 1, 2, 3]), 'BINARY_FILE'],
    ['large.png', Buffer.concat([PNG, Buffer.alloc(LIMITS.fileBytes)]), 'FILE_TOO_LARGE'],
    ['secret.png', Buffer.concat([PNG, Buffer.from('-----BEGIN ' + 'PRIVATE KEY-----')]), 'SECRET_DETECTED'],
  ]
  for (const [name, bytes, code] of cases) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-developer-invalid-asset-'))
    try {
      await writeFile(join(root, name), bytes)
      await assert.rejects(scanOrdinaryTree(root, { allowBinaryAssets: true }), { code })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('recognized image and font headers remain opaque and are bound to matching extensions', async () => {
  const headers = [
    ['jpg', 'ffd8ff', 'image/jpeg'], ['jpeg', 'ffd8ff', 'image/jpeg'],
    ['gif', '474946383961', 'image/gif'], ['webp', '524946460000000057454250', 'image/webp'],
    ['ico', '00000100', 'image/x-icon'], ['woff', '774f4646', 'font/woff'],
    ['woff2', '774f4632', 'font/woff2'], ['ttf', '00010000', 'font/ttf'], ['otf', '4f54544f', 'font/otf'],
  ]
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-asset-types-'))
  try {
    for (const [extension, header] of headers) {
      await writeFile(join(root, 'asset.' + extension), Buffer.concat([Buffer.from(header, 'hex'), Buffer.alloc(16)]))
    }
    const tree = await scanOrdinaryTree(root, { allowBinaryAssets: true })
    assert.equal(tree.fileCount, headers.length)
    for (const [extension, , mediaType] of headers) {
      assert.equal(tree.entries.find((entry) => entry.path === 'asset.' + extension).mediaType, mediaType)
    }
    await writeFile(join(root, 'mismatch.jpg'), PNG)
    await assert.rejects(scanOrdinaryTree(root, { allowBinaryAssets: true }), { code: 'BINARY_FILE' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the shipped PNG is accepted without treating compressed pixels as a text credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-logo-'))
  try {
    const logo = await readFile(new URL('../docs/assets/logo.png', import.meta.url))
    await writeFile(join(root, 'logo.png'), logo)
    const tree = await scanOrdinaryTree(root, { allowBinaryAssets: true })
    assert.equal(tree.entries[0].mediaType, 'image/png')
    assert.equal(tree.bytes, logo.length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const execute = promisify(execFile)
const STRICT_BUDGET = Object.freeze({
  id: 'ordinary-source', treeBytes: 4_194_304, fileBytes: 524_288,
  fileCount: 256, treeEntries: 1024, pathBytes: 240,
})
const SELF_BUDGET = Object.freeze({
  id: 'product-self', treeBytes: 16_777_216, fileBytes: 1_048_576,
  fileCount: 1024, treeEntries: 4096, pathBytes: 240,
})

async function temporaryDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-source-audit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

// Load the real scanner from a separate installation. No production test hook
// or caller-provided trusted root is needed to exercise product identity.
async function productFixture(t) {
  const parent = await temporaryDirectory(t)
  const root = join(parent, 'product')
  await mkdir(join(root, 'lib'), { recursive: true })
  for (const name of ['files.js', 'constants.js', 'errors.js', 'security.js', 'exclusive-rename.js']) {
    await copyFile(new URL('../lib/' + name, import.meta.url), join(root, 'lib', name))
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'identity-is-not-a-package-name', version: '1.0.0', type: 'module',
  }))
  const moduleUrl = pathToFileURL(join(root, 'lib', 'files.js')).href
  const scanner = await import(moduleUrl)
  return { parent, root, moduleUrl, ...scanner }
}

async function emptyFiles(root, count, prefix = 'file-') {
  for (let offset = 0; offset < count; offset += 32) {
    await Promise.all(Array.from({ length: Math.min(32, count - offset) }, (_, index) =>
      writeFile(join(root, prefix + String(offset + index).padStart(4, '0')), '')))
  }
}

async function emptyDirectories(root, count) {
  for (let offset = 0; offset < count; offset += 32) {
    await Promise.all(Array.from({ length: Math.min(32, count - offset) }, (_, index) =>
      mkdir(join(root, 'directory-' + String(offset + index).padStart(4, '0')))))
  }
}

async function paddedFiles(root, bytes, fileBytes) {
  for (let index = 0; bytes > 0; index += 1) {
    const size = Math.min(bytes, fileBytes)
    await writeFile(join(root, 'padding-' + String(index).padStart(4, '0')), Buffer.alloc(size, 0x20))
    bytes -= size
  }
}

async function scannerChild(fixture, body, args = {}) {
  const result = await execute(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    import { join } from 'node:path'
    const { root, moduleUrl, ...args } = JSON.parse(process.argv[1])
    const { scanSourceAuditTree, scanOrdinaryTree } = await import(moduleUrl)
    ${body}
  `, JSON.stringify({ root: await realpath(fixture.root), moduleUrl: fixture.moduleUrl, ...args })], {
    timeout: 30_000, maxBuffer: 64 * 1024,
  })
  return result.stdout.trim()
}

test('strict numerical source, Creator and transport ceilings cannot drift with the self budget', () => {
  assert.equal(LIMITS.creatorBytes, 262_144)
  assert.equal(LIMITS.treeBytes, 4_194_304)
  assert.equal(LIMITS.fileBytes, 524_288)
  assert.equal(LIMITS.fileCount, 256)
  assert.equal(LIMITS.treeEntries, 1024)
  assert.equal(LIMITS.pathBytes, 240)
  assert.equal(TEXT_TAR_MAX_BYTES, 4_859_904)
  assert.throws(() => encodeTextTree([{ path: 'large.txt', content: ' '.repeat(524_289) }]), { code: 'FILE_TOO_LARGE' })
  assert.throws(() => encodeTextTree(Array.from({ length: 257 }, (_, index) => ({ path: 'file-' + index, content: '' }))), { code: 'TOO_MANY_FILES' })
  assert.throws(() => encodeTextTree([
    ...Array.from({ length: 8 }, (_, index) => ({ path: 'file-' + index, content: ' '.repeat(524_288) })),
    { path: 'extra', content: ' ' },
  ]), { code: 'TREE_TOO_LARGE' })
})

for (const kind of ['fileBytes', 'treeBytes', 'fileCount', 'treeEntries']) {
  test('strict and external audit scans enforce the exact ' + kind + ' boundary', async (t) => {
    const root = await temporaryDirectory(t)
    if (kind === 'fileBytes') await writeFile(join(root, 'data'), Buffer.alloc(524_288, 0x20))
    if (kind === 'treeBytes') await paddedFiles(root, 4_194_304, 524_288)
    if (kind === 'fileCount') await emptyFiles(root, 256)
    if (kind === 'treeEntries') await emptyDirectories(root, 1024)
    const strict = await scanOrdinaryTree(root)
    const audited = await scanSourceAuditTree(root)
    assert.deepEqual(audited.budget, STRICT_BUDGET)
    assert.equal(strict.fingerprint, audited.fingerprint)
    if (kind === 'fileBytes') await writeFile(join(root, 'data'), Buffer.alloc(524_289, 0x20))
    else if (kind === 'treeEntries') await mkdir(join(root, 'one-more'))
    else await writeFile(join(root, 'one-more'), ' ')
    const code = { fileBytes: 'FILE_TOO_LARGE', treeBytes: 'TREE_TOO_LARGE', fileCount: 'TOO_MANY_FILES', treeEntries: 'TOO_MANY_ENTRIES' }[kind]
    // Forged profiles/options cannot enlarge either entry point's limits.
    const overrides = { limits: SELF_BUDGET, budget: SELF_BUDGET, profile: 'product-self', trustedRoot: root, treeBytes: Infinity }
    await assert.rejects(scanOrdinaryTree(root, overrides), { code })
    await assert.rejects(scanSourceAuditTree(root, overrides), { code })
  })
}

test('self identity comes from the running module, not package claims, copies or descendants', async (t) => {
  const fixture = await productFixture(t)
  const own = await fixture.scanSourceAuditTree(fixture.root)
  assert.deepEqual(own.budget, SELF_BUDGET)
  assert.ok(Object.isFrozen(own.budget))
  assert.throws(() => { own.budget.treeBytes = Infinity }, TypeError)
  const external = await scanSourceAuditTree(fixture.root)
  assert.deepEqual(external.budget, STRICT_BUDGET)
  assert.equal(external.fingerprint, own.fingerprint, 'budget identity is outside the byte fingerprint')
  await writeFile(join(fixture.root, 'large-lock.yaml'), Buffer.alloc(524_289, 0x20))
  await assert.rejects(scanSourceAuditTree(fixture.root), { code: 'FILE_TOO_LARGE' })
  await assert.rejects(fixture.scanOrdinaryTree(fixture.root), { code: 'FILE_TOO_LARGE' })
  assert.deepEqual((await fixture.scanSourceAuditTree(fixture.root)).budget, SELF_BUDGET)
  const descendant = join(fixture.root, 'descendant')
  await mkdir(descendant)
  await writeFile(join(descendant, 'package.json'), '{"name":"dsh-developer","type":"module"}')
  await writeFile(join(descendant, 'large-lock.yaml'), Buffer.alloc(524_289, 0x20))
  await assert.rejects(fixture.scanSourceAuditTree(descendant), { code: 'FILE_TOO_LARGE' })
  const sibling = join(fixture.parent, 'product-copy')
  await mkdir(sibling)
  await writeFile(join(sibling, 'package.json'), '{"name":"dsh-developer","type":"module"}')
  await writeFile(join(sibling, 'large-lock.yaml'), Buffer.alloc(524_289, 0x20))
  await assert.rejects(fixture.scanSourceAuditTree(sibling), { code: 'FILE_TOO_LARGE' })
})

for (const kind of ['fileBytes', 'fileCount', 'treeEntries']) {
  test('self audits enforce the exact larger ' + kind + ' boundary', async (t) => {
    const fixture = await productFixture(t)
    const initial = await fixture.scanSourceAuditTree(fixture.root)
    if (kind === 'fileBytes') await writeFile(join(fixture.root, 'data'), Buffer.alloc(1_048_576, 0x20))
    if (kind === 'fileCount') await emptyFiles(fixture.root, 1024 - initial.fileCount)
    if (kind === 'treeEntries') await emptyDirectories(fixture.root, 4096 - initial.treeEntries)
    const tree = await fixture.scanSourceAuditTree(fixture.root)
    assert.deepEqual(tree.budget, SELF_BUDGET)
    if (kind === 'fileCount') assert.equal(tree.fileCount, 1024)
    if (kind === 'treeEntries') assert.equal(tree.treeEntries, 4096)
    if (kind === 'fileBytes') await writeFile(join(fixture.root, 'data'), Buffer.alloc(1_048_577, 0x20))
    else if (kind === 'treeEntries') await mkdir(join(fixture.root, 'one-more'))
    else await writeFile(join(fixture.root, 'one-more'), '')
    const code = { fileBytes: 'FILE_TOO_LARGE', fileCount: 'TOO_MANY_FILES', treeEntries: 'TOO_MANY_ENTRIES' }[kind]
    await assert.rejects(fixture.scanSourceAuditTree(fixture.root), { code })
  })
}

test('a complete 16 MiB self audit remains bounded and rejects the next byte', async (t) => {
  const fixture = await productFixture(t)
  const initial = await fixture.scanSourceAuditTree(fixture.root)
  await paddedFiles(fixture.root, 16_777_216 - initial.bytes, 1_048_576)
  const cost = await scannerChild(fixture, `
    const start = performance.now()
    const tree = await scanSourceAuditTree(root)
    assert.equal(tree.bytes, 16_777_216)
    assert.equal(tree.budget.id, 'product-self')
    console.log(JSON.stringify({ bytes: tree.bytes, files: tree.fileCount,
      elapsedMs: Math.round(performance.now() - start), maxRssKiB: process.resourceUsage().maxRSS }))
  `)
  t.diagnostic('One full near-cap scan (both passes, isolated process): ' + cost)
  await writeFile(join(fixture.root, 'one-more'), ' ')
  await assert.rejects(fixture.scanSourceAuditTree(fixture.root), { code: 'TREE_TOO_LARGE' })
})

test('self audits scan late credentials beyond every former source boundary', async (t) => {
  const fixture = await productFixture(t)
  await paddedFiles(fixture.root, 4_194_305, 524_288)
  await emptyFiles(fixture.root, 257)
  const lockDirectory = join(fixture.root, '.github', 'dsh-runtimes', 'fixture')
  await mkdir(lockDirectory, { recursive: true })
  const lock = join(lockDirectory, 'pnpm-lock.yaml')
  const integrity = 'integrity: sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA==\n'
  await writeFile(lock, ' '.repeat(524_289) + integrity)
  const before = await fixture.scanSourceAuditTree(fixture.root)
  assert.ok(before.bytes > 4_194_304)
  assert.ok(before.fileCount > 256)
  await writeFile(lock, ' '.repeat(524_289) + integrity.replace('Y7/', 'Y8/'))
  const after = await fixture.scanSourceAuditTree(fixture.root)
  assert.notEqual(before.fingerprint, after.fingerprint, 'CI locks stay in the fingerprint')
  const secret = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
  await writeFile(lock, ' '.repeat(524_289) + secret)
  await assert.rejects(fixture.scanSourceAuditTree(fixture.root), (error) =>
    error.code === 'SECRET_DETECTED' && error.details.label === '.github/dsh-runtimes/fixture/pnpm-lock.yaml')
  await writeFile(lock, integrity)
  await writeFile(join(fixture.root, 'zzzz-late-secret.txt'), secret)
  await assert.rejects(fixture.scanSourceAuditTree(fixture.root), (error) =>
    error.code === 'SECRET_DETECTED' && error.details.label === 'zzzz-late-secret.txt')
})

test('self budgets retain forbidden paths, binary checks, asset credentials and portable path limits', async (t) => {
  const fixture = await productFixture(t)
  for (const name of ['.env.local', '.npmrc', 'credentials.json']) {
    await writeFile(join(fixture.root, name), 'ordinary text')
    await assert.rejects(fixture.scanSourceAuditTree(fixture.root), { code: 'FORBIDDEN_CONFIG' })
    await rm(join(fixture.root, name))
  }
  for (const name of ['vendor', '.aws', '.dsh']) {
    await mkdir(join(fixture.root, name))
    await assert.rejects(fixture.scanSourceAuditTree(fixture.root), { code: 'FORBIDDEN_TREE' })
    await rm(join(fixture.root, name), { recursive: true })
  }
  await mkdir(join(fixture.root, 'node_modules'))
  await writeFile(join(fixture.root, 'node_modules', '.env'), 'excluded dependency')
  assert.deepEqual((await fixture.scanSourceAuditTree(fixture.root)).excludedDirectories, ['node_modules'])
  await writeFile(join(fixture.root, 'binary.js'), PNG)
  await assert.rejects(fixture.scanSourceAuditTree(fixture.root), { code: 'BINARY_FILE' })
  await rm(join(fixture.root, 'binary.js'))
  await writeFile(join(fixture.root, 'logo.png'), PNG)
  assert.equal((await fixture.scanSourceAuditTree(fixture.root)).entries.find((value) => value.path === 'logo.png').mediaType, 'image/png')
  await writeFile(join(fixture.root, 'logo.png'), Buffer.concat([PNG, Buffer.alloc(524_288), Buffer.from(['-----BEGIN', 'PRIVATE KEY-----'].join(' '))]))
  await assert.rejects(fixture.scanSourceAuditTree(fixture.root), { code: 'SECRET_DETECTED' })
  await rm(join(fixture.root, 'logo.png'))
  await mkdir(join(fixture.root, 'paths'))
  await writeFile(join(fixture.root, 'paths', 'a'.repeat(234)), '')
  await fixture.scanSourceAuditTree(fixture.root)
  await writeFile(join(fixture.root, 'paths', 'b'.repeat(235)), '')
  await assert.rejects(fixture.scanSourceAuditTree(fixture.root), { code: 'UNSAFE_PATH' })
})

test('direct root and nested links are rejected while ancestor aliases scan the canonical root', async (t) => {
  const fixture = await productFixture(t)
  const direct = join(fixture.parent, 'direct')
  await symlink(fixture.root, direct, 'junction')
  await assert.rejects(fixture.scanSourceAuditTree(direct), { code: 'UNSAFE_SOURCE' })
  const aliasParent = await temporaryDirectory(t)
  const alias = join(aliasParent, 'alias')
  await symlink(fixture.parent, alias, 'junction')
  const canonical = await fixture.scanSourceAuditTree(fixture.root)
  const aliased = await fixture.scanSourceAuditTree(join(alias, 'product'))
  assert.equal(aliased.root, await realpath(fixture.root))
  assert.equal(aliased.fingerprint, canonical.fingerprint)
  assert.deepEqual(aliased.budget, SELF_BUDGET)
  await symlink(aliasParent, join(fixture.root, 'nested'), 'junction')
  await assert.rejects(fixture.scanSourceAuditTree(fixture.root), { code: 'UNSAFE_LINK' })
})

test('Windows self selection never case-folds distinct canonical roots', async (t) => {
  const fixture = await productFixture(t)
  const external = await temporaryDirectory(t)
  // Model a case-sensitive directory independently of the test volume's case
  // policy. Only this child sees the virtual canonical spelling and platform.
  await scannerChild(fixture, `
    const virtualRoot = root.slice(0, -'product'.length) + 'Product'
    const lstat = fs.promises.lstat
    const realpath = fs.promises.realpath
    const readdir = fs.promises.readdir
    fs.promises.realpath = async (path, ...rest) => path === args.external ? virtualRoot : realpath(path, ...rest)
    fs.promises.lstat = async (path, ...rest) => lstat(path === virtualRoot ? args.external : path, ...rest)
    fs.promises.readdir = async (path, ...rest) => path === virtualRoot ? [] : readdir(path, ...rest)
    syncBuiltinESMExports()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const tree = await scanSourceAuditTree(args.external)
    assert.equal(tree.root, virtualRoot)
    assert.equal(tree.budget.id, 'ordinary-source')
    assert.equal(tree.budget.treeBytes, 4_194_304)
  `, { external })
})

test('retargeting an ancestor alias after selection cannot redirect either scan pass', async (t) => {
  const fixture = await productFixture(t)
  const aliasParent = await temporaryDirectory(t)
  const alias = join(aliasParent, 'alias')
  const other = await temporaryDirectory(t)
  await mkdir(join(other, 'product'))
  await writeFile(join(other, 'product', 'different.txt'), 'different tree')
  await symlink(fixture.parent, alias, 'junction')
  await scannerChild(fixture, `
    const expected = await scanSourceAuditTree(root)
    const readdir = fs.promises.readdir
    let redirected = false
    fs.promises.readdir = async (path, options) => {
      if (path === root && !redirected) {
        redirected = true
        await fs.promises.unlink(args.alias)
        await fs.promises.symlink(args.other, args.alias, 'junction')
      }
      return readdir(path, options)
    }
    syncBuiltinESMExports()
    const tree = await scanSourceAuditTree(join(args.alias, 'product'))
    assert.equal(redirected, true)
    assert.equal(tree.root, root)
    assert.equal(tree.fingerprint, expected.fingerprint)
    assert.equal(tree.budget.id, 'product-self')
  `, { alias, other })
})

test('self audit cancellation and two-pass mutation detection remain active', async (t) => {
  const fixture = await productFixture(t)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(fixture.scanSourceAuditTree(fixture.root, { signal: aborted.signal }), { code: 'CANCELLED' })
  await scannerChild(fixture, `
    await fs.promises.writeFile(join(root, 'changing.txt'), 'before')
    const readdir = fs.promises.readdir
    let passes = 0
    fs.promises.readdir = async (path, options) => {
      if (path === root && ++passes === 2) await fs.promises.writeFile(join(root, 'changing.txt'), 'after!')
      return readdir(path, options)
    }
    syncBuiltinESMExports()
    await assert.rejects(scanSourceAuditTree(root), { code: 'MUTABLE_TREE' })
    const controller = new AbortController()
    fs.promises.readdir = async (path, options) => {
      const result = await readdir(path, options)
      controller.abort()
      return result
    }
    syncBuiltinESMExports()
    await assert.rejects(scanSourceAuditTree(root, { signal: controller.signal }), { code: 'CANCELLED' })
  `)
})

test('fingerprints bind raw UTF-8 BOM and line-ending bytes independently of audit budgets', async (t) => {
  const root = await temporaryDirectory(t)
  const fingerprints = new Set()
  for (const bytes of [Buffer.from('text\n'), Buffer.from('text\r\n'), Buffer.from('\ufefftext\n')]) {
    await writeFile(join(root, 'data.txt'), bytes)
    const tree = await scanSourceAuditTree(root)
    const expected = createHash('sha256').update('data.txt\0').update(String(bytes.length)).update('\0').update(bytes).update('\0').digest('hex')
    assert.equal(tree.fingerprint, 'sha256:' + expected)
    assert.equal(tree.bytes, bytes.length)
    assert.equal(tree.fingerprint, (await scanOrdinaryTree(root)).fingerprint)
    fingerprints.add(tree.fingerprint)
  }
  assert.equal(fingerprints.size, 3)
})

test('Doctor records the audit budget in both gates and detects a changed CI file without execution', async (t) => {
  const { doctorPlugin } = await import('../lib/doctor.js')
  const root = await temporaryDirectory(t)
  for (const name of ['package.json', 'index.js', 'cordis.patch.yml', 'LICENSE']) {
    await copyFile(new URL('./fixtures/ordinary-dsh-plugin/' + name, import.meta.url), join(root, name))
  }
  await mkdir(join(root, '.github'))
  const lock = join(root, '.github', 'lock.yaml')
  await writeFile(lock, 'before\n')
  const report = await doctorPlugin(root, { runtime: 'skip' })
  assert.equal(report.ok, true)
  for (const id of ['source.ordinary-tree', 'verification.freshness']) {
    assert.deepEqual(report.checks.find((value) => value.id === id).evidence.budget, STRICT_BUDGET)
  }
  let executions = 0
  const changed = await doctorPlugin(root, {
    checkDshVersion: async () => {
      await writeFile(lock, 'after!\n')
      return { version: '0.1.5-rc.2', invocation: {} }
    },
    smokeDshInstall: async () => { executions += 1 },
    runGeneratedNodeTests: async () => { executions += 1 },
  })
  assert.equal(executions, 0)
  assert.equal(changed.ok, false)
  assert.equal(changed.checks.find((value) => value.id === 'verification.freshness').evidence.code, 'STALE_VERIFICATION')
})

for (const caller of ['profile-preflight', 'upstream-impact', 'source-migration', 'compatibility']) {
  test(caller + ' retains self-audit capacity and mutation detection through its final scan', async (t) => {
    const fixture = await productFixture(t)
    await writeFile(join(fixture.root, 'package.json'), JSON.stringify({
      name: 'audit-fixture', version: '1.0.0', type: 'module', main: './index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(join(fixture.root, 'index.js'), 'export function apply() {}\n')
    await writeFile(join(fixture.root, 'cordis.patch.yml'), '- insert: []\n')
    await mkdir(join(fixture.root, '.github'))
    const lock = join(fixture.root, '.github', 'lock.yaml')
    const controller = new AbortController()
    const module = await import('../lib/' + caller + '-internal.js')
    const inspect = module[{
      'profile-preflight': 'inspectProfilePreflightInternal',
      'upstream-impact': 'inspectUpstreamImpactInternal',
      'source-migration': 'inspectSourceMigrationInternal',
      compatibility: 'inspectCompatibilityMatrixInternal',
    }[caller]]
    for (const mutate of [false, true]) {
      await writeFile(lock, ' '.repeat(524_289))
      let scans = 0
      let executions = 0
      const scan = async (source, options) => {
        assert.deepEqual(Object.keys(options), ['signal'])
        assert.equal(options.signal, controller.signal)
        const tree = await fixture.scanSourceAuditTree(source, options)
        assert.deepEqual(tree.budget, SELF_BUDGET)
        scans += 1
        if (mutate && scans === 1) await writeFile(lock, ' '.repeat(524_290))
        return tree
      }
      const report = await inspect(fixture.root, {
        profile: 'headless', releaseDsh: 'release-fixture', previewDsh: 'preview-fixture', signal: controller.signal,
      }, {
        scanSourceAuditTree: scan,
        resolveDshInvocation: async () => { throw new Error('No runtime is used by this source-audit test.') },
        smokeDshInstall: async () => { executions += 1 },
        doctorPlugin: async (source, options) => {
          const tree = await scan(source, { signal: options.signal })
          return { ok: true, fingerprint: tree.fingerprint, plugin: { name: 'audit-fixture', packageName: 'audit-fixture' }, checks: [] }
        },
      })
      assert.equal(scans, 2, 'initial and final gates must use the same audit entry point')
      assert.equal(executions, 0)
      const freshness = report.checks.find((value) => value.id === 'source.freshness')
      assert.equal(freshness.status, mutate ? 'FAIL' : 'PASS')
      if (!mutate) assert.deepEqual(freshness.evidence.budget, SELF_BUDGET)
      if (caller === 'compatibility') {
        assert.deepEqual(report.execution, { eligible: false, basis: 'untrusted-repository' }, 'a larger scan budget never grants execution authority')
      } else {
        assert.deepEqual(report.checks.find((value) => value.id === 'source.snapshot').evidence.budget, SELF_BUDGET)
      }
    }
  })
}
