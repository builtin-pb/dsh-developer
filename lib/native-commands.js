import { formatCellAdmissionReport, inspectIsolatedCellAdmission } from './cell-admission.js'
import { formatCapabilityReport, inspectDshCapabilities } from './capabilities.js'
import { doctorSource } from './doctor.js'
import { asDiagnostic, DshDeveloperError } from './errors.js'
import { conformExecutionLab, formatExecutionLabReport } from './execution-lab.js'
import { promoteCreatorExport } from './promote.js'

function parseInput(rawInput, allowed, required) {
  let value
  try {
    value = JSON.parse(rawInput.trim())
  } catch {
    throw new DshDeveloperError('COMMAND_USAGE', 'Command input must be one JSON object.')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DshDeveloperError('COMMAND_USAGE', 'Command input must be one JSON object.')
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new DshDeveloperError('COMMAND_USAGE', 'Unsupported command field "' + key + '".')
  }
  for (const key of required) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new DshDeveloperError('COMMAND_USAGE', 'Command field "' + key + '" must be a non-empty string.')
    }
  }
  return value
}

function currentDshEntry() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new DshDeveloperError('DSH_ENTRY_UNAVAILABLE', 'The running DSH entry path is unavailable.')
  }
  return entry
}

function doctorText(report) {
  const lines = [(report.ok ? 'PASS' : 'FAIL') + ' Doctor ' + report.source]
  for (const check of report.checks) {
    if (check.status === 'PASS') continue
    lines.push(check.status + ' ' + check.id + ': ' + check.message)
  }
  if (report.fingerprint) lines.push('Fingerprint: ' + report.fingerprint)
  return lines.join('\n')
}

async function doctorCommand(invocation) {
  try {
    const input = parseInput(
      invocation.rawInput,
      new Set(['source', 'skipRuntime']),
      ['source'],
    )
    if (input.skipRuntime !== undefined && typeof input.skipRuntime !== 'boolean') {
      throw new DshDeveloperError('COMMAND_USAGE', 'skipRuntime must be boolean when present.')
    }
    const report = await doctorSource(input.source, {
      dshPath: input.skipRuntime ? undefined : currentDshEntry(),
      runtime: input.skipRuntime ? 'skip' : 'required',
      signal: invocation.signal,
    })
    return { kind: report.ok ? 'success' : 'error', text: doctorText(report) }
  } catch (error) {
    const diagnostic = asDiagnostic(error)
    return { kind: 'error', text: diagnostic.code + ': ' + diagnostic.message }
  }
}

async function capabilitiesCommand(invocation) {
  try {
    const input = parseInput(invocation.rawInput, new Set(), [])
    if (Object.keys(input).length !== 0) {
      throw new DshDeveloperError('COMMAND_USAGE', 'Capability inspection accepts an empty JSON object.')
    }
    const report = await inspectDshCapabilities(currentDshEntry(), { signal: invocation.signal })
    return { kind: report.ok ? 'success' : 'error', text: formatCapabilityReport(report) }
  } catch (error) {
    const diagnostic = asDiagnostic(error)
    return { kind: 'error', text: diagnostic.code + ': ' + diagnostic.message }
  }
}

async function admitCellCommand(invocation) {
  try {
    const input = parseInput(invocation.rawInput, new Set(['distro']), [])
    if (input.distro !== undefined && (typeof input.distro !== 'string' || input.distro.length === 0)) {
      throw new DshDeveloperError('COMMAND_USAGE', 'distro must be a non-empty string when present.')
    }
    const report = await inspectIsolatedCellAdmission(currentDshEntry(), {
      distro: input.distro,
      signal: invocation.signal,
    })
    return { kind: report.ok ? 'success' : 'error', text: formatCellAdmissionReport(report) }
  } catch (error) {
    const diagnostic = asDiagnostic(error)
    return { kind: 'error', text: diagnostic.code + ': ' + diagnostic.message }
  }
}

async function labCommand(invocation) {
  try {
    const input = parseInput(invocation.rawInput, new Set(['distro']), [])
    if (input.distro !== undefined && (typeof input.distro !== 'string' || input.distro.length === 0)) {
      throw new DshDeveloperError('COMMAND_USAGE', 'distro must be a non-empty string when present.')
    }
    const report = await conformExecutionLab({ distro: input.distro, signal: invocation.signal })
    return { kind: report.ok ? 'success' : 'error', text: formatExecutionLabReport(report) }
  } catch (error) {
    const diagnostic = asDiagnostic(error)
    return { kind: 'error', text: diagnostic.code + ': ' + diagnostic.message }
  }
}

async function promoteCommand(invocation) {
  try {
    const input = parseInput(
      invocation.rawInput,
      new Set(['source', 'output']),
      ['source', 'output'],
    )
    const result = await promoteCreatorExport(input.source, input.output, {
      dshPath: currentDshEntry(),
      signal: invocation.signal,
    })
    return {
      kind: 'success',
      text: [
        'Created tested DSH plugin: ' + result.destination,
        'Source fingerprint: ' + result.sourceFingerprint,
        'Bundle fingerprint: ' + result.bundleFingerprint,
        'Doctor digest: ' + result.doctorDigest,
      ].join('\n'),
    }
  } catch (error) {
    const diagnostic = asDiagnostic(error)
    const staging = typeof diagnostic.staging === 'string' ? '\nRetained staging: ' + diagnostic.staging : ''
    return { kind: 'error', text: diagnostic.code + ': ' + diagnostic.message + staging }
  }
}

export function registerNativeCommands(ctx) {
  ctx.commands.register({
    name: 'dsh-developer-admit-cell',
    description: 'Run the evidence gate for isolated DSH agent execution cells',
    input: { hint: '{"distro":"Ubuntu-22.04"}' },
    handler: admitCellCommand,
  })
  ctx.commands.register({
    name: 'dsh-developer-capabilities',
    description: 'Inspect exact DSH capability and compatibility evidence',
    input: { hint: '{}' },
    handler: capabilitiesCommand,
  })
  ctx.commands.register({
    name: 'dsh-developer-lab',
    description: 'Run keyless conformance for the local WSL2 Bubblewrap execution lab',
    input: { hint: '{"distro":"Ubuntu-22.04"}' },
    handler: labCommand,
  })
  ctx.commands.register({
    name: 'dsh-developer-doctor',
    description: 'Audit a DSH Creator export or plugin directory',
    input: { hint: '{"source":"<path>","skipRuntime":false}' },
    handler: doctorCommand,
  })
  ctx.commands.register({
    name: 'dsh-developer-promote',
    description: 'Promote a Creator export into one new tested plugin directory',
    input: { hint: '{"source":"<creator.json>","output":"<new-directory>"}' },
    handler: promoteCommand,
  })
}
