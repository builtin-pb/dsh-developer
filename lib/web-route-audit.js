import { posix } from 'node:path'
import { DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET } from './constants.js'
import { DshDeveloperError } from './errors.js'

const CODE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']
const INDEX_FILES = ['index.js', 'index.mjs', 'index.cjs', 'index.ts', 'index.mts', 'index.cts']
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.tsx'])
const CONTROL_HEAD_KEYWORDS = new Set(['for', 'if', 'while', 'with'])
const METHOD_CONTROL_KEYWORDS = new Set([...CONTROL_HEAD_KEYWORDS, 'switch'])
const RUNTIME_IMPORT_PREFIXES = new Set(['await', 'case', 'return', 'throw', 'void', 'yield'])
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

function fail(code, message, details = {}) {
  throw new DshDeveloperError(code, message, details)
}

function identifierStart(value) {
  return value !== undefined && /[A-Za-z_$]/u.test(value)
}

function identifierCharacter(value) {
  return value !== undefined && /[A-Za-z0-9_$]/u.test(value)
}

function readQuoted(source, start) {
  const quote = source[start]
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

function regexLiteralStart(tokens) {
  const previous = tokens[tokens.length - 1]
  if (!previous) return true
  if (previous.value === ')' && previous.closesControlHead === true) return true
  if (previous.type === 'identifier') return REGEX_PREFIX_KEYWORDS.has(previous.value)
  return previous.type === 'punctuator' && '([{=,:;!?&|+-*%^~<>'.includes(previous.value)
}

function tokenizeTemplate(source, start) {
  const tokens = []
  for (let index = start + 1; index < source.length;) {
    if (source[index] === '\\') {
      index += 2
      continue
    }
    if (source[index] === '`') return { tokens, end: index + 1 }
    if (source[index] === '$' && source[index + 1] === '{') {
      const expression = tokenizeCode(source, index + 2, { stopAtClosingBrace: true })
      tokens.push(...expression.tokens)
      index = expression.end
      continue
    }
    index += 1
  }
  return { tokens, end: source.length }
}

function tokenizeCode(source, start = 0, options = {}) {
  const tokens = []
  let braceDepth = 0
  const parenthesisContexts = []
  for (let index = start; index < source.length;) {
    const current = source[index]
    if (/\s/u.test(current)) {
      index += 1
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
    if (current === '"' || current === "'") {
      const quoted = readQuoted(source, index)
      if (!quoted) {
        index += 1
        continue
      }
      tokens.push({ type: 'string', value: quoted.value, start: index, end: quoted.end })
      index = quoted.end
      continue
    }
    if (current === '`') {
      const template = tokenizeTemplate(source, index)
      tokens.push(...template.tokens)
      index = template.end
      continue
    }
    if (current === '/' && regexLiteralStart(tokens)) {
      index = skipRegex(source, index)
      continue
    }
    if (identifierStart(current)) {
      let end = index + 1
      while (identifierCharacter(source[end])) end += 1
      tokens.push({ type: 'identifier', value: source.slice(index, end), start: index, end })
      index = end
      continue
    }
    if (current === '(') {
      const previous = tokens[tokens.length - 1]
      const beforePrevious = tokens[tokens.length - 2]
      parenthesisContexts.push(
        previous?.type === 'identifier' && (
          CONTROL_HEAD_KEYWORDS.has(previous.value)
          || (previous.value === 'await' && beforePrevious?.value === 'for')
        ),
      )
      tokens.push({ type: 'punctuator', value: current, start: index, end: index + 1 })
      index += 1
      continue
    }
    if (current === ')') {
      tokens.push({
        type: 'punctuator',
        value: current,
        start: index,
        end: index + 1,
        closesControlHead: parenthesisContexts.pop() === true,
      })
      index += 1
      continue
    }
    if (current === '{') {
      braceDepth += 1
      tokens.push({ type: 'punctuator', value: current, start: index, end: index + 1 })
      index += 1
      continue
    }
    if (current === '}') {
      if (options.stopAtClosingBrace && braceDepth === 0) return { tokens, end: index + 1 }
      if (braceDepth > 0) braceDepth -= 1
      tokens.push({ type: 'punctuator', value: current, start: index, end: index + 1 })
      index += 1
      continue
    }
    tokens.push({ type: 'punctuator', value: current, start: index, end: index + 1 })
    index += 1
  }
  return { tokens, end: source.length }
}

function matches(tokens, start, values) {
  return values.every((value, offset) => tokens[start + offset]?.value === value)
}

function closingToken(tokens, start, open, close) {
  if (tokens[start]?.value !== open) return undefined
  let depth = 0
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === open) depth += 1
    else if (tokens[index].value === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return undefined
}

function openingToken(tokens, end, open, close) {
  if (tokens[end]?.value !== close) return undefined
  let depth = 0
  for (let index = end; index >= 0; index -= 1) {
    if (tokens[index].value === close) depth += 1
    else if (tokens[index].value === open) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return undefined
}

function blockAfter(tokens, start) {
  for (let index = start; index < tokens.length && index <= start + 32; index += 1) {
    if (tokens[index].value === '{') return index
    if (tokens[index].value === ';') return undefined
  }
  return undefined
}

function simpleContextParameter(tokens, start, end) {
  if (start === undefined || end === undefined || end <= start + 1) return undefined
  const first = tokens[start + 1]
  if (first?.type !== 'identifier' || first.value !== 'ctx') return undefined
  let nested = 0
  for (let index = start + 1; index < end; index += 1) {
    if ('([{'.includes(tokens[index].value)) nested += 1
    else if (')]}'.includes(tokens[index].value) && nested > 0) nested -= 1
    else if (tokens[index].value === ',' && nested === 0) return undefined
  }
  return 'ctx'
}

function parametersBindContext(tokens, start, end) {
  let parenthesisDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let initializer = false
  for (let index = start + 1; index < end; index += 1) {
    const token = tokens[index]
    const topLevel = parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0
    if (topLevel && token.value === ',') {
      initializer = false
      continue
    }
    if (topLevel && token.value === '=') {
      initializer = true
      continue
    }
    if (!initializer && token.type === 'identifier' && token.value === 'ctx') return true
    if (token.value === '(') parenthesisDepth += 1
    else if (token.value === ')' && parenthesisDepth > 0) parenthesisDepth -= 1
    else if (token.value === '[') bracketDepth += 1
    else if (token.value === ']' && bracketDepth > 0) bracketDepth -= 1
    else if (token.value === '{') braceDepth += 1
    else if (token.value === '}' && braceDepth > 0) braceDepth -= 1
  }
  return false
}

function declarationBindsContext(tokens, start, end) {
  let parenthesisDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let initializer = false
  for (let index = start + 1; index < end; index += 1) {
    const token = tokens[index]
    const topLevel = parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0
    if (topLevel && token.value === ';') return false
    if (topLevel && token.value === ',') {
      initializer = false
      continue
    }
    if (topLevel && token.value === '=') {
      initializer = true
      continue
    }
    if (!initializer && token.type === 'identifier' && token.value === 'ctx') return true
    if (token.value === '(') parenthesisDepth += 1
    else if (token.value === ')' && parenthesisDepth > 0) parenthesisDepth -= 1
    else if (token.value === '[') bracketDepth += 1
    else if (token.value === ']' && bracketDepth > 0) bracketDepth -= 1
    else if (token.value === '{') braceDepth += 1
    else if (token.value === '}' && braceDepth > 0) braceDepth -= 1
  }
  return false
}

function arrowExpressionEnd(tokens, start) {
  let parenthesisDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  for (let index = start; index < tokens.length; index += 1) {
    const value = tokens[index].value
    if (value === '(') parenthesisDepth += 1
    else if (value === ')') {
      if (parenthesisDepth === 0) return index
      parenthesisDepth -= 1
    } else if (value === '[') bracketDepth += 1
    else if (value === ']') {
      if (bracketDepth === 0) return index
      bracketDepth -= 1
    } else if (value === '{') braceDepth += 1
    else if (value === '}') {
      if (braceDepth === 0) return index
      braceDepth -= 1
    } else if ((value === ';' || value === ',')
        && parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0) return index
  }
  return tokens.length
}

function functionScopes(tokens, options = {}) {
  const scopes = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value === 'function') {
      let cursor = index + 1
      if (tokens[cursor]?.value === '*') cursor += 1
      const name = tokens[cursor]?.type === 'identifier' ? tokens[cursor++].value : undefined
      if (tokens[cursor]?.value !== '(') continue
      const parametersStart = cursor
      const parametersEnd = closingToken(tokens, parametersStart, '(', ')')
      if (parametersEnd === undefined) continue
      const bodyStart = blockAfter(tokens, parametersEnd + 1)
      const bodyEnd = bodyStart === undefined ? undefined : closingToken(tokens, bodyStart, '{', '}')
      if (bodyStart === undefined || bodyEnd === undefined) continue
      const exported = tokens[index - 1]?.value === 'export'
        || (tokens[index - 1]?.value === 'async' && tokens[index - 2]?.value === 'export')
      scopes.push({
        bodyStart,
        bodyEnd,
        rootContext: options.rootEntry && exported && name === 'apply'
          ? simpleContextParameter(tokens, parametersStart, parametersEnd)
          : undefined,
      })
      continue
    }
    if (!matches(tokens, index, ['=', '>'])) continue
    let parametersStart
    let parametersEnd
    let rootContext
    let assignment
    if (tokens[index - 1]?.value === ')') {
      parametersEnd = index - 1
      parametersStart = openingToken(tokens, parametersEnd, '(', ')')
      rootContext = simpleContextParameter(tokens, parametersStart, parametersEnd)
      assignment = parametersStart === undefined ? undefined : parametersStart - 1
    } else if (tokens[index - 1]?.type === 'identifier') {
      rootContext = tokens[index - 1].value === 'ctx' ? 'ctx' : undefined
      assignment = index - 2
    }
    if (assignment === undefined) continue
    if (tokens[assignment]?.value === 'async') assignment -= 1
    const bodyToken = index + 2
    const blockBody = tokens[bodyToken]?.value === '{'
    const bodyStart = blockBody ? bodyToken : index + 1
    const bodyEnd = blockBody
      ? closingToken(tokens, bodyToken, '{', '}')
      : arrowExpressionEnd(tokens, bodyToken)
    if (bodyEnd === undefined) continue
    const exportedApply = matches(tokens, assignment - 3, ['export', 'const', 'apply', '='])
      || matches(tokens, assignment - 3, ['export', 'let', 'apply', '='])
      || matches(tokens, assignment - 3, ['export', 'var', 'apply', '='])
    scopes.push({
      bodyStart,
      bodyEnd,
      rootContext: options.rootEntry && exportedApply
        ? rootContext
        : undefined,
    })
  }

  const functionBodies = new Set(scopes.map((scope) => `${scope.bodyStart}:${scope.bodyEnd}`))
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== '(') continue
    const parametersEnd = closingToken(tokens, index, '(', ')')
    const bodyStart = parametersEnd === undefined ? undefined : parametersEnd + 1
    if (bodyStart === undefined || tokens[bodyStart]?.value !== '{') continue
    const bodyEnd = closingToken(tokens, bodyStart, '{', '}')
    if (bodyEnd === undefined || functionBodies.has(`${bodyStart}:${bodyEnd}`)) continue
    const owner = tokens[index - 1]
    if (owner?.type === 'identifier' && METHOD_CONTROL_KEYWORDS.has(owner.value)) continue
    if (!parametersBindContext(tokens, index, parametersEnd)) continue
    scopes.push({ bodyStart, bodyEnd, rootContext: undefined })
  }

  for (let blockStart = 0; blockStart < tokens.length; blockStart += 1) {
    if (tokens[blockStart].value !== '{') continue
    const blockEnd = closingToken(tokens, blockStart, '{', '}')
    if (blockEnd === undefined) continue
    let parenthesisDepth = 0
    let bracketDepth = 0
    let braceDepth = 0
    for (let index = blockStart + 1; index < blockEnd; index += 1) {
      const token = tokens[index]
      const direct = parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0
      const lexicalDeclaration = ['const', 'let'].includes(token.value)
        && declarationBindsContext(tokens, index, blockEnd)
      const namedDeclaration = ['class', 'function'].includes(token.value)
        && tokens[index + 1]?.type === 'identifier' && tokens[index + 1].value === 'ctx'
      if (direct && (lexicalDeclaration || namedDeclaration)) {
        scopes.push({ bodyStart: blockStart, bodyEnd: blockEnd, rootContext: undefined })
        break
      }
      if (token.value === '(') parenthesisDepth += 1
      else if (token.value === ')' && parenthesisDepth > 0) parenthesisDepth -= 1
      else if (token.value === '[') bracketDepth += 1
      else if (token.value === ']' && bracketDepth > 0) bracketDepth -= 1
      else if (token.value === '{') braceDepth += 1
      else if (token.value === '}' && braceDepth > 0) braceDepth -= 1
    }
  }
  return scopes
}

