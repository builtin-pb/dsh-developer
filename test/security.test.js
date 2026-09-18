import assert from 'node:assert/strict'
import test from 'node:test'
import { createPrivateKeyObserver, findSecrets, redactSensitiveOutput } from '../lib/security.js'

test('private-key observation survives every marker split and stays sticky after clipping', () => {
  for (const type of ['', 'RSA ', 'EC ', 'OPENSSH ', 'DSA ', 'ENCRYPTED ']) {
    const marker = Buffer.from('-----BEGIN ' + type + 'PRIVATE KEY-----')
    for (let split = 1; split < marker.length; split++) {
      const observe = createPrivateKeyObserver()
      assert.equal(observe(Buffer.from('ordinary log\n'.repeat(10000))), false)
      assert.equal(observe(marker.subarray(0, split)), false)
      assert.equal(observe(marker.subarray(split)), true)
      assert.equal(observe(Buffer.from('ordinary log\n'.repeat(10000))), true)
    }
    const observe = createPrivateKeyObserver()
    for (let i = 0; i < marker.length; i++) assert.equal(observe(marker.subarray(i, i + 1)), i === marker.length - 1)
  }
  const observe = createPrivateKeyObserver()
  assert.equal(observe(Buffer.from('-----BEGIN PUBLIC KEY-----\nordinary log\n')), false)
})

test('separates shell assignment names from values without exempting the value', () => {
  const command = 'DSH_PACKAGE_ROOT=/installed/dsh npm test'
  for (const text of [command, 'export ' + command + '\n', 'Run `' + command + '`.',
    JSON.stringify({ scripts: { test: command } }), 'sh -c "' + command + '"']) {
    assert.deepEqual(findSecrets(text), [])
    assert.equal(redactSensitiveOutput(text), text)
  }
  const raw = ['aB3dE7gH', '9jK2mN4p', 'Q6sT8vW0', 'yZ1cF5iL'].join('')
  for (const text of ['VALUE=' + raw, 'export VALUE=' + raw, 'VALUE="' + raw + '"', raw + '=ordinary',
    '`VALUE=' + raw + '`', JSON.stringify({ test: 'VALUE=' + raw }), 'sh -c "VALUE=' + raw + '"']) {
    assert.ok(findSecrets(text).includes('high-entropy-token'), text)
  }
  assert.ok(findSecrets('password=' + 'ordinary-value').includes('credential-assignment'))
  for (const token of [['aB3dE7gH', '9jK2mN4p', 'Q6sT8vU='].join(''),
    ['AbCdEfGh', 'IjKlMnOp', 'QrStUvWx', 'YzA='].join('')]) {
    for (const text of ['Result: ' + token + '.', JSON.stringify({ value: token })]) {
      assert.ok(findSecrets(text).includes('high-entropy-token'))
      assert.match(redactSensitiveOutput(text), /redacted/u)
    }
  }
})

test('distinguishes lockfile integrity evidence from credentials', () => {
  const integrity = 'sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA=='
  assert.deepEqual(findSecrets('{"integrity":' + JSON.stringify(integrity) + '}'), [])
  const npmToken = ['npm', '1234567890abcdefghijklmnop'].join('_')
  assert.ok(findSecrets('{"token":' + JSON.stringify(npmToken) + '}').includes('npm-token'))
})

test('distinguishes DeepSeek package names from standalone credential prefixes', () => {
  const name = '@deepseek-ai/dsh-deepseek-llm-api-extensions'
  for (const text of [name, name + '@0.1.5-rc.2', JSON.stringify({ [name]: '^0.1.5-rc.2' })]) {
    assert.deepEqual(findSecrets(text), [])
    assert.equal(redactSensitiveOutput(text), text)
  }
  for (const prefix of ['deepseek-', 'dsk-', 'deepseek_', 'DSK_']) {
    const key = prefix + ['1234567890', 'abcdefghijklmnop'].join('')
    for (const text of [key, '"' + key + '"', name + ' ' + key, name + '?token=' + key]) {
      assert.ok(findSecrets(text).includes('deepseek-key'))
      assert.match(redactSensitiveOutput(text), /redacted/u)
    }
  }
  const key = ['sk', '1234567890abcdefghijklmnop'].join('-')
  assert.ok(findSecrets(name + ' ' + key).includes('openai-key'))
  assert.ok(findSecrets('api_key=' + name).includes('credential-assignment'))
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

test('scans GitHub repository identifiers separately without hiding credentials', () => {
  const repository = 'https://github.com/hg1048596-pixel/dsh-recall-unread'
  assert.deepEqual(findSecrets('[Reference](' + repository + ').'), [])
  assert.deepEqual(findSecrets(JSON.stringify({ repository })), [])
  const raw = ['aB3dE7gH', '9jK2mN4p', 'Q6sT8vW0', 'yZ1cF5iL'].join('')
  for (const url of [
    'https://github.com/' + raw + '/project',
    'https://github.com/owner/' + raw,
    repository + '/' + raw,
    repository + '?value=' + raw,
    repository + '#' + raw,
    repository + ' ' + raw,
  ]) assert.ok(findSecrets(url).includes('high-entropy-token'))
})

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
