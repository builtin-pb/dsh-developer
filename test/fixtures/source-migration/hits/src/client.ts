import type {
  ClientContext as BrowserContext,
  CommandRowProps,
  ConversationNode,
  SessionId,
  SessionRuntime,
} from '@deepseek-ai/dsh-client-runtime/client'

export type ClientFacts = {
  context: BrowserContext
  command: CommandRowProps
  node: ConversationNode
  sessionId: SessionId
  runtime: SessionRuntime
}
