import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_COMPATIBILITY_TARGET, SLOGAN } from './constants.js'
import { inspectClientBundle } from './client-bundle-audit.js'
import { normalizeCreatorExport, readStableCreatorExport } from './creator-export.js'
import { inspectOptionalRuntimeImports } from './dependency-audit.js'
import { asDiagnostic, DshDeveloperError } from './errors.js'
import { fingerprintFileMap, mapTreeEntries, scanOrdinaryTree } from './files.js'
import {
  checkDshVersion,
  runGeneratedNodeTests,
  smokeDshInstall,
} from './runtime.js'
import { renderGeneratedBundle } from './templates.js'
import {
  classifyHostInjectContract,
  discoverUpstreamReferences,
} from './upstream-impact-internal.js'

const productRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function report(kind, source) {
  return {
    kind,
    source,
    ok: true,
    verifiedAt: undefined,
    fingerprint: undefined,
    checks: [],
  }
}

function record(target, id, status, message, options = {}) {
  const check = {
    id,
    status,
    blocking: options.blocking ?? true,
    message,
  }
  if (options.evidence !== undefined) check.evidence = options.evidence
  if (options.recovery !== undefined) check.recovery = options.recovery
  target.checks.push(check)
  if (check.blocking && status === 'FAIL') target.ok = false
  return check
}

async function attempt(target, id, action, options = {}) {
  try {
    const result = await action()
    const detail = result && typeof result === 'object' ? result : {}
    return record(
      target,
      id,
      detail.status ?? 'PASS',
      detail.message ?? options.passMessage ?? 'Check passed.',
      {
        blocking: detail.blocking ?? options.blocking,
        evidence: detail.evidence,
        recovery: detail.recovery,
      },
    )
  } catch (error) {
    if (error instanceof DshDeveloperError && error.code === 'CANCELLED') throw error
    return record(target, id, 'FAIL', error instanceof Error ? error.message : String(error), {
      blocking: options.blocking,
      evidence: asDiagnostic(error),
      recovery: options.recovery,
    })
  }
}

function skip(target, id, message, options = {}) {
  return record(target, id, 'SKIP', message, { blocking: options.blocking ?? false, recovery: options.recovery })
}

function warning(target, id, message, evidence) {
  return record(target, id, 'WARN', message, { blocking: false, evidence })
}

function parseJson(files, path) {
  const content = files.get(path)
  if (content === undefined) throw new DshDeveloperError('MISSING_FILE', 'Required file "' + path + '" is missing.', { path })
  try {
    return JSON.parse(content)
  } catch (error) {
    throw new DshDeveloperError('INVALID_JSON', '"' + path + '" is not valid JSON: ' + error.message, { path })
  }
}

function requiredFile(files, path) {
  const content = files.get(path)
  if (content === undefined) throw new DshDeveloperError('MISSING_FILE', 'Required file "' + path + '" is missing.', { path })
  return content
}

function assert(condition, code, message, details = {}) {
  if (!condition) throw new DshDeveloperError(code, message, details)
}

function packagePath(value, label) {
  assert(typeof value === 'string' && value.length > 0, 'INVALID_PACKAGE', label + ' must be a package-relative path.')
  const relative = value.startsWith('./') ? value.slice(2) : value
  const normalized = posix.normalize(relative)
  assert(
    relative.length > 0
      && !relative.includes('\\')
      && !relative.includes('\0')
      && !relative.startsWith('/')
      && !/^[A-Za-z]:/u.test(relative)
      && normalized === relative
      && normalized !== '.'
      && normalized !== '..'
      && !normalized.startsWith('../'),
    'INVALID_PACKAGE',
    label + ' must be one portable package-relative path.',
    { path: value },
  )
  return normalized
}

