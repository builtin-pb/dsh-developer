import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { parse } from '@babel/parser'
import traverse from '@babel/traverse'
import { DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET } from './constants.js'
import { DshDeveloperError } from './errors.js'

const CODE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']
const INDEX_FILES = CODE_EXTENSIONS.map((extension) => `index${extension}`)
const TRANSPARENT_EXPRESSION_TYPES = new Set([
  'ChainExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSInstantiationExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TypeCastExpression',
])
const TYPE_ONLY_DECLARATIONS = new Set([
  'DeclareClass',
  'DeclareFunction',
  'DeclareInterface',
  'DeclareModule',
  'DeclareTypeAlias',
  'TSDeclareFunction',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
])

export const EXECUTABLE_SOURCE_BYTES_LIMIT = 512 * 1024
export const EXECUTABLE_SOURCE_NODE_LIMIT = 250_000
export const EXECUTABLE_SOURCE_NESTING_LIMIT = 64
export const EXECUTABLE_SOURCE_SCOPE_LIMIT = 4096
export const EXECUTABLE_MODULE_LIMIT = 512
export const EXECUTABLE_MODULE_EDGE_LIMIT = 4096
export const EXECUTABLE_EXPORT_CHAIN_LIMIT = 64
export const EXECUTABLE_GRAPH_SOURCE_BYTES_LIMIT = 4 * 1024 * 1024
export const EXECUTABLE_GRAPH_NODE_LIMIT = 1_000_000
export const EXECUTABLE_GRAPH_SCOPE_LIMIT = 16_384

function fail(code, message, details = {}) {
  throw new DshDeveloperError(code, message, details)
}

function emptyContextResult(complete = false) {
  return { complete, properties: [], serviceLookups: [], injections: [] }
}

function cloneContextResult(value) {
  return {
    complete: value.complete,
    properties: [...value.properties],
    serviceLookups: [...value.serviceLookups],
    injections: value.injections.map((item) => ({
      complete: item.complete,
      values: [...item.values],
    })),
  }
}

function freezePlain(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freezePlain(child)
  return Object.freeze(value)
}

function createGraphBudget() {
  return {
    limits: {
      sourceBytes: EXECUTABLE_GRAPH_SOURCE_BYTES_LIMIT,
      nodes: EXECUTABLE_GRAPH_NODE_LIMIT,
      scopes: EXECUTABLE_GRAPH_SCOPE_LIMIT,
      edges: EXECUTABLE_MODULE_EDGE_LIMIT,
      modules: EXECUTABLE_MODULE_LIMIT,
    },
    used: { sourceBytes: 0, nodes: 0, scopes: 0, edges: 0, modules: 0 },
    exhausted: new Set(),
  }
}

function consumeBudget(budget, kind, amount = 1) {
  if (budget.used[kind] + amount > budget.limits[kind]) {
    budget.exhausted.add(kind)
    return false
  }
  budget.used[kind] += amount
  return true
}

function budgetReport(budget) {
  return freezePlain({
    limits: { ...budget.limits },
    used: { ...budget.used },
    exhausted: [...budget.exhausted].sort(),
  })
}

function syntaxModes(sourcePath) {
  const extension = typeof sourcePath === 'string' ? posix.extname(sourcePath).toLowerCase() : ''
  if (['.js', '.mjs', '.cjs'].includes(extension)) return [['decorators']]
  if (extension === '.jsx') return [['decorators', 'jsx']]
  if (['.ts', '.mts', '.cts'].includes(extension)) return [['decorators', 'typescript']]
  if (extension === '.tsx') return [['decorators', 'typescript', 'jsx']]
  return [
    ['decorators'],
    ['decorators', 'jsx'],
    ['decorators', 'typescript'],
    ['decorators', 'typescript', 'jsx'],
  ]
}

function parseSource(source, sourcePath) {
  for (const plugins of syntaxModes(sourcePath)) {
    try {
      const ast = parse(source, {
        sourceType: 'unambiguous',
        sourceFilename: typeof sourcePath === 'string' ? sourcePath : undefined,
        plugins,
        errorRecovery: false,
        createImportExpressions: true,
        createParenthesizedExpressions: true,
        allowReturnOutsideFunction: ['.cjs', '.cts'].includes(
          typeof sourcePath === 'string' ? posix.extname(sourcePath).toLowerCase() : '',
        ),
        attachComment: false,
        tokens: false,
      })
      if (!Array.isArray(ast.errors) || ast.errors.length === 0) return ast
    } catch {
      // A known extension has one grammar. Unknown input falls through conservative modes.
    }
  }
  return undefined
}

function isTypePosition(path) {
  let current = path.parentPath
  while (current) {
    if (TYPE_ONLY_DECLARATIONS.has(current.node.type)) return true
    if (typeof current.isTSType === 'function' && current.isTSType()) return true
    if (typeof current.isFlow === 'function' && current.isFlow()) return true
    current = current.parentPath
  }
  return false
}

function bindingIsTypeOnly(binding) {
  let current = binding?.path
  while (current) {
    if (current.node.declare === true) return true
    if (current.isTSImportEqualsDeclaration?.() && current.node.importKind === 'type') return true
    if (current.isImportSpecifier?.() || current.isImportDefaultSpecifier?.()
        || current.isImportNamespaceSpecifier?.()) {
      const declaration = current.findParent((path) => path.isImportDeclaration?.())
      return current.node.importKind === 'type' || current.node.importKind === 'typeof'
        || declaration?.node.importKind === 'type' || declaration?.node.importKind === 'typeof'
    }
    if (TYPE_ONLY_DECLARATIONS.has(current.node.type)) return true
    current = current.parentPath
  }
  return false
}

function runtimeBinding(path, name) {
  const binding = path.scope.getBinding(name)
  return binding && !bindingIsTypeOnly(binding) ? binding : undefined
}

function unwrapExpressionPath(path) {
  let current = path
  while (current?.node && TRANSPARENT_EXPRESSION_TYPES.has(current.node.type)) current = current.get('expression')
  return current
}

function unboundIntrinsicIdentifier(path, name) {
  const value = unwrapExpressionPath(path)
  return value?.isIdentifier?.({ name }) && value.isReferencedIdentifier?.()
    && !runtimeBinding(value, name) ? value : undefined
}

function unwrapExpressionNode(node) {
  let current = node
  while (current && TRANSPARENT_EXPRESSION_TYPES.has(current.type)) current = current.expression
  return current
}

function outwardExpressionPath(path) {
  let current = path
  while (current.parentPath && TRANSPARENT_EXPRESSION_TYPES.has(current.parentPath.node.type)
      && current.parentPath.node.expression === current.node) current = current.parentPath
  return current
}

function nodeName(node) {
  if (node?.type === 'Identifier' || node?.type === 'JSXIdentifier') return node.name
  if (node?.type === 'PrivateName' && node.id?.type === 'Identifier') return node.id.name
  if (node?.type === 'StringLiteral') return node.value
  return undefined
}

function staticString(node) {
  const value = unwrapExpressionNode(node)
  if (value?.type === 'StringLiteral') return value.value
  if (value?.type === 'TemplateLiteral' && value.expressions.length === 0
      && value.quasis.length === 1) {
    return value.quasis[0].value.cooked ?? value.quasis[0].value.raw
  }
  return undefined
}

function nodeWithin(node, container) {
  return Number.isInteger(node?.start) && Number.isInteger(node?.end)
    && Number.isInteger(container?.start) && Number.isInteger(container?.end)
    && container.start <= node.start && node.end <= container.end
}

function firstRuntimeContextParameter(functionPath) {
  const parameters = functionPath.get('params')
  let index = 0
  if (parameters[0]?.isIdentifier?.({ name: 'this' })) index = 1
  const parameter = parameters[index]
  if (parameter?.isIdentifier?.({ name: 'ctx' })) return { index, path: parameter }
  if (parameter?.isAssignmentPattern?.()) {
    const left = parameter.get('left')
    if (left.isIdentifier?.({ name: 'ctx' })) return { index, path: left }
  }
  return undefined
}

function candidateContains(record, node) {
  return nodeWithin(node, record.bodyPath.node)
    || record.laterParameterPaths.some((path) => nodeWithin(node, path.node))
}

function contextReferenceInsideWith(path, record) {
  let current = path.parentPath
  while (current && current.node !== record.path.node) {
    if (current.isWithStatement?.() && nodeWithin(path.node, current.node.body)) return true
    current = current.parentPath
  }
  return false
}

function implicitArgumentsReferenceUnsafe(path) {
  const expression = outwardExpressionPath(path)
  const member = expression.parentPath
  const isMember = member?.isMemberExpression?.() || member?.isOptionalMemberExpression?.()
  if (!isMember || member.node.object !== expression.node) return true
  if (!member.node.computed) return nodeName(member.node.property) !== 'length'
  const name = staticString(member.node.property)
  if (name === 'length') return false
  if (name === '0') return true
  if (typeof name === 'string') return !/^[+-]?(?:0|[1-9][0-9]*)$/u.test(name)
  const property = unwrapExpressionNode(member.node.property)
  if (property?.type === 'NumericLiteral' && Number.isInteger(property.value)) {
    return Object.is(property.value, 0) || Object.is(property.value, -0)
  }
  if (property?.type === 'UnaryExpression' && ['+', '-'].includes(property.operator)
      && property.argument?.type === 'NumericLiteral') {
    const value = property.operator === '-' ? -property.argument.value : property.argument.value
    if (Number.isInteger(value)) return Object.is(value, 0) || Object.is(value, -0)
  }
  return true
}

function candidateMutation(binding) {
  let knownReplacement = false
  let unsafeReplacement = false
  for (const violation of binding.constantViolations) {
    if (violation.isVariableDeclarator?.()) {
      const declaration = violation.parentPath
      const statement = declaration?.parentPath
      const loopAssignment = statement?.isForInStatement?.() || statement?.isForOfStatement?.()
      if (violation.node.init === null && !loopAssignment) continue
      unsafeReplacement = true
      continue
    }
    if (violation.isFunctionDeclaration?.() && violation.node.id?.name === 'ctx') {
      knownReplacement = true
      continue
    }
    unsafeReplacement = true
  }
  return { usable: !knownReplacement && !unsafeReplacement, complete: !unsafeReplacement }
}

function literalStringArray(node) {
  const value = unwrapExpressionNode(node)
  if (value?.type !== 'ArrayExpression') return undefined
  const values = []
  for (const element of value.elements) {
    const literal = unwrapExpressionNode(element)
    if (literal?.type !== 'StringLiteral') return undefined
    values.push(literal.value)
  }
  return values
}

function staticMemberName(path) {
  if (!path.node.computed) return nodeName(path.node.property)
  return staticString(path.node.property)
}

function contextChain(reference) {
  let current = outwardExpressionPath(reference)
  const parts = []
  while (current.parentPath) {
    const member = current.parentPath
    const isMember = member.isMemberExpression?.() || member.isOptionalMemberExpression?.()
      || member.isJSXMemberExpression?.()
    if (!isMember || member.node.object !== current.node) break
    const name = staticMemberName(member)
    if (typeof name !== 'string') return { parts, terminal: member, dynamic: true }
    parts.push({ name, optional: member.node.optional === true })
    current = outwardExpressionPath(member)
  }
  return { parts, terminal: current, dynamic: false }
}

function callOfCallee(path) {
  const callee = outwardExpressionPath(path)
  const call = callee?.parentPath
  return (call?.isCallExpression?.() || call?.isOptionalCallExpression?.())
    && call.node.callee === callee.node ? call : undefined
}

function isAliasEscape(path) {
  const expression = outwardExpressionPath(path)
  const parent = expression.parentPath
  if (!parent) return false
  if (parent.isVariableDeclarator?.() && parent.node.init === expression.node) return true
  if (parent.isAssignmentExpression?.() && parent.node.right === expression.node) return true
  return false
}

function isCatchParameterSelfReference(path) {
  const catchPath = path.findParent((value) => value.isCatchClause?.())
  if (!catchPath) return false
  const parameter = catchPath.get('param')
  if (!parameter?.node || !nodeWithin(path.node, parameter.node)) return false
  return Object.hasOwn(parameter.getBindingIdentifiers(), 'ctx')
}

