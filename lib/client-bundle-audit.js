import { builtinModules } from 'node:module'
import { posix } from 'node:path'
import { Script } from 'node:vm'
import { DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET } from './constants.js'
import { DshDeveloperError } from './errors.js'

const CLIENT_RELEASE_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

const CLIENT_PREVIEW_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

const CORE_CLIENT_SERVICE_OWNERS = Object.freeze(Object.fromEntries(Object.entries({
  chatFileMentions: { release: '@deepseek-ai/dsh-client-ui-deliverables', preview: '@deepseek-ai/dsh-client-ui-deliverables' },
  commandUi: { release: '@deepseek-ai/dsh-client-ui-commands', preview: '@deepseek-ai/dsh-client-ui-commands' },
  connection: { release: '@deepseek-ai/dsh-client-connection', preview: '@deepseek-ai/dsh-client-connection' },
  conversation: { release: '@deepseek-ai/dsh-client-ui-conversation', preview: '@deepseek-ai/dsh-client-ui-conversation' },
  conversationEvents: { release: '@deepseek-ai/dsh-client-runtime' },
  conversationViews: { release: '@deepseek-ai/dsh-client-runtime' },
  cordisInspect: { release: '@deepseek-ai/dsh-cordis-client-runner', preview: '@deepseek-ai/dsh-cordis-client-runner' },
  dynamicCordisRunner: { release: '@deepseek-ai/dsh-cordis-client-runner', preview: '@deepseek-ai/dsh-cordis-client-runner' },
  inputTriggers: { release: '@deepseek-ai/dsh-client-ui-input-trigger', preview: '@deepseek-ai/dsh-client-ui-input-trigger' },
  layout: { release: '@deepseek-ai/dsh-client-ui-layout', preview: '@deepseek-ai/dsh-client-ui-layout' },
  locale: { release: '@deepseek-ai/dsh-client-locale', preview: '@deepseek-ai/dsh-client-locale' },
  modelDirectories: { release: '@deepseek-ai/dsh-client-ui-model-selection', preview: '@deepseek-ai/dsh-client-ui-model-selection' },
  modules: { release: '@deepseek-ai/dsh-client-modules', preview: '@deepseek-ai/dsh-client-modules' },
  remote: { release: '@deepseek-ai/dsh-api-gateway', preview: '@deepseek-ai/dsh-api-gateway' },
  sessionLogDownload: { release: '@deepseek-ai/dsh-session-log-export', preview: '@deepseek-ai/dsh-session-log-export' },
  sessions: { release: '@deepseek-ai/dsh-client-runtime', preview: '@deepseek-ai/dsh-api-session-controller' },
  settingsSchema: { release: '@deepseek-ai/dsh-client-ui-settings', preview: '@deepseek-ai/dsh-client-ui-settings' },
  settingsScope: { release: '@deepseek-ai/dsh-client-ui-settings', preview: '@deepseek-ai/dsh-client-ui-settings' },
  slots: { release: '@deepseek-ai/dsh-client-runtime', preview: '@deepseek-ai/dsh-client-ui-renderer' },
  theme: { release: '@deepseek-ai/dsh-client-ui-theme', preview: '@deepseek-ai/dsh-client-ui-theme' },
  timer: { release: '@deepseek-ai/dsh-cordis-client-runner', preview: '@deepseek-ai/dsh-cordis-client-runner' },
  typert: { release: '@deepseek-ai/dsh-typert-registry', preview: '@deepseek-ai/dsh-typert-registry' },
  uiConversation: { preview: '@deepseek-ai/dsh-client-ui-conversation' },
  uiRenderer: { release: '@deepseek-ai/dsh-client-ui-renderer', preview: '@deepseek-ai/dsh-client-ui-renderer' },
  uiSession: { preview: '@deepseek-ai/dsh-client-ui-session' },
  uiWorkspace: { preview: '@deepseek-ai/dsh-client-ui-workspace' },
  workspaces: { release: '@deepseek-ai/dsh-client-runtime', preview: '@deepseek-ai/dsh-api-workspace-controller' },
}).map(([service, owners]) => [service, Object.freeze(owners)])))

const NODE_BUILTINS = new Set(builtinModules.flatMap((value) => [
  value,
  value.startsWith('node:') ? value.slice('node:'.length) : 'node:' + value,
]))

function fail(code, message, details = {}) {
  throw new DshDeveloperError(code, message, details)
}

function optionalStringArray(packageName, field, value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail('INVALID_DSH_CLIENT', packageName + ' ' + field + ' must be an array of non-empty strings.', { field })
  }
  return [...value]
}

