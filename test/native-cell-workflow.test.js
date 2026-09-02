import assert from 'node:assert/strict'
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fingerprintFileMap, scanOrdinaryTree } from '../lib/files.js'
import { claimCellStageAuthority } from '../lib/cell-stage-authority.js'
import { DshDeveloperError } from '../lib/errors.js'
import {
  createCellWorkflowSlot,
  createNativeCellWorkflowController,
  formatCellWorkflowReport,
  inspectLiveAgentWorkspace,
  safeCellWorkflowDiagnostic,
} from '../lib/native-cell-workflow.js'

const SOURCE_FINGERPRINT = 'sha256:' + '1'.repeat(64)
const DOCTOR_DIGEST_INPUT = [{ id: 'source', status: 'PASS', blocking: true, message: 'stable' }]

function agent(id = 'agent-one') {
  return {
    ctx: {},
    session: { header: { id, cwd: resolve('workspace-' + id), origin: 'user', delegationDepth: 0 } },
  }
}

function report(fingerprint, plugin) {
  return {
    kind: 'doctor-plugin',
    ok: true,
    source: resolve('workspace-agent-one'),
    fingerprint,
    checks: structuredClone(DOCTOR_DIGEST_INPUT),
    ...(plugin ? { plugin } : {}),
  }
}

function fixture(options = {}) {
  const owner = options.owner ?? agent()
  const state = {
    fingerprint: SOURCE_FINGERPRINT,
    workspaceIdentity: 'sha256:' + '2'.repeat(64),
    now: 1_000,
    openCalls: 0,
    executed: [],
    disposed: 0,
  }
  const slot = createCellWorkflowSlot()
  const fakeCell = options.cell ?? {
    sourceFingerprint: SOURCE_FINGERPRINT,
    provider: { id: 'wsl2-bubblewrap', distro: 'fixture', kernel: 'fixture', bwrapVersion: 'fixture' },
    async exec(command) {
      state.executed.push(command)
      return { stdout: 'ok\n', stderr: '', exitCode: 0, cleanup: { observed: 0, killed: [], remaining: 0 } }
    },
    async stageResult() {
      return {
        changed: false,
        staging: undefined,
        stagingRoot: undefined,
        changes: { created: [], modified: [], deleted: [] },
        sourceFingerprint: state.fingerprint,
        resultFingerprint: state.fingerprint,
      }
    },
    async dispose() { state.disposed += 1 },
  }
  const controller = createNativeCellWorkflowController({
    slot,
    now: () => state.now,
    randomBytes: () => Buffer.alloc(32, 7),
    dshPath: 'fixture-dsh',
    ...(options.getProfileDirectory === undefined ? {} : { getProfileDirectory: options.getProfileDirectory }),
    ...(options.inspectProfileFence === undefined ? {} : { inspectProfileFence: options.inspectProfileFence }),
    ...(options.tmpdir === undefined ? {} : { tmpdir: options.tmpdir }),
    isRootAgent: (candidate) => candidate === owner,
    inspectWorkspace: options.inspectWorkspace ?? (async (candidate) => {
      if (candidate !== owner) throw Object.assign(new Error('not live'), { code: 'CELL_AGENT_NOT_LIVE' })
      return {
        root: resolve('workspace-agent-one'),
        headerPath: resolve('workspace-agent-one'),
        sessionId: owner.session.header.id,
        pathIdentity: [],
        identityDigest: state.workspaceIdentity,
        rootIdentity: { dev: '1', ino: '2' },
      }
    }),
    scanTree: options.scanTree ?? (async () => ({
      root: resolve('workspace-agent-one'),
      fingerprint: state.fingerprint,
      entries: [],
    })),
    ...(options.inspectTreeIdentity === null ? {} : {
      inspectTreeIdentity: options.inspectTreeIdentity ?? (async (_root, tree) => ({
        root: tree.root,
        rootIdentity: { dev: '1', ino: '2' },
        directories: [],
        files: [],
        digest: 'sha256:' + (tree.fingerprint === SOURCE_FINGERPRINT ? 'a' : 'b').repeat(64),
      })),
    }),
    doctor: options.doctor ?? (async () => report(state.fingerprint, options.plugin)),
    inspectCapabilities: options.inspectCapabilities ?? (async () => ({
      ok: true,
      evidenceDigest: 'sha256:' + '3'.repeat(64),
      runtime: {
        version: '0.1.1-rc.2',
        lane: { id: 'release', claim: 'blocking', recognized: true },
        package: { name: '@deepseek-ai/dsh', version: '0.1.1-rc.2', access: 'public' },
      },
    })),
    inspectAdmission: options.inspectAdmission ?? (async () => ({
      admitted: true,
      disposition: 'Incubate',
      evidenceDigest: 'sha256:' + '4'.repeat(64),
      runtime: { version: '0.1.1-rc.2' },
    })),
    openCell: options.openCell ?? (async () => {
      state.openCalls += 1
      return fakeCell
    }),
    preflight: options.preflight ?? (async () => ({
      ok: true,
      profile: 'headless',
      evidenceDigest: 'sha256:' + '5'.repeat(64),
    })),
    cleanupBarrier: options.cleanupBarrier,
    applyBarrier: options.applyBarrier,
  })
  return { controller, owner, state, slot, fakeCell }
}

async function makePlan(f, commands = [{ command: 'node --test', timeoutMs: 2_000 }]) {
  return f.controller.plan({
    outcome: 'Run the repository tests in an isolated copy',
    commands,
  }, { agent: f.owner, signal: new AbortController().signal })
}

async function grantOnce(f, plan, overrides = {}) {
  const token = overrides.token ?? Symbol('registry-token')
  const callId = overrides.callId ?? 'call-1'
  const exec = {
    name: 'dsh_developer',
    arguments: { operation: overrides.operation ?? 'cell-run', planDigest: plan.planDigest },
    token,
    callId,
    agent: overrides.agent ?? f.owner,
    signal: overrides.signal ?? new AbortController().signal,
    ...(overrides.parent === undefined ? {} : { parent: overrides.parent }),
  }
  const decision = await f.controller.prepareApproval(exec)
  return { token, callId, exec, decision, guard: () => f.controller.approvalGuard(exec) }
}

let stagedSequence = 0

async function writeFixtureTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const segments = path.split('/')
    if (segments.length > 1) await mkdir(join(root, ...segments.slice(0, -1)), { recursive: true })
    await writeFile(join(root, ...segments), content, 'utf8')
  }
}

async function makeStagedWorkflow(options = {}) {
  const source = options.source ?? await mkdtemp(join(tmpdir(), 'dsh-cell-owned-stage-source-'))
  if (options.source !== undefined) await mkdir(source, { recursive: true })
  await writeFixtureTree(source, options.sourceFiles ?? {})
  const sourceFingerprint = (await scanOrdinaryTree(source)).fingerprint
  const owner = agent('owned-stage-' + (++stagedSequence))
  const value = fixture({
    owner,
    inspectTreeIdentity: null,
    cleanupBarrier: options.cleanupBarrier,
    applyBarrier: options.applyBarrier,
    ...(options.getProfileDirectory === undefined ? {} : { getProfileDirectory: options.getProfileDirectory }),
    ...(options.tmpdir === undefined ? {} : { tmpdir: options.tmpdir }),
    inspectWorkspace: async () => ({
      root: source,
      headerPath: source,
      sessionId: owner.session.header.id,
      pathIdentity: [],
      identityDigest: 'sha256:' + '6'.repeat(64),
      rootIdentity: { dev: '1', ino: '2' },
    }),
    scanTree: (path, scanOptions) => scanOrdinaryTree(path, scanOptions),
    doctor: async (path) => {
      const tree = await scanOrdinaryTree(path)
      return report(tree.fingerprint)
    },
    cell: {
      sourceFingerprint,
      provider: { id: 'wsl2-bubblewrap', distro: 'fixture', kernel: 'fixture', bwrapVersion: 'fixture' },
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0, cleanup: { observed: 0, killed: [], remaining: 0 } }
      },
      async stageResult(stageOptions) {
        const authority = await claimCellStageAuthority(stageOptions.authority)
        await writeFixtureTree(authority.destination, options.stageFiles ?? {
          'result.txt': 'sealed\n',
          'nested/more.txt': 'more\n',
        })
        const tree = await scanOrdinaryTree(authority.destination)
        return {
          changed: true,
          staging: authority.destination,
          stagingRoot: authority.root,
          stageAuthority: authority.capability,
          changes: options.changes ?? { created: ['nested/more.txt', 'result.txt'], modified: [], deleted: [] },
          sourceFingerprint,
          resultFingerprint: tree.fingerprint,
        }
      },
      async dispose() {},
    },
  })
  value.state.fingerprint = sourceFingerprint
  const plan = await makePlan(value)
  const approval = await grantOnce(value, plan)
  assert.equal(approval.guard(), undefined)
  const run = await value.controller.run({ planDigest: plan.planDigest }, {
    agent: value.owner,
    executionToken: approval.token,
    callId: approval.callId,
  })
  assert.equal(run.staging.changed, true, JSON.stringify(run.failure))
  return { value, source, plan, run }
}

