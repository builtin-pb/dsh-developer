import { createHash } from 'node:crypto'

const PROTECTED_NAMESPACE = 'dsh_ui'

const ADAPTERS = Object.freeze([
  Object.freeze({
    id: 'playwright-compatible',
    rank: 0,
    operations: Object.freeze({
      navigate: 'browser_navigate',
      snapshot: 'browser_snapshot',
      click: 'browser_click',
      input: 'browser_type',
      wait: 'browser_wait_for',
      screenshot: 'browser_take_screenshot',
      console: 'browser_console_messages',
      network: 'browser_network_requests',
      close: 'browser_close',
    }),
    risk: Object.freeze([
      'browser_run_code_unsafe',
      'browser_evaluate',
      'browser_file_upload',
      'browser_drop',
    ]),
  }),
  Object.freeze({
    id: 'chrome-devtools-compatible',
    rank: 1,
    operations: Object.freeze({
      navigate: 'navigate_page',
      snapshot: 'take_snapshot',
      click: 'click',
      input: 'fill',
      wait: 'wait_for',
      screenshot: 'take_screenshot',
      console: 'list_console_messages',
      network: 'list_network_requests',
      performance: 'performance_start_trace',
      close: 'close_page',
    }),
    risk: Object.freeze([
      'evaluate_script',
      'upload_file',
      'execute_3p_developer_tool',
      'install_extension',
      'uninstall_extension',
      'install_pwa',
      'uninstall_pwa',
    ]),
  }),
])

const REQUIRED_OPERATIONS = Object.freeze([
  'navigate',
  'snapshot',
  'click',
  'input',
  'wait',
  'screenshot',
  'console',
  'close',
])
const NATIVE_CLI_OPERATIONS = Object.freeze({
  navigate: 'dsh_ui',
  snapshot: 'dsh_ui',
  click: 'dsh_ui',
  input: 'dsh_ui',
  wait: 'dsh_ui',
  screenshot: 'dsh_ui',
  console: 'dsh_ui',
  network: 'dsh_ui',
  close: 'dsh_ui',
})

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    )
  }
  return value
}

function digest(value) {
  return 'sha256:' + createHash('sha256')
    .update(JSON.stringify(stableValue(value)), 'utf8')
    .digest('hex')
}

function usableSchemas(value) {
  if (!Array.isArray(value)) throw new TypeError('UI capability inspection requires a tool-schema array')
  return value.filter((schema) => schema !== null
    && typeof schema === 'object'
    && typeof schema.name === 'string'
    && schema.name.length > 0)
}

function namespaceFor(name, rawName) {
  const prefix = 'mcp__'
  const suffix = '__' + rawName
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return undefined
  const namespace = name.slice(prefix.length, -suffix.length)
  return namespace.length > 0 ? namespace : undefined
}

function providerCandidates(schemas) {
  const byIdentity = new Map()
  for (const adapter of ADAPTERS) {
    const rawNames = new Set([...Object.values(adapter.operations), ...adapter.risk])
    for (const schema of schemas) {
      for (const rawName of rawNames) {
        const namespace = namespaceFor(schema.name, rawName)
        if (namespace === undefined) continue
        const identity = adapter.id + '\0' + namespace
        if (!byIdentity.has(identity)) {
          byIdentity.set(identity, { adapter, namespace, names: new Map() })
        }
        byIdentity.get(identity).names.set(rawName, schema.name)
      }
    }
  }
  return [...byIdentity.values()]
}

function nativeCliProvider(schemas, active) {
  if (!active) return undefined
  const schema = schemas.find((candidate) => candidate.name === 'dsh_ui')
  const ready = schema !== undefined
  const tools = ready ? [schema] : []
  return {
    adapter: 'playwright-cli-native',
    namespace: 'native',
    ready,
    admitted: ready,
    policy: 'dsh-developer-native',
    operations: ready ? { ...NATIVE_CLI_OPERATIONS } : {},
    missing: ready ? [] : [...REQUIRED_OPERATIONS],
    riskTools: [],
    catalogTools: tools.length,
    catalogSchemaChars: JSON.stringify(tools).length,
    catalogDigest: digest(tools),
    rank: -1,
  }
}

