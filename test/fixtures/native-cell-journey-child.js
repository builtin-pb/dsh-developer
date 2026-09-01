import assert from 'node:assert/strict'
import { cp, lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { doctorSource } from '../../lib/doctor.js'

const toolsRoot = process.env.DSH_DEVELOPER_JOURNEY_TOOLS_ROOT
const dshPath = process.env.DSH_DEVELOPER_JOURNEY_DSH
const expectedVersion = process.env.DSH_DEVELOPER_JOURNEY_EXPECTED_VERSION
const lane = process.env.DSH_DEVELOPER_JOURNEY_LANE
assert.ok(toolsRoot, 'DSH_DEVELOPER_JOURNEY_TOOLS_ROOT is required')
assert.ok(dshPath, 'DSH_DEVELOPER_JOURNEY_DSH is required')
assert.ok(expectedVersion, 'DSH_DEVELOPER_JOURNEY_EXPECTED_VERSION is required')
assert.ok(lane, 'DSH_DEVELOPER_JOURNEY_LANE is required')

const requireFromLane = createRequire(join(toolsRoot, 'package.json'))
const importFromLane = async (name) => import(pathToFileURL(requireFromLane.resolve(name)).href)
const [{ Context }, { default: SystemPrompt }, { default: ToolRuntime }, { AgentRegistry }] = await Promise.all([
  importFromLane('@deepseek-ai/cordis'),
  importFromLane('@deepseek-ai/dsh-system-prompt'),
  importFromLane('@deepseek-ai/dsh-tools'),
  importFromLane('@deepseek-ai/dsh-agent'),
])
assert.equal(requireFromLane(join(toolsRoot, 'package.json')).version, expectedVersion)

const sourceParent = await mkdtemp(join(tmpdir(), 'dsh-developer-native-journey-source-'))
const source = join(sourceParent, 'ordinary-dsh-plugin')
const realProfile = await mkdtemp(join(tmpdir(), 'dsh-developer-native-journey-profile-'))
await cp(fileURLToPath(new URL('./ordinary-dsh-plugin/', import.meta.url)), source, { recursive: true })
process.env.DSH_HOME = realProfile
process.argv[1] = resolve(dshPath)

const ctx = new Context()
let detachAgent
let firstDigest
let retainedRoot
let callSequence = 0
const approvals = []
let approvalMode = 'allowed-once'
let deferredApproval

function registryStub() {
  return {
    register() { return () => {} },
    get() { return undefined },
  }
}

function execute(agent, argumentsValue, signal = new AbortController().signal) {
  return ctx.tools.execute({
    callId: lane + '-native-cell-' + (++callSequence),
    name: 'dsh_developer',
    arguments: argumentsValue,
    agent,
    signal,
  })
}

async function assertSuccessful(result, operation) {
  assert.equal(result.isError, false, operation + ': ' + result.content?.map((item) => item.text ?? '').join('\n'))
  assert.equal(result.value.operation, operation)
  return result.value.report
}

try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const agents = new AgentRegistry(ctx)
  ctx.provide('skills', registryStub())
  ctx.provide('commands', registryStub())
  ctx.provide('shellEnv', registryStub())
  ctx.provide('approval', {
    request(request) {
      approvals.push(request)
      if (deferredApproval !== undefined) return deferredApproval.promise
      return Promise.resolve(approvalMode)
    },
  })
  const plugin = await import(pathToFileURL(fileURLToPath(new URL('../../index.js', import.meta.url))).href)
  await ctx.plugin(plugin)

  const agentCtx = ctx.extend()
  const sessionId = lane + '-native-cell-root'
  const agent = {
    id: sessionId,
    options: {},
    session: {
      id: sessionId,
      header: { id: sessionId, cwd: source, origin: 'user', delegationDepth: 0 },
    },
    inbox: {},
    status: 'idle',
    ctx: agentCtx,
    cancel() {},
    async whenIdle() {},
  }
  Object.defineProperty(agentCtx, 'agent', { value: agent, configurable: true })
  detachAgent = agents.enter(agent, undefined)
  assert.equal(ctx.agents.roots().includes(agent), true)

  const profileBefore = await doctorSource(realProfile, { runtime: 'skip' })
  const plan = await assertSuccessful(await execute(agent, {
    operation: 'cell-plan',
    outcome: 'Create one harmless staged proof file through the exact native isolated Build journey',
    commands: [{ command: 'printf after > proof.txt', timeoutMs: 60_000 }],
  }), 'cell-plan')
  firstDigest = plan.planDigest
  assert.equal(plan.source.path, resolve(source))
  assert.equal(plan.source.unchanged, true)
  assert.equal(plan.runtime.version, expectedVersion)
  assert.equal(plan.approval.granted, false)

  for (const denied of ['rejected', 'allowed-always', 'cancelled']) {
    approvalMode = denied
    const result = await execute(agent, { operation: 'cell-run', planDigest: firstDigest })
    assert.equal(result.isError, true, denied + ' must not dispatch the native handler')
    await assert.rejects(lstat(join(source, 'proof.txt')), (cause) => cause.code === 'ENOENT')
  }

  deferredApproval = Promise.withResolvers()
  const cancellation = new AbortController()
  const cancelledRun = execute(agent, { operation: 'cell-run', planDigest: firstDigest }, cancellation.signal)
  while (approvals.at(-1)?.callId !== lane + '-native-cell-' + callSequence) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
  }
  cancellation.abort('native journey approval cancelled')
  deferredApproval.resolve('allowed-once')
  const cancelledResult = await cancelledRun
  deferredApproval = undefined
  assert.equal(cancelledResult.isError, true)
  await assert.rejects(lstat(join(source, 'proof.txt')), (cause) => cause.code === 'ENOENT')

  approvalMode = 'allowed-once'
  const run = await assertSuccessful(await execute(agent, {
    operation: 'cell-run',
    planDigest: firstDigest,
  }), 'cell-run')
  retainedRoot = run.staging.root
  assert.equal(run.ok, true)
  assert.equal(run.source.unchanged, true)
  assert.equal(run.source.fingerprintBefore, plan.source.fingerprint)
  assert.equal(run.source.fingerprintAfter, plan.source.fingerprint)
  assert.deepEqual(run.staging.changedPaths, { created: ['proof.txt'], modified: [], deleted: [] })
  assert.equal(run.commands.length, 1)
  assert.equal(run.commands[0].exitCode, 0)
  assert.equal(run.commands[0].cleanup.remaining, 0)
  assert.equal(run.cleanup.cellDisposed, true)
  assert.equal(await readFile(join(run.staging.path, 'proof.txt'), 'utf8'), 'after')
  await assert.rejects(lstat(join(source, 'proof.txt')), (cause) => cause.code === 'ENOENT')

  const approval = approvals.at(-1)
  assert.equal(approvalMode, 'allowed-once')
  assert.equal(approval.agent, agent)
  assert.equal(approval.toolName, 'dsh_developer')
  for (const evidence of [
    firstDigest,
    resolve(source),
    plan.source.fingerprint,
    expectedVersion,
    'printf after > proof.txt',
    'isolated copy only',
    'network',
    'credentials',
  ]) assert.match(approval.reason, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))

  const stagedDoctor = await assertSuccessful(await execute(agent, {
    operation: 'doctor',
    source: run.staging.path,
    skipRuntime: true,
  }), 'doctor')
  assert.equal(stagedDoctor.ok, true)
  assert.equal(stagedDoctor.fingerprint, run.staging.fingerprint)

  const discard = await assertSuccessful(await execute(agent, {
    operation: 'cell-discard',
    planDigest: firstDigest,
  }), 'cell-discard')
  assert.equal(discard.cleanup.verified, true)
  assert.equal(discard.cleanup.capacityReleased, true)
  await assert.rejects(lstat(retainedRoot), (cause) => cause.code === 'ENOENT')
  retainedRoot = undefined

  const repeated = await assertSuccessful(await execute(agent, {
    operation: 'cell-discard',
    planDigest: firstDigest,
  }), 'cell-discard')
  assert.equal(repeated.alreadyDiscarded, true)
  assert.equal(repeated.cleanup.capacityReleased, true)

  const second = await assertSuccessful(await execute(agent, {
    operation: 'cell-plan',
    outcome: 'Prove the process-wide slot was released after verified discard',
    commands: [{ command: 'printf unused', timeoutMs: 1_000 }],
  }), 'cell-plan')
  const secondDiscard = await assertSuccessful(await execute(agent, {
    operation: 'cell-discard',
    planDigest: second.planDigest,
  }), 'cell-discard')
  assert.equal(secondDiscard.cleanup.capacityReleased, true)

  const profileAfter = await doctorSource(realProfile, { runtime: 'skip' })
  assert.equal(profileAfter.fingerprint, profileBefore.fingerprint)
  process.stdout.write(JSON.stringify({
    ok: true,
    lane,
    version: expectedVersion,
    planDigest: firstDigest,
    sourceFingerprint: plan.source.fingerprint,
    stagedFingerprint: run.staging.fingerprint,
    approvalRequests: approvals.length,
    sourceUnchanged: true,
    remainingProcesses: run.commands[0].cleanup.remaining,
    cleanupVerified: true,
    secondPlan: true,
  }) + '\n')
} finally {
  detachAgent?.()
  try {
    await ctx.fiber.dispose()
  } catch (cause) {
    if (retainedRoot !== undefined) {
      process.stderr.write('BLOCKER retained controller root: ' + retainedRoot + '\n')
    }
    throw cause
  }
  if (retainedRoot !== undefined) {
    const retained = await lstat(retainedRoot).then(() => true, (cause) => {
      if (cause?.code === 'ENOENT') return false
      throw cause
    })
    if (!retained) retainedRoot = undefined
  }
  if (retainedRoot !== undefined) {
    process.stderr.write('BLOCKER retained controller root: ' + retainedRoot + '\n')
    process.exitCode = 1
  } else {
    await rm(sourceParent, { recursive: true, force: true })
    await rm(realProfile, { recursive: true, force: true })
  }
}
