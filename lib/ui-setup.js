import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, win32, posix } from 'node:path'
import { DshDeveloperError } from './errors.js'
import { runBounded, secretFreeEnvironment } from './runtime.js'
import {
  PLAYWRIGHT_CLI_CONTRACT_VERSION, UI_CLI_ENVIRONMENT, UI_SETUP_INSTRUCTION,
  ordinaryUiFile, privateUiDirectory, readUiSettings, saveUiSettings, uiConfigPath, validateUiEntry,
} from './ui-configuration.js'

// Only conventional installation roots; never PATH, cwd, project node_modules or a recursive scan.
export function uiDiscoveryCandidates({ platform = process.platform, environment = process.env,
  home = homedir(), executable = process.execPath, configPath = uiConfigPath(environment) } = {}) {
  const windowsEnvironment = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key.toUpperCase(), value]))
  const path = platform === 'win32' ? win32 : posix
  const nodeDirectory = path.dirname(executable)
  const roots = [path.join(path.dirname(configPath), 'provider', 'node_modules'),
    path.join(nodeDirectory, 'node_modules'), path.join(nodeDirectory, '..', 'lib', 'node_modules')]
  if (platform === 'win32' && windowsEnvironment.APPDATA && path.isAbsolute(windowsEnvironment.APPDATA)) {
    roots.push(path.join(windowsEnvironment.APPDATA, 'npm', 'node_modules'))
  }
  if (platform !== 'win32') roots.push('/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules', '/usr/lib/node_modules')
  let browsers = []
  if (platform === 'darwin') browsers = ['/Applications', path.join(home, 'Applications')].flatMap(root => [
    path.join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    path.join(root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
  ])
  if (platform === 'win32') browsers = [windowsEnvironment.PROGRAMFILES, windowsEnvironment['PROGRAMFILES(X86)'], windowsEnvironment.LOCALAPPDATA]
    .filter(root => typeof root === 'string' && path.isAbsolute(root)).flatMap(root => [
      path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ])
  if (platform === 'linux') browsers = ['/opt/google/chrome/chrome', '/opt/microsoft/msedge/msedge',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
  return { entries: [...new Set(roots.map(root => path.join(root, '@playwright', 'cli', 'playwright-cli.js')))], browsers }
}

async function discover(paths, validate) {
  for (const path of paths) {
    try { return await validate(await realpath(path)) } catch { /* A candidate is evidence only after static validation. */ }
  }
  return undefined
}

export async function installUiCli(configPath, { signal, runner = runBounded, executable = process.execPath } = {}) {
  // npm comes from the running Node installation, never an arbitrary PATH candidate.
  const nodeDirectory = dirname(executable)
  const npm = await discover([join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')], async path => {
    const entry = await ordinaryUiFile(path, 'UI_SETUP_NPM_MISSING', 'The npm CLI')
    const packagePath = join(dirname(dirname(entry)), 'package.json')
    const info = await lstat(packagePath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('Invalid npm manifest')
    const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
    if (manifest.name !== 'npm') throw new Error('Not npm')
    return entry
  })
  if (!npm) throw new DshDeveloperError('UI_SETUP_NPM_MISSING', 'Install npm alongside the running Node, then rerun dsh-developer ui-setup --install-cli; the required package is @playwright/cli@0.1.18.')
  const root = join(dirname(configPath), 'provider')
  await privateUiDirectory(dirname(configPath))
  // An explicit install owns only this dedicated prefix, including npm cache/config/home.
  const prior = await lstat(root).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (prior) throw new DshDeveloperError('UI_SETUP_INSTALL_FAILED', 'Dedicated provider storage already exists but has no usable pinned CLI. Preserve or remove that setup storage explicitly, or use --cli-entry with an installed @playwright/cli@0.1.18.')
  await mkdir(root, { mode: 0o700 })
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-developer-browser-provider', private: true, version: '1.0.0' }), { flag: 'wx', mode: 0o600 })
    const userConfig = join(root, 'user.npmrc')
    const globalConfig = join(root, 'global.npmrc')
    await writeFile(userConfig, '', { flag: 'wx', mode: 0o600 })
    await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 })
    const home = await privateUiDirectory(join(root, 'home'))
    await runner(executable, [npm, 'install', '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund',
      '--save-exact', '--registry=https://registry.npmjs.org/', '--cache', join(root, 'cache'),
      '--userconfig', userConfig, '--globalconfig', globalConfig, '@playwright/cli@' + PLAYWRIGHT_CLI_CONTRACT_VERSION], {
      cwd: root, env: secretFreeEnvironment({ HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }), signal, timeoutMs: 120_000, outputLimit: 128 * 1024,
      label: 'pinned UI provider installation',
    })
    return await validateUiEntry(join(root, 'node_modules', '@playwright', 'cli', 'playwright-cli.js'))
  } catch (error) {
    // mkdir above acquired a fresh prefix; runBounded settles/terminates its child before rejecting.
    try { await rm(root, { recursive: true, force: true }) } catch {
      throw new DshDeveloperError('UI_SETUP_INSTALL_FAILED', 'UI installation failed and its fresh provider storage could not be removed. Preserve or remove that dedicated storage explicitly before retrying; configuration was not saved.')
    }
    if (error.code === 'CANCELLED') throw new DshDeveloperError('CANCELLED', 'UI provider installation cancelled; configuration was not saved.')
    throw new DshDeveloperError('UI_SETUP_INSTALL_FAILED', 'Could not install @playwright/cli@0.1.18 into dedicated setup storage; configuration was not saved. Fresh provider storage was removed. Check npm/network availability, then retry dsh-developer ui-setup --install-cli.')
  }
}

