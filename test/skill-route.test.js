import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skillRoot = path.join(repositoryRoot, 'skills', 'dsh-developer')
const ACTIVE_SET_CHARACTER_LIMIT = 8_000

test('keeps every routed skill instruction set within the repository budget', async (t) => {
  const routes = {
    creator: ['references/creator-export.md', 'references/safety.md'],
    audit: ['references/safety.md'],
    core: ['references/core-incubation.md'],
    'core-with-untrusted-source': ['references/core-incubation.md', 'references/safety.md'],
    'execution-bearing-core': ['references/execution-lab.md', 'references/safety.md'],
    'isolated-cell': ['references/isolated-cell.md', 'references/safety.md'],
    ui: ['references/agent-native-ui.md'],
  }

  for (const [name, references] of Object.entries(routes)) {
    await t.test(name, async () => {
      const contents = await Promise.all(['SKILL.md', ...references].map((relativePath) => (
        readFile(path.join(skillRoot, relativePath), 'utf8')
      )))
      const characters = contents.reduce(
        (total, content) => total + content.replaceAll('\r\n', '\n').length,
        0,
      )
      assert.ok(
        characters <= ACTIVE_SET_CHARACTER_LIMIT,
        `${name} route uses ${characters} characters; limit is ${ACTIVE_SET_CHARACTER_LIMIT}`,
      )
    })
  }
})