function exactRawRoute(chain, call) {
  return chain.parts.length === 2 && chain.parts[0].name === 'webServer'
    && chain.parts[1].name === 'register' && Boolean(call)
}

function exactConnectionRoute(chain, call) {
  return chain.parts.length === 3 && chain.parts[0].name === 'connection'
    && chain.parts[1].name === 'rpc' && chain.parts[2].name === 'handle' && Boolean(call)
}

function contextReferenceResult(
  records,
  valueContextPaths,
  candidateByBinding,
  incompleteBindings,
  withContextPaths,
) {
  let complete = true
  const properties = []
  const serviceLookups = []
  const injections = []
  for (const record of records) {
    if (record.candidate && record.mutation.complete !== true) complete = false
  }
  if (incompleteBindings.size > 0) complete = false
  const references = [...valueContextPaths]
    .sort((left, right) => (left.node.start ?? 0) - (right.node.start ?? 0))
  for (const path of references) {
    const binding = runtimeBinding(path, 'ctx')
    if (!binding) {
      complete = false
      continue
    }
    const candidate = candidateByBinding.get(binding)
    if (!candidate?.candidate || !candidate.mutation.usable
        || !candidateContains(candidate, path.node)
        || isCatchParameterSelfReference(path)) continue
    if (withContextPaths.has(path)) {
      complete = false
      continue
    }
    const chain = contextChain(path)
    if (chain.dynamic || chain.parts.length === 0) {
      complete = false
      continue
    }
    const property = chain.parts[0].name
    properties.push(property)
    const call = callOfCallee(chain.terminal)
    if (property === 'get') {
      const value = call && chain.parts.length === 1 && call.node.arguments.length === 1
        ? staticString(call.node.arguments[0]) : undefined
      if (value === undefined) complete = false
      else serviceLookups.push(value)
      continue
    }
    if (property === 'inject') {
      const values = call && chain.parts.length === 1
        ? literalStringArray(call.node.arguments[0]) : undefined
      const declarationComplete = values !== undefined && call.node.arguments.length >= 2
      injections.push({ complete: declarationComplete, values: declarationComplete ? values : [] })
      if (!declarationComplete) complete = false
      continue
    }
    if (property === 'webServer' || property === 'connection') {
      if (!exactRawRoute(chain, call) && !exactConnectionRoute(chain, call)) complete = false
      continue
    }
    if (!call && isAliasEscape(chain.terminal)) complete = false
  }
  return { complete, properties, serviceLookups, injections }
}

function literalObjectFields(node) {
  const value = unwrapExpressionNode(node)
  if (value?.type !== 'ObjectExpression') return {}
  const fields = {}
  for (const property of value.properties) {
    if (property.type !== 'ObjectProperty') continue
    const name = property.computed ? staticString(property.key) : nodeName(property.key)
    const fieldValue = unwrapExpressionNode(property.value)
    if (typeof name === 'string' && fieldValue?.type === 'StringLiteral') fields[name] = fieldValue.value
  }
  return fields
}

function routeSummaries(record, bindingReferences, incompleteBindings, withContextPaths) {
  if (!record.candidate || !record.mutation.usable || !record.binding) {
    return { complete: false, rawRoutes: [], connectionRoutes: [] }
  }
  let complete = record.mutation.complete && !incompleteBindings.has(record.binding)
  const rawRoutes = []
  const connectionRoutes = []
  const references = bindingReferences
    .filter((path) => candidateContains(record, path.node))
    .sort((left, right) => (left.node.start ?? 0) - (right.node.start ?? 0))
  for (const reference of references) {
    if (isCatchParameterSelfReference(reference)) continue
    if (withContextPaths.has(reference)) {
      complete = false
      continue
    }
    if (reference.getFunctionParent()?.node !== record.path.node) continue
    const chain = contextChain(reference)
    if (chain.dynamic || chain.parts.length === 0) {
      complete = false
      continue
    }
    const call = callOfCallee(chain.terminal)
    if (chain.parts[0].name === 'webServer') {
      if (!exactRawRoute(chain, call)) {
        complete = false
        continue
      }
      const fields = literalObjectFields(call.node.arguments[0])
      rawRoutes.push({
        sourcePath: record.sourcePath,
        line: reference.node.loc?.start.line ?? 1,
        call: 'ctx.webServer.register',
        kind: fields.kind,
        routePath: fields.path,
        authBoundary: 'raw-web-server',
        hostAuthentication: 'not-established-by-registration',
        intent: 'review-required',
      })
      continue
    }
    if (chain.parts[0].name === 'connection') {
      if (!exactConnectionRoute(chain, call)) {
        complete = false
        continue
      }
      const route = staticString(call.node.arguments[0])
      connectionRoutes.push({
        sourcePath: record.sourcePath,
        line: reference.node.loc?.start.line ?? 1,
        call: 'ctx.connection.rpc.handle',
        routePath: route,
        authBoundary: 'host-connection',
        hostAuthentication: 'connection-boundary',
        intent: 'authenticated-channel',
      })
    }
  }
  return { complete, rawRoutes, connectionRoutes }
}

function runtimeImportDeclaration(node) {
  if (node.importKind === 'type' || node.importKind === 'typeof') return false
  if (node.specifiers.length === 0) return true
  return node.specifiers.some((specifier) => specifier.importKind !== 'type'
    && specifier.importKind !== 'typeof')
}

function runtimeExportDeclaration(node) {
  if (node.exportKind === 'type') return false
  if (!Array.isArray(node.specifiers) || node.specifiers.length === 0) return true
  return node.specifiers.some((specifier) => specifier.exportKind !== 'type')
}

function tsImportEqualsSource(node) {
  if (node?.type !== 'TSImportEqualsDeclaration' || node.importKind === 'type'
      || node.moduleReference?.type !== 'TSExternalModuleReference') return undefined
  return staticString(node.moduleReference.expression)
}

function importDescriptor(binding) {
  let path = binding?.path
  while (path && !path.isImportSpecifier?.() && !path.isImportDefaultSpecifier?.()
      && !path.isImportNamespaceSpecifier?.()) path = path.parentPath
  if (!path || bindingIsTypeOnly(binding)) return undefined
  const declaration = path.findParent((value) => value.isImportDeclaration?.())
  if (!declaration) return undefined
  if (path.isImportSpecifier?.()) {
    return { kind: 'import', source: declaration.node.source.value, importedName: nodeName(path.node.imported) }
  }
  if (path.isImportDefaultSpecifier?.()) {
    return { kind: 'import', source: declaration.node.source.value, importedName: 'default' }
  }
  return undefined
}

function functionIdForPath(path, recordByNode) {
  const value = unwrapExpressionPath(path)
  return value?.isFunction?.() ? recordByNode.get(value.node)?.id : undefined
}

function functionRecordForBinding(binding, recordByNode) {
  const bindingPath = binding?.path
  if (!bindingPath) return undefined
  if (bindingPath.isFunction?.()) return recordByNode.get(bindingPath.node)
  if (bindingPath.isFunctionDeclaration?.()) return recordByNode.get(bindingPath.node)
  if (bindingPath.isVariableDeclarator?.()) {
    const init = unwrapExpressionPath(bindingPath.get('init'))
    return init?.isFunction?.() ? recordByNode.get(init.node) : undefined
  }
  return undefined
}

function classDescriptorForPath(path, recordByNode) {
  const value = unwrapExpressionPath(path)
  if (!value?.isClass?.()) return undefined
  const record = recordByNode.get(value.node)
  return record?.class
    ? { kind: 'local', functionId: record.id }
    : { kind: 'unresolved' }
}

function classDescriptorForBinding(binding, recordByNode) {
  let path = binding?.path
  if (path?.isIdentifier?.() && path.parentPath?.isClassDeclaration?.()) path = path.parentPath
  if (path?.isClassDeclaration?.() || path?.isClassExpression?.()) {
    return classDescriptorForPath(path, recordByNode)
  }
  if (path?.isVariableDeclarator?.()) return classDescriptorForPath(path.get('init'), recordByNode)
  return undefined
}

function namespaceImportDescriptor(binding, importedName) {
  if (!binding?.path?.isImportNamespaceSpecifier?.() || bindingIsTypeOnly(binding)) return undefined
  const declaration = binding.path.findParent((value) => value.isImportDeclaration?.())
  return declaration ? { kind: 'import', source: declaration.node.source.value, importedName } : undefined
}

function nestedNamespaceDescriptor(path) {
  const names = []
  let current = unwrapExpressionPath(path)
  while (current?.isMemberExpression?.() || current?.isOptionalMemberExpression?.()) {
    const name = staticMemberName(current)
    if (name === undefined) return undefined
    names.unshift(name)
    current = unwrapExpressionPath(current.get('object'))
  }
  if (!current?.isIdentifier?.() || !current.isReferencedIdentifier?.() || names.length < 2) return undefined
  const binding = runtimeBinding(current, current.node.name)
  if (!binding?.path?.isImportNamespaceSpecifier?.() || bindingIsTypeOnly(binding)) return undefined
  const declaration = binding.path.findParent((value) => value.isImportDeclaration?.())
  return declaration ? {
    kind: 'import-member',
    source: declaration.node.source.value,
    memberName: names.join('.'),
  } : undefined
}

function requireMemberDescriptor(binding, memberName) {
  if (!binding?.constant || !binding.path?.isVariableDeclarator?.()) return undefined
  const init = unwrapExpressionPath(binding.path.get('init'))
  if (!init?.isCallExpression?.() || init.node.optional === true || init.node.arguments.length !== 1) return undefined
  const callee = unwrapExpressionPath(init.get('callee'))
  if (!unboundIntrinsicIdentifier(callee, 'require')) return undefined
  const source = staticString(init.node.arguments[0])
  return source === undefined ? { kind: 'unresolved' } : { kind: 'import', source, importedName: memberName }
}

function importedMemberDescriptor(binding, memberName) {
  let path = binding?.path
  while (path && !path.isImportSpecifier?.() && !path.isImportDefaultSpecifier?.()
      && !path.isImportNamespaceSpecifier?.()) path = path.parentPath
  const declaration = path?.findParent((value) => value.isImportDeclaration?.())
  return declaration ? {
    kind: 'import-member',
    source: declaration.node.source.value,
    memberName,
  } : undefined
}

function staticPropertyName(path) {
  const name = path.node.computed ? staticString(path.node.key) : nodeName(path.node.key)
  if (name !== undefined) return name
  if (!path.node.computed) return undefined
  const key = unwrapExpressionPath(path.get('key'))
  if (!key?.isMemberExpression?.() && !key?.isOptionalMemberExpression?.()) return undefined
  const object = unwrapExpressionPath(key.get('object'))
  if (!unboundIntrinsicIdentifier(object, 'Symbol')) return undefined
  const property = staticMemberName(key)
  return typeof property === 'string' ? `Symbol.${property}` : undefined
}

function classPathForBinding(binding) {
  let path = binding?.path
  if (path?.isIdentifier?.() && path.parentPath?.isClassDeclaration?.()) path = path.parentPath
  if (path?.isClassDeclaration?.() || path?.isClassExpression?.()) return path
  if (!path?.isVariableDeclarator?.() || !binding.constant) return undefined
  const init = unwrapExpressionPath(path.get('init'))
  return init?.isClassExpression?.() ? init : undefined
}

