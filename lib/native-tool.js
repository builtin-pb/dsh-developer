import { inspectDshCapabilities } from './capabilities.js'
import { inspectCompatibilityMatrix } from './compatibility.js'
import { inspectAuthoritySafety, inspectDelegationSafety } from './delegation-safety.js'
import { doctorSource } from './doctor.js'
import { DshDeveloperError } from './errors.js'
import { inspectHookBridge } from './hook-bridge-doctor.js'
import {
  createNativeCellWorkflowController,
  toModelSafeCellWorkflowError,
} from './native-cell-workflow.js'
import { createNativeToolDefinition, NATIVE_TOOL_NAME } from './native-tool-internal.js'
import { inspectProfilePreflight } from './profile-preflight.js'
import { hasUiCliTool } from './ui-cli-tool.js'
import { inspectUiCapabilities, UI_PROTECTED_NAMESPACE } from './ui-capabilities.js'
import { inspectUpstreamImpact } from './upstream-impact.js'

function runningDshEntry() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new DshDeveloperError('DSH_ENTRY_UNAVAILABLE', 'The running DSH entry path is unavailable.')
  }
  return entry
}

function agentProjectRoot(agent) {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new DshDeveloperError('HOOK_PROJECT_UNAVAILABLE', 'Native hook-doctor requires a live Agent project root.')
  }
  return cwd
}

async function executeOperation(ctx, input, options) {
  let report
  if (input.operation === 'cell-plan') {
    report = await options.cellWorkflow.plan(input, options)
  } else if (input.operation === 'cell-run') {
    report = await options.cellWorkflow.run(input, options)
  } else if (input.operation === 'cell-apply') {
    report = await options.cellWorkflow.apply(input, options)
  } else if (input.operation === 'cell-discard') {
    report = await options.cellWorkflow.discard(input, options)
  } else if (input.operation === 'ui') {
    report = inspectUiCapabilities(ctx.tools.schemas(options.agent), {
      guardedNamespaces: [UI_PROTECTED_NAMESPACE],
      nativeCliActive: hasUiCliTool(ctx),
    })
  } else if (input.operation === 'authority') {
    report = inspectAuthoritySafety(ctx, options.agent, ctx.tools.schemas(options.agent))
  } else if (input.operation === 'delegation') {
    report = inspectDelegationSafety(options.agent, ctx.tools.schemas(options.agent))
  } else if (input.operation === 'capabilities') {
    const dshPath = runningDshEntry()
    report = await inspectDshCapabilities(dshPath, { signal: options.signal })
  } else if (input.operation === 'doctor') {
    const dshPath = runningDshEntry()
    report = await doctorSource(input.source, {
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
    report = await inspectProfilePreflight(input.source, {
      dshPath,
      profile: input.profile ?? 'headless',
      signal: options.signal,
    })
  } else if (input.operation === 'impact') {
    const dshPath = runningDshEntry()
    report = await inspectUpstreamImpact(input.source, {
      releaseDsh: input.releaseDsh ?? dshPath,
      previewDsh: input.previewDsh,
      signal: options.signal,
    })
  } else {
    const dshPath = runningDshEntry()
    report = await inspectCompatibilityMatrix(input.source, {
      releaseDsh: input.releaseDsh ?? dshPath,
      previewDsh: input.previewDsh,
      signal: options.signal,
    })
  }
  return { operation: input.operation, ok: report.ok, report }
}

export function registerNativeTool(ctx) {
  const cellWorkflow = createNativeCellWorkflowController({
    dshPath: runningDshEntry(),
    isRootAgent(agent) {
      if (typeof ctx.agents?.roots !== 'function') return false
      for (const candidate of ctx.agents.roots()) {
        if (candidate === agent) return true
      }
      return false
    },
  })
  const ownerLifetimes = new WeakSet()

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await cellWorkflow.prepareApproval(exec)
    return decision ?? next()
  })
  ctx.tools.guard((exec) => cellWorkflow.approvalGuard(exec))
  ctx.on('tools/result', (exec) => { cellWorkflow.settleExecution(exec) })
  ctx.effect(() => async () => cellWorkflow.dispose(), 'dsh-developer: dispose isolated Build workflow')

  return ctx.tools.register(createNativeToolDefinition(
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
        return await executeOperation(ctx, input, { ...options, cellWorkflow })
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

export function hasNativeTool(ctx) {
  const definition = ctx.tools.get(NATIVE_TOOL_NAME)
  return definition?.name === NATIVE_TOOL_NAME
    && typeof definition.execute === 'function'
    && definition.output?.schema?.type === 'object'
}
