#!/usr/bin/env node

import { resolve } from 'node:path'
import { formatCellAdmissionReport, inspectIsolatedCellAdmission } from '../lib/cell-admission.js'
import { formatCapabilityReport, inspectDshCapabilities } from '../lib/capabilities.js'
import { formatCompatibilityMatrix, inspectCompatibilityMatrix } from '../lib/compatibility.js'
import { assertCliCommandOptions, parseCliArguments } from '../lib/cli-options.js'
import { doctorSource } from '../lib/doctor.js'
import {
  readStableCreatorExport,
  withCreatorFingerprint,
} from '../lib/creator-export.js'
import { asDiagnostic, DshDeveloperError } from '../lib/errors.js'
import { conformExecutionLab, formatExecutionLabReport } from '../lib/execution-lab.js'
import { formatProfilePreflightReport, inspectProfilePreflight } from '../lib/profile-preflight.js'
import { formatProfileAttestationReport, inspectProfileAttestation } from '../lib/profile-attestation.js'
import { promoteCreatorExport } from '../lib/promote.js'
import { formatSourceMigrationReport, inspectSourceMigration } from '../lib/source-migration.js'
import { executeUiCliAction, formatUiCliReport } from '../lib/ui-cli.js'
import { formatUpstreamImpactReport, inspectUpstreamImpact } from '../lib/upstream-impact.js'

const USAGE = [
  'dsh-developer — The single plugin you need for DSH',
  '',
  'Usage:',
  '  dsh-developer admit-cell [--dsh <path>] [--wsl-distro <name>] [--json]',
  '  dsh-developer attest-profile --profile <directory> [--dsh <path>] [--json]',
  '  dsh-developer capabilities [--dsh <path>] [--json]',
  '  dsh-developer compatibility --source <plugin-dir> --release-dsh <path> --preview-dsh <path> [--json]',
  '  dsh-developer impact --source <plugin-dir> --release-dsh <path> --preview-dsh <path> [--json]',
  '  dsh-developer migration --source <plugin-dir> --from-dsh 0.1.1-rc.2 --to-dsh 0.1.2-alpha.3 [--json]',
  '  dsh-developer lab [--wsl-distro <name>] [--json]',
  '  dsh-developer preflight --source <plugin-dir> [--profile <name>] [--dsh <path>] [--json]',
  '  dsh-developer doctor --source <creator.json|plugin-dir> [--dsh <path>] [--skip-runtime] [--json]',
  '  dsh-developer promote --source <creator.json> --output <new-dir> [--dsh <path>] [--json]',
  '  dsh-developer fingerprint --source <creator-draft.json> [--json]',
  '  dsh-developer ui --session <name> --action <operation> [operation options] [--json]',
  '',
  'Promotion only creates a new, absent destination and requires public DSH 0.1.1-rc.2.',
].join('\n')

function required(options, key) {
  const optionName = key.replace(/[A-Z]/gu, (letter) => '-' + letter.toLowerCase())
  if (!options[key]) throw new DshDeveloperError('CLI_USAGE', '--' + optionName + ' is required.')
  return resolve(options[key])
}

function requiredValue(options, key) {
  const optionName = key.replace(/[A-Z]/gu, (letter) => '-' + letter.toLowerCase())
  if (!options[key]) throw new DshDeveloperError('CLI_USAGE', '--' + optionName + ' is required.')
  return options[key]
}

function integerOption(options, key) {
  if (options[key] === undefined) return undefined
  if (!/^-?[0-9]+$/u.test(options[key])) {
    throw new DshDeveloperError('CLI_USAGE', '--' + key.replace(/[A-Z]/gu, (letter) => '-' + letter.toLowerCase()) + ' must be an integer.')
  }
  const value = Number(options[key])
  if (!Number.isSafeInteger(value)) throw new DshDeveloperError('CLI_USAGE', 'Numeric UI option is outside the safe integer range.')
  return value
}

function printReport(report, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return
  }
  process.stdout.write((report.ok ? 'PASS' : 'FAIL') + ' ' + report.kind + ' ' + report.source + '\n')
  for (const check of report.checks) {
    const boundary = check.blocking ? 'blocking' : 'advisory'
    process.stdout.write('  ' + check.status.padEnd(4) + ' ' + check.id + ' [' + boundary + '] ' + check.message + '\n')
  }
  if (report.fingerprint) process.stdout.write('Fingerprint: ' + report.fingerprint + '\n')
}