function localStructuredValue(path, recordByNode, state = { depth: 0, bindings: new Set() }) {
  if (!path?.node || state.depth >= EXECUTABLE_EXPORT_CHAIN_LIMIT) return { kind: 'opaque' }
  const value = unwrapExpressionPath(path)
  if (value?.isObjectExpression?.()) return { kind: 'object', path: value }
  if (value?.isArrayExpression?.()) return { kind: 'array', path: value }
  if (value?.isClass?.()) return { kind: 'class', path: value, instance: false }
  if (value?.isThisExpression?.()) {
    const classPath = value.findParent((item) => item.isClass?.())
    return classPath ? { kind: 'class', path: classPath, instance: true } : undefined
  }
  if (value?.isNewExpression?.()) {
    const callee = unwrapExpressionPath(value.get('callee'))
    if (unboundIntrinsicIdentifier(callee, 'Proxy')) return { kind: 'opaque' }
    if (callee?.isClassExpression?.()) return { kind: 'class', path: callee, instance: true }
    if (callee?.isIdentifier?.() && callee.isReferencedIdentifier?.()) {
      const classPath = classPathForBinding(runtimeBinding(callee, callee.node.name))
      if (classPath) return { kind: 'class', path: classPath, instance: true }
    }
    return undefined
  }
  if (!value?.isIdentifier?.() || !value.isReferencedIdentifier?.()) return undefined
  const binding = runtimeBinding(value, value.node.name)
  if (!binding) return undefined
  if (state.bindings.has(binding)) return { kind: 'opaque' }
  const classPath = classPathForBinding(binding)
  if (classPath) return { kind: 'class', path: classPath, instance: false }
  if (!binding.constant || !binding.path?.isVariableDeclarator?.()) {
    return undefined
  }
  return localStructuredValue(binding.path.get('init'), recordByNode, {
    depth: state.depth + 1,
    bindings: new Set(state.bindings).add(binding),
  })
}

function methodDescriptor(path, recordByNode) {
  const record = path?.node ? recordByNode.get(path.node) : undefined
  return record ? { kind: 'local', functionId: record.id } : { kind: 'unresolved' }
}

function structuredPropertyDescriptor(structured, name, recordByNode, access = 'call') {
  if (!structured || name === undefined) return undefined
  if (structured.kind === 'opaque') return { kind: 'unresolved' }
  if (structured.kind === 'array') return undefined
  const members = structured.kind === 'object'
    ? structured.path.get('properties') : structured.path.get('body.body')
  const matches = members.filter((member) => {
    if (structured.kind === 'object') {
      if (!member.isObjectProperty?.() && !member.isObjectMethod?.()) return false
    } else {
      if (!member.isClassMethod?.() && !member.isClassPrivateMethod?.()
          && !member.isClassProperty?.() && !member.isClassPrivateProperty?.()) return false
      if ((member.node.static === true) !== !structured.instance) return false
    }
    return staticPropertyName(member) === name
  })
  if (matches.length === 0) return undefined
  if (matches.length !== 1) return { kind: 'unresolved' }
  const member = matches[0]
  const memberKind = member.node.kind ?? 'method'
  if (access === 'get') return memberKind === 'get' ? methodDescriptor(member, recordByNode) : undefined
  if (access === 'set') return memberKind === 'set' ? methodDescriptor(member, recordByNode) : undefined
  if (memberKind === 'get') return { kind: 'unresolved' }
  if (memberKind === 'set') return undefined
  if (member.isObjectMethod?.() || member.isClassMethod?.() || member.isClassPrivateMethod?.()) {
    return methodDescriptor(member, recordByNode)
  }
  return callableDescriptor(member.get('value'), recordByNode, { strict: true })
}

function memberExecutionDescriptor(path, recordByNode, access) {
  const member = unwrapExpressionPath(path)
  if (!member?.isMemberExpression?.() && !member?.isOptionalMemberExpression?.()) return undefined
  const name = staticMemberName(member)
  const structured = localStructuredValue(member.get('object'), recordByNode)
  if (name === undefined) return structured ? { kind: 'unresolved' } : undefined
  return structuredPropertyDescriptor(structured, name, recordByNode, access)
}

function structuredGetterDescriptors(path, recordByNode) {
  const structured = localStructuredValue(path, recordByNode)
  if (!structured) return []
  if (structured.kind === 'opaque') return [{ kind: 'unresolved' }]
  if (structured.kind !== 'object' && structured.kind !== 'class') return []
  const members = structured.kind === 'object'
    ? structured.path.get('properties') : structured.path.get('body.body')
  return members.filter((member) => {
    const method = structured.kind === 'object'
      ? member.isObjectMethod?.() : member.isClassMethod?.() || member.isClassPrivateMethod?.()
    return method && member.node.kind === 'get'
      && (structured.kind !== 'class' || (member.node.static === true) === !structured.instance)
  }).map((member) => methodDescriptor(member, recordByNode))
}

function iterableExecutionDescriptor(path, recordByNode) {
  const structured = localStructuredValue(path, recordByNode)
  if (!structured || structured.kind === 'array') return undefined
  if (structured.kind === 'opaque') return { kind: 'unresolved' }
  return structuredPropertyDescriptor(structured, 'Symbol.iterator', recordByNode, 'call')
}

function thenableExecutionDescriptor(path, recordByNode) {
  const structured = localStructuredValue(path, recordByNode)
  if (!structured || structured.kind === 'array') return undefined
  if (structured.kind === 'opaque') return { kind: 'unresolved' }
  return structuredPropertyDescriptor(structured, 'then', recordByNode, 'call')
}

function objectPropertyValue(path, name) {
  if (!path?.isObjectExpression?.()) return undefined
  for (const property of path.get('properties')) {
    if (!property.isObjectProperty?.() && !property.isObjectMethod?.()) continue
    const propertyName = property.node.computed
      ? staticString(property.node.key) : nodeName(property.node.key)
    if (propertyName !== name) continue
    return property.isObjectMethod?.() ? property : property.get('value')
  }
  return undefined
}

function thisMethodDescriptor(member, name, recordByNode) {
  const object = unwrapExpressionPath(member.get('object'))
  if (!object?.isThisExpression?.()) return undefined
  const classPath = member.findParent((value) => value.isClass?.())
  if (!classPath) return undefined
  const matches = classPath.get('body.body').filter((method) => (
    method.isClassMethod?.() || method.isClassPrivateMethod?.()
  ) && (method.node.computed ? staticString(method.node.key) : nodeName(method.node.key)) === name)
  if (matches.length === 0) return undefined
  if (matches.length !== 1) return { kind: 'unresolved' }
  const record = recordByNode.get(matches[0].node)
  return record ? { kind: 'local', functionId: record.id } : { kind: 'unresolved' }
}

function callableDescriptor(path, recordByNode, options = {}, state = { depth: 0, bindings: new Set() }) {
  if (!path?.node || state.depth >= EXECUTABLE_EXPORT_CHAIN_LIMIT) return { kind: 'unresolved' }
  let callee = unwrapExpressionPath(path)
  if (callee?.isSequenceExpression?.()) {
    const expressions = callee.get('expressions')
    callee = unwrapExpressionPath(expressions.at(-1))
  }
  if (callee?.isFunction?.()) {
    const record = recordByNode.get(callee.node)
    return record ? { kind: 'local', functionId: record.id } : { kind: 'unresolved' }
  }
  const inlineClass = classDescriptorForPath(callee, recordByNode)
  if (inlineClass) return inlineClass
  if (callee?.isConditionalExpression?.() || callee?.isLogicalExpression?.()
      || callee?.isAssignmentExpression?.()) {
    return options.strict ? { kind: 'unresolved' } : undefined
  }
  if (callee?.isCallExpression?.() || callee?.isOptionalCallExpression?.()) {
    if (!options.strict) return undefined
    const inner = callableDescriptor(callee.get('callee'), recordByNode, { strict: true }, state)
    const raw = unwrapExpressionPath(callee.get('callee'))
    const reflectGet = (raw?.isMemberExpression?.() || raw?.isOptionalMemberExpression?.())
      && staticMemberName(raw) === 'get'
      && unboundIntrinsicIdentifier(unwrapExpressionPath(raw.get('object')), 'Reflect')
    return inner || reflectGet ? { kind: 'unresolved' } : undefined
  }
  if (callee?.isNewExpression?.()) {
    return options.strict ? { kind: 'unresolved' } : undefined
  }
  if (callee?.isMemberExpression?.() || callee?.isOptionalMemberExpression?.()) {
    const name = staticMemberName(callee)
    if (name === undefined) return options.strict ? { kind: 'unresolved' } : undefined
    const object = unwrapExpressionPath(callee.get('object'))
    if (['call', 'apply', 'bind'].includes(name)) {
      return callableDescriptor(object, recordByNode, { strict: true }, state)
    }
    const thisMethod = thisMethodDescriptor(callee, name, recordByNode)
    if (thisMethod) return thisMethod
    const nestedNamespace = nestedNamespaceDescriptor(callee)
    if (nestedNamespace) return nestedNamespace
    const structured = localStructuredValue(object, recordByNode, {
        depth: state.depth + 1,
        bindings: state.bindings,
      })
    const structuredMember = structured?.kind === 'opaque' && !options.strict
      ? undefined
      : structuredPropertyDescriptor(structured, name, recordByNode, 'call')
    if (structuredMember) return structuredMember
    const directProperty = objectPropertyValue(object, name)
    if (directProperty) {
      return callableDescriptor(directProperty, recordByNode, { strict: true }, {
        depth: state.depth + 1,
        bindings: state.bindings,
      })
    }
    if (!object?.isIdentifier?.() || !object.isReferencedIdentifier?.()) return undefined
    const binding = runtimeBinding(object, object.node.name)
    if (!binding) return undefined
    const namespaced = namespaceImportDescriptor(binding, name)
    if (namespaced) return namespaced
    const importedMember = importedMemberDescriptor(binding, name)
    if (importedMember) return importedMember
    const requiredMember = requireMemberDescriptor(binding, name)
    if (requiredMember) return requiredMember
    if (state.bindings.has(binding)) return { kind: 'unresolved' }
    if (binding.path?.isVariableDeclarator?.()) {
      const init = unwrapExpressionPath(binding.path.get('init'))
      const property = objectPropertyValue(init, name)
      if (property) {
        if (!binding.constant) return { kind: 'unresolved' }
        return callableDescriptor(property, recordByNode, { strict: true }, {
          depth: state.depth + 1,
          bindings: new Set(state.bindings).add(binding),
        })
      }
      return init?.isObjectExpression?.() ? { kind: 'unresolved' } : undefined
    }
    return undefined
  }
  if (!callee?.isIdentifier?.() || !callee.isReferencedIdentifier?.()) return undefined
  const binding = runtimeBinding(callee, callee.node.name)
  if (!binding) return undefined
  const imported = importDescriptor(binding)
  if (imported) return imported
  if (binding.kind === 'param') return undefined
  if (state.bindings.has(binding)) return { kind: 'unresolved' }
  const classDescriptor = classDescriptorForBinding(binding, recordByNode)
  if (classDescriptor) return binding.constant ? classDescriptor : { kind: 'unresolved' }
  const record = functionRecordForBinding(binding, recordByNode)
  if (record) return binding.constant
    ? { kind: 'local', functionId: record.id } : { kind: 'unresolved' }
  if (binding.path?.isVariableDeclarator?.()) {
    const init = unwrapExpressionPath(binding.path.get('init'))
    if (!init?.node) {
      const declaration = binding.path.parentPath
      const statement = declaration?.parentPath
      if (statement?.isForInStatement?.() || statement?.isForOfStatement?.()) return undefined
      return options.strict ? { kind: 'unresolved' } : undefined
    }
    if (!binding.constant) return { kind: 'unresolved' }
    const descriptor = callableDescriptor(init, recordByNode, options, {
      depth: state.depth + 1,
      bindings: new Set(state.bindings).add(binding),
    })
    if (init.isCallExpression?.() || init.isOptionalCallExpression?.()) return descriptor
    if (init.isMemberExpression?.() || init.isOptionalMemberExpression?.()) return descriptor
    return descriptor ?? (options.strict ? { kind: 'unresolved' } : undefined)
  }
  return undefined
}

function edgeExecutionOwner(path, recordByNode) {
  const owner = path.getFunctionParent?.()
  const record = owner ? recordByNode.get(owner.node) : undefined
  return record ? { topLevel: false, functionId: record.id } : { topLevel: true }
}

