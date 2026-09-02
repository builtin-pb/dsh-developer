import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerDelegationProbeWithDependencies } from './lib/delegation-probe.js'
import { registerAuthoritySafetyWithDependencies } from './lib/delegation-safety.js'
import { registerNativeCommandsWithDependencies } from './lib/native-commands.js'
import { hasNativeTool, registerNativeToolWithDependencies } from './lib/native-tool.js'
import { registerUiCliToolWithDependencies } from './lib/ui-cli-tool.js'
import { registerUiSafetyGuardWithTools } from './lib/ui-policy.js'

export const name = 'dsh-developer'
export const inject = ['skills', 'commands', 'shellEnv', 'tools', 'agents']

const skillDirectory = dirname(fileURLToPath(new URL('./skills/dsh-developer/SKILL.md', import.meta.url)))
const cliPath = fileURLToPath(new URL('./bin/dsh-developer.js', import.meta.url))
const uiPatchPath = fileURLToPath(new URL('./presets/playwright-mcp.cordis.yml', import.meta.url))
const LOAD_WITNESS_FILENAME = '.dsh-developer-load-witness'

function parseSkill(markdown) {
  const match = /^---\r?\nname:\s*([a-z0-9-]+)\r?\ndescription:\s*"((?:[^"\\]|\\.)*)"\r?\nwhenToUse:\s*"((?:[^"\\]|\\.)*)"\r?\n---\r?\n([\s\S]+)$/u.exec(markdown)
  if (!match) throw new Error('dsh-developer: bundled SKILL.md has invalid frontmatter')
  return {
    name: match[1],
    description: JSON.parse('"' + match[2] + '"'),
    whenToUse: JSON.parse('"' + match[3] + '"'),
    content: match[4],
  }
}

async function completeLoadProbe({ resolveAppExit, tools }) {
  const token = process.env.DSH_DEVELOPER_LOAD_PROBE
  if (token === undefined) return
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('dsh-developer: invalid load-probe token')
  const home = process.env.DSH_HOME
  if (typeof home !== 'string' || home.length === 0) throw new Error('dsh-developer: load probe requires DSH_HOME')
  const requestExit = resolveAppExit()
  if (typeof requestExit !== 'function') throw new Error('dsh-developer: load probe requires the DSH app-exit service')
  if (!hasNativeTool(tools)) throw new Error('dsh-developer: native model tool registration was not visible')
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
  const authoritySources = {
    sandboxPolicy: () => ctx.get?.('sandboxPolicy'),
    approval: () => ctx.get?.('approval'),
  }
  registerAuthoritySafetyWithDependencies({
    authoritySources,
    agents: ctx.agents,
    tools: ctx.tools,
    logger: ctx.logger,
    events: {
      agentCreated: (listener) => ctx.on('agent/created', listener),
      agentDisposed: (listener) => ctx.on('agent/disposed', listener),
      sessionEvent: (listener) => ctx.on('session/event', listener),
      toolsChange: (listener) => ctx.on('tools/change', listener),
    },
    effect: (factory, description) => ctx.effect(factory, description),
  })
  registerNativeToolWithDependencies({
    authoritySources,
    agents: ctx.agents,
    tools: ctx.tools,
    onToolsPreExecute: (listener) => ctx.on('tools/pre-execute', listener),
    onToolsResult: (listener) => ctx.on('tools/result', listener),
    effect: (factory, description) => ctx.effect(factory, description),
  })
  registerUiSafetyGuardWithTools(ctx.tools)
  await registerUiCliToolWithDependencies({
    tools: ctx.tools,
    effect: (factory, description) => ctx.effect(factory, description),
  })
  registerNativeCommandsWithDependencies({ commands: ctx.commands, tools: ctx.tools })
  registerDelegationProbeWithDependencies({
    injectProbeServices: (callback) => ctx.inject(['agentLoop', 'appExit'], callback),
  })
  await completeLoadProbe({
    resolveAppExit: () => ctx.get?.('appExit'),
    tools: ctx.tools,
  })
}
