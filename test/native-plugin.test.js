import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject, name } from '../index.js'

test('registers the canonical skill through the native DSH service', async () => {
  let registration
  const commands = new Map()
  let shellContribution
  let nativeTool
  let nativeGuard
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
    },
  })
  assert.equal(name, 'dsh-developer')
  assert.deepEqual(inject, ['skills', 'commands', 'shellEnv', 'tools'])
  assert.equal(registration.name, 'dsh-developer')
  assert.equal(registration.source, 'bundled')
  assert.equal(registration.invocation.modelInvocable, true)
  assert.match(registration.content, /Promote/u)
  assert.equal(registration.resourceBase.kind, 'directory')
  assert.deepEqual([...commands.keys()], [
    'dsh-developer-admit-cell',
    'dsh-developer-capabilities',
    'dsh-developer-compatibility',
    'dsh-developer-lab',
    'dsh-developer-impact',
    'dsh-developer-preflight',
    'dsh-developer-doctor',
    'dsh-developer-promote',
    'dsh-developer-ui',
  ])
  assert.equal(shellContribution.name, 'dsh-developer')
  assert.match(shellContribution.resolve().DSH_DEVELOPER_BIN, /bin[\\/]dsh-developer\.js$/u)
  assert.match(shellContribution.resolve().DSH_DEVELOPER_UI_PATCH, /presets[\\/]playwright-mcp\.cordis\.yml$/u)
  assert.equal(nativeTool.name, 'dsh_developer')
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

  const arbitraryLab = await commands.get('dsh-developer-lab').handler({
    rawInput: JSON.stringify({ command: ['/usr/bin/true'] }),
    signal: new AbortController().signal,
  })
  assert.equal(arbitraryLab.kind, 'error')
  assert.match(arbitraryLab.text, /Unsupported command field "command"/u)
})
