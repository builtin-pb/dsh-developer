import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import ts from 'typescript'
import { typecheck } from '../scripts/typecheck.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const policy = join(root, 'lib/ui-policy.js')
const defaultHmr = '@deepseek-ai/cordis-plugin-hmr'
const currentHmr = '@deepseek-ai/dsh-hmr'
const execute = promisify(execFile)
const samePath = (left, right) => resolve(left) === resolve(right)
const inDirectory = (path, directory) => resolve(path).startsWith(resolve(directory) + sep)
const format = diagnostics => ts.formatDiagnostics(diagnostics, {
  getCanonicalFileName: path => path, getCurrentDirectory: () => root, getNewLine: () => '\n',
})
const clean = result => assert.equal(result.diagnostics.length, 0, format(result.diagnostics))
const hasCode = (result, code) => result.diagnostics.some(error => error.code === code)
const declarationPath = (program, name) => {
  const file = program.getSourceFiles().find(file => file.fileName.replaceAll('\\', '/').endsWith(`/node_modules/@deepseek-ai/${name}/lib/types/index.d.ts`))
  assert.ok(file, `Actual published ${name} declarations must be in the program`)
  return resolve(file.fileName)
}

test('default runner checks the same real roots and options as the pinned compiler', async () => {
  const result = await typecheck()
  clean(result)
  const configPath = join(root, 'tsconfig.json')
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: error => assert.fail(format([error])),
  })
  assert.deepEqual(result.program.getRootFileNames(), config.fileNames)
  assert.deepEqual(result.program.getCompilerOptions(), config.options)
  assert.equal(config.options.skipLibCheck, false, 'Broken transitive named imports must not erase checked boundary types to any')
  assert.ok(inDirectory(declarationPath(result.program, 'dsh-tools'), join(root, 'node_modules')))
  assert.ok(result.program.getSourceFiles().some(file => inDirectory(file.fileName, join(root, 'node_modules/@types/node'))))
  for (const path of config.fileNames.filter(path => /\.[cm]?js$/u.test(path))) {
    const source = result.program.getSourceFile(path)
    assert.equal(source.checkJsDirective?.enabled, true, path)
    assert.doesNotMatch(source.text, /@ts-(?:nocheck|ignore|expect-error)\b/u, `Checked implementation must not suppress errors: ${path}`)
  }
})

test('root marker validation uses the effective TypeScript directive', async t => {
  const f = await fixture(t)
  await f.main('export const value = 1\n')
  const path = join(f.directory, 'main.js')
  const body = 'export const value = 1\n'
  for (const [name, replacement] of [
    ['absent', body],
    ['string literal', `const marker = '@ts-check'\n${body}`],
    ['late comment', `${body}\n// @ts-check\n`],
    ['disabled after check', `// @ts-check\n// @ts-nocheck\n${body}`],
  ]) {
    await t.test(name, async () => {
      const result = await typecheck({ configPath: f.configPath,
        readFile: candidate => samePath(candidate, path) ? replacement : ts.sys.readFile(candidate) })
      assert.ok(result.diagnostics.some(error => error.code === 90001 && error.file && samePath(error.file.fileName, path)), format(result.diagnostics))
    })
  }
})

const lanes = [
  ['local', undefined],
  ['npm', process.env.DSH_TYPECHECK_NPM_RUNTIME],
  ['pnpm', process.env.DSH_TYPECHECK_PNPM_RUNTIME],
  ['current alpha', process.env.DSH_TYPECHECK_ALPHA_RUNTIME],
]

