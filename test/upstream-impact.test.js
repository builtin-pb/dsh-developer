import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { scanOrdinaryTree } from '../lib/files.js'
import { formatUpstreamImpactReport, inspectUpstreamImpact } from '../lib/upstream-impact.js'
import {
  classifyHostInjectContract,
  comparePackageSurfaces,
  discoverUpstreamReferences,
  inspectUpstreamImpactInternal,
} from '../lib/upstream-impact-internal.js'
import {
  EXECUTABLE_SOURCE_BYTES_LIMIT,
  EXECUTABLE_SOURCE_NESTING_LIMIT,
  EXECUTABLE_SOURCE_NODE_LIMIT,
  EXECUTABLE_SOURCE_SCOPE_LIMIT,
  inspectExecutableContextReferences,
  inspectExecutableModuleMetadata,
} from '../lib/web-route-audit.js'

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

async function sourceFixture(root, extra = {}) {
  await writeJson(join(root, 'package.json'), {
    name: 'impact-fixture',
    version: '0.1.0',
    type: 'module',
    main: './index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    dshDeveloper: { upstream: { services: ['skills'] } },
    ...extra,
  })
  await writeFile(join(root, 'index.js'), [
    "export const inject = ['skills']",
    'export async function apply(ctx) { ctx.skills.register({}) }',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(root, 'cordis.patch.yml'), '- insert: []\n', 'utf8')
}

async function installedPackage(root, name, version, declaration) {
  await mkdir(join(root, 'lib', 'types'), { recursive: true })
  await writeFile(join(root, 'lib', 'index.js'), 'export const version = ' + JSON.stringify(version) + '\n', 'utf8')
  await writeFile(join(root, 'lib', 'types', 'index.d.ts'), declaration, 'utf8')
  const value = {
    name,
    version,
    type: 'module',
    main: './lib/index.js',
    types: './lib/types/index.d.ts',
    exports: {
      '.': {
        types: './lib/types/index.d.ts',
        default: './lib/index.js',
      },
      './package.json': './package.json',
    },
    publishConfig: { access: 'public' },
  }
  await writeJson(join(root, 'package.json'), value)
  return { root, manifestPath: join(root, 'package.json'), value }
}

test('discovers declared packages, injected services, static imports, and the base host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-impact-source-'))
  try {
    await sourceFixture(root, {
      dependencies: { '@deepseek-ai/dsh-commands': '^0.1.1' },
      dshDeveloper: {
        upstream: {
          packages: ['@deepseek-ai/dsh-skill/invariant'],
          services: ['skills'],
        },
      },
    })
    await writeFile(join(root, 'index.js'), [
      "import '@deepseek-ai/dsh-shell-env'",
      "export const inject = { required: ['skills', 'commands', 'remote.workspace'] }",
      "export async function apply(ctx) { ctx.commands.register({}); ctx.reflect.provide('fixture', {}); ctx.get('appExit'); ctx.inject(['agentLoop'], () => {}); ctx.logger.info('ready') }",
      '',
    ].join('\n'), 'utf8')
    const references = discoverUpstreamReferences(await scanOrdinaryTree(root))
    assert.deepEqual(references.packages.map((value) => value.package), [
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-commands',
      '@deepseek-ai/dsh-shell-env',
      '@deepseek-ai/dsh-skill',
    ])
    assert.deepEqual(references.packages.find((value) => value.package === '@deepseek-ai/dsh-skill').subpaths, ['./invariant'])
    assert.deepEqual(references.services.map((value) => value.service), ['agentLoop', 'appExit', 'commands', 'remote.workspace', 'skills'])
    assert.equal(
      references.services.find((value) => value.service === 'agentLoop')
        .evidence.find((value) => value.kind === 'context-inject').requirement,
      'runtime',
    )
    assert.equal(
      references.services.find((value) => value.service === 'remote.workspace')
        .evidence.find((value) => value.kind === 'inject').requirement,
      'required',
    )
    assert.deepEqual(references.coverage.undeclaredPackages, ['@deepseek-ai/dsh-shell-env'])
    assert.deepEqual(references.coverage.undeclaredServices, ['appExit'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails nonliteral runtime closure closed while retaining independently proven context evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-impact-runtime-closure-'))
  try {
    await writeJson(join(root, 'package.json'), {
      name: 'runtime-closure-fixture',
      version: '0.1.0',
      type: 'module',
      main: './index.js',
      dshDeveloper: { upstream: { services: ['skills'] } },
    })
    for (const loader of [
      "const packageName = '@deepseek-ai/dsh-unknown'; import(packageName)",
      "const moduleName = '@deepseek-ai/dsh-unknown'; require(moduleName)",
      "eval(\"import('@deepseek-ai/dsh-unknown')\")",
      "(eval)(\"require('@deepseek-ai/dsh-unknown')\")",
      "eval?.(\"import('@deepseek-ai/dsh-unknown')\")",
      "(0, eval)(\"require('@deepseek-ai/dsh-unknown')\")",
      "Function(\"return import('@deepseek-ai/dsh-unknown')\")()",
      "new Function(\"return require('@deepseek-ai/dsh-unknown')\")",
      "(0, Function)(\"return import('@deepseek-ai/dsh-unknown')\")()",
      "const run = eval; run(\"import('@deepseek-ai/dsh-unknown')\")",
      "eval.call(null, \"import('@deepseek-ai/dsh-unknown')\")",
      "eval.apply(null, [\"import('@deepseek-ai/dsh-unknown')\"])",
      "Reflect.construct(Function, [\"return import('@deepseek-ai/dsh-unknown')\"])",
      "const run = globalThis.eval; run(\"import('@deepseek-ai/dsh-unknown')\")",
      "global['Function'](\"return require('@deepseek-ai/dsh-unknown')\")()",
    ]) {
      await writeFile(join(root, 'index.js'), [
        loader,
        "export function apply(ctx) { ctx.skills.register({ name: 'proven' }) }",
        '',
      ].join('\n'), 'utf8')
      const references = discoverUpstreamReferences(await scanOrdinaryTree(root))
      assert.deepEqual(references.services.map((value) => value.service), ['skills'], loader)
      assert.deepEqual(references.packages.map((value) => value.package), [], loader)
      assert.deepEqual(references.coverage.unparsedInjectDeclarations, ['index.js'], loader)
      assert.equal(classifyHostInjectContract(references).ok, false, loader)
    }

    await writeFile(join(root, 'index.js'), [
      'function apply(ctx, eval, Function, globalThis, global) {',
      "  eval(\"import('@deepseek-ai/dsh-unknown')\")",
      "  new Function(\"return require('@deepseek-ai/dsh-unknown')\")",
      "  globalThis.eval(\"import('@deepseek-ai/dsh-unknown')\")",
      "  global.Function(\"return require('@deepseek-ai/dsh-unknown')\")",
      "  ctx.skills.register({ name: 'proven' })",
      '}',
      '',
    ].join('\n'), 'utf8')
    const shadowed = discoverUpstreamReferences(await scanOrdinaryTree(root))
    assert.deepEqual(shadowed.services.map((value) => value.service), ['skills'])
    assert.deepEqual(shadowed.packages.map((value) => value.package), [])
    assert.deepEqual(shadowed.coverage.unparsedInjectDeclarations, [])

    await writeFile(join(root, 'index.js'), [
      "export { value } from './reexport.js'",
      'import(`./child.js`)',
      "import('@deepseek-ai/dsh-commands')",
      "export function apply(ctx) { ctx.skills.register({ name: 'proven' }) }",
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(root, 'child.js'), [
      "import '@deepseek-ai/dsh-shell-env'",
      'export function observe(ctx) { ctx.commands.register({}) }',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(root, 'reexport.js'), 'export const value = true\n', 'utf8')
    const exact = discoverUpstreamReferences(await scanOrdinaryTree(root))
    assert.deepEqual(exact.packages.map((value) => value.package), [
      '@deepseek-ai/dsh-commands',
      '@deepseek-ai/dsh-shell-env',
    ])
    assert.deepEqual(exact.services.map((value) => value.service), ['commands', 'skills'])
    assert.deepEqual(exact.coverage.unparsedInjectDeclarations, [])
    assert.equal(classifyHostInjectContract(exact).ok, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('separates deferred loader visibility from activation-reachable loader proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-impact-activation-closure-'))
  try {
    await writeJson(join(root, 'package.json'), {
      name: 'activation-closure-fixture',
      version: '0.1.0',
      type: 'module',
      main: './index.js',
      dshDeveloper: { upstream: { services: ['skills'] } },
    })

    const helper = [
      "const packageName = '@deepseek-ai/dsh-hidden'",
      'function load() { return import(packageName) }',
      "export const inject = ['skills']",
    ]
    await writeFile(join(root, 'index.js'), [
      ...helper,
      "export function apply(ctx) { ctx.skills.register({ name: 'proven' }) }",
      '',
    ].join('\n'), 'utf8')
    const deferred = discoverUpstreamReferences(await scanOrdinaryTree(root))
    assert.deepEqual(deferred.services.map((value) => value.service), ['skills'])
    assert.deepEqual(deferred.coverage.unparsedInjectDeclarations, [])
    assert.deepEqual(deferred.coverage.unparsedModuleClosure, ['index.js'])
    assert.equal(classifyHostInjectContract(deferred).ok, true)

    await writeFile(join(root, 'index.js'), [
      ...helper,
      "export function apply(ctx) { load(); ctx.skills.register({ name: 'proven' }) }",
      '',
    ].join('\n'), 'utf8')
    const activated = discoverUpstreamReferences(await scanOrdinaryTree(root))
    assert.deepEqual(activated.services.map((value) => value.service), ['skills'])
    assert.deepEqual(activated.coverage.unparsedInjectDeclarations, ['index.js'])
    assert.deepEqual(activated.coverage.unparsedModuleClosure, ['index.js'])
    assert.equal(classifyHostInjectContract(activated).ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails external package-import aliases closed instead of hiding package evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-impact-package-import-alias-'))
  try {
    await writeJson(join(root, 'package.json'), {
      name: 'package-import-alias-fixture',
      version: '0.1.0',
      type: 'module',
      main: './index.js',
      imports: { '#dsh': '@deepseek-ai/dsh-hidden' },
      dshDeveloper: { upstream: { services: ['skills'] } },
    })
    await writeFile(join(root, 'index.js'), [
      "import '#dsh'",
      "export const inject = ['skills']",
      "export function apply(ctx) { ctx.skills.register({ name: 'proven' }) }",
      '',
    ].join('\n'), 'utf8')
    const references = discoverUpstreamReferences(await scanOrdinaryTree(root))
    assert.deepEqual(references.packages, [])
    assert.deepEqual(references.services.map((value) => value.service), ['skills'])
    assert.deepEqual(references.coverage.unparsedInjectDeclarations, ['index.js'])
    assert.equal(classifyHostInjectContract(references).ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ignores manifest type conditions and declaration files as activation entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-impact-runtime-entry-'))
  try {
    await writeJson(join(root, 'package.json'), {
      name: 'runtime-entry-fixture',
      version: '0.1.0',
      type: 'module',
      main: './stale-missing.js',
      exports: {
        '.': {
          types: './index.d.ts',
          default: './runtime.js',
        },
      },
    })
    await writeFile(join(root, 'index.d.ts'), [
      "export declare const inject: ['fakeTypeService']",
      "import '@deepseek-ai/dsh-type-only'",
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(root, 'runtime.js'), [
      "export const inject = ['skills']",
      'export function apply(ctx) { ctx.skills.register({}) }',
      '',
    ].join('\n'), 'utf8')
    const references = discoverUpstreamReferences(await scanOrdinaryTree(root))
    assert.deepEqual(references.packages, [])
    assert.deepEqual(references.services.map((value) => value.service), ['skills'])
    assert.deepEqual(references.coverage.unparsedInjectDeclarations, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolves common Node main forms and fails missing activation entries closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-impact-main-entry-'))
  try {
    for (const [main, sourcePath] of [
      ['dist/plugin.js', join(root, 'dist', 'plugin.js')],
      ['./dist/plugin', join(root, 'dist', 'plugin.js')],
      ['dist/plugin', join(root, 'dist', 'plugin.js')],
      ['dist', join(root, 'dist', 'index.js')],
    ]) {
      await rm(join(root, 'dist'), { recursive: true, force: true })
      await mkdir(dirname(sourcePath), { recursive: true })
      await writeJson(join(root, 'package.json'), {
        name: 'main-entry-fixture',
        version: '0.1.0',
        type: 'module',
        main,
      })
      await writeFile(sourcePath, [
        "import '@deepseek-ai/dsh-commands'",
        'export function apply(ctx) { ctx.commands.register({}) }',
        '',
      ].join('\n'), 'utf8')
      const references = discoverUpstreamReferences(await scanOrdinaryTree(root))
      assert.deepEqual(references.packages.map((value) => value.package), [
        '@deepseek-ai/dsh-commands',
      ], main)
      assert.deepEqual(references.services.map((value) => value.service), ['commands'], main)
      assert.deepEqual(references.coverage.unparsedInjectDeclarations, [], main)
    }

    for (const manifest of [
      { name: 'missing-main', version: '0.1.0', main: 'dist/missing' },
      { name: 'empty-entry', version: '0.1.0' },
    ]) {
      await rm(join(root, 'dist'), { recursive: true, force: true })
      await writeJson(join(root, 'package.json'), manifest)
      const references = discoverUpstreamReferences(await scanOrdinaryTree(root))
      assert.deepEqual(references.coverage.unparsedInjectDeclarations, ['package.json'])
      assert.equal(classifyHostInjectContract(references).ok, false)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('infers ctx services only from executable member references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-impact-executable-ctx-'))
  try {
    await writeJson(join(root, 'package.json'), {
      name: 'executable-context-fixture',
      version: '0.1.0',
      type: 'module',
      main: './index.js',
    })
    await writeFile(join(root, 'index.js'), [
      "import './helper.js'",
      'export function apply(ctx) {',
      '  // ctx.webServer.register()',
      '  /* ctx.connection.rpc.handle() */',
      '  const quoted = "ctx.connection.rpc.handle()"',
      "  const alsoQuoted = 'ctx.webServer.register()'",
      `  const inertLookup = "ctx.get('inertLookupService')"`,
      '  const inertInject = `ctx.inject(dynamicServices, callback)`',
      '  const pattern = /ctx\\.webServer\\.register\\(\\)/',
      '  const inertTemplate = `ctx.connection.rpc.handle()`',
      '  if (ready) /ctx\\.connection\\.rpc\\.handle\\(\\)/.test(source)',
      '  const quotient = total / ctx.divisionService.value',
      '  const postfix = counter++ / ctx.postfixService.value',
      '  const captured = () => ctx.capturedService.value',
      '  const shadowed = (ctx) => ctx.shadowedService.value',
      "  ctx.get('lookupService')",
      "  ctx.inject(['injectedService'], () => {})",
      '  ctx.optionalMemberService?.run()',
      '  ctx.liveService.value',
      '  return `${ctx.templateExpressionService.value}:${ctx.liveService.value}:${quotient}`',
      '}',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(root, 'helper.js'), [
      'export function observe(ctx) {',
      '  const captured = () => ctx.helperCapturedService.value',
      '  const shadowed = (ctx) => ctx.helperShadowedService.value',
      '  return { captured, shadowed }',
      '}',
      '',
    ].join('\n'), 'utf8')

    const references = discoverUpstreamReferences(await scanOrdinaryTree(root))
    assert.deepEqual(references.services.map((value) => value.service), [
      'capturedService',
      'divisionService',
      'helperCapturedService',
      'injectedService',
      'liveService',
      'lookupService',
      'optionalMemberService',
      'postfixService',
      'templateExpressionService',
    ])
    assert.deepEqual(
      references.services.find((value) => value.service === 'helperCapturedService').evidence,
      [{ kind: 'context-property', path: 'helper.js' }],
    )
    assert.deepEqual(
      references.services.find((value) => value.service === 'liveService').evidence,
      [{ kind: 'context-property', path: 'index.js' }],
    )
    assert.deepEqual(references.coverage.undeclaredServices, [
      'capturedService',
      'divisionService',
      'helperCapturedService',
      'liveService',
      'lookupService',
      'optionalMemberService',
      'postfixService',
      'templateExpressionService',
    ])
    assert.deepEqual(
      references.services.find((value) => value.service === 'injectedService'),
      {
        service: 'injectedService',
        evidence: [{ kind: 'context-inject', requirement: 'runtime', path: 'index.js' }],
        declared: true,
      },
    )
    assert.deepEqual(references.coverage.unparsedInjectDeclarations, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('distinguishes statement regex boundaries from executable division-side ctx references', () => {
  const inspected = inspectExecutableContextReferences([
    'function declaration() {}',
    '  /ctx.fakeAfterFunction/.test(source)',
    'if (ready) {}',
    '  /ctx.fakeAfterIf/.test(source)',
    'class Feature {}',
    '  /ctx.fakeAfterClass/.test(source)',
    'function apply(ctx) {',
    '  const pattern = new /ctx.fakeAfterNew/',
    '  while (ready) { break',
    '    /ctx.fakeAfterBreak/.test(source)',
    '  }',
    '  while (ready) { continue',
    '    /ctx.fakeAfterContinue/.test(source)',
    '  }',
    '  breakLoop: while (ready) { break breakLoop',
    '    /ctx.fakeAfterLabeledBreak/.test(source)',
    '  }',
    '  continueLoop: while (ready) { continue continueLoop',
    '    /ctx.fakeAfterLabeledContinue/.test(source)',
    '  }',
    '  debugger',
    '  /ctx.fakeAfterDebugger/.test(source)',
    '  const objectValue = {} / ctx.objectDivision.value',
    '  const functionValue = function () {} / ctx.functionDivision.value',
    '  const arrowValue = (() => {}) / ctx.arrowDivision.value',
    '  const classValue = class {} / ctx.classDivision.value',
    '  counter++ / ctx.postfixDivision.value',
    '  ctx.optionalService?.run()',
    '}',
    '',
  ].join('\n'))

  assert.equal(inspected.complete, true)
  assert.deepEqual(inspected.properties, [
    'objectDivision',
    'functionDivision',
    'arrowDivision',
    'classDivision',
    'postfixDivision',
    'optionalService',
  ])
})

test('keeps executable ctx candidates and expression-local names in their exact scopes', () => {
  const inspected = inspectExecutableContextReferences([
    'function wrapper() {',
    '  function helper(ctx) {',
    '    ctx.requiredService.value',
    '    function nested(ctx) { ctx.doubleShadow.value }',
    '  }',
    '}',
    'const arrowWrapper = () => {',
    '  const helper = (ctx) => ctx.arrowRequiredService.value',
    '  return helper',
    '}',
    'function apply(ctx) {',
    '  ctx.beforeExpressionService.value',
    '  const fn = function ctx() { return ctx.functionNameShadow.value }',
    '  const Type = class ctx extends factory({ option: true }) {',
    '    method() { return ctx.classNameShadow.value }',
    '  }',
    '  ctx.afterExpressionService.value',
    '  return { fn, Type }',
    '}',
  ].join('\n'))

  assert.equal(inspected.complete, true)
  assert.deepEqual(inspected.properties, [
    'requiredService',
    'arrowRequiredService',
    'beforeExpressionService',
    'afterExpressionService',
  ])

  assert.deepEqual(inspectExecutableContextReferences([
    'function outer(ctx) {',
    '  ctx.beforeHoistedName.value',
    '  function ctx() { return ctx.functionDeclarationShadow.value }',
    '  ctx.afterHoistedName.value',
    '}',
  ].join('\n')), {
    complete: true,
    properties: [],
    serviceLookups: [],
    injections: [],
  })

  assert.deepEqual(inspectExecutableContextReferences([
    'function outer(ctx) {',
    '  ctx.beforeClassBlock.value',
    '  {',
    '    ctx.beforeClassDeclaration.value',
    '    class ctx { method() { return ctx.classDeclarationShadow.value } }',
    '    ctx.afterClassDeclaration.value',
    '  }',
    '  ctx.afterClassBlock.value',
    '}',
  ].join('\n')).properties, ['beforeClassBlock', 'afterClassBlock'])
})

test('uses exact bindings across defaults, methods, captures, blocks, catches, and loops', () => {
  const defaults = inspectExecutableContextReferences([
    'function own(ctx) {',
    '  ctx.ownBody.value',
    '  const arrowCapture = (value = ctx.arrowDefaultCapture.value) => ctx.arrowCapture.value',
    '  function functionCapture(value = ctx.functionDefaultCapture.value) { return ctx.functionCapture.value }',
    '  const holder = {',
    '    method(value = ctx.methodDefaultCapture.value) { return ctx.methodCapture.value },',
    '  }',
    '  const arrowShadow = (ctx = local) => ctx.arrowDefaultShadow.value',
    '  const methodShadow = { method(ctx = local) { return ctx.methodDefaultShadow.value } }',
    '  function functionShadow(ctx = local) { return ctx.functionDefaultShadow.value }',
    '  return { arrowCapture, functionCapture, holder, arrowShadow, methodShadow, functionShadow }',
    '}',
    'function extraParameter(other, ctx) { return ctx.extraParameter.value }',
    'function defaultParameter(ctx = local) { return ctx.defaultParameter.value }',
    'function restParameter(...ctx) { return ctx.restParameter.value }',
    'const arrowCandidate = (ctx) => ctx.arrowCandidate.value',
    'const methodCandidate = { method(ctx) { return ctx.methodCandidate.value } }',
  ].join('\n'))
  assert.equal(defaults.complete, true)
  assert.deepEqual(defaults.properties, [
    'ownBody',
    'arrowDefaultCapture',
    'arrowCapture',
    'functionDefaultCapture',
    'functionCapture',
    'methodDefaultCapture',
    'methodCapture',
    'defaultParameter',
    'arrowCandidate',
    'methodCandidate',
  ])

  const lexical = inspectExecutableContextReferences([
    'function apply(ctx) {',
    '  ctx.before.value',
    '  naked: { ctx.labeledBlock.value }',
    '  { ctx.beforeTdz.value; let ctx; ctx.afterTdz.value }',
    '  try { throw local } catch (ctx) { ctx.catchShadow.value }',
    '  try { throw local } catch ({ ctx = ctx.catchDefaultSelf.value }) { ctx.catchPatternShadow.value }',
    '  try { throw local } catch ({ nested: { ctx = ctx.nestedCatchDefaultSelf.value } }) { ctx.nestedCatchPatternShadow.value }',
    '  try { throw local } catch ({ other = ctx.catchCapturedDefault.value }) { other }',
    '  try { throw local } catch (error) { var ctx; ctx.catchVarNoAssignment.value }',
    '  for (let ctx of contexts) { ctx.letLoopShadow.value }',
    '  for (const { ctx } of contexts) { ctx.destructuredLoopShadow.value }',
    '  for (var ctx; ready;) { ctx.varLoopNoAssignment.value; break }',
    '  for (let index = 0; index < 1; index += 1) { ctx.loopCapture.value }',
    '  ctx.after.value',
    '}',
  ].join('\n'))
  assert.equal(lexical.complete, true)
  assert.deepEqual(lexical.properties, [
    'before', 'labeledBlock', 'catchCapturedDefault', 'catchVarNoAssignment', 'varLoopNoAssignment',
    'loopCapture', 'after',
  ])

  for (const overwritten of [
    [
      'function overwritten(ctx) {',
      '  for (var ctx of contexts) { ctx.varLoopShadow.value }',
      '  ctx.afterVarLoop.value',
      '}',
    ],
    [
      'function overwritten(ctx) {',
      '  try { throw local } catch (error) { var ctx = local; ctx.catchVarShadow.value }',
      '  ctx.afterCatchVar.value',
      '}',
    ],
  ]) {
    assert.deepEqual(inspectExecutableContextReferences(overwritten.join('\n')), {
      complete: false,
      properties: [],
      serviceLookups: [],
      injections: [],
    })
  }
})

test('admits the first ctx runtime parameter and classifies static optional context shapes', () => {
  const inspected = inspectExecutableContextReferences([
    'export function apply(ctx, config = {}, internals = {}) {',
    "  ctx?.['logger']?.info('ready')",
    "  ctx['get']?.('workspace')",
    "  ctx?.['inject']?.(['agentLoop'], () => {})",
    '  ctx[`commands`].register({})',
    '}',
    'function withDefault(ctx = ctx.defaultInitializerIsOutsideBody, config = {}) {',
    '  ctx.defaultBody.value',
    '}',
    'function second(config, ctx) { ctx.secondPosition.value }',
    'function rest(...ctx) { ctx.restPosition.value }',
  ].join('\n'))

  assert.deepEqual(inspected, {
    complete: true,
    properties: ['logger', 'get', 'inject', 'commands', 'defaultBody'],
    serviceLookups: ['workspace'],
    injections: [{ complete: true, values: ['agentLoop'] }],
  })

  for (const source of [
    'function apply(ctx) { const alias = ctx.logger }',
    'function apply(ctx) { const alias = ctx.logger.info }',
    'function apply(ctx) { const { logger } = ctx }',
    'function apply(ctx) { ctx[serviceName].run() }',
    'function apply(ctx) { consume(ctx) }',
    'function apply(ctx) { ctx.get(serviceName) }',
    "function apply(ctx) { ctx.inject(['agentLoop']) }",
  ]) {
    assert.equal(inspectExecutableContextReferences(source).complete, false, source)
  }

  const metadata = inspectExecutableModuleMetadata(
    'export function apply(ctx, config) { ctx.logger.info(config) }',
    { sourcePath: 'index.js' },
  )
  assert.equal(Object.isFrozen(metadata), true)
  assert.deepEqual(metadata.exports, [{
    name: 'apply',
    descriptors: [{ kind: 'function', functionId: metadata.functions[0].id }],
  }])

  assert.deepEqual(inspectExecutableContextReferences([
    'function apply(ctx) {',
    '  function inner() { var { ctx } = value; return ctx.innerShadow.value }',
    '  ctx.outerCapture.value',
    '}',
  ].join('\n')).properties, ['outerCapture'])
  assert.equal(inspectExecutableContextReferences([
    'function apply(ctx) {',
    '  var { ctx } = value',
    '  ctx.replaced.value',
    '}',
  ].join('\n')).complete, false)
})

test('includes later parameter initializers while excluding the canonical ctx initializer', () => {
  const inspected = inspectExecutableContextReferences([
    'function apply(',
    '  ctx = ctx.selfInitializer.value,',
    '  config = ctx.agentLoop.run(),',
    "  attachment = ctx.inject(['skills'], () => {}),",
    "  route = ctx.webServer.register({ kind: 'prefix', path: '/parameter' }),",
    '  { [ctx.keyName.value]: selected = ctx.destructuredDefault.value } = {},',
    ') {',
    '  ctx.bodyService.run()',
    '}',
  ].join('\n'))

  assert.deepEqual(inspected, {
    complete: true,
    properties: [
      'agentLoop',
      'inject',
      'webServer',
      'keyName',
      'destructuredDefault',
      'bodyService',
    ],
    serviceLookups: [],
    injections: [{ complete: true, values: ['skills'] }],
  })
})

test('fails direct eval, implicit arguments, and with-scoped ctx access closed', () => {
  for (const dynamicEval of [
    'eval("ctx.inject([\\"hidden\\"], callback)")',
    '(eval)("ctx.hiddenService.run()")',
    'function nested() { eval("ctx.hiddenService.run()") }; nested()',
  ]) {
    const inspected = inspectExecutableContextReferences([
      'function apply(ctx) {',
      `  ${dynamicEval}`,
      "  ctx.logger.info('visible')",
      '}',
    ].join('\n'))
    assert.equal(inspected.complete, false, dynamicEval)
    assert.deepEqual(inspected.properties, ['logger'], dynamicEval)
  }

  for (const laterInitializer of [
    'eval("ctx.hiddenService.run()")',
    'arguments[0]',
  ]) {
    const inspected = inspectExecutableContextReferences([
      `function apply(ctx, config = ${laterInitializer}) {`,
      "  ctx.logger.info('visible', config)",
      '}',
    ].join('\n'))
    assert.equal(inspected.complete, false, laterInitializer)
    assert.deepEqual(inspected.properties, ['logger'], laterInitializer)
  }

  for (const implicitArguments of [
    'arguments[0].hiddenService.run()',
    'consume(arguments)',
    'arguments[index].hiddenService.run()',
    'arguments.callee.hiddenService.run()',
    'const capture = () => arguments[0]',
    'function applyLater(ctx, config = arguments[0]) {}',
  ]) {
    const source = implicitArguments.startsWith('function ')
      ? `${implicitArguments}\nfunction visible(ctx) { ctx.logger.info('visible') }`
      : `function apply(ctx) { ${implicitArguments}; ctx.logger.info('visible') }`
    const inspected = inspectExecutableContextReferences(source)
    assert.equal(inspected.complete, false, implicitArguments)
  }

  for (const safe of [
    'function apply(ctx) { eval?.("ctx.hidden"); ctx.logger.info("visible") }',
    'function apply(ctx) { (0, eval)("ctx.hidden"); ctx.logger.info("visible") }',
    'function apply(ctx) { const invoke = eval; invoke("ctx.hidden"); ctx.logger.info("visible") }',
    'function apply(ctx) { globalThis.eval("ctx.hidden"); ctx.logger.info("visible") }',
    'function apply(ctx, eval) { eval("ctx.hidden"); ctx.logger.info("visible") }',
    'function apply(ctx) { function nested() { return arguments[0] }; ctx.logger.info("visible") }',
    'function apply(ctx, arguments) { arguments[0]; ctx.logger.info("visible") }',
    'const apply = (ctx) => { arguments[0]; ctx.logger.info("visible") }',
    'function apply(ctx) { arguments.length; arguments[1]; arguments["2"]; arguments[-1]; ctx.logger.info("visible") }',
  ]) {
    const inspected = inspectExecutableContextReferences(safe)
    assert.equal(inspected.complete, true, safe)
    assert.deepEqual(inspected.properties, ['logger'], safe)
  }

  const withScope = inspectExecutableContextReferences([
    'function apply(ctx) {',
    "  with (services) { ctx.inject(['hidden'], callback) }",
    "  ctx.logger.info('visible')",
    '}',
  ].join('\n'))
  assert.equal(withScope.complete, false)
  assert.deepEqual(withScope.properties, ['logger'])
  assert.deepEqual(withScope.injections, [])

  const withObject = inspectExecutableContextReferences([
    'function apply(ctx) {',
    '  with (ctx.scope) { consume(value) }',
    "  ctx.logger.info('visible')",
    '}',
  ].join('\n'))
  assert.equal(withObject.complete, true)
  assert.deepEqual(withObject.properties, ['scope', 'logger'])
})

test('fails Host attachment proof for with-scoped ctx access and implicit arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-impact-dynamic-context-'))
  try {
    await writeJson(join(root, 'package.json'), {
      name: 'dynamic-context-fixture',
      version: '0.1.0',
      main: './index.js',
    })
    for (const body of [
      "with (services) { ctx.inject(['hidden'], callback) }",
      'arguments[0].inject(["hidden"], callback)',
      'const capture = () => arguments[0]',
    ]) {
      await writeFile(join(root, 'index.js'), [
        'function apply(ctx) {',
        `  ${body}`,
        "  ctx.logger.info('visible')",
        '}',
        '',
      ].join('\n'), 'utf8')
      const references = discoverUpstreamReferences(await scanOrdinaryTree(root))
      assert.deepEqual(references.coverage.unparsedInjectDeclarations, ['index.js'], body)
      assert.equal(classifyHostInjectContract(references).ok, false, body)
    }

    await writeFile(join(root, 'index.js'), [
      'function apply(',
      '  ctx,',
      "  config = ctx.inject(['skills'], () => {}),",
      '  internals = ctx.agentLoop.run(),',
      ') { ctx.logger.info(config, internals) }',
      '',
    ].join('\n'), 'utf8')
    const laterParameters = discoverUpstreamReferences(await scanOrdinaryTree(root))
    assert.deepEqual(laterParameters.services.map((value) => value.service), [
      'agentLoop', 'skills',
    ])
    assert.deepEqual(laterParameters.coverage.unparsedInjectDeclarations, [])
    assert.equal(classifyHostInjectContract(laterParameters).ok, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolves class-name and heritage bindings without reading regex text', () => {
  const inspected = inspectExecutableContextReferences([
    'function apply(ctx) {',
    '  const Local = class Named extends mixin({ pattern: /ctx.fake/ }, ctx.expressionHeritage.Base) {',
    '    method() { return ctx.expressionMethod.value }',
    '  }',
    '  const Shadow = class ctx extends ctx.shadowHeritage.Base {',
    '    method() { return ctx.shadowMethod.value }',
    '  }',
    '  class Declared extends ctx.declarationHeritage.Base {',
    '    method() { return ctx.declarationMethod.value }',
    '  }',
    '  return { Local, Shadow, Declared }',
    '}',
  ].join('\n'))
  assert.equal(inspected.complete, true)
  assert.deepEqual(inspected.properties, [
    'expressionHeritage',
    'expressionMethod',
    'declarationHeritage',
    'declarationMethod',
  ])
})

test('keeps unary multiline arrows and naked blocks in their actual function scopes', () => {
  const inspected = inspectExecutableContextReferences([
    'function apply(ctx) {',
    '  const capturedType = () => typeof',
    '    ctx.typeCapture.value',
    '  const capturedVoid = () => void',
    '    ctx.voidCapture.value',
    '  const shadowed = (ctx) => typeof',
    '    ctx.unaryShadow.value',
    '  { ctx.nakedBlock.value }',
    '  routeLabel: { ctx.labeledBlock.value }',
    '  return { capturedType, capturedVoid, shadowed }',
    '}',
  ].join('\n'))
  assert.equal(inspected.complete, true)
  assert.deepEqual(inspected.properties, [
    'typeCapture', 'voidCapture', 'nakedBlock', 'labeledBlock',
  ])
})

test('does not let large runtime or type-only imports confuse value bindings', () => {
  const bindings = Array.from({ length: 140 }, (_, index) => `value${index} as local${index}`)
  const runtimeShadow = inspectExecutableContextReferences([
    `import { ${[...bindings, 'value as ctx'].join(', ')} } from 'host'`,
    'ctx.runtimeImportShadow.value',
  ].join('\n'), { sourcePath: 'index.js' })
  assert.deepEqual(runtimeShadow, {
    complete: true,
    properties: [],
    serviceLookups: [],
    injections: [],
  })

  for (const source of [
    "import type { value as ctx } from 'host'; ctx.unboundAfterTypeImport.value",
    "import { type value as ctx } from 'host'; ctx.unboundAfterSpecifierType.value",
    "import type ctx = require('host'); ctx.unboundAfterTypeImportEquals.value",
    'type ctx = { value: string }; ctx.unboundAfterTypeAlias.value',
    'declare const ctx: HostContext; ctx.unboundAfterDeclare.value',
  ]) {
    assert.deepEqual(inspectExecutableContextReferences(source, { sourcePath: 'index.ts' }), {
      complete: false,
      properties: [],
      serviceLookups: [],
      injections: [],
    })
  }

  const parameterWins = inspectExecutableContextReferences([
    "import type { value as ctx } from 'host'",
    'export function apply(ctx: HostContext) { ctx.parameterService.value }',
  ].join('\n'), { sourcePath: 'index.ts' })
  assert.equal(parameterWins.complete, true)
  assert.deepEqual(parameterWins.properties, ['parameterService'])
})

test('selects JS, JSX, TypeScript, and TSX grammars from path with a conservative fallback', () => {
  const jsx = inspectExecutableContextReferences(
    'function render(ctx) { return <View value={ctx.jsxService.value} /> }',
    { sourcePath: 'view.jsx' },
  )
  assert.equal(jsx.complete, true)
  assert.deepEqual(jsx.properties, ['jsxService'])

  const jsxMember = inspectExecutableContextReferences(
    'function render(ctx) { return <ctx.jsxComponent /> }',
    { sourcePath: 'component.jsx' },
  )
  assert.equal(jsxMember.complete, true)
  assert.deepEqual(jsxMember.properties, ['jsxComponent'])
  assert.equal(inspectExecutableContextReferences(
    'const rendered = <ctx.unboundComponent />',
    { sourcePath: 'unbound.jsx' },
  ).complete, false)

  const typescript = 'function apply(ctx: HostContext) { return ctx.typescriptService.value }'
  assert.deepEqual(
    inspectExecutableContextReferences(typescript, { sourcePath: 'index.ts' }).properties,
    ['typescriptService'],
  )
  assert.deepEqual(inspectExecutableContextReferences(typescript).properties, ['typescriptService'])

  const tsx = inspectExecutableContextReferences(
    'function render(ctx: HostContext) { return <View value={ctx.tsxService.value} /> }',
    { sourcePath: 'view.tsx' },
  )
  assert.equal(tsx.complete, true)
  assert.deepEqual(tsx.properties, ['tsxService'])

  assert.deepEqual(inspectExecutableContextReferences(typescript, { sourcePath: 'index.js' }), {
    complete: false,
    properties: [],
    serviceLookups: [],
    injections: [],
  })
})

test('distinguishes ASI declarations from newline-delimited function and class expressions', () => {
  const functionExpression = [
    'function apply(ctx) {',
    '  const value =',
    '  function named() {} / ctx.functionExpressionDivision.value',
    '}',
  ].join('\n')
  const classExpression = [
    'function apply(ctx) {',
    '  const value =',
    '  class {} / ctx.classExpressionDivision.value',
    '}',
  ].join('\n')
  assert.doesNotThrow(() => new Function(functionExpression))
  assert.doesNotThrow(() => new Function(classExpression))
  assert.deepEqual(inspectExecutableContextReferences(functionExpression).properties, [
    'functionExpressionDivision',
  ])
  assert.deepEqual(inspectExecutableContextReferences(classExpression).properties, [
    'classExpressionDivision',
  ])

  const asiDeclarations = inspectExecutableContextReferences([
    'function apply(ctx) {',
    '  const prior = value',
    '  function declared() {}',
    '  /ctx.fakeAfterFunctionDeclaration/.test(source)',
    '  const next = value',
    '  class Declared {}',
    '  /ctx.fakeAfterClassDeclaration/.test(source)',
    '  const pattern = /safe/',
    '  function declaredAfterRegex() {}',
    '  /ctx.fakeAfterRegexDeclaration/.test(source)',
    '  const asyncValue = async',
    '  function declaredAfterAsyncIdentifier() {}',
    '  /ctx.fakeAfterAsyncIdentifier/.test(source)',
    '  ctx.afterDeclarations.value',
    '}',
  ].join('\n'))
  assert.equal(asiDeclarations.complete, true)
  assert.deepEqual(asiDeclarations.properties, ['afterDeclarations'])
})

test('keeps tagged-template interpolations scoped across a large template expression', () => {
  const tagged = inspectExecutableContextReferences([
    'function apply(ctx) {',
    '  const nested = (ctx) => tag',
    '    `${ctx.firstTemplateShadow.value}:raw:${ctx.secondTemplateShadow.value}`',
    '  ctx.afterTaggedTemplate.value',
    '  const regexNested = (ctx) => /ctx.regexTextShadow/',
    '  ctx.afterRegexArrow.value',
    '  return { nested, regexNested }',
    '}',
  ].join('\n'))
  assert.equal(tagged.complete, true)
  assert.deepEqual(tagged.properties, ['afterTaggedTemplate', 'afterRegexArrow'])

  const expression = '[' + 'item,'.repeat(100_000) + 'ctx.largeTemplateService.value]'
  const largeTemplate = 'function apply(ctx) { const value = `${' + expression + '}` }'
  assert.doesNotThrow(() => new Function(largeTemplate))
  assert.deepEqual(inspectExecutableContextReferences(largeTemplate), {
    complete: true,
    properties: ['largeTemplateService'],
    serviceLookups: [],
    injections: [],
  })
})

test('resolves captured ctx against value-side bindings and excludes lexical shadows', () => {
  const inspected = inspectExecutableContextReferences([
    'function apply(ctx) {',
    '  function captured({ ctx: alias }) {',
    "    ctx.inject(['agentLoop'], () => {})",
    '    ctx.capturedService.value',
    '  }',
    '  function shorthand({ ctx }) { ctx.shorthandShadow.value }',
    '  function renamed({ x: ctx }) { ctx.renamedShadow.value }',
    '  for (const ctx of contexts) { ctx.loopShadow.value }',
    '  ctx.afterLoopService.value',
    '}',
    'const ctx = localContext',
    'ctx.topLevelLocal.value',
    '',
  ].join('\n'))

  assert.equal(inspected.complete, true)
  assert.deepEqual(inspected.properties, ['inject', 'capturedService', 'afterLoopService'])
  assert.deepEqual(inspected.injections, [{ complete: true, values: ['agentLoop'] }])

  assert.deepEqual(
    inspectExecutableContextReferences("import { value as ctx } from 'host'\nctx.importShadow.value"),
    { complete: true, properties: [], serviceLookups: [], injections: [] },
  )
  assert.deepEqual(
    inspectExecutableContextReferences("import { ctx as alias } from 'host'\nctx.unbound.value"),
    { complete: false, properties: [], serviceLookups: [], injections: [] },
  )
  assert.deepEqual(
    inspectExecutableContextReferences('function same(ctx) { ctx.before; var ctx; ctx.after }'),
    {
      complete: true,
      properties: ['before', 'after'],
      serviceLookups: [],
      injections: [],
    },
  )
  assert.deepEqual(
    inspectExecutableContextReferences('function replaced(ctx) { ctx.before; var ctx = local; ctx.after }'),
    { complete: false, properties: [], serviceLookups: [], injections: [] },
  )
})

test('fails attachment inference closed without retaining evidence from an invalid AST', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-impact-incomplete-ctx-'))
  try {
    await writeJson(join(root, 'package.json'), {
      name: 'incomplete-context-fixture',
      version: '0.1.0',
      type: 'module',
      main: './index.js',
    })
    let tooDeep = 'ctx.beyondNestingLimitService.value'
    for (let depth = 0; depth <= EXECUTABLE_SOURCE_NESTING_LIMIT; depth += 1) {
      tooDeep = '`${' + tooDeep + '}`'
    }
    let mixedTooDeep = 'ctx.beyondMixedNestingLimitService.value'
    for (let depth = 0; depth <= EXECUTABLE_SOURCE_NESTING_LIMIT / 2; depth += 1) {
      mixedTooDeep = '(`${' + mixedTooDeep + '}`)'
    }
    for (const incomplete of [
      '/* unterminated',
      'const value = "unterminated',
      'const value = /unterminated',
      'const value = `unterminated',
      'const value = (unterminated',
      'const value = ([)]',
      'const value = /escaped\\\nctx.hiddenByEscapedNewline/',
      'const value = ' + '('.repeat(EXECUTABLE_SOURCE_NESTING_LIMIT + 1),
      'const value = ' + tooDeep,
      'const value = ' + mixedTooDeep,
    ]) {
      await writeFile(join(root, 'index.js'), [
        'function apply(ctx) { ctx.beforeGapService.value }',
        incomplete,
        '',
      ].join('\n'), 'utf8')
      const references = discoverUpstreamReferences(await scanOrdinaryTree(root))
      assert.deepEqual(references.services.map((value) => value.service), [])
      assert.deepEqual(references.coverage.unparsedInjectDeclarations, ['index.js'])
      assert.equal(classifyHostInjectContract(references).ok, false)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bounds structural and scope work deterministically without partial AST claims', () => {
  const functions = []
  for (let index = 0; index <= EXECUTABLE_SOURCE_SCOPE_LIMIT; index += 1) {
    functions.push(`function bounded${index}() {}`)
  }
  const inspected = inspectExecutableContextReferences([
    'function apply(ctx) { ctx.beforeScopeLimit.value }',
    ...functions,
  ].join('\n'))
  assert.equal(inspected.complete, false)
  assert.deepEqual(inspected.properties, [])

  for (const gap of [
    'const broken = ([)]',
    'const broken = /escaped\\\nctx.hiddenByRegex/',
    '/* unterminated',
  ]) {
    const partial = inspectExecutableContextReferences(
      `function apply(ctx) { ctx.beforePartialGap.value; ${gap}`,
    )
    assert.equal(partial.complete, false)
    assert.deepEqual(partial.properties, [])
  }

  assert.deepEqual(inspectExecutableContextReferences('ctx.unboundService.value'), {
    complete: false,
    properties: [],
    serviceLookups: [],
    injections: [],
  })

  assert.deepEqual(inspectExecutableContextReferences(' '.repeat(EXECUTABLE_SOURCE_BYTES_LIMIT + 1)), {
    complete: false,
    properties: [],
    serviceLookups: [],
    injections: [],
  })
  const tooManyNodes = 'a;'.repeat(Math.floor(EXECUTABLE_SOURCE_NODE_LIMIT / 2) + 100)
  assert.deepEqual(inspectExecutableContextReferences(tooManyNodes), {
    complete: false,
    properties: [],
    serviceLookups: [],
    injections: [],
  })

  const semicolonless = ['function apply(ctx) {']
  for (let index = 0; index < 2000; index += 1) {
    semicolonless.push(`const local${index} = value${index}`)
  }
  semicolonless.push('ctx.afterSemicolonless.value', '}')
  const lineBounded = inspectExecutableContextReferences(semicolonless.join('\n'))
  assert.equal(lineBounded.complete, true)
  assert.deepEqual(lineBounded.properties, ['afterSemicolonless'])

  const duplicateShadows = ['function apply(ctx) {']
  for (let index = 0; index <= EXECUTABLE_SOURCE_SCOPE_LIMIT; index += 1) {
    duplicateShadows.push(`const ctx = local${index};`)
  }
  duplicateShadows.push('ctx.shadowed.value', '}')
  assert.deepEqual(inspectExecutableContextReferences(duplicateShadows.join('\n')), {
    complete: false,
    properties: [],
    serviceLookups: [],
    injections: [],
  })
})

test('classifies exact public-surface facts without treating version churn as a contract change', () => {
  const base = {
    name: '@deepseek-ai/dsh-skill',
    version: '0.1.1-rc.2',
    access: 'public',
    manifest: {
      exports: { '.': './lib/index.js' },
      peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
    },
    declarations: { 'lib/types/index.d.ts': 'sha256:one' },
    entries: { 'lib/index.js': 'sha256:entry' },
    digest: 'sha256:release',
  }
  const versionOnly = structuredClone(base)
  versionOnly.version = '0.1.2-alpha.3'
  versionOnly.digest = 'sha256:preview'
  assert.equal(comparePackageSurfaces(base.name, base, versionOnly).classification, 'package-version')

  const changed = structuredClone(versionOnly)
  changed.declarations['lib/types/index.d.ts'] = 'sha256:two'
  const result = comparePackageSurfaces(base.name, base, changed)
  assert.equal(result.classification, 'contract')
  assert.deepEqual(result.reasons, ['declarations-changed', 'version-changed'])
  assert.deepEqual(result.changedFiles.declarations.map((value) => value.status), ['changed'])
})

test('rejects malformed attachment declarations instead of silently widening inference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-impact-declaration-'))
  try {
    await sourceFixture(root, {
      dshDeveloper: {
        upstream: {
          packages: ['not-an-official-package'],
          services: ['skills'],
        },
      },
    })
    const tree = await scanOrdinaryTree(root)
    assert.throws(
      () => discoverUpstreamReferences(tree),
      (error) => error.code === 'IMPACT_DECLARATION_INVALID',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('distinguishes browser package metadata from invalid Host Cordis injections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-impact-client-inject-'))
  try {
    await sourceFixture(root, {
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { inject: ['@deepseek-ai/dsh-client-runtime'] },
      },
    })
    let references = discoverUpstreamReferences(await scanOrdinaryTree(root))
    assert.equal(classifyHostInjectContract(references).ok, true)

    await writeFile(join(root, 'index.js'), [
      "export const inject = ['@deepseek-ai/dsh-client-runtime']",
      'export async function apply() {}',
      '',
    ].join('\n'), 'utf8')
    references = discoverUpstreamReferences(await scanOrdinaryTree(root))
    const contract = classifyHostInjectContract(references)
    assert.equal(contract.ok, false)
    assert.deepEqual(contract.unparsedDeclarations, [])
    assert.deepEqual(contract.invalidValues, [])
    assert.deepEqual(contract.clientPackageInjections, [{
      path: 'index.js',
      kind: 'inject',
      value: '@deepseek-ai/dsh-client-runtime',
    }])

    await writeFile(join(root, 'index.js'), [
      'export async function apply(ctx, config = {}) {',
      "  ctx?.['inject']?.(['@deepseek-ai/dsh-client-runtime'], () => config)",
      '}',
      '',
    ].join('\n'), 'utf8')
    references = discoverUpstreamReferences(await scanOrdinaryTree(root))
    const computedContract = classifyHostInjectContract(references)
    assert.equal(computedContract.ok, false)
    assert.deepEqual(computedContract.unparsedDeclarations, [])
    assert.deepEqual(computedContract.clientPackageInjections, [{
      path: 'index.js',
      kind: 'context-inject',
      value: '@deepseek-ai/dsh-client-runtime',
    }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('maps a declared service to exact package owners and emits stable scoped impact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-developer-impact-'))
  const source = join(root, 'source')
  try {
    await mkdir(source)
    await sourceFixture(source, {
      peerDependencies: { '@deepseek-ai/dsh-skill': '^0.1.1-rc.2 || ^0.1.2-alpha.3' },
      devDependencies: { '@deepseek-ai/dsh-skill': '^0.1.1-rc.2 || ^0.1.2-alpha.3' },
    })
    const releaseDsh = await installedPackage(
      join(root, 'release-dsh'),
      '@deepseek-ai/dsh',
      '0.1.1-rc.2',
      'export interface Dsh {}\n',
    )
    const previewDsh = await installedPackage(
      join(root, 'preview-dsh'),
      '@deepseek-ai/dsh',
      '0.1.2-alpha.3',
      'export interface Dsh {}\n',
    )
    const releaseSkill = await installedPackage(
      join(root, 'release-skill'),
      '@deepseek-ai/dsh-skill',
      '0.1.1-rc.2',
      "declare module '@deepseek-ai/cordis' { interface Context { skills: object } }\n",
    )
    const previewSkill = await installedPackage(
      join(root, 'preview-skill'),
      '@deepseek-ai/dsh-skill',
      '0.1.2-alpha.3',
      "declare module '@deepseek-ai/cordis' { interface Context { skills: { register(value: unknown): void } } }\n",
    )
    const inventories = {
      '0.1.1-rc.2': new Map([
        ['@deepseek-ai/dsh', releaseDsh],
        ['@deepseek-ai/dsh-skill', releaseSkill],
      ]),
      '0.1.2-alpha.3': new Map([
        ['@deepseek-ai/dsh', previewDsh],
        ['@deepseek-ai/dsh-skill', previewSkill],
      ]),
    }
    const dependencies = {
      resolveDshInvocation: async (value) => ({ displayPath: value, prefixArgs: [] }),
      assertOfficialDshInvocation: async (invocation) => invocation.displayPath === 'release' ? releaseDsh : previewDsh,
      packageInventory: async (dshPackage) => inventories[dshPackage.value.version],
      serviceIndex: async () => new Map([['skills', ['@deepseek-ai/dsh-skill']]]),
      locateInstalledDshPackage: async (dshPackage, name) => inventories[dshPackage.value.version].get(name),
    }
    const first = await inspectUpstreamImpactInternal(source, {
      releaseDsh: 'release',
      previewDsh: 'preview',
    }, dependencies)
    const second = await inspectUpstreamImpactInternal(source, {
      releaseDsh: 'release',
      previewDsh: 'preview',
    }, dependencies)
    assert.equal(first.ok, true, JSON.stringify(first, null, 2))
    assert.deepEqual(first.serviceMappings, [{
      service: 'skills',
      declared: true,
      release: ['@deepseek-ai/dsh-skill'],
      preview: ['@deepseek-ai/dsh-skill'],
    }])
    assert.equal(first.changes.find((value) => value.package === '@deepseek-ai/dsh-skill').classification, 'contract')
    assert.equal(first.cohortRanges.length, 2)
    assert.deepEqual(first.cohortRanges.map((value) => value.acceptedLanes), [
      ['release', 'preview'],
      ['release', 'preview'],
    ])
    assert.equal(first.evidenceDigest, second.evidenceDigest)
    assert.match(formatUpstreamImpactReport(first), /^PASS DSH upstream impact impact-fixture/u)

    await writeFile(join(source, 'index.js'), [
      "const required = ['skills']",
      'export const inject = Object.freeze(required)',
      'export async function apply() {}',
      '',
    ].join('\n'), 'utf8')
    const dynamic = await inspectUpstreamImpactInternal(source, {
      releaseDsh: 'release',
      previewDsh: 'preview',
    }, dependencies)
    assert.equal(dynamic.ok, false)
    const failed = dynamic.checks.find((value) => value.id === 'source.inject-contract')
    assert.equal(failed.status, 'FAIL')
    assert.deepEqual(failed.evidence.paths, ['index.js'])

    await writeFile(join(source, 'index.js'), [
      "export const inject = ['skills']",
      'export async function apply(ctx) { ctx.inject(runtimeServices(), () => {}) }',
      '',
    ].join('\n'), 'utf8')
    const dynamicContext = await inspectUpstreamImpactInternal(source, {
      releaseDsh: 'release',
      previewDsh: 'preview',
    }, dependencies)
    assert.equal(dynamicContext.ok, false)
    const contextFailure = dynamicContext.checks.find((value) => value.id === 'source.inject-contract')
    assert.equal(contextFailure.status, 'FAIL')
    assert.deepEqual(contextFailure.evidence.paths, ['index.js'])

    await sourceFixture(source, {
      peerDependencies: { '@deepseek-ai/dsh-skill': '^0.1.0-rc.8' },
      devDependencies: { '@deepseek-ai/dsh-skill': '^0.1.0-rc.8' },
    })
    const stale = await inspectUpstreamImpactInternal(source, {
      releaseDsh: 'release',
      previewDsh: 'preview',
    }, dependencies)
    assert.equal(stale.ok, false)
    assert.equal(stale.checks.find((value) => value.id === 'source.release-cohort-coverage').status, 'FAIL')
    assert.equal(stale.checks.find((value) => value.id === 'source.preview-cohort-coverage').status, 'WARN')
    assert.match(formatUpstreamImpactReport(stale), /\^0\.1\.0-rc\.8 \[release:miss, preview:miss\]/u)

    await sourceFixture(source, {
      peerDependencies: { '@deepseek-ai/dsh-skill': '^0.1.2-alpha.2' },
      devDependencies: { '@deepseek-ai/dsh-skill': '^0.1.2-alpha.2' },
    })
    const upgraded = await inspectUpstreamImpactInternal(source, {
      releaseDsh: 'release',
      previewDsh: 'preview',
    }, dependencies)
    assert.equal(upgraded.ok, false)
    assert.equal(upgraded.checks.find((value) => value.id === 'source.release-cohort-coverage').status, 'FAIL')
    assert.equal(upgraded.checks.find((value) => value.id === 'source.preview-cohort-coverage').status, 'PASS')
    assert.deepEqual(upgraded.cohortRanges.map((value) => value.acceptedLanes), [['preview'], ['preview']])

    await sourceFixture(source, {
      peerDependencies: { '@deepseek-ai/dsh-skill': 'workspace:^' },
      devDependencies: { '@deepseek-ai/dsh-skill': 'workspace:^' },
    })
    const unknown = await inspectUpstreamImpactInternal(source, {
      releaseDsh: 'release',
      previewDsh: 'preview',
    }, dependencies)
    assert.equal(unknown.ok, false)
    assert.equal(unknown.checks.find((value) => value.id === 'source.release-cohort-coverage').status, 'FAIL')
    assert.equal(unknown.checks.find((value) => value.id === 'source.preview-cohort-coverage').status, 'WARN')
    assert.equal(unknown.cohortRanges.every((value) => value.status === 'unknown'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps the public impact option surface closed before reading source', async () => {
  await assert.rejects(
    inspectUpstreamImpact('C:\\never-read', {
      releaseDsh: 'release',
      previewDsh: 'preview',
      execute: true,
    }),
    (error) => error.code === 'IMPACT_OPTIONS_INVALID',
  )
  await assert.rejects(
    inspectUpstreamImpact('C:\\never-read', { releaseDsh: 'release' }),
    (error) => error.code === 'IMPACT_OPTIONS_INVALID',
  )
})
