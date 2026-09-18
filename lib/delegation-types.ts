import type { Context, Disposable, Events } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-cmdline'
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'

// Dependency seams retain the upstream methods and event signatures. These
// imports also load service augmentations without loading DSH at runtime.
export interface AuthoritySources {
  sandboxPolicy?: () => SandboxPolicyService | undefined
  approval?: () => ApprovalService | undefined
}

type Subscribe<K extends keyof Events> = (listener: Events[K]) => ReturnType<Context['on']>

export interface AuthoritySafetyDependencies {
  authoritySources?: AuthoritySources
  agents: Pick<AgentRegistry, 'list'>
  tools: Pick<ToolRuntime, 'get'>
  logger?: Pick<Context['logger'], 'warn'>
  events: {
    agentCreated: Subscribe<'agent/created'>
    agentDisposed: Subscribe<'agent/disposed'>
    sessionEvent: Subscribe<'session/event'>
    toolsChange: Subscribe<'tools/change'>
  }
  effect: (factory: () => Disposable<void>, description?: string) => Disposable<Promise<void>>
}

export interface ProbeDependencies {
  agents: Pick<AgentRegistry, 'create'>
  tools: Pick<ToolRuntime, 'get' | 'schemas' | 'execute'>
  authoritySources: AuthoritySources
  resolveAgentPresets: () => AgentPresets | undefined
  resolvePermissionPresets: () => PermissionPresetService | undefined
}

export interface ProbeRegistration {
  injectProbeServices: (callback: Parameters<Context['inject']>[1]) => ReturnType<Context['inject']>
}

export interface ProbeConfiguration {
  token: string
  home: string
}

export type AgentSession = Agent['session']
export type SafetyReport = ReturnType<typeof import('./delegation-safety.js').inspectDelegationSafety>
