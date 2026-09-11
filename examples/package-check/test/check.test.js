import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkPackageVersion } from '../lib/check.js'

test('applies npm range semantics, including zero-major and alternative ranges', () => {
  const cases = [
    ['1.9.0', '^1.2.0', true],
    ['2.0.0', '^1.2.0', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.4', '^0.0.3', false],
    ['1.3.0', '~1.2.0', false],
    ['3.1.0', '^1.0.0 || ^3.0.0', true],
    ['2.0.0', '1.0.0 - 2.0.0', true],
    ['1.2.3+build.7', '=1.2.3', true],
    ['v1.2.3', '1.2.x', true],
    ['1.2.3', '', true],
  ]
  for (const [version, range, expected] of cases) {
    assert.deepEqual(checkPackageVersion({ version, range }), {
      version, range, includePrerelease: false, satisfies: expected,
    })
  }
})

test('prereleases require an explicit matching comparator or opt-in', () => {
  const version = '0.1.1-rc.2'
  assert.equal(checkPackageVersion({ version, range: '*' }).satisfies, false)
  assert.equal(checkPackageVersion({ version, range: '*', includePrerelease: true }).satisfies, true)
  assert.equal(checkPackageVersion({ version, range: '>=0.1.1-rc.1 <0.2.0' }).satisfies, true)
  assert.equal(checkPackageVersion({ version: '0.1.2-rc.1', range: '>=0.1.1-rc.1 <0.2.0' }).satisfies, false)
})

test('invalid arguments fail with guidance instead of reporting incompatibility', () => {
  for (const input of [null, [], '1.2.3']) {
    assert.throws(() => checkPackageVersion(input), /Arguments must be an object/)
  }
  for (const version of [undefined, 123, '', '1.2', 'latest', '01.2.3', '1.2.3-01']) {
    assert.throws(() => checkPackageVersion({ version, range: '*' }), /version must be a complete semantic version/)
  }
  for (const range of [undefined, null, 123, 'latest', 'workspace:*', '>=oops']) {
    assert.throws(() => checkPackageVersion({ version: '1.2.3', range }), /range must be an npm semver range/)
  }
  for (const includePrerelease of ['false', 0, null]) {
    assert.throws(() => checkPackageVersion({ version: '1.2.3', range: '*', includePrerelease }), /includePrerelease must be a boolean/)
  }
  assert.throws(() => checkPackageVersion({ version: '1.2.3', range: '*', package: 'dsh' }), /Unknown argument: package/)
})

test('preserves the supplied version and range and accepts frozen arguments', () => {
  const args = Object.freeze({ version: '1.2.3+build.7', range: ' >=1.0.0 <2.0.0 ', includePrerelease: false })
  assert.deepEqual(checkPackageVersion(args), { ...args, satisfies: true })
})
