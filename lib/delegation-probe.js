// @ts-check
import { randomUUID } from 'node:crypto'
import { access, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { inspectAuthoritySafetyFromSources, inspectDelegationSafety } from './delegation-safety.js'
import { redactSensitiveOutput } from './security.js'

/**
 * @import { Context } from '@deepseek-ai/cordis'
 * @import { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
 * @import { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
 * @import { ProbeConfiguration, ProbeDependencies, ProbeRegistration } from './delegation-types.js'
 */

export const DELEGATION_PROBE_WITNESS = '.dsh-developer-delegation-witness.json'

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object'
}

/** @param {unknown} error @param {ProbeConfiguration} config */
function failureDiagnostic(error, config) {
  const stack = isRecord(error) ? error.stack : undefined
  const text = (typeof stack === 'string' ? stack : String(error))
    .replaceAll(config.token, '[probe-token]')
    .replaceAll(config.home, '[probe-home]')
  /** @type {unknown} */
  const redacted = redactSensitiveOutput(text)
  if (typeof redacted !== 'string') throw new TypeError('probe diagnostic must be a string')
  return redacted.slice(0, 8192)
}

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

/** @param {ProbeDependencies['resolveAgentPresets']} resolveAgentPresets @param {Context} agentCtx */
async function composeParent(resolveAgentPresets, agentCtx) {
  const presets = resolveAgentPresets()
  if (presets !== undefined) await presets.mount(agentCtx)
}

/** @param {ProbeDependencies['resolveAgentPresets']} resolveAgentPresets @param {Context} childCtx @param {Agent} parent */
function composeChild(resolveAgentPresets, childCtx, parent) {
  resolveAgentPresets()?.composeFrom(childCtx, parent.ctx)
}

/** @param {ToolExecutionResult} result */
function textContent(result) {
  return Array.isArray(result?.content)
    ? result.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
    : ''
}

/** @param {ProbeDependencies['tools']} tools @param {Agent} agent */
function scopedShell(tools, agent) {
  const shell = ['bash', 'pwsh'].find((name) => tools.get(name, agent) !== undefined)
  if (shell === undefined) throw new Error('delegation probe requires a scoped bash or pwsh tool')
  return shell
}

/** @param {string} shell @param {string} value */
function quoteShellLiteral(shell, value) {
  return "'" + value.replaceAll("'", shell === 'pwsh' ? "''" : "'\"'\"'") + "'"
}

/** @param {string} shell @param {string} marker */
function noOpCommand(shell, marker) {
  return (shell === 'pwsh' ? 'Write-Output ' : "printf '%s\\n' ") + quoteShellLiteral(shell, marker)
}

/**
 * @param {ProbeDependencies['tools']} tools
 * @param {Agent} agent
 * @param {string} shell
 * @param {string} command
 * @param {Record<string, unknown>} [extra]
 */
async function executeShell(tools, agent, shell, command, extra = {}) {
  if (tools.get(shell, agent) === undefined) throw new Error('delegation probe lost its scoped ' + shell + ' tool')
  return await tools.execute({
    // These locally minted nonempty IDs only need the upstream nominal brand.
    callId: /** @type {ToolExecutionInput['callId']} */ ('dsh-developer-authority-probe-' + randomUUID()),
    name: shell,
    arguments: {
      command,
      description: 'Exercise fixed authority behavior',
      ...extra,
    },
    agent,
    signal: new AbortController().signal,
  })
}

/**
 * Run through the registry so it supplies the complete upstream ToolRunContext.
 * @param {ProbeDependencies['tools']} tools
 * @param {Agent} agent
 * @param {'authority' | 'delegation'} operation
 */
async function executeEvidence(tools, agent, operation) {
  const result = await tools.execute({
    callId: /** @type {ToolExecutionInput['callId']} */ ('dsh-developer-evidence-probe-' + randomUUID()),
    name: 'dsh_developer',
    arguments: { operation },
    agent,
    signal: new AbortController().signal,
  })
  const envelope = result.value
  if (result.isError || !isRecord(envelope) || envelope.operation !== operation
      || !isRecord(envelope.report) || envelope.report.ok !== true
      || typeof envelope.ok !== 'boolean' || typeof envelope.report.evidenceDigest !== 'string') {
    throw new Error(operation + ' probe native evidence operation did not pass')
  }
  return {
    operation: envelope.operation,
    ok: envelope.ok,
    report: { evidenceDigest: envelope.report.evidenceDigest },
  }
}