async function setupUiInternal(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['cliEntry', 'browserExecutable', 'config', 'installCli', 'signal'].includes(key))
      || (options.installCli !== undefined && typeof options.installCli !== 'boolean')) {
    throw new DshDeveloperError('UI_OPTIONS_INVALID', 'UI setup accepts only cliEntry, browserExecutable, config, installCli and signal.')
  }
  for (const key of ['cliEntry', 'browserExecutable', 'config']) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || !isAbsolute(options[key]) || options[key].includes('\0'))) {
      throw new DshDeveloperError('UI_OPTIONS_INVALID', 'UI setup path overrides must be absolute strings.')
    }
  }
  if (options.signal?.aborted) throw new DshDeveloperError('CANCELLED', 'UI setup cancelled before start.')
  const environment = { ...process.env }
  if (options.config !== undefined) environment[UI_CLI_ENVIRONMENT.config] = options.config
  const configPath = uiConfigPath(environment)
  const saved = await readUiSettings(environment, { repair: true })
  const candidates = uiDiscoveryCandidates({ environment, configPath })
  const explicitEntry = options.cliEntry ?? environment[UI_CLI_ENVIRONMENT.entry]?.trim()
  const explicitBrowser = options.browserExecutable ?? environment[UI_CLI_ENVIRONMENT.browser]?.trim()
  const validateBrowser = path => ordinaryUiFile(path, 'UI_BROWSER_INVALID', 'The browser executable')
  const browser = explicitBrowser ? await validateBrowser(explicitBrowser)
    : await discover([...(saved ? [saved.browser] : []), ...candidates.browsers], validateBrowser)
  if (!browser) throw new DshDeveloperError('UI_BROWSER_INVALID', 'No installed Chrome or Edge was found in normal locations. Install one, then rerun dsh-developer ui-setup, or supply --browser-executable with its absolute executable path.')
  const root = environment[UI_CLI_ENVIRONMENT.root]?.trim() || saved?.root || join(dirname(configPath), 'runtime')
  if (!isAbsolute(root)) throw new DshDeveloperError('UI_ROOT_INVALID', 'DSH_DEVELOPER_UI_CLI_ROOT must be absolute when set.')
  let entry = explicitEntry ? await validateUiEntry(explicitEntry)
    : await discover([...(saved ? [saved.entry] : []), ...candidates.entries], validateUiEntry)
  if (!entry && options.installCli) entry = await installUiCli(configPath, { signal: options.signal })
  if (!entry) throw new DshDeveloperError('UI_CLI_NOT_CONFIGURED', 'No installed @playwright/cli@0.1.18 was found. ' + UI_SETUP_INSTRUCTION)
  if (options.signal?.aborted) throw new DshDeveloperError('CANCELLED', 'UI setup cancelled; configuration was not saved.')
  await saveUiSettings(configPath, { entry, browser, root })
  // Paths and package-manager output deliberately stay out of the public report.
  return { kind: 'ui-setup', ok: true, provider: '@playwright/cli', providerVersion: PLAYWRIGHT_CLI_CONTRACT_VERSION,
    configuration: 'saved', restartRequired: true, browserLaunched: false,
    nextStep: 'Restart DSH, then run dsh_developer {"operation":"ui"}. Shell ui commands can use the saved configuration immediately. If --config was used, set DSH_DEVELOPER_UI_CONFIG to that same absolute file for both routes.' }
}

export async function setupUi(options = {}) {
  try { return await setupUiInternal(options) } catch (error) {
    if (error instanceof DshDeveloperError) throw error
    throw new DshDeveloperError('UI_CONFIG_INVALID', 'Could not read or save private UI setup storage. Check file access or select another absolute --config file.')
  }
}

export function formatUiSetupReport(report) {
  return 'PASS UI setup: ' + report.provider + '@' + report.providerVersion + '\n' + report.nextStep
}