for (const [label, runtime] of lanes) {
  test(`published declaration mutations reach actual JS call sites (${label})`, {
    skip: label !== 'local' && !runtime
      ? 'Set DSH_TYPECHECK_NPM_RUNTIME / DSH_TYPECHECK_PNPM_RUNTIME / DSH_TYPECHECK_ALPHA_RUNTIME to test real installs.' : false,
  }, async t => {
    const baseline = await typecheck({ runtime })
    clean(baseline)
    const tools = declarationPath(baseline.program, 'dsh-tools')
    if (runtime) {
      const laneRoot = await realpath(runtime)
      assert.ok(inDirectory(tools, laneRoot), tools)
      const dsh = JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
      const toolsVersion = JSON.parse(await readFile(resolve(dirname(tools), '../../package.json'), 'utf8')).version
      assert.equal(toolsVersion, dsh.version)
      assert.equal(baseline.program.getSourceFiles().some(file => inDirectory(file.fileName, join(root, 'node_modules/@deepseek-ai'))), false)
      assert.ok(baseline.program.getSourceFiles().some(file => inDirectory(file.fileName, join(root, 'node_modules/@types/node'))))
      const providers = [defaultHmr, currentHmr].filter(name => Object.hasOwn(dsh.dependencies, name))
      assert.equal(providers.length, 1)
      assert.equal(baseline.program.getCompilerOptions().types.includes(defaultHmr), false)
      const hmr = declarationPath(baseline.program, providers[0].slice('@deepseek-ai/'.length))
      assert.ok(baseline.program.getRootFileNames().some(path => samePath(path, hmr)))
      await t.test('selected HMR declaration checks the actual watch callback', async () => {
        const original = await readFile(hmr, 'utf8')
        assert.equal(original.split("'hmr/reload'").length, 2)
        const result = await typecheck({ runtime, readFile: candidate => samePath(candidate, hmr)
          ? original.replace("'hmr/reload'", "'hmr/renamed-reload'") : ts.sys.readFile(candidate) })
        assert.ok(result.diagnostics.some(error => error.file && samePath(error.file.fileName, join(root, 'lib/development-watch-probe.js'))
          && /hmr\/reload/u.test(ts.flattenDiagnosticMessageText(error.messageText, '\n'))), format(result.diagnostics))
        assert.equal(await readFile(hmr, 'utf8'), original)
      })
    }
    const mutations = [
      ['method rename', tools, 'guard(guard: ToolGuard)', 'renamedGuard(guard: ToolGuard)', 2339],
      ['parameter shape', tools, 'guard(guard: ToolGuard)', 'guard(guard: string)', 2345],
      ['callback return', tools,
        'export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;',
        'export type ToolGuard = (execution: Readonly<ToolExecution>) => boolean;', 2345],
      ['service key', declarationPath(baseline.program, 'dsh-sandbox-policy'),
        'sandboxPolicy: SandboxPolicyService;', 'renamedSandboxPolicy: SandboxPolicyService;'],
    ]
    for (const [name, path, before, after, code] of mutations) {
      await t.test(name, async () => {
        const original = await readFile(path, 'utf8')
        assert.equal(original.split(before).length, 2, `Mutation must hit exactly one published declaration: ${name}`)
        let reads = 0
        const result = await typecheck({ runtime, readFile: candidate => {
          if (!samePath(candidate, path)) return ts.sys.readFile(candidate)
          reads++
          return original.replace(before, after)
        } })
        assert.ok(reads > 0)
        assert.deepEqual(result.program.getRootFileNames(), baseline.program.getRootFileNames())
        if (code) {
          assert.ok(result.diagnostics.some(error => error.code === code && error.file && samePath(error.file.fileName, policy)
            && /guard|uiSafetyGuardReason/u.test(error.file.text.slice(error.start, error.start + error.length))), format(result.diagnostics))
        } else {
          assert.ok(result.diagnostics.some(error => [2339, 2344, 2345, 1360].includes(error.code)
            && error.file && inDirectory(error.file.fileName, join(root, 'lib'))
            && /sandboxPolicy/u.test(ts.flattenDiagnosticMessageText(error.messageText, '\n'))), format(result.diagnostics))
        }
        assert.equal(await readFile(path, 'utf8'), original, 'Published declarations must remain unchanged on disk')
      })
    }
    await t.test('approval service must return the synchronous policy consumed by the authority boundary', async () => {
      const path = declarationPath(baseline.program, 'dsh-user-approval')
      const original = await readFile(path, 'utf8')
      const before = 'overrideOf(session: Session): ApprovalPolicy | undefined;'
      assert.equal(original.split(before).length, 2)
      const result = await typecheck({ runtime, readFile: candidate => samePath(candidate, path)
        ? original.replace(before, 'overrideOf(session: Session): Promise<ApprovalPolicy | undefined>;') : ts.sys.readFile(candidate) })
      assert.ok(result.diagnostics.some(error => [2322, 2345].includes(error.code)
        && error.file && samePath(error.file.fileName, join(root, 'lib/delegation-safety.js'))
        && /Promise/u.test(ts.flattenDiagnosticMessageText(error.messageText, '\n'))), format(result.diagnostics))
      assert.equal(await readFile(path, 'utf8'), original)
    })
    await t.test('transitive named export cannot erase a boundary type to any', async () => {
      const path = declarationPath(baseline.program, 'dsh-session')
      const original = await readFile(path, 'utf8')
      const before = 'export declare class Session {'
      assert.equal(original.split(before).length, 2)
      const result = await typecheck({ runtime, readFile: candidate => samePath(candidate, path)
        ? original.replace(before, 'export declare class RenamedSession {') : ts.sys.readFile(candidate) })
      assert.ok(result.diagnostics.some(error => [2305, 2724].includes(error.code)
        && /Session/u.test(ts.flattenDiagnosticMessageText(error.messageText, '\n'))), format(result.diagnostics))
      assert.equal(await readFile(path, 'utf8'), original)
    })
    await t.test('session header rename reaches the native cell adapter', async () => {
      const path = join(dirname(declarationPath(baseline.program, 'dsh-session')), 'types.d.ts')
      const original = await readFile(path, 'utf8')
      const before = 'readonly id: SessionId;'
      assert.equal(original.split(before).length, 2)
      const result = await typecheck({ runtime, readFile: candidate => samePath(candidate, path)
        ? original.replace(before, 'readonly renamedId: SessionId;') : ts.sys.readFile(candidate) })
      assert.ok(result.diagnostics.some(error => [2339, 2551].includes(error.code)
        && error.file && samePath(error.file.fileName, join(root, 'lib/native-cell-context.js'))
        && /\bid\b/u.test(ts.flattenDiagnosticMessageText(error.messageText, '\n'))), format(result.diagnostics))
      assert.equal(await readFile(path, 'utf8'), original)
    })
  })
}