function clientExportOf(packageName, exportsField) {
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
    fail('CLIENT_EXPORT_MISSING', packageName + ' declares dsh.client but exports no "./client" bundle.')
  }
  const declaration = exportsField['./client']
  if (typeof declaration === 'string') return declaration
  if (declaration !== null && typeof declaration === 'object' && !Array.isArray(declaration)) {
    if (typeof declaration.default === 'string') return declaration.default
  }
  fail(
    'CLIENT_EXPORT_INVALID',
    packageName + ' exports["./client"] must be a string or an object with a string default.',
  )
}

function portableClientPath(packageName, target) {
  if (!target.startsWith('./') || target.includes('\\') || target.includes('\0')) {
    fail('CLIENT_EXPORT_INVALID', packageName + ' client export must be one portable package-relative path.', { target })
  }
  const relative = target.slice(2)
  const normalized = posix.normalize(relative)
  if (relative.length === 0 || normalized !== relative || normalized === '..' || normalized.startsWith('../')) {
    fail('CLIENT_EXPORT_INVALID', packageName + ' client export escapes or aliases its package path.', { target })
  }
  return normalized
}

function identifierCharacter(value) {
  return value !== undefined && /[A-Za-z0-9_$]/u.test(value)
}

function skipWhitespace(source, start) {
  let index = start
  while (/\s/u.test(source[index] ?? '')) index += 1
  return index
}

function previousNonWhitespace(source, start) {
  let index = start - 1
  while (index >= 0 && /\s/u.test(source[index])) index -= 1
  return source[index]
}

function readQuoted(source, start) {
  const quote = source[start]
  if (quote !== '"' && quote !== "'") return undefined
  let value = ''
  for (let index = start + 1; index < source.length; index += 1) {
    const current = source[index]
    if (current === quote) return { value, end: index + 1 }
    if (current === '\r' || current === '\n') return undefined
    if (current !== '\\') {
      value += current
      continue
    }
    const escaped = source[index + 1]
    if (escaped === undefined) return undefined
    index += 1
    if (escaped === '\r' || escaped === '\n') {
      if (escaped === '\r' && source[index + 1] === '\n') index += 1
      continue
    }
    const simple = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '0': '\0' }
    if (Object.hasOwn(simple, escaped)) {
      value += simple[escaped]
      continue
    }
    if (escaped === 'x') {
      const digits = source.slice(index + 1, index + 3)
      if (!/^[0-9a-f]{2}$/iu.test(digits)) return undefined
      value += String.fromCodePoint(Number.parseInt(digits, 16))
      index += 2
      continue
    }
    if (escaped === 'u') {
      if (source[index + 1] === '{') {
        const end = source.indexOf('}', index + 2)
        const digits = end < 0 ? '' : source.slice(index + 2, end)
        const point = /^[0-9a-f]{1,6}$/iu.test(digits) ? Number.parseInt(digits, 16) : -1
        if (point < 0 || point > 0x10ffff) return undefined
        value += String.fromCodePoint(point)
        index = end
        continue
      }
      const digits = source.slice(index + 1, index + 5)
      if (!/^[0-9a-f]{4}$/iu.test(digits)) return undefined
      value += String.fromCodePoint(Number.parseInt(digits, 16))
      index += 4
      continue
    }
    value += escaped
  }
  return undefined
}

function skipQuoted(source, start) {
  const quote = source[start]
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1
      continue
    }
    if (source[index] === quote) return index + 1
  }
  return source.length
}

function parseFactoryParameters(source, start) {
  let index = skipWhitespace(source, start)
  if (source[index] !== '(') return undefined
  index = skipWhitespace(source, index + 1)
  if (source[index] === ')') return index + 1
  if (!source.startsWith('require', index) || identifierCharacter(source[index + 'require'.length])) {
    return undefined
  }
  index = skipWhitespace(source, index + 'require'.length)
  if (source[index] !== ')') return undefined
  return index + 1
}

function parseFactory(source, start) {
  let index = skipWhitespace(source, start)
  if (source.startsWith('function', index) && !identifierCharacter(source[index + 'function'.length])) {
    index = skipWhitespace(source, index + 'function'.length)
    while (identifierCharacter(source[index])) index += 1
    const parametersEnd = parseFactoryParameters(source, index)
    if (parametersEnd === undefined) return undefined
    index = skipWhitespace(source, parametersEnd)
    return source[index] === '{' ? index : undefined
  }
  if (source[index] === '(') {
    const parametersEnd = parseFactoryParameters(source, index)
    if (parametersEnd === undefined) return undefined
    index = skipWhitespace(source, parametersEnd)
  } else if (source.startsWith('require', index) && !identifierCharacter(source[index + 'require'.length])) {
    index = skipWhitespace(source, index + 'require'.length)
  } else {
    return undefined
  }
  if (!source.startsWith('=>', index)) return undefined
  return index + 2
}