test('binds a plan to exact commands, fixed policy, source fingerprint, lane, and no execution authority', async () => {
  const f = fixture()
  const plan = await makePlan(f, [
    { command: 'node --test', timeoutMs: 1_000 },
    { command: 'npm run check' },
  ])
  assert.match(plan.planDigest, /^sha256:[a-f0-9]{64}$/u)
  assert.equal(plan.ok, true)
  assert.equal(plan.commands[1].timeoutMs, 60_000)
  assert.equal(plan.source.authority, 'live-root-agent-session.header.cwd')
  assert.equal(plan.source.fingerprint, SOURCE_FINGERPRINT)
  assert.equal(plan.runtime.version, '0.1.1-rc.2')
  assert.equal(plan.effects.executionAuthority, 'none-plan-is-not-approval')
  assert.equal(f.state.openCalls, 0)
  await f.controller.discard({ planDigest: plan.planDigest }, { agent: f.owner })
})

test('requires an audited token proof and consumes allowed-once before exact stored commands launch', async () => {
  const f = fixture()
  const plan = await makePlan(f, [
    { command: 'node --test', timeoutMs: 1_000 },
    { command: 'npm run check', timeoutMs: 2_000 },
  ])
  const approval = await grantOnce(f, plan)
  assert.equal(approval.decision.kind, 'ask')
  assert.match(approval.decision.reason, /1\. \[1000 ms\] node --test/u)
  assert.match(approval.decision.reason, /2\. \[2000 ms\] npm run check/u)
  assert.equal(approval.guard(), undefined)

  const run = await f.controller.run({ planDigest: plan.planDigest }, {
    agent: f.owner,
    executionToken: approval.token,
    callId: approval.callId,
    signal: approval.exec.signal,
  })
  assert.equal(run.ok, true)
  assert.deepEqual(f.state.executed, ['node --test', 'npm run check'])
  assert.equal(run.commandBinding.exact, true)
  assert.equal(run.source.unchanged, true)
  assert.equal(run.isolation.network, 'none')
  assert.equal(run.isolation.credentials, 'none')
  assert.equal(run.cleanup.cellDisposed, true)
  assert.equal(f.state.disposed, 1)

  await assert.rejects(
    f.controller.run({ planDigest: plan.planDigest }, {
      agent: f.owner,
      executionToken: approval.token,
      callId: approval.callId,
    }),
    (cause) => cause.code === 'CELL_APPROVAL_GATE_UNAVAILABLE',
  )
  await f.controller.discard({ planDigest: plan.planDigest }, { agent: f.owner })
})

test('unavailable, rejected, cancelled, non-once, forged, and skipped approval paths launch nothing', async () => {
  for (const disposition of ['unavailable', 'rejected', 'cancelled', 'non-once']) {
    const f = fixture()
    const plan = await makePlan(f)
    const approval = await grantOnce(f, plan)
    assert.equal(approval.decision.kind, 'ask')
    // Every non-grant is represented by the registry never calling the guard.
    f.controller.settleExecution(approval.exec)
    await assert.rejects(
      f.controller.run({ planDigest: plan.planDigest }, {
        agent: f.owner,
        executionToken: approval.token,
        callId: approval.callId,
      }),
      (cause) => cause.code === 'CELL_APPROVAL_GATE_UNAVAILABLE',
      disposition,
    )
    assert.equal(f.state.openCalls, 0)
    await f.controller.discard({ planDigest: plan.planDigest }, { agent: f.owner })
  }

  const f = fixture()
  const plan = await makePlan(f)
  const approval = await grantOnce(f, plan)
  const forged = { ...approval.exec, token: Symbol('forged') }
  assert.match(f.controller.approvalGuard(forged), /CELL_APPROVAL_GATE_UNAVAILABLE/u)
  await assert.rejects(
    f.controller.run({ planDigest: plan.planDigest }, {
      agent: f.owner,
      executionToken: forged.token,
      callId: forged.callId,
    }),
    (cause) => cause.code === 'CELL_APPROVAL_GATE_UNAVAILABLE',
  )
  assert.equal(f.state.openCalls, 0)
  f.controller.settleExecution(approval.exec)
  await f.controller.discard({ planDigest: plan.planDigest }, { agent: f.owner })
})

test('rejects stale digest, source mutation, nested execution, cross-Agent and recreated-id hijacks before launch', async () => {
  const f = fixture()
  const plan = await makePlan(f)
  const other = agent(f.owner.session.header.id)
  const cross = await grantOnce(f, plan, { agent: other })
  assert.equal(cross.decision.kind, 'deny')
  assert.match(cross.decision.reason, /CELL_OWNER_MISMATCH|CELL_AGENT_NOT_LIVE/u)
  const nested = await grantOnce(f, plan, { parent: Symbol('parent') })
  assert.equal(nested.decision.kind, 'deny')
  assert.match(nested.decision.reason, /CELL_TOP_LEVEL_CALL_REQUIRED/u)
  const forged = await f.controller.prepareApproval({
    name: 'dsh_developer',
    arguments: { operation: 'cell-run', planDigest: 'sha256:' + '9'.repeat(64) },
    token: Symbol('forged-digest'),
    callId: 'forged',
    agent: f.owner,
    signal: new AbortController().signal,
  })
  assert.equal(forged.kind, 'deny')
  assert.match(forged.reason, /CELL_PLAN_DIGEST_MISMATCH/u)

  f.state.fingerprint = 'sha256:' + '8'.repeat(64)
  const stale = await grantOnce(f, plan)
  assert.equal(stale.decision.kind, 'deny')
  assert.match(stale.decision.reason, /CELL_PLAN_STALE|CELL_PLAN_MUTABLE_SOURCE/u)
  assert.equal(f.state.openCalls, 0)
  await f.controller.discard({ planDigest: plan.planDigest }, { agent: f.owner })
})

test('one process-wide slot covers planning and stays held until verified idempotent discard', async () => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let calls = 0
  const f = fixture({
    inspectWorkspace: async () => {
      calls += 1
      if (calls === 1) {
        entered.resolve()
        await release.promise
      }
      return {
        root: resolve('workspace-agent-one'), headerPath: resolve('workspace-agent-one'), sessionId: 'agent-one',
        pathIdentity: [], identityDigest: 'sha256:' + '2'.repeat(64), rootIdentity: { dev: '1', ino: '2' },
      }
    },
  })
  const pending = makePlan(f)
  await entered.promise
  await assert.rejects(makePlan(f), (cause) => cause.code === 'CELL_WORKFLOW_CAPACITY' && cause.details.phase === 'planning')
  release.resolve()
  const plan = await pending
  await assert.rejects(makePlan(f), (cause) => cause.code === 'CELL_WORKFLOW_CAPACITY')
  const first = await f.controller.discard({ planDigest: plan.planDigest }, { agent: f.owner })
  assert.equal(first.cleanup.capacityReleased, true)
  const second = await f.controller.discard({ planDigest: plan.planDigest }, { agent: f.owner })
  assert.equal(second.alreadyDiscarded, true)
})

