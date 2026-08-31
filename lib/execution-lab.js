import { asDiagnostic } from './errors.js'
import { buildExecutionLabReport } from './lab/report.js'
import {
  conformWslBubblewrap,
  WSL_BUBBLEWRAP_PROVIDER_ID,
} from './lab/wsl-bubblewrap.js'

export async function conformExecutionLab(options = {}) {
  let result
  try {
    result = await conformWslBubblewrap({
      distro: options.distro,
      signal: options.signal,
    })
  } catch (error) {
    result = {
      provider: { id: WSL_BUBBLEWRAP_PROVIDER_ID },
      policy: {},
      checks: [{
        id: 'lab.provider',
        status: 'FAIL',
        blocking: true,
        message: 'The local execution-lab provider could not start.',
        evidence: asDiagnostic(error),
      }],
    }
  }
  return buildExecutionLabReport(result)
}

export function formatExecutionLabReport(report) {
  const lines = [
    (report.ok ? 'PASS' : 'FAIL') + ' execution lab ' + report.provider.id
      + (report.provider.distro ? ' [' + report.provider.distro + ']' : ''),
  ]
  for (const value of report.checks) {
    lines.push('  ' + value.status.padEnd(4) + ' ' + value.id + ': ' + value.message)
  }
  lines.push('Evidence: ' + report.evidenceDigest)
  return lines.join('\n')
}
