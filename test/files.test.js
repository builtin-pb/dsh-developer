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