function conditionalExportTarget(value, conditions = []) {
  if (typeof value === 'string') return { target: value, conditions }
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const selected = conditionalExportTarget(candidate, conditions)
      if (selected) return selected
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  for (const [condition, candidate] of Object.entries(value)) {
    if (!['node-addons', 'node', 'import', 'default'].includes(condition)) continue
    const selected = conditionalExportTarget(candidate, [...conditions, condition])
    if (selected) return selected
  }
  return undefined
}

function packageEntry(value) {
  if (value.exports !== undefined) {
    const rootExport = value.exports && typeof value.exports === 'object' && !Array.isArray(value.exports)
      && Object.hasOwn(value.exports, '.')
      ? value.exports['.']
      : value.exports
    const selected = conditionalExportTarget(rootExport)
    return {
      path: packagePath(selected?.target, 'package.json exports root import target'),
      via: selected.conditions.length > 0 ? 'exports.' + selected.conditions.join('.') : 'exports',
    }
  }
  return { path: packagePath(value.main, 'package.json main'), via: 'main' }
}

function packageEntryPath(value) {
  return packageEntry(value).path
}

function validatePackage(files, options = {}) {
  const value = parseJson(files, 'package.json')
  assert(typeof value.name === 'string' && value.name.length > 0, 'INVALID_PACKAGE', 'package.json must have a package name.')
  assert(value.type === 'module', 'INVALID_PACKAGE', 'package.json type must be "module".')
  const entryPath = packageEntryPath(value)
  assert(files.has(entryPath), 'PACKAGE_ENTRY_MISSING', 'The package entry is absent from the audited tree.', { path: entryPath })

  const patchDeclaration = value.dsh?.bundle?.patch
  const hasClientSurface = value.dsh?.client !== undefined
    || (value.exports && typeof value.exports === 'object' && Object.hasOwn(value.exports, './client'))
  assert(
    patchDeclaration !== undefined || hasClientSurface,
    'INVALID_DSH_PACKAGE',
    'package.json must declare a dsh.bundle.patch or a DSH Client surface.',
  )
  let patchPath
  if (patchDeclaration !== undefined) {
    patchPath = packagePath(patchDeclaration, 'package.json dsh.bundle.patch')
    assert(files.has(patchPath), 'MISSING_DSH_PATCH', 'The declared DSH bundle patch is absent from the audited tree.', { path: patchPath })
  }

  if (options.generatedBundle) {
    assert(value.main === './index.js', 'INVALID_PACKAGE', 'Generated package.json main must be "./index.js".')
    assert(value.license === 'MIT', 'INVALID_PACKAGE', 'Generated package.json license must be "MIT".')
    assert(
      value.dsh?.bundle?.patch === './cordis.patch.yml',
      'INVALID_DSH_BUNDLE',
      'Generated package.json must declare dsh.bundle.patch as "./cordis.patch.yml".',
    )
    assert(value.engines?.node === '>=22.18', 'INVALID_PACKAGE', 'Generated package.json must require Node.js >=22.18.')
  }
  return value
}

function validateCodexManifest(files, options = {}) {
  const value = parseJson(files, '.codex-plugin/plugin.json')
  assert(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value.name), 'INVALID_CODEX_MANIFEST', 'Codex plugin name must be kebab-case.')
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version), 'INVALID_CODEX_MANIFEST', 'Codex plugin version must be semver.')
  if (options.generatedBundle) {
    assert(value.version === '0.1.0', 'INVALID_CODEX_MANIFEST', 'Generated Codex plugin version must be 0.1.0.')
  }
  assert(value.skills === './skills/', 'INVALID_CODEX_MANIFEST', 'Codex plugin must expose "./skills/".')
  assert(value.interface?.defaultPrompt?.includes('$' + value.name), 'INVALID_CODEX_MANIFEST', 'Codex default prompt must invoke the canonical skill.')
  return value
}

