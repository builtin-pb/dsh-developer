import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  formatCellAdmissionReport,
  inspectIsolatedCellAdmission,
  isolatedCellEvidenceSources,
} from '../lib/cell-admission.js'
import { inspectIsolatedCellAdmissionInternal } from '../lib/cell-admission-internal.js'
import { buildExecutionLabReport } from '../lib/lab/report.js'

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

async function fakeDsh(version = '0.1.1-rc.2') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-cell-admission-'))
  const dshRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  const entry = join(dshRoot, 'lib', 'bin.js')
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(entry, 'export {}\n', 'utf8')
  await writeJson(join(dshRoot, 'package.json'), {
    name: '@deepseek-ai/dsh',
    version,
    type: 'module',
    bin: { dsh: 'lib/bin.js' },
    publishConfig: { access: 'public' },
  })

  async function addPackage(name, files = {}) {
    const packageRoot = join(dshRoot, 'node_modules', ...name.split('/'))
    await writeJson(join(packageRoot, 'package.json'), {
      name,
      version,
      type: 'module',
      main: 'lib/index.js',
      publishConfig: { access: 'public' },
    })
    await mkdir(join(packageRoot, 'lib'), { recursive: true })
    await writeFile(join(packageRoot, 'lib', 'index.js'), files.entry ?? 'export {}\n', 'utf8')
    if (files.readme) await writeFile(join(packageRoot, 'README.md'), files.readme, 'utf8')
  }

  await addPackage('@deepseek-ai/dsh-subagent', {
    entry: [
      'export function childSessionMeta(parent, childDepth, lineageSeedLength) {',
      '  return { cwd: parent.session.header.cwd, parentSession: parent.session.header.id, childDepth, lineageSeedLength }',
      '}',
      '',
    ].join('\n'),
  })
  await addPackage('@deepseek-ai/dsh-sandbox', {
    readme: '# Contract\n\n**Same-world confinement only.**\n\n- **File effects are the whole policy vocabulary**.\n',
  })

  const help = 'Usage: dsh --profile <name> --dump-config plugin\n'
  return {
    root,
    entry,
    async runDsh(_invocation, args) {
      if (args[0] === '--version') return { stdout: version + '\n', stderr: '', exitCode: 0 }
      if (args[0] === '--help') return { stdout: help, stderr: '', exitCode: 0 }
      throw new Error('unexpected fake DSH arguments: ' + args.join(' '))
    },
    async smokeDshInstall() {
      return {
        installed: true,
        discovered: true,
        loaded: true,
        loadWitness: 'registration-nonce',
        uninstalled: true,
      }
    },
  }
}

function passingLab() {
  return buildExecutionLabReport({
    provider: { id: 'wsl2-bubblewrap', distro: 'Ubuntu-22.04' },
    policy: { network: 'none', credentials: 'none' },
    checks: [{
      id: 'lab.fixture',
      status: 'PASS',
      blocking: true,
      message: 'fixed test lab passed',
      evidence: { fixture: true },
    }],
  }, '2026-08-31T00:00:00.000Z')
}

function dependenciesFor(fixture, lab = passingLab()) {
  return {
    capabilitiesOptions: {
      runDsh: fixture.runDsh,
      smokeDshInstall: fixture.smokeDshInstall,
    },
    conformLab: async () => lab,
  }
}

test('admits only the bounded isolated-cell gap from exact installed behavior', async () => {
  const fixture = await fakeDsh()
  try {
    const first = await inspectIsolatedCellAdmissionInternal(fixture.entry, {}, dependenciesFor(fixture))
    const second = await inspectIsolatedCellAdmissionInternal(fixture.entry, {}, dependenciesFor(fixture))
    assert.equal(first.ok, true, JSON.stringify(first.checks, null, 2))
    assert.equal(first.admitted, true)
    assert.equal(first.disposition, 'Incubate')
    assert.deepEqual(first.candidate.excluded, [
      'roster',
      'mailbox',
      'task board',
      'ordinary child lifecycle',
      'generic workflow orchestration',
    ])
    const harm = first.checks.find((value) => value.id === 'harm.shared-workspace-alias')
    assert.equal(harm.status, 'PASS')
    assert.equal(harm.evidence.bothChildrenInheritedParentWorkspace, true)
    assert.equal(harm.evidence.representativeWriteTargetAliases, true)
    assert.equal(first.checks.find((value) => value.id === 'upstream.public-gap').status, 'PASS')
    assert.equal(first.evidenceDigest, second.evidenceDigest)
    const text = formatCellAdmissionReport(first)
    assert.match(text, /^PASS isolated agent cell admission 0\.1\.1-rc\.2 \[blocking\] — Incubate/u)
    assert.match(text, /Admitted guarantee:/u)
    assert.match(text, /Explicitly excluded: roster, mailbox, task board/u)
    assert.match(text, /Trusted input: the user-selected/u)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('retains an unsupported record when the local boundary fails', async () => {
  const fixture = await fakeDsh()
  try {
    const failedLab = buildExecutionLabReport({
      provider: { id: 'wsl2-bubblewrap' },
      policy: {},
      checks: [{ id: 'lab.fixture', status: 'FAIL', blocking: true, message: 'unavailable' }],
    }, '2026-08-31T00:00:00.000Z')
    const report = await inspectIsolatedCellAdmissionInternal(fixture.entry, {}, dependenciesFor(fixture, failedLab))
    assert.equal(report.ok, false)
    assert.equal(report.admitted, false)
    assert.equal(report.disposition, 'Unsupported')
    assert.equal(report.checks.find((value) => value.id === 'replacement.local-boundary').status, 'FAIL')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('does not transfer reviewed gap semantics to an unknown DSH lane', async () => {
  const fixture = await fakeDsh('0.2.0')
  try {
    let imported = false
    const report = await inspectIsolatedCellAdmissionInternal(fixture.entry, {}, {
      ...dependenciesFor(fixture),
      importModule: async () => {
        imported = true
        throw new Error('unreviewed behavior must not be imported')
      },
    })
    assert.equal(report.ok, false)
    assert.equal(report.disposition, 'Unsupported')
    assert.equal(report.checks.find((value) => value.id === 'upstream.public-gap').status, 'FAIL')
    assert.equal(imported, false)
    assert.equal(report.checks.find((value) => value.id === 'harm.shared-workspace-alias').evidence.code, 'DSH_LANE_UNREVIEWED')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('publishes dated public evidence without mutable shared references', () => {
  const first = isolatedCellEvidenceSources()
  const second = isolatedCellEvidenceSources()
  assert.equal(first.length, 3)
  assert.ok(first.every((value) => value.url.startsWith('https://github.com/')))
  assert.ok(first.every((value) => value.observedAt === '2026-08-31'))
  first[0].finding = 'changed by caller'
  assert.notEqual(first[0].finding, second[0].finding)
})

test('refuses an arbitrary caller-selected JavaScript entry before executing DSH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-cell-untrusted-'))
  try {
    const entry = join(root, 'arbitrary.js')
    await writeFile(entry, 'throw new Error("must not execute")\n', 'utf8')
    await assert.rejects(
      inspectIsolatedCellAdmission(entry),
      (error) => error?.code === 'DSH_PACKAGE_NOT_FOUND',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('public admission API rejects dependency injection before resolving DSH', async () => {
  let injected = false
  await assert.rejects(
    inspectIsolatedCellAdmission('not-used.js', {
      inspectCapabilities: async () => {
        injected = true
      },
    }),
    (error) => error?.code === 'ADMISSION_OPTIONS_INVALID'
      && /Unsupported cell admission option/u.test(error.message),
  )
  assert.equal(injected, false)
})
