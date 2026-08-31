#!/usr/bin/env node

import { resolve } from 'node:path'
import { doctorSource } from '../lib/doctor.js'
import {
  readStableCreatorExport,
  withCreatorFingerprint,
} from '../lib/creator-export.js'
import { asDiagnostic, DshDeveloperError } from '../lib/errors.js'
import { promoteCreatorExport } from '../lib/promote.js'

const USAGE = [
  'dsh-developer — The single plugin you need for DSH',
  '',
  'Usage:',
  '  dsh-developer doctor --source <creator.json|plugin-dir> [--dsh <path>] [--skip-runtime] [--json]',
  '  dsh-developer promote --source <creator.json> --output <new-dir> [--dsh <path>] [--json]',
  '  dsh-developer fingerprint --source <creator-draft.json> [--json]',
  '',
  'Promotion only creates a new, absent destination and requires public DSH 0.1.1-rc.2.',
].join('\n')

const VALUE_OPTIONS = new Set(['--source', '--output', '--dsh'])
const FLAG_OPTIONS = new Set(['--json', '--skip-runtime', '--help', '-h'])

function parse(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') return { command: 'help', options: { help: true } }
  const command = argv[0]
  const options = {}
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (VALUE_OPTIONS.has(token)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new DshDeveloperError('CLI_USAGE', token + ' requires a value.')
      }
      options[token.slice(2)] = value
      index += 1
      continue
    }
    if (FLAG_OPTIONS.has(token)) {
      const key = token === '-h' ? 'help' : token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
      options[key] = true
      continue
    }
    throw new DshDeveloperError('CLI_USAGE', 'Unknown option "' + token + '".')
  }
  return { command, options }
}

function required(options, key) {
  if (!options[key]) throw new DshDeveloperError('CLI_USAGE', '--' + key + ' is required.')
  return resolve(options[key])
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
  const { command, options } = parse(argv)
  if (options.help || command === undefined || command === 'help') {
    process.stdout.write(USAGE + '\n')
    return
  }
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())

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
    if (options.skipRuntime) {
      throw new DshDeveloperError('CLI_USAGE', '--skip-runtime is never allowed for promotion.')
    }
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
  throw new DshDeveloperError('CLI_USAGE', 'Unknown command "' + command + '".\n\n' + USAGE)
}

main(process.argv.slice(2)).catch((error) => {
  const diagnostic = asDiagnostic(error)
  process.stderr.write(JSON.stringify(diagnostic, null, 2) + '\n')
  process.exitCode = error instanceof DshDeveloperError && error.code === 'CANCELLED' ? 130 : 1
})
