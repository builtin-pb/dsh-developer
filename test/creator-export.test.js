import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateCreatorFingerprint,
  normalizeCreatorExport,
  withCreatorFingerprint,
} from '../lib/creator-export.js'
import { DshDeveloperError } from '../lib/errors.js'
import { renderGeneratedBundle } from '../lib/templates.js'

function draft(overrides = {}) {
  return {
    format: 'dsh-creator-export',
    schemaVersion: 1,
    name: 'sample-plugin',
    packageName: 'sample-plugin',
    author: 'Example contributors',
    description: 'A deterministic sample DSH plugin.',
    goal: 'Help the user finish one small task.',
    instructions: 'Ask for missing required input, then return a concise result.',
    compatibilityTarget: '0.1.1-rc.2',
    decisions: ['Keep one canonical skill.'],
    unresolvedRisks: [],
    tools: [],
    resources: [],
    ...overrides,
  }
}

test('fingerprints normalized Creator exports deterministically', () => {
  const first = withCreatorFingerprint(draft())
  const reordered = withCreatorFingerprint({
    resources: [],
    tools: [],
    unresolvedRisks: [],
    decisions: ['Keep one canonical skill.'],
    compatibilityTarget: '0.1.1-rc.2',
    instructions: 'Ask for missing required input, then return a concise result.',
    goal: 'Help the user finish one small task.',
    description: 'A deterministic sample DSH plugin.',
    author: 'Example contributors',
    packageName: 'sample-plugin',
    name: 'sample-plugin',
    schemaVersion: 1,
    format: 'dsh-creator-export',
  })
  assert.equal(first.sourceFingerprint, reordered.sourceFingerprint)
  assert.equal(first.sourceFingerprint, calculateCreatorFingerprint(first))
  assert.deepEqual(normalizeCreatorExport(first), normalizeCreatorExport(reordered))
})

test('rejects content tampering after a fingerprint is issued', () => {
  const value = withCreatorFingerprint(draft())
  value.instructions = 'Different instructions.'
  assert.throws(
    () => normalizeCreatorExport(value),
    (error) => error instanceof DshDeveloperError && error.code === 'INVALID_CREATOR_EXPORT',
  )
})

test('rejects unknown fields and likely credentials', () => {
  assert.throws(
    () => withCreatorFingerprint(draft({ surprise: true })),
    (error) => error.code === 'INVALID_CREATOR_EXPORT',
  )
  const credentialLikeText = 'Use api' + '_key=' + 'abcdefghijklmnopqrstuvwxyz123456.'
  assert.throws(
    () => withCreatorFingerprint(draft({ instructions: credentialLikeText })),
    (error) => error.code === 'SECRET_DETECTED',
  )

  const credentialCases = [
    '{"pass' + 'word":"hunter22"}',
    '{"api' + 'Key":"abcd1234"}',
    'xox' + 'b-' + '1234567890-' + 'abcdefghijklmnop',
    'npm' + '_' + 'A1b2C3d4E5f6G7' + 'h8I9j0K1l2M3n4',
    'Authorization: Bearer ' + 'A1b2C3d4E5f6G7' + 'h8I9j0K1l2',
    'eyJ' + 'hbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0' + 'NTY3ODkwIn0.' + 'AbCdEfGhIjKlMnOp' + 'QrStUvWxYz12',
    'Secret material: ' + 'mZ9_2Qa7-Lp4Xv8N' + '1sK6Rt3Wc5Yh0BjF',
  ]
  for (const instructions of credentialCases) {
    assert.throws(
      () => withCreatorFingerprint(draft({ instructions })),
      (error) => error.code === 'SECRET_DETECTED',
      instructions.slice(0, 24),
    )
  }
})

test('renders a deterministic dual DSH and Codex bundle', () => {
  const value = withCreatorFingerprint(draft())
  const first = renderGeneratedBundle(value)
  const second = renderGeneratedBundle(value)
  assert.equal(first.fingerprint, second.fingerprint)
  assert.deepEqual([...first.files], [...second.files])
  assert.match(first.files.get('cordis.patch.yml'), /name: 'sample-plugin'/u)
  assert.match(first.files.get('index.js'), /export async function apply/u)
  assert.match(first.files.get('.codex-plugin/plugin.json'), /"name": "sample-plugin"/u)
  assert.match(first.files.get('skills/sample-plugin/SKILL.md'), /name: sample-plugin/u)
  assert.match(first.files.get('README.md'), /The single plugin you need for DSH/u)
})
