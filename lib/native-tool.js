// @ts-check
/** @import { Agent } from '@deepseek-ai/dsh-agent' */
/** @import { PreToolDecision } from '@deepseek-ai/dsh-tools' */
/** @import { NativeContext, NativeDependencies, NativeInput, OperationOptions, CellWorkflow, ToolLookupSource } from './native-tool-types.js' */

import { inspectDshCapabilities } from './capabilities.js'
import { inspectCompatibilityMatrix } from './compatibility.js'
import { inspectAuthoritySafetyFromSources, inspectDelegationSafety } from './delegation-safety.js'
import { doctorSource } from './doctor.js'
import { DshDeveloperError } from './errors.js'
import { inspectHookBridge } from './hook-bridge-doctor.js'
import {
  createNativeCellWorkflowController,
  toModelSafeCellWorkflowError,
} from './native-cell-workflow.js'
import { agentProjectRoot, createNativeToolDefinition, isRecord, NATIVE_TOOL_NAME, resolveNativeSource } from './native-tool-internal.js'
import { inspectProfilePreflight } from './profile-preflight.js'
import { hasUiCliTool } from './ui-cli-tool.js'
import { inspectUiCapabilities, UI_PROTECTED_NAMESPACE } from './ui-capabilities.js'
import { inspectUpstreamImpact } from './upstream-impact.js'
import { inspectProject } from './project.js'
import { inspectDshKnowledge } from './knowledge.js'
import { inspectSession } from './session.js'

// The unchecked engine destructures these fields, but JS inference only keeps
// the defaulted limit. Give the call boundary its actual plugin-owned options.
/** @type {(source: string, options: { sourceRoot: string; limit?: number; signal: AbortSignal }) => Promise<unknown>} */
const inspectNativeSession = inspectSession

function runningDshEntry() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new DshDeveloperError('DSH_ENTRY_UNAVAILABLE', 'The running DSH entry path is unavailable.')
  }
  return entry
}

/**
 * @param {Pick<NativeDependencies, 'authoritySources' | 'tools'>} dependencies
 * @param {NativeInput} input
 * @param {OperationOptions & { cellWorkflow: CellWorkflow }} options
 */
async function executeOperation({ authoritySources, tools }, input, options) {
  /** @type {unknown} */
  let report
  if (input.operation === 'project') {
    report = await inspectProject(input.source ?? '.', { sourceRoot: agentProjectRoot(options.agent), signal: options.signal })
  } else if (input.operation === 'session') {
    report = await inspectNativeSession(input.source, { sourceRoot: agentProjectRoot(options.agent), limit: input.limit, signal: options.signal })
  } else if (input.operation === 'knowledge') {
    report = await inspectDshKnowledge({ dshPath: runningDshEntry(), upstreamRoot: input.source,
      sourceRoot: input.source === undefined ? undefined : agentProjectRoot(options.agent),
      topic: input.topic, packageName: input.packageName,
      consumerRoot: input.consumerRoot === undefined ? undefined : resolveNativeSource(input.consumerRoot, options.agent), signal: options.signal })
  } else if (input.operation === 'cell-plan') {
    report = await options.cellWorkflow.plan(input, options)
  } else if (input.operation === 'cell-run') {
    report = await options.cellWorkflow.run(input, options)
  } else if (input.operation === 'cell-apply') {
    report = await options.cellWorkflow.apply(input, options)
  } else if (input.operation === 'cell-discard') {
    report = await options.cellWorkflow.discard(input, options)
  } else if (input.operation === 'ui') {
    report = inspectUiCapabilities(tools.schemas(options.agent), {
      guardedNamespaces: [UI_PROTECTED_NAMESPACE],
      nativeCliActive: hasUiCliTool(tools),
    })
  } else if (input.operation === 'authority') {
    report = inspectAuthoritySafetyFromSources(authoritySources, options.agent, tools.schemas(options.agent))
  } else if (input.operation === 'delegation') {
    report = inspectDelegationSafety(options.agent, tools.schemas(options.agent))
  } else if (input.operation === 'capabilities') {
    const dshPath = runningDshEntry()
    report = await inspectDshCapabilities(dshPath, { signal: options.signal })
  } else if (input.operation === 'doctor') {
    const dshPath = runningDshEntry()
    report = await doctorSource(resolveNativeSource(input.source, options.agent), {
      dshPath: input.skipRuntime ? undefined : dshPath,
      runtime: input.skipRuntime ? 'skip' : 'required',
      signal: options.signal,
    })
  } else if (input.operation === 'hook-doctor') {
    report = await inspectHookBridge(input.source, {
      dialect: input.dialect,
      dshPath: runningDshEntry(),
      sourceRoot: agentProjectRoot(options.agent),
      signal: options.signal,
    })
  } else if (input.operation === 'preflight') {
    const dshPath = runningDshEntry()
    report = await inspectProfilePreflight(resolveNativeSource(input.source, options.agent), {
      dshPath,
      profile: input.profile ?? 'headless',
      signal: options.signal,
    })
  } else if (input.operation === 'impact') {
    const dshPath = runningDshEntry()
    report = await inspectUpstreamImpact(resolveNativeSource(input.source, options.agent), {
      releaseDsh: input.releaseDsh ?? dshPath,
      previewDsh: input.previewDsh,
      signal: options.signal,
    })
  } else {
    const dshPath = runningDshEntry()
    report = await inspectCompatibilityMatrix(resolveNativeSource(input.source, options.agent), {
      releaseDsh: input.releaseDsh ?? dshPath,
      previewDsh: input.previewDsh,
      signal: options.signal,
    })
  }
  if (!isRecord(report) || typeof report.ok !== 'boolean') {
    throw new TypeError('Native operation must return an object report with boolean ok')
  }
  return { operation: input.operation, ok: report.ok, report }
}

