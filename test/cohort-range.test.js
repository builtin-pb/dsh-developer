import assert from 'node:assert/strict'
import test from 'node:test'
import {
  inspectCohortRanges,
  satisfiesNpmRange,
} from '../lib/cohort-range.js'

function assertRange(version, range, expected) {
  assert.deepEqual(satisfiesNpmRange(version, range), { known: true, satisfies: expected })
}

test('applies npm prerelease exclusion to DSH caret cohorts', () => {
  assertRange('0.1.1-rc.2', '^0.1.0-rc.8', false)
  assertRange('0.1.2-alpha.3', '^0.1.0-rc.8', false)
  assertRange('0.1.2-alpha.3', '^0.1.2-alpha.2', true)
  assertRange('0.1.2-beta.1', '^0.1.2-alpha.2', true)
  assertRange('0.1.3-alpha.1', '^0.1.2-alpha.2', false)
  assertRange('0.1.2-alpha.3', '>=0.1.2-alpha.2 <0.2.0', true)
  assertRange('0.1.2-alpha.3', '>=0.1.1 <0.2.0', false)
})

test('supports exact, tilde, partial, wildcard, workspace, hyphen, and OR ranges', () => {
  assertRange('1.2.3', '1.2.3', true)
  assertRange('1.2.9', '~1.2.3', true)
  assertRange('1.3.0', '~1.2.3', false)
  assertRange('1.2.9', '1.2.x', true)
  assertRange('1.3.0', '1.2', false)
  assertRange('2.0.0', '*', true)
  assertRange('1.2.3', 'workspace:^1.2.0', true)
  assertRange('1.5.0', '1.2.3 - 2.0.0', true)
  assertRange('0.1.2-alpha.3', '^0.1.1-rc.2 || ^0.1.2-alpha.2', true)
  assert.deepEqual(satisfiesNpmRange('1.2.3', 'catalog:dsh'), { known: false, satisfies: false })
  assert.deepEqual(satisfiesNpmRange('1.2.3', 'workspace:^'), { known: false, satisfies: false })
})

test('reports peer and development range coverage from exact installed surfaces', () => {
  const references = {
    packages: [
      {
        package: '@deepseek-ai/dsh-agent',
        evidence: [
          { kind: 'package-manifest', field: 'peerDependencies', range: '^0.1.0-rc.8' },
          { kind: 'package-manifest', field: 'devDependencies', range: '^0.1.2-alpha.2' },
        ],
      },
      {
        package: 'typescript',
        evidence: [{ kind: 'package-manifest', field: 'devDependencies', range: '^5.0.0' }],
      },
    ],
  }
  const changes = [
    {
      package: '@deepseek-ai/dsh-agent',
      release: { version: '0.1.1-rc.2' },
      preview: { version: '0.1.2-alpha.3' },
    },
    {
      package: 'typescript',
      release: { version: '5.8.0' },
      preview: { version: '5.9.0' },
    },
  ]
  assert.deepEqual(inspectCohortRanges(references, changes).map((value) => ({
    field: value.field,
    status: value.status,
    acceptedLanes: value.acceptedLanes,
  })), [
    { field: 'devDependencies', status: 'covered', acceptedLanes: ['preview'] },
    { field: 'peerDependencies', status: 'uncovered', acceptedLanes: [] },
  ])
})