function parameterIndexForReference(path, record) {
  let value = unwrapExpressionPath(path)
  if (value?.isSequenceExpression?.()) {
    const expressions = value.get('expressions')
    value = unwrapExpressionPath(expressions.at(-1))
  }
  if (!value?.isIdentifier?.() || !value.isReferencedIdentifier?.()) return undefined
  const binding = runtimeBinding(value, value.node.name)
  if (!binding || binding.kind !== 'param') return undefined
  const parameters = record.path.get('params')
  for (let index = 0; index < parameters.length; index += 1) {
    if (Object.values(parameters[index].getBindingIdentifiers()).some(
      (identifier) => identifier === binding.identifier,
    )) return index
  }
  return undefined
}

function argumentCallableDescriptors(
  path,
  recordByNode,
  state = { depth: 0, nested: false, bindings: new Set() },
) {
  if (!path?.node || state.depth >= EXECUTABLE_EXPORT_CHAIN_LIMIT) {
    return state.nested ? [{ descriptor: { kind: 'unresolved' }, nested: true }] : []
  }
  const value = unwrapExpressionPath(path)
  const direct = callableDescriptor(value, recordByNode)
  if (direct) return [{ descriptor: direct, nested: state.nested }]
  const children = []
  if (value.isObjectExpression?.()) {
    for (const property of value.get('properties')) {
      if (property.isSpreadElement?.()) continue
      if (property.isObjectMethod?.()) {
        children.push({ descriptor: methodDescriptor(property, recordByNode), nested: true })
      } else if (property.isObjectProperty?.()) {
        children.push(...argumentCallableDescriptors(property.get('value'), recordByNode, {
          depth: state.depth + 1,
          nested: true,
          bindings: state.bindings,
        }))
      }
    }
    return children
  }
  if (value.isArrayExpression?.()) {
    for (const element of value.get('elements')) {
      if (!element?.node || element.isSpreadElement?.()) continue
      children.push(...argumentCallableDescriptors(element, recordByNode, {
        depth: state.depth + 1,
        nested: true,
        bindings: state.bindings,
      }))
    }
    return children
  }
  if (value.isIdentifier?.() && value.isReferencedIdentifier?.()) {
    const binding = runtimeBinding(value, value.node.name)
    if (binding?.constant && binding.path?.isVariableDeclarator?.()
        && !state.bindings.has(binding)) {
      const init = unwrapExpressionPath(binding.path.get('init'))
      if (init?.isObjectExpression?.() || init?.isArrayExpression?.()) {
        return argumentCallableDescriptors(init, recordByNode, {
          depth: state.depth + 1,
          nested: true,
          bindings: new Set(state.bindings).add(binding),
        })
      }
    }
  }
  return []
}

function staticallyUndefined(path) {
  const value = unwrapExpressionPath(path)
  return unboundIntrinsicIdentifier(value, 'undefined')
    || (value?.isUnaryExpression?.({ operator: 'void' }))
}

function createCallCollector(budget) {
  return { budget, keys: new Set(), overflow: false }
}

function addDescriptor(collector, owner, target, descriptor) {
  if (!descriptor) return
  const key = owner + '\0' + JSON.stringify(descriptor)
  if (collector.keys.has(key)) return
  if (!consumeBudget(collector.budget, 'edges')) {
    collector.overflow = true
    return
  }
  collector.keys.add(key)
  target.push(descriptor)
}

function addCallSite(collector, owner, target, site) {
  if (site.callbacks.length === 0) return
  const key = owner + '\0site\0' + JSON.stringify(site)
  if (collector.keys.has(key)) return
  if (!consumeBudget(collector.budget, 'edges')) {
    collector.overflow = true
    return
  }
  collector.keys.add(key)
  target.push(site)
}

function callEvidence(descriptor, path) {
  return descriptor?.kind === 'unresolved'
    ? { ...descriptor, line: path.node.loc?.start.line ?? 1, shape: path.node.type }
    : descriptor
}

function literalInjectValues(node) {
  const value = unwrapExpressionNode(node)
  if (value?.type === 'ArrayExpression') {
    const services = literalStringArray(value)
    return services?.map((service) => ({ service, requirement: 'required' }))
  }
  if (value?.type !== 'ObjectExpression') return undefined
  const values = []
  const seen = new Set()
  for (const property of value.properties) {
    if (property.type !== 'ObjectProperty' || property.method || property.shorthand) return undefined
    const name = property.computed ? staticString(property.key) : nodeName(property.key)
    if (!['required', 'optional'].includes(name) || seen.has(name)) return undefined
    seen.add(name)
    const services = literalStringArray(property.value)
    if (!services) return undefined
    for (const service of services) values.push({ service, requirement: name })
  }
  return values
}

function exportSpecifierReference(path) {
  return path.parentPath?.isExportSpecifier?.() && path.parentPath.node.local === path.node
}

function variableDeclarator(binding) {
  let path = binding?.path
  if (path?.isIdentifier?.() && path.parentPath?.isVariableDeclarator?.()
      && path.parentPath.node.id === path.node) path = path.parentPath
  return path?.isVariableDeclarator?.() ? path : undefined
}

function directExportDeclarationReference(path, binding) {
  const declaration = variableDeclarator(binding)?.parentPath
  return path.isExportNamedDeclaration?.() && declaration?.parentPath?.node === path.node
    && path.node.declaration === declaration.node
}

function injectDescriptorForBinding(binding, allowedReference, state) {
  if (!binding || bindingIsTypeOnly(binding) || !binding.constant
      || state.depth >= EXECUTABLE_EXPORT_CHAIN_LIMIT
      || state.seen.has(binding)) return undefined
  const declaration = variableDeclarator(binding)
  if (!declaration || declaration.parentPath?.node.kind !== 'const') return undefined
  for (const reference of binding.referencePaths) {
    if (reference.node === allowedReference?.node || exportSpecifierReference(reference)
        || directExportDeclarationReference(reference, binding)) continue
    return undefined
  }
  const init = unwrapExpressionPath(declaration.get('init'))
  if (!init?.node) return undefined
  const values = literalInjectValues(init.node)
  if (values) return { kind: 'inject-literal', values }
  if (!init.isIdentifier?.()) return undefined
  const target = runtimeBinding(init, init.node.name)
  return injectDescriptorForBinding(target, init, {
    depth: state.depth + 1,
    seen: new Set(state.seen).add(binding),
  })
}

function localExportDescriptor(programPath, localName, recordByNode, exportName) {
  const binding = programPath.scope.getBinding(localName)
  if (!binding || bindingIsTypeOnly(binding) || !binding.constant) return { kind: 'unresolved' }
  const imported = importDescriptor(binding)
  if (imported) {
    if (exportName === 'inject' && binding.referencePaths.some(
      (reference) => !exportSpecifierReference(reference) && !isTypePosition(reference),
    )) return { kind: 'unresolved' }
    return imported
  }
  const classDescriptor = classDescriptorForBinding(binding, recordByNode)
  if (classDescriptor?.kind === 'local') {
    return { kind: 'class', constructorFunctionId: classDescriptor.functionId }
  }
  let bindingPath = binding.path
  if (bindingPath.isIdentifier?.() && bindingPath.parentPath?.isFunctionDeclaration?.()) {
    bindingPath = bindingPath.parentPath
  }
  let functionId
  if (bindingPath.isFunctionDeclaration?.()) functionId = recordByNode.get(bindingPath.node)?.id
  else if (bindingPath.isVariableDeclarator?.()) {
    functionId = functionIdForPath(bindingPath.get('init'), recordByNode)
  }
  if (functionId) return { kind: 'function', functionId }
  const injectDescriptor = injectDescriptorForBinding(binding, undefined, {
    depth: 0,
    seen: new Set(),
  })
  if (injectDescriptor) return injectDescriptor
  const declaration = variableDeclarator(binding)
  const initializer = declaration ? unwrapExpressionPath(declaration.get('init')) : undefined
  if (initializer?.isLiteral?.() || initializer?.isObjectExpression?.()
      || initializer?.isArrayExpression?.()) return { kind: 'non-callable-value' }
  return { kind: 'unresolved' }
}

function addExport(exportCollector, name, descriptor) {
  if (typeof name !== 'string') return
  const existing = exportCollector.byName.get(name)
  if (existing) existing.descriptors.push(descriptor)
  else {
    const item = { name, descriptors: [descriptor] }
    exportCollector.byName.set(name, item)
    exportCollector.items.push(item)
  }
}

function createEdgeCollector(budget) {
  return { budget, items: [], byKey: new Map(), overflow: false }
}

function addEdge(collector, kind, specifier, execution = { topLevel: true }) {
  if (typeof specifier !== 'string') return true
  const key = `${kind}\0${specifier}`
  const existing = collector.byKey.get(key)
  if (existing) {
    if (execution.topLevel) existing.topLevel = true
    if (typeof execution.functionId === 'string'
        && !existing.functionIds.includes(execution.functionId)) {
      existing.functionIds.push(execution.functionId)
      existing.functionIds.sort()
    }
    return true
  }
  if (!consumeBudget(collector.budget, 'edges')) {
    collector.overflow = true
    return false
  }
  const edge = {
    kind,
    specifier,
    topLevel: execution.topLevel === true,
    functionIds: typeof execution.functionId === 'string' ? [execution.functionId] : [],
  }
  collector.byKey.set(key, edge)
  collector.items.push(edge)
  return true
}

function exactCreateRequireResolveReference(reference) {
  const callee = outwardExpressionPath(reference)
  const createCall = callee.parentPath
  if (!createCall?.isCallExpression?.() || createCall.node.optional === true
      || createCall.node.callee !== callee.node || createCall.node.arguments.length !== 1) return false
  const createdLoader = outwardExpressionPath(createCall)
  const member = createdLoader.parentPath
  const isMember = member?.isMemberExpression?.() || member?.isOptionalMemberExpression?.()
  if (!isMember || member.node.optional === true || member.node.object !== createdLoader.node
      || staticMemberName(member) !== 'resolve') return false
  const resolver = outwardExpressionPath(member)
  const resolveCall = resolver.parentPath
  return resolveCall?.isCallExpression?.() && resolveCall.node.optional !== true
    && resolveCall.node.callee === resolver.node && resolveCall.node.arguments.length >= 1
}

function safeNodeModuleImport(path) {
  if (!['module', 'node:module'].includes(path.node.source.value)
      || !runtimeImportDeclaration(path.node) || path.node.specifiers.length === 0) return false
  for (const specifier of path.get('specifiers')) {
    if (specifier.node.importKind === 'type' || specifier.node.importKind === 'typeof') continue
    if (!specifier.isImportSpecifier?.()) return false
    const importedName = nodeName(specifier.node.imported)
    if (importedName === 'builtinModules') continue
    if (importedName !== 'createRequire') return false
    const localName = specifier.node.local?.name
    const binding = typeof localName === 'string' ? path.scope.getBinding(localName) : undefined
    if (!binding || bindingIsTypeOnly(binding) || binding.referencePaths.length === 0
        || binding.referencePaths.some((reference) => !exactCreateRequireResolveReference(reference))) {
      return false
    }
  }
  return true
}

function declarationExportNames(path) {
  if (TYPE_ONLY_DECLARATIONS.has(path.node.type)
      || (path.isFunction?.() && !path.node.body)) return []
  if (path.isVariableDeclaration?.()) return Object.keys(path.getBindingIdentifiers())
  const name = path.node.id?.name
  return typeof name === 'string' ? [name] : []
}

