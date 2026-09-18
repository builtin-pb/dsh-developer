import type { Context, Events } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'

// Service and event contracts belong to DSH; these aliases select our usage.
export type NativeContext = Pick<Context, 'get' | 'agents' | 'tools' | 'on' | 'effect'>
export type UiContext = Pick<Context, 'tools' | 'effect' | 'logger'>
export type ToolLookup = Pick<Context['tools'], 'get'>
export type ToolLookupSource = ToolLookup | { tools: ToolLookup }
export type AuthoritySources = {
  sandboxPolicy: () => Context['sandboxPolicy'] | undefined
  approval: () => Context['approval'] | undefined
}
export type NativeDependencies = {
  authoritySources: AuthoritySources
  agents: Pick<Context['agents'], 'roots'>
  tools: Pick<Context['tools'], 'register' | 'guard' | 'schemas' | 'get'>
  onToolsPreExecute: (listener: Events['tools/pre-execute']) => ReturnType<Context['on']>
  onToolsResult: (listener: Events['tools/result']) => ReturnType<Context['on']>
  effect: Context['effect']
}
export type UiDependencies = {
  tools: Pick<Context['tools'], 'register'>
  effect: Context['effect']
  onConfigurationError?: (diagnostic: { code: string; message: string; nextStep: string }) => void
}

// The following are plugin-owned data, not copies of upstream interfaces.
export type CellPlanFields = {
  outcome: string
  commands: ReadonlyArray<Readonly<{ command: string; timeoutMs: number }>>
}
export type NativeInput =
  | { operation: 'project'; source?: string }
  | { operation: 'knowledge'; source?: string; topic?: string; packageName?: string; consumerRoot?: string }
  | { operation: 'session'; source: string; limit?: number }
  | { operation: 'authority' }
  | { operation: 'capabilities' }
  | { operation: 'delegation' }
  | { operation: 'ui' }
  | { operation: 'doctor'; source: string; skipRuntime?: boolean }
  | { operation: 'hook-doctor'; source: string; dialect: 'codex' | 'claude-code' }
  | { operation: 'preflight'; source: string; profile?: string }
  | { operation: 'impact'; source: string; releaseDsh?: string; previewDsh: string }
  | { operation: 'compatibility'; source: string; releaseDsh?: string; previewDsh: string }
  | ({ operation: 'cell-plan' } & CellPlanFields)
  | { operation: 'cell-run'; planDigest: string }
  | { operation: 'cell-apply'; planDigest: string }
  | { operation: 'cell-discard'; planDigest: string }
export type NativeOperation = NativeInput['operation']
export type OperationOptions = Pick<ToolRunContext, 'signal' | 'agent' | 'callId' | 'parent'> & {
  executionToken: ToolRunContext['token']
}
export type OperationExecutor = (input: NativeInput, options: OperationOptions) => Promise<unknown>
export type NativeEnvelope = {
  operation: NativeOperation
  ok: boolean
  report: Record<string, unknown>
}
export type CellWorkflow = ReturnType<typeof import('./native-cell-workflow.js').createNativeCellWorkflowController>
// UI input validation stays in UiCliController.execute, before browser effects.
export type UiController = {
  execute(sessionId: string, input: unknown, options: Pick<ToolRunContext, 'signal'>): Promise<unknown>
  disposeOwner(sessionId: string): void | Promise<void>
}
