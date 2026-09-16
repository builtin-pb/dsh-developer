import { findSecrets } from './security.js'

/** Accept only a consistent prefix of this invocation's requested cases. */
export function validVerificationReceipt(value, cases, workspace) {
  if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean' || typeof value.complete !== 'boolean'
      || !['startup', 'agent-setup', 'cases', 'agent-dispose', 'complete'].includes(value.phase)
      || value.caseCount !== cases.length || !Array.isArray(value.cases) || value.cases.length > cases.length
      || !value.cases.every((item, index) => item?.index === index + 1 && item.tool === cases[index].tool
        && item.name === cases[index].name && typeof item.passed === 'boolean')) return false
  if (['error', 'cleanupError'].some(key => Object.hasOwn(value, key)
    && (typeof value[key] !== 'string' || value[key].length > 2048))) return false
  if (['startup', 'agent-setup'].includes(value.phase) && (value.cases.length || value.activeCase !== null)) return false
  if (workspace === undefined) {
    if (value.agent !== undefined || ['agent-setup', 'agent-dispose'].includes(value.phase)) return false
  } else if (value.agent !== undefined) {
    if (!value.agent || typeof value.agent.id !== 'string' || !value.agent.id
        || !(value.agent.preset === null || typeof value.agent.preset === 'string')) return false
  } else if (['cases', 'agent-dispose', 'complete'].includes(value.phase)) return false
  if (value.complete) {
    return value.phase === 'complete' && value.cases.length === cases.length && value.activeCase === null
      && !Object.hasOwn(value, 'error') && !Object.hasOwn(value, 'cleanupError')
      && value.ok === value.cases.every(item => item.passed)
  }
  if (value.ok || value.phase === 'complete') return false
  if (value.activeCase === null) return true
  const next = cases[value.cases.length]
  return Boolean(next && value.activeCase?.index === value.cases.length + 1
    && value.activeCase.tool === next.tool && value.activeCase.name === next.name)
}

/** Keep verified outcomes even when displaying a result would expose credentials. */
export function protectVerificationReceipt(receipt, cases, processProtection) {
  const findings = findSecrets(JSON.stringify(receipt))
  const privateKey = findings.includes('private-key') || receipt.privateKeyOutput === true
    || receipt.cases.some(item => item.privateKeyOutput === true) || processProtection === 'private-key'
  const withholdAll = privateKey || processProtection === 'incomplete-process-output'
  if (!findings.length && !withholdAll) return receipt
  const withheld = value => withholdAll || findSecrets(JSON.stringify(value)).length > 0
  const identity = index => ({ index: index + 1, tool: cases[index].tool,
    ...(cases[index].name === undefined ? {} : { name: cases[index].name }) })
  const protectedReceipt = {
    ok: receipt.ok, complete: receipt.complete, phase: receipt.phase, caseCount: receipt.caseCount,
    activeCase: receipt.activeCase === null ? null : identity(receipt.cases.length),
    cases: receipt.cases.map((item, index) => {
      const result = { ...identity(index), passed: item.passed }
      if (typeof item.isError === 'boolean') result.isError = item.isError
      if (Array.isArray(item.failures)) result.failures = item.failures.filter(reason => [
        'expected-error', 'unexpected-error', 'missing-result-path', 'value-mismatch', 'result-budget-exceeded', 'error-message-mismatch',
      ].includes(reason))
      for (const key of ['valueBytes', 'contentBytes', 'resultBytes', 'maxResultBytes']) {
        if (Number.isSafeInteger(item[key]) && item[key] >= 0) result[key] = item[key]
      }
      if (typeof item.outputLimitExceeded === 'boolean') result.outputLimitExceeded = item.outputLimitExceeded
      for (const key of ['value', 'content', 'expected', 'resultPath', 'errorContains']) {
        if (item[key + 'Omitted'] === true) result[key + 'Omitted'] = true
        if (!Object.hasOwn(item, key)) continue
        if (withheld(item[key])) result[key + 'Withheld'] = true
        else result[key] = item[key]
      }
      return result
    }),
    outputProtection: { withheld: true, reason: privateKey ? 'private-key' : processProtection ?? 'possible-credentials' },
  }
  // Only known protocol fields survive the protected projection. In particular,
  // a suspect field name or an extra field cannot bypass result protection.
  for (const key of ['error', 'cleanupError', 'scope']) {
    if (typeof receipt[key] !== 'string') continue
    protectedReceipt[key] = withheld(receipt[key]) ? '[withheld: possible credentials]' : receipt[key]
  }
  if (receipt.agent) {
    protectedReceipt.agent = withheld(receipt.agent)
      ? { id: '[withheld]', preset: null, metadataWithheld: true }
      : { id: receipt.agent.id, preset: receipt.agent.preset }
  }
  return protectedReceipt
}
