// @ts-check
/** @import { Agent } from '@deepseek-ai/dsh-agent' */
/** @import { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools' */
/** @import { WorkspaceInspectionDependencies, WorkspaceInspectionOptions, CellApprovalInput, CellApprovalDependencies, CellApprovalProof, CellApprovalCall } from './native-cell-context-types.js' */

import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { DshDeveloperError } from './errors.js'

const TOOL_NAME = 'dsh_developer'
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u

/** @param {unknown} value @returns {value is string} */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/** @param {WorkspaceInspectionDependencies} dependencies */
export function createCellWorkspaceInspector({ snapshotPath, samePathSnapshot, digest, freeze }) {
  /** @param {Agent | null | undefined} agent @param {WorkspaceInspectionOptions} [options] */
  return async function inspectLiveAgentWorkspace(agent, options = {}) {
    if (agent === null || typeof agent !== 'object' || agent.ctx === null || typeof agent.ctx !== 'object') {
      throw new DshDeveloperError('CELL_AGENT_REQUIRED', 'Isolated Build requires the exact live top-level exec.agent object.')
    }
    if (typeof options.isRootAgent !== 'function' || options.isRootAgent(agent) !== true) {
      throw new DshDeveloperError(
        'CELL_ROOT_AGENT_NOT_LIVE',
        'The exact exec.agent object is not present in the authoritative live top-level Agent registry.',
      )
    }
    const header = agent.session?.header
    if (header === null || typeof header !== 'object') {
      throw new DshDeveloperError('CELL_WORKSPACE_AUTHORITY_UNAVAILABLE', 'The live agent session header is unavailable.')
    }
    const childMarkers = header.origin === 'subagent'
      || header.parentSession !== undefined
      || (header.delegationDepth !== undefined && header.delegationDepth !== 0)
    if (childMarkers) {
      throw new DshDeveloperError('CELL_TOP_LEVEL_AGENT_REQUIRED', 'Delegated, sibling, and child Agent contexts cannot own an isolated Build workflow.')
    }
    if (!nonEmptyString(header.id) || !nonEmptyString(header.cwd) || !isAbsolute(header.cwd)) {
      throw new DshDeveloperError(
        'CELL_WORKSPACE_AUTHORITY_UNAVAILABLE',
        'The exact live session.header.id and absolute session.header.cwd authorities are required; process cwd is never used.',
      )
    }
    const cwd = header.cwd
    const before = await snapshotPath(cwd, options.signal)
    const physicalRoot = await realpath(resolve(cwd)).catch((cause) => {
      throw new DshDeveloperError('CELL_WORKSPACE_AUTHORITY_UNAVAILABLE', 'The live agent workspace physical path cannot be resolved.', {
        path: resolve(cwd),
        cause: cause.message,
      })
    })
    const after = await snapshotPath(cwd, options.signal)
    if (!samePathSnapshot(before, after)) {
      throw new DshDeveloperError('CELL_WORKSPACE_MUTATED', 'The live agent workspace path changed while physical authority was verified.')
    }
    const physical = resolve(physicalRoot)
    const finalEntry = after[after.length - 1]
    return freeze({
      root: physical,
      headerPath: resolve(cwd),
      sessionId: header.id,
      pathIdentity: after,
      identityDigest: digest({ physical, pathIdentity: after }),
      rootIdentity: { dev: finalEntry.dev, ino: finalEntry.ino },
    })
  }
}

/** @param {unknown} value */
export function validateCellPlanDigest(value) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new DshDeveloperError('TOOL_USAGE', 'planDigest must be a sha256 digest.')
  }
  return value
}

/** @param {Readonly<ToolExecution>} exec @returns {CellApprovalInput | null} */
function parseApprovalInput(exec) {
  if (exec?.name !== TOOL_NAME) return null
  const input = exec.arguments
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || !('operation' in input) || (input.operation !== 'cell-run' && input.operation !== 'cell-apply')) return null
  for (const key of Object.keys(input)) {
    if (key !== 'operation' && key !== 'planDigest') {
      throw new DshDeveloperError('TOOL_USAGE', 'Field "' + key + '" is not valid in ' + input.operation + '.')
    }
  }
  return { operation: input.operation, planDigest: validateCellPlanDigest('planDigest' in input ? input.planDigest : undefined) }
}

