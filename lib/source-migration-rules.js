import { createHash } from 'node:crypto'

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => [key, stableValue(value[key])]))
  }
  return value
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

export const SOURCE_MIGRATION_LEDGER_V1 = deepFreeze({
  schemaVersion: 1,
  ledgerVersion: '1.0.0',
  corridor: {
    binding: 'exact',
    fromDsh: '0.1.1-rc.2',
    toDsh: '0.1.2-alpha.3',
  },
  semantics: {
    effect: 'advisory-only',
    netState: 'Only target-state differences that remain actionable at the corridor endpoint are emitted.',
  },
  rules: [
    {
      id: 'rc2-alpha3.web-client-runtime-removed',
      family: 'removed-package',
      planes: ['manifest', 'web-client'],
      confidence: 'exact-installed-contract',
      netState: {
        kind: 'removed',
        from: {
          package: '@deepseek-ai/dsh-client-runtime',
          version: '0.1.1-rc.2',
          publicSubpaths: ['.', './client', './invariant', './package.json', './src/*'],
        },
        to: {
          hostVersion: '0.1.2-alpha.3',
          availability: 'absent',
        },
      },
      touchpoints: [
        {
          kind: 'manifest-dependency',
          package: '@deepseek-ai/dsh-client-runtime',
          fields: ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'],
        },
        {
          kind: 'module-specifier',
          packagePrefix: '@deepseek-ai/dsh-client-runtime',
          syntax: [
            'static-import',
            'static-export',
            'side-effect-import',
            'dynamic-import-unescaped-literal',
            'require-unescaped-literal',
          ],
          excludes: ['comments', 'prose-strings', 'template-text', 'regex-literals', 'member-method-calls'],
        },
        {
          kind: 'client-inject',
          jsonPath: 'dsh.client.inject',
          package: '@deepseek-ai/dsh-client-runtime',
        },
      ],
      action: {
        kind: 'split-by-current-owner',
        summary: 'Replace the removed aggregate import and Client inject with alpha.3 owner packages, then remove its direct dependency after every imported symbol is accounted for.',
        mappings: [
          {
            from: 'ClientContext',
            to: 'Context',
            module: '@deepseek-ai/cordis',
          },
          {
            from: 'SessionId',
            to: 'SessionId',
            module: '@deepseek-ai/dsh-session/types',
          },
          {
            from: 'ConversationNode',
            to: 'ConversationNode',
            module: '@deepseek-ai/dsh-client-ui-conversation/client',
          },
          {
            from: 'CommandRowProps',
            to: 'CommandRowProps',
            module: '@deepseek-ai/dsh-client-ui-chat/client',
          },
        ],
        unmapped: 'Keep the touchpoint pending until each remaining symbol is verified against an alpha.3 public owner; there is no safe one-package replacement.',
      },
      evidence: [
        {
          package: '@deepseek-ai/dsh-client-runtime',
          version: '0.1.1-rc.2',
          coordinate: 'package.json exports and lib/types/client/index.d.ts',
        },
        {
          package: '@deepseek-ai/dsh',
          version: '0.1.2-alpha.3',
          coordinate: 'exact installed dependency graph has no @deepseek-ai/dsh-client-runtime package',
        },
        {
          package: '@deepseek-ai/cordis',
          version: '4.0.2',
          coordinate: 'root Context export',
        },
        {
          package: '@deepseek-ai/dsh-session',
          version: '0.1.2-alpha.3',
          coordinate: 'exports["./types"] and lib/types/types.d.ts#SessionId',
        },
        {
          package: '@deepseek-ai/dsh-client-ui-conversation',
          version: '0.1.2-alpha.3',
          coordinate: 'exports["./client"] and client contract ConversationNode',
        },
        {
          package: '@deepseek-ai/dsh-client-ui-chat',
          version: '0.1.2-alpha.3',
          coordinate: 'exports["./client"] and client contract CommandRowProps',
        },
      ],
    },
    {
      id: 'rc2-alpha3.llm-call-id-renamed',
      family: 'renamed-symbol',
      planes: ['shared'],
      confidence: 'exact-installed-contract',
      netState: {
        kind: 'renamed',
        from: {
          module: '@deepseek-ai/dsh-llm',
          symbol: 'CallId',
          version: '0.1.1-rc.2',
        },
        to: {
          module: '@deepseek-ai/dsh-llm',
          symbol: 'ToolCallId',
          version: '0.1.2-alpha.3',
        },
      },
      touchpoints: [
        {
          kind: 'named-module-binding',
          modules: ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm/brand'],
          symbol: 'CallId',
          syntax: ['direct-named-import', 'direct-named-export'],
        },
      ],
      action: {
        kind: 'rename-public-symbol',
        summary: 'Replace the imported or re-exported CallId binding with ToolCallId from the same public module; preserve a local alias only when downstream source still needs the old local name.',
        from: 'CallId',
        to: 'ToolCallId',
      },
      evidence: [
        {
          package: '@deepseek-ai/dsh-llm',
          version: '0.1.1-rc.2',
          coordinate: 'lib/types/brand.d.ts#CallId and root re-export',
        },
        {
          package: '@deepseek-ai/dsh-llm',
          version: '0.1.2-alpha.3',
          coordinate: 'lib/types/brand.d.ts#ToolCallId and root re-export',
        },
      ],
    },
  ],
})

export const SOURCE_MIGRATION_LEDGER_DIGEST = 'sha256:' + createHash('sha256')
  .update(JSON.stringify(stableValue(SOURCE_MIGRATION_LEDGER_V1)), 'utf8')
  .digest('hex')