test('redacts secret output before return, stops subsequent commands, stages once, and disposes', async () => {
  let stages = 0
  const f = fixture()
  f.fakeCell.exec = async (command) => {
    f.state.executed.push(command)
    return {
      stdout: ['sk', '-', 'abcdefghijklmnop', 'SECRET'].join(''),
      stderr: '',
      exitCode: 0,
      cleanup: { observed: 0, killed: [], remaining: 0 },
    }
  }
  f.fakeCell.stageResult = async () => {
    stages += 1
    return {
      changed: false,
      changes: { created: [], modified: [], deleted: [] },
      sourceFingerprint: f.state.fingerprint,
      resultFingerprint: f.state.fingerprint,
    }
  }
  const plan = await makePlan(f, [{ command: 'first' }, { command: 'second' }])
  const approval = await grantOnce(f, plan)
  assert.equal(approval.guard(), undefined)
  const run = await f.controller.run({ planDigest: plan.planDigest }, {
    agent: f.owner,
    executionToken: approval.token,
    callId: approval.callId,
    signal: approval.exec.signal,
  })
  assert.equal(run.ok, false)
  assert.deepEqual(f.state.executed, ['first'])
  assert.equal(run.commands[0].output.redacted, true)
  assert.doesNotMatch(run.commands[0].stdout, /sk-/u)
  assert.equal(stages, 1)
  assert.equal(run.cleanup.cellDisposed, true)
  await f.controller.discard({ planDigest: plan.planDigest }, { agent: f.owner })
})

test('renders bounded stdout, stderr, and exit evidence for a nonzero build without running later commands', async () => {
  const f = fixture()
  f.fakeCell.exec = async (command) => {
    f.state.executed.push(command)
    return {
      stdout: 'focused assertion failed\n' + 'x'.repeat(5_000),
      stderr: 'at fixture.test.js:10\n' + 'y'.repeat(5_000),
      exitCode: 2,
      cleanup: { observed: 0, killed: [], remaining: 0 },
    }
  }
  const plan = await makePlan(f, [{ command: 'focused-test' }, { command: 'must-not-run' }])
  const approval = await grantOnce(f, plan)
  assert.equal(approval.guard(), undefined)
  const run = await f.controller.run({ planDigest: plan.planDigest }, {
    agent: f.owner,
    executionToken: approval.token,
    callId: approval.callId,
  })
  const rendered = formatCellWorkflowReport(run)
  assert.equal(run.ok, false)
  assert.deepEqual(f.state.executed, ['focused-test'])
  assert.match(rendered, /Command 1 exit: 2/u)
  assert.match(rendered, /stdout:\nfocused assertion failed/u)
  assert.match(rendered, /stderr:\nat fixture\.test\.js:10/u)
  assert.match(rendered, /render truncated by dsh-developer/u)
  assert.ok(rendered.length < 6_000)
  await f.controller.discard({ planDigest: plan.planDigest }, { agent: f.owner })
})

test('allowlists, recursively bounds, and secret-scans exec, stage, Doctor, preflight, and disposal diagnostics', async () => {
  const secret = ['sk', '-', 'abcdefghijklmnop', 'SECRET'].join('')
  const injected = (phase) => new DshDeveloperError(
    'CELL_INJECTED_' + phase.toUpperCase(),
    phase + ' failed with ' + secret,
    {
      stdout: secret,
      stderr: secret,
      path: 'raw-path-' + secret,
      retainedRoot: resolve('safe-retained-stage'),
      cleanup: new DshDeveloperError('CELL_INJECTED_NESTED', 'nested ' + secret, {
        stdout: secret,
        path: secret,
      }),
    },
  )
  const assertSafe = (diagnostic) => {
    const serialized = JSON.stringify(diagnostic)
    assert.ok(serialized.length < 6_000)
    assert.doesNotMatch(serialized, new RegExp(secret, 'u'))
    assert.doesNotMatch(serialized, /"stdout"|"stderr"|raw-path/u)
    assert.match(serialized, /REDACTED/u)
  }
  assertSafe(safeCellWorkflowDiagnostic(injected('direct')))

  const cases = []
  const execFailure = fixture()
  execFailure.fakeCell.exec = async () => { throw injected('exec') }
  cases.push(execFailure)

  const stageFailure = fixture()
  stageFailure.fakeCell.stageResult = async () => { throw injected('stage') }
  cases.push(stageFailure)

  let doctorCalls = 0
  cases.push(fixture({
    doctor: async () => {
      doctorCalls += 1
      if (doctorCalls === 4) throw injected('doctor')
      return report(SOURCE_FINGERPRINT)
    },
  }))

  cases.push(fixture({
    plugin: { name: 'fixture-plugin' },
    preflight: async () => { throw injected('preflight') },
  }))

  const disposalFailure = fixture()
  let disposalCalls = 0
  disposalFailure.fakeCell.dispose = async () => {
    disposalCalls += 1
    if (disposalCalls === 1) throw injected('disposal')
  }
  cases.push(disposalFailure)

  for (const value of cases) {
    const plan = await makePlan(value)
    const approval = await grantOnce(value, plan)
    assert.equal(approval.guard(), undefined)
    const run = await value.controller.run({ planDigest: plan.planDigest }, {
      agent: value.owner,
      executionToken: approval.token,
      callId: approval.callId,
    })
    assert.equal(run.ok, false)
    assertSafe(run.failure)
    await value.controller.discard({ planDigest: plan.planDigest }, { agent: value.owner })
  }
})

test('stops on command timeout but still stages once, runs static verification, and disposes', async () => {
  let stages = 0
  let doctors = 0
  const f = fixture({
    doctor: async () => {
      doctors += 1
      return report(SOURCE_FINGERPRINT)
    },
  })
  f.fakeCell.exec = async () => {
    throw Object.assign(new Error('timed out'), { code: 'COMMAND_TIMEOUT' })
  }
  f.fakeCell.stageResult = async () => {
    stages += 1
    return {
      changed: false,
      changes: { created: [], modified: [], deleted: [] },
      sourceFingerprint: f.state.fingerprint,
      resultFingerprint: f.state.fingerprint,
    }
  }
  const plan = await makePlan(f, [{ command: 'slow' }, { command: 'must-not-run' }])
  const approval = await grantOnce(f, plan)
  assert.equal(approval.guard(), undefined)
  const run = await f.controller.run({ planDigest: plan.planDigest }, {
    agent: f.owner,
    executionToken: approval.token,
    callId: approval.callId,
  })
  assert.equal(run.ok, false)
  assert.equal(run.failure.code, 'COMMAND_TIMEOUT')
  assert.equal(run.commandBinding.executed, 0)
  assert.equal(stages, 1)
  assert.equal(doctors, 4, 'plan, approval recheck, run recheck, and final static Doctor must all complete')
  assert.equal(run.cleanup.cellDisposed, true)
  await f.controller.discard({ planDigest: plan.planDigest }, { agent: f.owner })
})

test('cancellation during planning releases capacity and cancellation during execution disposes before return', async () => {
  const controller = new AbortController()
  const f = fixture({
    inspectWorkspace: async (_agent, options) => new Promise((resolveValue, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true })
    }),
  })
  const planning = makePlan({ ...f, controller: f.controller }, [{ command: 'true' }]).catch((cause) => cause)
  controller.abort()
  // The helper owns its own signal, so explicitly dispose the owner to exercise
  // the controller-owned lifetime while the planning promise is pending.
  const disposal = f.controller.disposeOwner(f.owner)
  const planningError = await planning
  await disposal
  assert.equal(planningError.code, 'CANCELLED')
  assert.equal(f.controller.status().phase, 'idle')

  const runController = new AbortController()
  const executing = fixture()
  const executingEntered = Promise.withResolvers()
  executing.fakeCell.exec = async (_command, options) => new Promise((resolveValue, reject) => {
    executingEntered.resolve()
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled command'), { code: 'CANCELLED' })), { once: true })
  })
  const plan = await makePlan(executing)
  const approval = await grantOnce(executing, plan, { signal: runController.signal })
  assert.equal(approval.guard(), undefined)
  const runPromise = executing.controller.run({ planDigest: plan.planDigest }, {
    agent: executing.owner,
    executionToken: approval.token,
    callId: approval.callId,
    signal: runController.signal,
  })
  await executingEntered.promise
  runController.abort()
  const run = await runPromise
  assert.equal(run.ok, false)
  assert.equal(run.failure.code, 'CANCELLED')
  assert.equal(run.cleanup.cellDisposed, true)
  await executing.controller.discard({ planDigest: plan.planDigest }, { agent: executing.owner })
})

test('cancellation after the final planning await commits no digest and leaves capacity reusable', async () => {
  const cancellation = new AbortController()
  let scans = 0
  let injectCancellation = true
  const f = fixture({
    scanTree: async () => {
      scans += 1
      if (injectCancellation && scans === 2) cancellation.abort('cancel at final planning evidence')
      return { root: resolve('workspace-agent-one'), fingerprint: SOURCE_FINGERPRINT, entries: [] }
    },
  })
  await assert.rejects(
    f.controller.plan({ outcome: 'cancelled plan', commands: [{ command: 'true' }] }, {
      agent: f.owner,
      signal: cancellation.signal,
    }),
    (cause) => cause.code === 'CANCELLED' && cause.details?.planDigest === undefined,
  )
  assert.deepEqual(f.controller.status(), { phase: 'idle' })
  injectCancellation = false
  const recovered = await makePlan(f)
  assert.match(recovered.planDigest, /^sha256:/u)
  await f.controller.discard({ planDigest: recovered.planDigest }, { agent: f.owner })
})

