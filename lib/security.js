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
  if (/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u.test(candidate)) return false
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
  const findings = SECRET_PATTERNS.flatMap(([kind, pattern]) => pattern.test(text) ? [kind] : [])
  // A full Git commit is already exempt as a standalone hex token. Separate
  // only that segment in GitHub source links so adjacent path text does not
  // turn it into a credential. Both sides, queries and fragments stay scanned;
  // explicit credential patterns above always inspect the original text.
  const entropyText = text.replace(
    /\b(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:blob|tree)\/)[a-f0-9]{40}(?=\/|[?#\s)\]}]|$)/giu,
    '$1 ',
  ).replace(
    /\bhttps:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?=\/|[?#\s"'<>\x60)\]}]|$)/giu,
    // Owner and repository are separate identifiers, not one slash-joined
    // credential. Keep each identifier and the URL tail independently scanned.
    'github.com $1 $2 ',
  )
  if ([...entropyText.matchAll(TOKEN_CANDIDATE)].some((match) => looksLikeHighEntropySecret(match[0]))) {
    findings.push('high-entropy-token')
  }
  return findings
}

/** Preserve useful diagnostics while withholding credential-bearing lines and private-key blocks. */
export function redactSensitiveOutput(text) {
  const withoutKeys = text.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gu,
    '[redacted: private key]')
  return withoutKeys.split(/(\r?\n)/u).map(line => findSecrets(line).length ? '[redacted: possible credential]' : line).join('')
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