function provenRootContext(scopes, tokenIndex) {
  const enclosing = scopes
    .filter((scope) => scope.bodyStart < tokenIndex && tokenIndex < scope.bodyEnd)
    .sort((left, right) => (left.bodyEnd - left.bodyStart) - (right.bodyEnd - right.bodyStart)
      || Number(left.rootContext === 'ctx') - Number(right.rootContext === 'ctx'))
  return enclosing[0]?.rootContext === 'ctx'
}

function lineAt(source, offset) {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n') line += 1
  }
  return line
}

function literalObjectFields(tokens, openParenthesis) {
  const start = openParenthesis + 1
  if (tokens[start]?.value !== '{') return {}
  const fields = {}
  let objectDepth = 0
  let parenthesisDepth = 0
  let bracketDepth = 0
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (objectDepth === 1 && parenthesisDepth === 0 && bracketDepth === 0
        && (token.type === 'identifier' || token.type === 'string')
        && tokens[index + 1]?.value === ':' && tokens[index + 2]?.type === 'string') {
      fields[token.value] = tokens[index + 2].value
    }
    if (token.value === '{') objectDepth += 1
    else if (token.value === '}') {
      objectDepth -= 1
      if (objectDepth === 0) break
    } else if (token.value === '(') parenthesisDepth += 1
    else if (token.value === ')' && parenthesisDepth > 0) parenthesisDepth -= 1
    else if (token.value === '[') bracketDepth += 1
    else if (token.value === ']' && bracketDepth > 0) bracketDepth -= 1
  }
  return fields
}

