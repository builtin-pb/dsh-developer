import { posix } from 'node:path'
import { DshDeveloperError } from './errors.js'

function typeOnlyClause(clause) {
  const value = clause.trim()
  if (!value.startsWith('{') || !value.endsWith('}')) return false
  const bindings = value.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean)
  return bindings.length > 0 && bindings.every((item) => /^type\b/u.test(item))
}

function declarationSpecifier(source, start, keyword) {
  const clauseStart = skipTrivia(source, start + keyword.length)
  if (keyword === 'import' && (source[clauseStart] === '"' || source[clauseStart] === "'")) {
    return staticSpecifier(source, clauseStart)
  }
  if (source.startsWith('type', clauseStart) && !identifierCharacter(source[clauseStart + 4])) return undefined
  let curly = 0
  let parenthesis = 0
  let bracket = 0
  const limit = Math.min(source.length, clauseStart + 4096)
  for (let index = clauseStart; index < limit;) {
    const current = source[index]
    if (current === '"' || current === "'") {
      index = skipQuoted(source, index)
      continue
    }
    if (current === '`') {
      index = skipTemplate(source, index)
      continue
    }
    if (source.startsWith('//', index) || source.startsWith('/*', index)) {
      index = skipTrivia(source, index)
      continue
    }
    if (current === '{') curly += 1
    else if (current === '}') {
      if (curly === 0) return undefined
      curly -= 1
    } else if (current === '(') parenthesis += 1
    else if (current === ')') parenthesis = Math.max(0, parenthesis - 1)
    else if (current === '[') bracket += 1
    else if (current === ']') bracket = Math.max(0, bracket - 1)
    else if (current === ';' && curly === 0 && parenthesis === 0 && bracket === 0) return undefined
    if (curly === 0 && parenthesis === 0 && bracket === 0
        && source.startsWith('from', index)
        && !identifierCharacter(source[index - 1])
        && !identifierCharacter(source[index + 4])) {
      const specifierStart = skipTrivia(source, index + 4)
      const specifier = staticSpecifier(source, specifierStart)
      if (specifier !== undefined && !typeOnlyClause(source.slice(clauseStart, index))) return specifier
    }
    index += 1
  }
  return undefined
}

function eagerImportSpecifiers(source) {
  const specifiers = []
  let braceDepth = 0
  for (let index = 0; index < source.length;) {
    const current = source[index]
    if (current === '"' || current === "'") {
      index = skipQuoted(source, index)
      continue
    }
    if (current === '`') {
      index = skipTemplate(source, index)
      continue
    }
    if (source.startsWith('//', index) || source.startsWith('/*', index)) {
      index = skipTrivia(source, index)
      continue
    }
    if (current === '/' && regexLiteralStart(source, index)) {
      index = skipRegex(source, index)
      continue
    }
    if (current === '{') braceDepth += 1
    else if (current === '}') braceDepth = Math.max(0, braceDepth - 1)
    if (braceDepth === 0) {
      const keyword = ['import', 'export'].find((value) => (
        source.startsWith(value, index)
          && !identifierCharacter(source[index - 1])
          && !identifierCharacter(source[index + value.length])
      ))
      if (keyword) {
        const specifier = declarationSpecifier(source, index, keyword)
        if (specifier !== undefined) specifiers.push(specifier)
      }
    }
    index += 1
  }
  return [...new Set(specifiers)]
}

function identifierCharacter(value) {
  return value !== undefined && /[A-Za-z0-9_$]/u.test(value)
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'of',
  'return', 'throw', 'typeof', 'void', 'yield',
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
    if (source[index] === '[') characterClass = true
    else if (source[index] === ']' && characterClass) characterClass = false
    else if (source[index] === '/' && !characterClass) {
      index += 1
      while (/[A-Za-z]/u.test(source[index] ?? '')) index += 1
      return index
    }
  }
  return source.length
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

function templateExpressionEnd(source, start) {
  let braceDepth = 0
  for (let index = start; index < source.length;) {
    const current = source[index]
    if (current === '"' || current === "'") {
      index = skipQuoted(source, index)
      continue
    }
    if (current === '`') {
      index = readTemplate(source, index).end
      continue
    }
    if (source.startsWith('//', index) || source.startsWith('/*', index)) {
      index = skipTrivia(source, index)
      continue
    }
    if (current === '/' && regexLiteralStart(source, index)) {
      index = skipRegex(source, index)
      continue
    }
    if (current === '{') braceDepth += 1
    else if (current === '}') {
      if (braceDepth === 0) return index
      braceDepth -= 1
    }
    index += 1
  }
  return source.length
}