async function put(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
}

// Tiny packages below exercise resolution and nominal identity only. API
// compatibility is tested above using actual installed upstream declarations.
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh typecheck ü ')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const runtime = join(directory, 'runtime')
  const configPath = join(directory, 'tsconfig.json')
  await put(join(directory, 'package.json'), { type: 'module' })
  await put(configPath, {
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, allowJs: true, checkJs: false, skipLibCheck: true, noEmit: true,
      noUncheckedSideEffectImports: true, types: [] },
    files: ['main.js'],
  })
  async function pkg(packageRoot, name, declarations = '', extra = {}) {
    await put(join(packageRoot, 'package.json'), {
      name, version: '1.0.0', type: 'module', types: './index.d.ts',
      exports: { '.': { types: './index.d.ts', default: './index.js' } }, ...extra,
    })
    await put(join(packageRoot, 'index.d.ts'), declarations)
    await put(join(packageRoot, 'index.js'), 'throw new Error("Typechecking must never execute an installed package")\n')
    return packageRoot
  }
  async function link(target, path) {
    await mkdir(dirname(path), { recursive: true })
    await symlink(target, path, 'junction')
  }
  return { directory, runtime, configPath, pkg, link,
    main: source => put(join(directory, 'main.js'), '// @ts-check\n' + source),
    check: options => typecheck({ runtime, configPath, ...options }),
  }
}

async function setTypes(f, types) {
  const config = JSON.parse(await readFile(f.configPath, 'utf8'))
  config.compilerOptions.types = types
  await put(f.configPath, config)
}

