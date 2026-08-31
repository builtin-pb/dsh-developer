import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skillRoot = path.join(repositoryRoot, 'skills', 'dsh-developer')
// The user authorized 500-character hourly lifts while this long-running evolution task is active.
const ACTIVE_SET_CHARACTER_LIMIT = 13_500

test('keeps the longest routed skill instruction set within the repository budget', async () => {
  const route = [
    'SKILL.md',
    'references/core-incubation.md',
    'references/execution-lab.md',
    'references/isolated-cell.md',
  ]

  const contents = await Promise.all(route.map((relativePath) => (
    readFile(path.join(skillRoot, relativePath), 'utf8')
  )))
  const characters = contents.reduce((total, content) => total + content.length, 0)

  assert.ok(
    characters <= ACTIVE_SET_CHARACTER_LIMIT,
    `isolated-cell route uses ${characters} characters; limit is ${ACTIVE_SET_CHARACTER_LIMIT}`,
  )
})
