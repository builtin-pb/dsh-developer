import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skillRoot = path.join(repositoryRoot, 'skills', 'dsh-developer')
// Core Build decisions are always available, including during diagnostics.
// Budget both individual support routes and the combinations Build actually uses.
const ACTIVE_SET_BYTE_LIMIT = 11_500
const BUILD_COMBINATION_BYTE_LIMIT = 14_000
const ACTIVE_SET_BYTE_MARGIN = 150

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
    'native-cell': ['references/native-cell.md', 'references/safety.md'],
    development: ['references/development.md'],
    session: ['references/session-diagnostics.md'],
    feedback: ['references/feedback.md'],
    creator: ['references/creator-export.md', 'references/safety.md'],
    audit: ['references/safety.md'],
    core: ['references/core-incubation.md', 'references/safety.md'],
    'execution-bearing-core': ['references/execution-lab.md', 'references/safety.md'],
    'isolated-cell': ['references/isolated-cell.md', 'references/safety.md'],
    'cell-apply': ['references/cell-apply.md', 'references/safety.md'],
    authority: ['references/authority-safety.md', 'references/safety.md'],
    ui: ['references/agent-native-ui.md', 'references/safety.md'],
    'build-diagnostics': ['references/development.md', 'references/session-diagnostics.md'],
    'build-ui': ['references/development.md', 'references/agent-native-ui.md', 'references/safety.md'],
    'build-provider': ['references/development.md', 'references/isolated-cell.md', 'references/safety.md'],
  }

  for (const [name, references] of Object.entries(routes)) {
    await t.test(name, async () => {
      const contents = await routedInstructionSet(references)
      for (const [representation, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
        const bytes = [...contents.values()]
          .reduce((total, content) => total + Buffer.byteLength(withNewlines(content, newline)), 0)
        const limit = name.startsWith('build-') ? BUILD_COMBINATION_BYTE_LIMIT : ACTIVE_SET_BYTE_LIMIT
        assert.ok(
          bytes <= limit - ACTIVE_SET_BYTE_MARGIN,
          `${name} ${representation} route uses ${bytes} bytes across ${[...contents.keys()].join(', ')}; `
            + `limit is ${limit} with ${ACTIVE_SET_BYTE_MARGIN} reserved`,
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
  assert.match(skill, /implement, test, diagnose, and repair autonomously/u)
  assert.match(skill, /DeepSeek runs untrusted source only in the admitted host provider/u)
  assert.match(skill, /Hook Bridge Doctor first; classify exact installed bytes statically/u)
  assert.match(skill, /rerun that gate and all downstream gates/u)
  assert.match(skill, /answer or findings with evidence, assumptions and material limits/u)
  assert.match(skill, /For Build, return the tested outcome.*or an exact blocker and recovery/su)
})
