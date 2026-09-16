import { DshDeveloperError } from './errors.js'

const VALUE_OPTIONS = new Set([
  '--cli-entry',
  '--browser-executable',
  '--config',
  '--source',
  '--output',
  '--dsh',
  '--release-dsh',
  '--preview-dsh',
  '--from-dsh',
  '--to-dsh',
  '--profile',
  '--wsl-distro',
  '--action',
  '--session',
  '--url',
  '--development-server',
  '--target',
  '--text',
  '--key',
  '--depth',
  '--timeout-ms',
  '--width',
  '--height',
  '--dialect',
  '--script',
  '--cases',
  '--patch',
  '--port',
  '--topic',
  '--upstream',
  '--limit',
  '--package',
  '--consumer-root',
  '--workspace',
])
const FLAG_OPTIONS = new Set(['--install-cli', '--json', '--skip-runtime', '--online', '--watch', '--help', '-h'])
const COMMAND_OPTION_KEYS = new Map([
  ['project', new Set(['source', 'json'])],
  ['knowledge', new Set(['dsh', 'upstream', 'topic', 'package', 'consumerRoot', 'json'])],
  ['session', new Set(['source', 'limit', 'json'])],
  ['run', new Set(['source', 'script', 'scriptArgs', 'timeoutMs', 'json'])],
  ['verify', new Set(['source', 'cases', 'patch', 'dsh', 'profile', 'workspace', 'online', 'timeoutMs', 'json'])],
  ['dev', new Set(['source', 'patch', 'dsh', 'port', 'watch', 'workspace', 'online', 'timeoutMs', 'json'])],
  ['admit-cell', new Set(['dsh', 'wslDistro', 'json'])],
  ['attest-profile', new Set(['profile', 'dsh', 'json'])],
  ['capabilities', new Set(['dsh', 'json'])],
  ['compatibility', new Set(['source', 'releaseDsh', 'previewDsh', 'json'])],
  ['doctor', new Set(['source', 'dsh', 'skipRuntime', 'json'])],
  ['fingerprint', new Set(['source', 'json'])],
  ['hook-doctor', new Set(['source', 'dialect', 'dsh', 'json'])],
  ['impact', new Set(['source', 'releaseDsh', 'previewDsh', 'json'])],
  ['migration', new Set(['source', 'fromDsh', 'toDsh', 'json'])],
  ['lab', new Set(['wslDistro', 'json'])],
  ['preflight', new Set(['source', 'profile', 'dsh', 'json'])],
  ['promote', new Set(['source', 'output', 'dsh', 'json'])],
  ['ui-setup', new Set(['cliEntry', 'browserExecutable', 'config', 'installCli', 'json'])],
  ['ui', new Set([
    'action',
    'session',
    'url',
    'developmentServer',
    'target',
    'text',
    'key',
    'depth',
    'timeoutMs',
    'width',
    'height',
    'json',
  ])],
])

function keyFor(token) {
  return token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
}

export function parseCliArguments(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') return { command: 'help', options: { help: true } }
  const command = argv[0]
  const options = {}
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') {
      if (command !== 'run') throw new DshDeveloperError('CLI_USAGE', 'Only run accepts script arguments after --.')
      options.scriptArgs = argv.slice(index + 1)
      break
    }
    if (VALUE_OPTIONS.has(token)) {
      if (token === '--patch' && Object.hasOwn(options, 'patch')) {
        throw new DshDeveloperError('CLI_USAGE', '--patch accepts one file; combine overlays in one Cordis patch file.')
      }
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new DshDeveloperError('CLI_USAGE', token + ' requires a value.')
      }
      options[keyFor(token)] = value
      index += 1
      continue
    }
    if (FLAG_OPTIONS.has(token)) {
      const key = token === '-h' ? 'help' : keyFor(token)
      options[key] = true
      continue
    }
    throw new DshDeveloperError('CLI_USAGE', 'Unknown option "' + token + '".')
  }
  return { command, options }
}

export function assertCliCommandOptions(command, options) {
  const allowed = COMMAND_OPTION_KEYS.get(command)
  if (!allowed) return
  for (const key of Object.keys(options)) {
    if (allowed.has(key)) continue
    const option = '--' + key.replace(/[A-Z]/gu, (letter) => '-' + letter.toLowerCase())
    throw new DshDeveloperError('CLI_USAGE', command + ' does not accept ' + option + '.')
  }
}