for (const [provider, layout] of [[defaultHmr, 'npm'], [currentHmr, 'pnpm']]) {
  test(`selects the CLI's published HMR provider (${layout}, ${provider})`, async t => {
    const f = await fixture(t)
    const modules = join(f.runtime, 'node_modules')
    const packageRoot = name => layout === 'npm' ? join(modules, name)
      : join(modules, '.pnpm', name.replace('/', '+') + '@1.0.0', 'node_modules', name)
    const dsh = await f.pkg(packageRoot('@deepseek-ai/dsh'), '@deepseek-ai/dsh', '', { dependencies: { [provider]: '*' } })
    const installed = await f.pkg(packageRoot(provider), provider,
      'export {}; declare global { const typecheckProvider: "lane"; }\n')
    if (layout === 'pnpm') {
      await f.link(dsh, join(modules, '@deepseek-ai/dsh'))
      await f.link(installed, join(dirname(dsh), provider.slice('@deepseek-ai/'.length)))
    }
    const pinned = await f.pkg(join(f.directory, 'node_modules', defaultHmr), defaultHmr,
      'export {}; declare global { const typecheckProvider: "pinned"; }\n')
    await f.pkg(join(f.directory, 'node_modules/typecheck-root-types'), 'typecheck-root-types',
      'export {}; declare global { const rootTypeDependency: number; }\n')
    await setTypes(f, [defaultHmr, 'typecheck-root-types'])
    await f.main('export const selected = typecheckProvider\nexport const rootType = rootTypeDependency\n')
    const local = await typecheck({ configPath: f.configPath })
    clean(local)
    assert.ok(local.program.getSourceFile(join(pinned, 'index.d.ts')))
    const lane = await f.check()
    clean(lane)
    assert.deepEqual(lane.program.getCompilerOptions().types, ['typecheck-root-types'])
    assert.deepEqual(lane.program.getRootFileNames().map(path => resolve(path)), [join(f.directory, 'main.js'), join(installed, 'index.d.ts')])
    assert.equal(lane.program.getSourceFile(join(pinned, 'index.d.ts')), undefined)
    assert.equal(lane.program.getSourceFile(join(f.directory, 'main.js')).text, local.program.getSourceFile(join(f.directory, 'main.js')).text)

    const missing = await f.check({ readFile: path => samePath(path, join(installed, 'index.d.ts')) ? undefined : ts.sys.readFile(path) })
    assert.ok(missing.diagnostics.some(error => error.code === 90002 && /HMR provider/u.test(error.messageText)), format(missing.diagnostics))
    assert.equal(missing.program.getSourceFile(join(pinned, 'index.d.ts')), undefined)
    if (provider === currentHmr) {
      await f.main(`import '${defaultHmr}'\n`)
      const noAlias = await f.check()
      assert.ok(noAlias.diagnostics.some(error => error.code === 90002 && /no package/u.test(error.messageText)), format(noAlias.diagnostics))
    }
  })
}

test('HMR selection requires exactly one direct CLI dependency only when requested', async t => {
  for (const selection of ['none', 'both', 'indirect']) {
    await t.test(selection, async () => {
      const f = await fixture(t)
      const modules = join(f.runtime, 'node_modules')
      const bridge = '@deepseek-ai/typecheck-bridge'
      const dependencies = selection === 'both' ? { [defaultHmr]: '*', [currentHmr]: '*' }
        : selection === 'indirect' ? { [bridge]: '*' } : {}
      await f.pkg(join(modules, '@deepseek-ai/dsh'), '@deepseek-ai/dsh', '', { dependencies })
      await f.pkg(join(modules, bridge), bridge, '', { dependencies: { [currentHmr]: '*' } })
      for (const provider of [defaultHmr, currentHmr]) await f.pkg(join(modules, provider), provider, 'export {}\n')
      await f.main('export {}\n')
      const custom = await f.check()
      clean(custom)
      assert.deepEqual(custom.program.getRootFileNames().map(path => resolve(path)), [join(f.directory, 'main.js')])
      await setTypes(f, [defaultHmr])
      const requested = await f.check()
      assert.ok(requested.diagnostics.some(error => error.code === 90002 && /exactly one HMR provider/u.test(error.messageText)), format(requested.diagnostics))
    })
  }
})

