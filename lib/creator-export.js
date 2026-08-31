import { createHash } from 'node:crypto'
import { open, lstat } from 'node:fs/promises'
import {
  CREATOR_FORMAT,
  CREATOR_SCHEMA_VERSION,
  DSH_COMPATIBILITY_TARGET,
  LIMITS,
} from './constants.js'
import { DshDeveloperError } from './errors.js'
import { assertNoSecrets } from './security.js'

const REQUIRED_KEYS = [
  'author',
  'compatibilityTarget',
  'description',
  'format',
  'goal',
  'instructions',
  'name',
  'packageName',
  'schemaVersion',
  'sourceFingerprint',
]
const OPTIONAL_KEYS = ['decisions', 'resources', 'tools', 'unresolvedRisks']
const ALLOWED_KEYS = new Set([...REQUIRED_KEYS, ...OPTIONAL_KEYS])
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const KEBAB_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const ITEM_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

function fail(message, details = {}) {
  throw new DshDeveloperError('INVALID_CREATOR_EXPORT', message, details)
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(label + ' must be an object.')
  }
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(label + ' contains unsupported field "' + key + '".', { field: key })
  }
}

function text(value, label, max, options = {}) {
  if (typeof value !== 'string') fail(label + ' must be a string.', { field: label })
  if (value.length === 0) fail(label + ' must not be empty.', { field: label })
  if (value !== value.trim()) fail(label + ' must not have leading or trailing whitespace.', { field: label })
  if (value.length > max) fail(label + ' exceeds ' + max + ' characters.', { field: label })
  if (/[\0\uFFFD]/u.test(value)) fail(label + ' contains invalid text.', { field: label })
  if (options.singleLine && /[\r\n]/u.test(value)) fail(label + ' must be one line.', { field: label })
  return value
}

function stringList(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > LIMITS.listItems) {
    fail(label + ' must be an array of at most ' + LIMITS.listItems + ' strings.', { field: label })
  }
  const result = value.map((item, index) => text(item, label + '[' + index + ']', LIMITS.shortTextChars))
  if (new Set(result).size !== result.length) fail(label + ' contains duplicate entries.', { field: label })
  return result
}

function namedItems(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > LIMITS.toolItems) {
    fail(label + ' must be an array of at most ' + LIMITS.toolItems + ' items.', { field: label })
  }
  const names = new Set()
  return value.map((item, index) => {
    assertObject(item, label + '[' + index + ']')
    assertExactKeys(item, new Set(['name', 'purpose']), label + '[' + index + ']')
    const name = text(item.name, label + '[' + index + '].name', 64, { singleLine: true })
    if (!ITEM_NAME.test(name)) fail(label + '[' + index + '].name must be kebab-case.', { field: label })
    if (names.has(name)) fail(label + ' contains duplicate name "' + name + '".', { field: label })
    names.add(name)
    return {
      name,
      purpose: text(item.purpose, label + '[' + index + '].purpose', LIMITS.shortTextChars),
    }
  })
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
}