function scanRegistrations(source, sourcePath, options = {}) {
  const tokens = tokenizeCode(source).tokens
  const scopes = functionScopes(tokens, options)
  const rawCandidates = []
  const connectionCandidates = []
  for (let index = 0; index < tokens.length; index += 1) {
    const ctxRaw = tokens[index - 1]?.value !== '.'
      && matches(tokens, index, ['ctx', '.', 'webServer', '.', 'register', '('])
      && provenRootContext(scopes, index)
    if (ctxRaw) {
      const openParenthesis = index + 5
      const fields = literalObjectFields(tokens, openParenthesis)
      rawCandidates.push({
        sourcePath,
        line: lineAt(source, tokens[index].start),
        call: 'ctx.webServer.register',
        kind: fields.kind,
        routePath: fields.path,
        authBoundary: 'raw-web-server',
        hostAuthentication: 'not-established-by-registration',
        intent: 'review-required',
      })
    }

    const ctxConnection = tokens[index - 1]?.value !== '.'
      && matches(tokens, index, ['ctx', '.', 'connection', '.', 'rpc', '.', 'handle', '('])
      && provenRootContext(scopes, index)
    if (ctxConnection) {
      const openParenthesis = index + 7
      connectionCandidates.push({
        sourcePath,
        line: lineAt(source, tokens[index].start),
        call: 'ctx.connection.rpc.handle',
        routePath: tokens[openParenthesis + 1]?.type === 'string'
          ? tokens[openParenthesis + 1].value
          : undefined,
        authBoundary: 'host-connection',
        hostAuthentication: 'connection-boundary',
        intent: 'authenticated-channel',
      })
    }
  }
  return { tokens, rawCandidates, connectionCandidates }
}