for (const layout of ['npm', 'pnpm']) {
  test(`selects published subpaths through ${layout} dependency and peer edges`, async t => {
    const f = await fixture(t)
    const modules = join(f.runtime, 'node_modules')
    const packageRoot = name => layout === 'npm'
      ? join(modules, '@deepseek-ai', name)
      : join(modules, '.pnpm', name + '@2.0.0', 'node_modules', '@deepseek-ai', name)
    const apiName = '@deepseek-ai/typecheck-api'
    const bridgeName = '@deepseek-ai/typecheck-bridge'
    const dsh = await f.pkg(packageRoot('dsh'), '@deepseek-ai/dsh', '', { dependencies: { [bridgeName]: '*' } })
    const bridge = await f.pkg(packageRoot('typecheck-bridge'), bridgeName, '', { peerDependencies: { [apiName]: '*' } })
    const api = await f.pkg(packageRoot('typecheck-api'), apiName, '', {
      version: '2.0.0', exports: { './feature': { types: './feature.d.ts', default: './index.js' } },
    })
    await put(join(api, 'feature.d.ts'), 'export const lane: "selected";\n')
    if (layout === 'pnpm') {
      await f.link(dsh, join(modules, '@deepseek-ai/dsh'))
      await f.link(bridge, join(dirname(dsh), 'typecheck-bridge'))
      await f.link(api, join(dirname(bridge), 'typecheck-api'))
      assert.equal(existsSync(join(modules, apiName)), false, 'No hoisted API package may be needed')
    }
    const local = await f.pkg(join(f.directory, 'node_modules', apiName), apiName, '', {
      version: '99.0.0', exports: { './feature': { types: './feature.d.ts', default: './index.js' } },
    })
    await put(join(local, 'feature.d.ts'), 'export const lane: "local";\n')
    await f.main(`import { lane } from '${apiName}/feature'\n/** @type {'selected'} */ const selected = lane\n`)
    const selected = await f.check()
    clean(selected)
    assert.ok(selected.program.getSourceFile(join(api, 'feature.d.ts')))
    assert.equal(selected.program.getSourceFile(join(local, 'feature.d.ts')), undefined)
    const pinned = await typecheck({ configPath: f.configPath })
    assert.ok(hasCode(pinned, 2322), format(pinned.diagnostics))
    assert.ok(pinned.program.getSourceFile(join(local, 'feature.d.ts')))

    const missing = await f.check({ readFile: path => inDirectory(path, api) && /\.d\.ts$/u.test(path) ? undefined : ts.sys.readFile(path) })
    assert.ok(hasCode(missing, 90002), format(missing.diagnostics))
    assert.equal(missing.program.getSourceFile(join(local, 'feature.d.ts')), undefined)
  })
}

test('missing direct and transitive upstream packages cannot fall back to ancestor pins', async t => {
  const f = await fixture(t)
  const modules = join(f.runtime, 'node_modules')
  const apiName = '@deepseek-ai/typecheck-api'
  const missingName = '@deepseek-ai/typecheck-missing'
  await f.pkg(join(modules, '@deepseek-ai/dsh'), '@deepseek-ai/dsh', '', { dependencies: { [apiName]: '*' } })
  const api = await f.pkg(join(modules, apiName), apiName, `export type { Lost } from '${missingName}';\n`)
  const local = await f.pkg(join(f.directory, 'node_modules', missingName), missingName, 'export type Lost = string;\n')
  await f.main(`/** @type {import('${missingName}').Lost} */ const direct = 'lost'\nimport '${apiName}'\n`)
  const result = await f.check()
  const errors = result.diagnostics.filter(error => error.code === 90002)
  assert.ok(errors.some(error => error.file && samePath(error.file.fileName, join(f.directory, 'main.js'))), format(result.diagnostics))
  assert.ok(errors.some(error => error.file && samePath(error.file.fileName, join(api, 'index.d.ts'))), format(result.diagnostics))
  assert.equal(result.program.getSourceFile(join(local, 'index.d.ts')), undefined)
})

test('missing relative declaration links fail even with skipLibCheck', async t => {
  const f = await fixture(t)
  const apiName = '@deepseek-ai/typecheck-api'
  await f.pkg(join(f.runtime, 'node_modules/@deepseek-ai/dsh'), '@deepseek-ai/dsh', '', { dependencies: { [apiName]: '*' } })
  const api = await f.pkg(join(f.runtime, 'node_modules', apiName), apiName, 'export type { Lost } from "./lost.js";\n')
  await f.main(`import '${apiName}'\n`)
  const result = await f.check()
  assert.ok(result.diagnostics.some(error => error.code === 90002 && error.file && samePath(error.file.fileName, join(api, 'index.d.ts'))), format(result.diagnostics))
})

