import assert from 'node:assert/strict'
import test from 'node:test'
import { DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET } from '../lib/constants.js'
import { asDiagnostic, DshDeveloperError } from '../lib/errors.js'
import { createNativeToolDefinition } from '../lib/native-tool-internal.js'
import {
  appendFirstNextAction,
  deriveNextActions,
  NEXT_ACTION_IDS,
  NEXT_ACTION_LIMIT,
  NEXT_ACTION_SCHEMA,
  withNextActions,
} from '../lib/recovery-actions.js'
import { inspectUiCapabilities } from '../lib/ui-capabilities.js'
import { inspectSourceMigration } from '../lib/source-migration.js'

const DIGEST = 'sha256:' + 'a'.repeat(64)
const SECRET = 'malicious-secret-token-123456'

function ids(actions) {
  return actions.map((action) => action.id)
}

function schemaKeywords(value, found = new Set()) {
  if (value === null || typeof value !== 'object') return found
  for (const [key, child] of Object.entries(value)) {
    found.add(key)
    schemaKeywords(child, found)
  }
  return found
}

test('publishes one closed bounded action vocabulary with stable ordering and deduplication', () => {
  assert.equal(NEXT_ACTION_SCHEMA.additionalProperties, false)
  assert.deepEqual(NEXT_ACTION_SCHEMA.properties.id.enum, [...NEXT_ACTION_IDS])
  const keywords = schemaKeywords(NEXT_ACTION_SCHEMA)
  for (const unsupported of ['maxItems', 'minItems', 'maxLength', 'minLength']) {
    assert.equal(keywords.has(unsupported), false)
  }
  const context = {
    operation: 'doctor',
    report: {
      kind: 'isolated-cell-run',
      ok: false,
      planDigest: DIGEST,
      runtime: { lane: { recognized: false } },
      cleanup: { requiresCellDiscard: true },
      failure: { code: 'CELL_NOT_ADMITTED', message: SECRET },
      checks: [
        { id: 'compatibility.public-runtime', status: 'FAIL', blocking: true, message: SECRET },
        { id: 'compatibility.public-runtime', status: 'FAIL', blocking: true, message: SECRET },
        { id: 'source', status: 'FAIL', blocking: true, message: SECRET },
      ],
    },
  }
  const first = deriveNextActions(context)
  const second = deriveNextActions(structuredClone(context))
  assert.deepEqual(first, second)
  assert.equal(first.length, NEXT_ACTION_LIMIT)
  assert.deepEqual(ids(first), [
    'cell.discard',
    'dsh.select-reviewed-lane',
    'cell.resolve-admission',
  ])
  assert.equal(new Set(ids(first)).size, first.length)
  assert.ok(first.every((action) => action.automatic === false && Object.isFrozen(action)))
})

test('never copies diagnostic text, paths, source values, or invalid digests into actions', () => {
  const hostile = deriveNextActions({
    operation: 'ui',
    diagnostic: {
      code: 'UI_CLI_NOT_CONFIGURED',
      message: SECRET,
      path: 'C:\\' + SECRET + '\\payload',
    },
    input: { source: 'C:\\' + SECRET, planDigest: SECRET },
  })
  assert.deepEqual(ids(hostile), ['ui.configure-prerequisites'])
  assert.doesNotMatch(JSON.stringify(hostile), new RegExp(SECRET, 'u'))

  const poisoned = deriveNextActions({
    operation: 'cell-discard',
    diagnostic: {
      code: 'CELL_DISCARD_CLEANUP_FAILED',
      message: SECRET,
      retainedRoot: 'C:\\' + SECRET,
    },
    input: { planDigest: SECRET },
  })
  assert.equal(poisoned[0].recovery.kind, 'instruction')
  assert.doesNotMatch(JSON.stringify(poisoned), new RegExp(SECRET, 'u'))
})

test('is total on missing evidence and preserves the underlying report and digest', () => {
  assert.deepEqual(deriveNextActions(), [])
  assert.deepEqual(deriveNextActions({ report: null, diagnostic: [] }), [])
  const report = inspectUiCapabilities([{ name: 'bash', parameters: {} }])
  const before = structuredClone(report)
  const boundary = withNextActions(report, { operation: 'ui' })
  assert.equal(boundary.evidenceDigest, report.evidenceDigest)
  assert.deepEqual(report, before)
  assert.equal(Object.hasOwn(report, 'nextActions'), false)
  assert.deepEqual(ids(boundary.nextActions), ['ui.resolve-admission'])
})