function programMetadata(
  programPath,
  recordByNode,
  edgeCollector,
  requirePaths,
  modulePaths,
  exportsPaths,
  processPaths,
) {
  const exportCollector = { items: [], byName: new Map() }
  let hasRuntimeStarExport = false
  let exportComplete = true
  let moduleClosureComplete = true
  let topLevelClosureComplete = true
  const opaqueFunctionIds = new Set()
  let commonJsExportSurface = exportsPaths.length > 0
  const markOpaque = (path) => {
    moduleClosureComplete = false
    const owner = edgeExecutionOwner(path, recordByNode)
    if (owner.topLevel) topLevelClosureComplete = false
    else opaqueFunctionIds.add(owner.functionId)
  }
  for (const path of programPath.get('body')) {
    if (path.isTSImportEqualsDeclaration?.()) {
      const source = tsImportEqualsSource(path.node)
      if (source !== undefined && !addEdge(edgeCollector, 'import-equals', source)) break
      continue
    }
    if (path.isImportDeclaration?.()) {
      if (runtimeImportDeclaration(path.node) && !safeNodeModuleImport(path)
          && !addEdge(edgeCollector, 'import', path.node.source.value)) break
      continue
    }
    if (path.isExportAllDeclaration?.()) {
      if (path.node.exportKind !== 'type') {
        if (!addEdge(edgeCollector, 'reexport', path.node.source.value)) break
        hasRuntimeStarExport = true
        exportComplete = false
      }
      continue
    }
    if (path.isExportDefaultDeclaration?.()) {
      const declaration = path.get('declaration')
      const functionId = functionIdForPath(declaration, recordByNode)
      if (functionId) addExport(exportCollector, 'default', { kind: 'function', functionId })
      else if (declaration.isIdentifier?.()) {
        addExport(exportCollector, 'default', localExportDescriptor(
          programPath, declaration.node.name, recordByNode, 'default',
        ))
      } else addExport(exportCollector, 'default', { kind: 'unresolved' })
      continue
    }
    if (!path.isExportNamedDeclaration?.() || path.node.exportKind === 'type') continue
    const declaration = path.get('declaration')
    if (declaration?.node) {
      const source = tsImportEqualsSource(declaration.node)
      if (source !== undefined && !addEdge(edgeCollector, 'import-equals', source)) break
      for (const name of declarationExportNames(declaration)) {
        addExport(exportCollector, name, localExportDescriptor(
          programPath, name, recordByNode, name,
        ))
      }
    }
    if (path.node.source && runtimeExportDeclaration(path.node)) {
      if (!addEdge(edgeCollector, 'reexport', path.node.source.value)) break
    }
    for (const specifierPath of path.get('specifiers')) {
      if (specifierPath.node.exportKind === 'type') continue
      const exportedName = nodeName(specifierPath.node.exported)
      if (specifierPath.isExportSpecifier?.()) {
        const localName = nodeName(specifierPath.node.local)
        addExport(exportCollector, exportedName, path.node.source
          ? { kind: 'reexport', source: path.node.source.value, importedName: localName }
          : localExportDescriptor(programPath, localName, recordByNode, exportedName))
      } else addExport(exportCollector, exportedName, { kind: 'unresolved' })
    }
  }
  for (const path of requirePaths) {
    const reference = outwardExpressionPath(path)
    const member = reference.parentPath
    const isMember = member?.isMemberExpression?.() || member?.isOptionalMemberExpression?.()
    if (isMember && member.node.object === reference.node && staticMemberName(member) === 'resolve') {
      const terminal = outwardExpressionPath(member)
      const resolveCall = terminal.parentPath
      const exactResolve = resolveCall?.isCallExpression?.()
        && resolveCall.node.optional !== true && resolveCall.node.callee === terminal.node
        && resolveCall.node.arguments.length === 1
        && staticString(resolveCall.node.arguments[0]) !== undefined
      if (exactResolve) continue
    }
    const call = reference.parentPath
    const exactCall = call?.isCallExpression?.() && call.node.callee === reference.node
      && call.node.optional !== true && call.node.arguments.length === 1
    const source = exactCall ? staticString(call.node.arguments[0]) : undefined
    if (source === undefined) markOpaque(path)
    else if (!addEdge(edgeCollector, 'require', source,
      edgeExecutionOwner(path, recordByNode))) break
  }
  for (const path of modulePaths) {
    const reference = outwardExpressionPath(path)
    const member = reference.parentPath
    const isMember = member?.isMemberExpression?.() || member?.isOptionalMemberExpression?.()
    if (!isMember || member.node.object !== reference.node) {
      markOpaque(path)
      continue
    }
    const name = staticMemberName(member)
    if (name === undefined) {
      markOpaque(path)
      continue
    }
    if (name === 'exports') {
      commonJsExportSurface = true
      continue
    }
    if (name === 'constructor') {
      markOpaque(path)
      continue
    }
    if (name !== 'require') continue
    const terminal = outwardExpressionPath(member)
    const call = terminal.parentPath
    const exactCall = (call?.isCallExpression?.() || call?.isOptionalCallExpression?.())
      && call.node.callee === terminal.node && call.node.arguments.length === 1
    const source = exactCall ? staticString(call.node.arguments[0]) : undefined
    if (source === undefined) markOpaque(path)
    else if (!addEdge(edgeCollector, 'module-require', source,
      edgeExecutionOwner(path, recordByNode))) break
  }
  for (const path of processPaths) {
    const reference = outwardExpressionPath(path)
    const member = reference.parentPath
    const isMember = member?.isMemberExpression?.() || member?.isOptionalMemberExpression?.()
    if (!isMember || member.node.object !== reference.node) continue
    const name = staticMemberName(member)
    if (name === 'mainModule') {
      markOpaque(path)
      continue
    }
    if (name !== 'getBuiltinModule') continue
    const terminal = outwardExpressionPath(member)
    const call = terminal.parentPath
    const exactCall = (call?.isCallExpression?.() || call?.isOptionalCallExpression?.())
      && call.node.callee === terminal.node && call.node.arguments.length === 1
    const source = exactCall ? staticString(call.node.arguments[0]) : undefined
    if (!exactCall || source === undefined || source === 'module' || source === 'node:module') {
      markOpaque(path)
    }
  }
  for (const edge of edgeCollector.items.filter((item) => item.specifier === 'module'
      || item.specifier === 'node:module')) {
    moduleClosureComplete = false
    if (edge.topLevel) topLevelClosureComplete = false
    for (const functionId of edge.functionIds) opaqueFunctionIds.add(functionId)
  }
  return {
    complete: exportComplete && moduleClosureComplete && !edgeCollector.overflow,
    moduleClosureComplete: moduleClosureComplete && !edgeCollector.overflow,
    topLevelClosureComplete: topLevelClosureComplete && !edgeCollector.overflow,
    opaqueFunctionIds: [...opaqueFunctionIds].sort(),
    edges: edgeCollector.items,
    exportsByName: exportCollector.items,
    hasRuntimeStarExport,
    commonJsExportSurface,
  }
}

function commonJsExtension(sourcePath) {
  return ['.cjs', '.cts'].includes(
    typeof sourcePath === 'string' ? posix.extname(sourcePath).toLowerCase() : '',
  )
}

function incompleteMetadata(sourcePath, counts = {}) {
  return freezePlain({
    sourcePath,
    parsed: false,
    complete: false,
    moduleClosureComplete: false,
    activationClosureComplete: false,
    context: emptyContextResult(false),
    moduleEdges: [],
    exports: [],
    hasRuntimeStarExport: false,
    commonJsExportSurface: commonJsExtension(sourcePath),
    topLevelCalls: [],
    topLevelCallSites: [],
    functions: [],
    counts: {
      sourceBytes: counts.sourceBytes ?? 0,
      nodes: counts.nodes ?? 0,
      scopes: counts.scopes ?? 0,
      edges: counts.edges ?? 0,
    },
  })
}

