import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerDelegationProbe } from './lib/delegation-probe.js'
import { registerDelegationSafety } from './lib/delegation-safety.js'
import { registerNativeCommands } from './lib/native-commands.js'
import { hasNativeTool, registerNativeTool } from './lib/native-tool.js'
import { registerUiCliTool } from './lib/ui-cli-tool.js'
import { registerUiSafetyGuard } from './lib/ui-policy.js'

export const name = 'dsh-developer'
export const inject = ['skills', 'commands', 'shellEnv', 'tools', 'agents']

const skillDirectory = dirname(fileURLToPath(new URL('./skills/dsh-developer/SKILL.md', import.meta.url)))
const cliPath = fileURLToPath(new URL('./bin/dsh-developer.js', import.meta.url))
const uiPatchPath = fileURLToPath(new URL('./presets/playwright-mcp.cordis.yml', import.meta.url))
const LOAD_WITNESS_FILENAME = '.dsh-developer-load-witness'

function parseSkill(markdown) {
  const match = /^---\r?\nname:\s*([a-z0-9-]+)\r?\ndescription:\s*"((?:[^"\\]|\\.)*)"\r?\n---\r?\n([\s\S]+)$/u.exec(markdown)
  if (!match) throw new Error('dsh-developer: bundled SKILL.md has invalid frontmatter')
  return {
    name: match[1],
    description: JSON.parse('"' + match[2] + '"'),
    content: match[3],
  }
}

async function completeLoadProbe(ctx) {
  const token = process.env.DSH_DEVELOPER_LOAD_PROBE
  if (token === undefined) return
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('dsh-developer: invalid load-probe token')
  const home = process.env.DSH_HOME
  if (typeof home !== 'string' || home.length === 0) throw new Error('dsh-developer: load probe requires DSH_HOME')
  const requestExit = typeof ctx.get === 'function' ? ctx.get('appExit') : undefined
  if (typeof requestExit !== 'function') throw new Error('dsh-developer: load probe requires the DSH app-exit service')
  if (!hasNativeTool(ctx)) throw new Error('dsh-developer: native model tool registration was not visible')
  await writeFile(join(resolve(home), LOAD_WITNESS_FILENAME), token + '\n', {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  requestExit(0)
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
      DSH_DEVELOPER_UI_PATCH: {
        description: 'Absolute path to the opt-in, protected Playwright MCP Cordis patch.',
      },
    },
    resolve() {
      return { DSH_DEVELOPER_BIN: cliPath, DSH_DEVELOPER_UI_PATCH: uiPatchPath }
    },
  })
  registerDelegationSafety(ctx)
  registerNativeTool(ctx)
  registerUiSafetyGuard(ctx)
  await registerUiCliTool(ctx)
  registerNativeCommands(ctx)
  registerDelegationProbe(ctx)
  await completeLoadProbe(ctx)
}