function directRuntimeInitializer(tokens, index) {
  if (tokens[index - 1]?.value !== '=') return false
  for (let cursor = index - 2; cursor >= 0 && cursor >= index - 64; cursor -= 1) {
    const token = tokens[cursor]
    if (['(', '[', '{', ')', ']', '}', ';'].includes(token.value)) return false
    if (['const', 'let', 'var'].includes(token.value)) return true
    if (token.value === 'type' && tokens[cursor + 1]?.type === 'identifier') return false
    if (['interface', 'function', 'class'].includes(token.value)) return false
  }
  return false
}

function provenRuntimeDynamicImport(tokens, index, sourcePath) {
  if (!TYPESCRIPT_EXTENSIONS.has(posix.extname(sourcePath))) return true
  const previous = tokens[index - 1]
  if (!previous || previous.value === ';') return true
  if (previous.type === 'identifier' && RUNTIME_IMPORT_PREFIXES.has(previous.value)) return true
  if (matches(tokens, index - 2, ['export', 'default'])) return true
  return directRuntimeInitializer(tokens, index)
}

function moduleSpecifiers(tokens, sourcePath) {
  const values = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type !== 'identifier' || tokens[index - 1]?.value === '.') continue
    if (token.value === 'require' && tokens[index + 1]?.value === '('
        && tokens[index + 2]?.type === 'string' && tokens[index + 3]?.value === ')') {
      values.push(tokens[index + 2].value)
      continue
    }
    if (token.value === 'import') {
      if (tokens[index + 1]?.type === 'string') {
        values.push(tokens[index + 1].value)
        continue
      }
      if (tokens[index + 1]?.value === '(' && tokens[index + 2]?.type === 'string'
          && tokens[index + 3]?.value === ')') {
        if (!provenRuntimeDynamicImport(tokens, index, sourcePath)) continue
        values.push(tokens[index + 2].value)
        continue
      }
    }
    if (token.value !== 'import' && token.value !== 'export') continue
    if (tokens[index + 1]?.value === 'type' && tokens[index + 2]?.value !== 'from') continue
    for (let cursor = index + 1; cursor < tokens.length && cursor <= index + 128; cursor += 1) {
      if (tokens[cursor].value === ';') break
      if (tokens[cursor].value === 'from' && tokens[cursor + 1]?.type === 'string') {
        values.push(tokens[cursor + 1].value)
        break
      }
    }
  }
  return [...new Set(values)]
}