export function normalizeCreatorExport(value, options = {}) {
  assertObject(value, 'Creator export')
  assertExactKeys(value, ALLOWED_KEYS, 'Creator export')
  for (const key of REQUIRED_KEYS) {
    if (key === 'sourceFingerprint' && options.requireFingerprint === false) continue
    if (!Object.hasOwn(value, key)) fail('Creator export is missing required field "' + key + '".', { field: key })
  }
  if (value.format !== CREATOR_FORMAT) fail('format must be "' + CREATOR_FORMAT + '".', { field: 'format' })
  if (value.schemaVersion !== CREATOR_SCHEMA_VERSION) {
    fail('schemaVersion must be ' + CREATOR_SCHEMA_VERSION + '.', { field: 'schemaVersion' })
  }

  const name = text(value.name, 'name', 64, { singleLine: true })
  if (!KEBAB_NAME.test(name)) fail('name must be kebab-case.', { field: 'name' })
  const packageName = text(value.packageName, 'packageName', 128, { singleLine: true })
  if (!PACKAGE_NAME.test(packageName) || packageName.length > 214) {
    fail('packageName must be a valid lowercase npm package name.', { field: 'packageName' })
  }
  const compatibilityTarget = text(value.compatibilityTarget, 'compatibilityTarget', 32, { singleLine: true })
  if (compatibilityTarget !== DSH_COMPATIBILITY_TARGET) {
    fail(
      'compatibilityTarget must be the public blocking target "' + DSH_COMPATIBILITY_TARGET + '".',
      { field: 'compatibilityTarget' },
    )
  }

  const normalized = {
    format: CREATOR_FORMAT,
    schemaVersion: CREATOR_SCHEMA_VERSION,
    sourceFingerprint: value.sourceFingerprint,
    name,
    packageName,
    author: text(value.author, 'author', 160, { singleLine: true }),
    description: text(value.description, 'description', LIMITS.descriptionChars, { singleLine: true }),
    goal: text(value.goal, 'goal', LIMITS.longTextChars),
    instructions: text(value.instructions, 'instructions', LIMITS.longTextChars),
    compatibilityTarget,
    decisions: stringList(value.decisions, 'decisions'),
    unresolvedRisks: stringList(value.unresolvedRisks, 'unresolvedRisks'),
    tools: namedItems(value.tools, 'tools'),
    resources: namedItems(value.resources, 'resources'),
  }

  const visibleText = [
    normalized.author,
    normalized.description,
    normalized.goal,
    normalized.instructions,
    ...normalized.decisions,
    ...normalized.unresolvedRisks,
    ...normalized.tools.flatMap((item) => [item.name, item.purpose]),
    ...normalized.resources.flatMap((item) => [item.name, item.purpose]),
  ].join('\n')
  assertNoSecrets(visibleText, 'Creator export model-visible fields')

  if (options.requireFingerprint !== false) {
    const supplied = text(normalized.sourceFingerprint, 'sourceFingerprint', 71, { singleLine: true })
    const expected = calculateCreatorFingerprint(normalized)
    if (supplied !== expected) {
      fail('sourceFingerprint does not match the canonical export content.', {
        field: 'sourceFingerprint',
        expected,
      })
    }
  } else {
    delete normalized.sourceFingerprint
  }
  return normalized
}

export function calculateCreatorFingerprint(value) {
  const payload = { ...value }
  delete payload.sourceFingerprint
  const digest = createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex')
  return 'sha256:' + digest
}

export function withCreatorFingerprint(value) {
  const normalized = normalizeCreatorExport(value, { requireFingerprint: false })
  return {
    ...normalized,
    sourceFingerprint: calculateCreatorFingerprint(normalized),
  }
}

function sameFile(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
}

function assertActive(signal) {
  if (signal?.aborted) throw new DshDeveloperError('CANCELLED', 'Creator export snapshot was cancelled.')
}

export async function readStableCreatorExport(path, options = {}) {
  assertActive(options.signal)
  const before = await lstat(path).catch((error) => {
    throw new DshDeveloperError('SOURCE_UNAVAILABLE', 'Cannot inspect Creator export: ' + error.message, { path })
  })
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new DshDeveloperError('UNSAFE_SOURCE', 'Creator export must be an ordinary file, not a link or special file.', { path })
  }
  if (before.size > LIMITS.creatorBytes) {
    throw new DshDeveloperError('SOURCE_TOO_LARGE', 'Creator export exceeds ' + LIMITS.creatorBytes + ' bytes.', { path })
  }

  const handle = await open(path, 'r')
  let buffer
  let during
  try {
    assertActive(options.signal)
    during = await handle.stat()
    if (!sameFile(before, during)) {
      throw new DshDeveloperError('MUTABLE_SOURCE', 'Creator export changed while its snapshot was acquired.', { path })
    }
    buffer = await handle.readFile()
    assertActive(options.signal)
    const afterRead = await handle.stat()
    if (!sameFile(during, afterRead)) {
      throw new DshDeveloperError('MUTABLE_SOURCE', 'Creator export changed while it was being read.', { path })
    }
  } finally {
    await handle.close()
  }
  const after = await lstat(path)
  assertActive(options.signal)
  if (!sameFile(before, after)) {
    throw new DshDeveloperError('MUTABLE_SOURCE', 'Creator export changed before its snapshot was sealed.', { path })
  }
  if (buffer.byteLength > LIMITS.creatorBytes) {
    throw new DshDeveloperError('SOURCE_TOO_LARGE', 'Creator export exceeds ' + LIMITS.creatorBytes + ' bytes.', { path })
  }

  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new DshDeveloperError('INVALID_TEXT', 'Creator export must be valid UTF-8 text.', { path })
  }
  assertNoSecrets(source, 'Creator export file')

  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new DshDeveloperError('INVALID_JSON', 'Creator export is not valid JSON: ' + error.message, { path })
  }
  const value = normalizeCreatorExport(parsed, { requireFingerprint: options.requireFingerprint !== false })
  return {
    path,
    bytes: buffer.byteLength,
    contentDigest: 'sha256:' + createHash('sha256').update(buffer).digest('hex'),
    value,
  }
}
