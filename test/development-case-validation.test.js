import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { validateToolCases } from '../lib/development.js'
import { asDiagnostic, DshDeveloperError } from '../lib/errors.js'
import { findSecrets } from '../lib/security.js'

const good = Object.freeze({ tool: 'greet', arguments: Object.freeze({}), expected: 'hello' })

function diagnostic(cases) {
  let result
  assert.throws(() => validateToolCases(cases), error => {
    assert(error instanceof DshDeveloperError)
    assert.equal(error.code, 'DEVELOPMENT_CASES_INVALID')
    result = asDiagnostic(error)
    return true
  })
  return result
}

test('case diagnostics locate the second case and explain the offending schema field', () => {
  const rows = [
    [null, 'case', /must be an object/u],
    [{ ...good, name: '   ' }, 'name', /nonblank string/u],
    [{ ...good, name: 'n'.repeat(129) }, 'name', /at most 128/u],
    [{ ...good, name: 'line\nbreak' }, 'name', /control characters/u],
    [{ ...good, tool: '-lookup' }, 'tool', /start with an ASCII letter or digit/u],
    [{ ...good, arguments: [] }, 'arguments', /must be an object/u],
    [{ ...good, isError: 'true' }, 'isError', /must be boolean/u],
    [{ ...good, maxResultBytes: 0 }, 'maxResultBytes', /positive safe integer/u],
    [{ ...good, resultPath: 1 }, 'resultPath', /must be a string/u],
    [{ ...good, resultPath: '/' + 'p'.repeat(512) }, 'resultPath', /at most 512/u],
    [{ ...good, resultPath: 'items/0' }, 'resultPath', /JSON Pointer/u],
    [{ ...good, resultPath: '/~2' }, 'resultPath', /~ escaped as ~0/u],
    [{ tool: 'greet', arguments: {} }, 'expected', /required for a successful case/u],
    [{ ...good, errorContains: 'missing' }, 'errorContains', /requires isError: true/u],
    [{ ...good, isError: true, errorContains: ' ' }, 'errorContains', /nonblank literal string/u],
    [{ ...good, isError: true, errorContains: 'e'.repeat(513) }, 'errorContains', /at most 512/u],
  ]
  for (const [item, field, reason] of rows) {
    const error = diagnostic([good, item])
    assert.equal(error.caseIndex, 2)
    assert.equal(error.field, field)
    assert(error.message.startsWith('Case #2: ' + field + ' '))
    assert.match(error.message, reason)
  }
})

test('unknown fields are rejected without echoing arbitrary property names', () => {
  for (const key of ['expect', 'agent', 'approval', 'private-property\nwith-controls']) {
    const error = diagnostic([good, { ...good, [key]: { unrelated: 'payload' } }])
    assert.equal(error.field, 'fields')
    assert.equal(error.caseIndex, 2)
    assert.match(error.message, /unsupported property; allowed fields: name, tool, arguments, expected,/u)
    // "expect" is a substring of the allowed "expected"; check arbitrary keys separately.
    if (key !== 'expect') assert(!JSON.stringify(error).includes(key))
    assert(!JSON.stringify(error).includes('payload'))
  }
})

test('multiple invalid fields have a stable first error independent of property order', () => {
  const invalid = { ...good, name: '', tool: '-bad', arguments: [], isError: 'yes',
    maxResultBytes: 0, resultPath: 'items', errorContains: '' }
  const order = ['name', 'tool', 'arguments', 'isError', 'maxResultBytes', 'resultPath', 'errorContains']
  for (const field of order) {
    const forward = diagnostic([good, invalid])
    const reverse = diagnostic([good, Object.fromEntries(Object.entries(invalid).reverse())])
    assert.deepEqual(forward, reverse)
    assert.equal(forward.field, field)
    if (Object.hasOwn(good, field)) invalid[field] = good[field]
    else delete invalid[field]
  }
  const both = { tool: 'greet', arguments: {}, errorContains: 'failure' }
  assert.equal(diagnostic([both]).field, 'expected')
  assert.equal(diagnostic([{ ...both, extra: true }]).field, 'fields')
  assert.equal(diagnostic([{ ...good, arguments: null }, invalid]).caseIndex, 1)
})

