import assert from 'node:assert/strict'
import test from 'node:test'
import { findSecrets, redactSensitiveOutput } from '../lib/security.js'

test('distinguishes lockfile integrity evidence from credentials', () => {
  const integrity = 'sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA=='
  assert.deepEqual(findSecrets('{"integrity":' + JSON.stringify(integrity) + '}'), [])
  const npmToken = ['npm', '1234567890abcdefghijklmnop'].join('_')
  assert.ok(findSecrets('{"token":' + JSON.stringify(npmToken) + '}').includes('npm-token'))
})

test('keeps diagnostic context while redacting credentials and multiline private keys', () => {
  const token = ['sk', '1234567890abcdefghijklmnop'].join('-')
  const begin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
  const end = ['-----END', 'PRIVATE KEY-----'].join(' ')
  const text = 'build started\napi_key=' + token + '\nsource.ts:12 type mismatch\n' + begin + '\nshort payload\n' + end + '\nbuild failed'
  const redacted = redactSensitiveOutput(text)
  assert.ok(redacted.includes('source.ts:12 type mismatch'))
  assert.ok(redacted.includes('build failed'))
  assert.ok(!redacted.includes(token))
  assert.ok(!redacted.includes('short payload'))
  assert.ok(!redacted.includes('BEGIN PRIVATE KEY'))
})

const COMMIT = 'c291e7961a515f6d7af9304e7fd1d257929aef26'
const SOURCE = 'https://github.com/deepseek-ai/deepseek-harness/blob/' + COMMIT

test('preserves exact GitHub source links in documentation and diagnostics', () => {
  for (const url of [
    SOURCE,
    SOURCE + '/docs/subsystems/README.md',
    SOURCE + '/CONTRIBUTING.md',
    SOURCE.replace('/blob/', '/tree/') + '/docs',
    SOURCE.replace(COMMIT, COMMIT.toUpperCase()) + '/docs/development.md',
    SOURCE + '?plain=1#L42',
  ]) {
    const text = 'Source: [' + COMMIT + '](' + url + ').\nBuild failed; see source above.\n'
    assert.deepEqual(findSecrets(text), [], url)
    assert.equal(redactSensitiveOutput(text), text, url)
  }
})

test('source links do not hide credentials or adjacent high-entropy tokens', () => {
  const raw = ['aB3dE7gH', '9jK2mN4p', 'Q6sT8vW0', 'yZ1cF5iL'].join('')
  const npmToken = ['npm', '1234567890abcdefghijklmnop'].join('_')
  const key = ['sk', '1234567890abcdefghijklmnop'].join('-')
  for (const [text, kind] of [
    [raw, 'high-entropy-token'],
    [SOURCE + '/' + raw, 'high-entropy-token'],
    [SOURCE.replace('deepseek-ai', raw), 'high-entropy-token'],
    [SOURCE + '?value=' + raw, 'high-entropy-token'],
    [SOURCE + '#' + raw, 'high-entropy-token'],
    [SOURCE + '/' + npmToken, 'npm-token'],
    [SOURCE + '?api_key=' + key, 'openai-key'],
    ['api_key=' + SOURCE, 'credential-assignment'],
    ['api_key=' + COMMIT + '\n' + SOURCE, 'credential-assignment'],
    ['Bearer ' + COMMIT + '\n' + SOURCE, 'bearer-token'],
    [raw + '/' + COMMIT + '/' + raw, 'high-entropy-token'],
    ['https://unrelated.invalid/' + raw, 'high-entropy-token'],
  ]) {
    assert.ok(findSecrets(text).includes(kind), kind)
    assert.ok(redactSensitiveOutput(text).includes('[redacted: possible credential]'), kind)
  }
})

test('limits the hash exception to full commits in recognized source URL paths', () => {
  for (const text of [
    SOURCE.replace('github.com', 'github.com.evil.invalid') + '/docs/subsystems/README.md',
    SOURCE.replace('github.com', 'github.com@evil.invalid') + '/docs/subsystems/README.md',
    SOURCE.replace('/blob/', '/releases/') + '/docs/subsystems/README.md',
    SOURCE.replace(COMMIT, COMMIT + '0') + '/docs/subsystems/README.md',
    SOURCE.replace(COMMIT, COMMIT.slice(0, -1) + 'Z') + '/docs/subsystems/README.md',
  ]) {
    assert.ok(findSecrets(text).includes('high-entropy-token'), text)
  }
})