test('orders exact-lane recovery before Doctor and preflight repair without promoting preview evidence', () => {
  const doctor = deriveNextActions({
    operation: 'doctor',
    report: {
      kind: 'doctor-plugin',
      ok: false,
      checks: [
        { id: 'compatibility.public-runtime', status: 'SKIP', blocking: false },
        { id: 'package', status: 'FAIL', blocking: true },
      ],
    },
  })
  assert.deepEqual(ids(doctor), ['dsh.select-reviewed-lane', 'doctor.resolve-blocker'])
  assert.match(doctor[0].recovery.text, new RegExp(DSH_COMPATIBILITY_TARGET.replaceAll('.', '\\.'), 'u'))
  assert.match(doctor[0].recovery.text, /never use preview evidence as release proof/u)

  const preflight = deriveNextActions({
    operation: 'preflight',
    report: {
      kind: 'dsh-profile-preflight',
      ok: false,
      checks: [
        { id: 'runtime.identity', status: 'FAIL', blocking: true },
        { id: 'profile.service-contract', status: 'FAIL', blocking: true },
      ],
    },
  })
  assert.deepEqual(ids(preflight), ['dsh.select-reviewed-lane', 'preflight.resolve-blocker'])

  const laneOnlyDoctor = deriveNextActions({
    operation: 'doctor',
    report: {
      kind: 'doctor-plugin',
      ok: false,
      checks: [{ id: 'compatibility.public-runtime', status: 'SKIP', blocking: false }],
    },
  })
  assert.deepEqual(ids(laneOnlyDoctor), ['dsh.select-reviewed-lane'])

  const laneOnlyPreflight = deriveNextActions({
    operation: 'preflight',
    report: {
      kind: 'dsh-profile-preflight',
      ok: false,
      checks: [{ id: 'runtime.identity', status: 'FAIL', blocking: true }],
    },
  })
  assert.deepEqual(ids(laneOnlyPreflight), ['dsh.select-reviewed-lane'])

  const laneDiagnostic = deriveNextActions({
    operation: 'doctor',
    report: {
      kind: 'dsh-developer-diagnostic',
      ok: false,
      diagnostic: { code: 'DSH_VERSION_MISMATCH' },
    },
  })
  assert.deepEqual(ids(laneDiagnostic), ['dsh.select-reviewed-lane'])

  const preview = deriveNextActions({
    operation: 'capabilities',
    report: {
      kind: 'dsh-capabilities',
      ok: true,
      runtime: { version: DSH_PREVIEW_TARGET, lane: { id: 'preview', claim: 'preview', recognized: true } },
      checks: [{ id: 'runtime.version', status: 'PASS', blocking: false }],
    },
  })
  assert.deepEqual(preview, [])
})

test('models cell plan, approval denial, admission failure, run failure, and cleanup poison safely', () => {
  const plan = deriveNextActions({
    operation: 'cell-plan',
    report: { kind: 'isolated-cell-plan', ok: true, planDigest: DIGEST },
  })
  assert.deepEqual(ids(plan), ['cell.request-approved-run', 'cell.discard'])
  assert.equal(plan[0].authorityClass, 'human-approval-once')
  assert.equal(plan[0].recovery.onDenied, 'stop-without-execution-or-retry')
  assert.deepEqual(plan[0].recovery.argumentTemplate, [
    { name: 'planDigest', source: 'literal', value: DIGEST },
  ])

  const denied = deriveNextActions({
    operation: 'cell-run',
    input: { planDigest: DIGEST },
    approvalOutcome: 'rejected',
  })
  assert.deepEqual(ids(denied), ['cell.stop-after-approval-denial'])
  assert.equal(denied[0].effectClass, 'none')
  assert.doesNotMatch(JSON.stringify(denied), /cell-run.*planDigest/su)

  const failed = deriveNextActions({
    operation: 'cell-run',
    report: {
      kind: 'isolated-cell-run',
      ok: false,
      planDigest: DIGEST,
      failure: { code: 'CELL_NOT_ADMITTED', message: SECRET },
      cleanup: { requiresCellDiscard: true },
    },
  })
  assert.deepEqual(ids(failed), [
    'cell.discard',
    'cell.resolve-admission',
    'cell.resolve-run-failure',
  ])
  assert.equal(failed[0].recovery.argumentTemplate[0].value, DIGEST)
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(SECRET, 'u'))
})

test('distinguishes UI prerequisite failure from provider admission failure', () => {
  const prerequisite = deriveNextActions({ diagnostic: { code: 'UI_CLI_VERSION_MISMATCH' } })
  assert.deepEqual(ids(prerequisite), ['ui.configure-prerequisites'])
  assert.match(prerequisite[0].recovery.text, /Do not discover or install them automatically/u)

  const admission = deriveNextActions({
    report: { kind: 'ui-capabilities', ok: false, checks: [] },
  })
  assert.deepEqual(ids(admission), ['ui.resolve-admission'])
  assert.match(admission[0].recovery.text, /Keep browser execution, file transfer, and non-loopback navigation denied/u)
})

