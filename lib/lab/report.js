import { createHash } from 'node:crypto'

function evidenceDigest(provider, policy, checks) {
  const canonical = JSON.stringify({
    provider,
    policy,
    checks: checks.map(({ id, status, blocking, evidence }) => ({
      id,
      status,
      blocking,
      ...(evidence === undefined ? {} : { evidence }),
    })),
  })
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export function buildExecutionLabReport(result, verifiedAt = new Date().toISOString()) {
  const report = {
    kind: 'execution-lab-conformance',
    ok: !result.checks.some((value) => value.blocking && value.status !== 'PASS'),
    verifiedAt,
    provider: result.provider,
    policy: result.policy,
    checks: result.checks,
  }
  report.evidenceDigest = evidenceDigest(report.provider, report.policy, report.checks)
  return report
}

