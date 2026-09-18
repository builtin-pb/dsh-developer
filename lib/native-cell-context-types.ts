import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'

// Physical workspace evidence belongs to this controller; live Agent metadata
// is read only by the checked adapter that produces it.
export interface WorkspacePathEntry {
  path: string
  dev: string
  ino: string
}

export interface WorkspaceInspectionOptions {
  isRootAgent?: (agent: Agent) => boolean
  signal?: ToolExecution['signal']
}

export interface WorkspaceInspectionDependencies {
  snapshotPath(path: string, signal?: ToolExecution['signal']): Promise<WorkspacePathEntry[]>
  samePathSnapshot(left: WorkspacePathEntry[], right: WorkspacePathEntry[]): boolean
  digest(value: unknown): string
  freeze<T>(value: T): T
}

export interface CellApprovalInput {
  operation: 'cell-run' | 'cell-apply'
  planDigest: string
}

export type PreparedCellApproval = Extract<PreToolDecision, { kind: 'deny' }>
  | (Extract<PreToolDecision, { kind: 'ask' }> & { digest: string; evidenceDigest?: string })

export interface CellApprovalDependencies {
  assertController(): void
  prepare(
    input: CellApprovalInput,
    owner: ToolExecution['agent'],
    signal: ToolExecution['signal'],
  ): Promise<PreparedCellApproval>
  diagnostic(cause: unknown): { code: string; message: string }
}

export interface CellApprovalProof {
  owner: ToolExecution['agent']
  callId: ToolExecution['callId']
  operation: CellApprovalInput['operation']
  digest: string
  evidenceDigest?: string
}

// The native tool forwards these upstream fields, renaming only the token.
// Missing fields are retained as a runtime rejection case for direct callers.
export type CellApprovalCall = Partial<Pick<ToolRunContext, 'agent' | 'callId'>> & {
  executionToken?: ToolRunContext['token']
}