function readTemplate(source, start) {
  const expressions = []
  for (let index = start + 1; index < source.length;) {
    if (source[index] === '\\') {
      index += 2
      continue
    }
    if (source[index] === '`') return { end: index + 1, expressions }
    if (source[index] === '$' && source[index + 1] === '{') {
      const expressionStart = index + 2
      const expressionEnd = templateExpressionEnd(source, expressionStart)
      expressions.push(source.slice(expressionStart, expressionEnd))
      index = expressionEnd < source.length ? expressionEnd + 1 : source.length
      continue
    }
    index += 1
  }
  return { end: source.length, expressions }
}

function skipTemplate(source, start) {
  return readTemplate(source, start).end
}

function staticSpecifier(source, start) {
  const delimiter = source[start]
  if (delimiter !== '"' && delimiter !== "'" && delimiter !== '`') return undefined
  const end = delimiter === '`' ? skipTemplate(source, start) : skipQuoted(source, start)
  if (source[end - 1] !== delimiter) return undefined
  const raw = source.slice(start + 1, end - 1)
  if (raw.includes('\\') || (delimiter === '`' && raw.includes('${'))) return undefined
  return raw
}

function skipTrivia(source, start) {
  let index = start
  while (index < source.length) {
    if (/\s/u.test(source[index])) {
      index += 1
      continue
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2)
      index = end < 0 ? source.length : end + 1
      continue
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 2
      continue
    }
    break
  }
  return index
}

function lineRequiresOperand(source, boundary, newline) {
  const line = source.slice(boundary + 1, newline).trimEnd()
  return /(?:^|[^A-Za-z0-9_$])(?:await|delete|new|throw|typeof|void|yield)$/u.test(line)
    || /[!~]$/u.test(line)
}

