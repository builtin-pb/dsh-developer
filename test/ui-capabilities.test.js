import assert from 'node:assert/strict'
import test from 'node:test'
import { formatUiCapabilityReport, inspectUiCapabilities } from '../lib/ui-capabilities.js'

const PLAYWRIGHT_CORE = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_wait_for',
  'browser_take_screenshot',
  'browser_console_messages',
  'browser_network_requests',
  'browser_close',
  'browser_run_code_unsafe',
  'browser_evaluate',
  'browser_file_upload',
  'browser_drop',
]

function schemas(namespace, names = PLAYWRIGHT_CORE) {
  return names.map((name) => ({
    name: 'mcp__' + namespace + '__' + name,
    description: name,
    parameters: { type: 'object', properties: {} },
  }))
}

const GUARDED = { guardedNamespaces: ['dsh_ui'] }

test('fails closed when the scoped registry has no semantic UI provider', () => {
  const report = inspectUiCapabilities([{ name: 'bash', parameters: {} }])
  assert.equal(report.ok, false)
  assert.equal(report.selected, null)
  assert.equal(report.checks[0].status, 'FAIL')
  assert.match(report.evidenceDigest, /^sha256:[a-f0-9]{64}$/u)
  assert.match(formatUiCapabilityReport(report), /^FAIL UI capabilities \(no provider\)/u)
})

test('admits a complete Playwright-compatible provider only in the protected namespace', () => {
  const report = inspectUiCapabilities([
    ...schemas('dsh_ui'),
    { name: 'mcp__dsh_ui__browser_extra', description: '', parameters: {} },
  ], GUARDED)
  assert.equal(report.ok, true)
  assert.equal(report.selected.adapter, 'playwright-compatible')
  assert.equal(report.selected.namespace, 'dsh_ui')
  assert.equal(report.selected.policy, 'dsh-developer-guard')
  assert.equal(report.selected.operations.snapshot, 'mcp__dsh_ui__browser_snapshot')
  assert.equal(report.selected.catalogTools, PLAYWRIGHT_CORE.length + 1)
  assert.match(report.selected.catalogDigest, /^sha256:[a-f0-9]{64}$/u)
  assert.equal(report.providers[0].riskTools.length, 4)
  assert.match(formatUiCapabilityReport(report), /snapshot -> act -> wait -> assert/u)
})

test('reports complete but unguarded browser authority as not admitted', () => {
  const report = inspectUiCapabilities(schemas('playwright'))
  assert.equal(report.ok, false)
  assert.equal(report.providers[0].ready, true)
  assert.equal(report.providers[0].admitted, false)
  assert.equal(report.providers[0].policy, 'external')
  assert.equal(report.checks.find((item) => item.id === 'authority-boundary').status, 'FAIL')
})

test('selects an admitted provider ahead of a smaller unguarded catalog', () => {
  const report = inspectUiCapabilities([
    ...schemas('external'),
    ...schemas('dsh_ui'),
  ], GUARDED)
  assert.equal(report.ok, true)
  assert.equal(report.selected.namespace, 'dsh_ui')
})

test('recognizes the Chrome DevTools semantic and performance surface', () => {
  const names = [
    'navigate_page',
    'take_snapshot',
    'click',
    'fill',
    'wait_for',
    'take_screenshot',
    'list_console_messages',
    'list_network_requests',
    'performance_start_trace',
    'close_page',
    'evaluate_script',
  ]
  const report = inspectUiCapabilities(schemas('dsh_ui', names), GUARDED)
  assert.equal(report.ok, true)
  assert.equal(report.selected.adapter, 'chrome-devtools-compatible')
  assert.equal(report.selected.operations.performance, 'mcp__dsh_ui__performance_start_trace')
})

test('evidence is stable across irrelevant schema ordering', () => {
  const first = inspectUiCapabilities(schemas('dsh_ui'), GUARDED)
  const second = inspectUiCapabilities([...schemas('dsh_ui')].reverse(), GUARDED)
  assert.equal(first.evidenceDigest, second.evidenceDigest)
})

test('does not infer a live guard from a provider namespace alone', () => {
  const report = inspectUiCapabilities(schemas('dsh_ui'))
  assert.equal(report.ok, false)
  assert.equal(report.providers[0].ready, true)
  assert.equal(report.providers[0].policy, 'external')
})
