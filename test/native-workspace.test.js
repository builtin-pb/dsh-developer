import assert from 'node:assert/strict'
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { registerNativeCommandsWithDependencies } from '../lib/native-commands.js'
import { registerNativeToolWithDependencies } from '../lib/native-tool.js'

function nativeSurfaces() {
  let definition
  const commands = new Map()
  const tools = { register(value) { definition = value }, guard() {}, schemas() { return [] } }
  registerNativeToolWithDependencies({
    tools, agents: { *roots() {} }, authoritySources: {},
    onToolsPreExecute() {}, onToolsResult() {}, effect() {},
  })
  registerNativeCommandsWithDependencies({ commands: { register(value) { commands.set(value.name, value) } }, tools })
  return { definition, commands }
}

test('native Doctor and audits select the attached workspace instead of the launch directory', async () => {
  const workspace = await mkdtemp(join(await realpath(tmpdir()), 'dsh-native-workspace-'))
  const source = join(workspace, 'plugin')
  await cp(new URL('./fixtures/ordinary-dsh-plugin/', import.meta.url), source, { recursive: true })
  const { definition, commands } = nativeSurfaces()
  const invocation = { agent: { session: { header: { cwd: workspace } } }, signal: new AbortController().signal }
  try {
    const doctor = await definition.execute({ operation: 'doctor', source: 'plugin', skipRuntime: true }, invocation)
    assert.equal(doctor.ok, true)
    assert.equal(doctor.report.source, source)
    const command = await commands.get('dsh-developer-doctor').handler({
      ...invocation, rawInput: JSON.stringify({ source: 'plugin', skipRuntime: true }),
    })
    assert.equal(command.kind, 'success')
    assert.ok(command.text.startsWith('PASS Doctor ' + source + '\n'))

    // Missing runtime fixtures prevent any runtime execution while still exercising
    // the real source readers behind each native operation.
    for (const operation of ['preflight', 'impact', 'compatibility']) {
      const input = { operation, source: 'plugin', ...(operation === 'preflight' ? {} : {
        releaseDsh: join(workspace, 'missing-release'), previewDsh: join(workspace, 'missing-preview'),
      }) }
      const result = await definition.execute(input, invocation)
      assert.equal(result.report.source, source, operation + ': ' + JSON.stringify(result))
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('native source selection requires a valid Agent for relative tool paths and retains explicit command use', async () => {
  const { definition, commands } = nativeSurfaces()
  const source = await realpath(new URL('./fixtures/ordinary-dsh-plugin/', import.meta.url))
  const input = { operation: 'doctor', source: relative(process.cwd(), source), skipRuntime: true }
  const signal = new AbortController().signal
  for (const agent of [undefined, {}, { session: { header: { cwd: 'relative-root' } } }]) {
    const result = await definition.execute(input, { signal, agent })
    assert.equal(result.ok, false)
    assert.equal(result.report.diagnostic.code, 'HOOK_PROJECT_UNAVAILABLE')
  }
  const absolute = await definition.execute({ ...input, source }, { signal })
  assert.equal(absolute.report.source, source)
  const commandInput = { source: input.source, skipRuntime: true }
  const command = commands.get('dsh-developer-doctor')
  assert.equal((await command.handler({ rawInput: JSON.stringify(commandInput), signal })).kind, 'success')
  const malformed = await command.handler({ rawInput: JSON.stringify(commandInput), signal, agent: {} })
  assert.equal(malformed.kind, 'error')
  assert.match(malformed.text, /^HOOK_PROJECT_UNAVAILABLE:/u)
})
