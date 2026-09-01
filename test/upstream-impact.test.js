import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { scanOrdinaryTree } from '../lib/files.js'
import { formatUpstreamImpactReport, inspectUpstreamImpact } from '../lib/upstream-impact.js'
import {
  comparePackageSurfaces,
  discoverUpstreamReferences,
  inspectUpstreamImpactInternal,
} from '../lib/upstream-impact-internal.js'

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

async function sourceFixture(root, extra = {}) {
  await writeJson(join(root, 'package.json'), {
    name: 'impact-fixture',
    version: '0.1.0',
    type: 'module',
    main: './index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    dshDeveloper: { upstream: { services: ['skills'] } },
    ...extra,
  })
  await writeFile(join(root, 'index.js'), [
    "export const inject = ['skills']",
    'export async function apply(ctx) { ctx.skills.register({}) }',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(root, 'cordis.patch.yml'), '- insert: []\n', 'utf8')
}

async function installedPackage(root, name, version, declaration) {
  await mkdir(join(root, 'lib', 'types'), { recursive: true })
  await writeFile(join(root, 'lib', 'index.js'), 'export const version = ' + JSON.stringify(version) + '\n', 'utf8')
  await writeFile(join(root, 'lib', 'types', 'index.d.ts'), declaration, 'utf8')
  const value = {
    name,
    version,
    type: 'module',
    main: './lib/index.js',
    types: './lib/types/index.d.ts',
    exports: {
      '.': {
        types: './lib/types/index.d.ts',
        default: './lib/index.js',
      },
      './package.json': './package.json',
    },
    publishConfig: { access: 'public' },
  }
  await writeJson(join(root, 'package.json'), value)
  return { root, manifestPath: join(root, 'package.json'), value }
}

test('discovers declared packages, injected services, static imports, and the base host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-impact-source-'))
  try {
    await sourceFixture(root, {
      dependencies: { '@deepseek-ai/dsh-commands': '^0.1.1' },
      dshDeveloper: {
        upstream: {
          packages: ['@deepseek-ai/dsh-skill/invariant'],
          services: ['skills'],
        },
      },
    })
    await writeFile(join(root, 'index.js'), [
      "import '@deepseek-ai/dsh-shell-env'",
      "export const inject = { required: ['skills', 'commands', 'remote.workspace'] }",
      "export async function apply(ctx) { ctx.commands.register({}); ctx.get('appExit'); ctx.inject(['agentLoop'], () => {}); ctx.logger.info('ready') }",
      '',
    ].join('\n'), 'utf8')
    const references = discoverUpstreamReferences(await scanOrdinaryTree(root))
    assert.deepEqual(references.packages.map((value) => value.package), [
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-commands',
      '@deepseek-ai/dsh-shell-env',
      '@deepseek-ai/dsh-skill',
    ])
    assert.deepEqual(references.packages.find((value) => value.package === '@deepseek-ai/dsh-skill').subpaths, ['./invariant'])
    assert.deepEqual(references.services.map((value) => value.service), ['agentLoop', 'appExit', 'commands', 'remote.workspace', 'skills'])
    assert.equal(
      references.services.find((value) => value.service === 'agentLoop')
        .evidence.find((value) => value.kind === 'context-inject').requirement,
      'runtime',
    )
    assert.equal(
      references.services.find((value) => value.service === 'remote.workspace')
        .evidence.find((value) => value.kind === 'inject').requirement,
      'required',
    )
    assert.deepEqual(references.coverage.undeclaredPackages, ['@deepseek-ai/dsh-shell-env'])
    assert.deepEqual(references.coverage.undeclaredServices, ['appExit'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('classifies exact public-surface facts without treating version churn as a contract change', () => {
  const base = {
    name: '@deepseek-ai/dsh-skill',
    version: '0.1.1-rc.2',
    access: 'public',
    manifest: {
      exports: { '.': './lib/index.js' },
      peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
    },
    declarations: { 'lib/types/index.d.ts': 'sha256:one' },
    entries: { 'lib/index.js': 'sha256:entry' },
    digest: 'sha256:release',
  }
  const versionOnly = structuredClone(base)
  versionOnly.version = '0.1.2-alpha.3'
  versionOnly.digest = 'sha256:preview'
  assert.equal(comparePackageSurfaces(base.name, base, versionOnly).classification, 'package-version')

  const changed = structuredClone(versionOnly)
  changed.declarations['lib/types/index.d.ts'] = 'sha256:two'
  const result = comparePackageSurfaces(base.name, base, changed)
  assert.equal(result.classification, 'contract')
  assert.deepEqual(result.reasons, ['declarations-changed', 'version-changed'])
  assert.deepEqual(result.changedFiles.declarations.map((value) => value.status), ['changed'])
})

test('rejects malformed attachment declarations instead of silently widening inference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-impact-declaration-'))
  try {
    await sourceFixture(root, {
      dshDeveloper: {
        upstream: {
          packages: ['not-an-official-package'],
          services: ['skills'],
        },
      },
    })
    const tree = await scanOrdinaryTree(root)
    assert.throws(
      () => discoverUpstreamReferences(tree),
      (error) => error.code === 'IMPACT_DECLARATION_INVALID',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('maps a declared service to exact package owners and emits stable scoped impact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-impact-'))
  const source = join(root, 'source')
  try {
    await mkdir(source)
    await sourceFixture(source)
    const releaseDsh = await installedPackage(
      join(root, 'release-dsh'),
      '@deepseek-ai/dsh',
      '0.1.1-rc.2',
      'export interface Dsh {}\n',
    )
    const previewDsh = await installedPackage(
      join(root, 'preview-dsh'),
      '@deepseek-ai/dsh',
      '0.1.2-alpha.3',
      'export interface Dsh {}\n',
    )
    const releaseSkill = await installedPackage(
      join(root, 'release-skill'),
      '@deepseek-ai/dsh-skill',
      '0.1.1-rc.2',
      "declare module '@deepseek-ai/cordis' { interface Context { skills: object } }\n",
    )
    const previewSkill = await installedPackage(
      join(root, 'preview-skill'),
      '@deepseek-ai/dsh-skill',
      '0.1.2-alpha.3',
      "declare module '@deepseek-ai/cordis' { interface Context { skills: { register(value: unknown): void } } }\n",
    )
    const inventories = {
      '0.1.1-rc.2': new Map([
        ['@deepseek-ai/dsh', releaseDsh],
        ['@deepseek-ai/dsh-skill', releaseSkill],
      ]),
      '0.1.2-alpha.3': new Map([
        ['@deepseek-ai/dsh', previewDsh],
        ['@deepseek-ai/dsh-skill', previewSkill],
      ]),
    }
    const dependencies = {
      resolveDshInvocation: async (value) => ({ displayPath: value, prefixArgs: [] }),
      assertOfficialDshInvocation: async (invocation) => invocation.displayPath === 'release' ? releaseDsh : previewDsh,
      packageInventory: async (dshPackage) => inventories[dshPackage.value.version],
      serviceIndex: async () => new Map([['skills', ['@deepseek-ai/dsh-skill']]]),
      locateInstalledDshPackage: async (dshPackage, name) => inventories[dshPackage.value.version].get(name),
    }
    const first = await inspectUpstreamImpactInternal(source, {
      releaseDsh: 'release',
      previewDsh: 'preview',
    }, dependencies)
    const second = await inspectUpstreamImpactInternal(source, {
      releaseDsh: 'release',
      previewDsh: 'preview',
    }, dependencies)
    assert.equal(first.ok, true, JSON.stringify(first, null, 2))
    assert.deepEqual(first.serviceMappings, [{
      service: 'skills',
      declared: true,
      release: ['@deepseek-ai/dsh-skill'],
      preview: ['@deepseek-ai/dsh-skill'],
    }])
    assert.equal(first.changes.find((value) => value.package === '@deepseek-ai/dsh-skill').classification, 'contract')
    assert.equal(first.evidenceDigest, second.evidenceDigest)
    assert.match(formatUpstreamImpactReport(first), /^PASS DSH upstream impact impact-fixture/u)

    await writeFile(join(source, 'index.js'), [
      "const required = ['skills']",
      'export const inject = Object.freeze(required)',
      'export async function apply() {}',
      '',
    ].join('\n'), 'utf8')
    const dynamic = await inspectUpstreamImpactInternal(source, {
      releaseDsh: 'release',
      previewDsh: 'preview',
    }, dependencies)
    assert.equal(dynamic.ok, false)
    const failed = dynamic.checks.find((value) => value.id === 'source.inject-contract')
    assert.equal(failed.status, 'FAIL')
    assert.deepEqual(failed.evidence.paths, ['index.js'])

    await writeFile(join(source, 'index.js'), [
      "export const inject = ['skills']",
      'export async function apply(ctx) { ctx.inject(runtimeServices(), () => {}) }',
      '',
    ].join('\n'), 'utf8')
    const dynamicContext = await inspectUpstreamImpactInternal(source, {
      releaseDsh: 'release',
      previewDsh: 'preview',
    }, dependencies)
    assert.equal(dynamicContext.ok, false)
    const contextFailure = dynamicContext.checks.find((value) => value.id === 'source.inject-contract')
    assert.equal(contextFailure.status, 'FAIL')
    assert.deepEqual(contextFailure.evidence.paths, ['index.js'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps the public impact option surface closed before reading source', async () => {
  await assert.rejects(
    inspectUpstreamImpact('C:\\never-read', {
      releaseDsh: 'release',
      previewDsh: 'preview',
      execute: true,
    }),
    (error) => error.code === 'IMPACT_OPTIONS_INVALID',
  )
  await assert.rejects(
    inspectUpstreamImpact('C:\\never-read', { releaseDsh: 'release' }),
    (error) => error.code === 'IMPACT_OPTIONS_INVALID',
  )
})