function analyzeSource(source, sourcePath, budget = createGraphBudget()) {
  if (typeof source !== 'string') return incompleteMetadata(sourcePath)
  const sourceBytes = Buffer.byteLength(source, 'utf8')
  if (!consumeBudget(budget, 'sourceBytes', sourceBytes)
      || sourceBytes > EXECUTABLE_SOURCE_BYTES_LIMIT) {
    return incompleteMetadata(sourcePath, { sourceBytes })
  }
  const ast = parseSource(source, sourcePath)
  if (!ast) return incompleteMetadata(sourcePath, { sourceBytes })
  const functionRecords = []
  const classRecords = []
  const recordByNode = new WeakMap()
  const valueContextPaths = []
  const edgeCollector = createEdgeCollector(budget)
  const callCollector = createCallCollector(budget)
  const requirePaths = []
  const modulePaths = []
  const exportsPaths = []
  const processPaths = []
  const directEvalPaths = []
  const implicitArgumentsPaths = []
  const closureOpaquePaths = []
  const dynamicImportPaths = []
  const activationCallPaths = []
  const activationTaggedPaths = []
  const activationMemberPaths = []
  const activationAssignmentPaths = []
  const activationPatternPaths = []
  const activationSpreadPaths = []
  const activationAwaitPaths = []
  const activationIteratorPaths = []
  const scopes = new WeakSet()
  let scopeCount = 0
  let nodeCount = 0
  let depth = 0
  let bounded = true
  let closureComplete = true
  let programPath
  try {
    traverse(ast, {
      enter(path) {
        depth += 1
        nodeCount += 1
        if (!consumeBudget(budget, 'nodes')) bounded = false
        if (path.scope && !scopes.has(path.scope)) {
          scopes.add(path.scope)
          scopeCount += 1
          if (!consumeBudget(budget, 'scopes')) bounded = false
        }
        if (depth > EXECUTABLE_SOURCE_NESTING_LIMIT
            || nodeCount > EXECUTABLE_SOURCE_NODE_LIMIT
            || scopeCount > EXECUTABLE_SOURCE_SCOPE_LIMIT || !bounded) {
          bounded = false
          path.stop()
          return
        }
        if (path.isProgram?.()) programPath = path
        if (path.isClass?.()) {
          const constructor = path.get('body.body').find((member) => (
            member.isClassMethod?.() || member.isClassPrivateMethod?.()
          ) && member.node.kind === 'constructor')
          const record = {
            id: `class:${path.node.start ?? nodeCount}:${path.node.end ?? nodeCount}`,
            class: true,
            path,
            constructorNode: constructor?.node,
          }
          classRecords.push(record)
          recordByNode.set(path.node, record)
        }
        if (path.isFunction?.() && path.get('body')?.node) {
          const contextParameter = firstRuntimeContextParameter(path)
          const record = {
            id: `function:${path.node.start ?? nodeCount}:${path.node.end ?? nodeCount}`,
            sourcePath,
            path,
            bodyPath: path.get('body'),
            directParameter: contextParameter?.path,
            laterParameterPaths: contextParameter
              ? path.get('params').slice(contextParameter.index + 1) : [],
            candidate: false,
            mutation: { usable: true, complete: true },
          }
          functionRecords.push(record)
          recordByNode.set(path.node, record)
        }
        const ordinaryContext = path.isIdentifier?.({ name: 'ctx' })
          && path.isReferencedIdentifier?.() && !isTypePosition(path)
        const jsxContext = path.isJSXIdentifier?.({ name: 'ctx' })
          && path.parentPath?.isJSXMemberExpression?.()
          && path.parentPath.node.object === path.node
        if (ordinaryContext || jsxContext) valueContextPaths.push(path)
        if (path.isIdentifier?.({ name: 'require' }) && path.isReferencedIdentifier?.()
            && !isTypePosition(path) && !runtimeBinding(path, 'require')) requirePaths.push(path)
        if (path.isIdentifier?.({ name: 'module' }) && path.isReferencedIdentifier?.()
            && !isTypePosition(path) && !runtimeBinding(path, 'module')) modulePaths.push(path)
        if (path.isIdentifier?.({ name: 'exports' }) && path.isReferencedIdentifier?.()
            && !isTypePosition(path) && !runtimeBinding(path, 'exports')) exportsPaths.push(path)
        if (path.isIdentifier?.({ name: 'process' }) && path.isReferencedIdentifier?.()
            && !isTypePosition(path) && !runtimeBinding(path, 'process')) processPaths.push(path)
        if (path.isIdentifier?.() && ['eval', 'Function'].includes(path.node.name)
            && path.isReferencedIdentifier?.() && !isTypePosition(path)
            && !runtimeBinding(path, path.node.name)) {
          closureComplete = false
          closureOpaquePaths.push(path)
        }
        if (path.isIdentifier?.() && ['globalThis', 'global'].includes(path.node.name)
            && path.isReferencedIdentifier?.() && !isTypePosition(path)
            && !runtimeBinding(path, path.node.name)) {
          const base = outwardExpressionPath(path)
          const member = base.parentPath
          const isMember = member?.isMemberExpression?.() || member?.isOptionalMemberExpression?.()
          if (isMember && member.node.object === base.node
              && ['eval', 'Function'].includes(staticMemberName(member))) {
            closureComplete = false
            closureOpaquePaths.push(member)
          }
        }
        if (path.isIdentifier?.({ name: 'arguments' }) && path.isReferencedIdentifier?.()
            && !isTypePosition(path) && !runtimeBinding(path, 'arguments')
            && implicitArgumentsReferenceUnsafe(path)) {
          implicitArgumentsPaths.push(path)
        }
        if (path.isImportExpression?.()) {
          const sourceValue = staticString(path.node.source)
          dynamicImportPaths.push({ path, source: sourceValue })
          if (sourceValue === undefined) closureComplete = false
        }
        if (path.isTaggedTemplateExpression?.()) activationTaggedPaths.push(path)
        if (path.isMemberExpression?.() || path.isOptionalMemberExpression?.()) {
          activationMemberPaths.push(path)
        }
        if (path.isAssignmentExpression?.() || path.isUpdateExpression?.()) {
          activationAssignmentPaths.push(path)
        }
        if (path.isVariableDeclarator?.() || path.isAssignmentExpression?.()) {
          activationPatternPaths.push(path)
        }
        if (path.isSpreadElement?.()) activationSpreadPaths.push(path)
        if (path.isAwaitExpression?.()) activationAwaitPaths.push(path)
        if (path.isForOfStatement?.() || (path.isYieldExpression?.() && path.node.delegate === true)) {
          activationIteratorPaths.push(path)
        }
        if (path.isNewExpression?.()) {
          activationCallPaths.push(path)
          return
        }
        if (!path.isCallExpression?.() && !path.isOptionalCallExpression?.()) return
        activationCallPaths.push(path)
        const rawCallee = path.get('callee')
        const directEval = path.isCallExpression?.() && path.node.optional !== true
          ? unboundIntrinsicIdentifier(rawCallee, 'eval') : undefined
        if (directEval) directEvalPaths.push(directEval)
        if (rawCallee.isImport?.()) {
          const sourceValue = path.node.arguments.length === 1
            ? staticString(path.node.arguments[0]) : undefined
          dynamicImportPaths.push({ path, source: sourceValue })
          if (sourceValue === undefined) closureComplete = false
        }
      },
      exit() {
        depth -= 1
      },
    })
  } catch {
    bounded = false
  }
  if (!bounded || !programPath) {
    return incompleteMetadata(sourcePath, { sourceBytes, nodes: nodeCount, scopes: scopeCount })
  }

  for (const record of functionRecords) {
    if (!record.directParameter) continue
    let activeCandidate = false
    let ancestor = record.path.getFunctionParent()
    while (ancestor) {
      const ancestorRecord = recordByNode.get(ancestor.node)
      if (ancestorRecord?.candidate && candidateContains(ancestorRecord, record.path.node)) {
        activeCandidate = true
        break
      }
      ancestor = ancestor.getFunctionParent()
    }
    if (activeCandidate) continue
    const binding = record.path.scope.getBinding('ctx')
    if (!binding || binding.identifier !== record.directParameter.node || bindingIsTypeOnly(binding)) continue
    record.candidate = true
    record.binding = binding
    record.mutation = candidateMutation(binding)
  }
  const candidateByBinding = new Map(functionRecords
    .filter((record) => record.candidate && record.binding)
    .map((record) => [record.binding, record]))
  let topLevelClosureComplete = true
  const opaqueFunctionIds = new Set()
  const markOpaque = (path) => {
    const owner = edgeExecutionOwner(path, recordByNode)
    if (owner.topLevel) topLevelClosureComplete = false
    else opaqueFunctionIds.add(owner.functionId)
  }
  for (const path of closureOpaquePaths) {
    markOpaque(path)
  }
  for (const item of dynamicImportPaths) {
    if (item.source === undefined) {
      markOpaque(item.path)
      continue
    }
    if (!addEdge(edgeCollector, 'dynamic-import', item.source,
      edgeExecutionOwner(item.path, recordByNode))) {
      return incompleteMetadata(sourcePath, { sourceBytes, nodes: nodeCount, scopes: scopeCount })
    }
  }
  const executableRecords = [...functionRecords, ...classRecords]
  const callsByFunction = new Map(executableRecords.map((record) => [record.id, []]))
  const callSitesByFunction = new Map(functionRecords.map((record) => [record.id, []]))
  const eagerParametersByFunction = new Map(functionRecords.map((record) => [record.id, new Set()]))
  const defaultCallbacksByFunction = new Map(functionRecords.map((record) => [record.id, []]))
  const topLevelCalls = []
  const topLevelCallSites = []
  for (const path of activationCallPaths) {
    const descriptor = callEvidence(
      callableDescriptor(path.get('callee'), recordByNode, { strict: true }),
      path.get('callee'),
    )
    const owner = path.getFunctionParent?.()
    const ownerRecord = owner ? recordByNode.get(owner.node) : undefined
    const callbacks = []
    for (const [index, argument] of path.get('arguments').entries()) {
      if (ownerRecord) {
        const parameterIndex = parameterIndexForReference(argument, ownerRecord)
        if (parameterIndex !== undefined) eagerParametersByFunction.get(ownerRecord.id).add(parameterIndex)
      }
      for (const callback of argumentCallableDescriptors(argument, recordByNode)) {
        callbacks.push({
          index,
          descriptor: callEvidence(callback.descriptor, argument),
          nested: callback.nested,
        })
      }
    }
    if (ownerRecord) {
      const calls = callsByFunction.get(ownerRecord.id)
      addDescriptor(callCollector, ownerRecord.id, calls, descriptor)
      const calleeParameter = parameterIndexForReference(path.get('callee'), ownerRecord)
      if (calleeParameter !== undefined) eagerParametersByFunction.get(ownerRecord.id).add(calleeParameter)
      addCallSite(callCollector, ownerRecord.id, callSitesByFunction.get(ownerRecord.id), {
        callee: descriptor ?? null,
        callbacks,
        argumentCount: path.node.arguments.length,
        undefinedArguments: path.get('arguments').flatMap(
          (argument, index) => staticallyUndefined(argument) ? [index] : [],
        ),
      })
    } else {
      addDescriptor(callCollector, 'top-level', topLevelCalls, descriptor)
      addCallSite(callCollector, 'top-level', topLevelCallSites, {
        callee: descriptor ?? null,
        callbacks,
        argumentCount: path.node.arguments.length,
        undefinedArguments: path.get('arguments').flatMap(
          (argument, index) => staticallyUndefined(argument) ? [index] : [],
        ),
      })
    }
  }
  for (const record of functionRecords) {
    for (const [index, parameter] of record.path.get('params').entries()) {
      if (!parameter.isAssignmentPattern?.()) continue
      for (const callback of argumentCallableDescriptors(parameter.get('right'), recordByNode)) {
        const value = {
          index,
          descriptor: callEvidence(callback.descriptor, parameter.get('right')),
        }
        defaultCallbacksByFunction.get(record.id).push(value)
        if (eagerParametersByFunction.get(record.id).has(index)) {
          addDescriptor(callCollector, record.id, callsByFunction.get(record.id), value.descriptor)
        }
      }
    }
  }
  const addExecution = (path, descriptor) => {
    if (!descriptor) return
    const owner = path.getFunctionParent?.()
    const record = owner ? recordByNode.get(owner.node) : undefined
    addDescriptor(
      callCollector,
      record?.id ?? 'top-level',
      record ? callsByFunction.get(record.id) : topLevelCalls,
      callEvidence(descriptor, path),
    )
  }
  for (const path of activationMemberPaths) {
    const outward = outwardExpressionPath(path)
    const parent = outward.parentPath
    const simpleWrite = parent?.isAssignmentExpression?.({ operator: '=' })
      && parent.node.left === outward.node
    if (!simpleWrite) addExecution(path, memberExecutionDescriptor(path, recordByNode, 'get'))
  }
  for (const path of activationAssignmentPaths) {
    const target = path.isUpdateExpression?.() ? path.get('argument') : path.get('left')
    addExecution(target, memberExecutionDescriptor(target, recordByNode, 'set'))
  }
  const addPatternReads = (pattern, source, anchor, nesting = 0) => {
    if (!pattern?.node || !source?.node || nesting >= EXECUTABLE_EXPORT_CHAIN_LIMIT) {
      addExecution(anchor, { kind: 'unresolved' })
      return
    }
    if (pattern.isAssignmentPattern?.()) {
      addPatternReads(pattern.get('left'), source, anchor, nesting + 1)
      return
    }
    if (pattern.isObjectPattern?.()) {
      const structured = localStructuredValue(source, recordByNode)
      for (const property of pattern.get('properties')) {
        if (property.isRestElement?.()) {
          for (const descriptor of structuredGetterDescriptors(source, recordByNode)) {
            addExecution(anchor, descriptor)
          }
          continue
        }
        if (!property.isObjectProperty?.()) continue
        const name = staticPropertyName(property)
        if (name === undefined) {
          if (structured) addExecution(anchor, { kind: 'unresolved' })
          continue
        }
        addExecution(anchor, structuredPropertyDescriptor(structured, name, recordByNode, 'get'))
      }
      return
    }
    if (pattern.isArrayPattern?.()) {
      addExecution(anchor, iterableExecutionDescriptor(source, recordByNode))
    }
  }
  for (const path of activationPatternPaths) {
    const pattern = path.isVariableDeclarator?.() ? path.get('id') : path.get('left')
    const source = path.isVariableDeclarator?.() ? path.get('init') : path.get('right')
    if (!pattern?.isObjectPattern?.() && !pattern?.isArrayPattern?.()) continue
    addPatternReads(pattern, source, path)
  }
  for (const path of activationSpreadPaths) {
    const argument = path.get('argument')
    if (path.parentPath?.isObjectExpression?.()) {
      for (const descriptor of structuredGetterDescriptors(argument, recordByNode)) {
        addExecution(path, descriptor)
      }
    } else {
      addExecution(path, iterableExecutionDescriptor(argument, recordByNode))
    }
  }
  for (const path of activationAwaitPaths) {
    addExecution(path, thenableExecutionDescriptor(path.get('argument'), recordByNode))
  }
  for (const path of activationIteratorPaths) {
    const value = path.isForOfStatement?.() ? path.get('right') : path.get('argument')
    addExecution(path, iterableExecutionDescriptor(value, recordByNode))
  }
  for (const path of activationTaggedPaths) {
    addExecution(path, callableDescriptor(path.get('tag'), recordByNode, { strict: true }))
  }
  for (const record of classRecords) {
    const calls = callsByFunction.get(record.id)
    if (record.constructorNode) {
      const constructor = recordByNode.get(record.constructorNode)
      addDescriptor(callCollector, record.id, calls, constructor
        ? { kind: 'local', functionId: constructor.id }
        : { kind: 'unresolved' })
    }
    const superClass = record.path.get('superClass')
    if (superClass?.node) {
      addDescriptor(callCollector, record.id, calls, callEvidence(
        callableDescriptor(superClass, recordByNode, { strict: true }),
        superClass,
      ))
    }
  }
  if (callCollector.overflow) {
    return incompleteMetadata(sourcePath, { sourceBytes, nodes: nodeCount, scopes: scopeCount })
  }
  const directEvalBindings = new Set()
  for (const path of directEvalPaths) {
    const binding = runtimeBinding(path, 'ctx')
    const candidate = candidateByBinding.get(binding)
    if (candidate?.candidate && candidateContains(candidate, path.node)) {
      directEvalBindings.add(binding)
    }
  }
  const implicitArgumentsBindings = new Set()
  for (const path of implicitArgumentsPaths) {
    let owner = path.getFunctionParent()
    while (owner?.isArrowFunctionExpression?.()) owner = owner.getFunctionParent()
    const record = owner ? recordByNode.get(owner.node) : undefined
    if (record?.candidate && candidateContains(record, path.node)) {
      implicitArgumentsBindings.add(record.binding)
    }
  }
  const withContextPaths = new Set()
  for (const path of valueContextPaths) {
    const candidate = candidateByBinding.get(runtimeBinding(path, 'ctx'))
    if (candidate?.candidate && candidateContains(candidate, path.node)
        && contextReferenceInsideWith(path, candidate)) withContextPaths.add(path)
  }
  const incompleteBindings = new Set([
    ...directEvalBindings,
    ...implicitArgumentsBindings,
  ])
  const context = contextReferenceResult(
    functionRecords,
    valueContextPaths,
    candidateByBinding,
    incompleteBindings,
    withContextPaths,
  )
  const referencesByBinding = new Map()
  for (const path of valueContextPaths) {
    const binding = runtimeBinding(path, 'ctx')
    if (!binding) continue
    const references = referencesByBinding.get(binding) ?? []
    references.push(path)
    referencesByBinding.set(binding, references)
  }
  const program = programMetadata(
    programPath,
    recordByNode,
    edgeCollector,
    requirePaths,
    modulePaths,
    exportsPaths,
    processPaths,
  )
  topLevelClosureComplete = topLevelClosureComplete && program.topLevelClosureComplete
  for (const functionId of program.opaqueFunctionIds) opaqueFunctionIds.add(functionId)
  const functionSummaries = functionRecords.map((record) => {
    const routes = routeSummaries(
      record,
      referencesByBinding.get(record.binding) ?? [],
      incompleteBindings,
      withContextPaths,
    )
    return {
      id: record.id,
      candidate: record.candidate,
      usable: record.mutation.usable,
      mutationComplete: record.mutation.complete,
      routeComplete: routes.complete,
      closureComplete: !opaqueFunctionIds.has(record.id),
      calls: callsByFunction.get(record.id),
      callSites: callSitesByFunction.get(record.id),
      eagerParameters: [...eagerParametersByFunction.get(record.id)].sort((left, right) => left - right),
      defaultCallbacks: defaultCallbacksByFunction.get(record.id),
      rawRoutes: routes.rawRoutes,
      connectionRoutes: routes.connectionRoutes,
    }
  })
  for (const record of classRecords) {
    functionSummaries.push({
      id: record.id,
      candidate: false,
      usable: false,
      mutationComplete: true,
      routeComplete: false,
      closureComplete: true,
      calls: callsByFunction.get(record.id),
      callSites: [],
      eagerParameters: [],
      defaultCallbacks: [],
      rawRoutes: [],
      connectionRoutes: [],
    })
  }
  if (edgeCollector.overflow) {
    return incompleteMetadata(sourcePath, {
      sourceBytes, nodes: nodeCount, scopes: scopeCount, edges: program.edges.length,
    })
  }
  return freezePlain({
    sourcePath,
    parsed: true,
    complete: context.complete && closureComplete && program.complete,
    moduleClosureComplete: closureComplete && program.moduleClosureComplete,
    activationClosureComplete: topLevelClosureComplete,
    context,
    moduleEdges: program.edges,
    exports: program.exportsByName,
    hasRuntimeStarExport: program.hasRuntimeStarExport,
    commonJsExportSurface: commonJsExtension(sourcePath) || program.commonJsExportSurface,
    topLevelCalls,
    topLevelCallSites,
    functions: functionSummaries,
    counts: {
      sourceBytes,
      nodes: nodeCount,
      scopes: scopeCount,
      edges: program.edges.length,
    },
  })
}

