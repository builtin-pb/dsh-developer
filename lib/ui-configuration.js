import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DshDeveloperError } from './errors.js'

export const PLAYWRIGHT_CLI_CONTRACT_VERSION = '0.1.18'
export const UI_CLI_ENVIRONMENT = Object.freeze({
  entry: 'DSH_DEVELOPER_PLAYWRIGHT_CLI_ENTRY',
  browser: 'DSH_DEVELOPER_BROWSER_EXECUTABLE',
  root: 'DSH_DEVELOPER_UI_CLI_ROOT',
  config: 'DSH_DEVELOPER_UI_CONFIG',
})
export const UI_SETUP_INSTRUCTION = 'Run dsh-developer ui-setup (use --install-cli to install @playwright/cli@0.1.18 explicitly), then restart DSH and rerun dsh_developer {"operation":"ui"}.'

function fail(code, message) { throw new DshDeveloperError(code, message) }
export function uiConfigPath(environment = process.env) {
  const configured = environment[UI_CLI_ENVIRONMENT.config]?.trim()
  if (configured && !isAbsolute(configured)) fail('UI_CONFIG_INVALID', 'DSH_DEVELOPER_UI_CONFIG must be absolute.')
  return configured || join(homedir(), '.dsh-developer', 'ui', 'config.json')
}
export function uiCliConfigurationRequested(environment = process.env) {
  return ['entry', 'browser', 'root'].some(key => Boolean(environment[UI_CLI_ENVIRONMENT[key]]?.trim()))
}

export async function readUiSettings(environment = process.env, { repair = false } = {}) {
  const path = uiConfigPath(environment)
  let info
  try { info = await lstat(path) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    fail('UI_CONFIG_INVALID', 'Cannot read saved UI configuration. ' + UI_SETUP_INSTRUCTION)
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || (process.platform !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    fail('UI_CONFIG_INVALID', 'Saved UI configuration must be a bounded ordinary file. ' + UI_SETUP_INSTRUCTION)
  }
  if (info.size > 8192) {
    if (repair) return undefined
    fail('UI_CONFIG_INVALID', 'Saved UI configuration exceeds its size bound. ' + UI_SETUP_INSTRUCTION)
  }
  let value
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch {
    if (repair) return undefined
    fail('UI_CONFIG_INVALID', 'Saved UI configuration is not valid JSON. ' + UI_SETUP_INSTRUCTION)
  }
  if (!value || Array.isArray(value) || value.version !== 1
      || Object.keys(value).some(key => !['version', 'entry', 'browser', 'root'].includes(key))
      || ['entry', 'browser', 'root'].some(key => typeof value[key] !== 'string' || !isAbsolute(value[key]))) {
    if (repair) return undefined
    fail('UI_CONFIG_INVALID', 'Saved UI configuration has an unsupported shape. ' + UI_SETUP_INSTRUCTION)
  }
  return value
}

export async function uiCliConfigurationAvailable(environment = process.env) {
  return uiCliConfigurationRequested(environment) || (await readUiSettings(environment)) !== undefined
}

export async function ordinaryUiFile(path, code, label) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) fail(code, label + ' must be an absolute path.')
  const info = await lstat(path).catch(() => undefined)
  if (!info?.isFile() || info.isSymbolicLink()) fail(code, label + ' must be an existing ordinary file.')
  return realpath(path)
}

export async function validateUiEntry(path) {
  if (typeof path !== 'string' || basename(path) !== 'playwright-cli.js') {
    fail('UI_CLI_ENTRY_INVALID', 'The provider entry must name @playwright/cli playwright-cli.js.')
  }
  const entry = await ordinaryUiFile(path, 'UI_CLI_ENTRY_INVALID', 'The Playwright CLI entry')
  const packagePath = join(dirname(entry), 'package.json')
  const info = await lstat(packagePath).catch(() => undefined)
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) {
    fail('UI_CLI_PACKAGE_INVALID', 'The Playwright CLI entry has no bounded ordinary adjacent package.json.')
  }
  let manifest
  try { manifest = JSON.parse(await readFile(packagePath, 'utf8')) } catch {
    fail('UI_CLI_PACKAGE_INVALID', 'The Playwright CLI package.json is not valid JSON.')
  }
  if (manifest?.name !== '@playwright/cli' || manifest.version !== PLAYWRIGHT_CLI_CONTRACT_VERSION) {
    fail('UI_CLI_VERSION_MISMATCH', 'The configured provider must be @playwright/cli ' + PLAYWRIGHT_CLI_CONTRACT_VERSION + '.')
  }
  return entry
}

export async function loadUiConfiguration(environment = process.env) {
  // Complete explicit environment configuration remains independent of saved state.
  const saved = environment[UI_CLI_ENVIRONMENT.entry]?.trim() && environment[UI_CLI_ENVIRONMENT.browser]?.trim()
    ? undefined : await readUiSettings(environment)
  const values = Object.fromEntries(['entry', 'browser', 'root'].map(key => [key,
    environment[UI_CLI_ENVIRONMENT[key]]?.trim() || saved?.[key]]))
  if (!values.entry || !values.browser) fail('UI_CLI_NOT_CONFIGURED', 'UI configuration is missing or partial. ' + UI_SETUP_INSTRUCTION)
  const entry = await validateUiEntry(values.entry)
  const browser = await ordinaryUiFile(values.browser, 'UI_BROWSER_INVALID', 'The browser executable')
  if (values.root && !isAbsolute(values.root)) fail('UI_ROOT_INVALID', 'DSH_DEVELOPER_UI_CLI_ROOT must be absolute when set.')
  return { entry, browser, root: resolve(values.root || join(tmpdir(), 'dsh-developer-ui-cli')),
    provider: '@playwright/cli', providerVersion: PLAYWRIGHT_CLI_CONTRACT_VERSION }
}

export async function privateUiDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) fail('UI_CONFIG_INVALID', 'UI setup storage must be an ordinary directory.')
  return realpath(path)
}

export async function saveUiSettings(path, settings) {
  await privateUiDirectory(dirname(path))
  const existing = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1
      || (process.platform !== 'win32' && typeof process.getuid === 'function' && existing.uid !== process.getuid()))) {
    fail('UI_CONFIG_INVALID', 'Refusing to replace a non-ordinary UI configuration file.')
  }
  const temporary = join(dirname(path), '.ui-config-' + randomBytes(12).toString('hex'))
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify({ version: 1, ...settings }) + '\n'); await handle.sync() } finally { await handle.close() }
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}
