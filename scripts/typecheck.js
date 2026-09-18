#!/usr/bin/env node
// Developer-only: compile the real implementation against local or installed types.
import { existsSync, realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { localPackageSearchPaths, locateInstalledDshPackage } from '../lib/dsh-installation.js'

const defaultConfig = fileURLToPath(new URL('../tsconfig.json', import.meta.url))
const defaultHmr = '@deepseek-ai/cordis-plugin-hmr'
const upstream = name => name.startsWith('@deepseek-ai/')
const packageName = name => name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')
const declaration = path => /\.d\.[cm]?ts$/u.test(path)

function within(root, path) {
  const rest = relative(root, path)
  return rest !== '..' && !rest.startsWith('../') && !rest.startsWith('..\\') && !isAbsolute(rest)
}

function diagnostic(code, messageText, file, start = 0, length = 0) {
  return { category: ts.DiagnosticCategory.Error, code, messageText, file, start, length }
}

async function installedGraph(directory) {
  const root = await realpath(resolve(directory))
  // Require the requested installation itself, never a package in an ancestor.
  const entry = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  if (!existsSync(entry)) throw new Error(`No @deepseek-ai/dsh installation at ${entry}`)
  const installation = { root, manifestPath: join(root, 'package.json') }
  const dsh = await locateInstalledDshPackage(installation, '@deepseek-ai/dsh')
  const packages = new Map([[dsh.root, { ...dsh, consumer: installation }]])
  const byName = new Map()

  // Only the upstream namespace is redirected. Node and the project's other
  // development types keep their ordinary root resolution. Peer dependencies
  // are edges too: pnpm does not hoist them next to the DSH CLI.
  for (const pkg of packages.values()) {
    const candidates = byName.get(pkg.value.name) ?? []
    candidates.push(pkg)
    byName.set(pkg.value.name, candidates)
    const dependencies = { ...pkg.value.dependencies, ...pkg.value.peerDependencies, ...pkg.value.optionalDependencies }
    for (const name of Object.keys(dependencies).filter(upstream)) {
      if (!localPackageSearchPaths(pkg, name).some(path => within(root, path) && existsSync(join(path, name)))) continue
      const dependency = await locateInstalledDshPackage(pkg, name)
      if (dependency && !packages.has(dependency.root)) {
        packages.set(dependency.root, { ...dependency, consumer: pkg })
      }
    }
  }
  return { root, byName, dsh }
}

function useRuntime(host, options, graph, diagnostics) {
  const packageRoots = [...graph.byName.values()].flat().map(pkg => pkg.root)
  const laneFiles = new Set()
  // Restrict lane lookups before TS tries ancestor node_modules or @types.
  // This also prevents a runtime installed under the checkout from falling
  // through to the checkout's pinned types when its own declarations are absent.
  const laneHost = {
    ...host,
    fileExists: path => within(graph.root, path) && host.fileExists(path),
    directoryExists: path => within(graph.root, path) && host.directoryExists(path),
    readFile: path => within(graph.root, path) ? host.readFile(path) : undefined,
  }
  const laneOptions = { ...options, paths: undefined, baseUrl: undefined, typeRoots: undefined, preserveSymlinks: false }
  const cache = ts.createModuleResolutionCache(graph.root, host.getCanonicalFileName, laneOptions)
  const nearestCache = new Map()

  function nearest(containingFile, name) {
    const key = `${dirname(containingFile)}\0${name}`
    if (!nearestCache.has(key)) {
      const consumer = { root: dirname(containingFile), manifestPath: containingFile }
      const search = localPackageSearchPaths(consumer, name)
      const path = search.find(path => within(graph.root, path) && existsSync(join(path, name)))
      nearestCache.set(key, path ? realpathSync(join(path, name)) : undefined)
    }
    return nearestCache.get(key)
  }

  host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference, compilerOptions, sourceFile) => literals.map(literal => {
    const name = literal.text
    const mode = ts.getModeForUsageLocation(sourceFile, literal, compilerOptions)
    const fromLane = laneFiles.has(containingFile) || packageRoots.some(root => within(root, containingFile))
    if (!fromLane && !upstream(name)) {
      return ts.resolveModuleName(name, containingFile, compilerOptions, host, undefined, redirectedReference, mode)
    }

    function fail(message) {
      diagnostics.push(diagnostic(90002, message, sourceFile, literal.getStart(sourceFile), literal.getWidth(sourceFile)))
      return { resolvedModule: undefined }
    }

    let from = containingFile
    let expected
    if (!fromLane) {
      const candidates = graph.byName.get(packageName(name)) ?? []
      if (candidates.length !== 1) {
        return fail(candidates.length === 0
          ? `Runtime graph has no package for ${name}; local pinned types are not a fallback.`
          : `Runtime graph is ambiguous for ${name}: ${candidates.map(pkg => pkg.root).join(', ')}`)
      }
      expected = candidates[0].root
      // Resolve through a real dependency edge, retaining exports conditions and
      // subpath rules rather than guessing a types entry or synthesizing one.
      from = candidates[0].consumer.manifestPath
    } else if (upstream(name)) {
      expected = nearest(containingFile, packageName(name))
      if (!expected) return fail(`Runtime declaration ${containingFile} cannot find ${name}.`)
    }

    const result = ts.resolveModuleName(name, from, laneOptions, laneHost, cache, redirectedReference, mode)
    const resolved = result.resolvedModule
    if (isBuiltin(name)) return result
    // This declaration integrity guard covers upstream API imports and relative
    // declaration links. Other external imports use ordinary TS diagnostics.
    const requireDeclaration = upstream(name) || name.startsWith('.') || isAbsolute(name)
    if (requireDeclaration && (!resolved || !declaration(resolved.resolvedFileName)
        || (expected && !within(expected, resolved.resolvedFileName)))) {
      return fail(`Runtime published declarations cannot resolve ${name} from ${from}; local pinned types are not a fallback.`)
    }
    // TS normally redirects equal name/version package IDs to one SourceFile.
    // Physical instances (including same-version peer contexts) must keep their
    // own nominal types and module augmentations in an installed runtime graph.
    if (!resolved) return result
    laneFiles.add(resolved.resolvedFileName)
    return { ...result, resolvedModule: { ...resolved, packageId: undefined } }
  })

  // HMR moved between published providers. Load the CLI's actual provider as a
  // declaration root; never alias one official import name to the other.
  if (!options.types?.includes(defaultHmr)) return []
  options.types = options.types.filter(name => name !== defaultHmr)
  const providers = [defaultHmr, '@deepseek-ai/dsh-hmr']
    .filter(name => Object.hasOwn(graph.dsh.value.dependencies ?? {}, name))
  if (providers.length !== 1) {
    diagnostics.push(diagnostic(90002, 'Runtime CLI must declare exactly one HMR provider dependency: ' + providers.join(', ')))
    return []
  }
  const provider = providers[0]
  const expected = nearest(graph.dsh.manifestPath, provider)
  const mode = graph.dsh.value.type === 'module' ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS
  const resolved = ts.resolveModuleName(provider, graph.dsh.manifestPath, laneOptions, laneHost, cache, undefined, mode).resolvedModule
  if (!expected || !resolved || !declaration(resolved.resolvedFileName) || !within(expected, resolved.resolvedFileName)) {
    diagnostics.push(diagnostic(90002, `Runtime HMR provider ${provider} has no resolvable published declarations; local pinned types are not a fallback.`))
    return []
  }
  return [resolved.resolvedFileName]
}