function parseRegistration(source, start) {
  const prefixes = [
    'window.__ModuleLoader__.load',
    'globalThis.__ModuleLoader__.load',
  ]
  const prefix = prefixes.find((value) => source.startsWith(value, start))
  if (!prefix || identifierCharacter(source[start - 1])) return undefined
  let index = skipWhitespace(source, start + prefix.length)
  if (source[index] !== '(') return undefined
  index = skipWhitespace(source, index + 1)
  if (source[index] !== '{') return undefined
  index = skipWhitespace(source, index + 1)
  if (!source.startsWith('id', index) || identifierCharacter(source[index + 2])) return undefined
  index = skipWhitespace(source, index + 2)
  if (source[index] !== ':') return undefined
  index = skipWhitespace(source, index + 1)
  const id = readQuoted(source, index)
  if (!id) return undefined
  index = skipWhitespace(source, id.end)
  if (source[index] !== ',') return undefined
  index = skipWhitespace(source, index + 1)
  if (!source.startsWith('factory', index) || identifierCharacter(source[index + 'factory'.length])) return undefined
  index = skipWhitespace(source, index + 'factory'.length)
  if (source[index] !== ':') return undefined
  const factoryEnd = parseFactory(source, index + 1)
  return factoryEnd === undefined ? undefined : { id: id.value, end: factoryEnd }
}

function parseRequire(source, start) {
  if (!source.startsWith('require', start)
      || identifierCharacter(source[start - 1])
      || identifierCharacter(source[start + 'require'.length])
      || previousNonWhitespace(source, start) === '.'
      || previousNonWhitespace(source, start) === '#') return undefined
  let index = skipWhitespace(source, start + 'require'.length)
  if (source[index] !== '(') return undefined
  index = skipWhitespace(source, index + 1)
  const request = readQuoted(source, index)
  if (!request) return { dynamic: true, end: index }
  index = skipWhitespace(source, request.end)
  if (source[index] !== ')') return { dynamic: true, end: index }
  return { request: request.value, end: index + 1 }
}

function parseProvide(source, start) {
  const prefixes = [
    'rootCtx.reflect.provide',
    'rootCtx.provide',
    'ctx.reflect.provide',
    'ctx.provide',
  ]
  const prefix = prefixes.find((value) => source.startsWith(value, start))
  if (!prefix
      || identifierCharacter(source[start - 1])
      || previousNonWhitespace(source, start) === '.') return undefined
  let index = skipWhitespace(source, start + prefix.length)
  if (source[index] !== '(') return undefined
  index = skipWhitespace(source, index + 1)
  const service = readQuoted(source, index)
  if (!service) return { dynamic: true, end: index }
  index = skipWhitespace(source, service.end)
  if (source[index] !== ',' && source[index] !== ')') return { dynamic: true, end: index }
  return { service: service.value, end: index + 1 }
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
])

function regexLiteralStart(source, start) {
  let index = start - 1
  while (index >= 0 && /\s/u.test(source[index])) index -= 1
  if (index < 0) return true
  if ('([{=,:;!?&|+-*%^~<>'.includes(source[index])) return true
  if (!identifierCharacter(source[index])) return false
  const end = index + 1
  while (index >= 0 && identifierCharacter(source[index])) index -= 1
  return REGEX_PREFIX_KEYWORDS.has(source.slice(index + 1, end))
}

function skipRegex(source, start) {
  let characterClass = false
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1
      continue
    }
    if (source[index] === '[') {
      characterClass = true
      continue
    }
    if (source[index] === ']' && characterClass) {
      characterClass = false
      continue
    }
    if (source[index] === '/' && !characterClass) {
      index += 1
      while (/[A-Za-z]/u.test(source[index] ?? '')) index += 1
      return index
    }
  }
  return source.length
}

function scanTemplate(source, start, state) {
  for (let index = start + 1; index < source.length;) {
    if (source[index] === '\\') {
      index += 2
      continue
    }
    if (source[index] === '`') return index + 1
    if (source[index] === '$' && source[index + 1] === '{') {
      index = scanCode(source, index + 2, state, { stopAtClosingBrace: true, allowRegistration: false })
      continue
    }
    index += 1
  }
  return source.length
}