test('cancellation while opening or staging reaches owned cleanup and never schedules a later phase', async () => {
  const openingEntered = Promise.withResolvers()
  let openingCleaned = false
  const opening = fixture({
    openCell: async (_source, options) => new Promise((resolveValue, reject) => {
      openingEntered.resolve()
      options.signal.addEventListener('abort', () => {
        openingCleaned = true
        reject(Object.assign(new Error('opening cancelled'), { code: 'CANCELLED' }))
      }, { once: true })
    }),
  })
  const openingSignal = new AbortController()
  const openingPlan = await makePlan(opening)
  const openingApproval = await grantOnce(opening, openingPlan, { signal: openingSignal.signal })
  assert.equal(openingApproval.guard(), undefined)
  const openingRun = opening.controller.run({ planDigest: openingPlan.planDigest }, {
    agent: opening.owner,
    executionToken: openingApproval.token,
    callId: openingApproval.callId,
    signal: openingSignal.signal,
  })
  await openingEntered.promise
  openingSignal.abort()
  const openingReport = await openingRun
  assert.equal(openingReport.failure.code, 'CANCELLED')
  assert.equal(openingCleaned, true)
  assert.equal(openingReport.commands.length, 0)
  assert.equal(openingReport.staging.changed, false)
  await opening.controller.discard({ planDigest: openingPlan.planDigest }, { agent: opening.owner })

  const stagingEntered = Promise.withResolvers()
  const stagingSignal = new AbortController()
  const staging = fixture()
  staging.fakeCell.stageResult = async (options) => new Promise((resolveValue, reject) => {
    stagingEntered.resolve()
    options.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('staging cancelled'), { code: 'CANCELLED' }))
    }, { once: true })
  })
  const stagingPlan = await makePlan(staging)
  const stagingApproval = await grantOnce(staging, stagingPlan, { signal: stagingSignal.signal })
  assert.equal(stagingApproval.guard(), undefined)
  const stagingRun = staging.controller.run({ planDigest: stagingPlan.planDigest }, {
    agent: staging.owner,
    executionToken: stagingApproval.token,
    callId: stagingApproval.callId,
    signal: stagingSignal.signal,
  })
  await stagingEntered.promise
  stagingSignal.abort()
  const stagingReport = await stagingRun
  assert.equal(stagingReport.failure.code, 'CANCELLED')
  assert.equal(stagingReport.cleanup.cellDisposed, true)
  assert.equal(stagingReport.staging.changed, false)
  assert.equal(staging.state.disposed, 1)
  await staging.controller.discard({ planDigest: stagingPlan.planDigest }, { agent: staging.owner })
})

test('retains and poisons capacity on stage replacement, disappearance, and rename-away until verified discard', async () => {
  async function stagedFixture() {
    const source = await mkdtemp(join(tmpdir(), 'dsh-cell-workflow-source-'))
    const sourceFingerprint = fingerprintFileMap(new Map())
    const owner = agent('stage-owner')
    const f = fixture({
      owner,
      scanTree: async (path, options) => resolve(path) === resolve(source)
        ? ({ root: source, fingerprint: sourceFingerprint, entries: [] })
        : scanOrdinaryTree(path, options),
      inspectWorkspace: async () => ({
        root: source,
        headerPath: source,
        sessionId: 'stage-owner',
        pathIdentity: [],
        identityDigest: 'sha256:' + '6'.repeat(64),
        rootIdentity: { dev: '1', ino: '2' },
      }),
      doctor: async () => report(sourceFingerprint),
      cell: {
        sourceFingerprint,
        provider: { id: 'wsl2-bubblewrap', distro: 'fixture', kernel: 'fixture', bwrapVersion: 'fixture' },
        async exec() {
          return { stdout: '', stderr: '', exitCode: 0, cleanup: { observed: 0, killed: [], remaining: 0 } }
        },
        async stageResult(stageOptions) {
          const authority = await claimCellStageAuthority(stageOptions.authority)
          await writeFile(join(authority.destination, 'result.txt'), 'sealed\n', 'utf8')
          const tree = await scanOrdinaryTree(authority.destination)
          return {
            changed: true,
            staging: authority.destination,
            stagingRoot: authority.root,
            stageAuthority: authority.capability,
            changes: { created: ['result.txt'], modified: [], deleted: [] },
            sourceFingerprint,
            resultFingerprint: tree.fingerprint,
          }
        },
        async dispose() {},
      },
    })
    f.state.fingerprint = sourceFingerprint
    return { f, source }
  }

  async function runStaged(value) {
    const plan = await makePlan(value.f)
    const approval = await grantOnce(value.f, plan)
    assert.equal(approval.guard(), undefined)
    const run = await value.f.controller.run({ planDigest: plan.planDigest }, {
      agent: value.f.owner,
      executionToken: approval.token,
      callId: approval.callId,
    })
    assert.equal(run.staging.changed, true)
    return { plan, run }
  }

  const replaced = await stagedFixture()
  let replacedRoot
  try {
    const { plan, run } = await runStaged(replaced)
    replacedRoot = run.staging.root
    await rm(replacedRoot, { recursive: true, force: true })
    await mkdir(replacedRoot)
    await assert.rejects(
      replaced.f.controller.discard({ planDigest: plan.planDigest }, { agent: replaced.f.owner }),
      (cause) => cause.code === 'CELL_DISCARD_CLEANUP_FAILED'
        && cause.details.retainedRoot === replacedRoot,
    )
    assert.equal(replaced.f.controller.status().phase, 'cleanup-failed')
  } finally {
    if (replacedRoot) await rm(replacedRoot, { recursive: true, force: true })
    await rm(replaced.source, { recursive: true, force: true })
  }

  const missing = await stagedFixture()
  let missingRoot
  try {
    const { plan, run } = await runStaged(missing)
    missingRoot = run.staging.root
    await rm(missingRoot, { recursive: true, force: true })
    await assert.rejects(
      missing.f.controller.discard({ planDigest: plan.planDigest }, { agent: missing.f.owner }),
      (cause) => cause.code === 'CELL_DISCARD_CLEANUP_FAILED'
        && cause.details.retainedRoot === missingRoot
        && cause.details.cleanup.code === 'CELL_STAGE_MISSING',
    )
    assert.equal(missing.f.controller.status().phase, 'cleanup-failed')
  } finally {
    if (missingRoot) await rm(missingRoot, { recursive: true, force: true })
    await rm(missing.source, { recursive: true, force: true })
  }

  const moved = await stagedFixture()
  let movedRoot
  let movedAway
  try {
    const { plan, run } = await runStaged(moved)
    movedRoot = run.staging.root
    movedAway = movedRoot + '-renamed'
    await rename(movedRoot, movedAway)
    await assert.rejects(
      moved.f.controller.discard({ planDigest: plan.planDigest }, { agent: moved.f.owner }),
      (cause) => cause.code === 'CELL_DISCARD_CLEANUP_FAILED'
        && cause.details.retainedRoot === movedRoot,
    )
    assert.equal((await lstat(movedAway)).isDirectory(), true)
  } finally {
    if (movedRoot) await rm(movedRoot, { recursive: true, force: true })
    if (movedAway) await rm(movedAway, { recursive: true, force: true })
    await rm(moved.source, { recursive: true, force: true })
  }

  const verified = await stagedFixture()
  try {
    const { plan, run } = await runStaged(verified)
    const discarded = await verified.f.controller.discard({ planDigest: plan.planDigest }, { agent: verified.f.owner })
    assert.equal(discarded.cleanup.stageRemoved, true)
    assert.equal(discarded.cleanup.capacityReleased, true)
    await assert.rejects(lstat(run.staging.root), (cause) => cause.code === 'ENOENT')
  } finally {
    await rm(verified.source, { recursive: true, force: true })
  }
})