function providerReport(candidate, schemas, guardedNamespaces) {
  const { adapter, namespace, names } = candidate
  const tools = schemas
    .filter((schema) => schema.name.startsWith('mcp__' + namespace + '__'))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  const operations = {}
  const missing = []
  for (const [operation, rawName] of Object.entries(adapter.operations)) {
    const publicName = names.get(rawName)
    if (publicName !== undefined) operations[operation] = publicName
    else if (REQUIRED_OPERATIONS.includes(operation)) missing.push(operation)
  }
  const riskTools = adapter.risk
    .map((rawName) => names.get(rawName))
    .filter((name) => name !== undefined)
    .sort()
  const policy = guardedNamespaces.has(namespace) ? 'dsh-developer-guard' : 'external'
  const ready = missing.length === 0
  const admitted = ready && (riskTools.length === 0 || policy === 'dsh-developer-guard')
  return {
    adapter: adapter.id,
    namespace,
    ready,
    admitted,
    policy,
    operations,
    missing,
    riskTools,
    catalogTools: tools.length,
    catalogSchemaChars: JSON.stringify(tools).length,
    catalogDigest: digest(tools),
    rank: adapter.rank,
  }
}

function selectProvider(providers) {
  return [...providers].sort((left, right) => {
    if (left.admitted !== right.admitted) return left.admitted ? -1 : 1
    if (left.ready !== right.ready) return left.ready ? -1 : 1
    if (left.catalogSchemaChars !== right.catalogSchemaChars) {
      return left.catalogSchemaChars - right.catalogSchemaChars
    }
    if (left.rank !== right.rank) return left.rank - right.rank
    return left.namespace.localeCompare(right.namespace, 'en')
  })[0]
}

function visibleProviderCatalog(schemas, providers) {
  const mcpNamespaces = new Set(
    providers.filter((provider) => provider.namespace !== 'native')
      .map((provider) => provider.namespace),
  )
  const nativeVisible = providers.some((provider) => (
    provider.namespace === 'native' && provider.ready
  ))
  const tools = schemas.filter((schema) => (
    (nativeVisible && schema.name === 'dsh_ui')
    || [...mcpNamespaces].some((namespace) => schema.name.startsWith('mcp__' + namespace + '__'))
  )).sort((left, right) => left.name.localeCompare(right.name, 'en'))
  return {
    tools: tools.length,
    schemaChars: JSON.stringify(tools).length,
    digest: digest(tools),
  }
}

function check(id, status, blocking, message) {
  return { id, status, blocking, message }
}

function normalizeGuardedNamespaces(value) {
  if (value === undefined) return new Set()
  if (!Array.isArray(value)) throw new TypeError('guardedNamespaces must be an array')
  const namespaces = new Set()
  for (const namespace of value) {
    if (typeof namespace !== 'string' || namespace.length === 0) {
      throw new TypeError('guardedNamespaces entries must be non-empty strings')
    }
    namespaces.add(namespace)
  }
  return namespaces
}

