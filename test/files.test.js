import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshDeveloperError } from '../lib/errors.js'
import { assertPortableRelativePath, scanOrdinaryTree } from '../lib/files.js'

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