/** @param {ProbeDependencies} dependencies @param {ProbeConfiguration} config */
async function executeProbe({
  agents,
  tools,
  authoritySources,
  resolveAgentPresets,
  resolvePermissionPresets,
}, config) {
  const parentId = /** @type {Agent['id']} */ (randomUUID())
  const childId = /** @type {Agent['id']} */ (randomUUID())
  /** @type {AgentHandle | undefined} */
  let parentHandle
  /** @type {AgentHandle | undefined} */
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
    const parentShell = scopedShell(tools, parentHandle.agent)

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
    const parentNoOp = await executeShell(tools, parentHandle.agent, parentShell, noOpCommand(parentShell, 'authority-parent-ok'), {
      sandbox_permissions: 'workspace-write',
      justification: 'This redundant request must be removed before upstream execution.',
    })
    const parentNoOpText = textContent(parentNoOp)
    if (parentNoOp.isError || !parentNoOpText.includes('authority-parent-ok')) {
      throw new Error('authority probe did not sanitize a redundant maximum-scope request\n' + parentNoOpText)
    }

    const native = tools.get('dsh_developer', parentHandle.agent)
    if (native === undefined) throw new Error('authority probe could not resolve dsh_developer')
    const authorityEnvelope = await executeEvidence(tools, parentHandle.agent, 'authority')

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
    const parentApprovalNoOp = await executeShell(
      tools,
      parentHandle.agent,
      parentShell,
      noOpCommand(parentShell, 'authority-parent-approval-ok'),
      {
        sandbox_permissions: 'danger-full-access',
        justification: 'This impossible approval-disabled request must be removed.',
      },
    )
    const parentApprovalNoOpText = textContent(parentApprovalNoOp)
    if (parentApprovalNoOp.isError || !parentApprovalNoOpText.includes('authority-parent-approval-ok')) {
      throw new Error('authority probe did not sanitize an approval-disabled request\n' + parentApprovalNoOpText)
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

    const parent = parentHandle.agent
    childHandle = await parent.ctx.agents.create({
      sessionId: childId,
      meta: {
        cwd: config.home,
        parentSession: parentId,
        origin: 'subagent',
        delegationDepth: 1,
      },
      setup: (agentCtx) => composeChild(resolveAgentPresets, agentCtx, parent),
    })
    const child = inspectDelegationSafety(
      childHandle.agent,
      tools.schemas(childHandle.agent),
    )
    if (!child.ok || child.tools.some((tool) => tool.status !== 'fixed-scope')) {
      throw new Error('delegation probe observed escalation guidance in the fixed child scope')
    }
    const childShell = scopedShell(tools, childHandle.agent)

    const childNative = tools.get('dsh_developer', childHandle.agent)
    if (childNative === undefined) throw new Error('delegation probe could not resolve dsh_developer')
    const delegationEnvelope = await executeEvidence(tools, childHandle.agent, 'delegation')

    const childNoOp = await executeShell(tools, childHandle.agent, childShell, noOpCommand(childShell, 'authority-child-ok'), {
      sandbox_permissions: 'danger-full-access',
      justification: 'This impossible child request must be removed before upstream execution.',
    })
    const childNoOpText = textContent(childNoOp)
    if (childNoOp.isError || !childNoOpText.includes('authority-child-ok')) {
      throw new Error('delegation probe did not sanitize an impossible child escalation request\n' + childNoOpText)
    }

    childHandle.agent.session.append('sandbox/mode', { mode: 'read-only' })
    const deniedPath = join(config.home, 'must-not-write.txt')
    const escapedPath = quoteShellLiteral(childShell, deniedPath)
    const denied = await executeShell(
      tools,
      childHandle.agent,
      childShell,
      childShell === 'pwsh'
        ? 'Set-Content -LiteralPath ' + escapedPath + ' -Value blocked'
        : "printf '%s\\n' blocked > " + escapedPath,
    )
    const deniedText = textContent(denied)
    let deniedWriteExists = false
    try {
      await access(deniedPath)
      deniedWriteExists = true
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error
    }
    if (deniedWriteExists || !deniedText.includes('authority is fixed')
        || deniedText.includes('escalation available')) {
      throw new Error('delegation probe did not preserve denied fixed-authority behavior\n' + deniedText)
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
        shell: parentShell,
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
        shell: childShell,
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
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    })
  } finally {
    if (childHandle !== undefined) await childHandle.dispose().catch(() => {})
    if (parentHandle !== undefined) await parentHandle.dispose().catch(() => {})
  }
}

/** @param {ProbeRegistration} dependencies */
export function registerDelegationProbeWithDependencies({ injectProbeServices }) {
  const config = probeConfiguration()
  if (config === undefined) return
  injectProbeServices((probeCtx) => {
    const requestExit = probeCtx.get(/** @satisfies {keyof Context} */ ('appExit'))
    if (typeof requestExit !== 'function') throw new Error('dsh-developer: delegation probe requires appExit')
    const dependencies = {
      agents: probeCtx.agents,
      tools: probeCtx.tools,
      requestExit,
      authoritySources: {
        sandboxPolicy: () => probeCtx.get(/** @satisfies {keyof Context} */ ('sandboxPolicy')),
        approval: () => probeCtx.get(/** @satisfies {keyof Context} */ ('approval')),
      },
      resolveAgentPresets: () => probeCtx.get(/** @satisfies {keyof Context} */ ('agentPresets')),
      resolvePermissionPresets: () => probeCtx.get(/** @satisfies {keyof Context} */ ('permissionPresets')),
    }
    void executeProbe(dependencies, config).then(
      () => { dependencies.requestExit(0) },
      /** @param {unknown} error */
      async (error) => {
        const diagnostic = failureDiagnostic(error, config)
        // A custom base profile need not have a logger sink. Flush stderr before
        // requesting exit so the caller retains the error after profile cleanup.
        try {
          await new Promise((accept) => {
            process.stderr.write('dsh-developer delegation probe failed: ' + diagnostic + '\n', accept)
          })
        } finally {
          dependencies.requestExit(1)
        }
      },
    )
  })
}

/** @param {Context} ctx */
export function registerDelegationProbe(ctx) {
  return registerDelegationProbeWithDependencies({
    injectProbeServices: (callback) => ctx.inject(['agentLoop', 'appExit'], callback),
  })
}