/** @param {unknown} value @returns {PreToolDecision | undefined} */
function readApprovalDecision(value) {
  if (value == null) return undefined
  if (isRecord(value)) {
    if (value.kind === 'allow') return { kind: 'allow' }
    if (value.kind === 'deny' && typeof value.reason === 'string') return { kind: 'deny', reason: value.reason }
    if (value.kind === 'ask' && (value.reason === undefined || typeof value.reason === 'string')) {
      return { kind: 'ask', ...('reason' in value ? { reason: value.reason } : {}) }
    }
  }
  throw new TypeError('Invalid isolated Build approval decision')
}

/** @param {NativeDependencies} dependencies */
export function registerNativeToolWithDependencies({
  authoritySources,
  agents,
  tools,
  onToolsPreExecute,
  onToolsResult,
  effect,
}) {
  const cellWorkflow = createNativeCellWorkflowController({
    dshPath: runningDshEntry(),
    /** @param {Agent} agent */
    isRootAgent(agent) {
      if (typeof agents?.roots !== 'function') return false
      for (const candidate of agents.roots()) {
        if (candidate === agent) return true
      }
      return false
    },
  })
  const ownerLifetimes = new WeakSet()

  onToolsPreExecute(async (exec, next) => {
    const decision = readApprovalDecision(await cellWorkflow.prepareApproval(exec))
    return decision ?? next()
  })
  tools.guard((exec) => cellWorkflow.approvalGuard(exec))
  onToolsResult((exec) => { cellWorkflow.settleExecution(exec) })
  effect(() => async () => cellWorkflow.dispose(), 'dsh-developer: dispose isolated Build workflow')

  return tools.register(createNativeToolDefinition(
    async (input, options) => {
      if (input.operation === 'cell-plan'
          && options.agent?.ctx?.effect
          && !ownerLifetimes.has(options.agent)) {
        ownerLifetimes.add(options.agent)
        options.agent.ctx.effect(
          () => async () => cellWorkflow.disposeOwner(options.agent),
          'dsh-developer: dispose Agent-owned isolated Build workflow',
        )
      }
      try {
        return await executeOperation({ authoritySources, tools }, input, { ...options, cellWorkflow })
      } catch (cause) {
        if (input.operation === 'cell-plan'
            || input.operation === 'cell-run'
            || input.operation === 'cell-apply'
            || input.operation === 'cell-discard') {
          throw toModelSafeCellWorkflowError(cause)
        }
        throw cause
      }
    },
  ))
}

/** @param {NativeContext} ctx */
export function registerNativeTool(ctx) {
  return registerNativeToolWithDependencies({
    authoritySources: {
      sandboxPolicy: () => ctx.get?.(/** @satisfies {keyof import('@deepseek-ai/cordis').Context} */ ('sandboxPolicy')),
      approval: () => ctx.get?.(/** @satisfies {keyof import('@deepseek-ai/cordis').Context} */ ('approval')),
    },
    agents: ctx.agents,
    tools: ctx.tools,
    onToolsPreExecute: (listener) => ctx.on('tools/pre-execute', listener),
    onToolsResult: (listener) => ctx.on('tools/result', listener),
    effect: (factory, description) => ctx.effect(factory, description),
  })
}

/** @param {ToolLookupSource} value */
export function hasNativeTool(value) {
  const tools = 'tools' in value ? value.tools : value
  const definition = tools.get(NATIVE_TOOL_NAME)
  return definition?.name === NATIVE_TOOL_NAME
    && typeof definition.execute === 'function'
    && isRecord(definition.output?.schema) && definition.output.schema.type === 'object'
}