function scanCode(source, start, state, options = {}) {
  let braceDepth = 0
  for (let index = start; index < source.length;) {
    const current = source[index]
    if (current === '"' || current === "'") {
      index = skipQuoted(source, index)
      continue
    }
    if (current === '`') {
      index = scanTemplate(source, index, state)
      continue
    }
    if (current === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index + 2)
      index = end < 0 ? source.length : end + 1
      continue
    }
    if (current === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 2
      continue
    }
    if (current === '/' && regexLiteralStart(source, index)) {
      index = skipRegex(source, index)
      continue
    }
    if (current === '{') {
      braceDepth += 1
      index += 1
      continue
    }
    if (current === '}') {
      if (options.stopAtClosingBrace && braceDepth === 0) return index + 1
      if (braceDepth > 0) braceDepth -= 1
      index += 1
      continue
    }
    const registration = options.allowRegistration !== false && braceDepth === 0
      ? parseRegistration(source, index)
      : undefined
    if (registration) {
      state.registrations.push(registration.id)
      index = registration.end
      continue
    }
    const required = parseRequire(source, index)
    if (required) {
      if (required.dynamic) state.dynamicRequestCount += 1
      else state.requests.push(required.request)
      index = required.end
      continue
    }
    const provided = parseProvide(source, index)
    if (provided) {
      if (provided.dynamic) state.dynamicProvideCount += 1
      else state.providedServices.push(provided.service)
      index = provided.end
      continue
    }
    index += 1
  }
  return source.length
}

function scanBoundaryCalls(source) {
  const state = {
    registrations: [],
    requests: [],
    dynamicRequestCount: 0,
    providedServices: [],
    dynamicProvideCount: 0,
  }
  scanCode(source, 0, state)
  return {
    registrations: state.registrations,
    requests: [...new Set(state.requests)].sort((left, right) => left.localeCompare(right, 'en')),
    dynamicRequestCount: state.dynamicRequestCount,
    providedServices: [...new Set(state.providedServices)].sort((left, right) => left.localeCompare(right, 'en')),
    dynamicProvideCount: state.dynamicProvideCount,
  }
}

function classifyCoreServiceCollisions(services, packageName) {
  return services.flatMap((service) => {
    const owners = CORE_CLIENT_SERVICE_OWNERS[service]
    if (!owners || Object.values(owners).includes(packageName)) return []
    const lanes = []
    if (owners.release) lanes.push({ target: DSH_COMPATIBILITY_TARGET, owner: owners.release })
    if (owners.preview) lanes.push({ target: DSH_PREVIEW_TARGET, owner: owners.preview })
    return [{ service, lanes }]
  })
}

export function inspectClientServiceOwnership(source, packageName) {
  if (typeof source !== 'string' || typeof packageName !== 'string' || packageName.length === 0) {
    fail('INVALID_DSH_CLIENT', 'Client service ownership inspection requires source text and a named package.')
  }
  const scanned = scanBoundaryCalls(source)
  return {
    providedServices: scanned.providedServices,
    dynamicProvides: scanned.dynamicProvideCount,
    coreServiceCollisions: classifyCoreServiceCollisions(scanned.providedServices, packageName),
    repositoryCodeExecuted: false,
  }
}

function pathLikeSpecifier(value) {
  return value.startsWith('.')
    || value.startsWith('/')
    || value.startsWith('\\')
    || /^[a-z]:[\\/]/iu.test(value)
    || /^(?:file|data):/iu.test(value)
}

function validateRequestBoundary(requests, external) {
  const externalSet = new Set(external)
  const unsafe = requests.filter((value) => NODE_BUILTINS.has(value) || pathLikeSpecifier(value))
  const invalidExternal = external.filter((value) => NODE_BUILTINS.has(value) || pathLikeSpecifier(value))
  if (unsafe.length > 0 || invalidExternal.length > 0) {
    fail(
      'CLIENT_BUNDLE_UNSAFE_IMPORT',
      'The browser bundle requests Node, file, or package-local modules that DSH cannot supply to its client module table.',
      { requests: unsafe, declaredExternal: invalidExternal },
    )
  }
  const releaseMissing = requests.filter((value) => !CLIENT_RELEASE_MODULES.has(value) && !externalSet.has(value))
  const previewMissing = requests.filter((value) => !CLIENT_PREVIEW_MODULES.has(value) && !externalSet.has(value))
  if (releaseMissing.length > 0) {
    fail(
      'CLIENT_BUNDLE_EXTERNAL_DRIFT',
      'The browser bundle requests modules absent from the blocking DSH release module table and dsh.client.external.',
      {
        target: DSH_COMPATIBILITY_TARGET,
        requests: releaseMissing,
        previewTarget: DSH_PREVIEW_TARGET,
        previewRequests: previewMissing,
      },
    )
  }
  return {
    release: {
      target: DSH_COMPATIBILITY_TARGET,
      ok: true,
      missing: [],
    },
    preview: {
      target: DSH_PREVIEW_TARGET,
      ok: previewMissing.length === 0,
      missing: previewMissing,
    },
  }
}