test('rejects unowned prefix stages and malformed minted paths or fingerprints without deleting external directories', async () => {
  const external = await mkdtemp(join(tmpdir(), '.dsh-developer-cell-authority-external-'))
  await writeFile(join(external, 'sentinel.txt'), 'external\n', 'utf8')
  try {
    const unowned = fixture()
    unowned.fakeCell.stageResult = async () => ({
      changed: true,
      staging: join(external, 'result'),
      stagingRoot: external,
      changes: { created: ['sentinel.txt'], modified: [], deleted: [] },
      sourceFingerprint: SOURCE_FINGERPRINT,
      resultFingerprint: 'sha256:' + '7'.repeat(64),
    })
    const unownedPlan = await makePlan(unowned)
    const unownedApproval = await grantOnce(unowned, unownedPlan)
    assert.equal(unownedApproval.guard(), undefined)
    const unownedRun = await unowned.controller.run({ planDigest: unownedPlan.planDigest }, {
      agent: unowned.owner,
      executionToken: unownedApproval.token,
      callId: unownedApproval.callId,
    })
    assert.equal(unownedRun.failure.code, 'CELL_STAGE_OWNERSHIP_INVALID')
    await unowned.controller.discard({ planDigest: unownedPlan.planDigest }, { agent: unowned.owner })
    assert.equal((await lstat(join(external, 'sentinel.txt'))).isFile(), true)

    for (const mode of ['alias', 'fingerprint']) {
      const source = await mkdtemp(join(tmpdir(), 'dsh-cell-malformed-stage-source-'))
      const sourceFingerprint = fingerprintFileMap(new Map())
      const owner = agent('malformed-' + mode)
      const value = fixture({
        owner,
        inspectWorkspace: async () => ({
          root: source,
          headerPath: source,
          sessionId: owner.session.header.id,
          pathIdentity: [],
          identityDigest: 'sha256:' + '6'.repeat(64),
          rootIdentity: { dev: '1', ino: '2' },
        }),
        scanTree: async (path, options) => resolve(path) === resolve(source)
          ? ({ root: source, fingerprint: sourceFingerprint, entries: [] })
          : scanOrdinaryTree(path, options),
        doctor: async () => report(sourceFingerprint),
      })
      value.state.fingerprint = sourceFingerprint
      value.fakeCell.sourceFingerprint = sourceFingerprint
      value.fakeCell.stageResult = async (stageOptions) => {
        const authority = await claimCellStageAuthority(stageOptions.authority)
        await writeFile(join(authority.destination, 'result.txt'), 'owned\n', 'utf8')
        const tree = await scanOrdinaryTree(authority.destination)
        return {
          changed: true,
          staging: mode === 'alias' ? external : authority.destination,
          stagingRoot: authority.root,
          stageAuthority: authority.capability,
          changes: { created: ['result.txt'], modified: [], deleted: [] },
          sourceFingerprint,
          resultFingerprint: mode === 'fingerprint' ? 'sha256:' + '9'.repeat(64) : tree.fingerprint,
        }
      }
      try {
        const plan = await makePlan(value)
        const approval = await grantOnce(value, plan)
        assert.equal(approval.guard(), undefined)
        const run = await value.controller.run({ planDigest: plan.planDigest }, {
          agent: value.owner,
          executionToken: approval.token,
          callId: approval.callId,
        })
        assert.match(run.failure.code, /CELL_STAGE_(?:OWNERSHIP_INVALID|MUTATED)/u)
        assert.equal(run.staging.retained, true)
        await value.controller.discard({ planDigest: plan.planDigest }, { agent: value.owner })
        assert.equal((await lstat(join(external, 'sentinel.txt'))).isFile(), true)
      } finally {
        await rm(source, { recursive: true, force: true })
      }
    }
  } finally {
    await rm(external, { recursive: true, force: true })
  }
})

test('mints retained staging physically outside the runtime-owned real-profile fence', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-cell-real-profile-'))
  await writeFile(join(profile, 'sentinel.txt'), 'real profile\n', 'utf8')
  const workflow = await makeStagedWorkflow({
    getProfileDirectory: () => profile,
    tmpdir: () => profile,
  })
  try {
    const relation = relative(profile, workflow.run.staging.root)
    assert.equal(relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith('..' + sep)), false)
    assert.equal(workflow.run.source.unchanged, true)
    const discarded = await workflow.value.controller.discard({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
    })
    assert.equal(discarded.cleanup.capacityReleased, true)
  } finally {
    await rm(workflow.source, { recursive: true, force: true })
    await rm(profile, { recursive: true, force: true })
  }
})

