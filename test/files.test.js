import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshDeveloperError } from '../lib/errors.js'
import { assertPortableRelativePath, mapTreeEntries, scanOrdinaryTree, writeFilesExclusive } from '../lib/files.js'
import { LIMITS } from '../lib/constants.js'
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
