import { DshDeveloperError } from './errors.js'

const VALUE_OPTIONS = new Set([
  '--source',
  '--output',
  '--dsh',
  '--release-dsh',
  '--preview-dsh',
  '--profile',
  '--wsl-distro',
])
const FLAG_OPTIONS = new Set(['--json', '--skip-runtime', '--help', '-h'])
const COMMAND_OPTION_KEYS = new Map([
  ['admit-cell', new Set(['dsh', 'wslDistro', 'json'])],
  ['capabilities', new Set(['dsh', 'json'])],
  ['compatibility', new Set(['source', 'releaseDsh', 'previewDsh', 'json'])],
  ['doctor', new Set(['source', 'dsh', 'skipRuntime', 'json'])],
  ['fingerprint', new Set(['source', 'json'])],
  ['impact', new Set(['source', 'releaseDsh', 'previewDsh', 'json'])],
  ['lab', new Set(['wslDistro', 'json'])],
  ['preflight', new Set(['source', 'profile', 'dsh', 'json'])],
  ['promote', new Set(['source', 'output', 'dsh', 'json'])],
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
    if (VALUE_OPTIONS.has(token)) {
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