export function inspectExecutableModuleMetadata(source, options = {}) {
  const sourcePath = options && typeof options === 'object' ? options.sourcePath : undefined
  return analyzeSource(source, sourcePath)
}

export function inspectExecutableContextReferences(source, options = {}) {
  return cloneContextResult(inspectExecutableModuleMetadata(source, options).context)
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

function graphPackageManifest(files) {
  const source = files.get('package.json')
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > EXECUTABLE_SOURCE_BYTES_LIMIT) {
    return { valid: false }
  }
  try {
    const value = JSON.parse(source)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { valid: true, value } : { valid: false }
  } catch {
    return { valid: false }
  }
}

function boundedRuntimeTargets(value, state = { depth: 0, count: 0, values: [] }) {
  if (state.depth > EXECUTABLE_EXPORT_CHAIN_LIMIT || state.count > 128) return undefined
  state.count += 1
  if (typeof value === 'string') state.values.push(value)
  else if (Array.isArray(value)) {
    for (const item of value) {
      state.depth += 1
      if (!boundedRuntimeTargets(item, state)) return undefined
      state.depth -= 1
    }
  } else if (value && typeof value === 'object') {
    for (const [condition, item] of Object.entries(value)) {
      if (condition === 'types' || condition === 'typings') continue
      state.depth += 1
      if (!boundedRuntimeTargets(item, state)) return undefined
      state.depth -= 1
    }
  } else return undefined
  return state.values
}

function exactManifestTarget(value) {
  const targets = boundedRuntimeTargets(value)
  if (!targets) return undefined
  const unique = [...new Set(targets)]
  return unique.length === 1 ? unique[0] : undefined
}

function packageExportValue(exportsValue, subpath) {
  if (typeof exportsValue === 'string' || Array.isArray(exportsValue)) {
    return subpath === '.' ? exportsValue : undefined
  }
  if (!exportsValue || typeof exportsValue !== 'object') return undefined
  const keys = Object.keys(exportsValue)
  if (keys.some((key) => key.startsWith('.'))) return exportsValue[subpath]
  return subpath === '.' ? exportsValue : undefined
}

function graphSpecifierResolution(fromPath, specifier, files, packageManifest, state = new Set()) {
  if (specifier.startsWith('.')) {
    const local = resolveLocalModule(fromPath, specifier, files)
    return local ? { kind: 'local', path: local } : { kind: 'incomplete' }
  }
  if (specifier === 'node:' || specifier.startsWith('node:')) return { kind: 'terminal' }
  if (specifier.startsWith('/') || specifier.startsWith('\\')
      || /^[A-Za-z]:[\\/]/u.test(specifier)) return { kind: 'incomplete' }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier)) return { kind: 'incomplete' }
  if (state.has(specifier) || state.size >= EXECUTABLE_EXPORT_CHAIN_LIMIT) {
    return { kind: 'incomplete' }
  }
  const manifest = packageManifest.valid ? packageManifest.value : undefined
  let target
  if (specifier.startsWith('#')) {
    target = exactManifestTarget(manifest?.imports?.[specifier])
    if (target === undefined) return { kind: 'incomplete' }
    if (!target.startsWith('./')) return { kind: 'incomplete' }
  } else if (typeof manifest?.name === 'string'
      && (specifier === manifest.name || specifier.startsWith(manifest.name + '/'))) {
    const subpath = specifier === manifest.name ? '.' : './' + specifier.slice(manifest.name.length + 1)
    const exportValue = packageExportValue(manifest.exports, subpath)
    const usingMain = exportValue === undefined && subpath === '.'
    target = exactManifestTarget(exportValue ?? (usingMain ? manifest.main : undefined))
    if (target === undefined) return { kind: 'incomplete' }
    if (usingMain && !target.startsWith('./')) target = './' + target
    else if (!usingMain && !target.startsWith('./')) return { kind: 'incomplete' }
  } else return { kind: 'terminal' }

  if (target.startsWith('./')) {
    const local = resolveLocalModule('package.json', target, files)
    return local ? { kind: 'local', path: local } : { kind: 'incomplete' }
  }
  return graphSpecifierResolution('package.json', target, files, packageManifest,
    new Set(state).add(specifier))
}

function routeOrder(left, right) {
  return left.sourcePath.localeCompare(right.sourcePath, 'en')
    || left.line - right.line
    || (left.routePath ?? '').localeCompare(right.routePath ?? '', 'en')
}

function buildReachableModules(files, entryPaths) {
  const reachable = new Map()
  const forcedIncomplete = new Set()
  const budget = createGraphBudget()
  const packageManifest = graphPackageManifest(files)
  const entries = [...new Set(entryPaths)].sort((left, right) => left.localeCompare(right, 'en'))
  const queue = [...entries]
  while (queue.length > 0) {
    const sourcePath = queue.shift()
    if (reachable.has(sourcePath)) continue
    if (!consumeBudget(budget, 'modules')) {
      for (const entryPath of entries) forcedIncomplete.add(entryPath)
      break
    }
    const analysis = analyzeSource(files.get(sourcePath), sourcePath, budget)
    reachable.set(sourcePath, analysis)
    if (budget.exhausted.size > 0) {
      forcedIncomplete.add(sourcePath)
      for (const entryPath of entries) forcedIncomplete.add(entryPath)
      break
    }
    for (const edge of analysis.moduleEdges) {
      const resolution = graphSpecifierResolution(
        sourcePath,
        edge.specifier,
        files,
        packageManifest,
      )
      if (resolution.kind === 'incomplete') {
        forcedIncomplete.add(sourcePath)
        continue
      }
      if (resolution.kind === 'terminal') continue
      const local = resolution.path
      if (!local) {
        forcedIncomplete.add(sourcePath)
        continue
      }
      const extension = posix.extname(local).toLowerCase()
      if (extension === '.json') continue
      if (!CODE_EXTENSIONS.includes(extension)) {
        forcedIncomplete.add(sourcePath)
        continue
      }
      if (!reachable.has(local) && !queue.includes(local)) queue.push(local)
      queue.sort((left, right) => left.localeCompare(right, 'en'))
    }
  }
  return {
    entries,
    reachable,
    forcedIncomplete,
    packageManifest,
    budget,
  }
}

function activationFunctionKey(sourcePath, functionId) {
  return `${sourcePath}\0${functionId}`
}

function resolveCallableDescriptor(graph, files, sourcePath, descriptor) {
  if (descriptor.kind === 'local-class-without-constructor') return { ok: true, terminal: true }
  if (descriptor.kind === 'local') {
    const summary = graph.reachable.get(sourcePath)?.functions
      .find((value) => value.id === descriptor.functionId)
    return summary ? { ok: true, sourcePath, summary } : { ok: false }
  }
  if (descriptor.kind !== 'import' && descriptor.kind !== 'import-member') return { ok: false }
  const resolution = graphSpecifierResolution(
    sourcePath,
    descriptor.source,
    files,
    graph.packageManifest,
  )
  if (resolution.kind === 'terminal') return { ok: true, terminal: true }
  if (resolution.kind !== 'local' || !graph.reachable.has(resolution.path)) return { ok: false }
  if (descriptor.kind === 'import-member') return { ok: false }
  return resolveExportedFunction(
    graph.reachable,
    files,
    resolution.path,
    descriptor.importedName,
    { depth: 0, seen: new Set(), callable: true },
  )
}