test('detects a barrier-controlled quarantine ancestor swap and never deletes the junction target', async () => {
  const external = await mkdtemp(join(tmpdir(), 'dsh-cell-external-sentinel-'))
  await writeFile(join(external, 'sentinel.txt'), 'must survive\n', 'utf8')
  let swapped = false
  let movedAnchor
  let replacementAnchor
  let junctionSupported = false
  const workflow = await makeStagedWorkflow({
    cleanupBarrier: async (phase, { stage }) => {
      if (phase !== 'after-quarantine-rename' || swapped) return
      swapped = true
      replacementAnchor = stage.anchor
      movedAnchor = stage.anchor + '-owned-moved'
      await rename(stage.anchor, movedAnchor)
      try {
        await symlink(external, stage.anchor, 'junction')
        junctionSupported = true
      } catch {
        await mkdir(stage.anchor)
      }
    },
  })
  try {
    await assert.rejects(
      workflow.value.controller.discard({ planDigest: workflow.plan.planDigest }, {
        agent: workflow.value.owner,
      }),
      (cause) => cause.code === 'CELL_DISCARD_CLEANUP_FAILED'
        && cause.details.retainedRoot === replacementAnchor,
    )
    assert.equal((await lstat(join(external, 'sentinel.txt'))).isFile(), true)
    const replacement = await lstat(replacementAnchor)
    if (replacement.isSymbolicLink()) await unlink(replacementAnchor)
    else await rm(replacementAnchor, { recursive: true, force: true })
    await rename(movedAnchor, replacementAnchor)
    movedAnchor = undefined
    const recovered = await workflow.value.controller.discard({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
    })
    assert.equal(recovered.cleanup.capacityReleased, true)
    assert.equal((await lstat(join(external, 'sentinel.txt'))).isFile(), true)
    assert.equal(typeof junctionSupported, 'boolean')
  } finally {
    if (replacementAnchor) {
      const replacement = await lstat(replacementAnchor).catch(() => undefined)
      if (replacement?.isSymbolicLink()) await unlink(replacementAnchor)
      else await rm(replacementAnchor, { recursive: true, force: true })
    }
    if (movedAnchor) await rm(movedAnchor, { recursive: true, force: true })
    await rm(workflow.source, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

test('drains verified quarantine cleanup after caller cancellation and resumes a bounded redacted partial failure', async () => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let held = false
  const cancellationWorkflow = await makeStagedWorkflow({
    cleanupBarrier: async (phase) => {
      if (phase !== 'before-delete-entry' || held) return
      held = true
      entered.resolve()
      await release.promise
    },
  })
  try {
    const cancellation = new AbortController()
    const discard = cancellationWorkflow.value.controller.discard({
      planDigest: cancellationWorkflow.plan.planDigest,
    }, { agent: cancellationWorkflow.value.owner, signal: cancellation.signal })
    await entered.promise
    cancellation.abort('caller left after cleanup commit')
    release.resolve()
    const result = await discard
    assert.equal(result.cleanup.capacityReleased, true)
    assert.deepEqual(cancellationWorkflow.value.controller.status(), { phase: 'idle' })
  } finally {
    await rm(cancellationWorkflow.source, { recursive: true, force: true })
  }

  const secret = ['sk', '-', 'partialcleanupsecret', 'TOKEN'].join('')
  let deleteEntries = 0
  let failed = false
  const retryWorkflow = await makeStagedWorkflow({
    cleanupBarrier: async (phase) => {
      if (phase !== 'before-delete-entry') return
      deleteEntries += 1
      if (deleteEntries === 2 && !failed) {
        failed = true
        throw new DshDeveloperError('CELL_INJECTED_CLEANUP', 'cleanup ' + secret, {
          stdout: secret,
          path: secret,
        })
      }
    },
  })
  try {
    await assert.rejects(
      retryWorkflow.value.controller.discard({ planDigest: retryWorkflow.plan.planDigest }, {
        agent: retryWorkflow.value.owner,
      }),
      (cause) => {
        const serialized = JSON.stringify(cause.details)
        return cause.code === 'CELL_DISCARD_CLEANUP_FAILED'
          && cause.details.cleanup.code === 'CELL_INJECTED_CLEANUP'
          && !serialized.includes(secret)
          && !serialized.includes('stdout')
      },
    )
    assert.equal(retryWorkflow.value.controller.status().phase, 'cleanup-failed')
    const recovered = await retryWorkflow.value.controller.discard({ planDigest: retryWorkflow.plan.planDigest }, {
      agent: retryWorkflow.value.owner,
    })
    assert.equal(recovered.cleanup.capacityReleased, true)
    assert.ok(deleteEntries >= 3)
  } finally {
    await rm(retryWorkflow.source, { recursive: true, force: true })
  }
})

test('requires a second exact approval and transactionally applies the sealed tree before verified cleanup', async () => {
  const workflow = await makeStagedWorkflow()
  try {
    assert.equal(workflow.run.ok, true)
    const approval = await grantOnce(workflow.value, workflow.plan, { operation: 'cell-apply', callId: 'apply-success' })
    assert.equal(approval.decision.kind, 'ask')
    for (const evidence of [
      workflow.plan.planDigest,
      workflow.run.source.fingerprintBefore,
      workflow.run.staging.fingerprint,
      'nested/more.txt',
      'result.txt',
      'backup/transaction',
      'Real profile effect: none',
    ]) assert.match(approval.decision.reason, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
    assert.equal(approval.guard(), undefined)
    const result = await workflow.value.controller.apply({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
      executionToken: approval.token,
      callId: approval.callId,
      signal: approval.exec.signal,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.source.fingerprintBefore, workflow.run.source.fingerprintBefore)
    assert.equal(result.source.fingerprintAfter, workflow.run.staging.fingerprint)
    assert.equal(result.cleanup.backupRemoved, true)
    assert.equal(result.cleanup.stageRemoved, true)
    assert.equal(result.cleanup.capacityReleased, true)
    assert.equal(await readFile(join(workflow.source, 'result.txt'), 'utf8'), 'sealed\n')
    const repeatedDiscard = await workflow.value.controller.discard({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
    })
    assert.equal(repeatedDiscard.alreadyApplied, true)
  } finally {
    await rm(workflow.source, { recursive: true, force: true })
  }
})

test('rolls back byte-identical source after a partial candidate install and retains the sealed stage', async () => {
  let injected = false
  const workflow = await makeStagedWorkflow({
    applyBarrier: async (phase) => {
      if (phase === 'after-install-candidate' && !injected) {
        injected = true
        throw new DshDeveloperError('CELL_INJECTED_PARTIAL_WRITE', 'forced partial write')
      }
    },
  })
  try {
    const approval = await grantOnce(workflow.value, workflow.plan, { operation: 'cell-apply', callId: 'apply-rollback' })
    assert.equal(approval.decision.kind, 'ask')
    assert.equal(approval.guard(), undefined)
    const result = await workflow.value.controller.apply({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
      executionToken: approval.token,
      callId: approval.callId,
      signal: approval.exec.signal,
    })
    assert.equal(result.ok, false)
    assert.equal(result.failure.code, 'CELL_INJECTED_PARTIAL_WRITE')
    assert.equal(result.rollback.required, true)
    assert.equal(result.rollback.verified, true)
    assert.equal(result.cleanup.transactionCleaned, true)
    assert.equal(result.cleanup.stageRetained, true)
    assert.equal((await scanOrdinaryTree(workflow.source)).fingerprint, workflow.run.source.fingerprintBefore)
    await assert.rejects(lstat(join(workflow.source, 'result.txt')), (cause) => cause.code === 'ENOENT')
    const discard = await workflow.value.controller.discard({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
    })
    assert.equal(discard.cleanup.capacityReleased, true)
  } finally {
    await rm(workflow.source, { recursive: true, force: true })
  }
})

test('restores same-identity external content drift in place before verifying rollback', async () => {
  let tampered = false
  const workflow = await makeStagedWorkflow({
    sourceFiles: { 'stable.txt': 'original\n' },
    stageFiles: { 'stable.txt': 'original\n', 'result.txt': 'created\n' },
    changes: { created: ['result.txt'], modified: [], deleted: [] },
    applyBarrier: async (phase, context) => {
      if (phase === 'after-install-candidate' && context.path === 'result.txt' && !tampered) {
        tampered = true
        await writeFile(join(context.record.workspace.root, 'stable.txt'), 'tampered\n', 'utf8')
      }
    },
  })
  try {
    const approval = await grantOnce(workflow.value, workflow.plan, {
      operation: 'cell-apply', callId: 'apply-content-drift-rollback',
    })
    assert.equal(approval.guard(), undefined)
    const result = await workflow.value.controller.apply({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
      executionToken: approval.token,
      callId: approval.callId,
      signal: approval.exec.signal,
    })
    assert.equal(result.ok, false)
    assert.equal(result.failure.code, 'CELL_APPLY_RESULT_MISMATCH', JSON.stringify(result))
    assert.equal(result.rollback.required, true)
    assert.equal(result.rollback.verified, true)
    assert.equal(await readFile(join(workflow.source, 'stable.txt'), 'utf8'), 'original\n')
    await assert.rejects(lstat(join(workflow.source, 'result.txt')), (cause) => cause.code === 'ENOENT')
    assert.equal((await scanOrdinaryTree(workflow.source)).fingerprint, workflow.run.source.fingerprintBefore)
    const discard = await workflow.value.controller.discard({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
    })
    assert.equal(discard.cleanup.capacityReleased, true)
  } finally {
    await rm(workflow.source, { recursive: true, force: true })
  }
})

test('does not mistake a high-entropy workspace suffix for a credential but blocks explicit token paths', async () => {
  const safeParent = await mkdtemp(join(tmpdir(), 'dsh-cell-approval-path-'))
  const safe = await makeStagedWorkflow({
    source: join(safeParent, ['dsh', 'developer', 'native', 'journey', 'source', 'X8SJG3'].join('-')),
  })
  try {
    const approval = await grantOnce(safe.value, safe.plan, {
      operation: 'cell-apply', callId: 'apply-high-entropy-path',
    })
    assert.equal(approval.decision.kind, 'ask')
    await safe.value.controller.discard({ planDigest: safe.plan.planDigest }, { agent: safe.value.owner })
  } finally {
    await rm(safeParent, { recursive: true, force: true })
  }

  const secretParent = await mkdtemp(join(tmpdir(), 'dsh-cell-approval-secret-'))
  const secret = await makeStagedWorkflow({
    source: join(secretParent, ['sk', '-', 'abcdefghijklmnop', 'SECRET'].join('')),
  })
  try {
    const approval = await grantOnce(secret.value, secret.plan, {
      operation: 'cell-apply', callId: 'apply-explicit-secret-path',
    })
    assert.equal(approval.decision.kind, 'deny')
    assert.match(approval.decision.reason, /CELL_APPLY_APPROVAL_SECRET/u)
  } finally {
    await rm(secret.run.staging.root, { recursive: true, force: true })
    await rm(secretParent, { recursive: true, force: true })
  }
})

test('applies created, modified, deleted, and unchanged paths as one verified staged tree', async () => {
  const workflow = await makeStagedWorkflow({
    sourceFiles: {
      'delete.txt': 'remove me\n',
      'keep.txt': 'before\n',
      'nested/same.txt': 'unchanged\n',
    },
    stageFiles: {
      'created.txt': 'created\n',
      'keep.txt': 'after\n',
      'nested/same.txt': 'unchanged\n',
    },
    changes: { created: ['created.txt'], modified: ['keep.txt'], deleted: ['delete.txt'] },
  })
  try {
    const approval = await grantOnce(workflow.value, workflow.plan, {
      operation: 'cell-apply', callId: 'apply-all-change-types',
    })
    assert.equal(approval.guard(), undefined)
    const result = await workflow.value.controller.apply({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
      executionToken: approval.token,
      callId: approval.callId,
      signal: approval.exec.signal,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.source.changedPaths, {
      created: ['created.txt'], modified: ['keep.txt'], deleted: ['delete.txt'],
    })
    assert.equal(await readFile(join(workflow.source, 'created.txt'), 'utf8'), 'created\n')
    assert.equal(await readFile(join(workflow.source, 'keep.txt'), 'utf8'), 'after\n')
    assert.equal(await readFile(join(workflow.source, 'nested', 'same.txt'), 'utf8'), 'unchanged\n')
    await assert.rejects(lstat(join(workflow.source, 'delete.txt')), (cause) => cause.code === 'ENOENT')
    assert.equal((await scanOrdinaryTree(workflow.source)).fingerprint, workflow.run.staging.fingerprint)
  } finally {
    await rm(workflow.source, { recursive: true, force: true })
  }
})

test('serializes pre-approved Apply calls and tombstones every later replay', async () => {
  let releaseBarrier
  let enterBarrier
  const entered = new Promise((resolvePromise) => { enterBarrier = resolvePromise })
  const released = new Promise((resolvePromise) => { releaseBarrier = resolvePromise })
  let held = false
  let transactionRoot
  const workflow = await makeStagedWorkflow({
    applyBarrier: async (phase, context) => {
      if (phase === 'after-candidate-copy' && !held) {
        held = true
        transactionRoot = context.transaction.root
        enterBarrier()
        await released
      }
    },
  })
  try {
    const first = await grantOnce(workflow.value, workflow.plan, {
      operation: 'cell-apply', callId: 'apply-serialized-1',
    })
    const second = await grantOnce(workflow.value, workflow.plan, {
      operation: 'cell-apply', callId: 'apply-serialized-2',
    })
    assert.equal(first.guard(), undefined)
    assert.equal(second.guard(), undefined)
    const running = workflow.value.controller.apply({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
      executionToken: first.token,
      callId: first.callId,
      signal: first.exec.signal,
    })
    const overlapping = workflow.value.controller.apply({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
      executionToken: second.token,
      callId: second.callId,
      signal: second.exec.signal,
    })
    await assert.rejects(overlapping, (cause) => cause.code === 'CELL_APPLY_IN_PROGRESS')
    await entered
    const prepared = JSON.parse(await readFile(join(transactionRoot, 'state-prepared.json'), 'utf8'))
    assert.equal(prepared.kind, 'dsh-developer-cell-apply-recovery')
    assert.equal(prepared.state, 'prepared')
    assert.equal(prepared.source, workflow.source)
    assert.equal(prepared.sourceFingerprint, workflow.run.source.fingerprintBefore)
    assert.equal(prepared.stageFingerprint, workflow.run.staging.fingerprint)
    releaseBarrier()
    assert.equal((await running).ok, true)
    await assert.rejects(
      workflow.value.controller.apply({ planDigest: workflow.plan.planDigest }, {
        agent: workflow.value.owner,
        executionToken: second.token,
        callId: second.callId,
        signal: second.exec.signal,
      }),
      (cause) => cause.code === 'CELL_PLAN_ALREADY_APPLIED',
    )
  } finally {
    releaseBarrier?.()
    await rm(workflow.source, { recursive: true, force: true })
  }
})

test('caller cancellation after source mutation drains byte-identical rollback before return', async () => {
  const cancellation = new AbortController()
  let aborted = false
  const workflow = await makeStagedWorkflow({
    applyBarrier: async (phase) => {
      if (phase === 'after-install-candidate' && !aborted) {
        aborted = true
        cancellation.abort('cancel after the first source mutation')
      }
    },
  })
  try {
    const approval = await grantOnce(workflow.value, workflow.plan, {
      operation: 'cell-apply', callId: 'apply-cancelled', signal: cancellation.signal,
    })
    assert.equal(approval.guard(), undefined)
    const result = await workflow.value.controller.apply({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
      executionToken: approval.token,
      callId: approval.callId,
      signal: cancellation.signal,
    })
    assert.equal(result.ok, false)
    assert.equal(result.failure.code, 'CANCELLED')
    assert.equal(result.rollback.required, true)
    assert.equal(result.rollback.verified, true)
    assert.equal((await scanOrdinaryTree(workflow.source)).fingerprint, workflow.run.source.fingerprintBefore)
    const discard = await workflow.value.controller.discard({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
    })
    assert.equal(discard.cleanup.capacityReleased, true)
  } finally {
    await rm(workflow.source, { recursive: true, force: true })
  }
})

test('reports an already-applied tree truthfully and resumes post-commit cleanup through discard', async () => {
  let failCleanup = true
  let committedMarker
  const workflow = await makeStagedWorkflow({
    applyBarrier: async (phase, context) => {
      if (phase === 'before-delete-transaction-entry'
          && context.path === 'state-committed.json' && failCleanup) {
        failCleanup = false
        committedMarker = JSON.parse(await readFile(
          join(context.transaction.root, 'state-committed.json'),
          'utf8',
        ))
        throw new DshDeveloperError('EBUSY', 'forced transient post-commit cleanup failure')
      }
    },
  })
  try {
    const approval = await grantOnce(workflow.value, workflow.plan, {
      operation: 'cell-apply', callId: 'apply-cleanup-resume',
    })
    assert.equal(approval.guard(), undefined)
    const result = await workflow.value.controller.apply({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
      executionToken: approval.token,
      callId: approval.callId,
      signal: approval.exec.signal,
    })
    assert.equal(result.ok, false)
    assert.equal(result.alreadyApplied, true)
    assert.equal(result.failure.code, 'CELL_APPLY_CLEANUP_FAILED')
    assert.equal(result.source.effect, 'exact-staged-tree-applied')
    assert.equal(result.source.fingerprintAfter, workflow.run.staging.fingerprint)
    assert.equal(result.rollback.required, false)
    assert.equal(result.cleanup.resumable, true)
    assert.equal(result.cleanup.capacityReleased, false)
    assert.equal(committedMarker.state, 'committed')
    assert.equal(committedMarker.stageFingerprint, workflow.run.staging.fingerprint)
    assert.equal(await readFile(join(workflow.source, 'result.txt'), 'utf8'), 'sealed\n')
    const repeated = await grantOnce(workflow.value, workflow.plan, {
      operation: 'cell-apply', callId: 'apply-after-commit',
    })
    assert.equal(repeated.decision.kind, 'deny')
    assert.match(repeated.decision.reason, /CELL_PLAN_ALREADY_APPLIED/u)
    const recovered = await workflow.value.controller.discard({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
    })
    assert.equal(recovered.alreadyApplied, true)
    assert.equal(recovered.cleanup.transactionRemoved, true)
    assert.equal(recovered.cleanup.stageRemoved, true)
    assert.equal(recovered.cleanup.capacityReleased, true)
    assert.equal(await readFile(join(workflow.source, 'result.txt'), 'utf8'), 'sealed\n')
  } finally {
    await rm(workflow.source, { recursive: true, force: true })
  }
})

test('preserves post-commit integrity failure when caller cancellation races cleanup', async () => {
  const cancellation = new AbortController()
  let transactionRoot
  let injected = false
  const workflow = await makeStagedWorkflow({
    applyBarrier: async (phase, context) => {
      if (phase === 'before-delete-transaction-entry' && !injected) {
        injected = true
        transactionRoot = context.transaction.root
        await writeFile(join(transactionRoot, 'unexpected.txt'), 'tampered\n', 'utf8')
        cancellation.abort('cancel while transaction integrity is failing')
      }
    },
  })
  try {
    const approval = await grantOnce(workflow.value, workflow.plan, {
      operation: 'cell-apply', callId: 'apply-cancel-integrity-race', signal: cancellation.signal,
    })
    assert.equal(approval.guard(), undefined)
    const result = await workflow.value.controller.apply({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
      executionToken: approval.token,
      callId: approval.callId,
      signal: cancellation.signal,
    })
    assert.equal(result.ok, false)
    assert.equal(result.alreadyApplied, true)
    assert.equal(result.failure.code, 'CELL_APPLY_CLEANUP_FAILED')
    assert.equal(result.failure.cleanup.code, 'CELL_TRANSACTION_CLEANUP_AMBIGUOUS')
    assert.equal(result.cleanup.resumable, false)
    assert.equal(result.cleanup.capacityReleased, false)
  } finally {
    if (transactionRoot !== undefined) await rm(transactionRoot, { recursive: true, force: true })
    await rm(workflow.run.staging.root, { recursive: true, force: true })
    await rm(workflow.source, { recursive: true, force: true })
  }
})

test('rejects a hardlink-swapped candidate and verifies rollback before cleanup', async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), 'dsh-cell-apply-hardlink-'))
  const external = join(externalRoot, 'external.txt')
  await writeFile(external, 'sealed\n', 'utf8')
  let swapped = false
  let restored = false
  const workflow = await makeStagedWorkflow({
    applyBarrier: async (phase, context) => {
      if (phase === 'before-install-candidate' && context.path === 'result.txt' && !swapped) {
        const candidate = join(context.transaction.candidate, 'result.txt')
        await unlink(candidate)
        await link(external, candidate)
        swapped = true
      } else if (phase === 'before-rollback' && swapped && !restored) {
        const candidate = join(context.transaction.candidate, 'result.txt')
        await unlink(candidate)
        await writeFile(candidate, 'sealed\n', 'utf8')
        restored = true
      }
    },
  })
  try {
    const approval = await grantOnce(workflow.value, workflow.plan, {
      operation: 'cell-apply', callId: 'apply-hardlink-swap',
    })
    assert.equal(approval.guard(), undefined)
    const result = await workflow.value.controller.apply({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
      executionToken: approval.token,
      callId: approval.callId,
      signal: approval.exec.signal,
    })
    assert.equal(result.ok, false)
    assert.equal(result.failure.code, 'CELL_APPLY_CANDIDATE_IDENTITY_CHANGED')
    assert.equal(result.rollback.required, true)
    assert.equal(result.rollback.verified, true)
    assert.equal(result.cleanup.transactionCleaned, true)
    assert.equal((await scanOrdinaryTree(workflow.source)).fingerprint, workflow.run.source.fingerprintBefore)
    const discard = await workflow.value.controller.discard({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
    })
    assert.equal(discard.cleanup.capacityReleased, true)
  } finally {
    await rm(workflow.source, { recursive: true, force: true })
    await rm(externalRoot, { recursive: true, force: true })
  }
})

test('never claims rollback after a source hardlink race changes physical identity', async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), 'dsh-cell-source-hardlink-'))
  const external = join(externalRoot, 'held-link.txt')
  let linked = false
  const workflow = await makeStagedWorkflow({
    sourceFiles: { 'locked.txt': 'before\n' },
    stageFiles: { 'locked.txt': 'after\n' },
    changes: { created: [], modified: ['locked.txt'], deleted: [] },
    applyBarrier: async (phase, context) => {
      if (phase === 'before-move-original' && context.path === 'locked.txt' && !linked) {
        await link(join(context.record.workspace.root, 'locked.txt'), external)
        linked = true
      }
    },
  })
  let retainedTransaction
  try {
    const approval = await grantOnce(workflow.value, workflow.plan, {
      operation: 'cell-apply', callId: 'apply-source-hardlink-race',
    })
    assert.equal(approval.guard(), undefined)
    const result = await workflow.value.controller.apply({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
      executionToken: approval.token,
      callId: approval.callId,
      signal: approval.exec.signal,
    })
    retainedTransaction = result.cleanup.retainedRoot
    assert.equal(result.ok, false)
    assert.equal(result.failure.code, 'CELL_APPLY_ROLLBACK_FAILED')
    assert.equal(result.rollback.required, true)
    assert.equal(result.rollback.verified, false)
    assert.equal(result.cleanup.capacityReleased, false)
    assert.equal(await readFile(join(workflow.source, 'locked.txt'), 'utf8'), 'before\n')
    await assert.rejects(
      workflow.value.controller.discard({ planDigest: workflow.plan.planDigest }, {
        agent: workflow.value.owner,
      }),
      (cause) => cause.code === 'CELL_APPLY_RECOVERY_REQUIRED',
    )
  } finally {
    await rm(externalRoot, { recursive: true, force: true })
    if (retainedTransaction !== undefined) await rm(retainedTransaction, { recursive: true, force: true })
    await rm(workflow.run.staging.root, { recursive: true, force: true })
    await rm(workflow.source, { recursive: true, force: true })
  }
})

