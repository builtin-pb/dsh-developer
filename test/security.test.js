import assert from 'node:assert/strict'
import test from 'node:test'
import { findSecrets } from '../lib/security.js'

test('distinguishes lockfile integrity evidence from credentials', () => {
  const integrity = 'sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA=='
  assert.deepEqual(findSecrets('{"integrity":' + JSON.stringify(integrity) + '}'), [])
  const npmToken = ['npm', '1234567890abcdefghijklmnop'].join('_')
  assert.ok(findSecrets('{"token":' + JSON.stringify(npmToken) + '}').includes('npm-token'))
})
