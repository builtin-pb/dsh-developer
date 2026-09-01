import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  formatSourceMigrationReport,
  inspectSourceMigration,
  SOURCE_MIGRATION_LEDGER_DIGEST,
  SOURCE_MIGRATION_LEDGER_V1,
} from '../lib/source-migration.js'

const corridor = {
  fromDsh: '0.1.1-rc.2',
  toDsh: '0.1.2-alpha.3',
}

function fixture(name) {
  return fileURLToPath(new URL('./fixtures/source-migration/' + name + '/', import.meta.url))
}

test('publishes a frozen, exact-corridor, two-family migration ledger', () => {
  assert.equal(SOURCE_MIGRATION_LEDGER_V1.schemaVersion, 1)
  assert.equal(SOURCE_MIGRATION_LEDGER_V1.ledgerVersion, '1.0.0')
  assert.deepEqual(SOURCE_MIGRATION_LEDGER_V1.corridor, {
    binding: 'exact',
    ...corridor,
  })
  assert.deepEqual(SOURCE_MIGRATION_LEDGER_V1.rules.map((rule) => rule.id), [
    'rc2-alpha3.web-client-runtime-removed',
    'rc2-alpha3.llm-call-id-renamed',
  ])
  assert.equal(Object.isFrozen(SOURCE_MIGRATION_LEDGER_V1), true)
  assert.equal(Object.isFrozen(SOURCE_MIGRATION_LEDGER_V1.rules[0].action.mappings), true)
  assert.match(SOURCE_MIGRATION_LEDGER_DIGEST, /^sha256:[a-f0-9]{64}$/u)
})

test('returns exact actionable touchpoints and a stable digest without editing source', async () => {
  const source = fixture('hits')
  const first = await inspectSourceMigration(source, corridor)
  const second = await inspectSourceMigration(source, corridor)

  assert.equal(first.kind, 'dsh-source-migration')
  assert.equal(first.ok, true)
  assert.equal(first.advisory, true)
  assert.equal(first.plugin.name, 'source-migration-hit-fixture')
  assert.equal(first.evidenceDigest, second.evidenceDigest)
  assert.equal(first.ledger.digest, SOURCE_MIGRATION_LEDGER_DIGEST)
  assert.deepEqual(first.summary, {
    findings: 6,
    files: 4,
    rules: 2,
    manualReview: 4,
    codeFilesScanned: 3,
    byPlane: {
      manifest: 1,
      shared: 2,
      'web-client': 3,
    },
  })
  assert.deepEqual(first.findings.map((finding) => [
    finding.touchpoint.path,
    finding.touchpoint.line,
    finding.ruleId,
  ]), [
    ['package.json', 8, 'rc2-alpha3.web-client-runtime-removed'],
    ['package.json', 13, 'rc2-alpha3.web-client-runtime-removed'],
    ['src/client.ts', 7, 'rc2-alpha3.web-client-runtime-removed'],
    ['src/lazy.ts', 2, 'rc2-alpha3.web-client-runtime-removed'],
    ['src/llm.ts', 1, 'rc2-alpha3.llm-call-id-renamed'],
    ['src/llm.ts', 2, 'rc2-alpha3.llm-call-id-renamed'],
  ])

  const client = first.findings.find((finding) => finding.touchpoint.path === 'src/client.ts')
  assert.deepEqual(client.action.mappings, [
    {
      from: 'ClientContext',
      boundAs: 'BrowserContext',
      to: 'Context',
      module: '@deepseek-ai/cordis',
    },
    {
      from: 'CommandRowProps',
      boundAs: 'CommandRowProps',
      to: 'CommandRowProps',
      module: '@deepseek-ai/dsh-client-ui-chat/client',
    },
    {
      from: 'ConversationNode',
      boundAs: 'ConversationNode',
      to: 'ConversationNode',
      module: '@deepseek-ai/dsh-client-ui-conversation/client',
    },
    {
      from: 'SessionId',
      boundAs: 'SessionId',
      to: 'SessionId',
      module: '@deepseek-ai/dsh-session/types',
    },
  ])
  assert.deepEqual(client.action.unmapped, ['SessionRuntime'])
  assert.equal(client.action.manualReview, true)

  const aliasedCall = first.findings.find((finding) => finding.touchpoint.path === 'src/llm.ts'
    && finding.touchpoint.line === 1)
  assert.equal(aliasedCall.touchpoint.boundAs, 'LegacyCallId')
  assert.equal(aliasedCall.action.to, 'ToolCallId')
  assert.equal(aliasedCall.action.preserveLocalAlias, true)

  const formatted = formatSourceMigrationReport(first)
  assert.match(formatted, /^ADVISE DSH source migration source-migration-hit-fixture 0\.1\.1-rc\.2 -> 0\.1\.2-alpha\.3/u)
  assert.match(formatted, /MAP ClientContext -> @deepseek-ai\/cordis#Context/u)
  assert.match(formatted, /PENDING SessionRuntime/u)
  assert.ok(formatted.endsWith('Evidence: ' + first.evidenceDigest))
})

test('ignores prose, comments, regex text, member methods, local names, and zero-net-state examples', async () => {
  const report = await inspectSourceMigration(fixture('clean'), corridor)
  assert.equal(report.ok, true)
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.summary.byPlane, {})
  assert.match(formatSourceMigrationReport(report), /^PASS DSH source migration/u)
})

test('rejects unsupported corridors and mutation options before reading source', async () => {
  await assert.rejects(
    inspectSourceMigration('C:\\never-read', {
      fromDsh: '0.1.1-rc.2',
      toDsh: '0.1.2-alpha.2',
    }),
    (error) => error.code === 'MIGRATION_CORRIDOR_UNSUPPORTED'
      && error.details.supported.toDsh === '0.1.2-alpha.3',
  )
  await assert.rejects(
    inspectSourceMigration('C:\\never-read', {
      ...corridor,
      apply: true,
    }),
    (error) => error.code === 'MIGRATION_OPTIONS_INVALID'
      && /Unsupported source-migration option/u.test(error.message),
  )
})
