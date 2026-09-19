import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { KNOWLEDGE_TOPICS, inspectDshKnowledge, formatDshKnowledgeReport } from '../lib/knowledge.js'
import { runBounded } from '../lib/runtime.js'
import { registerNativeToolWithDependencies } from '../lib/native-tool.js'

const COMMIT = 'c291e7961a515f6d7af9304e7fd1d257929aef26'
const SECRET = 'PRIVATE_CONFIGURATION_MUST_NOT_BE_READ'

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content))
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh knowledge ü ')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const upstream = join(root, 'checkout')
  const installed = join(root, 'installation', 'node_modules', '@deepseek-ai', 'dsh')
  const marker = join(root, 'executed')
  const executable = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('TARGET EXECUTED')\n`
  await write(join(upstream, 'package.json'), { name: '@deepseek-ai/dsh-root', version: '0.1.5-rc.2',
    scripts: { postinstall: 'node src/index.js' } })
  await write(join(upstream, '.git', 'HEAD'), COMMIT + '\n')
  await write(join(upstream, '.git', 'config'), SECRET)
  await write(join(upstream, '.env'), SECRET)
  await write(join(upstream, 'cordis.yml'), SECRET)
  await write(join(upstream, 'config', 'settings.json'), SECRET)
  const entry = join(installed, 'lib', 'bin.js')
  await write(entry, executable)
  await write(join(installed, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.1-rc.2', type: 'module',
    bin: { dsh: 'lib/bin.js' }, scripts: { postinstall: 'node lib/bin.js' } })
  async function packageAt(packageRoot, name, version, extra = {}) {
    await write(join(packageRoot, 'package.json'), { name, version, type: 'module',
      main: './index.js', types: './lib/types/index.d.ts', exports: { '.': { types: './lib/types/index.d.ts', default: './index.js' } },
      scripts: { prepare: 'node index.js', postinstall: 'node index.js' }, ...extra })
    await write(join(packageRoot, 'index.js'), executable)
    return packageRoot
  }
  return { root, upstream, installed, entry, marker, executable,
    upstreamPackage: (name, directory, extra) => packageAt(join(upstream, directory), name, '0.1.5-rc.2', extra),
    installedPackage: (name, extra, consumer = installed) => packageAt(join(consumer, 'node_modules', ...name.split('/')), name, '0.1.1-rc.2', extra),
  }
}

// Paths and names are assertions of public ownership, not generated from the
// implementation's route table. Each case excludes the neighboring topic.
const ROUTING_CASES = [
  ['tool', 'docs/user/develop/basic/tool.md', '@deepseek-ai/dsh-tools', 'packages/core/tools'],
  ['lifecycle', 'docs/user/develop/framework/index.md', '@deepseek-ai/cordis', 'vendor/cordis'],
  ['configuration', 'docs/user/develop/basic/config.md', '@deepseek-ai/dsh-settings', 'packages/settings/settings'],
  ['ui', 'docs/subsystems/slots.md', '@deepseek-ai/dsh-client-ui-slots', 'packages/client/ui-slots'],
  ['packaging', 'docs/user/develop/basic/publish.md', '@deepseek-ai/dsh', 'apps/cli'],
  ['core', 'docs/subsystems/core.md', '@deepseek-ai/dsh-agent', 'packages/core/agent'],
  ['testing', 'docs/development.md', '@deepseek-ai/dsh-agent-loop', 'packages/core/agent-loop'],
]

test('routes every topic to its actual docs, owning source and tests', async (t) => {
  const f = await fixture(t)
  for (const [topic, doc, name, directory] of ROUTING_CASES) {
    await write(join(f.upstream, doc), '# ' + topic + '\nPublic guidance for ' + topic + '\n')
    const pkg = await f.upstreamPackage(name, directory)
    await write(join(pkg, 'README.md'), '# ' + name + '\nOwned API documentation\n')
    await write(join(pkg, 'src', 'index.ts'), 'export const sourceFor = ' + JSON.stringify(topic) + '\n')
    await write(join(pkg, 'tests', 'behavior.spec.ts'), "test('" + topic + " behavior', () => {})\n")
  }
  for (const [topic, doc, name, directory] of ROUTING_CASES) {
    await t.test(topic, async () => {
      const report = await inspectDshKnowledge({ upstreamRoot: f.upstream, topic })
      assert.equal(report.ok, true)
      assert.equal(report.kind, 'dsh-knowledge')
      assert.deepEqual(report.topics, [topic])
      assert.equal(report.installed, null, 'upstream-only must not inspect an unrelated installation on PATH')
      assert.equal(report.upstream.version, '0.1.5-rc.2')
      assert.equal(report.upstream.commit, COMMIT)
      assert(report.evidence.some((item) => item.path === join(f.upstream, doc)))
      for (const [kind, file] of [['source', 'src/index.ts'], ['test', 'tests/behavior.spec.ts'], ['readme', 'README.md']]) {
        assert(report.evidence.some((item) => item.kind === kind && item.packageName === name && item.path === join(f.upstream, directory, file)))
      }
      assert(report.evidence.every((item) => item.topics.includes(topic)))
      const unrelated = topic === 'tool' ? 'core' : 'tool'
      const unrelatedDoc = ROUTING_CASES.find(([value]) => value === unrelated)[1]
      assert(!report.evidence.some((item) => item.path === join(f.upstream, unrelatedDoc)))
      assert(!JSON.stringify(report).includes(SECRET))
    })
  }
  assert.deepEqual(KNOWLEDGE_TOPICS, ROUTING_CASES.map(([topic]) => topic))
  const defaultReport = await inspectDshKnowledge({ upstreamRoot: f.upstream })
  const explicit = await inspectDshKnowledge({ upstreamRoot: f.upstream, topic: 'tool' })
  assert.deepEqual(defaultReport.topics, ['tool'])
  assert.deepEqual(defaultReport.evidence, explicit.evidence)
  assert.match(formatDshKnowledgeReport(defaultReport), /Default topic: tool\. Available topics: tool, lifecycle, configuration, ui, packaging, core, testing/u)
  assert.equal(new Set(defaultReport.evidence.map((item) => item.path)).size, defaultReport.evidence.length)
})

test('returns line-accurate excerpts and digests of the actual working files', async (t) => {
  const f = await fixture(t)
  const doc = join(f.upstream, 'docs/user/develop/basic/tool.md')
  const source = [...Array.from({ length: 45 }, (_, n) => 'intro ' + n),
    'ctx.tools.register(defineTool({', '  name: "local-only-api",', '  execute() { return "exact target" },', '})',
    ...Array.from({ length: 100 }, () => 'further explanation')].join('\n')
  await write(doc, source)
  const report = await inspectDshKnowledge({ upstreamRoot: f.upstream, topic: 'tool' })
  const item = report.evidence.find((item) => item.path === doc)
  assert(item.startLine > 1)
  assert.match(item.excerpt, /local-only-api/u)
  assert.equal(item.sha256, createHash('sha256').update(source).digest('hex'))
  assert.equal(item.excerpt, source.split('\n').slice(item.startLine - 1, item.endLine).join('\n').slice(0, item.excerpt.length))
  assert.equal(item.truncated, true)
  assert(item.excerpt.length <= report.limits.excerptChars)
  assert(item.endLine - item.startLine + 1 <= report.limits.excerptLines)
  assert.equal(report.upstream.workingTree, 'not-verified-clean')
  await write(doc, source.replace('exact target', 'modified target'))
  const changed = await inspectDshKnowledge({ upstreamRoot: f.upstream, topic: 'tool' })
  assert.equal(changed.upstream.commit, COMMIT)
  assert.notEqual(changed.evidence.find((entry) => entry.path === doc).sha256, item.sha256)
  const formatted = formatDshKnowledgeReport(report)
  assert(formatted.includes(doc + ':' + item.startLine + '-' + item.endLine))
  assert(formatted.includes(item.excerpt))
  assert(formatted.includes(COMMIT))
  assert.match(formatted, /cleanliness.*not verified/iu)
})

test('keeps old installed declarations separate from a newer checkout and never executes packages', async (t) => {
  const f = await fixture(t)
  const pkg = await f.installedPackage('@deepseek-ai/dsh-tools', {
    repository: { directory: 'packages/core/tools' },
    exports: { '.': { import: { types: './lib/types/index.d.ts', default: './index.js' } },
      './extra': { types: './lib/types/extra.d.mts' } },
  })
  await write(join(pkg, 'README.md'), '# Installed tool API\nOLD_INSTALLED_ONLY\n')
  await write(join(pkg, 'lib/types/index.d.ts'), 'export declare function oldTool(): void;\n')
  await write(join(pkg, 'lib/types/extra.d.mts'), 'export declare interface ExtraTool { old: true }\n')
  const upstreamPkg = await f.upstreamPackage('@deepseek-ai/dsh-tools', 'packages/core/tools')
  await write(join(upstreamPkg, 'src/index.ts'), f.executable + 'export function newTool() {}\n')
  await write(join(f.upstream, 'docs/user/develop/basic/tool.md'), '# New API\nNEW_CHECKOUT_ONLY\n')
  const report = await inspectDshKnowledge({ dshPath: f.entry, upstreamRoot: f.upstream, topic: 'tool' })
  assert.equal(report.installed.version, '0.1.1-rc.2')
  assert.equal(report.upstream.version, '0.1.5-rc.2')
  assert.equal(report.versionMismatch, true)
  assert.equal(report.ok, true, 'a version mismatch is evidence, not a lookup failure')
  assert.deepEqual(report.packageVersionMismatches, [
    { name: '@deepseek-ai/dsh-tools', installedVersion: '0.1.1-rc.2', upstreamVersion: '0.1.5-rc.2' },
  ])
  assert(report.warnings.some((warning) => warning.includes('does not describe the installed version')))
  const declarations = report.evidence.filter((item) => item.kind === 'declaration')
  assert.equal(declarations.length, 2)
  assert(declarations.every((item) => item.origin === 'installed' && item.packageVersion === '0.1.1-rc.2'))
  assert(report.evidence.some((item) => item.origin === 'installed' && item.excerpt.includes('oldTool')))
  assert(report.evidence.some((item) => item.origin === 'upstream' && item.excerpt.includes('newTool')))
  assert(report.missing.some((item) => item.origin === 'installed' && item.kind === 'source'))
  const installedOnly = await inspectDshKnowledge({ dshPath: f.entry, topic: 'tool' })
  assert.equal(installedOnly.upstream, null)
  assert(!JSON.stringify(installedOnly).includes('NEW_CHECKOUT_ONLY'))
  assert(!JSON.stringify(installedOnly).includes(COMMIT))
  await assert.rejects(access(f.marker), { code: 'ENOENT' })
  assert.equal(await readFile(f.entry, 'utf8'), f.executable)
})

test('reports owner version mismatches even when CLI and checkout versions match', async (t) => {
  const f = await fixture(t)
  await write(join(f.upstream, 'package.json'), { name: '@deepseek-ai/dsh-root', version: '0.1.1-rc.2' })
  await f.upstreamPackage('@deepseek-ai/cordis', 'vendor/cordis', { version: '4.1.0' })
  await f.installedPackage('@deepseek-ai/cordis', { version: '4.0.2' })
  const report = await inspectDshKnowledge({ dshPath: f.entry, upstreamRoot: f.upstream, topic: 'lifecycle' })
  assert.equal(report.versionMismatch, false)
  assert.deepEqual(report.packageVersionMismatches, [
    { name: '@deepseek-ai/cordis', installedVersion: '4.0.2', upstreamVersion: '4.1.0' },
  ])
  assert.match(formatDshKnowledgeReport(report), /Package version mismatch: @deepseek-ai\/cordis installed 4\.0\.2, checkout 4\.1\.0/u)
})

test('reports missing docs, packages and unknown commits without inventing evidence', async (t) => {
  const f = await fixture(t)
  await rm(join(f.upstream, '.git'), { recursive: true })
  // A similarly named page from an unselected location must not become evidence.
  await write(join(f.upstream, 'node_modules/current-master/docs/subsystems/core.md'), 'WRONG_SOURCE')
  const report = await inspectDshKnowledge({ upstreamRoot: f.upstream, topic: 'core' })
  assert.equal(report.upstream.commit, null)
  assert.deepEqual(report.evidence, [])
  assert.equal(report.ok, true, 'metadata-only retrieval succeeds with explicit omissions')
  assert.equal(report.kind, 'dsh-knowledge')
  assert(report.missing.some((item) => item.kind === 'documentation' && item.reason === 'not-found'))
  assert(report.missing.some((item) => item.kind === 'package' && item.reason === 'not-found'))
  const text = formatDshKnowledgeReport(report)
  assert.match(text, /commit unavailable/u)
  assert.match(text, /Unavailable in this bounded lookup/u)
  assert(!text.includes('WRONG_SOURCE'))
})

test('reads loose refs, packed refs and linked worktree identity without Git configuration', async (t) => {
  const f = await fixture(t)
  await write(join(f.upstream, '.git/HEAD'), 'ref: refs/heads/develop\n')
  await write(join(f.upstream, '.git/refs/heads/develop'), COMMIT + '\n')
  assert.equal((await inspectDshKnowledge({ upstreamRoot: f.upstream, topic: 'core' })).upstream.commit, COMMIT)
  await rm(join(f.upstream, '.git/refs'), { recursive: true })
  await write(join(f.upstream, '.git/packed-refs'), '# pack-refs with: peeled\n' + COMMIT + ' refs/heads/develop\n')
  assert.equal((await inspectDshKnowledge({ upstreamRoot: f.upstream, topic: 'core' })).upstream.commit, COMMIT)
  const common = join(f.root, 'git metadata')
  const worktreeGit = join(common, 'worktrees/feature')
  await write(join(worktreeGit, 'HEAD'), 'ref: refs/heads/feature\n')
  await write(join(worktreeGit, 'commondir'), '../..\n')
  await write(join(common, 'refs/heads/feature'), COMMIT + '\n')
  await rm(join(f.upstream, '.git'), { recursive: true })
  await write(join(f.upstream, '.git'), 'gitdir: ' + worktreeGit + '\n')
  assert.equal((await inspectDshKnowledge({ upstreamRoot: f.upstream, topic: 'core' })).upstream.commit, COMMIT)
  await write(join(worktreeGit, 'HEAD'), 'ref: refs/heads/../../../config\n')
  assert.equal((await inspectDshKnowledge({ upstreamRoot: f.upstream, topic: 'core' })).upstream.commit, null)
  await write(join(worktreeGit, 'HEAD'), 'ref: refs/heads/开发\n')
  await write(join(common, 'refs/heads/开发'), COMMIT + '\n')
  assert.equal((await inspectDshKnowledge({ upstreamRoot: f.upstream, topic: 'core' })).upstream.commit, COMMIT)
})

test('rejects escaping declarations, linked docs and config aliases', async (t) => {
  const f = await fixture(t)
  const pkg = await f.installedPackage('@deepseek-ai/dsh-tools', { types: '../secret.d.ts',
    exports: { './bad': { types: './config/secret.d.ts' } } })
  await write(join(dirname(pkg), 'secret.d.ts'), SECRET)
  await write(join(pkg, 'config/secret.d.ts'), SECRET)
  await write(join(pkg, 'src/.env.ts'), SECRET)
  await write(join(pkg, 'src/config/secrets.ts'), SECRET)
  const first = await inspectDshKnowledge({ dshPath: f.entry, topic: 'tool' })
  assert(!JSON.stringify(first).includes(SECRET))
  assert.equal(first.missing.filter((item) => item.reason === 'unsafe-declaration-path').length, 2)
  await mkdir(join(f.upstream, 'docs/subsystems'), { recursive: true })
  try {
    await symlink(join(pkg, 'config/secret.d.ts'), join(f.upstream, 'docs/subsystems/core.md'))
    await symlink(join(pkg, 'config/secret.d.ts'), join(pkg, 'README.md'))
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.diagnostic('File symlinks require Windows Developer Mode; non-symlink containment assertions passed.')
    throw error
  }
  const report = await inspectDshKnowledge({ dshPath: f.entry, upstreamRoot: f.upstream, topic: 'core' })
  assert(report.missing.some((item) => item.reason === 'symlink'))
  assert(!JSON.stringify(report).includes(SECRET))
  const tools = await inspectDshKnowledge({ dshPath: f.entry, topic: 'tool' })
  assert(tools.missing.some((item) => item.kind === 'readme' && item.reason === 'symlink'))
  assert(!JSON.stringify(tools).includes(SECRET))
})

test('bounds documents, metadata and directory exploration and rejects binary evidence', async (t) => {
  const f = await fixture(t)
  await write(join(f.upstream, 'docs/subsystems/core.md'), 'x'.repeat(256 * 1024 + 1))
  await write(join(f.upstream, 'docs/architecture.md'), Buffer.from([0xff, 0xfe, 0x00]))
  const pkg = await f.upstreamPackage('@deepseek-ai/dsh-agent', 'packages/core/agent')
  for (let n = 0; n < 205; n += 1) await write(join(pkg, 'src', `file-${n}.ts`), 'export const agent = true\n')
  const report = await inspectDshKnowledge({ upstreamRoot: f.upstream, topic: 'core' })
  assert(report.missing.some((item) => item.reason === 'file-size-limit'))
  assert.equal(report.ok, true, 'bounded omissions do not make a completed lookup fail')
  assert(report.missing.some((item) => item.reason === 'not-utf8'))
  assert(report.missing.some((item) => item.reason === 'directory-search-limit'))
  assert(report.usage.directoryEntries <= report.limits.packageEntries)
  assert(report.usage.readBytes <= report.limits.totalReadBytes)
  assert(report.evidence.length <= report.limits.evidenceFiles)
  assert(report.evidence.filter((item) => item.kind === 'source').length <= report.limits.sourcesPerPackage)
  assert(report.evidence.every((item) => item.excerpt.length <= report.limits.excerptChars))
  await write(join(f.upstream, 'package.json'), ' '.repeat(64 * 1024 + 1))
  await assert.rejects(inspectDshKnowledge({ upstreamRoot: f.upstream, topic: 'core' }),
    (error) => error.code === 'KNOWLEDGE_UPSTREAM_INVALID' && error.details.reason === 'file-size-limit')
})

test('rejects invalid inputs and respects cancellation before and during lookup', async (t) => {
  const f = await fixture(t)
  for (const topic of ['../configuration', 'toString', ['tool'], null]) {
    await assert.rejects(inspectDshKnowledge({ upstreamRoot: f.upstream, topic }), { code: 'KNOWLEDGE_TOPIC_INVALID' })
  }
  for (const upstreamRoot of ['', false, ['directory'], 'contains\0null']) {
    await assert.rejects(inspectDshKnowledge({ upstreamRoot }), { code: 'KNOWLEDGE_PATH_INVALID' })
  }
  await assert.rejects(inspectDshKnowledge({ dshPath: join(f.root, 'missing') }), { code: 'DSH_NOT_FOUND' })
  await write(join(f.root, 'random.js'), f.executable)
  await assert.rejects(inspectDshKnowledge({ dshPath: join(f.root, 'random.js') }), { code: 'DSH_PACKAGE_NOT_FOUND' })
  await write(join(f.upstream, 'package.json'), { name: 'unrelated-project', version: '1.0.0' })
  await assert.rejects(inspectDshKnowledge({ upstreamRoot: f.upstream }), { code: 'KNOWLEDGE_UPSTREAM_INVALID' })
  await assert.rejects(inspectDshKnowledge({ signal: AbortSignal.abort() }), { code: 'CANCELLED' })
  const controller = new AbortController()
  const pending = inspectDshKnowledge({ dshPath: f.entry, topic: 'tool', signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { code: 'CANCELLED' })
  await assert.rejects(access(f.marker), { code: 'ENOENT' })
})

test('the actual CLI exits zero for successful lookups with omitted evidence', async (t) => {
  const f = await fixture(t)
  const cli = fileURLToPath(new URL('../bin/dsh-developer.js', import.meta.url))
  const args = [cli, 'knowledge', '--dsh', f.entry]
  // runBounded checks the CLI child status directly; a downstream pipe must not
  // mask a nonzero exit from the command under test.
  const json = await runBounded(process.execPath, [...args, '--json'])
  assert.equal(json.exitCode, 0)
  const report = JSON.parse(json.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.kind, 'dsh-knowledge')
  assert.deepEqual(report.topics, ['tool'])
  assert.equal(report.evidence.length, 0)
  assert(report.missing.length > 0)
  const text = await runBounded(process.execPath, args)
  assert.equal(text.exitCode, 0)
  assert.match(text.stdout, /DSH knowledge: tool/u)
  assert.match(text.stdout, /Unavailable in this bounded lookup/u)
  await assert.rejects(access(f.marker), { code: 'ENOENT' })
})

test('pins the installed peer-service closure without resolving a newer prerelease from a registry', async t => {
  const f = await fixture(t)
  await f.installedPackage('@deepseek-ai/dsh-tools', { peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.1-rc.1' } })
  await f.installedPackage('@deepseek-ai/dsh-agent', { peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.1-rc.1' } })
  const report = await inspectDshKnowledge({ dshPath: f.entry, topic: 'tool' })
  assert.equal(report.development.complete, true)
  assert.deepEqual(report.development.dependencies, {
    '@deepseek-ai/dsh-tools': '0.1.1-rc.2', '@deepseek-ai/dsh-agent': '0.1.1-rc.2',
  })
  await f.installedPackage('@deepseek-ai/dsh-agent', { peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.5-rc.1' } })
  const mismatch = await inspectDshKnowledge({ dshPath: f.entry, topic: 'tool' })
  assert.equal(mismatch.development.complete, false)
  assert.equal(mismatch.development.missing[0].reason, 'installed-peer-range-mismatch')
})

test('pins the peer resolved by the selected consumer instead of a different CLI-level copy', async t => {
  const f = await fixture(t)
  const tools = '@deepseek-ai/dsh-tools', agent = '@deepseek-ai/dsh-agent'
  const pkg = await f.installedPackage(tools, { version: '1.0.0', peerDependencies: { [agent]: '*' } })
  await f.installedPackage(agent, { version: '1.0.0' })
  const nested = await f.installedPackage(agent, { version: '2.0.0' }, pkg)
  await write(join(pkg, 'index.js'), `import '${agent}';\n` + f.executable)
  const declaration = `export type { Agent } from '${agent}';\n`
  await write(join(pkg, 'lib/types/index.d.ts'), declaration)
  // Resolve the real import target without loading its executable sentinel.
  assert.equal(createRequire(join(pkg, 'index.js')).resolve(agent), join(nested, 'index.js'))
  assert.notEqual(createRequire(f.entry).resolve(agent), join(nested, 'index.js'))
  for (const selection of [{}, { packageName: tools }]) {
    const report = await inspectDshKnowledge({ dshPath: f.entry, ...selection })
    assert.equal(report.development.complete, true)
    assert.deepEqual(report.development.dependencies, { [tools]: '1.0.0', [agent]: '2.0.0' })
    assert.equal(report.development.root, pkg)
    assert.equal(report.development.manifestPath, join(pkg, 'package.json'))
    assert.equal(report.installed.packages.find(item => item.name === tools).root, pkg)
    assert(report.evidence.some(item => item.path === join(pkg, 'lib/types/index.d.ts') && item.excerpt === declaration))
  }
  await assert.rejects(access(f.marker), { code: 'ENOENT' })
})

test('refuses flat pins for conflicting consumer identities even when their versions match', async t => {
  for (const nestedVersion of ['2.0.0', '1.0.0']) {
    await t.test(nestedVersion, async t => {
      const f = await fixture(t)
      const tools = '@deepseek-ai/dsh-tools', agent = '@deepseek-ai/dsh-agent', session = '@deepseek-ai/dsh-session'
      const pkg = await f.installedPackage(tools, { version: '1.0.0', peerDependencies: { [agent]: '*', [session]: '*' } })
      const first = await f.installedPackage(agent, { version: '1.0.0' })
      const other = await f.installedPackage(session, { version: '1.0.0', peerDependencies: { [agent]: '*' } })
      const nested = await f.installedPackage(agent, { version: nestedVersion }, other)
      assert.equal(createRequire(join(pkg, 'index.js')).resolve(agent), join(first, 'index.js'))
      assert.equal(createRequire(join(other, 'index.js')).resolve(agent), join(nested, 'index.js'))
      const report = await inspectDshKnowledge({ dshPath: f.entry })
      assert.equal(report.development.complete, false)
      assert(!Object.hasOwn(report.development.dependencies, agent), 'a conflicting name has no honest flat pin')
      const conflict = report.development.missing.find(item => item.reason === 'installed-peer-identity-conflict')
      assert.equal(conflict.name, agent)
      assert.equal(conflict.consumer, session)
      assert.deepEqual(conflict.identities.map(item => [item.root, item.version]), [[first, '1.0.0'], [nested, nestedVersion]])
      assert.equal(report.development.root, pkg)
      assert.equal(report.development.usage.packages, 4)
      await assert.rejects(access(f.marker), { code: 'ENOENT' })
    })
  }
})

test('finds hoisted export-hidden peers beyond the installation helper’s sibling fallbacks', async t => {
  const f = await fixture(t)
  const tools = '@deepseek-ai/dsh-tools', agent = '@deepseek-ai/dsh-agent'
  const pkg = await f.installedPackage(tools, { version: '1.0.0', peerDependencies: { [agent]: '*' } })
  const hoisted = await f.installedPackage(agent, { version: '2.0.0' }, join(f.root, 'installation'))
  assert.equal(createRequire(join(pkg, 'index.js')).resolve(agent), join(hoisted, 'index.js'))
  assert.throws(() => createRequire(join(pkg, 'index.js')).resolve(agent + '/package.json'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
  const report = await inspectDshKnowledge({ dshPath: f.entry })
  assert.equal(report.development.complete, true)
  assert.deepEqual(report.development.dependencies, { [tools]: '1.0.0', [agent]: '2.0.0' })
  await assert.rejects(access(f.marker), { code: 'ENOENT' })
})

test('uses the actual package manifest when exports redirect package.json to different metadata', async t => {
  for (const target of ['./package.json', './decoy.json']) {
    await t.test(target, async t => {
      const f = await fixture(t)
      const tools = '@deepseek-ai/dsh-tools', agent = '@deepseek-ai/dsh-agent'
      const pkg = await f.installedPackage(tools, { version: '1.0.0', peerDependencies: { [agent]: '*' } })
      const nested = await f.installedPackage(agent, { version: '2.0.0', exports: {
        '.': './index.js', './package.json': target,
      } }, pkg)
      await write(join(nested, 'decoy.json'), { name: agent, version: '9.0.0' })
      assert.equal(createRequire(join(pkg, 'index.js')).resolve(agent + '/package.json'), join(nested, target))
      const report = await inspectDshKnowledge({ dshPath: f.entry })
      assert.equal(report.development.complete, true)
      assert.deepEqual(report.development.dependencies, { [tools]: '1.0.0', [agent]: '2.0.0' })
      await assert.rejects(access(f.marker), { code: 'ENOENT' })
    })
  }
})

test('preserves the selected root and evidence when another consumer resolves a conflicting root copy', async t => {
  const f = await fixture(t)
  const tools = '@deepseek-ai/dsh-tools', agent = '@deepseek-ai/dsh-agent'
  const pkg = await f.installedPackage(tools, { version: '1.0.0', peerDependencies: { [agent]: '*' } })
  const peer = await f.installedPackage(agent, { version: '1.0.0', peerDependencies: { [tools]: '*' } })
  const nested = await f.installedPackage(tools, { version: '2.0.0' }, peer)
  await write(join(pkg, 'lib/types/index.d.ts'), 'export declare function selectedTool(): void;\n')
  await write(join(nested, 'lib/types/index.d.ts'), 'export declare function otherTool(): void;\n')
  const report = await inspectDshKnowledge({ dshPath: f.entry, packageName: tools })
  assert.equal(report.development.complete, false)
  assert.equal(report.development.root, pkg)
  assert.equal(report.development.manifestPath, join(pkg, 'package.json'))
  assert.deepEqual(report.development.dependencies, { [agent]: '1.0.0' })
  assert.equal(report.installed.packages.find(item => item.name === tools).root, pkg)
  assert(report.evidence.some(item => item.excerpt.includes('selectedTool')))
  assert(!report.evidence.some(item => item.excerpt.includes('otherTool')))
  assert.equal(report.development.missing[0].reason, 'installed-peer-identity-conflict')
  await assert.rejects(access(f.marker), { code: 'ENOENT' })
})

test('does not replace missing or invalid nearest peer metadata with an unrelated valid copy', async t => {
  const tools = '@deepseek-ai/dsh-tools', agent = '@deepseek-ai/dsh-agent'
  const cases = [
    ['missing manifest', undefined], ['malformed JSON', '{'], ['non-object JSON', 'null'],
    ['wrong package identity', { name: '@deepseek-ai/wrong', version: '2.0.0' }],
    ['nonexact version', { name: agent, version: '^2.0.0' }],
  ]
  for (const [label, manifest] of cases) {
    await t.test(label, async t => {
      const f = await fixture(t)
      const pkg = await f.installedPackage(tools, { version: '1.0.0', peerDependencies: { [agent]: '*' } })
      await f.installedPackage(agent, { version: '1.0.0' })
      const nested = await f.installedPackage(agent, { version: '2.0.0' }, pkg)
      if (manifest === undefined) await rm(join(nested, 'package.json'))
      else await write(join(nested, 'package.json'), manifest)
      const report = await inspectDshKnowledge({ dshPath: f.entry })
      assert.equal(report.development.complete, false)
      assert.deepEqual(report.development.dependencies, { [tools]: '1.0.0' })
      assert.deepEqual(report.development.missing, [{ name: agent, consumer: tools, reason: 'exact-installed-version-unavailable' }])
      await assert.rejects(access(f.marker), { code: 'ENOENT' })
    })
  }
})

test('resolves linked consumers from their physical roots and coalesces links to one peer identity', async t => {
  const f = await fixture(t)
  const tools = '@deepseek-ai/dsh-tools', agent = '@deepseek-ai/dsh-agent', session = '@deepseek-ai/dsh-session'
  const pkg = await f.upstreamPackage(tools, 'packages/tools', { version: '1.0.0', peerDependencies: { [agent]: '*' } })
  // Neither this arbitrary sibling nor the CLI copy belongs to pkg's local
  // dependency graph. An inherited NODE_PATH must not supply a replacement.
  await f.upstreamPackage(agent, 'packages/dsh-agent', { version: '2.0.0' })
  await f.installedPackage(agent, { version: '1.0.0' })
  const toolsLink = join(f.installed, 'node_modules', ...tools.split('/'))
  await mkdir(dirname(toolsLink), { recursive: true })
  try { await symlink(pkg, toolsLink, 'junction') } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Directory symlink unavailable.')
    throw error
  }
  const missing = await inspectDshKnowledge({ dshPath: f.entry })
  assert.equal(missing.development.root, pkg)
  assert.equal(missing.development.complete, false)
  assert.deepEqual(missing.development.dependencies, { [tools]: '1.0.0' })

  const peer = await f.installedPackage(agent, { version: '2.0.0' }, pkg)
  await write(join(pkg, 'package.json'), { name: tools, version: '1.0.0', peerDependencies: { [agent]: '*', [session]: '*' } })
  const second = await f.installedPackage(session, { version: '1.0.0', peerDependencies: { [agent]: '*' } }, pkg)
  const peerLink = join(second, 'node_modules', ...agent.split('/'))
  await mkdir(dirname(peerLink), { recursive: true })
  await symlink(peer, peerLink, 'junction')
  assert.equal(createRequire(join(second, 'index.js')).resolve(agent), join(peer, 'index.js'))
  const shared = await inspectDshKnowledge({ dshPath: f.entry })
  assert.equal(shared.development.complete, true)
  assert.deepEqual(shared.development.dependencies, { [tools]: '1.0.0', [agent]: '2.0.0', [session]: '1.0.0' })
  assert.equal(shared.development.usage.packages, 3)
  // A link with another name must not borrow an already cached package identity.
  const alias = '@deepseek-ai/dsh-agent-alias'
  await symlink(peer, join(pkg, 'node_modules', ...alias.split('/')), 'junction')
  await write(join(pkg, 'package.json'), { name: tools, version: '1.0.0', peerDependencies: { [agent]: '*', [alias]: '*' } })
  const wrongIdentity = await inspectDshKnowledge({ dshPath: f.entry })
  assert.equal(wrongIdentity.development.complete, false)
  assert(!Object.hasOwn(wrongIdentity.development.dependencies, alias))
  assert(wrongIdentity.development.missing.some(item => item.name === alias && item.reason === 'exact-installed-version-unavailable'))
  await assert.rejects(access(f.marker), { code: 'ENOENT' })
})

test('focuses an exact package beyond topic owners and follows a named type-only import separately', async t => {
  const f = await fixture(t)
  const name = '@deepseek-ai/dsh-custom-view'
  const peer = '@deepseek-ai/dsh-view-service'
  const imported = '@deepseek-ai/dsh-view-types'
  const directory = 'extensions/views/custom'
  const pkg = await f.installedPackage(name, {
    version: '0.1.5-rc.1', repository: { directory }, peerDependencies: { [peer]: '^0.1.5-rc.1' },
  })
  await f.installedPackage(peer, { version: '0.1.5-rc.2' })
  const typesPkg = await f.installedPackage(imported, { peerDependencies: { [peer]: '^0.1.5-rc.1' } })
  const declaration = `export type { View } from '${imported}';\nexport declare function renderView(): void;\n`
  await write(join(pkg, 'lib/types/index.d.ts'), declaration)
  await write(join(typesPkg, 'lib/types/index.d.ts'), 'export interface View { title: string }\n')
  const upstreamPkg = await f.upstreamPackage(name, directory)
  await write(join(upstreamPkg, 'src/index.ts'), 'export function renderView() {}\n')
  const other = await f.installedPackage('@deepseek-ai/dsh-client-ui-renderer')
  await write(join(other, 'README.md'), 'UNSELECTED_RENDERER')
  const report = await inspectDshKnowledge({ dshPath: f.entry, upstreamRoot: f.upstream, topic: 'ui', packageName: name })
  assert.equal(report.packageName, name)
  assert.equal(report.development.rootPackage, name)
  assert.equal(report.development.root, pkg)
  assert.equal(report.development.manifestPath, join(pkg, 'package.json'))
  assert.deepEqual(report.development.dependencies, { [name]: '0.1.5-rc.1', [peer]: '0.1.5-rc.2' })
  assert.equal(report.development.complete, true)
  assert.match(report.development.scope, /Type-only imports.*not discovered/u)
  const identity = report.installed.packages.find(item => item.name === name)
  assert.equal(identity.root, report.development.root)
  assert.equal(identity.version, report.development.dependencies[name])
  assert.equal(report.upstream.packages[0].root, upstreamPkg)
  assert.equal(report.upstream.packages.length, 1)
  const item = report.evidence.find(item => item.kind === 'declaration')
  assert.equal(item.packageName, name)
  assert.equal(item.path, join(pkg, 'lib/types/index.d.ts'))
  assert.equal(item.sha256, createHash('sha256').update(declaration).digest('hex'))
  assert.equal(item.startLine, 1)
  assert.equal(item.excerpt, declaration)
  assert(report.evidence.filter(item => item.origin === 'installed').every(item => item.packageName === name))
  assert(!JSON.stringify(report).includes('UNSELECTED_RENDERER'))
  assert(!Object.hasOwn(report.development.dependencies, imported))
  assert(formatDshKnowledgeReport(report).includes('Selected package: ' + name))

  const follow = await inspectDshKnowledge({ dshPath: f.entry, packageName: imported })
  assert.deepEqual(follow.topics, ['tool'], 'package selection preserves the default topic')
  assert.equal(follow.development.rootPackage, imported)
  assert.deepEqual(follow.development.dependencies, { [imported]: '0.1.1-rc.2', [peer]: '0.1.5-rc.2' })
  assert(follow.evidence.some(item => item.path === join(typesPkg, 'lib/types/index.d.ts')))
  await assert.rejects(access(f.marker), { code: 'ENOENT' })
})

test('reports missing exact packages and unknown source owners without guessing a checkout path', async t => {
  const f = await fixture(t)
  const name = '@deepseek-ai/dsh-unknown'
  const guessingTrap = await f.upstreamPackage(name, 'packages/dsh-unknown')
  await write(join(guessingTrap, 'src/index.ts'), SECRET)
  const installed = await inspectDshKnowledge({ dshPath: f.entry, packageName: name })
  assert.equal(installed.packageName, name)
  assert.equal(installed.development.rootPackage, name)
  assert.equal(installed.development.root, null)
  assert.equal(installed.development.complete, false)
  assert.deepEqual(installed.development.dependencies, {})
  assert(installed.missing.some(item => item.packageName === name && item.reason === 'package-not-installed'))

  const sourceOnly = await inspectDshKnowledge({ upstreamRoot: f.upstream, packageName: name })
  assert.equal(sourceOnly.installed, null)
  assert.equal(sourceOnly.development, null)
  assert.equal(sourceOnly.usage.directoryEntries, 0)
  assert(sourceOnly.missing.some(item => item.packageName === name && item.reason === 'source-owner-unavailable'))
  assert(!JSON.stringify(sourceOnly).includes(SECRET))

  await f.installedPackage(name)
  const noOwner = await inspectDshKnowledge({ dshPath: f.entry, upstreamRoot: f.upstream, packageName: name })
  assert(noOwner.missing.some(item => item.origin === 'upstream' && item.reason === 'source-owner-unavailable'))
  const known = await f.upstreamPackage('@deepseek-ai/dsh-session', 'packages/core/session')
  await write(join(known, 'src/index.ts'), 'export class Session {}\n')
  const mapped = await inspectDshKnowledge({ upstreamRoot: f.upstream, packageName: '@deepseek-ai/dsh-session' })
  assert.equal(mapped.installed, null)
  assert.deepEqual(mapped.upstream.packages.map(item => item.root), [known])
})

test('rejects package specs, subpaths and invalid names before local target discovery', async () => {
  for (const packageName of [null, false, [], {}, '', 'dsh-tools', '@other/dsh-tools',
    '@deepseek-ai/', '@deepseek-ai/..', '@deepseek-ai/../secret', '@deepseek-ai/dsh-tools/types',
    '@deepseek-ai/dsh-tools@0.1.5-rc.1', '@deepseek-ai/DSH-tools', '@deepseek-ai/dsh tools',
    '@deepseek-ai/dsh-tools\n', '@deepseek-ai/dsh-tools\0', '@deepseek-ai/dsh\\tools', '@deepseek-ai/' + 'a'.repeat(202)]) {
    await assert.rejects(inspectDshKnowledge({ dshPath: '/missing/dsh', packageName }), { code: 'KNOWLEDGE_PACKAGE_INVALID' })
  }
})

test('selects an unmapped source package from its directory or file and prioritizes that file', async t => {
  const f = await fixture(t)
  const name = '@deepseek-ai/dsh-client-ui-layout'
  const pkg = await f.upstreamPackage(name, 'packages/client/ui-layout')
  for (const file of ['index.ts', 'a.ts', 'b.ts', 'z-layout.ts']) {
    await write(join(pkg, 'src', file), 'export const layout = ' + JSON.stringify(file) + '\n')
  }
  const selectedFile = join(pkg, 'src', 'z-layout.ts')
  await write(join(pkg, 'tests', 'layout.test.ts'), "test('switching sessions closes the details pane', () => {})\n")
  await write(join(pkg, 'tests', 'a.test.ts'), "test('unrelated alphabetically earlier test', () => {})\n")
  await write(join(pkg, 'tests', 'z-layout.client.spec.ts'), "test('selected layout behavior', () => {})\n")
  // Installed metadata must not override an explicit source selection.
  await f.installedPackage(name, { repository: { directory: 'old/layout' } })
  for (const upstreamRoot of [pkg, join(pkg, 'src'), selectedFile, join(pkg, 'package.json')]) {
    const report = await inspectDshKnowledge({ upstreamRoot, topic: 'ui' })
    assert.equal(report.packageName, name)
    assert.equal(report.upstream.root, f.upstream)
    assert.equal(report.upstream.requested, upstreamRoot)
    assert.equal(report.upstream.commit, COMMIT)
    assert.deepEqual(report.upstream.packages.map(item => item.root), [pkg])
    assert(report.evidence.some(item => item.kind === 'test'))
    assert.equal(report.installed, null)
    if (upstreamRoot === selectedFile) {
      const sources = report.evidence.filter(item => item.kind === 'source')
      assert.equal(sources[0].path, selectedFile)
      assert.equal(sources.length, report.limits.sourcesPerPackage)
      const tests = report.evidence.filter(item => item.kind === 'test')
      assert.equal(tests[0].path, join(pkg, 'tests', 'z-layout.client.spec.ts'))
      assert.equal(tests.length, report.limits.testsPerPackage)
      assert(report.missing.some(item => item.reason === 'source-excerpt-limit'))
      assert(report.missing.some(item => item.reason === 'test-excerpt-limit'))
    }
  }
  const combined = await inspectDshKnowledge({ dshPath: f.entry, upstreamRoot: selectedFile, topic: 'ui' })
  assert.equal(combined.development.rootPackage, name)
  assert.equal(combined.upstream.packages[0].root, pkg)
  assert.equal(combined.packageVersionMismatches[0].name, name)
  const matching = await inspectDshKnowledge({ upstreamRoot: selectedFile, packageName: name })
  assert.equal(matching.upstream.packages[0].root, pkg)
  const selectedTest = join(pkg, 'tests', 'z-selected.test.ts')
  await write(selectedTest, "test('explicit selected regression', () => {})\n")
  await write(join(pkg, 'tests', 'a.test.ts'), "test('another test', () => {})\n")
  const testReport = await inspectDshKnowledge({ upstreamRoot: selectedTest })
  const tests = testReport.evidence.filter(item => item.kind === 'test')
  assert.equal(tests[0].path, selectedTest)
  assert.equal(tests.length, testReport.limits.testsPerPackage)
  await assert.rejects(inspectDshKnowledge({ upstreamRoot: pkg, packageName: '@deepseek-ai/dsh-tools' }),
    { code: 'KNOWLEDGE_PACKAGE_CONFLICT' })
  await assert.rejects(access(f.marker), { code: 'ENOENT' })
})

test('charges source-selection manifests once to the evidence budget and bounds ancestor search', async t => {
  const f = await fixture(t)
  const pkg = await f.upstreamPackage('@deepseek-ai/dsh-budget', 'packages/budget')
  const source = join(pkg, 'src/index.ts')
  await write(source, 'export const bounded = true\n')
  const report = await inspectDshKnowledge({ upstreamRoot: source })
  const files = [join(f.upstream, 'package.json'), join(pkg, 'package.json'), join(f.upstream, '.git/HEAD'), source]
  const bytes = await Promise.all(files.map(path => readFile(path)))
  assert.equal(report.usage.readBytes, bytes.reduce((total, buffer) => total + buffer.length, 0))
  const deep = join(pkg, ...Array(report.limits.ancestorDirectories).fill('d'))
  await mkdir(deep, { recursive: true })
  await assert.rejects(inspectDshKnowledge({ upstreamRoot: deep }),
    error => error.code === 'KNOWLEDGE_UPSTREAM_INVALID' && error.details.reason === 'ancestor-search-limit')
})

test('source selection respects workspace and nested-repository boundaries and rejects unsafe nearest metadata', async t => {
  const f = await fixture(t)
  const pkg = await f.upstreamPackage('@deepseek-ai/dsh-selection', 'packages/selection')
  await write(join(pkg, 'src/index.ts'), 'export const safe = true\n')
  const inside = await inspectDshKnowledge({ upstreamRoot: 'packages/selection/src/index.ts', sourceRoot: f.upstream })
  assert.equal(inside.upstream.root, f.upstream)
  await assert.rejects(inspectDshKnowledge({ upstreamRoot: join(pkg, 'src/index.ts'), sourceRoot: join(pkg, 'src/index.ts') }),
    error => error.code === 'KNOWLEDGE_UPSTREAM_INVALID' && error.details.reason === 'outside-workspace')
  await assert.rejects(inspectDshKnowledge({ upstreamRoot: pkg, sourceRoot: pkg }),
    error => error.code === 'KNOWLEDGE_UPSTREAM_INVALID' && error.details.reason === 'checkout-not-found')
  await assert.rejects(inspectDshKnowledge({ upstreamRoot: f.upstream, sourceRoot: pkg }),
    error => error.code === 'KNOWLEDGE_UPSTREAM_INVALID' && error.details.reason === 'outside-workspace')
  await write(join(pkg, '.git'), 'gitdir: /outside\n')
  await assert.rejects(inspectDshKnowledge({ upstreamRoot: join(pkg, 'src/index.ts') }), { code: 'KNOWLEDGE_UPSTREAM_INVALID' })
  await rm(join(pkg, '.git'))
  await write(join(pkg, 'package.json'), '{')
  await assert.rejects(inspectDshKnowledge({ upstreamRoot: pkg }),
    error => error.code === 'KNOWLEDGE_UPSTREAM_INVALID' && error.details.reason === 'invalid-manifest')
  await write(join(pkg, 'package.json'), { name: ['@deepseek-ai/dsh-selection'] })
  await assert.rejects(inspectDshKnowledge({ upstreamRoot: pkg }), { code: 'KNOWLEDGE_UPSTREAM_INVALID' })
  const hidden = await f.upstreamPackage('@deepseek-ai/dsh-selection', 'node_modules/hidden')
  await write(join(hidden, 'src/index.ts'), SECRET)
  await assert.rejects(inspectDshKnowledge({ upstreamRoot: hidden }), { code: 'KNOWLEDGE_UPSTREAM_INVALID' })
  const link = join(pkg, 'outside')
  await symlink(f.upstream, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(inspectDshKnowledge({ upstreamRoot: link, sourceRoot: pkg }),
    error => error.code === 'KNOWLEDGE_UPSTREAM_INVALID' && error.details.reason === 'outside-workspace')
})

test('CLI and native knowledge preserve a source-file selection inside the Agent workspace', async t => {
  const f = await fixture(t)
  const pkg = await f.upstreamPackage('@deepseek-ai/dsh-navigation', 'packages/navigation')
  const source = join(pkg, 'src/index.ts')
  await write(source, 'export function navigateNativeSource() {}\n')
  const cli = fileURLToPath(new URL('../bin/dsh-developer.js', import.meta.url))
  const result = await runBounded(process.execPath, [cli, 'knowledge', '--upstream', source, '--topic', 'core', '--json'])
  const report = JSON.parse(result.stdout)
  assert.equal(report.upstream.root, f.upstream)
  assert.equal(report.packageName, '@deepseek-ai/dsh-navigation')
  assert(report.evidence.some(item => item.path === source))
  const previousEntry = process.argv[1]
  process.argv[1] = f.entry
  t.after(() => { process.argv[1] = previousEntry })
  let definition
  registerNativeToolWithDependencies({
    tools: { register(value) { definition = value }, guard() {}, schemas() { return [] } },
    agents: { *roots() {} }, authoritySources: {}, onToolsPreExecute() {}, onToolsResult() {}, effect() {},
  })
  const invocation = { agent: { session: { header: { cwd: f.upstream } } }, signal: new AbortController().signal }
  const native = await definition.execute({ operation: 'knowledge', source: relative(f.upstream, source), topic: 'core' }, invocation)
  assert.equal(native.report.upstream.root, f.upstream)
  assert.equal(native.report.packageName, report.packageName)
  assert(native.report.evidence.some(item => item.path === source))
  await assert.rejects(definition.execute({ operation: 'knowledge', source: f.upstream },
    { ...invocation, agent: { session: { header: { cwd: pkg } } } }), { code: 'KNOWLEDGE_UPSTREAM_INVALID' })

  const installed = await f.installedPackage('@deepseek-ai/dsh-navigation')
  await write(join(installed, 'lib/types/index.d.ts'), 'export declare function installedNavigation(): void;\n')
  await assert.rejects(definition.execute({ operation: 'knowledge', source: installed }, invocation), error => {
    assert.equal(error.code, 'KNOWLEDGE_UPSTREAM_INVALID')
    assert.equal(error.details.reason, 'outside-workspace')
    assert.match(error.message, /omit source \(CLI --upstream\).*packageName \(CLI --package\)/u)
    assert(!error.message.includes(installed), 'the recovery does not echo untrusted selections')
    return true
  })
  const recovered = await definition.execute({ operation: 'knowledge', packageName: '@deepseek-ai/dsh-navigation' }, invocation)
  assert.equal(recovered.report.upstream, null)
  assert(recovered.report.installed.packages.some(item => item.root === installed))
  assert(recovered.report.evidence.some(item => item.excerpt.includes('installedNavigation')))
  await assert.rejects(access(f.marker), { code: 'ENOENT' })
})

test('confines custom repository directories and verifies source package identity', async t => {
  const f = await fixture(t)
  const name = '@deepseek-ai/dsh-owner-test'
  const outside = await f.upstreamPackage(name, '../outside-owner')
  await write(join(outside, 'src/index.ts'), SECRET)
  for (const directory of ['../outside-owner', 'packages/../../outside-owner', outside,
    'C:/outside-owner', 'C:\\outside-owner', '.private/owner', 'node_modules/owner', '.', '', null, 42]) {
    await f.installedPackage(name, { repository: { directory } })
    const report = await inspectDshKnowledge({ dshPath: f.entry, upstreamRoot: f.upstream, packageName: name })
    assert(report.missing.some(item => item.origin === 'upstream' && item.reason === 'unsafe-repository-directory'), String(directory))
    assert.equal(report.upstream.packages.length, 0)
    assert(!JSON.stringify(report).includes(SECRET))
  }
  const wrong = await f.upstreamPackage('@deepseek-ai/different-owner', 'extensions/mismatch')
  await write(join(wrong, 'src/index.ts'), SECRET)
  await f.installedPackage(name, { repository: { directory: 'extensions/mismatch' } })
  const mismatch = await inspectDshKnowledge({ dshPath: f.entry, upstreamRoot: f.upstream, packageName: name })
  assert(mismatch.missing.some(item => item.reason === 'package-name-mismatch'))
  assert(!JSON.stringify(mismatch).includes(SECRET))
  try { await symlink(outside, join(f.upstream, 'linked-owner'), 'junction') } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.diagnostic('Directory symlink unavailable; lexical and identity checks passed.')
    throw error
  }
  await f.installedPackage(name, { repository: { directory: 'linked-owner' } })
  const linked = await inspectDshKnowledge({ dshPath: f.entry, upstreamRoot: f.upstream, packageName: name })
  assert(linked.missing.some(item => item.reason === 'symlink'))
  assert(!JSON.stringify(linked).includes(SECRET))
})

test('confines declarations of explicitly selected packages to their own physical root', async t => {
  const f = await fixture(t)
  const name = '@deepseek-ai/dsh-custom-types'
  const pkg = await f.installedPackage(name, { types: '../outside.d.ts', exports: {
    './local': { types: './types/local.d.ts' }, './config': { types: './config/secret.d.ts' },
  } })
  await write(join(dirname(pkg), 'outside.d.ts'), SECRET)
  await write(join(pkg, 'config/secret.d.ts'), SECRET)
  await write(join(pkg, 'types/local.d.ts'), 'export interface Local {}\n')
  const report = await inspectDshKnowledge({ dshPath: f.entry, packageName: name })
  assert.deepEqual(report.evidence.map(item => item.path), [join(pkg, 'types/local.d.ts')])
  assert.equal(report.missing.filter(item => item.reason === 'unsafe-declaration-path').length, 2)
  assert(!JSON.stringify(report).includes(SECRET))
  await assert.rejects(access(f.marker), { code: 'ENOENT' })
})

test('checks every custom-package peer range with npm prerelease semantics, including cycles', async t => {
  const f = await fixture(t)
  const name = '@deepseek-ai/dsh-peer-root'
  const peer = '@deepseek-ai/dsh-peer-child'
  await f.installedPackage(name, { version: '0.1.5-rc.1', peerDependencies: { [peer]: '^0.1.5-rc.1' } })
  await f.installedPackage(peer, { version: '0.1.5-rc.2', peerDependencies: { [name]: '^0.1.5-rc.1' } })
  const good = await inspectDshKnowledge({ dshPath: f.entry, packageName: name })
  assert.equal(good.development.complete, true)
  assert.equal(good.development.usage.packages, 2)
  for (const range of ['^0.1.5', '^0.1.6-rc.1', 'not-a-range', 42]) {
    await f.installedPackage(peer, { version: '0.1.5-rc.2', peerDependencies: { [name]: range } })
    const mismatch = await inspectDshKnowledge({ dshPath: f.entry, packageName: name })
    assert.equal(mismatch.development.complete, false)
    assert.deepEqual(mismatch.development.missing, [{ name, consumer: peer, reason: 'installed-peer-range-mismatch' }])
  }
})

test('marks malformed peer metadata and nonexact versions incomplete without following unsafe names', async t => {
  const f = await fixture(t)
  const name = '@deepseek-ai/dsh-invalid-peers'
  for (const peerDependencies of [null, [], 'not-a-map']) {
    await f.installedPackage(name, { peerDependencies })
    const report = await inspectDshKnowledge({ dshPath: f.entry, packageName: name })
    assert.equal(report.development.complete, false)
    assert.equal(report.development.missing[0].reason, 'invalid-peer-dependencies')
  }
  await f.installedPackage(name, { peerDependencies: { ['@deepseek-ai/../' + SECRET]: '*' } })
  const unsafe = await inspectDshKnowledge({ dshPath: f.entry, packageName: name })
  assert.equal(unsafe.development.complete, false)
  assert.equal(unsafe.development.missing[0].reason, 'invalid-peer-package-name')
  assert(!JSON.stringify(unsafe).includes(SECRET))
  assert.equal(unsafe.development.usage.packages, 1)
  for (const version of ['v0.1.5-rc.1', '^0.1.5-rc.1', '', null]) {
    await f.installedPackage(name, { version })
    const report = await inspectDshKnowledge({ dshPath: f.entry, packageName: name })
    assert.equal(report.development.complete, false)
    assert.deepEqual(report.development.dependencies, {})
    assert.equal(report.development.missing[0].reason, 'exact-installed-version-unavailable')
  }
})

test('allows peer closures beyond 32 packages while bounding packages and edges', async t => {
  const f = await fixture(t)
  const name = n => '@deepseek-ai/dsh-closure-' + n
  for (let n = 0; n < 52; n += 1) {
    await f.installedPackage(name(n), { peerDependencies: n < 51 ? { [name(n + 1)]: '^0.1.1-rc.1' } : {} })
  }
  const complete = await inspectDshKnowledge({ dshPath: f.entry, packageName: name(0) })
  assert.equal(complete.development.complete, true)
  assert.equal(Object.keys(complete.development.dependencies).length, 52)
  assert.equal(complete.development.usage.edges, 51)
  for (let n = 51; n <= complete.limits.developmentPackages; n += 1) {
    await f.installedPackage(name(n), { peerDependencies: { [name(n + 1)]: '^0.1.1-rc.1' } })
  }
  const capped = await inspectDshKnowledge({ dshPath: f.entry, packageName: name(0) })
  assert.equal(capped.development.complete, false)
  assert.equal(capped.development.usage.packages, capped.limits.developmentPackages)
  assert(capped.development.missing.some(item => item.reason === 'peer-closure-limit'))
  await f.installedPackage(name(capped.limits.developmentPackages - 1), { peerDependencies: { [name(0)]: '^0.1.1-rc.1' } })
  const exactBound = await inspectDshKnowledge({ dshPath: f.entry, packageName: name(0) })
  assert.equal(exactBound.development.complete, true, 'a cycle at the package bound needs no further manifest reads')
  assert.equal(exactBound.development.usage.packages, exactBound.limits.developmentPackages)
  const dense = Object.fromEntries(Array.from({ length: 24 }, (_, n) => [name(n), '^0.1.1-rc.1']))
  for (let n = 0; n < 24; n += 1) await f.installedPackage(name(n), { peerDependencies: dense })
  const edgeCap = await inspectDshKnowledge({ dshPath: f.entry, packageName: name(0) })
  assert.equal(edgeCap.development.complete, false)
  assert.equal(edgeCap.development.usage.edges, edgeCap.limits.developmentEdges)
  assert(edgeCap.development.missing.some(item => item.reason === 'peer-edge-limit'))
  assert(edgeCap.usage.readBytes <= edgeCap.limits.totalReadBytes)
})

test('all identity manifests share the read budget regardless of export visibility', async t => {
  for (const hidden of [false, true]) await t.test(hidden ? 'hidden' : 'exported', async t => {
    const f = await fixture(t)
    const name = i => '@deepseek-ai/bounded-peer-' + i
    const manifests = new Map()
    for (let i = 0; i < 12; i++) {
      const root = await f.installedPackage(name(i), {
        version: '1.0.0', description: 'a'.repeat(800 * 1024),
        peerDependencies: i < 11 ? { [name(i + 1)]: '*' } : {},
        exports: hidden ? { '.': './index.js' } : { '.': './index.js', './package.json': './package.json' },
      })
      manifests.set(name(i), await readFile(join(root, 'package.json')))
    }
    const report = await inspectDshKnowledge({ dshPath: f.entry, packageName: name(0) })
    assert.equal(report.development.complete, false)
    assert(report.development.missing.some(item => item.reason === 'total-read-limit'))
    assert(report.warnings.some(item => item.includes('inspection limit')))
    const inspected = Object.keys(report.development.dependencies)
    assert(inspected.length < 12)
    const expectedBytes = (await readFile(join(f.installed, 'package.json'))).length
      + inspected.reduce((sum, name) => sum + manifests.get(name).length, 0)
    assert.equal(report.usage.readBytes, expectedBytes)
    assert(report.usage.readBytes <= report.limits.totalReadBytes)
    assert(report.usage.readBytes > 6 * 1024 * 1024)
  })
})

test('follows an import from its physical consumer through library, CLI and native lookup', async t => {
  const f = await fixture(t)
  const tools = '@deepseek-ai/dsh-tools', agent = '@deepseek-ai/dsh-agent'
  const consumer = await f.installedPackage(tools, { version: '1.0.0', peerDependencies: { [agent]: '*' } })
  const nested = await f.installedPackage(agent, { version: '1.0.0' }, consumer)
  const outer = await f.installedPackage(agent, { version: '2.0.0' })
  await write(join(consumer, 'lib/types/index.d.ts'), `export { Agent } from '${agent}';\n`)
  await write(join(nested, 'lib/types/index.d.ts'), 'export interface Agent { oldId: string }\n')
  await write(join(outer, 'lib/types/index.d.ts'), 'export interface Agent { newId: number }\n')
  const initial = await inspectDshKnowledge({ dshPath: f.entry, packageName: tools })
  assert.equal(initial.development.dependencies[agent], '1.0.0')
  assert.equal((await inspectDshKnowledge({ dshPath: f.entry, packageName: agent })).development.dependencies[agent], '2.0.0')
  function check(report) {
    assert.equal(report.development.dependencies[agent], '1.0.0')
    assert.equal(report.resolution.consumerRoot, consumer)
    assert.equal(report.resolution.consumerManifestPath, join(consumer, 'package.json'))
    assert.equal(report.resolution.consumerName, tools)
    assert.equal(report.resolution.consumerVersion, '1.0.0')
    assert(report.evidence.some(item => item.packageVersion === '1.0.0' && item.excerpt.includes('oldId')))
    assert(!report.evidence.some(item => item.excerpt.includes('newId')))
    assert.match(formatDshKnowledgeReport(report), /Resolve imports from:/u)
  }
  check(await inspectDshKnowledge({ dshPath: f.entry, packageName: agent, consumerRoot: consumer }))
  const cli = fileURLToPath(new URL('../bin/dsh-developer.js', import.meta.url))
  const output = await runBounded(process.execPath, [cli, 'knowledge', '--dsh', f.entry,
    '--package', agent, '--consumer-root', consumer, '--json'])
  check(JSON.parse(output.stdout))
  const previousEntry = process.argv[1]
  process.argv[1] = f.entry
  t.after(() => { process.argv[1] = previousEntry })
  let definition
  registerNativeToolWithDependencies({
    tools: { register(value) { definition = value }, guard() {}, schemas() { return [] } },
    agents: { *roots() {} }, authoritySources: {}, onToolsPreExecute() {}, onToolsResult() {}, effect() {},
  })
  const invocation = { agent: { session: { header: { cwd: f.root } } }, signal: new AbortController().signal }
  for (const consumerRoot of [consumer, relative(f.root, consumer)]) {
    check((await definition.execute({ operation: 'knowledge', packageName: agent, consumerRoot }, invocation)).report)
  }
  const alias = join(f.root, 'consumer-link')
  try { await symlink(consumer, alias, 'junction') } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.diagnostic('Directory symlink unavailable; direct consumer checks passed.')
    throw error
  }
  check(await inspectDshKnowledge({ dshPath: f.entry, packageName: agent, consumerRoot: alias }))
  // A bad nearest manifest must not cause the explicit consumer to fall back
  // to the valid, different version available from DSH itself.
  await write(join(nested, 'package.json'), '{')
  const broken = await inspectDshKnowledge({ dshPath: f.entry, packageName: agent, consumerRoot: alias })
  assert.equal(broken.development.complete, false)
  assert.equal(broken.evidence.length, 0)
  await assert.rejects(access(f.marker), { code: 'ENOENT' })
})

test('consumer basis requires an installed package query and ordinary package metadata', async t => {
  const f = await fixture(t)
  const packageName = '@deepseek-ai/dsh-agent'
  await assert.rejects(inspectDshKnowledge({ dshPath: f.entry, consumerRoot: f.installed }), { code: 'KNOWLEDGE_CONSUMER_INVALID' })
  await assert.rejects(inspectDshKnowledge({ upstreamRoot: f.upstream, packageName, consumerRoot: f.installed }), { code: 'KNOWLEDGE_CONSUMER_INVALID' })
  await assert.rejects(inspectDshKnowledge({ dshPath: f.entry, packageName, consumerRoot: f.root }), { code: 'KNOWLEDGE_CONSUMER_INVALID' })
  await assert.rejects(inspectDshKnowledge({ dshPath: f.entry, packageName, consumerRoot: '' }), { code: 'KNOWLEDGE_PATH_INVALID' })
  const plugin = join(f.root, 'ordinary-plugin')
  await write(join(plugin, 'package.json'), { name: 'my-plugin', version: '1.0.0' })
  await f.installedPackage(packageName, { version: '3.0.0' }, plugin)
  const report = await inspectDshKnowledge({ dshPath: f.entry, packageName, consumerRoot: plugin })
  assert.equal(report.development.dependencies[packageName], '3.0.0')
  assert.equal(report.resolution.consumerName, 'my-plugin')
  await write(join(plugin, 'package.json'), { name: ['my-plugin'] })
  await assert.rejects(inspectDshKnowledge({ dshPath: f.entry, packageName, consumerRoot: plugin }), { code: 'KNOWLEDGE_CONSUMER_INVALID' })
})
