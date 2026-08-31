import { DshDeveloperError } from './errors.js'

const SECRET_PATTERNS = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{16,}\b/u],
  ['deepseek-key', /\b(?:dsk|deepseek)[-_][A-Za-z0-9_-]{16,}\b/iu],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/u],
  ['aws-access-key', /\bAKIA[A-Z0-9]{16}\b/u],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/u],
  ['npm-token', /\bnpm_[A-Za-z0-9]{20,}\b/u],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{30,}\b/u],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u],
  ['bearer-token', /\bbearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}(?=$|[\s,"'])/iu],
  ['credential-assignment', /["']?\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|private[_-]?key|password|credential)\b["']?\s*[:=]\s*["']?[^\s"',]{8,}/iu],
]

const TOKEN_CANDIDATE = /[A-Za-z0-9+/_=-]{24,}/gu
const PLACEHOLDER = /(?:example|placeholder|redacted|replace|sample|your[_-]|x{6,}|\*{6,})/iu

function shannonEntropy(value) {
  const counts = new Map()
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    entropy -= probability * Math.log2(probability)
  }
  return entropy
}

function looksLikeHighEntropySecret(candidate) {
  if (candidate.length > 256 || PLACEHOLDER.test(candidate)) return false
  if (/^[a-f0-9]+$/iu.test(candidate) || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(candidate)) {
    return false
  }
  const classes = [
    /[a-z]/u.test(candidate),
    /[A-Z]/u.test(candidate),
    /[0-9]/u.test(candidate),
    /[+/_=-]/u.test(candidate),
  ].filter(Boolean).length
  return classes >= 3 && shannonEntropy(candidate) >= 4.25
}

export function findSecrets(text) {
  const findings = []
  for (const [kind, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) findings.push(kind)
  }
  if ([...text.matchAll(TOKEN_CANDIDATE)].some((match) => looksLikeHighEntropySecret(match[0]))) {
    findings.push('high-entropy-token')
  }
  return findings
}

export function assertNoSecrets(text, label) {
  const findings = findSecrets(text)
  if (findings.length > 0) {
    throw new DshDeveloperError(
      'SECRET_DETECTED',
      'Potential credentials were found in ' + label + '. Remove or redact them before continuing.',
      { label, findingKinds: findings },
    )
  }
}
