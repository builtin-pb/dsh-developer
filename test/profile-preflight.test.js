import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DSH_COMPATIBILITY_TARGET } from '../lib/constants.js'
import { DshDeveloperError } from '../lib/errors.js'
import { inspectProfilePreflight } from '../lib/profile-preflight.js'
import {
  inspectProfilePreflightInternal,
  inspectProfileComposition,
} from '../lib/profile-preflight-internal.js'

async function fixture(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-preflight-source-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'preflight-fixture',
    version: '0.1.0',
    type: 'module',
    main: './index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    dshDeveloper: { upstream: { services: ['skills', 'remote.workspace'] } },
    ...extra,
  }, null, 2) + '\n', 'utf8')
  await writeFile(join(root, 'index.js'), [
    "export const inject = ['skills', 'remote.workspace']",
    'export function apply() {}',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(root, 'cordis.patch.yml'), '- insert: []\n', 'utf8')
  return root
}

function runtimeDependencies(compose) {
  const invocation = { command: 'node', prefixArgs: ['official-dsh.js'], displayPath: 'fake-dsh' }
  return {
    resolveDshInvocation: async () => invocation,
    assertOfficialDshInvocation: async () => ({ value: { version: DSH_COMPATIBILITY_TARGET } }),
    runDsh: async (_invocation, args) => {
      assert.deepEqual(args, ['--version'])
      return { stdout: DSH_COMPATIBILITY_TARGET + '\n', stderr: '', exitCode: 0 }
    },
    indexInstalledServiceOwners: async () => new Map([
      ['remote.workspace', ['@deepseek-ai/dsh-workspace-controller']],
      ['skills', ['@deepseek-ai/dsh-skill']],
    ]),
    inspectProfileComposition: compose,
  }
}

test('proves dotted required services with clean-profile composition evidence', async () => {
  const root = await fixture()
  let observed
  try {
    const report = await inspectProfilePreflightInternal(root, {
      dshPath: 'fake-dsh',
      profile: 'headless',
    }, runtimeDependencies(async (_invocation, profile, services, owners) => {
      observed = { profile, services }
      return {
        profile,
        requiredServices: services,
        mappings: services.map((service) => ({
          service,
          owners: owners.get(service),
          mountedOwners: owners.get(service),
          conditionalOwners: [],
        })),
        confidence: 'composition',
        profileActivated: false,
        repositoryCodeExecuted: false,
      }
    }))
    assert.equal(report.ok, true)
    assert.deepEqual(report.requiredServices, ['remote.workspace', 'skills'])
    assert.deepEqual(observed, { profile: 'headless', services: ['remote.workspace', 'skills'] })
    assert.equal(report.checks.find((value) => value.id === 'profile.service-contract').status, 'PASS')
    assert.match(report.evidenceDigest, /^sha256:[a-f0-9]{64}$/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps a profile composition failure actionable without executing repository code', async () => {
  const root = await fixture()
  try {
    const report = await inspectProfilePreflightInternal(root, {
      dshPath: 'fake-dsh',
      profile: 'headless',
    }, runtimeDependencies(async () => {
      throw new DshDeveloperError(
        'COMMAND_EXITED',
        'DSH profile preflight composition is missing a required service.',
        { stage: 'composition', missingServices: ['remote.workspace'] },
      )
    }))
    assert.equal(report.ok, false)
    const failed = report.checks.find((value) => value.id === 'profile.service-contract')
    assert.equal(failed.status, 'FAIL')
    assert.equal(failed.evidence.stage, 'composition')
    assert.deepEqual(failed.evidence.missingServices, ['remote.workspace'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects runtime copies of required DSH service-owner packages', async () => {
  const root = await fixture({
    dependencies: { '@deepseek-ai/dsh-skill': '^0.1.1' },
  })
  try {
    const report = await inspectProfilePreflightInternal(root, {
      dshPath: 'fake-dsh',
      profile: 'headless',
    }, runtimeDependencies(async (_invocation, profile, services, owners) => ({
      profile,
      requiredServices: services,
      mappings: services.map((service) => ({
        service,
        owners: owners.get(service),
        mountedOwners: owners.get(service),
        conditionalOwners: [],
      })),
      confidence: 'composition',
      profileActivated: false,
      repositoryCodeExecuted: false,
    })))
    assert.equal(report.ok, false)
    const failed = report.checks.find((value) => value.id === 'source.host-package-placement')
    assert.equal(failed.status, 'FAIL')
    assert.deepEqual(failed.evidence.misplaced, [{
      package: '@deepseek-ai/dsh-skill',
      services: ['skills'],
      fields: ['dependencies'],
    }])
    assert.equal(report.checks.find((value) => value.id === 'profile.service-contract').status, 'PASS')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('composes only an isolated profile and never installs or activates repository code', async () => {
  const virtualHome = join(tmpdir(), 'dsh-developer-virtual-preflight')
  let environment
  const calls = []
  const owners = new Map([
    ['remote.workspace', ['@deepseek-ai/dsh-workspace-controller']],
    ['skills', ['@deepseek-ai/dsh-skill']],
  ])
  const result = await inspectProfileComposition(
    { command: 'node', prefixArgs: ['official-dsh.js'], displayPath: 'fake-dsh' },
    'headless',
    ['remote.workspace', 'skills'],
    owners,
    {
      mkdtemp: async () => virtualHome,
      runDsh: async (_invocation, args, options) => {
        calls.push(args)
        environment = options.env
        return {
          stdout: [
            '- id: workspace-controller',
            "  name: '@deepseek-ai/dsh-workspace-controller'",
            '- id: skill',
            "  name: '@deepseek-ai/dsh-skill'",
            '',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        }
      },
      rm: async () => {},
    },
  )
  assert.equal(result.repositoryCodeExecuted, false)
  assert.equal(result.profileActivated, false)
  assert.equal(result.confidence, 'composition')
  assert.deepEqual(calls, [['--profile', 'headless', '--dump-config']])
  assert.equal(environment.DSH_PERMISSION_MODE, 'read-only')
  assert.equal(environment.DEEPSEEK_API_KEY, undefined)
})

test('fails closed when a required service owner is absent or conditional', async () => {
  const owners = new Map([['remote.workspace', ['@deepseek-ai/dsh-workspace-controller']]])
  await assert.rejects(
    inspectProfileComposition(
      { command: 'node', prefixArgs: ['official-dsh.js'], displayPath: 'fake-dsh' },
      'headless',
      ['remote.workspace'],
      owners,
      {
        mkdtemp: async () => join(tmpdir(), 'dsh-developer-virtual-preflight-failure'),
        runDsh: async () => ({
          stdout: [
            '- id: workspace-controller',
            "  name: '@deepseek-ai/dsh-workspace-controller'",
            "  disabled: !!js process.platform === 'win32'",
            '',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        }),
        rm: async () => {},
      },
    ),
    (error) => error instanceof DshDeveloperError
      && error.code === 'PROFILE_SERVICES_MISSING'
      && error.details.missingServices[0] === 'remote.workspace'
      && error.details.mappings[0].conditionalOwners[0] === '@deepseek-ai/dsh-workspace-controller',
  )
})

test('public preflight rejects dependency injection before touching source', async () => {
  await assert.rejects(
    inspectProfilePreflight('missing', {
      profile: 'headless',
      inspectProfileComposition: async () => {},
    }),
    (error) => error instanceof DshDeveloperError
      && error.code === 'PROFILE_PREFLIGHT_OPTIONS_INVALID'
      && /inspectProfileComposition/u.test(error.message),
  )
})
