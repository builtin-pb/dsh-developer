import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skillRoot = path.join(repositoryRoot, 'skills', 'dsh-developer')
const ACTIVE_SET_CHARACTER_LIMIT = 8_000
const ACTIVE_SET_CHARACTER_MARGIN = 150

function withNewlines(content, newline) {
  return content.replace(/\r\n?|\n/gu, '\n').replace(/\n/gu, newline)
}

async function routedInstructionSet(initialReferences) {
  const contents = new Map([['SKILL.md', await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')]])
  const queue = [...initialReferences]
  while (queue.length > 0) {
    const relativePath = queue.shift()
    if (contents.has(relativePath)) continue
    const content = await readFile(path.join(skillRoot, relativePath), 'utf8')
    contents.set(relativePath, content)
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)#]+\.md)\)/gu)) {
      const linked = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), match[1]))
      assert.match(linked, /^references\//u)
      queue.push(linked)
    }
  }
  return contents
}

test('keeps every LF and CRLF routed skill set below the repository budget with margin', async (t) => {
  const routes = {
    creator: ['references/creator-export.md', 'references/safety.md'],
    audit: ['references/safety.md'],
    core: ['references/core-incubation.md', 'references/safety.md'],
    'execution-bearing-core': ['references/execution-lab.md', 'references/safety.md'],
    'isolated-cell': ['references/isolated-cell.md', 'references/safety.md'],
    authority: ['references/authority-safety.md', 'references/safety.md'],
    ui: ['references/agent-native-ui.md', 'references/safety.md'],
  }

  for (const [name, references] of Object.entries(routes)) {
    await t.test(name, async () => {
      const contents = await routedInstructionSet(references)
      for (const [representation, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
        const characters = [...contents.values()]
          .reduce((total, content) => total + withNewlines(content, newline).length, 0)
        assert.ok(
          characters <= ACTIVE_SET_CHARACTER_LIMIT - ACTIVE_SET_CHARACTER_MARGIN,
          `${name} ${representation} route uses ${characters} characters across ${[...contents.keys()].join(', ')}; `
            + `limit is ${ACTIVE_SET_CHARACTER_LIMIT} with ${ACTIVE_SET_CHARACTER_MARGIN} reserved`,
        )
      }
    })
  }
})

test('owns a conversational plan-to-proof development loop', async () => {
  const skill = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')
  assert.match(skill, /Use for any DSH plugin idea/u)
  assert.match(skill, /even when they do not name this skill/u)
  assert.match(skill, /\*\*Answer\*\*.*\*\*Inspect\*\*.*\*\*Build\*\*/su)
  assert.match(skill, /Answer or inspect directly when no change is needed/u)
  assert.match(skill, /compact plan: outcome, files\/effects, proof path, and material choices/u)
  assert.match(skill, /Obtain approval before mutation/u)
  assert.match(skill, /implement, test, diagnose, and repair autonomously/u)
  assert.match(skill, /Load one reference family per response/u)
  assert.match(skill, /DeepSeek runs untrusted source only in an admitted Bubblewrap-backed cell/u)
  assert.match(skill, /rerun that gate and all downstream gates/u)
  assert.match(skill, /Answer ends with the answer and assumptions/u)
  assert.match(skill, /Inspect ends with findings, evidence, and risks/u)
  assert.match(skill, /Build ends with a tested outcome.*or an exact blocker and recovery/su)
})