/**
 * Compile the repository's actual tsconfig inputs without emitting or copying.
 * readFile has the ts.sys.readFile signature; tests may wrap it to mutate an
 * upstream declaration in memory. Setup errors throw; compiler errors are
 * returned as ordinary TypeScript diagnostics alongside the inspectable program.
 */
export async function typecheck({ runtime, configPath = defaultConfig, readFile = ts.sys.readFile } = {}) {
  configPath = resolve(configPath)
  const diagnostics = []
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys, readFile, onUnRecoverableConfigFileDiagnostic: error => diagnostics.push(error),
  })
  if (!config) return { program: undefined, diagnostics }
  diagnostics.push(...config.errors)
  const options = { ...config.options, noEmit: true }
  const host = ts.createCompilerHost(options, true)
  host.readFile = path => readFile(ts.sys.realpath(path))
  // Keep readFile's in-memory deletions visible to the resolver as well.
  host.fileExists = path => ts.sys.fileExists(path) && host.readFile(path) !== undefined
  const runtimeRoots = runtime === undefined ? [] : useRuntime(host, options, await installedGraph(runtime), diagnostics)
  const program = ts.createProgram({ rootNames: [...config.fileNames, ...runtimeRoots], options, host, projectReferences: config.projectReferences })
  for (const path of config.fileNames.filter(path => /\.[cm]?js$/u.test(path))) {
    const source = program.getSourceFile(path)
    // Use the compiler's effective directive: a string, a late comment, or an
    // overridden @ts-check must not make an unchecked module look covered.
    if (source && source.checkJsDirective?.enabled !== true) {
      diagnostics.push(diagnostic(90001, 'Every root JavaScript file must enable @ts-check.', source))
    }
  }
  diagnostics.push(...ts.getPreEmitDiagnostics(program))
  return { program, diagnostics: ts.sortAndDeduplicateDiagnostics(diagnostics) }
}

async function main(args) {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--runtime' || args[1].startsWith('--'))) {
    throw new Error('Usage: node scripts/typecheck.js [--runtime <installation directory>]')
  }
  const { diagnostics } = await typecheck({ runtime: args[1] })
  if (diagnostics.length) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: path => path,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => ts.sys.newLine,
    }))
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`typecheck: ${error.message}`)
    process.exitCode = 1
  })
}