/** @param {CellApprovalDependencies} dependencies */
export function createCellApprovalContext({ assertController, prepare, diagnostic }) {
  /** @type {Map<ToolExecution['token'], CellApprovalProof>} */
  const pendingApprovals = new Map()
  /** @type {Map<ToolExecution['token'], CellApprovalProof>} */
  const allowedApprovals = new Map()

  /** @param {ToolExecution} exec @returns {Promise<PreToolDecision | null>} */
  async function prepareApproval(exec) {
    assertController()
    try {
      const parsed = parseApprovalInput(exec)
      if (parsed === null) return null
      if (typeof exec.token !== 'symbol') {
        return { kind: 'deny', reason: 'CELL_APPROVAL_GATE_UNAVAILABLE: registry-minted execution token is unavailable' }
      }
      if (exec.parent !== undefined) {
        return { kind: 'deny', reason: 'CELL_TOP_LEVEL_CALL_REQUIRED: ' + parsed.operation + ' cannot be dispatched as a nested tool call' }
      }
      const prepared = await prepare(parsed, exec.agent, exec.signal)
      if (prepared.kind === 'deny') return prepared
      if (exec.signal?.aborted) {
        throw new DshDeveloperError('CANCELLED', 'Isolated Build approval preparation was cancelled.')
      }
      pendingApprovals.set(exec.token, {
        owner: exec.agent,
        digest: prepared.digest,
        callId: exec.callId,
        operation: parsed.operation,
        evidenceDigest: prepared.evidenceDigest,
      })
      return { kind: 'ask', reason: prepared.reason }
    } catch (cause) {
      const failure = diagnostic(cause)
      return { kind: 'deny', reason: failure.code + ': ' + failure.message }
    }
  }

  /** @param {Readonly<ToolExecution>} exec */
  function approvalGuard(exec) {
    let parsed
    try {
      parsed = parseApprovalInput(exec)
    } catch (cause) {
      const failure = diagnostic(cause)
      return failure.code + ': ' + failure.message
    }
    if (parsed === null) return undefined
    const pending = pendingApprovals.get(exec.token)
    if (pending === undefined
        || pending.owner !== exec.agent
        || pending.digest !== parsed.planDigest
        || pending.operation !== parsed.operation
        || pending.callId !== exec.callId) {
      return 'CELL_APPROVAL_GATE_UNAVAILABLE: an audited allowed-once pre-execute proof did not reach the guard'
    }
    pendingApprovals.delete(exec.token)
    allowedApprovals.set(exec.token, pending)
    return undefined
  }

  /** @param {CellApprovalCall} call @param {CellApprovalInput['operation']} operation @param {string} planDigest */
  function consumeApproval(call, operation, planDigest) {
    const token = call.executionToken
    const proof = token === undefined ? undefined : allowedApprovals.get(token)
    if (token !== undefined) {
      allowedApprovals.delete(token)
      pendingApprovals.delete(token)
    }
    if (proof === undefined
        || proof.owner !== call.agent
        || proof.digest !== planDigest
        || proof.operation !== operation
        || proof.callId !== call.callId) {
      throw new DshDeveloperError(
        'CELL_APPROVAL_GATE_UNAVAILABLE',
        operation + ' requires an unconsumed registry-minted proof that audited tools/pre-execute returned allowed-once.',
      )
    }
    return proof
  }

  /** @param {Readonly<ToolExecution>} exec */
  function settleExecution(exec) {
    if (exec?.name !== TOOL_NAME || typeof exec.token !== 'symbol') return
    pendingApprovals.delete(exec.token)
    allowedApprovals.delete(exec.token)
  }

  function clearApprovals() {
    pendingApprovals.clear()
    allowedApprovals.clear()
  }

  return { prepareApproval, approvalGuard, consumeApproval, settleExecution, clearApprovals }
}