function topLevelDynamicImportSpecifiers(source) {
  const specifiers = []
  let braceDepth = 0
  let lazyBraceDepth = 0
  const braceKinds = []
  let parenthesisDepth = 0
  let bracketDepth = 0
  let controlHeader = false
  const controlledBodies = []
  let lastArrow = -1
  let lastConditional = -1
  let lastBoundary = -1
  let previousCode = ''
  for (let index = 0; index < source.length;) {
    const current = source[index]
    if (current === '"' || current === "'") {
      index = skipQuoted(source, index)
      previousCode = 'string'
      continue
    }
    if (current === '`') {
      const template = readTemplate(source, index)
      if (lazyBraceDepth === 0
          && controlledBodies.length === 0
          && lastArrow <= lastBoundary
          && lastConditional <= lastBoundary) {
        for (const expression of template.expressions) {
          specifiers.push(...topLevelDynamicImportSpecifiers('(' + expression + ')'))
        }
      }
      index = template.end
      previousCode = 'template'
      continue
    }
    if (current === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index + 2)
      index = end < 0 ? source.length : end
      continue
    }
    if (current === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 2
      continue
    }
    if (current === '/' && regexLiteralStart(source, index)) {
      index = skipRegex(source, index)
      previousCode = 'regex'
      continue
    }

    const topLevelBefore = braceDepth === 0 && parenthesisDepth === 0 && bracketDepth === 0
    let controlKeyword
    if (topLevelBefore) {
      controlKeyword = ['if', 'for', 'while', 'switch'].find((keyword) => (
        source.startsWith(keyword, index)
          && !identifierCharacter(source[index - 1])
          && !identifierCharacter(source[index + keyword.length])
      ))
      const body = controlledBodies.at(-1)
      if (body && !body.started && index >= body.after && !/\s/u.test(current)) {
        body.started = true
        body.braced = current === '{'
      }
      if (controlKeyword) controlHeader = true
      const bodyKeyword = ['else', 'do'].find((keyword) => (
        source.startsWith(keyword, index)
          && !identifierCharacter(source[index - 1])
          && !identifierCharacter(source[index + keyword.length])
      ))
      if (bodyKeyword) controlledBodies.push({ started: false, braced: false, after: index + bodyKeyword.length })
    }

    if (current === '{') {
      const controlledBrace = topLevelBefore && controlledBodies.at(-1)?.braced === true
      const expressionBrace = !controlledBrace
        && lazyBraceDepth === 0
        && ['=', '(', '[', ',', ':'].includes(previousCode)
      braceKinds.push(expressionBrace)
      if (!expressionBrace) lazyBraceDepth += 1
      braceDepth += 1
    }
    else if (current === '}') {
      const expressionBrace = braceKinds.pop()
      if (expressionBrace === false) lazyBraceDepth = Math.max(0, lazyBraceDepth - 1)
      braceDepth = Math.max(0, braceDepth - 1)
      if (braceDepth === 0 && parenthesisDepth === 0 && bracketDepth === 0
          && controlledBodies.some((body) => body.braced)) {
        controlledBodies.length = 0
        lastBoundary = index
      }
    }
    else if (current === '(') parenthesisDepth += 1
    else if (current === ')') {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1)
      if (controlHeader && braceDepth === 0 && parenthesisDepth === 0 && bracketDepth === 0) {
        controlledBodies.push({ started: false, braced: false, after: index + 1 })
        controlHeader = false
      }
    }
    else if (current === '[') bracketDepth += 1
    else if (current === ']') bracketDepth = Math.max(0, bracketDepth - 1)

    if (lazyBraceDepth === 0 && current === '=' && source[index + 1] === '>') {
      lastArrow = index
      previousCode = '=>'
      index += 2
      continue
    }
    if (lazyBraceDepth === 0) {
      const doubleOperator = source.slice(index, index + 2)
      if (current === '?' || doubleOperator === '&&' || doubleOperator === '||' || doubleOperator === '??') {
        lastConditional = index
      }
    }

    if (braceDepth === 0 && parenthesisDepth === 0 && bracketDepth === 0) {
      if (current === ';') {
        lastBoundary = index
        controlledBodies.length = 0
      }
      if (current === '\n') {
        if (!['=>', '=', ',', '.', '?', ':', '+', '-', '*', '/', '!', '~', '&&', '||', '??'].includes(previousCode)
            && !lineRequiresOperand(source, lastBoundary, index)) {
          lastBoundary = index
          if (controlledBodies.some((body) => body.started && !body.braced)) controlledBodies.length = 0
        }
      }
    }
    if (lazyBraceDepth === 0
        && source.startsWith('import', index)
        && !identifierCharacter(source[index - 1])
        && !identifierCharacter(source[index + 'import'.length])
        && controlledBodies.length === 0
        && lastArrow <= lastBoundary
        && lastConditional <= lastBoundary) {
      let cursor = skipTrivia(source, index + 'import'.length)
      if (source[cursor] === '(') {
        cursor = skipTrivia(source, cursor + 1)
        const specifier = staticSpecifier(source, cursor)
        if (specifier !== undefined) specifiers.push(specifier)
      }
    }
    if (!/\s/u.test(current)) previousCode = source.slice(index, index + 2) === '&&'
      || source.slice(index, index + 2) === '||'
      || source.slice(index, index + 2) === '??'
      ? source.slice(index, index + 2)
      : current
    index += 1
  }
  return [...new Set(specifiers)]
}

function resolveEagerLocalModule(fromPath, specifier, files) {
  if (!specifier.startsWith('.')) return undefined
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
  if (base === '..' || base.startsWith('../')) return undefined
  return [
    base,
    ...['.js', '.mjs', '.ts', '.mts', '.jsx', '.tsx'].map((extension) => base + extension),
    ...['index.js', 'index.mjs', 'index.ts', 'index.mts', 'index.jsx', 'index.tsx']
      .map((name) => posix.join(base, name)),
  ].find((path) => files.has(path))
}

function barePackageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return undefined
  if (specifier.startsWith('@')) {
    const packageEnd = specifier.indexOf('/', specifier.indexOf('/') + 1)
    return packageEnd < 0 ? specifier : specifier.slice(0, packageEnd)
  }
  const packageEnd = specifier.indexOf('/')
  return packageEnd < 0 ? specifier : specifier.slice(0, packageEnd)
}

