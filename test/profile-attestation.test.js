import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET } from '../lib/constants.js'
import { DshDeveloperError } from '../lib/errors.js'
import { inspectProfileAttestation } from '../lib/profile-attestation.js'
import { inspectProfileAttestationInternal } from '../lib/profile-attestation-internal.js'

const WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
const ROOT_CONFIG = '# dsh profile root — an empty entry list. The tree is composed as patches:\n'
  + "# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n"
  + '# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n'
const INTEGRITY = 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

async function packageAt(root, value, entry = 'export function apply() {}\n', patch = '[]\n') {
  await put(join(root, 'package.json'), JSON.stringify(value, null, 2) + '\n')
  if (value.main) await put(join(root, value.main), entry)
  if (value.bin?.dsh) await put(join(root, value.bin.dsh), entry)
  if (value.dsh?.bundle?.patch) await put(join(root, value.dsh.bundle.patch), patch)
}

async function fixture(version) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-attestation-'))
  const dsh = join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh')
  const base = join(dsh, 'node_modules', '@deepseek-ai', 'dsh-base')
  await packageAt(dsh, {
    name: '@deepseek-ai/dsh',
    version,
    type: 'module',
    bin: { dsh: 'lib/bin.js' },
    publishConfig: { access: 'public' },
    dependencies: { '@deepseek-ai/dsh-base': version },
  }, '#!/usr/bin/env node\n')
  await packageAt(base, {
    name: '@deepseek-ai/dsh-base',
    version,
    type: 'module',
    main: 'lib/index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  const profile = join(root, 'profiles', 'headless')
  const manifest = {
    name: 'dsh-profile-headless',
    private: true,
    dependencies: { 'fixture-plugin': '^1.2.3' },
    dsh: { profile: {
      bundles: ['@deepseek-ai/dsh-base', 'fixture-plugin'],
      ...(version === DSH_PREVIEW_TARGET ? { patchReload: 'startup' } : {}),
    } },
  }
  await put(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  await put(join(profile, 'cordis.patch.yml'), '[]\n')
  await put(join(profile, 'cordis.yml'), ROOT_CONFIG)
  await put(join(profile, 'pnpm-workspace.yaml'), WORKSPACE)
  await put(join(profile, 'pnpm-lock.yaml'), [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: false',
    '  excludeLinksFromLockfile: false',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      fixture-plugin:',
    '        specifier: ^1.2.3',
    '        version: 1.2.3',
    '',
    'packages:',
    '',
    '  fixture-plugin@1.2.3:',
    '    resolution: {integrity: ' + INTEGRITY + '}',
    '',
    'snapshots:',
    '',
    '  fixture-plugin@1.2.3: {}',
    '',
  ].join('\n'))
  const plugin = join(profile, 'node_modules', 'fixture-plugin')
  await packageAt(plugin, {
    name: 'fixture-plugin',
    version: '1.2.3',
    type: 'module',
    main: 'index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  return { root, dsh: join(dsh, 'lib', 'bin.js'), profile, plugin }
}

async function withFixture(version, run) {
  const value = await fixture(version)
  try { await run(value) } finally { await rm(value.root, { recursive: true, force: true }) }
}

for (const [version, lane, claim] of [
  [DSH_COMPATIBILITY_TARGET, 'release', 'blocking'],
  [DSH_PREVIEW_TARGET, 'preview', 'advisory'],
]) {
  test('attests original ' + version + ' profile layout without executing package code', async () => {
    await withFixture(version, async ({ dsh, profile }) => {
      const report = await inspectProfileAttestation(profile, { dshPath: dsh })
      assert.equal(report.ok, true)
      assert.equal(report.runtime.lane, lane)
      assert.equal(report.runtime.claim, claim)
      assert.equal(report.claim.packageCodeExecuted, false)
      assert.deepEqual(report.profile.manifest.bundleOrder, ['@deepseek-ai/dsh-base', 'fixture-plugin'])
      assert.equal(report.profile.lockfile.dependencies[0].integrity, INTEGRITY)
      assert.equal(report.profile.bundles[1].resolution.kind, 'profile')
      assert.match(report.evidenceDigest, /^sha256:[a-f0-9]{64}$/u)
    })
  })
}

test('keeps the evidence digest deterministic while freshness remains explicit', async () => {
  await withFixture(DSH_COMPATIBILITY_TARGET, async ({ dsh, profile }) => {
    const first = await inspectProfileAttestation(profile, { dshPath: dsh })
    const second = await inspectProfileAttestation(profile, { dshPath: dsh })
    assert.equal(first.evidenceDigest, second.evidenceDigest)
    assert.equal(first.freshness.passes, 2)
    assert.equal(first.freshness.stable, true)
  })
})

for (const [label, mutate] of [
  ['lock drift', async ({ profile }) => put(join(profile, 'pnpm-lock.yaml'), (await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8')) + '\n')],
  ['bundle-order drift', async ({ profile }) => {
    const path = join(profile, 'package.json')
    const value = JSON.parse(await readFile(path, 'utf8'))
    value.dsh.profile.bundles.reverse()
    await put(path, JSON.stringify(value, null, 2) + '\n')
  }],
  ['package source mutation', async ({ plugin }) => put(join(plugin, 'index.js'), 'export const changed = true\n')],
]) {
  test('fails closed on ' + label + ' between passes', async () => {
    await withFixture(DSH_COMPATIBILITY_TARGET, async (value) => {
      await assert.rejects(
        inspectProfileAttestationInternal(value.profile, { dshPath: value.dsh }, { betweenPasses: () => mutate(value) }),
        (error) => error instanceof DshDeveloperError && error.code === 'PROFILE_STATE_CHANGED',
      )
    })
  })
}

test('redacts secret-bearing profile state before emitting any digest', async () => {
  await withFixture(DSH_COMPATIBILITY_TARGET, async ({ dsh, profile }) => {
    const secret = ['sk-', 'abcdefghijklmnop', 'qrstuvwxyz123456'].join('')
    await put(join(profile, 'cordis.patch.yml'), '- token: ' + secret + '\n')
    let caught
    try { await inspectProfileAttestation(profile, { dshPath: dsh }) } catch (error) { caught = error }
    assert.equal(caught.code, 'PROFILE_SECRET_STATE')
    assert.doesNotMatch(JSON.stringify(caught), new RegExp(secret, 'u'))
    assert.equal(caught.details.recovery.includes('redact'), true)
  })
})

test('rejects linked package roots that escape the profile', async (t) => {
  await withFixture(DSH_COMPATIBILITY_TARGET, async ({ root, dsh, profile, plugin }) => {
    const outside = join(root, 'outside-plugin')
    await rm(plugin, { recursive: true, force: true })
    await packageAt(outside, { name: 'fixture-plugin', version: '1.2.3', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } })
    try { await symlink(outside, plugin, process.platform === 'win32' ? 'junction' : 'dir') } catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('host cannot create a test link')
      throw error
    }
    await assert.rejects(inspectProfileAttestation(profile, { dshPath: dsh }), (error) => error.code === 'PROFILE_PACKAGE_LINKED_OR_MISSING')
  })
})

test('rejects package entry escapes', async () => {
  await withFixture(DSH_COMPATIBILITY_TARGET, async ({ dsh, profile, plugin }) => {
    const path = join(plugin, 'package.json')
    const value = JSON.parse(await readFile(path, 'utf8'))
    value.main = '../escaped.js'
    await put(path, JSON.stringify(value, null, 2) + '\n')
    await put(join(dirname(plugin), 'escaped.js'), 'export default 1\n')
    await assert.rejects(inspectProfileAttestation(profile, { dshPath: dsh }), (error) => error.code === 'PROFILE_PACKAGE_ESCAPE')
  })
})

test('rejects missing and conditional direct packages', async (t) => {
  await t.test('missing', async () => {
    await withFixture(DSH_COMPATIBILITY_TARGET, async ({ dsh, profile, plugin }) => {
      await rm(plugin, { recursive: true, force: true })
      await assert.rejects(inspectProfileAttestation(profile, { dshPath: dsh }), (error) => error.code === 'PROFILE_PACKAGE_LINKED_OR_MISSING')
    })
  })
  await t.test('conditional', async () => {
    await withFixture(DSH_COMPATIBILITY_TARGET, async ({ dsh, profile, plugin }) => {
      const path = join(plugin, 'package.json')
      const value = JSON.parse(await readFile(path, 'utf8'))
      value.os = ['linux']
      await put(path, JSON.stringify(value, null, 2) + '\n')
      await assert.rejects(inspectProfileAttestation(profile, { dshPath: dsh }), (error) => error.code === 'PROFILE_PACKAGE_CONDITIONAL')
    })
  })
})

test('public options cannot inject scanner dependencies', async () => {
  await assert.rejects(
    inspectProfileAttestation('missing', { betweenPasses() {} }),
    (error) => error.code === 'PROFILE_ATTESTATION_OPTIONS_INVALID',
  )
})
