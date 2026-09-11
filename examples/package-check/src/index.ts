import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { checkPackageVersion } from './check.js'

export const name = 'dsh-package-check'
export const inject = ['tools']

export const checkPackageVersionTool = {
  name: 'check_package_version',
  description: 'Check whether a package version satisfies an npm semver range. A mismatch returns satisfies: false; malformed input is a tool error. Prereleases follow npm rules unless includePrerelease is true.',
  parameters: {
    type: 'object',
    properties: {
      version: { type: 'string', description: 'Complete version, for example 0.1.1-rc.2.' },
      range: { type: 'string', description: 'npm semver range, for example >=0.1.1-rc.2 <0.2.0. An empty range means *.' },
      includePrerelease: { type: 'boolean', description: 'Include prereleases when comparing ranges. Defaults to false.' },
    },
    required: ['version', 'range'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        version: { type: 'string' },
        range: { type: 'string' },
        includePrerelease: { type: 'boolean' },
        satisfies: { type: 'boolean' },
      },
      required: ['version', 'range', 'includePrerelease', 'satisfies'],
      additionalProperties: false,
    },
    render(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value) }]
    },
  },
  isConcurrencySafe: () => true,
  async execute(args: unknown) {
    return checkPackageVersion(args)
  },
} satisfies ToolDefinition

export function apply(ctx: Context): void {
  ctx.tools.register(checkPackageVersionTool)
}