export function inspectUiCapabilities(value, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('UI capability options must be an object')
  }
  const unknownOptions = Object.keys(options).filter((key) => key !== 'guardedNamespaces' && key !== 'nativeCliActive')
  if (unknownOptions.length > 0) throw new TypeError('Unknown UI capability option: ' + unknownOptions[0])
  if (options.nativeCliActive !== undefined && typeof options.nativeCliActive !== 'boolean') {
    throw new TypeError('nativeCliActive must be boolean')
  }
  const guardedNamespaces = normalizeGuardedNamespaces(options.guardedNamespaces)
  const schemas = usableSchemas(value)
  const native = nativeCliProvider(schemas, options.nativeCliActive === true)
  const providers = [
    ...(native === undefined ? [] : [native]),
    ...providerCandidates(schemas)
    .map((candidate) => providerReport(candidate, schemas, guardedNamespaces))
  ]
    .sort((left, right) => left.rank - right.rank
      || left.namespace.localeCompare(right.namespace, 'en'))
  const selected = selectProvider(providers)
  const catalog = visibleProviderCatalog(schemas, providers)
  const checks = []
  if (selected === undefined) {
    checks.push(check(
      'semantic-provider',
      'FAIL',
      true,
      'No scoped MCP tool set exposes a recognized semantic browser contract.',
    ))
  } else {
    checks.push(check(
      'semantic-provider',
      selected.ready ? 'PASS' : 'FAIL',
      true,
      selected.ready
        ? selected.adapter + ' is complete in namespace ' + selected.namespace + '.'
        : selected.adapter + ' is missing: ' + selected.missing.join(', ') + '.',
    ))
    checks.push(check(
      'authority-boundary',
      selected.admitted ? 'PASS' : 'FAIL',
      true,
      selected.riskTools.length === 0
        ? 'No recognized code-execution or file-transfer browser tools are visible.'
        : selected.policy === 'dsh-developer-guard'
          ? 'Risk-bearing tools are visible but denied by the dsh_ui monotonic guard.'
          : 'Risk-bearing tools are visible without a dsh-developer-owned guard: ' + selected.riskTools.join(', ') + '.',
    ))
    checks.push(check(
      'bounded-visual-evidence',
      selected.operations.screenshot === undefined ? 'FAIL' : 'PASS',
      true,
      selected.operations.screenshot === undefined
        ? 'No targeted screenshot operation is visible.'
        : 'Targeted screenshots are available for deliberate visual checkpoints.',
    ))
    checks.push(check(
      'runtime-diagnostics',
      selected.operations.console === undefined ? 'FAIL' : 'PASS',
      true,
      selected.operations.console === undefined
        ? 'No console diagnostic operation is visible.'
        : 'Console diagnostics are available; network evidence is '
          + (selected.operations.network === undefined ? 'not visible.' : 'also visible.'),
    ))
    checks.push(check(
      'model-catalog-cost',
      'INFO',
      false,
      selected.catalogTools + ' provider tools contribute approximately '
        + selected.catalogSchemaChars + ' JSON characters on the selected route; recognized visible UI providers total '
        + catalog.tools + ' tools and approximately ' + catalog.schemaChars + ' characters.',
    ))
  }
  const report = {
    kind: 'ui-capabilities',
    version: 1,
    ok: selected?.admitted === true,
    selected: selected === undefined ? null : {
      adapter: selected.adapter,
      namespace: selected.namespace,
      policy: selected.policy,
      operations: selected.operations,
      catalogTools: selected.catalogTools,
      catalogSchemaChars: selected.catalogSchemaChars,
      catalogDigest: selected.catalogDigest,
    },
    providers: providers.map(({ rank: _rank, ...provider }) => provider),
    catalog,
    checks,
    policy: {
      interaction: 'semantic-snapshot-first',
      visualEvidence: 'targeted-checkpoints-only',
      pageContent: 'untrusted-data',
      preferredCodingRoute: 'playwright-cli',
      preferredExplorationRoute: 'scoped-mcp',
      guardedNamespaces: [...guardedNamespaces].sort(),
      nativeCliActive: options.nativeCliActive === true,
    },
  }
  report.evidenceDigest = digest(report)
  return report
}

export function formatUiCapabilityReport(report) {
  const selected = report.selected
  const lines = [
    (report.ok ? 'PASS' : 'FAIL') + ' UI capabilities '
      + (selected === null ? '(no provider)' : selected.adapter + ' [' + selected.namespace + ']'),
  ]
  for (const item of report.checks) {
    if (item.status === 'PASS') continue
    lines.push(item.status + ' ' + item.id + ': ' + item.message)
  }
  if (selected !== null) {
    lines.push('Route: snapshot -> act -> wait -> assert -> diagnostics -> visual checkpoint')
    lines.push('Catalog: ' + selected.catalogTools + ' tools / ~' + selected.catalogSchemaChars + ' JSON chars')
    if (report.catalog.tools !== selected.catalogTools
        || report.catalog.schemaChars !== selected.catalogSchemaChars) {
      lines.push('All recognized UI providers: ' + report.catalog.tools + ' tools / ~'
        + report.catalog.schemaChars + ' JSON chars')
    }
  }
  lines.push('Evidence: ' + report.evidenceDigest)
  return lines.join('\n')
}

export const UI_PROTECTED_NAMESPACE = PROTECTED_NAMESPACE