test('diagnostics never echo case names, tools, payloads or credential-bearing keys', () => {
  const token = 'sk-' + 'A1b2C3d4'.repeat(4)
  const marker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
  assert(findSecrets(token).length > 0)
  assert(findSecrets(marker).length > 0)
  for (const secret of [token, marker, 'ordinary-private-value']) {
    const base = { ...good, name: secret, arguments: { input: secret }, expected: secret }
    const cases = [
      { ...base, resultPath: 'invalid-pointer' },
      { ...good, name: secret + '\n' },
      { ...good, tool: secret + '/' },
      { ...good, arguments: secret },
      { ...good, isError: secret },
      { ...good, maxResultBytes: secret },
      { ...good, resultPath: secret },
      { ...good, errorContains: secret },
      { ...good, isError: true, errorContains: secret.repeat(100) },
      { ...good, [secret]: secret },
    ]
    for (const item of cases) {
      const error = diagnostic([good, item])
      const serialized = JSON.stringify(error)
      assert.equal(error.caseIndex, 2)
      assert(!serialized.includes(secret))
      assert.deepEqual(findSecrets(serialized), [])
      assert.deepEqual(Object.keys(error).sort(), ['caseIndex', 'code', 'field', 'message'])
    }
  }
})

test('shipped example and boundary-valid cases remain accepted without mutation', async () => {
  const example = JSON.parse(await readFile(new URL('../examples/package-check/tool-cases.json', import.meta.url), 'utf8'))
  const before = JSON.stringify(example)
  assert.equal(validateToolCases(example), example)
  assert.equal(JSON.stringify(example), before)
  const cases = Object.freeze([
    good,
    { ...good, name: '界'.repeat(128), tool: 'A' + 'a'.repeat(127), maxResultBytes: Number.MAX_SAFE_INTEGER },
    { ...good, tool: '0_.:-', resultPath: '', maxResultBytes: 1, expected: null },
    { ...good, resultPath: '/', expected: false, isError: false },
    { ...good, resultPath: '/items/0/~0/~1', expected: [{ nested: true }] },
    { ...good, resultPath: '/' + 'p'.repeat(511), expected: 0 },
    { ...good, isError: true, errorContains: '界'.repeat(512) },
    { ...good, isError: true, errorContains: 'literal [input].*\nnext line' },
    { tool: 'greet', arguments: {}, isError: true },
    { ...good, name: undefined, isError: undefined, errorContains: undefined, resultPath: undefined,
      maxResultBytes: undefined, expected: undefined },
  ].map(Object.freeze))
  assert.equal(validateToolCases(cases), cases)
  const maximum = Object.freeze(Array(32).fill(good))
  assert.equal(validateToolCases(maximum), maximum)
})

test('invalid types and one-past-boundary values remain rejected', () => {
  const values = {
    name: [null, 1, {}, [], '', '\t', 'x'.repeat(129), 'control\u007f'],
    tool: [undefined, null, 1, {}, [], '', '_prefix', 'has space', '界', 'x'.repeat(129)],
    arguments: [undefined, null, 1, '', []],
    isError: [null, 0, 'false', {}, []],
    maxResultBytes: [null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1],
    resultPath: [null, 1, {}, [], 'items', '/~', '/~2', '/' + 'x'.repeat(512)],
    errorContains: [null, 1, {}, [], '', ' \n', 'x'.repeat(513)],
  }
  for (const [field, rejected] of Object.entries(values)) {
    for (const value of rejected) {
      const error = diagnostic([{ ...good, ...(field === 'errorContains' ? { isError: true } : {}), [field]: value }])
      assert.equal(error.caseIndex, 1)
      assert.equal(error.field, field)
    }
  }
  for (const cases of [null, {}, [], Array(33).fill(good)]) {
    const error = diagnostic(cases)
    assert.match(error.message, /1–32/u)
    assert.equal(error.caseIndex, undefined)
  }
  for (const item of [null, false, 1, 'case', []]) assert.equal(diagnostic([item]).field, 'case')
})

test('CLI exposes the same useful diagnostic in human and JSON modes before runtime preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-case-validation-'))
  try {
    const casesPath = join(root, 'cases.json')
    const privateValue = 'ordinary-private-value'
    await writeFile(casesPath, JSON.stringify([good, { ...good, name: privateValue,
      arguments: { input: privateValue }, expected: privateValue, resultPath: 'items/0' }]))
    const cli = fileURLToPath(new URL('../bin/dsh-developer.js', import.meta.url))
    const args = [cli, 'verify', '--source', join(root, 'absent-plugin'), '--cases', casesPath,
      '--dsh', join(root, 'absent-dsh')]
    const human = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10_000 })
    const json = spawnSync(process.execPath, [...args, '--json'], { encoding: 'utf8', timeout: 10_000 })
    for (const result of [human, json]) {
      assert.equal(result.error, undefined)
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert(!result.stderr.includes(privateValue))
      assert.deepEqual(findSecrets(result.stderr), [])
    }
    const error = JSON.parse(json.stderr)
    assert.equal(error.code, 'DEVELOPMENT_CASES_INVALID')
    assert.equal(error.caseIndex, 2)
    assert.equal(error.field, 'resultPath')
    assert.match(error.message, /JSON Pointer/u)
    assert(human.stderr.includes(error.code + ': ' + error.message))
  } finally { await rm(root, { recursive: true, force: true }) }
})