function validateSkill(files, pluginName) {
  const path = 'skills/' + pluginName + '/SKILL.md'
  const content = requiredFile(files, path)
  const match = /^---\r?\nname:\s*([a-z0-9-]+)\r?\ndescription:\s*"((?:[^"\\]|\\.)*)"\r?\n---\r?\n([\s\S]+)$/u.exec(content)
  assert(Boolean(match), 'INVALID_SKILL', path + ' must have canonical name and description frontmatter.', { path })
  assert(match[1] === pluginName, 'INVALID_SKILL', 'Skill name must match the Codex plugin name.', { path })
  const description = JSON.parse('"' + match[2] + '"')
  assert(description.length > 0 && description.length <= 1024, 'INVALID_SKILL', 'Skill description must be 1-1024 characters.', { path })
  assert(!/\bTODO\b|\[TODO/u.test(content), 'PLACEHOLDER_FOUND', 'Skill contains a TODO placeholder.', { path })
  const agentPath = 'skills/' + pluginName + '/agents/openai.yaml'
  const agent = requiredFile(files, agentPath)
  assert(agent.includes('$' + pluginName), 'INVALID_SKILL_INTERFACE', 'openai.yaml must invoke the canonical skill.', { path: agentPath })

  const links = [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map((matchValue) => matchValue[1])
  for (const link of links) {
    if (/^[a-z]+:\/\//iu.test(link) || link.startsWith('#')) continue
    const normalized = link.replace(/^\.\//u, '')
    assert(
      !normalized.includes('..') && files.has('skills/' + pluginName + '/' + normalized),
      'BROKEN_SKILL_REFERENCE',
      'Skill reference "' + link + '" does not resolve inside its skill directory.',
      { path, reference: link },
    )
  }
  return { path, description }
}

function validateDshEntrypoint(files, pluginName, packageName, options = {}) {
  const patchPath = options.patchPath
  const entryPath = options.entryPath ?? 'index.js'
  const patch = patchPath ? requiredFile(files, patchPath) : undefined
  const entry = requiredFile(files, entryPath)
  if (!options.generatedBundle) {
    let mountedId
    if (patch) {
      const packagePattern = packageName.replace(/[$^.*+?{}()|[\]\\]/gu, '\\$&')
      const mounted = new RegExp(
        '^\\s*- id:\\s*([^\\r\\n]+)\\s*\\r?\\n\\s+name:\\s*[\'\"]?' + packagePattern + '[\'\"]?\\s*$',
        'mu',
      ).exec(patch)
      mountedId = mounted?.[1]?.trim().replace(/^['"]|['"]$/gu, '')
    }
    if (mountedId) {
      assert(
        /export\s+(?:async\s+)?function\s+apply\s*\(/u.test(entry)
          || /export\s+(?:const|let|var)\s+apply\s*=/u.test(entry),
        'INVALID_DSH_ENTRY',
        entryPath + ' must export an apply function because the bundle patch mounts this package.',
        { path: entryPath, pluginName: mountedId },
      )
    }
    return {
      pluginName: mountedId ?? packageName,
      mounted: Boolean(mountedId),
      entryPath,
      entryVia: options.entryVia,
      patchPath,
    }
  }

  assert(patch, 'MISSING_DSH_PATCH', 'Generated bundle must include its declared DSH patch.')
  const pluginPattern = pluginName.replace(/[$^.*+?{}()|[\]\\]/gu, '\\$&')
  const packagePattern = packageName.replace(/[$^.*+?{}()|[\]\\]/gu, '\\$&')
  assert(
    new RegExp(
      '^\\s*- id:\\s*' + pluginPattern + '\\s*\\r?\\n\\s+name:\\s*[\'\"]?' + packagePattern + '[\'\"]?\\s*$',
      'mu',
    ).test(patch),
    'INVALID_DSH_PATCH',
    'cordis.patch.yml must insert id "' + pluginName + '" with package entry "' + packageName + '".',
  )
  assert(/export\s+const\s+name\s*=/u.test(entry), 'INVALID_DSH_ENTRY', 'index.js must export const name.')
  assert(/export\s+const\s+inject\s*=/u.test(entry), 'INVALID_DSH_ENTRY', 'index.js must export const inject.')
  assert(/export\s+async\s+function\s+apply\s*\(/u.test(entry), 'INVALID_DSH_ENTRY', 'index.js must export async function apply.')
  assert(!/export\s+default\b/u.test(entry), 'INVALID_DSH_ENTRY', 'index.js must not use a default export.')
  return { pluginName, mounted: true, entryPath, entryVia: options.entryVia, patchPath }
}

function validateDocsAndLicense(files, options = {}) {
  if (options.generatedBundle) {
    const readme = requiredFile(files, 'README.md')
    assert(readme.includes(SLOGAN), 'MISSING_SLOGAN', 'README.md must contain the exact product slogan.')
    assert(/npm test/u.test(readme), 'INCOMPLETE_DOCS', 'README.md must document the test command.')
    assert(/dsh plugin --profile/u.test(readme), 'INCOMPLETE_DOCS', 'README.md must document DSH installation.')
    assert(readme.includes(DSH_COMPATIBILITY_TARGET), 'INCOMPLETE_DOCS', 'README.md must state the blocking DSH target.')
  }
  const license = requiredFile(files, 'LICENSE')
  assert(/^MIT License\r?$/mu.test(license), 'INVALID_LICENSE', 'LICENSE must contain the MIT license.')
}

function inspectOrdinaryDocs(files) {
  const missing = []
  const readme = files.get('README.md')
  const license = files.get('LICENSE')
  if (readme === undefined || readme.trim().length === 0) missing.push('README.md')
  if (license === undefined || license.trim().length === 0) missing.push('LICENSE')
  return { missing }
}

function compareReproducibleTree(files) {
  const provenance = normalizeCreatorExport(parseJson(files, 'dsh-developer.provenance.json'))
  const expected = renderGeneratedBundle(provenance)
  const actualPaths = [...files.keys()].sort((left, right) => left.localeCompare(right, 'en'))
  const expectedPaths = [...expected.files.keys()].sort((left, right) => left.localeCompare(right, 'en'))
  const changed = []
  const allPaths = new Set([...actualPaths, ...expectedPaths])
  for (const path of allPaths) {
    if (files.get(path) !== expected.files.get(path)) changed.push(path)
  }
  assert(changed.length === 0, 'NON_REPRODUCIBLE_BUNDLE', 'Bundle differs from its provenance and deterministic generator.', {
    changedPaths: changed.slice(0, 32),
  })
  return {
    value: provenance,
    expected,
    treeFingerprint: fingerprintFileMap(files),
  }
}

async function runtimeCheck(target, options) {
  if (options.runtime === 'skip') {
    skip(target, 'compatibility.public-runtime', 'Public DSH runtime check was explicitly skipped for this audit.', {
      recovery: 'Run again without --skip-runtime before promotion or release.',
    })
    return undefined
  }
  let value
  await attempt(target, 'compatibility.public-runtime', async () => {
    value = options.checkDshVersion
      ? await options.checkDshVersion(options.dshPath, options)
      : await checkDshVersion(options.dshPath, options)
    return {
      message: 'Blocking public DSH runtime matches ' + DSH_COMPATIBILITY_TARGET + '.',
      evidence: { version: value.version, dshPath: value.invocation?.displayPath },
    }
  }, {
    recovery: 'Install DSH ' + DSH_COMPATIBILITY_TARGET + ' or pass its executable with --dsh.',
  })
  return value
}

export async function doctorCreator(source, options = {}) {
  const absolute = resolve(source)
  const target = report('creator-export', absolute)
  let snapshot
  await attempt(target, 'source.stable-snapshot', async () => {
    snapshot = await readStableCreatorExport(absolute, { signal: options.signal })
    target.fingerprint = snapshot.contentDigest
    return {
      message: 'Acquired one stable, ordinary-file Creator export snapshot.',
      evidence: {
        bytes: snapshot.bytes,
        contentDigest: snapshot.contentDigest,
        sourceFingerprint: snapshot.value.sourceFingerprint,
      },
    }
  }, {
    recovery: 'Export a stable UTF-8 JSON file from DSH Creator and remove links, secrets, or concurrent writers.',
  })
  if (snapshot) {
    record(target, 'creator.schema-and-fingerprint', 'PASS', 'Creator export schema, bounds, secrets, and canonical fingerprint are valid.', {
      evidence: {
        format: snapshot.value.format,
        schemaVersion: snapshot.value.schemaVersion,
        sourceFingerprint: snapshot.value.sourceFingerprint,
      },
    })
    record(target, 'compatibility.export-target', 'PASS', 'Creator export targets public DSH ' + DSH_COMPATIBILITY_TARGET + '.')
  } else {
    skip(target, 'creator.schema-and-fingerprint', 'No stable snapshot was available.')
    skip(target, 'compatibility.export-target', 'No valid Creator export was available.')
  }
  const runtime = await runtimeCheck(target, options)
  warning(target, 'compatibility.official-master', 'Official DSH master is advisory and was not executed for this report.', {
    policy: 'advisory',
  })
  target.verifiedAt = new Date().toISOString()
  target.snapshot = snapshot
  target.runtime = runtime
  return target
}

export async function doctorPlugin(source, options = {}) {
  const absolute = resolve(source)
  const isProductSource = process.platform === 'win32'
    ? absolute.toLocaleLowerCase('en-US') === productRoot.toLocaleLowerCase('en-US')
    : absolute === productRoot
  const target = report('plugin', absolute)
  let tree
  let files
  await attempt(target, 'source.ordinary-tree', async () => {
    tree = await scanOrdinaryTree(absolute, { signal: options.signal })
    files = mapTreeEntries(tree)
    target.fingerprint = tree.fingerprint
    return {
      message: 'Plugin tree contains only bounded, portable, case-safe UTF-8 files and no detected secrets.',
      evidence: { files: tree.fileCount, entries: tree.treeEntries, bytes: tree.bytes, fingerprint: tree.fingerprint },
    }
  }, {
    recovery: 'Remove links, special/binary files, dependency trees, case collisions, oversized content, credentials, or concurrent writers.',
  })

  let packageValue
  let packageDocument
  let codexValue
  let dshValue
  let reproducible
  let upstreamReferences
  const hasCodexManifest = files?.has('.codex-plugin/plugin.json') ?? false
  const hasProvenance = files?.has('dsh-developer.provenance.json') ?? false
  const hasGeneratedManifest = files?.has('dsh-developer.manifest.json') ?? false
  const generatedBundleContract = Boolean(options.requireGenerated || isProductSource || hasProvenance || hasGeneratedManifest)
  if (files) {
    await attempt(target, 'manifest.package', async () => {
      packageDocument = parseJson(files, 'package.json')
      packageValue = validatePackage(files, { generatedBundle: generatedBundleContract })
      return {
        message: generatedBundleContract
          ? 'package.json has the generated DSH bundle contract, ESM entry, MIT license, and supported Node floor.'
          : 'package.json exposes a portable ESM entry and a DSH bundle or Client surface.',
      }
    })
    await attempt(target, 'manifest.codex-plugin', async () => {
      if (!hasCodexManifest && !generatedBundleContract) {
        return {
          status: 'SKIP',
          blocking: false,
          message: 'This DSH plugin declares no Codex plugin surface.',
        }
      }
      codexValue = validateCodexManifest(files, { generatedBundle: generatedBundleContract })
      return { message: 'Codex manifest exposes the canonical shared Agent Skill.' }
    })
    await attempt(target, 'dsh.entrypoint', async () => {
      assert(packageValue, 'PREREQUISITE_FAILED', 'Package manifest must be valid before checking the DSH entry.')
      const patchDeclaration = packageValue.dsh?.bundle?.patch
      const entry = packageEntry(packageValue)
      dshValue = validateDshEntrypoint(files, codexValue?.name ?? packageValue.name, packageValue.name, {
        generatedBundle: generatedBundleContract,
        entryPath: entry.path,
        entryVia: entry.via,
        patchPath: patchDeclaration === undefined
          ? undefined
          : packagePath(patchDeclaration, 'package.json dsh.bundle.patch'),
      })
      return {
        message: generatedBundleContract
          ? 'DSH loads the generated module entry with named name, inject, and apply exports.'
          : dshValue.mounted
            ? 'The DSH patch mounts this package and its ESM entry exports apply.'
            : 'The package entry and DSH profile or Client surface are structurally present.',
        evidence: dshValue,
      }
    })
    await attempt(target, 'web.client-bundle', async () => {
      if (!packageDocument) {
        return {
          status: 'SKIP',
          blocking: false,
          message: 'Client-bundle audit requires a parseable package manifest.',
        }
      }
      const evidence = inspectClientBundle(files, packageDocument)
      if (!evidence.declared) {
        return {
          status: 'SKIP',
          blocking: false,
          message: 'The package declares no DSH Web client bundle.',
        }
      }
      const advisories = []
      const recovery = []
      if (evidence.coreServiceCollisions.length > 0) {
        advisories.push('The Web bundle directly provides DSH-owned client services, which can stop the interface before first render.')
        recovery.push('Rename the provided services, or remove their official owner packages only when replacement is intentional and the complete Web profile is verified.')
      }
      if (evidence.dynamicProvides > 0) {
        advisories.push('Computed client service names prevent static ownership proof.')
        recovery.push('Use literal provider names, or verify the complete Web profile when indirection is essential.')
      }
      if (!evidence.lanes.preview.ok) {
        advisories.push('The release-valid bundle requests modules absent from the reviewed preview module table.')
        recovery.push('Bundle those modules, declare supplied client modules in dsh.client.external, or remove the preview-only dependency.')
      }
      if (advisories.length > 0) {
        return {
          status: 'WARN',
          blocking: false,
          message: advisories.join(' '),
          evidence,
          recovery: recovery.join(' '),
        }
      }
      return {
        message: 'The DSH Web bundle has a valid client declaration, classic-script handoff, closed browser module boundary, and no literal DSH-owned service replacement.',
        evidence,
      }
    }, {
      recovery: 'Declare package.json dsh.client with platform "web", rebuild the exported ./client classic script, register the exact package id, keep Node and file imports out, and declare non-platform client modules in dsh.client.external.',
    })
    await attempt(target, 'dsh.host-client-inject', async () => {
      upstreamReferences = discoverUpstreamReferences(tree)
      const contract = classifyHostInjectContract(upstreamReferences)
      if (contract.clientPackageInjections.length > 0) {
        throw new DshDeveloperError(
          'HOST_CLIENT_PACKAGE_INJECT',
          'Host Cordis inject contains DSH Client package identifiers, which can leave the plugin pending and fail Web boot.',
          { injections: contract.clientPackageInjections },
        )
      }
      return {
        message: 'Host Cordis injections keep browser package identifiers out of server activation.',
      }
    }, {
      recovery: 'Remove @deepseek-ai/dsh-client-* values from Host export const inject or ctx.inject; put browser package dependencies in package.json dsh.client.inject, and remove an already-broken plugin from the profile before restarting Web.',
    })
    await attempt(target, 'compatibility.upstream-attachments', async () => {
      const references = upstreamReferences ?? discoverUpstreamReferences(tree)
      const contract = classifyHostInjectContract(references)
      if (contract.unparsedDeclarations.length > 0 || contract.invalidValues.length > 0) {
        throw new DshDeveloperError(
          'UNSCOPED_INJECT_CONTRACT',
          'Doctor cannot claim complete upstream attachments while an inject assignment is dynamic, unsupported, or contains an invalid service name.',
          {
            paths: contract.paths,
            invalidValues: contract.invalidValues,
            unparsedDeclarations: contract.unparsedDeclarations,
          },
        )
      }
      const uncovered = [
        ...references.coverage.undeclaredPackages,
        ...references.coverage.undeclaredServices,
      ]
      return uncovered.length === 0
        ? {
            message: 'Runtime imports and Cordis service attachments have machine-readable declarations.',
            evidence: {
              packages: references.packages.map((value) => value.package),
              services: references.services.map((value) => value.service),
            },
          }
        : {
            status: 'WARN',
            blocking: false,
            message: 'Some inferred upstream attachments lack a package or dshDeveloper.upstream declaration.',
            evidence: references.coverage,
          }
    })
    await attempt(target, 'dependencies.cold-boot', async () => {
      if (!packageValue || !dshValue) {
        return {
          status: 'SKIP',
          blocking: false,
          message: 'Cold-boot dependency inspection requires a valid package manifest and DSH composition.',
        }
      }
      const evidence = inspectOptionalRuntimeImports(files, packageValue, {
        entryPath: dshValue.mounted ? dshValue.entryPath : undefined,
        patchPath: dshValue.patchPath,
      })
      if (evidence.collisions.length > 0) {
        throw new DshDeveloperError(
          'OPTIONAL_EAGER_IMPORT',
          'Plugin cold-boot paths require packages declared optional, so a valid optional install can crash the profile.',
          evidence,
        )
      }
      return {
        message: 'No audited plugin cold-boot path requires a package declared optional.',
        evidence,
      }
    }, {
      recovery: 'Use a valid optionalDependencies map. Move every boot-required package to dependencies with a published lane-compatible range; if the feature is truly optional, gate the capability and verify cold boot with the package absent.',
    })
    await attempt(target, 'skill.integrity', async () => {
      if (!hasCodexManifest && !generatedBundleContract) {
        return {
          status: 'SKIP',
          blocking: false,
          message: 'Agent Skill checks do not apply without a Codex plugin surface.',
        }
      }
      assert(codexValue, 'PREREQUISITE_FAILED', 'Codex plugin manifest must be valid before checking its skill.')
      validateSkill(files, codexValue.name)
      return { message: 'Agent Skill metadata, interface, and local references are internally consistent.' }
    })
    await attempt(target, 'docs-and-license', async () => {
      if (generatedBundleContract) {
        validateDocsAndLicense(files, { generatedBundle: true })
        return { message: 'README, exact slogan, install/test guidance, compatibility statement, and MIT license are present.' }
      }
      const evidence = inspectOrdinaryDocs(files)
      return evidence.missing.length === 0
        ? {
            message: 'Repository README and license are present; generated-bundle copy conventions do not apply.',
            evidence,
          }
        : {
            status: 'WARN',
            blocking: false,
            message: 'The DSH package is auditable, but its repository documentation is incomplete.',
            evidence,
            recovery: 'Add ' + evidence.missing.join(' and ') + ' before a public release.',
          }
    })
    await attempt(target, 'packaging.reproducible', async () => {
      if (!hasProvenance || !hasGeneratedManifest) {
        if (options.requireGenerated || hasProvenance !== hasGeneratedManifest) {
          throw new DshDeveloperError('PROVENANCE_REQUIRED', 'Release output must include deterministic provenance and manifest files.')
        }
        return {
          status: 'WARN',
          blocking: false,
          message: 'This repository is not a promoted bundle; reproducibility is advisory during repository audit.',
        }
      }
      reproducible = compareReproducibleTree(files)
      return {
        message: 'Every output byte reproduces from the fingerprinted Creator export.',
        evidence: {
          sourceFingerprint: reproducible.value.sourceFingerprint,
          treeFingerprint: reproducible.treeFingerprint,
        },
      }
    }, { blocking: Boolean(options.requireGenerated || hasProvenance || hasGeneratedManifest) })
  } else {
    for (const id of [
      'manifest.package',
      'manifest.codex-plugin',
      'dsh.entrypoint',
      'web.client-bundle',
      'dsh.host-client-inject',
      'compatibility.upstream-attachments',
      'dependencies.cold-boot',
      'skill.integrity',
      'docs-and-license',
      'packaging.reproducible',
    ]) skip(target, id, 'Plugin tree snapshot failed.')
  }

  const runtime = await runtimeCheck(target, options)
  if (reproducible && packageValue && codexValue) {
    await attempt(target, 'tests.generated-smoke', async () => {
      const runner = options.runGeneratedNodeTests ?? runGeneratedNodeTests
      await runner(absolute, options)
      return { message: 'Generated plugin tests invoked the native registration entry successfully.' }
    })
  } else {
    skip(target, 'tests.generated-smoke', 'Controlled execution requires a byte-for-byte reproducible promoted bundle.')
  }

  if ((reproducible || isProductSource) && packageValue && codexValue && runtime) {
    await attempt(target, 'dsh.clean-profile-lifecycle', async () => {
      const runner = options.smokeDshInstall ?? smokeDshInstall
      await runner(absolute, codexValue.name, packageValue.name, runtime.invocation, options)
      return { message: 'Clean-profile DSH install, witnessed registration, discovery, and uninstall passed with pnpm offline and lifecycle scripts disabled.' }
    }, {
      recovery: 'Inspect the retained smoke home, DSH patch row, package name, and local offline install behavior.',
    })
  } else {
    skip(
      target,
      'dsh.clean-profile-lifecycle',
      packageValue && codexValue && runtime
        ? 'Existing untrusted repositories are audited without executing package-manager lifecycle commands.'
        : 'Clean-profile lifecycle requires valid package identities and the blocking public DSH runtime.',
    )
  }

  warning(target, 'compatibility.official-master', 'Official DSH master remains advisory and was not executed for this report.', {
    policy: 'advisory',
  })
  if (tree) {
    await attempt(target, 'verification.freshness', async () => {
      const fresh = await scanOrdinaryTree(absolute, { signal: options.signal })
      if (fresh.fingerprint !== target.fingerprint) {
        throw new DshDeveloperError(
          'STALE_VERIFICATION',
          'Plugin tree changed during generated tests or DSH lifecycle verification.',
          { before: target.fingerprint, after: fresh.fingerprint },
        )
      }
      target.fingerprint = fresh.fingerprint
      return {
        message: 'A fresh post-execution scan matches the exact tree accepted by the final gate.',
        evidence: { fingerprint: fresh.fingerprint },
      }
    })
  } else {
    skip(target, 'verification.freshness', 'No stable plugin tree was available for a fresh final scan.')
  }
  target.verifiedAt = new Date().toISOString()
  target.runtime = runtime
  target.plugin = packageValue
    ? { name: codexValue?.name ?? dshValue?.pluginName ?? packageValue.name, packageName: packageValue.name }
    : undefined
  return target
}

export async function doctorSource(source, options = {}) {
  const absolute = resolve(source)
  const info = await lstat(absolute).catch((error) => {
    throw new DshDeveloperError('SOURCE_UNAVAILABLE', 'Cannot inspect source: ' + error.message, { path: absolute })
  })
  if (info.isFile() && !info.isSymbolicLink()) return doctorCreator(absolute, options)
  if (info.isDirectory() && !info.isSymbolicLink()) return doctorPlugin(absolute, options)
  throw new DshDeveloperError('UNSAFE_SOURCE', 'Source must be an ordinary Creator export file or plugin directory.', { path: absolute })
}

export function reportDigest(value) {
  const canonical = JSON.stringify(value.checks.map(({ id, status, blocking, message }) => ({ id, status, blocking, message })))
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex')
}
