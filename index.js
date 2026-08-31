import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerNativeCommands } from './lib/native-commands.js'

export const name = 'dsh-developer'
export const inject = ['skills', 'commands', 'shellEnv']

const skillDirectory = dirname(fileURLToPath(new URL('./skills/dsh-developer/SKILL.md', import.meta.url)))
const cliPath = fileURLToPath(new URL('./bin/dsh-developer.js', import.meta.url))

function parseSkill(markdown) {
  const match = /^---\r?\nname:\s*([a-z0-9-]+)\r?\ndescription:\s*"((?:[^"\\]|\\.)*)"\r?\n---\r?\n([\s\S]+)$/u.exec(markdown)
  if (!match) throw new Error('dsh-developer: bundled SKILL.md has invalid frontmatter')
  return {
    name: match[1],
    description: JSON.parse('"' + match[2] + '"'),
    content: match[3],
  }
}

export async function apply(ctx) {
  const markdown = await readFile(new URL('./skills/dsh-developer/SKILL.md', import.meta.url), 'utf8')
  const skill = parseSkill(markdown)
  ctx.skills.register({
    ...skill,
    source: 'bundled',
    invocation: { modelInvocable: true, userInvocable: true },
    resourceBase: { kind: 'directory', path: skillDirectory },
  })
  ctx.shellEnv.register({
    name: 'dsh-developer',
    variables: {
      DSH_DEVELOPER_BIN: {
        description: 'Absolute path to the installed dsh-developer CLI entry.',
      },
    },
    resolve() {
      return { DSH_DEVELOPER_BIN: cliPath }
    },
  })
  registerNativeCommands(ctx)
}