test('runtime at the project or its ancestor still compiles implementation JavaScript imports', async t => {
  const f = await fixture(t)
  const apiName = '@deepseek-ai/typecheck-api'
  const modules = join(f.directory, 'node_modules')
  await f.pkg(join(modules, '@deepseek-ai/dsh'), '@deepseek-ai/dsh', '', { dependencies: { [apiName]: '*' } })
  await f.pkg(join(modules, apiName), apiName, 'export const value: string;\n')
  await put(join(f.directory, 'helper.js'), '// @ts-check\nexport const helper = 1\n')
  await f.main(`import { helper } from './helper.js'\nimport { value } from '${apiName}'\nexport const text = value + helper\n`)
  clean(await f.check({ runtime: f.directory }))
  await put(join(f.directory, 'nested', 'main.js'), '// @ts-check\nexport { text } from "../main.js"\n')
  await put(join(f.directory, 'nested', 'tsconfig.json'), { extends: '../tsconfig.json', files: ['main.js'] })
  clean(await f.check({ runtime: f.directory, configPath: join(f.directory, 'nested', 'tsconfig.json') }))
})

test('same-version nominal instances stay distinct and direct ambiguity is an error', async t => {
  const f = await fixture(t)
  const modules = join(f.runtime, 'node_modules')
  const leftName = '@deepseek-ai/typecheck-left'
  const rightName = '@deepseek-ai/typecheck-right'
  const tokenName = '@deepseek-ai/typecheck-token'
  await f.pkg(join(modules, '@deepseek-ai/dsh'), '@deepseek-ai/dsh', '', { dependencies: { [leftName]: '*', [rightName]: '*' } })
  const left = await f.pkg(join(modules, leftName), leftName,
    `export function consume(token: import('${tokenName}').Token): void;\n`, { dependencies: { [tokenName]: '*' } })
  const right = await f.pkg(join(modules, rightName), rightName,
    `export function make(): import('${tokenName}').Token;\n`, { dependencies: { [tokenName]: '*' } })
  const tokens = []
  for (const parent of [left, right]) {
    tokens.push(await f.pkg(join(parent, 'node_modules', tokenName), tokenName, 'export class Token { private nominal: void; }\n'))
  }
  await f.main(`import { consume } from '${leftName}'\nimport { make } from '${rightName}'\nconsume(make())\n`)
  const result = await f.check()
  assert.ok(result.diagnostics.some(error => error.code === 2345 && /private property 'nominal'/u.test(ts.flattenDiagnosticMessageText(error.messageText, '\n'))), format(result.diagnostics))
  assert.equal(hasCode(result, 90002), false, format(result.diagnostics))
  for (const token of tokens) assert.ok(result.program.getSourceFile(join(token, 'index.d.ts')))

  await f.main(`/** @type {import('${tokenName}').Token | undefined} */ const token = undefined\n`)
  const ambiguous = await f.check()
  assert.ok(ambiguous.diagnostics.some(error => error.code === 90002 && /ambiguous/u.test(error.messageText)), format(ambiguous.diagnostics))
})

test('a runtime must exist at the selected installation and CLI rejects invalid flags', async t => {
  const f = await fixture(t)
  await mkdir(f.runtime, { recursive: true })
  await f.pkg(join(f.directory, 'node_modules/@deepseek-ai/dsh'), '@deepseek-ai/dsh')
  await f.main('export {}\n')
  await assert.rejects(f.check(), /No @deepseek-ai\/dsh installation/u)
  for (const args of [['--runtime'], ['--runtim', f.runtime], ['--runtime', f.runtime, '--extra']]) {
    await assert.rejects(execute(process.execPath, [join(root, 'scripts/typecheck.js'), ...args], { cwd: f.directory }), error => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /Usage: node scripts\/typecheck.js/u)
      return true
    })
  }
})
