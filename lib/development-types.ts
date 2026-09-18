import type { Context } from '@deepseek-ai/cordis'

export type { Context }

// Cordis injection requires appExit before the verification plugin activates.
export type VerificationContext = Context & Required<Pick<Context, 'appExit'>>

// Private file/receipt formats owned by this development harness, not DSH APIs.
export interface ToolCase {
  name?: string
  tool: string
  arguments: Record<string, unknown>
  expected?: unknown
  isError?: boolean
  errorContains?: string
  resultPath?: string
  maxResultBytes?: number
}

export interface CaseReceiptFields {
  value: unknown
  expected: unknown
  resultPath: string
  errorContains: string
  content: import('@deepseek-ai/dsh-tools').ToolExecutionResult['content']
}

export type CaseReceipt = Partial<CaseReceiptFields>
  & Partial<Record<`${keyof CaseReceiptFields}Omitted`, true>> & {
    index: number
    name?: string
    tool: string
    passed: boolean
    failures: string[]
    isError: boolean
    privateKeyOutput?: true
    valueBytes: number
    contentBytes: number
    resultBytes: number
    maxResultBytes?: number
    outputLimitExceeded?: boolean
  }

export type ActiveCase = Pick<CaseReceipt, 'index' | 'name' | 'tool'>
export interface AgentReceipt {
  id: import('@deepseek-ai/dsh-agent').Agent['id']
  preset: import('@deepseek-ai/dsh-agent-presets').AgentPreset['id'] | null
}

export interface ReloadReceipt {
  sequence: number
  attempt: number
  warnings: number
  status: 'settled' | 'pending' | 'warning' | 'failed'
  active: number
  inactive: number
}

export type ServerObservation = {
  error: string
  privateKeyOutput?: true
} | {
  host: Context['webServer']['host']
  port: Context['webServer']['port']
  url: string
  pid: number
  workspace: Pick<import('@deepseek-ai/dsh-workspace').Workspace, 'id' | 'path'>
}
