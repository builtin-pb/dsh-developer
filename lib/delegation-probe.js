import { randomUUID } from 'node:crypto'
import { access, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { inspectAuthoritySafetyFromSources, inspectDelegationSafety } from './delegation-safety.js'

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

async function composeParent(resolveAgentPresets, agentCtx) {
  const presets = resolveAgentPresets()
  if (presets !== undefined) await presets.mount(agentCtx)
}

function composeChild(resolveAgentPresets, childCtx, parent) {
  resolveAgentPresets()?.composeFrom(childCtx, parent.ctx)
}

function textContent(result) {
  return Array.isArray(result?.content)
    ? result.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
    : ''
}

async function executePwsh(tools, agent, command, extra = {}) {
  const schema = tools.get('pwsh', agent)
  if (schema === undefined) throw new Error('delegation probe requires the scoped pwsh tool')
  return await tools.execute({
    callId: 'dsh-developer-authority-probe-' + randomUUID(),
    name: 'pwsh',
    arguments: {
      command,
      description: 'Exercise fixed authority behavior',
      ...extra,
    },
    agent,
    signal: new AbortController().signal,
  })
}

async function executeProbe({
  agents,
  tools,
  authoritySources,
  resolveAgentPresets,
  resolvePermissionPresets,
}, config) {
  const parentId = randomUUID()
  const childId = randomUUID()
  let parentHandle
  let childHandle
  try {
    parentHandle = await agents.create({
      sessionId: parentId,
      meta: { cwd: config.home },
      setup: (agentCtx) => composeParent(resolveAgentPresets, agentCtx),
    })
    const parentMutable = inspectAuthoritySafetyFromSources(
      authoritySources,
      parentHandle.agent,
      tools.schemas(parentHandle.agent),
    )
    if (!parentMutable.ok || parentMutable.applies) {
      throw new Error('authority probe expected the initial parent scope to remain mutable')
    }
    const parentEscalationTools = parentMutable.tools
      .filter((tool) => tool.status === 'escalation-advertised')
      .map((tool) => tool.name)
    if (parentEscalationTools.length === 0) {
      throw new Error('authority probe found no parent escalation schema to correct')
    }

    const permissionPresets = resolvePermissionPresets()
    if (permissionPresets === undefined) throw new Error('authority probe requires permissionPresets')
    permissionPresets.set(parentHandle.agent.session, 'danger-full-access')
    const parentMaximum = inspectAuthoritySafetyFromSources(
      authoritySources,
      parentHandle.agent,
      tools.schemas(parentHandle.agent),
    )
    if (!parentMaximum.ok || !parentMaximum.applies
        || !parentMaximum.authority.reasons.includes('maximum-sandbox')) {
      throw new Error('authority probe did not correct the maximum parent scope')
    }
    const parentNoOp = await executePwsh(tools, parentHandle.agent, 'Write-Output authority-parent-ok', {
      sandbox_permissions: 'workspace-write',
      justification: 'This redundant request must be removed before upstream execution.',
    })
    const parentNoOpText = textContent(parentNoOp)
    if (parentNoOp.isError || !parentNoOpText.includes('authority-parent-ok')) {
      throw new Error('authority probe did not sanitize a redundant maximum-scope request')
    }

    const native = tools.get('dsh_developer', parentHandle.agent)
    if (native === undefined) throw new Error('authority probe could not resolve dsh_developer')
    const authorityEnvelope = await native.execute(
      { operation: 'authority' },
      { signal: new AbortController().signal, agent: parentHandle.agent },
    )
    if (authorityEnvelope?.operation !== 'authority' || authorityEnvelope?.report?.ok !== true) {
      throw new Error('authority probe native evidence operation did not pass')
    }

    permissionPresets.set(parentHandle.agent.session, 'workspace-write')
    const parentRestored = inspectAuthoritySafetyFromSources(
      authoritySources,
      parentHandle.agent,
      tools.schemas(parentHandle.agent),
    )
    if (!parentRestored.ok || parentRestored.applies
        || parentRestored.tools.every((tool) => tool.status !== 'escalation-advertised')) {
      throw new Error('authority probe did not restore the mutable parent schema')
    }

    parentHandle.agent.session.append('approval/policy', { policy: 'never' })
    const parentApprovalDisabled = inspectAuthoritySafetyFromSources(
      authoritySources,
      parentHandle.agent,
      tools.schemas(parentHandle.agent),
    )
    if (!parentApprovalDisabled.ok || !parentApprovalDisabled.applies
        || !parentApprovalDisabled.authority.reasons.includes('approval-disabled')
        || parentApprovalDisabled.authority.reasons.includes('maximum-sandbox')) {
      throw new Error('authority probe did not correct the approval-disabled parent scope')
    }
    const parentApprovalNoOp = await executePwsh(
      tools,
      parentHandle.agent,
      'Write-Output authority-parent-approval-ok',
      {
        sandbox_permissions: 'danger-full-access',
        justification: 'This impossible approval-disabled request must be removed.',
      },
    )
    const parentApprovalNoOpText = textContent(parentApprovalNoOp)
    if (parentApprovalNoOp.isError || !parentApprovalNoOpText.includes('authority-parent-approval-ok')) {
      throw new Error('authority probe did not sanitize an approval-disabled request')
    }
    parentHandle.agent.session.append('approval/policy', { policy: 'ask' })
    const parentApprovalRestored = inspectAuthoritySafetyFromSources(
      authoritySources,
      parentHandle.agent,
      tools.schemas(parentHandle.agent),
    )
    if (!parentApprovalRestored.ok || parentApprovalRestored.applies
        || parentApprovalRestored.tools.every((tool) => tool.status !== 'escalation-advertised')) {
      throw new Error('authority probe did not restore schemas after approvals were re-enabled')
    }

    childHandle = await parentHandle.agent.ctx.agents.create({
      sessionId: childId,
      meta: {
        cwd: config.home,
        parentSession: parentId,
        origin: 'subagent',
        delegationDepth: 1,
      },
      setup: (agentCtx) => composeChild(resolveAgentPresets, agentCtx, parentHandle.agent),
    })
    const child = inspectDelegationSafety(
      childHandle.agent,
      tools.schemas(childHandle.agent),
    )
    if (!child.ok || child.tools.some((tool) => tool.status !== 'fixed-scope')) {
      throw new Error('delegation probe observed escalation guidance in the fixed child scope')
    }

    const childNative = tools.get('dsh_developer', childHandle.agent)
    if (childNative === undefined) throw new Error('delegation probe could not resolve dsh_developer')
    const delegationEnvelope = await childNative.execute(
      { operation: 'delegation' },
      { signal: new AbortController().signal, agent: childHandle.agent },
    )
    if (delegationEnvelope?.operation !== 'delegation' || delegationEnvelope?.report?.ok !== true) {
      throw new Error('delegation probe native evidence operation did not pass')
    }

    const childNoOp = await executePwsh(tools, childHandle.agent, 'Write-Output authority-child-ok', {
      sandbox_permissions: 'danger-full-access',
      justification: 'This impossible child request must be removed before upstream execution.',
    })
    const childNoOpText = textContent(childNoOp)
    if (childNoOp.isError || !childNoOpText.includes('authority-child-ok')) {
      throw new Error('delegation probe did not sanitize an impossible child escalation request')
    }

    childHandle.agent.session.append('sandbox/mode', { mode: 'read-only' })
    const deniedPath = join(config.home, 'must-not-write.txt')
    const escapedPath = deniedPath.replaceAll("'", "''")
    const denied = await executePwsh(
      tools,
      childHandle.agent,
      "Set-Content -LiteralPath '" + escapedPath + "' -Value blocked",
    )
    const deniedText = textContent(denied)
    let deniedWriteExists = false
    try {
      await access(deniedPath)
      deniedWriteExists = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (deniedWriteExists || !deniedText.includes('authority is fixed')
        || deniedText.includes('escalation available')) {
      throw new Error('delegation probe did not preserve denied fixed-authority behavior')
    }

    await childHandle.dispose()
    childHandle = undefined
    await parentHandle.dispose()
    parentHandle = undefined
    const witness = {
      token: config.token,
      ok: true,
      parentEscalationTools,
      parent: {
        mutable: { ok: parentMutable.ok, applies: parentMutable.applies },
        maximum: {
          ok: parentMaximum.ok,
          applies: parentMaximum.applies,
          reasons: parentMaximum.authority.reasons,
          tools: parentMaximum.tools,
          evidenceDigest: parentMaximum.evidenceDigest,
        },
        restored: { ok: parentRestored.ok, applies: parentRestored.applies },
        approvalDisabled: {
          ok: parentApprovalDisabled.ok,
          applies: parentApprovalDisabled.applies,
          reasons: parentApprovalDisabled.authority.reasons,
          tools: parentApprovalDisabled.tools,
          evidenceDigest: parentApprovalDisabled.evidenceDigest,
          noOp: { isError: parentApprovalNoOp.isError, text: parentApprovalNoOpText },
        },
        approvalRestored: {
          ok: parentApprovalRestored.ok,
          applies: parentApprovalRestored.applies,
        },
        noOp: { isError: parentNoOp.isError, text: parentNoOpText },
      },
      child: {
        ok: child.ok,
        applies: child.applies,
        tools: child.tools,
        evidenceDigest: child.evidenceDigest,
      },
      native: {
        authority: {
          operation: authorityEnvelope.operation,
          ok: authorityEnvelope.ok,
          evidenceDigest: authorityEnvelope.report.evidenceDigest,
        },
        delegation: {
          operation: delegationEnvelope.operation,
          ok: delegationEnvelope.ok,
          evidenceDigest: delegationEnvelope.report.evidenceDigest,
        },
      },
      sanitization: {
        child: { isError: childNoOp.isError, text: childNoOpText },
        denial: { isError: denied.isError, wroteFile: deniedWriteExists, text: deniedText },
      },
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

export function registerDelegationProbeWithDependencies({ injectProbeServices }) {
  const config = probeConfiguration()
  if (config === undefined) return
  injectProbeServices((probeCtx) => {
    const requestExit = probeCtx.get('appExit')
    if (typeof requestExit !== 'function') throw new Error('dsh-developer: delegation probe requires appExit')
    const dependencies = {
      agents: probeCtx.agents,
      tools: probeCtx.tools,
      logger: probeCtx.logger,
      requestExit,
      authoritySources: {
        sandboxPolicy: () => probeCtx.get('sandboxPolicy'),
        approval: () => probeCtx.get('approval'),
      },
      resolveAgentPresets: () => probeCtx.get('agentPresets'),
      resolvePermissionPresets: () => probeCtx.get('permissionPresets'),
    }
    void executeProbe(dependencies, config).then(
      () => { dependencies.requestExit(0) },
      (error) => {
        dependencies.logger.error('dsh-developer delegation probe failed: ' + (error?.message ?? String(error)))
        dependencies.requestExit(1)
      },
    )
  })
}

export function registerDelegationProbe(ctx) {
  return registerDelegationProbeWithDependencies({
    injectProbeServices: (callback) => ctx.inject(['agentLoop', 'appExit'], callback),
  })
}
