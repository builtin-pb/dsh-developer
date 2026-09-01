import { createHash } from 'node:crypto'
import { DshDeveloperError } from './errors.js'
import { mapTreeEntries, scanOrdinaryTree } from './files.js'
import {
  SOURCE_MIGRATION_LEDGER_DIGEST,
  SOURCE_MIGRATION_LEDGER_V1,
} from './source-migration-rules.js'

const CODE_PATH = /(?:^|\/)[^/]+\.(?:[cm]?[jt]sx?|mts|cts)$/iu
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const CLIENT_RUNTIME = '@deepseek-ai/dsh-client-runtime'
const LLM_CALL_ID_MODULES = new Set(['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm/brand'])
const MAX_FINDINGS = 4096

const CLIENT_RULE = SOURCE_MIGRATION_LEDGER_V1.rules
  .find((rule) => rule.id === 'rc2-alpha3.web-client-runtime-removed')
const CALL_ID_RULE = SOURCE_MIGRATION_LEDGER_V1.rules
  .find((rule) => rule.id === 'rc2-alpha3.llm-call-id-renamed')
const CLIENT_MAPPINGS = new Map(CLIENT_RULE.action.mappings.map((value) => [value.from, value]))

function assertActive(signal) {
  if (signal?.aborted) {
    throw new DshDeveloperError('CANCELLED', 'Source-migration inspection was cancelled.')
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => [key, stableValue(value[key])]))
  }
  return value
}

function digest(value) {
  return 'sha256:' + createHash('sha256')
    .update(JSON.stringify(stableValue(value)), 'utf8')
    .digest('hex')
}

function sourcePosition(content, index) {
  const before = content.slice(0, index)
  const lastBreak = before.lastIndexOf('\n')
  return {
    line: before.split('\n').length,
    column: index - lastBreak,
  }
}

function isIdentifierStart(character) {
  return character !== undefined && /[A-Za-z_$]/u.test(character)
}

function isIdentifierPart(character) {
  return character !== undefined && /[A-Za-z0-9_$]/u.test(character)
}

