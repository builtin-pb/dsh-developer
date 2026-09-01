import type { CallId as LegacyCallId, MessageId } from '@deepseek-ai/dsh-llm'
export type { CallId } from '@deepseek-ai/dsh-llm/brand'

export interface LegacyCall {
  id: LegacyCallId
  messageId: MessageId
}
