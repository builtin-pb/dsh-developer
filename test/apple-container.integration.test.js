import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAppleContainerCell } from '../lib/lab/apple-container.js'
import { createCellWorkflowSlot, createNativeCellWorkflowController } from '../lib/native-cell-workflow.js'
import { promoteCreatorExport } from '../lib/promote.js'
import { withCreatorFingerprint } from '../lib/creator-export.js'

const enabled = process.platform === 'darwin' && process.env.DSH_DEVELOPER_APPLE_LAB_TEST === '1'

test('Mac Build/Apply uses real DSH admission, VM execution, staged preflight and native commit', { skip: !enabled, timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sample-dsh-apple-'))
  const source = join(root, 'plugin')
  await cp(new URL('./fixtures/ordinary-dsh-plugin/', import.meta.url), source, { recursive: true })
  const owner = { ctx: {}, session: { header: { id: 'apple-integration', cwd: source, origin: 'user', delegationDepth: 0 } } }
  const controller = createNativeCellWorkflowController({ slot: createCellWorkflowSlot(), isRootAgent: (v) => v === owner })
  const approve = async (operation, planDigest) => {
    const exec = { name: 'dsh_developer', arguments: { operation, planDigest }, token: Symbol(operation), callId: operation, agent: owner, signal: new AbortController().signal }
    const decision = await controller.prepareApproval(exec)
    assert.equal(decision.kind, 'ask', decision.reason)
    // Exercise the controller's audited-registry boundary with a fixture token;
    // native registry approval behavior has its own release integration suite.
    assert.equal(controller.approvalGuard(exec), undefined)
    return { agent: owner, executionToken: exec.token, callId: exec.callId, signal: exec.signal }
  }
  try {
    const plan = await controller.plan({ outcome: 'Add a tested development note', commands: [{ command: "printf 'Built in an isolated VM\\n' > development.txt", timeoutMs: 5000 }] }, { agent: owner })
    assert.equal(plan.ok, true, JSON.stringify(plan))
    const run = await controller.run({ planDigest: plan.planDigest }, await approve('cell-run', plan.planDigest))
    assert.equal(run.ok, true, JSON.stringify(run))
    assert.equal(run.staging.changed, true)
    await assert.rejects(readFile(join(source, 'development.txt')), { code: 'ENOENT' })
    const applied = await controller.apply({ planDigest: plan.planDigest }, await approve('cell-apply', plan.planDigest))
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(await readFile(join(source, 'development.txt'), 'utf8'), 'Built in an isolated VM\n')
  } finally {
    await controller.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('Mac rejects sparse oversized exports and destroys the VM before returning', { skip: !enabled, timeout: 30_000 }, async () => {
  const cell = await createAppleContainerCell()
  try {
    await cell.run(['/usr/bin/python3', '-c', "[open('/opt/workspace/sparse-'+str(i),'wb').truncate(524288) for i in range(9)]"])
    await assert.rejects(cell.snapshot())
    await assert.rejects(cell.run(['/usr/bin/true']), { code: 'CELL_DISPOSED' })
  } finally { await cell.dispose() }
})

test('Mac promotion proves generated tests and the real installed DSH lifecycle', { skip: !enabled, timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sample-dsh-promotion-'))
  const source = join(root, 'creator.json')
  const draft = withCreatorFingerprint({ format: 'dsh-creator-export', schemaVersion: 1,
    name: 'apple-trial-plugin', packageName: 'apple-trial-plugin', author: 'DSH contributors',
    description: 'A local macOS lifecycle fixture.', goal: 'Return a useful development note.',
    instructions: 'Return one concise development note.', compatibilityTarget: '0.1.5-rc.2',
    decisions: [], unresolvedRisks: [], tools: [], resources: [] })
  try {
    await writeFile(source, JSON.stringify(draft))
    const result = await promoteCreatorExport(source, join(root, 'apple-trial-plugin'))
    assert.equal(result.committed, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Mac freezes fork/exit churn and removes the VM on command timeout', { skip: !enabled, timeout: 30_000 }, async () => {
  const cell = await createAppleContainerCell()
  const churn = `import os,time
pid=os.fork()
if pid:
    time.sleep(0.1)
    os._exit(0)
os.setsid()
os.close(1)
os.close(2)
while True:
    try:
        pid=os.fork()
        if pid: os._exit(0)
    except OSError:
        time.sleep(0.01)
`
  try {
    const result = await cell.run(['/usr/bin/python3', '-I', '-S', '-c', churn])
    assert.equal(result.cleanup.freezeVerified, true)
    assert.equal(result.cleanup.populated, false)
    assert.ok(result.cleanup.killed.length > 0)
    await assert.rejects(cell.run(['/bin/sleep', '30'], { timeoutMs: 300 }), { code: 'COMMAND_TIMEOUT' })
    await assert.rejects(cell.run(['/usr/bin/true']), { code: 'CELL_DISPOSED' })
  } finally { await cell.dispose() }
})
