import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { apply, inject, name } from '../index.js'
import { hasNativeTool } from '../lib/native-tool.js'
import { inspectExecutableContextReferences, inspectExecutableModuleClosure } from '../lib/web-route-audit.js'
import { UI_CLI_ENVIRONMENT } from '../lib/ui-configuration.js'

test('the shipped activation graph remains complete within its bounded audit', async () => {
  const library = new URL('../lib/', import.meta.url)
  const paths = ['package.json', 'index.js', ...(await readdir(library, { recursive: true }))
    .filter(path => path.endsWith('.js')).map(path => 'lib/' + path.replaceAll('\\', '/'))]
  const files = new Map(await Promise.all(paths.map(async path => [path,
    await readFile(new URL('../' + path, import.meta.url), 'utf8')])))
  const closure = inspectExecutableModuleClosure(files, { entryPaths: ['index.js'] })
  assert.deepEqual(closure.activationIncompletePaths, [])
  assert.deepEqual(closure.resources.exhausted, [])
})

test('optional UI configuration failures leave core commands and diagnostics usable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-bad-ui-'))
  const previous = Object.fromEntries(Object.values(UI_CLI_ENVIRONMENT).map(key => [key, process.env[key]]))
  for (const key of Object.values(UI_CLI_ENVIRONMENT)) delete process.env[key]
  process.env.DSH_DEVELOPER_UI_CONFIG = join(root, 'config.json')
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  const provider = join(root, 'provider')
  await mkdir(provider)
  const entry = join(provider, 'playwright-cli.js'), browser = join(root, 'browser')
  await writeFile(entry, 'throw new Error("provider must not execute during activation")')
  await writeFile(browser, 'must not launch')
  await writeFile(join(provider, 'package.json'), JSON.stringify({ name: '@playwright/cli', version: '0.1.19' }))
  for (const [configuration, code] of [
    ['malformed JSON', 'UI_CONFIG_INVALID'],
    [JSON.stringify({ version: 1, entry, browser, root: join(root, 'runtime') }), 'UI_CLI_VERSION_MISMATCH'],
  ]) {
    await writeFile(process.env.DSH_DEVELOPER_UI_CONFIG, configuration)
    const definitions = new Map(), commands = new Map(), effects = [], warnings = []
    await apply({
      skills: { register() {} }, shellEnv: { register() {} },
      commands: { register(value) { commands.set(value.name, value) } },
      tools: { register(value) { definitions.set(value.name, value) }, guard() {},
        schemas: () => [...definitions.values()], get: name => definitions.get(name) },
      agents: { list: () => [] }, on: () => () => {},
      effect(factory) { effects.push(factory()) },
      logger: { warn: message => warnings.push(message) },
    })
    try {
      assert.equal(definitions.has('dsh_developer'), true)
      assert.equal(definitions.has('dsh_ui'), false)
      assert.equal(commands.size, 10)
      const result = await commands.get('dsh-developer-doctor').handler({ rawInput: JSON.stringify({
        source: fileURLToPath(new URL('../examples/hello-dsh.creator.json', import.meta.url)), skipRuntime: true,
      }) })
      assert.equal(result.kind, 'success')
      const ui = await commands.get('dsh-developer-ui').handler({ rawInput: '{}' })
      assert.equal(ui.kind, 'error')
      assert.equal(warnings.length, 1)
      assert.ok(warnings[0].includes(code))
      assert.match(warnings[0], /dsh_ui unavailable/u)
      assert.match(warnings[0], /ui-setup.*restart DSH/u)
    } finally { await Promise.all(effects.reverse().map(dispose => dispose?.())) }
  }
})

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

test('registers the canonical skill through the native DSH service', async (t) => {
  const uiRoot = await mkdtemp(join(tmpdir(), 'dsh-native-no-ui-'))
  const previousUiEnvironment = Object.fromEntries(Object.values(UI_CLI_ENVIRONMENT).map(key => [key, process.env[key]]))
  for (const key of Object.values(UI_CLI_ENVIRONMENT)) delete process.env[key]
  process.env.DSH_DEVELOPER_UI_CONFIG = join(uiRoot, 'absent.json')
  t.after(async () => {
    for (const [key, value] of Object.entries(previousUiEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(uiRoot, { recursive: true, force: true })
  })
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
  assert.match(registration.content, /Understand and act/u)
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
  assert.equal(shellContribution.resolve().DSH_DEVELOPER_DSH, process.argv[1])
  assert.match(shellContribution.resolve().DSH_DEVELOPER_BIN, /bin[\\/]dsh-developer\.js$/u)
  assert.match(shellContribution.resolve().DSH_DEVELOPER_UI_PATCH, /presets[\\/]playwright-mcp\.cordis\.yml$/u)
  assert.equal(nativeTool.name, 'dsh_developer')
  const scopedTools = { get: () => nativeTool }
  assert.equal(hasNativeTool(scopedTools), true)
  assert.equal(hasNativeTool({ tools: scopedTools }), true)
  assert.equal(typeof nativeGuard, 'function')
  assert.deepEqual(nativeTool.parameters.required, ['operation'])
  assert.equal(nativeTool.output.schema.additionalProperties, false)
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-native-session-')))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(workspace, 'session.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'native-session' }) + '\n'
    + JSON.stringify({ type: 'turn/end', seq: 0, data: { turn: 1, reason: { kind: 'completed' } } }) + '\n')
  const session = await nativeTool.execute({ operation: 'session', source: 'session.jsonl', limit: 0 }, {
    signal: new AbortController().signal, agent: { session: { header: { cwd: workspace } } },
  })
  assert.equal(session.ok, true)
  assert.equal(session.report.completion.state, 'completed')
  assert.deepEqual(session.nextActions, [])
  await assert.rejects(nativeTool.execute({ operation: 'session', source: 'session.jsonl' }, {
    signal: new AbortController().signal,
  }), { code: 'HOOK_PROJECT_UNAVAILABLE' })
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
