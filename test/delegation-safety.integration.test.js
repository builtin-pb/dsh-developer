import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DELEGATION_PROBE_WITNESS } from '../lib/delegation-probe.js'
import {
  resolveDshInvocation,
  runDsh,
  secretFreeEnvironment,
} from '../lib/runtime.js'

const enabled = process.env.DSH_DEVELOPER_DELEGATION_DSH_TEST === '1'
const productRoot = dirname(dirname(fileURLToPath(import.meta.url)))

async function probeLane(dshPath, lane) {
  assert.ok(dshPath, lane + ' DSH path is required')
  const invocation = await resolveDshInvocation(dshPath)
  const home = await mkdtemp(join(tmpdir(), 'dsh-developer-delegation-' + lane + '-'))
  const token = randomBytes(32).toString('hex')
  const profile = 'dsh-developer-delegation'
  const environment = secretFreeEnvironment({
    DSH_HOME: home,
    DSH_DEVELOPER_DELEGATION_PROBE: token,
    DSH_PERMISSION_MODE: 'read-only',
    npm_config_offline: 'true',
    npm_config_ignore_scripts: 'true',
  })
  try {
    const version = (await runDsh(invocation, ['--version'], {
      env: environment,
      signal: new AbortController().signal,
      label: lane + ' delegation version probe',
    })).stdout.trim()
    await runDsh(invocation, ['plugin', '--profile', profile, 'add', productRoot, '--offline', '--ignore-scripts'], {
      cwd: home,
      env: environment,
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      label: lane + ' delegation plugin install',
      diagnosticOutput: true,
    })
    await runDsh(invocation, ['--profile', profile], {
      cwd: home,
      env: environment,
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      label: lane + ' delegation runtime probe',
      diagnosticOutput: true,
    })
    const witness = JSON.parse(await readFile(join(home, DELEGATION_PROBE_WITNESS), 'utf8'))
    assert.equal(witness.token, token)
    assert.equal(witness.ok, true)
    assert.ok(witness.parentEscalationTools.length > 0)
    assert.equal(witness.parent.mutable.ok, true)
    assert.equal(witness.parent.mutable.applies, false)
    assert.equal(witness.parent.maximum.ok, true)
    assert.equal(witness.parent.maximum.applies, true)
    assert.ok(witness.parent.maximum.reasons.includes('maximum-sandbox'))
    assert.ok(witness.parent.maximum.tools.every((tool) => tool.status === 'fixed-scope'))
    assert.equal(witness.parent.restored.ok, true)
    assert.equal(witness.parent.restored.applies, false)
    assert.equal(witness.parent.approvalDisabled.ok, true)
    assert.equal(witness.parent.approvalDisabled.applies, true)
    assert.deepEqual(witness.parent.approvalDisabled.reasons, ['approval-disabled'])
    assert.ok(witness.parent.approvalDisabled.tools.every((tool) => tool.status === 'fixed-scope'))
    assert.equal(witness.parent.approvalDisabled.noOp.isError, false)
    assert.match(witness.parent.approvalDisabled.noOp.text, /authority-parent-approval-ok/u)
    assert.equal(witness.parent.approvalRestored.ok, true)
    assert.equal(witness.parent.approvalRestored.applies, false)
    assert.equal(witness.parent.noOp.isError, false)
    assert.match(witness.parent.noOp.text, /authority-parent-ok/u)
    assert.equal(witness.child.ok, true)
    assert.equal(witness.child.applies, true)
    assert.ok(witness.child.tools.length > 0)
    assert.ok(witness.child.tools.every((tool) => tool.status === 'fixed-scope'))
    assert.equal(witness.native.authority.operation, 'authority')
    assert.equal(witness.native.authority.ok, true)
    assert.equal(witness.native.delegation.operation, 'delegation')
    assert.equal(witness.native.delegation.ok, true)
    assert.equal(witness.sanitization.child.isError, false)
    assert.match(witness.sanitization.child.text, /authority-child-ok/u)
    assert.equal(witness.sanitization.denial.wroteFile, false)
    assert.doesNotMatch(witness.sanitization.denial.text, /escalation available/u)
    assert.match(witness.sanitization.denial.text, /authority is fixed/u)
    return { lane, version, witness }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('corrects fixed-authority schemas through exact release and preview DSH runtimes', {
  skip: !enabled,
  timeout: 150_000,
}, async () => {
  const release = await probeLane(process.env.DSH_DEVELOPER_RELEASE_DSH, 'release')
  const preview = await probeLane(process.env.DSH_DEVELOPER_PREVIEW_DSH, 'preview')
  assert.equal(release.version, '0.1.1-rc.2')
  assert.equal(preview.version, '0.1.2-alpha.3')
  assert.deepEqual(release.witness.parentEscalationTools, preview.witness.parentEscalationTools)
})