export function inspectClientBundle(files, packageValue) {
  const packageName = packageValue?.name
  if (typeof packageName !== 'string' || packageName.length === 0) {
    fail('INVALID_DSH_CLIENT', 'Client-bundle audit requires a named package manifest.')
  }
  const declaration = packageValue.dsh?.client
  if (declaration === undefined) {
    const exportsClient = packageValue.exports !== null
      && typeof packageValue.exports === 'object'
      && !Array.isArray(packageValue.exports)
      && Object.hasOwn(packageValue.exports, './client')
    const legacyClient = packageValue.client !== undefined
    if (exportsClient || legacyClient) {
      fail(
        'CLIENT_DECLARATION_MISSING',
        packageName + (exportsClient ? ' exports a "./client" browser entry' : ' uses the legacy top-level package.json client field')
          + ' but omits the required package.json dsh.client declaration.',
        { export: exportsClient ? './client' : undefined, legacyClient },
      )
    }
    return { declared: false }
  }
  if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
    fail('INVALID_DSH_CLIENT', packageName + ' has a non-object dsh.client declaration.')
  }
  if (declaration.platform !== 'web') {
    fail('INVALID_DSH_CLIENT', packageName + ' dsh.client.platform must be "web".', {
      platform: declaration.platform,
    })
  }
  const injectedServices = optionalStringArray(packageName, 'dsh.client.inject', declaration.inject)
  const external = optionalStringArray(packageName, 'dsh.client.external', declaration.external)
  if (declaration.immediately !== undefined && typeof declaration.immediately !== 'boolean') {
    fail('INVALID_DSH_CLIENT', packageName + ' dsh.client.immediately must be boolean when present.')
  }

  const clientPath = portableClientPath(packageName, clientExportOf(packageName, packageValue.exports))
  const source = files.get(clientPath)
  if (source === undefined) {
    fail('CLIENT_BUNDLE_MISSING', packageName + ' client export is absent from the package tree.', { path: clientPath })
  }
  try {
    new Script(source, { filename: clientPath })
  } catch (error) {
    fail('CLIENT_BUNDLE_SYNTAX', packageName + ' client export is not a valid classic browser script.', {
      path: clientPath,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const scanned = scanBoundaryCalls(source)
  const registrations = scanned.registrations
  if (registrations.length !== 1 || registrations[0] !== packageName) {
    fail(
      'CLIENT_BUNDLE_REGISTRATION_INVALID',
      packageName + ' client bundle must register exactly its package id through window.__ModuleLoader__.load.',
      { expected: packageName, observed: registrations },
    )
  }
  const requests = scanned.requests
  if (scanned.dynamicRequestCount > 0) {
    fail(
      'CLIENT_BUNDLE_DYNAMIC_REQUEST',
      'The browser bundle contains non-literal require() calls that cannot be proven against the DSH client module table.',
      { calls: scanned.dynamicRequestCount },
    )
  }
  const lanes = validateRequestBoundary(requests, external)
  const externalSet = new Set(external)
  const coreServiceCollisions = classifyCoreServiceCollisions(scanned.providedServices, packageName)
  return {
    declared: true,
    platform: declaration.platform,
    path: clientPath,
    bytes: Buffer.byteLength(source, 'utf8'),
    registrationId: registrations[0],
    inject: [...new Set(injectedServices)].sort((left, right) => left.localeCompare(right, 'en')),
    external: [...externalSet].sort((left, right) => left.localeCompare(right, 'en')),
    requests,
    dynamicRequests: requests.filter((value) => externalSet.has(value)),
    providedServices: scanned.providedServices,
    dynamicProvides: scanned.dynamicProvideCount,
    coreServiceCollisions,
    lanes,
    validation: 'static-classic-script',
    repositoryCodeExecuted: false,
  }
}

export const CLIENT_BUNDLE_PLATFORM_MODULES = Object.freeze([...CLIENT_RELEASE_MODULES])
export const CLIENT_BUNDLE_PREVIEW_PLATFORM_MODULES = Object.freeze([...CLIENT_PREVIEW_MODULES])
export const CLIENT_BUNDLE_CORE_SERVICE_OWNERS = CORE_CLIENT_SERVICE_OWNERS