test('blocks a fresh controller while a crash-recovery transaction remains beside source', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-cell-orphan-recovery-'))
  const source = join(parent, 'source')
  const orphan = join(parent, '.dsh-developer-cell-apply-crash-evidence')
  await mkdir(source)
  await mkdir(orphan)
  await writeFile(join(orphan, 'state-committing.json'), JSON.stringify({
    kind: 'dsh-developer-cell-apply-recovery', version: 1, state: 'committing', source,
  }) + '\n', 'utf8')
  const owner = agent('orphan-recovery-owner')
  const f = fixture({
    owner,
    inspectTreeIdentity: null,
    inspectWorkspace: async () => ({
      root: source,
      headerPath: source,
      sessionId: owner.session.header.id,
      pathIdentity: [],
      identityDigest: 'sha256:' + '7'.repeat(64),
      rootIdentity: { dev: '1', ino: '2' },
    }),
    scanTree: (path, options) => scanOrdinaryTree(path, options),
    doctor: async (path) => {
      const tree = await scanOrdinaryTree(path)
      return report(tree.fingerprint)
    },
  })
  try {
    await assert.rejects(
      makePlan(f),
      (cause) => cause.code === 'CELL_APPLY_RECOVERY_PENDING'
        && cause.details.retainedRoot === orphan
        && cause.details.retainedTransactions === 1
        && cause.details.recoveryState === 'committing',
    )
    assert.deepEqual(f.controller.status(), { phase: 'idle' })
    await rm(orphan, { recursive: true, force: true })
    const plan = await makePlan(f)
    const discard = await f.controller.discard({ planDigest: plan.planDigest }, { agent: owner })
    assert.equal(discard.cleanup.capacityReleased, true)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('owner disposal during Apply aborts mutation, rolls back, and releases capacity', async () => {
  let releaseBarrier
  let enterBarrier
  const entered = new Promise((resolvePromise) => { enterBarrier = resolvePromise })
  const released = new Promise((resolvePromise) => { releaseBarrier = resolvePromise })
  let held = false
  const workflow = await makeStagedWorkflow({
    applyBarrier: async (phase) => {
      if (phase === 'after-install-candidate' && !held) {
        held = true
        enterBarrier()
        await released
      }
    },
  })
  try {
    const approval = await grantOnce(workflow.value, workflow.plan, {
      operation: 'cell-apply', callId: 'apply-owner-dispose',
    })
    assert.equal(approval.guard(), undefined)
    const applying = workflow.value.controller.apply({ planDigest: workflow.plan.planDigest }, {
      agent: workflow.value.owner,
      executionToken: approval.token,
      callId: approval.callId,
      signal: approval.exec.signal,
    })
    await entered
    const disposing = workflow.value.controller.disposeOwner(workflow.value.owner)
    releaseBarrier()
    const result = await applying
    assert.equal(result.ok, false)
    assert.equal(result.failure.code, 'CANCELLED')
    assert.equal(result.rollback.verified, true)
    await disposing
    assert.deepEqual(workflow.value.controller.status(), { phase: 'idle' })
    assert.equal((await scanOrdinaryTree(workflow.source)).fingerprint, workflow.run.source.fingerprintBefore)
  } finally {
    releaseBarrier?.()
    await rm(workflow.source, { recursive: true, force: true })
  }
})

test('live workspace authority rejects missing, child, relative, and junction-marked contexts without cwd fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cell-authority-'))
  try {
    const top = { ctx: {}, session: { header: { id: 'top', cwd: root, origin: 'user', delegationDepth: 0 } } }
    const workspace = await inspectLiveAgentWorkspace(top, { isRootAgent: (candidate) => candidate === top })
    assert.equal(workspace.root, resolve(await realpath(root)))
    const cleanHeaderChild = {
      ctx: {}, session: { header: { id: 'clean-child', cwd: root, origin: 'user', delegationDepth: 0 } },
    }
    await assert.rejects(
      inspectLiveAgentWorkspace(cleanHeaderChild, { isRootAgent: (candidate) => candidate === top }),
      (cause) => cause.code === 'CELL_ROOT_AGENT_NOT_LIVE',
    )
    await assert.rejects(inspectLiveAgentWorkspace(undefined), (cause) => cause.code === 'CELL_AGENT_REQUIRED')
    await assert.rejects(inspectLiveAgentWorkspace({
      ctx: {}, session: { header: { id: 'child', cwd: root, origin: 'subagent', delegationDepth: 1, parentSession: 'top' } },
    }, { isRootAgent: () => true }), (cause) => cause.code === 'CELL_TOP_LEVEL_AGENT_REQUIRED')
    await assert.rejects(inspectLiveAgentWorkspace({
      ctx: {}, session: { header: { id: 'relative', cwd: 'relative', origin: 'user', delegationDepth: 0 } },
    }, { isRootAgent: () => true }), (cause) => cause.code === 'CELL_WORKSPACE_AUTHORITY_UNAVAILABLE')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