test('native boundary returns the full set while rendering only the first action', async () => {
  const report = {
    kind: 'doctor-plugin',
    ok: false,
    source: 'plugin',
    checks: [
      { id: 'compatibility.public-runtime', status: 'SKIP', blocking: false, message: 'skipped' },
      { id: 'package', status: 'FAIL', blocking: true, message: 'failed' },
    ],
    evidenceDigest: DIGEST,
  }
  const definition = createNativeToolDefinition(async () => ({ operation: 'doctor', ok: false, report }))
  const value = await definition.execute(
    { operation: 'doctor', source: 'plugin' },
    { signal: new AbortController().signal },
  )
  assert.deepEqual(ids(value.nextActions), ['dsh.select-reviewed-lane', 'doctor.resolve-blocker'])
  assert.equal(value.report, report)
  assert.equal(value.report.evidenceDigest, DIGEST)
  const rendered = definition.output.render({}, value)[0].text
  assert.equal((rendered.match(/Next action \[/gu) ?? []).length, 1)
  assert.match(rendered, /dsh\.select-reviewed-lane/u)

  const failedDefinition = createNativeToolDefinition(async () => {
    throw new DshDeveloperError('CELL_DISCARD_CLEANUP_FAILED', SECRET, { retainedRoot: SECRET })
  })
  const failure = await failedDefinition.execute(
    { operation: 'cell-discard', planDigest: DIGEST },
    { signal: new AbortController().signal },
  )
  assert.equal(failure.ok, false)
  assert.equal(failure.report.diagnostic.code, 'CELL_DISCARD_CLEANUP_FAILED')
  assert.deepEqual(ids(failure.nextActions), ['cell.discard'])
  assert.doesNotMatch(JSON.stringify(failure.nextActions), new RegExp(SECRET, 'u'))
})

test('approval denial finalization stops without inventing execution authority', () => {
  const definition = createNativeToolDefinition(async () => {
    throw new Error('must not execute')
  })
  const result = {
    isError: true,
    error: { message: 'the user rejected tool "dsh_developer"' },
    content: [{ type: 'text', text: 'Error: rejected' }],
  }
  const content = definition.finalizeContent(
    { operation: 'cell-run', planDigest: DIGEST },
    result,
  )
  assert.equal(content.length, 2)
  assert.match(content[1].text, /cell\.stop-after-approval-denial/u)
  assert.match(content[1].text, /Stop without executing or retrying/u)
  assert.doesNotMatch(content[1].text, /allowed-once|grant/u)
})

test('unsupported migration corridor fails before source access and emits a safe boundary action', async () => {
  const missingSource = 'C:\\missing-' + SECRET + '\\plugin'
  let diagnostic
  await assert.rejects(
    inspectSourceMigration(missingSource, { fromDsh: '9.9.9', toDsh: '10.0.0' }),
    (error) => {
      diagnostic = withNextActions(asDiagnostic(error), {
        operation: 'migration',
        diagnostic: asDiagnostic(error),
      })
      return error.code === 'MIGRATION_CORRIDOR_UNSUPPORTED'
    },
  )
  assert.equal(diagnostic.code, 'MIGRATION_CORRIDOR_UNSUPPORTED')
  assert.deepEqual(ids(diagnostic.nextActions), ['migration.use-supported-corridor'])
  assert.doesNotMatch(JSON.stringify(diagnostic.nextActions), new RegExp(SECRET, 'u'))
  assert.deepEqual(diagnostic.nextActions[0].recovery.argumentTemplate, [
    { name: 'source', source: 'original-request', field: 'source' },
    { name: 'fromDsh', source: 'literal', value: DSH_COMPATIBILITY_TARGET },
    { name: 'toDsh', source: 'literal', value: DSH_PREVIEW_TARGET },
    { name: 'json', source: 'literal', value: true },
  ])
})

test('human rendering appends no more than the first relevant action', () => {
  const actions = deriveNextActions({
    operation: 'doctor',
    report: {
      kind: 'doctor-plugin',
      ok: false,
      checks: [
        { id: 'compatibility.public-runtime', status: 'SKIP', blocking: false },
        { id: 'source', status: 'FAIL', blocking: true },
      ],
    },
  })
  const rendered = appendFirstNextAction('FAIL Doctor', actions)
  assert.equal((rendered.match(/Next action \[/gu) ?? []).length, 1)
  assert.match(rendered, /dsh\.select-reviewed-lane/u)
  assert.doesNotMatch(rendered, /doctor\.resolve-blocker/u)
})