function mountedPackages(files, patchPath) {
  if (!patchPath) return []
  const source = files.get(patchPath) ?? ''
  const names = []
  const lines = source.split(/\r?\n/u)
  const rowStart = /^( *)(?:-[ ]+)([A-Za-z][A-Za-z0-9_-]*):[ ]*(.*)$/u
  const field = /^( +)([A-Za-z][A-Za-z0-9_-]*):[ ]*(.*)$/u
  const scalar = (value) => {
    const trimmed = value.replace(/[ ]+#.*$/u, '').trim()
    if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1)
    return /^[^\s#]+$/u.test(trimmed) ? trimmed : undefined
  }
  for (let index = 0; index < lines.length; index += 1) {
    const start = rowStart.exec(lines[index])
    if (!start || !['id', 'name'].includes(start[2])) continue
    const indentation = start[1].length
    const mappingIndentation = lines[index].indexOf(start[2], indentation + 1)
    const values = new Map([[start[2], scalar(start[3])]])
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trim().length === 0 || /^[ ]*#/u.test(lines[cursor])) continue
      const nextRow = rowStart.exec(lines[cursor])
      if (nextRow && nextRow[1].length <= indentation) break
      const nextField = field.exec(lines[cursor])
      if (!nextField || nextField[1].length <= indentation) break
      if (nextField[1].length === mappingIndentation && ['id', 'name'].includes(nextField[2])) {
        values.set(nextField[2], scalar(nextField[3]))
      }
    }
    if (values.get('id') && values.get('name')) names.push(values.get('name'))
  }
  return [...new Set(names)].sort((left, right) => left.localeCompare(right, 'en'))
}

function recordCollision(collisions, packageName, path) {
  let paths = collisions.get(packageName)
  if (!paths) {
    paths = new Set()
    collisions.set(packageName, paths)
  }
  paths.add(path)
}

export function inspectOptionalRuntimeImports(files, packageValue, options = {}) {
  const optional = packageValue.optionalDependencies
  if (optional !== undefined && (optional === null || typeof optional !== 'object' || Array.isArray(optional))) {
    throw new DshDeveloperError(
      'INVALID_OPTIONAL_DEPENDENCIES',
      'package.json optionalDependencies must be an object when present.',
    )
  }
  const patchPackages = mountedPackages(files, options.patchPath)
  const roots = options.entryPath ? [options.entryPath] : []
  const baseEvidence = {
    roots,
    uninspectedExternalMounts: patchPackages.filter((name) => name !== packageValue.name),
  }
  if (optional === undefined) return { ...baseEvidence, visitedModules: [], collisions: [] }
  const optionalNames = new Set(Object.keys(optional))
  for (const packageName of optionalNames) {
    if (typeof optional[packageName] !== 'string' || optional[packageName].length === 0) {
      throw new DshDeveloperError(
        'INVALID_OPTIONAL_DEPENDENCIES',
        'Every package.json optionalDependencies value must be a non-empty range string.',
        { package: packageName },
      )
    }
  }
  const collisionPaths = new Map()
  for (const packageName of patchPackages) {
    if (packageName !== packageValue.name && optionalNames.has(packageName)) {
      recordCollision(collisionPaths, packageName, options.patchPath)
    }
  }
  const queue = [...roots]
  const visited = new Set()
  while (queue.length > 0) {
    const path = queue.shift()
    if (visited.has(path)) continue
    visited.add(path)
    const source = files.get(path) ?? ''
    const specifiers = [...new Set([
      ...eagerImportSpecifiers(source),
      ...topLevelDynamicImportSpecifiers(source),
    ])]
    for (const specifier of specifiers) {
      const local = resolveEagerLocalModule(path, specifier, files)
      if (local) {
        if (!visited.has(local)) queue.push(local)
        continue
      }
      const packageName = barePackageName(specifier)
      if (!packageName || !optionalNames.has(packageName)) continue
      recordCollision(collisionPaths, packageName, path)
    }
  }
  return {
    ...baseEvidence,
    visitedModules: [...visited].sort((left, right) => left.localeCompare(right, 'en')),
    collisions: [...collisionPaths.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([packageName, paths]) => ({
        package: packageName,
        range: optional[packageName],
        paths: [...paths].sort((left, right) => left.localeCompare(right, 'en')),
      })),
  }
}
