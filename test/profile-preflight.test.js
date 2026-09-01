import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DSH_COMPATIBILITY_TARGET } from '../lib/constants.js'
import { DshDeveloperError } from '../lib/errors.js'
import { formatProfilePreflightReport, inspectProfilePreflight } from '../lib/profile-preflight.js'
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
    assert.equal(report.checks.find((value) => value.id === 'source.inject-contract').status, 'PASS')
    assert.equal(report.checks.find((value) => value.id === 'profile.service-contract').status, 'PASS')
    assert.match(report.evidenceDigest, /^sha256:[a-f0-9]{64}$/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports optional inject services without making them profile requirements', async () => {
  const root = await fixture()
  await writeFile(join(root, 'index.js'), [
    "export const inject = { required: ['skills'], optional: ['remote.workspace'] }",
    'export function apply() {}',
    '',
  ].join('\n'), 'utf8')
  let composedServices
  try {
    const report = await inspectProfilePreflightInternal(root, {
      dshPath: 'fake-dsh',
      profile: 'headless',
    }, runtimeDependencies(async (_invocation, profile, services, owners) => {
      composedServices = services
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
    assert.deepEqual(report.requiredServices, ['skills'])
    assert.deepEqual(report.optionalServices, ['remote.workspace'])
    assert.deepEqual(composedServices, ['skills'])
    assert.match(formatProfilePreflightReport(report), /\n  OPTIONAL remote\.workspace\n/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails closed when an inject assignment cannot be reduced to literal services', async () => {
  const root = await fixture()
  await writeFile(join(root, 'index.js'), [
    "const baseServices = ['skills']",
    'export const inject = Object.freeze(baseServices)',
    'export function apply() {}',
    '',
  ].join('\n'), 'utf8')
  let composed = false
  try {
    const report = await inspectProfilePreflightInternal(root, {
      dshPath: 'fake-dsh',
      profile: 'headless',
    }, runtimeDependencies(async () => {
      composed = true
      throw new Error('dynamic inject source must not reach profile composition')
    }))
    assert.equal(report.ok, false)
    assert.deepEqual(report.requiredServices, [])
    const failed = report.checks.find((value) => value.id === 'source.inject-contract')
    assert.equal(failed.status, 'FAIL')
    assert.deepEqual(failed.evidence.paths, ['index.js'])
    assert.equal(composed, false)
    assert.equal(report.checks.find((value) => value.id === 'profile.service-contract').status, 'SKIP')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails closed when a literal-looking inject prefix has a dynamic tail', async () => {
  const root = await fixture()
  await writeFile(join(root, 'index.js'), [
    "const extraServices = ['skills']",
    "export const inject = ['commands'].concat(extraServices)",
    'export function apply() {}',
    '',
  ].join('\n'), 'utf8')
  let composed = false
  try {
    const report = await inspectProfilePreflightInternal(root, {
      dshPath: 'fake-dsh',
      profile: 'headless',
    }, runtimeDependencies(async () => {
      composed = true
      throw new Error('dynamic inject source must not reach profile composition')
    }))
    assert.equal(report.ok, false)
    assert.deepEqual(report.requiredServices, [])
    assert.equal(report.checks.find((value) => value.id === 'source.inject-contract').status, 'FAIL')
    assert.equal(report.checks.find((value) => value.id === 'profile.service-contract').status, 'SKIP')
    assert.equal(composed, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails closed when a quoted inject value is not a valid Cordis service name', async () => {
  const root = await fixture()
  await writeFile(join(root, 'index.js'), [
    "export const inject = ['skills..invalid']",
    'export function apply() {}',
    '',
  ].join('\n'), 'utf8')
  let composed = false
  try {
    const report = await inspectProfilePreflightInternal(root, {
      dshPath: 'fake-dsh',
      profile: 'headless',
    }, runtimeDependencies(async () => {
      composed = true
    }))
    assert.equal(report.ok, false)
    assert.deepEqual(report.requiredServices, [])
    assert.equal(report.checks.find((value) => value.id === 'source.inject-contract').status, 'FAIL')
    assert.equal(report.checks.find((value) => value.id === 'profile.service-contract').status, 'SKIP')
    assert.equal(composed, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails before composition when Host inject contains DSH Client package identifiers', async () => {
  const root = await fixture()
  await writeFile(join(root, 'index.js'), [
    "export const inject = ['@deepseek-ai/dsh-client-runtime']",
    'export function apply() {}',
    '',
  ].join('\n'), 'utf8')
  let composed = false
  try {
    const report = await inspectProfilePreflightInternal(root, {
      dshPath: 'fake-dsh',
      profile: 'web',
    }, runtimeDependencies(async () => {
      composed = true
    }))
    const failed = report.checks.find((value) => value.id === 'source.inject-contract')
    assert.equal(failed.status, 'FAIL')
    assert.match(failed.message, /package\.json dsh\.client\.inject/u)
    assert.deepEqual(failed.evidence.clientPackageInjections, [{
      path: 'index.js',
      kind: 'inject',
      value: '@deepseek-ai/dsh-client-runtime',
    }])
    assert.equal(composed, false)
    assert.equal(report.checks.find((value) => value.id === 'profile.service-contract').status, 'SKIP')
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