function inspectActivationClosure(graph, files) {
  const incompletePaths = new Set()
  const activeModules = new Set()
  const activeFunctions = new Set()
  const queue = graph.entries.map((sourcePath) => ({ kind: 'module', sourcePath }))
  let steps = 0
  const enqueueFunction = (sourcePath, summary) => {
    const key = activationFunctionKey(sourcePath, summary.id)
    if (!activeFunctions.has(key)) queue.push({ kind: 'function', sourcePath, summary })
  }
  const consumeCall = (sourcePath, descriptor) => {
    const resolution = resolveCallableDescriptor(graph, files, sourcePath, descriptor)
    if (!resolution.ok) incompletePaths.add(sourcePath)
    else if (!resolution.terminal) enqueueFunction(resolution.sourcePath, resolution.summary)
    return resolution
  }
  const consumeCallSite = (sourcePath, site) => {
    const resolution = site.callee
      ? resolveCallableDescriptor(graph, files, sourcePath, site.callee)
      : { ok: true, terminal: true }
    if (!resolution.ok) incompletePaths.add(sourcePath)
    const eager = resolution.ok && !resolution.terminal
      ? new Set(resolution.summary.eagerParameters ?? []) : undefined
    for (const callback of site.callbacks) {
      if (callback.nested ? eager?.has(callback.index) : !eager || eager.has(callback.index)) {
        consumeCall(sourcePath, callback.descriptor)
      }
    }
    if (resolution.ok && !resolution.terminal) {
      const undefinedArguments = new Set(site.undefinedArguments ?? [])
      for (const callback of resolution.summary.defaultCallbacks ?? []) {
        if (callback.index >= (site.argumentCount ?? 0) || undefinedArguments.has(callback.index)) {
          consumeCall(resolution.sourcePath, callback.descriptor)
        }
      }
    }
  }
  const consumeEdge = (sourcePath, edge) => {
    const resolution = graphSpecifierResolution(
      sourcePath,
      edge.specifier,
      files,
      graph.packageManifest,
    )
    if (resolution.kind === 'incomplete') {
      incompletePaths.add(sourcePath)
      return
    }
    if (resolution.kind !== 'local') return
    const extension = posix.extname(resolution.path).toLowerCase()
    if (extension === '.json') return
    if (!CODE_EXTENSIONS.includes(extension) || !graph.reachable.has(resolution.path)) {
      incompletePaths.add(sourcePath)
      return
    }
    if (!activeModules.has(resolution.path)) {
      queue.push({ kind: 'module', sourcePath: resolution.path })
    }
  }
  for (const entryPath of graph.entries) {
    const analysis = graph.reachable.get(entryPath)
    const descriptors = descriptorsFor(analysis, 'apply')
    if (descriptors.length === 0) {
      if (analysis?.commonJsExportSurface || analysis?.hasRuntimeStarExport) {
        incompletePaths.add(entryPath)
      }
      continue
    }
    const resolution = resolveExportedFunction(
      graph.reachable,
      files,
      entryPath,
      'apply',
      { depth: 0, seen: new Set() },
    )
    if (!resolution.ok) incompletePaths.add(entryPath)
    else enqueueFunction(resolution.sourcePath, resolution.summary)
  }
  while (queue.length > 0) {
    steps += 1
    if (steps > EXECUTABLE_GRAPH_SCOPE_LIMIT + EXECUTABLE_MODULE_EDGE_LIMIT) {
      for (const entryPath of graph.entries) incompletePaths.add(entryPath)
      break
    }
    const item = queue.shift()
    if (item.kind === 'module') {
      if (activeModules.has(item.sourcePath)) continue
      activeModules.add(item.sourcePath)
      const analysis = graph.reachable.get(item.sourcePath)
      if (!analysis?.parsed || analysis.activationClosureComplete !== true) {
        incompletePaths.add(item.sourcePath)
      }
      for (const descriptor of analysis?.topLevelCalls ?? []) {
        consumeCall(item.sourcePath, descriptor)
      }
      for (const site of analysis?.topLevelCallSites ?? []) {
        consumeCallSite(item.sourcePath, site)
      }
      for (const edge of analysis?.moduleEdges ?? []) {
        if (edge.topLevel) consumeEdge(item.sourcePath, edge)
      }
      continue
    }
    const key = activationFunctionKey(item.sourcePath, item.summary.id)
    if (activeFunctions.has(key)) continue
    activeFunctions.add(key)
    if (!activeModules.has(item.sourcePath)) {
      queue.push({ kind: 'module', sourcePath: item.sourcePath })
    }
    if (item.summary.closureComplete !== true) incompletePaths.add(item.sourcePath)
    for (const descriptor of item.summary.calls ?? []) consumeCall(item.sourcePath, descriptor)
    for (const site of item.summary.callSites ?? []) consumeCallSite(item.sourcePath, site)
    const analysis = graph.reachable.get(item.sourcePath)
    for (const edge of analysis?.moduleEdges ?? []) {
      if (edge.functionIds.includes(item.summary.id)) consumeEdge(item.sourcePath, edge)
    }
  }
  if (graph.budget.exhausted.size > 0) {
    for (const entryPath of graph.entries) incompletePaths.add(entryPath)
  }
  return [...incompletePaths].sort((left, right) => left.localeCompare(right, 'en'))
}

export function inspectExecutableModuleClosure(files, options = {}) {
  if (!(files instanceof Map)) fail('INVALID_EXECUTABLE_CLOSURE', 'Executable closure inspection requires a file map.')
  const entryPaths = options && typeof options === 'object' ? options.entryPaths : undefined
  if (!Array.isArray(entryPaths) || entryPaths.some((value) => typeof value !== 'string'
      || value.length === 0 || !files.has(value))) {
    fail('INVALID_EXECUTABLE_CLOSURE', 'Executable closure inspection requires existing entry paths.')
  }
  const graph = buildReachableModules(files, entryPaths)
  const modules = [...graph.reachable.values()]
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath, 'en'))
  const incompletePaths = [...new Set([
    ...(graph.entries.length === 0 ? ['package.json'] : []),
    ...graph.forcedIncomplete,
    ...modules.filter((value) => value.moduleClosureComplete !== true)
      .map((value) => value.sourcePath),
  ])].sort((left, right) => left.localeCompare(right, 'en'))
  const activationIncompletePaths = [...new Set([
    ...(graph.entries.length === 0 ? ['package.json'] : []),
    ...inspectActivationClosure(graph, files),
  ])].sort((left, right) => left.localeCompare(right, 'en'))
  const injectExports = graph.entries.map((entryPath) => ({
    entryPath,
    ...resolveExportedInject(graph.reachable, files, entryPath, 'inject', {
      depth: 0,
      seen: new Set(),
    }),
  }))
  return freezePlain({
    entries: [...graph.entries],
    modules,
    incompletePaths,
    activationIncompletePaths,
    injectExports,
    resources: budgetReport(graph.budget),
  })
}

function descriptorsFor(analysis, exportName) {
  return analysis?.exports?.find((item) => item.name === exportName)?.descriptors ?? []
}

function resolveExportedInject(reachable, files, modulePath, exportName, state) {
  if (state.depth >= EXECUTABLE_EXPORT_CHAIN_LIMIT) {
    return { complete: false, present: false, sourcePath: modulePath, values: [] }
  }
  const key = `${modulePath}\0${exportName}`
  if (state.seen.has(key)) {
    return { complete: false, present: false, sourcePath: modulePath, values: [] }
  }
  const analysis = reachable.get(modulePath)
  if (!analysis?.parsed) {
    return { complete: false, present: false, sourcePath: modulePath, values: [] }
  }
  if (analysis.commonJsExportSurface) {
    return { complete: false, present: false, sourcePath: modulePath, values: [] }
  }
  const descriptors = descriptorsFor(analysis, exportName)
  if (descriptors.length === 0) {
    return analysis.hasRuntimeStarExport
      ? { complete: false, present: false, sourcePath: modulePath, values: [] }
      : { complete: true, present: false, values: [] }
  }
  if (descriptors.length !== 1) {
    return { complete: false, present: false, sourcePath: modulePath, values: [] }
  }
  const descriptor = descriptors[0]
  if (descriptor.kind === 'inject-literal') {
    return {
      complete: true,
      present: true,
      definingPath: modulePath,
      values: descriptor.values.map((value) => ({ ...value })),
    }
  }
  if (descriptor.kind !== 'import' && descriptor.kind !== 'reexport') {
    return { complete: false, present: false, sourcePath: modulePath, values: [] }
  }
  const target = resolveLocalModule(modulePath, descriptor.source, files)
  if (!target || !reachable.has(target)) {
    return { complete: false, present: false, sourcePath: modulePath, values: [] }
  }
  return resolveExportedInject(reachable, files, target, descriptor.importedName, {
    depth: state.depth + 1,
    seen: new Set(state.seen).add(key),
  })
}

function resolveExportedFunction(reachable, files, modulePath, exportName, state) {
  if (state.depth >= EXECUTABLE_EXPORT_CHAIN_LIMIT) return { ok: false, sourcePath: modulePath }
  const key = `${modulePath}\0${exportName}`
  if (state.seen.has(key)) return { ok: false, sourcePath: modulePath }
  const analysis = reachable.get(modulePath)
  if (!analysis?.parsed) return { ok: false, sourcePath: modulePath }
  const descriptors = descriptorsFor(analysis, exportName)
  if (descriptors.length !== 1) {
    return { ok: false, sourcePath: modulePath, star: analysis.hasRuntimeStarExport }
  }
  const descriptor = descriptors[0]
  if (descriptor.kind === 'function') {
    const summary = analysis.functions.find((item) => item.id === descriptor.functionId)
    return summary ? { ok: true, sourcePath: modulePath, summary }
      : { ok: false, sourcePath: modulePath }
  }
  if (descriptor.kind === 'class' && state.callable) {
    if (!descriptor.constructorFunctionId) return { ok: true, terminal: true }
    const summary = analysis.functions.find(
      (item) => item.id === descriptor.constructorFunctionId,
    )
    return summary ? { ok: true, sourcePath: modulePath, summary }
      : { ok: false, sourcePath: modulePath }
  }
  if (descriptor.kind === 'non-callable-value' && state.callable) {
    return { ok: true, terminal: true }
  }
  if (descriptor.kind !== 'import' && descriptor.kind !== 'reexport') {
    return { ok: false, sourcePath: modulePath }
  }
  const target = resolveLocalModule(modulePath, descriptor.source, files)
  if (!target || !reachable.has(target)) return { ok: false, sourcePath: modulePath }
  return resolveExportedFunction(reachable, files, target, descriptor.importedName, {
    depth: state.depth + 1,
    seen: new Set(state.seen).add(key),
    callable: state.callable,
  })
}

function routesForApply(resolution) {
  if (!resolution.summary.candidate || !resolution.summary.usable) {
    return { complete: false, rawCandidates: [], connectionCandidates: [] }
  }
  return {
    complete: resolution.summary.routeComplete,
    rawCandidates: resolution.summary.rawRoutes.map((value) => ({ ...value })),
    connectionCandidates: resolution.summary.connectionRoutes.map((value) => ({ ...value })),
  }
}

export function inspectWebRouteAuth(files, options = {}) {
  if (!(files instanceof Map)) fail('INVALID_WEB_ROUTE_AUDIT', 'Web-route audit requires a plugin file map.')
  const entryPath = options.entryPath
  if (typeof entryPath !== 'string' || entryPath.length === 0 || !files.has(entryPath)) {
    fail('WEB_ROUTE_ENTRY_MISSING', 'Web-route audit requires the package entry in the audited tree.', { entryPath })
  }

  const graph = buildReachableModules(files, [entryPath])
  const resolution = resolveExportedFunction(graph.reachable, files, entryPath, 'apply', {
    depth: 0,
    seen: new Set(),
  })
  let routes = { complete: false, rawCandidates: [], connectionCandidates: [] }
  if (resolution.ok) {
    routes = routesForApply(resolution)
    if (!routes.complete) graph.forcedIncomplete.add(resolution.sourcePath)
  } else {
    graph.forcedIncomplete.add(entryPath)
    graph.forcedIncomplete.add(resolution.sourcePath)
  }
  const rawRoutes = routes.rawCandidates.sort(routeOrder)
  const connectionRoutes = routes.connectionCandidates.sort(routeOrder)
  const incompletePaths = [...new Set([
    ...graph.forcedIncomplete,
    ...[...graph.reachable.entries()]
      .filter(([, value]) => value.complete !== true)
      .map(([sourcePath]) => sourcePath),
  ])].sort((left, right) => left.localeCompare(right, 'en'))

  return {
    entryPath,
    reachablePaths: [...graph.reachable.keys()].sort((left, right) => left.localeCompare(right, 'en')),
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
      dynamicOrAliasedRegistrations: 'coverage-incomplete',
      optionalOrLiteralComputedRegistrations: 'classified',
      bareServiceBindings: 'coverage-incomplete',
      nestedOrShadowedContextBindings: 'not-claimed',
      nonLiteralModuleSpecifiers: 'coverage-incomplete',
      retainedAnalysis: 'compact-metadata-only',
      resources: budgetReport(graph.budget),
      incompletePaths,
      absenceIsLocal: true,
    },
    repositoryCodeExecuted: false,
  }
}
