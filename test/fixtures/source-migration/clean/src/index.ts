import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { CallId } from 'fixture-owned-types'

// import type { CallId } from '@deepseek-ai/dsh-llm'
const documentation = "import('@deepseek-ai/dsh-client-runtime/client')"
const example = /import type { CallId } from "@deepseek-ai\/dsh-llm"/
const loader = {
  import: (_specifier: string) => undefined,
  require: (_specifier: string) => undefined,
}
loader.import('@deepseek-ai/dsh-client-runtime/client')
loader.require('@deepseek-ai/dsh-client-runtime/client')

export interface PersistedEvent {
  ignorable?: boolean
  id: ToolCallId | CallId
  documentation: typeof documentation
  example: typeof example
}
