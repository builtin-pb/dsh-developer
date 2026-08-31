import { inspectDshCapabilities } from './capabilities.js'
import { inspectCompatibilityMatrix } from './compatibility.js'
import { doctorSource } from './doctor.js'
import { DshDeveloperError } from './errors.js'
import { createNativeToolDefinition, NATIVE_TOOL_NAME } from './native-tool-internal.js'
import { inspectProfilePreflight } from './profile-preflight.js'
import { inspectUpstreamImpact } from './upstream-impact.js'

function runningDshEntry() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new DshDeveloperError('DSH_ENTRY_UNAVAILABLE', 'The running DSH entry path is unavailable.')
  }
  return entry
}

async function executeOperation(input, options) {
  const dshPath = runningDshEntry()
  let report
  if (input.operation === 'capabilities') {
    report = await inspectDshCapabilities(dshPath, { signal: options.signal })
  } else if (input.operation === 'doctor') {
    report = await doctorSource(input.source, {
      dshPath: input.skipRuntime ? undefined : dshPath,
      runtime: input.skipRuntime ? 'skip' : 'required',
      signal: options.signal,
    })
  } else if (input.operation === 'preflight') {
    report = await inspectProfilePreflight(input.source, {
      dshPath,
      profile: input.profile ?? 'headless',
      signal: options.signal,
    })
  } else if (input.operation === 'impact') {
    report = await inspectUpstreamImpact(input.source, {
      releaseDsh: input.releaseDsh ?? dshPath,
      previewDsh: input.previewDsh,
      signal: options.signal,
    })
  } else {
    report = await inspectCompatibilityMatrix(input.source, {
      releaseDsh: input.releaseDsh ?? dshPath,
      previewDsh: input.previewDsh,
      signal: options.signal,
    })
  }
  return { operation: input.operation, ok: report.ok, report }
}

export function registerNativeTool(ctx) {
  return ctx.tools.register(createNativeToolDefinition(executeOperation))
}

export function hasNativeTool(ctx) {
  const definition = ctx.tools.get(NATIVE_TOOL_NAME)
  return definition?.name === NATIVE_TOOL_NAME
    && typeof definition.execute === 'function'
    && definition.output?.schema?.type === 'object'
}
