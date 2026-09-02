import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { apply, inject, name } from '../index.js'
import { hasNativeTool } from '../lib/native-tool.js'
import { inspectExecutableContextReferences } from '../lib/web-route-audit.js'

test('keeps every activation path context-complete through narrow capability projection', async () => {
  const activationPaths = [
    '../index.js',
    '../lib/delegation-probe.js',
    '../lib/delegation-safety.js',
    '../lib/native-commands.js',
    '../lib/native-tool.js',
  ]
  for (const relativePath of activationPaths) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8')
    const report = inspectExecutableContextReferences(source, { sourcePath: relativePath })
    assert.equal(report.complete, true, relativePath + ' must not retain or forward a bare DSH context')
  }
})

test('registers the canonical skill through the native DSH service', async () => {
  let registration
  const commands = new Map()
  let shellContribution
  let nativeTool
  let nativeGuard
  const lifecycleListeners = new Map()
  await apply({
    skills: {
      register(value) {
        registration = value
        return () => {}
      },
    },
    commands: {
      register(value) {
        commands.set(value.name, value)
        return () => {}
      },
    },
    shellEnv: {
      register(value) {
        shellContribution = value
        return () => {}
      },
    },
    tools: {
      register(value) {
        nativeTool = value
        return () => {}
      },
      guard(value) {
        nativeGuard = value
        return () => {}
      },
      schemas() {
        return []
      },
      get() {
        return undefined
      },
    },
    agents: { list() { return [] } },
    on(name, callback) {
      lifecycleListeners.set(name, callback)
      return () => {}
    },
    effect(factory) {
      factory()
      return () => {}
    },
  })
  assert.equal(name, 'dsh-developer')
  assert.deepEqual(inject, ['skills', 'commands', 'shellEnv', 'tools', 'agents'])
  assert.equal(typeof lifecycleListeners.get('agent/created'), 'function')
  assert.equal(typeof lifecycleListeners.get('agent/disposed'), 'function')
  assert.equal(registration.name, 'dsh-developer')
  assert.equal(registration.source, 'bundled')
  assert.equal(registration.invocation.modelInvocable, true)
  assert.match(registration.description, /any DSH plugin idea/u)
  assert.match(registration.description, /Answer or inspect directly when no change is needed/u)
  assert.match(registration.whenToUse, /even when they do not name this skill/u)
  assert.match(registration.content, /Start from conversation/u)
  assert.match(registration.content, /compact plan/u)
  assert.match(registration.content, /implement, test, diagnose, and repair autonomously/u)
  assert.equal(registration.resourceBase.kind, 'directory')
  assert.deepEqual([...commands.keys()], [
    'dsh-developer-admit-cell',
    'dsh-developer-capabilities',
    'dsh-developer-compatibility',
    'dsh-developer-lab',
    'dsh-developer-impact',
    'dsh-developer-hook-doctor',
    'dsh-developer-preflight',
    'dsh-developer-doctor',
    'dsh-developer-promote',
    'dsh-developer-ui',
  ])
  assert.equal(shellContribution.name, 'dsh-developer')
  assert.match(shellContribution.resolve().DSH_DEVELOPER_BIN, /bin[\\/]dsh-developer\.js$/u)
  assert.match(shellContribution.resolve().DSH_DEVELOPER_UI_PATCH, /presets[\\/]playwright-mcp\.cordis\.yml$/u)
  assert.equal(nativeTool.name, 'dsh_developer')
  const scopedTools = { get: () => nativeTool }
  assert.equal(hasNativeTool(scopedTools), true)
  assert.equal(hasNativeTool({ tools: scopedTools }), true)
  assert.equal(typeof nativeGuard, 'function')
  assert.deepEqual(nativeTool.parameters.required, ['operation'])
  assert.equal(nativeTool.output.schema.additionalProperties, false)
  const result = await commands.get('dsh-developer-doctor').handler({
    rawInput: JSON.stringify({
      source: 'examples/hello-dsh.creator.json',
      skipRuntime: true,
    }),
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^PASS Doctor/u)

  const confinedHook = await commands.get('dsh-developer-hook-doctor').handler({
    rawInput: JSON.stringify({ source: '../outside-hooks.json', dialect: 'codex' }),
    signal: new AbortController().signal,
  })
  assert.equal(confinedHook.kind, 'error')
  assert.match(confinedHook.text, /source\.authority/u)
  assert.doesNotMatch(confinedHook.text, /outside-hooks/u)

  const nativeHook = await nativeTool.execute({
    operation: 'hook-doctor',
    source: 'package.json',
    dialect: 'codex',
  }, {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: process.cwd() } } },
  })
  assert.equal(nativeHook.operation, 'hook-doctor')
  assert.equal(nativeHook.report.checks[0].id, 'lane.identity')
  await assert.rejects(() => nativeTool.execute({
    operation: 'hook-doctor',
    source: 'package.json',
    dialect: 'codex',
  }, {
    signal: new AbortController().signal,
  }), (error) => error.code === 'HOOK_PROJECT_UNAVAILABLE')

  const arbitraryLab = await commands.get('dsh-developer-lab').handler({
    rawInput: JSON.stringify({ command: ['/usr/bin/true'] }),
    signal: new AbortController().signal,
  })
  assert.equal(arbitraryLab.kind, 'error')
  assert.match(arbitraryLab.text, /Unsupported command field "command"/u)
})
