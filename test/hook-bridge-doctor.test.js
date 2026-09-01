import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { formatHookBridgeReport, inspectHookBridge } from '../lib/hook-bridge-doctor.js'
import { inspectHookBridgeInternal } from '../lib/hook-bridge-doctor-internal.js'
import { resolveInstalledDshEntry } from '../lib/dsh-installation.js'
import { withNextActions } from '../lib/recovery-actions.js'

function hash(value) {
  return 'sha256:' + createHash('sha256').update(value).digest('hex')
}

async function put(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const content = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  await writeFile(path, content)
  return hash(content)
}

async function putJson(path, value) {
  return put(path, JSON.stringify(value, null, 2) + '\n')
}

async function makeLane(t, { dialect = 'codex', release = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hook-doctor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dshRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  const dshVersion = release ? '9.1.1-test-release' : '9.1.2-test-preview'
  const bridgeName = dialect === 'codex'
    ? '@deepseek-ai/dsh-hooks-codex'
    : '@deepseek-ai/dsh-hooks-claude-code'
  const dshManifest = {
    name: '@deepseek-ai/dsh',
    version: dshVersion,
    publishConfig: { access: 'public' },
    bin: { dsh: 'lib/bin.js' },
    dependencies: release ? {} : { [bridgeName]: dshVersion },
  }
  const dshManifestDigest = await putJson(join(dshRoot, 'package.json'), dshManifest)
  const dshEntryDigest = await put(join(dshRoot, 'lib', 'bin.js'), 'throw new Error("DSH bytes must never execute")\n')
  const reviewed = {
    [release ? 'release' : 'preview']: {
      version: dshVersion,
      dsh: { manifest: dshManifestDigest, entry: dshEntryDigest },
      bridgeStatus: release ? 'reviewed-absent' : 'reviewed-partial',
    },
  }
  if (!release) {
    const bridgeRoot = join(dshRoot, 'node_modules', ...bridgeName.split('/'))
    const bridgeVersion = '9.1.2-test-bridge'
    const bridgeManifest = {
      name: bridgeName,
      version: bridgeVersion,
      publishConfig: { access: 'public' },
      main: 'lib/index.js',
    }
    const bridgeManifestDigest = await putJson(join(bridgeRoot, 'package.json'), bridgeManifest)
    const bridgeEntryDigest = await put(join(bridgeRoot, 'lib', 'index.js'), 'throw new Error("bridge bytes must never execute")\n')
    const bridgeInvariantDigest = await put(join(bridgeRoot, 'lib', 'invariant.js'), 'throw new Error("bridge invariant must never execute")\n')
    const protocolRoot = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-hook-protocol')
    const protocolVersion = '9.1.2-test-protocol'
    const protocolManifest = {
      name: '@deepseek-ai/dsh-hook-protocol',
      version: protocolVersion,
      publishConfig: { access: 'public' },
      main: 'lib/index.js',
    }
    const protocolManifestDigest = await putJson(join(protocolRoot, 'package.json'), protocolManifest)
    const protocolEntryDigest = await put(join(protocolRoot, 'lib', 'index.js'), 'throw new Error("protocol bytes must never execute")\n')
    const protocolInvariantDigest = await put(join(protocolRoot, 'lib', 'invariant.js'), 'throw new Error("protocol invariant must never execute")\n')
    reviewed.preview.bridges = {
      [dialect]: {
        name: bridgeName,
        version: bridgeVersion,
        manifest: bridgeManifestDigest,
        entry: bridgeEntryDigest,
        invariant: bridgeInvariantDigest,
      },
    }
    reviewed.preview.protocol = {
      name: '@deepseek-ai/dsh-hook-protocol',
      version: protocolVersion,
      manifest: protocolManifestDigest,
      entry: protocolEntryDigest,
      invariant: protocolInvariantDigest,
    }
  }
  return {
    root,
    dshEntry: join(dshRoot, 'lib', 'bin.js'),
    dshRoot,
    reviewed,
    bridgeEntry: release ? undefined : join(dshRoot, 'node_modules', ...bridgeName.split('/'), 'lib', 'index.js'),
    async inspect(config, options = {}) {
      const source = options.source ?? join(root, 'hooks.json')
      if (config !== undefined) await putJson(source, config)
      return inspectHookBridgeInternal(source, {
        dialect,
        dshPath: join(dshRoot, 'lib', 'bin.js'),
        sourceRoot: options.sourceRoot ?? root,
        signal: options.signal,
      }, { reviewedLanes: reviewed, ...options.dependencies })
    },
  }
}

function commandHooks(command = 'echo inspected-only') {
  return [{ hooks: [{ type: 'command', command, timeout: 5 }] }]
}

test('classifies the exact reviewed Codex subset without executing DSH, bridge, or hook commands', async (t) => {
  const lane = await makeLane(t)
  const sentinel = join(lane.root, 'must-not-exist.txt')
  const command = `node -e "require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'ran')"`
  const config = {
    hooks: {
      PreToolUse: [{ matcher: 'shell|bash', hooks: [{ command, timeout: 5 }] }],
      PostToolUse: commandHooks(),
      SessionStart: [{ matcher: '^startup', hooks: [{ command: 'echo session' }] }],
      UserPromptSubmit: commandHooks(),
      Stop: commandHooks(),
    },
  }
  const first = await lane.inspect(config)
  const second = await lane.inspect(config)
  assert.equal(first.ok, true)
  assert.equal(first.lane.status, 'reviewed-partial')
  assert.equal(first.lane.activation, 'not-inspected')
  assert.equal(first.config.totals.runnable, 5)
  assert.equal(first.config.totals.runtimeRunnable, 5)
  assert.equal(first.config.totals.effectiveRunnable, 5)
  assert.equal(first.config.events.find((value) => value.event === 'PreToolUse').matcherClasses[0].classification, 'codex-regex')
  assert.equal(first.evidenceDigest, second.evidenceDigest)
  assert.equal(await readFile(sentinel, 'utf8').catch(() => undefined), undefined)
  assert.doesNotMatch(JSON.stringify(first), /writeFileSync|must-not-exist/u)
  assert.match(formatHookBridgeReport(first), /^PASS Hook Bridge Doctor codex/u)
})

test('classifies all seven reviewed Claude Code events and exact matcher subjects', async (t) => {
  const lane = await makeLane(t, { dialect: 'claude-code' })
  const report = await lane.inspect({
    hooks: {
      SessionStart: [{ matcher: '^startup', hooks: [{ command: 'echo session' }] }],
      UserPromptSubmit: commandHooks(),
      PreToolUse: [{ matcher: 'Read|Write', hooks: [{ command: 'echo pre' }] }],
      PostToolUse: commandHooks(),
      Stop: commandHooks(),
      SubagentStart: [{ matcher: 'general-purpose', hooks: [{ command: 'echo child' }] }],
      SubagentStop: [{ matcher: '*', hooks: [{ command: 'echo child-end' }] }],
    },
  })
  assert.equal(report.ok, true)
  assert.equal(report.config.events.length, 7)
  assert.equal(report.config.totals.runnable, 7)
  assert.equal(report.config.events.find((value) => value.event === 'PreToolUse').matcherClasses[0].classification, 'claude-literal-alternatives')
  assert.equal(report.config.events.find((value) => value.event === 'SubagentStart').matcherSubject, 'agent-type:general-purpose')
  assert.deepEqual(report.nonClaims, ['bridge-activation', 'command-behavior', 'hook-output-behavior', 'full-reference-product-parity'])
})

test('separates strict acceptance from bridge-runtime parsing and catches whole-config matcher rejection', async (t) => {
  const lane = await makeLane(t)
  const report = await lane.inspect({
    hooks: {
      PreToolUse: [{
        matcher: '[',
        hooks: [
          { type: 42, command: '' },
          { command: 'echo timeout', timeout: 1.5 },
        ],
      }],
      PostToolUse: commandHooks(),
    },
  })
  assert.equal(report.ok, false)
  assert.equal(report.config.registration, 'none-invalid-matcher')
  assert.equal(report.config.totals.runnable, 1)
  assert.equal(report.config.totals.runtimeRunnable, 3)
  assert.equal(report.config.totals.effectiveRunnable, 0)
  assert.ok(report.config.issues.some((value) => value.code === 'HOOK_HANDLER_TYPE_INVALID'))
  assert.ok(report.config.issues.some((value) => value.code === 'HOOK_TIMEOUT_INVALID'))
  assert.ok(report.config.issues.some((value) => value.code === 'HOOK_MATCHER_INVALID_REGEX'))
})

test('distinguishes Codex async skip from Claude async synchronous runtime behavior', async (t) => {
  const codex = await makeLane(t)
  const codexReport = await codex.inspect({
    hooks: { PreToolUse: [{ hooks: [{ command: 'echo codex', async: true }] }] },
  })
  assert.equal(codexReport.config.totals.runtimeRunnable, 0)
  assert.equal(codexReport.config.events[0].handlerClasses[0].classification, 'skipped-async')

  const claude = await makeLane(t, { dialect: 'claude-code' })
  const claudeReport = await claude.inspect({
    hooks: { PreToolUse: [{ hooks: [{ command: 'echo claude', async: true, args: ['x'], mystery: true }] }] },
  })
  assert.equal(claudeReport.config.totals.runtimeRunnable, 1)
  assert.equal(claudeReport.config.totals.runnable, 0)
  assert.equal(claudeReport.config.events[0].handlerClasses[0].classification, 'runnable-command-with-ignored-options')
  const ignored = claudeReport.config.issues.filter((value) => value.code === 'HOOK_HANDLER_OPTION_IGNORED')
  assert.equal(ignored.length, 1)
  assert.equal(ignored[0].count, 3)
})

test('redacts unknown event and handler content while classifying every unreachable handler once', async (t) => {
  const lane = await makeLane(t)
  const marker = 'DO_NOT_ECHO_MARKER'
  const report = await lane.inspect({
    hooks: {
      PermissionRequest: [{ hooks: [{ command: marker }] }],
      attackerControlledEvent: [{ hooks: [{ command: marker }, { arbitrary: marker }] }],
    },
  })
  assert.equal(report.ok, false)
  assert.equal(report.config.totals.handlers, 3)
  assert.equal(report.config.totals.skipped, 3)
  const unknown = report.config.events.find((value) => value.support === 'unknown')
  assert.equal(unknown.event, undefined)
  assert.equal(unknown.handlerClasses[0].classification, 'unreachable-event')
  assert.equal(unknown.handlerClasses[0].count, 2)
  assert.doesNotMatch(JSON.stringify(report), /attackerControlledEvent|DO_NOT_ECHO_MARKER/u)
  assert.match(formatHookBridgeReport(report), /redacted-event-/u)
  const boundary = withNextActions(report, { operation: 'hook-doctor', report })
  assert.deepEqual(boundary.nextActions.map((value) => value.id), ['hook-doctor.resolve-config'])
  assert.doesNotMatch(JSON.stringify(boundary.nextActions), /attackerControlledEvent|DO_NOT_ECHO_MARKER/u)
})

test('never expands Claude bridge substitutions and fails closed without mount context', async (t) => {
  const lane = await makeLane(t, { dialect: 'claude-code' })
  const report = await lane.inspect({
    hooks: {
      PreToolUse: [{ hooks: [{ command: '"${CLAUDE_PLUGIN_ROOT}/check" "${CLAUDE_PROJECT_DIR}"' }] }],
    },
  })
  assert.equal(report.ok, false)
  assert.equal(report.config.tokenFlags.claudePluginRoot, true)
  assert.equal(report.config.tokenFlags.claudeProjectDir, true)
  assert.ok(report.config.issues.some((value) => value.code === 'HOOK_SUBSTITUTION_CONTEXT_NOT_INSPECTED'))
  assert.doesNotMatch(JSON.stringify(report), /CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR/u)
})

test('reports reviewed rc2 absence without reading the config or suggesting an alpha substitution', async (t) => {
  const lane = await makeLane(t, { release: true })
  const report = await lane.inspect(undefined, { source: join(lane.root, 'missing-and-unread.json') })
  assert.equal(report.ok, false)
  assert.equal(report.lane.status, 'reviewed-absent')
  assert.equal(report.lane.bridge.availability, 'not-shipped')
  assert.equal(report.source.status, 'not-read')
  assert.ok(report.config.issues.some((value) => value.code === 'HOOK_BRIDGE_NOT_SHIPPED'))
  assert.doesNotMatch(JSON.stringify(report), /alpha|install/iu)
  const boundary = withNextActions(report, { operation: 'hook-doctor', report })
  assert.deepEqual(boundary.nextActions, [])
  assert.doesNotMatch(JSON.stringify(boundary), /doctor\.resolve-blocker|repair source|alpha|install/iu)
})

test('keeps changed bridge bytes unclassified and does not read config afterward', async (t) => {
  const lane = await makeLane(t)
  await put(join(lane.dshRoot, 'node_modules', '@deepseek-ai', 'dsh-hooks-codex', 'lib', 'index.js'), 'changed unreviewed bytes\n')
  const report = await lane.inspect(undefined, { source: join(lane.root, 'missing-and-unread.json') })
  assert.equal(report.ok, false)
  assert.equal(report.source.status, 'not-read')
  assert.equal(report.checks[0].evidence.code, 'HOOK_BRIDGE_UNREVIEWED')
  const boundary = withNextActions(report, { operation: 'hook-doctor', report })
  assert.deepEqual(boundary.nextActions.map((value) => value.id), ['dsh.select-reviewed-lane'])
  assert.doesNotMatch(JSON.stringify(boundary.nextActions), /doctor\.resolve-blocker|repair-doctor-blocker/u)
})

test('reseals the complete package set against cross-file mutation', async (t) => {
  const lane = await makeLane(t)
  let resolutions = 0
  const report = await lane.inspect(undefined, {
    source: join(lane.root, 'missing-and-unread.json'),
    dependencies: {
      async resolveInstalledDshEntry(installed) {
        const entry = await resolveInstalledDshEntry(installed)
        resolutions += 1
        if (resolutions === 2) await put(lane.bridgeEntry, 'mutated after its first verified read\n')
        return entry
      },
    },
  })
  assert.equal(report.ok, false)
  assert.equal(report.checks[0].evidence.code, 'HOOK_PACKAGE_MUTATED')
  assert.equal(report.source.status, 'not-read')
})

test('confines relative native sources to the supplied project root', async (t) => {
  const lane = await makeLane(t)
  await putJson(join(lane.root, 'project-hooks.json'), { hooks: { PreToolUse: commandHooks() } })
  const inside = await lane.inspect(undefined, { source: 'project-hooks.json' })
  assert.equal(inside.ok, true)
  const outside = await lane.inspect(undefined, {
    source: join(dirname(lane.root), 'outside-hooks.json'),
    sourceRoot: lane.root,
  })
  assert.equal(outside.ok, false)
  assert.equal(outside.checks[0].evidence.code, 'HOOK_SOURCE_OUTSIDE_PROJECT')
})

test('fails closed and redacts secret, malformed, non-text, NUL, oversized, and deep sources', async (t) => {
  const credentialName = ['api', 'key'].join('_')
  const credentialValue = ['sk-', 'abcdefgh', 'ijklmnop', 'qrstuvwx', 'yz123456'].join('')
  const cases = [
    ['secret', JSON.stringify({ hooks: {}, [credentialName]: credentialValue }), 'HOOK_SOURCE_SECRET'],
    ['malformed', '{"hooks":', 'HOOK_CONFIG_INVALID_JSON'],
    ['non-text', Buffer.from([0xff, 0xfe]), 'HOOK_SOURCE_INVALID_TEXT'],
    ['nul', Buffer.from('{"hooks":{}}\0', 'utf8'), 'HOOK_SOURCE_INVALID_TEXT'],
    ['oversized', Buffer.alloc(256 * 1024 + 1, 0x20), 'HOOK_SOURCE_TOO_LARGE'],
  ]
  for (const [name, content, code] of cases) {
    await t.test(name, async () => {
      const lane = await makeLane(t)
      const source = join(lane.root, name + '.json')
      await put(source, content)
      const report = await lane.inspect(undefined, { source })
      assert.equal(report.ok, false)
      assert.equal(report.config.issues[0].code, code)
      if (name === 'secret') {
        assert.equal(report.source.status, 'redacted')
        assert.doesNotMatch(JSON.stringify(report), new RegExp(credentialName + '|' + credentialValue, 'u'))
      }
    })
  }
  await t.test('deep', async () => {
    const lane = await makeLane(t)
    let value = 'leaf'
    for (let index = 0; index < 20; index += 1) value = { child: value }
    const report = await lane.inspect({ hooks: {}, extra: value })
    assert.equal(report.ok, false)
    assert.equal(report.config.issues[0].code, 'HOOK_CONFIG_DEPTH_LIMIT')
  })
})

test('rejects linked source files when the platform permits creating one', async (t) => {
  const lane = await makeLane(t)
  const target = join(lane.root, 'target.json')
  const linked = join(lane.root, 'linked.json')
  await putJson(target, { hooks: { PreToolUse: commandHooks() } })
  try {
    await symlink(target, linked, 'file')
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('file symlinks require additional Windows privilege')
      return
    }
    throw error
  }
  const report = await lane.inspect(undefined, { source: linked })
  assert.equal(report.ok, false)
  assert.equal(report.config.issues[0].code, 'HOOK_SOURCE_LINKED')
})

test('rejects project-local hard-link aliases to configuration bytes', async (t) => {
  const lane = await makeLane(t)
  const target = join(lane.root, 'target.json')
  const linked = join(lane.root, 'hard-linked.json')
  await putJson(target, { hooks: { PreToolUse: commandHooks() } })
  await link(target, linked)
  const report = await lane.inspect(undefined, { source: linked })
  assert.equal(report.ok, false)
  assert.equal(report.config.issues[0].code, 'HOOK_SOURCE_UNSAFE')
})

test('validates the closed public API and cancellation without starting any runtime', async () => {
  await assert.rejects(() => inspectHookBridge('hooks.json', {
    dialect: 'codex',
    dshPath: 'dsh',
    extra: true,
  }), /unsupported option/u)
  await assert.rejects(() => inspectHookBridge('hooks.json', {
    dialect: 'other',
    dshPath: 'dsh',
  }), /dialect must be/u)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => inspectHookBridgeInternal('hooks.json', {
    dialect: 'codex',
    dshPath: 'dsh',
    signal: controller.signal,
  }), (error) => error.code === 'CANCELLED')
})