async function main(argv) {
  const { command, options } = parseCliArguments(argv)
  if (options.help || command === undefined || command === 'help') {
    process.stdout.write(USAGE + '\n')
    return
  }
  assertCliCommandOptions(command, options)
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())

  if (command === 'admit-cell') {
    const report = await inspectIsolatedCellAdmission(options.dsh, {
      distro: options.wslDistro,
      signal: controller.signal,
    })
    process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : formatCellAdmissionReport(report) + '\n')
    if (!report.ok) process.exitCode = 1
    return
  }
  if (command === 'attest-profile') {
    const report = await inspectProfileAttestation(required(options, 'profile'), {
      dshPath: options.dsh,
      signal: controller.signal,
    })
    process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : formatProfileAttestationReport(report) + '\n')
    return
  }
  if (command === 'capabilities') {
    const report = await inspectDshCapabilities(options.dsh, { signal: controller.signal })
    process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : formatCapabilityReport(report) + '\n')
    if (!report.ok) process.exitCode = 1
    return
  }
  if (command === 'compatibility') {
    const report = await inspectCompatibilityMatrix(required(options, 'source'), {
      releaseDsh: required(options, 'releaseDsh'),
      previewDsh: required(options, 'previewDsh'),
      signal: controller.signal,
    })
    process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : formatCompatibilityMatrix(report) + '\n')
    if (!report.ok) process.exitCode = 1
    return
  }
  if (command === 'lab') {
    const report = await conformExecutionLab({
      distro: options.wslDistro,
      signal: controller.signal,
    })
    process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : formatExecutionLabReport(report) + '\n')
    if (!report.ok) process.exitCode = 1
    return
  }
  if (command === 'impact') {
    const report = await inspectUpstreamImpact(required(options, 'source'), {
      releaseDsh: required(options, 'releaseDsh'),
      previewDsh: required(options, 'previewDsh'),
      signal: controller.signal,
    })
    process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : formatUpstreamImpactReport(report) + '\n')
    if (!report.ok) process.exitCode = 1
    return
  }
  if (command === 'migration') {
    const report = await inspectSourceMigration(required(options, 'source'), {
      fromDsh: requiredValue(options, 'fromDsh'),
      toDsh: requiredValue(options, 'toDsh'),
      signal: controller.signal,
    })
    process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : formatSourceMigrationReport(report) + '\n')
    if (!report.ok) process.exitCode = 1
    return
  }
  if (command === 'preflight') {
    const report = await inspectProfilePreflight(required(options, 'source'), {
      dshPath: options.dsh,
      profile: options.profile ?? 'headless',
      signal: controller.signal,
    })
    process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : formatProfilePreflightReport(report) + '\n')
    if (!report.ok) process.exitCode = 1
    return
  }
  if (command === 'doctor') {
    const report = await doctorSource(required(options, 'source'), {
      dshPath: options.dsh,
      runtime: options.skipRuntime ? 'skip' : 'required',
      signal: controller.signal,
    })
    printReport(report, options.json)
    if (!report.ok) process.exitCode = 1
    return
  }
  if (command === 'promote') {
    const result = await promoteCreatorExport(
      required(options, 'source'),
      required(options, 'output'),
      {
        dshPath: options.dsh,
        signal: controller.signal,
      },
    )
    if (options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    } else {
      process.stdout.write('Created tested DSH plugin: ' + result.destination + '\n')
      process.stdout.write('Source fingerprint: ' + result.sourceFingerprint + '\n')
      process.stdout.write('Bundle fingerprint: ' + result.bundleFingerprint + '\n')
      process.stdout.write('Doctor digest: ' + result.doctorDigest + '\n')
    }
    return
  }
  if (command === 'fingerprint') {
    const snapshot = await readStableCreatorExport(required(options, 'source'), { requireFingerprint: false })
    const value = withCreatorFingerprint(snapshot.value)
    if (options.json) {
      process.stdout.write(JSON.stringify(value, null, 2) + '\n')
    } else {
      process.stdout.write(value.sourceFingerprint + '\n')
    }
    return
  }
  if (command === 'ui') {
    const input = {
      operation: requiredValue(options, 'action'),
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.target === undefined ? {} : { target: options.target }),
      ...(options.text === undefined ? {} : { text: options.text }),
      ...(options.key === undefined ? {} : { key: options.key }),
      ...(options.depth === undefined ? {} : { depth: integerOption(options, 'depth') }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: integerOption(options, 'timeoutMs') }),
      ...(options.width === undefined ? {} : { width: integerOption(options, 'width') }),
      ...(options.height === undefined ? {} : { height: integerOption(options, 'height') }),
    }
    const report = await executeUiCliAction(
      requiredValue(options, 'session'),
      input,
      { signal: controller.signal },
    )
    process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : formatUiCliReport(report) + '\n')
    return
  }
  throw new DshDeveloperError('CLI_USAGE', 'Unknown command "' + command + '".\n\n' + USAGE)
}

main(process.argv.slice(2)).catch((error) => {
  const diagnostic = asDiagnostic(error)
  process.stderr.write(JSON.stringify(diagnostic, null, 2) + '\n')
  process.exitCode = error instanceof DshDeveloperError && error.code === 'CANCELLED' ? 130 : 1
})
