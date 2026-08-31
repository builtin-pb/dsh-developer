import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { inspectDelegationSafety } from './delegation-safety.js'

export const DELEGATION_PROBE_WITNESS = '.dsh-developer-delegation-witness.json'

function probeConfiguration() {
  const token = process.env.DSH_DEVELOPER_DELEGATION_PROBE
  if (token === undefined) return undefined
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('dsh-developer: invalid delegation-probe token')
  const home = process.env.DSH_HOME
  if (typeof home !== 'string' || home.length === 0) {
    throw new Error('dsh-developer: delegation probe requires DSH_HOME')
  }
  return { token, home: resolve(home) }
}

async function composeParent(ctx, agentCtx) {
  const presets = ctx.get('agentPresets')
  if (presets !== undefined) await presets.mount(agentCtx)
}

function composeChild(ctx, childCtx, parent) {
  ctx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)
}

function textContent(result) {
  return Array.isArray(result?.content)
    ? result.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
    : ''
}

async function executeProbe(ctx, config) {
  const parentId = randomUUID()
  const childId = randomUUID()
  let parentHandle
  let childHandle
  try {
    parentHandle = await ctx.agents.create({
      sessionId: parentId,
      meta: { cwd: config.home },
      setup: (agentCtx) => composeParent(ctx, agentCtx),
    })
    childHandle = await parentHandle.agent.ctx.agents.create({
      sessionId: childId,
      meta: {
        cwd: config.home,
        parentSession: parentId,
        origin: 'subagent',
        delegationDepth: 1,
      },
      setup: (agentCtx) => composeChild(ctx, agentCtx, parentHandle.agent),
    })
    const parent = inspectDelegationSafety(
      parentHandle.agent,
      ctx.tools.schemas(parentHandle.agent),
    )
    const child = inspectDelegationSafety(
      childHandle.agent,
      ctx.tools.schemas(childHandle.agent),
    )
    const parentEscalationTools = parent.tools
      .filter((tool) => tool.status === 'escalation-advertised')
      .map((tool) => tool.name)
    if (parentEscalationTools.length === 0) {
      throw new Error('delegation probe found no parent escalation schema to correct')
    }
    if (!child.ok || child.tools.some((tool) => tool.exposed.length > 0)) {
      throw new Error('delegation probe observed escalation fields in the fixed child scope')
    }

    const native = ctx.tools.get('dsh_developer', childHandle.agent)
    if (native === undefined) throw new Error('delegation probe could not resolve dsh_developer')
    const nativeEnvelope = await native.execute(
      { operation: 'delegation' },
      { signal: new AbortController().signal, agent: childHandle.agent },
    )
    if (nativeEnvelope?.operation !== 'delegation' || nativeEnvelope?.report?.ok !== true) {
      throw new Error('delegation probe native evidence operation did not pass')
    }

    const guarded = await ctx.tools.execute({
      callId: 'dsh-developer-delegation-probe-' + randomUUID(),
      name: parentEscalationTools[0],
      arguments: {
        sandbox_permissions: 'workspace-write',
        justification: 'Verify the delegated fixed-scope denial.',
      },
      agent: childHandle.agent,
      signal: new AbortController().signal,
    })
    const guardedText = textContent(guarded)
    if (guarded.isError !== true || !guardedText.includes('cannot widen its permission scope')) {
      throw new Error('delegation probe runtime guard did not deny hidden escalation arguments')
    }

    await childHandle.dispose()
    childHandle = undefined
    await parentHandle.dispose()
    parentHandle = undefined
    const witness = {
      token: config.token,
      ok: true,
      parentEscalationTools,
      child: {
        ok: child.ok,
        applies: child.applies,
        tools: child.tools,
        evidenceDigest: child.evidenceDigest,
      },
      native: {
        operation: nativeEnvelope.operation,
        ok: nativeEnvelope.ok,
        evidenceDigest: nativeEnvelope.report.evidenceDigest,
      },
      guard: { denied: guarded.isError, text: guardedText },
    }
    await writeFile(join(config.home, DELEGATION_PROBE_WITNESS), JSON.stringify(witness, null, 2) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } finally {
    if (childHandle !== undefined) await childHandle.dispose().catch(() => {})
    if (parentHandle !== undefined) await parentHandle.dispose().catch(() => {})
  }
}

export function registerDelegationProbe(ctx) {
  const config = probeConfiguration()
  if (config === undefined) return
  ctx.inject(['agentLoop', 'appExit'], (probeCtx) => {
    const requestExit = probeCtx.get('appExit')
    if (typeof requestExit !== 'function') throw new Error('dsh-developer: delegation probe requires appExit')
    void executeProbe(probeCtx, config).then(
      () => { requestExit(0) },
      (error) => {
        probeCtx.logger.error('dsh-developer delegation probe failed: ' + (error?.message ?? String(error)))
        requestExit(1)
      },
    )
  })
}