function regexMayStart(previous) {
  if (!previous) return true
  if (previous.type === 'identifier') {
    return new Set([
      'await',
      'case',
      'delete',
      'do',
      'else',
      'in',
      'instanceof',
      'new',
      'of',
      'return',
      'throw',
      'typeof',
      'void',
      'yield',
    ]).has(previous.value)
  }
  return /[([{,;:=!?&|+\-*%~<>]/u.test(previous.value)
}

function skipRegex(content, start) {
  let index = start + 1
  let escaped = false
  let inClass = false
  while (index < content.length) {
    const character = content[index]
    if (character === '\n' || character === '\r') return start + 1
    if (escaped) {
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === '[') {
      inClass = true
    } else if (character === ']') {
      inClass = false
    } else if (character === '/' && !inClass) {
      index += 1
      while (/[A-Za-z]/u.test(content[index] ?? '')) index += 1
      return index
    }
    index += 1
  }
  return start + 1
}

function tokenizeSource(content) {
  const tokens = []
  let index = 0
  while (index < content.length) {
    const character = content[index]
    if (/\s/u.test(character)) {
      index += 1
      continue
    }
    if (character === '/' && content[index + 1] === '/') {
      index += 2
      while (index < content.length && content[index] !== '\n') index += 1
      continue
    }
    if (character === '/' && content[index + 1] === '*') {
      const end = content.indexOf('*/', index + 2)
      index = end === -1 ? content.length : end + 2
      continue
    }
    if (character === '/' && regexMayStart(tokens.at(-1))) {
      const end = skipRegex(content, index)
      if (end > index + 1) {
        index = end
        continue
      }
    }
    if (character === '`') {
      index += 1
      let escaped = false
      while (index < content.length) {
        const current = content[index]
        if (escaped) {
          escaped = false
        } else if (current === '\\') {
          escaped = true
        } else if (current === '`') {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (character === '"' || character === "'") {
      const start = index
      const quote = character
      let simple = true
      index += 1
      const valueStart = index
      while (index < content.length) {
        const current = content[index]
        if (current === '\\') {
          simple = false
          index += 2
          continue
        }
        if (current === quote) break
        if (current === '\n' || current === '\r') simple = false
        index += 1
      }
      const value = content.slice(valueStart, index)
      if (content[index] === quote) index += 1
      tokens.push({ type: 'string', value, simple, start, end: index })
      continue
    }
    if (isIdentifierStart(character)) {
      const start = index
      index += 1
      while (isIdentifierPart(content[index])) index += 1
      tokens.push({ type: 'identifier', value: content.slice(start, index), start, end: index })
      continue
    }
    tokens.push({ type: 'punctuation', value: character, start: index, end: index + 1 })
    index += 1
  }
  return tokens
}

function namedBindings(tokens, keywordIndex, fromIndex) {
  const clause = tokens.slice(keywordIndex + 1, fromIndex)
  const open = clause.findIndex((token) => token.value === '{')
  const close = clause.findLastIndex((token) => token.value === '}')
  if (open === -1 || close <= open) return { bindings: [], onlyNamed: false }
  const bindings = []
  let group = []
  function finish() {
    const identifiers = group.filter((token) => token.type === 'identifier')
    const meaningful = identifiers[0]?.value === 'type' ? identifiers.slice(1) : identifiers
    if (meaningful.length > 0) {
      const aliasIndex = meaningful.findIndex((token) => token.value === 'as')
      bindings.push({
        imported: meaningful[0].value,
        boundAs: aliasIndex >= 0 && meaningful[aliasIndex + 1]
          ? meaningful[aliasIndex + 1].value
          : meaningful[0].value,
        start: meaningful[0].start,
      })
    }
    group = []
  }
  for (const token of clause.slice(open + 1, close)) {
    if (token.value === ',') finish()
    else group.push(token)
  }
  finish()
  const outside = clause
    .filter((_, index) => index < open || index > close)
    .filter((token) => !(token.type === 'identifier' && token.value === 'type'))
  return { bindings, onlyNamed: outside.length === 0 }
}

function moduleReferences(content) {
  const tokens = tokenizeSource(content)
  const references = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type !== 'string' || !token.simple) continue
    const previous = tokens[index - 1]
    const beforePrevious = tokens[index - 2]
    if (previous?.type === 'identifier' && previous.value === 'from') {
      let keywordIndex = index - 2
      while (keywordIndex >= 0 && tokens[keywordIndex].value !== ';') {
        const candidate = tokens[keywordIndex]
        if (candidate.type === 'identifier'
            && (candidate.value === 'import' || candidate.value === 'export')) break
        keywordIndex -= 1
      }
      const keyword = tokens[keywordIndex]
      if (!keyword || !['import', 'export'].includes(keyword.value)) continue
      const invalidClause = tokens.slice(keywordIndex + 1, index - 1)
        .some((value) => ['(', ')', '='].includes(value.value))
      if (invalidClause) continue
      const named = namedBindings(tokens, keywordIndex, index - 1)
      references.push({
        kind: keyword.value === 'import' ? 'named-import' : 'named-export',
        module: token.value,
        start: token.start,
        bindings: named.bindings,
        onlyNamed: named.onlyNamed,
      })
      continue
    }
    if (previous?.type === 'identifier' && previous.value === 'import') {
      references.push({
        kind: 'side-effect-import',
        module: token.value,
        start: token.start,
        bindings: [],
        onlyNamed: false,
      })
      continue
    }
    if (previous?.value === '(' && beforePrevious?.type === 'identifier'
        && ['import', 'require'].includes(beforePrevious.value)
        && tokens[index - 3]?.value !== '.') {
      references.push({
        kind: beforePrevious.value === 'import' ? 'dynamic-import' : 'require',
        module: token.value,
        start: token.start,
        bindings: [],
        onlyNamed: false,
      })
    }
  }
  return references
}

function parseManifest(files) {
  const content = files.get('package.json')
  if (content === undefined) {
    throw new DshDeveloperError('MIGRATION_PACKAGE_MISSING', 'Source-migration inspection requires package.json.')
  }
  let value
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new DshDeveloperError('MIGRATION_PACKAGE_INVALID', 'package.json is not valid JSON: ' + error.message)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DshDeveloperError('MIGRATION_PACKAGE_INVALID', 'package.json must contain one JSON object.')
  }
  for (const field of DEPENDENCY_FIELDS) {
    if (value[field] !== undefined
        && (value[field] === null || typeof value[field] !== 'object' || Array.isArray(value[field]))) {
      throw new DshDeveloperError('MIGRATION_PACKAGE_INVALID', field + ' must be an object when present.')
    }
  }
  return { content, value }
}

function makeFinding(rule, plane, content, path, index, kind, touchpoint, action) {
  const position = sourcePosition(content, index)
  return {
    id: rule.id + '@' + path + ':' + position.line + ':' + position.column + ':' + kind,
    ruleId: rule.id,
    family: rule.family,
    plane,
    confidence: rule.confidence,
    netState: stableValue(rule.netState),
    touchpoint: {
      path,
      ...position,
      kind,
      ...touchpoint,
    },
    action,
  }
}

function manifestFindings(manifest) {
  const findings = []
  for (const field of DEPENDENCY_FIELDS) {
    if (!Object.hasOwn(manifest.value[field] ?? {}, CLIENT_RUNTIME)) continue
    const fieldIndex = manifest.content.indexOf(JSON.stringify(field))
    const packageIndex = manifest.content.indexOf(JSON.stringify(CLIENT_RUNTIME), Math.max(0, fieldIndex))
    findings.push(makeFinding(
      CLIENT_RULE,
      'manifest',
      manifest.content,
      'package.json',
      packageIndex < 0 ? 0 : packageIndex,
      'manifest-dependency',
      { field, package: CLIENT_RUNTIME },
      {
        kind: 'replace-dependency-after-imports',
        message: CLIENT_RULE.action.summary,
        manualReview: true,
        pending: CLIENT_RULE.action.unmapped,
      },
    ))
  }
  const clientInject = manifest.value.dsh?.client?.inject
  if (Array.isArray(clientInject) && clientInject.includes(CLIENT_RUNTIME)) {
    const dshIndex = manifest.content.indexOf('"dsh"')
    const injectIndex = manifest.content.indexOf('"inject"', Math.max(0, dshIndex))
    const packageIndex = manifest.content.indexOf(JSON.stringify(CLIENT_RUNTIME), Math.max(0, injectIndex))
    findings.push(makeFinding(
      CLIENT_RULE,
      'web-client',
      manifest.content,
      'package.json',
      packageIndex < 0 ? 0 : packageIndex,
      'client-inject',
      { jsonPath: 'dsh.client.inject', package: CLIENT_RUNTIME },
      {
        kind: 'replace-client-inject',
        message: CLIENT_RULE.action.summary,
        manualReview: true,
        pending: CLIENT_RULE.action.unmapped,
      },
    ))
  }
  return findings
}

function clientRuntimeFinding(path, content, reference) {
  const mappedSurface = reference.module === CLIENT_RUNTIME + '/client'
  const mappings = reference.bindings
    .map((binding) => {
      const mapped = mappedSurface ? CLIENT_MAPPINGS.get(binding.imported) : undefined
      return mapped
        ? {
            from: binding.imported,
            boundAs: binding.boundAs,
            to: mapped.to,
            module: mapped.module,
          }
        : undefined
    })
    .filter(Boolean)
    .sort((left, right) => left.from.localeCompare(right.from, 'en'))
  const unmapped = reference.bindings
    .map((binding) => binding.imported)
    .filter((name) => !mappedSurface || !CLIENT_MAPPINGS.has(name))
    .sort((left, right) => left.localeCompare(right, 'en'))
  const manualReview = !reference.onlyNamed || reference.bindings.length === 0 || unmapped.length > 0
  return makeFinding(
    CLIENT_RULE,
    'web-client',
    content,
    path,
    reference.start,
    'module-specifier',
    {
      module: reference.module,
      syntax: reference.kind,
      imported: reference.bindings.map((binding) => ({
        name: binding.imported,
        boundAs: binding.boundAs,
      })),
    },
    {
      kind: 'split-by-current-owner',
      message: CLIENT_RULE.action.summary,
      mappings,
      unmapped,
      manualReview,
      ...(manualReview ? { pending: CLIENT_RULE.action.unmapped } : {}),
    },
  )
}

function callIdFindings(path, content, reference) {
  return reference.bindings
    .filter((binding) => binding.imported === 'CallId')
    .map((binding) => makeFinding(
      CALL_ID_RULE,
      'shared',
      content,
      path,
      binding.start,
      'named-module-binding',
      {
        module: reference.module,
        syntax: reference.kind,
        symbol: binding.imported,
        boundAs: binding.boundAs,
      },
      {
        kind: 'rename-public-symbol',
        message: CALL_ID_RULE.action.summary,
        from: 'CallId',
        to: 'ToolCallId',
        module: reference.module,
        preserveLocalAlias: binding.boundAs !== binding.imported,
        manualReview: false,
      },
    ))
}

function compareFinding(left, right) {
  return left.touchpoint.path.localeCompare(right.touchpoint.path, 'en')
    || left.touchpoint.line - right.touchpoint.line
    || left.touchpoint.column - right.touchpoint.column
    || left.ruleId.localeCompare(right.ruleId, 'en')
    || left.touchpoint.kind.localeCompare(right.touchpoint.kind, 'en')
}

function reportDigest(report) {
  return digest({
    sourceFingerprint: report.sourceFingerprint,
    plugin: report.plugin,
    corridor: report.corridor,
    ledger: report.ledger,
    findings: report.findings,
    checks: report.checks.map(({ id, status, blocking, evidence }) => ({
      id,
      status,
      blocking,
      ...(evidence === undefined ? {} : { evidence }),
    })),
    summary: report.summary,
  })
}

export async function inspectSourceMigrationInternal(source, options, dependencies = {}) {
  const scan = dependencies.scanOrdinaryTree ?? scanOrdinaryTree
  assertActive(options.signal)
  const first = await scan(source, { signal: options.signal, excludeDependencies: true })
  const files = mapTreeEntries(first)
  const manifest = parseManifest(files)
  const findings = manifestFindings(manifest)
  let codeFiles = 0
  for (const [path, content] of files) {
    assertActive(options.signal)
    if (!CODE_PATH.test(path)) continue
    codeFiles += 1
    for (const reference of moduleReferences(content)) {
      if (reference.module === CLIENT_RUNTIME || reference.module.startsWith(CLIENT_RUNTIME + '/')) {
        findings.push(clientRuntimeFinding(path, content, reference))
      }
      if (LLM_CALL_ID_MODULES.has(reference.module)
          && ['named-import', 'named-export'].includes(reference.kind)) {
        findings.push(...callIdFindings(path, content, reference))
      }
      if (findings.length > MAX_FINDINGS) {
        throw new DshDeveloperError(
          'MIGRATION_TOO_MANY_FINDINGS',
          'Source-migration findings exceed the bounded ' + MAX_FINDINGS + '-item report.',
        )
      }
    }
  }
  findings.sort(compareFinding)
  const final = await scan(source, { signal: options.signal, excludeDependencies: true })
  const fresh = first.fingerprint === final.fingerprint
  const checks = [
    {
      id: 'corridor.exact',
      status: 'PASS',
      blocking: true,
      message: 'Bound the ledger to exact DSH 0.1.1-rc.2 -> 0.1.2-alpha.3.',
    },
    {
      id: 'source.snapshot',
      status: 'PASS',
      blocking: true,
      message: 'Acquired one bounded, credential-free source tree without dependencies.',
      evidence: {
        fingerprint: first.fingerprint,
        files: first.fileCount,
        excludedDirectories: first.excludedDirectories,
      },
    },
    {
      id: 'ledger.scope',
      status: 'PASS',
      blocking: true,
      message: 'Applied two exact-contract rule families without executing or editing source.',
      evidence: {
        ledgerDigest: SOURCE_MIGRATION_LEDGER_DIGEST,
        rules: SOURCE_MIGRATION_LEDGER_V1.rules.map((rule) => rule.id),
      },
    },
    {
      id: 'source.freshness',
      status: fresh ? 'PASS' : 'FAIL',
      blocking: true,
      message: fresh
        ? 'A fresh source scan matches the tree used for every finding.'
        : 'Plugin source changed during source-migration inspection.',
      evidence: { before: first.fingerprint, after: final.fingerprint },
    },
  ]
  const fileCount = new Set(findings.map((finding) => finding.touchpoint.path)).size
  const ruleCount = new Set(findings.map((finding) => finding.ruleId)).size
  const manualReview = findings.filter((finding) => finding.action.manualReview).length
  const byPlane = Object.fromEntries([...new Set(findings.map((finding) => finding.plane))]
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((plane) => [plane, findings.filter((finding) => finding.plane === plane).length]))
  const report = {
    kind: 'dsh-source-migration',
    ok: checks.every((check) => !check.blocking || check.status === 'PASS'),
    advisory: true,
    source: first.root,
    sourceFingerprint: first.fingerprint,
    verifiedAt: new Date().toISOString(),
    plugin: {
      ...(typeof manifest.value.name === 'string' ? { name: manifest.value.name } : {}),
      ...(typeof manifest.value.version === 'string' ? { version: manifest.value.version } : {}),
    },
    corridor: stableValue(SOURCE_MIGRATION_LEDGER_V1.corridor),
    ledger: {
      schemaVersion: SOURCE_MIGRATION_LEDGER_V1.schemaVersion,
      ledgerVersion: SOURCE_MIGRATION_LEDGER_V1.ledgerVersion,
      digest: SOURCE_MIGRATION_LEDGER_DIGEST,
      ruleIds: SOURCE_MIGRATION_LEDGER_V1.rules.map((rule) => rule.id),
    },
    findings,
    checks,
    summary: {
      findings: findings.length,
      files: fileCount,
      rules: ruleCount,
      manualReview,
      codeFilesScanned: codeFiles,
      byPlane,
    },
  }
  report.evidenceDigest = reportDigest(report)
  return report
}