function resolveLocalModule(fromPath, specifier, files) {
  if (!specifier.startsWith('.')) return undefined
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
  if (base === '..' || base.startsWith('../')) return undefined
  const candidates = [
    base,
    ...CODE_EXTENSIONS.map((extension) => base + extension),
    ...INDEX_FILES.map((name) => posix.join(base, name)),
  ]
  return candidates.find((value) => files.has(value))
}

function routeOrder(left, right) {
  return left.sourcePath.localeCompare(right.sourcePath, 'en')
    || left.line - right.line
    || (left.routePath ?? '').localeCompare(right.routePath ?? '', 'en')
}

export function inspectWebRouteAuth(files, options = {}) {
  if (!(files instanceof Map)) fail('INVALID_WEB_ROUTE_AUDIT', 'Web-route audit requires a plugin file map.')
  const entryPath = options.entryPath
  if (typeof entryPath !== 'string' || entryPath.length === 0 || !files.has(entryPath)) {
    fail('WEB_ROUTE_ENTRY_MISSING', 'Web-route audit requires the package entry in the audited tree.', { entryPath })
  }

  const queue = [entryPath]
  const reachable = new Map()
  while (queue.length > 0) {
    const sourcePath = queue.shift()
    if (reachable.has(sourcePath)) continue
    const source = files.get(sourcePath)
    if (typeof source !== 'string') continue
    const scanned = scanRegistrations(source, sourcePath, { rootEntry: sourcePath === entryPath })
    reachable.set(sourcePath, scanned)
    for (const specifier of moduleSpecifiers(scanned.tokens, sourcePath)) {
      const local = resolveLocalModule(sourcePath, specifier, files)
      if (local && !reachable.has(local)) queue.push(local)
    }
  }

  const rawRoutes = [...reachable.values()]
    .flatMap((value) => value.rawCandidates)
    .sort(routeOrder)
  const connectionRoutes = [...reachable.values()]
    .flatMap((value) => value.connectionCandidates)
    .sort(routeOrder)

  return {
    entryPath,
    reachablePaths: [...reachable.keys()].sort((left, right) => left.localeCompare(right, 'en')),
    rawRoutes,
    connectionRoutes,
    lanes: {
      release: {
        target: DSH_COMPATIBILITY_TARGET,
        policy: 'blocking',
        exactRuntimeProofRequired: true,
      },
      preview: {
        target: DSH_PREVIEW_TARGET,
        policy: 'advisory',
        exactRuntimeProofRequired: true,
      },
    },
    coverage: {
      mode: 'package-entry-reachable-exported-apply-context',
      dynamicOrAliasedRegistrations: 'not-claimed',
      bareServiceBindings: 'not-claimed',
      nestedOrShadowedContextBindings: 'not-claimed',
      absenceIsLocal: true,
    },
    repositoryCodeExecuted: false,
  }
}
